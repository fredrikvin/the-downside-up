import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inputsMatch } from "../src/cache/freshness";
import { gatherInventory } from "../src/context/inventory";
import { findCalledFunctions, gatherFunctionContext } from "../src/context/related";
import type { FunctionTarget } from "../src/core/types";
import { initializeGoParserAt, listGoFunctions } from "../src/languages/go/syntax";
import { initializeRustParserAt, listRustFunctions } from "../src/languages/rust/syntax";
import { Position, Range, Uri, workspace } from "./vscode";

let root: string;

beforeAll(async () => {
  await initializeRustParserAt(resolve("."));
  await initializeGoParserAt(resolve("."));
});

beforeEach(async () => {
  workspace.__resetConfiguration();
  root = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-related-")));
  await mkdir(resolve(root, "src"));
  for (const file of ["Cargo.toml", "src/main.rs", "src/inventory.rs", "src/storage.rs"]) {
    await copyFile(resolve("fixtures/rust-app", file), resolve(root, file));
  }
});

afterEach(async () => {
  workspace.__resetConfiguration();
  await rm(root, { recursive: true, force: true });
});

async function checkoutContext() {
  const path = resolve(root, "src/main.rs");
  const text = await readFile(path, "utf8");
  const document = {
    uri: Uri.file(path),
    languageId: "rust",
    version: 1,
    getText: () => text
  } as unknown as import("vscode").TextDocument;
  const checkout = (await listRustFunctions(document)).find((entry) => entry.name === "checkout")!;
  const target = {
    uri: document.uri,
    range: new Range(new Position(checkout.startLine, 0), new Position(checkout.endLine, 1)),
    selection: new Range(new Position(checkout.startLine, 3), new Position(checkout.startLine, 11)),
    languageId: "rust",
    name: "checkout",
    qualifiedName: "checkout",
    signature: checkout.signature,
    source: checkout.source,
    symbolId: "symbol-checkout",
    structuralFingerprint: checkout.fingerprint,
    analysis: "rust-tree-sitter"
  } as unknown as FunctionTarget;
  return gatherFunctionContext(target, document, await gatherInventory(root));
}

async function editStorage(from: string, to: string): Promise<void> {
  const path = resolve(root, "src/storage.rs");
  const text = await readFile(path, "utf8");
  if (!text.includes(from)) throw new Error(`storage.rs does not contain ${from}`);
  await writeFile(path, text.replace(from, to));
}

