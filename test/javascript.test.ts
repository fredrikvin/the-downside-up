import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inputsMatch } from "../src/cache/freshness";
import { gatherInventory } from "../src/context/inventory";
import { findCalledFunctions, gatherFunctionContext } from "../src/context/related";
import type { Description } from "../src/context/outlineText";
import { resetTypeScriptReadiness } from "../src/languages/javascript/dependencies";
import { COMPONENT_GUIDANCE, HOOK_GUIDANCE, javascriptGuidance, nestedGuidance } from "../src/languages/javascript/guidance";
import { describeJavaScriptSource } from "../src/languages/javascript/outline";
import {
  findJavaScriptFunction,
  initializeJavaScriptParsersAt,
  listJavaScriptFunctions
} from "../src/languages/javascript/syntax";
import { commands, Position, Range, Uri, workspace } from "./vscode";

const flat = (description: Description): string =>
  description.map((segment) => (segment.code ? `\`${segment.text}\`` : segment.text)).join("");

function documentAt(path: string, text = readFileSync(path, "utf8")) {
  return {
    uri: Uri.file(path),
    languageId: path.endsWith(".tsx") ? "typescriptreact" : "typescript",
    version: 1,
    getText: () => text
  } as unknown as import("vscode").TextDocument;
}

beforeAll(async () => {
  await initializeJavaScriptParsersAt(resolve("."));
});

describe("JavaScript and TypeScript discovery", () => {
  it("finds named functions, components, hooks, and methods but not callbacks", async () => {
    const source = [
      "export default function () { return 1; }",
      "const Button = forwardRef((props, ref) => <button ref={ref} {...props} />);",
      "class Shelf extends Base {",
      "  handle = () => {};",
      "  add(book: Book): void {}",
      "}",
      "const api = { load() {}, save: async () => {} };",
      "function outer() {",
      "  items.forEach(function (item) { function inner() {} });",
      "}",
      "const onClick = useCallback(() => {}, []);",
      "const total = useMemo(() => 1, []);",
      "const lowercase = () => <div />;"
    ].join("\n");
    const found = await listJavaScriptFunctions(source, "/repo/src/mixed.tsx");
    expect(found.map((entry) => `${entry.kind} ${entry.qualifiedName}`)).toEqual([
      "function default",
      "component Button",
      "method Shelf.handle",
      "method Shelf.add",
      "method api.load",
      "method api.save",
      "function outer",
      "function outer.inner",
      "function onClick",
      "function lowercase"
    ]);
  });

  it("reads generic arrow functions in .ts files with the TypeScript grammar", async () => {
    const found = await listJavaScriptFunctions("const id = <T>(value: T): T => value;\n", "/repo/src/id.ts");
    expect(found.map((entry) => [entry.qualifiedName, entry.signature])).toEqual([["id", "const id = <T>(value: T): T =>"]]);
  });

  it("finds the innermost named function at a position, treating callbacks as part of it", async () => {
    const document = documentAt(resolve("fixtures/react-app/src/CartView.tsx"));
    const text = document.getText();
    const at = (needle: string) => {
      const before = text.slice(0, text.indexOf(needle));
      const line = before.split("\n").length - 1;
      return new Position(line, before.length - before.lastIndexOf("\n") - 1) as unknown as import("vscode").Position;
    };
    const inEffect = await findJavaScriptFunction(document, at("document.title"));
    expect(inEffect).toMatchObject({ qualifiedName: "CartView", analysis: "javascript-tree-sitter", languageId: "typescriptreact" });
    expect(inEffect?.selection).toEqual(new Range(8, 16, 8, 24));
    expect((await findJavaScriptFunction(document, at("onCheckout(cart")))?.qualifiedName).toBe("CartView.handleCheckout");
    // Called functions are found again from the start of their line, which may be `export`.
    expect((await findJavaScriptFunction(document, new Position(8, 0) as unknown as import("vscode").Position))?.qualifiedName).toBe("CartView");
  });
});

