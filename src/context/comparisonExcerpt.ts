import type { ComparisonContextRequest, ComparisonSourceRange } from "../core/types";
import type { ComparisonFunction } from "../languages/support";
import { MAX_SIDE_BYTES, type ComparisonSnapshot } from "./comparison";
import type { comparisonInventories } from "./comparisonFunctions";
import { comparisonSourceLines, sourceDiff } from "./sourceDiff";

export type ComparisonExcerpt = {
  original: readonly ComparisonSourceRange[];
  modified: readonly ComparisonSourceRange[];
  limitations: readonly string[];
};

type Inventories = Awaited<ReturnType<typeof comparisonInventories>>;
type Side = "original" | "modified";
type Fits = (ranges: ComparisonExcerpt) => boolean;
const SIDES = ["original", "modified"] as const;
const REQUEST_NOTICE = "Context requests:";
const CONTEXT_NOTICE = "Source context omitted:";
const PARTIAL_NOTICE = "Enclosing bodies, headers, and same-file signatures are optional and may be incomplete. Partial bodies do not establish complete behavior or safety. Call-like name matches are signature hints, not resolved dependencies; only supplied source can support behavior.";

interface Outcomes {
  invalid: number;
  absent: number;
  duplicate: number;
  budget: number;
  exact: number;
  supplied: number;
  excess: boolean;
}

const noRequests = (): Outcomes => ({
  invalid: 0, absent: 0, duplicate: 0, budget: 0, exact: 0, supplied: 0, excess: false
});

/**
 * Fixed-width bounded outcomes reserve room for declined requests from the
 * outset, without echoing untrusted model reasons. Each count is at most six.
 */
function requestNotice(result: Outcomes): string {
  return `${REQUEST_NOTICE} invalid=${result.invalid}; absent side=${result.absent}; duplicate/already supplied=${result.duplicate}; budget declined=${result.budget}; exact-range fallback=${result.exact}; supplied=${result.supplied}; beyond six=${result.excess ? "some" : "none"}. Only supplied source can support behavior.`;
}

function source(snapshot: ComparisonSnapshot): Record<Side, string[]> {
  for (const side of SIDES) {
    const value = snapshot[side];
    if (value.state !== "present" && value.state !== "absent") {
      throw new Error("Comparison excerpts require readable, authorized source snapshots.");
    }
    if ((value.state === "absent" && value.text !== "") || value.text.length > MAX_SIDE_BYTES ||
        Buffer.byteLength(value.text, "utf8") > MAX_SIDE_BYTES) {
      throw new Error("Comparison source exceeds the 256 KiB per-side snapshot limit.");
    }
  }
  return {
    original: comparisonSourceLines(snapshot.original.text),
    modified: comparisonSourceLines(snapshot.modified.text)
  };
}

function merge(ranges: readonly ComparisonSourceRange[]): ComparisonSourceRange[] {
  const result: ComparisonSourceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end + 1) {
      result[result.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else result.push({ start: range.start, end: range.end });
  }
  return result;
}

function included(ranges: readonly ComparisonSourceRange[], start: number, end: number): boolean {
  return ranges.some((range) => range.start <= start && end <= range.end);
}

function omitted(lines: Record<Side, readonly string[]>, excerpt: ComparisonExcerpt): Record<Side, number> {
  const count = (side: Side) => lines[side].length -
    merge(excerpt[side]).reduce((sum, range) => sum + range.end - range.start + 1, 0);
  return { original: count("original"), modified: count("modified") };
}

export function excerptOmitted(snapshot: ComparisonSnapshot, excerpt: ComparisonExcerpt): {
  original: number; modified: number;
} {
  return omitted(source(snapshot), excerpt);
}

function finish(
  lines: Record<Side, readonly string[]>, excerpt: ComparisonExcerpt, outcomes: Outcomes
): ComparisonExcerpt {
  const missing = omitted(lines, excerpt);
  const limitations = excerpt.limitations.filter((notice) =>
    !notice.startsWith(CONTEXT_NOTICE) && !notice.startsWith(REQUEST_NOTICE));
  return {
    original: excerpt.original, modified: excerpt.modified,
    limitations: [...new Set([
      ...limitations, PARTIAL_NOTICE,
      `${CONTEXT_NOTICE} ${missing.original} original and ${missing.modified} modified lines; only supplied source can support behavior.`,
      requestNotice(outcomes)
    ])]
  };
}

function withRange(excerpt: ComparisonExcerpt, side: Side, range: ComparisonSourceRange): ComparisonExcerpt {
  return { ...excerpt, [side]: merge([...excerpt[side], range]) };
}

function functionRange(entry: ComparisonFunction, length: number): ComparisonSourceRange | undefined {
  const start = entry.startLine + 1;
  const end = entry.endLine + 1;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && start <= end && end <= length
    ? { start, end } : undefined;
}

