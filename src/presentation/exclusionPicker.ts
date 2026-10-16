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
    const updates: Array<{ setting: keyof PolicySettings; path: string }> = [];
    const settings = Object.keys(TITLES) as Array<keyof PolicySettings>;
    for (const [index, setting] of settings.entries()) {
      const choices: Array<vscode.QuickPickItem & { file?: string }> = [
        { label: "Keep current setting", description: policySettings()[setting] || "Not configured" },
        ...names.map((name) => ({ label: name, file: name }))
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: `${TITLES[setting]} (${index + 1}/${settings.length})`,
        placeHolder: "Select a file, or keep this setting unchanged",
        ignoreFocusOut: true
      });
      if (!choice) return;
      if (choice.file) updates.push({ setting, path: resolve(folder.fsPath, choice.file) });
    }
    const configuration = vscode.workspace.getConfiguration("downsideUp");
    for (const { setting, path } of updates) {
      await configuration.update(`exclusion.${setting}`, path, vscode.ConfigurationTarget.Global);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Could not configure content-exclusion files: ${detail}`);
  }
}
