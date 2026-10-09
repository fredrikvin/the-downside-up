import type { FunctionExplanation, LineLinked } from "../core/types";

/** Prefixes each source line with its 1-based number, as sent to the model. */
export function numberLines(source: string): string {
  const lines = source.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
}

function normalizeItems<T extends LineLinked>(items: readonly T[], lines: readonly string[]): T[] {
  return items.map((item): T => {
    const start = item.startLine;
    const end = Math.min(item.endLine, lines.length);
    const anchor = Number.isInteger(start) && start >= 1 && start <= lines.length ? lines[start - 1]!.trim() : "";
    if (!anchor || !Number.isInteger(end) || end < start) {
      const { anchor: _ignored, ...rest } = item;
      return { ...rest, startLine: 0, endLine: 0 } as T;
    }
    return { ...item, startLine: start, endLine: end, anchor };
  });
}

/**
 * Checks model-provided lines of steps, pseudocode lines, and flowchart
 * nodes against the function source. Valid ranges are clamped to the
 * function and remember the text of their first line, so they can be found
 * again after lines shift; anything else becomes 0 (not tied to lines).
 */
export function normalizeStepLines<T extends Partial<Pick<FunctionExplanation, "steps" | "pseudocode" | "flowchart">>>(
  explanation: T,
  source: string
): T {
  const lines = source.split(/\r?\n/);
  return {
    ...explanation,
    ...(explanation.steps ? { steps: normalizeItems(explanation.steps, lines) } : {}),
    ...(explanation.pseudocode ? { pseudocode: normalizeItems(explanation.pseudocode, lines) } : {}),
    ...(explanation.flowchart
      ? { flowchart: { ...explanation.flowchart, nodes: normalizeItems(explanation.flowchart.nodes, lines) } }
      : {})
  };
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
  steps: readonly LineLinked[],
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

/**
 * For a cursor on one line: the items containing that line with the smallest
 * span, so a nested item wins over the broader ones around it.
 */
export function innermostAt(ranges: ReadonlyArray<StepRange | undefined>, line: number): number[] {
  let best = Number.POSITIVE_INFINITY;
  let hits: number[] = [];
  ranges.forEach((range, index) => {
    if (!range || range.start > line || range.end < line) return;
    const span = range.end - range.start;
    if (span < best) {
      best = span;
      hits = [index];
    } else if (span === best) {
      hits.push(index);
    }
  });
  return hits;
}

export interface PseudocodeLayout {
  /** Indentation level to show. */
  readonly level: number;
  /** Whether a blank line comes before it, as in the code. */
  readonly gap: boolean;
}

function indentWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    if (character === "\t") width += 4 - (width % 4);
    else if (character === " ") width++;
    else break;
  }
  return width;
}

/**
 * Lays pseudocode out like the code it describes. A linked line takes the
 * indentation of its first source line (ranked among the indentations used,
 * so tabs and spaces both work), and gets a gap where the code has a blank
 * line since the previous linked line. Unlinked lines keep the model's depth
 * relative to the line before them.
 */
export function pseudocodeLayout(
  ranges: ReadonlyArray<StepRange | undefined>,
  modelDepths: readonly number[],
  lineText: (line: number) => string
): PseudocodeLayout[] {
  const widths = ranges.map((range) => (range ? indentWidth(lineText(range.start)) : undefined));
  const levels = [...new Set(widths.filter((width): width is number => width !== undefined))].sort((left, right) => left - right);
  let previousEnd: number | undefined;
  let previousLevel: number | undefined;
  let previousDepth = 0;
  return ranges.map((range, index) => {
    const depth = Math.min(4, Math.max(0, modelDepths[index] ?? 0));
    let layout: PseudocodeLayout;
    if (!range) {
      layout = { level: previousLevel === undefined ? depth : Math.max(0, previousLevel + depth - previousDepth), gap: false };
    } else {
      let gap = false;
      if (previousEnd !== undefined) {
        for (let line = previousEnd + 1; line < range.start && !gap; line++) gap = lineText(line).trim() === "";
      }
      previousEnd = Math.max(previousEnd ?? range.end, range.end);
      layout = { level: levels.indexOf(widths[index]!), gap };
    }
    previousLevel = layout.level;
    previousDepth = depth;
    return { level: Math.min(6, layout.level), gap: layout.gap };
  });
}
