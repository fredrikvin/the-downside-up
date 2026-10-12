import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ExplanationFormat, FunctionExplanation, RepositoryOverview } from "../core/types";
import type { SourceReference } from "../context/related";
import type { FileOverview } from "../context/fileOverview";
import { lineForOffset, monotonicAnchors, offsetForLine } from "./scrollSync";

export type ExplanationStatus = "loading" | "current" | "outdated" | "cancelled" | "failed";

/** The AI explanation section of one function in the preview. */
export interface ExplanationView {
  readonly entryId: string;
  readonly functionName: string;
  readonly expanded: boolean;
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

export interface PanelState {
  readonly provider: string;
  readonly model: string;
  readonly document?: FileOverview;
  readonly explanations: readonly ExplanationView[];
  readonly overview?: RepositoryOverview;
  /** AI summary of the shown file; `current` is false when the file changed since. */
  readonly summary?: { readonly text: string; readonly current: boolean };
  /** Whether the "More detail" part of explanations starts open. */
  readonly showDetails: boolean;
  readonly formats: FormatSettings;
  readonly notice?: PanelNotice;
  readonly busy: boolean;
  readonly hasRepository: boolean;
}

export type PanelAction =
  | { readonly type: "expand"; readonly entryId: string }
  | { readonly type: "collapse"; readonly entryId: string }
  | { readonly type: "regenerate"; readonly entryId: string }
  | { readonly type: "cancelEntry"; readonly entryId: string }
  | { readonly type: "cancel" }
  | { readonly type: "refreshContext" }
  | { readonly type: "clearCache" }
  | { readonly type: "chooseModel" }
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
    :root { --separator: var(--vscode-textSeparator-foreground, rgba(128, 128, 128, .35)); }
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
    .toolbar { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 10px 0 0; font-size: .85em; color: var(--vscode-descriptionForeground); }
    .toolbar .spacer { flex: 1; }
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
    .comment { font-style: italic; white-space: pre-line; color: var(--vscode-descriptionForeground); }
    .notes { list-style: none; padding: 0; margin: -6px 0 12px; font-size: .9em; color: var(--vscode-descriptionForeground); }

