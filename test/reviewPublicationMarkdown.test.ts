import { describe, expect, it } from "vitest";
import type { ComparisonRecord, ReviewSummaryRecord } from "../src/core/types";
import type { ReviewExportData } from "../src/presentation/reviewExport";
import { renderReviewPublication } from "../src/presentation/reviewPublication";

const coverage = { total: 3, included: 1, unavailable: 1, omitted: 1, lowValue: 1 };
const evidence = [{
  id: "evidence-1",
  path: "src/main.ts",
  ref: {
    root: "/private/repository",
    original: { path: "src/main.ts", source: { kind: "revision" as const, hash: "a".repeat(40) } },
    modified: { path: "src/main.ts", source: { kind: "working" as const } }
  }
}];

function summaryRecord(text = "Safely updates the cache."): ReviewSummaryRecord {
  return {
    value: {
      summary: text,
      themes: [{ title: "Cache update", text: "The `cacheKey` keeps punctuation.", fileIds: ["evidence-1"] }],
      possibleEffects: ["May retry once."],
      limitations: ["The network result is not verified."],
      diagram: {
        nodes: [
          { id: "model-node", label: "Read input", fileIds: ["evidence-1"] },
          { id: "model-node-2", label: "Write cache", fileIds: [] }
        ],
        edges: [{ from: "model-node", to: "model-node-2", label: "success" }]
      }
    },
    provider: "vscode-lm",
    model: "test-model",
    savedAt: 10,
    promptVersion: "summary-1",
    fingerprint: "fingerprint",
    coverage,
    evidence
  };
}

function comparisonRecord(text = "Cache behavior changes."): ComparisonRecord {
  const visualSide = {
    presence: "present" as const,
    region: "12-20",
    coverage: "whole function",
    flowchartStatus: "available" as const,
    flowchartReason: "",
    steps: [{ id: "step", text: "Read the old cache", detail: "Before replacement.", startLine: 1, endLine: 2, occurrenceId: "occurrence" }],
    pseudocode: [{ id: "pseudo", text: "if (`ready`) return", depth: 0, startLine: 1, endLine: 2, occurrenceId: "occurrence" }],
    flowchart: {
      nodes: [{ id: "untrusted-node-id", kind: "start" as const, label: "Read input", occurrenceId: "occurrence" }],
      edges: []
    }
  };
  const afterSide = {
    ...visualSide,
    steps: [{ ...visualSide.steps[0]!, text: "Write the new cache", detail: "Only after validation." }],
    pseudocode: [{ ...visualSide.pseudocode[0]!, text: "write(cacheKey)" }],
    flowchart: {
      nodes: [{ id: "other-model-id", kind: "end" as const, label: "Write cache", occurrenceId: "occurrence" }],
      edges: []
    }
  };
  return {
    original: { path: "src/main.ts", identity: `revision:${"a".repeat(40)}`, fingerprint: "before", lines: 20 },
    modified: { path: "src/main.ts", identity: "working", fingerprint: "after", lines: 22 },
    comparison: {
      summary: text,
      added: [{ functionId: "fn-added", summary: "Adds a retry." }],
      removed: [],
      changes: [{
        functionId: "fn-changed",
        visualScopeId: "scope",
        title: "Retry behavior",
        before: "Errors stop immediately.",
        after: "Errors retry once.",
        when: "On timeout.",
        flow: "A retry path is added.",
        original: { start: 1, end: 2 },
        modified: { start: 1, end: 3 }
      }],
      visualScopes: [{
        id: "scope",
        functionId: "fn-changed",
        title: "Cache lookup",
        original: visualSide,
        modified: afterSide,
        units: [],
        unitCorrespondences: [],
        edgeCorrespondences: []
      }],
      outside: "The default timeout changes.",
      possibleEffects: ["A slow request can take longer."],
      limitations: ["Retries are not tested here."]
    },
    catalogue: {
      version: 1,
      fingerprint: "catalogue",
      classified: true,
      limitations: [],
      entries: [
        { id: "fn-added", category: "added", name: "refreshCache", kind: "function" },
        { id: "fn-changed", category: "changed", name: "Cache.lookup", kind: "method",
          original: { name: "lookup", qualifiedName: "Cache.lookup", signature: "lookup()", startLine: 0, endLine: 19,
            startColumn: 0, endColumn: 1, nameLine: 0, nameColumn: 0, fingerprint: "old" },
          modified: { name: "lookup", qualifiedName: "Cache.lookup", signature: "lookup()", startLine: 0, endLine: 21,
            startColumn: 0, endColumn: 1, nameLine: 0, nameColumn: 0, fingerprint: "new" } }
      ]
    },
    provider: "vscode-lm",
    model: "functions-model",
    promptVersion: "comparison-1",
    savedAt: 11
  };
}

