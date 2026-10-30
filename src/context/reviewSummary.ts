import { isAbsolute } from "node:path";
import { validReviewPattern, type LowValueClassification } from "./reviewFilter";
import { cacheKey, fingerprint } from "../core/fingerprint";
import type {
  ComparisonRecord, RepositoryCache, ReviewSummaryCoverage, ReviewSummaryEvidence, ReviewSummaryRecord
} from "../core/types";
import { COMPARISON_PROMPT_VERSION, REVIEW_SUMMARY_PROMPT_VERSION, reviewSummaryPrompt } from "../generation/prompts";
import type { ReviewSummaryPromptInput } from "../generation/provider";
import {
  MAX_CHANGED_FILES, MAX_SIDE_BYTES, comparisonProblem, describeIdentity, snapshotSignature, sourceIdentity,
  type ComparisonRef, type ComparisonSnapshot
} from "./comparison";

export type { ReviewSummary, ReviewSummaryCoverage, ReviewSummaryEvidence, ReviewSummaryRecord } from "../core/types";

export interface ReviewSummaryScope {
  readonly kind: "working" | "commit";
  readonly base: string;
  readonly root: string;
  readonly filterFingerprint?: string;
  readonly items: readonly {
    readonly path: string;
    readonly ref: ComparisonRef;
    readonly confirmed: string;
    readonly lowValue?: LowValueClassification;
  }[];
  /** Files outside the confirmed eligible set; never counted as included evidence. */
  readonly excluded?: number;
  readonly skipped?: number;
  readonly truncated?: boolean;
}

export type ReviewSummaryRead = (ref: ComparisonRef) => Promise<ComparisonSnapshot>;

export interface PreparedReviewSummary {
  readonly scopeKey: string;
  readonly coverage: ReviewSummaryCoverage;
  /** Mapping for the displayed saved record, or the prospective request when none is saved. */
  readonly evidence: readonly ReviewSummaryEvidence[];
  readonly record?: ReviewSummaryRecord;
  readonly current: boolean;
  readonly canGenerate: boolean;
}

interface Descriptor {
  readonly kind: string;
  readonly modelId: string;
}

const refParts = (ref: ComparisonRef): string[] => [
  ref.root, ref.original.path, sourceIdentity(ref.original.source),
  ref.modified.path, sourceIdentity(ref.modified.source)
];

/** Source text is deliberately absent: this key retains an outdated saved summary. */
export function reviewSummaryScopeKey(scope: ReviewSummaryScope): string {
  validateReviewSummaryScope(scope);
  return cacheKey([scope.kind, scope.root, scope.base, scope.filterFingerprint ?? "",
    ...scope.items.map((item) => JSON.stringify([item.path, ...refParts(item.ref), item.lowValue ?? null])).sort()]);
}

export function validateReviewSummaryScope(scope: ReviewSummaryScope): void {
  const path = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !isAbsolute(value) && !/[\\\x00-\x1f]/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
  if (!scope || !["working", "commit"].includes(scope.kind) || typeof scope.root !== "string" ||
      !isAbsolute(scope.root) || /[\x00-\x1f]/.test(scope.root) ||
      typeof scope.base !== "string" || !scope.base || scope.base.length > 256 ||
      /[\x00-\x1f]/.test(scope.base) || !Array.isArray(scope.items) || scope.items.length > MAX_CHANGED_FILES ||
      [scope.excluded, scope.skipped].some((count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000)) ||
      (scope.truncated !== undefined && typeof scope.truncated !== "boolean") ||
      (scope.filterFingerprint !== undefined && (typeof scope.filterFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(scope.filterFingerprint)))) {
    throw new Error("The review summary scope is invalid or exceeds the 200-file limit.");
  }
  const seen = new Set<string>();
  for (const item of scope.items) {
    if (!item || !path(item.path) || !item.ref || item.ref.root !== scope.root ||
        typeof item.confirmed !== "string" || !item.confirmed || item.confirmed.length > 8192 ||
        (item.lowValue !== undefined && !validReviewPattern(item.lowValue?.pattern))) {
      throw new Error("The review summary contains an invalid confirmed file.");
    }
    for (const side of [item.ref.original, item.ref.modified]) {
      if (!side || !path(side.path) || !side.source || !["working", "index", "revision"].includes(side.source.kind) ||
          (side.source.kind === "revision" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(side.source.hash))) {
        throw new Error("The review summary contains an invalid comparison reference.");
      }
    }
    if ((item.path !== item.ref.original.path && item.path !== item.ref.modified.path) ||
        (scope.kind === "commit" && [item.ref.original, item.ref.modified].some((side) => side.source.kind !== "revision")) ||
        (scope.kind === "working" && item.ref.modified.source.kind !== "working")) {
      throw new Error("The review summary comparison does not match its scope.");
    }
    const key = JSON.stringify(refParts(item.ref));
    if (seen.has(key)) throw new Error("The review summary contains duplicate comparisons.");
    seen.add(key);
  }
}

