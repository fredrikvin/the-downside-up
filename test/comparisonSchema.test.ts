import { describe, expect, it } from "vitest";
import { parseComparison } from "../src/generation/schema";

describe("parseComparison", () => {
  const base = { summary: "Adds a retry.", outside: "", possibleEffects: ["More load"], limitations: [] };

  it("keeps valid changes and drops those without a title or behavior", () => {
    const parsed = parseComparison({
      ...base,
      changes: [
        { title: "Retry", before: "Fails at once", after: "Tries twice", when: "", flow: "", original: { startLine: 2, endLine: 4 }, modified: { startLine: 2, endLine: 9 } },
        { title: "", before: "x", after: "y", when: "", flow: "", original: { startLine: 1, endLine: 1 }, modified: { startLine: 1, endLine: 1 } },
        { title: "Empty", before: "", after: "", when: "", flow: "", original: { startLine: 1, endLine: 1 }, modified: { startLine: 1, endLine: 1 } },
        null
      ]
    });
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0]).toMatchObject({ title: "Retry", original: { start: 2, end: 4 }, modified: { start: 2, end: 9 } });
    expect(parsed.possibleEffects).toEqual(["More load"]);
  });

  it("treats malformed line spans as absent", () => {
    const parsed = parseComparison({
      ...base,
      changes: [{ title: "T", before: "a", after: "b", when: "", flow: "", original: { startLine: 5, endLine: 2 }, modified: { startLine: 0, endLine: 3 } }]
    });
    expect(parsed.changes[0]).toMatchObject({ original: { start: 0, end: 0 }, modified: { start: 0, end: 0 } });
  });
});
