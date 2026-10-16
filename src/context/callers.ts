import { resolve } from "node:path";
import * as vscode from "vscode";
import type { FunctionTarget } from "../core/types";
import type { LanguageSupport } from "../languages/support";
import type { CallerLocation } from "../languages/editor/callers";
import { listEligibleFiles } from "./inventory";

/**
 * Reverse only confidently resolved direct-call dependencies. A per-lookup
 * snapshot bounds work and keeps every resolver on the same unsaved-buffer text.
 */
export async function staticCallers(
  root: string,
  target: Pick<FunctionTarget, "uri" | "name" | "range">,
  support: LanguageSupport,
  load: (path: string) => Promise<string | undefined>,
  cancelled: () => boolean
): Promise<CallerLocation[]> {
  if (!support.findDirectCalls || !support.listFunctions) return [];
  const deadline = Date.now() + 8000;
  const { files } = await listEligibleFiles(root, "", 2000);
  const texts = new Map<string, string>();
  let bytes = 0;
  for (const path of files.sort()) {
    if (cancelled()) return [];
    if (Date.now() >= deadline) break;
    if (!support.fileExtensions.some((extension) => path.endsWith(extension)) &&
        !support.directCallManifests?.includes(path.split("/").pop()!)) continue;
    if (texts.size >= 100) break;
    const text = await load(path);
    if (text === undefined || Buffer.byteLength(text) > 256 * 1024) continue;
    bytes += Buffer.byteLength(text);
    if (bytes > 2 * 1024 * 1024) break;
    texts.set(path, text);
  }
  const readablePaths = new Set(texts.keys());
  const callers: CallerLocation[] = [];
  let checked = 0;
  for (const [path, text] of texts) {
    if (!support.fileExtensions.some((extension) => path.endsWith(extension))) continue;
    for (const fn of await support.listFunctions(text, path)) {
      if (cancelled()) return [];
      if (++checked > 500 || Date.now() >= deadline) return callers;
      const result = await support.findDirectCalls({
        root, path, text, line: fn.startLine, name: fn.name,
        readablePaths, load: async (file) => texts.get(file), maxDependencies: 100
      });
      if (result.dependencies.some(({ path: file, item }) =>
        resolve(root, file) === resolve(target.uri.fsPath) &&
        item.line === target.range.start.line && item.name === target.name
      )) {
        callers.push({
          name: fn.qualifiedName,
          uri: vscode.Uri.file(resolve(root, path)),
          position: new vscode.Position(fn.startLine, 0),
          source: text
        });
      }
      if (callers.length >= 100) return callers;
    }
  }
  return callers;
}
