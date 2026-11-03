import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { ChangedFile } from "../context/comparison";

export interface PullRequestTarget {
  readonly hostname: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface GitHubDiffLine {
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly position: number;
}

export interface PullRequestFile extends ChangedFile {
  readonly diffLines?: readonly GitHubDiffLine[];
}

export interface PullRequestRevision {
  readonly base: string;
  readonly head: string;
  readonly files: readonly PullRequestFile[];
}
export interface PullRequestHeads {
  readonly base: string;
  readonly head: string;
  readonly count: number;
}

export type GitHubRequest = (
  target: PullRequestTarget, endpoint: string, signal: AbortSignal, body?: unknown, method?: "PATCH" | "DELETE"
) => Promise<unknown>;

export interface GitHubComment {
  readonly id: number;
  readonly url: string;
  readonly type: "summary" | "file";
  readonly body: string;
  readonly author: string;
  readonly path?: string;
  readonly head?: string;
  readonly originalHead?: string;
  readonly subjectType?: "file" | "line";
  readonly line?: number;
  readonly side?: "LEFT" | "RIGHT";
  readonly replyTo?: number;
  readonly mutationEndpoint: string;
}

/** Only host-authored, actionable messages may cross the publication error boundary. */
export class GitHubClientError extends Error {
  constructor(message: string, readonly rejected = false) { super(message); }
}

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_PATCH_LINES = 50_000;
const lineValid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sideValid = (value: unknown): value is GitHubDiffLine["side"] => value === "LEFT" || value === "RIGHT";

/** Fail closed for the whole patch, including earlier hunks, on incomplete evidence. */
function diffLines(file: Record<string, unknown>): readonly GitHubDiffLine[] | undefined {
  const patch = file.patch;
  if (typeof patch !== "string" || !patch || patch.length > MAX_PATCH_BYTES ||
      Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES ||
      !Number.isSafeInteger(file.additions) || Number(file.additions) < 0 ||
      !Number.isSafeInteger(file.deletions) || Number(file.deletions) < 0) return undefined;
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_PATCH_LINES) return undefined;
  const result: GitHubDiffLine[] = [];
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  let oldEnd = -1, newEnd = -1, hunks = 0, added = 0, deleted = 0;
  let previous: string | undefined;
  let oldFinished = false, newFinished = false;
  for (const [position, text] of lines.entries()) {
    if (text.startsWith("@@")) {
      if (oldRemaining || newRemaining) return undefined;
      const match = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$/.exec(text);
      if (!match) return undefined;
      const [oldStart, oldCount, newStart, newCount] =
        [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if (![oldStart, oldCount, newStart, newCount].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          (!oldCount && !newCount) || (oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0) ||
          !Number.isSafeInteger(oldStart + oldCount) || !Number.isSafeInteger(newStart + newCount)) return undefined;
      // Zero-count ranges name the line before the insertion/deletion.
      oldLine = oldCount ? oldStart : oldStart + 1;
      newLine = newCount ? newStart : newStart + 1;
      if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine) ||
          oldLine < oldEnd || newLine < newEnd ||
          (hunks ? oldLine - oldEnd !== newLine - newEnd : oldLine !== newLine)) return undefined;
      oldRemaining = oldCount;
      newRemaining = newCount;
      oldEnd = oldLine + oldCount;
      newEnd = newLine + newCount;
      previous = undefined;
      hunks++;
      continue;
    }
    if (!hunks) return undefined;
    if (text === "\\ No newline at end of file") {
      if (previous === undefined) return undefined;
      if (previous !== "+") oldFinished = true;
      if (previous !== "-") newFinished = true;
      previous = undefined;
      continue;
    }
    const prefix = text[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") return undefined;
    const consumesOld = prefix !== "+", consumesNew = prefix !== "-";
    if ((consumesOld && (!oldRemaining || oldFinished)) || (consumesNew && (!newRemaining || newFinished))) return undefined;
    if (prefix === "+") { result.push({ line: newLine, side: "RIGHT", position }); added++; }
    if (prefix === "-") { result.push({ line: oldLine, side: "LEFT", position }); deleted++; }
    if (consumesOld) { oldLine++; oldRemaining--; }
    if (consumesNew) { newLine++; newRemaining--; }
    previous = prefix;
  }
  if (!hunks || oldRemaining || newRemaining) return undefined;
  // GitHub's file totals also detect patches truncated exactly at a hunk boundary.
  if (file.additions !== added || file.deletions !== deleted) return undefined;
  return result;
}

