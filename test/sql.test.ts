import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Position, Uri, type TextDocument } from "vscode";
import { sqlSupport } from "../src/languages/sql";
import { lexSql, sqlFingerprint } from "../src/languages/sql/lexer";
import { listSqlFunctions, sqlDefinitions, sqlPreamble, sqlStatements } from "../src/languages/sql/syntax";
import { describeSqlSource } from "../src/languages/sql/outline";
import { findSqlDependencies } from "../src/languages/sql/dependencies";
import { bundledLanguageFor, bundledLanguageIdForPath } from "../src/languages/registry";
import { gatherInventory } from "../src/context/inventory";
import { gatherFunctionContext } from "../src/context/related";
import { inputsMatch } from "../src/cache/freshness";

async function dependencies(
  files: Record<string, string>, path = "app.sql", name = "caller",
  extra: Partial<Parameters<typeof findSqlDependencies>[0]> = {}
) {
  const target = sqlDefinitions(files[path]!).find((entry) => entry.name.name === name)!;
  return findSqlDependencies({
    root: "/repo", path, text: files[path]!, line: target.startLine, name,
    readablePaths: new Set(Object.keys(files)), load: async (path) => files[path], ...extra
  });
}
const names = (result: Awaited<ReturnType<typeof dependencies>>) =>
  result.dependencies.map(({ path, item }) => `${path}:${item.qualifiedName}`);

