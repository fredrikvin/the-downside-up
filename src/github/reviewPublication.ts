import { createHash } from "node:crypto";
import {
  commitDetails, comparisonProblem, pullRequestMergeBase, snapshotSignature,
  type ComparisonRef, type ComparisonSnapshot
} from "../context/comparison";
import { validateReviewSummaryScope, type ReviewSummaryRead, type ReviewSummaryScope } from "../context/reviewSummary";
import type { ReviewExportData } from "../presentation/reviewExport";
import { renderReviewPublication, type ReviewPublicationFile, type ReviewPublicationFunction } from "../presentation/reviewPublication";
import {
  GitHubClientError, PullRequestClient, pullRequestUrl, type GitHubComment, type GitHubDiffLine, type PullRequestRevision
} from "./client";

interface Marker {
  readonly target: string;
  readonly key: string;
  readonly base: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly hash: string;
  readonly state: "current" | "superseded";
  readonly function?: string;
  /** Never promote edited/legacy originals into deletion-eligible evidence. */
  readonly retained?: "unverified";
}

export interface PublicationPart {
  readonly action: "create" | "update" | "supersede" | "delete";
  readonly marker: string;
  readonly key: string;
  readonly path?: string;
  readonly anchor?: GitHubDiffLine;
  readonly body: string;
  readonly comment?: GitHubComment;
  readonly replacementKey?: string;
}

export interface PublicationOptions {
  readonly updateExisting?: boolean;
  readonly allowEdited?: boolean;
  /** Legacy create-only callers may skip discovery for freshness-only revalidation. */
  readonly checkDuplicates?: boolean;
}

export interface PreparedPublication {
  readonly revision: PullRequestRevision;
  readonly mergeBase: string;
  readonly account: string;
  readonly parts: readonly PublicationPart[];
  readonly existing: number;
  readonly edited: number;
  readonly allowEdited: boolean;
  readonly counts: { readonly create: number; readonly update: number; readonly supersede: number; readonly delete: number };
  readonly placement: { readonly inline: number; readonly fallback: number };
  readonly links: Readonly<Record<string, string>>;
  readonly contentFingerprint: string;
  readonly fingerprint: string;
}

/** Host callbacks may use this for controlled, actionable validation messages (never raw subprocess errors). */
export class PublicationValidationError extends Error {}
const PublicationError = PublicationValidationError;

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const targetIdentity = (client: PullRequestClient): string => digest([
  client.target.hostname, client.target.owner.toLowerCase(), client.target.repo.toLowerCase(), client.target.number
]);
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const markerText = (marker: Marker): string =>
  `<!-- downside-up-pr-v2:${Buffer.from(JSON.stringify(marker)).toString("base64url")} -->`;
const withMarker = (marker: Omit<Marker, "hash">, body: string): string => {
  const result = `${markerText({ ...marker, hash: digest(body) })}\n${body}`;
  if (Buffer.byteLength(result, "utf8") > 65_000) {
    throw new PublicationError("A publication comment exceeds GitHub's size limit. Use standalone export instead.");
  }
  return result;
};
const markerKey = (target: string, path?: string, functionId?: string): string => functionId === undefined
  ? digest([target, path === undefined ? "summary" : "file", path])
  : digest([target, "function", path, functionId]);

function parseMarker(body: string): { marker: Marker; content: string; edited: boolean } | undefined {
  const match = /^<!-- downside-up-pr-v2:([A-Za-z0-9_-]{1,2048}) -->\n/.exec(body);
  if (!match) return undefined;
  try {
    const marker = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as Marker;
    if (!marker || [marker.target, marker.key, marker.hash, marker.base, marker.head, marker.mergeBase, marker.state]
      .some((value) => typeof value !== "string") ||
        !HASH.test(marker.target) || !HASH.test(marker.key) || !HASH.test(marker.hash) ||
        !REVISION.test(marker.base) || !REVISION.test(marker.head) || !REVISION.test(marker.mergeBase) ||
        !["current", "superseded"].includes(marker.state) || markerText(marker) + "\n" !== match[0] ||
        (marker.retained !== undefined && marker.retained !== "unverified") ||
        (marker.function !== undefined && (typeof marker.function !== "string" || !HASH.test(marker.function))) ||
        Object.keys(marker).sort().join() !== ["base", "hash", "head", "key", "mergeBase", "state", "target",
          ...(marker.retained === undefined ? [] : ["retained"]),
          ...(marker.function === undefined ? [] : ["function"])].sort().join()) return undefined;
    const content = body.slice(match[0].length);
    return { marker, content, edited: digest(content) !== marker.hash };
  } catch { return undefined; }
}
const sameContent = (left: ComparisonSnapshot, right: ComparisonSnapshot): boolean =>
  (["original", "modified"] as const).every((side) =>
    left[side].path === right[side].path && left[side].state === right[side].state && left[side].text === right[side].text);

