import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fingerprint } from "../core/fingerprint";

/** The most text read from one side of a comparison. */
export const MAX_SIDE_BYTES = 256 * 1024;
/** The most changed files listed for one batch comparison. */
export const MAX_CHANGED_FILES = 200;

const GIT_TIMEOUT_MS = 10_000;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

/** What a side of a diff reads from. */
export type SideSource =
  | { readonly kind: "working" }
  | { readonly kind: "index" }
  | { readonly kind: "revision"; readonly hash: string };

export interface SideRef {
  /** Repository-relative path at this side, which differs between sides for a rename. */
  readonly path: string;
  readonly source: SideSource;
}

/** The exact pair of documents a diff shows. */
export interface ComparisonRef {
  readonly root: string;
  readonly original: SideRef;
  readonly modified: SideRef;
}

export type SideState = "present" | "absent" | "unreadable" | "binary" | "oversized" | "excluded";

export interface SideSnapshot {
  readonly path: string;
  /** `working`, `index`, or `revision:<hash>`. */
  readonly identity: string;
  readonly state: SideState;
  /** Why the side could not be read, in plain words; empty for present and absent sides. */
  readonly detail: string;
  /** Empty unless the side is present. */
  readonly text: string;
  /**
   * Exact fingerprint of `text`, empty unless the side is present. Unlike a
   * function's fingerprint it changes with formatting too, since evidence
   * links name absolute lines of this text.
   */
  readonly fingerprint: string;
  readonly lines: number;
}

export interface ComparisonSnapshot {
  readonly root: string;
  readonly original: SideSnapshot;
  readonly modified: SideSnapshot;
}

export interface SnapshotOptions {
  /** Unsaved editor text by absolute path; the working-tree side reads from it before disk. */
  readonly buffers?: ReadonlyMap<string, string>;
  /** Why a file may not be shared, or undefined. Checked for both sides, including historical paths. */
  readonly exclusion?: (root: string, absolutePath: string) => Promise<string | undefined>;
  readonly maxBytes?: number;
}

/** The parts of a document URI the resolver needs. */
export interface DiffUri {
  readonly scheme: string;
  readonly fsPath: string;
  readonly query: string;
}

export type Resolution = { readonly ref: ComparisonRef } | { readonly unsupported: string };

export function sourceIdentity(source: SideSource): string {
  return source.kind === "revision" ? `revision:${source.hash}` : source.kind;
}

/** Plain words for a side's identity, such as "the committed version (1a2b3c4)". */
export function describeIdentity(identity: string): string {
  if (identity === "working") return "the working tree, including unsaved edits";
  if (identity === "index") return "the staged version";
  return identity.startsWith("revision:") ? `the committed version (${identity.slice(9, 16)})` : identity;
}

interface GitResult {
  readonly stdout: Buffer;
}

function git(root: string, args: readonly string[], maxBytes = MAX_LISTING_BYTES): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      ["-C", root, "-c", "core.quotePath=false", ...args],
      {
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: maxBytes,
        windowsHide: true,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" }
      },
      (error, stdout) => (error ? reject(error) : resolveResult({ stdout }))
    );
  });
}

const gitText = async (root: string, args: readonly string[]): Promise<string> =>
  (await git(root, args)).stdout.toString("utf8");

const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,200}$/;
// Git's object IDs for the empty tree, including repositories using SHA-256.
const EMPTY_TREES = ["sha1", "sha256"].map((algorithm) => createHash(algorithm).update("tree 0\0").digest("hex"));

