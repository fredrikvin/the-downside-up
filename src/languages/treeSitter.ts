import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type { Position } from "vscode";

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

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((entry): entry is SyntaxNode => entry !== null);
}

export function allChildren(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((entry): entry is SyntaxNode => entry !== null);
}

/** Token text and node types without whitespace, so formatting-only edits keep the same fingerprint. */
export function structuralTokens(node: SyntaxNode): string {
  if (node.type.endsWith("_literal")) {
    return `${node.type}:${node.text.length}:${node.text};`;
  }
  if (node.childCount === 0) return `${node.type}:${node.text.length}:${node.text};`;
  return allChildren(node).map((entry) => structuralTokens(entry)).join("");
}

/** Converts a Tree-sitter point (UTF-8 byte column) to a VS Code position (UTF-16 column). */
export function pointToPosition(
  point: { row: number; column: number },
  source: string
): Position {
  const vscode = require("vscode") as typeof import("vscode");
  const line = source.split(/\r?\n/)[point.row] ?? "";
  const bytePrefix = Buffer.from(line, "utf8").subarray(0, point.column).toString("utf8");
  return new vscode.Position(point.row, bytePrefix.length);
}
