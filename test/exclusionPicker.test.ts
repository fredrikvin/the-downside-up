import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { chooseExclusionFile, chooseExclusionFolder } from "../src/presentation/exclusionPicker";
import { workspace } from "./vscode";

const ui = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showQuickPick: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  update: vi.fn()
}));

vi.mock("vscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vscode")>();
  return {
    ...original,
    ConfigurationTarget: { Global: 1 },
    window: ui,
    workspace: {
      ...original.workspace,
      getConfiguration: (section?: string) => ({
        ...original.workspace.getConfiguration(section),
        update: ui.update
      })
    }
  };
});

let folder: string;
const settings = ["blockedFilePatternsFile", "restrictedRemotesFile", "allowedRepositoriesFile"] as const;

beforeEach(async () => {
  vi.resetAllMocks();
  workspace.__resetConfiguration();
  folder = await mkdtemp(resolve(tmpdir(), "downside-up-policy-picker-"));
});

afterEach(async () => {
  workspace.__resetConfiguration();
  await rm(folder, { recursive: true, force: true });
});

describe("exclusion file pickers", () => {
  it.each(settings)("writes %s only to user settings, with a native single-file picker", async (setting) => {
    const path = resolve(folder, "my policy.rules");
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(path)]);
    await chooseExclusionFile(setting);
    expect(ui.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false
    }));
    expect(ui.update).toHaveBeenCalledExactlyOnceWith(`exclusion.${setting}`, path, vscode.ConfigurationTarget.Global);
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });

  it("starts at the current user path, expands tilde, and ignores workspace values", async () => {
    workspace.__setConfiguration("downsideUp.exclusion.blockedFilePatternsFile", "~/policies/blocks");
    workspace.__setConfiguration("workspace:downsideUp.exclusion.blockedFilePatternsFile", "/workspace/other");
    ui.showOpenDialog.mockResolvedValue(undefined);
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.showOpenDialog.mock.calls[0]![0].defaultUri.fsPath).toBe(resolve(homedir(), "policies/blocks"));
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("leaves settings unchanged on cancellation or an empty selection", async () => {
    for (const selection of [undefined, []]) {
      ui.showOpenDialog.mockResolvedValue(selection);
      await chooseExclusionFile("restrictedRemotesFile");
      expect(ui.update).not.toHaveBeenCalled();
    }
  });

  it("rejects nonlocal selection and surfaces dialog and settings-write errors", async () => {
    ui.showOpenDialog.mockResolvedValue([{ scheme: "https", fsPath: "/not-local" }]);
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.update).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("local policy file"));
    ui.showOpenDialog.mockRejectedValueOnce(new Error("Dialog unavailable"));
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Dialog unavailable"));
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(resolve(folder, "rules"))]);
    ui.update.mockRejectedValueOnce(new Error("Settings are read-only"));
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Settings are read-only"));
  });
});

describe("exclusion folder picker", () => {
  async function files() {
    await writeFile(resolve(folder, "blocks.rules"), "private/**");
    await writeFile(resolve(folder, "remotes.rules"), "ssh://example.invalid/");
    await writeFile(resolve(folder, "allowed.rules"), "team/app");
    await mkdir(resolve(folder, "subfolder"));
    await writeFile(resolve(folder, "subfolder", "nested.rules"), "not listed");
    await symlink(resolve(folder, "blocks.rules"), resolve(folder, "linked.rules"));
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(folder)]);
  }

  it("assigns arbitrary filenames after collecting all choices, with no recursive listing", async () => {
    await files();
    const picked = ["blocks.rules", "remotes.rules", "allowed.rules"];
    ui.showQuickPick.mockImplementation(async (choices, options) => {
      expect(ui.update).not.toHaveBeenCalled();
      expect(choices.map((choice: vscode.QuickPickItem) => choice.label)).toEqual([
        "Keep current setting", "allowed.rules", "blocks.rules", "remotes.rules"
      ]);
      const index = ui.showQuickPick.mock.calls.length - 1;
      expect(options.title).toContain(`(${index + 1}/3)`);
      return choices.find((choice: vscode.QuickPickItem) => choice.label === picked[index]);
    });
    await chooseExclusionFolder();
    expect(ui.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    }));
    expect(ui.update.mock.calls).toEqual(settings.map((setting, index) => [
      `exclusion.${setting}`, resolve(folder, picked[index]!), vscode.ConfigurationTarget.Global
    ]));
  });

  it("preserves skipped settings", async () => {
    await files();
    ui.showQuickPick.mockImplementation(async (choices) => choices[ui.showQuickPick.mock.calls.length === 2 ? 3 : 0]);
    await chooseExclusionFolder();
    expect(ui.update).toHaveBeenCalledExactlyOnceWith("exclusion.restrictedRemotesFile", resolve(folder, "remotes.rules"), vscode.ConfigurationTarget.Global);
  });

  it("does not write any setting if assignment is cancelled midway", async () => {
    await files();
    ui.showQuickPick.mockImplementationOnce(async (choices) => choices[1]).mockResolvedValueOnce(undefined);
    await chooseExclusionFolder();
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("handles a cancelled picker and an empty folder without changing settings", async () => {
    ui.showOpenDialog.mockResolvedValueOnce(undefined);
    await chooseExclusionFolder();
    expect(ui.showQuickPick).not.toHaveBeenCalled();
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(folder)]);
    await chooseExclusionFolder();
    expect(ui.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no regular files"));
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("surfaces unreadable-directory errors", async () => {
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(resolve(folder, "missing"))]);
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Could not configure"));
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("rejects nonlocal folders and reports failed settings writes", async () => {
    ui.showOpenDialog.mockResolvedValue([{ scheme: "https", fsPath: "/not-local" }]);
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("local policy folder"));
    expect(ui.showQuickPick).not.toHaveBeenCalled();
    await files();
    ui.showQuickPick.mockImplementation(async (choices) => choices[1]);
    ui.update.mockRejectedValueOnce(new Error("Settings are read-only"));
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Settings are read-only"));
    expect(ui.update).toHaveBeenCalledTimes(1);
  });
});
