import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readComparison, snapshotSignature, type ComparisonRef } from "../src/context/comparison";
import type { ReviewSummaryScope } from "../src/context/reviewSummary";
import type { ReviewExportData } from "../src/presentation/reviewExport";
import { GitHubClientError, parsePullRequestUrl, PullRequestClient, type GitHubRequest, type PullRequestRevision } from "../src/github/client";
import {
  preparePublication, publishReview, verifyPullRequestScope, PublicationValidationError, type PublicationOptions
} from "../src/github/reviewPublication";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

let root: string;
let base: string;
let head: string;
let scope: ReviewSummaryScope;
let revision: PullRequestRevision;
const signal = new AbortController().signal;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const target = parsePullRequestUrl("https://github.com/owner/repo/pull/42");
let ref: ComparisonRef;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dsu-pr-")));
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "."); git("commit", "-qm", "base"); base = git("rev-parse", "HEAD");
  await writeFile(join(root, "a.ts"), "export const a = 2;\n");
  git("add", "."); git("commit", "-qm", "head"); head = git("rev-parse", "HEAD");
  ref = { root, original: { path: "a.ts", source: { kind: "revision", hash: base } },
    modified: { path: "a.ts", source: { kind: "working" } } };
  scope = { root, base, kind: "working", items: [{ path: "a.ts", ref, confirmed: snapshotSignature(await readComparison(ref)) }] };
  revision = { base, head, files: [{ path: "a.ts", status: "modified" }] };
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function data(withFile = false, text = "Updates `a`."): ReviewExportData {
  const coverage = { total: 1, included: 1, unavailable: 0, omitted: 0, lowValue: 0 };
  return { kind: "working", base, head, coverage, evidence: [], files: withFile ? [{
    path: "a.ts", status: "current", comparison: {
      original: { path: "a.ts", identity: `revision:${base}`, fingerprint: "old", lines: 1 },
      modified: { path: "a.ts", identity: `revision:${head}`, fingerprint: "new", lines: 1 },
      comparison: { summary: text, changes: [], outside: "", possibleEffects: [], limitations: [] },
      provider: "vscode-lm", model: "test", promptVersion: "test", savedAt: 1
    }
  }] : [{ path: "a.ts", status: "missing" }], exportedAt: 123,
    summary: { value: { summary: text, themes: [], possibleEffects: [], limitations: [] },
      provider: "vscode-lm", model: "test", promptVersion: "test", savedAt: 1, fingerprint: "test", coverage, evidence: [] } };
}

interface RemoteComment {
  id: number;
  html_url: string;
  body: string;
  user: { login: string };
  path?: string;
  commit_id?: string;
  original_commit_id?: string;
  subject_type?: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT";
  in_reply_to_id?: number;
}

function remote() {
  const comments: RemoteComment[] = [];
  const posts: Record<string, unknown>[] = [];
  const patches: { id: number; body: string }[] = [];
  const deletes: number[] = [];
  const diffs = new Map<string, string>();
  const request = vi.fn<GitHubRequest>(async (_target, endpoint, _signal, payload, method) => {
    const mutationId = /\/(?:issues|pulls)\/comments\/([0-9]+)$/.exec(endpoint)?.[1];
    if (mutationId) {
      const comment = comments.find((entry) => entry.id === Number(mutationId))!;
      if (method === "DELETE") {
        comments.splice(comments.indexOf(comment), 1);
        deletes.push(comment.id);
        return undefined;
      }
      if (method === "PATCH") {
        comment.body = String((payload as { body: string }).body);
        patches.push({ id: comment.id, body: comment.body });
      }
      return structuredClone(comment);
    }
    if (payload) {
      const body = { ...payload as Record<string, unknown> };
      if (body.subject_type === "line" || "line" in body || "side" in body) {
        throw new GitHubClientError("Unsupported line-comment parameters.", true);
      }
      if (typeof body.position === "number" && typeof body.path === "string") {
        const lines = diffs.get(body.path)!.split("\n");
        let original = 0, modified = 0;
        for (const [position, text] of lines.entries()) {
          if (text.startsWith("@@")) {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text)!;
            original = Number(hunk[1]); modified = Number(hunk[2]);
          } else {
            if (position === body.position) {
              body.subject_type = "line"; body.side = text.startsWith("-") ? "LEFT" : "RIGHT";
              body.line = text.startsWith("-") ? original : modified;
            }
            if (!text.startsWith("+")) original++;
            if (!text.startsWith("-")) modified++;
          }
        }
      }
      posts.push(body);
      const id = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
      const comment = {
        id, html_url: `https://github.com/owner/repo/pull/42#${body.path ? "discussion_r" : "issuecomment-"}${id}`,
        body: String(body.body), user: { login: "reader" },
        ...(body.path ? {
          path: String(body.path), commit_id: String(body.commit_id), original_commit_id: String(body.commit_id),
          subject_type: String(body.subject_type),
          ...(body.line ? { line: Number(body.line), side: body.side as "LEFT" | "RIGHT" } : {})
        } : {})
      };
      comments.push(comment);
      return structuredClone(comment);
    }
    if (endpoint === "user") return { login: "reader" };
    if (endpoint.endsWith("/pulls/42")) return {
      state: "open", base: { sha: revision.base, repo: { full_name: "owner/repo" } },
      head: { sha: revision.head }, changed_files: revision.files.length
    };
    if (endpoint.includes("/files?")) return revision.files.map((file) => {
      const patch = diffs.get(file.path);
      return { filename: file.path, status: file.status === "deleted" ? "removed" : file.status,
        ...(file.oldPath ? { previous_filename: file.oldPath } : {}), patch,
        additions: patch?.split("\n").filter((line) => line.startsWith("+")).length,
        deletions: patch?.split("\n").filter((line) => line.startsWith("-")).length };
    });
    return structuredClone(comments.filter((comment) => endpoint.includes("/pulls/") ? comment.path : !comment.path));
  });
  return { client: new PullRequestClient(target, request), request, comments, posts, patches, deletes, diffs };
}

async function functionData(): Promise<ReviewExportData> {
  await writeFile(join(root, "a.ts"), [
    "function first() {", "  return 1;", "}", "",
    "function second() {", "  return 1;", "}", "",
    "function removed() {", "  return 1;", "}", ""
  ].join("\n"));
  git("add", "."); git("commit", "-qm", "function base"); base = git("rev-parse", "HEAD");
  await writeFile(join(root, "a.ts"), [
    "function first() {", "  return 2;", "}", "",
    "// shifted function", "function second() {", "  return 2;", "}", ""
  ].join("\n"));
  git("add", "."); git("commit", "-qm", "function head"); head = git("rev-parse", "HEAD");
  ref = { ...ref, original: { ...ref.original, source: { kind: "revision", hash: base } } };
  scope = { ...scope, base, items: [{ path: "a.ts", ref, confirmed: snapshotSignature(await readComparison(ref)) }] };
  revision = { base, head, files: [{ path: "a.ts", status: "modified" }] };
  const exported = data(true);
  const record = exported.files[0]!.comparison!;
  const source = (name: string, startLine: number, endLine: number) => ({
    name, qualifiedName: name, signature: `${name}()`, startLine, endLine,
    startColumn: 0, endColumn: 1, nameLine: startLine, nameColumn: 0, fingerprint: name
  });
  return { ...exported, files: [{ ...exported.files[0]!, comparison: {
    ...record, original: { ...record.original, lines: 11 }, modified: { ...record.modified, lines: 8 },
    catalogue: { version: 1, fingerprint: "catalogue", classified: true, limitations: [], entries: [
      { id: "fn-first", category: "changed", name: "first", kind: "function",
        original: source("first", 0, 2), modified: source("first", 0, 2) },
      { id: "fn-second", category: "changed", name: "second", kind: "function",
        original: source("second", 4, 6), modified: source("second", 5, 7) },
      { id: "fn-removed", category: "removed", name: "removed", kind: "function",
        original: source("removed", 8, 10) }
    ] },
    comparison: { ...record.comparison, changes: ["first", "second"].map((name) => ({
      functionId: `fn-${name}`, title: `${name} behavior`, before: "Returns one.", after: "Returns two.", when: "", flow: "",
      original: { start: name === "first" ? 2 : 6, end: name === "first" ? 2 : 6 },
      modified: { start: name === "first" ? 2 : 7, end: name === "first" ? 2 : 7 }
    })), removed: [{ functionId: "fn-removed", summary: "Removes the old helper." }],
    outside: "Updates an outside comment.", possibleEffects: ["Results change."] }
  } }] };
}

