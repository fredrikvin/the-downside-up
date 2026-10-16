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
  createQuickPick: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  update: vi.fn()
}));

vi.mock("vscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vscode")>();
  return {
    ...original,
    ConfigurationTarget: { Global: 1 },
    ThemeIcon: class { constructor(public readonly id: string) {} },
    QuickInputButtons: { Back: { tooltip: "Back" } },
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
type WizardAction = { file?: string; direction?: "next" | "back" | "save" | "cancel" };
let wizardActions: WizardAction[];
let wizardViews: Array<{ step: number; items: readonly vscode.QuickPickItem[]; activeItems: readonly vscode.QuickPickItem[]; placeholder: string }>;
const settings = ["blockedFilePatternsFile", "restrictedRemotesFile", "allowedRepositoriesFile"] as const;

beforeEach(async () => {
  vi.resetAllMocks();
  workspace.__resetConfiguration();
  wizardActions = [];
  wizardViews = [];
  ui.createQuickPick.mockImplementation(() => {
    const handlers = new Map<string, (value?: unknown) => void>();
    const listen = (event: string, handler: (value?: unknown) => void) => {
      handlers.set(event, handler);
      return { dispose: () => handlers.delete(event) };
    };
    const picker = {
      step: 0, items: [] as Array<vscode.QuickPickItem & { file?: string }>,
      activeItems: [] as Array<vscode.QuickPickItem & { file?: string }>,
      selectedItems: [] as Array<vscode.QuickPickItem & { file?: string }>,
      buttons: [] as vscode.QuickInputButton[], placeholder: "",
      onDidAccept: (handler: () => void) => listen("accept", handler),
      onDidTriggerButton: (handler: (value?: unknown) => void) => listen("button", handler),
      onDidHide: (handler: () => void) => listen("hide", handler),
      dispose: vi.fn(),
      show: () => queueMicrotask(() => {
        wizardViews.push({ step: picker.step, items: picker.items, activeItems: picker.activeItems, placeholder: picker.placeholder });
        const action = wizardActions.shift() ?? { direction: "cancel" };
        if (action.direction === "cancel") { handlers.get("hide")?.(); return; }
        if (picker.step < 4) {
          picker.selectedItems = picker.items.filter((item) => item.file === action.file);
          handlers.get("accept")?.();
          handlers.get("accept")?.();
          expect(ui.update).not.toHaveBeenCalled();
          expect(handlers.has("button")).toBe(true);
        }
        const button = action.direction === "back" ? vscode.QuickInputButtons.Back : picker.buttons[picker.buttons.length - 1];
        handlers.get("button")?.(button);
      })
    };
    return picker;
  });
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
    wizardActions = [...picked.map((file) => ({ file, direction: "next" as const })), { direction: "save" }];
    await chooseExclusionFolder();
    expect(ui.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    }));
    expect(ui.update.mock.calls).toEqual(settings.map((setting, index) => [
      `exclusion.${setting}`, resolve(folder, picked[index]!), vscode.ConfigurationTarget.Global
    ]));
    expect(wizardViews.map((view) => view.step)).toEqual([1, 2, 3, 4]);
    expect(wizardViews[0]!.items.map((item) => item.label)).toEqual(["Keep current setting", "allowed.rules", "blocks.rules", "remotes.rules"]);
    expect(wizardViews[0]!.placeholder).toContain("*.vault");
    expect(wizardViews[1]!.placeholder).toContain("ssh://");
    expect(wizardViews[2]!.placeholder).toContain("team/app");
    expect(wizardViews[3]!.items.map((item) => item.description)).toEqual(picked);
  });

  it("preserves skipped settings", async () => {
    await files();
    wizardActions = [{ direction: "next" }, { file: "remotes.rules", direction: "next" }, { direction: "next" }, { direction: "save" }];
    await chooseExclusionFolder();
    expect(ui.update).toHaveBeenCalledExactlyOnceWith("exclusion.restrictedRemotesFile", resolve(folder, "remotes.rules"), vscode.ConfigurationTarget.Global);
  });

  it("does not write any setting if assignment is cancelled midway", async () => {
    await files();
    wizardActions = [{ file: "blocks.rules", direction: "next" }, { direction: "cancel" }];
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
    wizardActions = settings.map(() => ({ file: "allowed.rules", direction: "next" }));
    wizardActions.push({ direction: "save" });
    ui.update.mockRejectedValueOnce(new Error("Settings are read-only"));
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Settings are read-only"));
    expect(ui.update).toHaveBeenCalledTimes(1);
  });

  it("supports Back from assignment and review screens and remembers choices", async () => {
    await files();
    wizardActions = [
      { file: "blocks.rules", direction: "next" },
      { file: "blocks.rules", direction: "back" },
      { file: "allowed.rules", direction: "next" },
      { file: "remotes.rules", direction: "next" },
      { direction: "next" },
      { direction: "back" },
      { file: "blocks.rules", direction: "next" },
      { direction: "save" }
    ];
    await chooseExclusionFolder();
    expect(wizardViews.map((view) => view.step)).toEqual([1, 2, 1, 2, 3, 4, 3, 4]);
    expect(wizardViews[2]!.activeItems[0]!.label).toBe("blocks.rules");
    expect(wizardViews[3]!.activeItems[0]!.label).toBe("blocks.rules");
    expect(ui.update.mock.calls).toEqual([
      ["exclusion.blockedFilePatternsFile", resolve(folder, "allowed.rules"), vscode.ConfigurationTarget.Global],
      ["exclusion.restrictedRemotesFile", resolve(folder, "remotes.rules"), vscode.ConfigurationTarget.Global],
      ["exclusion.allowedRepositoriesFile", resolve(folder, "blocks.rules"), vscode.ConfigurationTarget.Global]
    ]);
  });

  it("leaves settings untouched if the final review is cancelled", async () => {
    await files();
    wizardActions = settings.map(() => ({ file: "blocks.rules", direction: "next" }));
    wizardActions.push({ direction: "cancel" });
    await chooseExclusionFolder();
    expect(wizardViews).toHaveLength(4);
    expect(ui.update).not.toHaveBeenCalled();
  });
});