/** Greedily add optional source; every trial includes the exact final notices. */
export function buildComparisonExcerpt(
  snapshot: ComparisonSnapshot, inventories: Inventories, fits: Fits
): ComparisonExcerpt {
  const lines = source(snapshot);
  const diff = sourceDiff(snapshot);
  const outcomes = noRequests();
  let current = finish(lines, {
    original: diff.original, modified: diff.modified,
    limitations: [
      ...inventories.original.limitations, ...inventories.modified.limitations,
      ...(SIDES.some((side) => inventories[side].status !== "complete")
        ? ["Function discovery is incomplete; enclosing bodies and same-file signature hints may be unavailable. Only supplied source can support behavior."] : []),
      ...(diff.coarse
        ? ["Bounded diff alignment retained an entire replacement region, possibly including unchanged lines."] : [])
    ]
  }, outcomes);
  if (!fits(current)) {
    throw new Error("Changed source cannot fit within Max Request Size. Increase Max Request Size or compare a smaller change; no changed lines were dropped.");
  }
  const tryExcerpt = (candidate: ComparisonExcerpt): boolean => {
    const final = finish(lines, candidate, outcomes);
    if (!fits(final)) return false;
    current = final;
    return true;
  };

  // All hunk edges first. If they do not fit together, try each edge range
  // independently; the mandatory bare edits remain intact throughout.
  if (!tryExcerpt({ ...current, ...diff.context })) {
    for (const side of SIDES) {
      for (const range of diff.context[side]) tryExcerpt(withRange(current, side, range));
    }
  }

  // Use the full inventory, not just the semantically changed catalogue:
  // comment-only changes can be inside an otherwise unchanged function.
  for (const side of SIDES) {
    for (const entry of inventories[side].entries) {
      const range = functionRange(entry, lines[side].length);
      if (range && diff[side].some((edit) => edit.start <= range.end && range.start <= edit.end)) {
        tryExcerpt(withRange(current, side, range));
      }
    }
  }

  for (const side of SIDES) {
    let firstFunction = lines[side].length;
    for (const entry of inventories[side].entries) {
      if (functionRange(entry, lines[side].length)) firstFunction = Math.min(firstFunction, entry.startLine);
    }
    let bytes = 0;
    let end = 0;
    while (end < Math.min(80, firstFunction)) {
      const next = Buffer.byteLength(lines[side][end]!, "utf8") + (end ? 1 : 0);
      if (bytes + next > 8 * 1024) break;
      bytes += next;
      end++;
    }
    if (end) tryExcerpt(withRange(current, side, { start: 1, end }));
  }

  for (const side of SIDES) {
    const calls = new Set<string>();
    for (const range of diff[side]) {
      for (let index = range.start - 1; index < range.end; index++) {
        for (const match of lines[side][index]!.matchAll(/([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s*\(/gu)) {
          calls.add(match[1]!);
        }
      }
    }
    for (const entry of inventories[side].entries) {
      const range = functionRange(entry, lines[side].length);
      if (!range || !calls.has(entry.name) || !entry.signature) continue;
      // Discovered signatures are prefixes of their exact source. Never
      // fabricate source from a signature or infer a body boundary ourselves.
      const end = Math.min(range.end, range.start + comparisonSourceLines(entry.signature).length - 1);
      tryExcerpt(withRange(current, side, { start: range.start, end }));
    }
  }
  // No estimated token/byte fits: the caller serializes the final request.
  if (!fits(current)) throw new Error("Comparison exceeds Max Request Size; increase Max Request Size.");
  return current;
}

/** Model requests can add evidence, never subtract existing evidence. */
export function expandComparisonExcerpt(
  snapshot: ComparisonSnapshot, inventories: Inventories, current: ComparisonExcerpt,
  requests: readonly ComparisonContextRequest[], fits: Fits
): ComparisonExcerpt {
  const lines = source(snapshot);
  const outcomes = noRequests();
  outcomes.excess = requests.length > 6;
  let result = finish(lines, current, outcomes);
  const seen = new Set<string>();
  for (const request of requests.slice(0, 6)) {
    if (!request || !SIDES.includes(request.side) || !Number.isInteger(request.startLine) ||
        !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine ||
        request.endLine - request.startLine + 1 > 200 || typeof request.reason !== "string" || !request.reason.trim()) {
      outcomes.invalid++;
      continue;
    }
    const side = request.side;
    if (snapshot[side].state !== "present") {
      outcomes.absent++;
      continue;
    }
    if (request.endLine > lines[side].length) {
      outcomes.invalid++;
      continue;
    }
    const key = `${side}:${request.startLine}:${request.endLine}`;
    if (seen.has(key) || included(result[side], request.startLine, request.endLine)) {
      outcomes.duplicate++;
      continue;
    }
    seen.add(key);
    const exact = { start: request.startLine, end: request.endLine };
    const enclosing = inventories[side].entries
      .map((entry) => functionRange(entry, lines[side].length))
      .filter((range): range is ComparisonSourceRange =>
        Boolean(range && range.start <= exact.start && range.end >= exact.end))
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const accept = (range: ComparisonSourceRange, fallback: boolean): boolean => {
      const nextOutcomes = { ...outcomes, supplied: outcomes.supplied + 1, exact: outcomes.exact + (fallback ? 1 : 0) };
      const candidate = finish(lines, withRange(result, side, range), nextOutcomes);
      if (!fits(candidate)) return false;
      outcomes.supplied++;
      if (fallback) outcomes.exact++;
      result = candidate;
      return true;
    };
    if (enclosing && accept(enclosing, false)) continue;
    if (!accept(exact, Boolean(enclosing))) outcomes.budget++;
  }
  const final = finish(lines, result, outcomes);
  // Fixed-width notices keep declined/duplicate requests from consuming new
  // budget. The final callback still checks the exact serialized request.
  if (fits(final)) return final;
  // If the caller's budget changed while expanding, fall back to the existing
  // evidence and mark every attempted addition as declined. Never return an
  // unchecked request or silently lose previously supplied source.
  const fallback = finish(lines, current, {
    ...outcomes, supplied: 0, exact: 0, budget: outcomes.budget + outcomes.supplied
  });
  if (fits(fallback)) return fallback;
  throw new Error("Comparison context no longer fits Max Request Size. Increase Max Request Size or retry the comparison.");
}
