import { describe, expect, it } from "vitest";
import { panelHtml, type ExplanationView } from "../src/presentation/panel";
import type { Flowchart } from "../src/core/types";

class TestElement {
  readonly children: Array<TestElement | string> = [];
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";
  id = "";
  readonly dataset: Record<string, string> = {};
  constructor(readonly tagName: string) {}
  append(...children: Array<TestElement | string>): void { this.children.push(...children); }
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
  return new Function("acquireVsCodeApi", "document", "window", script + "\nreturn { layoutFlow, downwardPath, renderEntry, renderAiBody, missingFormat };")(
    () => ({ getState: () => ({}), postMessage: () => undefined }),
    {
      getElementById: () => new TestElement("a"),
      createElement: (tag: string) => new TestElement(tag),
      createTextNode: (text: string) => text
    },
    { addEventListener: () => undefined }
  ) as {
    layoutFlow(chart: Flowchart, limit?: number): { rows: Flowchart["nodes"][]; back: Set<Flowchart["edges"][number]> };
    downwardPath(points: Array<{ x: number; y: number }>): string;
    renderEntry(entry: Record<string, unknown>, views: Map<string, ExplanationView>): TestElement;
    renderAiBody(view: ExplanationView): TestElement;
    missingFormat(view: ExplanationView, format: string): TestElement;
  };
}

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