describe("positions after non-ASCII text", () => {
  it("uses UTF-16 columns, as VS Code does", async () => {
    const source = "const label = \"×€\"; export function total() { return format(label); }\n";
    const described = await describeJavaScriptSource(source, "/repo/src/total.ts");
    expect(described.drafts.find((draft) => draft.name === "total")).toMatchObject({
      nameStart: source.indexOf("total"),
      nameEnd: source.indexOf("total") + "total".length
    });
    const document = documentAt("/repo/src/total.ts", source);
    const target = await findJavaScriptFunction(document, new Position(0, source.indexOf("format")) as unknown as import("vscode").Position);
    expect(target?.selection).toEqual(new Range(0, source.indexOf("total"), 0, source.indexOf("total") + "total".length));
  });
});

describe("JavaScript and TypeScript file descriptions", () => {
  const describeFixture = async (file: string) => {
    const path = resolve("fixtures/react-app/src", file);
    const described = await describeJavaScriptSource(readFileSync(path, "utf8"), path);
    return described.drafts
      .sort((left, right) => left.startLine - right.startLine)
      .map((draft) => `${draft.startLine} ${draft.kindLabel}${draft.explainable ? "*" : ""}: ${flat(draft.description)}${
        draft.notes.length ? ` (${draft.notes.map(flat).join(" ")})` : ""}${draft.documentation ? ` [${draft.documentation}]` : ""}`);
  };

  it("labels components and hooks and describes props, state, and remembered values", async () => {
    expect(await describeFixture("CartView.tsx")).toEqual([
      "0 Import: Imports `useEffect` from `react`.",
      "1 Import: Imports `CartItem` from `./CartItem`.",
      "2 Import: Imports `formatPrice` from `./format`.",
      "3 Import: Imports types `CartViewProps` from `./types`.",
      "4 Import: Imports `useCart` from `./useCart`.",
      "6 Comment: The shopping cart page.",
      "8 Component*: Exported component `CartView` takes props `initialLines` and `onCheckout` (`CartViewProps`).",
      "9 Local: Constant `cart` local to `CartView`, set to `useCart(initialLines)`.",
      "15 Function*: Function `handleCheckout`."
    ]);
    expect(await describeFixture("CartItem.tsx")).toContain(
      "9 Component*: Exported component `CartItem` takes props `line` and `onRemove` (`CartItemProps`). (Wrapped in `memo`, so it shows again only when its props change.)"
    );
    expect(await describeFixture("useCart.ts")).toEqual([
      "0 Import: Imports `useMemo` and `useState` from `react`.",
      "1 Import: Imports `sum` from `./format`.",
      "2 Import: Imports types `CartLine` from `./types`.",
      "4 Hook*: Exported hook `useCart` takes `initialLines` (`CartLine[]`). [Keeps the cart's lines and their total.]",
      "6 Local: State `lines` of `useCart`, changed with `setLines`, starting at `initialLines`.",
      "7 Local: Value `totalCents` remembered between renders of `useCart`, worked out again when `[lines]` changes.",
      "9 Function*: Function `remove` takes `id` (`string`)."
    ]);
  });

  it("describes plain JavaScript like other languages", async () => {
    const source = [
      "// Catalog operations for the checkout flow.",
      "",
      "import { persist, load as loadAll } from \"./storage.js\";",
      "",
      "const LIMIT = 10;",
      "",
      "/** Finds an available book and persists it. */",
      "export async function checkout(catalog, title = \"\") {",
      "  const book = catalog.find((item) => item.title === title);",
      "  return book;",
      "}",
      "",
      "export class Shelf extends Base {",
      "  count = 0;",
      "  add(book) {}",
      "}",
      "export { LIMIT };"
    ].join("\n");
    const described = await describeJavaScriptSource(source, "/repo/src/catalog.js");
    expect(described.purpose).toBe("Catalog operations for the checkout flow.");
    expect(described.drafts.sort((left, right) => left.startLine - right.startLine).map((draft) => `${draft.startLine} ${draft.kindLabel}: ${flat(draft.description)}`)).toEqual([
      "2 Import: Imports `persist` and `load` as `loadAll` from `./storage.js`.",
      "4 Constant: Constant `LIMIT`, set to `10`.",
      "6 Function: Exported async function `checkout` takes `catalog` and `title`, default `\"\"`.",
      "8 Local: Constant `book` local to `checkout`, set to `catalog.find((item) => item.title === title)`.",
      "12 Class: Exported class `Shelf` extends `Base`.",
      "13 Field: Field `count` of `Shelf`, set to `0`.",
      "14 Method: Method `add` of `Shelf` takes `book`.",
      "16 Export: Exports `LIMIT`."
    ]);
  });
});

