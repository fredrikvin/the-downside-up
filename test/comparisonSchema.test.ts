import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/generation/mock";
import { comparisonSchema, parseComparison } from "../src/generation/schema";
import { comparisonBounds as bounds, comparisonScope as scope, comparisonResponse } from "./comparisonFixture";
import { classifiedComparisonResponse, comparisonFunctionCatalogue as catalogue } from "./comparisonFixture";

describe("host catalogue response validation", () => {
  const checkedBounds = { ...bounds, catalogue };
  it("requires exact added/removed summary coverage and retains Changed function ownership", () => {
    const result = parseComparison(classifiedComparisonResponse(), checkedBounds);
    expect(result.added).toEqual([{ functionId: "added", summary: "Adds a helper." }]);
    expect(result.removed).toHaveLength(1);
    expect(result.changes[0]?.functionId).toBe("changed");
    expect(result.visualScopes?.[0]?.functionId).toBe("changed");
  });
  it.each(["missing", "duplicate", "unknown", "wrong-category", "empty", "long", "count"] as const)(
    "rejects %s summaries without inventing missing evidence", (bad) => {
      const response = classifiedComparisonResponse();
      if (bad === "missing") response.added = [];
      if (bad === "duplicate") response.added.push(response.added[0]!);
      if (bad === "unknown") response.added[0]!.functionId = "unknown";
      if (bad === "wrong-category") response.added[0]!.functionId = "removed";
      if (bad === "empty") response.added[0]!.summary = " ";
      if (bad === "long") response.added[0]!.summary = "x".repeat(601);
      if (bad === "count") response.added = Array.from({ length: 101 }, () => response.added[0]!);
      expect(() => parseComparison(response, checkedBounds)).toThrow();
    });
  it("rejects unknown or Added/Removed ids on Changed text and function-external evidence", () => {
    const response = classifiedComparisonResponse();
    response.changes[0]!.functionId = "added";
    expect(() => parseComparison(response, checkedBounds)).toThrow("Changed function id");
    response.changes[0]!.functionId = "changed";
    response.changes[0]!.original.startLine = 1;
    expect(() => parseComparison(response, checkedBounds)).toThrow("outside its function");
  });
  it("omits out-of-function, wrong-category and orphan visuals without losing independently valid text", () => {
    for (const bad of ["span", "id", "orphan"]) {
      const response = classifiedComparisonResponse();
      if (bad === "span") response.visualScopes[0]!.original.operations[0]!.startLine = 1;
      if (bad === "id") response.visualScopes[0]!.functionId = "removed";
      if (bad === "orphan") response.changes[0]!.visualScopeId = "";
      const parsed = parseComparison(response, checkedBounds);
      expect(parsed.changes).toHaveLength(1);
      expect(parsed.visualScopes).toBeUndefined();
      expect(parsed.limitations.length).toBeGreaterThan(0);
    }
  });
  it("allows no behavioral items for a signature-only change, while still requiring summaries", () => {
    const response = classifiedComparisonResponse();
    response.changes = [];
    response.visualScopes = [];
    expect(parseComparison(response, checkedBounds).changes).toEqual([]);
  });
  it("bounds aggregate text across summaries and visuals", () => {
    const response = { ...classifiedComparisonResponse(), extraneous: "x".repeat(80_001) };
    expect(() => parseComparison(response, checkedBounds)).toThrow("text budget");
  });
});

