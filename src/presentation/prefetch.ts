/** A function in the shown file that prefetching may explain. */
export interface PrefetchCandidate {
  readonly key: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nameLine: number;
}

/** Lines between the reading position and a function; 0 when the position is inside it. */
export function prefetchDistance(candidate: PrefetchCandidate, focusLine: number): number {
  if (focusLine < candidate.startLine) return candidate.startLine - focusLine;
  if (focusLine > candidate.endLine) return focusLine - candidate.endLine;
  return 0;
}

/**
 * Picks the next function to prefetch. The window is the `window` functions
 * nearest the reading position (every function when `window` is 0), so it
 * moves with the reader; the nearest one in it that is not done comes next.
 */
export function nextPrefetch<T extends PrefetchCandidate>(
  candidates: readonly T[],
  focusLine: number,
  window: number,
  done: ReadonlySet<string>
): T | undefined {
  const ordered = [...candidates].sort((left, right) =>
    prefetchDistance(left, focusLine) - prefetchDistance(right, focusLine) || left.nameLine - right.nameLine
  );
  const inWindow = window > 0 ? ordered.slice(0, window) : ordered;
  return inWindow.find((candidate) => !done.has(candidate.key));
}

/** The cursor line when it is on screen, otherwise the middle of the visible lines. */
export function prefetchFocusLine(
  cursorLine: number,
  visible: { readonly start: number; readonly end: number } | undefined
): number {
  if (!visible || (cursorLine >= visible.start && cursorLine <= visible.end)) return cursorLine;
  return Math.floor((visible.start + visible.end) / 2);
}
