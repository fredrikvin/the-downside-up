import { describe, expect, it, vi } from "vitest";
import {
  parsePullRequestUrl, PullRequestClient, type GitHubDiffLine, type GitHubRequest
} from "../src/github/client";

const target = parsePullRequestUrl("https://github.example.com/owner/repo/pull/42");
const signal = new AbortController().signal;
const base = "a".repeat(40);
const head = "b".repeat(40);
const metadata = { state: "open", changed_files: 1, base: { sha: base, repo: { full_name: "owner/repo" } }, head: { sha: head } };
const comment = (file = false, id = 1) => ({
  id, html_url: `https://github.example.com/owner/repo/pull/42#${file ? "discussion_r" : "issuecomment-"}${id}`,
  body: "saved explanation", user: { login: "reader" },
  ...(file ? { path: "new.ts", commit_id: head, original_commit_id: head, subject_type: "file" } : {})
});
const lineComment = (line: number | null = 7, side = "RIGHT") => ({
  ...comment(true), subject_type: "line", line, side
});

async function patchRevision(patch: unknown, extra: Record<string, unknown> = {}) {
  const lines = typeof patch === "string" ? patch.split("\n") : [];
  const request = vi.fn<GitHubRequest>().mockResolvedValueOnce(metadata).mockResolvedValueOnce([{
    filename: "new.ts", status: "modified", patch,
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length, ...extra
  }]);
  return new PullRequestClient(target, request).revision(signal);
}

describe("bounded GitHub diff-line discovery", () => {
  it("reproduces the live line 1284 / diff position 13 anchor without source text", async () => {
    const revision = await patchRevision([
      "@@ -1277,15 +1277,11 @@", ...Array<string>(7).fill(" context"),
      ...Array<string>(5).fill("-before"), "+after", ...Array<string>(3).fill(" context")
    ].join("\n"));
    expect(revision.files[0]?.diffLines?.find((anchor) => anchor.side === "RIGHT"))
      .toEqual({ line: 1284, side: "RIGHT", position: 13 });
  });

  it("extracts only actual added/deleted lines across complete hunks, including renames and function headers", async () => {
    const revision = await patchRevision(
      "@@ -2,3 +2,4 @@ function example()\n context\n-old\n+new\n+extra\n context\n@@ -20 +21 @@\n-before\n+after",
      { status: "renamed", previous_filename: "old.ts", additions: 3, deletions: 2 });
    expect(revision.files).toEqual([{
      path: "new.ts", oldPath: "old.ts", status: "renamed", diffLines: [
        { line: 3, side: "LEFT", position: 2 }, { line: 3, side: "RIGHT", position: 3 }, { line: 4, side: "RIGHT", position: 4 },
        { line: 20, side: "LEFT", position: 7 }, { line: 21, side: "RIGHT", position: 8 }
      ]
    }]);
    expect(JSON.stringify(revision)).not.toContain("function example");
    expect(revision.files[0]).not.toHaveProperty("patch");
  });

  it.each([
    ["@@ -0,0 +1,2 @@\n+one\n+two\n", [{ line: 1, side: "RIGHT", position: 1 }, { line: 2, side: "RIGHT", position: 2 }]],
    ["@@ -1,2 +0,0 @@\n-one\n-two", [{ line: 1, side: "LEFT", position: 1 }, { line: 2, side: "LEFT", position: 2 }]],
    ["@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+different\n\\ No newline at end of file",
      [{ line: 1, side: "LEFT", position: 1 }, { line: 1, side: "RIGHT", position: 3 }]],
    ["@@ -1 +1 @@\n context", []]
  ])("handles zero-count ranges, context, and no-newline markers: %s", async (patch, expected) => {
    expect((await patchRevision(patch)).files[0]?.diffLines).toEqual(expected);
  });

  it.each([
    undefined, null, 3, "", "binary file",
    "@@ -1 +1 @@\n-old", // incomplete new side
    "@@ -1 +1 @@\n-old\n+new\n+excess",
    "@@ -1 +1 @@\n-old\n+new\n@@ -5,2 +5,2 @@\n context", // discard earlier valid hunk
    "@@ -1 +1 @@\n-old\n+new\ntruncated",
    "@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n\\ invalid marker",
    "@@ -0 +1 @@\n-old\n+new",
    "@@ -1,0 +1,0 @@",
    "@@ -9007199254740991,2 +1 @@\n-old\n-old\n+new",
    "@@ -9007199254740992 +1 @@\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new",
    "@@ -1 +2 @@\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n@@ -5 +6 @@\n-old\n+new",
    "@@ -1 +1 @@bad\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n+more"
  ])("provides no anchors for missing, malformed, or truncated patches: %s", async (patch) => {
    expect((await patchRevision(patch)).files[0]?.diffLines ?? []).toEqual([]);
  });

  it("rejects totals that expose truncation at a complete hunk boundary or malformed counts", async () => {
    for (const extra of [
      { additions: 2, deletions: 1 }, { additions: 1, deletions: 2 }, { additions: "1" },
      { additions: undefined }, { deletions: undefined }, { additions: null }, { deletions: -1 }
    ]) {
      expect((await patchRevision("@@ -1 +1 @@\n-old\n+new", extra)).files[0]?.diffLines ?? []).toEqual([]);
    }
  });

  it("enforces UTF-8 byte and patch-line bounds", async () => {
    const exact = "@@ -0,0 +1 @@\n+" + "a".repeat(1024 * 1024 - "@@ -0,0 +1 @@\n+".length);
    expect((await patchRevision(exact)).files[0]?.diffLines).toEqual([{ line: 1, side: "RIGHT", position: 1 }]);
    expect((await patchRevision(exact + "a")).files[0]?.diffLines ?? []).toEqual([]);
    expect((await patchRevision(exact.replaceAll("a", "é"))).files[0]?.diffLines ?? []).toEqual([]);
    const atLimit = "@@ -0,0 +1,49999 @@\n" + Array(49_999).fill("+").join("\n");
    expect((await patchRevision(atLimit)).files[0]?.diffLines).toHaveLength(49_999);
    const overLimit = "@@ -0,0 +1,50000 @@\n" + Array(50_000).fill("+").join("\n");
    expect((await patchRevision(overLimit)).files[0]?.diffLines ?? []).toEqual([]);
  });
});

