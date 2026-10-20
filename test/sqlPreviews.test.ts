import { describe, expect, it } from "vitest";
import { Position, Uri, type TextDocument } from "vscode";
import { buildFileOverview } from "../src/context/fileOverview";
import { CONCISE_OUTLINE, visibleOutline } from "../src/presentation/outlineFilter";
import { sqlSupport } from "../src/languages/sql";
import { describeSqlSource } from "../src/languages/sql/outline";
import { sqlDefinitions, listSqlFunctions } from "../src/languages/sql/syntax";
import { findSqlDependencies } from "../src/languages/sql/dependencies";
import { sqlFingerprint } from "../src/languages/sql/lexer";

const schema = `-- A small lending catalog.
CREATE TABLE public.books (
  id integer NOT NULL,
  title text DEFAULT 'Untitled'::text NOT NULL,
  price numeric(10, 2),
  label text GENERATED ALWAYS AS (title || '-' || id::text) STORED
);
CREATE TABLE public.loans (
  id integer,
  book_id integer NOT NULL
);
ALTER TABLE ONLY public.books ADD CONSTRAINT books_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.books ADD CONSTRAINT titles_unique UNIQUE (title);
ALTER TABLE ONLY public.loans ADD CONSTRAINT loans_book_fkey FOREIGN KEY (book_id) REFERENCES public.books(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.loans ALTER COLUMN id SET DEFAULT nextval('public.loan_ids'::regclass);
CREATE INDEX loans_by_book ON public.loans USING btree (book_id);
CREATE TYPE public.loan_status AS ENUM ('open', 'closed');
CREATE SEQUENCE public.loan_ids AS integer START WITH 1 INCREMENT BY 1;
`;
const document = (source: string) => ({
  uri: Uri.file("/repo/schema.sql"), languageId: "sql", getText: () => source
}) as TextDocument;
const text = (segments: readonly { text: string }[]) => segments.map((segment) => segment.text).join("");
const notes = (entry: { notes: readonly (readonly { text: string }[])[] }) => entry.notes.map(text).join("\n");

describe("local SQL schema previews", () => {
  it("shows schema cards, columns, defaults, keys, enums and sequences with default settings", async () => {
    const overview = await buildFileOverview(document(schema), "schema.sql");
    const visible = visibleOutline(overview.entries, CONCISE_OUTLINE);
    expect(visible.map((entry) => entry.qualifiedName)).toEqual([
      "public.books", "public.loans", "loans_by_book", "public.loan_status", "public.loan_ids"
    ]);
    const books = visible[0]!;
    expect(books.explainable).toBe(true);
    expect(books.showCallers).toBe(false);
    expect(books.description.length).toBeGreaterThan(0);
    expect(books.previewTable?.headers).toEqual(["Column", "Type", "Required", "Default / rules"]);
    const rows = books.previewTable!.rows.map((row) => row.map(text));
    expect(rows[0]).toEqual(["id", "integer", "Yes", "primary key"]);
    expect(rows[1]).toEqual(["title", "text", "Yes", "Default: 'Untitled'::text; unique"]);
    expect(rows[2]).toEqual(["price", "numeric(10, 2)", "No", "-"]);
    expect(rows[3]?.[3]).toContain("GENERATED ALWAYS AS");
    expect(notes(books)).toContain("Primary key: id.");
    expect(notes(books)).toContain("Unique: title.");
    const loans = visible[1]!;
    expect(loans.previewTable?.rows[0]?.map(text)).toEqual(["id", "integer", "No", "Default: nextval('public.loan_ids'::regclass)"]);
    expect(notes(loans)).toContain("Foreign key (book_id) references public.books (id).");
    expect(notes(loans)).toContain("On delete: cascade.");
    expect(notes(loans)).toContain("Index: CREATE INDEX");
    expect(notes(visible[3]!)).toContain("Allowed values: 'open', 'closed'.");
    expect(notes(visible[4]!)).toContain("START WITH 1 INCREMENT BY 1");
    expect(visibleOutline(overview.entries, { ...CONCISE_OUTLINE, types: true }).filter((entry) => entry.kind === "field")).toEqual([]);
  });

  it("resolves column and relationship links to host-owned references, never arbitrary paths", async () => {
    const overview = await buildFileOverview(document(schema), "schema.sql");
    const books = overview.entries.find((entry) => entry.name === "books")!;
    const id = overview.entries.find((entry) => entry.qualifiedName === "public.books.id")!;
    expect(books.previewTable?.rows[0]?.[0]?.[0]?.referenceId).toBe(id.id);
    expect(id.reference).toMatchObject({ path: "schema.sql", line: 2 });
    const loans = overview.entries.find((entry) => entry.name === "loans")!;
    expect(loans.notes.flat().find((segment) => segment.text === "public.books")?.referenceId).toBe(books.id);
    expect(loans.notes.flat().some((segment) => segment.target !== undefined)).toBe(false);
    const unresolved = await buildFileOverview(document("CREATE TABLE loans(book_id int REFERENCES elsewhere.books(id));"), "schema.sql");
    expect(unresolved.entries[0]?.notes.flat().find((segment) => segment.text === "elsewhere.books")?.referenceId).toBeUndefined();
  });

  it("allows explicit table explanations and tracks later ALTER/default/index changes", async () => {
    const target = await sqlSupport.findFunction(document(schema), new Position(2, 4));
    expect(target?.name).toBe("books");
    expect(target?.source).toContain("CREATE TABLE public.books");
    expect(target?.source).not.toContain("ALTER TABLE");
    const lookup = async (source: string) => findSqlDependencies({
      root: "/repo", path: "schema.sql", text: source, line: 1, name: "books",
      readablePaths: new Set(["schema.sql"]), load: async () => undefined
    });
    const result = await lookup(schema);
    expect(result.local?.[0]?.item.source).toContain("ADD CONSTRAINT books_pkey");
    expect(result.local?.[0]?.item.source).not.toContain("loans_book_fkey");
    const original = result.local?.[0]?.item.fingerprint;
    expect((await lookup(schema.replace("UNIQUE (title)", "UNIQUE (id, title)"))).local?.[0]?.item.fingerprint).not.toBe(original);
    expect((await lookup(schema.replace("UNIQUE (title)", "unique (\n title \n)"))).local?.[0]?.item.fingerprint).toBe(original);
    expect(await sqlSupport.explanationGuidance!({ path: "schema.sql", text: schema, line: 1, name: "books", qualifiedName: "public.books" }))
      .toContain("database structure");
  });

  it("includes foreign key targets and enriched schema in query dependencies", async () => {
    const query = "-- name: GetLoans :many\nSELECT * FROM public.loans WHERE book_id = $1;";
    const result = await findSqlDependencies({
      root: "/repo", path: "query.sql", text: query, line: 0, name: "GetLoans",
      readablePaths: new Set(["query.sql", "schema.sql"]), load: async () => schema
    });
    expect(result.dependencies[0]?.item.qualifiedName).toBe("public.loans");
    expect(result.dependencies[0]?.item.source).toContain("loans_book_fkey");
    expect(result.dependencies[0]?.item.source).toContain("CREATE INDEX");
    const table = sqlDefinitions(schema).find((entry) => entry.name.name === "loans")!;
    const references = await findSqlDependencies({
      root: "/repo", path: "schema.sql", text: schema, line: table.startLine, name: "loans",
      readablePaths: new Set(["schema.sql"]), load: async () => undefined
    });
    expect(references.dependencies.map(({ item }) => item.qualifiedName)).toContain("public.books");
  });
});