const segment = (value: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value) && value !== "." && value !== "..";
const pathValid = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(value) &&
  !value.split("/").some((part) => !part || part === "." || part === "..");

export function parsePullRequestUrl(value: string): PullRequestTarget {
  const url = new URL(value.trim());
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) ||
      !match || !segment(match[1]!) || !segment(match[2]!) || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error("Enter an HTTPS pull request URL, such as https://github.com/owner/repository/pull/123.");
  }
  return { hostname: url.hostname, owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase(), number: Number(match[3]) };
}

export const pullRequestUrl = (target: PullRequestTarget): string =>
  `https://${target.hostname}/${target.owner}/${target.repo}/pull/${target.number}`;

export const repositoryEndpoint = (target: PullRequestTarget): string => `repos/${target.owner}/${target.repo}`;

function rejectedRequest(stdout: string, stderr: string): GitHubClientError | undefined {
  const status = Number(/\(HTTP ([45][0-9]{2})\)\s*$/.exec(stderr.trim())?.[1]);
  if (!status || status === 408 || status >= 500) return undefined;
  const fields: string[] = [];
  const reasons = new Set<string>();
  const classify = (message: unknown): void => {
    if (typeof message !== "string") return;
    if (/secondary rate limit|rate limit exceeded|abuse detection|submitted too quickly|spam|was submitted too fast/i.test(message)) {
      reasons.add("GitHub rate-limit or spam protection");
    }
    if (/already have a pending review|only (?:one|1) pending review|pending review already exists/i.test(message)) {
      reasons.add("an existing pending review");
    }
    if (/(?:line|position).{0,80}(?:not part of|must be part of|not in|outside).{0,40}diff/i.test(message)) {
      reasons.add("a line outside the current diff");
    }
    if (/"(?:subject_type|line)" is not a permitted key/i.test(message)) {
      reasons.add("unsupported line-comment parameters");
    }
    if (/review.{0,30}(?:limit|maximum)|maximum.{0,30}review/i.test(message)) {
      reasons.add("GitHub's review count limit");
    }
  };
  if (Buffer.byteLength(stdout, "utf8") <= MAX_RESPONSE) {
    try {
      const response: unknown = JSON.parse(stdout);
      if (response && typeof response === "object") {
        if ("message" in response) classify(response.message);
        const errors = "errors" in response && Array.isArray(response.errors) ? response.errors : [];
        for (const error of errors.slice(0, 20)) {
          classify(error);
          if (error && typeof error === "object" && "message" in error) classify(error.message);
          if (error && typeof error === "object" && "field" in error && typeof error.field === "string" &&
              ["body", "commit_id", "path", "line", "side", "subject_type", "position"].includes(error.field)) fields.push(error.field);
        }
      }
    } catch { /* Non-JSON errors still have a safe HTTP status, never raw response text. */ }
  }
  const guidance = status === 401 || status === 403
    ? "Check GitHub CLI authentication, write permissions, and GitHub rate limits."
    : status === 404 ? "Check that this account can access the PR and its comments."
    : status === 429 ? "GitHub is rate limiting requests. Wait before explicitly retrying."
    : reasons.has("GitHub rate-limit or spam protection")
      ? "Wait at least one minute before explicitly retrying; longer if GitHub continues blocking comments."
    : reasons.has("unsupported line-comment parameters")
      ? "GitHub rejected line-based request parameters. Update Downside Up to use verified diff positions."
    : status === 422 ? "GitHub did not accept the comment. HTTP 422 can mean validation failure or comment spam protection; the status alone cannot distinguish them."
    : "Inspect the PR before explicitly retrying.";
  return new GitHubClientError(`GitHub rejected the request (HTTP ${status})` +
    (fields.length ? `; invalid fields: ${[...new Set(fields)].join(", ")}` : "") +
    (reasons.size ? `; reason: ${[...reasons].join(", ")}` : "") +
    `. ${guidance} No automatic retry was made.`, true);
}

