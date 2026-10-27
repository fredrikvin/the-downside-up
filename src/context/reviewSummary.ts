import { isAbsolute } from "node:path";
import { cacheKey, fingerprint } from "../core/fingerprint";
import type {
  ComparisonRecord, RepositoryCache, ReviewSummaryCoverage, ReviewSummaryEvidence, ReviewSummaryRecord
} from "../core/types";
import { COMPARISON_PROMPT_VERSION, REVIEW_SUMMARY_PROMPT_VERSION, reviewSummaryPrompt } from "../generation/prompts";
import type { ReviewSummaryPromptInput } from "../generation/provider";
import {
  MAX_CHANGED_FILES, comparisonProblem, snapshotSignature, sourceIdentity,
  type ComparisonRef, type ComparisonSnapshot
} from "./comparison";

export type { ReviewSummary, ReviewSummaryCoverage, ReviewSummaryEvidence, ReviewSummaryRecord } from "../core/types";

export interface ReviewSummaryScope {
  readonly kind: "working" | "commit";
  readonly base: string;
  readonly root: string;
  readonly items: readonly {
    readonly path: string;
    readonly ref: ComparisonRef;
    readonly confirmed: string;
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
  return cacheKey([scope.kind, scope.root, scope.base,
    ...scope.items.map((item) => JSON.stringify([item.path, ...refParts(item.ref)])).sort()]);
}

export function validateReviewSummaryScope(scope: ReviewSummaryScope): void {
  const path = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !isAbsolute(value) && !/[\\\x00-\x1f]/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
  if (!scope || !["working", "commit"].includes(scope.kind) || typeof scope.root !== "string" ||
      !isAbsolute(scope.root) || /[\x00-\x1f]/.test(scope.root) ||
      typeof scope.base !== "string" || !scope.base || scope.base.length > 256 ||
      /[\x00-\x1f]/.test(scope.base) || !Array.isArray(scope.items) || scope.items.length > MAX_CHANGED_FILES ||
      [scope.excluded, scope.skipped].some((count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000)) ||
      (scope.truncated !== undefined && typeof scope.truncated !== "boolean")) {
    throw new Error("The review summary scope is invalid or exceeds the 200-file limit.");
  }
  const seen = new Set<string>();
  for (const item of scope.items) {
    if (!item || !path(item.path) || !item.ref || item.ref.root !== scope.root ||
        typeof item.confirmed !== "string" || !item.confirmed || item.confirmed.length > 8192) {
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
  /** Compare these against the updater's cache under lock, never re-read the store there. */
  readonly consumed: readonly { readonly key: string; readonly fingerprint: string; readonly item: ReviewSummaryScope["items"][number] }[];
}

export const reviewEvidenceFingerprint = (record: ComparisonRecord): string => fingerprint(JSON.stringify(record));

/**
 * Cache-only evidence collection. A miss cannot explain a file, prime an overview,
 * or ask for consent. Whole saved explanations are selected in stable order.
 */
export async function buildReviewSummaryRequest(
  scope: ReviewSummaryScope,
  cache: RepositoryCache,
  functions: Descriptor,
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
  for (const item of items) {
    try {
      if (!(await allowed(item.ref))) continue;
      const snapshot = await read(item.ref);
      if (!reviewSnapshotMatches(item.ref, snapshot) || comparisonProblem(snapshot) ||
          snapshotSignature(snapshot) !== item.confirmed) continue;
      const key = reviewComparisonKey(snapshot, functions);
      const record = cache.comparisons?.[key];
      if (!record || !reviewComparisonCurrent(record, snapshot, functions)) continue;
      const id = `file-${cacheKey([...refParts(item.ref), item.confirmed])}`;
      const comparison = record.comparison;
      available.push({
        evidence: { id, path: item.path, ref: item.ref },
        consumed: { key, fingerprint: reviewEvidenceFingerprint(record), item },
        file: {
          id, path: item.path, summary: comparison.summary,
          added: (comparison.added ?? []).map((entry) => entry.summary),
          removed: (comparison.removed ?? []).map((entry) => entry.summary),
          changes: comparison.changes.map(({ title, before, after, when, flow }) => ({ title, before, after, when, flow })),
          outside: comparison.outside, possibleEffects: comparison.possibleEffects, limitations: comparison.limitations
        }
      });
    } catch {
      // Unreadable sources and malformed saved evidence count as unavailable, not invented evidence.
    }
  }
  const inputFor = (count: number): ReviewSummaryPromptInput => {
    const coverage = {
      total: items.length, included: count, unavailable: items.length - available.length, omitted: available.length - count
    };
    return {
      coverage,
      limitations: [
        "This synthesizes saved AI explanations, not source code or an independent review.",
        ...(coverage.unavailable ? [`${coverage.unavailable} confirmed files have no current usable saved comparison.`] : []),
        ...(coverage.omitted ? [`${coverage.omitted} available comparisons were omitted to fit the request limit.`] : []),
        ...(scope.excluded ? [`${scope.excluded} excluded files are outside the confirmed eligible set.`] : []),
        ...(scope.skipped ? [`${scope.skipped} skipped files are outside the confirmed eligible set.`] : []),
        ...(scope.truncated ? ["The changed-file listing was truncated; this is not complete change coverage."] : [])
      ],
      files: available.slice(0, count).map((entry) => entry.file)
    };
  };
  const size = (input: ReviewSummaryPromptInput) => Buffer.byteLength(reviewSummaryPrompt(input).join(""), "utf8");
  // At most 200 candidates. Descending selection accounts for changes in coverage metadata too.
  let count = available.length;
  while (count > 0 && size(inputFor(count)) > maxBytes) count--;
  const input = inputFor(count);
  const selected = available.slice(0, count);
  return {
    scopeKey, input, bytes: size(input), evidence: selected.map((entry) => entry.evidence),
    consumed: selected.map((entry) => entry.consumed),
    fingerprint: cacheKey([
      REVIEW_SUMMARY_PROMPT_VERSION, scopeKey,
      JSON.stringify(items.map((item) => [item.path, ...refParts(item.ref), item.confirmed])),
      JSON.stringify([scope.excluded ?? 0, scope.skipped ?? 0, scope.truncated ?? false]),
      JSON.stringify(functions), JSON.stringify(overview),
      String(maxBytes), JSON.stringify(input), ...selected.map((entry) => entry.consumed.fingerprint)
    ])
  };
}
