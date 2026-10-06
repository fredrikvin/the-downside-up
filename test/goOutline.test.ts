import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFileOverview } from "../src/context/fileOverview";
import type { Description } from "../src/context/outlineText";
import { initializeGoParserAt } from "../src/languages/go";
import { describeGoSource } from "../src/languages/goOutline";
import { Uri } from "./vscode";

const flat = (description: Description): string =>
  description.map((segment) => (segment.code ? `\`${segment.text}\`` : segment.text)).join("");

async function outline(source: string) {
  const result = await describeGoSource(source);
  return {
    purpose: result.purpose,
    entries: [...result.drafts].sort((left, right) => left.startLine - right.startLine || left.depth - right.depth)
  };
}

const fixture = (name: string) => readFileSync(resolve("fixtures/go-app", name), "utf8");

beforeAll(async () => {
  await initializeGoParserAt(resolve("."));
});

describe("Go local descriptions", () => {
  it("describes the fixture's main.go in source order", async () => {
    const { purpose, entries } = await outline(fixture("main.go"));
    expect(purpose).toBeUndefined();
    expect(entries.map((entry) => [entry.startLine, entry.depth, entry.kindLabel, flat(entry.description)])).toEqual([
      [0, 0, "Package", "Package `main`, which builds an executable program."],
      [2, 0, "Import", "Imports packages `fmt` (standard library), `example.com/library/inventory`, and `example.com/library/storage`."],
      [9, 0, "Function", "Function `main` takes no arguments and returns nothing."],
      [10, 1, "Local", "Declares local `catalog`, set to `inventory.NewCatalog()`."],
      [13, 1, "Local", "Declares locals `book` and `err`, set to `checkout(catalog, \"The Left Hand of Darkness\")`."],
      [21, 0, "Function", "Function `checkout` takes `catalog` (`*inventory.Catalog`) and `title` (`string`) and returns `inventory.Book` and `error`."],
      [23, 1, "Local", "Declares locals `book` and `ok`, set to `catalog.FindAvailable(title)`."]
    ]);
    const main = entries.find((entry) => entry.name === "main" && entry.kindLabel === "Function")!;
    expect(main.notes.map(flat)).toEqual(["Program entry point: runs when the program starts."]);
    const checkout = entries.find((entry) => entry.name === "checkout")!;
    expect(checkout).toMatchObject({
      documentation: "checkout takes an available book out of the catalog and records it.",
      explainable: true,
      nameLine: 22,
      nameStart: 5,
      nameEnd: 13
    });
  });

  it("describes methods by receiver, structs, and the package comment", async () => {
    const inventory = await outline(fixture("inventory/inventory.go"));
    expect(inventory.purpose).toBe("Package inventory keeps the library's catalog of books.");
    expect(inventory.entries.map((entry) => [entry.kindLabel, entry.qualifiedName, flat(entry.description)])).toEqual([
      ["Package", "inventory", "Package `inventory`."],
      ["Struct", "Book", "Exported struct `Book` with fields `Title` (`string`) and `Available` (`bool`)."],
      ["Struct", "Catalog", "Exported struct `Catalog` with field `books` (`[]Book`)."],
      ["Function", "NewCatalog", "Exported function `NewCatalog` takes no arguments and returns `*Catalog`."],
      ["Method", "Catalog.Add", "Exported method `Add` of `Catalog` takes `book` (`Book`) and returns nothing."]
    ]);
    const add = inventory.entries.find((entry) => entry.qualifiedName === "Catalog.Add")!;
    expect(add.name).toBe("Add");
    expect(add.notes.map(flat)).toEqual(["Pointer receiver `c *Catalog`: changes through it affect the caller's value."]);
    expect(add.startLine).toBe(19);
  });

  it("covers groups, iota, interfaces, embedding, generics, directives, and special functions", async () => {
    const source = [
      "//go:build linux",
      "",
      "// Package demo shows things.",
      "package demo",
      "",
      "// Kinds of loans.",
      "const (",
      "\t// Short loans.",
      "\tShort = iota",
      "\tLong",
      ")",
      "",
      "type Store interface {",
      "\tio.Reader",
      "\tSave(b Book) error",
      "}",
      "type Number interface{ ~int | ~float64 }",
      "type Any interface{}",
      "type Shelf struct {",
      "\tBase",
      "\t*Other",
      "\tName string `json:\"name\"`",
      "\ta, b int",
      "}",
      "type Level int",
      "type Alias = string",
      "var registry = map[string]int{}",
      "",
      "//go:generate stringer -type=Level",
      "func Sum[T Number](prefix string, values ...T) (total T, err error) {",
      "\tvar n int",
      "\tconst k = 3",
      "\treturn",
      "}",
      "",
      "// A comment that documents nothing.",
      "",
      "func (s Shelf) Kind() string { return \"\" }",
      "func init() {}",
      "func TestX(t *testing.T) {}",
      "func Testing(t *testing.T) {}"
    ].join("\n");
    const { purpose, entries } = await outline(source);
    expect(purpose).toBe("Package demo shows things.");
    expect(entries.map((entry) => [entry.depth, entry.kindLabel, flat(entry.description), entry.notes.map(flat).join(" | ")])).toEqual([
      [0, "Package", "Package `demo`.", "Built only when `linux` holds."],
      [0, "Constants", "Groups constants `Short` and `Long`.", "`iota` counts 0, 1, 2, … through this group, and a constant without a value repeats the previous expression."],
      [1, "Constant", "Exported constant `Short`, set to `iota`.", ""],
      [1, "Constant", "Exported constant `Long`, repeating `iota` for the next position in the group.", ""],
      [0, "Interface", "Exported interface `Store` requiring method `Save` and embedding `io.Reader`.", ""],
      [0, "Interface", "Exported interface `Number` allowing types `~int | ~float64`.", ""],
      [0, "Interface", "Exported interface `Any` with no methods, so every type satisfies it.", ""],
      [0, "Struct", "Exported struct `Shelf` with fields `Name` (`string`) and `a, b` (`int`), embedding `Base` and `*Other`.", ""],
      [0, "Type", "Exported type `Level` defined as `int`.", "A distinct type: values of `int` need a conversion to become `Level`."],
      [0, "Type alias", "Exported type alias `Alias` for `string`.", ""],
      [0, "Variable", "Package variable `registry`, set to `map[string]int{}`.", ""],
      [0, "Function", "Exported function `Sum` takes `prefix` (`string`) and `values` (any number of `T` values) and returns `total` (`T`) and `err` (`error`).", "`go generate` runs `stringer -type=Level`. | Generic over `[T Number]`."],
      [1, "Local", "Declares local `n` of type `int`, starting at its zero value.", ""],
      [1, "Local", "Declares local constant `k`, set to `3`.", ""],
      [0, "Comment", "A comment that documents nothing.", ""],
      [0, "Method", "Exported method `Kind` of `Shelf` takes no arguments and returns `string`.", "Value receiver `s Shelf`: the method works on a copy."],
      [0, "Function", "Function `init` takes no arguments and returns nothing.", "Runs automatically when the package is initialized, before `main`."],
      [0, "Function", "Exported function `TestX` takes `t` (`*testing.T`) and returns nothing.", "Runs as a test with `go test`."],
      [0, "Function", "Exported function `Testing` takes `t` (`*testing.T`) and returns nothing.", ""]
    ]);
    expect(entries.find((entry) => entry.name === "Short")).toMatchObject({ documentation: "Short loans.", startLine: 7 });
    expect(entries.find((entry) => entry.kindLabel === "Constants")).toMatchObject({ documentation: "Kinds of loans.", startLine: 5, endLine: 10 });
    expect(entries.find((entry) => entry.name === "Sum")).toMatchObject({ startLine: 28, explainable: true });
  });

  it("is used for Go files in the file overview without a symbol provider", async () => {
    const document = {
      uri: Uri.file("/workspace/inventory/lookup.go"),
      languageId: "go",
      getText: () => fixture("inventory/lookup.go")
    } as unknown as import("vscode").TextDocument;
    const overview = await buildFileOverview(document, "inventory/lookup.go");
    expect(overview.limitations).toEqual([]);
    expect(overview.entries.filter((entry) => entry.explainable).map((entry) => [entry.name, entry.qualifiedName])).toEqual([
      ["FindAvailable", "Catalog.FindAvailable"],
      ["MarkUnavailable", "Catalog.MarkUnavailable"]
    ]);
    expect(overview.entries[1]!.reference).toMatchObject({ path: "inventory/lookup.go", line: 3, startCharacter: 18, endCharacter: 31 });
  });
});
