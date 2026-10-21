import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type { Position } from "vscode";
import { fingerprint } from "../core/fingerprint";
import type { ComparisonFunction, FunctionDiscovery } from "./support";

const require = createRequire(__filename);
let runtimePromise: Promise<void> | undefined;

/** Creates a parser for a grammar bundled in `dist/`; the runtime is initialized once for all grammars. */
export async function createTreeSitterParser(
  extensionPath: string,
  grammarFile: string,
  languageName: string
): Promise<Parser> {
  const assetPath = resolve(extensionPath, "dist");
  const runtime = resolve(assetPath, "tree-sitter.wasm");
  const grammar = resolve(assetPath, grammarFile);
  if (!existsSync(runtime) || !existsSync(grammar)) {
    throw new Error(`Bundled Tree-sitter runtime or ${languageName} grammar asset is missing.`);
  }
  runtimePromise ??= Parser.init({ locateFile: () => runtime });
  await runtimePromise;
  const parser = new Parser();
  parser.setLanguage(await Language.load(grammar));
  return parser;
}

export interface TreeSitterGrammar {
  /** Loads the grammar from `<extensionPath>/dist`; later calls reuse the first load. */
  initialize(extensionPath: string): Promise<void>;
  /** Parses with the grammar and releases the tree after `use` returns. */
  withSyntaxTree<T>(source: string, use: (root: SyntaxNode) => T): Promise<T | undefined>;
}

/**
 * A bundled grammar (copied to `dist/` by `esbuild.config.mjs`), loaded on
 * first use. Without an explicit `initialize`, it loads from the bundle's
 * own directory, which is right for the packaged extension.
 */
export function treeSitterGrammar(grammarFile: string, languageName: string): TreeSitterGrammar {
  let parserPromise: Promise<Parser> | undefined;
  const parser = (extensionPath = resolve(__dirname, "..")) => {
    // A failed load is forgotten, so a later `initialize` with the right path can still succeed.
    parserPromise ??= createTreeSitterParser(extensionPath, grammarFile, languageName).catch((error: unknown) => {
      parserPromise = undefined;
      throw error;
    });
    return parserPromise;
  };
  return {
    initialize: (extensionPath) => parser(extensionPath).then(() => undefined),
    async withSyntaxTree(source, use) {
      const tree = (await parser()).parse(source);
      if (!tree) return undefined;
      try {
        return use(tree.rootNode);
      } finally {
        tree.delete();
      }
    }
  };
}

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((entry): entry is SyntaxNode => entry !== null);
}

export function allChildren(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((entry): entry is SyntaxNode => entry !== null);
}

/** Token text and node types without whitespace, so formatting-only edits keep the same fingerprint. */
export function structuralTokens(node: SyntaxNode): string {
  if (!node.type.trim() && !node.text.trim()) return "";
  if (node.type.endsWith("_literal")) {
    return `${node.type}:${node.text.length}:${node.text};`;
  }
  if (node.childCount === 0) return `${node.type}:${node.text.length}:${node.text};`;
  return `${node.type}[${allChildren(node).map((entry) => structuralTokens(entry)).join("")}]`;
}

/** Comparison-only: documentation/comments are not executable declaration changes. */
export function comparisonTokens(node: SyntaxNode, omitId?: number): string {
  if (node.id === omitId) return "";
  if (node.type.includes("comment")) return "";
  if (!node.type.trim() && !node.text.trim()) return "";
  if (node.type.endsWith("_literal") || node.childCount === 0) return `${node.type}:${node.text.length}:${node.text};`;
  return `${node.type}[${allChildren(node).map((child) => comparisonTokens(child, omitId)).join("")}]`;
}

/** Shared range/validation mechanics; callable identities and walks remain language-owned. */
export function comparisonFunction(
  node: SyntaxNode, name: SyntaxNode, qualifiedName: string, matchKey: string, kind: string, signature: string
): ComparisonFunction {
  const body = node.childForFieldName("body");
  const signatureTokens = allChildren(node).filter((child) => child !== body && child.id !== body?.id).map((child) => comparisonTokens(child)).join("");
  return {
    name: name.text, qualifiedName, matchKey, kind, signature, source: node.text,
    startLine: node.startPosition.row, endLine: node.endPosition.row,
    startColumn: node.startPosition.column, endColumn: node.endPosition.column,
    nameLine: name.startPosition.row, nameColumn: name.startPosition.column,
    fingerprint: fingerprint(comparisonTokens(node)), signatureFingerprint: fingerprint(signatureTokens)
  };
}

export function comparisonDiscovery(root: SyntaxNode, entries: ComparisonFunction[]): FunctionDiscovery {
  return {
    status: root.hasError || entries.length > 500 ? "partial" : "complete",
    entries: entries.slice(0, 500),
    limitations: root.hasError ? ["Function discovery is incomplete because the snapshot contains syntax errors."]
      : entries.length > 500 ? ["Function discovery exceeded the 500-function limit."] : []
  };
}

/**
 * Converts a Tree-sitter point to a VS Code position. web-tree-sitter parses
 * JavaScript strings as UTF-16, so its columns are UTF-16 code units, as in
 * VS Code.
 */
export function pointToPosition(point: { row: number; column: number }): Position {
  const vscode = require("vscode") as typeof import("vscode");
  return new vscode.Position(point.row, point.column);
}
