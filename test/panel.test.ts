import { describe, expect, it, vi } from "vitest";
import { panelHtml, type ExplanationView, type PanelState, type Crumb, type ChangeView } from "../src/presentation/panel";
import type { ComparisonVisualScope, Flowchart } from "../src/core/types";

class TestElement {
  readonly children: Array<TestElement | string> = [];
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";
  id = "";
  title = "";
  hidden = false;
  disabled = false;
  focused = false;
  readonly listeners = new Map<string, (event?: { key?: string; preventDefault(): void; stopPropagation(): void }) => void>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = { add: (...names: string[]) => { this.className += " " + names.join(" "); } };
  readonly clientWidth = 400;
  readonly offsetWidth = 320;
  readonly offsetHeight = 200;
  readonly scrollWidth = 320;
  readonly scrollHeight = 200;
  readonly isConnected = true;
  parentElement?: TestElement;
  get ownerSVGElement(): TestElement | undefined { return this.parentElement?.tagName === "svg" ? this.parentElement : this.parentElement?.ownerSVGElement; }
  constructor(readonly tagName: string) {}
  append(...children: Array<TestElement | string>): void { for (const child of children) if (child instanceof TestElement) child.parentElement = this; this.children.push(...children); }
  prepend(...children: Array<TestElement | string>): void { for (const child of children) if (child instanceof TestElement) child.parentElement = this; this.children.unshift(...children); }
  replaceChildren(...children: Array<TestElement | string>): void { this.children.length = 0; this.append(...children); this.textContent = ""; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | undefined { return this.attributes.get(name); }
  querySelectorAll(): TestElement[] { return []; }
  getBoundingClientRect() { const top = (Number(this.style.gridRow || 1) - 1) * 100; return { width: 320, height: 40, left: 0, right: 320, top, bottom: top + 40 }; }
  getTotalLength(): number { return 100; }
  getPointAtLength(length: number) { return { x: 160, y: length }; }
  getBBox() { return { x: 100, y: 50, width: 80, height: 12 }; }
  addEventListener(type: string, listener: (event?: { key?: string; preventDefault(): void; stopPropagation(): void }) => void): void { this.listeners.set(type, listener); }
  focus(): void { this.focused = true; }
  elements(): TestElement[] {
    return [this, ...this.children.flatMap((child) => typeof child === "string" ? [] : child.elements())];
  }
}

function webviewHelpers() {
  const html = panelHtml("n");
  const start = html.indexOf('<script nonce="n">') + '<script nonce="n">'.length;
  const script = html.slice(start, html.indexOf("</script>", start));
  const elements = new Map<string, TestElement>();
  const messages: unknown[] = [];
  const frames: Array<() => void> = [];
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new TestElement("button"));
    return elements.get(id)!;
  };
  const helpers = new Function("acquireVsCodeApi", "document", "window", "requestAnimationFrame", script + "\nreturn { layoutFlow, downwardPath, renderEntry, renderAiBody, missingFormat, renderHeader, renderCrumbs, renderActivity, renderPageActions, renderChange, setFormats: (formats) => { state = { formats }; } };")(
    () => ({ getState: () => ({}), postMessage: (message: unknown) => messages.push(message) }),
    {
      getElementById: element,
      createElement: (tag: string) => new TestElement(tag),
      createElementNS: (_ns: string, tag: string) => new TestElement(tag),
      createTextNode: (text: string) => text
    },
    { addEventListener: () => undefined },
    (callback: () => void) => { frames.push(callback); return frames.length; }
  ) as {
    layoutFlow(chart: Flowchart, limit?: number): { rows: Flowchart["nodes"][]; back: Set<Flowchart["edges"][number]> };
    downwardPath(points: Array<{ x: number; y: number }>): string;
    renderEntry(entry: Record<string, unknown>, views: Map<string, ExplanationView>): TestElement;
    renderAiBody(view: ExplanationView): TestElement;
    missingFormat(view: ExplanationView, format: string): TestElement;
    renderHeader(state: Pick<PanelState, "models" | "provider" | "busy" | "hasRepository" | "needsInitialization" | "stats" | "statsError">): void;
    renderCrumbs(crumbs: readonly Crumb[]): void;
    renderActivity(state: Pick<PanelState, "busy" | "notice" | "folder" | "stats">): void;
    renderPageActions(state: Partial<PanelState>): void;
    renderChange(change: ChangeView): TestElement[];
    setFormats(formats: PanelState["formats"]): void;
  };
  messages.length = 0;
  return { ...helpers, element, messages, flushFrames: () => { while (frames.length) frames.shift()!(); } };
}

