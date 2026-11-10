import { basename, extname } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import * as vscode from "vscode";
import { cacheKey, fingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import { scanSvelte, svelteAnalysisSource } from "./blocks";
import type { ComparisonFunction, FunctionDiscovery, FunctionSlice } from "../support";
import { comparisonDiscovery, comparisonFunction, structuralTokens } from "../treeSitter";
import {
  javascriptFunctionNodes,
  javascriptSignature,
  withJavaScriptSyntaxTree,
  withTypeScriptSyntaxTree
} from "../javascript/syntax";

const COMPONENT_KIND = "component";
const COMPONENT_ANALYSIS = "svelte-scanner";

interface SvelteFunction {
  readonly entry: ReturnType<typeof javascriptFunctionNodes>[number];
  readonly qualifiedName: string;
  readonly module: boolean;
}

function componentName(path: string): string {
  const name = basename(path, extname(path));
  return name || "Component";
}

function componentSignature(source: string, name: string): string {
  const runeProps = [...source.matchAll(/^\s*(?:let|const)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]{0,200})?\s*=\s*\$props(?:<[\s\S]{0,400}?>)?\s*\(\s*\)/gm)]
    .map((match) => match[1]!.replace(/\s+/g, " ").trim());
  const legacyProps = [...source.matchAll(/^\s*export\s+let\s+([^\n;]+)/gm)]
    .map((match) => match[1]!.replace(/\s+/g, " ").trim());
  if (runeProps.length) return `${name} takes props ${runeProps.join(", ")}`;
  if (legacyProps.length) return `${name} takes legacy props ${legacyProps.join(", ")}`;
  return `${name} has no detected props`;
}

export function withSvelteSyntaxTree<T>(
  source: string,
  path: string,
  use: (root: SyntaxNode) => T
): Promise<T | undefined> {
  const scan = scanSvelte(source);
  return scan.scripts.some((script) => script.typescript)
    ? withTypeScriptSyntaxTree(scan.scriptView, use)
    : withJavaScriptSyntaxTree(scan.scriptView, path, use);
}

function functionEntries(source: string, path: string, root: SyntaxNode): SvelteFunction[] {
  const scan = scanSvelte(source);
  const component = componentName(path);
  return javascriptFunctionNodes(root).flatMap((entry) => {
    const script = scan.scripts.find((block) =>
      entry.node.startIndex >= block.contentStart && entry.node.startIndex < block.contentEnd);
    if (!script) return [];
    const localName = entry.qualifiedName;
    return [{
      entry,
      module: script.module,
      qualifiedName: script.module
        ? `${component}.module.${localName}`
        : `${component}.${localName}`
    }];
  });
}

function componentFingerprint(source: string, path: string): Promise<string> {
  const scan = scanSvelte(source);
  const markup = scan.markupView.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  return withSvelteSyntaxTree(source, path, structuralTokens)
    .then((tokens) => fingerprint(JSON.stringify([tokens ?? scan.scriptView, markup])));
}

async function componentTarget(document: vscode.TextDocument, source: string): Promise<FunctionTarget> {
  const name = componentName(document.uri.path);
  const lines = source.split(/\r?\n/);
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lines.length - 1, lines.at(-1)?.length ?? 0));
  return {
    uri: document.uri,
    range,
    selection: range,
    languageId: document.languageId,
    name,
    qualifiedName: name,
    signature: componentSignature(source, name),
    source: svelteAnalysisSource(source),
    symbolId: cacheKey(["svelte-v1", document.uri.path, name]),
    structuralFingerprint: await componentFingerprint(source, document.uri.path),
    analysis: COMPONENT_ANALYSIS
  };
}

