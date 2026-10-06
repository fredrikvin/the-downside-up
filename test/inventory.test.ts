import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherInventory } from "../src/context/inventory";
import { workspace } from "./vscode";

let root: string;

beforeEach(async () => {
  workspace.__resetConfiguration();
  root = await mkdtemp(resolve(tmpdir(), "downside-up-inventory-"));
  await mkdir(resolve(root, "src"), { recursive: true });
  await mkdir(resolve(root, "vendor"), { recursive: true });
  await mkdir(resolve(root, "node_modules", "sample"), { recursive: true });
  await mkdir(resolve(root, ".hidden"), { recursive: true });
  await writeFile(resolve(root, ".gitignore"), "*.log\nignored/\n");
  await writeFile(resolve(root, ".copilotignore"), "private.js\n");
  await writeFile(resolve(root, "README.md"), "# Fixture\nSmall example repository.");
  await writeFile(resolve(root, "src/main.js"), "export function run() { return 1; }\n");
  await writeFile(resolve(root, "src/private.js"), "should not enter model context");
  await writeFile(resolve(root, "src/build.log"), "ignored by gitignore");
  await writeFile(resolve(root, "vendor/library.js"), "vendored source");
  await writeFile(resolve(root, "node_modules/sample/index.js"), "dependency");
  await writeFile(resolve(root, ".hidden/secret.js"), "hidden");
  await writeFile(resolve(root, "credentials.pem"), "test secret");
  await writeFile(resolve(root, "ignored-data.tmp"), "excluded");
});

afterEach(async () => {
  workspace.__resetConfiguration();
  await rm(root, { recursive: true, force: true });
});

describe("bounded repository inventory", () => {
  it("honors Git/Copilot ignore rules and excludes secrets, hidden and generated trees", async () => {
    const result = await gatherInventory(root);
    const paths = result.files.map((file) => file.relativePath);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/main.js");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain(".copilotignore");
    expect(paths).not.toContain("src/private.js");
    expect(paths).not.toContain("src/build.log");
    expect(paths).not.toContain("vendor/library.js");
    expect(paths).not.toContain("node_modules/sample/index.js");
    expect(paths).not.toContain(".hidden/secret.js");
    expect(paths).not.toContain("credentials.pem");
    expect(result.inventoryText).not.toContain("should not enter model context");
    expect(result.inventoryText).not.toContain("test secret");
  });

  it("includes Go module files and primes go.mod as a manifest", async () => {
    await writeFile(resolve(root, "go.mod"), "module example.com/fixture\n\ngo 1.22\n");
    await writeFile(resolve(root, "go.sum"), "example.com/dep v1.0.0 h1:abc=\n");
    const result = await gatherInventory(root);
    const paths = result.files.map((file) => file.relativePath);
    expect(paths).toContain("go.mod");
    expect(paths).not.toContain("go.sum");
    expect(result.primedPaths).toContain("go.mod");
  });

  it("tracks ignore-rule changes without sending ignore-file contents", async () => {
    const first = await gatherInventory(root);
    expect(first.snapshot[".gitignore"]).toBeDefined();
    expect(first.inventoryText).not.toContain("ignored/");
    await writeFile(resolve(root, ".gitignore"), "*.log\nignored/\nsrc/main.js\n");
    const second = await gatherInventory(root, first.snapshot);
    expect(second.changedPaths).toContain(".gitignore");
    expect(second.changedPaths).toContain("src/main.js");
    expect(second.files.some((file) => file.relativePath === "src/main.js")).toBe(false);
  });

  it("uses unsaved editor content and respects VS Code exclude globs", async () => {
    const file = resolve(root, "src/main.js");
    const getText = vi.fn(() => "export function unsaved() { return 2; }\n");
    workspace.__setConfiguration("files.exclude", { "**/main.js": true });
    workspace.textDocuments.push({
      uri: { scheme: "file", fsPath: file },
      getText
    });
    expect((await import("vscode")).workspace.textDocuments).toBe(workspace.textDocuments);
    const result = await gatherInventory(root);
    expect(result.files.some((entry) => entry.relativePath === "src/main.js")).toBe(false);

    workspace.__setConfiguration("files.exclude", {});
    expect((await import("vscode")).workspace.getConfiguration("files").get("exclude")).toEqual({});
    const included = await gatherInventory(root);
    expect(getText).toHaveBeenCalled();
    expect(included.files.find((entry) => entry.relativePath === "src/main.js")?.content)
      .toContain("unsaved");
  });

  it("never follows a symlink outside the repository root", async () => {
    const external = await mkdtemp(resolve(tmpdir(), "downside-up-outside-"));
    try {
      await writeFile(resolve(external, "outside.js"), "external code");
      await symlink(resolve(external, "outside.js"), resolve(root, "src/link.js"));
      const result = await gatherInventory(root);
      expect(result.files.some((entry) => entry.relativePath === "src/link.js")).toBe(false);
      expect(result.inventoryText).not.toContain("external code");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("tracks Git branch switches even when the checked-out files are unchanged", async () => {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Downside Up Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "add", "README.md", "src/main.js"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
    const first = await gatherInventory(root);

    execFileSync("git", ["-C", root, "switch", "--quiet", "-c", "alternate"]);
    const second = await gatherInventory(root, first.snapshot);

    expect(second.changedPaths).toContain("[Git branch/HEAD]");
  });
});