describe("function-anchored PR comments", () => {
  function patch(h: ReturnType<typeof remote>) {
    const diff = git("diff", "--unified=3", base, head, "--", "a.ts");
    h.diffs.set("a.ts", diff.slice(diff.indexOf("@@")));
  }
  const noop = () => undefined;

  it("plans inline migration for the reported PR's hunk geometry, and leaves old file comments untouched when the first inline write is rejected", async () => {
    // Source-free geometry and host-rendered ranges from the reported cameras.hooks.ts comparison.
    const hunks = [
      { header: "@@ -23,7 +23,7 @@", oldStart: 23, prefixes: "   -+   " },
      { header: "@@ -158,19 +158,18 @@", oldStart: 158, prefixes: "   +  +       ----+   " },
      { header: "@@ -191,9 +190,12 @@", oldStart: 191, prefixes: "   ---++++++   " },
      { header: "@@ -206,16 +208,30 @@", oldStart: 206, prefixes: "   -++++++   --+++++ -+++++++ -+   " }
    ];
    const before = Array.from({ length: 350 }, (_, index) => `source line ${index + 1}`);
    const after: string[] = [];
    const patch: string[] = [];
    let consumed = 0;
    for (const [index, hunk] of hunks.entries()) {
      after.push(...before.slice(consumed, hunk.oldStart - 1));
      consumed = hunk.oldStart - 1;
      patch.push(hunk.header);
      for (const [position, prefix] of [...hunk.prefixes].entries()) {
        const text = prefix === "+" ? `replacement ${index}:${position}` : before[consumed++]!;
        patch.push(prefix + text);
        if (prefix !== "-") after.push(text);
      }
    }
    after.push(...before.slice(consumed));
    const path = "websites/modules/bwmc/src/pages/cameras.hooks.ts";
    await mkdir(join(root, "websites/modules/bwmc/src/pages"), { recursive: true });
    await writeFile(join(root, path), before.join("\n") + "\n");
    git("add", "."); git("commit", "-qm", "reported shape base"); base = git("rev-parse", "HEAD");
    await writeFile(join(root, path), after.join("\n") + "\n");
    git("add", "."); git("commit", "-qm", "reported shape head"); head = git("rev-parse", "HEAD");
    ref = { root, original: { path, source: { kind: "revision", hash: base } },
      modified: { path, source: { kind: "revision", hash: head } } };
    scope = { root, base, kind: "commit", items: [{ path, ref, confirmed: snapshotSignature(await readComparison(ref)) }] };
    revision = { base, head, files: [{ path, status: "modified" }] };
    const ranges = [
      { name: "useCameraConfiguration.configureSingleCamera", before: [169, 175], after: [171, 174] },
      { name: "useCameraConfiguration.runConfigure", before: [192, 204], after: [191, 206] },
      { name: "useCameraConfiguration.runConfigureMany", before: [206, 222], after: [208, 238] }
    ];
    const source = (name: string, range: number[]) => ({
      name, qualifiedName: name, signature: name, startLine: range[0]! - 1, endLine: range[1]! - 1,
      startColumn: 0, endColumn: 1, nameLine: range[0]! - 1, nameColumn: 0, fingerprint: name
    });
    const record = data(true).files[0]!.comparison!;
    const exported: ReviewExportData = { ...data(true), kind: "commit", files: [{ path, status: "current", comparison: {
      ...record, original: { ...record.original, path, lines: before.length },
      modified: { ...record.modified, path, lines: after.length },
      catalogue: { version: 1, classified: true, fingerprint: "reported-shape", limitations: [], entries: ranges.map((range) => ({
        id: range.name, name: range.name, category: "changed", kind: "function",
        original: source(range.name, range.before), modified: source(range.name, range.after)
      })) },
      comparison: { ...record.comparison, changes: ranges.map((range) => ({
        functionId: range.name, title: range.name, before: "Before.", after: "After.", when: "", flow: "",
        original: { start: range.before[0]!, end: range.before[1]! },
        modified: { start: range.after[0]!, end: range.after[1]! }
      })) }
    } }] };
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, exported, readComparison, signal, { updateExisting: true });
    await publishReview(h.client, await prepare(), prepare, signal, noop);
    const previous = structuredClone(h.comments);
    h.diffs.set(path, patch.join("\n"));
    const plan = await prepare();
    expect(plan.placement).toEqual({ inline: 3, fallback: 0 });
    expect(plan.parts.filter((part) => part.anchor).map((part) => ({ line: part.anchor!.line, side: part.anchor!.side }))).toEqual([
      { line: 172, side: "RIGHT" }, { line: 193, side: "RIGHT" }, { line: 211, side: "RIGHT" }
    ]);
    expect(plan.counts).toEqual({ create: 3, update: 1, supersede: 0, delete: 0 });
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      if (args[3] && !args[4]) throw new GitHubClientError("GitHub rejected the request (HTTP 422).", true);
      return original(...args);
    });
    const failure = await publishReview(h.client, plan, prepare, signal, noop).catch((error) => error);
    expect(failure.message).toContain(`Stopped during create for ${path}`);
    expect(failure.message).toContain("0 comment(s) confirmed published");
    expect(h.comments).toEqual(previous);
    expect(h.comments.find((comment) => comment.path)!.body).toContain("### `useCameraConfiguration.runConfigureMany`");
    h.request.mockImplementation(original);
    await publishReview(h.client, await prepare(), prepare, signal, noop);
    expect(h.comments.filter((comment) => comment.subject_type === "line").map((comment) => comment.line)).toEqual([172, 193, 211]);
    expect(h.comments.find((comment) => comment.subject_type === "file")!.body).not.toContain("### `useCameraConfiguration.");
  });

  it("places independent Before/After explanations on each function's after-side change, and removed functions on the left", async () => {
    const exported = await functionData();
    const h = remote();
    patch(h);
    const prepare = () => preparePublication(h.client, scope, exported, readComparison, signal);
    const prepared = await prepare();
    expect(prepared.placement).toEqual({ inline: 3, fallback: 0 });
    expect(prepared.parts.map((part) => part.anchor && ({ line: part.anchor.line, side: part.anchor.side }))).toEqual([
      { line: 2, side: "RIGHT" }, { line: 7, side: "RIGHT" }, { line: 9, side: "LEFT" }, undefined, undefined
    ]);
    expect(prepared.parts[0]!.body).toContain("### `first`");
    expect(prepared.parts[0]!.body).not.toContain("### `second`");
    expect(prepared.parts[1]!.body).toContain("### `second`");
    expect(prepared.parts[1]!.body).toContain("Before lines 5-7; After lines 6-8");
    expect(prepared.parts[2]!.body).toContain("Removes the old helper.");
    expect(prepared.parts[3]!.body).toContain("### Other\n\n");
    expect(prepared.parts[3]!.body).not.toContain("### `first`");
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.posts.map((post) => post.subject_type)).toEqual(["line", "line", "line", "file", undefined]);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("falls back without losing content when a patch or commentable function range is unavailable", async () => {
    const exported = await functionData();
    const h = remote();
    let prepared = await preparePublication(h.client, scope, exported, readComparison, signal);
    expect(prepared.placement).toEqual({ inline: 0, fallback: 3 });
    expect(prepared.parts).toHaveLength(2);
    expect(prepared.parts[0]!.body).toContain("### `first`");
    expect(prepared.parts[0]!.body).toContain("### `second`");
    h.diffs.set("a.ts", "@@ -1 +1 @@\n-function first() {\n+function first() {");
    prepared = await preparePublication(h.client, scope, exported, readComparison, signal);
    expect(prepared.parts.filter((part) => part.anchor)).toHaveLength(1);
    const fallback = prepared.parts.find((part) => part.path && !part.anchor)!;
    expect(fallback.body).not.toContain("### `first`");
    expect(fallback.body).toContain("### `second`");
    expect(fallback.body).toContain("### `removed`");
  });

  it("does not place an enclosing function's comment on a nested function's changed line", async () => {
    const exported = await functionData();
    const record = exported.files[0]!.comparison!;
    const nested = { ...exported, files: [{ ...exported.files[0]!, comparison: { ...record,
      catalogue: { ...record.catalogue!, entries: record.catalogue!.entries.map((entry) =>
        entry.id === "fn-first" ? { ...entry, modified: { ...entry.modified!, endLine: 7 } } :
          entry.id === "fn-second" ? { ...entry, modified: { ...entry.modified!, startLine: 4, endLine: 6 } } : entry) }
    } }] };
    const h = remote();
    h.diffs.set("a.ts", "@@ -6 +6 @@\n-  return 1;\n+  return 2;");
    const plan = await preparePublication(h.client, scope, nested, readComparison, signal);
    expect(plan.parts.filter((part) => part.anchor).map((part) => ({ line: part.anchor!.line, side: part.anchor!.side }))).toEqual([{ line: 6, side: "RIGHT" }]);
    expect(plan.parts[0]!.body).toContain("### `second`");
    const fallback = plan.parts.find((part) => part.path && !part.anchor)!;
    expect(fallback.body).toContain("### `first`");
  });

  it("updates existing file layouts and inline content in place without moving or deleting discussions", async () => {
    const exported = await functionData();
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, exported, readComparison, signal, { updateExisting: true });
    await publishReview(h.client, await prepare(), prepare, signal, noop);
    const oldFile = h.comments.find((comment) => comment.path)!;
    patch(h);
    const split = await prepare();
    expect(split.counts).toEqual({ create: 3, update: 1, supersede: 0, delete: 0 });
    await publishReview(h.client, split, prepare, signal, noop);
    expect(oldFile.body).not.toContain("### `first`");
    const inline = h.comments.find((comment) => comment.subject_type === "line")!;
    const id = Math.max(...h.comments.map((comment) => comment.id)) + 1;
    h.comments.push({ ...inline, id, html_url: inline.html_url.replace(/discussion_r\d+$/, `discussion_r${id}`),
      in_reply_to_id: inline.id, body: "A human reply." });
    const updated = { ...exported, files: exported.files.map((file) => ({ ...file, comparison: {
      ...file.comparison!, comparison: { ...file.comparison!.comparison,
        changes: file.comparison!.comparison.changes.map((change) => ({ ...change, after: "Updated explanation." })) }
    } })) };
    const refresh = () => preparePublication(h.client, scope, updated, readComparison, signal, { updateExisting: true });
    const changed = await refresh();
    expect(changed.counts).toEqual({ create: 0, update: 2, supersede: 0, delete: 0 });
    await publishReview(h.client, changed, refresh, signal, noop);
    expect(inline.body).toContain("Updated explanation.");
    expect(h.comments.find((comment) => comment.id === id)!.body).toBe("A human reply.");
    expect((await refresh()).parts).toHaveLength(0);
  });

  it("retires outdated inline anchors only after replacements, preserving replies and ignoring unrelated line threads", async () => {
    const exported = await functionData();
    const h = remote();
    patch(h);
    const prepare = () => preparePublication(h.client, scope, exported, readComparison, signal, { updateExisting: true });
    await publishReview(h.client, await prepare(), prepare, signal, noop);
    const inline = h.comments.filter((comment) => comment.subject_type === "line");
    const first = inline[0]!;
    const replyId = Math.max(...h.comments.map((comment) => comment.id)) + 1;
    h.comments.push({ ...first, id: replyId, html_url: first.html_url.replace(/discussion_r\d+$/, `discussion_r${replyId}`),
      in_reply_to_id: first.id, body: "Keep this discussion." });
    const unrelatedId = replyId + 1;
    h.comments.push({ ...first, id: unrelatedId,
      html_url: first.html_url.replace(/discussion_r\d+$/, `discussion_r${unrelatedId}`), body: "Unrelated inline comment." });
    // GitHub may remove current line coordinates when a push makes a comment outdated.
    for (const comment of inline) comment.line = null;
    const plan = await prepare();
    expect(plan.counts).toEqual({ create: 3, update: 0, supersede: 1, delete: 2 });
    await publishReview(h.client, plan, prepare, signal, noop);
    expect(first.body).toContain("Superseded by");
    expect(h.deletes).toEqual(inline.slice(1).map((comment) => comment.id));
    const currentFirst = h.comments.find((comment) => comment.id > unrelatedId && comment.line === 2)!;
    expect(first.body).toContain(`](${currentFirst.html_url})`);
    expect(h.comments.find((comment) => comment.id === unrelatedId)!.body).toBe("Unrelated inline comment.");
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("creates fresh anchors after a push and links retained discussions to the same function despite new catalogue IDs", async () => {
    let exported = await functionData();
    const h = remote();
    patch(h);
    const prepare = () => preparePublication(h.client, scope, exported, readComparison, signal, { updateExisting: true });
    const initial = await prepare();
    await publishReview(h.client, initial, prepare, signal, noop);
    const old = h.comments.find((comment) => comment.line === 2)!;
    const replyId = Math.max(...h.comments.map((comment) => comment.id)) + 1;
    h.comments.push({ ...old, id: replyId, html_url: old.html_url.replace(/discussion_r\d+$/, `discussion_r${replyId}`),
      in_reply_to_id: old.id, body: "Discuss first." });
    await writeFile(join(root, "a.ts"), [
      "// inserted after the first publication", "function first() {", "  return 3;", "}", "",
      "// shifted function", "function second() {", "  return 2;", "}", ""
    ].join("\n"));
    git("add", "."); git("commit", "-qm", "updated function head"); head = git("rev-parse", "HEAD");
    revision = { ...revision, head };
    scope = { ...scope, items: [{ path: "a.ts", ref, confirmed: snapshotSignature(await readComparison(ref)) }] };
    patch(h);
    const record = exported.files[0]!.comparison!;
    exported = { ...exported, head, files: [{ ...exported.files[0]!, comparison: {
      ...record, modified: { ...record.modified, lines: 9, identity: `revision:${head}` },
      catalogue: { ...record.catalogue!, entries: record.catalogue!.entries.map((entry) => ({
        ...entry, id: `${entry.id}-new`, modified: entry.modified ? {
          ...entry.modified, startLine: entry.modified.startLine + 1, endLine: entry.modified.endLine + 1
        } : undefined
      })) },
      comparison: { ...record.comparison,
        changes: record.comparison.changes.map((change) => ({ ...change, functionId: `${change.functionId}-new` })),
        removed: record.comparison.removed!.map((removed) => ({ ...removed, functionId: `${removed.functionId}-new` })) }
    } }] };
    const plan = await prepare();
    expect(plan.counts).toEqual({ create: 4, update: 1, supersede: 1, delete: 3 });
    expect(plan.parts[0]!.key).toBe(initial.parts[0]!.key);
    expect(plan.parts[0]!.anchor).toMatchObject({ line: 3, side: "RIGHT" });
    await publishReview(h.client, plan, prepare, signal, noop);
    const replacement = h.comments.find((comment) => comment.commit_id === head && comment.line === 3)!;
    expect(old.body).toContain(`](${replacement.html_url})`);
    expect(h.comments.find((comment) => comment.id === replyId)!.body).toBe("Discuss first.");
    expect((await prepare()).parts).toHaveLength(0);
  });
});

