import { describe, expect, it } from "vitest";
import type { FunctionExplanation } from "../src/core/types";
import { innermostAt, normalizeStepLines, numberLines, pseudocodeLayout, stepRanges, stepsAt } from "../src/presentation/stepLines";

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

  it("keeps anchors through spacing changes, but never collapses string contents", () => {
    const before = '  value = "two  spaces";';
    const steps = normalizeStepLines(explanation([[1, 1]]), before).steps;
    expect(stepRanges(steps, '    value  =  "two  spaces";', 0)).toEqual([{ start: 0, end: 0 }]);
    expect(stepRanges(steps, '    value  =  "two spaces";', 0)).toEqual([undefined]);
  });

  it("follows both ends of a linked range when blank lines are inserted inside it", () => {
    const before = "first();\nsecond();\nthird();";
    const steps = normalizeStepLines(explanation([[1, 3]]), before).steps;
    expect(stepRanges(steps, "first();\n\nsecond();\n\nthird();", 10)).toEqual([{ start: 10, end: 14 }]);
    expect(stepRanges(steps, "first();\nsecond();\nreplaced();", 10)).toEqual([undefined]);
  });
});

describe("cursor matching and pseudocode layout", () => {
  it("prefers the innermost items for a cursor", () => {
    const ranges = [{ start: 10, end: 20 }, { start: 14, end: 14 }, undefined, { start: 14, end: 14 }, { start: 12, end: 16 }];
    expect(innermostAt(ranges, 14)).toEqual([1, 3]);
    expect(innermostAt(ranges, 18)).toEqual([0]);
    expect(innermostAt(ranges, 30)).toEqual([]);
  });

  it("follows the code's indentation and blank lines", () => {
    const code = [
      "func getCamera() {",
      "\tresponse, err := get()",
      "\tif err != nil {",
      "\t\tlog(err)",
      "\t\treturn nil, ErrInternal",
      "\t}",
      "",
      "\tdefer close(response)",
      "",
      "\treturn convert(response), nil",
      "}"
    ];
    const ranges = [
      { start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 }, { start: 4, end: 4 },
      undefined, { start: 7, end: 7 }, { start: 9, end: 9 }
    ];
    const layout = pseudocodeLayout(ranges, [0, 0, 1, 1, 2, 0, 0], (line) => code[line] ?? "");
    expect(layout).toEqual([
      { level: 0, gap: false },
      { level: 0, gap: false },
      { level: 1, gap: false },
      { level: 1, gap: false },
      { level: 2, gap: false },
      { level: 0, gap: true },
      { level: 0, gap: true }
    ]);
    const spaces = pseudocodeLayout([{ start: 0, end: 0 }, { start: 1, end: 1 }], [0, 0], (line) => ["    a", "        b"][line]!);
    expect(spaces.map((entry) => entry.level)).toEqual([0, 1]);
  });
});