/** Uses gh's existing authentication; no credentials or generated bodies enter argv or logs. */
export const requestGitHub: GitHubRequest = (target, endpoint, signal, body, method) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const checked = parsePullRequestUrl(pullRequestUrl(target));
  if (checked.hostname !== target.hostname || checked.owner !== target.owner ||
      checked.repo !== target.repo || checked.number !== target.number ||
      !(endpoint === "user" || endpoint.startsWith(`${repositoryEndpoint(target)}/`)) ||
      /[\x00-\x20#\\]/.test(endpoint)) {
    throw new GitHubClientError("Invalid GitHub destination.");
  }
  if (method !== undefined && !(
    (method === "PATCH" && body !== undefined) ||
    (method === "DELETE" && body === undefined &&
      endpoint.startsWith(`${repositoryEndpoint(target)}/pulls/comments/`) &&
      /^[1-9][0-9]*$/.test(endpoint.slice(`${repositoryEndpoint(target)}/pulls/comments/`.length)))
  )) {
    throw new GitHubClientError("Invalid GitHub mutation.");
  }
  const args = ["api", "--hostname", target.hostname, "--method", method ?? (body === undefined ? "GET" : "POST"),
    "-H", "Accept: application/vnd.github+json", endpoint, ...(body === undefined ? [] : ["--input", "-"])];
  const child = execFile("gh", args, {
    encoding: "utf8", timeout: 30_000, maxBuffer: MAX_RESPONSE, windowsHide: true, signal,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" }
  }, (error, stdout, stderr) => {
    if (error) {
      const rejected = !signal.aborted && !error.killed && !error.signal
        ? rejectedRequest(stdout, stderr ?? "") : undefined;
      if (rejected) { reject(rejected); return; }
      reject(new GitHubClientError(method === "DELETE"
        ? "GitHub did not confirm the deletion. The comment may have been deleted; inspect the PR before retrying. No automatic retry was made."
        : body === undefined
        ? "GitHub could not be read. Check that GitHub CLI (gh) is installed, authenticated for this host, and has access to the pull request."
        : "GitHub did not confirm the comment. It may have been published; inspect the PR before retrying. No automatic retry was made."));
      return;
    }
    // gh api emits no content for GitHub's successful 204 DELETE response.
    if (method === "DELETE") {
      if (stdout.trim() === "") resolve(undefined);
      else reject(new GitHubClientError("GitHub returned an unexpected deletion response. The comment may have been deleted; inspect the PR before retrying. No automatic retry was made."));
      return;
    }
    try { resolve(JSON.parse(stdout) as unknown); }
    catch { reject(new GitHubClientError("GitHub returned an invalid response. Inspect the PR before retrying a publication.")); }
  });
  child.stdin?.on("error", () => { /* execFile reports a failed process through its callback. */ });
  child.stdin?.end(body === undefined ? undefined : JSON.stringify(body));
});

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitHubClientError("GitHub returned an invalid response.");
  return value as Record<string, unknown>;
}

export class PullRequestClient {
  private nextWriteAt = 0;

  constructor(readonly target: PullRequestTarget, private readonly request: GitHubRequest = requestGitHub) {
    parsePullRequestUrl(pullRequestUrl(target));
  }

  private endpoint(suffix: string): string {
    return `${repositoryEndpoint(this.target)}/pulls/${this.target.number}${suffix}`;
  }

  private async paceWrite(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const now = Date.now();
    const scheduled = Math.max(now, this.nextWriteAt);
    this.nextWriteAt = scheduled + 1_000;
    if (scheduled > now) await delay(scheduled - now, undefined, { signal });
    signal.throwIfAborted();
  }

