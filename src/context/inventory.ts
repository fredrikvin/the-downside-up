import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { fingerprint } from "../core/fingerprint";
import { currentPolicy } from "./policy";
import { bundledLanguageIdForPath } from "../languages/registry";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_PRIME_BYTES = 80 * 1024;
const MAX_READABLE_FILES = 200;
const GIT_HEAD_SNAPSHOT_KEY = "\0git-head";
const GIT_HEAD_CHANGED_LABEL = "[Git branch/HEAD]";
const ALWAYS_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "coverage",
  ".vscode-test",
  ".next",
  ".turbo"
]);
const SECRET_FILE = /(?:^|[._-])(?:secret|credential|token|private)(?:[._-]|$)/i;
const TEXT_EXTENSIONS = new Set([
  ".rs", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".hpp",
  ".rb", ".php", ".swift", ".kt", ".scala", ".md", ".mdx",
  ".txt", ".toml", ".json", ".yaml", ".yml", ".xml", ".html",
  ".css", ".scss", ".sql", ".sh", ".gitignore", ".properties"
]);
/** Source and text files the inventory reads, including every bundled language's files. */
const isTextFile = (path: string): boolean =>
  TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || bundledLanguageIdForPath(path) !== undefined;

const PRIORITY = [
  /^README(?:\.[^/]*)?$/i,
  /(?:^|\/)(?:Cargo\.toml|package\.json|pyproject\.toml|go\.mod|pom\.xml|build\.gradle)$/i,
  /(?:^|\/)(?:ARCHITECTURE|CONTRIBUTING|DESIGN)(?:\.[^/]*)?$/i,
  /(?:^|\/)(?:main|index|lib|mod)\.(?:rs|[cm]?js|jsx|mjs|cjs|ts|tsx|py|go|java)$/i
];

export interface InventoryFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly hash: string;
  readonly size: number;
  readonly languageId: string | null;
}

export interface RepositoryInventory {
  readonly root: string;
  readonly name: string;
  readonly files: InventoryFile[];
  readonly snapshot: Record<string, string>;
  /** Files whose content is included in the priming inventory text. */
  readonly primedPaths: string[];
  readonly inventoryText: string;
  readonly languageIds: string[];
  readonly limitations: string[];
  readonly changedPaths: string[];
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalRelative(value: string): string {
  return value.split(sep).join("/");
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await stat(resolve(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

function runGit(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout.trim());
      }
    );
  });
}

async function gitHeadFingerprint(root: string, limitations: string[]): Promise<string | undefined> {
  if (!(await hasGitMarker(root))) return undefined;
  try {
    const revision = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
    const branch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      .catch(() => "detached");
    return fingerprint(JSON.stringify([branch, revision]));
  } catch {
    limitations.push("Git branch/revision could not be read; source-file changes remain tracked.");
    return undefined;
  }
}

export async function findRepositoryRoot(workspaceRoot: string): Promise<string> {
  let current = await realpath(workspaceRoot);
  const workspace = current;
  while (true) {
    if (await hasGitMarker(current)) return current;
    if (current === dirname(current) || !isWithin(current, workspace)) return workspace;
    const parent = dirname(current);
    if (!isWithin(workspace, parent)) return workspace;
    current = parent;
  }
}

function isSecretOrGenerated(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const file = basename(relativePath);
  const ignoreControlFile = file === ".gitignore" || file === ".copilotignore";
  if (
    parts.some((part, index) =>
      part.startsWith(".") &&
      part !== ".well-known" &&
      !(ignoreControlFile && index === parts.length - 1)
    )
  ) return true;
  if (/^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i.test(file)) return true;
  if (SECRET_FILE.test(file) || /\.(?:lockb|vsix|dll|dylib|so|exe|bin|class|o|a|wasm|png|jpe?g|gif|pdf|zip|gz|db)$/i.test(file)) {
    return true;
  }
  return false;
}

function eligiblePath(relativePath: string): boolean {
  const file = basename(relativePath);
  return isTextFile(relativePath) ||
    file === "Cargo.toml" ||
    file === "Cargo.lock" ||
    file === "go.mod" ||
    file === "go.work" ||
    file === "package.json" ||
    file === "package-lock.json" ||
    file === ".gitignore" ||
    file === ".copilotignore";
}

async function readIgnoreRules(directory: string): Promise<ReturnType<typeof ignore> | undefined> {
  try {
    const [gitIgnore, copilotIgnore] = await Promise.all([
      readFile(resolve(directory, ".gitignore"), "utf8").catch(() => ""),
      readFile(resolve(directory, ".copilotignore"), "utf8").catch(() => "")
    ]);
    return ignore().add(gitIgnore).add(copilotIgnore);
  } catch {
    return undefined;
  }
}

