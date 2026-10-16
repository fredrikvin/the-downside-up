import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import { policySettings, type PolicySettings } from "../context/policy";

const TITLES: Record<keyof PolicySettings, string> = {
  blockedFilePatternsFile: "Choose blocked file patterns file",
  restrictedRemotesFile: "Choose restricted remotes file",
  allowedRepositoriesFile: "Choose allowed repositories file"
};

const HINTS: Record<keyof PolicySettings, string> = {
  blockedFilePatternsFile: "File patterns, for example *.vault or private/**",
  restrictedRemotesFile: "Git server URL prefixes, for example ssh://git.example.com/",
  allowedRepositoriesFile: "Repository path exceptions, for example team/app"
};

interface PolicyChoice extends vscode.QuickPickItem {
  readonly file?: string;
}

function assignmentStep(
  setting: keyof PolicySettings,
  index: number,
  names: readonly string[],
  selected: string | undefined
): Promise<{ direction: "next" | "back"; file?: string } | undefined> {
  const picker = vscode.window.createQuickPick<PolicyChoice>();
  const next = { iconPath: new vscode.ThemeIcon("arrow-right"), tooltip: index === 2 ? "Next: review all assignments" : "Next policy setting" };
  picker.title = TITLES[setting];
  picker.step = index + 1;
  picker.totalSteps = 4;
  picker.placeholder = `${HINTS[setting]}. Select a row, then use Next (right arrow).`;
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  picker.items = [
    { label: "Keep current setting", description: policySettings()[setting] || "Not configured" },
    ...names.map((name) => ({ label: name, file: name }))
  ];
  picker.activeItems = picker.items.filter((item) => item.file === selected);
  picker.buttons = index ? [vscode.QuickInputButtons.Back, next] : [next];
  return new Promise((resolveStep) => {
    const subscriptions: vscode.Disposable[] = [];
    let finished = false;
    const finish = (result: { direction: "next" | "back"; file?: string } | undefined) => {
      if (finished) return;
      finished = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      picker.dispose();
      resolveStep(result);
    };
    const choice = () => picker.selectedItems[0] ?? picker.activeItems[0];
    subscriptions.push(
      picker.onDidAccept(() => {
        const item = choice();
        if (item) picker.placeholder = `Selected: ${item.label}. Use Next (right arrow) to continue${index ? "; Back revisits the previous choice" : ""}.`;
      }),
      picker.onDidTriggerButton((button) => {
        const item = choice();
        if (button === vscode.QuickInputButtons.Back) finish({ direction: "back", file: item?.file });
        else if (button === next && item) finish({ direction: "next", file: item.file });
      }),
      picker.onDidHide(() => finish(undefined))
    );
    picker.show();
  });
}

function reviewAssignments(
  settings: readonly (keyof PolicySettings)[],
  assignments: ReadonlyMap<keyof PolicySettings, string | undefined>
): Promise<"save" | "back" | undefined> {
  const picker = vscode.window.createQuickPick();
  const save = { iconPath: new vscode.ThemeIcon("check"), tooltip: "Save these assignments to user settings" };
  picker.title = "Review content-exclusion files";
  picker.step = 4;
  picker.totalSteps = 4;
  picker.placeholder = "Review all three assignments. Use Back to correct them, or the checkmark to save.";
  picker.ignoreFocusOut = true;
  picker.items = settings.map((setting) => ({
    label: TITLES[setting].replace("Choose ", ""),
    description: assignments.get(setting) ?? "Keep current setting",
    detail: assignments.get(setting) ? HINTS[setting] : policySettings()[setting] || "Not configured"
  }));
  picker.buttons = [vscode.QuickInputButtons.Back, save];
  return new Promise((resolveReview) => {
    const subscriptions: vscode.Disposable[] = [];
    let finished = false;
    const finish = (result: "save" | "back" | undefined) => {
      if (finished) return;
      finished = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      picker.dispose();
      resolveReview(result);
    };
    subscriptions.push(
      picker.onDidTriggerButton((button) => finish(button === save ? "save" : "back")),
      picker.onDidHide(() => finish(undefined))
    );
    picker.show();
  });
}

function currentFile(setting: keyof PolicySettings): vscode.Uri | undefined {
  const current = policySettings()[setting];
  const expanded = current === "~" || current.startsWith("~/") ? resolve(homedir(), current.slice(2)) : current;
  return isAbsolute(expanded) ? vscode.Uri.file(expanded) : undefined;
}

export async function chooseExclusionFile(setting: keyof PolicySettings): Promise<void> {
  try {
    const selected = await vscode.window.showOpenDialog({
      title: TITLES[setting],
      openLabel: "Use policy file",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: currentFile(setting) ?? vscode.Uri.file(homedir())
    });
    const file = selected?.[0];
    if (!file) return;
    if (file.scheme !== "file") throw new Error("Choose a local policy file.");
    await vscode.workspace.getConfiguration("downsideUp").update(
      `exclusion.${setting}`, file.fsPath, vscode.ConfigurationTarget.Global
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Could not set the content-exclusion file: ${detail}`);
  }
}

export async function chooseExclusionFolder(): Promise<void> {
  try {
    const previous = currentFile("blockedFilePatternsFile") ?? currentFile("restrictedRemotesFile") ?? currentFile("allowedRepositoriesFile");
    const selected = await vscode.window.showOpenDialog({
      title: "Choose content-exclusion policy folder",
      openLabel: "Choose policy folder",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(previous ? dirname(previous.fsPath) : homedir())
    });
    const folder = selected?.[0];
    if (!folder) return;
    if (folder.scheme !== "file") throw new Error("Choose a local policy folder.");
    const names = (await readdir(folder.fsPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    if (!names.length) {
      await vscode.window.showInformationMessage("The selected folder has no regular files. Existing exclusion settings were left unchanged.");
      return;
    }
    const assignments = new Map<keyof PolicySettings, string | undefined>();
    const settings = Object.keys(TITLES) as Array<keyof PolicySettings>;
    let index = 0;
    while (true) {
      if (index === settings.length) {
        const review = await reviewAssignments(settings, assignments);
        if (!review) return;
        if (review === "save") break;
        index--;
        continue;
      }
      const setting = settings[index]!;
      const choice = await assignmentStep(setting, index, names, assignments.get(setting));
      if (!choice) return;
      assignments.set(setting, choice.file);
      index += choice.direction === "next" ? 1 : -1;
    }
    const configuration = vscode.workspace.getConfiguration("downsideUp");
    for (const [setting, file] of assignments) {
      if (file) await configuration.update(`exclusion.${setting}`, resolve(folder.fsPath, file), vscode.ConfigurationTarget.Global);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Could not configure content-exclusion files: ${detail}`);
  }
}