describe("matching saved reviews to PR content", () => {
  it("matches the three-dot merge base even after the base branch advances", async () => {
    git("checkout", "-qb", "base-branch", base);
    await writeFile(join(root, "unrelated.ts"), "base branch only\n");
    git("add", "."); git("commit", "-qm", "advanced base");
    const advancedBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", head);
    expect(await verifyPullRequestScope(scope, { ...revision, base: advancedBase }, readComparison, signal)).toBe(base);
  });

  it("rejects wrong revisions, extra PR files, truncated scopes, and missing local history", async () => {
    await expect(verifyPullRequestScope(scope, { ...revision, head: base }, readComparison, signal)).rejects.toThrow("Local HEAD");
    await expect(verifyPullRequestScope(scope, { ...revision, files: [...revision.files, { path: "extra.ts", status: "added" }] }, readComparison, signal))
      .rejects.toThrow("file set");
    await expect(verifyPullRequestScope({ ...scope, truncated: true }, revision, readComparison, signal)).rejects.toThrow("truncated");
    await expect(verifyPullRequestScope(scope, { ...revision, base: "f".repeat(40) }, readComparison, signal)).rejects.toThrow("verified locally");
    await expect(verifyPullRequestScope({ ...scope, items: [{ ...scope.items[0]!, ref: { ...ref,
      original: { path: "a.ts", source: { kind: "revision", hash: head } } } }] }, revision, readComparison, signal))
      .rejects.toThrow("merge base");
  });

  it("does not mistake unrelated excluded files for omitted PR paths", async () => {
    const changedFiles = [{ path: "a.ts", status: "modified" as const }, { path: ".env.local", status: "added" as const }];
    await expect(verifyPullRequestScope({ ...scope, excluded: 1, changedFiles },
      { ...revision, files: [...revision.files, { path: "b.ts", status: "modified" }] }, readComparison, signal))
      .rejects.toThrow("file set");
  });

  it("rejects local and dirty-buffer differences even if reconfirmed, but ignores unrelated edits", async () => {
    await writeFile(join(root, "unrelated.ts"), "not in PR\n");
    expect(await verifyPullRequestScope(scope, revision, readComparison, signal)).toBe(base);
    const read = (reference: ComparisonRef) => readComparison(reference, {
      buffers: new Map([[join(root, "a.ts"), "export const a = 3;\n"]])
    });

    const edited = { ...scope, items: [{ ...scope.items[0]!, confirmed: snapshotSignature(await read(ref)) }] };
    await expect(verifyPullRequestScope(edited, revision, read, signal)).rejects.toThrow("differs from the published PR");
  });

  it("rejects shallow history and reviews rooted inside a repository", async () => {
    const subdirectory = join(root, "subdirectory");
    await mkdir(subdirectory);
    await expect(verifyPullRequestScope({ ...scope, root: subdirectory, items: scope.items.map((item) => ({
      ...item, ref: { ...item.ref, root: subdirectory }
    })) }, revision, readComparison, signal)).rejects.toThrow("repository root");
    await writeFile(join(root, ".git", "shallow"), `${base}\n`);
    await expect(verifyPullRequestScope(scope, revision, readComparison, signal)).rejects.toThrow("complete local Git history");
  });

  it("matches immutable reviews despite unrelated working changes, and checks both sides of renames/additions/deletions", async () => {
    git("mv", "a.ts", "renamed.ts");
    await writeFile(join(root, "added.ts"), "export const added = 1;\n");
    git("add", "."); git("commit", "-qm", "rename and add"); head = git("rev-parse", "HEAD");
    const files = [{ path: "renamed.ts", oldPath: "a.ts", status: "renamed" as const },
      { path: "added.ts", status: "added" as const }];
    const items = await Promise.all(files.map(async (file) => {
      const ref: ComparisonRef = { root, original: { path: file.oldPath ?? file.path, source: { kind: "revision", hash: base } },
        modified: { path: file.path, source: { kind: "revision", hash: head } } };
      return { path: file.path, ref, confirmed: snapshotSignature(await readComparison(ref)) };
    }));
    await writeFile(join(root, "renamed.ts"), "unrelated working edits\n");
    expect(await verifyPullRequestScope({ ...scope, kind: "commit", items }, { base, head, files }, readComparison, signal)).toBe(base);
    git("rm", "-qf", "renamed.ts"); git("commit", "-qm", "delete"); head = git("rev-parse", "HEAD");
    const deleted: ComparisonRef = { root, original: { path: "a.ts", source: { kind: "revision", hash: base } },
      modified: { path: "a.ts", source: { kind: "revision", hash: head } } };
    expect(await verifyPullRequestScope({ ...scope, kind: "commit", items: [
      { path: "a.ts", ref: deleted, confirmed: snapshotSignature(await readComparison(deleted)) }
    ] }, { base, head, files: [{ path: "a.ts", status: "deleted" }] }, readComparison, signal)).toBe(base);
  });
});

