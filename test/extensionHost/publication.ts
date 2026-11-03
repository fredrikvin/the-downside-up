import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as vscode from "vscode";
import type { DownsideUpTestApi } from "../../src/extension";
import type { GitHubRequest } from "../../src/github/client";

async function waitFor(operation: () => boolean, description: string): Promise<void> {
  const until = Date.now() + 45_000;
  while (!operation()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Disposable Git repository and injected GitHub transport; never authenticates or posts to a real PR. */
export async function run(): Promise<void> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "dsu-publication-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  let api: DownsideUpTestApi | undefined;
  try {
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    const source = resolve(root, "main.ts");
    await writeFile(source, "export function main() { return 1; }\n");
    git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    await writeFile(source, "export function main() { return 2; }\n");
    git("add", "."); git("commit", "-qm", "head"); let head = git("rev-parse", "HEAD");
    assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(root) }));
    await waitFor(() => Boolean(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))), "disposable workspace");
    await vscode.workspace.getConfiguration("downsideUp").update("provider", "mock", vscode.ConfigurationTarget.Global);
    api = await vscode.extensions.getExtension<DownsideUpTestApi>("FredrikVinkvist.the-downside-up")!.activate();
    const setPublication = (
      request: GitHubRequest, dialog: NonNullable<Parameters<DownsideUpTestApi["setPublicationRequest"]>[1]>
    ): void => api!.setPublicationRequest(request, { confirmPreparation: async () => true, ...dialog });
    const publish = async (): Promise<void> => {
      let finished = false;
      const command = Promise.resolve(vscode.commands.executeCommand("downsideUp.publishReviewSummary"))
        .finally(() => { finished = true; });
      await waitFor(() => finished || Boolean(api!.publicationError()), "publication to finish or report an error");
      if (api!.publicationError()) await vscode.commands.executeCommand("notifications.clearAll");
      await command;
      assert.equal(api!.publicationError(), undefined);
    };
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), vscode.ViewColumn.One);
    await vscode.commands.executeCommand("downsideUp.showFileOverview");
    interface Comment {
      id: number;
      html_url: string;
      body: string;
      user: { login: string };
      path?: string;
      commit_id?: string;
      original_commit_id?: string;
      subject_type?: string;
      line?: number;
      side?: string;
      in_reply_to_id?: number;
    }
    const comments: Comment[] = [];
    const posts: Record<string, unknown>[] = [];
    const deletes: number[] = [];
    let nextId = 1;
    let afterPost: (() => Promise<void>) | undefined;
    let includePatch = false;
    const request: GitHubRequest = async (_target, endpoint, _signal, payload, method) => {
      const single = /\/(?:pulls|issues)\/comments\/([0-9]+)$/.exec(endpoint);
      if (single) {
        const comment = comments.find((entry) => entry.id === Number(single[1]));
        assert.ok(comment);
        if (method === "DELETE") {
          assert.ok(!comments.some((entry) => entry.in_reply_to_id === comment.id));
          deletes.push(comment.id);
          comments.splice(comments.indexOf(comment), 1);
          return undefined;
        }
        if (method === "PATCH") {
          const body = { ...payload as Record<string, unknown> };
          assert.ok(!("line" in body) && !("side" in body) && body.subject_type !== "line");
          posts.push(body);
          comment.body = String(body.body);
        }
        return comment;
      }
      if (payload) {
        const body = payload as Record<string, unknown>;
        if (body.position !== undefined) {
          assert.equal(body.position, 2);
          body.subject_type = "line";
          body.line = 1;
          body.side = "RIGHT";
        }
        posts.push(body);
        const id = nextId++;
        const comment: Comment = { id, body: String(body.body), user: { login: "reader" },
          html_url: `https://github.com/owner/repo/pull/42#${body.path ? "discussion_r" : "issuecomment-"}${id}`,
          ...(body.path ? { path: String(body.path), commit_id: String(body.commit_id),
            original_commit_id: String(body.commit_id), subject_type: String(body.subject_type),
            ...(body.line ? { line: Number(body.line), side: String(body.side) } : {}) } : {}) };
        comments.push(comment);
        await afterPost?.();
        return comment;
      }
      if (endpoint === "user") return { login: "reader" };
      if (endpoint.endsWith("/pulls/42")) return { state: "open", changed_files: 1,
        base: { sha: base, repo: { full_name: "owner/repo" } }, head: { sha: head } };
      if (endpoint.includes("/files?")) {
        const diff = includePatch ? git("diff", "--unified=3", base, head, "--", "main.ts") : "";
        const patch = diff.slice(diff.indexOf("@@"));
        return [{ filename: "main.ts", status: "modified", ...(includePatch ? { patch,
          additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
          deletions: patch.split("\n").filter((line) => line.startsWith("-")).length } : {}) }];
      }
      return comments.filter((comment) => endpoint.includes("/pulls/") ? Boolean(comment.path) : !comment.path);
    };
    const url = "https://github.com/owner/repo/pull/42";
    let cancelledRead = false;
    setPublication(async (_target, _endpoint, signal) => {
      cancelledRead = true;
      api!.stopReview();
      signal.throwIfAborted();
      assert.fail("Cancelling preparation must abort its GitHub request.");
    }, { url, prepare: "full", confirm: async () => assert.fail("Cancelled reads cannot reach posting") });
    const cancelled = vscode.commands.executeCommand("downsideUp.publishReviewSummary");
    await waitFor(() => Boolean(api!.publicationError()), "cancelled publication warning");
    await cancelled;
    assert.ok(cancelledRead);
    assert.equal(posts.length, 0);
    // Leave the warning visible: it must not retain ownership of publication.
    setPublication(request, { url, prepare: "full",
      confirmPreparation: async () => false, confirm: async () => assert.fail("Cancelled preparation cannot reach posting") });
    await publish();
    assert.equal(posts.length, 0);
    assert.equal(api.reviewItems().length, 0, "Cancelling preparation does not create a review.");
    await vscode.commands.executeCommand("notifications.clearAll");
    setPublication(request, { url, prepare: "full", confirmPreparation: async () => true, confirm: async (detail) => {
      assert.match(detail, /Signed in as: reader/);
      assert.ok(detail.includes(head));
      assert.match(detail, /2 new comments, 0 updates, 0 superseded/);
      return false;
    } });
    await publish();
    assert.equal(posts.length, 0, "Cancelling confirmation must not publish.");
    assert.equal(api.publicationError(), undefined);
    assert.equal(api.reviewItems().length, 1, "Publishing can prepare a review without running a separate command.");
    assert.ok(api.reviewItems().every((item) => item.status === "done"));
    setPublication(request, { url, confirm: async () => true });
    await publish();
    assert.equal(api.publicationError(), undefined);
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.subject_type, "file", "File comments precede the conversation summary.");
    const filePost = posts.find((post) => post.subject_type === "file")!;
    assert.equal(filePost.path, "main.ts");
    assert.equal(filePost.commit_id, head);
    assert.ok(String(filePost.body).includes("<details>"));
    assert.ok(posts.some((post) => String(post.body).includes("## Review summary")));
    await publish();
    assert.equal(posts.length, 2, "A repeat invocation skips identical comments.");
    const summaryComment = comments.find((comment) => !comment.path)!;
    const summaryId = summaryComment.id;
    summaryComment.body += "\nA manually written note.";
    setPublication(request, { url, updateExisting: true, confirmEdited: async () => false,
      confirm: async () => assert.fail("Edited comments need separate approval") });
    await publish();
    assert.equal(posts.length, 2, "Declining edited-comment approval must not mutate comments.");
    setPublication(request, { url, updateExisting: true, confirmEdited: async (detail) => {
      assert.match(detail, /manually edited/);
      return true;
    }, confirm: async (detail) => {
      assert.match(detail, /0 new comments, 1 updates/);
      return true;
    } });
    await publish();
    assert.equal(posts.length, 3);
    assert.equal(comments.find((comment) => !comment.path)!.id, summaryId, "Updating must preserve the summary discussion.");
    assert.ok(!summaryComment.body.includes("A manually written note."));
    const originalPublication = comments.map((comment) => ({ ...comment }));

    api.stopReview();
    assert.equal(await api.reviewChanges(base), 1);
    await waitFor(() => Boolean(api!.shownReviewSummary()?.current) && api!.reviewItems().every((item) => item.status === "done"),
      "existing working review before exact PR preparation");
    const localEdit = new vscode.WorkspaceEdit();
    localEdit.insert(vscode.Uri.file(source), new vscode.Position(0, 0), "// local changes are not PR evidence\n");
    assert.equal(await vscode.workspace.applyEdit(localEdit), true);
    let preparedOverWorkingReview = false;
    setPublication(request, { url, confirmPreparation: async (detail) => {
      if (detail === "full") preparedOverWorkingReview = true;
      return true;
    }, confirm: async () => true });
    await publish();
    assert.ok(preparedOverWorkingReview, "Even an existing review must prepare the exact PR scope.");
    assert.equal(posts.length, 3, "Exact PR preparation reuses current records and skips identical comments.");
    assert.ok((await vscode.workspace.openTextDocument(source)).isDirty, "Existing working reviews are replaced with immutable PR scope without saving local edits.");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), vscode.ViewColumn.One);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    comments.length = 0;
    setPublication(request, { url, confirm: async () => true });
    afterPost = async () => {
      api!.stopReview();
    };
    const partial = vscode.commands.executeCommand("downsideUp.publishReviewSummary");
    await waitFor(() => Boolean(api!.publicationError()), "partial publication to stop after cancellation");
    assert.match(api.publicationError()!, /1 comment\(s\) confirmed published/);
    await vscode.commands.executeCommand("notifications.clearAll");
    await partial;
    assert.equal(posts.length, 4, "The first comment is recorded, but remaining comments cannot post after cancellation.");
    await vscode.commands.executeCommand("workbench.action.files.revert");
    afterPost = undefined;
    comments.splice(0, comments.length, ...originalPublication);
    api.stopReview();
    await writeFile(source, "export function main() { return 3; }\n");
    git("add", "."); git("commit", "-qm", "next head"); head = git("rev-parse", "HEAD");
    const updatedSource = await vscode.workspace.openTextDocument(source);
    await vscode.window.showTextDocument(updatedSource, vscode.ViewColumn.One);
    await waitFor(() => updatedSource.getText() === "export function main() { return 3; }\n",
      "editor to observe the new committed source");
    const unrelatedWorkingEdit = new vscode.WorkspaceEdit();
    unrelatedWorkingEdit.insert(vscode.Uri.file(source), new vscode.Position(0, 0), "// not part of the PR\n");
    assert.equal(await vscode.workspace.applyEdit(unrelatedWorkingEdit), true);
    setPublication(request, { url, prepare: "summary-only", updateExisting: true, confirmPreparation: async () => true,
      confirm: async (detail) => {
        assert.match(detail, /0 new comments, 1 updates, 0 superseded file comments, 1 deletions/);
        return true;
      } });
    await publish();
    assert.equal(api.publicationError(), undefined);
    assert.equal(posts.length, 5, "Summary-only updates the summary without generating new file explanations.");
    assert.equal(deletes.length, 1, "The old unchanged file comment without replies is deleted after updating its replacement summary.");
    assert.ok(comments.find((comment) => !comment.path)!.body.includes("## Review summary"));
    assert.equal(comments.find((comment) => !comment.path)!.id, summaryId);
    assert.equal(comments.some((comment) => comment.path), false);
    const oldFile = originalPublication.find((comment) => comment.path)!;
    const replyId = nextId++;
    comments.push({ ...oldFile }, { ...oldFile, id: replyId, body: "Please keep this discussion",
      html_url: `https://github.com/owner/repo/pull/42#discussion_r${replyId}`, in_reply_to_id: oldFile.id });
    setPublication(request, { url, prepare: "summary-only", updateExisting: true, confirm: async (detail) => {
      assert.match(detail, /0 new comments, 0 updates, 1 superseded file comments, 0 deletions/);
      return true;
    } });
    await publish();
    assert.equal(deletes.length, 1, "An old comment with a reply must never be deleted.");
    assert.match(comments.find((comment) => comment.id === oldFile.id)!.body, /superseded/i);
    assert.equal(comments.find((comment) => comment.id === replyId)!.body, "Please keep this discussion");
    assert.ok(api.reviewItems().every((item) => item.status === "pending"), "Summary-only must not generate Functions comparisons.");
    assert.ok((await vscode.workspace.openTextDocument(source)).isDirty, "Immutable PR preparation must not save or discard local edits.");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), vscode.ViewColumn.One);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    setPublication(request, { url, prepare: "full", updateExisting: true, confirm: async () => true });
    await publish();
    const previousFile = comments.find((comment) => comment.subject_type === "file" && comment.commit_id === head)!;
    assert.ok(previousFile.body.includes("### `main`"));
    includePatch = true;
    const inlineStart = posts.length;
    setPublication(request, { url, prepare: "full", updateExisting: true, confirmPreparation: async () => true,
      confirm: async (detail) => {
        assert.match(detail, /1 new comments, 1 updates/);
        assert.match(detail, /1 function explanation\(s\) placed inline; 0 kept in file comments/);
        return true;
      } });
    await publish();
    const inlinePosts = posts.slice(inlineStart);
    assert.equal(inlinePosts.length, 2);
    assert.equal(inlinePosts[0]!.subject_type, "line");
    assert.equal(inlinePosts[0]!.side, "RIGHT");
    assert.equal(inlinePosts[0]!.line, 1);
    assert.ok(String(inlinePosts[0]!.body).includes("### `main`"));
    assert.ok(String(inlinePosts[0]!.body).includes("<summary>Flowchart</summary>"));
    assert.ok(comments.find((comment) => comment.id === previousFile.id)!.body === inlinePosts[1]!.body);
    assert.ok(!String(inlinePosts[1]!.body).includes("### `main`"));
    setPublication(request, { url, confirm: async () => true });
    await publish();
    assert.equal(posts.length, inlineStart + 2, "Repeating a function-anchored publication skips all duplicates.");
    const inlineComment = comments.find((comment) => comment.subject_type === "line")!;
    const inlineReplyId = nextId++;
    comments.push({ ...inlineComment, id: inlineReplyId, body: "Discuss this function",
      html_url: `https://github.com/owner/repo/pull/42#discussion_r${inlineReplyId}`, in_reply_to_id: inlineComment.id });
    includePatch = false;
    setPublication(request, { url, updateExisting: true, confirm: async (detail) => {
      assert.match(detail, /0 new comments, 1 updates, 1 superseded file comments, 0 deletions/);
      assert.match(detail, /0 function explanation\(s\) placed inline; 1 kept in file comments/);
      return true;
    } });
    await publish();
    assert.match(inlineComment.body, /Superseded by/);
    assert.equal(comments.find((comment) => comment.id === inlineReplyId)!.body, "Discuss this function");
    assert.ok(comments.find((comment) => comment.subject_type === "file")!.body.includes("### `main`"));
    console.log("Downside Up publication integration tests passed: preparation, confirmation, file and function inline comments, duplicate/update/fallback handling, discussion preservation and freshness; no real GitHub requests.");
  } finally {
    api?.stopReview();
    api?.setPublicationRequest(undefined);
    await rm(root, { recursive: true, force: true });
  }
}