function isEditorExcluded(root: string, path: string): boolean {
  const relativePath = path.split(sep).join("/");
  const resource = vscode.Uri.file(root);
  const excludes = [
    vscode.workspace.getConfiguration("files", resource).get<Record<string, boolean>>("exclude") ?? {},
    vscode.workspace.getConfiguration("search", resource).get<Record<string, boolean>>("exclude") ?? {}
  ];
  return excludes.some((entries) =>
    Object.entries(entries).some(([pattern, active]) =>
      active &&
      (minimatch(relativePath, pattern, { dot: true }) ||
        (!pattern.includes("/") && minimatch(basename(relativePath), pattern, { dot: true })))
    )
  );
}

const ancestorRulesCache = new Map<string, { at: number; value: Promise<Array<{ directory: string; rules: ReturnType<typeof ignore> }>> }>();

/** `.copilotignore` files in the folders above the repository, which apply to it as they do for Copilot. */
function ancestorCopilotIgnores(root: string): Promise<Array<{ directory: string; rules: ReturnType<typeof ignore> }>> {
  const cached = ancestorRulesCache.get(root);
  if (cached && Date.now() - cached.at < 5_000) return cached.value;
  const value = (async () => {
    const found: Array<{ directory: string; rules: ReturnType<typeof ignore> }> = [];
    let directory = dirname(root);
    while (directory !== root) {
      const text = await readFile(resolve(directory, ".copilotignore"), "utf8").catch(() => undefined);
      if (text !== undefined) found.push({ directory, rules: ignore().add(text) });
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return found;
  })();
  ancestorRulesCache.set(root, { at: Date.now(), value });
  return value;
}

async function isIgnored(root: string, relativePath: string): Promise<boolean> {
  for (const { directory, rules } of await ancestorCopilotIgnores(root)) {
    if (rules.ignores(relative(directory, resolve(root, relativePath)).split(sep).join("/"))) return true;
  }
  const segments = relativePath.split("/");
  let parent = root;
  for (let index = 0; index < segments.length; index++) {
    const rules = await readIgnoreRules(parent);
    const candidate = segments.slice(index).join("/");
    if (rules?.ignores(candidate)) return true;
    parent = resolve(parent, segments[index]!);
  }
  return false;
}

function vscodeLanguage(path: string): string | null {
  const extension = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".py": "python",
    ".java": "java",
    ".cs": "csharp"
  };
  return map[extension] ?? bundledLanguageIdForPath(path) ?? null;
}

async function readDocumentOrDisk(absolutePath: string): Promise<string> {
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "file") continue;
    try {
      if (await realpath(document.uri.fsPath) === absolutePath) return document.getText();
    } catch {
      if (resolve(document.uri.fsPath) === absolutePath) return document.getText();
    }
  }
  return readFile(absolutePath, "utf8");
}

function priority(path: string): number {
  const index = PRIORITY.findIndex((pattern) => pattern.test(path));
  return index < 0 ? 10 : index;
}

function selectPrimeFiles(files: readonly InventoryFile[]): InventoryFile[] {
  const selected: InventoryFile[] = [];
  let size = 0;
  for (const file of [...files].sort((a, b) =>
    priority(a.relativePath) - priority(b.relativePath) ||
    a.relativePath.localeCompare(b.relativePath)
  )) {
    if (
      !isTextFile(file.relativePath) &&
      !/^(?:Cargo\.toml|Cargo\.lock|go\.mod|go\.work|package\.json|package-lock\.json)$/.test(basename(file.relativePath))
    ) continue;
    if (size + Buffer.byteLength(file.content) > MAX_PRIME_BYTES) continue;
    selected.push(file);
    size += Buffer.byteLength(file.content);
  }
  return selected;
}

