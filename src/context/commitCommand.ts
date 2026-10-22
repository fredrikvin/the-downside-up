import { isAbsolute } from "node:path";

/**
 * The graph forwards (SourceControl, SourceControlHistoryItem), not a Git
 * Repository or a bare hash. This menu is still proposed-only in VS Code;
 * the stable command palette path does not require it (see development.md).
 */
export function graphCommitTarget(sourceControl: unknown, historyItem: unknown): { root: string; revision: string } {
  const source = sourceControl as { id?: unknown; rootUri?: { scheme?: unknown; fsPath?: unknown } } | undefined;
  const item = historyItem as { id?: unknown } | undefined;
  if (source?.id !== "git" || source.rootUri?.scheme !== "file" ||
      typeof source.rootUri.fsPath !== "string" || !isAbsolute(source.rootUri.fsPath) || source.rootUri.fsPath.length > 32_768 ||
      typeof item?.id !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(item.id)) {
    throw new Error("Choose one local Git commit, or run Prepare Commit Explanations… from the command palette.");
  }
  return { root: source.rootUri.fsPath, revision: item.id };
}
