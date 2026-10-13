/** A folder and the subfolders below it, walked for a bottom-up summary run. */
export interface FolderTree {
  readonly root: string;
  /** Every folder in the tree, the root first. */
  readonly folders: readonly string[];
  readonly subfolders: ReadonlyMap<string, readonly string[]>;
  /** Folders grouped by height, leaves first, so each group only needs the groups before it. */
  readonly levels: ReadonlyArray<readonly string[]>;
}

/**
 * Walks the subfolders of `root` breadth first with `list` (which returns a
 * folder's subfolder paths). Returns undefined when there are more than
 * `limit` folders, so a run is never planned for part of a tree.
 */
export async function collectFolderTree(
  root: string,
  list: (path: string) => Promise<readonly string[]>,
  limit: number
): Promise<FolderTree | undefined> {
  const folders = [root];
  const subfolders = new Map<string, readonly string[]>();
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index]!;
    const below = [...new Set(await list(folder))].filter((path) => path !== folder && !subfolders.has(path) && !folders.includes(path));
    subfolders.set(folder, below);
    folders.push(...below);
    if (folders.length > limit) return undefined;
  }
  const height = new Map<string, number>();
  for (const folder of [...folders].reverse()) {
    height.set(folder, Math.max(-1, ...(subfolders.get(folder) ?? []).map((path) => height.get(path) ?? 0)) + 1);
  }
  const levels: string[][] = [];
  for (const folder of folders) (levels[height.get(folder)!] ??= []).push(folder);
  return { root, folders, subfolders, levels };
}

/**
 * The folders a run must summarize: those without a current summary, and
 * every folder above one of them, since a new subfolder summary changes its
 * parent's input.
 */
export function foldersToSummarize(tree: FolderTree, current: ReadonlySet<string>): Set<string> {
  const stale = new Set<string>();
  for (const level of tree.levels) {
    for (const folder of level) {
      if (!current.has(folder) || (tree.subfolders.get(folder) ?? []).some((path) => stale.has(path))) stale.add(folder);
    }
  }
  return stale;
}