    .ai-section { margin: 0 0 14px; }
    .ai-toggle {
      display: inline-flex; align-items: center; gap: 8px;
      background: none; border: 0; padding: 2px 0; margin: 0;
      font: inherit; font-size: .85em; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: var(--vscode-textLink-foreground); cursor: pointer;
    }
    .ai-toggle:hover .ai-label { text-decoration: underline; }
    .ai-hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--vscode-descriptionForeground); }
    .chevron {
      display: inline-block; width: 6px; height: 6px;
      border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
      transform: rotate(-45deg); transition: transform .12s ease; margin: 0 2px;
    }
    .ai-section.expanded .chevron { transform: rotate(45deg) translate(-2px, -2px); }
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
    .step.linked:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, .12)); }
    .step.active, .pseudo-line.active { background: var(--vscode-editor-selectionHighlightBackground, rgba(128, 128, 128, .22)); }
    .flow-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin: 16px 0 6px; }
    .flow-head h5 { margin: 0; }
    .tabs { display: flex; gap: 2px; font-size: .85em; }
    .tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 2px 8px; font: inherit; color: var(--vscode-descriptionForeground); cursor: pointer; }
    .tab[aria-selected="true"] { color: var(--vscode-editor-foreground); border-bottom-color: var(--vscode-textLink-foreground); }
    .pseudo { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; line-height: 1.55; margin: 4px 0 12px; }
    .pseudo-line { padding: 2px 6px; border-radius: 4px; white-space: pre-wrap; }
    .pseudo-line.gap { margin-top: 1.1em; }
    .pseudo-line.linked { cursor: pointer; }
    .pseudo-line.linked:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, .12)); }
    .flow-scroll { overflow-x: auto; margin: 6px 0 12px; }
    .flow { position: relative; display: inline-grid; grid-auto-columns: max-content; column-gap: 32px; row-gap: 34px; align-items: center; padding: 4px 16px 8px 4px; }
    .flow.has-loops { padding-left: 56px; }
    .flow-node {
      position: relative; z-index: 1; justify-self: center; max-width: 170px; padding: 6px 12px; text-align: center; font-size: .9em; line-height: 1.35;
      border: 1px solid var(--vscode-panel-border, var(--separator)); border-radius: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .flow-node.kind-start, .flow-node.kind-end { border-radius: 999px; }
    .flow-node.kind-end { border-style: dashed; }
    .flow-node.kind-decision { border: 2px solid var(--vscode-charts-yellow, #c9a000); }
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
    .flow.flow-inner { display: inline-grid; column-gap: 20px; row-gap: 24px; padding: 6px 8px 2px 2px; text-align: center; }
    .flow.flow-inner.has-loops { padding-left: 40px; }
    .flow-node.kind-start, .flow-node.kind-end { color: var(--vscode-descriptionForeground, inherit); }
    .flow-node.linked { cursor: pointer; }
    .flow-node.linked:hover { border-color: var(--vscode-focusBorder); }
    .flow-node.active { outline: 2px solid var(--vscode-textLink-foreground, #3794ff); outline-offset: 2px; }
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
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } .chevron { transition: none; } }
    .repo { margin-top: 40px; border-top: 1px solid var(--separator); padding-top: 8px; }
    .repo summary { cursor: pointer; font-weight: 600; }
    .repo p { white-space: pre-line; }
    footer { margin-top: 24px; }
  </style>
</head>
<body>
  <nav class="toolbar" aria-label="Downside Up actions">
    <span id="model"></span>
    <a id="chooseModel" role="button" tabindex="0">Change model</a>
    <span class="spacer"></span>
    <a id="cancel" role="button" tabindex="0" hidden>Cancel</a>
    <a id="refreshContext" role="button" tabindex="0">Refresh repository context</a>
    <a id="clearCache" role="button" tabindex="0">Clear cache</a>
  </nav>
  <p id="notice" class="notice" role="status" aria-live="polite"></p>
  <main id="doc">
    <h1 id="title">Downside Up</h1>
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
    <footer class="muted small">
      <p>Function headings and other items come from the code itself. AI explanations and the file summary are generated by the selected model, only after you consent to sharing code; open a function's AI explanation to create one. Which items are listed is set by "Downside Up › Preview: Include". Double-click any item to jump to its source.</p>
    </footer>
  </main>
  <script nonce="${nonce}">
    const offsetForLine = (${offsetForLine.toString()});
    const lineForOffset = (${lineForOffset.toString()});
    const monotonicAnchors = (${monotonicAnchors.toString()});
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    const HEADING_KINDS = new Set(["function", "type", "impl", "module", "macro"]);
    const DETAIL_SECTIONS = [
      ["role", "Where it fits"],
      ["edgeCases", "Edge cases"],
      ["languageNotes", "Language notes"]
    ];
    /** "More detail" open state the reader chose, by entry; otherwise the setting decides. */
    const detailChoices = new Map();
    let state;
    let renderedFile = "";
    let sourceLine = 0;
    let currentEntry;
    let scrollFrame = 0;
    let revealFrame = 0;
    let ignoreScrollUntil = 0;

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function segments(parent, description) {
      for (const segment of description || []) {
        parent.append(segment.code ? el("code", "", segment.text) : document.createTextNode(segment.text));
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
        post({ type: "revealItem", entryId: view.entryId, kind, index });
      };
      item.addEventListener("click", (clicked) => reveal(clicked.target));
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
        inline(row, line.text);
        block.append(row);
      });
      return block;
    }

    /**
     * Places flowchart nodes in rows: each node's row is its longest distance
     * from the start along forward edges, so the main path runs downward. An
     * early exit (an end or show node reached only from a node that also
     * continues) sits on its source's row, to the right. Edges that loop back
     * are drawn on the left.
     */
    function layoutFlow(chart) {
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
      while (queue.length) {
        const id = queue.shift();
        for (const edge of forward.filter((candidate) => candidate.from === id)) {
          rank.set(edge.to, Math.max(rank.get(edge.to), rank.get(id) + 1));
          indegree.set(edge.to, indegree.get(edge.to) - 1);
          if (indegree.get(edge.to) === 0) queue.push(edge.to);
        }
      }
      for (const [exit, source] of sideExit) rank.set(exit, rank.get(source));
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
     * connected like the top level.
     */
    function renderFlowchart(chart, view) {
      const scroll = el("div", "flow-scroll");
      const levels = [];
      const build = (parentId) => {
        const nodes = chart.nodes.filter((node) => (node.parent || "") === parentId);
        const ids = new Set(nodes.map((node) => node.id));
        const edges = chart.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
        const level = el("div", parentId ? "flow flow-inner" : "flow");
        const { rows, back } = layoutFlow({ nodes, edges });
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
            const box = el("div", "flow-node kind-" + node.kind + (container ? " holds" : ""));
            if (container) box.append(el("div", "flow-node-label", node.label), build(node.id));
            else box.textContent = node.label;
            box.style.gridRow = String(rowIndex + 1);
            box.style.gridColumn = String(columnIndex + 1);
            if (tall) box.style.alignSelf = "start";
            linkItem(box, view, "node", chart.nodes.indexOf(node), "node");
            boxes.set(node.id, box);
            level.append(box);
          });
        });
        levels.push({ flow: level, boxes, edges, back, index: levels.length });
        return level;
      };
      const flow = build("");
      flow.setAttribute("role", "group");
      flow.setAttribute("aria-label", "Flowchart");
      scroll.append(flow);
      /**
       * Shrinks a chart wider than its column (down to 60%) so the whole flow
       * stays visible; negative margins give back the space the scaling frees.
       */
      const fit = () => {
        flow.style.transform = "";
        flow.style.marginRight = "";
        flow.style.marginBottom = "";
        const natural = flow.offsetWidth;
        const available = scroll.clientWidth;
        const scale = natural > available && available > 0 ? Math.max(0.6, available / natural) : 1;
        if (scale < 1) {
          flow.style.transformOrigin = "0 0";
          flow.style.transform = "scale(" + scale + ")";
          flow.style.marginRight = -Math.ceil(natural * (1 - scale)) + "px";
          flow.style.marginBottom = -Math.ceil(flow.offsetHeight * (1 - scale)) + "px";
        }
        return scale;
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
        marker.setAttribute("refX", "7");
        marker.setAttribute("refY", "4");
        marker.setAttribute("markerWidth", "7");
        marker.setAttribute("markerHeight", "7");
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
        for (const edge of edges) {
          const from = rect(edge.from);
          const to = rect(edge.to);
          const path = document.createElementNS(SVG, "path");
          let d;
          if (!back.has(edge) && Math.abs(to.y - from.y) < 4 && to.left > from.right) {
            d = "M" + from.right + "," + from.y + " H" + to.left;
          } else if (!back.has(edge) && to.top > from.bottom && to.left > from.right) {
            // A branch to the side leaves from the right and bends down into the target.
            d = "M" + from.right + "," + from.y + " C" + to.x + "," + from.y + " " + to.x + "," + from.y + " " + to.x + "," + to.top;
          } else if (!back.has(edge) && to.top > from.bottom) {
            const middle = (from.bottom + to.top) / 2;
            d = "M" + from.x + "," + from.bottom + " C" + from.x + "," + middle + " " + to.x + "," + middle + " " + to.x + "," + to.top;
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
            label.textContent = edge.label;
            svg.append(label);
            requestAnimationFrame(() => {
              const near = path.getPointAtLength(Math.min(22, path.getTotalLength() / 2));
              label.setAttribute("x", String(near.x + 5));
              label.setAttribute("y", String(near.y - 5));
            });
          }
        }
        holder.prepend(svg);
      };
      const draw = () => {
        const scale = fit();
        for (const level of levels) drawLevel(level, scale);
      };
      requestAnimationFrame(draw);
      if (typeof ResizeObserver === "function") {
        let lastWidth = 0;
        new ResizeObserver(() => {
          // Redraw when the column width changes, not when fitting changes the height.
          if (scroll.clientWidth === lastWidth) return;
          lastWidth = scroll.clientWidth;
          requestAnimationFrame(draw);
        }).observe(scroll);
      }
      return scroll;
    }

    function missingFormat(view, format) {
      const box = el("div");
      if (view.loadingFormat === format) {
        const loading = el("div", "loading");
        loading.setAttribute("role", "status");
        loading.append(el("span", "spinner"), el("span", "", "Generating the " + format + "…"));
        box.append(loading);
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

    function renderAiBody(view) {
      const body = el("div", "ai-body");
      body.id = view.entryId + "-ai";
      if (view.status === "loading") {
        const loading = el("div", "loading");
        loading.setAttribute("role", "status");
        loading.append(el("span", "spinner"), el("span", "", view.detail || "Working…"));
        loading.append(action("Cancel", () => post({ type: "cancelEntry", entryId: view.entryId })));
        body.append(loading);
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

    function renderAiSection(entry, view) {
      const expanded = Boolean(view && view.expanded);
      const section = el("div", "ai-section" + (expanded ? " expanded" : ""));
      const toggle = el("button", "ai-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.append(el("span", "chevron"), el("span", "ai-label", "AI explanation"));
      if (!expanded && view) {
        const hint = view.status === "loading" ? "generating…" : view.status === "current" ? "ready" : view.status === "outdated" ? "outdated" : "";
        if (hint) toggle.append(el("span", "ai-hint", hint));
      }
      toggle.title = expanded ? "Hide the AI explanation" : "Show the AI explanation (generates one if none is saved)";
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        post({ type: expanded ? "collapse" : "expand", entryId: entry.id });
      });
      section.append(toggle);
      if (expanded) {
        toggle.setAttribute("aria-controls", entry.id + "-ai");
        section.append(renderAiBody(view));
      }
      return section;
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
        const nameLink = action("", entry.explainable
          ? () => post({ type: "expand", entryId: entry.id })
          : () => post({ type: "navigate", referenceId: entry.id }), "heading-name");
        nameLink.title = entry.explainable ? "Show the AI explanation of " + entry.name : "Go to source";
        nameLink.append(el("code", "", entry.kind === "impl" ? entry.qualifiedName : entry.name));
        heading.append(nameLink);
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
      if (entry.explainable) section.append(renderAiSection(entry, view));
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

    function render(next) {
      const previousScroll = window.scrollY;
      const focusedEntry = document.activeElement && document.activeElement.closest ? document.activeElement.closest(".entry") : null;
      const focusedClass = document.activeElement ? document.activeElement.className : "";
      state = next;
      const file = next.document;
      byId("model").textContent = next.provider === "mock" ? "Mock mode (placeholder output)" : "AI: " + next.model;
      byId("cancel").hidden = !next.busy;
      byId("refreshContext").hidden = !next.hasRepository;
      byId("clearCache").hidden = !next.hasRepository;
      const notice = byId("notice");
      notice.textContent = next.notice ? next.notice.text : "";
      notice.className = "notice" + (next.notice && next.notice.tone === "error" ? " error" : "");
      byId("title").textContent = file ? file.fileName : "Downside Up";
      byId("facts").textContent = file ? [file.path, file.languageId, file.lineCount + " lines"].join(" · ") : "";
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
      byId("entries").replaceChildren(...(file ? file.entries.map((entry) => renderEntry(entry, views)) : []));
      const empty = byId("empty");
      empty.hidden = Boolean(file && file.entries.length);
      empty.textContent = file ? "Nothing to describe in this file." : "Open a source file to see its description here.";
      byId("limitations").textContent = file ? file.limitations.join("\\n") : "";
      renderOverview(next.overview);
      highlight(currentEntry);
      highlightSteps(activeSteps);
      updateStuck();
      if (focusedEntry && focusedEntry.id) {
        const focusedKind = focusedClass.split(" ")[0] || "ai-toggle";
        const selector = focusedKind === "tab" ? '.tab[aria-selected="true"]' : "." + focusedKind;
        const target = document.querySelector("#" + CSS.escape(focusedEntry.id) + " " + selector);
        if (target) target.focus({ preventScroll: true });
      }
      const fileKey = file ? file.path : "";
      if (fileKey !== renderedFile) {
        renderedFile = fileKey;
        scrollToLine(sourceLine);
      } else {
        // Re-rendering the same file keeps the reader's place.
        ignoreScrollUntil = performance.now() + 100;
        window.scrollTo(0, previousScroll);
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
        target.scrollIntoView({ block: centered ? "center" : "start" });
        // A tall item would start under the sticky heading.
        if (item && !centered) window.scrollBy(0, -inset);
      });
    }

    function highlight(entryId) {
      currentEntry = entryId;
      for (const node of document.querySelectorAll(".entry.current")) node.classList.remove("current");
      if (entryId) byId(entryId)?.classList.add("current");
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "state") render(message.state);
      else if (message.type === "scroll" && typeof message.line === "number") scrollToLine(message.line);
      else if (message.type === "cursor") highlight(typeof message.entryId === "string" ? message.entryId : undefined);
      else if (message.type === "steps") {
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
    for (const [id, type] of [["chooseModel", "chooseModel"], ["cancel", "cancel"], ["refreshContext", "refreshContext"], ["clearCache", "clearCache"]]) {
      const link = byId(id);
      link.addEventListener("click", () => post({ type }));
      link.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); post({ type }); }
      });
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
        if (typeof message !== "object" || message === null || !("type" in message)) return;
        const fields = message as Record<string, unknown>;
        const stringField = (key: string): string | undefined => {
          const value = fields[key];
          return typeof value === "string" && value.length <= 200 ? value : undefined;
        };
        const type = fields.type;
        if (type === "ready") {
          this.replay();
        } else if (type === "cancel" || type === "refreshContext" || type === "clearCache" || type === "chooseModel") {
          onAction({ type });
        } else if (type === "expand" || type === "collapse" || type === "regenerate" || type === "cancelEntry") {
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
      this.panel.onDidChangeViewState((event) => onVisibilityChanged?.(event.webviewPanel.visible))
    );
  }

  private replay(): void {
    if (this.state) void this.panel.webview.postMessage({ type: "state", state: this.state });
    if (this.cursorEntry) void this.panel.webview.postMessage({ type: "cursor", entryId: this.cursorEntry });
    if (this.scrollLine !== undefined) void this.panel.webview.postMessage({ type: "scroll", line: this.scrollLine });
    if (this.activeSteps.entryId) void this.panel.webview.postMessage({ type: "steps", ...this.activeSteps });
  }

  update(state: PanelState): void {
    this.state = state;
    void this.panel.webview.postMessage({ type: "state", state });
  }

  /** Aligns the preview with the first visible source line. */
  scrollToLine(line: number): void {
    this.scrollLine = line;
    void this.panel.webview.postMessage({ type: "scroll", line });
  }

  /** Highlights the outline entry at the editor cursor. */
  highlightEntry(entryId: string | undefined): void {
    if (entryId === this.cursorEntry) return;
    this.cursorEntry = entryId;
    void this.panel.webview.postMessage({ type: "cursor", entryId });
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
    void this.panel.webview.postMessage({ type: "steps", ...next, ...(reveal ? { reveal: true } : {}) });
  }

  setReferenceHandlers(handlers: Map<string, () => Promise<void>>): void {
    this.referenceHandlers.clear();
    for (const [id, navigate] of handlers) this.referenceHandlers.set(id, navigate);
  }

  setFileReferenceHandlers(handlers: Map<string, () => Promise<void>>): void {
    this.fileReferenceHandlers.clear();
    for (const [id, navigate] of handlers) this.fileReferenceHandlers.set(id, navigate);
  }

  async navigate(referenceId: string): Promise<void> {
    const handler = this.referenceHandlers.get(referenceId) ?? this.fileReferenceHandlers.get(referenceId);
    if (handler) await handler();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
