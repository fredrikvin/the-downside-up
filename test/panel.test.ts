import { describe, expect, it, vi } from "vitest";
import { panelHtml, type ExplanationView, type PanelState, type Crumb } from "../src/presentation/panel";
import type { Flowchart } from "../src/core/types";

class TestElement {
  readonly children: Array<TestElement | string> = [];
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";
  id = "";
  title = "";
  hidden = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  constructor(readonly tagName: string) {}
  append(...children: Array<TestElement | string>): void { this.children.push(...children); }
  prepend(...children: Array<TestElement | string>): void { this.children.unshift(...children); }
  replaceChildren(...children: Array<TestElement | string>): void { this.children.splice(0, this.children.length, ...children); this.textContent = ""; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(): void {}
  elements(): TestElement[] {
    return [this, ...this.children.flatMap((child) => typeof child === "string" ? [] : child.elements())];
  }
}

function webviewHelpers() {
  const html = panelHtml("n");
  const start = html.indexOf('<script nonce="n">') + '<script nonce="n">'.length;
  const script = html.slice(start, html.indexOf("</script>", start));
  const elements = new Map<string, TestElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new TestElement("button"));
    return elements.get(id)!;
  };
  const helpers = new Function("acquireVsCodeApi", "document", "window", script + "\nreturn { layoutFlow, downwardPath, renderEntry, renderAiBody, missingFormat, renderHeader, renderCrumbs, renderActivity };")(
    () => ({ getState: () => ({}), postMessage: () => undefined }),
    {
      getElementById: element,
      createElement: (tag: string) => new TestElement(tag),
      createElementNS: (_ns: string, tag: string) => new TestElement(tag),
      createTextNode: (text: string) => text
    },
    { addEventListener: () => undefined }
  ) as {
    layoutFlow(chart: Flowchart, limit?: number): { rows: Flowchart["nodes"][]; back: Set<Flowchart["edges"][number]> };
    downwardPath(points: Array<{ x: number; y: number }>): string;
    renderEntry(entry: Record<string, unknown>, views: Map<string, ExplanationView>): TestElement;
    renderAiBody(view: ExplanationView): TestElement;
    missingFormat(view: ExplanationView, format: string): TestElement;
    renderHeader(state: Pick<PanelState, "models" | "provider" | "busy" | "hasRepository" | "stats" | "statsError">): void;
    renderCrumbs(crumbs: readonly Crumb[]): void;
    renderActivity(state: Pick<PanelState, "busy" | "notice" | "folder">): void;
  };
  return { ...helpers, element };
}

it("shows elapsed activity across updates and clears the timer when work stops", () => {
  vi.useFakeTimers();
  try {
    const { renderActivity, element } = webviewHelpers();
    renderActivity({ busy: true, notice: { tone: "progress", text: "Mapping the project…" } });
    expect(element("activity").hidden).toBe(false);
    expect(element("activityStage").textContent).toBe("Mapping the project…");
    vi.advanceTimersByTime(65_000);
    expect(element("activityTime").textContent).toContain("1:05 elapsed");
    renderActivity({ busy: true, notice: { tone: "progress", text: "Saving…" } });
    expect(element("activityStage").textContent).toBe("Saving…");
    vi.advanceTimersByTime(1000);
    expect(element("activityTime").textContent).toContain("1:06 elapsed");
    renderActivity({ busy: false });
    expect(element("activity").hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe("preview webview document", () => {
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
    for (const id of ["chooseModel", "chooseOverviewModel", "cancel", "refreshContext", "clearCache"]) {
      expect(html).toMatch(new RegExp('<button id="' + id + '"[^>]*type="button"[^>]*aria-label='));
    }
    expect(html).toContain('@container (max-width: 420px)');
    expect(html).toContain('.toolbar .btn-label { display: none; }');
    expect(html).toContain('class="tool-button danger"');
    expect(html).toContain('post({ type: "regenerateOutdated" })');
    expect(html).toContain('button.addEventListener("click", () => post({ type }))');
    expect(html.indexOf('<button id="chooseOverviewModel"')).toBeLessThan(html.indexOf('<button id="chooseModel"'));
    expect(html).toContain('background: transparent; border: 0;');
    expect(html).toContain('button:not(:disabled):is(:hover, :focus-visible, :active)');
  });

  it("shows both model roles, saved counts, scoped outdated status, and an explicit batch action", () => {
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
    expect(stats.map((node) => node.textContent)).toEqual(expect.arrayContaining(["12 explanations", "1 file summary", "2 folder summaries", "3 flow sets", "2 outdated in this file"]));
    expect(stats.find((node) => node.id === "regenerateOutdated")?.disabled).toBe(false);
    expect(element("stats").title).toContain("across all models");
    renderHeader({ ...base, models: { explanation: "Fast", overview: "Fast" }, busy: true, stats: { explanations: 1, fileSummaries: 0, folderSummaries: 0, flows: 0, outdatedHere: 1, scope: "folder" } });
    for (const id of ["chooseModel", "chooseOverviewModel"]) {
      expect(element(id).elements().find((node) => node.className === "model-name")?.textContent).toBe("Fast");
    }
    expect(element("stats").elements().find((node) => node.id === "regenerateOutdated")?.disabled).toBe(true);
    renderHeader({ ...base, stats: { explanations: 0, fileSummaries: 0, folderSummaries: 0, flows: 0, outdatedHere: 0, scope: "file" } });
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
    const { renderEntry } = webviewHelpers();
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
    const pending = renderEntry(entry, new Map([["f", loading]])).elements();
    expect(pending.filter((node) => node.className === "explain")).toEqual([]);
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
