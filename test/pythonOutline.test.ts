import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Position, Uri } from "vscode";
import { pythonSupport } from "../src/languages/python";
import { describePythonSource } from "../src/languages/python/outline";
import { findPythonFunction, listPythonFunctions } from "../src/languages/python/syntax";

beforeAll(() => pythonSupport.initialize!(resolve(".")));

describe("bundled Python discovery and local descriptions", () => {
  const source = `"""A small library.

    Keeps books available.
"""
from .inventory import Book
LIMIT: int = 3

class Catalog(Base):
    """Stores books."""
    @classmethod
    async def create(cls, name: str = "library") -> Book:
        """Build a catalog."""
        def validate():
            return name
        return validate()

    @property
    def size(self) -> int:
        return LIMIT

ignored = lambda x: x
`;

  it("finds decorated/async methods and nested functions, not lambdas", async () => {
    const functions = await listPythonFunctions(source);
    expect(functions.map((fn) => fn.qualifiedName)).toEqual(["Catalog.create", "Catalog.create.validate", "Catalog.size"]);
    expect(functions[0]?.source).toMatch(/^@classmethod\n    async def create/);
    expect(functions[0]?.signature).toBe('@classmethod\n    async def create(cls, name: str = "library") -> Book:');
    const document = { uri: Uri.file("/repo/library.py"), getText: () => source } as import("vscode").TextDocument;
    const outer = await findPythonFunction(document, new Position(9, 6));
    expect(outer?.qualifiedName).toBe("Catalog.create");
    expect(outer?.range.start.line).toBe(9);
    expect(outer?.selection.start.line).toBe(10);
    expect(outer?.analysis).toBe("python-tree-sitter");
    expect((await findPythonFunction(document, new Position(13, 18)))?.qualifiedName).toBe("Catalog.create.validate");
    expect(await findPythonFunction(document, new Position(20, 18))).toBeUndefined();
  });

  it("describes module/class/function docstrings, parameters, bases, constants and decorators", async () => {
    const result = await describePythonSource(source);
    expect(result.purpose).toBe("A small library.\n\nKeeps books available.");
    const classEntry = result.drafts.find((entry) => entry.name === "Catalog")!;
    expect(classEntry.documentation).toBe("Stores books.");
    expect(classEntry.description.map((part) => part.text).join("")).toBe("Class Catalog with bases Base.");
    const create = result.drafts.find((entry) => entry.name === "create")!;
    expect(create).toMatchObject({ depth: 1, kindLabel: "Method", documentation: "Build a catalog.", explainable: true });
    expect(create.description.map((part) => part.text).join("")).toBe('Async method create takes name: str = "library" and returns Book.');
    expect(create.notes[0]?.map((part) => part.text).join("")).toBe("Decorated with classmethod.");
    expect(result.drafts.find((entry) => entry.name === "LIMIT")?.kind).toBe("constant");
    expect(result.drafts.find((entry) => entry.name === "validate")?.depth).toBe(2);
    expect(result.drafts.map((entry) => entry.startLine)).toEqual(result.drafts.map((entry) => entry.startLine).sort((a, b) => a - b));
  });

  it("preserves indentation structure, literals, f-strings and comments while tolerating formatting", async () => {
    const hash = (text: string) => pythonSupport.textFingerprint!(text, "app.py");
    const original = 'def f(x):\n    if x:\n        print(f"two  spaces {x}")\n        return 1\n';
    expect(await hash('def f( x ):\n\n  if x:\n    print( f"two  spaces {x}" )\n    return 1\n')).toBe(await hash(original));
    expect(await hash(original.replace("        return", "    return"))).not.toBe(await hash(original));
    expect(await hash(original.replace("two  spaces", "two spaces"))).not.toBe(await hash(original));
    expect(await hash(original + "# note\n")).not.toBe(await hash(original));
    const functions = await listPythonFunctions(original);
    expect(functions[0]?.fingerprint).toBeDefined();
  });

  it("uses UTF-16 columns and keeps function identities after adding blank lines", async () => {
    const text = 'def café(value="😀"):\n    return value\n';
    const document = (source: string) => ({ uri: Uri.file("/repo/app.py"), getText: () => source }) as import("vscode").TextDocument;
    const first = await findPythonFunction(document(text), new Position(1, 6));
    const moved = await findPythonFunction(document("\n\n" + text), new Position(3, 6));
    expect(first?.selection.end.character).toBe(8);
    expect(moved?.symbolId).toBe(first?.symbolId);
    expect(moved?.structuralFingerprint).toBe(first?.structuralFingerprint);
  });

  it("distinguishes property accessors and attaches comments without duplicating them", async () => {
    const text = "# A catalog.\n\nclass C:\n    # Read the value.\n    @property\n    def value(self):\n        return 1\n    @value.setter\n    def value(self, new):\n        pass\n";
    expect((await listPythonFunctions(text)).map((entry) => entry.qualifiedName)).toEqual(["C.value", "C.value.setter"]);
    const result = await describePythonSource(text);
    expect(result.purpose).toBe("A catalog.");
    expect(result.drafts.find((entry) => entry.qualifiedName === "C.value")?.documentation).toBe("Read the value.");
    expect(result.drafts.filter((entry) => entry.kind === "comment")).toEqual([]);
    const document = { uri: Uri.file("/repo/app.py"), getText: () => text } as import("vscode").TextDocument;
    expect((await findPythonFunction(document, new Position(6, 10)))?.symbolId)
      .not.toBe((await findPythonFunction(document, new Position(9, 6)))?.symbolId);
  });
});