describe("explicit PR publication", () => {
  it("publishes saved content once, skips duplicates, and never overwrites edited comments", async () => {
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, data(), readComparison, signal);
    const first = await prepare();
    expect(h.posts).toHaveLength(0);
    await publishReview(h.client, first, prepare, signal, () => undefined);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).not.toHaveProperty("subject_type");
    const duplicate = await prepare();
    expect(duplicate.parts).toHaveLength(0);
    expect(duplicate.existing).toBe(1);
    h.comments[0]!.body += "\nmanual edit";
    await expect(prepare()).rejects.toThrow("never overwritten");
  });

  it("rechecks PR revisions and local content immediately before posting", async () => {
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, data(), readComparison, signal);
    const prepared = await prepare();
    await writeFile(join(root, "a.ts"), "changed after confirmation\n");
    await expect(publishReview(h.client, prepared, prepare, signal, () => undefined)).rejects.toThrow("0 comment(s)");
    expect(h.posts).toHaveLength(0);
  });

  it("rejects a moved remote head before posting and discloses a move after the last write", async () => {
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, data(), readComparison, signal);
    const prepared = await prepare();
    revision = { ...revision, head: base };
    await expect(publishReview(h.client, prepared, prepare, signal, () => undefined)).rejects.toThrow("Local HEAD");
    expect(h.posts).toHaveLength(0);
    await expect(publishReview(h.client, prepared, async () => prepared, signal, () => undefined))
      .rejects.toThrow("PR moved during publication");
    expect(h.posts).toHaveLength(1);
  });

  it("reports uncertain writes without retrying when the server response is lost", async () => {
    const h = remote();
    const prepared = await preparePublication(h.client, scope, data(), readComparison, signal);
    h.request.mockRejectedValueOnce(new Error("response lost SECRET source"));
    await expect(publishReview(h.client, prepared, async () => prepared, signal, () => undefined))
      .rejects.toThrow("last comment may also have been published");
    expect(h.posts).toHaveLength(0);
  });

  it("reports a rejected write without an uncertainty warning and preserves pending comments for explicit retry", async () => {
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal);
    const prepared = await prepare();
    h.request.mockRejectedValueOnce(new GitHubClientError("GitHub rejected the request (HTTP 422); invalid fields: line.", true));
    const failure = await publishReview(h.client, prepared, async () => prepared, signal, () => undefined)
      .catch((error) => error);
    expect(failure.message).toContain("HTTP 422");
    expect(failure.message).toContain("0 comment(s) confirmed published");
    expect(failure.message).not.toContain("may also have been published");
    expect(h.posts).toHaveLength(0);
    expect((await prepare()).parts).toEqual(prepared.parts);
  });

  it("does not post after cancellation and reports receipts after partial publication", async () => {
    const h = remote();
    const prepared = await preparePublication(h.client, scope, data(), readComparison, signal);
    const controller = new AbortController();
    controller.abort();
    await expect(publishReview(h.client, prepared, async () => prepared, controller.signal, () => undefined)).rejects.toThrow("0 comment(s)");
    const parts = [{ ...prepared.parts[0]!, path: "a.ts" }, prepared.parts[0]!];
    const batch = { ...prepared, parts };
    const realPost = h.client.post.bind(h.client);
    let writes = 0;
    vi.spyOn(h.client, "post").mockImplementation(async (...args) => {
      if (writes++) throw new Error("failure");
      return realPost(...args);
    });
    await expect(publishReview(h.client, batch, async () => batch, signal, () => undefined, async () => undefined))
      .rejects.toThrow("1 comment(s) confirmed");
  });

  it("uses a full post-confirmation validation once and lightweight fences for each write", async () => {
    const h = remote();
    const prepared = await preparePublication(h.client, scope, data(), readComparison, signal);
    const batch = { ...prepared, parts: [{ ...prepared.parts[0]!, path: "a.ts" }, prepared.parts[0]!] };
    const rebuild = vi.fn(async () => batch);
    const fence = vi.fn(async () => undefined);
    await publishReview(h.client, batch, rebuild, signal, () => undefined, fence);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(h.posts).toHaveLength(2);
  });
});

