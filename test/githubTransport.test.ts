import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  end: vi.fn(),
  on: vi.fn()
}));
vi.mock("node:child_process", () => ({ execFile: mock.exec }));
import { GitHubClientError, parsePullRequestUrl, requestGitHub } from "../src/github/client";

beforeEach(() => {
  vi.clearAllMocks();
  mock.exec.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '{"id":1}'));
    return { stdin: { end: mock.end, on: mock.on } };
  });
});

describe("GitHub CLI transport", () => {
  it("uses fixed argv without a shell and sends generated content only through stdin", async () => {
    const target = parsePullRequestUrl("https://github.example.com/owner/repo/pull/42");
    const signal = new AbortController().signal;
    const body = { body: "`code`; $(do-not-run) @mention\nsource details" };
    expect(await requestGitHub(target, "repos/owner/repo/pulls/42/comments", signal, body)).toEqual({ id: 1 });
    const [command, args, options] = mock.exec.mock.calls[0]!;
    expect(command).toBe("gh");
    expect(args).toEqual(["api", "--hostname", "github.example.com", "--method", "POST",
      "-H", "Accept: application/vnd.github+json", "repos/owner/repo/pulls/42/comments", "--input", "-"]);
    expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal,
      env: { GH_PROMPT_DISABLED: "1" } });
    expect(options.shell).toBeUndefined();
    expect(mock.end).toHaveBeenCalledWith(JSON.stringify(body));
    expect(JSON.stringify(args)).not.toContain("source details");
  });

  it("does not leak CLI stderr, commands, credentials or body in errors and never retries", async () => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("token SECRET generated-source"), ""));
      return { stdin: { end: mock.end, on: mock.on } };
    });

    await expect(requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/1/comments", new AbortController().signal, { body: "source" }))
      .rejects.toThrow("It may have been published");
    expect(mock.exec).toHaveBeenCalledTimes(1);
  });

  it("uses explicit PATCH through stdin without putting an edited body in argv", async () => {
    const target = parsePullRequestUrl("https://github.com/o/r/pull/1");
    const body = { body: "replacement source details" };
    await requestGitHub(target, "repos/o/r/issues/comments/123", new AbortController().signal, body, "PATCH");
    const args = mock.exec.mock.calls[0]![1];
    expect(args).toContain("PATCH");
    expect(args).not.toContain("POST");
    expect(JSON.stringify(args)).not.toContain("replacement source details");
    expect(mock.end).toHaveBeenCalledWith(JSON.stringify(body));
    expect(mock.exec).toHaveBeenCalledTimes(1);
  });

  it("transports diff positions through JSON stdin, never argv", async () => {
    const target = parsePullRequestUrl("https://github.com/o/r/pull/1");
    const body = { body: "private explanation", commit_id: "b".repeat(40),
      path: "private/source.ts", position: 13 };
    await requestGitHub(target, "repos/o/r/pulls/1/comments", new AbortController().signal, body);
    expect(mock.end).toHaveBeenCalledWith(JSON.stringify(body));
    const args = mock.exec.mock.calls[0]![1];
    expect(args).toContain("POST");
    expect(JSON.stringify(args)).not.toContain("private");
    expect(JSON.stringify(args)).not.toContain("position");
    expect(mock.exec).toHaveBeenCalledOnce();
  });

  it("never starts the CLI for an aborted mutation or a different repository", async () => {
    const target = parsePullRequestUrl("https://github.com/o/r/pull/1");
    const controller = new AbortController();
    controller.abort();
    await expect(requestGitHub(target, "repos/o/r/issues/comments/1", controller.signal, { body: "x" }, "PATCH"))
      .rejects.toThrow();
    await expect(requestGitHub(target, "repos/o/other/issues/comments/1", new AbortController().signal, { body: "x" }, "PATCH"))
      .rejects.toThrow();
    expect(mock.exec).not.toHaveBeenCalled();
  });

  it("does not leak mutation stderr when a PATCH response is uncertain", async () => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("credential SECRET source"), ""));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    const error = await requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/issues/comments/1", new AbortController().signal, { body: "source" }, "PATCH").catch((value) => value);
    expect((error as Error).message).toContain("It may have been published");
    expect((error as Error).message).not.toContain("SECRET");
    expect(mock.exec).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 409, 422, 429])("reports definite HTTP %s rejections without leaking response content or claiming a write may have succeeded", async (status) => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("SECRET source"), JSON.stringify({
        message: "PRIVATE text", errors: [
          { field: "line", message: "SECRET source" }, { field: "PRIVATE" }, { field: "side" }, { field: "line" }
        ]
      }), `gh: PRIVATE text (HTTP ${status})\n`));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    const error = await requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/1/comments", new AbortController().signal, { body: "source" }).catch((value) => value);
    if (!(error instanceof GitHubClientError)) throw new Error("Expected a sanitized GitHub rejection.");
    expect(error).toMatchObject({ rejected: true });
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain("invalid fields: line, side.");
    expect(error.message).not.toMatch(/PRIVATE|SECRET|may have/);
    expect(mock.exec).toHaveBeenCalledOnce();
  });

  it.each([408, 500, 502])("retains write uncertainty for HTTP %s responses", async (status) => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("SECRET"), "{}", `gh: failed (HTTP ${status})`));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    const error = await requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/1/comments", new AbortController().signal, { body: "source" }).catch((value) => value);
    if (!(error instanceof GitHubClientError)) throw new Error("Expected an uncertain GitHub write error.");
    expect(error.rejected).toBe(false);
    expect(error.message).toContain("may have been published");
    expect(error.message).not.toContain("SECRET");
  });

  it("reports safe HTTP status even when a rejection body is not JSON", async () => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("SECRET"), "<html>PRIVATE</html>", "gh: failed (HTTP 403)"));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    await expect(requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/1/comments", new AbortController().signal, { body: "source" }))
      .rejects.toThrow("Check GitHub CLI authentication, write permissions, and GitHub rate limits.");
  });

  it.each([
    ["You have exceeded a secondary rate limit.", "GitHub rate-limit or spam protection"],
    ["Review comments was submitted too quickly.", "GitHub rate-limit or spam protection"],
    ["Validation Failed", undefined],
    ["You already have a pending review for this pull request.", "an existing pending review"],
    ["pull_request_review_thread.line must be part of the diff", "a line outside the current diff"],
    ["You have reached the maximum number of reviews.", "GitHub's review count limit"],
    ['Invalid request.\nNo subschema in "oneOf" matched.\n"position" wasn\'t supplied.\n"subject_type" is not a permitted key.\n"line" is not a permitted key.',
      "unsupported line-comment parameters"]
  ])("classifies a 422 signal without exposing raw message text: %s", async (message, reason) => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("SECRET"), JSON.stringify({
        message: "Validation Failed", errors: [{ message: `${message} SECRET source` }]
      }), "gh: failed (HTTP 422)"));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    const error = await requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/1/comments", new AbortController().signal, { body: "source" }).catch((value) => value);
    if (!(error instanceof GitHubClientError)) throw new Error("Expected GitHub rejection");
    expect(error.message).not.toContain("SECRET");
    if (reason) expect(error.message).toContain(`reason: ${reason}`);
    else expect(error.message).toContain("the status alone cannot distinguish");
    if (reason === "GitHub rate-limit or spam protection") expect(error.message).toContain("Wait at least one minute");
  });

  it("uses explicit bodyless DELETE and accepts GitHub's empty 204 response", async () => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, ""));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    const target = parsePullRequestUrl("https://github.com/o/r/pull/1");
    await expect(requestGitHub(target, "repos/o/r/pulls/comments/123", new AbortController().signal,
      undefined, "DELETE")).resolves.toBeUndefined();
    expect(mock.exec.mock.calls[0]![1]).toEqual(["api", "--hostname", "github.com", "--method", "DELETE",
      "-H", "Accept: application/vnd.github+json", "repos/o/r/pulls/comments/123"]);
    expect(mock.end).toHaveBeenCalledWith(undefined);
    expect(mock.exec).toHaveBeenCalledTimes(1);
  });

  it("does not start DELETE after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/comments/123", controller.signal, undefined, "DELETE")).rejects.toThrow();
    expect(mock.exec).not.toHaveBeenCalled();
  });

  it.each([
    ["repos/o/r/issues/comments/123", undefined],
    ["repos/o/r/pulls/1/comments", undefined],
    ["repos/o/r/pulls/comments/123?other=1", undefined],
    ["repos/o/other/pulls/comments/123", undefined],
    ["repos/o/r/pulls/comments/123", { body: "source" }]
  ])("rejects unsafe DELETE endpoints and bodies: %s", async (endpoint, body) => {
    await expect(requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      endpoint as string, new AbortController().signal, body, "DELETE")).rejects.toThrow();
    expect(mock.exec).not.toHaveBeenCalled();
  });

  it.each([true, false])("sanitizes uncertain DELETE failures without retries (process error: %s)", async (processError) => {
    mock.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(processError ? new Error("credential SECRET source") : null,
        processError ? "" : '{"SECRET":"source"}'));
      return { stdin: { end: mock.end, on: mock.on } };
    });
    const error = await requestGitHub(parsePullRequestUrl("https://github.com/o/r/pull/1"),
      "repos/o/r/pulls/comments/123", new AbortController().signal, undefined, "DELETE").catch((value) => value);
    expect((error as Error).message).toContain("may have been deleted");
    expect((error as Error).message).not.toContain("SECRET");
    expect(mock.exec).toHaveBeenCalledTimes(1);
  });
});
