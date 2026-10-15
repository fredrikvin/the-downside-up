import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { formatTolerantFingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import type { Dependency, DependencyItem, DependencyRequest, DependencyResult } from "../support";
import { findFunctionWithEditorTools } from "./symbols";

const MAX_LOOKUPS = 24;
const PARALLEL_LOOKUPS = 6;
const LOOKUP_TIMEOUT_MS = 1_500;
const DEFAULT_TIME_BUDGET_MS = 3_000;

const NOT_CALLS = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "return", "function", "typeof", "sizeof",
  "elif", "else", "do", "with", "assert", "await", "yield", "def", "fn", "func", "fun", "match",
  "when", "unless", "until", "in", "not", "and", "or", "lambda", "new", "using", "lock", "fixed",
  "checked", "unchecked", "nameof", "synchronized", "defined", "throw", "case", "delete", "void"
]);

/** A name that declares rather than calls, such as a nested `function inner(`. */
const DECLARES = /\b(?:function|def|fn|func|fun|sub|class|interface|struct|new)\s*\*?\s*$/;

const HASH_COMMENT_LANGUAGES = new Set([
  "python", "ruby", "shellscript", "perl", "r", "powershell", "elixir", "julia", "nim", "crystal", "coffeescript"
]);

export const LOOKUP_TIMED_OUT =
  "Looking up the functions this function calls took too long; some are not included or tracked.";
export const NO_DEFINITIONS =
  "VS Code language tooling found no definitions for the calls in this function, so the functions it calls are not included or tracked.";
export const UNREAD_CALLEES =
  "Some functions this function calls are in files outside the inventory's read budget; they are not included or tracked.";

/** Blanks comments and quoted strings, keeping offsets, so calls are only found in code. */
export function maskNonCode(source: string, languageId: string): string {
  const hash = HASH_COMMENT_LANGUAGES.has(languageId);
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    let stop: number | undefined;
    if (hash ? char === "#" : char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      stop = end < 0 ? source.length : end;
    } else if (!hash && char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      stop = end < 0 ? source.length : end + 2;
    } else if (char === "\"" || char === "'") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char && source[cursor] !== "\n") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      stop = Math.min(source.length, cursor + 1);
    }
    if (stop === undefined) {
      out += char;
      index++;
    } else {
      out += blank(source.slice(index, stop));
      index = stop;
    }
  }
  return out;
}

export interface CallSite {
  readonly name: string;
  /** Offset of the name in the function's source. */
  readonly offset: number;
}

/** Names followed by `(`, first occurrence of each in source order, skipping keywords and declarations. */
export function findCallSites(source: string, languageId: string, skipOffsets: ReadonlySet<number> = new Set()): CallSite[] {
  const code = maskNonCode(source, languageId);
  const seen = new Set<string>();
  const sites: CallSite[] = [];
  for (const match of code.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>\s*)?\(/g)) {
    const name = match[1]!;
    const offset = match.index!;
    if (NOT_CALLS.has(name) || seen.has(name) || skipOffsets.has(offset)) continue;
    if (DECLARES.test(code.slice(Math.max(0, offset - 24), offset))) continue;
    seen.add(name);
    sites.push({ name, offset });
  }
  return sites;
}

function repositoryPath(root: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") return undefined;
  const value = relative(root, resolve(uri.fsPath));
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return value.split(sep).join("/");
}

