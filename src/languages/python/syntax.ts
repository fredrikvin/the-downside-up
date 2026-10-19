import type { Node as SyntaxNode } from "web-tree-sitter";
import { Position, Range, type TextDocument } from "vscode";
import { cacheKey, fingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import type { FunctionSlice } from "../support";
import { namedChildren, structuralTokens, treeSitterGrammar } from "../treeSitter";

const grammar = treeSitterGrammar("tree-sitter-python.wasm", "Python");

export const initializePythonParserAt = grammar.initialize;
export const withPythonSyntaxTree = grammar.withSyntaxTree;

export function pythonDefinition(node: SyntaxNode): SyntaxNode {
  return node.type === "decorated_definition" ? node.childForFieldName("definition") ?? node : node;
}

export function pythonQualifiedName(node: SyntaxNode, containers: readonly string[], name: string): string {
  const accessor = node.type === "decorated_definition" ? namedChildren(node)
    .find((child) => child.type === "decorator" && [`@${name}.setter`, `@${name}.deleter`, `@${name}.getter`].includes(child.text))
    ?.text.split(".").at(-1) : undefined;
  return [...containers, name, ...(accessor ? [accessor] : [])].join(".");
}

export function pythonSignature(node: SyntaxNode): string {
  const definition = pythonDefinition(node);
  const body = definition.childForFieldName("body");
  return body ? node.text.slice(0, body.startIndex - node.startIndex).trimEnd() : node.text;
}

export interface PythonFunctionNode {
  readonly node: SyntaxNode;
  readonly definition: SyntaxNode;
  readonly name: SyntaxNode;
  readonly qualifiedName: string;
  readonly method: boolean;
  readonly depth: number;
}

export function pythonFunctionNodes(root: SyntaxNode): PythonFunctionNode[] {
  const functions: PythonFunctionNode[] = [];
  const visit = (node: SyntaxNode, containers: string[], owner?: string) => {
    const definition = pythonDefinition(node);
    if (definition.type === "function_definition" || definition.type === "class_definition") {
      const name = definition.childForFieldName("name");
      if (!name) return;
      const qualifiedName = pythonQualifiedName(node, containers, name.text);
      if (definition.type === "function_definition") {
        functions.push({
          node, definition, name, qualifiedName,
          method: owner === "class_definition", depth: containers.length
        });
      }
      const body = definition.childForFieldName("body");
      if (body) visit(body, qualifiedName.split("."), definition.type);
      return;
    }
    for (const child of namedChildren(node)) visit(child, containers, owner);
  };
  visit(root, []);
  return functions;
}

export async function findPythonFunction(document: TextDocument, position: Position): Promise<FunctionTarget | undefined> {
  return withPythonSyntaxTree(document.getText(), (root) => {
    const rangeOf = (node: SyntaxNode) =>
      new Range(new Position(node.startPosition.row, node.startPosition.column), new Position(node.endPosition.row, node.endPosition.column));
    const found = pythonFunctionNodes(root).reverse().find((entry) => rangeOf(entry.node).contains(position));
    if (!found) return undefined;
    return {
      uri: document.uri, range: rangeOf(found.node), selection: rangeOf(found.name),
      languageId: "python", name: found.name.text, qualifiedName: found.qualifiedName,
      signature: pythonSignature(found.node), source: found.node.text,
      symbolId: cacheKey(["python-v1", document.uri.path, found.qualifiedName]),
      structuralFingerprint: fingerprint(structuralTokens(found.node)),
      analysis: "python-tree-sitter"
    };
  });
}

export async function listPythonFunctions(source: string): Promise<FunctionSlice[]> {
  return (await withPythonSyntaxTree(source, (root) => pythonFunctionNodes(root).map((entry) => ({
    name: entry.name.text, qualifiedName: entry.qualifiedName,
    signature: pythonSignature(entry.node), source: entry.node.text,
    startLine: entry.node.startPosition.row, endLine: entry.node.endPosition.row,
    fingerprint: fingerprint(structuralTokens(entry.node))
  })))) ?? [];
}

/** Only literal docstrings: f-strings and implicit expressions are not documentation. */
export function pythonDocstring(body: SyntaxNode): string | undefined {
  const first = namedChildren(body).find((node) => node.type !== "comment");
  const string = first?.type === "expression_statement" ? namedChildren(first)[0] : undefined;
  if (string?.type !== "string" || namedChildren(string).some((node) => node.type === "interpolation")) return undefined;
  const match = /^(?:[ru])?("""|'''|"|')([\s\S]*)\1$/i.exec(string.text);
  if (!match) return undefined;
  const lines = match[2]!.split(/\r?\n/);
  const indent = Math.min(...lines.slice(1).filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length));
  return [lines[0]!.trim(), ...lines.slice(1).map((line) => line.slice(Number.isFinite(indent) ? indent : 0))]
    .join("\n").trim() || undefined;
}