export function reviewComparisonKey(snapshot: ComparisonSnapshot, descriptor: Descriptor): string {
  return cacheKey(["comparison", snapshot.original.identity, snapshot.original.path,
    snapshot.modified.identity, snapshot.modified.path, descriptor.kind, descriptor.modelId, COMPARISON_PROMPT_VERSION]);
}

/** Exact correspondence to a host-owned ref; never accept a reader's substituted file or side. */
export function reviewSnapshotMatches(ref: ComparisonRef, snapshot: ComparisonSnapshot): boolean {
  return snapshot.root === ref.root && (["original", "modified"] as const).every((name) =>
    snapshot[name].path === ref[name].path && snapshot[name].identity === sourceIdentity(ref[name].source));
}

export function reviewComparisonCurrent(record: ComparisonRecord, snapshot: ComparisonSnapshot, descriptor: Descriptor): boolean {
  return record.promptVersion === COMPARISON_PROMPT_VERSION && record.catalogue?.version === 1 &&
    record.provider === descriptor.kind && record.model === descriptor.modelId &&
    (["original", "modified"] as const).every((side) =>
      record[side].path === snapshot[side].path && record[side].identity === snapshot[side].identity &&
      record[side].fingerprint === snapshot[side].fingerprint && record[side].lines === snapshot[side].lines);
}

export interface ReviewSummaryRequest {
  readonly scopeKey: string;
  readonly fingerprint: string;
  readonly input: ReviewSummaryPromptInput;
  readonly bytes: number;
  readonly evidence: readonly ReviewSummaryEvidence[];
  /** Exact source signatures to revalidate before dispatch and under the persistence lock. */
  readonly consumed: readonly { readonly item: ReviewSummaryScope["items"][number] }[];
}

export const reviewEvidenceFingerprint = (record: ComparisonRecord): string => fingerprint(JSON.stringify(record));

const CONTEXT_LINES = 3;
const ALIGNMENT_LOOKAHEAD = 64;
const sourceLines = (text: string): string[] => text ? text.replace(/\n$/, "").split("\n") : [];

/**
 * Language-neutral, bounded line alignment. Every changed line is retained.
 * Nearby equal lines split replacement regions; when matching would require
 * unbounded searching, retain the entire unresolved region, never guess or
 * silently drop changes. This need not be a minimal diff to be exact evidence.
 */
