import type { Position, TextDocument } from "vscode";
import type { OutlineEntryDraft } from "../context/outlineModel";
import type { FunctionTarget } from "../core/types";

/**
 * What the extension needs from a language. Each bundled language lives in
 * its own folder under `src/languages/` and exports one `LanguageSupport`
 * that is listed in `registry.ts`. Languages without one use the editor's
 * own tooling (`editor/`): document symbols and go-to-definition.
 */
export interface LanguageSupport {
  /** Display name used in limitations, such as "Rust". */
  readonly name: string;
  /** VS Code language IDs; the first is the one recorded for the language's files. */
  readonly languageIds: readonly string[];
  /** File extensions, lowercase with the dot, such as ".rs". */
  readonly fileExtensions: readonly string[];
  /** Loads parsers from `<extensionPath>/dist`; called before the first use. */
  initialize?(extensionPath: string): Promise<void>;
  /** The innermost function at `position`, or undefined to let editor symbols try. */
  findFunction(document: TextDocument, position: Position): Promise<FunctionTarget | undefined>;
  /** Every function in the file, for the repository's symbol outline; `path` is the file's path. */
  listFunctions?(source: string, path: string): Promise<FunctionSlice[]>;
  /** The local file description shown in the preview; editor symbols are used without it. */
  describeSource?(source: string, path: string): Promise<SourceDescription>;
  /**
   * The file's imports and declarations sent with every function of it.
   * Without it, import-like lines are taken from the text.
   */
  preamble?(source: string, path: string): Promise<string>;
  /** Items the function uses directly, for explanation context, tracking, hovers, and prefetching. */
  findDependencies(request: DependencyRequest): Promise<DependencyResult>;
  /**
   * Background for explaining this kind of function, such as how a React
   * component runs. It must be the language support's own fixed text, never
   * repository text, and depend only on the function's own source so saved
   * explanations stay tied to their tracked inputs.
   */
  explanationGuidance?(request: GuidanceRequest): Promise<string | undefined>;
  /**
   * Repository-relative files or folders a file imports, for structure
   * diagrams. Local and syntactic only; unresolvable imports are left out.
   */
  fileImports?(request: ImportRequest): Promise<string[]>;
}

export interface ImportRequest {
  /** Repository-relative path and current text of the file. */
  readonly path: string;
  readonly text: string;
  /** Whether an eligible repository file exists at a repository-relative path. */
  readonly hasFile: (path: string) => boolean;
  /** Reads a small repository file such as a manifest; undefined when it is missing or excluded. */
  readonly readFile: (path: string) => Promise<string | undefined>;
}

export interface GuidanceRequest {
  /** Path and current text of the function's file. */
  readonly path: string;
  readonly text: string;
  /** Zero-based line where the function starts, and its names. */
  readonly line: number;
  readonly name: string;
  readonly qualifiedName: string;
}

export interface FunctionSlice {
  readonly name: string;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly source: string;
  /** Zero-based lines. */
  readonly startLine: number;
  readonly endLine: number;
  readonly fingerprint: string;
}

export interface SourceDescription {
  readonly purpose?: string;
  readonly drafts: OutlineEntryDraft[];
}

export interface DependencyItem {
  /** Items of kind "function" or "method" count as calls. */
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName: string;
  /** Zero-based line where its declaration starts. */
  readonly line: number;
  readonly source: string;
  readonly signature: string;
  readonly fingerprint: string;
  readonly signatureFingerprint: string;
  /** How the item is described to the model and in tracking; defaults to `<kind> <qualifiedName>`. */
  readonly label?: string;
}

export interface Dependency {
  /** Repository-relative path of the file that defines it. */
  readonly path: string;
  readonly item: DependencyItem;
}

export interface DependencyRequest {
  /** Absolute repository root. */
  readonly root: string;
  /** Repository-relative path and current text of the function's file. */
  readonly path: string;
  readonly text: string;
  /** Zero-based line where the function starts, and its name. */
  readonly line: number;
  readonly name: string;
  /** Files the inventory may read. */
  readonly readablePaths: ReadonlySet<string>;
  /** Eligible files skipped by the inventory's read budget. */
  readonly unreadPaths?: ReadonlySet<string>;
  /** Reads an eligible file, preferring open buffers; undefined when it may not be read. */
  readonly load: (path: string) => Promise<string | undefined>;
  readonly maxDependencies?: number;
  /** Only calls with this name are needed (hovers); a language may still return more. */
  readonly onlyName?: string;
  /** Epoch milliseconds after which slow lookups stop; a language may ignore it. */
  readonly deadline?: number;
}

export interface DependencyResult {
  /** Items sent whole or by signature within the shared request budget. */
  readonly dependencies: readonly Dependency[];
  /** Small items from the function's own file, always sent whole and tracked at depth 1. */
  readonly local?: readonly Dependency[];
  /** The file's imports and declarations, when found while resolving. */
  readonly preamble?: string;
  readonly limitations: readonly string[];
}

export const UNRESOLVED_DEPENDENCIES = "Items this function uses could not be resolved; changes to them are not tracked.";

export const isCallable = (item: Pick<DependencyItem, "kind">): boolean =>
  item.kind === "function" || item.kind === "method";

/**
 * Import-like lines from a file's text. When function ranges are given, `//`
 * comment lines outside any one of them are kept too (as Rust always has).
 */
export function lineScanPreamble(
  text: string,
  ranges: readonly { readonly startLine: number; readonly endLine: number }[] = []
): string {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => {
      if (/^\s*(?:use\b|mod\b|import\b|export\b|const\b|#include\b)/.test(line)) return true;
      return ranges.some((range) => index < range.startLine || index > range.endLine + 1) &&
        /^\s*\/\//.test(line);
    })
    .slice(0, 120)
    .map(({ line }) => line)
    .join("\n");
}
