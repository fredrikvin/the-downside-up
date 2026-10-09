import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inputsMatch } from "../src/cache/freshness";
import { gatherInventory } from "../src/context/inventory";
import { findCalledFunctions, gatherFunctionContext } from "../src/context/related";
import {
  findCallSites,
  findEditorDependencies,
  LOOKUP_TIMED_OUT,
  NO_DEFINITIONS
} from "../src/languages/editor/dependencies";
import { findFunctionWithEditorTools } from "../src/languages/editor/symbols";
import { commands, DocumentSymbol, Position, Range, SymbolKind, Uri, workspace } from "./vscode";

class FakeDocument {
  readonly uri: ReturnType<typeof Uri.file>;
  readonly languageId = "php";
  readonly version = 1;

  constructor(path: string, private readonly text: string) {
    this.uri = Uri.file(path);
  }

  getText(range?: Range): string {
    return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text;
  }

  get lineCount(): number {
    return this.text.split("\n").length;
  }

  lineAt(line: number) {
    const text = this.text.split("\n")[line] ?? "";
    return { text, firstNonWhitespaceCharacterIndex: text.search(/\S|$/) };
  }

  offsetAt(position: Position): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let index = 0; index < position.line; index++) offset += lines[index]!.length + 1;
    return offset + position.character;
  }

  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset);
    return new Position(before.split("\n").length - 1, offset - (before.lastIndexOf("\n") + 1));
  }
}

/** A tiny symbol provider for PHP-like code: each `function name(...) {...}` with its braces matched. */
function symbolsOf(document: FakeDocument): DocumentSymbol[] {
  const text = document.getText();
  const symbols: DocumentSymbol[] = [];
  for (const match of text.matchAll(/function\s+([A-Za-z_]\w*)\s*\(/g)) {
    const lineStart = text.lastIndexOf("\n", match.index!) + 1;
    const start = lineStart + document.lineAt(document.positionAt(lineStart).line).firstNonWhitespaceCharacterIndex;
    let depth = 0;
    let end = text.indexOf("{", match.index!);
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      if (text[end] === "}" && --depth === 0) break;
    }
    const nameStart = match.index! + match[0].indexOf(match[1]!);
    symbols.push(new DocumentSymbol(
      match[1]!,
      "",
      SymbolKind.Function,
      new Range(document.positionAt(start), document.positionAt(end + 1)),
      new Range(document.positionAt(nameStart), document.positionAt(nameStart + match[1]!.length))
    ));
  }
  return symbols;
}

let root: string;
let lookups: string[];
let definitionsAvailable: boolean;
let neverAnswer: boolean;

const open = (path: string) => new FakeDocument(path, readFileSync(path, "utf8"));

beforeEach(async () => {
  workspace.__resetConfiguration();
  root = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-editor-")));
  await mkdir(resolve(root, "src"));
  await writeFile(resolve(root, "package.json"), "{\"type\":\"module\"}\n");
  await writeFile(resolve(root, ".gitignore"), "src/generated.php\n");
  await writeFile(resolve(root, "src/checkout.php"), [
    "require_once \"storage.php\";",
    "",
    "export function checkout(catalog, title) {",
    "  // persist(draft) is only mentioned here",
    "  const label = \"format(title)\";",
    "  const book = findBook(catalog, title);",
    "  generated(book);",
    "  log(label);",
    "  if (book) persist(book);",
    "  return checkout.length ? book : undefined;",
    "}",
    "",
    "function findBook(catalog, title) {",
    "  return catalog.find((item) => item.title === title);",
    "}",
    ""
  ].join("\n"));
  await writeFile(resolve(root, "src/storage.php"), [
    "export function persist(book) {",
    "  validate(book);",
    "  return book;",
    "}",
    "",
    "function validate(book) {",
    "  if (!book.title) throw new TypeError(\"A book needs a title\");",
    "}",
    ""
  ].join("\n"));
  await writeFile(resolve(root, "src/generated.php"), "export function generated(value) {\n  return value;\n}\n");
  lookups = [];
  definitionsAvailable = true;
  neverAnswer = false;
  workspace.openTextDocument = async (uri: { fsPath: string }) => open(uri.fsPath);
  commands.__setExecuteCommand(async (command, ...args) => {
    if (command === "vscode.executeDocumentSymbolProvider") {
      return symbolsOf(open((args[0] as { fsPath: string }).fsPath));
    }
    if (command !== "vscode.executeDefinitionProvider") return [];
    const document = open((args[0] as { fsPath: string }).fsPath);
    const position = args[1] as Position;
    const rest = document.getText().slice(document.offsetAt(position));
    const name = /^[A-Za-z_$][\w$]*/.exec(rest)![0];
    lookups.push(`${name}@${position.line}`);
    if (neverAnswer) return new Promise(() => undefined);
    if (!definitionsAvailable) return [];
    if (name === "find") {
      return [{ uri: Uri.file("/elsewhere/lib.es5.d.ts"), range: new Range(1, 2, 1, 6) }];
    }
    for (const file of ["src/checkout.php", "src/storage.php", "src/generated.php"]) {
      const candidate = open(resolve(root, file));
      const symbol = symbolsOf(candidate).find((entry) => entry.name === name);
      if (symbol) {
        return [{ targetUri: candidate.uri, targetRange: symbol.range, targetSelectionRange: symbol.selectionRange }];
      }
    }
    return [];
  });
});