it("shows elapsed activity across updates and clears the timer when work stops", () => {
  vi.useFakeTimers();
  try {
    const { renderActivity, element } = webviewHelpers();
    renderActivity({ busy: true, notice: { tone: "progress", text: "Mapping the project…" } });
    expect(element("activity").hidden).toBe(false);
    expect(element("header").className).toBe("header working");
    expect(element("activityStage").textContent).toBe("Mapping the project…");
    vi.advanceTimersByTime(65_000);
    expect(element("activityTime").textContent).toContain("1:05 elapsed");
    renderActivity({ busy: true, notice: { tone: "progress", text: "Saving…" } });
    expect(element("activityStage").textContent).toBe("Saving…");
    vi.advanceTimersByTime(1000);
    expect(element("activityTime").textContent).toContain("1:06 elapsed");
    renderActivity({ busy: false });
    expect(element("activity").hidden).toBe(true);
    expect(element("header").className).toBe("header");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe("preview webview document", () => {
  it("omits the shared help footer while keeping contextual notices and limitations", () => {
    const html = panelHtml("n");
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("Function headings and other items come from the code itself.");
    expect(html).toContain('id="notice"');
    expect(html).toContain('id="prefetchConsent"');
    expect(html).toContain('id="limitations"');
  });

  it("renders local schema tables as text with host-owned column/relationship links and an explicit Explain action", () => {
    const { renderEntry, messages } = webviewHelpers();
    const schemaEntry = {
      id: "entry-0", kind: "type", kindLabel: "Table", name: "books", qualifiedName: "public.books",
      startLine: 1, endLine: 5, depth: 0, explainable: true, showCallers: false,
      description: [{ text: "Stores books." }],
      notes: [[{ text: "References " }, { text: "users", code: true, referenceId: "entry-5" }]],
      previewTable: {
        headers: ["Column", "Type", "Required", "Default / rules"],
        rows: [[
          [{ text: "id", code: true, referenceId: "entry-1" }],
          [{ text: "integer", code: true }], [{ text: "Yes" }], [{ text: "<script>not executable</script>" }]
        ]]
      }
    };
    const rendered = renderEntry(schemaEntry, new Map());
    const elements = rendered.elements();
    expect(elements.filter((node) => node.tagName === "table")).toHaveLength(1);
    expect(elements.filter((node) => node.tagName === "th").map((node) => node.textContent)).toEqual(schemaEntry.previewTable.headers);
    expect(elements.some((node) => node.tagName === "script")).toBe(false);
    expect(elements.some((node) => node.className === "callers")).toBe(false);
    expect(messages).toEqual([]);
    elements.find((node) => node.tagName === "a" && node.children.some((child) => child instanceof TestElement && child.textContent === "id"))?.listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} });
    expect(messages).toEqual([{ type: "navigate", referenceId: "entry-1" }]);
    elements.find((node) => node.tagName === "button" && node.textContent === "Explain")?.listeners.get("click")?.();
    expect(messages.at(-1)).toEqual({ type: "expand", entryId: "entry-0" });
  });

  it("offers repository initialization only when context is missing, without generating on render", () => {
    const { renderHeader, element, messages } = webviewHelpers();
    const base = { provider: "mock", models: { explanation: "Mock" }, busy: false, hasRepository: true };
    renderHeader({ ...base, needsInitialization: true });
    expect(element("initializeProject").hidden).toBe(false);
    expect(element("initializeProject").disabled).toBe(false);
    expect(messages).toEqual([]);
    element("initializeProject").listeners.get("click")?.();
    expect(messages).toEqual([{ type: "refreshContext" }]);
    renderHeader({ ...base, needsInitialization: true, busy: true });
    expect(element("initializeProject").disabled).toBe(true);
    renderHeader({ ...base, needsInitialization: false });
    expect(element("initializeProject").hidden).toBe(true);
    renderHeader({ ...base, needsInitialization: true, hasRepository: false });
    expect(element("initializeProject").hidden).toBe(true);
  });

  it("integrates the map into the opening description without a repetitive heading or paragraph", () => {
    const html = panelHtml("n");
    expect(html).not.toContain('el("h2", "folder-heading", "Map")');
    expect(html).not.toContain('el("p", "muted small", "Arrows point from a part');
    expect(html).toContain('box.title = "AI-generated from repository context; may miss connections.');
  });

  it("places refresh actions in page context and uses amber only for known outdated content", () => {
    const { renderPageActions, renderActivity, element, messages } = webviewHelpers();
    const folder: NonNullable<PanelState["folder"]> = {
      name: "Project", path: "", level: "project", mapState: "current",
      fileCount: 0, children: [], limitations: [], summarizing: false,
      canSummarize: false, canSummarizeTree: false, describingFlows: false, canDescribeFlows: false
    };
    renderPageActions({ busy: false, folder });
    expect(element("pageActions").elements().find((node) => node.id === "pageRefresh")?.disabled).toBe(true);
    renderPageActions({ busy: false, folder: { ...folder, mapState: "missing" } });
    expect(element("pageActions").elements().map((node) => node.textContent)).toContain("Map project");
    const mapButton = element("pageActions").elements().find((node) => node.id === "pageMap");
    expect(mapButton?.disabled).toBe(false);
    mapButton?.listeners.get("click")?.();
    expect(messages).toEqual([{ type: "refreshContext" }]);
    const stats: NonNullable<PanelState["stats"]> = {
      explanations: 2, fileSummaries: 0, folderSummaries: 0, flows: 0, outdatedHere: 2, scope: "folder"
    };
    renderPageActions({ busy: false, folder, stats });
    expect(element("pageActions").elements().map((node) => node.textContent)).toContain("2 outdated here");
    element("pageActions").elements().find((node) => node.id === "pageRefresh")?.listeners.get("click")?.();
    expect(messages).toEqual([{ type: "refreshContext" }, { type: "regenerateOutdated" }]);
    renderActivity({ busy: false, folder, stats });
    expect(element("header").className).toBe("header stale");
    renderActivity({ busy: false, folder: { ...folder, mapState: "other" } });
    expect(element("header").className).toBe("header stale");
    renderActivity({ busy: true, folder: { ...folder, mapState: "other" } });
    expect(element("header").className).toBe("header working");
    renderPageActions({ busy: true, folder: { ...folder, mapState: "other" } });
    expect(element("pageActions").elements().find((node) => node.id === "pageMap")?.disabled).toBe(true);
    renderActivity({ busy: false });
    expect(element("header").className).toBe("header");
    renderPageActions({ busy: false });
    expect(element("pageActions").children).toHaveLength(0);
  });

  it("keeps a restrictive policy and renders content only as text", () => {
    const html = panelHtml("nonce-value");
    expect(html).toContain("default-src 'none'; style-src 'nonce-nonce-value'; script-src 'nonce-nonce-value';");
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(html).not.toMatch(/<(?:img|iframe|link)\b/);
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script nonce="nonce-value">']);
  });

  it("embeds the tested pure helpers instead of separate copies", () => {
    const html = panelHtml("n");
    expect(html).toContain("const offsetForLine = (function offsetForLine(");
    expect(html).toContain("const lineForOffset = (function lineForOffset(");
  });

  it("has a webview script that parses", () => {
    const html = panelHtml("n");
    const start = html.indexOf('<script nonce="n">') + '<script nonce="n">'.length;
    const script = html.slice(start, html.indexOf("</script>", start));
    expect(() => new Function(script)).not.toThrow();
  });

  it("uses native, responsive icon buttons without duplicate keyboard handlers", () => {
    const html = panelHtml("n");
    for (const id of ["chooseModel", "chooseOverviewModel", "cancel", "clearCache"]) {
      expect(html).toMatch(new RegExp('<button id="' + id + '"[^>]*type="button"[^>]*aria-label='));
    }
    expect(html).toContain('@container (max-width: 420px)');
    expect(html).toContain('.toolbar .btn-label { display: none; }');
    expect(html).toContain('class="tool-button danger"');
    expect(html).toContain('"Refresh outdated items on this page", "regenerateOutdated"');
    expect(html.indexOf('id="pageActions"')).toBeGreaterThan(html.indexOf('</header>'));
    expect(html).toContain('button.addEventListener("click", () => post({ type }))');
    expect(html.indexOf('<button id="chooseOverviewModel"')).toBeLessThan(html.indexOf('<button id="chooseModel"'));
    expect(html).toContain('background: transparent; border: 0;');
    expect(html).toContain('button:not(:disabled):is(:hover, :focus-visible, :active)');
    expect(html).not.toContain('<button id="refreshContext"');
    expect(html).toContain('<span class="btn-label">Clear</span>');
    expect(html).toContain('.header.working::after');
    expect(html).not.toContain('.activity::before');
  });

  it("keeps model roles and repository cache details in the global header", () => {
    const { renderHeader, element } = webviewHelpers();
    const base = { provider: "vscode-lm" as const, models: { explanation: "Fast", overview: "Strong" }, busy: false, hasRepository: true };
    renderHeader({
      ...base,
      stats: { explanations: 12, fileSummaries: 1, folderSummaries: 2, flows: 3, outdatedHere: 2, scope: "file", mapSavedAt: Date.now() }
    });

    expect(element("chooseModel").elements().filter((node) => node.className === "model-role" || node.className === "model-name").map((node) => node.textContent)).toEqual(["Functions", "Fast"]);
    expect(element("chooseOverviewModel").elements().filter((node) => node.className === "model-role" || node.className === "model-name").map((node) => node.textContent)).toEqual(["Project overview", "Strong"]);
    expect(element("chooseOverviewModel").title).toContain("Project priming and repository context reviews");
    expect(element("chooseOverviewModel").title).toContain("folder summaries, and main flows");
    expect(element("chooseOverviewModel").attributes.get("aria-label")).toBe("Choose project overview model; current: Strong");
    expect(element("modelsIcon").elements().filter((node) => node.tagName === "svg")).toHaveLength(1);
    for (const id of ["chooseOverviewModel", "chooseModel"]) {
      expect(element(id).elements().filter((node) => node.tagName === "svg")).toHaveLength(1);
    }
    const stats = element("stats").elements();
    expect(stats.map((node) => node.textContent)).toEqual(expect.arrayContaining(["12 explanations", "1 file summary", "2 folder summaries", "3 flow sets"]));
    expect(element("stats").title).toContain("across all models");
    renderHeader({ ...base, models: { explanation: "Fast", overview: "Fast" }, busy: true, stats: { explanations: 1, fileSummaries: 0, folderSummaries: 0, flows: 0, outdatedHere: 1, scope: "folder" } });
    for (const id of ["chooseModel", "chooseOverviewModel"]) {
      expect(element(id).elements().find((node) => node.className === "model-name")?.textContent).toBe("Fast");
    }
    expect(element("clearCache").disabled).toBe(true);
    expect(element("cancel").hidden).toBe(false);
    renderHeader({ ...base, stats: { explanations: 0, fileSummaries: 0, folderSummaries: 0, flows: 0, outdatedHere: 0, scope: "file" } });
    expect(element("clearCache").disabled).toBe(false);
    expect(element("stats").elements().some((node) => node.id === "regenerateOutdated")).toBe(false);
    renderHeader({ ...base, statsError: "Cache could not be read" });
    expect(element("stats").elements().find((node) => node.className === "error")?.textContent).toBe("Cache could not be read");
    renderHeader({ ...base, provider: "mock" });
    for (const id of ["chooseModel", "chooseOverviewModel"]) {
      expect(element(id).elements().some((node) => node.textContent === "Mock mode")).toBe(true);
    }
    renderHeader({ ...base, models: { explanation: "Fallback" } });
    expect(element("chooseOverviewModel").elements().find((node) => node.className === "model-name")?.textContent).toBe("Fallback");
  });

  it("puts retained token usage and cache counts in a disclosure and hides zero outdated counts", () => {
    const { renderHeader, element } = webviewHelpers();
    renderHeader({
      provider: "vscode-lm", models: { explanation: "Fast" }, busy: false, hasRepository: true,
      stats: {
        explanations: 1, fileSummaries: 0, folderSummaries: 0, flows: 0, outdatedHere: 0, scope: "file",
        usage: {
          inputTokens: 100, outputTokens: 20, estimated: true, unrecorded: 0,
          models: [{ role: "Functions", provider: "vscode-lm", model: "Fast", inputTokens: 100, outputTokens: 20, estimated: true }]
        }
      }
    });
    const details = element("stats").elements().find((node) => node.tagName === "details");
    expect(details).toBeDefined();
    expect(details!.elements().find((node) => node.tagName === "summary")?.textContent).toBe("Tokens in current cache: ~120");
    expect(details!.elements().map((node) => node.textContent)).toContain("Functions: 100 input / 20 output");
    expect(details!.elements().map((node) => node.textContent)).toContain("Fast (vscode-lm): ~100 input / 20 output");
    expect(element("stats").elements().some((node) => node.textContent.includes("0 outdated"))).toBe(false);
  });

  it("renders level-aware crumbs as text, marking rich pages and the current location", () => {
    const { renderCrumbs, element } = webviewHelpers();
    const crumbs: Crumb[] = [
      { name: "project", level: "project", summary: "<script>not markup</script>", target: "root" },
      { name: "services", level: "group", target: "services" },
      { name: "api", level: "component", target: "api" },
      { name: "module", level: "module", target: "module" },
      { name: "api.ts", level: "file" }
    ];
    renderCrumbs(crumbs);
    const nodes = element("crumbs").elements();
    expect(nodes.filter((node) => node.className.endsWith(" rich"))).toHaveLength(3);
    expect(nodes.find((node) => node.className === "crumb level-project rich")?.title).toBe("Project — <script>not markup</script>");
    expect(nodes.find((node) => node.className === "crumb level-file")?.attributes.get("aria-current")).toBe("page");
    expect(nodes.filter((node) => node.tagName === "svg")).toHaveLength(5);
    expect(nodes.filter((node) => node.tagName === "svg").every((node) => node.attributes.get("aria-hidden") === "true")).toBe(true);
    renderCrumbs([crumbs[0]!]);
    expect(element("crumbs").hidden).toBe(false);
    expect(element("crumbs").elements().find((node) => node.className.includes("level-project"))?.attributes.get("aria-current")).toBe("page");
  });

  it("reflows flowchart branches and side exits vertically without losing nodes or loops", () => {
    const chart: Flowchart = {
      nodes: [
        { id: "start", label: "Start", kind: "start", startLine: 0, endLine: 0 },
        { id: "choice", label: "Choose", kind: "decision", startLine: 0, endLine: 0 },
        ...["a", "b", "c"].map((id) => ({ id, label: id, kind: "action" as const, startLine: 0, endLine: 0 })),
        { id: "end", label: "Done", kind: "end", startLine: 0, endLine: 0 }
      ],
      edges: [
        { from: "start", to: "choice", label: "" }, { from: "choice", to: "end", label: "Stop" },
        ...["a", "b", "c"].map((to) => ({ from: "choice", to, label: to })),
        { from: "b", to: "choice", label: "Retry" }
      ]
    };
    const { layoutFlow } = webviewHelpers();
    for (const limit of [1, 2]) {
      const layout = layoutFlow(chart, limit);
      expect(layout.rows.flat().map((node) => node.id).sort()).toEqual(chart.nodes.map((node) => node.id).sort());
      for (const row of layout.rows) expect(row.length).toBeLessThanOrEqual(limit);
      const rows = new Map(layout.rows.flatMap((row, rank) => row.map((node) => [node.id, rank] as const)));
      for (const edge of chart.edges) {
        if (!layout.back.has(edge)) expect(rows.get(edge.to)!).toBeGreaterThan(rows.get(edge.from)!);
      }
      expect([...layout.back].map((edge) => edge.label)).toEqual(["Retry"]);
    }
  });

  it("ends downward arrows with a straight segment at the target boundary", () => {
    const { downwardPath } = webviewHelpers();
    expect(downwardPath([{ x: 10, y: 20 }, { x: 80, y: 100 }])).toBe("M10,20 V32 C10,60 80,60 80,88 V100");
    expect(downwardPath([{ x: 0, y: 0 }, { x: 10, y: 8 }])).toBe("M0,0 V2 C0,4 10,4 10,6 V8");
  });

  it("shows Explain only for an unexplained entry and renders prefetched loading inline", () => {
    const { renderEntry, messages } = webviewHelpers();
    const entry = {
      id: "f", kind: "function", kindLabel: "Function", name: "run",
      depth: 0, startLine: 0, explainable: true, description: [], notes: []
    };
    const loading: ExplanationView = {
      entryId: "f", functionName: "run", status: "loading", detail: "Waiting for a request slot",
      references: [], limitations: []
    };
    const unexplained = renderEntry(entry, new Map()).elements();
    expect(unexplained.filter((node) => node.className === "explain").map((node) => node.textContent)).toEqual(["Explain"]);
    const callers = unexplained.find((node) => node.className === "callers");
    expect(callers?.attributes.get("aria-label")).toBe("Show callers of run");
    expect(callers?.textContent).toBe("");
    expect(callers?.elements().some((node) => node.tagName === "svg")).toBe(true);
    callers?.listeners.get("click")?.();
    expect(messages).toEqual([{ type: "showCallers", entryId: "f" }]);
    messages.length = 0;
    const name = unexplained.find((node) => node.className === "heading-name");
    expect(name?.title).toBe("Go to source: run");
    name?.listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} });
    expect(messages).toEqual([{ type: "navigate", referenceId: "f" }]);
    unexplained.find((node) => node.className === "explain")?.listeners.get("click")?.();
    expect(messages[1]).toEqual({ type: "expand", entryId: "f" });
    const pending = renderEntry(entry, new Map([["f", loading]])).elements();
    expect(pending.filter((node) => node.className === "explain")).toEqual([]);
    expect(pending.some((node) => node.className === "callers")).toBe(true);
    expect(pending.some((node) => node.id === "f-ai")).toBe(true);
    expect(pending.filter((node) => node.className.startsWith("skeleton"))).toHaveLength(4);
    expect(pending.find((node) => node.attributes.get("role") === "status")?.children).toContainEqual(
      expect.objectContaining({ textContent: loading.detail })
    );
    expect(pending.some((node) => node.textContent === "Cancel")).toBe(true);
    expect(pending.some((node) => node.className === "ai-toggle")).toBe(false);
  });

  it("keeps failures actionable and gives added formats the same accessible skeletons", () => {
    const { renderAiBody, missingFormat } = webviewHelpers();
    const failed: ExplanationView = {
      entryId: "f", functionName: "run", status: "failed", detail: "Generation failed",
      error: "Provider quota reached", references: [], limitations: []
    };
    const failure = renderAiBody(failed).elements();
    expect(failure.some((node) => node.textContent === "Try again")).toBe(true);
    expect(failure.some((node) => node.textContent === failed.error)).toBe(true);
    expect(failure.some((node) => node.className.startsWith("skeleton"))).toBe(false);
    const format = missingFormat({ ...failed, status: "current", loadingFormat: "flowchart" }, "flowchart").elements();
    expect(format.filter((node) => node.className.startsWith("skeleton"))).toHaveLength(4);
    expect(format.some((node) => node.attributes.get("aria-busy") === "true")).toBe(true);
    expect(format.some((node) => node.attributes.get("aria-hidden") === "true")).toBe(true);
  });
});

