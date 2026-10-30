import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { comparisonCatalogue } from "../src/context/comparisonFunctions";
import { javascriptSupport } from "../src/languages/javascript";
import {
  baseComparisonRef,
  changedFilesSince,
  comparisonProblem,
  commitComparisonRef,
  commitDetails,
  commitScope,
  readComparison,
  resolveNativeDiff,
  snapshotSignature,
  workingTreeDifferences,
  type ComparisonRef
} from "../src/context/comparison";

let root = "";
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const gitUri = (path: string, ref: string) => ({ scheme: "git", fsPath: join(root, path), query: JSON.stringify({ path: join(root, path), ref }) });
const fileUri = (path: string) => ({ scheme: "file", fsPath: join(root, path), query: "" });
beforeAll(() => javascriptSupport.initialize!(process.cwd()));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dsu-comparison-")));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(root, "a.txt"), "export const a = 1;\n");
  await writeFile(join(root, "old.txt"), "export function legacy() {\n  return 1;\n}\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refOf = async (original: ReturnType<typeof gitUri>, modified: ReturnType<typeof gitUri>): Promise<ComparisonRef> => {
  const resolved = await resolveNativeDiff(root, original, modified);
  if (!("ref" in resolved)) throw new Error(resolved.unsupported);
  return resolved.ref;
};

describe("native diff identity", () => {
  it("classifies commit-to-commit snapshots independently of today's file, and index snapshots independently of unsaved text", async () => {
    await writeFile(join(root, "functions.ts"), "export function old() {}\n");
    git("add", "."); git("commit", "-q", "-m", "old function");
    const original = git("rev-parse", "HEAD");
    await writeFile(join(root, "functions.ts"), "export function next() {}\n");
    git("add", "."); git("commit", "-q", "-m", "next function");
    const modified = git("rev-parse", "HEAD");
    await writeFile(join(root, "functions.ts"), "export function today() {}\n");
    const committed = await readComparison(await refOf(gitUri("functions.ts", original), gitUri("functions.ts", modified)));
    expect((await comparisonCatalogue(committed)).entries.map((entry) => [entry.name, entry.category]))
      .toEqual([["old", "removed"], ["next", "added"]]);
    git("add", "functions.ts");
    const staged = await readComparison(await refOf(gitUri("functions.ts", "HEAD"), gitUri("functions.ts", "")), {
      buffers: new Map([[join(root, "functions.ts"), "export function unsaved() {}\n"]])
    });
    expect((await comparisonCatalogue(staged)).entries.map((entry) => [entry.name, entry.category]))
      .toEqual([["next", "removed"], ["today", "added"]]);
  });
  it("separates unstaged changes (index against working tree) from staged ones (HEAD against index)", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const unstaged = await refOf(gitUri("a.txt", ""), fileUri("a.txt"));
    expect(unstaged.original.source).toEqual({ kind: "index" });
    expect(unstaged.modified.source).toEqual({ kind: "working" });
    git("add", "a.txt");
    const staged = await refOf(gitUri("a.txt", "HEAD"), gitUri("a.txt", ""));
    expect(staged.original.source).toEqual({ kind: "revision", hash: git("rev-parse", "HEAD") });
    expect(staged.modified.source).toEqual({ kind: "index" });
    const snapshot = await readComparison(staged);
    expect(snapshot.original.text).toBe("export const a = 1;\n");
    expect(snapshot.modified.text).toBe("export const a = 2;\n");
    expect(snapshot.original.identity).toMatch(/^revision:[0-9a-f]{40}$/);
  });

  it("reports unsupported schemes and unresolved revisions instead of guessing", async () => {
    expect(await resolveNativeDiff(root, { scheme: "untitled", fsPath: "x", query: "" }, fileUri("a.txt"))).toEqual({
      unsupported: expect.stringContaining("untitled")
    });
    expect(await resolveNativeDiff(root, gitUri("a.txt", "--upload-pack=evil"), fileUri("a.txt"))).toEqual({
      unsupported: expect.stringContaining("could not be resolved")
    });
    expect(await resolveNativeDiff(root, { scheme: "file", fsPath: "/elsewhere/a.txt", query: "" }, fileUri("a.txt"))).toEqual({
      unsupported: expect.stringContaining("outside the repository")
    });
  });

  it("reads the empty stand-in document of an added or deleted file as absent, with the same identity as a batch comparison", async () => {
    await writeFile(join(root, "new.txt"), "fresh\n");
    const head = git("rev-parse", "HEAD");
    const added = await refOf({ scheme: "downside-up-empty", fsPath: join(root, "new.txt"), query: head }, fileUri("new.txt"));
    expect(added.original).toEqual({ path: "new.txt", source: { kind: "revision", hash: head } });
    const snapshot = await readComparison(added);
    expect(snapshot.original.state).toBe("absent");
    expect(snapshot.modified.text).toBe("fresh\n");
    const deleted = await refOf(gitUri("a.txt", "HEAD"), { scheme: "downside-up-empty", fsPath: join(root, "a.txt"), query: "" });
    expect(deleted.modified.source).toEqual({ kind: "working" });
    await rm(join(root, "a.txt"));
    expect((await readComparison(deleted)).modified.state).toBe("absent");
  });

  it("keeps different paths for a rename and allows explaining a pure move", async () => {
    git("mv", "old.txt", "new.txt");
    const ref = await refOf(gitUri("old.txt", "HEAD"), gitUri("new.txt", ""));
    const snapshot = await readComparison(ref);
    expect(snapshot.original.path).toBe("old.txt");
    expect(snapshot.modified.path).toBe("new.txt");
    expect(snapshot.original.text).toBe(snapshot.modified.text);
    expect(comparisonProblem(snapshot)).toBeUndefined();
    const same = await readComparison(await refOf(gitUri("a.txt", "HEAD"), fileUri("a.txt")));
    expect(comparisonProblem(same)).toBe("The two versions are identical.");
  });

  it("allows a rename with edits", async () => {
    git("mv", "old.txt", "new.txt");
    await writeFile(join(root, "new.txt"), "export function legacy() {\n  return 2;\n}\n");
    const snapshot = await readComparison(await refOf(gitUri("old.txt", "HEAD"), fileUri("new.txt")));
    expect(snapshot.original.path).toBe("old.txt");
    expect(snapshot.modified.text).toContain("return 2");
    expect(comparisonProblem(snapshot)).toBeUndefined();
  });
});

