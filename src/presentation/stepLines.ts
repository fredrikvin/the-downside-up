import type { ExplanationStep, FunctionExplanation } from "../core/types";

/** Prefixes each source line with its 1-based number, as sent to the model. */
export function numberLines(source: string): string {
  const lines = source.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
}

/**
 * Checks model-provided step lines against the function source. Valid ranges
 * are clamped to the function and remember the text of their first line, so
 * they can be found again after lines shift; anything else becomes 0 (not
 * tied to lines).
 */
export function normalizeStepLines(explanation: FunctionExplanation, source: string): FunctionExplanation {
  const lines = source.split(/\r?\n/);
  const steps = explanation.steps.map((step): ExplanationStep => {
    const start = step.startLine;
    const end = Math.min(step.endLine, lines.length);
    const anchor = Number.isInteger(start) && start >= 1 && start <= lines.length ? lines[start - 1]!.trim() : "";
    if (!anchor || !Number.isInteger(end) || end < start) {
      const { anchor: _ignored, ...rest } = step;
      return { ...rest, startLine: 0, endLine: 0 };
    }
    return { ...step, startLine: start, endLine: end, anchor };
  });
  return { ...explanation, steps };
}

export interface StepRange {
  /** Zero-based document lines, inclusive. */
  readonly start: number;
  readonly end: number;
}

/**
 * Maps steps to document lines of the function as it is now. A step's first
 * line must still read the same; if it moved (for example after a comment
 * was added), the nearest line with that text is used, and the step has no
 * range when none is found.
 */
export function stepRanges(
  steps: readonly ExplanationStep[],
  currentSource: string,
  functionStartLine: number
): Array<StepRange | undefined> {
  const lines = currentSource.split(/\r?\n/).map((line) => line.trim());
  return steps.map((step) => {
    if (!step.anchor || step.startLine < 1) return undefined;
    const expected = step.startLine - 1;
    let found = lines[expected] === step.anchor ? expected : -1;
    for (let distance = 1; found < 0 && distance < lines.length; distance++) {
      if (lines[expected - distance] === step.anchor) found = expected - distance;
      else if (lines[expected + distance] === step.anchor) found = expected + distance;
    }
    if (found < 0) return undefined;
    const end = Math.min(lines.length - 1, found + (step.endLine - step.startLine));
    return { start: functionStartLine + found, end: functionStartLine + end };
  });
}

/**
 * Steps touched by the cursor or selection (inclusive lines). When no step
 * contains the cursor line, none is highlighted rather than guessing.
 */
export function stepsAt(ranges: ReadonlyArray<StepRange | undefined>, start: number, end: number): number[] {
  const hits: number[] = [];
  ranges.forEach((range, index) => {
    if (range && range.start <= end && range.end >= start) hits.push(index);
  });
  return hits;
}
