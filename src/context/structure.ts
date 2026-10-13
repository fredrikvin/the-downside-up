import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { bundledLanguageFor } from "../languages/registry";
import type { FolderChild } from "./inventory";
import { listEligibleFiles } from "./inventory";

/** A box in a folder's structure diagram: one direct child of the folder. */
export interface StructureNode {
  /** Repository-relative path of the child. */
  readonly id: string;
  readonly kind: "folder" | "file";
  readonly name: string;
}

/** Imports from files in one child to files in another, counted per importing file and target. */
export interface StructureEdge {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
}

export interface StructureGraph {
  readonly nodes: readonly StructureNode[];
  readonly edges: readonly StructureEdge[];
  readonly limitations: readonly string[];
}

const MAX_STRUCTURE_FILES = 1_500;
const MAX_STRUCTURE_BYTES = 24 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;

const importCache = new Map<string, { mtimeMs: number; size: number; imports: string[] }>();

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

/** The direct child of `folder` that holds `path`, or undefined when it is outside the folder or is the folder itself. */
function childOf(folder: string, path: string): string | undefined {
  const inside = folder === "" ? path : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined;
  if (!inside || inside === ".") return undefined;
  const first = inside.split("/")[0]!;
  return folder === "" ? first : `${folder}/${first}`;
}

/**
 * The import graph between a folder's direct children, found locally: each
 * eligible file under the folder is read (open buffers are not consulted;
 * this is a structural sketch) and its imports resolved by its language
 * support. Imports leaving the folder, within one child, or in languages
 * without import support are left out and stated.
 */
export async function folderStructure(
  rootPath: string,
  folder: string,
  children: readonly FolderChild[]
): Promise<StructureGraph> {
  const root = await realpath(rootPath);
  const limitations: string[] = [];
  const nodes: StructureNode[] = children.map((child) => ({ id: child.path, kind: child.kind, name: child.name }));
  const ids = new Set(nodes.map((node) => node.id));
  const { files, complete } = await listEligibleFiles(root, folder);
  if (!complete) limitations.push("Only part of this folder was scanned for imports.");
  const known = new Set(files);
  const readSmall = async (path: string): Promise<string | undefined> => {
    const absolute = resolve(root, path);
    if (!within(root, absolute)) return undefined;
    try {
      if ((await stat(absolute)).size > MAX_FILE_BYTES) return undefined;
      return await readFile(absolute, "utf8");
    } catch {
      return undefined;
    }
  };
  const weights = new Map<string, number>();
  const unsupported = new Set<string>();
  let bytes = 0;
  let scanned = 0;
  for (const path of files) {
    const from = childOf(folder, path);
    if (!from || !ids.has(from)) continue;
    const language = bundledLanguageFor({ path });
    if (!language?.fileImports) {
      const extension = posix.extname(path);
      if (extension) unsupported.add(extension);
      continue;
    }
    if (scanned >= MAX_STRUCTURE_FILES || bytes >= MAX_STRUCTURE_BYTES) {
      limitations.push(`Imports were read from the first ${scanned.toLocaleString("en")} files only.`);
      break;
    }
    const absolute = resolve(root, path);
    let imports: string[];
    try {
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) continue;
      scanned++;
      bytes += info.size;
      const cached = importCache.get(absolute);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        imports = cached.imports;
      } else {
        const text = await readFile(absolute, "utf8");
        imports = await language.fileImports({ path, text, hasFile: (candidate) => known.has(candidate), readFile: readSmall })
          .catch(() => []);
        importCache.set(absolute, { mtimeMs: info.mtimeMs, size: info.size, imports });
      }
    } catch {
      continue;
    }
    for (const target of imports) {
      const to = childOf(folder, target);
      if (!to || to === from || !ids.has(to)) continue;
      const key = `${from}\0${to}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }
  if (unsupported.size) {
    limitations.push(`Imports are not read for ${[...unsupported].sort().join(", ")} files, so their connections are not shown.`);
  }
  const edges = [...weights].map(([key, weight]) => {
    const [from, to] = key.split("\0") as [string, string];
    return { from, to, weight };
  });
  return { nodes, edges, limitations };
}
