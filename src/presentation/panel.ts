import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ComparisonVisualScope, ExplanationFormat, Flowchart, FunctionExplanation, RepositoryOverview } from "../core/types";
import type { SourceReference } from "../context/related";
import type { FileOverview } from "../context/fileOverview";
import type { CachedUsage } from "../cache/usage";
import { lineForOffset, monotonicAnchors, offsetForLine } from "./scrollSync";
import { structureLayout } from "./structureLayout";
import { pseudocodeTokens } from "./pseudocode";

export type ExplanationStatus = "loading" | "current" | "outdated" | "cancelled" | "failed";

/** The AI explanation section of one function in the preview. */
export interface ExplanationView {
  readonly entryId: string;
  readonly functionName: string;
  readonly status: ExplanationStatus;
  readonly detail: string;
  readonly error?: string;
  readonly usage?: string;
  readonly explanation?: FunctionExplanation;
  readonly references: readonly SourceReference[];
  readonly limitations: readonly string[];
  /** Whether each step, pseudocode line, and flowchart node maps to source lines and can be highlighted or clicked. */
  readonly linked?: LinkedItems;
  /** Zero-based document line where each linked item starts, or -1; used as scroll anchors. */
  readonly itemLines?: {
    readonly steps: readonly number[];
    readonly pseudocode: readonly number[];
    readonly nodes: readonly number[];
  };
  /** Indentation and blank lines for pseudocode, taken from the code it describes. */
  readonly pseudocodeLayout?: ReadonlyArray<{ readonly level: number; readonly gap: boolean }>;
  /** An extra view being generated for this explanation. */
  readonly loadingFormat?: ExplanationFormat;
  readonly formatError?: string;
}

export interface LinkedItems {
  readonly steps: readonly boolean[];
  readonly pseudocode: readonly boolean[];
  readonly nodes: readonly boolean[];
}

export type LinkedKind = "step" | "pseudocode" | "node";

/** Which views of "What happens" are shown as tabs, and which one opens first. */
export interface FormatSettings {
  readonly pseudocode: boolean;
  readonly flowchart: boolean;
  readonly initial: "steps" | ExplanationFormat;
}

export interface PanelNotice {
  readonly tone: "info" | "progress" | "error";
  readonly text: string;
}

/** One step of the breadcrumb trail above a preview; `target` is a navigation id when it can be opened. */
export interface Crumb {
  readonly name: string;
  readonly target?: string;
  readonly level: FolderView["level"] | "file";
  readonly summary?: string;
}

/** A file or subfolder listed in a folder preview. */
export interface FolderChildView {
  readonly kind: "folder" | "file";
  readonly name: string;
  readonly path: string;
  /** Navigation id that opens it. */
  readonly target: string;
  readonly languageId?: string;
  readonly fileCount?: number;
  readonly countCapped?: boolean;
  /** Saved one-sentence AI summary; `current` is false when the file changed since. */
  readonly summary?: { readonly text: string; readonly current: boolean };
  /** For a part without a summary of its own: the folder summary's sentence about it, inferred from names. */
  readonly partSummary?: string;
}

/** A box on a folder's project map; `target` opens its folder when it is in the repository. */
export interface MapNodeView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly place: "inside" | "outside" | "external";
  readonly group?: string;
  readonly target?: string;
}

/** A folder preview: its children and the import structure between them. Local only. */
export interface FolderView {
  readonly name: string;
  /** Repository-relative path, or "" for the repository root. */
  readonly path: string;
  /**
   * How far the page zooms, from the project map: the project, a group of
   * components, a component, a module, a support folder, or a plain folder.
   */
  readonly level: "project" | "group" | "component" | "module" | "support" | "folder";
  /** What the project map says about this folder, or at the root about the project. */
  readonly about?: { readonly summary: string; readonly detail?: string; readonly offers?: string; readonly uses?: string };
  /** The folder's map, one zoom level down. */
  readonly map?: {
    readonly nodes: readonly MapNodeView[];
    readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string }>;
  };
  /** The parts listed on a project or group page. */
  readonly members?: ReadonlyArray<{ readonly name: string; readonly summary: string; readonly level: string; readonly target?: string }>;
  /** Whether a project map is saved: current for the overview model and settings, made with other ones, or missing. */
  readonly mapState: "current" | "other" | "missing";
  /** While the project is being mapped: what to say next to the placeholder. */
  readonly mapping?: string;
  readonly fileCount: number;
  readonly children: readonly FolderChildView[];
  readonly structure?: {
    readonly nodes: ReadonlyArray<{ readonly id: string; readonly kind: "folder" | "file"; readonly name: string }>;
    readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly weight: number }>;
  };
  readonly limitations: readonly string[];
  /** The folder's saved AI summary; `current` is false when its contents changed since. */
  readonly ai?: { readonly summary: string; readonly overview: string; readonly offers?: string; readonly uses?: string; readonly current: boolean };
  /** Whether a summary is being generated. */
  readonly summarizing: boolean;
  /** Whether a summary can be requested now (its input is ready). */
  readonly canSummarize: boolean;
  readonly summaryError?: string;
  /** Saved main flows; each node's link opens the code its step points to. */
  readonly flows?: {
    readonly current: boolean;
    readonly items: ReadonlyArray<{
      readonly title: string;
      readonly summary: string;
      readonly chart: Flowchart;
      readonly links: ReadonlyArray<{ readonly target: string; readonly caption: string } | null>;
    }>;
  };
  readonly describingFlows: boolean;
  readonly canDescribeFlows: boolean;
  readonly flowsError?: string;
  /** Whether the folder and all its subfolders can be summarized in one run. */
  readonly canSummarizeTree: boolean;
  /** Progress of a run over the folder tree that covers this folder. */
  readonly tree?: { readonly name: string; readonly done: number; readonly total: number; readonly running: readonly string[] };
}

/** A link from a change to lines in one side of the diff; `referenceId` is host-owned and checked against that side's snapshot. */
export interface ChangeLinkView {
  readonly referenceId: string;
  readonly caption: string;
}

/** A function only one version has: what it does (or did), with its full explanation on request. */
export interface ChangeFunctionCardView {
  /**
   * Host-issued id: the card's element id, and the `entryId` of its expand,
   * regenerate, cancelEntry, addFormat, and revealItem messages.
   */
  readonly id: string;
  readonly name: string;
  /** For example "Function" or "Method". */
  readonly kindLabel: string;
  /** The comparison's short summary of what it does (added) or did (removed). */
  readonly summary: string;
  /** Its lines in its own side of the diff; left out while the comparison is outdated. */
  readonly link?: ChangeLinkView;
  /** Whether Explain may be offered; when false, `note` says why. */
  readonly canExplain: boolean;
  readonly note?: string;
  /** The normal function explanation, once saved or requested; absent until then. */
  readonly explanation?: ExplanationView;
}

/** What a diff's saved explanation says; all text, rendered as text. */
export interface ChangeResultView {
  readonly summary: string;
  /** Functions only the modified version has. */
  readonly added?: readonly ChangeFunctionCardView[];
  /** Functions only the original version has. */
  readonly removed?: readonly ChangeFunctionCardView[];
  /** Behavioral changes to functions both versions have. */
  readonly changes: ReadonlyArray<{
    readonly visualScopeId?: string;
    /** The changed function's name, when the change belongs to one. */
    readonly functionName?: string;
    readonly title: string;
    readonly before: string;
    readonly after: string;
    readonly when: string;
    readonly flow: string;
    readonly links: readonly ChangeLinkView[];
  }>;
  /** Exact paired visuals with host-validated, side-specific navigation ids keyed by occurrence id. */
  readonly visualScopes?: ReadonlyArray<{
    readonly scope: ComparisonVisualScope;
    readonly originalLinks: Readonly<Record<string, string>>;
    readonly modifiedLinks: Readonly<Record<string, string>>;
  }>;
  /** Changes outside any function ("Other changes"). */
  readonly outside: string;
  readonly possibleEffects: readonly string[];
  readonly limitations: readonly string[];
  readonly model: string;
  readonly usage?: string;
  /** Set when either version changed since it was explained; its line links are then left out. */
  readonly outdated?: boolean;
}

/** A native diff shown in place of a file: its two versions and, when saved or requested, what the change does. */
export interface ChangeView {
  /** Identifies the pair, so the panel keeps its place only while the same pair is shown. */
  readonly key: string;
  readonly fileName: string;
  readonly facts: string;
  readonly originalLabel: string;
  readonly modifiedLabel: string;
  /** `ready`: nothing saved yet; `unavailable`: the pair cannot be explained, and `message` says why. */
  readonly status: "ready" | "loading" | "current" | "outdated" | "failed" | "unavailable";
  readonly detail?: string;
  readonly message?: string;
  readonly canExplain: boolean;
  readonly result?: ChangeResultView;
}

export interface PanelState {
  readonly provider: string;
  readonly models: { readonly explanation: string; readonly overview?: string };
  readonly stats?: {
    readonly usage?: CachedUsage;
    readonly explanations: number;
    readonly fileSummaries: number;
    readonly folderSummaries: number;
    readonly flows: number;
    readonly mapSavedAt?: number;
    readonly outdatedHere: number;
    readonly scope: "file" | "folder";
  };
  readonly statsError?: string;
  readonly document?: FileOverview;
  /** Shown instead of a file when a folder is previewed. */
  readonly folder?: FolderView;
  /** Shown instead of a file or folder when the active editor is a native diff. */
  readonly change?: ChangeView;
  readonly breadcrumbs?: readonly Crumb[];
  readonly explanations: readonly ExplanationView[];
  readonly overview?: RepositoryOverview;
  /** AI summary of the shown file; `current` is false when the file changed since. */
  readonly summary?: { readonly text: string; readonly current: boolean };
  /** Whether the "More detail" part of explanations starts open. */
  readonly showDetails: boolean;
  readonly formats: FormatSettings;
  readonly notice?: PanelNotice;
  readonly prefetchConsent?: { readonly models: readonly string[]; readonly approving: boolean };
  /** Commit preparation only; the existing Git graph remains the navigator. */
  readonly review?: { readonly text: string; readonly canStop: boolean };
  /** A folder being opened; its placeholder is shown until it is listed. */
  readonly loading?: { readonly name: string };
  readonly busy: boolean;
  readonly hasRepository: boolean;
  readonly needsInitialization?: boolean;
}

export type PanelAction =
  | { readonly type: "showCallers"; readonly entryId: string }
  | { readonly type: "expand"; readonly entryId: string }
  | { readonly type: "approveSharing" }
  | { readonly type: "regenerate"; readonly entryId: string }
  | { readonly type: "cancelEntry"; readonly entryId: string }
  | { readonly type: "cancel" }
  | { readonly type: "stopReview" }
  | { readonly type: "explainChanges" }
  | { readonly type: "summarizeFolder" }
  | { readonly type: "summarizeTree" }
  | { readonly type: "describeFlows" }
  | { readonly type: "refreshContext" }
  | { readonly type: "clearCache" }
  | { readonly type: "chooseModel" }
  | { readonly type: "chooseOverviewModel" }
  | { readonly type: "regenerateOutdated" }
  | { readonly type: "navigate"; readonly referenceId: string }
  | { readonly type: "revealLine"; readonly line: number }
  | { readonly type: "revealItem"; readonly entryId: string; readonly kind: LinkedKind; readonly index: number }
  | { readonly type: "addFormat"; readonly entryId: string; readonly format: ExplanationFormat };

