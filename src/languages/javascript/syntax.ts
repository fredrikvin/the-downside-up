import { extname } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import * as vscode from "vscode";
import { cacheKey, fingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import type { FunctionSlice } from "../support";
import { namedChildren, structuralTokens, treeSitterGrammar } from "../treeSitter";
import { comparisonDiscovery, comparisonFunction, comparisonTokens } from "../treeSitter";
import type { FunctionDiscovery } from "../support";

// `.ts` files need the TypeScript grammar: in TSX, `<T>(x) => x` and `<T>value` read as JSX.
const typescriptGrammar = treeSitterGrammar("tree-sitter-typescript.wasm", "TypeScript");
const tsxGrammar = treeSitterGrammar("tree-sitter-tsx.wasm", "TSX");
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

export const JAVASCRIPT_LANGUAGE_IDS = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
export const JAVASCRIPT_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export async function initializeJavaScriptParsersAt(extensionPath: string): Promise<void> {
  await Promise.all([typescriptGrammar.initialize(extensionPath), tsxGrammar.initialize(extensionPath)]);
}

/** Parses JavaScript or TypeScript with the grammar for the file, releasing the tree after `use` returns. */
export function withJavaScriptSyntaxTree<T>(
  source: string,
  path: string,
  use: (root: SyntaxNode) => T
): Promise<T | undefined> {
  const typescript = TYPESCRIPT_EXTENSIONS.has(extname(path).toLowerCase());
  return (typescript ? typescriptGrammar : tsxGrammar).withSyntaxTree(source, use);
}

export type JsFunctionKind = "function" | "method" | "component" | "hook";

export interface JsFunctionNode {
  /** The declaration: a function, method, field, pair, or the `const` statement holding it, with any `export`. */
  readonly node: SyntaxNode;
  /** The function itself (arrow, expression, declaration, or method). */
  readonly fn: SyntaxNode;
  readonly name: SyntaxNode | null;
  readonly simpleName: string;
  /** Dot-joined names of enclosing classes, objects, and functions, as editor outlines show them. */
  readonly qualifiedName: string;
  readonly containers: readonly string[];
  readonly kind: JsFunctionKind;
  readonly exported: boolean;
  readonly isDefault: boolean;
  /** Wrapping calls, outermost first, such as `memo` or `forwardRef`. */
  readonly wrappers: readonly string[];
}

const FUNCTION_TYPES = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "generator_function",
  "function", "arrow_function", "method_definition"
]);
const JSX_TYPES = new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);
const CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration", "class"]);

function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

/**
 * Calls known to return the function they are given, wrapped. Other calls
 * with a callback, such as `items.find(...)` or `useMemo(...)`, return a
 * value, so their callback is part of the function around them.
 */
const FUNCTION_WRAPPERS = /(?:^|\.)(?:memo|forwardRef|useCallback|observer|debounce|throttle|once|memoize|with[A-Z]\w*)$/;

/** The function inside a value: itself, or the function argument of a known wrapper such as `memo(...)`. */
export function unwrapFunction(value: SyntaxNode | null): { fn: SyntaxNode; wrappers: string[] } | undefined {
  const wrappers: string[] = [];
  let current = value;
  for (let depth = 0; current && depth < 4; depth++) {
    while (current && (current.type === "parenthesized_expression" || current.type === "as_expression" || current.type === "satisfies_expression")) {
      current = namedChildren(current)[0] ?? null;
    }
    if (!current) return undefined;
    if (FUNCTION_TYPES.has(current.type) && current.type !== "method_definition") return { fn: current, wrappers };
    if (current.type !== "call_expression") return undefined;
    const callee = field(current, "function");
    const args = field(current, "arguments");
    const inner = args ? namedChildren(args).find((entry) =>
      FUNCTION_TYPES.has(entry.type) || entry.type === "call_expression") : undefined;
    if (!callee || !inner || !FUNCTION_WRAPPERS.test(callee.text)) return undefined;
    wrappers.push(callee.text);
    current = inner;
  }
  return undefined;
}

/** Whether a function returns JSX, ignoring named functions nested in it. */
export function returnsJsx(fn: SyntaxNode): boolean {
  const visit = (node: SyntaxNode): boolean => {
    if (JSX_TYPES.has(node.type)) return true;
    if (node !== fn && FUNCTION_TYPES.has(node.type) && node.type !== "arrow_function") return false;
    return namedChildren(node).some(visit);
  };
  return visit(fn);
}