describe("change view", () => {
  const base: ChangeView = {
    key: "k", fileName: "a.txt", facts: "", originalLabel: "Last commit", modifiedLabel: "Working copy",
    status: "ready", canExplain: true
  };
  const texts = (nodes: TestElement[]) => nodes.flatMap((node) => node.elements()).flatMap((node) => [node.textContent, ...node.children.filter((child) => typeof child === "string")]);
  const event = { preventDefault: () => undefined, stopPropagation: () => undefined };
  const visualScope = (): ComparisonVisualScope => {
    const side = (prefix: string): ComparisonVisualScope["original"] => ({
      presence: "present", region: prefix + " region", coverage: "Selected routine only",
      flowchartStatus: "available", flowchartReason: "",
      steps: [{ id: "step", text: prefix + " step <script>alert(1)</script>", detail: prefix + " detail", occurrenceId: "occurrence", startLine: 2, endLine: 3 }],
      pseudocode: [{ id: "pseudo", text: prefix + " pseudocode", depth: 2, occurrenceId: "occurrence", startLine: 2, endLine: 3 }],
      flowchart: {
        nodes: [
          { id: "start", kind: "start", label: prefix + " start", occurrenceId: "occurrence" },
          { id: "end", kind: "end", label: prefix + " end", occurrenceId: "occurrence" }
        ],
        edges: [{ id: "edge", from: "start", to: "end", label: prefix + " branch" }]
      }
    });
    return {
      id: "scope", title: "Paired <b>routine</b>", original: side("Before"), modified: side("After"),
      units: [
        { id: "before-unit", label: "Old operation", side: "original", occurrence: { id: "occurrence", startLine: 2, endLine: 3 } },
        { id: "after-unit", label: "New operation", side: "modified", occurrence: { id: "occurrence", startLine: 2, endLine: 3 } }
      ],
      unitCorrespondences: [{ originalUnitId: "before-unit", modifiedUnitId: "after-unit", meaning: "Checks input", difference: "Rejects empty values" }],
      edgeCorrespondences: [{ originalEdgeId: "edge", modifiedEdgeId: "edge", meaning: "Next operation", difference: "Runs after validation" }]
    };
  };
  const withVisual = (scope = visualScope()): ChangeView => ({
    ...base, status: "current",
    result: {
      summary: "Changed routine", changes: [{ visualScopeId: scope.id, title: "Validation", before: "", after: "", when: "", flow: "", links: [] }],
      outside: "", possibleEffects: [], limitations: [], model: "m",
      visualScopes: [{ scope, originalLinks: { occurrence: "host-original" }, modifiedLinks: { occurrence: "host-modified" } }]
    }
  });

  it("renders scoped paired steps, pseudocode, and flow connections using only host-owned side links", () => {
    const { renderChange, messages, flushFrames } = webviewHelpers();
    const cards = renderChange(withVisual());
    const elements = () => cards.flatMap((card) => card.elements());
    const click = (text: string) => elements().find((node) => node.textContent === text)?.listeners.get("click")?.(event);
    const visibleTexts = () => texts(cards).join(" ");
    expect(visibleTexts()).toContain("Before step <script>alert(1)</script>");
    expect(visibleTexts()).toContain("After step <script>alert(1)</script>");
    expect(visibleTexts()).toContain("Before detail");
    expect(visibleTexts()).toContain("Coverage: Selected routine only");
    expect(elements().some((node) => node.tagName === "script" || node.tagName === "b")).toBe(false);
    expect(elements().find((node) => node.className === "comparison-visual")).toBeDefined();
    expect(elements().find((node) => node.attributes.get("role") === "tablist")?.attributes.get("aria-label")).toBe("Paired <b>routine</b> comparison views");
    expect(elements().find((node) => node.textContent === "Steps")?.attributes.get("aria-selected")).toBe("true");
    expect(messages).toEqual([]);
    click("Before step <script>alert(1)</script>");
    click("After step <script>alert(1)</script>");
    expect(messages.splice(0)).toEqual([{ type: "navigate", referenceId: "host-original" }, { type: "navigate", referenceId: "host-modified" }]);
    click("Pseudocode");
    expect(messages).toEqual([]);
    expect(visibleTexts()).not.toContain("Before step");
    expect(visibleTexts()).toContain("Before pseudocode");
    expect(elements().find((node) => node.tagName === "li" && node.attributes.has("style"))?.attributes.get("style")).toBe("margin-left: 2em");
    click("Before pseudocode");
    click("After pseudocode");
    expect(messages.splice(0)).toEqual([{ type: "navigate", referenceId: "host-original" }, { type: "navigate", referenceId: "host-modified" }]);
    click("Flowchart");
    flushFrames();
    expect(messages).toEqual([]);
    expect(elements().filter((node) => node.className === "flow-scroll")).toHaveLength(2);
    expect(elements().filter((node) => node.tagName === "svg")).toHaveLength(2);
    const edges = elements().filter((node) => node.tagName === "path" && node.attributes.get("class") === "flow-edge");
    expect(edges).toHaveLength(2);
    expect(edges.every((edge) => edge.attributes.get("d")?.startsWith("M") && edge.attributes.get("marker-end")?.startsWith("url(#arrow-comparison-visual-"))).toBe(true);
    expect(new Set(edges.map((edge) => edge.attributes.get("marker-end"))).size).toBe(2);
    expect(visibleTexts()).toContain("Last commit lines 2–3");
    expect(visibleTexts()).toContain("Working copy lines 2–3");
    expect(visibleTexts()).toContain("Before branch");
    expect(visibleTexts()).toContain("After branch");
    click("Before start");
    click("After end");
    expect(messages.splice(0)).toEqual([{ type: "navigate", referenceId: "host-original" }, { type: "navigate", referenceId: "host-modified" }]);
    expect(visibleTexts()).toContain("not proof of equivalent behavior");
    expect(visibleTexts()).toContain("Meaning: Checks input");
    expect(visibleTexts()).toContain("Difference: Runs after validation");
    click("Old operation");
    click("New operation");
    expect(messages).toEqual([{ type: "navigate", referenceId: "host-original" }, { type: "navigate", referenceId: "host-modified" }]);
    const html = panelHtml("n");
    expect(html).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)');
    expect(html).toContain('@media (max-width: 600px) { .comparison-sides { grid-template-columns: minmax(0, 1fr); } }');
  });

  it("keeps comparison tabs local, keyboard accessible, and independent of other change cards", () => {
    const { renderChange, messages } = webviewHelpers();
    const view = withVisual();
    const sharedScope = {
      ...view,
      result: {
        ...view.result!,
        changes: [...view.result!.changes, { ...view.result!.changes[0]!, title: "Related change" }]
      }
    };
    expect(renderChange(sharedScope).flatMap((card) => card.elements()).filter((node) => node.className === "comparison-visual")).toHaveLength(1);

    const second = { ...visualScope(), id: "second", title: "Second scope" };
    const combined: ChangeView = {
      ...view,
      result: {
        ...view.result!,
        changes: [...view.result!.changes, { ...view.result!.changes[0]!, visualScopeId: second.id }],
        visualScopes: [...view.result!.visualScopes!, { scope: second, originalLinks: {}, modifiedLinks: {} }]
      }
    };
    const cards = renderChange(combined);
    const visuals = cards.flatMap((card) => card.elements()).filter((node) => node.className === "comparison-visual");
    const firstTab = visuals[0]!.elements().find((node) => node.textContent === "Steps")!;
    firstTab.listeners.get("keydown")?.({ ...event, key: "ArrowRight" });
    const firstElements = visuals[0]!.elements();
    const pseudoTab = firstElements.find((node) => node.textContent === "Pseudocode")!;
    expect(pseudoTab.focused).toBe(true);
    expect(pseudoTab.attributes.get("aria-selected")).toBe("true");
    const pane = firstElements.find((node) => node.attributes.get("role") === "tabpanel")!;
    expect(pane.attributes.get("aria-labelledby")).toBe(pseudoTab.id);
    expect(pseudoTab.attributes.get("aria-controls")).toBe(pane.id);
    expect(visuals[1]!.elements().find((node) => node.textContent === "Steps")?.attributes.get("aria-selected")).toBe("true");
    const rerendered = renderChange(combined).flatMap((card) => card.elements()).filter((node) => node.className === "comparison-visual");
    expect(rerendered[0]!.elements().find((node) => node.textContent === "Pseudocode")?.attributes.get("aria-selected")).toBe("true");
    expect(rerendered[1]!.elements().find((node) => node.textContent === "Steps")?.attributes.get("aria-selected")).toBe("true");
    const otherPair = renderChange({ ...combined, key: "other-pair" }).flatMap((card) => card.elements());
    expect(otherPair.filter((node) => node.textContent === "Steps").every((tab) => tab.attributes.get("aria-selected") === "true")).toBe(true);
    expect(messages).toEqual([]);
  });

  it("shows missing sides and unavailable chart reasons without offering absent formats or requests", () => {
    const { renderChange, messages } = webviewHelpers();
    const scope = visualScope();
    const empty = { ...scope.original, steps: [], pseudocode: [], flowchart: { nodes: [], edges: [] } };
    const added: ComparisonVisualScope = {
      ...scope,
      original: { ...empty, presence: "absent", flowchartStatus: "not-applicable", flowchartReason: "No original routine" },
      modified: { ...scope.modified, flowchartStatus: "unavailable", flowchartReason: "Routine exceeds chart limit" }
    };
    const cards = renderChange(withVisual(added));
    expect(texts(cards)).toContain("Not present in this version.");
    cards.flatMap((card) => card.elements()).find((node) => node.textContent === "Flowchart")?.listeners.get("click")?.(event);
    expect(texts(cards)).toContain("Flowchart unavailable.");
    expect(texts(cards)).toContain("Routine exceeds chart limit");
    const noFormats = renderChange(withVisual({ ...scope, original: empty, modified: empty }));
    const tabs = noFormats.flatMap((card) => card.elements()).filter((node) => node.attributes.get("role") === "tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Steps"]);
    expect(texts(noFormats)).toContain("No steps recorded for this region.");
    expect(messages).toEqual([]);
  });

  it("retains unassigned scopes and omits all visual navigation when outdated or not host-linked", () => {
    const { renderChange, messages, flushFrames } = webviewHelpers();
    const view = withVisual();
    const noChanges: ChangeView = { ...view, result: { ...view.result!, changes: [] } };
    expect(texts(renderChange(noChanges))).toContain("Paired <b>routine</b>");
    for (const stale of [
      { ...view, status: "outdated" as const },
      { ...view, status: "failed" as const, result: { ...view.result!, outdated: true } },
      { ...view, result: { ...view.result!, visualScopes: [{ ...view.result!.visualScopes![0]!, originalLinks: {}, modifiedLinks: {} }] } }
    ]) {
      const cards = renderChange(stale);
      const elements = () => cards.flatMap((card) => card.elements());
      expect(elements().filter((node) => node.tagName === "a" && node.attributes.has("aria-label"))).toHaveLength(0);
      elements().find((node) => node.textContent === "Pseudocode")?.listeners.get("click")?.(event);
      expect(elements().filter((node) => node.tagName === "a" && node.attributes.has("aria-label"))).toHaveLength(0);
      elements().find((node) => node.textContent === "Flowchart")?.listeners.get("click")?.(event);
      flushFrames();
      expect(elements().filter((node) => node.tagName === "a" && node.attributes.has("aria-label"))).toHaveLength(0);
      expect(elements().filter((node) => node.className.startsWith("flow-node"))).toHaveLength(4);
      expect(elements().filter((node) => node.dataset.flowLink === "1")).toHaveLength(0);
    }
    expect(messages).toEqual([]);
  });

  it("honors optional format settings without hiding Steps or generating formats", () => {
    const { renderChange, setFormats, messages } = webviewHelpers();
    setFormats({ pseudocode: false, flowchart: true, initial: "pseudocode" });
    const cards = renderChange(withVisual());
    const tabs = () => cards.flatMap((card) => card.elements()).filter((node) => node.attributes.get("role") === "tab");
    expect(tabs().map((tab) => tab.textContent)).toEqual(["Steps", "Flowchart"]);
    tabs().find((tab) => tab.textContent === "Flowchart")?.listeners.get("click")?.(event);
    setFormats({ pseudocode: false, flowchart: false, initial: "flowchart" });
    const updatedTabs = renderChange(withVisual()).flatMap((card) => card.elements()).filter((node) => node.attributes.get("role") === "tab");
    expect(updatedTabs.map((tab) => tab.textContent)).toEqual(["Steps"]);
    expect(updatedTabs[0]!.attributes.get("aria-selected")).toBe("true");
    expect(messages).toEqual([]);
  });

  it("asks before explaining and posts only an explicit request", () => {
    const { renderChange, messages } = webviewHelpers();
    const nodes = renderChange(base).flatMap((node) => node.elements());
    expect(texts(renderChange(base))).toContain("This change has not been explained yet.");
    nodes.find((node) => node.textContent === "Explain changes")?.listeners.get("click")?.();
    expect(messages).toContainEqual({ type: "explainChanges" });
  });

  it("shows a saved result as text with host-owned links", () => {
    const { renderChange, messages } = webviewHelpers();
    const view: ChangeView = {
      ...base,
      status: "outdated",
      result: {
        summary: "<b>Retries</b> now.",
        changes: [{ title: "Retry", before: "No retry", after: "Retries twice", when: "On failure", flow: "", links: [{ referenceId: "ref-1", caption: "Modified lines 3–5" }] }],
        outside: "", possibleEffects: ["More load"], limitations: [], model: "m"
      }
    };
    const nodes = renderChange(view).flatMap((node) => node.elements());
    expect(texts(renderChange(view)).join(" ")).toContain("Outdated");
    expect(nodes.some((node) => node.tagName === "script" || node.tagName === "b")).toBe(false);
    nodes.find((node) => node.textContent === "Modified lines 3–5")?.listeners.get("click")?.(event);
    expect(messages).toContainEqual({ type: "navigate", referenceId: "ref-1" });
  });

  it("offers to try again when an attempt failed while an earlier result is still shown", () => {
    const { renderChange, messages } = webviewHelpers();
    const result = { summary: "Earlier result.", changes: [], outside: "", possibleEffects: [], limitations: [], model: "m" };
    const view: ChangeView = { ...base, status: "failed", message: "Rate limited", result };
    const nodes = renderChange(view).flatMap((node) => node.elements());
    expect(texts(renderChange(view))).toEqual(expect.arrayContaining(["Rate limited", "Earlier result."]));
    nodes.find((node) => node.textContent === "Try again")?.listeners.get("click")?.(event);
    expect(messages).toContainEqual({ type: "explainChanges" });
    const outdated = texts(renderChange({ ...view, result: { ...result, outdated: true } })).join(" ");
    expect(outdated).toContain("line links are hidden");
    expect(texts(renderChange({ ...view, canExplain: false }))).not.toContain("Try again");
  });

  it("shows loading and unavailable states without an explain button", () => {
    const { renderChange } = webviewHelpers();
    expect(texts(renderChange({ ...base, status: "loading", canExplain: false }))).toContain("Cancel");
    const unavailable = renderChange({ ...base, status: "unavailable", canExplain: false, message: "Binary file" });
    expect(texts(unavailable)).toContain("Binary file");
    expect(texts(unavailable)).not.toContain("Explain changes");
  });
});
