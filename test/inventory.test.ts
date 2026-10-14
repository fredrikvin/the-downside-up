import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherInventory, sharingExclusion } from "../src/context/inventory";
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

  it("reads what says most about the project first, and shares deployment files only as names", async () => {
    // More files than the inventory reads in full, all sorting before the evidence below.
    await mkdir(resolve(root, "aaa"), { recursive: true });
    for (let index = 0; index < 220; index++) await writeFile(resolve(root, `aaa/file${String(index).padStart(3, "0")}.js`), `export const value${index} = ${index};\n`);
    await mkdir(resolve(root, "services/api/api"), { recursive: true });
    await mkdir(resolve(root, "services/api/manifests"), { recursive: true });
    await writeFile(resolve(root, "services/api/go.mod"), "module example.com/api\n");
    await writeFile(resolve(root, "services/api/Dockerfile"), "FROM golang:1.22\n");
    await writeFile(resolve(root, "services/api/api/asyncapi.yaml"), "asyncapi: 2.6.0\ninfo:\n  title: Orders events\n");
    await writeFile(resolve(root, "services/api/manifests/deployment.yaml"), [
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          env:",
      "            - name: WORKER_URL",
      "              value: http://worker.internal:9000"
    ].join("\n"));
    const result = await gatherInventory(root);
    expect(result.primedPaths.slice(0, 1)).toEqual(["README.md"]);
    expect(result.primedPaths).toEqual(expect.arrayContaining([
      "services/api/go.mod",
      "services/api/api/asyncapi.yaml",
      "services/api/Dockerfile",
      "services/api/manifests/deployment.yaml"
    ]));
    expect(result.inventoryText).toContain("Orders events");
    expect(result.inventoryText).toContain("[Deployment facts; values omitted]");
    expect(result.inventoryText).toContain("environment variable names: WORKER_URL");
    expect(result.inventoryText).not.toContain("worker.internal");
    const api = result.outline.find((entry) => entry.path === "services/api");
    expect(api?.markers).toEqual(["Dockerfile", "go.mod"]);
    expect(result.folders.has("services/api/api")).toBe(true);
    expect(result.folders.has("vendor")).toBe(false);
  });

  it("reads only what priming may send, and ranks by name without reading generated code or test operations", async () => {
    await mkdir(resolve(root, "lots"), { recursive: true });
    for (let index = 0; index < 120; index++) await writeFile(resolve(root, `lots/helper${String(index).padStart(3, "0")}.js`), `export const value${index} = ${index};\n`);
    await mkdir(resolve(root, "web/src/components/cart"), { recursive: true });
    await mkdir(resolve(root, "web/src/__generated__"), { recursive: true });
    await mkdir(resolve(root, "tests/operations"), { recursive: true });
    await writeFile(resolve(root, "web/package.json"), "{\"name\":\"web\"}\n");
    await writeFile(resolve(root, "web/src/index.ts"), "export const app = 1;\n");
    await writeFile(resolve(root, "web/src/components/cart/index.ts"), "export * from './cart';\n");
    await writeFile(resolve(root, "web/src/__generated__/index.ts"), "export const generated = 1;\n");
    await writeFile(resolve(root, "tests/operations/order.graphql"), "query Order { order { id } }\n");
    const result = await gatherInventory(root);
    const read = result.files.map((file) => file.relativePath);
    expect(read).toEqual(expect.arrayContaining(["README.md", "web/package.json", "web/src/index.ts"]));
    expect(read.length).toBeLessThan(80);
    expect(read).not.toContain("web/src/__generated__/index.ts");
    expect(read).not.toContain("tests/operations/order.graphql");
    expect(result.snapshot["web/src/__generated__/index.ts"]).toMatch(/^unread:/);
    // A barrel deep in a component is not an entry point, so it ranks with ordinary files.
    expect(result.primedPaths.indexOf("web/src/index.ts")).toBeLessThan(result.primedPaths.indexOf("lots/helper000.js"));
    expect(result.outline.find((entry) => entry.path === "tests/operations")?.markers ?? []).toEqual([]);
    expect(result.languageIds).toContain("javascript");
  });

  it("lists every top-level area when the repository has more files than the scan takes", async () => {
    await mkdir(resolve(root, "aaa/deep/er"), { recursive: true });
    for (let index = 0; index < 2_050; index++) await writeFile(resolve(root, `aaa/deep/er/file${String(index).padStart(4, "0")}.js`), "export {};\n");
    await mkdir(resolve(root, "zzz-service"), { recursive: true });
    await writeFile(resolve(root, "zzz-service/go.mod"), "module example.com/zzz\n");
    const result = await gatherInventory(root);
    expect(result.limitations).toContain("Inventory stopped at 2000 eligible files.");
    expect(result.snapshot["zzz-service/go.mod"]).toBeDefined();
    expect(result.primedPaths).toContain("zzz-service/go.mod");
    expect(result.outline.find((entry) => entry.path === "zzz-service")?.markers).toEqual(["go.mod"]);
  });

  it("cuts a long file in the priming inventory instead of leaving it out", async () => {
    await writeFile(resolve(root, "README.md"), `# Fixture\n${"A long introduction. ".repeat(1_500)}`);
    const result = await gatherInventory(root);
    expect(result.primedPaths[0]).toBe("README.md");
    expect(result.inventoryText).toContain("[… cut to fit the priming budget]");
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

  it("explains why a single file must not be shared, using the scanner's rules", async () => {
    await mkdir(resolve(root, "src/ignored"), { recursive: true });
    await mkdir(resolve(root, "lib/nested"), { recursive: true });
    await writeFile(resolve(root, "src/ignored/code.js"), "ignored by a directory rule");
    await writeFile(resolve(root, "lib/nested/.copilotignore"), "internal.js\n");
    await writeFile(resolve(root, "lib/nested/internal.js"), "excluded by a nested rule");
    await writeFile(resolve(root, "lib/nested/public.js"), "shared");
    const reason = (path: string) => sharingExclusion(root, resolve(root, path));

    expect(await reason("src/main.js")).toBeUndefined();
    expect(await reason("lib/nested/public.js")).toBeUndefined();
    expect(await reason("src/private.js")).toContain("secret");
    await writeFile(resolve(root, ".copilotignore"), "private.js\nconfidential/\n");
    await mkdir(resolve(root, "confidential"), { recursive: true });
    await writeFile(resolve(root, "confidential/plan.js"), "excluded by the root rule");
    expect(await reason("confidential/plan.js")).toContain(".copilotignore");
    expect(await reason("src/ignored/code.js")).toContain(".gitignore");
    expect(await reason("lib/nested/internal.js")).toContain(".copilotignore");
    expect(await reason("vendor/library.js")).toContain("vendored");
    expect(await reason(".hidden/secret.js")).toContain("hidden");
    expect(await reason("credentials.pem")).toContain("secret");

    workspace.__setConfiguration("files.exclude", { "**/main.js": true });
    expect(await reason("src/main.js")).toContain("files.exclude");
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