describe("React guidance for explanations", () => {
  const guidanceFor = async (file: string, qualifiedName: string) => {
    const path = resolve("fixtures/react-app/src", file);
    const text = readFileSync(path, "utf8");
    const entry = (await listJavaScriptFunctions(text, path)).find((candidate) => candidate.qualifiedName === qualifiedName)!;
    return javascriptGuidance({ path, text, line: entry.startLine, name: entry.name, qualifiedName });
  };

  it("explains components, hooks, and functions inside them, and nothing else", async () => {
    expect(await guidanceFor("CartView.tsx", "CartView")).toBe(COMPONENT_GUIDANCE);
    expect(await guidanceFor("CartItem.tsx", "CartItem")).toBe(COMPONENT_GUIDANCE);
    expect(await guidanceFor("useCart.ts", "useCart")).toBe(HOOK_GUIDANCE);
    expect(await guidanceFor("CartView.tsx", "CartView.handleCheckout")).toBe(nestedGuidance("CartView"));
    expect(await guidanceFor("useCart.ts", "useCart.remove")).toContain("inside the React hook useCart");
    expect(await guidanceFor("format.ts", "formatPrice")).toBeUndefined();
    expect(COMPONENT_GUIDANCE).toContain("phase field");
  });
});

describe("what JavaScript and TypeScript functions use", () => {
  let root: string;
  let lookups: string[];

  /** Stands in for TypeScript's go-to-definition: finds top-level declarations by name in the fixture. */
  async function definitionsFor(uri: { fsPath: string }, position: Position) {
    const text = await readFile(uri.fsPath, "utf8");
    const line = text.split("\n")[position.line] ?? "";
    const name = /^[A-Za-z_$][\w$]*/.exec(line.slice(position.character))?.[0] ?? "";
    lookups.push(name);
    for (const file of await readdir(resolve(root, "src"))) {
      const path = resolve(root, "src", file);
      const lines = (await readFile(path, "utf8")).split("\n");
      for (const [row, content] of lines.entries()) {
        const match = new RegExp(`^(?:export\\s+)?(?:function|const|interface|type)\\s+(${name})\\b`).exec(content);
        if (match) {
          const start = content.indexOf(match[1]!, match[0].length - match[1]!.length);
          return [{ uri: Uri.file(path), range: new Range(row, start, row, start + name.length) }];
        }
      }
    }
    return [];
  }

  beforeEach(async () => {
    workspace.__resetConfiguration();
    root = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-react-")));
    await cp(resolve("fixtures/react-app"), root, { recursive: true });
    lookups = [];
    workspace.openTextDocument = async (uri: { fsPath: string }) => documentAt(uri.fsPath);
    commands.__setExecuteCommand(async (command, ...args) =>
      command === "vscode.executeDefinitionProvider"
        ? definitionsFor(args[0] as { fsPath: string }, args[1] as Position)
        : []);
  });

  afterEach(async () => {
    commands.__setExecuteCommand(async () => []);
    workspace.__resetConfiguration();
    await rm(root, { recursive: true, force: true });
  });

  async function cartView() {
    const document = documentAt(resolve(root, "src/CartView.tsx"));
    const target = await findJavaScriptFunction(document, new Position(9, 4) as unknown as import("vscode").Position);
    return { document, target: target! };
  }

  it("lists hooks, rendered components, and helpers in order of first use", async () => {
    const { document, target } = await cartView();
    const called = await findCalledFunctions(target, document, await gatherInventory(root));
    expect(called.map((entry) => `${entry.path}:${entry.line} ${entry.qualifiedName}`)).toEqual([
      "src/useCart.ts:5 useCart",
      "src/CartItem.tsx:9 CartItem",
      "src/format.ts:1 formatPrice"
    ]);
    // Lowercase JSX tags and the function's own name are never looked up.
    expect(lookups).not.toContain("section");
    expect(lookups).not.toContain("CartView");
    expect(lookups).toContain("CartViewProps");
  });

  it("looks up only the hovered component", async () => {
    const { document, target } = await cartView();
    const called = await findCalledFunctions(target, document, await gatherInventory(root), "CartItem");
    expect(called.map((entry) => entry.qualifiedName)).toEqual(["CartItem"]);
    expect(new Set(lookups)).toEqual(new Set(["CartItem"]));
  });

  it("waits until TypeScript resolves imports across files, once per repository", async () => {
    resetTypeScriptReadiness();
    // While the project loads, VS Code's syntax-only server leads imported names to their import line.
    let loading = 3;
    commands.__setExecuteCommand(async (command, ...args) => {
      if (command !== "vscode.executeDefinitionProvider") return [];
      const uri = args[0] as { fsPath: string };
      if (loading > 0) {
        loading--;
        lookups.push("(loading)");
        const text = await readFile(uri.fsPath, "utf8");
        const line = text.split("\n").findIndex((content) => content.includes("from \"./useCart\""));
        return [{ uri: Uri.file(uri.fsPath), range: new Range(line, 9, line, 16) }];
      }
      return definitionsFor(uri, args[1] as Position);
    });
    const { document, target } = await cartView();
    const called = await findCalledFunctions(target, document, await gatherInventory(root));
    expect(loading).toBe(0);
    expect(called.map((entry) => entry.qualifiedName)).toEqual(["useCart", "CartItem", "formatPrice"]);
    lookups = [];
    await findCalledFunctions(target, document, await gatherInventory(root));
    expect(lookups.filter((name) => name === "useCart")).toHaveLength(1);
  });

  it("sends and tracks the props type, used functions, and their callees' signatures", async () => {
    const context = async () => {
      const { document, target } = await cartView();
      return gatherFunctionContext(target, document, await gatherInventory(root));
    };
    const original = await context();
    const tracked = original.inputs.map((input) => `${input.depth ?? "-"} ${input.scope ?? "body"} ${input.path}: ${input.description}`);
    expect(tracked).toEqual(expect.arrayContaining([
      "0 body src/CartView.tsx: selected CartView",
      "- body src/CartView.tsx: module imports and declarations",
      "1 body src/types.ts: interface CartViewProps",
      "1 body src/useCart.ts: hook useCart",
      "1 body src/CartItem.tsx: component CartItem",
      "1 body src/format.ts: function formatPrice",
      "2 signature src/format.ts: signature of function sum, used by useCart"
    ]));
    expect(original.text).toContain("onCheckout: (totalCents: number) => void;");

    const edit = async (file: string, from: string, to: string) => {
      const path = resolve(root, file);
      const text = await readFile(path, "utf8");
      if (!text.includes(from)) throw new Error(`${file} does not contain ${from}`);
      await writeFile(path, text.replace(from, to));
    };
    await edit("src/format.ts", "total + value(item)", "value(item) + total");
    expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(true);
    await edit("src/types.ts", "onCheckout: (totalCents: number) => void;", "onCheckout: (totalCents: number, currency: string) => void;");
    expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
  });
});
