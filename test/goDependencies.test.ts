import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findGoDependencies, type GoDependencyRequest } from "../src/context/goDependencies";
import { initializeGoParserAt, listGoFunctions } from "../src/languages/go";

const fixtureRoot = resolve("fixtures/go-app");
const fixtureFiles = [
  "go.mod",
  "main.go",
  "report.go",
  "main_test.go",
  "inventory/inventory.go",
  "inventory/lookup.go",
  "storage/storage.go"
];

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
  extra: Partial<GoDependencyRequest> = {}
): GoDependencyRequest {
  const text = files[path]!;
  const line = text.split("\n").findIndex((entry) => new RegExp(`^func (?:\\([^)]*\\) )?${name}\\b`).test(entry));
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
  const result = await findGoDependencies(request(files, path, name));
  return result.dependencies.map(({ path: file, item }) => `${file} ${item.kind} ${item.qualifiedName}`).sort();
}

beforeAll(async () => {
  await initializeGoParserAt(resolve("."));
});

describe("Go function discovery", () => {
  it("names methods by receiver type and numbers repeated init functions", async () => {
    const source = [
      "package demo",
      "func init() {}",
      "func init() {}",
      "type Box[T any] struct{ v T }",
      "func (b *Box[T]) Get() T { return b.v }",
      "func (Box[T]) Kind() string { return \"box\" }",
      "func Make() Box[int] { return Box[int]{} }"
    ].join("\n");
    const functions = await listGoFunctions({ getText: () => source });
    expect(functions.map((entry) => [entry.qualifiedName, entry.startLine])).toEqual([
      ["init", 1],
      ["init#2", 2],
      ["Box.Get", 4],
      ["Box.Kind", 5],
      ["Make", 6]
    ]);
    expect(functions[2]!.signature).toBe("func (b *Box[T]) Get() T");
  });
});

describe("Go dependencies", () => {
  it("finds items from imported packages, including methods declared in sibling files", async () => {
    expect(await dependencies(fixture(), "main.go", "checkout")).toEqual([
      "inventory/inventory.go type Book",
      "inventory/inventory.go type Catalog",
      "inventory/lookup.go method Catalog.FindAvailable",
      "inventory/lookup.go method Catalog.MarkUnavailable",
      "storage/storage.go function Persist",
      "storage/storage.go type StoreError"
    ]);
  });

  it("finds same-package functions in sibling files and methods on returned types", async () => {
    expect(await dependencies(fixture(), "main.go", "main")).toEqual([
      "inventory/inventory.go function NewCatalog",
      "inventory/inventory.go method Catalog.Add",
      "inventory/inventory.go type Book",
      "main.go function checkout",
      "report.go function describe"
    ]);
    expect(await dependencies(fixture(), "storage/storage.go", "Persist")).toEqual([
      "inventory/inventory.go type Book",
      "storage/storage.go constant MaxTitleLength",
      "storage/storage.go type StoreError"
    ]);
  });

  it("lets tests use the package's other files, and keeps test files out of normal lookups", async () => {
    expect(await dependencies(fixture(), "main_test.go", "TestCheckoutMarksBookUnavailable")).toEqual([
      "inventory/inventory.go function NewCatalog",
      "inventory/inventory.go method Catalog.Add",
      "inventory/inventory.go type Book",
      "inventory/lookup.go method Catalog.FindAvailable",
      "main.go function checkout"
    ]);
    const files = fixture({ "main_test.go": "package main\n\nfunc describe(x int) string { return \"\" }\n" });
    expect(await dependencies(files, "main.go", "main")).toContain("report.go function describe");
  });

  it("returns the import block as the preamble", async () => {
    const result = await findGoDependencies(request(fixture(), "main.go", "checkout"));
    expect(result.preamble).toBe([
      "package main",
      "import (\n\t\"fmt\"\n\n\t\"example.com/library/inventory\"\n\t\"example.com/library/storage\"\n)"
    ].join("\n"));
  });

  it("changes fingerprints for body edits but not for formatting", async () => {
    const findAvailableOf = async (files: Record<string, string>) =>
      (await findGoDependencies(request(files, "main.go", "checkout"))).dependencies
        .find(({ item }) => item.name === "FindAvailable")!.item;
    const lookup = fixture()["inventory/lookup.go"]!;
    const original = await findAvailableOf(fixture());
    const reformatted = await findAvailableOf(fixture({
      "inventory/lookup.go": lookup.replace("return book, true", "return book,   true")
    }));
    const edited = await findAvailableOf(fixture({
      "inventory/lookup.go": lookup.replace("book.Available && book.Title == title", "book.Title == title")
    }));
    expect(reformatted.fingerprint).toBe(original.fingerprint);
    expect(edited.fingerprint).not.toBe(original.fingerprint);
    expect(edited.signatureFingerprint).toBe(original.signatureFingerprint);
  });

  it("handles aliases, dot imports, grouped declarations, external packages, and missing modules", async () => {
    const files: Record<string, string> = {
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "util/util.go": [
        "package util",
        "const (",
        "\tLow = iota",
        "\tHigh",
        ")",
        "type (",
        "\tLevel int",
        "\tName = string",
        ")",
        "var (",
        "\tDefault Level = 1",
        "\tOther = 2",
        ")",
        "func Clamp(l Level) Level { return l }"
      ].join("\n"),
      "dot/dot.go": "package dot\n\nfunc Helper() int { return 1 }\n",
      "cmd/run.go": [
        "package main",
        "import (",
        "\tu \"example.com/app/util\"",
        "\t. \"example.com/app/dot\"",
        "\t_ \"example.com/app/unused\"",
        "\t\"github.com/other/lib\"",
        ")",
        "func run() u.Level { lib.Do(); _ = u.High; var n u.Name; _ = n; _ = u.Default; return u.Clamp(u.Level(Helper())) }"
      ].join("\n")
    };
    expect(await dependencies(files, "cmd/run.go", "run")).toEqual([
      "dot/dot.go function Helper",
      "util/util.go constant High",
      "util/util.go function Clamp",
      "util/util.go type Level",
      "util/util.go type alias Name",
      "util/util.go variable Default"
    ]);
    const high = (await findGoDependencies(request(files, "cmd/run.go", "run"))).dependencies
      .find(({ item }) => item.name === "High")!.item;
    expect(high.source).toContain("Low = iota");

    const { "go.mod": _mod, ...withoutModule } = files;
    const unresolved = await findGoDependencies(request(withoutModule, "cmd/run.go", "run"));
    expect(unresolved.dependencies).toEqual([]);
    expect(unresolved.limitations.join(" ")).toContain("No go.mod module path");
  });

  it("reports unread package files and caps the number of tracked items", async () => {
    const files = fixture();
    const { "inventory/lookup.go": _lookup, ...readable } = files;
    const unread = await findGoDependencies(request(files, "main.go", "checkout", {
      readablePaths: new Set(Object.keys(readable)),
      unreadPaths: new Set(["inventory/lookup.go"])
    }));
    expect(unread.dependencies.some(({ path }) => path === "inventory/lookup.go")).toBe(false);
    expect(unread.limitations.join(" ")).toContain("inventory/lookup.go was not read");

    const capped = await findGoDependencies(request(files, "main.go", "checkout", { maxDependencies: 2 }));
    expect(capped.dependencies).toHaveLength(2);
    expect(capped.limitations.join(" ")).toContain("Only the first 2");
  });
});