/** Returns the innermost named script function, or the component as a whole. */
export async function findSvelteFunction(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<FunctionTarget | undefined> {
  const source = document.getText();
  const scan = scanSvelte(source);
  if (!scan.supported) return undefined;
  const found = await withSvelteSyntaxTree(source, document.uri.path, (root) => {
    const entry = functionEntries(source, document.uri.path, root)
      .filter(({ entry: candidate }) => {
        const start = new vscode.Position(candidate.node.startPosition.row, candidate.node.startPosition.column);
        const end = new vscode.Position(candidate.node.endPosition.row, candidate.node.endPosition.column);
        return new vscode.Range(start, end).contains(position);
      })
      .sort((left, right) =>
        (left.entry.node.endIndex - left.entry.node.startIndex) - (right.entry.node.endIndex - right.entry.node.startIndex))[0];
    if (!entry) return undefined;
    const start = new vscode.Position(entry.entry.node.startPosition.row, entry.entry.node.startPosition.column);
    const end = new vscode.Position(entry.entry.node.endPosition.row, entry.entry.node.endPosition.column);
    const range = new vscode.Range(start, end);
    const selection = entry.entry.name
      ? new vscode.Range(
        new vscode.Position(entry.entry.name.startPosition.row, entry.entry.name.startPosition.column),
        new vscode.Position(entry.entry.name.endPosition.row, entry.entry.name.endPosition.column)
      )
      : new vscode.Range(start, start);
    return {
      uri: document.uri,
      range,
      selection,
      languageId: document.languageId,
      name: entry.entry.simpleName,
      qualifiedName: entry.qualifiedName,
      signature: javascriptSignature(entry.entry),
      source: entry.entry.node.text,
      symbolId: cacheKey(["svelte-v1", document.uri.path, entry.qualifiedName]),
      structuralFingerprint: fingerprint(structuralTokens(entry.entry.node)),
      analysis: COMPONENT_ANALYSIS
    } satisfies FunctionTarget;
  });
  return found ?? componentTarget(document, source);
}

export async function listSvelteFunctions(source: string, path: string): Promise<FunctionSlice[]> {
  const scan = scanSvelte(source);
  if (!scan.supported) return [];
  const name = componentName(path);
  const componentSourceFingerprint = await componentFingerprint(source, path);
  const component: FunctionSlice = {
    name,
    qualifiedName: name,
    signature: componentSignature(source, name),
    source: svelteAnalysisSource(source, scan),
    startLine: 0,
    endLine: Math.max(0, source.split(/\r?\n/).length - 1),
    fingerprint: componentSourceFingerprint
  };
  const functions = await withSvelteSyntaxTree(source, path, (root) =>
    functionEntries(source, path, root).map(({ entry, qualifiedName }) => ({
      name: entry.simpleName,
      qualifiedName,
      signature: javascriptSignature(entry),
      source: entry.node.text,
      startLine: entry.node.startPosition.row,
      endLine: entry.node.endPosition.row,
      fingerprint: fingerprint(structuralTokens(entry.node))
    }))) ?? [];
  return [component, ...functions];
}

export async function svelteComparisonFunctions(source: string, path: string): Promise<FunctionDiscovery> {
  const scan = scanSvelte(source);
  if (!scan.supported) return { status: "unavailable", entries: [], limitations: ["Svelte block scanning exceeded its source or block limit."] };
  const component = componentName(path);
  const lines = source.split(/\r?\n/);
  const componentEntryFingerprint = await componentFingerprint(source, path);
  const found = await withSvelteSyntaxTree(source, path, (root) => {
    const componentEntry: ComparisonFunction = {
      name: component,
      qualifiedName: component,
      matchKey: JSON.stringify(["svelte-component", component]),
      kind: COMPONENT_KIND,
      signature: componentSignature(source, component),
      source: svelteAnalysisSource(source, scan),
      startLine: 0,
      endLine: Math.max(0, lines.length - 1),
      startColumn: 0,
      endColumn: lines.at(-1)?.length ?? 0,
      nameLine: 0,
      nameColumn: 0,
      fingerprint: componentEntryFingerprint,
      signatureFingerprint: fingerprint(componentSignature(source, component).replace(/\s+/g, " ").trim())
    };
    const entries = functionEntries(source, path, root)
      .filter(({ entry }) => Boolean(entry.fn.childForFieldName("body")))
      .map(({ entry, qualifiedName }) => ({
        ...comparisonFunction(
          entry.node,
          entry.name ?? entry.fn,
          qualifiedName,
          JSON.stringify(["svelte-function", qualifiedName]),
          entry.kind,
          javascriptSignature(entry)
        ),
        name: entry.simpleName
      }));
    return comparisonDiscovery(root, [componentEntry, ...entries]);
  });
  return found ?? { status: "unavailable", entries: [], limitations: ["Svelte script parsing was unavailable."] };
}

export { componentName, componentSignature, functionEntries };
