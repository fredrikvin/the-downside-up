/** A function in the shown file that prefetching may explain. */
export interface PrefetchCandidate {
  readonly key: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nameLine: number;
}

/** Lines between the reading position and a function; 0 when the position is inside it. */
export function prefetchDistance(candidate: Pick<PrefetchCandidate, "startLine" | "endLine">, focusLine: number): number {
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

/** A changed function waiting to be explained in review mode. */
export interface ReviewCandidate extends Omit<PrefetchCandidate, "key"> {
  /** Repository-relative path of its file. */
  readonly path: string;
}

/**
 * Picks the next changed function to explain: in the file being read, the
 * one nearest the reading position; otherwise the first one in diff order.
 * So jumping to a changed function that is still waiting moves it forward.
 */
export function nextReview<T extends ReviewCandidate>(
  pending: readonly T[],
  reading: { readonly path: string; readonly focusLine: number } | undefined
): T | undefined {
  const here = reading ? pending.filter((candidate) => candidate.path === reading.path) : [];
  if (reading && here.length) {
    return [...here].sort((left, right) =>
      prefetchDistance(left, reading.focusLine) - prefetchDistance(right, reading.focusLine) || left.nameLine - right.nameLine
    )[0];
  }
  return pending[0];
}
