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

const python = [
  "# Catalog operations for the checkout flow.",
  "",
  "from .storage import persist, load as load_all",
  "import config",
  "",
  "LIMIT = 10",
  "",
  "# Finds an available book and persists it.",
  "async def checkout(catalog, title):",
  "    book = next(item for item in catalog if item.title == title)",
  "    return book",
  "",
  "",
  "# Helpers below are internal.",
  "",
  "class Shelf(Base):",
  "    def add(self, book):",
  "        pass"
].join("\n");

describe("local document-ordered file description", () => {
  it("describes imports, values, functions, classes, and comments where they appear", async () => {
    const checkout = symbol("checkout", SymbolKind.Function, [8, 0], [10, 15], 10, [
      symbol("book", SymbolKind.Variable, [9, 4], [9, 64], 4)
    ]);
    const shelf = symbol("Shelf", SymbolKind.Class, [15, 0], [17, 12], 6, [
      symbol("add", SymbolKind.Method, [16, 4], [17, 12], 8)
    ]);
    vi.spyOn(commands, "executeCommand").mockResolvedValue([
      symbol("LIMIT", SymbolKind.Constant, [5, 0], [5, 10], 0),
      checkout,
      shelf
    ]);

    const overview = await buildFileOverview(documentFor("app/catalog.py", "python", python), "app/catalog.py");

    expect(overview.fileName).toBe("catalog.py");
    expect(overview.lineCount).toBe(18);
    expect(overview.purpose).toBe("Catalog operations for the checkout flow.");
    expect(overview.entries.map((entry) => [entry.startLine, entry.kindLabel, flat(entry.description)])).toEqual([
      [2, "Import", "Imports `persist` and `load` as `load_all` from `.storage` (relative to this package)."],
      [3, "Import", "Imports module `config`."],
      [5, "Constant", "Constant `LIMIT`, set to `10`."],
      [7, "Function", "Async function `checkout` takes `catalog` and `title`."],
      [9, "Variable", "Variable `book` local to `checkout`, set to `next(item for item in catalog if item.title == title)`."],
      [13, "Comment", "Helpers below are internal."],
      [15, "Class", "Class `Shelf` extends `Base`."],
      [16, "Method", "Method `add` of `Shelf` takes `book`."]
    ]);
    const checkoutEntry = overview.entries.find((entry) => entry.name === "checkout") as OutlineEntry;
    expect(checkoutEntry.documentation).toBe("Finds an available book and persists it.");
    expect(checkoutEntry.explainable).toBe(true);
    expect(checkoutEntry.reference).toMatchObject({ path: "app/catalog.py", line: 8, startCharacter: 10, endCharacter: 18 });
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