describe("SQL query previews", () => {
  it("uses sqlc names, result modes and parameters, including comments before the query", async () => {
    const source = `-- name: GetBooks :many
-- Include books whose title matches.
SELECT b.id, b.title FROM public.books b WHERE title = sqlc.arg('title') OR id = $1;

-- name: UpdateTitle :execrows
UPDATE public.books SET title = sqlc.narg('title') WHERE id = @book_id;

WITH matching AS (SELECT * FROM public.books WHERE id = $1)
SELECT * FROM matching;`;
    const units = await listSqlFunctions(source);
    expect(units.map((entry) => entry.name)).toEqual(["GetBooks", "UpdateTitle", "WITH query 1"]);
    expect(units[0]?.source).toContain("-- Include books");
    const outline = await describeSqlSource(source);
    expect(outline.drafts.filter((entry) => entry.explainable).map((entry) => entry.kindLabel)).toEqual(["Query", "Query", "Query"]);
    expect(notes(outline.drafts.find((entry) => entry.name === "GetBooks")!)).toContain("Inputs: title, $1.");
    expect(notes(outline.drafts.find((entry) => entry.name === "GetBooks")!)).toContain("Returns multiple rows.");
    expect(notes(outline.drafts.find((entry) => entry.name === "UpdateTitle")!)).toContain("Returns the number of affected rows.");
    expect(notes(outline.drafts.find((entry) => entry.name === "UpdateTitle")!)).toContain("Inputs: title, @book_id.");
    const target = await sqlSupport.findFunction(document(source), new Position(0, 10));
    expect(target?.name).toBe("GetBooks");
    expect(target?.selection.start).toEqual(new Position(0, 9));
    expect((await sqlSupport.findFunction(document(source), new Position(2, 25)))?.symbolId).toBe(target?.symbolId);
    expect(await sqlSupport.explanationGuidance!({ path: "query.sql", text: source, line: 0, name: "GetBooks", qualifiedName: "GetBooks" })).toContain("SQL query");
  });

  it("keeps duplicate/unnamed query identities distinct and doesn't split literal semicolons", async () => {
    const source = "-- name: Same :one\nSELECT ';';\n-- name: Same :one\nSELECT $$;$$;\nDELETE FROM books WHERE id = $1;";
    expect((await listSqlFunctions(source)).map((entry) => entry.qualifiedName)).toEqual(["Same", "Same #2", "DELETE query 1"]);
    expect(sqlFingerprint(source)).not.toBe(sqlFingerprint(source.replace(":one", ":many")));
    expect(sqlFingerprint(source)).toBe(sqlFingerprint(source.replace("SELECT ';';", "select\n ';' ;")));
    expect((await listSqlFunctions("SET search_path TO public; ALTER TABLE books ADD COLUMN title text;"))).toEqual([]);
  });
});
