import { createRequire } from "node:module";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { TextDocument, Position, Range } from "vscode";
import { cacheKey, fingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import { allChildren, pointToPosition, structuralTokens, treeSitterGrammar } from "../treeSitter";
import { comparisonDiscovery, comparisonFunction, comparisonTokens } from "../treeSitter";
import type { FunctionDiscovery } from "../support";

const require = createRequire(__filename);
const grammar = treeSitterGrammar("tree-sitter-rust.wasm", "Rust");

export function initializeRustParserAt(extensionPath: string): Promise<void> {
  return grammar.initialize(extensionPath);
}

/** Parses Rust source with the bundled grammar and releases the tree after `use` returns. */
export function withRustSyntaxTree<T>(
  source: string,
  use: (root: SyntaxNode) => T
): Promise<T | undefined> {
  return grammar.withSyntaxTree(source, use);
}

function child(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

const nodeChildren = allChildren;

export const rustStructuralTokens = structuralTokens;

interface FoundFunction {
  readonly node: SyntaxNode;
  readonly name: SyntaxNode;
  readonly containers: string[];
  readonly identityContainers: string[];
}

function findFunctions(root: SyntaxNode): FoundFunction[] {
  const found: FoundFunction[] = [];
  const visit = (node: SyntaxNode, containers: string[], identityContainers: string[]) => {
    const nextContainers = [...containers];
    const nextIdentities = [...identityContainers];
    if (node.type === "trait_item" || node.type === "mod_item") {
      const containerName = child(node, "name")?.text;
      if (containerName) {
        nextContainers.push(containerName);
        nextIdentities.push(containerName);
      }
    } else if (node.type === "impl_item") {
      // impl blocks have no name; identify methods by type (and trait) so
      // `Foo::new` and `Bar::new` in one file are distinct functions.
      const type = child(node, "type")?.text;
      const trait = child(node, "trait")?.text;
      if (type) {
        nextContainers.push(trait ? `<${type} as ${trait}>` : type);
        nextIdentities.push(JSON.stringify([comparisonTokens(child(node, "type")!), child(node, "trait") ? comparisonTokens(child(node, "trait")!) : ""]));
      }
    }
    if (node.type === "function_item") {
      const name = child(node, "name");
      if (name) {
        found.push({ node, name, containers, identityContainers });
        nextContainers.push(name.text);
        nextIdentities.push(name.text);
      }
    }
    for (const entry of nodeChildren(node)) visit(entry, nextContainers, nextIdentities);
  };
  visit(root, [], []);
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

export function rustSignature(node: SyntaxNode): string {
  const body = child(node, "body");
  return body ? node.text.slice(0, node.text.lastIndexOf(body.text)).trim() : node.text;
}

export async function findRustFunction(
  document: TextDocument,
  position: Position
): Promise<FunctionTarget | undefined> {
  const source = document.getText();
  const vscode = require("vscode") as typeof import("vscode");
  return withRustSyntaxTree(source, (root) => {
    const rangeOf = (node: SyntaxNode) =>
      new vscode.Range(pointToPosition(node.startPosition), pointToPosition(node.endPosition));
    const found = smallestContaining(findFunctions(root), position, (entry) => rangeOf(entry.node));
    if (!found) return undefined;
    const qualifiedName = [...found.containers, found.name.text].join("::");
    return {
      uri: document.uri,
      range: rangeOf(found.node),
      selection: rangeOf(found.name),
      languageId: "rust",
      name: found.name.text,
      qualifiedName,
      signature: rustSignature(found.node),
      source: found.node.text,
      symbolId: cacheKey(["rust-v1", document.uri.path, qualifiedName]),
      structuralFingerprint: fingerprint(rustStructuralTokens(found.node)),
      analysis: "rust-tree-sitter"
    };
  });
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

export async function listRustFunctions(document: Pick<TextDocument, "getText">): Promise<RustFunctionSlice[]> {
  return (await withRustSyntaxTree(document.getText(), (root) =>
    findFunctions(root).map(({ node, name, containers }) => ({
      name: name.text,
      qualifiedName: [...containers, name.text].join("::"),
      signature: rustSignature(node),
      source: node.text,
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      fingerprint: fingerprint(rustStructuralTokens(node))
    }))
  )) ?? [];
}

export async function rustComparisonFunctions(source: string): Promise<FunctionDiscovery> {
  return (await withRustSyntaxTree(source, (root) => comparisonDiscovery(root, findFunctions(root).map(({ node, name, containers, identityContainers }) =>
    comparisonFunction(node, name, [...containers, name.text].join("::"), JSON.stringify([identityContainers, name.text]),
      ["impl_item", "trait_item"].includes(node.parent?.parent?.type ?? "") ? "method" : "function", rustSignature(node))
  )))) ?? { status: "unavailable", entries: [], limitations: [] };
}

export interface RustDeclarationSlice {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly source: string;
  readonly fingerprint: string;
}

export async function findRustDeclarations(
  document: Pick<TextDocument, "getText">,
  referencedNames: ReadonlySet<string>
): Promise<RustDeclarationSlice[]> {
  const kinds = new Set([
    "struct_item", "enum_item", "trait_item", "type_item", "const_item", "static_item"
  ]);
  return (await withRustSyntaxTree(document.getText(), (root) => {
    const found: RustDeclarationSlice[] = [];
    const visit = (node: SyntaxNode) => {
      if (kinds.has(node.type)) {
        const name = child(node, "name")?.text;
        if (name && referencedNames.has(name)) {
          found.push({
            name,
            kind: node.type,
            line: node.startPosition.row,
            source: node.text,
            fingerprint: fingerprint(rustStructuralTokens(node))
          });
        }
      }
      for (const entry of nodeChildren(node)) visit(entry);
    };
    visit(root);
    return found.slice(0, 12);
  })) ?? [];
}

export async function fingerprintRustSyntax(source: string): Promise<string> {
  const value = await withRustSyntaxTree(source, (root) => fingerprint(rustStructuralTokens(root)));
  if (value === undefined) throw new Error("Tree-sitter could not parse the Rust source.");
  return value;
}