describe("explicitly updating an existing publication", () => {
  const update: PublicationOptions = { updateExisting: true };
  const noop = () => undefined;

  async function seed(h: ReturnType<typeof remote>) {
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal);
    await publishReview(h.client, await prepare(), prepare, signal, noop);
    expect(h.posts.map((post) => post.path)).toEqual(["a.ts", undefined]);
  }

  async function advanceHead() {
    await writeFile(join(root, "a.ts"), `export const a = ${Number(git("rev-list", "--count", "HEAD")) + 1};\n`);
    git("add", "."); git("commit", "-qm", "next head");
    head = git("rev-parse", "HEAD");
    revision = { ...revision, head };
    scope = { ...scope, items: [{ ...scope.items[0]!, confirmed: snapshotSignature(await readComparison(ref)) }] };
  }

  function addReply(h: ReturnType<typeof remote>, file: RemoteComment) {
    const id = Math.max(...h.comments.map((comment) => comment.id)) + 1;
    h.comments.push({ ...file, id, html_url: file.html_url.replace(/discussion_r\d+$/, `discussion_r${id}`),
      body: "A human reply", in_reply_to_id: file.id });
  }

  it.each([1, 2])("deletes %s unchanged reply-free old file comments only after verified replacements, preserving the current file and summary", async (oldCount) => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    const summaryId = h.comments.find((comment) => !comment.path)!.id;
    if (oldCount === 2) h.comments.push({ ...oldFile, id: 3,
      html_url: oldFile.html_url.replace(/discussion_r\d+$/, "discussion_r3") });
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 1, update: 1, supersede: 0, delete: oldCount });
    expect(prepared.parts.map((part) => part.action)).toEqual(["create", "update", ...Array(oldCount).fill("delete")]);
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      if (args[4] === "DELETE") {
        expect(h.comments.find((comment) => comment.path && comment.commit_id === head)?.body)
          .toBe(prepared.parts[0]!.body);
        expect(h.comments.find((comment) => comment.id === summaryId)?.body).toBe(prepared.parts[1]!.body);
      }
      return original(...args);
    });
    // Full residual-plan revalidation must continue working after each write.
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.deletes).toEqual(oldCount === 1 ? [oldFile.id] : [oldFile.id, 3]);
    expect(h.comments.map((comment) => comment.id)).toEqual([summaryId, oldCount === 1 ? 3 : 4]);
    expect(h.request.mock.calls.filter((call) => call[4] === "DELETE").map((call) => call[1]))
      .toEqual(h.deletes.map((id) => `repos/owner/repo/pulls/comments/${id}`));
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("can clean up an already-superseded v2 old version once its replies are gone", async () => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    addReply(h, oldFile);
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    await publishReview(h.client, await prepare(), prepare, signal, noop);
    expect(oldFile.body).toContain("Superseded");
    h.comments.splice(h.comments.findIndex((comment) => comment.in_reply_to_id), 1);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 0, update: 0, supersede: 0, delete: 1 });
    const currentIds = h.comments.filter((comment) => comment !== oldFile).map((comment) => comment.id);
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.deletes).toEqual([oldFile.id]);
    expect(h.comments.map((comment) => comment.id)).toEqual(currentIds);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("uses the verified in-place summary as replacement when no current file explanation is available", async () => {
    const h = remote();
    await seed(h);
    const summaryId = h.comments.find((comment) => !comment.path)!.id;
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(), readComparison, signal, update);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 0, update: 1, supersede: 0, delete: 1 });
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.id).toBe(summaryId);
    expect(h.comments[0]!.body).toBe(prepared.parts[0]!.body);
    expect(h.deletes).toEqual([1]);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it.each(["edited", "legacy", "edited-in-place"])("never deletes %s originals, including after an authorized superseding update", async (kind) => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    if (kind === "legacy") {
      oldFile.body = oldFile.body.replace(/^<!-- downside-up-pr-v2:[^\n]+ -->/,
        `<!-- downside-up-pr-v1:${"a".repeat(64)} -->`);
    } else oldFile.body += "\nmanual context";
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, { ...update, allowEdited: true });
    if (kind === "edited-in-place") {
      await publishReview(h.client, await prepare(), prepare, signal, noop);
      expect((await prepare()).parts).toHaveLength(0);
      expect((await preparePublication(h.client, scope, data(true), readComparison, signal)).parts).toHaveLength(0);
    }
    await advanceHead();
    const prepared = await prepare();
    expect(prepared.counts.delete).toBe(0);
    expect(prepared.counts.supersede).toBe(1);
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(oldFile.body).toContain("Superseded");
    expect(h.deletes).toHaveLength(0);
    // Rehashing an edited or legacy original must never launder it into
    // a verified, reply-free v2 comment eligible for the next cleanup.
    expect((await prepare()).parts).toHaveLength(0);
    await advanceHead();
    const next = await prepare();
    expect(next.parts.some((part) => part.comment?.id === oldFile.id)).toBe(false);
  });

  it("binds delete-versus-retain decisions to confirmation and rejects new replies before any writes", async () => {
    const h = remote();
    await seed(h);
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    addReply(h, h.comments.find((comment) => comment.path)!);
    expect((await prepare()).fingerprint).not.toBe(prepared.fingerprint);
    await expect(publishReview(h.client, prepared, prepare, signal, noop)).rejects.toThrow("Confirm publishing again");
    expect(h.deletes).toHaveLength(0);
    expect(h.posts).toHaveLength(2);
    expect(h.patches).toHaveLength(0);
  });

  it.each([false, true])("downgrades deletion for late replies, retaining already-superseded comments without another PATCH: %s", async (alreadySuperseded) => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    if (alreadySuperseded) addReply(h, oldFile);
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    if (alreadySuperseded) {
      await publishReview(h.client, await prepare(), prepare, signal, noop);
      h.comments.splice(h.comments.findIndex((comment) => comment.in_reply_to_id), 1);
    }
    const prepared = await prepare();
    const patchesBefore = h.patches.length;
    const originalBody = oldFile.body;
    const fence = async () => {
      if (!h.comments.some((comment) => comment.in_reply_to_id)) addReply(h, oldFile);
    };
    await publishReview(h.client, prepared, prepare, signal, noop, fence);
    expect(h.deletes).toHaveLength(0);
    expect(oldFile.body).toContain("Superseded");
    if (alreadySuperseded) {
      expect(oldFile.body).toBe(originalBody);
      expect(h.patches).toHaveLength(patchesBefore);
    } else {
      expect(h.patches.filter((patch) => patch.id === oldFile.id)).toHaveLength(1);
    }
    expect((await prepare()).parts).toHaveLength(0);
  });

  it.each(["body", "author", "marker", "account"])("blocks a deletion when the late %s changes", async (kind) => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      // Initial revalidation still succeeds; mutate only the deletion fence.
      if (h.posts.length === 3 && args[1] === "user" && kind === "account") return { login: "other-account" };
      if (args[1] === `repos/owner/repo/pulls/comments/${oldFile.id}` && !args[4]) {
        const comment = result as RemoteComment;
        if (kind === "body") comment.body += "\nconcurrent edit";
        if (kind === "author") comment.user.login = "other-account";
        if (kind === "marker") comment.body = comment.body.replace("downside-up-pr-v2:", "downside-up-pr-v9:");
      }
      return result;
    });
    const failure = await publishReview(h.client, prepared, prepare, signal, noop, async () => undefined).catch((error) => error);
    expect(failure.message).toMatch(/changed after confirmation|account changed/);
    expect(failure.message).toContain("2 comment(s) confirmed published");
    expect(failure.message).toContain("0 comment(s) confirmed deleted");
    expect(failure.message).not.toContain("last comment may");
    expect(h.deletes).toHaveLength(0);
  });

  it.each(["before", "after"])("honors cancellation %s the DELETE acknowledgement commit point", async (gate) => {
    const h = remote();
    await seed(h);
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    const controller = new AbortController();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      const response = await original(...args);
      if ((gate === "before" && args[1] === "repos/owner/repo/pulls/comments/1" && !args[4]) ||
          (gate === "after" && args[4] === "DELETE")) controller.abort();
      return response;
    });
    const failure = await publishReview(h.client, prepared, prepare, controller.signal, noop, async () => undefined).catch((error) => error);
    expect(failure.message).toContain("2 comment(s) confirmed published");
    expect(failure.message).toContain(`${gate === "after" ? 1 : 0} comment(s) confirmed deleted`);
    expect(failure.message).not.toContain("last comment may");
    expect(h.deletes).toHaveLength(gate === "after" ? 1 : 0);
  });

  it.each([false, true])("reports uncertain DELETEs separately without retries and discovers successful ones on explicit retry: %s", async (serverDeleted) => {
    const h = remote();
    await seed(h);
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      if (args[4] === "DELETE") {
        if (serverDeleted) await original(...args);
        throw new Error("SECRET source credentials");
      }
      return original(...args);
    });
    const failure = await publishReview(h.client, prepared, prepare, signal, noop).catch((error) => error);
    expect(failure.message).toContain("2 comment(s) confirmed published");
    expect(failure.message).toContain("0 comment(s) confirmed deleted");
    expect(failure.message).toContain("last comment may also have been deleted");
    expect(failure.message).not.toContain("SECRET");
    expect(h.request.mock.calls.filter((call) => call[4] === "DELETE")).toHaveLength(1);
    h.request.mockImplementation(original);
    const retry = await prepare();
    expect(retry.counts.delete).toBe(serverDeleted ? 0 : 1);
    await publishReview(h.client, retry, prepare, signal, noop);
    expect(h.deletes).toEqual([1]);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("never deletes when a verified replacement link is missing", async () => {
    const h = remote();
    await seed(h);
    await advanceHead();
    const prepared = await preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const retirementOnly = { ...prepared, parts: prepared.parts.filter((part) => part.action === "delete"), links: {} };
    await expect(publishReview(h.client, retirementOnly, async () => retirementOnly, signal, noop, async () => undefined))
      .rejects.toThrow("replacement comment could not be verified");
    expect(h.deletes).toHaveLength(0);
  });

  it("uses v2 host markers with stable target/path keys, revision and a content hash", async () => {
    const h = remote();
    const first = await preparePublication(h.client, scope, data(true), readComparison, signal);
    const marker = (body: string) => JSON.parse(Buffer.from(
      /^<!-- downside-up-pr-v2:([A-Za-z0-9_-]+) -->/.exec(body)![1]!, "base64url").toString("utf8"));
    const initial = marker(first.parts[0]!.body);
    expect(initial).toMatchObject({ base, head, mergeBase: base, state: "current" });
    expect(initial.hash).toBe(createHash("sha256").update(JSON.stringify(first.parts[0]!.body.slice(
      first.parts[0]!.body.indexOf("\n") + 1))).digest("hex"));
    await advanceHead();
    const next = await preparePublication(h.client, scope, data(true), readComparison, signal);
    expect(marker(next.parts[0]!.body).key).toBe(initial.key);
    expect(marker(next.parts[1]!.body).key).not.toBe(initial.key);
    expect(marker(next.parts[0]!.body).head).not.toBe(initial.head);
  });

  it("updates the summary and same-revision file comments in place without deleting replies", async () => {
    const h = remote();
    await seed(h);
    const ids = h.comments.map((comment) => comment.id);
    const prepare = () => preparePublication(h.client, scope, data(true, "Revised saved explanation."), readComparison, signal, update);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 0, update: 2, supersede: 0, delete: 0 });
    expect(prepared.parts.map((part) => [part.action, part.path])).toEqual([
      ["update", "a.ts"], ["update", undefined]
    ]);
    expect(prepared.edited).toBe(0);
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.posts).toHaveLength(2);
    expect(h.patches.map((patch) => patch.id)).toEqual(ids);
    expect(h.comments.every((comment) => comment.body.includes("Revised saved explanation"))).toBe(true);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("replaces an older verbose layout in place using the same saved review", async () => {
    const h = remote();
    await seed(h);
    const ids = h.comments.map((comment) => comment.id);
    for (const comment of h.comments) {
      const newline = comment.body.indexOf("\n");
      const marker: Record<string, unknown> = JSON.parse(Buffer.from(
        /^<!-- downside-up-pr-v2:([A-Za-z0-9_-]+) -->/.exec(comment.body)![1]!, "base64url").toString("utf8"));
      const content = comment.path
        ? `<details>\n<summary>a.ts</summary>\n\n${comment.body.slice(newline + 1)}\n\n### Limitations\n- None recorded\n\n</details>`
        : `${comment.body.slice(newline + 1)}\n\n## Material limitations\n- Previous presentation boilerplate`;
      marker.hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      comment.body = `<!-- downside-up-pr-v2:${Buffer.from(JSON.stringify(marker)).toString("base64url")} -->\n${content}`;
    }
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 0, update: 2, supersede: 0, delete: 0 });
    expect(prepared.edited).toBe(0);
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.comments.map((comment) => comment.id)).toEqual(ids);
    expect(h.posts).toHaveLength(2);
    expect(h.comments.find((comment) => comment.path)!.body).not.toContain("<summary>a.ts</summary>");
    expect(h.comments.find((comment) => comment.path)!.body).not.toContain("### Limitations");
    expect(h.comments.find((comment) => !comment.path)!.body).toContain("<summary>Review details</summary>");
    expect(h.comments.find((comment) => !comment.path)!.body).not.toContain("Previous presentation boilerplate");
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("creates fresh anchors after a new head, supersedes old file discussions, and preserves replies", async () => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    const oldContent = oldFile.body.slice(oldFile.body.indexOf("\n") + 1);
    h.comments.push({ ...oldFile, id: 3, html_url: oldFile.html_url.replace(/discussion_r\d+$/, "discussion_r3"),
      body: "A human reply", in_reply_to_id: oldFile.id });
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, update);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 1, update: 1, supersede: 1, delete: 0 });
    expect(prepared.parts.map((part) => [part.action, part.path])).toEqual([
      ["create", "a.ts"], ["update", undefined], ["supersede", "a.ts"]
    ]);
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.request.mock.calls.filter((call) => call[3]).slice(2).map((call) => [call[1], call[4]])).toEqual([
      ["repos/owner/repo/pulls/42/comments", undefined],
      ["repos/owner/repo/issues/comments/2", "PATCH"],
      ["repos/owner/repo/pulls/comments/1", "PATCH"]
    ]);
    const replacement = h.comments.find((comment) => comment.path && comment.commit_id === head)!;
    expect(oldFile.body).toContain(oldContent);
    expect(oldFile.body).toContain(`](${replacement.html_url})`);
    expect(oldFile.body).toContain("Superseded");
    expect(oldFile.commit_id).not.toBe(head);
    expect(h.comments.find((comment) => comment.in_reply_to_id)?.body).toBe("A human reply");
    expect(h.comments.filter((comment) => !comment.path)).toHaveLength(1);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("retires discussions for files no longer in the PR and links them to the updated summary", async () => {
    const h = remote();
    await seed(h);
    const oldFile = h.comments.find((comment) => comment.path)!;
    h.comments.push({ ...oldFile, id: 3, html_url: oldFile.html_url.replace(/discussion_r\d+$/, "discussion_r3"),
      body: "Keep this discussion", in_reply_to_id: oldFile.id });
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "b.ts"), "export const b = 1;\n");
    git("add", "."); git("commit", "-qm", "replace PR scope"); head = git("rev-parse", "HEAD");
    revision = { base, head, files: [{ path: "b.ts", status: "added" }] };
    ref = { ...ref, original: { ...ref.original, path: "b.ts" }, modified: { ...ref.modified, path: "b.ts" } };
    scope = { ...scope, items: [{ path: "b.ts", ref, confirmed: snapshotSignature(await readComparison(ref)) }] };
    const exported = { ...data(), files: [{ path: "b.ts", status: "missing" as const }] };
    const prepare = () => preparePublication(h.client, scope, exported, readComparison, signal, update);
    const prepared = await prepare();
    expect(prepared.counts).toEqual({ create: 0, update: 1, supersede: 1, delete: 0 });
    await publishReview(h.client, prepared, prepare, signal, noop);
    expect(h.comments.find((comment) => comment.path === "a.ts")!.body)
      .toContain(`](${h.comments.find((comment) => !comment.path)!.html_url})`);
  });

  it("returns edited counts for inspection and rejects publishing until a separate confirmation", async () => {
    const h = remote();
    await seed(h);
    h.comments.find((comment) => !comment.path)!.body += "\nmanual summary edit";
    h.comments.find((comment) => comment.path)!.body += "\nmanual file edit";
    const prepare = (allowEdited = false) => preparePublication(h.client, scope, data(true, "New saved content."),
      readComparison, signal, { ...update, allowEdited });
    const inspect = await prepare();
    expect(inspect.edited).toBe(2);
    expect(inspect.counts.update).toBe(2);
    await expect(publishReview(h.client, inspect, () => prepare(), signal, noop)).rejects.toThrow("separate explicit confirmation");
    expect(h.patches).toHaveLength(0);
    const confirmed = await prepare(true);
    expect(confirmed.fingerprint).toBe(inspect.fingerprint);
    await publishReview(h.client, confirmed, () => prepare(true), signal, noop);
    expect(h.patches).toHaveLength(2);
  });

  it("requires edited confirmation for superseding an old manually edited file comment too", async () => {
    const h = remote();
    await seed(h);
    h.comments.find((comment) => comment.path)!.body += "\nmanual context";
    await advanceHead();
    const prepared = await preparePublication(h.client, scope, data(true), readComparison, signal, update);
    expect(prepared.edited).toBe(1);
    expect(prepared.counts.supersede).toBe(1);
    await expect(publishReview(h.client, prepared, async () => prepared, signal, noop)).rejects.toThrow("separate explicit");
    expect(h.posts).toHaveLength(2);
  });

  it("detects an edit made after confirmation with an immediate GET and does not PATCH", async () => {
    const h = remote();
    await seed(h);
    const prepare = () => preparePublication(h.client, scope, data(true, "New content."), readComparison, signal,
      { ...update, allowEdited: true });
    const prepared = await prepare();
    const beforeWrite = vi.fn(async () => { h.comments[0]!.body += "\nconcurrent edit"; });
    const failure = await publishReview(h.client, prepared, prepare, signal, noop, beforeWrite).catch((error) => error);
    expect(failure.message).toContain("changed after confirmation");
    expect(failure.message).not.toContain("last comment may");
    expect(h.patches).toHaveLength(0);
  });

  it("conservatively discovers legacy v1 comments and requires explicit edited authorization", async () => {
    const h = remote();
    await seed(h);
    for (const comment of h.comments) {
      comment.body = comment.body.replace(/^<!-- downside-up-pr-v2:[^\n]+ -->/, `<!-- downside-up-pr-v1:${"a".repeat(64)} -->`);
    }
    const prepare = (allowEdited = false) => preparePublication(h.client, scope, data(true), readComparison, signal,
      { ...update, allowEdited });
    const prepared = await prepare();
    expect(prepared.edited).toBe(2);
    expect(prepared.counts).toEqual({ create: 1, update: 1, supersede: 1, delete: 0 });
    await expect(publishReview(h.client, prepared, () => prepare(), signal, noop)).rejects.toThrow("legacy");
    await publishReview(h.client, await prepare(true), () => prepare(true), signal, noop);
    expect(h.comments.find((comment) => comment.path)!.body).toContain("Superseded");
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("never edits another account's marker, a reply, or a line comment", async () => {
    const h = remote();
    await seed(h);
    const file = h.comments.find((comment) => comment.path)!;
    file.user.login = "another-account";
    h.comments.push({ ...file, user: { login: "reader" }, id: 3,
      html_url: file.html_url.replace(/discussion_r\d+$/, "discussion_r3"), in_reply_to_id: file.id });
    h.comments.push({ ...file, user: { login: "reader" }, id: 4,
      html_url: file.html_url.replace(/discussion_r\d+$/, "discussion_r4"), subject_type: "line" });
    const prepared = await preparePublication(h.client, scope, data(true, "New content."), readComparison, signal, update);
    expect(prepared.counts).toEqual({ create: 1, update: 1, supersede: 0, delete: 0 });
    await publishReview(h.client, prepared, async () => prepared, signal, noop, async () => undefined);
    expect(h.patches.map((patch) => patch.id)).toEqual([2]);
  });

  it("rejects ambiguous summaries and damaged markers instead of guessing ownership", async () => {
    const h = remote();
    await seed(h);
    const summary = h.comments.find((comment) => !comment.path)!;
    h.comments.push({ ...summary, id: 3, html_url: summary.html_url.replace(/issuecomment-\d+$/, "issuecomment-3") });
    await expect(preparePublication(h.client, scope, data(true), readComparison, signal, update)).rejects.toThrow("ambiguous");
    h.comments.pop();
    summary.body = "<!-- downside-up-pr-v2:damaged -->\ncontent";
    await expect(preparePublication(h.client, scope, data(true), readComparison, signal, update)).rejects.toThrow("damaged");
  });

  it("reports partial/uncertain PATCHes without retry and resumes only the remaining deterministic retirement", async () => {
    const h = remote();
    await seed(h);
    h.comments.find((comment) => comment.path)!.body += "\nmanual context";
    await advanceHead();
    const prepare = () => preparePublication(h.client, scope, data(true), readComparison, signal, { ...update, allowEdited: true });
    const prepared = await prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      if (args[4] === "PATCH" && args[1].endsWith("/pulls/comments/1")) throw new Error("SECRET source error");
      return original(...args);
    });
    const failure = await publishReview(h.client, prepared, prepare, signal, noop).catch((error) => error);
    expect(failure.message).toContain("2 comment(s) confirmed");
    expect(failure.message).toContain("last comment may also");
    expect(failure.message).not.toContain("SECRET");
    expect(h.request.mock.calls.filter((call) => call[4] === "PATCH" && call[1].endsWith("/pulls/comments/1"))).toHaveLength(1);
    h.request.mockImplementation(original);
    const retry = await prepare();
    expect(retry.counts).toEqual({ create: 0, update: 0, supersede: 1, delete: 0 });
    await publishReview(h.client, retry, prepare, signal, noop);
    expect(h.posts).toHaveLength(3);
    expect((await prepare()).parts).toHaveLength(0);
  });

  it("discovers an uncertain successful POST before a separately requested retry", async () => {
    const h = remote();
    const prepare = () => preparePublication(h.client, scope, data(), readComparison, signal, update);
    const prepared = await prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[3]) throw new Error("response lost");
      return response;
    });
    await expect(publishReview(h.client, prepared, prepare, signal, noop)).rejects.toThrow("last comment may also");
    h.request.mockImplementation(original);
    const retry = await prepare();
    expect(retry.parts).toHaveLength(0);
    await publishReview(h.client, retry, prepare, signal, noop);
    expect(h.posts).toHaveLength(1);
  });

  it("honors cancellation before a mutation and retains an acknowledged write after cancellation", async () => {
    const h = remote();
    await seed(h);
    const prepare = () => preparePublication(h.client, scope, data(true, "New content."), readComparison, signal, update);
    const prepared = await prepare();
    const before = new AbortController();
    await expect(publishReview(h.client, prepared, prepare, before.signal, noop, async () => before.abort()))
      .rejects.toThrow("0 comment(s) confirmed");
    expect(h.patches).toHaveLength(0);
    const after = new AbortController();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[4] === "PATCH") after.abort();
      return result;
    });
    const failure = await publishReview(h.client, prepared, prepare, after.signal, noop, async () => undefined).catch((error) => error);
    expect(failure.message).toContain("1 comment(s) confirmed");
    expect(failure.message).not.toContain("last comment may also");
    expect(h.patches).toHaveLength(1);
    expect(h.comments[0]!.body).toContain("New content");
  });

  it("cannot update with duplicate discovery disabled or publish saved files outside the confirmed set", async () => {
    const h = remote();
    await expect(preparePublication(h.client, scope, data(), readComparison, signal,
      { ...update, checkDuplicates: false })).rejects.toThrow("requires checking");
    const outside = { ...data(true), files: data(true).files.map((file) => ({ ...file, path: "outside.ts" })) };
    await expect(preparePublication(h.client, scope, outside, readComparison, signal, update)).rejects.toThrow("confirmed review scope");
    expect(h.posts).toHaveLength(0);
  });

  it("binds confirmation to the saved evidence, not the incidental export timestamp", async () => {
    const h = remote();
    const first = await preparePublication(h.client, scope, data(), readComparison, signal, update);
    const exportedLater = await preparePublication(h.client, scope, { ...data(), exportedAt: 456 }, readComparison, signal, update);
    expect(exportedLater.fingerprint).toBe(first.fingerprint);
    const resaved = await preparePublication(h.client, scope, {
      ...data(), summary: { ...data().summary, savedAt: 2 }
    }, readComparison, signal, update);
    await expect(publishReview(h.client, first, async () => resaved, signal, noop)).rejects.toThrow("review evidence");
    expect(h.posts).toHaveLength(0);
  });

  it("still recognizes exact legacy v1 duplicates without authorizing any overwrite", async () => {
    const h = remote();
    const prepared = await preparePublication(h.client, scope, data(), readComparison, signal);
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const identity = hash([target, revision.base, revision.head, base,
      scope.items.map((item) => [item.path, item.confirmed]).sort()]);
    h.comments.push({
      id: 1, html_url: "https://github.com/owner/repo/pull/42#issuecomment-1", user: { login: "reader" },
      body: `<!-- downside-up-pr-v1:${hash([identity, "summary"])} -->` +
        prepared.parts[0]!.body.slice(prepared.parts[0]!.body.indexOf("\n"))
    });
    const duplicate = await preparePublication(h.client, scope, data(), readComparison, signal);
    expect(duplicate.existing).toBe(1);
    expect(duplicate.parts).toHaveLength(0);
  });

  it.each([true, false])("preserves create-only boolean freshness revalidation with a partial existing publication (lightweight fence: %s)", async (lightweight) => {
    const h = remote();
    await seed(h);
    h.comments.splice(1, 1);
    const prepared = await preparePublication(h.client, scope, data(true), readComparison, signal);
    expect(prepared.existing).toBe(1);
    expect(prepared.parts).toHaveLength(1);
    await publishReview(h.client, prepared,
      () => preparePublication(h.client, scope, data(true), readComparison, signal, false), signal, noop,
      lightweight ? async () => undefined : undefined);
    expect(h.posts).toHaveLength(3);
  });

  it("revalidates every create with legacy false and no lightweight callback without changing marker bytes", async () => {
    const h = remote();
    const prepared = await preparePublication(h.client, scope, data(true), readComparison, signal);
    const revalidate = vi.fn(() => preparePublication(h.client, scope, data(true), readComparison, signal, false));
    const discoveryReads = h.request.mock.calls.filter((call) => call[1].includes("/comments?")).length;
    await publishReview(h.client, prepared, revalidate, signal, noop);
    expect(revalidate).toHaveBeenCalledTimes(3);
    expect(h.posts.map((post) => post.path)).toEqual(["a.ts", undefined]);
    expect(h.posts.map((post) => post.body)).toEqual(prepared.parts.map((part) => part.body));
    expect(h.request.mock.calls.filter((call) => call[1].includes("/comments?"))).toHaveLength(discoveryReads);
  });

  it("preserves controlled host validation messages without exposing unknown callback failures", async () => {
    const h = remote();
    const prepared = await preparePublication(h.client, scope, data(), readComparison, signal);
    await expect(publishReview(h.client, prepared, async () => prepared, signal, noop, async () => {
      throw new PublicationValidationError("Reviewed source or saved summary changed.");
    })).rejects.toThrow("Reviewed source or saved summary changed");
    const failure = await publishReview(h.client, prepared, async () => prepared, signal, noop, async () => {
      throw new Error("SECRET source error");
    }).catch((error) => error);
    expect(failure.message).not.toContain("SECRET");
    expect(h.posts).toHaveLength(0);
  });
});