describe("bundled SQL lexer and discovery", () => {
  it("keeps strings, quoted names, nested comments and dollar quotes opaque", () => {
    const tokens = lexSql(`SELECT 'it''s; -- text', E'quote\\' and ;', "a""b", \`a\`\`b\`, [a]]b], $tag$; CREATE VIEW fake AS SELECT 1;$tag$;
/* outer /* nested */ still comment */ -- end
`);
    expect(tokens.filter((token) => token.kind === "string").map((token) => token.text))
      .toEqual(["'it''s; -- text'", "E'quote\\' and ;'"]);
    expect(tokens.filter((token) => token.kind === "identifier").map((token) => token.text))
      .toEqual(['"a""b"', "`a``b`", "[a]]b]"]);
    expect(tokens.filter((token) => token.kind === "dollar")).toHaveLength(1);
    expect(tokens.filter((token) => token.kind === "comment")).toHaveLength(2);
    expect(tokens.every((token) => token.closed)).toBe(true);
    expect(lexSql("/* unfinished")[0]?.closed).toBe(false);
    expect(sqlDefinitions("CREATE FUNCTION bad() RETURNS int AS $$ unclosed")).toEqual([]);
  });

  it("discovers PostgreSQL routines, triggers, materialized views and standalone queries", async () => {
    const source = `-- header
CREATE OR REPLACE FUNCTION public.calculate(x integer) RETURNS integer LANGUAGE plpgsql AS $fn$
BEGIN
  IF x > 0 THEN RETURN x; END IF;
  RETURN 0;
END;
$fn$;
CREATE PROCEDURE public.refresh() LANGUAGE sql AS $$SELECT 1; SELECT 2;$$;
CREATE TRIGGER changed AFTER INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.notify();
CREATE MATERIALIZED VIEW public.saved AS SELECT * FROM public.items;
SELECT * FROM public.saved;`;
    const units = await listSqlFunctions(source);
    expect(units.map((entry) => entry.qualifiedName)).toEqual([
      "public.calculate(integer)", "public.refresh()", "changed", "public.saved", "SELECT query 1"
    ]);
    expect(units[0]?.source).toContain("RETURN 0;");
    expect(units[0]?.source).not.toContain("CREATE PROCEDURE");
    expect(units[0]?.signature).toContain("RETURNS integer LANGUAGE plpgsql");
    const document = { uri: Uri.file("/repo/app.sql"), getText: () => source } as TextDocument;
    const target = await sqlSupport.findFunction(document, new Position(4, 4));
    expect(target?.analysis).toBe("sql-lexer");
    expect(target?.selection.start).toEqual(new Position(1, 27));
    expect(target?.name).toBe("calculate");
    expect((await sqlSupport.findFunction(document, new Position(10, 5)))?.name).toBe("SELECT query 1");
    expect(bundledLanguageFor({ path: "app.SQL" })).toBe(sqlSupport);
    expect(bundledLanguageIdForPath("app.sql")).toBe("sql");
  });

  it("splits MySQL custom delimiters, BEGIN blocks, IF/CASE/loops and SQLite triggers", async () => {
    const mysql = `  DELIMITER $$
CREATE DEFINER=admin@localhost PROCEDURE save()
BEGIN
  IF 1 THEN SELECT CASE WHEN true THEN 1 ELSE 2 END; END IF;
  WHILE 1 DO SELECT 2; END WHILE;
  BEGIN SELECT 3; END;
END$$
CREATE FUNCTION value_of() RETURNS INTEGER
BEGIN RETURN 2; END$$
DELIMITER ;
CREATE VIEW saved AS SELECT 3;`;
    expect((await listSqlFunctions(mysql)).map((entry) => entry.name)).toEqual(["save", "value_of", "saved"]);
    expect((await listSqlFunctions(mysql))[0]?.source).toContain("END WHILE;");
    expect((await listSqlFunctions("DELIMITER //\nCREATE PROCEDURE quoted() BEGIN SELECT 'it\\'s; fine'; END//\nDELIMITER ;")).map((entry) => entry.name))
      .toEqual(["quoted"]);
    const sqlite = `CREATE TABLE items(id INTEGER);
CREATE TRIGGER changed AFTER INSERT ON items BEGIN
  INSERT INTO audit SELECT CASE WHEN NEW.id = 0 THEN 1 ELSE NEW.id END;
  UPDATE totals SET value = value + 1;
END;
CREATE VIEW saved AS SELECT * FROM items;`;
    expect((await listSqlFunctions(sqlite)).map((entry) => entry.name)).toEqual(["items", "changed", "saved"]);
    expect(sqlStatements(sqlite)).toHaveLength(3);
  });

  it("keeps T-SQL bodies through semicolons until GO, including unwrapped bodies", async () => {
    const source = `CREATE OR ALTER PROCEDURE [dbo].[save] @id int AS
BEGIN
  IF @id > 0 BEGIN SELECT @id; END;
  EXEC dbo.persist @id;
END;
GO -- batch
CREATE PROCEDURE dbo.simple AS SELECT 1; SELECT 2;
GO
CREATE PROCEDURE dbo.setup AS CREATE TABLE #items(id int); SELECT * FROM #items;
GO
CREATE VIEW dbo.saved AS SELECT 1 AS value;
GO
`;
    const units = await listSqlFunctions(source);
    expect(units.map((entry) => entry.name)).toEqual(["[save]", "simple", "setup", "saved"]);
    expect(units[0]?.source).toContain("EXEC dbo.persist");
    expect(units[1]?.source).toContain("SELECT 2;");
    expect(units[2]?.source).toContain("CREATE TABLE #items");
    expect(units[3]?.source).not.toContain("GO");
  });

  it("gives overloads different identities and preserves quoted-name case", async () => {
    const source = `CREATE FUNCTION "Math"."Value"(x integer) RETURNS int AS $$SELECT x;$$ LANGUAGE sql;
CREATE FUNCTION "Math"."Value"(x text) RETURNS text AS $$SELECT x;$$ LANGUAGE sql;`;
    const functions = await listSqlFunctions(source);
    expect(functions.map((entry) => entry.qualifiedName)).toEqual(['"Math"."Value"(integer)', '"Math"."Value"(text)']);
    const document = { uri: Uri.file("/repo/a.sql"), getText: () => source } as TextDocument;
    expect((await sqlSupport.findFunction(document, new Position(0, 25)))?.symbolId)
      .not.toBe((await sqlSupport.findFunction(document, new Position(1, 25)))?.symbolId);
  });

  it("ignores safe whitespace/comments/casing but preserves literals, operators and non-SQL bodies", () => {
    const original = "CREATE FUNCTION f(x int) RETURNS text LANGUAGE sql AS $$SELECT 'two  spaces' FROM books WHERE id >= x;$$;";
    expect(sqlFingerprint(original)).toBe(sqlFingerprint(
      "create FUNCTION f( x int ) RETURNS text language sql as $$\n -- comment\n select 'two  spaces'\n FROM books WHERE id >= x ;\n$$ ;"
    ));
    expect(sqlFingerprint(original)).not.toBe(sqlFingerprint(original.replace("two  spaces", "two spaces")));
    expect(sqlFingerprint(original)).not.toBe(sqlFingerprint(original.replace(">=", "> =")));
    expect(sqlFingerprint("SELECT 1 /* unfinished")).not.toBe(sqlFingerprint("SELECT 1"));
    expect(sqlFingerprint("SELECT 1 /*! + 2 */")).not.toBe(sqlFingerprint("SELECT 1"));
    const external = "CREATE FUNCTION f() RETURNS text LANGUAGE plpython3u AS $$return 'two  spaces'$$;";
    expect(sqlFingerprint(external)).not.toBe(sqlFingerprint(external.replace("two  spaces", "two spaces")));
    expect(sqlFingerprint('SELECT "Title" FROM books')).not.toBe(sqlFingerprint('SELECT "title" FROM books'));
    const file = original + "\nSELECT $$two  spaces$$;";
    expect(sqlFingerprint(file)).not.toBe(sqlFingerprint(file.replace("SELECT $$two  spaces$$", "SELECT $$two spaces$$")));
    expect(sqlFingerprint("SELECT a # b FROM items;")).not.toBe(sqlFingerprint("SELECT a # c FROM items;"));
    expect(sqlFingerprint("SELECT 1e2;")).not.toBe(sqlFingerprint("SELECT 1 e2;"));
    expect(sqlFingerprint("SELECT 0xff;")).not.toBe(sqlFingerprint("SELECT 0 xff;"));
  });
});