  private async send(endpoint: string, signal: AbortSignal, body?: unknown, method?: "PATCH" | "DELETE"): Promise<unknown> {
    signal.throwIfAborted();
    try {
      return await (method === undefined
        ? this.request(this.target, endpoint, signal, body)
        : this.request(this.target, endpoint, signal, body, method));
    } catch (error) {
      if (error instanceof GitHubClientError) throw error;
      throw new GitHubClientError(method === "DELETE"
        ? "GitHub did not confirm the deletion. The comment may have been deleted; inspect the PR before retrying. No automatic retry was made."
        : body === undefined
        ? "GitHub could not be read. Check authentication and PR access."
        : "GitHub did not confirm the write. It may have been published; inspect the PR before retrying.");
    }
  }

  async account(signal: AbortSignal): Promise<string> {
    const login = object(await this.send("user", signal)).login;
    if (typeof login !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(login)) throw new GitHubClientError("GitHub account could not be verified.");
    return login;
  }

  async heads(signal: AbortSignal): Promise<PullRequestHeads> {
    const data = object(await this.send(this.endpoint(""), signal));
    const base = object(data.base);
    const head = object(data.head);
    if (data.state !== "open") throw new GitHubClientError("Choose an open pull request.");
    if (String(object(base.repo).full_name).toLowerCase() !== `${this.target.owner}/${this.target.repo}` ||
        typeof base.sha !== "string" || !HASH.test(base.sha) || typeof head.sha !== "string" || !HASH.test(head.sha) ||
        typeof data.changed_files !== "number" || !Number.isSafeInteger(data.changed_files) || data.changed_files < 1 ||
        data.changed_files > 200) {
      throw new GitHubClientError("The PR identity or revisions could not be verified, or it exceeds the 200-file publishing limit.");
    }
    return { base: base.sha, head: head.sha, count: data.changed_files };
  }