describe("parseComparison", () => {
  const base = {
    summary: "Adds a retry.",
    outside: "",
    possibleEffects: ["More load"],
    limitations: []
  };
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

  it("expands one operation table into linked views with host-owned side-specific ids", () => {
    const wire = comparisonResponse();
    const parsed = parseComparison(wire, bounds);
    const visual = parsed.visualScopes![0]!;
    const before = visual.units.find((unit) => unit.side === "original" && unit.label === "Send request")!;
    const after = visual.units.find((unit) => unit.side === "modified" && unit.label === "Send request")!;
    expect(before.id).not.toBe(after.id);
    expect(visual.original.steps[0]).toMatchObject({ occurrenceId: before.occurrence.id, startLine: 3, endLine: 4 });
    expect(visual.original.pseudocode[0]).toMatchObject({ occurrenceId: before.occurrence.id, startLine: 3, endLine: 4, depth: 0 });
    expect(visual.original.flowchart.nodes[1]).toMatchObject({ id: before.id, occurrenceId: before.occurrence.id });
    expect(visual.modified.steps[0]).toMatchObject({ occurrenceId: after.occurrence.id, startLine: 3, endLine: 6 });
    expect(visual.edgeCorrespondences[0]).toMatchObject({
      originalEdgeId: visual.original.flowchart.edges[0]!.id,
      modifiedEdgeId: visual.modified.flowchart.edges[0]!.id
    });
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(parsed).length * 0.8);
    const schema = JSON.stringify(comparisonSchema);
    expect(schema).toContain('"operations"');
    expect(schema).not.toMatch(/"occurrenceId"|"units"|"nodes"|"originalUnitId"/);
  });

  it("preserves explicit source ordering, indentation and loop edges independently", () => {
    const wire = comparisonResponse();
    const side = wire.visualScopes[0]!.original;
    side.operations.push({ id: "finish", label: "Finish", kind: "end", startLine: 6, endLine: 6 });
    side.pseudocode.push({ operation: "finish", text: "finish after the loop", depth: 1 });
    side.edges.push({ from: "send", to: "start", label: "retry" }, { from: "send", to: "finish", label: "done" });
    const parsed = parseComparison(wire, bounds).visualScopes![0]!;
    expect(parsed.original.pseudocode.map((line) => [line.text, line.startLine, line.depth])).toEqual([
      ["send the request", 3, 0], ["finish after the loop", 6, 1]
    ]);
    expect(parsed.original.flowchart.edges[1]).toMatchObject({
      from: parsed.original.flowchart.nodes[1]!.id, to: parsed.original.flowchart.nodes[0]!.id, label: "retry"
    });
  });

  it("never infers matching from equal operation ids or labels", () => {
    const wire = comparisonResponse();
    wire.visualScopes[0]!.operationMatches = [];
    wire.visualScopes[0]!.edgeMatches = [];
    const parsed = parseComparison(wire, bounds);
    expect(parsed.visualScopes?.[0]?.unitCorrespondences).toEqual([]);
    expect(parsed.visualScopes?.[0]?.edgeCorrespondences).toEqual([]);
    expect(parsed.limitations).toEqual([]);
  });

  it.each(["duplicate", "edge", "depth", "span", "kind"] as const)("rejects unsafe %s data rather than guessing", (bad) => {
    const wire = comparisonResponse();
    const side = wire.visualScopes[0]!.original;
    if (bad === "duplicate") side.operations[1]!.id = "start";
    if (bad === "edge") side.edges[0]!.to = "missing";
    if (bad === "depth") side.pseudocode[0]!.depth = 5;
    if (bad === "span") side.operations[0]!.startLine = 0;
    if (bad === "kind") side.operations[0]!.kind = "unknown";
    const parsed = parseComparison(wire, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("was omitted");
  });

  it("retains steps for an unavailable chart without inventing nodes", () => {
    const wire = comparisonResponse();
    const side = wire.visualScopes[0]!.original;
    side.flowchartStatus = "unavailable";
    side.flowchartReason = "The source has incomplete control flow.";
    side.operations.forEach((operation) => { operation.kind = "none"; });
    side.edges = [];
    wire.visualScopes[0]!.edgeMatches = [];
    const parsed = parseComparison(wire, bounds);
    expect(parsed.visualScopes?.[0]?.original.steps).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.original.flowchart).toEqual({ nodes: [], edges: [] });
  });

  it("rejects out-of-range edge matches without losing either graph", () => {
    const wire = comparisonResponse();
    wire.visualScopes[0]!.edgeMatches[0]!.modified = 1;
    const parsed = parseComparison(wire, bounds);
    expect(parsed.visualScopes?.[0]?.edgeCorrespondences).toEqual([]);
    expect(parsed.visualScopes?.[0]?.modified.flowchart.edges).toHaveLength(1);
    expect(parsed.limitations.join(" ")).toContain("unknown edge");
  });

  it("enforces the total expanded visual text budget", () => {
    const wire = comparisonResponse();
    wire.visualScopes = Array.from({ length: 12 }, (_, index) => {
      const visual = scope();
      visual.id = `scope-${index}`;
      visual.original.steps = Array.from({ length: 40 }, () => ({ operation: "send", text: "Send", detail: "x".repeat(500) }));
      return visual;
    });
    const parsed = parseComparison(wire, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("total budget");
  });

  it("enforces the per-side chart budget even when operations fit their own bound", () => {
    const wire = comparisonResponse();
    wire.visualScopes[0]!.original.operations.push(...Array.from({ length: 23 }, (_, index) => ({
      id: `extra-${index}`, kind: "action", label: "Operation", startLine: 3, endLine: 4
    })));
    const parsed = parseComparison(wire, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("per-side limit");
  });

  it("rejects any operation on an absent snapshot side", () => {
    const parsed = parseComparison(comparisonResponse(), { ...bounds, originalPresent: false, originalLines: 0 });
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("was omitted");
  });

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
    visual.modified.operations[1]!.endLine = 11;
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("paired visual comparison was omitted");
  });

  it("rejects non-one-to-one matching without losing valid side views", () => {
    const visual = scope();
    visual.modified.operations.push({ id: "copy", label: "Retry request", kind: "action", startLine: 5, endLine: 6 });
    visual.operationMatches.push({
      original: "send",
      modified: "copy",
      meaning: "Another match",
      difference: ""
    });
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.original.flowchart.nodes).toHaveLength(2);
    expect(parsed.visualScopes?.[0]?.unitCorrespondences).toEqual([]);
    expect(parsed.visualScopes?.[0]?.edgeCorrespondences).toEqual([]);
    expect(parsed.limitations.join(" ")).toContain("Unit correspondences must be one-to-one");
  });

  it("requires matched edges to connect explicitly corresponding operations", () => {
    const visual = scope();
    visual.modified.edges[0]!.from = "send";
    visual.modified.edges[0]!.to = "start";
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.edgeCorrespondences).toEqual([]);
    expect(parsed.visualScopes?.[0]?.unitCorrespondences).toHaveLength(2);
    expect(parsed.limitations.join(" ")).toContain("Corresponding edges do not connect corresponding operations");
    expect(parsed.changes).toHaveLength(1);
  });

  it("checks side membership and absent-side emptiness", () => {
    const visual = scope();
    visual.original.operations[1]!.id = "original-send";
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [visual] }, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.changes).toHaveLength(1);
  });

  it("represents an added file with an explicit empty original side", () => {
    const visual = scope();
    visual.original.region = "";
    visual.original.flowchartStatus = "not-applicable";
    visual.original.flowchartReason = "The file did not exist before.";
    visual.original.steps = [];
    visual.original.pseudocode = [];
    visual.original.operations = [];
    visual.original.edges = [];
    visual.operationMatches = [];
    visual.edgeMatches = [];
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
    for (const side of [largeScope.original, largeScope.modified]) {
      side.operations.push(...Array.from({ length: 22 }, (_, index) => ({
        id: `extra-${index}`, kind: "action", label: "Operation", startLine: 3, endLine: 4
      })));
    }
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
        const side = visual[sideName];
        side.edges = Array.from({ length: 40 }, () => ({ ...side.edges[0]! }));
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
    invalid.modified.operations[1]!.endLine = 11;
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [invalid, scope()] }, bounds);
    expect(parsed.visualScopes).toHaveLength(1);
    expect(parsed.visualScopes?.[0]?.id).toBe("request");
    expect(parsed.limitations.join(" ")).toContain("Visual scope 1 was omitted: A visual source span is outside its comparison side.");
  });

  it("still rejects unsafe source references and reports why", () => {
    const invalid = scope();
    invalid.original.steps[0]!.operation = "unknown-operation";
    const parsed = parseComparison({ ...base, changes: [change()], visualScopes: [invalid] }, bounds);
    expect(parsed.visualScopes).toBeUndefined();
    expect(parsed.limitations.join(" ")).toContain("Comparison text references an unknown operation on this side");
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
      original: { presence: "present", flowchartStatus: "available" },
      modified: { presence: "present", flowchartStatus: "available" }
    });
    expect(result.value.visualScopes?.[0]?.unitCorrespondences).toHaveLength(3);
  });
});