describe("exact freshness", () => {
  it("counts formatting and blank-line edits as changes", async () => {
    const ref = await refOf(gitUri("a.txt", "HEAD"), fileUri("a.txt"));
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const first = await readComparison(ref);
    await writeFile(join(root, "a.txt"), "export  const a = 2;\n");
    const spaced = await readComparison(ref);
    await writeFile(join(root, "a.txt"), "export const a = 2;\n\n");
    const blank = await readComparison(ref);
    expect(new Set([first.modified.fingerprint, spaced.modified.fingerprint, blank.modified.fingerprint]).size).toBe(3);
    expect(new Set([snapshotSignature(first), snapshotSignature(spaced), snapshotSignature(blank)]).size).toBe(3);
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    expect(snapshotSignature(await readComparison(ref))).toBe(snapshotSignature(first));
  });
});

describe("reading both sides", () => {
  it("distinguishes an absent side from unreadable, excluded, oversized, and binary ones", async () => {
    await writeFile(join(root, "added.txt"), "export const x = 1;\n");
    await writeFile(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    await writeFile(join(root, "big.txt"), "x".repeat(300));
    git("add", ".");
    const added = await readComparison(await refOf(gitUri("added.txt", "HEAD"), gitUri("added.txt", "")));
    expect(added.original.state).toBe("absent");
    expect(added.modified.state).toBe("present");
    expect(comparisonProblem(added)).toBeUndefined();

    const binary = await readComparison(await refOf(gitUri("blob.bin", "HEAD"), gitUri("blob.bin", "")));
    expect(binary.modified.state).toBe("binary");
    expect(comparisonProblem(binary)).toContain("binary");

    const oversized = await readComparison(await refOf(gitUri("big.txt", "HEAD"), gitUri("big.txt", "")), { maxBytes: 100 });
    expect(oversized.modified.state).toBe("oversized");

    const excluded = await readComparison(await refOf(gitUri("a.txt", "HEAD"), gitUri("a.txt", "")), {
      exclusion: async (_root, path) => path.endsWith("a.txt") ? "it is a secret" : undefined
    });
    expect(excluded.original.state).toBe("excluded");
    expect(excluded.modified.state).toBe("excluded");
    expect(excluded.original.text).toBe("");
    expect(comparisonProblem(excluded)).toContain("was not sent because it is a secret");
  });

  it("checks the historical path of a renamed file for exclusion", async () => {
    git("mv", "old.txt", "new.txt");
    const seen: string[] = [];
    const snapshot = await readComparison(await refOf(gitUri("old.txt", "HEAD"), gitUri("new.txt", "")), {
      exclusion: async (_root, path) => { seen.push(path); return path.endsWith("old.txt") ? "the old name is excluded" : undefined; }
    });
    expect(seen.sort()).toEqual([join(root, "new.txt"), join(root, "old.txt")]);
    expect(snapshot.original.state).toBe("excluded");
    expect(snapshot.modified.state).toBe("present");
  });

  it("reads unsaved editor text for the working side and never substitutes it for a missing original", async () => {
    const buffers = new Map([[join(root, "a.txt"), "export const a = 3;\n"]]);
    const snapshot = await readComparison(await refOf(gitUri("a.txt", ""), fileUri("a.txt")), { buffers });
    expect(snapshot.modified.text).toBe("export const a = 3;\n");
    expect(snapshot.original.text).toBe("export const a = 1;\n");
    const missing = await readComparison({ root, original: { path: "a.txt", source: { kind: "revision", hash: "0".repeat(40) } }, modified: { path: "a.txt", source: { kind: "working" } } }, { buffers });
    expect(missing.original.state).toBe("unreadable");
    expect(missing.original.text).toBe("");
    expect(comparisonProblem(missing)).toContain("original");
  });

  it("gives a deleted working file an absent modified side", async () => {
    await rm(join(root, "a.txt"));
    const snapshot = await readComparison(await refOf(gitUri("a.txt", ""), fileUri("a.txt")));
    expect(snapshot.modified.state).toBe("absent");
    expect(snapshot.original.state).toBe("present");
  });
});

describe("changed files since a commit", () => {
  it("lists additions, deletions, renames, and untracked files", async () => {
    git("mv", "old.txt", "new.txt");
    await rm(join(root, "a.txt"));
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "fresh.txt"), "export {};\n");
    await writeFile(join(root, "b.txt"), "export const b = 1;\n");
    git("add", "b.txt");
    const { files, truncated } = await changedFilesSince(root, "HEAD");
    expect(truncated).toBe(false);
    expect(files).toEqual([
      { status: "deleted", path: "a.txt" },
      { status: "added", path: "b.txt" },
      { status: "added", path: "dir/fresh.txt" },
      { status: "renamed", path: "new.txt", oldPath: "old.txt" }
    ]);
    const renamed = await readComparison(await baseComparisonRef(root, "HEAD", files[3]!));
    expect(renamed.original.path).toBe("old.txt");
    expect(renamed.modified.path).toBe("new.txt");
    expect(renamed.original.state).toBe("present");
    expect((await changedFilesSince(root, "HEAD", 2)).truncated).toBe(true);
  });

  describe("immutable commit preparation", () => {
    it("prepares exact additions/deletions/renames/modifications, ignoring dirty buffers and later HEAD", async () => {
      const parent = git("rev-parse", "HEAD");
      git("mv", "old.txt", "new.txt");
      await rm(join(root, "a.txt"));
      await writeFile(join(root, "added.ts"), "export function added() { return 1; }\n");
      git("add", "."); git("commit", "-q", "-m", "selected");
      const commit = git("rev-parse", "HEAD");
      const scope = await commitScope(root, "HEAD");
      expect(scope).toMatchObject({ commit, parent, truncated: false, files: [
        { status: "deleted", path: "a.txt" },
        { status: "added", path: "added.ts" },
        { status: "renamed", oldPath: "old.txt", path: "new.txt" }
      ] });
      await writeFile(join(root, "added.ts"), "today\n");
      await writeFile(join(root, "untracked.ts"), "not in commit\n");
      git("add", "added.ts"); git("commit", "-q", "-m", "later");
      const buffers = new Map([[join(root, "added.ts"), "unsaved\n"]]);
      for (const file of scope.files) {
        const ref = commitComparisonRef(root, scope, file);
        const snapshot = await readComparison(ref, { buffers });
        const native = await refOf(gitUri(file.oldPath ?? file.path, parent), gitUri(file.path, commit));
        expect(ref).toEqual(native);
        expect(snapshotSignature(snapshot)).toBe(snapshotSignature(await readComparison(native)));
        if (file.status === "added") {
          expect(snapshot.original.state).toBe("absent");
          expect(snapshot.modified.text).toContain("return 1");
        }
        if (file.status === "deleted") expect(snapshot.modified.state).toBe("absent");
        if (file.status === "renamed") expect(snapshot.original.text).toBe(snapshot.modified.text);
      }
      expect((await commitScope(root, commit, undefined, 2)).truncated).toBe(true);
    });

    it("handles root commits against Git's empty tree without inventing a parent or reading working files", async () => {
      const details = await commitDetails(root, "HEAD");
      expect(details.parents).toEqual([]);
      const scope = await commitScope(root, details.hash);
      expect(scope.parent).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      expect(scope.files).toEqual([{ status: "added", path: "a.txt" }, { status: "added", path: "old.txt" }]);
      const ref = commitComparisonRef(root, scope, scope.files[0]!);
      const native = await refOf(gitUri("a.txt", scope.parent), gitUri("a.txt", scope.commit));
      expect(native).toEqual(ref);
      expect(await readComparison(ref)).toMatchObject({ original: { state: "absent" }, modified: { state: "present", text: "export const a = 1;\n" } });
      expect(await refOf({ scheme: "downside-up-empty", fsPath: join(root, "a.txt"), query: scope.parent }, gitUri("a.txt", scope.commit))).toEqual(ref);
    });

    it("requires an explicit actual parent for merges and keeps different parent pairs separate", async () => {
      const baseBranch = git("branch", "--show-current");
      git("checkout", "-q", "-b", "other");
      await writeFile(join(root, "other.ts"), "export const other = 1;\n");
      git("add", "."); git("commit", "-q", "-m", "other side");
      const other = git("rev-parse", "HEAD");
      git("checkout", "-q", baseBranch);
      await writeFile(join(root, "a.txt"), "export const a = 2;\n");
      git("add", "."); git("commit", "-q", "-m", "first side");
      const first = git("rev-parse", "HEAD");
      git("merge", "-q", "--no-ff", "-m", "merge", "other");
      const details = await commitDetails(root, "HEAD");
      expect(details.parents).toEqual([first, other]);
      await expect(commitScope(root, details.hash)).rejects.toThrow("Choose a parent explicitly");
      await expect(commitScope(root, details.hash, "f".repeat(40))).rejects.toThrow("not a parent");
      expect((await commitScope(root, details.hash, first)).files).toEqual([{ status: "added", path: "other.ts" }]);
      expect((await commitScope(root, details.hash, other)).files).toEqual([{ status: "modified", path: "a.txt" }]);
      await expect(commitScope(root, "--upload-pack=evil")).rejects.toThrow("existing Git commit");
    });

    it("checks both historical paths for exclusions before preparing a renamed file", async () => {
      git("mv", "old.txt", "new.txt"); git("commit", "-q", "-m", "rename");
      const scope = await commitScope(root, "HEAD");
      const snapshot = await readComparison(commitComparisonRef(root, scope, scope.files[0]!), {
        exclusion: async (_root, path) => path.endsWith("old.txt") ? "the old path is excluded" : undefined
      });
      expect(snapshot.original).toMatchObject({ state: "excluded", text: "" });
      expect(comparisonProblem(snapshot)).toContain("the old path is excluded");
    });
  });

  it("lists paths relative to a project folder inside a larger repository", async () => {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app", "x.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "two");
    await writeFile(join(root, "app", "x.txt"), "two\n");
    await writeFile(join(root, "a.txt"), "changed outside\n");
    const { files } = await changedFilesSince(join(root, "app"), "HEAD");
    expect(files).toEqual([{ status: "modified", path: "x.txt" }]);
    const snapshot = await readComparison(await baseComparisonRef(join(root, "app"), "HEAD", files[0]!));
    expect(snapshot.original.text).toBe("one\n");
    expect(snapshot.modified.text).toBe("two\n");
  });
});

