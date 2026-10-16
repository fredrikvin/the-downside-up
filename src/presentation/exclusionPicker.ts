import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import { policySettings, type PolicySettings } from "../context/policy";
import { chooseExclusionAssignments } from "./exclusionWizard";

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
    const settings = Object.keys(TITLES) as Array<keyof PolicySettings>;
    const current = policySettings();
    const assignments = await chooseExclusionAssignments(settings.map((setting) => ({
      title: TITLES[setting], hint: HINTS[setting], current: current[setting] || "Not configured"
    })), names);
    if (!assignments) return;
    const configuration = vscode.workspace.getConfiguration("downsideUp");
    for (const [index, setting] of settings.entries()) {
      const file = names[assignments[index]! - 1];
      if (file) await configuration.update(`exclusion.${setting}`, resolve(folder.fsPath, file), vscode.ConfigurationTarget.Global);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Could not configure content-exclusion files: ${detail}`);
  }
}
