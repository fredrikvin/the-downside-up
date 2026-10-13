import { describe, expect, it } from "vitest";
import { collectFolderTree, foldersToSummarize } from "../src/context/folderTree";

const layout: Record<string, string[]> = {
  src: ["src/api", "src/core"],
  "src/api": [],
  "src/core": ["src/core/cache", "src/core/parse"],
  "src/core/cache": [],
  "src/core/parse": ["src/core/parse/rust"],
  "src/core/parse/rust": []
};
const list = async (path: string) => layout[path] ?? [];

describe("folder tree runs", () => {
  it("groups folders by height so every subfolder comes before its parent", async () => {
    const tree = await collectFolderTree("src", list, 100);
    expect(tree?.folders[0]).toBe("src");
    expect(tree?.levels).toEqual([
      ["src/api", "src/core/cache", "src/core/parse/rust"],
      ["src/core/parse"],
      ["src/core"],
      ["src"]
    ]);
  });

  it("refuses trees with more folders than the limit", async () => {
    expect(await collectFolderTree("src", list, 5)).toBeUndefined();
    expect(await collectFolderTree("src", list, 6)).toBeDefined();
  });

  it("walks the repository root and ignores repeated or self references", async () => {
    const tree = await collectFolderTree("", async (path) => (path === "" ? ["a", "a", ""] : path === "a" ? ["a"] : []), 10);
    expect(tree?.folders).toEqual(["", "a"]);
    expect(tree?.levels).toEqual([["a"], [""]]);
  });

  it("summarizes stale folders and every folder above them, and skips current branches", async () => {
    const tree = (await collectFolderTree("src", list, 100))!;
    const current = new Set(["src", "src/api", "src/core", "src/core/cache", "src/core/parse"]);
    expect([...foldersToSummarize(tree, current)].sort()).toEqual(["src", "src/core", "src/core/parse", "src/core/parse/rust"]);
    expect(foldersToSummarize(tree, new Set(tree.folders)).size).toBe(0);
    expect(foldersToSummarize(tree, new Set()).size).toBe(tree.folders.length);
  });
});