function exportData(overrides: Partial<ReviewExportData> = {}): ReviewExportData {
  return {
    kind: "working",
    base: "main",
    head: "b".repeat(40),
    summary: summaryRecord(),
    coverage,
    evidence,
    files: [
      { path: "src/main.ts", status: "current", comparison: comparisonRecord() },
      { path: "src/old.ts", status: "outdated", reason: "Saved comparison is outdated." },
      { path: "vendor/library.ts", status: "low-value", comparison: comparisonRecord("Low-value comparison.") },
      { path: "src/missing.ts", status: "missing", reason: "No saved comparison." }
    ],
    exportedAt: 20,
    ...overrides
  };
}

describe("review publication Markdown", () => {
  it("keeps ordinary punctuation and safe inline code while neutralizing hostile Markdown", () => {
    const hostile = [
      "Use `--flag`, ``a`b``, and ``@build-bot`` safely.",
      "![image](https://evil.test/x) <img src=x onerror=alert(1)>",
      "@everyone reader@example.test https://evil.test www.evil.test ftp://ftp.evil.test example.com/path",
      "```mermaid\nclick n0 \"evil\"\n%%{init: {\"securityLevel\":\"loose\"}}",
      "\u202ehidden\u0000 text"
    ].join(" ");
    const publication = renderReviewPublication(exportData({ summary: summaryRecord(hostile) }));
    expect(publication.summary).toContain("## Review summary");
    expect(publication.summary).toContain("Use `--flag`, ``a`b``, and `＠build-bot` safely.");
    expect(publication.summary).toContain("\\!\\[image\\]\\(https&#58;//evil&#46;test/x\\)");
    expect(publication.summary).not.toContain("<img");
    expect(publication.summary).not.toContain("https://evil.test");
    expect(publication.summary).not.toContain("ftp://ftp.evil.test");
    expect(publication.summary).not.toContain("example.com/path");
    expect(publication.summary).not.toContain("@everyone");
    expect(publication.summary).not.toContain("reader@example.test");
    expect(publication.summary).not.toContain("@");
    expect(publication.summary).toContain("＠everyone");
    expect(publication.summary).not.toContain("```mermaid\nclick n0");
    expect(publication.summary).toContain("&#96;&#96;&#96;mermaid");
    expect(publication.summary).not.toContain("%%{init");
    expect(publication.summary).not.toMatch(/[\u202e\u0000]/);
    expect(publication.summary).toContain("safely.");
  });

  it("renders per-file comparisons vertically with separate saved side diagrams", () => {
    const publication = renderReviewPublication(exportData());
    const body = publication.files[0]!.body;
    expect(publication.files.map((file) => file.path)).toEqual(["src/main.ts", "vendor/library.ts"]);
    expect(body).toContain("**Before:** Errors stop immediately.");
    expect(body).toContain("**After:** Errors retry once.");
    expect(body.indexOf("**Before**")).toBeLessThan(body.indexOf("**After**"));
    expect(body).toContain("<summary>Pseudocode</summary>");
    expect(body).toContain("if (`ready`) return");
    expect(body).toContain("<summary>Flowchart</summary>");
    expect(body).toContain("flowchart TB");
    expect(body).toContain('n0(["Read input"])');
    expect(body).toContain('n0(["Write cache"])');
    expect(body).not.toContain("untrusted-node-id");
    expect(body).not.toContain("<table>");
    expect(body).toMatch(/^Cache behavior changes\.\n/);
    expect(body).not.toContain("## Cache behavior changes.");
    expect(body).not.toContain("<summary>Saved steps");
    expect(body).not.toContain("### Limitations");
    expect(body).not.toContain("Retries are not tested here.");
    expect(body.match(/<details>/g)).toHaveLength(3);
    expect(body).toContain("#### Execution detail: Cache lookup");
    expect(body).toContain("### `Cache.lookup`");
    expect(body).toContain("**Changed method** — Before lines 1-20; After lines 1-22.");
    expect(body).toContain("**Changed lines:** Before lines 1-2; After lines 1-3.");
    expect(body).not.toContain("<summary>Cache lookup</summary>");
    expect(body).toContain("<summary>Steps</summary>");
    let depth = 0;
    for (const tag of body.matchAll(/<\/?details>/g)) {
      depth += tag[0] === "<details>" ? 1 : -1;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    expect(body.indexOf('n0(["Read input"])')).toBeLessThan(body.indexOf('n0(["Write cache"])'));
  });

  it("neutralizes arbitrary mentions in file-comment prose and inline code", () => {
    const record = comparisonRecord();
    const scope = record.comparison.visualScopes![0]!;
    const mentionComparison: ComparisonRecord = {
      ...record,
      comparison: {
        ...record.comparison,
        changes: record.comparison.changes.map((change) => ({ ...change, before: "@reviewers" })),
        visualScopes: [{
          ...scope,
          original: {
            ...scope.original,
            pseudocode: scope.original.pseudocode.map((item) => ({ ...item, text: "notify @build-bot" }))
          }
        }]
      }
    };
    const body = renderReviewPublication(exportData({
      files: [{ path: "src/mentions.ts", status: "current", comparison: mentionComparison }]
    })).files[0]!.body;
    expect(body).not.toContain("@");
    expect(body).toContain("＠reviewers");
    expect(body).toContain("＠build-bot");
  });

  it("keeps each function's behavior changes and shared visuals together with unambiguous source labels", () => {
    const record = comparisonRecord();
    const firstScope = record.comparison.visualScopes![0]!;
    const change = record.comparison.changes[0]!;
    const secondFunction = { ...record.catalogue!.entries[1]!, id: "fn-second",
      name: "useCameraConfiguration.runConfigureMany" };
    const grouped: ComparisonRecord = {
      ...record, catalogue: { ...record.catalogue!, entries: [...record.catalogue!.entries, secondFunction] },
      comparison: { ...record.comparison, changes: [
        change,
        { ...change, title: "Record the failure", after: "Adds structured logging." },
        { ...change, functionId: secondFunction.id, visualScopeId: "scope-2", title: "Report bulk failures" }
      ], visualScopes: [
        firstScope,
        { ...firstScope, id: "scope-2", functionId: secondFunction.id, title: "Bulk configuration outcomes" }
      ] }
    };
    const body = renderReviewPublication(exportData({ files: [
      { path: "src/hooks.ts", status: "current", comparison: grouped }
    ] })).files[0]!.body;
    const firstStart = body.indexOf("### `Cache.lookup`");
    const secondStart = body.indexOf("### `useCameraConfiguration.runConfigureMany`");
    const first = body.slice(firstStart, secondStart);
    const second = body.slice(secondStart);
    expect(first).toContain("Retry behavior");
    expect(first).toContain("Record the failure");
    expect(first).toContain("Execution detail: Cache lookup");
    expect(first.match(/<summary>Steps<\/summary>/g)).toHaveLength(1);
    expect(first).not.toContain("Report bulk failures");
    expect(second).toContain("Report bulk failures");
    expect(second).toContain("Execution detail: Bulk configuration outcomes");
    expect(second).not.toContain("Record the failure");
    expect(body).toContain("</details>\n\n### `useCameraConfiguration.runConfigureMany`");
    expect(body).toContain("</details>\n\n### Other");
    expect(body).not.toMatch(/<\/details>\n#{1,6} /);
  });

  it("does not guess a function from generated titles when source ownership is unavailable", () => {
    const record = comparisonRecord();
    const unmapped: ComparisonRecord = { ...record, catalogue: undefined, comparison: {
      ...record.comparison, changes: record.comparison.changes.map((change) => ({
        ...change, functionId: undefined, original: { start: 0, end: 0 }, modified: { start: 999, end: 1000 }
      })),
      visualScopes: record.comparison.visualScopes!.map((scope) => ({ ...scope, functionId: undefined }))
    } };
    const body = renderReviewPublication(exportData({ files: [
      { path: "src/unknown.ts", status: "current", comparison: unmapped }
    ] })).files[0]!.body;
    expect(body).toContain("### Changes without a recorded function");
    expect(body).toContain("Added function (name unavailable):");
    expect(body).toContain("Adds a retry.");
    expect(body).toContain("Execution detail: Cache lookup");
    expect(body).not.toContain("### `Cache.lookup`");
    expect(body).not.toContain("Changed lines:");
    expect(body).not.toContain("999");
  });

  it("separates function payloads from file-wide context using only validated catalogue ranges", () => {
    const file = renderReviewPublication(exportData()).files[0]!;
    expect(file.functions.map((group) => group.id)).toEqual(["fn-added", "fn-changed"]);
    expect(file.functions[0]).toMatchObject({ category: "added" });
    expect(file.functions[0]!.modified).toBeUndefined();
    expect(file.functions[1]).toMatchObject({
      category: "changed", original: { start: 1, end: 20 }, modified: { start: 1, end: 22 }
    });
    expect(file.functions[1]!.body).toContain("**Before:** Errors stop immediately.");
    expect(file.functions[1]!.body).toContain("<summary>Flowchart</summary>");
    expect(file.functions[1]!.body).not.toContain("### Other\n");
    expect(file.overview).toContain("### Other\n\n");
    expect(file.overview).toContain("Possible effects");
    expect(file.overview).not.toContain("### `Cache.lookup`");
    const record = comparisonRecord();
    const invalid = { ...record, catalogue: { ...record.catalogue!, entries: record.catalogue!.entries.map((entry) => ({
      ...entry, modified: entry.modified ? { ...entry.modified, endLine: 999 } : undefined
    })) } };
    const fallback = renderReviewPublication(exportData({ files: [{ path: "a.ts", status: "current", comparison: invalid }] }));
    expect(fallback.files[0]!.functions[1]!.modified).toBeUndefined();
    const exclusive = { ...record, catalogue: { ...record.catalogue!, entries: record.catalogue!.entries.map((entry) => ({
      ...entry, modified: entry.modified ? { ...entry.modified, endLine: 20, endColumn: 0 } : undefined
    })) } };
    const bounded = renderReviewPublication(exportData({ files: [{ path: "a.ts", status: "current", comparison: exclusive }] }));
    expect(bounded.files[0]!.functions[1]!.modified).toEqual({ start: 1, end: 20 });
  });

  it("preserves validated API paths without repeating the filename in a wrapper", () => {
    const rawPath = "src/double  spaces\u00a0name.ts";
    const publication = renderReviewPublication(exportData({
      files: [{ path: rawPath, status: "current", comparison: comparisonRecord() }]
    }));
    expect(publication.files[0]!.path).toBe(rawPath);
    expect(publication.files[0]!.body).not.toContain("double");
    expect(publication.files[0]!.body).toContain("#### Execution detail: Cache lookup");
  });

  it("renders deep pseudocode indentation with safe list content, not Markdown code blocks", () => {
    const record = comparisonRecord();
    const scope = record.comparison.visualScopes![0]!;
    const deepComparison: ComparisonRecord = {
      ...record,
      comparison: {
        ...record.comparison,
        visualScopes: [{
          ...scope,
          original: {
            ...scope.original,
            pseudocode: scope.original.pseudocode.map((item) => ({ ...item, depth: 3 }))
          }
        }]
      }
    };
    const body = renderReviewPublication(exportData({
      files: [{ path: "src/deep.ts", status: "current", comparison: deepComparison }]
    })).files[0]!.body;
    expect(body).toContain("- &emsp;&emsp;&emsp;``if (`ready`) return``");
    expect(body).not.toContain("-       ");
  });

  it("omits unavailable format accordions while retaining the steps for that scope", () => {
    const record = comparisonRecord();
    const scope = record.comparison.visualScopes![0]!;
    const stepsOnly: ComparisonRecord = { ...record, comparison: { ...record.comparison, visualScopes: [{
      ...scope,
      original: { ...scope.original, pseudocode: [], flowchartStatus: "unavailable", flowchart: { nodes: [], edges: [] } },
      modified: { ...scope.modified, pseudocode: [], flowchartStatus: "unavailable", flowchart: { nodes: [], edges: [] } }
    }] } };
    const body = renderReviewPublication(exportData({ files: [
      { path: "src/main.ts", status: "current", comparison: stepsOnly }
    ] })).files[0]!.body;
    expect(body).toContain("#### Execution detail: Cache lookup");
    expect(body).toContain("<summary>Steps</summary>");
    expect(body).toContain("**Before**");
    expect(body).toContain("**After**");
    expect(body).not.toContain("<summary>Pseudocode</summary>");
    expect(body).not.toContain("<summary>Flowchart</summary>");
    expect(body.match(/<details>/g)).toHaveLength(1);
  });

  it("keeps summary context collapsed, discloses omitted records, and ignores export time", () => {
    const first = renderReviewPublication(exportData());
    const later = renderReviewPublication(exportData({ exportedAt: 999 }));
    expect(first).toEqual(later);
    const details = first.summary.indexOf("<details>");
    expect(first.summary).toContain("### Possible effects");
    expect(first.summary).toContain("### Review caveats");
    expect(first.summary).toContain("<summary>Review details</summary>");
    expect(first.summary).toContain("### Themes");
    expect(first.summary).toContain("### Affected parts");
    expect(first.summary.indexOf("### Themes")).toBeLessThan(first.summary.indexOf("### Affected parts"));
    expect(first.summary.indexOf("### Affected parts")).toBeLessThan(details);
    expect(first.summary.indexOf("### Possible effects")).toBeGreaterThan(details);
    expect(first.summary.indexOf("### Review caveats")).toBeGreaterThan(details);
    expect(first.summary.indexOf("src/old")).toBeGreaterThan(details);
    expect(first.summary.indexOf("test-model")).toBeGreaterThan(details);
    expect(first.summary).toContain("**Incomplete coverage:**");
    expect(first.summary).toContain("src/old&#46;ts");
    expect(first.summary).toContain("Saved comparison is outdated.");
    expect(first.summary).toContain("src/missing&#46;ts");
    expect(first.summary).not.toContain("/private/repository");
    expect(first.summary).not.toContain("## Commit");
    expect(first.files[1]!.body).toContain("Low-value file; excluded from summary evidence.");
  });

  it("omits empty sections and execution wrappers instead of emitting boilerplate", () => {
    const savedSummary = summaryRecord();
    const savedFile = comparisonRecord();
    const publication = renderReviewPublication(exportData({
      coverage: { total: 1, included: 1, unavailable: 0, omitted: 0, lowValue: 0 },
      summary: { ...savedSummary, value: { ...savedSummary.value, themes: [], possibleEffects: [], limitations: [], diagram: undefined } },
      files: [{ path: "src/main.ts", status: "current", comparison: {
        ...savedFile, comparison: { ...savedFile.comparison, possibleEffects: [], limitations: [], visualScopes: [] }
      } }]
    }));
    expect(publication.summary).not.toContain("### Themes");
    expect(publication.summary).not.toContain("### Affected parts");
    expect(publication.summary).not.toContain("### Possible effects");
    expect(publication.summary).not.toContain("### Review caveats");
    expect(publication.summary).not.toContain("Files without");
    expect(publication.summary).not.toContain("Incomplete coverage");
    expect(publication.summary).not.toContain("None recorded");
    expect(publication.files[0]!.body).not.toContain("<details>");
    expect(publication.files[0]!.body).not.toContain("Possible effects");
    expect(publication.files[0]!.body).not.toContain("Limitations");
    expect(publication.files[0]!.body).not.toContain("No saved execution details");
  });

  it("drops mechanical summary boilerplate but preserves substantive caveats in review details", () => {
    const saved = summaryRecord();
    const publication = renderReviewPublication(exportData({ summary: {
      ...saved, value: { ...saved.value, limitations: [
        "Grounded only in confirmed source diffs with bounded surrounding context; not proof of correctness or execution.",
        "Surrounding source is bounded: 100 unchanged lines were omitted.",
        "Bounded diff alignment retained replacement regions that may include unchanged lines.",
        "Only a test file changed; production behavior was not included."
      ] }
    } }));
    expect(publication.summary).not.toContain("Grounded only");
    expect(publication.summary).not.toContain("100 unchanged lines");
    expect(publication.summary).not.toContain("Bounded diff alignment");
    expect(publication.summary).toContain("Only a test file changed");
    expect(publication.summary.indexOf("Only a test file changed")).toBeGreaterThan(publication.summary.indexOf("<details>"));
  });

  it("rejects oversized UTF-8 summary and file bodies with actionable locations", () => {
    const largeText = "é".repeat(31_000);
    expect(() => renderReviewPublication(exportData({ summary: summaryRecord(largeText) })))
      .toThrow(/summary is .* UTF-8 bytes; the limit is 60000/);
    const largeComparison = comparisonRecord();
    const oversizedFile: ComparisonRecord = {
      ...largeComparison,
      comparison: { ...largeComparison.comparison, summary: largeText }
    };
    expect(() => renderReviewPublication(exportData({
      files: [{ path: "src/large.ts", status: "current", comparison: oversizedFile }]
    }))).toThrow(/file src\/large\.ts is .* UTF-8 bytes; the limit is 60000/);
  });
});
