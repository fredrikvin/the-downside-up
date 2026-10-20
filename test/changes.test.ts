import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseChoices, changedLinesSince, parseChangedLines, recentCommits, touchesChange } from "../src/context/changes";
import { nextReviewFile } from "../src/presentation/prefetch";

describe("changed lines from a diff", () => {
  it("reads new-side ranges, removals, and deleted files", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,2 +3,4 @@ function a() {",
      "@@ -10 +12 @@",
      "@@ -20,3 +21,0 @@",
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
      "diff --git a/dir with space/b.go b/dir with space/b.go",
      "--- a/dir with space/b.go",
      "+++ b/dir with space/b.go",
      "@@ -0,0 +1,2 @@"
    ].join("\n");
    expect(Object.fromEntries(parseChangedLines(diff))).toEqual({
      "src/a.ts": [{ start: 2, end: 5 }, { start: 11, end: 11 }, { start: 20, end: 21, removal: true }],
      "dir with space/b.go": [{ start: 0, end: 1 }]
    });
  });

  it("counts a removal only for functions that held the removed lines", () => {
    const removal = [{ start: 20, end: 21, removal: true as const }];
    expect(touchesChange(removal, 15, 30)).toBe(true);
    // A function ending just before, or starting just after, the removed lines is unchanged.
    expect(touchesChange(removal, 10, 20)).toBe(false);
    expect(touchesChange(removal, 21, 30)).toBe(false);
    expect(touchesChange([{ start: 5, end: 6 }], 6, 9)).toBe(true);
    expect(touchesChange([{ start: 5, end: 6 }], 7, 9)).toBe(false);
    expect(touchesChange("all", 0, 1)).toBe(true);
  });
});

describe("changes in a Git repository", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-changes-")));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await mkdir(resolve(repo, "app/src"), { recursive: true });
    await writeFile(resolve(repo, "app/src/a.ts"), "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n");
    await writeFile(resolve(repo, "outside.ts"), "export const x = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "Initial");
    git("checkout", "-q", "-b", "feature");
    await writeFile(resolve(repo, "app/src/a.ts"), "export function a() {\n  return 10;\n}\n\nexport function b() {\n  return 2;\n}\n");
    git("commit", "-q", "-am", "Change a");
    await writeFile(resolve(repo, "outside.ts"), "export const x = 2;\n");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("offers the merge base with the default branch, its tip, and uncommitted changes", async () => {
    git("checkout", "-q", "main");
    await writeFile(resolve(repo, "main.ts"), "export const m = 1;\n");
    git("add", "main.ts");
    git("commit", "-q", "-m", "Main moves on");
    git("checkout", "-q", "feature");
    const choices = await baseChoices(repo);
    const mergeBase = git("merge-base", "HEAD", "main");
    expect(choices.map((choice) => [choice.label, choice.commit])).toEqual([
      ["Changes on this branch since main", mergeBase],
      ["Changes compared with main as it is now", git("rev-parse", "main")],
      ["Uncommitted changes only", git("rev-parse", "HEAD")]
    ]);
    expect(choices[0]!.phrase).toBe(`since main (merge base ${mergeBase.slice(0, 7)})`);
    expect((await recentCommits(repo)).map((commit) => commit.subject)).toEqual(["Change a", "Initial"]);
  });

  it("includes committed, uncommitted, and new files under the root, relative to it", async () => {
    await writeFile(resolve(repo, "app/src/a.ts"), "export function a() {\n  return 10;\n}\n\nexport function b() {\n  return 20;\n}\n");
    await writeFile(resolve(repo, "app/src/new.ts"), "export function n() {}\n");
    const root = resolve(repo, "app");
    const changed = await changedLinesSince(root, git("merge-base", "HEAD", "main"));
    expect(Object.fromEntries(changed)).toEqual({
      "src/a.ts": [{ start: 1, end: 1 }, { start: 5, end: 5 }],
      "src/new.ts": "all"
    });
    expect(Object.fromEntries(await changedLinesSince(root, "HEAD"))).toEqual({
      "src/a.ts": [{ start: 5, end: 5 }],
      "src/new.ts": "all"
    });
  });
});

describe("review order", () => {
  it("prefers the file being read, then diff order", () => {
    const pending = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
    expect(nextReviewFile(pending, "b.ts")).toBe(pending[1]);
    expect(nextReviewFile(pending, "z.ts")).toBe(pending[0]);
    expect(nextReviewFile(pending, undefined)).toBe(pending[0]);
    expect(nextReviewFile([], "a.ts")).toBeUndefined();
  });
});