describe("GitHub line comment identity and mutation", () => {
  it("uses a verified diff position without unsupported line parameters and checks the returned line", async () => {
    const request = vi.fn<GitHubRequest>().mockResolvedValue(lineComment(1284));
    await new PullRequestClient(target, request).post("saved explanation", head, signal, "new.ts", undefined,
      { line: 1284, side: "RIGHT", position: 13 });
    expect(request.mock.calls[0]![3]).toEqual({
      body: "saved explanation", commit_id: head, path: "new.ts", position: 13
    });
  });
  it("spaces mutations by a second, rechecks identities after waiting, and cancels queued writes", async () => {
    const times: number[] = [];
    const request = vi.fn<GitHubRequest>(async () => { times.push(Date.now()); return comment(); });
    const client = new PullRequestClient(target, request);
    await client.post("saved explanation", head, signal);
    const updating = client.update({
      id: 1, url: comment().html_url, type: "summary", body: "saved explanation", author: "reader",
      mutationEndpoint: "repos/owner/repo/issues/comments/1"
    }, "saved explanation", signal);
    expect(request).toHaveBeenCalledTimes(1);
    await updating;
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1_000);
    expect(request.mock.calls.map((call) => call[4])).toEqual([undefined, undefined, "PATCH"]);
    const controller = new AbortController();
    const queued = client.post("saved explanation", head, controller.signal).catch((error: unknown) => error);
    controller.abort();
    expect(await queued).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["LEFT", "RIGHT"] as const)("posts a head-pinned %s line comment with a checked receipt", async (side) => {
    const request = vi.fn<GitHubRequest>().mockResolvedValue(lineComment(7, side));
    const beforeWrite = vi.fn();
    const receipt = await new PullRequestClient(target, request).post(
      "saved explanation", head, signal, "new.ts", beforeWrite, { line: 7, side, position: 13 });
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ subjectType: "line", line: 7, side });
    expect(request).toHaveBeenCalledWith(target, "repos/owner/repo/pulls/42/comments", signal, {
      body: "saved explanation", commit_id: head, path: "new.ts", position: 13
    });
  });

  it.each([
    { line: 8 }, { side: "LEFT" }, { line: null }, { line: undefined },
    { side: undefined }, { subject_type: "file" }, { in_reply_to_id: 2 },
    { path: "other.ts" }, { commit_id: base }, { original_commit_id: base }
  ])("rejects an incorrect line publication receipt: %j", async (changes) => {
    const request = vi.fn<GitHubRequest>().mockResolvedValue({ ...lineComment(), ...changes });
    await expect(new PullRequestClient(target, request).post(
      "saved explanation", head, signal, "new.ts", undefined, { line: 7, side: "RIGHT", position: 13 })).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { line: 0, side: "RIGHT" }, { line: -1, side: "RIGHT" }, { line: 1.5, side: "RIGHT" },
    { line: Number.MAX_SAFE_INTEGER + 1, side: "RIGHT" }, { line: 1, side: "OTHER", position: 1 },
    ...[undefined, 0, -1, 1.5, 50_000, Number.MAX_SAFE_INTEGER + 1].map((position) => ({ line: 1, side: "RIGHT", position }))
  ])("rejects unsafe outbound anchors before writing: %j", async (anchor) => {
    const request = vi.fn<GitHubRequest>();
    await expect(new PullRequestClient(target, request).post(
      "body", head, signal, "new.ts", undefined, { position: 1, ...anchor } as GitHubDiffLine)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("requires a path for a line anchor", async () => {
    const request = vi.fn<GitHubRequest>();
    await expect(new PullRequestClient(target, request).post(
      "body", head, signal, undefined, undefined, { line: 1, side: "LEFT", position: 1 })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts outdated nullable lines without inventing a current line", async () => {
    const request = vi.fn<GitHubRequest>().mockResolvedValueOnce([lineComment(null, "LEFT")]).mockResolvedValueOnce([]);
    const [parsed] = await new PullRequestClient(target, request).comments(signal);
    expect(parsed).toMatchObject({ subjectType: "line", side: "LEFT" });
    expect(parsed?.line).toBeUndefined();
  });

  it.each([{ line: 0 }, { line: -2 }, { line: 1.1 }, { line: "7" }, { line: NaN }, { line: Infinity },
    { side: "OTHER" }, { side: null }])("rejects invalid API line metadata: %j", async (changes) => {
    const request = vi.fn<GitHubRequest>().mockResolvedValueOnce([{ ...lineComment(), ...changes }]);
    await expect(new PullRequestClient(target, request).comments(signal)).rejects.toThrow();
  });

  async function existingLine(raw: ReturnType<typeof lineComment> & { in_reply_to_id?: number } = lineComment()) {
    const request = vi.fn<GitHubRequest>().mockResolvedValueOnce([raw]).mockResolvedValueOnce([]);
    const client = new PullRequestClient(target, request);
    const [expected] = await client.comments(signal);
    request.mockReset();
    return { client, request, expected: expected!, raw };
  }

  it.each([7, null])("updates caller-verified root line comments, including outdated line %s", async (line) => {
    const h = await existingLine(lineComment(line));
    h.request.mockResolvedValueOnce(h.raw).mockResolvedValueOnce({ ...h.raw, body: "replacement" });
    expect(await h.client.update(h.expected, "replacement", signal)).toMatchObject({ body: "replacement" });
    expect(h.request.mock.calls.map((call) => call[4])).toEqual([undefined, "PATCH"]);
  });

  it.each([7, null])("deletes caller-verified root line comments after account, scan and GET checks: %s", async (line) => {
    const h = await existingLine(lineComment(line));
    h.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([h.raw])
      .mockResolvedValueOnce(h.raw).mockResolvedValueOnce(undefined);
    await expect(h.client.delete(h.expected, "reader", signal)).resolves.toBe("deleted");
    expect(h.request.mock.calls.map((call) => call[1])).toEqual([
      "user", "repos/owner/repo/pulls/42/comments?per_page=100&page=1",
      "repos/owner/repo/pulls/comments/1", "repos/owner/repo/pulls/comments/1"
    ]);
    expect(h.request.mock.calls[3]?.[4]).toBe("DELETE");
  });

  it.each([{ line: 8 }, { line: null }, { side: "LEFT" }, { in_reply_to_id: 2 }, { body: "edited" },
    { user: { login: "other" } }])("blocks root-line mutations on immediate GET identity/body changes: %j", async (changes) => {
    const h = await existingLine();
    h.request.mockResolvedValueOnce({ ...h.raw, ...changes });
    await expect(h.client.update(h.expected, "replacement", signal)).rejects.toThrow("changed after confirmation");
    h.request.mockReset();
    h.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([h.raw])
      .mockResolvedValueOnce({ ...h.raw, ...changes });
    await expect(h.client.delete(h.expected, "reader", signal)).rejects.toThrow("changed after confirmation");
    expect(h.request.mock.calls.some((call) => call[4] === "PATCH" || call[4] === "DELETE")).toBe(false);
  });

  it("preserves line identity in PATCH receipts", async () => {
    const h = await existingLine();
    h.request.mockResolvedValueOnce(h.raw).mockResolvedValueOnce({ ...h.raw, line: 8, body: "replacement" });
    await expect(h.client.update(h.expected, "replacement", signal)).rejects.toThrow("expected update");
  });

  it("stops a line write cancelled at beforeWrite, but retains a confirmed receipt after cancellation", async () => {
    const request = vi.fn<GitHubRequest>();
    const controller = new AbortController();
    const client = new PullRequestClient(target, request);
    await expect(client.post("saved explanation", head, controller.signal, "new.ts",
      () => controller.abort(), { line: 7, side: "RIGHT", position: 13 })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const after = new AbortController();
    request.mockImplementationOnce(async () => { after.abort(); return lineComment(); });
    await expect(client.post("saved explanation", head, after.signal, "new.ts",
      undefined, { line: 7, side: "RIGHT", position: 13 })).resolves.toMatchObject({ line: 7, side: "RIGHT" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("never mutates replies and retains root threads with late replies", async () => {
    const h = await existingLine({ ...lineComment(), in_reply_to_id: 3 });
    h.request.mockResolvedValueOnce(h.raw);
    await expect(h.client.update(h.expected, "replacement", signal)).rejects.toThrow();
    await expect(h.client.delete(h.expected, "reader", signal)).rejects.toThrow();
    expect(h.request.mock.calls.some((call) => call[4] !== undefined)).toBe(false);
    const root = await existingLine();
    root.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([
      root.raw, { ...comment(true, 2), subject_type: "line", line: 7, side: "RIGHT", in_reply_to_id: 1 }
    ]).mockResolvedValueOnce(root.raw);
    await expect(root.client.delete(root.expected, "reader", signal)).resolves.toBe("replies");
    expect(root.request.mock.calls.some((call) => call[4] === "DELETE")).toBe(false);
  });

  it.each(["update", "delete"] as const)("checks cancellation before %s and keeps successful acknowledgements after it", async (operation) => {
    for (const cancelBeforeWrite of [true, false]) {
      const h = await existingLine();
      const controller = new AbortController();
      if (operation === "delete") {
        h.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([h.raw]);
      }
      h.request.mockResolvedValueOnce(h.raw).mockImplementationOnce(async () => {
        controller.abort();
        return operation === "delete" ? undefined : { ...h.raw, body: "replacement" };
      });
      const beforeWrite = () => { if (cancelBeforeWrite) controller.abort(); };
      const result = operation === "delete"
        ? h.client.delete(h.expected, "reader", controller.signal, beforeWrite)
        : h.client.update(h.expected, "replacement", controller.signal, beforeWrite);
      if (cancelBeforeWrite) await expect(result).rejects.toThrow();
      else if (operation === "delete") await expect(result).resolves.toBe("deleted");
      else await expect(result).resolves.toMatchObject({ body: "replacement", line: 7 });
      expect(h.request.mock.calls.filter((call) => call[4] !== undefined)).toHaveLength(cancelBeforeWrite ? 0 : 1);
    }
  });
});

describe("GitHub PR destination and bounded reads", () => {
  it.each([
    "http://github.com/o/r/pull/1", "https://user:secret@github.com/o/r/pull/1",
    "https://github.com/o/r/pull/1?token=x", "https://github.com/o/r/pull/1#fragment",
    "https://github.com/o/r/pull/0", "https://github.com/o/r/pull/1/files",
    "https://github.com/o/r%2Fx/pull/1", "https://github.com/o/r/pull/99999999999999999999"
  ])("rejects ambiguous or credential-bearing PR URLs: %s", (url) => {
    expect(() => parsePullRequestUrl(url)).toThrow();
  });

  it("uses explicit host/repository and preserves rename paths without relying on branch inference", async () => {
    const request = vi.fn<GitHubRequest>()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce([{ filename: "new.ts", previous_filename: "old.ts", status: "renamed" }]);
    const revision = await new PullRequestClient(target, request).revision(signal);
    expect(revision).toEqual({ base, head, files: [{ path: "new.ts", oldPath: "old.ts", status: "renamed" }] });
    expect(request.mock.calls.map(([destination, endpoint]) => [destination, endpoint])).toEqual([
      [target, "repos/owner/repo/pulls/42"], [target, "repos/owner/repo/pulls/42/files?per_page=100&page=1"]
    ]);
  });

  it("rejects overlarge, incomplete, duplicate, or unsafe PR file lists", async () => {
    for (const [meta, files] of [
      [{ ...metadata, changed_files: 201 }, []],
      [metadata, []],
      [{ ...metadata, changed_files: 2 }, [{ filename: "a.ts", status: "modified" }, { filename: "a.ts", status: "modified" }]],
      [metadata, [{ filename: "../a.ts", status: "modified" }]],
      [{ ...metadata, state: "closed" }, []]
    ]) {
      const request = vi.fn<GitHubRequest>().mockResolvedValueOnce(meta).mockResolvedValueOnce(files);
      await expect(new PullRequestClient(target, request).revision(signal)).rejects.toThrow();
    }
  });

  it("reads at most ten full pages when duplicate checking cannot complete", async () => {
    const request = vi.fn<GitHubRequest>().mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => comment(true, i + 1)));
    request.mockImplementation(async (_target, endpoint) => {
      const page = Number(new URL(`https://test/${endpoint}`).searchParams.get("page"));
      return Array.from({ length: 100 }, (_, i) => comment(true, (page - 1) * 100 + i + 1));
    });
    await expect(new PullRequestClient(target, request).comments(signal)).rejects.toThrow("Too many existing comments");
    expect(request).toHaveBeenCalledTimes(10);
  });

  it("posts file-level comments pinned to the PR head, with no arbitrary line numbers", async () => {
    const request = vi.fn<GitHubRequest>().mockResolvedValue(comment(true));
    await new PullRequestClient(target, request).post("saved explanation", head, signal, "new.ts");
    expect(request).toHaveBeenCalledWith(target, "repos/owner/repo/pulls/42/comments", signal, {
      body: "saved explanation", commit_id: head, path: "new.ts", subject_type: "file"
    });
  });

  it("exposes validated comment IDs, destinations, and anchors, retaining but not mutating replies", async () => {
      const request = vi.fn<GitHubRequest>()
        .mockResolvedValueOnce([comment(true), { ...comment(true, 2), in_reply_to_id: 1 }])
        .mockResolvedValueOnce([comment()]);
      const comments = await new PullRequestClient(target, request).comments(signal);
      expect(comments[0]).toMatchObject({
        id: 1, type: "file", path: "new.ts", head, originalHead: head, subjectType: "file",
        mutationEndpoint: "repos/owner/repo/pulls/comments/1"
      });
      expect(comments[1]).toHaveProperty("replyTo", 1);
      expect(comments[2]).toMatchObject({ type: "summary", mutationEndpoint: "repos/owner/repo/issues/comments/1" });
    });

    it.each([
      { id: -1 }, { id: 1.5 }, { html_url: "https://evil.example/owner/repo/pull/42#discussion_r1" },
      { html_url: "https://github.example.com/owner/other/pull/42#discussion_r1" },
      { html_url: "https://github.example.com/owner/repo/pull/42#issuecomment-1" },
      { path: "../private" }, { commit_id: "bad" }, { original_commit_id: "bad" },
      { subject_type: "unknown" }, { in_reply_to_id: 0 }
    ])("rejects unsafe comment metadata: %j", async (changes) => {
      const request = vi.fn<GitHubRequest>().mockResolvedValueOnce([{ ...comment(true), ...changes }]);
      await expect(new PullRequestClient(target, request).comments(signal)).rejects.toThrow();
    });

    it("compares the expected body immediately before a single PATCH and checks its receipt", async () => {
      const request = vi.fn<GitHubRequest>()
        .mockResolvedValueOnce([comment(true)]).mockResolvedValueOnce([])
        .mockResolvedValueOnce(comment(true)).mockResolvedValueOnce({ ...comment(true), body: "new explanation" });
      const client = new PullRequestClient(target, request);
      const [expected] = await client.comments(signal);
      const receipt = await client.update(expected!, "new explanation", signal);
      expect(receipt.body).toBe("new explanation");
      expect(request.mock.calls.slice(2)).toEqual([
        [target, "repos/owner/repo/pulls/comments/1", signal, undefined],
        [target, "repos/owner/repo/pulls/comments/1", signal, { body: "new explanation" }, "PATCH"]
      ]);
    });

    it("never PATCHes a concurrently edited comment, even when overwriting its original edit was authorized", async () => {
      const request = vi.fn<GitHubRequest>()
        .mockResolvedValueOnce([]).mockResolvedValueOnce([comment()])
        .mockResolvedValueOnce({ ...comment(), body: "a concurrent edit" });
      const client = new PullRequestClient(target, request);
      const [expected] = await client.comments(signal);
      await expect(client.update(expected!, "replacement", signal)).rejects.toThrow("changed after confirmation");
      expect(request.mock.calls.some((call) => call[4] === "PATCH")).toBe(false);
    });

    it("does not mutate when cancellation arrives during the comparison GET", async () => {
      const controller = new AbortController();
      const request = vi.fn<GitHubRequest>()
        .mockResolvedValueOnce([]).mockResolvedValueOnce([comment()]);
      const client = new PullRequestClient(target, request);
      const [expected] = await client.comments(signal);
      request.mockImplementationOnce(async () => { controller.abort(); return comment(); });
      await expect(client.update(expected!, "replacement", controller.signal)).rejects.toThrow();
      expect(request.mock.calls.some((call) => call[4] === "PATCH")).toBe(false);
    });

    it("sanitizes injected transport errors without a retry", async () => {
      const request = vi.fn<GitHubRequest>().mockRejectedValue(new Error("SECRET source or credentials"));
      await expect(new PullRequestClient(target, request).account(signal)).rejects.toThrow("GitHub could not be read");
      expect(request).toHaveBeenCalledTimes(1);
    });

    async function deletionClient() {
      const request = vi.fn<GitHubRequest>()
        .mockResolvedValueOnce([comment(true)]).mockResolvedValueOnce([]);
      const client = new PullRequestClient(target, request);
      const [expected] = await client.comments(signal);
      request.mockClear();
      request.mockResolvedValueOnce({ login: "reader" })
        .mockResolvedValueOnce([comment(true)]).mockResolvedValueOnce(comment(true)).mockResolvedValueOnce(undefined);
      return { client, request, expected: expected! };
    }

    it("deletes only after a fresh account, complete file-only reply scan, and exact single-comment GET", async () => {
      const h = await deletionClient();
      await expect(h.client.delete(h.expected, "reader", signal)).resolves.toBe("deleted");
      expect(h.request.mock.calls).toEqual([
        [target, "user", signal, undefined],
        [target, "repos/owner/repo/pulls/42/comments?per_page=100&page=1", signal, undefined],
        [target, "repos/owner/repo/pulls/comments/1", signal, undefined],
        [target, "repos/owner/repo/pulls/comments/1", signal, undefined, "DELETE"]
      ]);
    });

    it("returns late replies without sending DELETE", async () => {
      const h = await deletionClient();
      h.request.mockReset();
      h.request.mockResolvedValueOnce({ login: "reader" })
        .mockResolvedValueOnce([comment(true), { ...comment(true, 2), in_reply_to_id: 1 }])
        .mockResolvedValueOnce(comment(true));
      await expect(h.client.delete(h.expected, "reader", signal)).resolves.toBe("replies");
      expect(h.request.mock.calls.some((call) => call[4] === "DELETE")).toBe(false);
    });

    it.each([
      { body: "edited after confirmation" }, { user: { login: "other-account" } },
      { subject_type: "line" }, { in_reply_to_id: 5 }, { original_commit_id: "c".repeat(40) },
      { path: "other.ts" }, { id: 2, html_url: comment(true, 2).html_url }
    ])("blocks deletion if the comparison GET changes identity or body: %j", async (changes) => {
      const h = await deletionClient();
      h.request.mockReset();
      h.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([comment(true)])
        .mockResolvedValueOnce({ ...comment(true), ...changes });
      await expect(h.client.delete(h.expected, "reader", signal)).rejects.toThrow("changed after confirmation");
      expect(h.request.mock.calls.some((call) => call[4] === "DELETE")).toBe(false);
    });

    it("blocks deletion when the active account changes or the comment disappears from the complete list", async () => {
      const h = await deletionClient();
      h.request.mockReset();
      h.request.mockResolvedValueOnce({ login: "another-account" });
      await expect(h.client.delete(h.expected, "reader", signal)).rejects.toThrow("account changed");
      expect(h.request).toHaveBeenCalledTimes(1);
      h.request.mockReset();
      h.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([]).mockResolvedValueOnce(comment(true));
      await expect(h.client.delete(h.expected, "reader", signal)).rejects.toThrow("changed after confirmation");
      expect(h.request.mock.calls.some((call) => call[4] === "DELETE")).toBe(false);
    });

    it("fails closed when the bounded complete reply scan cannot finish", async () => {
      const h = await deletionClient();
      h.request.mockReset();
      h.request.mockImplementation(async (_target, endpoint) => {
        if (endpoint === "user") return { login: "reader" };
        const page = Number(new URL(`https://test/${endpoint}`).searchParams.get("page"));
        return Array.from({ length: 100 }, (_, i) => comment(true, (page - 1) * 100 + i + 1));
      });
      await expect(h.client.delete(h.expected, "reader", signal)).rejects.toThrow("complete file reply list could not be verified");
      expect(h.request).toHaveBeenCalledTimes(11);
      expect(h.request.mock.calls.some((call) => call[4] === "DELETE")).toBe(false);
    });

    it.each(["scan", "get"])("honors cancellation during the fresh %s before deleting", async (gate) => {
      const h = await deletionClient();
      const controller = new AbortController();
      h.request.mockReset();
      h.request.mockImplementation(async (_target, endpoint) => {
        if (endpoint === "user") return { login: "reader" };
        if (endpoint.includes("?")) {
          if (gate === "scan") controller.abort();
          return [comment(true)];
        }
        controller.abort();
        return comment(true);
      });
      await expect(h.client.delete(h.expected, "reader", controller.signal)).rejects.toThrow();
      expect(h.request.mock.calls.some((call) => call[4] === "DELETE")).toBe(false);
    });

    it("sanitizes an uncertain DELETE without retrying", async () => {
      const h = await deletionClient();
      h.request.mockReset();
      h.request.mockResolvedValueOnce({ login: "reader" }).mockResolvedValueOnce([comment(true)])
        .mockResolvedValueOnce(comment(true)).mockRejectedValueOnce(new Error("SECRET source credentials"));
      const failure = await h.client.delete(h.expected, "reader", signal).catch((error) => error);
      expect(failure.message).toContain("may have been deleted");
      expect(failure.message).not.toContain("SECRET");
      expect(h.request.mock.calls.filter((call) => call[4] === "DELETE")).toHaveLength(1);
    });
});
