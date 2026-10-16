import { stat } from "node:fs/promises";
import * as vscode from "vscode";
import { clearSharingExclusionCache, findRepositoryRoot, sharingExclusionReport } from "../context/inventory";
import { currentPolicy, policyFileReports, type PolicyFileReport, type PolicySettings } from "../context/policy";

const TITLES: Record<keyof PolicySettings, string> = {
  blockedFilePatternsFile: "Blocked file patterns",
  restrictedRemotesFile: "Restricted remotes",
  allowedRepositoriesFile: "Allowed repositories"
};

const SEMANTICS: Record<keyof PolicySettings, string> = {
  blockedFilePatternsFile: "Repository-relative globs: no slash matches at any depth; slash anchors at root; ** crosses folders.",
  restrictedRemotesFile: "Remote URL prefixes: trailing * is implied; * and ? are wildcards.",
  allowedRepositoriesFile: "Whole repository paths without host or .git; * matches within one path segment."
};

export function formatPolicyReports(reports: readonly PolicyFileReport[]): string {
  const lines = [
    "CONTENT EXCLUSION CHECK",
    "",
    "Local diagnostics only. No AI requests or consent changes.",
    "No source contents read, except exclusion/opt-in control files used by the checks.",
    "Not excluded does NOT mean safe to share. Consent, workspace trust, supported file",
    "types, and request/scan limits still apply. Copilot server-side exclusions are not",
    "available to this extension or applied to Language Model API requests.",
    "This is a snapshot; rerun the command after changes.",
    ""
  ];
  for (const report of reports) {
    const count = report.entries.filter((entry) => entry.active).length;
    lines.push(TITLES[report.setting], `Setting: downsideUp.exclusion.${report.setting}`,
      `Path: ${report.path ?? "(not configured)"}`, `Status: ${report.status}`, SEMANTICS[report.setting]);
    if (report.status === "missing" || report.status === "unreadable") {
      lines.push("WARNING: This policy is not active. It adds no restrictions.", report.error ?? "");
    } else if (report.status === "not configured") {
      lines.push("No additional rules configured for this policy.");
    } else {
      lines.push(`Active rules: ${count}${count === 0 ? " (this policy adds no restrictions)" : ""}`);
      for (const entry of report.entries) {
        lines.push(`${entry.line}: ${entry.active ? "[rule]" : "[ignored comment/blank]"} ${entry.text}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function showReport(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: "plaintext", content });
  await vscode.window.showTextDocument(document, { preview: false });
}

export async function checkContentExclusions(): Promise<void> {
  try {
    const active = vscode.window.activeTextEditor?.document.uri;
    const choices = [
      { label: "Inspect policy files", description: "Fresh load status and parsed rules", action: "policies" },
      ...(active?.scheme === "file" ? [{ label: "Test current file", description: active.fsPath, action: "current" }] : []),
      { label: "Test a file...", description: "Choose a file without reading its source", action: "pick" }
    ];
    const choice = await vscode.window.showQuickPick(choices, { title: "Check content exclusions", placeHolder: "Local checks only; nothing is sent to AI" });
    if (!choice) return;
    if (choice.action === "policies") {
      await showReport(formatPolicyReports(await policyFileReports()));
      return;
    }
    const file = choice.action === "current" ? active : (await vscode.window.showOpenDialog({
      title: "Test file against content exclusions", canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      defaultUri: active?.scheme === "file" ? active : vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: "Test file"
    }))?.[0];
    if (!file) return;
    if (file.scheme !== "file") throw new Error("Choose a local file. Remote file URIs are not supported.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust the workspace before checking repository exclusions. No repository files were inspected.");
    if (!(await stat(file.fsPath)).isFile()) throw new Error("Choose an existing regular file.");
    const folders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file") ?? [];
    const containing = vscode.workspace.getWorkspaceFolder(file);
    const folder = containing?.uri.scheme === "file" ? containing : folders.length === 1 ? folders[0] :
      (await vscode.window.showQuickPick(folders.map((folder) => ({
        label: folder.name, description: folder.uri.fsPath, folder
      })), { title: "Choose the workspace to check against" }))?.folder;
    if (!folder) {
      if (!folders.length) throw new Error("Open a local workspace folder before testing a file.");
      return;
    }
    const root = await findRepositoryRoot(folder.uri.fsPath);
    const reports = await policyFileReports();
    clearSharingExclusionCache();
    const policy = await currentPolicy();
    const repository = await policy.repositoryReport(root);
    const result = await sharingExclusionReport(root, file.fsPath);
    const incomplete = reports.some((report) => report.status === "missing" || report.status === "unreadable") || Boolean(repository.error);
    const lines = [
      "FILE CHECK", `File: ${file.fsPath}`, `Repository: ${root}`,
      `Decision: ${result ? "Excluded" : "Not excluded"}${incomplete ? " - WARNING: policy checks incomplete" : ""}`,
      "The first blocking check is shown; other exclusions may also match."
    ];
    if (result) lines.push(`Reason: ${result.reason}`, `Source: ${result.source}`, ...(result.rule ? [`Matched rule: ${result.rule}`] : []));
    for (const [setting, rule] of [
      ["blockedFilePatternsFile", result?.source === "Blocked file patterns policy" ? result.rule : undefined],
      ["restrictedRemotesFile", repository.matchedRule]
    ] as const) {
      const report = reports.find((report) => report.setting === setting);
      const entry = report?.entries.find((entry) => entry.active && entry.text === rule);
      if (entry) lines.push(`Matched policy entry: ${report?.path}:${entry.line}`);
    }
    if (repository.matchedRule) lines.push(`Restricted-remotes rule: ${repository.matchedRule}`);
    if (repository.exception) lines.push(`Repository exception: ${repository.exception}`);
    if (repository.error) lines.push(`WARNING: ${repository.error}`);
    await showReport(`${lines.join("\n")}\n\n${formatPolicyReports(reports)}`);
  } catch (error) {
    await vscode.window.showErrorMessage(`Could not check content exclusions: ${error instanceof Error ? error.message : String(error)}`);
  }
}