  async revision(signal: AbortSignal): Promise<PullRequestRevision> {
    const data = await this.heads(signal);
    const files: PullRequestFile[] = [];
    for (let page = 1; files.length < data.count; page++) {
      const entries = await this.send(this.endpoint(`/files?per_page=100&page=${page}`), signal);
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100 || page > 2) {
        throw new GitHubClientError("The complete PR file list could not be verified.");
      }
      for (const entry of entries) {
        const file = object(entry);
        if (!pathValid(file.filename) || !["added", "removed", "modified", "renamed", "copied", "changed"].includes(String(file.status)) ||
            (file.status === "renamed" && !pathValid(file.previous_filename))) {
          throw new GitHubClientError("The PR contains an unsupported file change.");
        }
        const anchors = diffLines(file);
        files.push({ path: file.filename,
          status: file.status === "removed" ? "deleted" : file.status === "renamed" ? "renamed" :
            file.status === "added" || file.status === "copied" ? "added" : "modified",
          ...(file.status === "renamed" ? { oldPath: String(file.previous_filename) } : {}),
          ...(anchors === undefined ? {} : { diffLines: anchors }) });
      }
    }
    if (files.length !== data.count || new Set(files.map((file) => file.path)).size !== files.length) {
      throw new GitHubClientError("The PR file list changed or is incomplete. Try again.");
    }
    return { base: data.base, head: data.head, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  private comment(value: unknown, type: GitHubComment["type"]): GitHubComment {
    const data = object(value);
    const author = object(data.user).login;
    const id = data.id;
    const file = type === "file";
    const url = `${pullRequestUrl(this.target)}#${file ? "discussion_r" : "issuecomment-"}${id}`;
    let validUrl = false;
    try {
      const received = new URL(String(data.html_url));
      validUrl = received.origin === `https://${this.target.hostname}` && !received.username && !received.password &&
        !received.search && received.pathname.toLowerCase() === new URL(url).pathname &&
        received.hash === new URL(url).hash;
    } catch { /* Invalid API URLs are never usable as publication links. */ }
    if (!Number.isSafeInteger(id) || Number(id) <= 0 || !validUrl ||
        typeof author !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(author) ||
        typeof data.body !== "string" || Buffer.byteLength(data.body, "utf8") > 262_144 ||
        (file && (!pathValid(data.path) || typeof data.commit_id !== "string" || !HASH.test(data.commit_id) ||
          typeof data.original_commit_id !== "string" || !HASH.test(data.original_commit_id) ||
          !["file", "line"].includes(String(data.subject_type)) ||
          (data.line !== undefined && data.line !== null && !lineValid(data.line)) ||
          (data.side !== undefined && !sideValid(data.side)) ||
          (data.in_reply_to_id !== undefined && data.in_reply_to_id !== null &&
            (!Number.isSafeInteger(data.in_reply_to_id) || Number(data.in_reply_to_id) <= 0))))) {
      throw new GitHubClientError("Existing PR comment identity, URL, or anchor could not be verified.");
    }
    return {
      id: Number(id), url, type, body: data.body, author,
      mutationEndpoint: `${repositoryEndpoint(this.target)}/${file ? "pulls" : "issues"}/comments/${id}`,
      ...(file ? {
        path: String(data.path), head: String(data.commit_id), originalHead: String(data.original_commit_id),
        subjectType: data.subject_type as "file" | "line",
        ...(data.line === undefined || data.line === null ? {} : { line: Number(data.line) }),
        ...(data.side === undefined ? {} : { side: data.side as GitHubDiffLine["side"] }),
        ...(data.in_reply_to_id ? { replyTo: Number(data.in_reply_to_id) } : {})
      } : {})
    };
  }

  private async scanComments(signal: AbortSignal, filesOnly = false): Promise<readonly GitHubComment[]> {
    const result: GitHubComment[] = [];
    for (const [type, endpoint] of [
      ["file", this.endpoint("/comments")],
      ["summary", `${repositoryEndpoint(this.target)}/issues/${this.target.number}/comments`]
    ] as const) {
      if (filesOnly && type !== "file") continue;
      for (let page = 1; page <= 10; page++) {
        const entries = await this.send(`${endpoint}?per_page=100&page=${page}`, signal);
        if (!Array.isArray(entries) || entries.length > 100) throw new GitHubClientError("Existing PR comments could not be verified.");
        for (const entry of entries) {
          const comment = this.comment(entry, type);
          if (result.some((previous) => previous.type === type && previous.id === comment.id)) {
            throw new GitHubClientError("The PR comment list changed or contains duplicate identities. Inspect the PR first.");
          }
          result.push(comment);
        }
        if (entries.length < 100) break;
        if (page === 10) throw new GitHubClientError("Too many existing comments to safely check for duplicate publications (1,000 per comment type).");
      }
    }
    return result;
  }

  async comments(signal: AbortSignal): Promise<readonly GitHubComment[]> {
    return this.scanComments(signal);
  }

  private identity(comment: GitHubComment): string {
    return JSON.stringify([
      comment.id, comment.url, comment.author.toLowerCase(), comment.type, comment.path,
      comment.head, comment.originalHead, comment.subjectType, comment.line, comment.side,
      comment.replyTo, comment.mutationEndpoint
    ]);
  }

  /**
   * Retires only an exact, caller-verified root file/line comment. A fresh complete reply
   * scan and account/GET comparison precede DELETE; GitHub has no atomic
   * "delete only if still reply-free" operation, so the final GET->DELETE race remains.
   * Successful server acknowledgement is the commit point, even if then cancelled.
   */
  async delete(
    expected: GitHubComment, account: string, signal: AbortSignal, beforeWrite?: () => void
  ): Promise<"deleted" | "replies"> {
    const endpoint = `${repositoryEndpoint(this.target)}/pulls/comments/${expected.id}`;
    if (expected.type !== "file" || !["file", "line"].includes(String(expected.subjectType)) || expected.replyTo ||
        !Number.isSafeInteger(expected.id) || expected.id <= 0 || expected.mutationEndpoint !== endpoint ||
        expected.author.toLowerCase() !== account.toLowerCase()) {
      throw new GitHubClientError("Invalid GitHub comment deletion.");
    }
    await this.paceWrite(signal);
    if ((await this.account(signal)).toLowerCase() !== account.toLowerCase()) {
      throw new GitHubClientError("The GitHub account changed. Confirm the publication again before deleting comments.");
    }
    let comments: readonly GitHubComment[];
    try {
      comments = await this.scanComments(signal, true);
    } catch {
      signal.throwIfAborted();
      throw new GitHubClientError("The complete file reply list could not be verified. No deletion was sent; inspect the PR and confirm the update again.");
    }
    const listed = comments.find((comment) => comment.id === expected.id);
    const current = this.comment(await this.send(endpoint, signal), "file");
    if (!listed || this.identity(listed) !== this.identity(expected) || listed.body !== expected.body ||
        this.identity(current) !== this.identity(expected) || current.body !== expected.body) {
      throw new GitHubClientError("The existing comment changed after confirmation. No deletion was sent; inspect the PR and confirm the update again.");
    }
    signal.throwIfAborted();
    if (comments.some((comment) => comment.replyTo === expected.id)) return "replies";
    this.nextWriteAt = Math.max(this.nextWriteAt, Date.now() + 1_000);
    beforeWrite?.();
    const response = await this.send(endpoint, signal, undefined, "DELETE");
    if (response !== undefined) {
      throw new GitHubClientError("GitHub did not confirm the expected deletion. The comment may have been deleted; inspect the PR before retrying. No automatic retry was made.");
    }
    return "deleted";
  }

  async post(
    body: string, head: string, signal: AbortSignal, path?: string, beforeWrite?: () => void,
    anchor?: GitHubDiffLine
  ): Promise<GitHubComment> {
    signal.throwIfAborted();
    if (!HASH.test(head) || (path !== undefined && !pathValid(path)) || Buffer.byteLength(body, "utf8") > 65_000 ||
        (anchor !== undefined && (path === undefined || !lineValid(anchor.line) || !sideValid(anchor.side) ||
          !lineValid(anchor.position) || anchor.position >= MAX_PATCH_LINES))) {
      throw new GitHubClientError("Invalid or oversized GitHub publication.");
    }
    const endpoint = path === undefined
      ? `${repositoryEndpoint(this.target)}/issues/${this.target.number}/comments` : this.endpoint("/comments");
    const payload = path === undefined ? { body } : {
      body, commit_id: head, path,
      ...(anchor ? { position: anchor.position } : { subject_type: "file" })
    };
    await this.paceWrite(signal);
    this.nextWriteAt = Math.max(this.nextWriteAt, Date.now() + 1_000);
    beforeWrite?.();
    const response = this.comment(await this.send(endpoint, signal, payload), path === undefined ? "summary" : "file");
    if (response.body !== body || (path !== undefined &&
        (response.path !== path || response.head !== head || response.originalHead !== head ||
          response.subjectType !== (anchor ? "line" : "file") || response.replyTo ||
          (anchor && (response.line !== anchor.line || response.side !== anchor.side))))) {
      throw new GitHubClientError("GitHub did not confirm the expected comment. Inspect the PR before retrying.");
    }
    return response;
  }

  /** GET/compare immediately before PATCH; never deletes a thread or silently accepts a new body. */
  async update(
    expected: GitHubComment, body: string, signal: AbortSignal, beforeWrite?: () => void
  ): Promise<GitHubComment> {
    const endpoint = `${repositoryEndpoint(this.target)}/${expected.type === "file" ? "pulls" : "issues"}/comments/${expected.id}`;
    if (!Number.isSafeInteger(expected.id) || expected.id <= 0 || expected.mutationEndpoint !== endpoint ||
        Buffer.byteLength(body, "utf8") > 65_000) throw new GitHubClientError("Invalid GitHub comment update.");
    await this.paceWrite(signal);
    const current = this.comment(await this.send(endpoint, signal), expected.type);
    if (this.identity(current) !== this.identity(expected) || current.body !== expected.body || current.replyTo) {
      throw new GitHubClientError("The existing comment changed after confirmation. Inspect the PR and confirm the update again.");
    }
    signal.throwIfAborted();
    this.nextWriteAt = Math.max(this.nextWriteAt, Date.now() + 1_000);
    beforeWrite?.();
    const response = this.comment(await this.send(endpoint, signal, { body }, "PATCH"), expected.type);
    if (this.identity(response) !== this.identity(current) || response.body !== body) {
      throw new GitHubClientError("GitHub did not confirm the expected update. Inspect the PR before retrying.");
    }
    return response;
  }
}