describe("SQL outlines and references", () => {
  it("outlines database objects and table columns in source order", async () => {
    const source = `-- Catalog storage.

CREATE TABLE books (
  id integer PRIMARY KEY,
  title text,
  CONSTRAINT valid CHECK (id > 0)
);
CREATE TYPE status AS ENUM ('new', 'old');
CREATE INDEX by_title ON books(title);
-- Saved available titles.
CREATE VIEW available AS SELECT title FROM books;`;
    const outline = await describeSqlSource(source);
    expect(outline.purpose).toBe("Catalog storage.");
    expect(outline.drafts.map((entry) => `${entry.kindLabel}:${entry.name}`))
      .toEqual(["Table:books", "Column:id", "Column:title", "Type:status", "Index:by_title", "View:available"]);
    expect(outline.drafts.at(-1)?.documentation).toBe("Saved available titles.");
    expect(outline.drafts.filter((entry) => entry.explainable).map((entry) => entry.name)).toEqual(["books", "status", "by_title", "available"]);
    expect(sqlPreamble("USE catalog;\nCREATE VIEW v AS SELECT 1;\nSET search_path TO public;"))
      .toBe("USE catalog;\nSET search_path TO public;");
  });

  it("resolves tables, comma joins, views and routine calls across eligible files", async () => {
    const files = {
      "app.sql": `CREATE FUNCTION caller() RETURNS int LANGUAGE sql AS $$
        SELECT h.work(a.id), v.id FROM public.items AS a, public.extra b
        JOIN public.saved v ON v.id = b.id;
      $$;`,
      "schema.sql": `CREATE TABLE public.items(id int);
CREATE TABLE public.extra(id int);
CREATE VIEW public.saved AS SELECT id FROM public.items;`,
      "helpers.sql": "CREATE FUNCTION h.work(value int) RETURNS int LANGUAGE sql AS $$SELECT value;$$;"
    };
    const result = await dependencies(files);
    expect(names(result)).toEqual(expect.arrayContaining([
      "helpers.sql:h.work(int)", "schema.sql:public.items", "schema.sql:public.extra", "schema.sql:public.saved"
    ]));
    expect(result.dependencies).toHaveLength(4);
    expect(names(await dependencies(files, "app.sql", "caller", { directCallsOnly: true }))).toEqual(["helpers.sql:h.work(int)"]);
    const first = result.dependencies[0]!.item;
    expect(first.kind).toBe("function");
    expect(first.signatureFingerprint).toBe(sqlFingerprint(first.signature));
  });

  it("skips CTEs, aliases, comments, string SQL and unresolved/system names", async () => {
    const files = {
      "app.sql": `CREATE VIEW caller AS
WITH RECURSIVE items AS (SELECT id FROM source), second AS (SELECT id FROM items)
SELECT 'FROM secret; CALL fake()' FROM items a JOIN second b ON a.id = b.id;
-- CALL fake();`,
      "schema.sql": "CREATE TABLE items(id int);\nCREATE TABLE source(id int);\nCREATE TABLE second(id int);\nCREATE TABLE secret(id int);"
    };
    expect(names(await dependencies(files))).toEqual(["schema.sql:source"]);
  });

  it("finds trigger references, CALL, EXEC, PERFORM and name-based overload candidates", async () => {
    const files = {
      "app.sql": `CREATE TRIGGER caller AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION changed();
CREATE PROCEDURE run() LANGUAGE plpgsql AS $$BEGIN CALL changed(); PERFORM changed(1); EXEC changed; END;$$;`,
      "schema.sql": `CREATE TABLE items(id int);
CREATE FUNCTION changed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;
CREATE FUNCTION changed(x int) RETURNS int LANGUAGE sql AS $$SELECT x;$$;`
    };
    const result = await dependencies(files);
    expect(names(result)).toEqual(["schema.sql:items", "schema.sql:changed()", "schema.sql:changed(int)"]);
    expect(result.limitations.join(" ")).toMatch(/overloads.*name/);
    expect(names(await dependencies(files, "app.sql", "run", { directCallsOnly: true })))
      .toEqual(["schema.sql:changed()", "schema.sql:changed(int)"]);
    const calls = await dependencies({ "app.sql": `CREATE PROCEDURE caller AS EXEC @result = dbo.persist 1;\nGO
CREATE PROCEDURE dbo.persist @id int AS SELECT @id;\nGO` }, "app.sql", "caller", { directCallsOnly: true });
    expect(names(calls)).toEqual(["app.sql:dbo.persist"]);
    expect(names(await dependencies({ "app.sql": "CREATE PROCEDURE caller() SELECT target();\nCREATE FUNCTION target() RETURNS int RETURN 1;" })))
      .toEqual(["app.sql:target()"]);
  });

  it("tracks INSERT column lists as table dependencies, not table-valued calls", async () => {
    const result = await dependencies({
      "app.sql": "CREATE PROCEDURE caller() LANGUAGE plpgsql AS $$BEGIN INSERT INTO items (id) VALUES (1); END;$$;",
      "schema.sql": "CREATE TABLE items(id int);"
    });
    expect(names(result)).toEqual(["schema.sql:items"]);
    expect(result.dependencies[0]?.item.kind).toBe("table");
  });

  it("uses explicit schemas and search_path, rejecting ambiguous unqualified schema matches", async () => {
    const schema = "CREATE TABLE a.items(id int);\nCREATE TABLE b.items(id int);";
    expect(names(await dependencies({ "app.sql": "CREATE VIEW caller AS SELECT * FROM items;", "schema.sql": schema }))).toEqual([]);
    expect(names(await dependencies({ "app.sql": "SET search_path TO b, a;\nCREATE VIEW caller AS SELECT * FROM items;", "schema.sql": schema })))
      .toEqual(["schema.sql:b.items"]);
    expect(names(await dependencies({ "app.sql": "CREATE VIEW a.caller AS SELECT * FROM items;", "schema.sql": schema })))
      .toEqual(["schema.sql:a.items"]);
    expect(names(await dependencies({ "app.sql": 'CREATE VIEW caller AS SELECT * FROM "Case"."Items";', "schema.sql": 'CREATE TABLE "Case"."Items"(id int);' })))
      .toEqual(['schema.sql:"Case"."Items"']);
    expect(names(await dependencies({ "app.sql": "CREATE VIEW caller AS SELECT * FROM case.items;", "schema.sql": 'CREATE TABLE "Case"."Items"(id int);' }))).toEqual([]);
  });

  it("uses the last lexical migration definition and reports the ordering assumption", async () => {
    const result = await dependencies({
      "app.sql": "CREATE VIEW caller AS SELECT * FROM items;",
      "001.sql": "CREATE TABLE items(id int);",
      "002.sql": "CREATE TABLE items(id int, title text);"
    });
    expect(names(result)).toEqual(["002.sql:items"]);
    expect(result.limitations.join(" ")).toContain("lexical path order");
  });

  it("reports dynamic/non-SQL bodies without pretending they are static calls", async () => {
    const files = {
      "app.sql": "CREATE PROCEDURE caller() LANGUAGE plpgsql AS $$BEGIN EXECUTE 'CALL hidden()'; END;$$;",
      "helper.sql": "CREATE PROCEDURE hidden() LANGUAGE sql AS $$SELECT 1;$$;"
    };
    const dynamic = await dependencies(files);
    expect(dynamic.dependencies).toEqual([]);
    expect(dynamic.limitations).toContain("Dynamic SQL is not resolved or tracked.");
    files["app.sql"] = "CREATE FUNCTION caller() RETURNS text LANGUAGE plpython3u AS $$return hidden()$$;";
    const external = await dependencies(files);
    expect(external.dependencies).toEqual([]);
    expect(external.limitations).toContain("Non-SQL routine bodies are not resolved.");
    files["app.sql"] = "CREATE PROCEDURE caller() LANGUAGE plpgsql AS $$BEGIN EXECUTE hidden; END;$$;";
    const variable = await dependencies(files);
    expect(variable.dependencies).toEqual([]);
    expect(variable.limitations).toContain("Dynamic SQL is not resolved or tracked.");
  });

  it("honors readable paths, onlyName, item/size/file budgets, time and unsaved content", async () => {
    const files: Record<string, string> = {
      "app.sql": "CREATE VIEW caller AS SELECT work() FROM items;",
      "schema.sql": "CREATE TABLE items(id int);",
      "helper.sql": "CREATE FUNCTION work() RETURNS int LANGUAGE sql AS $$SELECT 42;$$;"
    };
    const load = vi.fn(async () => { throw new Error("Do not read excluded paths"); });
    expect(names(await dependencies(files, "app.sql", "caller", { readablePaths: new Set(["app.sql"]), load }))).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(names(await dependencies(files, "app.sql", "caller", { onlyName: "missing", load }))).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(names(await dependencies(files, "app.sql", "caller", { onlyName: "work" }))).toEqual(["helper.sql:work()"]);
    expect((await dependencies(files, "app.sql", "caller", { maxDependencies: 1 })).dependencies).toHaveLength(1);
    const expired = await dependencies(files, "app.sql", "caller", { deadline: 0, load });
    expect(expired.dependencies).toEqual([]);
    expect(expired.limitations.join(" ")).toContain("time limit");
    expect(load).not.toHaveBeenCalled();
    expect((await dependencies(files)).dependencies[0]?.item.source).toContain("SELECT 42");
    const oversized = await dependencies(files, "app.sql", "caller", {
      load: async (path) => path === "helper.sql" ? " ".repeat(256 * 1024 + 1) : files[path]
    });
    expect(names(oversized)).toEqual(["schema.sql:items"]);
    expect(oversized.limitations.join(" ")).toContain("text budget");
    const many = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`${String(index).padStart(3, "0")}.sql`, "SELECT 1;"]));
    const count = vi.fn(async (path: string) => many[path]);
    const bounded = await dependencies({ "app.sql": files["app.sql"]!, ...many }, "app.sql", "caller", { load: count });
    expect(count).toHaveBeenCalledTimes(99);
    expect(bounded.limitations.join(" ")).toContain("100-file");
  });

  it("tracks real SQL context through formatting, dependency bodies, depth-2 signatures and schema changes", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-sql-")));
    let source = "SET search_path TO public;\nCREATE FUNCTION caller() RETURNS int LANGUAGE sql AS $$SELECT helper() FROM items;$$;\n";
    let helper = "CREATE FUNCTION helper() RETURNS int LANGUAGE sql AS $$SELECT leaf();$$;\n";
    let leaf = "CREATE FUNCTION leaf() RETURNS int LANGUAGE sql AS $$SELECT 1;$$;\n";
    let schema = "CREATE TABLE items(id int);\n";
    const document = { uri: Uri.file(resolve(root, "app.sql")), languageId: "sql", version: 1, getText: () => source } as TextDocument;
    const context = async () => {
      await Promise.all([
        writeFile(resolve(root, "app.sql"), source),
        writeFile(resolve(root, "helper.sql"), helper),
        writeFile(resolve(root, "leaf.sql"), leaf),
        writeFile(resolve(root, "schema.sql"), schema)
      ]);
      const target = await sqlSupport.findFunction(document, new Position(1, 20));
      return gatherFunctionContext(target!, document, await gatherInventory(root));
    };
    try {
      const original = await context();
      expect(original.inputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "helper.sql", description: "function helper()", depth: 1, scope: "body" }),
        expect.objectContaining({ path: "schema.sql", description: "table items", depth: 1, scope: "body" }),
        expect.objectContaining({ path: "leaf.sql", description: "signature of function leaf(), used by helper()", depth: 2, scope: "signature" })
      ]));
      helper = helper.replace("SELECT leaf();", "\n-- formatting only\nselect leaf( );\n");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(true);
      leaf = leaf.replace("SELECT 1", "SELECT 2");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(true);
      leaf = leaf.replace("RETURNS int", "RETURNS bigint");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
      leaf = leaf.replace("RETURNS bigint", "RETURNS int");
      helper = helper.replace("leaf( )", "leaf( ) + 1");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
      helper = helper.replace("leaf( ) + 1", "leaf( )");
      schema = schema.replace("id int", "id bigint");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
      schema = schema.replace("id bigint", "id int");
      source = source.replace("TO public", "TO other");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
