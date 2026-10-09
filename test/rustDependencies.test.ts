import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findRustDependencies, type RustDependencyRequest } from "../src/languages/rust/dependencies";
import { initializeRustParserAt } from "../src/languages/rust/syntax";

const fixtureRoot = resolve("fixtures/rust-app");
const fixtureFiles = ["Cargo.toml", "src/main.rs", "src/inventory.rs", "src/storage.rs"];

function fixture(overrides: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(fixtureFiles.map((path) => [
    path,
    overrides[path] ?? readFileSync(resolve(fixtureRoot, path), "utf8")
  ]));
}

function request(
  files: Record<string, string>,
  path: string,
  name: string,
  extra: Partial<RustDependencyRequest> = {}
): RustDependencyRequest {
  const text = files[path]!;
  const line = text.split("\n").findIndex((entry) => new RegExp(`\\bfn ${name}\\b`).test(entry));
  if (line < 0) throw new Error(`No function ${name} in ${path}`);
  return {
    path,
    text,
    line,
    name,
    readablePaths: new Set(Object.keys(files)),
    load: async (file) => files[file],
    ...extra
  };
}

async function dependencies(files: Record<string, string>, path: string, name: string) {
  const result = await findRustDependencies(request(files, path, name));
  return result.dependencies.map(({ path: file, item }) => `${file} ${item.kind} ${item.qualifiedName}`).sort();
}

beforeAll(async () => {
  await initializeRustParserAt(resolve("."));
});

describe("Rust cross-file dependencies", () => {
  it("finds types, functions, and methods a function uses from other files", async () => {
    expect(await dependencies(fixture(), "src/main.rs", "checkout")).toEqual([
      "src/inventory.rs method Catalog::find_available",
      "src/inventory.rs method Catalog::mark_unavailable",
      "src/inventory.rs struct Book",
      "src/inventory.rs struct Catalog",
      "src/storage.rs enum StoreError",
      "src/storage.rs function persist"
    ]);
    expect(await dependencies(fixture(), "src/main.rs", "main")).toEqual([
      "src/inventory.rs method Catalog::add",
      "src/inventory.rs struct Book",
      "src/inventory.rs struct Catalog"
    ]);
  });

  it("resolves `use super::*` in an inline test module and `crate::` paths", async () => {
    expect(await dependencies(fixture(), "src/main.rs", "checkout_marks_matching_book_unavailable")).toEqual([
      "src/inventory.rs method Catalog::add",
      "src/inventory.rs method Catalog::find_available",
      "src/inventory.rs struct Book",
      "src/inventory.rs struct Catalog"
    ]);
    expect(await dependencies(fixture(), "src/storage.rs", "persist")).toEqual(["src/inventory.rs struct Book"]);
  });

  it("changes a dependency's fingerprint for body edits but not for formatting", async () => {
    const persistOf = async (files: Record<string, string>) =>
      (await findRustDependencies(request(files, "src/main.rs", "checkout"))).dependencies
        .find(({ item }) => item.name === "persist")!.item;
    const original = await persistOf(fixture());
    const storage = fixture()["src/storage.rs"]!;
    const reformatted = await persistOf(fixture({
      "src/storage.rs": storage.replace("if book.title.is_empty() {", "if book.title.is_empty()\n    {")
    }));
    const edited = await persistOf(fixture({
      "src/storage.rs": storage.replace("if book.title.is_empty() {", "if book.title.len() < 2 {")
    }));
    expect(reformatted.fingerprint).toBe(original.fingerprint);
    expect(edited.fingerprint).not.toBe(original.fingerprint);
    expect(edited.signatureFingerprint).toBe(original.signatureFingerprint);
  });

  it("tracks attributes that change a type's meaning", async () => {
    const catalogOf = async (files: Record<string, string>) =>
      (await findRustDependencies(request(files, "src/main.rs", "main"))).dependencies
        .find(({ item }) => item.name === "Catalog")!.item;
    const inventory = fixture()["src/inventory.rs"]!;
    const original = await catalogOf(fixture());
    const withoutDerive = await catalogOf(fixture({
      "src/inventory.rs": inventory.replace("#[derive(Default)]\n", "")
    }));
    expect(original.source).toContain("#[derive(Default)]");
    expect(withoutDerive.fingerprint).not.toBe(original.fingerprint);
  });

  it("follows Cargo module layout, the package name, self/super, inline modules, and macro paths, skipping external crates", async () => {
    const files = {
      "Cargo.toml": "[package]\nname = \"my-crate\"\nversion = \"0.1.0\"\n\n[dependencies]\nserde = \"1\"\n",
      "src/lib.rs": "pub mod util;\nmod inner {\n    pub struct Hidden;\n}\npub fn top() {}\npub fn flag() -> bool { true }\n",
      "src/util/mod.rs": "pub mod deep;\npub fn helper() -> u8 { 1 }\n",
      "src/util/deep.rs": [
        "use super::helper;",
        "use self::nested::Thing;",
        "use crate::inner::Hidden;",
        "use serde::Serialize;",
        "mod nested { pub struct Thing; }",
        "pub fn run() -> u8 { let _h = Hidden; let _t = Thing; crate::top(); assert!(crate::flag()); helper() }"
      ].join("\n"),
      "tests/it.rs": "use my_crate::util::helper;\nfn check() { helper(); my_crate::util::deep::run(); }\n"
    };
    expect(await dependencies(files, "src/util/deep.rs", "run")).toEqual([
      "src/lib.rs function flag",
      "src/lib.rs function top",
      "src/lib.rs struct inner::Hidden",
      "src/util/mod.rs function helper"
    ]);
    expect(await dependencies(files, "tests/it.rs", "check")).toEqual([
      "src/util/deep.rs function run",
      "src/util/mod.rs function helper"
    ]);
  });

  it("reports unread module files and caps the number of tracked items", async () => {
    const files = fixture();
    const { "src/storage.rs": _storage, ...readable } = files;
    const unread = await findRustDependencies(request(files, "src/main.rs", "checkout", {
      readablePaths: new Set(Object.keys(readable)),
      unreadPaths: new Set(["src/storage.rs"])
    }));
    expect(unread.dependencies.some(({ path }) => path === "src/storage.rs")).toBe(false);
    expect(unread.limitations.join(" ")).toContain("src/storage.rs was not read");

    const capped = await findRustDependencies(request(files, "src/main.rs", "checkout", { maxDependencies: 2 }));
    expect(capped.dependencies).toHaveLength(2);
    expect(capped.limitations.join(" ")).toContain("Only the first 2");
  });
});