function functionAnchor(
  group: ReviewPublicationFunction, file: ReviewPublicationFile, lines: readonly GitHubDiffLine[]
): GitHubDiffLine | undefined {
  const side = group.category === "removed" ? "LEFT" : "RIGHT";
  const field = side === "RIGHT" ? "modified" : "original";
  const range = group[field];
  if (!range) return undefined;
  return lines.filter((candidate) => candidate.side === side &&
    candidate.line >= range.start && candidate.line <= range.end &&
    !file.functions.some((other) => {
      const nested = other[field];
      return other.id !== group.id && nested && nested.start >= range.start && nested.end <= range.end &&
        candidate.line >= nested.start && candidate.line <= nested.end;
    })).sort((a, b) => a.line - b.line)[0];
}

/** Working text (including buffers) must equal the exact published PR, not just its paths. */
export async function verifyPullRequestScope(
  scope: ReviewSummaryScope,
  revision: PullRequestRevision,
  read: ReviewSummaryRead,
  signal: AbortSignal
): Promise<string> {
  validateReviewSummaryScope(scope);
  if (scope.truncated) throw new PublicationError("A truncated review cannot be published. Confirm the full PR scope first.");
  const confirmedFiles = scope.changedFiles ?? (scope.excluded || scope.skipped ? [] : scope.items.map((item) => ({
    path: item.path, oldPath: item.ref.original.path !== item.path ? item.ref.original.path : undefined
  })));
  if (confirmedFiles.length !== revision.files.length || confirmedFiles.some((file) =>
    !revision.files.some((published) => published.path === file.path && published.oldPath === file.oldPath))) {
    throw new PublicationError("The confirmed review does not cover the PR file set. Confirm a review against the PR merge base first.");
  }
  signal.throwIfAborted();
  const mergeBase = await pullRequestMergeBase(scope.root, revision.base, revision.head);
  if (scope.kind === "working" && (await commitDetails(scope.root, "HEAD")).hash !== revision.head) {
    throw new PublicationError("Local HEAD does not match the PR head. Review the published PR revisions before publishing.");
  }
  const files = new Map(revision.files.map((file) => [file.path, file]));
  for (const item of scope.items) {
    signal.throwIfAborted();
    const file = files.get(item.path);
    if (!file || item.ref.original.path !== (file.oldPath ?? file.path) || item.ref.modified.path !== file.path ||
        item.ref.original.source.kind !== "revision" || item.ref.original.source.hash !== mergeBase ||
        (scope.kind === "commit" && (item.ref.modified.source.kind !== "revision" || item.ref.modified.source.hash !== revision.head))) {
      throw new PublicationError("A confirmed comparison does not match the PR merge base, head, or file paths. Confirm a review of the full PR comparison first.");
    }
    const immutable: ComparisonRef = { root: scope.root,
      original: { path: file.oldPath ?? file.path, source: { kind: "revision", hash: mergeBase } },
      modified: { path: file.path, source: { kind: "revision", hash: revision.head } } };
    const current = await read(item.ref);
    const published = await read(immutable);
    if (snapshotSignature(current) !== item.confirmed || comparisonProblem(current) || comparisonProblem(published) ||
        !sameContent(current, published)) {
      throw new PublicationError("Reviewed source differs from the published PR or is no longer available. Local and unsaved changes can be exported, but cannot be published as PR explanations.");
    }
  }
  signal.throwIfAborted();
  return mergeBase;
}

