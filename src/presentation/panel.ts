import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { FunctionExplanation, RepositoryOverview } from "../core/types";
import type { SourceReference } from "../context/related";
import type { FileOverview } from "../context/fileOverview";
import { lineForOffset, offsetForLine } from "./scrollSync";

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
  /** For each step, whether it maps to source lines and can be highlighted or clicked. */
  readonly linkedSteps?: readonly boolean[];
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
  | { readonly type: "revealStep"; readonly entryId: string; readonly step: number };

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
    .step.linked { cursor: pointer; }
    .step.linked:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, .12)); }
    .step.active { background: var(--vscode-editor-selectionHighlightBackground, rgba(128, 128, 128, .22)); }
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
      if (explanation.steps && explanation.steps.length) {
        const list = el("ol");
        explanation.steps.forEach((step, index) => {
          const linked = Boolean(view.linkedSteps && view.linkedSteps[index]);
          const item = el("li", "step" + (linked ? " linked" : ""));
          item.dataset.step = String(index);
          if (linked) {
            item.tabIndex = 0;
            item.title = "Select these lines in the editor";
            const reveal = (target) => {
              if (target && target.closest && target.closest("a")) return;
              post({ type: "revealStep", entryId: view.entryId, step: index });
            };
            item.addEventListener("click", (clicked) => reveal(clicked.target));
            item.addEventListener("keydown", (pressed) => {
              const name = pressed["key"];
              if (name === "Enter" || name === " ") { pressed.preventDefault(); reveal(undefined); }
            });
          }
          item.append(el("strong", "", step.title.replace(/[.:]?$/, ".")));
          inline(item, " " + step.detail);
          list.append(item);
        });
        body.append(el("h5", "", "What happens"), list);
      }
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
        if (aiTitle) heading.append(el("span", "ai-title", aiTitle + " —"));
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
      if (focusedEntry && focusedEntry.id) {
        const target = document.querySelector("#" + CSS.escape(focusedEntry.id) + " ." + (focusedClass.split(" ")[0] || "ai-toggle"));
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

    function anchors() {
      const list = [];
      for (const node of document.querySelectorAll("[data-line]")) {
        list.push({ line: Number(node.dataset.line), top: node.getBoundingClientRect().top + window.scrollY });
      }
      return list.sort((left, right) => left.line - right.line || left.top - right.top);
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
        window.scrollTo(0, offsetForLine(anchors(), sourceLine, lineCount(), documentEnd()));
      });
    }
    window.addEventListener("scroll", () => {
      if (performance.now() < ignoreScrollUntil || !state || !state.document) return;
      cancelAnimationFrame(revealFrame);
      revealFrame = requestAnimationFrame(() => {
        sourceLine = lineForOffset(anchors(), window.scrollY, lineCount(), documentEnd());
        post({ type: "revealLine", line: Math.max(0, Math.floor(sourceLine)) });
      });
    }, { passive: true });
    let activeSteps = { entryId: "", steps: [] };
    function highlightSteps(next) {
      activeSteps = next;
      for (const node of document.querySelectorAll(".step.active")) node.classList.remove("active");
      const body = next.entryId ? byId(next.entryId + "-ai") : null;
      if (!body) return;
      for (const index of next.steps) body.querySelector('[data-step="' + index + '"]')?.classList.add("active");
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
        highlightSteps({
          entryId: typeof message.entryId === "string" ? message.entryId : "",
          steps: Array.isArray(message.steps) ? message.steps.filter((step) => Number.isInteger(step)) : []
        });
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
  private activeSteps: { entryId: string; steps: number[] } = { entryId: "", steps: [] };
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
        } else if (type === "revealStep") {
          const entryId = stringField("entryId");
          const step = fields.step;
          if (entryId && typeof step === "number" && Number.isInteger(step) && step >= 0 && step < 50) {
            onAction({ type, entryId, step });
          }
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

  /** Highlights the explanation steps that cover the editor's cursor or selection. */
  highlightSteps(entryId: string | undefined, steps: readonly number[]): void {
    const next = { entryId: entryId ?? "", steps: entryId ? [...steps] : [] };
    if (next.entryId === this.activeSteps.entryId && next.steps.join() === this.activeSteps.steps.join()) return;
    this.activeSteps = next;
    void this.panel.webview.postMessage({ type: "steps", ...next });
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
