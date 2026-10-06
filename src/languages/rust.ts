import { createRequire } from "node:module";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type { ExtensionContext, TextDocument, Position, Range } from "vscode";
import { cacheKey, fingerprint } from "../core/fingerprint";
import type { FunctionTarget } from "../core/types";

const require = createRequire(__filename);
let parserPromise: Promise<Parser> | undefined;

async function createParser(extensionPath: string): Promise<Parser> {
  const assetPath = resolve(extensionPath, "dist");
  const runtime = resolve(assetPath, "tree-sitter.wasm");
  const grammar = resolve(assetPath, "tree-sitter-rust.wasm");
  if (!existsSync(runtime) || !existsSync(grammar)) {
    throw new Error("Bundled Tree-sitter runtime or Rust grammar asset is missing.");
  }
  await Parser.init({ locateFile: () => runtime });
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammar));
  return parser;
}

export function initializeRustParserAt(extensionPath: string): Promise<void> {
  parserPromise ??= createParser(extensionPath);
  return parserPromise.then(() => undefined);
}

export function initializeRustParser(context: ExtensionContext): Promise<void> {
  return initializeRustParserAt(context.extensionPath);
}

function child(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

function nodeChildren(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((entry): entry is SyntaxNode => entry !== null);
}

function pointToPosition(
  point: { row: number; column: number },
  source: string
): Position {
  const vscode = require("vscode") as typeof import("vscode");
  const line = source.split(/\r?\n/)[point.row] ?? "";
  const bytePrefix = Buffer.from(line, "utf8").subarray(0, point.column).toString("utf8");
  return new vscode.Position(point.row, bytePrefix.length);
}

function tokens(node: SyntaxNode): string {
  if (node.type.endsWith("_literal")) {
    return `${node.type}:${node.text.length}:${node.text};`;
  }
  if (node.childCount === 0) return `${node.type}:${node.text.length}:${node.text};`;
  return nodeChildren(node).map((entry) => tokens(entry)).join("");
}

interface FoundFunction {
  readonly node: SyntaxNode;
  readonly name: SyntaxNode;
  readonly containers: string[];
}

function findFunctions(root: SyntaxNode): FoundFunction[] {
  const found: FoundFunction[] = [];
  const visit = (node: SyntaxNode, containers: string[]) => {
    const nextContainers = [...containers];
    if (node.type === "trait_item" || node.type === "mod_item") {
      const containerName = child(node, "name")?.text;
      if (containerName) nextContainers.push(containerName);
    } else if (node.type === "impl_item") {
      // impl blocks have no name; identify methods by type (and trait) so
      // `Foo::new` and `Bar::new` in one file are distinct functions.
      const type = child(node, "type")?.text;
      const trait = child(node, "trait")?.text;
      if (type) nextContainers.push(trait ? `<${type} as ${trait}>` : type);
    }
    if (node.type === "function_item") {
      const name = child(node, "name");
      if (name) found.push({ node, name, containers });
    }
    for (const entry of nodeChildren(node)) visit(entry, nextContainers);
  };
  visit(root, []);
  return found;
}

function smallestContaining<T>(
  nodes: readonly T[],
  position: Position,
  getRange: (node: T) => Range
): T | undefined {
  return nodes
    .filter((entry) => getRange(entry).contains(position))
    .sort((a, b) => {
      const left = getRange(a);
      const right = getRange(b);
      return left.end.line - left.start.line - (right.end.line - right.start.line);
    })[0];
}

function signatureFor(node: SyntaxNode): string {
  const body = child(node, "body");
  return body ? node.text.slice(0, node.text.lastIndexOf(body.text)).trim() : node.text;
}

export async function findRustFunction(
  document: TextDocument,
  position: Position
): Promise<FunctionTarget | undefined> {
  parserPromise ??= createParser(resolve(__dirname, ".."));
  const parser = await parserPromise;
  const tree = parser.parse(document.getText());
  if (!tree) return undefined;
  const vscode = require("vscode") as typeof import("vscode");
  const functions = findFunctions(tree.rootNode);
  const found = smallestContaining(functions, position, (entry) =>
    new vscode.Range(
      pointToPosition(entry.node.startPosition, document.getText()),
      pointToPosition(entry.node.endPosition, document.getText())
    )
  );
  if (!found) {
    tree.delete();
    return undefined;
  }
  const range = new vscode.Range(
    pointToPosition(found.node.startPosition, document.getText()),
    pointToPosition(found.node.endPosition, document.getText())
  );
  const signature = signatureFor(found.node);
  const qualifiedName = [...found.containers, found.name.text].join("::");
  const target = {
    uri: document.uri,
    range,
    selection: new vscode.Range(
      pointToPosition(found.name.startPosition, document.getText()),
      pointToPosition(found.name.endPosition, document.getText())
    ),
    languageId: "rust",
    name: found.name.text,
    qualifiedName,
    signature,
    source: found.node.text,
    symbolId: cacheKey(["rust-v1", document.uri.path, qualifiedName]),
    structuralFingerprint: fingerprint(tokens(found.node)),
    analysis: "rust-tree-sitter" as const
  };
  tree.delete();
  return target;
}

export interface RustFunctionSlice {
  readonly name: string;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly source: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fingerprint: string;
}

export async function listRustFunctions(document: TextDocument): Promise<RustFunctionSlice[]> {
  parserPromise ??= createParser(resolve(__dirname, ".."));
  const parser = await parserPromise;
  const tree = parser.parse(document.getText());
  if (!tree) return [];
  const result = findFunctions(tree.rootNode).map(({ node, name, containers }) => ({
    name: name.text,
    qualifiedName: [...containers, name.text].join("::"),
    signature: signatureFor(node),
    source: node.text,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    fingerprint: fingerprint(tokens(node))
  }));
  tree.delete();
  return result;
}

export interface RustDeclarationSlice {
  readonly name: string;
  readonly kind: string;
  readonly source: string;
  readonly fingerprint: string;
}

export async function findRustDeclarations(
  document: TextDocument,
  referencedNames: ReadonlySet<string>
): Promise<RustDeclarationSlice[]> {
  parserPromise ??= createParser(resolve(__dirname, ".."));
  const parser = await parserPromise;
  const tree = parser.parse(document.getText());
  if (!tree) return [];
  const kinds = new Set([
    "struct_item", "enum_item", "trait_item", "type_item", "const_item", "static_item"
  ]);
  const found: RustDeclarationSlice[] = [];
  const visit = (node: SyntaxNode) => {
    if (kinds.has(node.type)) {
      const name = child(node, "name")?.text;
      if (name && referencedNames.has(name)) {
        found.push({
          name,
          kind: node.type,
          source: node.text,
          fingerprint: fingerprint(tokens(node))
        });
      }
    }
    for (const entry of nodeChildren(node)) visit(entry);
  };
  visit(tree.rootNode);
  tree.delete();
  return found.slice(0, 12);
}

export async function fingerprintRustSyntax(source: string): Promise<string> {
  parserPromise ??= createParser(resolve(__dirname, ".."));
  const parser = await parserPromise;
  const tree = parser.parse(source);
  if (!tree) throw new Error("Tree-sitter could not parse the Rust source.");
  const value = fingerprint(tokens(tree.rootNode));
  tree.delete();
  return value;
}

/** Parses Rust source with the bundled grammar and releases the tree after `use` returns. */
export async function withRustSyntaxTree<T>(
  source: string,
  use: (root: SyntaxNode) => T
): Promise<T | undefined> {
  parserPromise ??= createParser(resolve(__dirname, ".."));
  const parser = await parserPromise;
  const tree = parser.parse(source);
  if (!tree) return undefined;
  try {
    return use(tree.rootNode);
  } finally {
    tree.delete();
  }
}