export async function preparePublication(
  client: PullRequestClient,
  scope: ReviewSummaryScope,
  data: ReviewExportData,
  read: ReviewSummaryRead,
  signal: AbortSignal,
  options: boolean | PublicationOptions = true
): Promise<PreparedPublication> {
  const settings = typeof options === "boolean" ? { checkDuplicates: options } : options;
  if (settings.updateExisting && settings.checkDuplicates === false) {
    throw new PublicationError("Updating a publication requires checking existing comments.");
  }
  const revision = await client.revision(signal);
  const mergeBase = await verifyPullRequestScope(scope, revision, read, signal);
  const account = await client.account(signal);
  const rendered = renderReviewPublication(data);
  const provenance = `\n\nReviewed PR: ${revision.head} against merge base ${mergeBase}.\n`;
  const identity = digest([client.target, revision.base, revision.head, mergeBase,
    scope.items.map((item) => [item.path, item.confirmed]).sort()]);
  if (rendered.files.length > scope.items.length || new Set(rendered.files.map((file) => file.path)).size !== rendered.files.length ||
      rendered.files.some((file) => !scope.items.some((item) => item.path === file.path))) {
    throw new PublicationError("Saved file explanations exceed the confirmed review scope.");
  }
  const target = targetIdentity(client);
  const summaryKey = markerKey(target);
  const placement = { inline: 0, fallback: 0 };
  const drafts: { path?: string; body: string; function?: string; anchor?: GitHubDiffLine }[] = [
    ...rendered.files.flatMap((file) => {
      const diffLines = revision.files.find((changed) => changed.path === file.path)?.diffLines ?? [];
      const groups = file.functions.map((group) => ({ group, anchor: functionAnchor(group, file, diffLines) }));
      const inline = groups.filter((group) => group.anchor);
      placement.inline += inline.length;
      placement.fallback += groups.length - inline.length;
      return [
        ...inline.map(({ group, anchor }) => ({
          path: file.path, body: group.body, function: digest(group.identity), anchor
        })),
        { path: file.path, body: inline.length
          ? [file.overview, ...groups.filter((group) => !group.anchor).map(({ group }) => group.body)].join("\n\n")
          : file.body }
      ];
    }),
    { body: rendered.summary + `\n\nPR files: ${revision.files.length}; confirmed files: ${scope.items.length}.` }
  ];
  const desired: PublicationPart[] = drafts.map((part) => {
    const path = part.path;
    const functionId = part.function;
    const key = markerKey(target, path, functionId);
    const body = withMarker({ target, key, base: revision.base, head: revision.head, mergeBase, state: "current",
      ...(functionId ? { function: functionId } : {}) },
      part.body + provenance);
    return { action: "create", ...(path ? { path } : {}),
      ...(part.anchor ? { anchor: part.anchor } : {}), key, marker: body.split("\n")[0]!, body };
  });
  const comments = settings.checkDuplicates !== false ? await client.comments(signal) : [];
  const owned = comments.flatMap<{
    comment: GitHubComment; marker: Marker | undefined; content: string; edited: boolean
  }>((comment) => {
    if (comment.author.toLowerCase() !== account.toLowerCase() || comment.replyTo) return [];
    const parsed = parseMarker(comment.body);
    if (comment.type === "file" && comment.subjectType === "line" && !parsed?.marker.function) return [];
    if (parsed && parsed.marker.target === target &&
        parsed.marker.key === markerKey(target, comment.path, parsed.marker.function) &&
        (parsed.marker.function === undefined || (comment.type === "file" && comment.subjectType === "line")) &&
        (comment.type !== "file" || parsed.marker.head === comment.originalHead)) {
      return [{ comment, ...parsed }];
    }
    if (/^<!-- downside-up-pr-v1:[a-f0-9]{64} -->\n/.test(comment.body)) {
      // v1 did not authenticate its body or carry a recoverable stable identity.
      // Discovery is allowed, but mutation always requires the edited-content confirmation.
      return [{ comment, marker: undefined, content: comment.body, edited: true }];
    }
    if (/^<!-- downside-up-pr-v[12]:/.test(comment.body) && !parsed) {
      throw new PublicationError("An existing publication marker is damaged or unsupported. Inspect the PR before publishing.");
    }
    return [];
  });
  const active = owned.filter((entry) => !entry.marker || entry.marker.state === "current");
  if (settings.updateExisting && active.filter((entry) => entry.comment.type === "summary").length > 1) {
    throw new PublicationError("Multiple existing review summaries are ambiguous. Inspect the PR before updating.");
  }
  const parts: PublicationPart[] = [];
  const links: Record<string, string> = {};
  const used = new Set<string>();
  const edited = new Set<string>();
  let existing = 0;
  for (let part of desired) {
    const legacyMarker = `<!-- downside-up-pr-v1:${digest([identity, part.path ?? "summary"])} -->`;
    const legacyBody = `${legacyMarker}\n${parseMarker(part.body)!.content}`;
    const matches = active.filter((entry) => {
      if (entry.comment.path !== part.path || (part.anchor
        ? entry.comment.subjectType !== "line" || entry.comment.line !== part.anchor.line || entry.comment.side !== part.anchor.side
        : entry.comment.subjectType === "line")) return false;
      if (settings.updateExisting && part.path === undefined) return true;
      return entry.marker
        ? entry.marker.key === part.key && entry.marker.base === revision.base &&
          entry.marker.head === revision.head && entry.marker.mergeBase === mergeBase &&
          (entry.comment.type !== "file" || entry.comment.head === revision.head)
        : entry.comment.body.startsWith(legacyMarker + "\n");
    });
    if (matches.length > 1) throw new PublicationError("Multiple existing comments have the same publication identity. Inspect the PR first.");
    const match = matches[0];
    if (!match) {
      parts.push(part);
      continue;
    }
    if (match.marker?.retained || (settings.updateExisting && match.edited)) {
      const parsed = parseMarker(part.body)!;
      const body = withMarker({ ...parsed.marker, retained: "unverified" }, parsed.content);
      part = { ...part, body, marker: body.split("\n")[0]! };
    }
    used.add(`${match.comment.type}:${match.comment.id}`);
    links[part.key] = match.comment.url;
    if (match.comment.body === part.body || (!settings.updateExisting && match.comment.body === legacyBody)) {
      existing++;
      continue;
    }
    if (!settings.updateExisting) {
      throw new PublicationError("A previously published comment has different content. Existing comments are never overwritten without an explicit update; inspect the PR first.");
    }
    if (match.edited) edited.add(`${match.comment.type}:${match.comment.id}`);
    parts.push({ ...part, action: "update", comment: match.comment });
  }
  if (settings.updateExisting) {
    for (const entry of owned) {
      if (entry.comment.type !== "file" || used.has(`file:${entry.comment.id}`)) continue;
      const canDelete = entry.marker && !entry.edited && !entry.marker.retained &&
        !comments.some((comment) => comment.type === "file" && comment.replyTo === entry.comment.id);
      if (!canDelete && entry.marker?.state === "superseded") continue;
      if (entry.edited) edited.add(`file:${entry.comment.id}`);
      const replacementKey = desired.find((part) => part.key === entry.marker?.key)?.key ??
        desired.find((part) => part.path === entry.comment.path && !part.anchor)?.key ?? summaryKey;
      parts.push({
        action: canDelete ? "delete" : "supersede", key: entry.marker?.key ?? markerKey(target, entry.comment.path), path: entry.comment.path,
        marker: entry.comment.body.split("\n")[0]!, body: entry.comment.body, comment: entry.comment, replacementKey
      });
    }
  }
  if (parts.length > 2200) throw new PublicationError("Too many publication writes. Inspect the existing PR discussions first.");
  const counts = {
    create: parts.filter((part) => part.action === "create").length,
    update: parts.filter((part) => part.action === "update").length,
    supersede: parts.filter((part) => part.action === "supersede").length,
    delete: parts.filter((part) => part.action === "delete").length
  };
  // Export time is presentation-only; the saved records, scope and exact inputs are not.
  const contentFingerprint = digest([
    client.target, revision, mergeBase, account.toLowerCase(), scope, { ...data, exportedAt: undefined }, desired
  ]);
  const prepared = { revision, mergeBase, account, parts, existing, edited: edited.size, allowEdited: settings.allowEdited === true,
    counts, placement, links, contentFingerprint,
    fingerprint: settings.updateExisting ? digest([contentFingerprint, parts]) : contentFingerprint };
  // Bound retirement bodies before any write, even when replacement IDs are not known yet.
  for (const part of parts.filter((candidate) => candidate.action === "supersede" || candidate.action === "delete")) {
    supersededBody(part, `${pullRequestUrl(client.target)}#discussion_r${Number.MAX_SAFE_INTEGER}`, prepared, target);
  }
  signal.throwIfAborted();
  return prepared;
}

