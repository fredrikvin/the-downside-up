import type { ComparisonSourceRange } from "../core/types";
import type { ReviewSummaryPromptInput } from "../generation/provider";
import type { ComparisonSnapshot } from "./comparison";

export const CONTEXT_LINES = 3;
const ALIGNMENT_LOOKAHEAD = 64;

/** Retain the terminal empty line: adding/removing a final newline is an edit. */
export const comparisonSourceLines = (text: string): string[] => text ? text.split(/\r\n|\r|\n/) : [];
/** Legacy review-summary line counts; final newline is separate side metadata. */
export const sourceLines = (text: string): string[] => text ? text.replace(/\n$/, "").split("\n") : [];

interface Edit {
  readonly kind: " " | "-" | "+";
  readonly text: string;
}

/**
 * Bounded, language-neutral alignment. An unresolved replacement is retained
 * whole rather than guessed. The common suffix survives the lookahead bound.
 */
function align(before: readonly string[], after: readonly string[]): { edits: Edit[]; coarse: boolean } {
  const edits: Edit[] = [];
  let original = 0;
  let modified = 0;
  let endOriginal = before.length;
  let endModified = after.length;
  while (endOriginal > 0 && endModified > 0 && before[endOriginal - 1] === after[endModified - 1]) {
    endOriginal--;
    endModified--;
  }
  let coarse = false;
  const removeUntil = (end: number): void => {
    while (original < end) edits.push({ kind: "-", text: before[original++]! });
  };
  const addUntil = (end: number): void => {
    while (modified < end) edits.push({ kind: "+", text: after[modified++]! });
  };
  while (original < endOriginal || modified < endModified) {
    if (original < endOriginal && modified < endModified && before[original] === after[modified]) {
      edits.push({ kind: " ", text: before[original++]! });
      modified++;
      continue;
    }
    const next = new Map<string, number>();
    for (let index = modified; index < Math.min(endModified, modified + ALIGNMENT_LOOKAHEAD); index++) {
      if (!next.has(after[index]!)) next.set(after[index]!, index);
    }
    let anchor: { original: number; modified: number; distance: number } | undefined;
    for (let index = original; index < Math.min(endOriginal, original + ALIGNMENT_LOOKAHEAD); index++) {
      const match = next.get(before[index]!);
      if (match === undefined) continue;
      const distance = index - original + match - modified;
      if (!anchor || distance < anchor.distance) anchor = { original: index, modified: match, distance };
    }
    if (!anchor) {
      coarse = original < endOriginal && modified < endModified;
      removeUntil(endOriginal);
      addUntil(endModified);
      break;
    }
    removeUntil(anchor.original);
    addUntil(anchor.modified);
  }
  while (original < before.length && modified < after.length) {
    edits.push({ kind: " ", text: before[original++]! });
    modified++;
  }
  return { edits, coarse };
}

function hunkWindows(edits: readonly Edit[], context: number): ComparisonSourceRange[] {
  // Internal edit offsets are zero-based, end-exclusive.
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < edits.length; index++) {
    if (edits[index]!.kind === " ") continue;
    const start = Math.max(0, index - context);
    const end = Math.min(edits.length, index + context + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges;
}

/** Absolute, one-based inclusive ranges, including every changed line. */
export function sourceDiff(snapshot: ComparisonSnapshot): {
  original: ComparisonSourceRange[];
  modified: ComparisonSourceRange[];
  context: { original: ComparisonSourceRange[]; modified: ComparisonSourceRange[] };
  coarse: boolean;
} {
  const before = comparisonSourceLines(snapshot.original.text);
  const after = comparisonSourceLines(snapshot.modified.text);
  const { edits, coarse } = align(before, after);
  const project = (windows: readonly ComparisonSourceRange[]) => {
    const original: ComparisonSourceRange[] = [];
    const modified: ComparisonSourceRange[] = [];
    let oldLine = 0;
    let newLine = 0;
    let window = 0;
    const append = (ranges: ComparisonSourceRange[], line: number) => {
      const last = ranges[ranges.length - 1];
      if (last && last.end + 1 === line) ranges[ranges.length - 1] = { start: last.start, end: line };
      else ranges.push({ start: line, end: line });
    };
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]!;
      if (edit.kind !== "+") oldLine++;
      if (edit.kind !== "-") newLine++;
      while (window < windows.length && index >= windows[window]!.end) window++;
      if (window >= windows.length || index < windows[window]!.start) continue;
      if (edit.kind !== "+") append(original, oldLine);
      if (edit.kind !== "-") append(modified, newLine);
    }
    return { original, modified };
  };
  const mandatory = project(hunkWindows(edits, 0));
  const context = project(hunkWindows(edits, CONTEXT_LINES));
  return { ...mandatory, context, coarse };
}

/**
 * Review summaries retain their existing wire output exactly, including their
 * legacy terminal-newline handling (side metadata records finalNewline).
 */
export function sourceHunks(snapshot: ComparisonSnapshot): Pick<ReviewSummaryPromptInput["files"][number],
  "diff" | "contextLines" | "omittedContext" | "limitations"> {
  const before = sourceLines(snapshot.original.text);
  const after = sourceLines(snapshot.modified.text);
  const { edits, coarse } = align(before, after);
  const ranges = hunkWindows(edits, CONTEXT_LINES);
  if (!ranges.length && edits.length) ranges.push({ start: 0, end: Math.min(CONTEXT_LINES, edits.length) });
  let oldLine = 0;
  let newLine = 0;
  let includedOriginal = 0;
  let includedModified = 0;
  let cursor = 0;
  const hunks: string[] = [];
  for (const range of ranges) {
    while (cursor < range.start) {
      if (edits[cursor]!.kind !== "+") oldLine++;
      if (edits[cursor++]!.kind !== "-") newLine++;
    }
    const lines = edits.slice(range.start, range.end);
    const oldCount = lines.filter((line) => line.kind !== "+").length;
    const newCount = lines.filter((line) => line.kind !== "-").length;
    hunks.push(`@@ -${oldCount ? oldLine + 1 : oldLine},${oldCount} +${newCount ? newLine + 1 : newLine},${newCount} @@`);
    for (const line of lines) hunks.push(line.kind + line.text);
    includedOriginal += oldCount;
    includedModified += newCount;
    oldLine += oldCount;
    newLine += newCount;
    cursor = range.end;
  }
  const omittedContext = { original: before.length - includedOriginal, modified: after.length - includedModified };
  return {
    diff: hunks.join("\n"), contextLines: CONTEXT_LINES, omittedContext,
    limitations: [
      ...(omittedContext.original || omittedContext.modified
        ? [`Unchanged surrounding source omitted: ${omittedContext.original} original and ${omittedContext.modified} modified lines; at most ${CONTEXT_LINES} context lines per hunk edge.`] : []),
      ...(coarse ? ["Bounded diff alignment retained an entire replacement region; it may contain unchanged lines."] : [])
    ]
  };
}