describe("Rust function context across files", () => {
  it("sends and tracks items used from other files at depth 1", async () => {
    const context = await checkoutContext();
    const crossFile = context.inputs.filter((input) => input.path !== "src/main.rs");
    expect(crossFile.map((input) => [input.path, input.description, input.depth, input.scope]).sort()).toEqual([
      ["src/inventory.rs", "method Catalog::find_available", 1, "body"],
      ["src/inventory.rs", "method Catalog::mark_unavailable", 1, "body"],
      ["src/inventory.rs", "struct Book", 1, "body"],
      ["src/inventory.rs", "struct Catalog", 1, "body"],
      ["src/storage.rs", "enum StoreError", 1, "body"],
      ["src/storage.rs", "function persist", 1, "body"]
    ]);
    expect(context.text).toContain("--- src/storage.rs (function persist) ---\npub fn persist(book: &Book)");
  });

  it("reads the files it uses on demand, even ones priming did not read", async () => {
    // Enough other files that priming's read stops before the crate's modules.
    for (let index = 0; index < 60; index++) await writeFile(resolve(root, `note${String(index).padStart(2, "0")}.md`), `Note ${index}.\n`);
    const inventory = await gatherInventory(root);
    expect(inventory.files.map((file) => file.relativePath)).not.toContain("src/storage.rs");
    expect(inventory.snapshot["src/storage.rs"]).toMatch(/^unread:/);
    const context = await checkoutContext();
    expect(context.inputs.map((input) => `${input.path} ${input.description}`)).toContain("src/storage.rs function persist");
    expect(context.limitations.join(" ")).not.toMatch(/read budget/);
  });

  it("marks the explanation outdated only when a used item changes", async () => {
    const original = await checkoutContext();

    await editStorage("write!(formatter, \"book not available: {title}\")", "write!(formatter, \"unavailable: {title}\")");
    expect(inputsMatch(original.inputs, (await checkoutContext()).inputs)).toBe(true);

    await editStorage("if book.title.is_empty() {", "if book.title.len() < 2 {");
    expect(inputsMatch(original.inputs, (await checkoutContext()).inputs)).toBe(false);
  });

  it("adds depth-2 signatures of functions that helpers in other files call", async () => {
    const inventoryPath = resolve(root, "src/inventory.rs");
    await writeFile(inventoryPath, (await readFile(inventoryPath, "utf8")) + "\npub fn audit(book: &Book) -> bool {\n    !book.title.is_empty()\n}\n");
    await editStorage("    if book.title.is_empty() {", "    crate::inventory::audit(book);\n    if book.title.is_empty() {");
    const context = await checkoutContext();
    const audit = context.inputs.find((input) => input.description.includes("audit"));
    expect(audit).toMatchObject({
      path: "src/inventory.rs",
      description: "signature of function audit, used by persist",
      depth: 2,
      scope: "signature"
    });
    expect(context.text).toContain("pub fn audit(book: &Book) -> bool");
    expect(context.text).not.toContain("!book.title.is_empty()");
  });

  it("tracks a dependency too large to send by its signature only", async () => {
    const padding = Array.from({ length: 200 }, (_, index) => `    let _unused_${index} = ${index};`).join("\n");
    await editStorage("    if book.title.is_empty() {", `${padding}\n    if book.title.is_empty() {`);
    const large = await checkoutContext();
    const persist = large.inputs.find((input) => input.description.endsWith("function persist"))!;
    expect(persist).toMatchObject({ description: "signature of function persist", scope: "signature", depth: 1 });
    expect(large.text).not.toContain("_unused_0");
    expect(large.limitations.join(" ")).toContain("tracked by signature only");

    await editStorage("if book.title.is_empty() {", "if book.title.len() < 2 {");
    expect(inputsMatch(large.inputs, (await checkoutContext()).inputs)).toBe(true);

    await editStorage("pub fn persist(book: &Book)", "pub fn persist(book: &Book, _retries: u8)");
    expect(inputsMatch(large.inputs, (await checkoutContext()).inputs)).toBe(false);
  });
});

