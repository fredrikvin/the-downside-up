import { describe, expect, it } from "vitest";
import type { ComparisonRecord, ReviewSummaryRecord } from "../src/core/types";
import { renderReviewExport } from "../src/presentation/reviewExport";

const coverage = { total: 1, included: 1, unavailable: 0, omitted: 0, lowValue: 0 };
const evidence = [{ id: "evidence-1", path: "src/main.ts", ref: {
  root: "/repo",
  original: { path: "src/main.ts", source: { kind: "revision" as const, hash: "a".repeat(40) } },
  modified: { path: "src/main.ts", source: { kind: "working" as const } }
} }];

function comparisonWith(text: string): ComparisonRecord {
  const visualSide = {
    presence: "present" as const,
    region: "",
    coverage: "whole function",
    flowchartStatus: "available" as const,
    flowchartReason: "",
    steps: [{ id: "step-1", text, startLine: 1, endLine: 1, occurrenceId: "occurrence-1" }],
    pseudocode: [{ id: "pseudo-1", text, depth: 0, startLine: 1, endLine: 1, occurrenceId: "occurrence-1" }],
    flowchart: {
      nodes: [
        { id: "model-start", kind: "start" as const, label: text, occurrenceId: "occurrence-1" },
        { id: "model-check", kind: "decision" as const, label: "Is it ready?", occurrenceId: "occurrence-1" }
      ],
      edges: [{ id: "edge-1", from: "model-start", to: "model-check", label: text }]
    }
  };
  const absentSide = {
    ...visualSide,
    presence: "absent" as const,
    flowchartStatus: "not-applicable" as const,
    steps: [],
    pseudocode: [],
    flowchart: { nodes: [], edges: [] }
  };
  return {
    catalogue: {
      version: 1, fingerprint: "catalogue", classified: true, limitations: [],
      entries: [{ id: "function-1", category: "added", name: "addedFunction", kind: "function" }]
    },
    original: { path: "src/main.ts", identity: `revision:${"a".repeat(40)}`, fingerprint: "original", lines: 1 },
    modified: { path: "src/main.ts", identity: "working", fingerprint: "modified", lines: 1 },
    comparison: {
      summary: text,
      added: [{ functionId: "function-1", summary: text }],
      removed: [],
      changes: [{ title: text, before: text, after: text, when: text, flow: text, original: { start: 1, end: 1 }, modified: { start: 1, end: 1 } }],
      visualScopes: [
        { id: "scope-1", title: text, original: visualSide, modified: visualSide, units: [], unitCorrespondences: [], edgeCorrespondences: [] },
        { id: "scope-2", title: "Added helper", original: absentSide, modified: visualSide, units: [], unitCorrespondences: [], edgeCorrespondences: [] }
      ],
      outside: text,
      possibleEffects: [text],
      limitations: [text]
    },
    provider: "vscode-lm",
    model: "test-model",
    promptVersion: "comparison-1",
    savedAt: 1
  };
}

function summaryWith(text: string): ReviewSummaryRecord {
  return {
    value: {
      summary: text,
      themes: [{ title: text, text, fileIds: ["evidence-1"] }],
      possibleEffects: [text],
      limitations: [text],
      diagram: {
        nodes: [
          { id: "model-id-a", label: text, fileIds: ["evidence-1"] },
          { id: "model-id-b", label: "service", fileIds: ["evidence-1"] }
        ],
        edges: [{ from: "model-id-a", to: "model-id-b", label: text }]
      }
    },
    provider: "vscode-lm",
    model: "overview-model",
    savedAt: 1,
    promptVersion: "review-summary-1",
    fingerprint: "summary",
    coverage,
    evidence
  };
}

