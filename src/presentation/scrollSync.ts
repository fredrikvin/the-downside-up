/** A rendered element in the preview tied to the first source line it describes. */
export interface ScrollAnchor {
  readonly line: number;
  readonly top: number;
}

/**
 * Maps a source line to a preview scroll offset by interpolating between the
 * nearest anchors, like VS Code's Markdown preview. Anchors must be sorted by
 * line and then by top. The document end is treated as a final anchor.
 *
 * This function is serialized into the webview, so it must stay self-contained.
 */
export function offsetForLine(
  anchors: readonly ScrollAnchor[],
  line: number,
  endLine: number,
  endTop: number
): number {
  let first = { line: 0, top: 0 };
  let last = first;
  let next = { line: Math.max(endLine, 1), top: endTop };
  for (const anchor of anchors) {
    if (anchor.line > line) {
      next = anchor;
      break;
    }
    if (anchor.line > last.line) {
      first = anchor;
      last = anchor;
    } else if (anchor.line === last.line) {
      last = anchor;
    }
  }
  // A line that starts several items aligns with the first; lines after it
  // interpolate from the last, so the mapping stays the inverse of lineForOffset.
  if (line <= last.line || next.line <= last.line) return Math.max(0, first.top);
  const progress = Math.min(1, Math.max(0, (line - last.line) / (next.line - last.line)));
  return Math.max(0, last.top + progress * (next.top - last.top));
}

/**
 * Keeps anchors (sorted by line, then top) whose tops never go up, so the
 * line-to-offset mapping stays monotonic even when items are laid out out of
 * source order, such as an early-exit flowchart node beside its decision.
 * Serialized into the webview, so it must stay self-contained.
 */
export function monotonicAnchors(anchors: readonly ScrollAnchor[]): ScrollAnchor[] {
  const kept: ScrollAnchor[] = [];
  let lastTop = Number.NEGATIVE_INFINITY;
  for (const anchor of anchors) {
    if (anchor.top < lastTop) continue;
    kept.push(anchor);
    lastTop = anchor.top;
  }
  return kept;
}

export interface LineRange {
  readonly id: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Returns the innermost (shortest) range containing the line. */
export function innermostRangeAt<T extends LineRange>(ranges: readonly T[], line: number): T | undefined {
  let best: T | undefined;
  for (const range of ranges) {
    if (range.startLine > line || range.endLine < line) continue;
    if (!best || range.endLine - range.startLine <= best.endLine - best.startLine) best = range;
  }
  return best;
}

/**
 * Inverse of `offsetForLine`: maps a preview scroll offset to a (fractional)
 * source line. Serialized into the webview, so it must stay self-contained.
 */
export function lineForOffset(
  anchors: readonly ScrollAnchor[],
  offset: number,
  endLine: number,
  endTop: number
): number {
  let previous = { line: 0, top: 0 };
  let next = { line: Math.max(endLine, 1), top: endTop };
  for (const anchor of anchors) {
    if (anchor.top <= offset) {
      if (anchor.line >= previous.line) previous = anchor;
    } else {
      next = anchor;
      break;
    }
  }
  if (next.top <= previous.top || next.line <= previous.line) return previous.line;
  const progress = Math.min(1, Math.max(0, (offset - previous.top) / (next.top - previous.top)));
  return previous.line + progress * (next.line - previous.line);
}