describe("working review HEAD fence", () => {
  it("reports staged, unstaged, untracked, deleted, and renamed confirmed paths", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "ignore generated file");
    const head = git("rev-parse", "HEAD");
    await writeFile(join(root, "a.txt"), "staged\n");
    git("add", "a.txt");
    await writeFile(join(root, "a.txt"), "unstaged\n");
    await writeFile(join(root, "new.txt"), "untracked\n");
    await writeFile(join(root, "space name.txt"), "untracked with spaces\n");
    await writeFile(join(root, "ignored.txt"), "ignored\n");
    git("mv", "old.txt", "renamed.txt");
    await rm(join(root, "old.txt")).catch(() => undefined);
    const result = await workingTreeDifferences(root, [
      { status: "modified", path: "a.txt" },
      { status: "added", path: "new.txt" },
      { status: "added", path: "space name.txt" },
      { status: "added", path: "ignored.txt" },
      { status: "renamed", oldPath: "old.txt", path: "renamed.txt" }
    ]);
    expect(result.head).toBe(head);
    expect(result.differences).toEqual([
      { path: "a.txt", reason: "staged change and working-tree change" },
      { path: "new.txt", reason: "untracked file" },
      { path: "space name.txt", reason: "untracked file" },
      { path: "ignored.txt", reason: "ignored untracked file" },
      { path: "old.txt", reason: "renamed relative to HEAD" },
      { path: "renamed.txt", reason: "renamed relative to HEAD" }
    ]);
  });

  it("detects mode changes and unresolved conflicts", async () => {
    const head = git("rev-parse", "HEAD");
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises");
      await chmod(join(root, "a.txt"), 0o755);
      expect((await workingTreeDifferences(root, [{ status: "modified", path: "a.txt" }])).differences)
        .toEqual([{ path: "a.txt", reason: "file mode differs from HEAD" }]);
      await chmod(join(root, "a.txt"), 0o644);
    }

    const branch = git("branch", "--show-current");
    git("checkout", "-q", "-b", "conflict");
    await writeFile(join(root, "a.txt"), "conflict branch\n");
    git("commit", "-qam", "conflict side");
    git("checkout", "-q", branch);
    await writeFile(join(root, "a.txt"), "main branch\n");
    git("commit", "-qam", "main side");
    expect(() => git("merge", "conflict")).toThrow();
    expect((await workingTreeDifferences(root, [{ status: "modified", path: "a.txt" }])).differences)
      .toEqual([{ path: "a.txt", reason: "unresolved merge conflict" }]);
  });

  it("returns a fresh HEAD for the caller to compare and rejects repositories without HEAD", async () => {
    const before = git("rev-parse", "HEAD");
    await writeFile(join(root, "later.txt"), "later\n");
    git("add", "later.txt");
    git("commit", "-qm", "move HEAD");
    const after = await workingTreeDifferences(root, [{ status: "modified", path: "a.txt" }]);
    expect(after.head).not.toBe(before);
    expect(after.differences).toEqual([]);

    const empty = await realpath(await mkdtemp(join(tmpdir(), "dsu-no-head-")));
    try {
      execFileSync("git", ["-C", empty, "init", "-q"]);
      await expect(workingTreeDifferences(empty, [{ status: "modified", path: "a.txt" }]))
        .rejects.toThrow("HEAD could not be resolved");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("uses project-relative paths when the review root is a repository subdirectory", async () => {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app", "x.txt"), "one\n");
    git("add", "app/x.txt");
    git("commit", "-qm", "add app");
    await writeFile(join(root, "app", "x.txt"), "two\n");
    expect((await workingTreeDifferences(join(root, "app"), [{ status: "modified", path: "x.txt" }])).differences)
      .toEqual([{ path: "x.txt", reason: "working-tree change" }]);
  });
});