function kindOf(name: string, fn: SyntaxNode, wrappers: readonly string[], inClass: boolean): JsFunctionKind {
  if (/^use[A-Z0-9]/.test(name)) return "hook";
  if (inClass) return "method";
  const wrapped = wrappers.some((wrapper) => /(?:^|\.)(?:memo|forwardRef)$/.test(wrapper));
  if (/^\p{Lu}/u.test(name) && (wrapped || returnsJsx(fn))) return "component";
  return "function";
}

/**
 * Named functions in source order: declarations, functions and wrapped
 * functions assigned to variables, class and object methods, and class
 * fields holding functions. Unnamed callbacks belong to the function around
 * them. A default-exported unnamed function is named `default`.
 */
export function javascriptFunctionNodes(root: SyntaxNode): JsFunctionNode[] {
  const found: JsFunctionNode[] = [];
  const seen = new Map<string, number>();
  const add = (
    node: SyntaxNode,
    fn: SyntaxNode,
    name: SyntaxNode | null,
    simpleName: string,
    containers: readonly string[],
    flags: { exported: boolean; isDefault: boolean; inClass: boolean; wrappers?: string[] }
  ): void => {
    const base = [...containers, simpleName].join(".");
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const wrappers = flags.wrappers ?? [];
    found.push({
      node,
      fn,
      name,
      simpleName,
      qualifiedName: count > 1 ? `${base}#${count}` : base,
      containers,
      kind: kindOf(simpleName, fn, wrappers, flags.inClass),
      exported: flags.exported,
      isDefault: flags.isDefault,
      wrappers
    });
  };

  // `outer` is the `export` statement around a declaration, so the function's range starts at `export`.
  const visit = (node: SyntaxNode, containers: readonly string[], exported = false, isDefault = false, outer?: SyntaxNode): void => {
    const type = node.type;
    if (type === "export_statement") {
      const isDefaultExport = /^export\s+default\b/.test(node.text);
      const declaration = field(node, "declaration");
      const value = field(node, "value");
      if (declaration) return visit(declaration, containers, true, isDefaultExport, node);
      const unwrapped = value ? unwrapFunction(value) : undefined;
      if (unwrapped) {
        const ownName = field(unwrapped.fn, "name");
        const simpleName = ownName?.text ?? "default";
        add(node, unwrapped.fn, ownName, simpleName, containers, {
          exported: true, isDefault: true, inClass: false, wrappers: unwrapped.wrappers
        });
        return visitBody(unwrapped.fn, [...containers, simpleName]);
      }
      return namedChildren(node).forEach((child) => visit(child, containers, true, isDefaultExport));
    }
    if (type === "function_declaration" || type === "generator_function_declaration") {
      const name = field(node, "name");
      const simpleName = name?.text ?? "default";
      add(outer ?? node, node, name, simpleName, containers, { exported, isDefault, inClass: false });
      return visitBody(node, [...containers, simpleName]);
    }
    if (type === "lexical_declaration" || type === "variable_declaration") {
      const declarators = namedChildren(node).filter((child) => child.type === "variable_declarator");
      for (const declarator of declarators) {
        const name = field(declarator, "name");
        const value = field(declarator, "value");
        if (!name || name.type !== "identifier") {
          if (value) visit(value, containers);
          continue;
        }
        const unwrapped = unwrapFunction(value);
        if (unwrapped) {
          add(declarators.length === 1 ? outer ?? node : declarator, unwrapped.fn, name, name.text, containers, {
            exported, isDefault, inClass: false, wrappers: unwrapped.wrappers
          });
          visitBody(unwrapped.fn, [...containers, name.text]);
        } else if (value?.type === "object") {
          visitObject(value, [...containers, name.text]);
        } else if (value) {
          visit(value, containers);
        }
      }
      return;
    }
    if (CLASS_TYPES.has(type)) {
      const name = field(node, "name")?.text ?? "default";
      const body = field(node, "body");
      if (body) visitClass(body, [...containers, name]);
      return;
    }
    // An unnamed callback: named functions inside it still belong to the enclosing scope.
    if (FUNCTION_TYPES.has(type)) return visitBody(node, containers);
    for (const child of namedChildren(node)) visit(child, containers);
  };

  const visitBody = (fn: SyntaxNode, containers: readonly string[]): void => {
    for (const child of namedChildren(fn)) {
      if (child.type === "formal_parameters" || child.type === "type_annotation" || child.type === "type_parameters") continue;
      visit(child, containers);
    }
  };

  const visitMember = (member: SyntaxNode, containers: readonly string[]): void => {
    if (member.type === "method_definition") {
      const name = field(member, "name");
      if (!name) return;
      add(member, member, name, name.text, containers, { exported: false, isDefault: false, inClass: true });
      visitBody(member, [...containers, name.text]);
      return;
    }
    const isField = member.type === "public_field_definition" || member.type === "field_definition";
    const name = isField ? field(member, "name") ?? field(member, "property") : field(member, "key");
    const value = field(member, "value");
    if (!name || (!isField && member.type !== "pair")) return;
    const unwrapped = unwrapFunction(value);
    if (unwrapped && (isField || name.type === "property_identifier" || name.type === "identifier")) {
      add(member, unwrapped.fn, name, name.text, containers, {
        exported: false, isDefault: false, inClass: true, wrappers: unwrapped.wrappers
      });
      visitBody(unwrapped.fn, [...containers, name.text]);
    } else if (!isField && value?.type === "object") {
      visitObject(value, [...containers, name.text]);
    }
  };

  const visitClass = (body: SyntaxNode, containers: readonly string[]): void => {
    for (const member of namedChildren(body)) visitMember(member, containers);
  };
  const visitObject = (object: SyntaxNode, containers: readonly string[]): void => {
    for (const member of namedChildren(object)) visitMember(member, containers);
  };

  for (const child of namedChildren(root)) visit(child, []);
  return found;
}