export async function gatherInventory(
  rootPath: string,
  previousSnapshot?: Readonly<Record<string, string>>
): Promise<RepositoryInventory> {
  const root = await realpath(rootPath);
  const paths: string[] = [];
  const limitations: string[] = [];
  const policy = await currentPolicy();
  const visit = async (directory: string): Promise<void> => {
    if (paths.length >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (paths.length >= MAX_FILES) return;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        const rel = canonicalRelative(relative(root, absolutePath));
        if (policy.blockedBy(rel) || await isIgnored(root, rel)) continue;
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = canonicalRelative(relative(root, absolutePath));
      if (
        isSecretOrGenerated(rel) ||
        policy.blockedBy(rel) ||
        isEditorExcluded(root, rel) ||
        !eligiblePath(rel) ||
        await isIgnored(root, rel)
      ) continue;
      paths.push(rel);
    }
  };
  // A restricted repository is not read at all, so nothing from it can reach an overview or context.
  const restricted = await policy.repositoryRestriction(root);
  if (restricted) limitations.push(`No files were read because ${restricted}.`);
  else await visit(root);
  if (paths.length >= MAX_FILES) limitations.push(`Inventory stopped at ${MAX_FILES} eligible files.`);

  const files: InventoryFile[] = [];
  const snapshot: Record<string, string> = {};
  let scannedBytes = 0;
  let readableFiles = 0;
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    if (!isWithin(root, await realpath(absolutePath))) continue;
    const fileStat = await stat(absolutePath);
    const size = fileStat.size;
    const previous = previousSnapshot?.[path];
    if (size > MAX_FILE_BYTES) {
      snapshot[path] = `oversize:${size}:${fileStat.mtimeMs}`;
      continue;
    }
    if (scannedBytes + size > MAX_SNAPSHOT_BYTES || readableFiles >= MAX_READABLE_FILES) {
      snapshot[path] = `unread:${size}:${fileStat.mtimeMs}`;
      continue;
    }
    scannedBytes += size;
    readableFiles++;
    try {
      const content = await readDocumentOrDisk(absolutePath);
      if (content.includes("\0")) {
        snapshot[path] = `binary:${size}`;
        continue;
      }
      const hash = fingerprint(content);
      snapshot[path] = hash;
      files.push({
        relativePath: path,
        absolutePath,
        content,
        hash,
        size: Buffer.byteLength(content, "utf8"),
        languageId: vscodeLanguage(path)
      });
    } catch {
      snapshot[path] = `unreadable:${size}`;
      limitations.push(`Could not read ${path}; it was omitted from context.`);
    }
    if (previous && snapshot[path] === previous) continue;
  }
  if (readableFiles >= MAX_READABLE_FILES || scannedBytes >= MAX_SNAPSHOT_BYTES) {
    limitations.push("Snapshot content was bounded; lower-priority files may not have content fingerprints.");
  }
  const gitHead = await gitHeadFingerprint(root, limitations);
  if (gitHead) snapshot[GIT_HEAD_SNAPSHOT_KEY] = gitHead;

  const selected = selectPrimeFiles(files);
  const primedPaths = selected.map((file) => file.relativePath);
  const inventoryText = selected.map((file) => `--- ${file.relativePath} ---\n${file.content}`).join("\n\n");
  const languageIds = [...new Set(files.map((file) => file.languageId).filter((id): id is string => id !== null))].sort();
  const changedPaths = [...new Set([
    ...Object.keys(previousSnapshot ?? {}),
    ...Object.keys(snapshot)
  ])]
    .filter((path) => previousSnapshot?.[path] !== snapshot[path])
    .map((path) => path === GIT_HEAD_SNAPSHOT_KEY ? GIT_HEAD_CHANGED_LABEL : path);
  return {
    root,
    name: basename(root),
    files,
    snapshot,
    primedPaths,
    inventoryText,
    languageIds,
    limitations,
    changedPaths
  };
}

/** A file or subfolder shown in a folder preview. */
export interface FolderChild {
  readonly kind: "folder" | "file";
  readonly name: string;
  /** Repository-relative path. */
  readonly path: string;
  readonly languageId?: string;
  /** For folders: eligible files inside, at any depth. */
  readonly fileCount?: number;
  /** For folders: true when counting stopped at the walk's limit. */
  readonly countCapped?: boolean;
}

const MAX_WALK_ENTRIES = 20_000;

/**
 * Walks the eligible files under a folder with the scanner's rules (hidden,
 * dependency, and build folders, ignore files, VS Code exclusions, the
 * organization policy, secret-like names, and non-text files are skipped),
 * visiting at most `budget.entries` directory entries.
 */
async function walkEligible(
  root: string,
  relativeFolder: string,
  onFile: (path: string) => void,
  budget: { entries: number },
  policy: Awaited<ReturnType<typeof currentPolicy>>
): Promise<boolean> {
  const visit = async (directory: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (--budget.entries < 0) return false;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      const rel = canonicalRelative(relative(root, absolutePath));
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(entry.name) || policy.blockedBy(rel) || await isIgnored(root, rel)) continue;
        if (!await visit(absolutePath)) return false;
      } else if (
        entry.isFile() &&
        !isSecretOrGenerated(rel) &&
        !policy.blockedBy(rel) &&
        !isEditorExcluded(root, rel) &&
        eligiblePath(rel) &&
        !await isIgnored(root, rel)
      ) {
        onFile(rel);
      }
    }
    return true;
  };
  return visit(resolve(root, relativeFolder));
}

