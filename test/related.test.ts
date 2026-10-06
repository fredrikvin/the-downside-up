import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inputsMatch } from "../src/cache/freshness";
import { gatherInventory } from "../src/context/inventory";
import { gatherFunctionContext } from "../src/context/related";
import type { FunctionTarget } from "../src/core/types";
import { initializeRustParserAt, listRustFunctions } from "../src/languages/rust";
import { Position, Range, Uri, workspace } from "./vscode";

let root: string;

beforeAll(async () => {
  await initializeRustParserAt(resolve("."));
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

  it("marks the explanation outdated only when a used item changes", async () => {
    const original = await checkoutContext();

    await editStorage("write!(formatter, \"book not available: {title}\")", "write!(formatter, \"unavailable: {title}\")");
    expect(inputsMatch(original.inputs, (await checkoutContext()).inputs)).toBe(true);

    await editStorage("if book.title.is_empty() {", "if book.title.len() < 2 {");
    expect(inputsMatch(original.inputs, (await checkoutContext()).inputs)).toBe(false);
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
