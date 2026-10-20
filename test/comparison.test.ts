import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baseComparisonRef,
  changedFilesSince,
  comparisonProblem,
  readComparison,
  resolveNativeDiff,
  type ComparisonRef
} from "../src/context/comparison";

let root = "";
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const gitUri = (path: string, ref: string) => ({ scheme: "git", fsPath: join(root, path), query: JSON.stringify({ path: join(root, path), ref }) });
const fileUri = (path: string) => ({ scheme: "file", fsPath: join(root, path), query: "" });

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

  it("keeps different paths for a rename", async () => {
    git("mv", "old.txt", "new.txt");
    const ref = await refOf(gitUri("old.txt", "HEAD"), gitUri("new.txt", ""));
    const snapshot = await readComparison(ref);
    expect(snapshot.original.path).toBe("old.txt");
    expect(snapshot.modified.path).toBe("new.txt");
    expect(snapshot.original.text).toBe(snapshot.modified.text);
    expect(comparisonProblem(snapshot)).toBe("The two versions are identical.");
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
