import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { folderExclusion, listEligibleFiles, listFolder } from "../src/context/inventory";
import { folderStructure } from "../src/context/structure";
import { initializeGoParserAt } from "../src/languages/go/syntax";
import { initializeJavaScriptParsersAt } from "../src/languages/javascript/syntax";
import { initializeRustParserAt } from "../src/languages/rust/syntax";

beforeAll(async () => {
  await Promise.all([initializeRustParserAt(resolve(".")), initializeGoParserAt(resolve(".")), initializeJavaScriptParsersAt(resolve("."))]);
});

async function structureOf(fixture: string, folder: string) {
  const root = resolve("fixtures", fixture);
  const { children } = await listFolder(root, folder);
  const graph = await folderStructure(root, folder, children);
  return {
    children: children.map((child) => `${child.kind} ${child.path}${child.fileCount === undefined ? "" : ` (${child.fileCount})`}`),
    edges: graph.edges.map((edge) => `${edge.from} > ${edge.to} x${edge.weight}`).sort(),
    limitations: graph.limitations
  };
}

describe("folder listings and structure", () => {
  it("lists subfolders with file counts, then files, skipping ignored, hidden, and non-text files", async () => {
    const { children } = await structureOf("go-app", "");
    expect(children).toEqual([
      "folder inventory (2)",
      "folder storage (1)",
      "file go.mod",
      "file main_test.go",
      "file main.go",
      "file report.go"
    ]);
  });

  it("connects Go files to the packages they import within the module", async () => {
    const { edges } = await structureOf("go-app", "");
    // The .copilotignore'd legacy package is left out entirely.
    expect(edges).toEqual([
      "main.go > inventory x1",
      "main.go > storage x1",
      "main_test.go > inventory x1",
      "report.go > inventory x1",
      "storage > inventory x1"
    ]);
  });

  it("connects Rust modules declared with mod and named with crate paths", async () => {
    const { edges } = await structureOf("rust-app", "src");
    expect(edges).toEqual([
      "src/main.rs > src/inventory.rs x1",
      "src/main.rs > src/storage.rs x1",
      "src/storage.rs > src/inventory.rs x1"
    ]);
  });

  it("connects TypeScript files through relative imports", async () => {
    const { edges, limitations } = await structureOf("react-app", "src");
    expect(edges).toEqual([
      "src/CartItem.tsx > src/format.ts x1",
      "src/CartItem.tsx > src/types.ts x1",
      "src/CartView.tsx > src/CartItem.tsx x1",
      "src/CartView.tsx > src/format.ts x1",
      "src/CartView.tsx > src/types.ts x1",
      "src/CartView.tsx > src/useCart.ts x1",
      "src/useCart.ts > src/format.ts x1",
      "src/useCart.ts > src/types.ts x1"
    ]);
    expect(limitations).toEqual([]);
  });

  it("refuses to preview or walk folders the scanner would skip, including links out of the repository", async () => {
    const base = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-folders-")));
    const repo = resolve(base, "repo");
    try {
      for (const dir of ["src", "node_modules/pkg", ".hidden", "generated"]) await mkdir(resolve(repo, dir), { recursive: true });
      await mkdir(resolve(base, "elsewhere"));
      await writeFile(resolve(base, "elsewhere/secret.ts"), "export const x = 1;\n");
      await writeFile(resolve(repo, "node_modules/pkg/index.js"), "module.exports = 1;\n");
      await writeFile(resolve(repo, "generated/out.ts"), "export const y = 1;\n");
      await writeFile(resolve(repo, ".gitignore"), "generated/\n");
      await symlink(resolve(base, "elsewhere"), resolve(repo, "linked"));
      expect(await folderExclusion(repo, "src")).toBeUndefined();
      expect(await folderExclusion(repo, "")).toBeUndefined();
      expect(await folderExclusion(repo, "linked")).toBe("it is a link to another location");
      expect(await folderExclusion(repo, "node_modules/pkg")).toMatch(/dependency, build, or vendored/);
      expect(await folderExclusion(repo, ".hidden")).toMatch(/hidden/);
      expect(await folderExclusion(repo, "generated")).toMatch(/\.gitignore or \.copilotignore/);
      expect(await folderExclusion(repo, "../elsewhere")).toBe("it is outside the repository");
      await expect(listFolder(repo, "linked")).rejects.toThrow(/link to another location/);
      expect(await listEligibleFiles(repo, "node_modules/pkg")).toEqual({ files: [], complete: true });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
