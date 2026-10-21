import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/generation/mock";
import { parseComparison } from "../src/generation/schema";

describe("parseComparison", () => {
  const base = {
    summary: "Adds a retry.",
    outside: "",
    possibleEffects: ["More load"],
    limitations: []
  };
  const bounds = { originalLines: 8, modifiedLines: 10, originalPresent: true, modifiedPresent: true };

  function scope() {
    const side = (name: "original" | "modified", endLine: number) => ({
      presence: "present",
      region: "request handling",
      coverage: "The changed request path only.",
      flowchartStatus: "available",
      flowchartReason: "",
      steps: [{
        id: `${name}-step`,
        text: "Send the request",
        detail: "",
        depth: 0,
        occurrenceId: `${name}-occurrence`,
        startLine: 2,
        endLine
      }],
      pseudocode: [{
        id: `${name}-pseudo`,
        text: "send the request",
        detail: "",
        depth: 0,
        occurrenceId: `${name}-occurrence`,
        startLine: 2,
        endLine
      }],
      flowchart: {
        nodes: [
          { id: `${name}-start`, kind: "start", label: "Start", occurrenceId: `${name}-start-occurrence` },
          { id: `${name}-work`, kind: "action", label: "Send request", occurrenceId: `${name}-occurrence` }
        ],
        edges: [{ id: `${name}-edge`, from: `${name}-start`, to: `${name}-work`, label: "" }]
      }
    });
    return {
      id: "request",
      title: "Request behavior",
      original: side("original", 4),
      modified: side("modified", 6),
      units: [
        { id: "before-start", label: "Start", side: "original", occurrence: { id: "original-start-occurrence", startLine: 2, endLine: 4 } },
        { id: "before-request", label: "Send request", side: "original", occurrence: { id: "original-occurrence", startLine: 2, endLine: 4 } },
        { id: "after-start", label: "Start", side: "modified", occurrence: { id: "modified-start-occurrence", startLine: 2, endLine: 6 } },
        { id: "after-request", label: "Send request", side: "modified", occurrence: { id: "modified-occurrence", startLine: 2, endLine: 6 } }
      ],
      unitCorrespondences: [
        { originalUnitId: "before-start", modifiedUnitId: "after-start", meaning: "Entry point", difference: "" },
        { originalUnitId: "before-request", modifiedUnitId: "after-request", meaning: "Same request operation", difference: "The modified operation retries." }
      ],
      edgeCorrespondences: [{
        originalEdgeId: "original-edge",
        modifiedEdgeId: "modified-edge",
        meaning: "Entry into the request",
        difference: "The transition is preserved."
      }]
    };
  }

  function change(overrides: Record<string, unknown> = {}) {
    return {
      id: "retry",
      title: "Retry",
      before: "Fails at once",
      after: "Tries twice",
      when: "",
      flow: "",
      original: { startLine: 2, endLine: 4 },
      modified: { startLine: 2, endLine: 9 },
      visualScopeId: "request",
      ...overrides
    };
  }

  it("keeps valid textual changes and drops those without a title or behavior", () => {
    const parsed = parseComparison({
      ...base,
      changes: [
        change(),
        change({ id: "bad-title", title: "" }),
        change({ id: "empty", title: "Empty", before: "", after: "" }),
        null
      ],
      visualScopes: [scope()]
    }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0]).toMatchObject({
      id: "retry",
      title: "Retry",
      original: { start: 2, end: 4 },
      modified: { start: 2, end: 9 }
    });
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.possibleEffects).toEqual(["More load"]);
  });

  it("retains textual content and adds an explicit limitation when visual spans exceed that side", () => {
    const visual = scope();
    visual.modified.steps[0]!.endLine = 11;
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("paired visual comparison was omitted");
  });

  it("rejects non-one-to-one matching without losing valid side views", () => {
    const visual = scope();
    visual.units.push({
      id: "after-request-copy",
      label: "Retry request",
      side: "modified",
      occurrence: { id: "modified-occurrence-copy", startLine: 5, endLine: 6 }
    });
    visual.unitCorrespondences.push({
      originalUnitId: "before-request",
      modifiedUnitId: "after-request-copy",
      meaning: "Another match",
      difference: ""
    });
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.original.flowchart).toEqual(visual.original.flowchart);
    expect(parsed.visualScopes?.[0]?.unitCorrespondences).toEqual([]);
    expect(parsed.visualScopes?.[0]?.edgeCorrespondences).toEqual([]);
    expect(parsed.limitations.join(" ")).toContain("Unit correspondences must be one-to-one");
  });

  it("requires matched edges to connect explicitly corresponding operations", () => {
    const visual = scope();
    visual.modified.flowchart.edges[0]!.from = "modified-work";
    visual.modified.flowchart.edges[0]!.to = "modified-start";
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.edgeCorrespondences).toEqual([]);
    expect(parsed.visualScopes?.[0]?.unitCorrespondences).toEqual(visual.unitCorrespondences);
    expect(parsed.limitations.join(" ")).toContain("Corresponding edges do not connect corresponding operations");
    expect(parsed.changes).toHaveLength(1);
  });

  it("checks side membership and absent-side emptiness", () => {
    const visual = scope();
    visual.original.flowchart.nodes[0]!.occurrenceId = "modified-occurrence";
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.changes).toHaveLength(1);
  });

  it("represents an added file with an explicit empty original side", () => {
    const visual = scope();
    visual.original.presence = "absent";
    visual.original.region = "";
    visual.original.flowchartStatus = "not-applicable";
    visual.original.flowchartReason = "The file did not exist before.";
    visual.original.steps = [];
    visual.original.pseudocode = [];
    visual.original.flowchart = { nodes: [], edges: [] };
    visual.units = visual.units.filter((unit) => unit.side === "modified");
    visual.unitCorrespondences = [];
    visual.edgeCorrespondences = [];
    const parsed = parseComparison({
      ...base,
      changes: [change({ original: { startLine: 0, endLine: 0 } })],
      visualScopes: [visual]
    }, { originalLines: 0, modifiedLines: 10, originalPresent: false, modifiedPresent: true });
    expect(parsed.visualScopes?.[0]?.original).toMatchObject({
      presence: "absent",
      flowchartStatus: "not-applicable",
      flowchart: { nodes: [], edges: [] }
    });
  });

  it("enforces the whole-response chart budget", () => {
    const largeScope = scope();
    largeScope.original.flowchart.nodes = Array.from({ length: 24 }, (_, index) => ({
      id: `o-${index}`,
      kind: "action",
      label: "Operation",
      occurrenceId: "original-occurrence"
    }));
    largeScope.modified.flowchart.nodes = Array.from({ length: 24 }, (_, index) => ({
      id: `m-${index}`,
      kind: "action",
      label: "Operation",
      occurrenceId: "modified-occurrence"
    }));
    largeScope.original.flowchart.edges = [];
    largeScope.modified.flowchart.edges = [];
    const parsed = parseComparison({
      ...base,
      changes: [change()],
      visualScopes: Array.from({ length: 3 }, (_, index) => ({ ...largeScope, id: `scope-${index}` }))
    }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("safety limits");
  });

  it("enforces the total edge budget across scopes", () => {
    const scopes = Array.from({ length: 3 }, (_, scopeIndex) => {
      const visual = scope();
      visual.id = scopeIndex === 0 ? "request" : `request-${scopeIndex}`;
      for (const sideName of ["original", "modified"] as const) {
        const chart = visual[sideName].flowchart;
        const edge = chart.edges[0]!;
        chart.edges = Array.from({ length: 40 }, (_, index) => ({
          ...edge,
          id: `${sideName}-${scopeIndex}-${index}`
        }));
      }
      return visual;
    });
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: scopes }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("safety limits");
  });

  it("keeps valid charts when a change references an unknown visual scope", () => {
    const parsed = parseComparison({ ...base, changes: [change({ visualScopeId: "missing" })], visualScopes: [scope()] }, bounds);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0]?.visualScopeId).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("visual link was omitted");
  });

  it("keeps valid scopes when another scope fails and reports the exact validation reason", () => {
    const invalid = scope();
    invalid.id = "invalid-scope";
    invalid.modified.steps[0]!.endLine = 11;
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [invalid, scope()] }, bounds);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.id).toBe("request");
    expect(parsed.limitations.join(" ")).toContain("Visual scope 1 was omitted: A visual source span is outside its comparison side.");
  });

  it("still rejects unsafe source references and reports why", () => {
    const invalid = scope();
    invalid.original.flowchart.nodes[0]!.occurrenceId = "unknown-occurrence";
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [invalid] }, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("Flowchart node references an occurrence on the wrong side");
  });

  it("rejects duplicate scope identities rather than guessing the intended link", () => {
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [scope(), scope()] }, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("Duplicate comparison visual scope id");
  });

  it("keeps a textual comparison without visual data unchanged", () => {
    const parsed = parseComparison({ ...base, changes: [change({ visualScopeId: "" })], visualScopes: [] });
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations).toEqual([]);
  });

  it("emits the paired comparison contract from mock mode", async () => {
    const provider = new MockProvider();
    const result = await provider.explainComparison({
      repositoryName: "sample",
      languageId: "typescript",
      original: { path: "sample.ts", label: "Before", present: true, source: "old()" },
      modified: { path: "sample.ts", label: "After", present: true, source: "new()" }
    });
    expect(result.value.changes[0]).toMatchObject({ id: "mock-change", visualScopeId: "mock-scope" });
    expect(result.value.visualScopes?.[0]).toMatchObject({
      unitCorrespondences: [{ originalUnitId: "mock-before", modifiedUnitId: "mock-after" }],
      original: { presence: "present", flowchartStatus: "available" },
      modified: { presence: "present", flowchartStatus: "available" }
    });
  });
});