async function withTimeout<T>(promise: Thenable<T>, milliseconds: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Definition = vscode.Location | vscode.LocationLink;

function definitionTarget(definition: Definition): { uri: vscode.Uri; position: vscode.Position } {
  return "targetUri" in definition
    ? { uri: definition.targetUri, position: (definition.targetSelectionRange ?? definition.targetRange).start }
    : { uri: definition.uri, position: definition.range.start };
}

export interface LookupSite {
  readonly name: string;
  /** Where the name is used, in the function's document. */
  readonly position: vscode.Position;
}

export interface DefinitionTarget {
  /** Repository-relative path of the file with the definition. */
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly position: vscode.Position;
  /** The file's current text, preferring open buffers. */
  readonly text: string;
}

export interface SiteResolution {
  /** The function's document, used to ask for definitions. */
  readonly document: vscode.TextDocument;
  /** The function's range; definitions inside it are skipped. */
  readonly range: vscode.Range;
  readonly sites: readonly LookupSite[];
  /** The item declared at a definition, or undefined to skip it. */
  readonly itemAt: (definition: DefinitionTarget) => Promise<DependencyItem | undefined>;
  readonly maxLookups?: number;
}

/**
 * Resolves names a function uses with the editor's go-to-definition, at most
 * `maxLookups` distinct names within the request's deadline. Definitions
 * outside the repository, in files the inventory may not read, or inside the
 * function itself are skipped.
 */
export async function resolveSites(request: DependencyRequest, resolution: SiteResolution): Promise<DependencyResult> {
  const { document, range } = resolution;
  const sites = resolution.sites
    .filter((site) => request.onlyName === undefined || site.name === request.onlyName)
    .slice(0, resolution.maxLookups ?? MAX_LOOKUPS);
  const deadline = request.deadline ?? Date.now() + DEFAULT_TIME_BUDGET_MS;
  const limitations = new Set<string>();
  let answered = false;

  const lookup = async (site: LookupSite): Promise<Definition | undefined> => {
    const remaining = Math.min(LOOKUP_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0) {
      limitations.add(LOOKUP_TIMED_OUT);
      return undefined;
    }
    const result = await withTimeout(
      vscode.commands.executeCommand<Definition[] | undefined>("vscode.executeDefinitionProvider", document.uri, site.position),
      remaining
    ).catch(() => undefined);
    if (result === "timeout") {
      limitations.add(LOOKUP_TIMED_OUT);
      return undefined;
    }
    if (result?.length) answered = true;
    return result?.[0];
  };
  const definitions: Array<Definition | undefined> = [];
  for (let index = 0; index < sites.length; index += PARALLEL_LOOKUPS) {
    definitions.push(...await Promise.all(sites.slice(index, index + PARALLEL_LOOKUPS).map(lookup)));
  }

  const dependencies: Dependency[] = [];
  const known = new Set<string>();
  for (const definition of definitions) {
    if (!definition || dependencies.length >= (request.maxDependencies ?? MAX_LOOKUPS)) continue;
    const { uri, position } = definitionTarget(definition);
    const path = repositoryPath(request.root, uri);
    if (!path) continue;
    if (path === request.path && range.contains(position)) continue;
    if (!request.readablePaths.has(path)) {
      if (request.unreadPaths?.has(path)) limitations.add(UNREAD_CALLEES);
      continue;
    }
    const text = path === request.path ? request.text : await request.load(path);
    if (text === undefined) continue;
    const item = await resolution.itemAt({ path, uri, position, text }).catch(() => undefined);
    if (!item) continue;
    const key = `${path}\0${item.qualifiedName}`;
    if (known.has(key)) continue;
    known.add(key);
    dependencies.push({ path, item });
  }
  if (sites.length > 0 && !answered && !limitations.has(LOOKUP_TIMED_OUT)) limitations.add(NO_DEFINITIONS);
  return { dependencies, limitations: [...limitations] };
}

async function findTarget(root: string, path: string, line: number, name: string): Promise<{
  document: vscode.TextDocument;
  target: FunctionTarget;
} | undefined> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(root, path)));
  if (line >= document.lineCount) return undefined;
  const position = new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
  const target = await findFunctionWithEditorTools(document, position);
  return target && target.name === name ? { document, target } : undefined;
}

/**
 * Functions a function calls, for languages without bundled analysis. Call
 * sites are found in the function's text and resolved with the editor's
 * go-to-definition, and each definition is mapped to its enclosing function
 * with document symbols, so results depend on the installed language
 * extension. Definitions outside the repository, in files the inventory may
 * not read, or inside the function itself are skipped.
 */
export async function findEditorDependencies(request: DependencyRequest): Promise<DependencyResult> {
  const found = await findTarget(request.root, request.path, request.line, request.name);
  if (!found) return { dependencies: [], limitations: [] };
  const { document, target } = found;
  const start = document.offsetAt(target.range.start);
  const ownName = document.offsetAt(target.selection.start) - start;
  return resolveSites(request, {
    document,
    range: target.range,
    sites: findCallSites(target.source, document.languageId, new Set([ownName]))
      .map((site) => ({ name: site.name, position: document.positionAt(start + site.offset) })),
    async itemAt({ path, uri, position }) {
      const calleeDocument = path === request.path ? document : await vscode.workspace.openTextDocument(uri);
      const callee = await findFunctionWithEditorTools(calleeDocument, position);
      // The definition must be the function's own name, not a value or type inside some function.
      if (!callee || !callee.selection.contains(position)) return undefined;
      return {
        kind: "function",
        name: callee.name,
        qualifiedName: callee.qualifiedName,
        line: callee.range.start.line,
        source: callee.source,
        signature: callee.signature,
        fingerprint: callee.structuralFingerprint,
        signatureFingerprint: formatTolerantFingerprint(callee.signature)
      };
    }
  });
}
