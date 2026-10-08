import { describe, expect, it } from "vitest";
import type { FunctionExplanation } from "../src/core/types";
import { normalizeStepLines, numberLines, stepRanges, stepsAt } from "../src/presentation/stepLines";

const source = [
  "func checkout(catalog *Catalog, title string) (Book, error) {",
  "\tbook, ok := catalog.FindAvailable(title)",
  "\tif !ok {",
  "\t\treturn Book{}, errMissing",
  "\t}",
  "\tcatalog.MarkUnavailable(book.Title)",
  "\treturn book, nil",
  "}"
].join("\n");

function explanation(steps: Array<[number, number]>): FunctionExplanation {
  return {
    title: "Check out a book", purpose: "", inputs: [], result: "", notes: [], role: "", edgeCases: "", languageNotes: "", limitations: [],
    steps: steps.map(([startLine, endLine], index) => ({ title: `Step ${index}`, detail: "", startLine, endLine }))
  };
}

describe("step lines", () => {
  it("numbers source lines for the prompt", () => {
    expect(numberLines("a\nb").split("\n")).toEqual(["1| a", "2| b"]);
    expect(numberLines(source).split("\n")[7]).toBe("8| }");
  });

  it("keeps valid ranges with an anchor and drops invalid ones", () => {
    const normalized = normalizeStepLines(explanation([[2, 5], [6, 99], [0, 0], [9, 9], [5, 3]]), source).steps;
    expect(normalized.map((step) => [step.startLine, step.endLine, step.anchor])).toEqual([
      [2, 5, "book, ok := catalog.FindAvailable(title)"],
      [6, 8, "catalog.MarkUnavailable(book.Title)"],
      [0, 0, undefined],
      [0, 0, undefined],
      [0, 0, undefined]
    ]);
  });

  it("maps steps to document lines and follows lines that moved", () => {
    const steps = normalizeStepLines(explanation([[2, 5], [6, 7]]), source).steps;
    expect(stepRanges(steps, source, 20)).toEqual([{ start: 21, end: 24 }, { start: 25, end: 26 }]);

    const moved = source.replace("\tcatalog.MarkUnavailable", "\t// Mark it as taken.\n\tcatalog.MarkUnavailable");
    expect(stepRanges(steps, moved, 20)).toEqual([{ start: 21, end: 24 }, { start: 26, end: 27 }]);

    const rewritten = source.replace("catalog.FindAvailable(title)", "catalog.Find(title)");
    expect(stepRanges(steps, rewritten, 20)[0]).toBeUndefined();
  });

  it("finds steps under the cursor or a selection", () => {
    const ranges = [{ start: 21, end: 24 }, undefined, { start: 25, end: 26 }];
    expect(stepsAt(ranges, 22, 22)).toEqual([0]);
    expect(stepsAt(ranges, 24, 25)).toEqual([0, 2]);
    expect(stepsAt(ranges, 30, 30)).toEqual([]);
  });
});