describe("review export Markdown", () => {
  it("renders a deterministic export with host-owned Mermaid identifiers and saved explanations", () => {
    const data = {
      kind: "working" as const,
      base: "main",
      head: "b".repeat(40),
      summary: summaryWith("A contract change"),
      coverage,
      evidence,
      files: [{ path: "src/main.ts", status: "current" as const, comparison: comparisonWith("Saved comparison") }],
      exportedAt: 2
    };
    const output = renderReviewExport(data);
    expect(output).toBe(renderReviewExport(data));
    expect(output).toContain("## Summary\nA contract change");
    expect(output).toContain('n0["A contract change (src main.ts)"]');
    expect(output).toContain("n0 -->|A contract change| n1");
    expect(output).toContain("<summary>src&#47;main&#46;ts</summary>");
    expect(output).toContain("addedFunction&#58; Saved comparison");
    expect(output).toContain("<pre><code>Saved comparison</code></pre>");
    expect(output).toContain([
      "<details open>",
      "<summary>Steps</summary>",
      "",
      "<table>",
      "<thead><tr><th>Before</th><th>After</th></tr></thead>",
      "<tbody><tr>",
      '<td valign="top">',
      "",
      "<ol>\n<li>Saved comparison</li>\n</ol>"
    ].join("\n"));
    expect(output).toContain("<summary>Pseudocode</summary>");
    expect(output).toContain("<summary>Flowchart</summary>");
    expect(output).toContain('<td valign="top">\n\n<em>Not present</em>\n\n</td>');
    expect(output).toContain([
      "```mermaid",
      "flowchart TB",
      '  subgraph s0["Before"]',
      "    direction TB",
      '    b0(["Saved comparison"])',
      '    b1{"Is it ready?"}',
      "    b0 -->|Saved comparison| b1",
      "  end",
      '  subgraph s1["After"]'
    ].join("\n"));
    expect(output).toContain('    bx["Not present"]');
    expect(output).not.toContain("model-start");
    expect(output).toContain("- Low-value: 0");
    expect(output).toContain("- Overview model: overview&#45;model (vscode&#45;lm)");
    expect(output).toContain("- Functions model: test&#45;model (vscode&#45;lm)");
    expect(output).not.toContain("- Functions model: overview&#45;model");
  });

  it("keeps hostile model text, paths, and saved pseudocode inert", () => {
    const hostile = [
      "</summary><img src=x onerror=alert(1)>",
      "# injected heading\n[click](https://evil.test) https://evil.test",
      "reader@example.test @everyone ![image](https://evil.test/x)",
      "```mermaid\nclick n0 \"https://evil.test\"\n%%{init: {\"securityLevel\":\"loose\"}}",
      "</code></pre>"
    ].join("\n");
    const output = renderReviewExport({
      kind: "commit",
      base: "commit",
      commit: "c".repeat(40),
      parent: "none",
      summary: summaryWith(hostile),
      coverage,
      evidence: [{ ...evidence[0]!, path: "src/\n</summary><img>.ts" }],
      files: [{ path: "src/\n</summary><img>.ts", status: "current", comparison: comparisonWith(hostile) }],
      exportedAt: 2
    });

    expect(output).not.toContain("<img");
    expect(output).not.toContain("</summary><img");
    expect(output).not.toContain("https://evil.test");
    expect(output).not.toContain("reader@example.test");
    expect(output).not.toContain("```mermaid\nclick");
    expect(output).not.toContain("\n# injected heading");
    expect(output).toContain("&#60;&#47;summary&#62;&#60;img");
    expect(output).toContain("```mermaid\nflowchart LR");
    expect(output).toContain("<summary>src&#47; &#60;&#47;summary&#62;&#60;img&#62;&#46;ts</summary>");
    expect(output).toContain("&#60;&#47;code&#62;&#60;&#47;pre&#62;");
    expect(output).toContain("n0[\"");
    expect(output).not.toContain('\"model-id-a\"');
    expect(output).not.toContain("model-start");
    expect(output).not.toContain("%%");
    const diagrams = [...output.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(diagrams).toHaveLength(3);
    for (const diagram of diagrams) expect(diagram).not.toMatch(/^\s*(click|style|classDef|linkStyle)\b/m);
    expect(output).toMatch(/b0\(\["[^"\]\[<>{}%#&:\/@`]*"\]\)/);
  });

  it("explains low-value, missing, and outdated per-file entries", () => {
    const output = renderReviewExport({
      kind: "working",
      base: "main",
      head: "b".repeat(40),
      summary: summaryWith("A contract change"),
      coverage: { total: 3, included: 1, unavailable: 1, omitted: 0, lowValue: 1 },
      evidence,
      files: [
        { path: "src/main.ts", status: "current", comparison: comparisonWith("Saved comparison") },
        { path: "package-lock.json", status: "low-value", reason: "matched pattern package-lock.json" },
        { path: "src/old.ts", status: "outdated", reason: "the saved comparison is outdated" }
      ],
      exportedAt: 2
    });
    expect(output).toContain("matched pattern package&#45;lock&#46;json");
    expect(output).toContain("the saved comparison is outdated");
    expect(output).toContain("package&#45;lock&#46;json");
    expect(output).toContain("src&#47;old&#46;ts");
  });
});
