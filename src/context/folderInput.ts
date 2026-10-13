import { basename } from "node:path";
import type { FolderPartInput, FolderSummaryPromptInput } from "../generation/provider";
import { bundledLanguageFor } from "../languages/registry";
import type { FolderChild } from "./inventory";
import type { StructureGraph } from "./structure";

const MAX_PARTS = 150;
const MAX_CONTENTS = 20;
const MAX_IMPORTS = 200;
const MAX_README_BYTES = 8 * 1024;

export interface FolderInputSources {
  /** A file's saved one-sentence summary, current or not. */
  readonly fileSummary: (path: string) => string | undefined;
  /** A subfolder's saved summary sentence, current or not. */
  readonly folderSummary: (path: string) => Promise<string | undefined>;
  /** A file's current text, or undefined when it cannot be read. */
  readonly text: (path: string) => Promise<string | undefined>;
  /** Names of a subfolder's contents. */
  readonly contents: (path: string) => Promise<string[]>;
}

/**
 * What a folder summary is made from: each part's saved summary, or else the
 * names of a file's functions and types (from its bundled language support)
 * or a subfolder's contents, the import edges between parts, and the
 * folder's README, bounded. No source code is included.
 */
export async function folderSummaryInput(
  repositoryName: string,
  path: string,
  children: readonly FolderChild[],
  structure: StructureGraph | undefined,
  sources: FolderInputSources
): Promise<FolderSummaryPromptInput> {
  const parts: FolderPartInput[] = [];
  for (const child of children.slice(0, MAX_PARTS)) {
    if (child.kind === "file") {
      const summary = sources.fileSummary(child.path);
      if (summary) {
        parts.push({ name: child.name, kind: "file", summary });
        continue;
      }
      const language = bundledLanguageFor({ path: child.path });
      const text = language?.listFunctions ? await sources.text(child.path) : undefined;
      const names = text !== undefined && language?.listFunctions
        ? [...new Set((await language.listFunctions(text, child.path).catch(() => [])).map((entry) => entry.qualifiedName))].slice(0, MAX_CONTENTS)
        : [];
      parts.push({ name: child.name, kind: "file", ...(names.length ? { contents: names } : {}) });
    } else {
      const summary = await sources.folderSummary(child.path);
      if (summary) {
        parts.push({ name: child.name, kind: "folder", summary });
        continue;
      }
      const names = (await sources.contents(child.path).catch(() => [])).slice(0, MAX_CONTENTS);
      parts.push({ name: child.name, kind: "folder", ...(names.length ? { contents: names } : {}) });
    }
  }
  const nameOf = new Map(children.map((child) => [child.path, child.name]));
  const imports = (structure?.edges ?? [])
    .map((edge) => ({ from: nameOf.get(edge.from) ?? basename(edge.from), to: nameOf.get(edge.to) ?? basename(edge.to) }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
    .slice(0, MAX_IMPORTS);
  const readmeChild = children.find((child) => child.kind === "file" && /^readme(\.(md|markdown|txt|rst))?$/i.test(child.name));
  const readmeText = readmeChild ? await sources.text(readmeChild.path) : undefined;
  const readme = readmeText === undefined
    ? undefined
    : Buffer.byteLength(readmeText, "utf8") > MAX_README_BYTES
      ? `${Buffer.from(readmeText, "utf8").subarray(0, MAX_README_BYTES).toString("utf8")}\n[README truncated]`
      : readmeText;
  return { repositoryName, path, parts, imports, ...(readme ? { readme } : {}) };
}
