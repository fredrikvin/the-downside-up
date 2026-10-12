import { execFile } from "node:child_process";

/**
 * A changed span of new-side lines, zero-based and inclusive. A removal of
 * lines is recorded as the two lines around it, and only an item holding
 * both of them counts as changed.
 */
export interface ChangedRange {
  readonly start: number;
  readonly end: number;
  readonly removal?: true;
}

/** Changed lines per repository-relative path, or "all" for a new file. */
export type ChangedLines = Map<string, ChangedRange[] | "all">;

export interface BaseChoice {
  readonly label: string;
  readonly description: string;
  /** How the changes are described in sentences, such as "since main (merge base 1a2b3c4)". */
  readonly phrase: string;
  /** The commit compared with the working tree. */
  readonly commit: string;
}

export interface CommitSummary {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly when: string;
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      ["-C", root, "-c", "core.quotePath=false", ...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      }
    );
  });
}

const optional = (promise: Promise<string>) => promise.then((value) => value.trim(), () => "");

/**
 * Bases to compare the working tree with: the merge base with the default
 * branch (the remote's HEAD, or `main`/`master`), the tips of those
 * branches, and the last commit, so only uncommitted changes count.
 */
export async function baseChoices(root: string): Promise<BaseChoice[]> {
  const head = await optional(git(root, ["rev-parse", "--verify", "HEAD"]));
  if (!head) return [];
  const remoteDefault = (await optional(git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])));
  const candidates = [...new Set([remoteDefault, "main", "master", "origin/main", "origin/master"].filter(Boolean))];
  const choices: BaseChoice[] = [];
  for (const branch of candidates) {
    const tip = await optional(git(root, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]));
    if (!tip) continue;
    const base = await optional(git(root, ["merge-base", "HEAD", tip]));
    if (base && base !== head) {
      choices.push({
        label: `Changes on this branch since ${branch}`,
        description: `merge base ${base.slice(0, 7)}`,
        phrase: `since ${branch} (merge base ${base.slice(0, 7)})`,
        commit: base
      });
    }
    if (tip !== base && tip !== head) {
      choices.push({
        label: `Changes compared with ${branch} as it is now`,
        description: tip.slice(0, 7),
        phrase: `compared with ${branch} (${tip.slice(0, 7)})`,
        commit: tip
      });
    }
  }
  choices.push({ label: "Uncommitted changes only", description: `since ${head.slice(0, 7)}`, phrase: "not yet committed", commit: head });
  return choices.filter((choice, index) => choices.findIndex((other) => other.commit === choice.commit) === index);
}

export async function recentCommits(root: string, count = 50): Promise<CommitSummary[]> {
  const output = await optional(git(root, ["log", `-n${count}`, "--format=%H%x09%h%x09%cr%x09%s"]));
  return output.split("\n").filter(Boolean).map((line) => {
    const [hash = "", shortHash = "", when = "", ...subject] = line.split("\t");
    return { hash, shortHash, when, subject: subject.join("\t") };
  });
}

/**
 * Reads `git diff --unified=0` output: the new-side lines each hunk touches.
 * A hunk that only removes lines marks the line where they were.
 */
export function parseChangedLines(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let path: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t.*$/, "");
      path = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !path) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const ranges = changed.get(path);
    const list = ranges === "all" ? undefined : ranges ?? [];
    if (!list) continue;
    // Lines are one-based; a removal (count 0) happened between line `start` and the next one.
    list.push(count === 0
      ? { start: start - 1, end: start, removal: true }
      : { start: start - 1, end: start - 1 + count - 1 });
    changed.set(path, list);
  }
  return changed;
}

/**
 * Lines changed between `base` and the working tree, including staged and
 * unstaged edits, with new untracked files counted whole. Paths are relative
 * to `root`, and only files under it are included.
 */
export async function changedLinesSince(root: string, base: string): Promise<ChangedLines> {
  const diff = await git(root, ["diff", "--relative", "--unified=0", "--no-color", "--no-ext-diff", "-M", base, "--"]);
  const changed = parseChangedLines(diff);
  const untracked = await optional(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  for (const path of untracked.split("\0").filter(Boolean)) changed.set(path, "all");
  return changed;
}

/** Whether an item spanning `start`-`end` (zero-based, inclusive) touches a changed line. */
export function touchesChange(ranges: ChangedRange[] | "all", start: number, end: number): boolean {
  return ranges === "all" || ranges.some((range) => range.removal
    ? range.start >= start && range.end <= end
    : range.start <= end && range.end >= start);
}