/** Declaration text before the function body, such as `const CartView = ({ items }: Props) =>`. */
export function javascriptSignature(entry: Pick<JsFunctionNode, "node" | "fn">): string {
  const body = field(entry.fn, "body");
  const end = body ? body.startIndex : entry.fn.endIndex;
  return entry.node.text.slice(0, Math.max(0, end - entry.node.startIndex)).trim();
}

export interface JsFunctionSlice extends FunctionSlice {
  readonly kind: JsFunctionKind;
}

export async function listJavaScriptFunctions(source: string, path: string): Promise<JsFunctionSlice[]> {
  return (await withJavaScriptSyntaxTree(source, path, (root) => javascriptFunctionNodes(root).map((entry) => ({
    name: entry.simpleName,
    qualifiedName: entry.qualifiedName,
    signature: javascriptSignature(entry),
    source: entry.node.text,
    startLine: entry.node.startPosition.row,
    endLine: entry.node.endPosition.row,
    fingerprint: fingerprint(structuralTokens(entry.node)),
    kind: entry.kind
  })))) ?? [];
}

export async function javascriptComparisonFunctions(source: string, path: string): Promise<FunctionDiscovery> {
  return (await withJavaScriptSyntaxTree(source, path, (root) => comparisonDiscovery(root,
    javascriptFunctionNodes(root).filter((entry) => Boolean(field(entry.fn, "body"))).map((entry) => {
      const base = comparisonFunction(entry.node, entry.name ?? entry.fn, entry.qualifiedName,
        JSON.stringify([entry.containers, entry.simpleName, entry.kind === "method" ? "method" : "function"]),
        entry.kind, javascriptSignature(entry));
      // Overload declarations belong to the implementation, not to separate Explain cards.
      const overloads: string[] = [];
      let previous = entry.node.previousNamedSibling;
      while (previous) {
        if (previous.type.includes("comment")) { previous = previous.previousNamedSibling; continue; }
        const declaration = field(previous, "declaration") ?? previous;
        if (!["function_signature", "method_signature", "abstract_method_signature"].includes(declaration.type) ||
            field(declaration, "name")?.text !== entry.simpleName) break;
        overloads.unshift(comparisonTokens(declaration));
        previous = previous.previousNamedSibling;
      }
      return { ...base, name: entry.simpleName,
        fingerprint: fingerprint(JSON.stringify([base.fingerprint, overloads])),
        signatureFingerprint: fingerprint(JSON.stringify([comparisonTokens(entry.node, field(entry.fn, "body")?.id), overloads])) };
    })))) ?? { status: "unavailable", entries: [], limitations: [] };
}