function supersededBody(part: PublicationPart, replacement: string, prepared: PreparedPublication, target: string): string {
  const previous = parseMarker(part.body);
  const marker = previous?.marker ?? {
    target, key: part.key, base: prepared.revision.base,
    head: part.comment!.originalHead!, mergeBase: prepared.mergeBase
  };
  return withMarker({ ...marker, state: "superseded",
    ...(!previous || previous.edited ? { retained: "unverified" as const } : {})
  },
    (previous?.content ?? part.body) + `\n\n---\nSuperseded by [the current publication](${replacement}). ` +
    `This discussion is retained for its replies or unverified original content; it does not describe the current review.\n`);
}

/** Successful server acknowledgement is each write's commit point. Never retries or rolls back. */
export async function publishReview(
  client: PullRequestClient,
  prepared: PreparedPublication,
  revalidate: () => Promise<PreparedPublication>,
  signal: AbortSignal,
  report: (message: string) => void,
  beforePost?: () => Promise<void>
): Promise<void> {
  let posted = 0;
  let deleted = 0;
  let completed = 0;
  let posting: "publish" | "delete" | undefined;
  let operation: string | undefined;
  try {
    signal.throwIfAborted();
    if (prepared.edited && !prepared.allowEdited) {
      throw new PublicationError("Manually edited or legacy comments require separate explicit confirmation before updating.");
    }
    const latest = await revalidate();
    if (latest.fingerprint !== prepared.fingerprint) throw new PublicationError("The PR, review evidence, account, or sharing settings changed. Confirm publishing again.");
    const links = { ...latest.links };
    for (const [index, part] of prepared.parts.entries()) {
      signal.throwIfAborted();
      if (beforePost) await beforePost();
      else {
        const current = await revalidate();
        const remaining = prepared.parts.slice(index);
        // Create-only freshness checks may deliberately skip discovery and return all desired
        // creates, including already-confirmed/skipped parts. Still compare every remaining
        // identity and exact body. Update plans always require the complete residual plan.
        const pending = prepared.fingerprint === prepared.contentFingerprint &&
          current.fingerprint === current.contentFingerprint
          ? current.parts.filter((candidate) => remaining.some((part) => part.key === candidate.key))
          : current.parts;
        if (current.contentFingerprint !== prepared.contentFingerprint ||
            digest(pending) !== digest(remaining)) {
          throw new PublicationError("The PR, saved review evidence, or existing comments changed.");
        }
      }
      signal.throwIfAborted();
      const retiring = part.action === "supersede" || part.action === "delete";
      const replacement = retiring ? links[part.replacementKey!] : undefined;
      if (retiring && !replacement) {
        throw new PublicationError("A replacement comment could not be verified. No retirement was sent.");
      }
      const body = retiring
        ? supersededBody(part, replacement!, prepared, targetIdentity(client))
        : part.body;
      operation = `${part.action} for ${part.path ?? "review summary"}`;
      report(`${part.action === "create" ? "Publishing" : part.action === "update" ? "Updating" :
        part.action === "delete" ? "Deleting obsolete comment for" : "Superseding"} ` +
        `${part.path ?? "review summary"} (${index + 1}/${prepared.parts.length})`);
      if (part.action === "delete") {
        const parsed = parseMarker(part.body);
        const comment = part.comment;
        if (!comment || comment.body !== part.body || !parsed || parsed.edited || parsed.marker.retained ||
            parsed.marker.target !== targetIdentity(client) ||
            parsed.marker.key !== markerKey(targetIdentity(client), part.path, parsed.marker.function) ||
            comment.subjectType !== (parsed.marker.function ? "line" : "file") ||
            comment.path !== part.path || parsed.marker.head !== comment.originalHead) {
          throw new PublicationError("The obsolete comment's original content could not be verified. No deletion was sent.");
        }
        const result = await client.delete(comment, prepared.account, signal, () => { posting = "delete"; });
        posting = undefined;
        if (result === "deleted") { deleted++; completed++; continue; }
        // Replies arriving after confirmation downgrade retirement, never deletion.
        report(`Replies appeared for ${part.path}; retaining the discussion instead of deleting it.`);
        if (parsed.marker.state === "superseded") { completed++; continue; }
      }
      const receipt = part.action === "create"
        ? await client.post(body, prepared.revision.head, signal, part.path, () => { posting = "publish"; }, part.anchor)
        : await client.update(part.comment!, body, signal, () => { posting = "publish"; });
      posting = undefined;
      posted++;
      completed++;
      if (receipt.author.toLowerCase() !== prepared.account.toLowerCase()) {
        throw new PublicationError("The GitHub account changed during publication. Inspect the PR before continuing.");
      }
      if (!retiring) links[part.key] = receipt.url;
    }
    signal.throwIfAborted();
    const heads = await client.heads(signal);
    if (heads.base !== prepared.revision.base || heads.head !== prepared.revision.head) {
      throw new PublicationError("The PR moved during publication; comments describe the recorded older revision.");
    }
  } catch (error) {
    if (error instanceof GitHubClientError && error.rejected) posting = undefined;
    const reason = error instanceof PublicationError || error instanceof GitHubClientError ? error.message :
      signal.aborted ? "Publication was cancelled." : "Publication stopped because validation or a GitHub request failed.";
    throw new Error(`${reason}\n${operation ? `Stopped during ${operation}. ` : ""}${posted} comment(s) confirmed published to ${pullRequestUrl(client.target)}. ` +
      `${deleted} comment(s) confirmed deleted. ` +
      `${posting === "delete" ? "The last comment may also have been deleted. " :
        posting === "publish" ? "The last comment may also have been published. " : ""}` +
      `${completed < prepared.parts.length ? "Remaining comments were not sent. " : ""}No automatic retry or rollback was made.`);
  }
}