export const panelHtml = (nonce: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { --separator: var(--vscode-textSeparator-foreground, rgba(128, 128, 128, .35)); --item-highlight: var(--vscode-editor-selectionHighlightBackground, rgba(128, 128, 128, .22)); }
    html, body { margin: 0; }
    body {
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif;
      font-size: 14px;
      line-height: 1.6;
      word-wrap: break-word;
      padding: 0 26px 90vh;
    }
    main { max-width: 860px; }
    h1, h2, h3, h4, h5 { font-weight: 600; line-height: 1.25; margin: 24px 0 12px; }
    h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid var(--separator); margin-top: 16px; }
    h2 { font-size: 1.45em; padding-bottom: .25em; border-bottom: 1px solid var(--separator); }
    h3 { font-size: 1.2em; }
    h4 { font-size: 1.05em; }
    h5 { font-size: .95em; margin: 16px 0 6px; }
    p, ul, ol, blockquote { margin: 0 0 12px; }
    ul, ol { padding-left: 1.6em; }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .9em;
      background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, .15));
      padding: 1px 4px;
      border-radius: 3px;
    }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    a:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    blockquote {
      border-left: 4px solid var(--vscode-textBlockQuote-border, var(--separator));
      background: var(--vscode-textBlockQuote-background, transparent);
      padding: 4px 14px;
      white-space: pre-line;
    }
    .muted { color: var(--vscode-descriptionForeground); }
    .small { font-size: .85em; }
    [hidden] { display: none !important; }
    .header { position: relative; container-type: inline-size; padding: 8px 0; margin-bottom: 10px; border-bottom: 1px solid var(--separator); }
    .header.working { border-bottom-color: var(--vscode-progressBar-background, #3794ff); }
    .header.stale { border-bottom-color: var(--vscode-editorWarning-foreground, #c9a000); }
    .page-heading { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--separator); margin: 16px 0 12px; }
    .page-heading h1 { flex: 1; border: 0; margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .page-actions { display: flex; align-items: center; gap: 8px; }
    .page-actions button { display: inline-flex; align-items: center; gap: 5px; font: inherit; color: inherit; background: transparent; border: 0; padding: 5px; cursor: pointer; }
    .page-actions button:disabled { opacity: .5; cursor: default; }
    .page-actions button:not(:disabled):is(:hover, :focus-visible, :active) { background: var(--vscode-toolbar-hoverBackground); }
    .page-actions svg { width: 16px; height: 16px; }
    .header.working::after { content: ""; position: absolute; bottom: -1px; left: 0; width: 100%; height: 1px; background: linear-gradient(90deg, transparent, var(--vscode-editor-background), transparent); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; pointer-events: none; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; }
    .toolbar .spacer { flex: 1; }
    .header button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; font: inherit; color: inherit; background: transparent; border: 0; border-radius: 4px; padding: 3px 6px; cursor: pointer; min-height: 28px; box-sizing: border-box; }
    .header button:not(:disabled):is(:hover, :focus-visible, :active) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.14)); }
    .header button:disabled { opacity: .5; cursor: default; }
    .header .danger:not(:disabled):is(:hover, :focus-visible, :active) { color: var(--vscode-errorForeground, #c33); }
    .model-selectors { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
    .model-options { display: flex; flex-wrap: wrap; gap: 0 6px; min-width: 0; }
    .header .model-button { min-width: 0; max-width: 100%; text-align: left; }
    .model-copy { display: flex; flex-wrap: wrap; gap: 0 5px; min-width: 0; line-height: 1.5; }
    .model-role { color: var(--vscode-descriptionForeground); }
    .model-name { font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
    #modelsIcon { display: inline-flex; flex: none; color: var(--vscode-descriptionForeground); }
    .icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; vertical-align: middle; }
    .stats { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .stats .outdated { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .stats button { font-size: 11px; padding: 2px 6px; min-height: 24px; }
    @container (max-width: 600px) { .toolbar .spacer { display: none; } }
    @container (max-width: 420px) { .toolbar .btn-label { display: none; } .toolbar .tool-button { width: 28px; padding: 6px; } .model-options { flex-direction: column; } }
    .change-item { margin: 0 0 18px; padding-left: 12px; border-left: 2px solid var(--separator); }
    .change-item h3 { margin: 0 0 6px; }
    .change-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 4px 16px; margin: 6px 0; }
    .change-sides h5, .change-item h5 { margin: 6px 0 2px; font-size: .8em; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
    .change-sides p, .change-item p { margin: 0 0 4px; }
    .change-links { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: .85em; margin-bottom: 4px; }
    .comparison-visual { margin-top: 12px; overflow-wrap: anywhere; }
    .comparison-visual > .tabs { margin: 8px 0; }
    .comparison-sides { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
    .comparison-side { min-width: 0; }
    .comparison-side h4 { margin: 8px 0; }
    @media (max-width: 600px) { .comparison-sides { grid-template-columns: minmax(0, 1fr); } }
    .notice { margin: 8px 0 0; font-size: .9em; white-space: pre-line; }
    .notice.error, .error { color: var(--vscode-errorForeground); }
    .entry { position: relative; margin: 0; padding: 0 0 2px 12px; border-left: 2px solid transparent; }
    .entry.current { border-left-color: var(--vscode-textLink-foreground); }
    .entry.depth-1 { margin-left: 18px; }
    .entry.depth-2 { margin-left: 36px; }
    .entry.depth-3, .entry.depth-4 { margin-left: 54px; }
    .entry > h2, .entry > h3, .entry > h4 { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    /* Headings stay in view while their section is read, and are pushed away by the next one. */
    .entry > h2, .entry > h3, .entry > h4 {
      position: sticky; top: 0; z-index: 5;
      padding: 8px 0 6px; margin-bottom: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background, #fff) 88%, transparent);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      transition: box-shadow .15s ease, border-color .15s ease;
    }
    /* One line, so the sticky heading stays small: the title shortens, the name stays whole. */
    .entry > h2:has(.ai-title), .entry > h3:has(.ai-title), .entry > h4:has(.ai-title) { flex-wrap: nowrap; }
    .ai-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry > h2 > .heading-name, .entry > h3 > .heading-name, .entry > h4 > .heading-name { flex-shrink: 0; }
    .entry > .stuck {
      border-bottom-color: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 55%, transparent);
      box-shadow: 0 8px 12px -10px rgba(0, 0, 0, .45);
    }
    @media (prefers-reduced-motion: reduce) { .entry > h2, .entry > h3, .entry > h4 { transition: none; } }
    .entry.depth-0 > h2 { margin-top: 28px; }
    .kind { font-size: .7em; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
    .heading-name code { font-size: .92em; background: none; padding: 0; }
    .line-item { margin: 6px 0; }
    .preview-table { width: 100%; border-collapse: collapse; margin: 10px 0 18px; font-size: .9em; table-layout: fixed; }
    .preview-table th, .preview-table td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--separator); overflow-wrap: anywhere; }
    .preview-table th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .preview-table code { white-space: pre-wrap; }
    .comment { font-style: italic; white-space: pre-line; color: var(--vscode-descriptionForeground); }
    .notes { list-style: none; padding: 0; margin: -6px 0 12px; font-size: .9em; color: var(--vscode-descriptionForeground); }

    .ai-section { margin: 0 0 14px; }
    .explain { flex: none; font: inherit; font-size: 12px; color: var(--vscode-textLink-foreground); background: none; border: 1px solid var(--separator); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
    .callers { flex: none; display: inline-flex; align-items: center; padding: 3px; color: var(--vscode-descriptionForeground); background: transparent; border: 0; border-radius: 3px; cursor: pointer; }
    .callers svg { width: 14px; height: 14px; }
    .callers:is(:hover, :focus-visible) { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .prefetch-consent { max-width: 860px; box-sizing: border-box; margin: 12px 0; padding: 10px 14px; border: 1px solid var(--vscode-textLink-foreground); border-radius: 4px; }
    .prefetch-consent p { margin-bottom: 6px; }
    .prefetch-consent button { font: inherit; cursor: pointer; }
    .ai-body {
      margin: 6px 0 4px; padding: 10px 16px 4px;
      border-left: 2px solid var(--vscode-textLink-foreground);
      background: var(--vscode-editorWidget-background, transparent);
      border-radius: 0 6px 6px 0;
    }
    .ai-body p { white-space: pre-line; }
    .ai-body ul, .ai-body ol { padding-left: 1.4em; }
    .ai-body li { margin: 4px 0; }
    .more { margin: 4px 0 10px; }
    .more > summary { cursor: pointer; font-size: .85em; color: var(--vscode-textLink-foreground); }
    .summary { font-size: 1.1em; margin: 0 0 14px; }
    .ai-title { font-weight: 600; }
    .step { border-radius: 4px; padding: 1px 4px; margin-left: -4px; }
    .step-phase { margin: 10px 0 4px; font-weight: 600; color: var(--vscode-descriptionForeground); }
    .steps > ol { margin-bottom: 8px; }
    .step.linked { cursor: pointer; }
    .step.linked:is(:hover, :focus-visible), .pseudo-line.linked:is(:hover, :focus-visible),
    .step.active, .pseudo-line.active { background: var(--item-highlight); }
    .flow-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin: 16px 0 6px; }
    .flow-head h5 { margin: 0; }
    .tabs { display: flex; flex-wrap: wrap; gap: 2px; font-size: .85em; }
    .tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 2px 8px; font: inherit; color: var(--vscode-descriptionForeground); cursor: pointer; }
    .tab[aria-selected="true"] { color: var(--vscode-editor-foreground); border-bottom-color: var(--vscode-textLink-foreground); }
    .pseudo { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; line-height: 1.55; margin: 4px 0 12px; }
    .pseudo-line { padding: 2px 6px; border-radius: 4px; white-space: pre-wrap; }
    .pseudo-line.gap { margin-top: 1.1em; }
    .pseudo-line.linked { cursor: pointer; }
    .pseudo-code {
      --pseudo-keyword: #c586c0; --pseudo-string: #ce9178; --pseudo-number: #b5cea8; --pseudo-name: #9cdcfe;
      color: var(--vscode-editor-foreground);
    }
    .vscode-light .pseudo-code, .vscode-high-contrast-light .pseudo-code {
      --pseudo-keyword: #af00db; --pseudo-string: #a31515; --pseudo-number: #098658; --pseudo-name: #001080;
    }
    .vscode-high-contrast .pseudo-code, .vscode-high-contrast-light .pseudo-code {
      --pseudo-keyword: var(--vscode-textLink-foreground); --pseudo-string: var(--vscode-editor-foreground);
      --pseudo-number: var(--vscode-editor-foreground); --pseudo-name: var(--vscode-textLink-foreground);
    }
    .pseudo-token-keyword, .pseudo-token-literal { color: var(--pseudo-keyword); font-weight: 600; }
    .pseudo-token-string { color: var(--pseudo-string); }
    .pseudo-token-number { color: var(--pseudo-number); }
    .pseudo-code .pseudo-token-name { color: var(--pseudo-name); font: inherit; background: none; padding: 0; }
    .pseudo-token-operator { font-weight: 600; }
    .crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
    .crumb { display: inline-flex; align-items: center; gap: 4px; padding: 2px 5px; border: 1px solid transparent; border-radius: 4px; max-width: 100%; box-sizing: border-box; min-width: 0; }
    .crumb-name { overflow-wrap: anywhere; min-width: 0; }
    .crumb.rich { font-weight: 600; background: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 9%, transparent); border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 25%, transparent); }
    .crumb[aria-current="page"] { color: var(--vscode-editor-foreground); }
    .crumbs .sep { opacity: .6; }
    .folder-list { list-style: none; padding: 0; margin: 4px 0 16px; }
    .folder-list li { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, var(--separator)); }
    .folder-list .child-name { font-weight: 600; }
    .folder-list .child-meta { margin-left: 8px; }
    .folder-list .child-summary { margin: 2px 0 0; }
    .structure-scroll, .flow-scroll { position: relative; overflow: hidden; width: 100%; box-sizing: border-box; }
    .structure-scroll { margin: 6px 0 16px; }
    .structure { position: relative; display: inline-flex; flex-direction: column; align-items: center; gap: 72px; width: max-content; min-width: 100%; padding: 4px 4px 8px; box-sizing: border-box; }
    .structure.has-loops { padding-left: 48px; }
    .structure-row { display: flex; justify-content: center; gap: 24px; }
    .structure-row.unconnected, .structure-row.shared { flex-wrap: wrap; gap: 14px 16px; }
    .flow-ref { margin-top: 3px; font-size: .78em; color: var(--vscode-textLink-foreground); overflow-wrap: anywhere; }
    .flow-title { margin: 14px 0 2px; font-size: 1em; }
    .structure-waypoint { width: 10px; height: 2px; align-self: center; }
    .structure-row { align-items: center; }
    .structure-caption { font-size: .8em; color: var(--vscode-descriptionForeground); margin-bottom: -58px; }
    .structure-node { cursor: pointer; text-align: center; max-width: 190px; font: inherit; color: inherit; }
    .structure-node .node-name { font-weight: 600; overflow-wrap: anywhere; }
    .structure-node .node-meta { font-size: .78em; color: var(--vscode-descriptionForeground); }
    .structure-node.kind-folder, .structure-node.kind-inside { border-width: 2px; }
    .structure-node.kind-outside { border-style: dashed; }
    .structure-node.kind-external { border-style: dashed; border-radius: 999px; color: var(--vscode-descriptionForeground); }
    div.structure-node { cursor: default; }
    .folder-contents { margin: 18px 0; }
    .skeleton, .skeleton-box {
      --sk: color-mix(in srgb, var(--vscode-editor-foreground, #888) 7%, transparent);
      --sk-hi: color-mix(in srgb, var(--vscode-editor-foreground, #888) 15%, transparent);
      background: linear-gradient(90deg, var(--sk) 25%, var(--sk-hi) 50%, var(--sk) 75%);
      background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite; border-radius: 4px;
    }
    .skeleton { height: .85em; margin: 10px 0; }
    .skeleton.short { width: 55%; }
    .skeleton.heading { height: 1.3em; width: 30%; margin-top: 26px; }
    .skeleton-map { display: flex; flex-direction: column; align-items: center; gap: 30px; margin: 18px 0 24px; }
    .skeleton-row { display: flex; gap: 24px; }
    .skeleton-box { width: 124px; height: 46px; }
    @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) { .skeleton, .skeleton-box { animation: none; } }
    .folder-contents > summary { cursor: pointer; font-weight: 600; }
    .structure-node:hover, .structure-node:focus-visible { border-color: var(--vscode-focusBorder); }
    .flow-scroll { margin: 6px 0 12px; }
    .flow { position: relative; display: inline-grid; width: max-content; grid-auto-columns: max-content; column-gap: 32px; row-gap: 64px; align-items: center; padding: 8px 16px 8px 8px; }
    .flow.has-loops { padding-left: 56px; }
    .flow-node {
      position: relative; z-index: 1; justify-self: center; max-width: 170px; padding: 6px 12px; text-align: center; font-size: .9em; line-height: 1.35;
      border: 1px solid var(--vscode-panel-border, var(--separator)); border-radius: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .flow-node.kind-start, .flow-node.kind-end { border-radius: 999px; }
    .flow-node.kind-end { border-style: dashed; }
    .flow-node.kind-decision {
      display: flex; align-items: center; justify-content: center;
      max-width: none; padding: 0; border: 0; border-radius: 0; background: none;
    }
    .decision-content { position: relative; width: max-content; max-width: 140px; padding: 6px 10px; overflow-wrap: anywhere; }
    .decision-shape { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
    .decision-shape polygon {
      fill: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      stroke: var(--vscode-charts-yellow, #c9a000); stroke-width: 2;
    }
    .decision-shape .decision-highlight { fill: none; stroke: transparent; stroke-width: 10; stroke-linejoin: round; }
    /* What a function returns to be shown on screen, drawn like a small window. */
    .flow-node.kind-show {
      --show: var(--vscode-charts-blue, #3794ff);
      border: 2px solid var(--show); border-top-width: 7px; border-radius: 6px;
      background: color-mix(in srgb, var(--show) 10%, var(--vscode-editorWidget-background, var(--vscode-editor-background, #fff)));
    }
    .flow-node.kind-show::before {
      content: "Shows"; display: block; margin-bottom: 1px;
      font-size: .7em; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--show);
    }
    .flow-node.holds { max-width: none; padding: 4px 8px 8px; }
    .flow-node.holds > .flow-node-label { margin-bottom: 2px; }
    .flow.flow-inner { display: inline-grid; column-gap: 20px; row-gap: 52px; padding: 8px; text-align: center; }
    .flow.flow-inner.has-loops { padding-left: 40px; }
    .flow-node.kind-start, .flow-node.kind-end { color: var(--vscode-descriptionForeground, inherit); }
    .flow-node.linked { cursor: pointer; }
    .flow-node.linked:hover { border-color: var(--vscode-focusBorder); }
    .flow-node.active, .flow-node.linked:is(:hover, :focus-visible) { box-shadow: 0 0 0 5px var(--item-highlight); }
    .flow-node.kind-decision.active, .flow-node.kind-decision.linked:is(:hover, :focus-visible) { box-shadow: none; }
    .flow-node.kind-decision:is(.active, :focus-visible) { outline: none; }
    .flow-node.kind-decision.active > .decision-shape > .decision-highlight,
    .flow-node.kind-decision.linked:is(:hover, :focus-visible) > .decision-shape > .decision-highlight { stroke: var(--item-highlight); }
    .flow-edges { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; z-index: 0; }
    .flow-edge { fill: none; stroke: var(--vscode-descriptionForeground, #888); stroke-width: 1.3; }
    .flow-arrow { fill: var(--vscode-descriptionForeground, #888); }
    .flow-label { font-size: 11px; fill: var(--vscode-descriptionForeground, #888); paint-order: stroke; stroke: var(--vscode-editor-background, #fff); stroke-width: 4px; }
    .ai-body .lead { font-size: 1.05em; }
    .ai-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font-size: .8em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
    .loading { display: flex; align-items: center; gap: 10px; margin: 4px 0 12px; color: var(--vscode-descriptionForeground); }
    .spinner {
      width: 14px; height: 14px; flex: none; border-radius: 50%;
      border: 2px solid var(--separator); border-top-color: var(--vscode-textLink-foreground);
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
    .repo { margin-top: 40px; border-top: 1px solid var(--separator); padding-top: 8px; }
    .repo summary { cursor: pointer; font-weight: 600; }
    .repo p { white-space: pre-line; }
    .activity { padding-top: 8px; font-size: .85em; }
    @media (prefers-reduced-motion: reduce) { .header.working::after { animation: none; } }
  </style>
</head>
<body>
  <header id="header" class="header">
    <nav class="toolbar" aria-label="Downside Up actions">
      <div class="model-selectors" role="group" aria-label="AI models">
        <span id="modelsIcon" aria-hidden="true"></span>
        <div class="model-options">
          <button id="chooseOverviewModel" class="model-button" type="button" aria-label="Choose project overview model"></button>
          <button id="chooseModel" class="model-button" type="button" aria-label="Choose function explanation model"></button>
        </div>
      </div>
      <span class="spacer"></span>
      <button id="cancel" class="tool-button" type="button" title="Cancel requests" aria-label="Cancel requests" hidden><span class="btn-label">Cancel</span></button>
      <button id="initializeProject" class="tool-button" type="button" title="Build repository context and the project map; may send code to the overview model and asks for sharing approval if needed" aria-label="Initialize project" hidden><span class="btn-label">Initialize project</span></button>
      <button id="clearCache" class="tool-button danger" type="button" title="Clear this repository's cache and saved sharing consent" aria-label="Clear repository cache"><span class="btn-label">Clear</span></button>
    </nav>
    <div id="stats" class="stats" aria-label="Local cache statistics" hidden></div>
    <div id="activity" class="activity" hidden><span id="activityStage" role="status"></span><span id="activityTime" class="muted small"></span></div>
    <div id="commitProgress" class="stats" role="status" aria-live="polite" hidden></div>
  </header>
  <p id="notice" class="notice" role="status" aria-live="polite"></p>
  <aside id="prefetchConsent" class="prefetch-consent" aria-label="Background explanation approval" hidden></aside>
  <main id="doc">
    <nav id="crumbs" class="crumbs muted small" aria-label="Location" hidden></nav>
    <div class="page-heading"><h1 id="title">Downside Up</h1><div id="pageActions" class="page-actions"></div></div>
    <p id="facts" class="muted small"></p>
    <p id="summary" class="summary" hidden></p>
    <blockquote id="purpose" hidden></blockquote>
    <div id="entries"></div>
    <p id="empty" class="muted" hidden></p>
    <p id="limitations" class="muted small"></p>
    <details id="repo" class="repo" hidden>
      <summary>Repository context used for explanations</summary>
      <div id="repoBody"></div>
    </details>
  </main>
  <script nonce="${nonce}">
    const offsetForLine = (${offsetForLine.toString()});
    const lineForOffset = (${lineForOffset.toString()});
    const monotonicAnchors = (${monotonicAnchors.toString()});
    const structureLayout = (${structureLayout.toString()});
    const pseudocodeTokens = (${pseudocodeTokens.toString()});
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    let activityStarted;
    let activityTimer;
    function renderActivity(next) {
      const busy = next.busy;
      const stale = Boolean(next.stats?.outdatedHere || (next.folder?.level === "project" && next.folder.mapState === "other"));
      byId("header").className = "header" + (busy ? " working" : stale ? " stale" : "");
      byId("activity").hidden = !busy;
      byId("activityStage").textContent = busy
        ? (next.notice?.tone === "progress" ? next.notice.text : next.folder?.mapping || "Preparing explanations…")
        : "";
      if (!busy) {
        clearInterval(activityTimer);
        activityTimer = undefined;
        activityStarted = undefined;
        byId("activityTime").textContent = "";
        return;
      }
      if (activityStarted !== undefined) return;
      activityStarted = Date.now();
      const tick = () => {
        const seconds = Math.floor((Date.now() - activityStarted) / 1000);
        byId("activityTime").textContent = " · " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " elapsed · Use Cancel to stop";
      };
      tick();
      activityTimer = setInterval(tick, 1000);
    }
    const HEADING_KINDS = new Set(["function", "type", "impl", "module", "macro"]);
    const DETAIL_SECTIONS = [
      ["role", "Where it fits"],
      ["edgeCases", "Edge cases"],
      ["languageNotes", "Language notes"]
    ];
    /** "More detail" open state the reader chose, by entry; otherwise the setting decides. */
    const detailChoices = new Map();
    const comparisonTabChoices = new Map();
    let comparisonVisualId = 0;
    let state;
    let renderedFile = "";
    let renderCount = 0;
    let sourceLine = 0;
    let currentEntry;
    let scrollFrame = 0;
    let revealFrame = 0;
    let ignoreScrollUntil = 0;
    const chartObservers = [];
    let renderedModels = "";
    let renderedStats = "";
    let savedDetailsOpen = false;

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function segments(parent, description) {
      for (const segment of description || []) {
        const content = segment.code ? el("code", "", segment.text) : document.createTextNode(segment.text);
        if (segment.referenceId) {
          const link = action("", () => post({ type: "navigate", referenceId: segment.referenceId }));
          link.append(content);
          parent.append(link);
        } else parent.append(content);
      }
      return parent;
    }
    /** Appends generated text, showing \`backticked\` names as code; everything stays text, never HTML. */
    function inline(parent, text) {
      String(text || "").split("\`").forEach((part, index) => {
        if (!part) return;
        parent.append(index % 2 === 1 ? el("code", "", part) : document.createTextNode(part));
      });
      return parent;
    }
    function highlightPseudocode(parent, text) {
      parent.classList.add("pseudo-code");
      for (const token of pseudocodeTokens(text)) {
        if (!token.kind) parent.append(document.createTextNode(token.text));
        else parent.append(el(token.kind === "name" ? "code" : "span", "pseudo-token-" + token.kind,
          token.kind === "name" ? token.text.slice(1, -1) : token.text));
      }
      return parent;
    }
    function post(message) { vscode.postMessage(message); }
    function action(label, handler, className) {
      const link = el("a", className || "", label);
      link.setAttribute("role", "button");
      link.tabIndex = 0;
      link.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); handler(); });
      link.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handler(); }
      });
      return link;
    }

    function statusLine(view) {
      const meta = el("div", "ai-meta");
      meta.append(el("span", "", [view.detail, view.usage].filter(Boolean).join(" · ")));
      if (view.status === "failed" || view.status === "cancelled") {
        meta.append(action("Try again", () => post({ type: "regenerate", entryId: view.entryId })));
      } else if (view.status === "outdated") {
        meta.append(action("Regenerate", () => post({ type: "regenerate", entryId: view.entryId })));
      }
      return meta;
    }

    /** Tab chosen per explanation; otherwise the setting decides. */
    /** The view picked with a tab; it applies to every explanation, like language tabs in documentation. */
    let chosenTab = (vscode.getState() || {}).tab;
    const SVG = "http://www.w3.org/2000/svg";
    const iconPaths = {
      model: "M8 1 10 6 15 8 10 10 8 15 6 10 1 8 6 6Z",
      chevron: "m4 6 4 4 4-4",
      refresh: "M13 6A5.5 5.5 0 1 0 13.3 10M13 2v4H9",
      callers: "M12 3H8v10h4M8 8H2m3-3L2 8l3 3",
      clear: "M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 6v5M9 6v5",
      cancel: "m4 4 8 8M12 4l-8 8",
      project: "M1.5 3.5h5l2 2h6v8h-13ZM4 8h8M4 11h5",
      group: "M1.5 2h5v4h-5ZM9.5 2h5v4h-5ZM1.5 10h5v4h-5ZM9.5 10h5v4h-5Z",
      component: "m8 1 6 3.5v7L8 15l-6-3.5v-7ZM2 4.5 8 8l6-3.5M8 8v7",
      module: "M2 2h12v12H2ZM2 6h12M6 6v8",
      support: "m8 1 6 3v4c0 3-3 5-6 7-3-2-6-4-6-7V4ZM5 8l2 2 4-4",
      folder: "M1.5 3.5h5l2 2h6v8h-13Z",
      file: "M3 1.5h6l4 4v9H3ZM9 1.5v4h4M5.5 8h5M5.5 11h5"
    };
    function icon(name) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("class", "icon");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", iconPaths[name] || iconPaths.folder);
      svg.append(path);
      return svg;
    }

    function savedAge(timestamp) {
      const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
      if (minutes < 1) return "just now";
      if (minutes < 60) return minutes + "m ago";
      if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
      return Math.floor(minutes / 1440) + "d ago";
    }

    function renderHeader(next) {
      const models = next.models;
      const modelKey = JSON.stringify([next.provider, models]);
      if (modelKey !== renderedModels) {
        renderedModels = modelKey;
        byId("modelsIcon").replaceChildren(icon("model"));
        for (const [id, role, name, purpose] of [
          ["chooseOverviewModel", "Project overview", models.overview || models.explanation, "Project priming and repository context reviews, architecture maps, folder summaries, and main flows."],
          ["chooseModel", "Functions", models.explanation, "Function explanations, added explanation formats, and file summaries."]
        ]) {
          const button = byId(id);
          const model = next.provider === "mock" ? "Mock mode" : name;
          const copy = el("span", "model-copy");
          copy.append(el("span", "model-role", role), el("span", "model-name", model));
          button.replaceChildren(copy, icon("chevron"));
          button.title = role + ": " + model + "\\n" + purpose + "\\nClick to change model";
          button.setAttribute("aria-label", "Choose " + role.toLowerCase() + " model; current: " + model);
        }
      }
      byId("cancel").hidden = !next.busy;
      byId("initializeProject").hidden = !next.hasRepository || !next.needsInitialization;
      byId("initializeProject").disabled = next.busy;
      byId("clearCache").hidden = !next.hasRepository;
      byId("clearCache").disabled = next.busy;
      const statsKey = JSON.stringify([next.stats, next.statsError, next.busy, next.stats?.mapSavedAt === undefined ? "" : savedAge(next.stats.mapSavedAt)]);
      if (statsKey === renderedStats) return;
      renderedStats = statsKey;
      const stats = byId("stats");
      stats.hidden = !next.stats && !next.statsError;
      stats.replaceChildren();
      if (next.statsError) {
        stats.append(el("span", "error", next.statsError));
      } else if (next.stats) {
        const saved = next.stats;
        stats.title = "Local saved records for this repository, across all models. Outdated counts cover only items checked in the shown " + saved.scope + ", not the whole repository.";
        const details = el("details", "saved-details");
        details.open = savedDetailsOpen;
        details.addEventListener("toggle", () => { savedDetailsOpen = details.open; });
        const summary = el("summary", "");
        const usage = saved.usage;
        summary.textContent = usage
          ? "Tokens in current cache: " + (usage.estimated ? "~" : "") + (usage.inputTokens + usage.outputTokens).toLocaleString()
          : "Saved";
        details.append(summary);
        const body = el("div", "");
        body.append(el("p", "small", "Recorded tokens for retained cache records, not lifetime usage or billing. Replaced records and failed or cancelled requests are not included."));
        if (usage) {
          body.append(el("p", "", usage.inputTokens.toLocaleString() + " input / " + usage.outputTokens.toLocaleString() + " output"));
          for (const role of ["Overview", "Functions"]) {
            const groups = usage.models.filter((group) => group.role === role);
            const input = groups.reduce((sum, group) => sum + group.inputTokens, 0);
            const output = groups.reduce((sum, group) => sum + group.outputTokens, 0);
            body.append(el("p", "", role + ": " + input.toLocaleString() + " input / " + output.toLocaleString() + " output"));
            for (const group of groups) {
              body.append(el("p", "small", group.model + " (" + group.provider + "): " + (group.estimated ? "~" : "") + group.inputTokens.toLocaleString() + " input / " + group.outputTokens.toLocaleString() + " output"));
            }
          }
          if (usage.unrecorded) body.append(el("p", "small", usage.unrecorded + " older records have no recorded token usage; totals are incomplete."));
        }
        body.append(el("span", "", "Saved in repository:"));
        for (const [key, one, many] of [["explanations", "explanation", "explanations"], ["fileSummaries", "file summary", "file summaries"], ["folderSummaries", "folder summary", "folder summaries"], ["flows", "flow set", "flow sets"]]) {
          const count = saved[key];
          body.append(el("p", "small", count + " " + (count === 1 ? one : many)));
        }
        const map = el("span", "", saved.mapSavedAt === undefined ? "No project map" : "Map saved " + savedAge(saved.mapSavedAt));
        if (saved.mapSavedAt !== undefined) map.title = "Saved " + new Date(saved.mapSavedAt).toLocaleString() + "; age does not indicate freshness";
        body.append(map);
        details.append(body);
        stats.append(details);
      }
    }

    function renderPageActions(next) {
      const container = byId("pageActions");
      container.replaceChildren();
      if (next.loading || (!next.document && !next.folder)) return;
      const count = next.stats?.outdatedHere || 0;
      const needsMap = next.folder?.level === "project" && next.folder.mapState !== "current";
      if (count) {
        const outdated = el("span", "small outdated", count + " outdated here");
        outdated.title = "Only saved items checked on this page; not a repository-wide freshness scan";
        container.append(outdated);
      }
      const action = (id, label, type, disabled, text) => {
        const button = el("button", "");
        button.type = "button";
        button.id = id;
        button.disabled = next.busy || disabled;
        button.title = label + "; uses provider quota or billing and asks for sharing approval if needed";
        button.setAttribute("aria-label", label);
        button.append(icon("refresh"));
        if (text) button.append(el("span", "small", text));
        button.addEventListener("click", () => post({ type }));
        container.append(button);
      };
      if (needsMap) {
        const label = next.folder.mapState === "missing" ? "Map project" : "Update project map";
        action("pageMap", label, "refreshContext", false, label);
      }
      if (count || !needsMap) {
        action("pageRefresh", "Refresh outdated items on this page", "regenerateOutdated", !count);
      }
    }

    /** Makes an item clickable to select its source lines, and marks it for highlighting. */
    function linkItem(item, view, kind, index, attribute) {
      item.dataset[attribute] = String(index);
      const key = kind === "step" ? "steps" : kind === "pseudocode" ? "pseudocode" : "nodes";
      const linked = view.linked && view.linked[key];
      if (!linked || !linked[index]) return;
      // Items are scroll anchors at their own code lines, so scrolling lands on what describes the code.
      const line = view.itemLines && view.itemLines[key] ? view.itemLines[key][index] : -1;
      if (Number.isInteger(line) && line >= 0) item.dataset.line = String(line);
      item.classList.add("linked");
      item.tabIndex = 0;
      item.title = "Select these lines in the editor";
      const reveal = (target) => {
        if (target && target.closest && target.closest("a")) return;
        // A flowchart node inside another handles its own clicks.
        if (target && target.closest && target.closest("[data-" + attribute + "]") !== item) return;
        cancelAnimationFrame(scrollFrame);
        cancelAnimationFrame(revealFrame);
        cancelAnimationFrame(revealActiveFrame);
        post({ type: "revealItem", entryId: view.entryId, kind, index });
      };
      item.addEventListener("click", (clicked) => reveal(clicked.target));
      if (attribute === "node") {
        // Focusing a clicked node would scroll a tall node into view, moving the preview the reader is using.
        item.addEventListener("mousedown", (pressed) => {
          if (pressed.button !== 0 || (pressed.target && pressed.target.closest && pressed.target.closest("[data-node]") !== item)) return;
          pressed.preventDefault();
          item.focus({ preventScroll: true });
        });
      }
      item.addEventListener("keydown", (pressed) => {
        const name = pressed["key"];
        if (pressed.target !== item) return;
        if (name === "Enter" || name === " ") { pressed.preventDefault(); reveal(undefined); }
      });
    }

    /** Numbered steps; when parts run at different times, consecutive steps are grouped under when they run. */
    function renderSteps(explanation, view) {
      const container = el("div", "steps");
      let list;
      let phase;
      explanation.steps.forEach((step, index) => {
        const stepPhase = typeof step.phase === "string" ? step.phase : "";
        if (!list || stepPhase !== phase) {
          phase = stepPhase;
          if (stepPhase) container.append(el("p", "step-phase", stepPhase));
          list = el("ol");
          // Numbering continues across groups, matching the step numbers used for highlighting.
          if (index > 0) list.start = index + 1;
          container.append(list);
        }
        const item = el("li", "step");
        linkItem(item, view, "step", index, "step");
        item.append(el("strong", "", step.title.replace(/[.:]?$/, ".")));
        inline(item, " " + step.detail);
        list.append(item);
      });
      return container;
    }

    function renderPseudocode(lines, view) {
      const block = el("div", "pseudo");
      const layout = view.pseudocodeLayout || [];
      lines.forEach((line, index) => {
        const placed = layout[index];
        const row = el("div", "pseudo-line" + (placed && placed.gap ? " gap" : ""));
        const level = placed ? placed.level : Math.min(4, line.depth);
        // A hanging indent keeps a wrapped line visibly one line.
        row.style.paddingLeft = (26 + level * 24) + "px";
        row.style.textIndent = "-20px";
        linkItem(row, view, "pseudocode", index, "pseudo");
        highlightPseudocode(row, line.text);
        block.append(row);
      });
      return block;
    }

    function fitChart(chart, viewport) {
      chart.style.position = "absolute";
      chart.style.transform = "";
      const scale = Math.min(1, viewport.clientWidth / Math.max(1, chart.offsetWidth));
      chart.style.transformOrigin = "0 0";
      chart.style.transform = "scale(" + scale + ")";
      viewport.style.height = Math.ceil(chart.offsetHeight * scale) + "px";
      return scale;
    }

    function observeChart(viewport, draw) {
      requestAnimationFrame(() => { if (viewport.isConnected) draw(); });
      if (typeof ResizeObserver !== "function") return;
      let width = -1;
      const observer = new ResizeObserver(() => {
        if (viewport.clientWidth === width) return;
        width = viewport.clientWidth;
        requestAnimationFrame(() => { if (viewport.isConnected) draw(); });
      });
      observer.observe(viewport);
      chartObservers.push(observer);
    }

    /** Straight entry and exit segments keep arrowheads aligned with their curves. */
    function downwardPath(points) {
      let d = "M" + points[0].x + "," + points[0].y;
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        const inset = Math.min(12, Math.max(0, (to.y - from.y) / 4));
        const middle = (from.y + to.y) / 2;
        d += " V" + (from.y + inset) + " C" + from.x + "," + middle + " " + to.x + "," + middle + " " + to.x + "," + (to.y - inset) + " V" + to.y;
      }
      return d;
    }

    /** Keep labels beside their own edge, away from boxes and earlier labels. */
    function placeEdgeLabels(items, obstacles) {
      const placed = [];
      const overlaps = (a, b) => a.x < b.x + b.width + 6 && a.x + a.width + 6 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;
      for (const { path, label } of items) {
        let positioned = false;
        for (const fraction of [.25, .4, .55, .7, .85, .15]) {
          const point = path.getPointAtLength(path.getTotalLength() * fraction);
          for (const shift of [0, -16, 16, -32, 32]) {
            label.setAttribute("x", String(point.x + shift));
            label.setAttribute("y", String(point.y - 6));
            const rect = label.getBBox();
            const svg = label.ownerSVGElement;
            if (rect.x < 0 || rect.x + rect.width > Number(svg.getAttribute("width"))) continue;
            if ([...obstacles, ...placed].some((other) => overlaps(rect, other))) continue;
            placed.push(rect);
            positioned = true;
            break;
          }
          if (positioned) break;
        }
        if (!positioned) placed.push(label.getBBox());
      }
    }

    /** Forward ranks are capacity-limited on narrow columns; loops route up the left. */
    function layoutFlow(chart, maxRowItems = Infinity) {
      const order = new Map(chart.nodes.map((node, index) => [node.id, index]));
      const outgoing = new Map(chart.nodes.map((node) => [node.id, []]));
      for (const edge of chart.edges) outgoing.get(edge.from).push(edge);
      const visit = new Map();
      const back = new Set();
      const dfs = (id) => {
        visit.set(id, 1);
        for (const edge of outgoing.get(id)) {
          const seen = visit.get(edge.to);
          if (seen === 1) back.add(edge);
          else if (!seen) dfs(edge.to);
        }
        visit.set(id, 2);
      };
      const start = chart.nodes.find((node) => node.kind === "start") || chart.nodes[0];
      dfs(start.id);
      for (const node of chart.nodes) if (!visit.get(node.id)) dfs(node.id);
      const forward = chart.edges.filter((edge) => !back.has(edge) && edge.from !== edge.to);
      const kinds = new Map(chart.nodes.map((node) => [node.id, node.kind]));
      const sideExit = new Map();
      const isExit = (kind) => kind === "end" || kind === "show";
      for (const node of chart.nodes) {
        if (!isExit(node.kind)) continue;
        const incoming = forward.filter((edge) => edge.to === node.id);
        if (incoming.length !== 1) continue;
        const source = incoming[0].from;
        if (forward.some((edge) => edge.from === source && edge.to !== node.id && !isExit(kinds.get(edge.to)))) sideExit.set(node.id, source);
      }
      const indegree = new Map(chart.nodes.map((node) => [node.id, 0]));
      for (const edge of forward) indegree.set(edge.to, indegree.get(edge.to) + 1);
      const rank = new Map(chart.nodes.map((node) => [node.id, 0]));
      const queue = chart.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
      const occupied = new Map();
      while (queue.length) {
        const id = queue.shift();
        let row = rank.get(id);
        while ((occupied.get(row) || 0) >= maxRowItems) row++;
        rank.set(id, row);
        occupied.set(row, (occupied.get(row) || 0) + 1);
        for (const edge of forward.filter((candidate) => candidate.from === id)) {
          rank.set(edge.to, Math.max(rank.get(edge.to), rank.get(id) + 1));
          indegree.set(edge.to, indegree.get(edge.to) - 1);
          if (indegree.get(edge.to) === 0) queue.push(edge.to);
        }
      }
      if (maxRowItems === Infinity) {
        for (const [exit, source] of sideExit) rank.set(exit, rank.get(source));
      }
      const rows = [];
      for (const node of chart.nodes) {
        const row = rank.get(node.id);
        (rows[row] = rows[row] || []).push(node);
      }
      const ending = (node) => (isExit(node.kind) ? 1 : 0);
      return {
        rows: rows.filter(Boolean).map((row) => row.sort((left, right) => ending(left) - ending(right) || order.get(left.id) - order.get(right.id))),
        back
      };
    }

    /**
     * Draws the flowchart. A show node with nodes inside it (the logic that
     * decides what appears within it) holds its own small flow, laid out and
     * connected like the top level. With links (project flows), a node opens
     * the code its step points to instead of selecting source lines.
     */
    function renderFlowchart(chart, view, links) {
      const scroll = el("div", "flow-scroll");
      // The chart is fitted to this box, so a focus or reveal must never scroll inside it.
      scroll.addEventListener("scroll", () => { scroll.scrollTop = 0; scroll.scrollLeft = 0; });
      const levels = [];
      const decisions = [];
      let rowLimit = Infinity;
      const build = (parentId) => {
        const nodes = chart.nodes.filter((node) => (node.parent || "") === parentId);
        const ids = new Set(nodes.map((node) => node.id));
        const edges = chart.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
        const level = el("div", parentId ? "flow flow-inner" : "flow");
        const { rows, back } = layoutFlow({ nodes, edges }, rowLimit);
        // Room on the left only for flows with loops, which are routed there.
        if (back.size) level.classList.add("has-loops");
        const boxes = new Map();
        // Grid cells keep the main path in the first column, with exits to its right.
        const holds = (node) => node.kind === "show" && chart.nodes.some((other) => other.parent === node.id);
        rows.forEach((row, rowIndex) => {
          // Next to a tall container, boxes line up with its top rather than its middle.
          const tall = row.some(holds);
          row.forEach((node, columnIndex) => {
            const container = holds(node);
            const index = chart.nodes.indexOf(node);
            const box = el("div", "flow-node kind-" + node.kind + (container ? " holds" : ""));
            let content = box;
            if (container) box.append(el("div", "flow-node-label", node.label), build(node.id));
            else if (node.kind === "decision") {
              const shape = document.createElementNS(SVG, "svg");
              shape.setAttribute("class", "decision-shape");
              shape.setAttribute("viewBox", "0 0 100 100");
              shape.setAttribute("preserveAspectRatio", "none");
              shape.setAttribute("aria-hidden", "true");
              shape.setAttribute("focusable", "false");
              const diamond = document.createElementNS(SVG, "polygon");
              diamond.setAttribute("points", "50,0 100,50 50,100 0,50");
              diamond.setAttribute("vector-effect", "non-scaling-stroke");
              const halo = document.createElementNS(SVG, "polygon");
              halo.setAttribute("class", "decision-highlight");
              halo.setAttribute("points", "50,0 100,50 50,100 0,50");
              halo.setAttribute("vector-effect", "non-scaling-stroke");
              shape.append(halo, diamond);
              content = el("div", "decision-content", node.label);
              box.append(shape, content);
              box.setAttribute("aria-label", "Decision: " + node.label + (links && links[index] ? "; " + links[index].caption : ""));
            } else box.textContent = node.label;
            box.style.gridRow = String(rowIndex + 1);
            box.style.gridColumn = String(columnIndex + 1);
            if (tall) box.style.alignSelf = "start";
            if (links) linkFlowNode(box, links[index], content);
            else linkItem(box, view, "node", index, "node");
            boxes.set(node.id, box);
            if (node.kind === "decision") decisions.push({ box, content });
            level.append(box);
          });
        });
        levels.push({ flow: level, boxes, edges, back, index: levels.length });
        return level;
      };
      /** Draws one level's edges in an SVG inside that level; positions are converted back from the chart's scale. */
      const drawLevel = (level, scale) => {
        const { flow: holder, boxes, edges, back } = level;
        for (const old of holder.querySelectorAll(":scope > .flow-edges")) old.remove();
        const base = holder.getBoundingClientRect();
        if (!base.width) return;
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("class", "flow-edges");
        svg.setAttribute("width", String(holder.scrollWidth));
        svg.setAttribute("height", String(holder.scrollHeight));
        const defs = document.createElementNS(SVG, "defs");
        const marker = document.createElementNS(SVG, "marker");
        const markerId = "arrow-" + view.entryId + "-" + level.index;
        marker.setAttribute("id", markerId);
        marker.setAttribute("viewBox", "0 0 8 8");
        marker.setAttribute("refX", "8");
        marker.setAttribute("refY", "4");
        marker.setAttribute("markerWidth", "7");
        marker.setAttribute("markerHeight", "7");
        marker.setAttribute("markerUnits", "userSpaceOnUse");
        marker.setAttribute("orient", "auto-start-reverse");
        const tip = document.createElementNS(SVG, "path");
        tip.setAttribute("d", "M0,0 L8,4 L0,8 z");
        tip.setAttribute("class", "flow-arrow");
        marker.append(tip);
        defs.append(marker);
        svg.append(defs);
        // Screen positions are scaled; the SVG lives inside the scaled chart, so convert back.
        const rect = (id) => {
          const r = boxes.get(id).getBoundingClientRect();
          const left = (r.left - base.left) / scale;
          const top = (r.top - base.top) / scale;
          const right = (r.right - base.left) / scale;
          const bottom = (r.bottom - base.top) / scale;
          return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2 };
        };
        if (!boxes.size) return;
        // Loops go up the left of the main path; exits use the right, so they never cross.
        const left = Math.min(...[...boxes.keys()].map((id) => rect(id).left));
        let lane = 0;
        const labels = [];
        for (const edge of edges) {
          const from = rect(edge.from);
          const to = rect(edge.to);
          const path = document.createElementNS(SVG, "path");
          let d;
          if (!back.has(edge) && Math.abs(to.y - from.y) < 4 && to.left > from.right) {
            d = "M" + from.right + "," + from.y + " H" + to.left;
          } else if (!back.has(edge) && to.top > from.bottom && to.left > from.right) {
            // A branch to the side leaves from the right and bends down into the target.
            const end = to.top - Math.min(12, (to.top - from.bottom) / 4);
            d = "M" + from.right + "," + from.y + " C" + to.x + "," + from.y + " " + to.x + "," + from.y + " " + to.x + "," + end + " V" + to.top;
          } else if (!back.has(edge) && to.top > from.bottom) {
            d = downwardPath([{ x: from.x, y: from.bottom }, { x: to.x, y: to.top }]);
          } else {
            const x = Math.max(4, left - 16 - 10 * lane++);
            d = "M" + from.left + "," + from.y + " H" + x + " V" + to.y + " H" + to.left;
          }
          path.setAttribute("d", d);
          path.setAttribute("class", "flow-edge");
          path.setAttribute("marker-end", "url(#" + markerId + ")");
          svg.append(path);
          if (edge.label) {
            const label = document.createElementNS(SVG, "text");
            label.setAttribute("class", "flow-label");
            label.setAttribute("text-anchor", "middle");
            label.textContent = edge.label;
            svg.append(label);
            labels.push({ path, label });
          }
        }
        holder.prepend(svg);
        placeEdgeLabels(labels, [...boxes.keys()].map((id) => {
          const box = rect(id);
          return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
        }));
      };
      const draw = () => {
        if (!scroll.clientWidth) return;
        let flow;
        rowLimit = Infinity;
        do {
          levels.length = 0;
          decisions.length = 0;
          flow = build("");
          flow.style.position = "absolute";
          scroll.replaceChildren(flow);
          // The central half of a diamond is a safe rectangle for its label and source caption.
          for (const { box, content } of decisions) {
            box.style.width = content.offsetWidth * 2 + "px";
            box.style.height = content.offsetHeight * 2 + "px";
          }
          if (flow.offsetWidth <= scroll.clientWidth || rowLimit === 1) break;
          const widest = Math.max(1, ...levels.flatMap((level) => [...level.boxes.values()].map((box) => Number(box.style.gridColumn))));
          rowLimit = rowLimit === Infinity
            ? Math.max(1, Math.floor(widest * scroll.clientWidth / flow.offsetWidth))
            : rowLimit - 1;
        } while (true);
        flow.setAttribute("role", "group");
        flow.setAttribute("aria-label", "Flowchart");
        const scale = fitChart(flow, scroll);
        for (const level of levels) drawLevel(level, scale);
        // Drawing replaces the nodes after the host may already have highlighted them.
        if (!links && activeSteps.entryId === view.entryId) highlightSteps(activeSteps);
      };
      observeChart(scroll, draw);
      return scroll;
    }

    function missingFormat(view, format) {
      const box = el("div");
      if (view.loadingFormat === format) {
        box.append(explanationSkeleton("Generating the " + format + "…"));
        return box;
      }
      if (view.formatError) box.append(el("p", "error", view.formatError));
      const note = el("p", "muted");
      note.append(document.createTextNode("Not generated for this explanation yet. "));
      if (view.status === "current") {
        note.append(action("Generate", () => post({ type: "addFormat", entryId: view.entryId, format })));
      }
      box.append(note);
      return box;
    }

    /** "What happens" as numbered steps, pseudocode, or a flowchart, chosen with tabs. */
    function renderFlowViews(body, explanation, view) {
      const formats = (state && state.formats) || { pseudocode: false, flowchart: false, initial: "steps" };
      const tabs = [["steps", "Steps"]];
      if (formats.pseudocode || explanation.pseudocode) tabs.push(["pseudocode", "Pseudocode"]);
      if (formats.flowchart || explanation.flowchart) tabs.push(["flowchart", "Flowchart"]);
      const available = tabs.map(([id]) => id);
      const selected = available.includes(chosenTab) ? chosenTab : available.includes(formats.initial) ? formats.initial : "steps";
      if (selected === "steps" && !(explanation.steps && explanation.steps.length) && tabs.length === 1) return;
      const head = el("div", "flow-head");
      head.append(el("h5", "", "What happens"));
      if (tabs.length > 1) {
        const bar = el("div", "tabs");
        bar.setAttribute("role", "tablist");
        for (const [id, label] of tabs) {
          const tab = el("button", "tab", label);
          tab.type = "button";
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(id === selected));
          tab.addEventListener("click", (event) => {
            event.stopPropagation();
            if (id === selected) return;
            chosenTab = id;
            vscode.setState({ ...(vscode.getState() || {}), tab: id });
            // Every explanation switches, which changes heights above this one, so keep the clicked tabs in place.
            const before = bar.getBoundingClientRect().top;
            render(state);
            const keepInPlace = () => {
              const after = document.querySelector("#" + CSS.escape(view.entryId) + "-ai .tabs");
              if (!after) return;
              ignoreScrollUntil = performance.now() + 200;
              window.scrollBy(0, after.getBoundingClientRect().top - before);
              return after;
            };
            keepInPlace()?.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
            // Flowcharts are fitted in the next frame, which changes heights once more.
            requestAnimationFrame(() => requestAnimationFrame(keepInPlace));
          });
          bar.append(tab);
        }
        head.append(bar);
      }
      body.append(head);
      if (selected === "pseudocode") {
        body.append(explanation.pseudocode ? renderPseudocode(explanation.pseudocode, view) : missingFormat(view, "pseudocode"));
      } else if (selected === "flowchart") {
        body.append(explanation.flowchart ? renderFlowchart(explanation.flowchart, view) : missingFormat(view, "flowchart"));
      } else {
        body.append(renderSteps(explanation, view));
      }
    }

    function renderExplanation(body, explanation, view) {
      if (explanation.purpose) body.append(inline(el("p", "lead"), explanation.purpose));
      if (explanation.inputs && explanation.inputs.length) {
        const list = el("ul");
        for (const input of explanation.inputs) {
          const item = el("li");
          item.append(el("strong", "", input.label));
          if (input.name && input.name !== input.label) {
            item.append(document.createTextNode(" ("), el("code", "", input.name), document.createTextNode(")"));
          }
          if (input.description) inline(item, ": " + input.description);
          list.append(item);
        }
        body.append(el("h5", "", "Inputs"), list);
      }
      if (explanation.result) body.append(el("h5", "", "Result"), inline(el("p"), explanation.result));
      renderFlowViews(body, explanation, view);
      for (const note of explanation.notes || []) {
        if (note.heading && note.text) body.append(el("h5", "", note.heading), inline(el("p"), note.text));
      }
    }

    function explanationSkeleton(detail, cancel) {
      const box = el("div", "explanation-loading");
      box.setAttribute("aria-busy", "true");
      const status = el("div", "loading small");
      status.setAttribute("role", "status");
      status.append(el("span", "", detail));
      if (cancel) status.append(action("Cancel", cancel));
      box.append(status);
      const lines = el("div");
      lines.setAttribute("aria-hidden", "true");
      for (const className of ["skeleton", "skeleton", "skeleton", "skeleton short"]) lines.append(el("div", className));
      box.append(lines);
      return box;
    }

    function renderAiBody(view) {
      const body = el("div", "ai-body");
      body.id = view.entryId + "-ai";
      if (view.status === "loading") {
        body.append(explanationSkeleton(view.detail || "Preparing explanation…", () => post({ type: "cancelEntry", entryId: view.entryId })));
      } else if (view.status !== "current" || !view.explanation) {
        body.append(statusLine(view));
      }
      if (view.error) body.append(el("p", "error", view.error));
      const explanation = view.explanation;
      if (explanation) {
        renderExplanation(body, explanation, view);
        const more = el("details", "more");
        const remembered = detailChoices.get(view.entryId);
        more.open = remembered === undefined ? Boolean(state && state.showDetails) : remembered;
        more.addEventListener("toggle", () => detailChoices.set(view.entryId, more.open));
        more.append(el("summary", "", "More detail"));
        for (const [key, title] of DETAIL_SECTIONS) {
          if (explanation[key]) more.append(el("h5", "", title), inline(el("p"), explanation[key]));
        }
        if (view.references.length) {
          const refs = el("p", "muted small");
          refs.append(document.createTextNode("Related code: "));
          view.references.forEach((reference, index) => {
            if (index > 0) refs.append(document.createTextNode(" · "));
            refs.append(action(reference.path + ":" + (reference.line + 1), () =>
              post({ type: "navigate", referenceId: reference.id })
            ));
          });
          more.append(refs);
        }
        if (view.limitations.length) more.append(el("p", "muted small", view.limitations.join("\\n")));
        if (view.status === "current") more.append(statusLine(view));
        body.append(more);
      } else if (view.limitations.length) {
        body.append(el("p", "muted small", view.limitations.join("\\n")));
      }
      return body;
    }

    function renderEntry(entry, views) {
      const section = el("section", "entry depth-" + Math.min(entry.depth, 4) + " kind-" + entry.kind);
      section.id = entry.id;
      section.dataset.line = String(entry.startLine);
      section.addEventListener("dblclick", (event) => {
        if (event.target.closest(".ai-section, a, button")) return;
        post({ type: "navigate", referenceId: entry.id });
      });
      if (entry.kind === "comment") {
        section.append(segments(el("p", "comment line-item"), entry.description));
        return section;
      }
      const view = entry.explainable ? views.get(entry.id) : undefined;
      const aiTitle = view && view.status === "current" && view.explanation ? view.explanation.title : "";
      if (HEADING_KINDS.has(entry.kind)) {
        const heading = el(entry.depth === 0 ? "h2" : entry.depth === 1 ? "h3" : "h4");
        if (aiTitle) {
          const title = el("span", "ai-title", aiTitle + " —");
          title.title = aiTitle;
          heading.append(title);
        }
        else heading.append(el("span", "kind", entry.kindLabel));
        const nameLink = action("", () => post({ type: "navigate", referenceId: entry.id }), "heading-name");
        nameLink.title = "Go to source: " + entry.name;
        nameLink.append(el("code", "", entry.kind === "impl" ? entry.qualifiedName : entry.name));
        heading.append(nameLink);
        if (entry.explainable && entry.showCallers !== false) {
          const callers = el("button", "callers");
          callers.type = "button";
          callers.title = "Show callers — find functions that call this one; no AI request";
          callers.setAttribute("aria-label", "Show callers of " + entry.name);
          callers.append(icon("callers"));
          callers.addEventListener("click", () => post({ type: "showCallers", entryId: entry.id }));
          heading.append(callers);
        }
        if (entry.explainable && !view) {
          const explain = el("button", "explain", "Explain");
          explain.type = "button";
          explain.setAttribute("aria-label", "Explain " + entry.name + " with AI");
          explain.addEventListener("click", () => post({ type: "expand", entryId: entry.id }));
          heading.append(explain);
        }
        section.append(heading);
        if (entry.documentation) section.append(el("blockquote", "", entry.documentation));
        if (entry.description.length) section.append(segments(el("p"), entry.description));
      } else {
        if (entry.documentation) section.append(el("blockquote", "", entry.documentation));
        const line = el("p", "line-item");
        line.title = entry.kindLabel;
        section.append(segments(line, entry.description));
      }
      if (entry.notes.length) {
        const notes = el("ul", "notes");
        for (const note of entry.notes) notes.append(segments(el("li"), note));
        section.append(notes);
      }
      if (entry.previewTable) {
        const table = el("table", "preview-table");
        table.setAttribute("aria-label", entry.kindLabel + " details for " + entry.name);
        const head = el("thead");
        const headings = el("tr");
        for (const label of entry.previewTable.headers) {
          const cell = el("th", "", label);
          cell.setAttribute("scope", "col");
          headings.append(cell);
        }
        head.append(headings);
        table.append(head);
        const body = el("tbody");
        for (const row of entry.previewTable.rows) {
          const line = el("tr");
          for (const cell of row) line.append(segments(el("td"), cell));
          body.append(line);
        }
        table.append(body);
        section.append(table);
      }
      if (view) {
        const ai = el("div", "ai-section");
        ai.setAttribute("aria-label", "AI explanation of " + entry.name);
        ai.append(renderAiBody(view));
        section.append(ai);
      }
      return section;
    }

    function renderOverview(overview) {
      const body = byId("repoBody");
      body.replaceChildren();
      byId("repo").hidden = !overview;
      if (!overview) return;
      for (const [key, title] of [
        ["purpose", "Observed purpose"], ["components", "Components"], ["flows", "Entry points and flows"],
        ["conventions", "Conventions"], ["uncertainties", "Uncertainties and gaps"]
      ]) {
        if (overview[key]) body.append(el("h5", "", title), el("p", "", overview[key]));
      }
    }

    /** The breadcrumb trail; every step but the last opens that folder. */
    function renderCrumbs(crumbs) {
      const nav = byId("crumbs");
      nav.hidden = !(crumbs && crumbs.length);
      nav.replaceChildren();
      (crumbs || []).forEach((crumb, index) => {
        if (index > 0) {
          const separator = el("span", "sep", "›");
          separator.setAttribute("aria-hidden", "true");
          nav.append(separator);
        }
        const current = index === crumbs.length - 1;
        const level = crumb.level;
        const className = "crumb level-" + level + (["project", "group", "component"].includes(level) ? " rich" : "");
        const node = crumb.target && !current
          ? action("", () => post({ type: "navigate", referenceId: crumb.target }), className)
          : el("span", className);
        node.title = level.charAt(0).toUpperCase() + level.slice(1) + (crumb.summary ? " — " + crumb.summary : "");
        if (current) node.setAttribute("aria-current", "page");
        node.append(icon(level), el("span", "crumb-name", crumb.name));
        nav.append(node);
      });
    }

    function plural(count, word) {
      return count + " " + word + (count === 1 ? "" : "s");
    }

    function childMeta(child) {
      if (child.kind === "folder") return child.countCapped ? "at least " + plural(child.fileCount, "file") : plural(child.fileCount || 0, "file");
      return child.languageId || "file";
    }

    /**
     * Draws the import structure between a folder's children: importers above
     * what they import, shared folders in a bottom row, cycles' closing edges
     * up the left. Boxes open their folder or file.
     */
    function renderStructure(structure, children, options) {
      const opts = options || {};
      let layout;
      const byPath = new Map(children.map((child) => [child.path, child]));
      const scroll = el("div", "structure-scroll");
      const chart = el("div", "structure");
      chart.setAttribute("role", "group");
      chart.setAttribute("aria-label", opts.label || "Structure diagram: what imports what");
      scroll.append(chart);
      const boxes = new Map();
      const waypoints = new Map();
      const build = (limit) => {
        layout = structureLayout(structure, limit);
        chart.replaceChildren();
        boxes.clear();
        waypoints.clear();
        chart.classList.toggle("has-loops", Boolean(layout.back.length));
        layout.rows.forEach((row, index) => {
          const kind = layout.rowKinds[index];
          if (kind === "shared") chart.append(el("div", "structure-caption", "Used by most of the others"));
          if (kind === "unconnected") chart.append(el("div", "structure-caption", opts.unconnected || "No imports to or from the others"));
          const line = el("div", "structure-row " + kind);
          if (kind !== "layer") line.style.maxWidth = Math.max(1, scroll.clientWidth - 56) + "px";
          for (const id of row) {
            if (id.startsWith("\\u0001")) {
              // A waypoint keeps a lane free for an edge passing this row.
              const spacer = el("span", "structure-waypoint");
              waypoints.set(id, spacer);
              line.append(spacer);
              continue;
            }
            const child = byPath.get(id);
            if (!child) continue;
            const box = el(child.target ? "button" : "div", "flow-node structure-node kind-" + child.kind);
            if (child.target) box.type = "button";
            box.title = opts.title ? opts.title(child) : (child.kind === "folder" ? "Preview " : "Open ") + child.path;
            box.append(el("div", "node-name", child.name + (child.kind === "folder" ? "/" : "")));
            const own = opts.meta ? opts.meta(child) : childMeta(child);
            const meta = layout.usedBy[id] ? "used by " + layout.usedBy[id] + (own ? " · " + own : "") : own;
            if (meta) box.append(el("div", "node-meta", meta));
            if (child.target) box.addEventListener("click", () => post({ type: "navigate", referenceId: child.target }));
            boxes.set(id, box);
            line.append(box);
          }
          chart.append(line);
        });
      };
      const draw = () => {
        if (!scroll.clientWidth) return;
        chart.style.position = "absolute";
        chart.style.transform = "";
        let limit = Infinity;
        do {
          build(limit);
          if (chart.offsetWidth <= scroll.clientWidth || limit === 1) break;
          const widest = Math.max(1, ...layout.rows.filter((_, index) => layout.rowKinds[index] === "layer").map((row) => row.filter((id) => !id.startsWith("\\u0001")).length));
          limit = limit === Infinity
            ? Math.max(1, Math.floor(widest * scroll.clientWidth / chart.offsetWidth))
            : limit - 1;
        } while (true);
        const hidden = new Set(layout.hidden);
        const back = new Set(layout.back);
        const scale = fitChart(chart, scroll);
        const base = chart.getBoundingClientRect();
        if (!base.width) return;
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("class", "flow-edges");
        svg.setAttribute("width", String(chart.scrollWidth));
        svg.setAttribute("height", String(chart.scrollHeight));
        const defs = document.createElementNS(SVG, "defs");
        const marker = document.createElementNS(SVG, "marker");
        const markerId = "structure-arrow";
        marker.setAttribute("id", markerId);
        marker.setAttribute("viewBox", "0 0 8 8");
        marker.setAttribute("refX", "8");
        marker.setAttribute("refY", "4");
        marker.setAttribute("markerWidth", "7");
        marker.setAttribute("markerHeight", "7");
        marker.setAttribute("markerUnits", "userSpaceOnUse");
        marker.setAttribute("orient", "auto-start-reverse");
        const tip = document.createElementNS(SVG, "path");
        tip.setAttribute("d", "M0,0 L8,4 L0,8 z");
        tip.setAttribute("class", "flow-arrow");
        marker.append(tip);
        defs.append(marker);
        svg.append(defs);
        const rect = (id) => {
          const r = (boxes.get(id) || waypoints.get(id)).getBoundingClientRect();
          const left = (r.left - base.left) / scale;
          const top = (r.top - base.top) / scale;
          const right = (r.right - base.left) / scale;
          const bottom = (r.bottom - base.top) / scale;
          return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2 };
        };
        const leftEdge = boxes.size ? Math.min(...[...boxes.keys()].map((id) => rect(id).left)) : 0;
        const shown = structure.edges.filter((edge) => {
          const key = edge.from + "\\u0000" + edge.to;
          return !hidden.has(key) && boxes.has(edge.from) && boxes.has(edge.to);
        });
        const keyOf = (edge) => edge.from + "\\u0000" + edge.to;
        const downward = shown.filter((edge) => !back.has(keyOf(edge)) && rect(edge.to).top >= rect(edge.from).bottom);
        // The first point after a box and the last before one, to spread arrows along its edges.
        const firstAfter = (edge) => rect((layout.routes[keyOf(edge)] || [])[0] || edge.to).x;
        const lastBefore = (edge) => rect((layout.routes[keyOf(edge)] || []).slice(-1)[0] || edge.from).x;
        const ports = new Map();
        const spread = (edges, sideOf, xOf, end) => {
          const groups = new Map();
          for (const edge of edges) {
            const id = sideOf(edge);
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(edge);
          }
          for (const [id, group] of groups) {
            const box = rect(id);
            const inset = Math.min(18, (box.right - box.left) / 4);
            group.sort((left, right) => xOf(left) - xOf(right));
            group.forEach((edge, index) => {
              const x = group.length === 1 ? box.x : box.left + inset + (box.right - box.left - 2 * inset) * index / (group.length - 1);
              ports.set(keyOf(edge) + end, x);
            });
          }
        };
        spread(downward, (edge) => edge.from, firstAfter, ":out");
        spread(downward, (edge) => edge.to, lastBefore, ":in");
        let lane = 0;
        // Paths are measured once the diagram is in the page.
        const labels = [];
        for (const edge of shown) {
          const key = keyOf(edge);
          const from = rect(edge.from);
          const to = rect(edge.to);
          let d;
          if (!downward.includes(edge)) {
            const x = Math.max(4, leftEdge - 14 - 10 * lane++);
            d = "M" + from.left + "," + from.y + " H" + x + " V" + to.y + " H" + to.left;
          } else {
            const points = [
              { x: ports.get(key + ":out"), y: from.bottom },
              ...(layout.routes[key] || []).map((id) => ({ x: rect(id).x, y: rect(id).y })),
              { x: ports.get(key + ":in"), y: to.top }
            ];
            d = downwardPath(points);
          }
          const path = document.createElementNS(SVG, "path");
          path.setAttribute("d", d);
          path.setAttribute("class", "flow-edge");
          path.style.strokeWidth = String(1.2 + Math.min(2.4, Math.log2(edge.weight)));
          path.setAttribute("marker-end", "url(#" + markerId + ")");
          const title = document.createElementNS(SVG, "title");
          title.textContent = edge.label || plural(edge.weight, "import");
          path.append(title);
          svg.append(path);
          if (opts.labels && edge.label) {
            const label = document.createElementNS(SVG, "text");
            label.setAttribute("class", "flow-label");
            label.setAttribute("text-anchor", "middle");
            label.textContent = edge.label;
            svg.append(label);
            labels.push({ path, label });
          }
        }
        chart.prepend(svg);
        placeEdgeLabels(labels, [...boxes.keys()].map((id) => {
          const box = rect(id);
          return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
        }));
      };
      observeChart(scroll, draw);
      return scroll;
    }

    /** Makes a project flow's node open the code its step points to, and names that place under its label. */
    function linkFlowNode(box, link, content = box) {
      if (!link) return;
      content.append(el("div", "flow-ref", link.caption));
      box.classList.add("linked");
      box.tabIndex = 0;
      box.title = "Open " + link.caption;
      box.dataset.flowLink = "1";
      const open = (target) => {
        if (target && target.closest && target.closest("[data-flow-link]") !== box) return;
        post({ type: "navigate", referenceId: link.target });
      };
      box.addEventListener("click", (clicked) => open(clicked.target));
      box.addEventListener("keydown", (pressed) => {
        const name = pressed["key"];
        if (pressed.target !== box) return;
        if (name === "Enter" || name === " ") { pressed.preventDefault(); open(undefined); }
      });
    }

    /** The folder's main flows, each a flowchart whose steps open their code, or a way to request them. */
    function renderFolderFlows(folder) {
      const box = el("div", "folder-flows");
      if (!folder.flows && !folder.describingFlows && !folder.canDescribeFlows && !folder.flowsError) return box;
      box.append(el("h2", "folder-heading", "Main flows"));
      for (const [index, flow] of ((folder.flows && folder.flows.items) || []).entries()) {
        box.append(el("h3", "flow-title", flow.title));
        if (flow.summary) box.append(el("p", "", flow.summary));
        box.append(renderFlowchart(flow.chart, { entryId: "project-flow-" + index }, flow.links));
      }
      if (folder.describingFlows) {
        const loading = el("div", "loading");
        loading.setAttribute("role", "status");
        loading.append(el("span", "spinner"), el("span", "", "Describing the main flows…"));
        box.append(loading);
      } else if (folder.canDescribeFlows && (!folder.flows || !folder.flows.current)) {
        const note = el("p", "muted small");
        const betweenParts = folder.level === "project" || folder.level === "group" || folder.level === "component";
        if (folder.flows) note.append(document.createTextNode(betweenParts ? "Outdated: the project map changed since. " : "Outdated: the files, summaries, or function names changed since. "));
        note.append(action(folder.flows ? "Regenerate" : "Describe the main flows", () => post({ type: "describeFlows" })));
        note.append(document.createTextNode(betweenParts
          ? " · sends the parts on this map, their one-line summaries, and how they connect; no code. Steps open the folders they pass through."
          : " · sends file paths, saved summaries, function names, and imports; no code. Steps link to the files and functions they name."));
        box.append(note);
      }
      if (folder.flowsError) box.append(el("p", "error", folder.flowsError));
      return box;
    }

    /** The folder's AI summary, or a way to request one; with withTree, also the run over its subfolders. */
    function renderFolderSummary(folder, withTree) {
      const box = el("div", "folder-ai");
      if (folder.ai) {
        const summary = el("p", "summary", folder.ai.summary);
        summary.title = "AI-generated summary of this folder";
        box.append(summary);
        if (folder.ai.overview) box.append(el("p", "", folder.ai.overview));
        if (folder.ai.offers) box.append(labelled("Offers", folder.ai.offers));
        if (folder.ai.uses) box.append(labelled("Uses", folder.ai.uses));
      }
      if (folder.summarizing) {
        const loading = el("div", "loading");
        loading.setAttribute("role", "status");
        loading.append(el("span", "spinner"), el("span", "", "Summarizing this folder…"));
        box.append(loading);
      } else if (folder.canSummarize && (!folder.ai || !folder.ai.current)) {
        const note = el("p", "muted small");
        if (folder.ai) note.append(document.createTextNode("Outdated: the folder's contents changed since. "));
        note.append(action(folder.ai ? "Regenerate" : "Summarize this folder", () => post({ type: "summarizeFolder" })));
        note.append(document.createTextNode(folder.level === "component"
          ? " · sends the names, saved summaries, and function names of its contents, the imports between them, its README, and its API contracts; no other code."
          : " · sends the names, saved summaries, and function names of its contents, the imports between them, and its README; no code."));
        box.append(note);
      }
      if (folder.summaryError) box.append(el("p", "error", folder.summaryError));
      if (withTree) box.append(renderTreeRun(folder));
      return box;
    }

    /** Progress of a run over the folder and its subfolders, or a way to start one. */
    function renderTreeRun(folder) {
      const box = el("div", "folder-tree-run");
      if (folder.tree) {
        const loading = el("div", "loading");
        loading.setAttribute("role", "status");
        const running = folder.tree.running.length ? " · now " + folder.tree.running.join(", ") : "";
        loading.append(el("span", "spinner"), el("span", "", "Summarizing " + folder.tree.name + " and its subfolders: " + folder.tree.done + " of " + folder.tree.total + " requests done" + running + "…"));
        box.append(loading);
      } else if (folder.canSummarizeTree && !folder.summarizing) {
        const note = el("p", "muted small");
        note.append(action("Summarize with all subfolders", () => post({ type: "summarizeTree" })));
        note.append(document.createTextNode(" · summarizes every folder here without a current summary, deepest first, then describes the main flows; shows the number of requests before sending anything."));
        box.append(note);
      }
      return box;
    }

    /** A paragraph that starts with a bold label, such as "Offers: …". */
    function labelled(label, text) {
      const paragraph = el("p", "");
      paragraph.append(el("strong", "", label + ": "), document.createTextNode(text));
      return paragraph;
    }

    /**
     * What the project map says about the folder: at the root, what the
     * project is; elsewhere, the folder's sentence and, with detailed maps,
     * more about a component. For the project, also a way to make or refresh
     * the map.
     */
    /** A shimmering placeholder of a summary and a map, for content still being made or loaded. */
    function renderSkeleton(withMap) {
      const box = el("div", "skeleton-block");
      box.setAttribute("aria-hidden", "true");
      box.append(el("div", "skeleton"), el("div", "skeleton"), el("div", "skeleton short"));
      if (withMap) {
        box.append(el("div", "skeleton heading"));
        const map = el("div", "skeleton-map");
        for (const count of [1, 2, 3]) {
          const row = el("div", "skeleton-row");
          for (let index = 0; index < count; index++) row.append(el("div", "skeleton-box"));
          map.append(row);
        }
        box.append(map);
      }
      return box;
    }

    function renderAbout(folder) {
      const box = el("div", "folder-about");
      if (folder.mapping) {
        const loading = el("div", "loading");
        loading.setAttribute("role", "status");
        loading.append(el("span", "spinner"), el("span", "", folder.mapping + " Some models take several minutes. You can cancel at any time."));
        box.append(loading, renderSkeleton(true));
        return box;
      }
      const about = folder.about;
      // A folder's own AI summary says the same in more words, so the map's sentence steps aside.
      if (about && (folder.level === "project" || !folder.ai)) {
        const summary = el("p", "summary", about.summary);
        summary.title = "From the project map; AI-generated";
        box.append(summary);
        if (about.detail) box.append(el("p", "", about.detail));
        if (about.offers) box.append(labelled("Offers", about.offers));
        if (about.uses) box.append(labelled("Uses", about.uses));
      }
      if (folder.level === "project" && folder.mapState !== "current") {
        const note = el("p", "muted small");
        note.append(document.createTextNode(folder.mapState === "missing"
          ? "No project map yet. Use Map project beside the page title to create one. "
          : "The project map was made with another overview model or setting. "));
        if (folder.mapState !== "missing") note.append(document.createTextNode("Use Update project map beside the page title. "));
        note.append(document.createTextNode(" · sends a bounded inventory of the repository (READMEs, manifests, API contracts, deployment facts with values left out, and some source files) and its folder outline to the overview model."));
        box.append(note);
      }
      return box;
    }

    const LEVEL_WORDS = { group: "group", component: "component", module: "part", support: "support", external: "outside the repository" };

    /** The parts listed on a project or group page, each with its sentence from the map. */
    function renderMembers(folder) {
      const box = el("section", "folder-members");
      box.append(el("h2", "folder-heading", folder.level === "project" ? "Main parts" : "Members"));
      const list = el("ul", "folder-list");
      for (const member of folder.members) {
        const item = el("li");
        item.append(member.target
          ? action(member.name, () => post({ type: "navigate", referenceId: member.target }), "child-name")
          : el("span", "child-name", member.name));
        item.append(el("span", "child-meta muted small", LEVEL_WORDS[member.level] || member.level));
        if (member.summary) item.append(el("p", "child-summary", member.summary));
        list.append(item);
      }
      box.append(list);
      return box;
    }

    /** The folder's map one zoom level down: its parts, what they connect to, and how. */
    function renderMap(folder) {
      const box = el("section", "folder-map");
      box.setAttribute("aria-label", "Project architecture map");
      box.title = "AI-generated from repository context; may miss connections. Arrows point from a part to what it calls, sends to, or depends on.";
      const nodes = folder.map.nodes.map((node) => ({ ...node, path: node.id, kind: node.place }));
      const structure = {
        nodes: nodes.map((node) => ({ id: node.id })),
        edges: folder.map.edges.map((edge) => ({ ...edge, weight: 1 }))
      };
      box.append(renderStructure(structure, nodes, {
        label: "Map: the parts and how they connect",
        unconnected: "No known connections to the others",
        labels: true,
        title: (node) => node.summary || node.name,
        meta: (node) => node.place === "external" ? "outside the repository" : node.place === "outside" ? "elsewhere in the repository" : node.group || ""
      }));
      return box;
    }

    /**
     * A folder preview, zoomed to its level: the project and groups show
     * their parts and map; components their map and offers; modules and
     * plain folders their files and import structure; support folders only a
     * short description and their contents.
     */
    function explainChangesButton(change, label) {
      const button = el("button", "explain", label);
      button.type = "button";
      button.disabled = Boolean(state && state.busy);
      button.title = "Sends both versions of this file to the selected Functions model; uses provider quota or billing and asks for sharing approval if needed";
      button.addEventListener("click", () => post({ type: "explainChanges" }));
      return button;
    }

    function renderComparisonVisual(view, change, outdated, choiceKey) {
      const scope = view.scope;
      const section = el("section", "comparison-visual");
      section.setAttribute("aria-label", scope.title);
      section.append(el("h4", "", scope.title));
      const tabs = el("div", "tabs");
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", scope.title + " comparison views");
      const pane = el("div");
      pane.setAttribute("role", "tabpanel");
      pane.tabIndex = 0;
      const prefix = "comparison-visual-" + comparisonVisualId++;
      pane.id = prefix + "-panel";
      const formats = [["steps", "Steps"]];
      if ((!state || !state.formats || state.formats.pseudocode !== false) && (scope.original.pseudocode.length || scope.modified.pseudocode.length)) formats.push(["pseudocode", "Pseudocode"]);
      if ((!state || !state.formats || state.formats.flowchart !== false) && (scope.original.flowchart.nodes.length || scope.modified.flowchart.nodes.length)) formats.push(["flowchart", "Flowchart"]);
      const buttons = [];
      function sourceReference(side, occurrenceId) {
        const links = side === "original" ? view.originalLinks : view.modifiedLinks;
        return !outdated && links && Object.prototype.hasOwnProperty.call(links, occurrenceId) ? links[occurrenceId] : undefined;
      }
      function drawSide(sideName, format) {
        const side = scope[sideName];
        const column = el("section", "comparison-side");
        const label = sideName === "original" ? change.originalLabel : change.modifiedLabel;
        column.setAttribute("aria-label", label + ": " + formats.find((item) => item[0] === format)[1]);
        column.append(el("h4", "", label));
        if (side.region) column.append(el("p", "muted small", "Region: " + side.region));
        if (side.coverage) column.append(el("p", "muted small", "Coverage: " + side.coverage));
        if (side.presence === "absent") {
          column.append(el("p", "muted", "Not present in this version."));
          return column;
        }
        if (format === "flowchart") {
          if (side.flowchartStatus !== "available" || !side.flowchart.nodes.length) {
            column.append(el("p", "muted", side.flowchartStatus === "not-applicable" ? "Flowchart not applicable." : "Flowchart unavailable."));
          }
          if (side.flowchartReason) column.append(el("p", "muted small", side.flowchartReason));
          if (side.flowchartStatus !== "available" || !side.flowchart.nodes.length) return column;
          const occurrences = new Map(scope.units.filter((unit) => unit.side === sideName).map((unit) => [unit.occurrence.id, unit.occurrence]));
          const chart = {
            nodes: side.flowchart.nodes.map((node) => {
              const occurrence = occurrences.get(node.occurrenceId);
              return { ...node, startLine: occurrence ? occurrence.startLine : 0, endLine: occurrence ? occurrence.endLine : 0 };
            }),
            edges: side.flowchart.edges
          };
          const hostLinks = sideName === "original" ? view.originalLinks : view.modifiedLinks;
          const links = chart.nodes.map((node) => {
            const occurrence = occurrences.get(node.occurrenceId);
            const target = !outdated && occurrence && hostLinks && Object.prototype.hasOwnProperty.call(hostLinks, node.occurrenceId) ? hostLinks[node.occurrenceId] : undefined;
            return target ? { target, caption: label + " lines " + occurrence.startLine + "–" + occurrence.endLine } : null;
          });
          const graph = renderFlowchart(chart, { entryId: prefix + "-" + sideName }, links);
          graph.setAttribute("aria-label", label + " flowchart");
          column.append(graph);
          return column;
        }
        const items = side[format];
        if (!items.length) column.append(el("p", "muted", format === "steps" ? "No steps recorded for this region." : "No pseudocode recorded for this region."));
        const pseudocode = format === "pseudocode";
        const list = el(pseudocode ? "div" : "ol", pseudocode ? "pseudo" : "steps");
        for (const item of items) {
          const row = el(pseudocode ? "div" : "li", pseudocode ? "pseudo-line" : "step");
          if (pseudocode) {
            row.style.paddingLeft = (26 + Math.max(0, Math.min(4, item.depth || 0)) * 24) + "px";
            row.style.textIndent = "-20px";
            highlightPseudocode(row, item.text);
          } else {
            row.append(el("strong", "", item.text.replace(/[.:]?$/, ".")));
            if (item.detail) inline(row, " " + item.detail);
          }
          const referenceId = sourceReference(sideName, item.occurrenceId);
          if (referenceId) {
            row.classList.add("linked");
            row.tabIndex = 0;
            row.title = "Reveal these lines in " + label;
            row.addEventListener("click", () => post({ type: "navigate", referenceId }));
            row.addEventListener("keydown", (event) => {
              if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              post({ type: "navigate", referenceId });
            });
          }
          list.append(row);
        }
        if (items.length) column.append(list);
        return column;
      }
      function select(format) {
        comparisonTabChoices.set(choiceKey, format);
        for (const [name, button] of buttons) {
          button.setAttribute("aria-selected", String(name === format));
          button.tabIndex = name === format ? 0 : -1;
        }
        pane.setAttribute("aria-labelledby", prefix + "-" + format);
        const sides = el("div", "comparison-sides");
        sides.append(drawSide("original", format), drawSide("modified", format));
        pane.replaceChildren(sides);
      }
      for (const [format, label] of formats) {
        const button = el("button", "tab", label);
        button.type = "button";
        button.id = prefix + "-" + format;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", pane.id);
        button.addEventListener("click", () => select(format));
        button.addEventListener("keydown", (event) => {
          const index = formats.findIndex((item) => item[0] === format);
          const next = event.key === "Home" ? 0 : event.key === "End" ? formats.length - 1 : event.key === "ArrowRight" ? (index + 1) % formats.length : event.key === "ArrowLeft" ? (index + formats.length - 1) % formats.length : -1;
          if (next < 0) return;
          event.preventDefault();
          select(formats[next][0]);
          buttons[next][1].focus();
        });
        buttons.push([format, button]);
        tabs.append(button);
      }
      const chosen = comparisonTabChoices.get(choiceKey);
      select(formats.some((item) => item[0] === chosen) ? chosen : "steps");
      section.append(tabs, pane);
      return section;
    }

    function renderChange(change) {
      const parts = [el("p", "muted small", change.originalLabel + " → " + change.modifiedLabel)];
      if (change.status === "loading") {
        parts.push(explanationSkeleton(change.detail || "Explaining the changes…", () => post({ type: "cancel" })));
        return parts;
      }
      if (change.message) parts.push(inline(el("p", change.status === "failed" ? "error" : "muted", ""), change.message));
      const result = change.result;
      if (!result) {
        if (change.canExplain) {
          if (change.status === "ready") parts.push(el("p", "muted", "This change has not been explained yet."));
          parts.push(explainChangesButton(change, change.status === "failed" ? "Try again" : "Explain changes"));
        }
        return parts;
      }
      if (change.status === "outdated") {
        const note = el("p", "muted small", "Outdated: one of the versions changed since this was explained, so its line links are hidden. ");
        if (change.canExplain) note.append(explainChangesButton(change, "Explain again"));
        parts.push(note);
      } else if (change.status === "failed") {
        // The earlier result stays visible below, and the failed attempt can be tried again.
        const note = el("p", "muted small", result.outdated ? "The explanation below is outdated: one of the versions changed since, so its line links are hidden. " : "");
        if (change.canExplain) note.append(explainChangesButton(change, "Try again"));
        if (change.canExplain || result.outdated) parts.push(note);
      }
      const summary = el("p", "summary");
      inline(summary, result.summary);
      summary.title = "AI-generated explanation of this change";
      parts.push(summary);
      const outdated = Boolean(result.outdated || change.status === "outdated");
      const renderFunctionCards = (heading, cards) => {
        if (!cards || !cards.length) return;
        parts.push(el("h2", "folder-heading", heading));
        for (const card of cards) {
          const entry = el("section", "entry depth-0 kind-function");
          entry.id = card.id;
          const title = el("h3");
          title.append(el("span", "kind", card.kindLabel));
          if (card.link && !outdated) {
            const name = action("", () => post({ type: "navigate", referenceId: card.link.referenceId }), "heading-name");
            name.title = "Go to source: " + card.name;
            name.append(el("code", "", card.name));
            title.append(name);
          } else {
            title.append(el("code", "heading-name", card.name));
          }
          entry.append(title, inline(el("p", "line-item"), card.summary));
          if (card.explanation) {
            const explanationOutdated = outdated || card.explanation.status === "outdated";
            const view = {
              ...card.explanation,
              entryId: card.id,
              functionName: card.name,
              references: explanationOutdated ? [] : card.explanation.references,
              linked: explanationOutdated ? undefined : card.explanation.linked
            };
            const ai = el("div", "ai-section");
            ai.setAttribute("aria-label", "AI explanation of " + card.name);
            ai.append(renderAiBody(view));
            entry.append(ai);
          } else if (card.canExplain) {
            const explain = el("button", "explain", "Explain");
            explain.type = "button";
            explain.setAttribute("aria-label", "Explain " + card.name + " with AI");
            explain.addEventListener("click", () => post({ type: "expand", entryId: card.id }));
            entry.append(explain);
          } else if (card.note) {
            entry.append(el("p", "muted small", card.note));
          }
          parts.push(entry);
        }
      };
      renderFunctionCards("Added", result.added);
      if (result.changes.length) parts.push(el("h2", "folder-heading", "Changed"));
      const visualScopes = result.visualScopes || [];
      const usedScopes = new Set();
      for (const [index, item] of result.changes.entries()) {
        const section = el("section", "change-item");
        if (item.functionName && item.functionName !== item.title) section.append(el("p", "muted small", item.functionName));
        section.append(inline(el("h3"), item.title));
        if (item.links.length) {
          const links = el("div", "change-links");
          for (const link of item.links) links.append(action(link.caption, () => post({ type: "navigate", referenceId: link.referenceId })));
          section.append(links);
        }
        const sides = el("div", "change-sides");
        for (const [heading, text] of [["Before", item.before], ["After", item.after]]) {
          if (!text) continue;
          const column = el("div");
          column.append(el("h5", "", heading), inline(el("p"), text));
          sides.append(column);
        }
        if (sides.children.length) section.append(sides);
        if (item.when) section.append(el("h5", "", "When it differs"), inline(el("p"), item.when));
        if (item.flow) section.append(el("h5", "", "Effect on flow"), inline(el("p"), item.flow));
        const visual = visualScopes.find((view) => view.scope.id === item.visualScopeId);
        if (visual && !usedScopes.has(visual.scope.id)) {
          usedScopes.add(visual.scope.id);
          section.append(renderComparisonVisual(visual, change, result.outdated || change.status === "outdated", JSON.stringify([change.key, visual.scope.id, index])));
        }
        parts.push(section);
      }
      for (const visual of visualScopes) {
        if (usedScopes.has(visual.scope.id)) continue;
        const section = el("section", "change-item");
        section.append(renderComparisonVisual(visual, change, result.outdated || change.status === "outdated", JSON.stringify([change.key, visual.scope.id])));
        parts.push(section);
      }
      renderFunctionCards("Removed", result.removed);
      if (result.outside) parts.push(el("h2", "folder-heading", "Other changes"), inline(el("p"), result.outside));
      if (result.possibleEffects.length) {
        parts.push(el("h2", "folder-heading", "Possible consequences"), el("p", "muted small", "Not shown by this code; things worth checking."));
        const list = el("ul");
        for (const effect of result.possibleEffects) list.append(inline(el("li"), effect));
        parts.push(list);
      }
      if (result.limitations.length) parts.push(el("p", "muted small", "Limits: " + result.limitations.join(" ")));
      parts.push(el("p", "muted small", ["Explained with " + result.model, result.usage].filter(Boolean).join(" · ")));
      return parts;
    }

    function renderFolder(folder) {
      const level = folder.level;
      // The project and groups lead with their summary and map; requests for more come last.
      const overviewFirst = level === "project" || level === "group";
      const parts = [renderAbout(folder), renderFolderSummary(folder, !overviewFirst)];
      if (folder.map) parts.push(renderMap(folder));
      if (folder.members && folder.members.length) parts.push(renderMembers(folder));
      if (level !== "support") parts.push(renderFolderFlows(folder));
      if (overviewFirst) parts.push(renderTreeRun(folder));
      const structure = folder.structure;
      // Imports are drawn where the map has nothing to show, such as inside a component's parts.
      const showImports = level !== "support" && !folder.map;
      if (showImports && structure && structure.nodes.length > 1) {
        parts.push(el("h2", "folder-heading", "Structure"));
        if (structure.edges.length) {
          parts.push(el("p", "muted small", "Arrows point from a file or folder to what it imports. Only imports are shown; other connections, such as calls between services, are not."));
          parts.push(renderStructure(structure, folder.children));
        } else {
          parts.push(el("p", "muted", "No imports between these were found."));
        }
      }
      const list = el("ul", "folder-list");
      for (const child of folder.children) {
        const item = el("li");
        item.append(action(child.name + (child.kind === "folder" ? "/" : ""), () => post({ type: "navigate", referenceId: child.target }), "child-name"));
        item.append(el("span", "child-meta muted small", childMeta(child)));
        if (child.summary) {
          const summary = el("p", "child-summary" + (child.summary.current ? "" : " muted"), child.summary.text);
          summary.title = child.summary.current ? "AI-generated summary" : "AI-generated summary; it changed since";
          item.append(summary);
        } else if (child.partSummary) {
          const summary = el("p", "child-summary muted", child.partSummary);
          summary.title = "From the folder's AI summary, inferred from names only";
          item.append(summary);
        }
        list.append(item);
      }
      // The project and groups are read through their parts; their full contents are one click away.
      if ((level === "project" || level === "group") && folder.members && folder.members.length) {
        const contents = el("details", "folder-contents");
        contents.append(el("summary", "", "All files and folders (" + folder.children.length + ")"), list);
        parts.push(contents);
      } else {
        parts.push(el("h2", "folder-heading", "Contents"), list);
      }
      return parts;
    }


    function render(next) {
      const previousScroll = window.scrollY;
      const entries = [...document.querySelectorAll(".entry")];
      const inset = stickyInset();
      const anchor = entries.find((entry) => {
        const top = entry.getBoundingClientRect().top;
        return top >= inset && top < window.innerHeight;
      }) || entries.find((entry) => entry.getBoundingClientRect().bottom > inset);
      const anchorId = anchor?.id;
      const anchorTop = anchor?.getBoundingClientRect().top;
      for (const observer of chartObservers.splice(0)) observer.disconnect();
      const focusedEntry = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".entry") : null;
      const focusedClass = document.activeElement ? document.activeElement.className : "";
      const focusedItem = document.activeElement && document.activeElement.dataset
        ? ["step", "pseudo", "node"].find((name) => document.activeElement.dataset[name] !== undefined)
        : undefined;
      const focusedItemSelector = focusedItem ? "[data-" + focusedItem + '="' + document.activeElement.dataset[focusedItem] + '"]' : "";
      // Flowcharts are drawn a frame after rendering; until then the page must not shrink, or the browser would clamp its scroll.
      const doc = byId("doc");
      const renderToken = ++renderCount;
      doc.style.minHeight = doc.offsetHeight + "px";
      state = next;
      renderActivity(next);
      const loading = next.loading;
      const change = loading ? undefined : next.change;
      const file = loading || change ? undefined : next.document;
      const folder = file || loading || change ? undefined : next.folder;
      renderCrumbs(next.breadcrumbs);
      renderHeader(next);
      renderCommitProgress(next.review);
      renderPageActions(next);
      const notice = byId("notice");
      notice.textContent = next.notice ? next.notice.text : "";
      notice.className = "notice" + (next.notice && next.notice.tone === "error" ? " error" : "");
      const consent = byId("prefetchConsent");
      consent.hidden = !next.prefetchConsent;
      consent.replaceChildren();
      if (next.prefetchConsent) {
        consent.append(el("p", "", "Background explanations are on, but waiting for your approval to share code from this repository with " + next.prefetchConsent.models.join(" and ") + "."));
        const approve = el("button", "", next.prefetchConsent.approving ? "Waiting for approval…" : "Approve sharing");
        approve.type = "button";
        approve.disabled = next.prefetchConsent.approving;
        approve.addEventListener("click", () => post({ type: "approveSharing" }));
        consent.append(approve, el("p", "small muted", "Approval is saved for this repository and model. Background requests use your provider's usage limits or billing. You can also press Explain beside a function to approve its first request."));
      }
      byId("title").textContent = loading ? loading.name : change ? change.fileName : file ? file.fileName : folder ? folder.name : "Downside Up";
      byId("facts").textContent = change ? change.facts : file
        ? [file.path, file.languageId, file.lineCount + " lines"].join(" · ")
        : folder ? [folder.path || "repository root", plural(folder.fileCount, "file")].join(" · ") : loading ? "Opening…" : "";
      const summary = byId("summary");
      const aiSummary = file ? next.summary : undefined;
      summary.hidden = !aiSummary;
      summary.textContent = aiSummary ? aiSummary.text : "";
      if (aiSummary && !aiSummary.current) summary.append(el("span", "muted small", " (outdated; updates when a function in this file is explained)"));
      summary.title = aiSummary ? "AI-generated summary of this file" : "";
      const purpose = byId("purpose");
      const localPurpose = file && file.purpose && !(aiSummary && aiSummary.current) ? file.purpose : "";
      purpose.hidden = !localPurpose;
      purpose.textContent = localPurpose;
      const views = new Map((next.explanations || []).map((view) => [view.entryId, view]));
      byId("entries").replaceChildren(...(change ? renderChange(change) : file ? file.entries.map((entry) => renderEntry(entry, views)) : folder ? renderFolder(folder) : loading ? [renderSkeleton(true)] : []));
      const empty = byId("empty");
      empty.hidden = Boolean(loading || change || (file && file.entries.length) || (folder && folder.children.length));
      empty.textContent = file ? "Nothing to describe in this file." : folder ? "Nothing to describe in this folder." : "Open a source file to see its description here.";
      byId("limitations").textContent = file ? file.limitations.join("\\n") : folder ? folder.limitations.join("\\n") : "";
      renderOverview(next.overview);
      highlight(currentEntry);
      highlightSteps(activeSteps);
      updateStuck();
      if (focusedEntry && focusedEntry.id) {
        const focusedKind = focusedClass.split(" ")[0] || "explain";
        const selector = focusedItemSelector || (focusedKind === "tab" ? '.tab[aria-selected="true"]' : "." + focusedKind);
        const refocus = () => {
          const target = document.querySelector("#" + CSS.escape(focusedEntry.id) + " " + selector);
          if (target) target.focus({ preventScroll: true });
        };
        refocus();
        // A flowchart node exists only once the chart is drawn.
        if (focusedItem === "node") requestAnimationFrame(() => { if (state === next) refocus(); });
      }
      const release = () => { if (renderToken === renderCount) doc.style.minHeight = ""; };
      const fileKey = change ? "change:" + change.key : file ? file.path : folder ? "folder:" + folder.path : loading ? "loading:" + loading.name : "";
      if (fileKey !== renderedFile) {
        release();
        renderedFile = fileKey;
        if (folder || loading || change) window.scrollTo(0, 0);
        else scrollToLine(sourceLine);
      } else {
        // Re-rendering the same file keeps the reader's place.
        ignoreScrollUntil = performance.now() + 100;
        const restore = () => {
          if (state !== next) return;
          const kept = anchorId ? byId(anchorId) : null;
          window.scrollTo(0, kept && anchorTop !== undefined ? window.scrollY + kept.getBoundingClientRect().top - anchorTop : previousScroll);
        };
        // Following entries are temporarily higher until charts are drawn.
        // Keep the absolute offset now; only use the entry anchor after layout.
        window.scrollTo(0, previousScroll);
        // Charts registered their drawing frames during rendering, so they are drawn before this one.
        requestAnimationFrame(() => {
          ignoreScrollUntil = performance.now() + 100;
          release();
          restore();
        });
      }
    }

    /** Height of a stuck function heading, so code lines map to the visible area below it. */
    function stickyInset() {
      const heading = document.querySelector(".entry.depth-0 > h2");
      return heading ? heading.offsetHeight : 0;
    }

    let stuckFrame = 0;
    /** Marks headings that are currently stuck, to show their shadow. */
    function updateStuck() {
      cancelAnimationFrame(stuckFrame);
      stuckFrame = requestAnimationFrame(() => {
        for (const heading of document.querySelectorAll(".entry > h2, .entry > h3, .entry > h4")) {
          const section = heading.parentElement.getBoundingClientRect();
          heading.classList.toggle("stuck", section.top < -1 && section.bottom > heading.offsetHeight);
        }
      });
    }
    window.addEventListener("scroll", updateStuck, { passive: true });

    function anchors() {
      const list = [];
      for (const node of document.querySelectorAll("[data-line]")) {
        list.push({ line: Number(node.dataset.line), top: node.getBoundingClientRect().top + window.scrollY });
      }
      return monotonicAnchors(list.sort((left, right) => left.line - right.line || left.top - right.top));
    }
    function documentEnd() {
      return byId("doc").getBoundingClientRect().bottom + window.scrollY;
    }
    function lineCount() {
      return state && state.document ? state.document.lineCount : 1;
    }
    function scrollToLine(line) {
      sourceLine = line;
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        ignoreScrollUntil = performance.now() + 100;
        window.scrollTo(0, offsetForLine(anchors(), sourceLine, lineCount(), documentEnd()) - stickyInset());
      });
    }
    window.addEventListener("scroll", () => {
      if (performance.now() < ignoreScrollUntil || !state || !state.document) return;
      cancelAnimationFrame(revealFrame);
      revealFrame = requestAnimationFrame(() => {
        sourceLine = lineForOffset(anchors(), window.scrollY + stickyInset(), lineCount(), documentEnd());
        post({ type: "revealLine", line: Math.max(0, Math.floor(sourceLine)) });
      });
    }, { passive: true });
    let activeSteps = { entryId: "", steps: [], pseudocode: [], nodes: [] };
    function highlightSteps(next) {
      activeSteps = next;
      for (const node of document.querySelectorAll(".step.active, .pseudo-line.active, .flow-node.active")) node.classList.remove("active");
      const body = next.entryId ? byId(next.entryId + "-ai") : null;
      if (!body) return;
      const mark = (attribute, indices) => {
        for (const index of indices) body.querySelector("[data-" + attribute + '="' + index + '"]')?.classList.add("active");
      };
      mark("step", next.steps);
      mark("pseudo", next.pseudocode);
      mark("node", next.nodes);
    }
    let revealActiveFrame = 0;
    /**
     * After the cursor moved in the code, brings what it highlights into view:
     * the highlighted item if it is not fully visible, otherwise the entry if
     * none of it is visible. This scroll does not move the editor.
     */
    function revealActive() {
      cancelAnimationFrame(revealActiveFrame);
      revealActiveFrame = requestAnimationFrame(() => {
        const item = document.querySelector(".step.active, .pseudo-line.active, .flow-node.active");
        const target = item || (currentEntry ? byId(currentEntry) : null);
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const inset = stickyInset();
        const visible = item ? rect.top >= inset && rect.bottom <= window.innerHeight : rect.bottom > inset && rect.top < window.innerHeight;
        if (visible) return;
        ignoreScrollUntil = performance.now() + 200;
        const centered = item && rect.height < window.innerHeight - inset;
        // Only the page scrolls; scrollIntoView would also shift a flowchart within its fitted box.
        // A tall item starts below the sticky heading.
        window.scrollBy(0, centered ? rect.top + rect.height / 2 - (inset + window.innerHeight) / 2 : rect.top - (item ? inset : 0));
      });
    }

    function highlight(entryId) {
      currentEntry = entryId;
      for (const node of document.querySelectorAll(".entry.current")) node.classList.remove("current");
      if (entryId) byId(entryId)?.classList.add("current");
    }

    function renderCommitProgress(review) {
      const progress = byId("commitProgress");
      progress.hidden = !review;
      progress.replaceChildren();
      if (!review) return;
      progress.append(el("span", "", review.text));
      if (review.canStop) {
        const stop = el("button", "text-button", "Stop");
        stop.type = "button";
        stop.addEventListener("click", () => post({ type: "stopReview" }));
        stop.title = "Stop preparing new files; requests already sent may finish and be saved";
        progress.append(" · ", stop);
      }
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "state") render(message.state);
      else if (message.type === "review") {
        if (state) state = { ...state, review: message.review };
        renderCommitProgress(message.review);
      }
      else if (message.type === "scroll" && typeof message.line === "number") scrollToLine(message.line);
      else if (message.type === "cursor") highlight(typeof message.entryId === "string" ? message.entryId : undefined);
      else if (message.type === "steps") {
        cancelAnimationFrame(revealActiveFrame);
        const indices = (value) => (Array.isArray(value) ? value.filter((index) => Number.isInteger(index)) : []);
        highlightSteps({
          entryId: typeof message.entryId === "string" ? message.entryId : "",
          steps: indices(message.steps),
          pseudocode: indices(message.pseudocode),
          nodes: indices(message.nodes)
        });
        if (message.reveal === true) revealActive();
      }
    });
    for (const [id, type, glyph] of [["chooseModel", "chooseModel"], ["chooseOverviewModel", "chooseOverviewModel"], ["cancel", "cancel", "cancel"], ["initializeProject", "refreshContext", "refresh"], ["clearCache", "clearCache", "clear"]]) {
      const button = byId(id);
      if (glyph) button.prepend(icon(glyph));
      button.addEventListener("click", () => post({ type }));
    }
    post({ type: "ready" });
  </script>
</body>
</html>`;

function nonce(): string {
  return randomBytes(24).toString("hex");
}

export class ExplanationPanel {
  readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private state: PanelState | undefined;
  private scrollLine: number | undefined;
  private cursorEntry: string | undefined;
  private activeSteps: { entryId: string; steps: number[]; pseudocode: number[]; nodes: number[] } =
    { entryId: "", steps: [], pseudocode: [], nodes: [] };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly referenceHandlers = new Map<string, () => Promise<void>>();
  private readonly fileReferenceHandlers = new Map<string, () => Promise<void>>();

  constructor(
    title: string,
    onAction: (action: PanelAction) => void,
    onClosed?: () => void,
    onVisibilityChanged?: (visible: boolean) => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "theDownsideUp.explanation",
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    this.panel.webview.html = panelHtml(nonce());
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (this.disposed) return;
        if (typeof message !== "object" || message === null || !("type" in message)) return;
        const fields = message as Record<string, unknown>;
        const stringField = (key: string): string | undefined => {
          const value = fields[key];
          return typeof value === "string" && value.length <= 200 ? value : undefined;
        };
        const type = fields.type;
        if (type === "ready") {
          this.replay();
        } else if (type === "cancel" || type === "stopReview" || type === "refreshContext" || type === "clearCache" || type === "chooseModel" || type === "chooseOverviewModel" || type === "regenerateOutdated" || type === "summarizeFolder" || type === "summarizeTree" || type === "describeFlows" || type === "approveSharing" || type === "explainChanges") {
          onAction({ type });
        } else if (type === "expand" || type === "regenerate" || type === "cancelEntry" || type === "showCallers") {
          const entryId = stringField("entryId");
          if (entryId) onAction({ type, entryId });
        } else if (type === "navigate") {
          const referenceId = stringField("referenceId");
          if (referenceId) onAction({ type, referenceId });
        } else if (type === "revealItem") {
          const entryId = stringField("entryId");
          const kind = fields.kind;
          const index = fields.index;
          if (
            entryId && (kind === "step" || kind === "pseudocode" || kind === "node") &&
            typeof index === "number" && Number.isInteger(index) && index >= 0 && index < 50
          ) {
            onAction({ type, entryId, kind, index });
          }
        } else if (type === "addFormat") {
          const entryId = stringField("entryId");
          const format = fields.format;
          if (entryId && (format === "pseudocode" || format === "flowchart")) onAction({ type, entryId, format });
        } else if (type === "revealLine") {
          const line = fields.line;
          if (typeof line === "number" && Number.isInteger(line) && line >= 0) onAction({ type, line });
        }
      }),
      this.panel.onDidDispose(() => {
        this.dispose();
        onClosed?.();
      }),
      this.panel.onDidChangeViewState((event) => {
        if (!this.disposed) onVisibilityChanged?.(event.webviewPanel.visible);
      })
    );
  }

  private replay(): void {
    if (this.state) this.postMessage({ type: "state", state: this.state });
    if (this.cursorEntry) this.postMessage({ type: "cursor", entryId: this.cursorEntry });
    if (this.scrollLine !== undefined) this.postMessage({ type: "scroll", line: this.scrollLine });
    if (this.activeSteps.entryId) this.postMessage({ type: "steps", ...this.activeSteps });
  }

  private postMessage(message: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  update(state: PanelState): void {
    if (this.disposed) return;
    this.state = state;
    this.postMessage({ type: "state", state });
  }

  /** Progress changes must not rebuild charts or disturb the reader's selection. */
  updateReview(review: PanelState["review"]): void {
    if (this.disposed) return;
    if (JSON.stringify(this.state?.review) === JSON.stringify(review)) return;
    if (this.state) this.state = { ...this.state, review };
    this.postMessage({ type: "review", review });
  }

  /** Aligns the preview with the first visible source line. */
  scrollToLine(line: number): void {
    this.scrollLine = line;
    this.postMessage({ type: "scroll", line });
  }

  /** Highlights the outline entry at the editor cursor. */
  highlightEntry(entryId: string | undefined): void {
    if (entryId === this.cursorEntry) return;
    this.cursorEntry = entryId;
    this.postMessage({ type: "cursor", entryId });
  }

  /** Highlights the steps, pseudocode lines, and flowchart nodes that cover the editor's cursor or selection. */
  highlightSteps(
    entryId: string | undefined,
    items: { readonly steps: readonly number[]; readonly pseudocode: readonly number[]; readonly nodes: readonly number[] },
    reveal = false
  ): void {
    const next = entryId
      ? { entryId, steps: [...items.steps], pseudocode: [...items.pseudocode], nodes: [...items.nodes] }
      : { entryId: "", steps: [], pseudocode: [], nodes: [] };
    if (!reveal && JSON.stringify(next) === JSON.stringify(this.activeSteps)) return;
    this.activeSteps = next;
    this.postMessage({ type: "steps", ...next, ...(reveal ? { reveal: true } : {}) });
  }

  setReferenceHandlers(handlers: Map<string, () => Promise<void>>): void {
    if (this.disposed) return;
    this.referenceHandlers.clear();
    for (const [id, navigate] of handlers) this.referenceHandlers.set(id, navigate);
  }

  setFileReferenceHandlers(handlers: Map<string, () => Promise<void>>): void {
    if (this.disposed) return;
    this.fileReferenceHandlers.clear();
    for (const [id, navigate] of handlers) this.fileReferenceHandlers.set(id, navigate);
  }

  async navigate(referenceId: string): Promise<void> {
    const handler = this.referenceHandlers.get(referenceId) ?? this.fileReferenceHandlers.get(referenceId);
    if (handler) await handler();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = undefined;
    this.referenceHandlers.clear();
    this.fileReferenceHandlers.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