/** Converts a Tree-sitter point to a VS Code position; both count columns in UTF-16 code units. */
export function javascriptPosition(point: { row: number; column: number }): vscode.Position {
  return new vscode.Position(point.row, point.column);
}

export async function findJavaScriptFunction(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<FunctionTarget | undefined> {
  const source = document.getText();
  return withJavaScriptSyntaxTree(source, document.uri.path, (root) => {
    const rangeOf = (node: SyntaxNode) =>
      new vscode.Range(javascriptPosition(node.startPosition), javascriptPosition(node.endPosition));
    const found = javascriptFunctionNodes(root)
      .filter((entry) => rangeOf(entry.node).contains(position))
      .sort((left, right) => (left.node.endIndex - left.node.startIndex) - (right.node.endIndex - right.node.startIndex))[0];
    if (!found) return undefined;
    const range = rangeOf(found.node);
    return {
      uri: document.uri,
      range,
      selection: found.name ? rangeOf(found.name) : new vscode.Range(range.start, range.start),
      languageId: document.languageId,
      name: found.simpleName,
      qualifiedName: found.qualifiedName,
      signature: javascriptSignature(found),
      source: found.node.text,
      symbolId: cacheKey(["javascript-v1", document.uri.path, found.qualifiedName]),
      structuralFingerprint: fingerprint(structuralTokens(found.node)),
      analysis: "javascript-tree-sitter"
    };
  });
}

const TYPE_WORDS: Record<string, string> = {
  interface_declaration: "interface",
  type_alias_declaration: "type alias",
  enum_declaration: "enum",
  class_declaration: "class",
  abstract_class_declaration: "abstract class"
};

export interface JsDeclaration {
  readonly kind: "function" | "method" | "type";
  /** How the item is described to the model, such as "component CartItem" or "interface Props". */
  readonly label: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly line: number;
  readonly source: string;
  readonly signature: string;
  readonly fingerprint: string;
  readonly signatureFingerprint: string;
}

const normalized = (text: string) => fingerprint(text.replace(/\s+/g, " "));

/** The function or type whose name is at a zero-based row and UTF-16 column, if any. */
export function javascriptDeclarationAt(root: SyntaxNode, row: number, column: number): JsDeclaration | undefined {
  const at = (node: SyntaxNode | null): boolean => Boolean(node) &&
    (node!.startPosition.row < row || (node!.startPosition.row === row && node!.startPosition.column <= column)) &&
    (node!.endPosition.row > row || (node!.endPosition.row === row && node!.endPosition.column >= column));
  const fn = javascriptFunctionNodes(root).find((entry) => at(entry.name));
  if (fn) {
    const signature = javascriptSignature(fn);
    return {
      kind: fn.kind === "method" ? "method" : "function",
      label: `${fn.kind} ${fn.qualifiedName}`,
      name: fn.simpleName,
      qualifiedName: fn.qualifiedName,
      line: fn.node.startPosition.row,
      source: fn.node.text,
      signature,
      fingerprint: fingerprint(structuralTokens(fn.node)),
      signatureFingerprint: normalized(signature)
    };
  }
  let found: JsDeclaration | undefined;
  const visit = (node: SyntaxNode): void => {
    if (found) return;
    const name = TYPE_WORDS[node.type] ? field(node, "name") : null;
    if (name && at(name)) {
      const body = field(node, "body");
      const isClass = node.type.includes("class");
      const signature = isClass && body ? node.text.slice(0, body.startIndex - node.startIndex).trim() : node.text;
      found = {
        kind: "type",
        label: `${TYPE_WORDS[node.type]} ${name.text}`,
        name: name.text,
        qualifiedName: name.text,
        line: node.startPosition.row,
        source: node.text,
        signature,
        fingerprint: fingerprint(structuralTokens(node)),
        signatureFingerprint: normalized(signature)
      };
      return;
    }
    if (node.startPosition.row <= row && node.endPosition.row >= row) namedChildren(node).forEach(visit);
  };
  visit(root);
  return found;
}