describe("Go function context", () => {
  let goRoot: string;

  beforeEach(async () => {
    goRoot = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-go-related-")));
    for (const file of ["go.mod", "main.go", "report.go", "inventory/inventory.go", "inventory/lookup.go", "storage/storage.go"]) {
      await mkdir(resolve(goRoot, file, ".."), { recursive: true });
      await copyFile(resolve("fixtures/go-app", file), resolve(goRoot, file));
    }
  });

  afterEach(async () => {
    await rm(goRoot, { recursive: true, force: true });
  });

  async function goContext(name: string) {
    const path = resolve(goRoot, "main.go");
    const text = await readFile(path, "utf8");
    const document = {
      uri: Uri.file(path),
      languageId: "go",
      version: 1,
      getText: () => text
    } as unknown as import("vscode").TextDocument;
    const entry = (await listGoFunctions(document)).find((candidate) => candidate.name === name)!;
    const target = {
      uri: document.uri,
      range: new Range(new Position(entry.startLine, 0), new Position(entry.endLine, 1)),
      selection: new Range(new Position(entry.startLine, 5), new Position(entry.startLine, 5 + name.length)),
      languageId: "go",
      name,
      qualifiedName: entry.qualifiedName,
      signature: entry.signature,
      source: entry.source,
      symbolId: `symbol-${name}`,
      structuralFingerprint: entry.fingerprint,
      analysis: "go-tree-sitter"
    } as unknown as FunctionTarget;
    return gatherFunctionContext(target, document, await gatherInventory(goRoot));
  }

  async function edit(file: string, from: string, to: string): Promise<void> {
    const path = resolve(goRoot, file);
    const text = await readFile(path, "utf8");
    if (!text.includes(from)) throw new Error(`${file} does not contain ${from}`);
    await writeFile(path, text.replace(from, to));
  }

  it("tracks the import block and items used from this and other packages", async () => {
    const context = await goContext("main");
    expect(context.inputs.map((input) => [input.path, input.description, input.depth, input.scope]).sort()).toEqual([
      ["inventory/inventory.go", "function NewCatalog", 1, "body"],
      ["inventory/inventory.go", "method Catalog.Add", 1, "body"],
      ["inventory/inventory.go", "type Book", 1, "body"],
      ["inventory/lookup.go", "signature of method Catalog.FindAvailable, used by checkout", 2, "signature"],
      ["inventory/lookup.go", "signature of method Catalog.MarkUnavailable, used by checkout", 2, "signature"],
      ["main.go", "function checkout", 1, "body"],
      ["main.go", "module imports and declarations", undefined, undefined],
      ["main.go", "selected main", 0, undefined],
      ["report.go", "function describe", 1, "body"],
      ["storage/storage.go", "signature of function Persist, used by checkout", 2, "signature"]
    ]);
    expect(context.text).toContain("func Persist(book inventory.Book) error");
    expect(context.text).not.toContain("len(book.Title) > MaxTitleLength");
    expect(context.text).toContain("\"example.com/library/storage\"");
  });

  it("tracks depth-2 functions by signature: body edits keep it current, signature edits outdate it", async () => {
    const original = await goContext("main");

    await edit("storage/storage.go", "len(book.Title) > MaxTitleLength", "len(book.Title) >= MaxTitleLength");
    expect(inputsMatch(original.inputs, (await goContext("main")).inputs)).toBe(true);

    await edit("storage/storage.go", "func Persist(book inventory.Book) error", "func Persist(book inventory.Book, force bool) error");
    expect(inputsMatch(original.inputs, (await goContext("main")).inputs)).toBe(false);
  });

  it("marks the explanation outdated only when a used item changes", async () => {
    const original = await goContext("checkout");

    await edit("inventory/inventory.go", "c.books = append(c.books, book)", "c.books = append([]Book{book}, c.books...)");
    expect(inputsMatch(original.inputs, (await goContext("checkout")).inputs)).toBe(true);

    await edit("inventory/lookup.go", "book.Available && book.Title == title", "book.Title == title");
    expect(inputsMatch(original.inputs, (await goContext("checkout")).inputs)).toBe(false);
  });
});

describe("called functions for hovers and prefetching", () => {
  async function calledFrom(root: string, file: string, languageId: "rust" | "go", name: string) {
    const path = resolve(root, file);
    const text = await readFile(path, "utf8");
    const document = { uri: Uri.file(path), languageId, version: 1, getText: () => text } as unknown as import("vscode").TextDocument;
    const entries = languageId === "rust" ? await listRustFunctions(document) : await listGoFunctions(document);
    const entry = entries.find((candidate) => candidate.name === name)!;
    const target = {
      uri: document.uri,
      range: new Range(new Position(entry.startLine, 0), new Position(entry.endLine, 1)),
      selection: new Range(new Position(entry.startLine, 0), new Position(entry.startLine, 1)),
      languageId,
      name,
      qualifiedName: entry.qualifiedName,
      signature: entry.signature,
      source: entry.source,
      symbolId: `symbol-${name}`,
      structuralFingerprint: entry.fingerprint,
      analysis: `${languageId}-tree-sitter`
    } as unknown as FunctionTarget;
    return (await findCalledFunctions(target, document, await gatherInventory(root)))
      .map((called) => `${called.path}:${called.line} ${called.qualifiedName}`);
  }

  it("lists Rust calls in other files and the same file with their lines", async () => {
    expect(await calledFrom(root, "src/main.rs", "rust", "main")).toEqual([
      "src/inventory.rs:12 Catalog::add",
      "src/main.rs:19 checkout"
    ]);
  });

  it("lists Go calls across packages in order of first use", async () => {
    const goRoot = resolve("fixtures/go-app");
    expect(await calledFrom(goRoot, "main.go", "go", "checkout")).toEqual([
      "storage/storage.go:22 Persist",
      "inventory/lookup.go:3 Catalog.FindAvailable",
      "inventory/lookup.go:13 Catalog.MarkUnavailable"
    ]);
  });
});
