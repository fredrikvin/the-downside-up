import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFileOverview, type OutlineEntry } from "../src/context/fileOverview";
import type { Description } from "../src/context/outlineText";
import { scanImports } from "../src/context/imports";
import { commands, DocumentSymbol, Position, Range, SymbolKind, Uri } from "./vscode";

afterEach(() => vi.restoreAllMocks());

const flat = (description: Description): string =>
  description.map((segment) => (segment.code ? `\`${segment.text}\`` : segment.text)).join("");

function documentFor(path: string, languageId: string, source: string) {
  return {
    uri: Uri.file(`/workspace/${path}`),
    languageId,
    getText: () => source
  } as unknown as import("vscode").TextDocument;
}

function symbol(
  name: string,
  kind: number,
  start: [number, number],
  end: [number, number],
  nameStart: number,
  children: DocumentSymbol[] = []
): DocumentSymbol {
  return new DocumentSymbol(
    name,
    "",
    kind,
    new Range(new Position(start[0], start[1]), new Position(end[0], end[1])),
    new Range(new Position(start[0], nameStart), new Position(start[0], nameStart + name.length)),
    children
  );
}

const javascript = [
  "// Catalog operations for the checkout flow.",
  "",
  "import { persist, load as loadAll } from \"./storage.js\";",
  "import config from \"./config.js\";",
  "",
  "const LIMIT = 10;",
  "",
  "/** Finds an available book and persists it. */",
  "export async function checkout(catalog, title) {",
  "  const book = catalog.find((item) => item.title === title);",
  "  return book;",
  "}",
  "",
  "// Helpers below are internal.",
  "",
  "export class Shelf extends Base {",
  "  add(book) {}",
  "}"
].join("\n");

describe("local document-ordered file description", () => {
  it("describes imports, values, functions, classes, and comments where they appear", async () => {
    const checkout = symbol("checkout", SymbolKind.Function, [8, 0], [11, 1], 22, [
      symbol("book", SymbolKind.Variable, [9, 2], [9, 61], 8)
    ]);
    const shelf = symbol("Shelf", SymbolKind.Class, [15, 0], [17, 1], 13, [
      symbol("add", SymbolKind.Method, [16, 2], [16, 14], 2)
    ]);
    vi.spyOn(commands, "executeCommand").mockResolvedValue([
      symbol("LIMIT", SymbolKind.Constant, [5, 0], [5, 16], 6),
      checkout,
      shelf
    ]);

    const overview = await buildFileOverview(documentFor("src/catalog.js", "javascript", javascript), "src/catalog.js");

    expect(overview.fileName).toBe("catalog.js");
    expect(overview.lineCount).toBe(18);
    expect(overview.purpose).toBe("Catalog operations for the checkout flow.");
    expect(overview.entries.map((entry) => [entry.startLine, entry.kindLabel, flat(entry.description)])).toEqual([
      [2, "Import", "Imports `persist` and `load` as `loadAll` from `./storage.js`."],
      [3, "Import", "Imports the default export as `config` from `./config.js`."],
      [5, "Constant", "Constant `LIMIT`, set to `10`."],
      [7, "Function", "Exported async function `checkout` takes `catalog` and `title`."],
      [9, "Variable", "Constant `book` local to `checkout`, set to `catalog.find((item) => item.title === title)`."],
      [13, "Comment", "Helpers below are internal."],
      [15, "Class", "Exported class `Shelf` extends `Base`."],
      [16, "Method", "Method `add` of `Shelf` takes `book`."]
    ]);
    const checkoutEntry = overview.entries[3] as OutlineEntry;
    expect(checkoutEntry.documentation).toBe("Finds an available book and persists it.");
    expect(checkoutEntry.explainable).toBe(true);
    expect(checkoutEntry.reference).toMatchObject({ path: "src/catalog.js", line: 8, startCharacter: 22, endCharacter: 30 });
    expect(overview.entries.filter((entry) => entry.explainable).map((entry) => entry.name)).toEqual(["checkout", "add"]);
    expect(new Set(overview.entries.map((entry) => entry.id)).size).toBe(overview.entries.length);
    expect(overview.limitations).toEqual([]);
  });

  it("still describes imports and comments when no symbol provider answers", async () => {
    vi.spyOn(commands, "executeCommand").mockResolvedValue(undefined);
    const source = "import os\nfrom .models import (\n    Book,\n    Shelf as Rack,\n)\n\n# Settings below.\nVALUE = 1\n";

    const overview = await buildFileOverview(documentFor("app/main.py", "python", source), "app/main.py");

    expect(overview.purpose).toBeUndefined();
    expect(overview.entries.map((entry) => flat(entry.description))).toEqual([
      "Imports module `os`.",
      "Imports `Book` and `Shelf` as `Rack` from `.models` (relative to this package).",
      "Settings below."
    ]);
    expect(overview.entries[1]).toMatchObject({ startLine: 1, endLine: 4 });
    expect(overview.limitations[0]).toContain("No VS Code document-symbol provider");
  });

  it("does not describe oversized files", async () => {
    const overview = await buildFileOverview(
      documentFor("big.js", "javascript", "x".repeat(257 * 1024)),
      "big.js"
    );
    expect(overview.entries).toEqual([]);
    expect(overview.limitations[0]).toContain("256 KiB");
  });
});

describe("import statement descriptions", () => {
  const describeAll = (languageId: string, source: string) =>
    scanImports(languageId, source.split("\n")).map((statement) => flat(statement.description));

  it("covers common languages without inventing structure", () => {
    expect(describeAll("go", "import (\n  \"fmt\"\n  _ \"embed\"\n  str \"strings\"\n)")).toEqual([
      "Imports packages `fmt`, `embed` for its side effects, and `strings` as `str`."
    ]);
    expect(describeAll("java", "import java.util.List;\nimport static org.junit.Assert.*;")).toEqual([
      "Imports `List` from `java.util`.",
      "Imports everything from `org.junit.Assert`."
    ]);
    expect(describeAll("csharp", "using System.Text;\nusing Json = System.Text.Json;\nusing (var x = y) {}")).toEqual([
      "Uses namespace `System.Text`.",
      "Defines alias `Json` for `System.Text.Json`."
    ]);
    expect(describeAll("c", "#include <stdio.h>\n#include \"catalog.h\"")).toEqual([
      "Includes system header `stdio.h`.",
      "Includes project header `catalog.h`."
    ]);
    expect(describeAll("typescript", "import type { Book } from \"./book\";\nimport \"./polyfill\";\nexport * from \"./shelf\";\nimport * as path from \"node:path\";")).toEqual([
      "Imports types `Book` from `./book`.",
      "Loads `./polyfill` for its side effects.",
      "Re-exports all exports from `./shelf`.",
      "Imports all exports as namespace `path` from `node:path`."
    ]);
  });
});
