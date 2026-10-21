import { createRequire } from "node:module";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { Position, TextDocument } from "vscode";
import { cacheKey, fingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import { namedChildren, pointToPosition, structuralTokens, treeSitterGrammar } from "../treeSitter";
import { comparisonDiscovery, comparisonFunction } from "../treeSitter";
import type { FunctionDiscovery } from "../support";

const require = createRequire(__filename);
const grammar = treeSitterGrammar("tree-sitter-go.wasm", "Go");

export function initializeGoParserAt(extensionPath: string): Promise<void> {
  return grammar.initialize(extensionPath);
}

/** Parses Go source with the bundled grammar and releases the tree after `use` returns. */
export function withGoSyntaxTree<T>(
  source: string,
  use: (root: SyntaxNode) => T
): Promise<T | undefined> {
  return grammar.withSyntaxTree(source, use);
}

/** Declaration text before the body, such as `func (c *Catalog) Add(b Book) error`. */
export function goSignature(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  return body ? node.text.slice(0, body.startIndex - node.startIndex).trim() : node.text.trim();
}

/** Base type name of a type expression: `*inventory.Catalog[T]` gives `Catalog`. */
export function goBaseTypeName(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "pointer_type":
    case "parenthesized_type":
      return goBaseTypeName(namedChildren(node)[0] ?? null);
    case "generic_type":
      return goBaseTypeName(node.childForFieldName("type"));
    case "qualified_type":
      return node.childForFieldName("name")?.text;
    default:
      return undefined;
  }
}

export function goReceiverType(method: SyntaxNode): string | undefined {
  const receiver = method.childForFieldName("receiver");
  const parameter = receiver ? namedChildren(receiver).find((entry) => entry.type === "parameter_declaration") : undefined;
  return goBaseTypeName(parameter?.childForFieldName("type") ?? null);
}

export interface GoFunctionNode {
  readonly node: SyntaxNode;
  readonly name: SyntaxNode;
  /** `Name` for functions and `Type.Name` for methods; repeated `init` functions are numbered. */
  readonly qualifiedName: string;
}

export function goFunctionNodes(root: SyntaxNode): GoFunctionNode[] {
  const found: GoFunctionNode[] = [];
  let inits = 0;
  for (const node of namedChildren(root)) {
    if (node.type !== "function_declaration" && node.type !== "method_declaration") continue;
    const name = node.childForFieldName("name");
    if (!name) continue;
    let qualifiedName = name.text;
    if (node.type === "method_declaration") {
      const receiver = goReceiverType(node);
      if (receiver) qualifiedName = `${receiver}.${name.text}`;
    } else if (name.text === "init") {
      inits++;
      if (inits > 1) qualifiedName = `init#${inits}`;
    }
    found.push({ node, name, qualifiedName });
  }
  return found;
}

export async function findGoFunction(
  document: TextDocument,
  position: Position
): Promise<FunctionTarget | undefined> {
  const source = document.getText();
  const vscode = require("vscode") as typeof import("vscode");
  return withGoSyntaxTree(source, (root) => {
    const rangeOf = (node: SyntaxNode) =>
      new vscode.Range(pointToPosition(node.startPosition), pointToPosition(node.endPosition));
    const found = goFunctionNodes(root).find((entry) => rangeOf(entry.node).contains(position));
    if (!found) return undefined;
    return {
      uri: document.uri,
      range: rangeOf(found.node),
      selection: rangeOf(found.name),
      languageId: "go",
      name: found.name.text,
      qualifiedName: found.qualifiedName,
      signature: goSignature(found.node),
      source: found.node.text,
      symbolId: cacheKey(["go-v1", document.uri.path, found.qualifiedName]),
      structuralFingerprint: fingerprint(structuralTokens(found.node)),
      analysis: "go-tree-sitter" as const
    };
  });
}

export interface GoFunctionSlice {
  readonly name: string;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly source: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fingerprint: string;
}

export async function listGoFunctions(document: Pick<TextDocument, "getText">): Promise<GoFunctionSlice[]> {
  return (await withGoSyntaxTree(document.getText(), (root) =>
    goFunctionNodes(root).map(({ node, name, qualifiedName }) => ({
      name: name.text,
      qualifiedName,
      signature: goSignature(node),
      source: node.text,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      fingerprint: fingerprint(structuralTokens(node))
    }))
  )) ?? [];
}

export async function goComparisonFunctions(source: string): Promise<FunctionDiscovery> {
  return (await withGoSyntaxTree(source, (root) => comparisonDiscovery(root, goFunctionNodes(root).map(({ node, name, qualifiedName }) =>
    comparisonFunction(node, name, qualifiedName, JSON.stringify([goReceiverType(node) ?? "", name.text]),
      node.type === "method_declaration" ? "method" : "function", goSignature(node))
  )))) ?? { status: "unavailable", entries: [], limitations: [] };
}