function sourceHunks(snapshot: ComparisonSnapshot): Pick<ReviewSummaryPromptInput["files"][number],
  "diff" | "contextLines" | "omittedContext" | "limitations"> {
  const before = sourceLines(snapshot.original.text);
  const after = sourceLines(snapshot.modified.text);
  const edits: { readonly kind: " " | "-" | "+"; readonly text: string }[] = [];
  let original = 0;
  let modified = 0;
  let endOriginal = before.length;
  let endModified = after.length;
  // Keep the common suffix available even if a large replacement cannot align.
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
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < edits.length; index++) {
    if (edits[index]!.kind === " ") continue;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(edits.length, index + CONTEXT_LINES + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  // A rename-only or final-newline-only change still carries bounded source.
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

/**
 * Local source-only preparation. No comparison cache miss can explain a file,
 * prime an overview, or ask for consent. Select whole bounded diffs in stable
 * order, skipping oversized entries rather than starving smaller later files.
 * Cache/functions arguments are retained for existing callers, not consumed.
 */
export async function buildReviewSummaryRequest(
  scope: ReviewSummaryScope,
  _cache: RepositoryCache,
  _functions: Descriptor,
  overview: Descriptor,
  read: ReviewSummaryRead,
  allowed: (ref: ComparisonRef) => Promise<boolean>,
  maxBytes: number
): Promise<ReviewSummaryRequest> {
  const scopeKey = reviewSummaryScopeKey(scope);
  const available: {
    evidence: ReviewSummaryEvidence;
    file: ReviewSummaryPromptInput["files"][number];
    consumed: ReviewSummaryRequest["consumed"][number];
  }[] = [];
  const items = [...scope.items].sort((a, b) => {
    const left = JSON.stringify([a.path, ...refParts(a.ref)]);
    const right = JSON.stringify([b.path, ...refParts(b.ref)]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const lowValue = items.filter((item) => item.lowValue).length;
  for (const item of items) {
    if (item.lowValue) continue;
    try {
      if (!(await allowed(item.ref))) continue;
      const snapshot = await read(item.ref);
      if (!reviewSnapshotMatches(item.ref, snapshot) || comparisonProblem(snapshot) ||
          snapshotSignature(snapshot) !== item.confirmed ||
          [snapshot.original, snapshot.modified].some((side) => Buffer.byteLength(side.text, "utf8") > MAX_SIDE_BYTES)) continue;
      const id = `file-${cacheKey([...refParts(item.ref), item.confirmed])}`;
      const side = (name: "original" | "modified") => ({
        path: snapshot[name].path, label: describeIdentity(snapshot[name].identity),
        present: snapshot[name].state === "present", lines: sourceLines(snapshot[name].text).length,
        finalNewline: snapshot[name].text.endsWith("\n")
      });
      available.push({
        evidence: { id, path: item.path, ref: item.ref },
        consumed: { item },
        file: {
          id, path: item.path, original: side("original"), modified: side("modified"), ...sourceHunks(snapshot)
        }
      });
    } catch {
      // Unreadable sources count as unavailable, never invented evidence.
    }
  }
  const inputFor = (selected: typeof available): ReviewSummaryPromptInput => {
    const coverage = {
      total: items.length, included: selected.length, lowValue,
      unavailable: items.length - lowValue - available.length, omitted: available.length - selected.length
    };
    const bounded = selected.filter((entry) => entry.file.omittedContext.original || entry.file.omittedContext.modified);
    const coarse = selected.filter((entry) => entry.file.limitations.some((notice) => notice.startsWith("Bounded diff alignment")));
    return {
      coverage,
      limitations: [
        "Grounded only in confirmed source diffs with bounded surrounding context; not proof of correctness or execution.",
        ...(lowValue ? ["Low-value files remain in the confirmed review but are excluded from summary evidence."] : []),
        ...(bounded.length ? [`Surrounding source is bounded: ${bounded.length} included file diffs omit ${bounded.reduce((sum, entry) => sum + entry.file.omittedContext.original, 0)} original and ${bounded.reduce((sum, entry) => sum + entry.file.omittedContext.modified, 0)} modified unchanged lines; at most ${CONTEXT_LINES} context lines per hunk edge were supplied.`] : []),
        ...(coarse.length ? [`Bounded diff alignment retained replacement regions that may include unchanged lines in ${coarse.length} included file diffs.`] : []),
        ...(coverage.unavailable ? [`${coverage.unavailable} confirmed file diffs are unavailable, restricted, or no longer match their confirmed source.`] : []),
        ...(coverage.omitted ? [`${coverage.omitted} available file diffs were omitted whole to fit the request limit; included files retain all changes.`] : []),
        ...(scope.excluded ? [`${scope.excluded} excluded files are outside the confirmed eligible set.`] : []),
        ...(scope.skipped ? [`${scope.skipped} skipped files are outside the confirmed eligible set.`] : []),
        ...(scope.truncated ? ["The changed-file listing was truncated; this is not complete change coverage."] : [])
      ],
      files: selected.map((entry) => entry.file)
    };
  };
  const size = (input: ReviewSummaryPromptInput) => Buffer.byteLength(reviewSummaryPrompt(input).join(""), "utf8");
  const selected: typeof available = [];
  for (const candidate of available) {
    if (size(inputFor([...selected, candidate])) <= maxBytes) selected.push(candidate);
  }
  const input = inputFor(selected);
  return {
    scopeKey, input, bytes: size(input), evidence: selected.map((entry) => entry.evidence),
    consumed: selected.map((entry) => entry.consumed),
    fingerprint: cacheKey([
      REVIEW_SUMMARY_PROMPT_VERSION, scopeKey,
      JSON.stringify(items.map((item) => [item.path, ...refParts(item.ref), item.confirmed, item.lowValue ?? null])),
      JSON.stringify([scope.excluded ?? 0, scope.skipped ?? 0, scope.truncated ?? false]),
      JSON.stringify(overview), String(maxBytes), JSON.stringify(input)
    ])
  };
}
