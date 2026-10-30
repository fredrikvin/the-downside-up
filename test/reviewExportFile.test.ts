import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { defaultReviewExportFolder, isInsideFolder, reviewExportFileName } from "../src/presentation/reviewExportFile";

const date = new Date(2026, 9, 3, 23, 59);

describe("review export file", () => {
  it("names working reviews by repository, short base commit, and local date", () => {
    expect(reviewExportFileName({ root: "/work/the-app", kind: "working", base: "a".repeat(40), date }))
      .toBe("review-the-app-aaaaaaa-2026-10-03.md");
  });

  it("names commit reviews by the commit, not its parent", () => {
    expect(reviewExportFileName({
      root: "/work/the-app", kind: "commit", base: `${"c".repeat(40)}:${"p".repeat(40)}`, commit: "c".repeat(40), date
    })).toBe("review-the-app-ccccccc-2026-10-03.md");
  });

  it("keeps names file-system safe when a base is a label or the repository name is unusual", () => {
    expect(reviewExportFileName({ root: "/work/My Repo: #1", kind: "working", base: "since main (merge base 1a2b3c4)", date }))
      .toBe("review-My-Repo-1-since-main-merge-base-1a2b3c4-2026-10-03.md");
    expect(reviewExportFileName({ root: "/", kind: "working", base: "../../", date }))
      .toBe("review-repository-changes-2026-10-03.md");
  });

  it("recognizes paths inside a folder without matching sibling names", () => {
    const root = resolve("/work/app");
    expect(isInsideFolder(root, root)).toBe(true);
    expect(isInsideFolder(root, join(root, "docs", "review.md"))).toBe(true);
    expect(isInsideFolder(root, join(root, "..review.md"))).toBe(true);
    expect(isInsideFolder(root, resolve("/work/app-exports/review.md"))).toBe(false);
    expect(isInsideFolder(root, resolve("/work/review.md"))).toBe(false);
  });

  it("defaults to the last export folder, then Downloads, then home", async () => {
    const folders = new Set(["/home/me", "/home/me/Downloads", "/exports"]);
    const isFolder = async (path: string) => folders.has(path);
    expect(await defaultReviewExportFolder("/exports", "/home/me", isFolder)).toBe("/exports");
    expect(await defaultReviewExportFolder("/gone", "/home/me", isFolder)).toBe(join("/home/me", "Downloads"));
    folders.delete("/home/me/Downloads");
    expect(await defaultReviewExportFolder(undefined, "/home/me", isFolder)).toBe("/home/me");
  });
});