/** Eligible files under a folder, at any depth, in path order; `complete` is false when the walk was cut short. */
export async function listEligibleFiles(
  rootPath: string,
  relativeFolder: string,
  maxEntries = MAX_WALK_ENTRIES
): Promise<{ files: string[]; complete: boolean }> {
  const root = await realpath(rootPath);
  const files: string[] = [];
  const complete = await walkEligible(root, relativeFolder, (path) => files.push(path), { entries: maxEntries }, await currentPolicy());
  return { files, complete };
}

/**
 * The direct children of a folder shown in its preview: subfolders that
 * hold eligible files, with how many, then eligible files. Local only.
 */
export async function listFolder(rootPath: string, relativeFolder: string): Promise<{ children: FolderChild[]; limitations: string[] }> {
  const root = await realpath(rootPath);
  const folder = resolve(root, relativeFolder);
  if (!isWithin(root, folder)) throw new Error("The folder is outside the repository.");
  const policy = await currentPolicy();
  const budget = { entries: MAX_WALK_ENTRIES };
  const folders: FolderChild[] = [];
  const files: FolderChild[] = [];
  let capped = false;
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const rel = canonicalRelative(relative(root, resolve(folder, entry.name)));
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(entry.name) || policy.blockedBy(rel) || await isIgnored(root, rel)) continue;
      let count = 0;
      const complete = await walkEligible(root, rel, () => count++, budget, policy);
      if (!complete) capped = true;
      if (count > 0 || !complete) folders.push({ kind: "folder", name: entry.name, path: rel, fileCount: count, ...(complete ? {} : { countCapped: true }) });
    } else if (
      entry.isFile() &&
      !entry.name.startsWith(".") &&
      !isSecretOrGenerated(rel) &&
      !policy.blockedBy(rel) &&
      !isEditorExcluded(root, rel) &&
      eligiblePath(rel) &&
      !await isIgnored(root, rel)
    ) {
      const languageId = vscodeLanguage(rel);
      files.push({ kind: "file", name: entry.name, path: rel, ...(languageId ? { languageId } : {}) });
    }
  }
  return {
    children: [...folders, ...files],
    limitations: capped ? [`File counts stopped after ${MAX_WALK_ENTRIES.toLocaleString("en")} folder entries; some folders show at least that many files.`] : []
  };
}

export function byteHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isEligibleRelativePath(root: string, path: string): boolean {
  return isWithin(resolve(root), resolve(root, path)) && !isSecretOrGenerated(path) && eligiblePath(path);
}

/**
 * Why a file must not be shared with a provider, or undefined when it may be.
 * Applies the scanner's rules to one file: Git and Copilot ignore files at
 * every level, VS Code file and search exclusions, hidden, dependency, and
 * build folders, secret-like or generated names, and symlinks leaving the
 * repository, `.copilotignore` files in folders above it, and the optional
 * organization exclusion policy (`./policy.ts`). GitHub's server-side Copilot
 * content exclusion is not visible here; mirror it into `.copilotignore` or a
 * policy file to apply it.
 */
export async function sharingExclusion(rootPath: string, filePath: string): Promise<string | undefined> {
  let root: string;
  let file: string;
  try {
    root = await realpath(rootPath);
    file = await realpath(filePath);
  } catch {
    root = resolve(rootPath);
    file = resolve(filePath);
  }
  if (!isWithin(root, file)) return "it is outside the repository";
  const rel = canonicalRelative(relative(root, file));
  const policy = await currentPolicy();
  const restricted = await policy.repositoryRestriction(root);
  if (restricted) return restricted;
  const blocked = policy.blockedBy(rel);
  if (blocked) return `your organization's exclusion policy blocks files matching '${blocked}'`;
  const folders = rel.split("/").slice(0, -1);
  if (folders.some((folder) => ALWAYS_SKIP_DIRS.has(folder))) return "it is in a dependency, build, or vendored folder";
  if (isSecretOrGenerated(rel)) return "it is hidden, secret-like, or generated";
  if (isEditorExcluded(root, rel)) return "VS Code's files.exclude or search.exclude setting excludes it";
  if (await isIgnored(root, rel)) return "a .gitignore or .copilotignore file excludes it";
  return undefined;
}