async function resolveRevision(root: string, revision: string): Promise<string | undefined> {
  // A root comparison can name the empty tree even before Git has stored that object.
  if (EMPTY_TREES.includes(revision)) return revision;
  if (!SAFE_REVISION.test(revision)) return undefined;
  try {
    const hash = (await gitText(root, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).trim();
    return /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

function repositoryPath(root: string, fsPath: string): string | undefined {
  const rel = relative(root, fsPath);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
}

/** The scheme of an empty document standing in for a missing side of an added or deleted file. */
export const EMPTY_SCHEME = "downside-up-empty";

async function sideFromUri(root: string, uri: DiffUri): Promise<SideRef | string> {
  if (uri.scheme === EMPTY_SCHEME) {
    // The query names the revision the file is absent from; without one the file is absent from the working tree.
    const path = repositoryPath(root, uri.fsPath);
    if (!path) return "A file outside the repository cannot be explained.";
    if (!uri.query) return { path, source: { kind: "working" } };
    const hash = await resolveRevision(root, uri.query);
    return hash ? { path, source: { kind: "revision", hash } } : `The Git revision "${uri.query}" could not be resolved.`;
  }
  if (uri.scheme === "file") {
    const path = repositoryPath(root, uri.fsPath);
    return path ? { path, source: { kind: "working" } } : "A file outside the repository cannot be explained.";
  }
  if (uri.scheme !== "git") return `Comparing ${uri.scheme} documents is not supported yet; only local Git changes are.`;
  let query: { path?: unknown; ref?: unknown };
  try {
    query = JSON.parse(uri.query || "{}") as typeof query;
  } catch {
    return "This Git document could not be identified.";
  }
  const path = repositoryPath(root, typeof query.path === "string" ? query.path : uri.fsPath);
  if (!path) return "A file outside the repository cannot be explained.";
  const ref = typeof query.ref === "string" ? query.ref : "";
  if (ref === "") return { path, source: { kind: "index" } };
  // The Git extension's "~" means the index when the file is staged and HEAD otherwise.
  if (ref === "~") {
    const staged = await gitText(root, ["diff", "--cached", "--name-only", "-z", "--", path]).catch(() => "");
    if (staged) return { path, source: { kind: "index" } };
  }
  const hash = await resolveRevision(root, ref === "~" ? "HEAD" : ref);
  return hash ? { path, source: { kind: "revision", hash } } : `The Git revision "${ref}" could not be resolved.`;
}

/** Resolves the original and modified documents of a native diff, or says why they are not supported. */
export async function resolveNativeDiff(root: string, original: DiffUri, modified: DiffUri): Promise<Resolution> {
  const [originalSide, modifiedSide] = await Promise.all([sideFromUri(root, original), sideFromUri(root, modified)]);
  if (typeof originalSide === "string") return { unsupported: originalSide };
  if (typeof modifiedSide === "string") return { unsupported: modifiedSide };
  return { ref: { root, original: originalSide, modified: modifiedSide } };
}

interface Blob {
  readonly hash: string;
  readonly size: number;
}

type Located = { readonly blob: Blob } | { readonly state: "absent" | "unreadable"; readonly detail: string };

async function locate(root: string, source: SideSource, path: string): Promise<Located> {
  if (source.kind === "revision") {
    if (EMPTY_TREES.includes(source.hash)) return { state: "absent", detail: "" };
    const entry = (await gitText(root, ["ls-tree", "-l", "-z", source.hash, "--", path])).split("\0")[0];
    if (!entry) return { state: "absent", detail: "" };
    const [meta] = entry.split("\t");
    const [, type, hash, size] = (meta ?? "").split(/\s+/);
    if (type !== "blob" || !hash) return { state: "unreadable", detail: "it is not an ordinary file" };
    return { blob: { hash, size: Number(size) } };
  }
  const entry = (await gitText(root, ["ls-files", "-s", "-z", "--", path])).split("\0")[0];
  if (!entry) return { state: "absent", detail: "" };
  const [meta] = entry.split("\t");
  const [mode, hash, stage] = (meta ?? "").split(/\s+/);
  if (stage !== "0") return { state: "unreadable", detail: "it has unresolved merge conflicts" };
  if (!hash || mode === "160000") return { state: "unreadable", detail: "it is not an ordinary file" };
  const size = Number((await gitText(root, ["cat-file", "-s", hash])).trim());
  return { blob: { hash, size } };
}

const hasBinaryMarker = (bytes: Buffer): boolean => bytes.subarray(0, 8_000).includes(0);

function fingerprinted(path: string, identity: string, text: string): SideSnapshot {
  return {
    path, identity, state: "present", detail: "", text,
    fingerprint: fingerprint(text),
    lines: text === "" ? 0 : text.split(/\r?\n/).length
  };
}

async function readSide(root: string, side: SideRef, options: SnapshotOptions): Promise<SideSnapshot> {
  const identity = sourceIdentity(side.source);
  const absolute = join(root, ...side.path.split("/"));
  const empty = (state: SideState, detail = ""): SideSnapshot => ({ path: side.path, identity, state, detail, text: "", fingerprint: "", lines: 0 });
  const maxBytes = options.maxBytes ?? MAX_SIDE_BYTES;
  const reason = await options.exclusion?.(root, absolute);
  if (reason) return empty("excluded", reason);
  try {
    if (side.source.kind === "working") {
      const buffered = options.buffers?.get(absolute);
      if (buffered !== undefined) {
        return Buffer.byteLength(buffered, "utf8") > maxBytes ? empty("oversized", "it is too large") : fingerprinted(side.path, identity, buffered);
      }
      const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : Promise.reject(error));
      if (!info) return empty("absent");
      if (!info.isFile()) return empty("unreadable", "it is not an ordinary file");
      if (info.size > maxBytes) return empty("oversized", "it is too large");
      const bytes = await readFile(absolute);
      return hasBinaryMarker(bytes) ? empty("binary", "it is a binary file") : fingerprinted(side.path, identity, bytes.toString("utf8"));
    }
    const located = await locate(root, side.source, side.path);
    if ("state" in located) return empty(located.state, located.detail);
    if (!Number.isFinite(located.blob.size) || located.blob.size > maxBytes) return empty("oversized", "it is too large");
    const bytes = (await git(root, ["cat-file", "blob", located.blob.hash], maxBytes + 1)).stdout;
    return hasBinaryMarker(bytes) ? empty("binary", "it is a binary file") : fingerprinted(side.path, identity, bytes.toString("utf8"));
  } catch {
    return empty("unreadable", "it could not be read");
  }
}

/**
 * Reads both sides of a comparison, bounded, with the sharing exclusions
 * applied to each side's own path. An absent side (a true addition or
 * deletion) is kept apart from a side that failed to read, and nothing from
 * the working tree ever stands in for an unreadable original.
 */
export async function readComparison(ref: ComparisonRef, options: SnapshotOptions = {}): Promise<ComparisonSnapshot> {
  const [original, modified] = await Promise.all([
    readSide(ref.root, ref.original, options),
    readSide(ref.root, ref.modified, options)
  ]);
  return { root: ref.root, original, modified };
}

/** What a snapshot was read from and says; a different signature later means a different pair of versions. */
export function snapshotSignature(snapshot: ComparisonSnapshot): string {
  return [snapshot.original, snapshot.modified].map((side) => `${side.path}\0${side.identity}\0${side.state}\0${side.fingerprint}`).join("\n");
}

/** Why a snapshot cannot be explained, or undefined when both sides are usable. */
export function comparisonProblem(snapshot: ComparisonSnapshot): string | undefined {
  for (const [name, side] of [["original", snapshot.original], ["modified", snapshot.modified]] as const) {
    if (side.state === "excluded") return `The ${name} version of ${side.path} was not sent because ${side.detail}.`;
    if (side.state === "binary" || side.state === "oversized" || side.state === "unreadable") {
      return `The ${name} version of ${side.path} was not explained because ${side.detail}.`;
    }
  }
  if (snapshot.original.state === "absent" && snapshot.modified.state === "absent") return "Neither version of this file exists.";
  // A file moved without edits is still a change: its path differs.
  if (snapshot.original.state === "present" && snapshot.modified.state === "present" &&
      snapshot.original.text === snapshot.modified.text && snapshot.original.path === snapshot.modified.path) {
    return "The two versions are identical.";
  }
  return undefined;
}

export interface ChangedFile {
  readonly status: "added" | "deleted" | "modified" | "renamed";
  /** Modified-side path, or the deleted path. */
  readonly path: string;
  /** Original-side path, when the file was renamed. */
  readonly oldPath?: string;
}

/** Immutable commit metadata, read from Git rather than command arguments. */
export interface CommitDetails {
  readonly hash: string;
  readonly parents: readonly string[];
}

export async function commitDetails(root: string, revision: string): Promise<CommitDetails> {
  const hash = await resolveRevision(root, revision);
  if (!hash || EMPTY_TREES.includes(hash)) throw new Error("Choose an existing Git commit.");
  const parents = (await gitText(root, ["show", "-s", "--format=%P", hash])).trim().split(/\s+/).filter(Boolean);
  return { hash, parents };
}

export interface CommitScope {
  readonly commit: string;
  /** An actual parent commit, or Git's empty tree for a root commit. */
  readonly parent: string;
  readonly files: ChangedFile[];
  readonly truncated: boolean;
}

/** Exact parent -> commit changes; never includes the index, untracked files or editor buffers. */
export async function commitScope(root: string, revision: string, parent?: string, limit = MAX_CHANGED_FILES): Promise<CommitScope> {
  const details = await commitDetails(root, revision);
  if (details.parents.length > 1 && !parent) throw new Error("Choose a parent explicitly for this merge commit.");
  if (parent && !details.parents.includes(parent)) throw new Error("The selected revision is not a parent of this commit.");
  const original = parent ?? details.parents[0];
  const format = (await gitText(root, ["rev-parse", "--show-object-format"])).trim();
  if (format !== "sha1" && format !== "sha256") throw new Error("This repository's Git object format is not supported.");
  const empty = EMPTY_TREES[format === "sha256" ? 1 : 0]!;
  const args = ["--name-status", "--relative", "-M", "-z", "--no-ext-diff"];
  const listing = original
    ? await gitText(root, ["diff", ...args, original, details.hash, "--"])
    : await gitText(root, ["diff-tree", "--root", "--no-commit-id", "-r", ...args, details.hash, "--"]);
  const files = parseChangedFiles(listing);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { commit: details.hash, parent: original ?? empty, files: files.slice(0, limit), truncated: files.length > limit };
}

/** Uses exactly the same revision/path identities as native Git graph diffs. */
export function commitComparisonRef(root: string, scope: Pick<CommitScope, "commit" | "parent">, file: ChangedFile): ComparisonRef {
  return {
    root,
    original: { path: file.oldPath ?? file.path, source: { kind: "revision", hash: scope.parent } },
    modified: { path: file.path, source: { kind: "revision", hash: scope.commit } }
  };
}

function parseChangedFiles(listing: string): ChangedFile[] {
  const tokens = listing.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tokens[index++] ?? "";
      const path = tokens[index++] ?? "";
      if (path && oldPath) files.push(kind === "R" ? { status: "renamed", path, oldPath } : { status: "added", path });
      continue;
    }
    const path = tokens[index++] ?? "";
    if (path) files.push({ status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified", path });
  }
  return files;
}

/**
 * Files changed in the working tree since a commit, with additions,
 * deletions, and renames kept distinct, bounded to `limit` files. `truncated`
 * is true when more changed.
 */
export async function changedFilesSince(root: string, base: string, limit = MAX_CHANGED_FILES): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const hash = await resolveRevision(root, base);
  if (!hash) throw new Error(`The Git revision "${base}" could not be resolved.`);
  const files = parseChangedFiles(await gitText(root, ["diff", "--name-status", "--relative", "-M", "-z", "--no-ext-diff", hash]));
  const tracked = new Set(files.map((file) => file.path));
  const untracked = (await gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((path) => path && !tracked.has(path));
  for (const path of untracked) files.push({ status: "added", path });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files: files.slice(0, limit), truncated: files.length > limit };
}

/** The pair of documents for one changed file, compared with the base commit. */
export async function baseComparisonRef(root: string, base: string, file: ChangedFile): Promise<ComparisonRef> {
  const hash = await resolveRevision(root, base);
  if (!hash) throw new Error(`The Git revision "${base}" could not be resolved.`);
  return {
    root,
    original: { path: file.oldPath ?? file.path, source: { kind: "revision", hash } },
    modified: { path: file.path, source: { kind: "working" } }
  };
}
