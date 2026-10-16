import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { clearSharingExclusionCache, folderExclusion, sharingExclusion, sharingExclusionReport } from "../src/context/inventory";
import { clearPolicyCache } from "../src/context/policy";
import { checkContentExclusions } from "../src/presentation/exclusionDiagnostics";
import { Uri, workspace } from "./vscode";

const ui = vi.hoisted(() => ({
  showQuickPick: vi.fn(), showOpenDialog: vi.fn(), showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(), openTextDocument: vi.fn(),
  root: "", currentFile: "", trusted: true
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

vi.mock("vscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vscode")>();
  const folder = () => ({ name: "app", uri: original.Uri.file(ui.root), index: 0 });
  return {
    ...original,
    window: {
      ...ui,
      get activeTextEditor() { return ui.currentFile ? { document: { uri: original.Uri.file(ui.currentFile) } } : undefined; }
    },
    workspace: {
      ...original.workspace,
      get isTrusted() { return ui.trusted; },
      get workspaceFolders() { return ui.root ? [folder()] : []; },
      getWorkspaceFolder: () => ui.root ? folder() : undefined,
      openTextDocument: ui.openTextDocument
    }
  };
});

let base: string;
let file: string;
let policy: string;
const content = () => ui.openTextDocument.mock.calls[0]![0].content as string;
const setting = (name: string, value: string) => workspace.__setConfiguration(`downsideUp.exclusion.${name}`, value);

beforeEach(async () => {
  vi.clearAllMocks();
  workspace.__resetConfiguration();
  clearPolicyCache();
  clearSharingExclusionCache();
  base = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-diagnostics-")));
  ui.root = resolve(base, "app");
  ui.trusted = true;
  await mkdir(resolve(ui.root, "src"), { recursive: true });
  execFileSync("git", ["-C", ui.root, "init", "-q"]);
  file = resolve(ui.root, "src/a.ts");
  ui.currentFile = file;
  policy = resolve(base, "blocked.rules");
  await writeFile(file, "export const value = 1;\n");
  ui.openTextDocument.mockResolvedValue({ uri: "report" });
});

afterEach(async () => {
  workspace.__resetConfiguration();
  clearPolicyCache();
  clearSharingExclusionCache();
  await rm(base, { recursive: true, force: true });
});

describe("content exclusion diagnostics", () => {
  it("inspects effective user policies, active/ignored lines and inactive warnings without a workspace", async () => {
    await writeFile(policy, "# explanation\n\n *.vault \n");
    setting("blockedFilePatternsFile", policy);
    setting("restrictedRemotesFile", resolve(base, "missing"));
    setting("allowedRepositoriesFile", base);
    workspace.__setConfiguration("workspace:downsideUp.exclusion.blockedFilePatternsFile", "/not-the-user-file");
    ui.root = "";
    ui.showQuickPick.mockResolvedValue({ action: "policies" });
    await checkContentExclusions();
    expect(content()).toContain(`Path: ${policy}`);
    expect(content()).toContain("Active rules: 1");
    expect(content()).toContain("1: [ignored comment/blank] # explanation");
    expect(content()).toContain("3: [rule] *.vault");
    expect(content()).toContain("Status: missing");
    expect(content()).toContain("Status: unreadable");
    expect(content()).toContain("WARNING: This policy is not active");
    expect(content()).not.toContain("/not-the-user-file");
    expect(ui.showTextDocument).toHaveBeenCalledWith({ uri: "report" }, { preview: false });
  });

  it("tests a chosen file with the actual enforcement engine and never reads its contents", async () => {
    await writeFile(policy, "# blocked\nsrc/*.ts\n");
    setting("blockedFilePatternsFile", policy);
    ui.showQuickPick.mockResolvedValue({ action: "pick" });
    ui.showOpenDialog.mockResolvedValue([Uri.file(file)]);
    await checkContentExclusions();
    expect(content()).toContain("Decision: Excluded");
    expect(content()).toContain("Matched rule: src/*.ts");
    expect(content()).toContain(`Matched policy entry: ${policy}:2`);
    expect(content()).toContain(`Path: ${policy}`);
    expect(await sharingExclusion(ui.root, file)).toContain("blocks files matching 'src/*.ts'");
    expect(vi.mocked(fs.readFile).mock.calls.some(([path]) => path === file)).toBe(false);
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });

  it("does not call an incomplete policy check an all-clear", async () => {
    setting("blockedFilePatternsFile", policy);
    ui.showQuickPick.mockResolvedValue({ action: "current" });
    await checkContentExclusions();
    expect(content()).toContain("Decision: Not excluded - WARNING: policy checks incomplete");
    expect(content()).toContain("Not excluded does NOT mean safe to share");
  });

  it("shows actual ignore provenance, preserves negation, and refreshes parent ignores", async () => {
    const path = resolve(ui.root, ".gitignore");
    await writeFile(path, "src/*.ts\n!src/a.ts\n");
    expect(await sharingExclusionReport(ui.root, file)).toBeUndefined();
    await writeFile(resolve(ui.root, ".copilotignore"), "# private\nsrc/*.ts\n");
    expect(await sharingExclusionReport(ui.root, file)).toEqual({
      reason: "a .gitignore or .copilotignore file excludes it",
      source: `${resolve(ui.root, ".copilotignore")}:2`, rule: "src/*.ts"
    });
    await rm(resolve(ui.root, ".copilotignore"));
    expect(await sharingExclusion(ui.root, file)).toBeUndefined();
    await writeFile(resolve(base, ".copilotignore"), "# parent\napp/src/\n");
    ui.showQuickPick.mockResolvedValue({ action: "current" });
    await checkContentExclusions();
    expect(content()).toContain(`Source: ${resolve(base, ".copilotignore")}:2`);
    expect(content()).toContain("Matched rule: app/src/");
  });

  it("shows editor settings, built-in safeguards and repository boundaries", async () => {
    workspace.__setConfiguration("files.exclude", { "**/*.ts": true });
    expect(await sharingExclusionReport(ui.root, file)).toMatchObject({ source: "files.exclude", rule: "**/*.ts" });
    workspace.__resetConfiguration();
    expect(await sharingExclusionReport(ui.root, resolve(ui.root, ".env"))).toMatchObject({ source: "Built-in safeguards" });
    expect(await sharingExclusionReport(ui.root, resolve(ui.root, "node_modules/a.js"))).toMatchObject({ source: "Built-in safeguards" });
    expect(await sharingExclusionReport(ui.root, resolve(base, "outside.ts"))).toMatchObject({ source: "Repository boundary" });
  });

  it("preserves folder traversal for child-only wildcard rules", async () => {
    await writeFile(resolve(ui.root, ".gitignore"), "src/*\n");
    expect(await folderExclusion(ui.root, "src")).toBeUndefined();
    expect(await sharingExclusionReport(ui.root, file)).toMatchObject({
      source: `${resolve(ui.root, ".gitignore")}:1`, rule: "src/*"
    });
  });

  it("reports the remote rule and allowed-repository exception", async () => {
    execFileSync("git", ["-C", ui.root, "remote", "add", "origin", "ssh://user@git.example.com/team/app.git"]);
    const restricted = resolve(base, "restricted.rules");
    const allowed = resolve(base, "allowed.rules");
    await writeFile(restricted, "ssh://user@git.example.com/\n");
    await writeFile(allowed, "team/*\n");
    setting("restrictedRemotesFile", restricted);
    setting("allowedRepositoriesFile", allowed);
    ui.showQuickPick.mockResolvedValue({ action: "current" });
    await checkContentExclusions();
    expect(content()).toContain("Decision: Not excluded");
    expect(content()).toContain("Restricted-remotes rule: ssh://user@git.example.com/");
    expect(content()).toContain("Repository exception: Allowed-repositories rule: team/*");
  });

  it("handles menu and file cancellation without a report", async () => {
    ui.showQuickPick.mockResolvedValue(undefined);
    await checkContentExclusions();
    ui.showQuickPick.mockResolvedValue({ action: "pick" });
    ui.showOpenDialog.mockResolvedValue(undefined);
    await checkContentExclusions();
    expect(ui.openTextDocument).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });

  it("rejects remote files, untrusted workspaces, missing files and absent workspaces explicitly", async () => {
    ui.showQuickPick.mockResolvedValue({ action: "pick" });
    ui.showOpenDialog.mockResolvedValue([{ scheme: "vscode-remote", fsPath: file }]);
    await checkContentExclusions();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Choose a local file"));
    ui.showQuickPick.mockResolvedValue({ action: "current" });
    ui.trusted = false;
    await checkContentExclusions();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Trust the workspace"));
    expect(fs.readFile).not.toHaveBeenCalled();
    ui.trusted = true;
    ui.currentFile = resolve(base, "missing.ts");
    await checkContentExclusions();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("ENOENT"));
    ui.currentFile = file;
    ui.root = "";
    await checkContentExclusions();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Open a local workspace"));
    expect(ui.openTextDocument).not.toHaveBeenCalled();
  });
});