afterEach(async () => {
  commands.__setExecuteCommand(async () => []);
  workspace.__resetConfiguration();
  await rm(root, { recursive: true, force: true });
});

async function checkoutTarget() {
  const document = open(resolve(root, "src/checkout.php"));
  const target = await findFunctionWithEditorTools(
    document as unknown as import("vscode").TextDocument,
    new Position(2, 20) as unknown as import("vscode").Position
  );
  return { document: document as unknown as import("vscode").TextDocument, target: target! };
}

describe("call sites", () => {
  it("finds calls in code only, once per name, without keywords or declarations", () => {
    const source = [
      "function outer(a) {",
      "  // helper(a) in a comment",
      "  const text = 'call(a)' + \"other(b)\";",
      "  if (a) helper(a);",
      "  function inner() { return helper(a); }",
      "  return format<string>(text) + new Thing(a);",
      "}"
    ].join("\n");
    expect(findCallSites(source, "typescript", new Set([9])).map((site) => site.name)).toEqual(["helper", "format"]);
    expect(findCallSites("def run(x):\n    # ignored(x)\n    return compute(x)", "python").map((site) => site.name))
      .toEqual(["compute"]);
  });
});

describe("called functions through editor tooling", () => {
  it("resolves calls in the repository and skips other definitions", async () => {
    const { document, target } = await checkoutTarget();
    expect(target.analysis).toBe("vscode-symbols");
    const called = await findCalledFunctions(target, document, await gatherInventory(root));
    expect(called.map((entry) => `${entry.path}:${entry.line} ${entry.qualifiedName}`)).toEqual([
      "src/checkout.php:12 findBook",
      "src/storage.php:0 persist"
    ]);
    // Comments, strings, the function's own name, and keywords are never looked up.
    expect(lookups.sort()).toEqual(["findBook@5", "generated@6", "log@7", "persist@8"]);
  });

  it("looks up only the hovered name", async () => {
    const { document, target } = await checkoutTarget();
    const called = await findCalledFunctions(target, document, await gatherInventory(root), "persist");
    expect(called.map((entry) => entry.qualifiedName)).toEqual(["persist"]);
    expect(lookups).toEqual(["persist@8"]);
  });

  it("sends and tracks callees at depth 1 and their callees' signatures at depth 2", async () => {
    const context = async () => {
      const { document, target } = await checkoutTarget();
      return gatherFunctionContext(target, document, await gatherInventory(root));
    };
    const original = await context();
    const tracked = original.inputs.map((input) => `${input.depth ?? "-"} ${input.scope ?? "body"} ${input.path}: ${input.description}`);
    expect(tracked).toContain("1 body src/checkout.php: function findBook");
    expect(tracked).toContain("1 body src/storage.php: function persist");
    expect(tracked).toContain("2 signature src/storage.php: signature of function validate, used by persist");
    expect(tracked.some((entry) => entry.includes("generated"))).toBe(false);
    expect(original.text).toContain("export function persist(book)");
    expect(original.text).not.toContain("export function generated");

    const storage = resolve(root, "src/storage.php");
    const edit = async (from: string, to: string) =>
      writeFile(storage, (await readFile(storage, "utf8")).replace(from, to));
    await edit("throw new TypeError", "throw new RangeError");
    expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(true);
    await edit("function validate(book)", "function validate(book, strict)");
    expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
  });

  it("states when the editor resolves no calls", async () => {
    definitionsAvailable = false;
    const { document, target } = await checkoutTarget();
    const context = await gatherFunctionContext(target, document, await gatherInventory(root));
    expect(context.limitations).toContain(NO_DEFINITIONS);
    expect(context.inputs.some((input) => input.depth === 1)).toBe(false);
  });

  it("stops slow lookups at the deadline", async () => {
    neverAnswer = true;
    const inventory = await gatherInventory(root);
    const found = await findEditorDependencies({
      root,
      path: "src/checkout.php",
      text: await readFile(resolve(root, "src/checkout.php"), "utf8"),
      line: 2,
      name: "checkout",
      readablePaths: new Set(inventory.files.map((file) => file.relativePath)),
      load: async () => "",
      deadline: Date.now() + 50
    });
    expect(found.dependencies).toEqual([]);
    expect(found.limitations).toEqual([LOOKUP_TIMED_OUT]);
  });
});
