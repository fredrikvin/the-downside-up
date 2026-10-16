import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { fingerprint } from "../core/fingerprint";
import { currentPolicy } from "./policy";
import {
  deploymentFacts,
  folderOutline,
  foldersOf,
  isContainerFile,
  isContractFile,
  isDeploymentFile,
  isGeneratedSource,
  type FolderOutlineEntry
} from "./projectMap";
import { bundledLanguageIdForPath } from "../languages/registry";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_PRIME_BYTES = 64 * 1024;
/** One file's share of the priming inventory; longer files are cut, so a few large ones cannot crowd out the rest. */
const MAX_PRIME_FILE_BYTES = 6 * 1024;
/** The root README introduces the whole project, so it may take more. */
const MAX_PRIME_ROOT_README_BYTES = 12 * 1024;
/** Manifests mostly list dependencies; their start says what a component is. */
const MAX_PRIME_MANIFEST_BYTES = 3 * 1024;
/**
 * Each kind of evidence, by priority, first gets at most this share of the
 * priming budget (root README, manifests, READMEs, contracts, deployment
 * files, architecture notes, entry points), so no kind crowds out the others
 * in a large repository; whatever is left is then filled in priority order.
 */
const PRIME_SHARES = [10, 14, 16, 10, 6, 4, 4].map((kib) => kib * 1024);
/** At most this many evidence files (READMEs, manifests, contracts, deployment files, architecture notes, entry points) are read for priming. */
const MAX_EVIDENCE_FILES = 300;
/** At most this many other files are read to fill what is left of the priming budget. */
const MAX_FILL_FILES = 40;
/** The walk stops after this many directory entries, however few files are eligible. */
const MAX_WALK_DIRECTORY_ENTRIES = 50_000;
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
  ".css", ".scss", ".sql", ".sh", ".gitignore", ".properties",
  ".graphql", ".graphqls", ".gql", ".proto"
]);
/** Source and text files the inventory reads, including every bundled language's files and Dockerfiles. */
const isTextFile = (path: string): boolean =>
  TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || bundledLanguageIdForPath(path) !== undefined || isContainerFile(basename(path));

const MANIFEST = /(?:^|\/)(?:Cargo\.toml|package\.json|pyproject\.toml|go\.mod|pom\.xml|build\.gradle)$/i;
const TEST_FOLDER = /^(?:tests?|__tests__|e2e|testdata|test-?data|api-?tests?|fixtures?|mocks?|examples?|samples?)$/i;

const parentFolder = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * Ranks files by what they say about the project, from names and locations
 * only: the root README, manifests, other READMEs, API contracts,
 * deployment files (reduced to names), architecture notes, and entry points
 * (any `main` file, and `index`, `lib`, `app`, or `server` files only at a
 * component's top or in its `src` folder, not every barrel file); then
 * everything else. Files in test folders rank below that, and generated code
 * last, so neither crowds out the product.
 */
function rankerFor(paths: readonly string[]): (path: string) => number {
  const components = new Set(paths.filter((path) => MANIFEST.test(path)).map(parentFolder));
  const isEntryPoint = (path: string): boolean => {
    const name = basename(path);
    if (/^main\.(?:rs|go|py|java|kt|cs|[cm]?[jt]sx?)$/i.test(name)) return true;
    if (!/^(?:index|lib|app|server)\.(?:rs|py|[cm]?[jt]sx?)$/i.test(name)) return false;
    const folder = parentFolder(path);
    return folder === "" || components.has(folder) || (basename(folder) === "src" && (components.has(parentFolder(folder)) || parentFolder(folder) === ""));
  };
  const tiers: ReadonlyArray<(path: string) => boolean> = [
    (path) => /^README(?:\.[^/]*)?$/i.test(path),
    (path) => MANIFEST.test(path),
    (path) => /(?:^|\/)README(?:\.[^/]*)?$/i.test(path),
    isContractFile,
    (path) => isDeploymentFile(path) || isContainerFile(basename(path)),
    (path) => /(?:^|\/)(?:ARCHITECTURE|CONTRIBUTING|DESIGN)(?:\.[^/]*)?$/i.test(path),
    isEntryPoint
  ];
  const cache = new Map<string, number>();
  return (path) => {
    let rank = cache.get(path);
    if (rank === undefined) {
      if (isGeneratedSource(path)) rank = 30;
      else if (path.split("/").slice(0, -1).some((segment) => TEST_FOLDER.test(segment))) rank = 20;
      else {
        const index = tiers.findIndex((matches) => matches(path));
        rank = index < 0 ? 10 : index;
      }
      cache.set(path, rank);
    }
    return rank;
  };
}

/** Ranks of evidence that priming reads and gives a share of its budget; higher ranks only fill what is left. */
const EVIDENCE_RANKS = PRIME_SHARES.length;

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
  /** Bounded folder outline with component markers, for the project map. */
  readonly outline: FolderOutlineEntry[];
  /** Every folder holding eligible files, for checking folder paths a model returns. */
  readonly folders: ReadonlySet<string>;
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
    isContainerFile(file) ||
    file === ".gitignore" ||
    file === ".copilotignore";
}

function addIgnoreRules(rules: ReturnType<typeof ignore>, path: string, text: string): void {
  text.split(/\r?\n/).forEach((pattern, index) => rules.add({ pattern, mark: `${path}:${index + 1}` }));
}

async function readIgnoreRules(directory: string): Promise<ReturnType<typeof ignore> | undefined> {
  try {
    const [gitIgnore, copilotIgnore] = await Promise.all([
      readFile(resolve(directory, ".gitignore"), "utf8").catch(() => ""),
      readFile(resolve(directory, ".copilotignore"), "utf8").catch(() => "")
    ]);
    const rules = ignore();
    for (const [file, text] of [[".gitignore", gitIgnore], [".copilotignore", copilotIgnore]] as const) {
      addIgnoreRules(rules, resolve(directory, file), text);
    }
    return rules;
  } catch {
    return undefined;
  }
}

function isEditorExcluded(root: string, path: string): boolean {
  return editorExclusion(root, path) !== undefined;
}

function editorExclusion(root: string, path: string): { source: string; rule: string } | undefined {
  const relativePath = path.split(sep).join("/");
  const resource = vscode.Uri.file(root);
  for (const section of ["files", "search"]) {
    const entries = vscode.workspace.getConfiguration(section, resource).get<Record<string, boolean>>("exclude") ?? {};
    const match = Object.entries(entries).find(([pattern, active]) =>
      active &&
      (minimatch(relativePath, pattern, { dot: true }) ||
        (!pattern.includes("/") && minimatch(basename(relativePath), pattern, { dot: true })))
    );
    if (match) return { source: `${section}.exclude`, rule: match[0] };
  }
  return undefined;
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
      if (text !== undefined) {
        const rules = ignore();
        addIgnoreRules(rules, resolve(directory, ".copilotignore"), text);
        found.push({ directory, rules });
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return found;
  })();
  ancestorRulesCache.set(root, { at: Date.now(), value });
  return value;
}

/** Whether ignore files exclude a path; `isDirectory` lets folder-only patterns such as `build/` match it. */
async function isIgnored(root: string, relativePath: string, isDirectory = false): Promise<boolean> {
  return (await ignoredBy(root, relativePath, isDirectory)) !== undefined;
}

async function ignoredBy(root: string, relativePath: string, isDirectory = false): Promise<{ source: string; rule?: string } | undefined> {
  const suffix = isDirectory ? "/" : "";
  for (const { directory, rules } of await ancestorCopilotIgnores(root)) {
    const result = rules.test(relative(directory, resolve(root, relativePath)).split(sep).join("/") + suffix);
    if (result.ignored) return { source: result.rule?.mark ?? resolve(directory, ".copilotignore"), rule: result.rule?.pattern };
  }
  const segments = relativePath.split("/");
  let parent = root;
  for (let index = 0; index < segments.length; index++) {
    const rules = await readIgnoreRules(parent);
    const candidate = segments.slice(index).join("/") + suffix;
    const result = rules?.test(candidate);
    if (result?.ignored) return { source: result.rule?.mark ?? parent, rule: result.rule?.pattern };
    parent = resolve(parent, segments[index]!);
  }
  return undefined;
}

/** Explicit diagnostics must not reuse an earlier parent-ignore decision. */
export function clearSharingExclusionCache(): void {
  ancestorRulesCache.clear();
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

/** Important files first, shallow before deep, so priming covers every part of a large repository. */
function byRank(rank: (path: string) => number): (left: string, right: string) => number {
  return (left, right) =>
    rank(left) - rank(right) ||
    left.split("/").length - right.split("/").length ||
    left.localeCompare(right);
}

/**
 * What priming sends of a file: deployment files only as facts reduced to
 * names, and other files cut at a bounded length.
 */
function primeText(file: InventoryFile, rank: (path: string) => number): string {
  if (isDeploymentFile(file.relativePath)) {
    const facts = deploymentFacts(file.content);
    return facts ? `[Deployment facts; values omitted]\n${facts}` : "";
  }
  const limit = /^README(?:\.[^/]*)?$/i.test(file.relativePath)
    ? MAX_PRIME_ROOT_README_BYTES
    : rank(file.relativePath) === 1 ? MAX_PRIME_MANIFEST_BYTES : MAX_PRIME_FILE_BYTES;
  if (Buffer.byteLength(file.content, "utf8") <= limit) return file.content;
  return `${Buffer.from(file.content, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD+$/, "")}\n[… cut to fit the priming budget]`;
}

function selectPrimeFiles(files: readonly InventoryFile[], rank: (path: string) => number): Array<{ file: InventoryFile; text: string }> {
  const order = byRank(rank);
  const candidates = [...files]
    .sort((a, b) => order(a.relativePath, b.relativePath))
    .filter((file) =>
      rank(file.relativePath) < 30 && (
        isTextFile(file.relativePath) ||
        /^(?:Cargo\.toml|Cargo\.lock|go\.mod|go\.work|package\.json|package-lock\.json)$/.test(basename(file.relativePath))))
    .map((file) => ({ file, text: primeText(file, rank), tier: rank(file.relativePath) }))
    .filter((candidate) => candidate.text);
  const chosen = new Set<(typeof candidates)[number]>();
  const used = new Map<number, number>();
  let size = 0;
  const take = (candidate: (typeof candidates)[number]) => {
    const bytes = Buffer.byteLength(candidate.text);
    chosen.add(candidate);
    used.set(candidate.tier, (used.get(candidate.tier) ?? 0) + bytes);
    size += bytes;
  };
  for (const candidate of candidates) {
    const share = PRIME_SHARES[candidate.tier];
    const bytes = Buffer.byteLength(candidate.text);
    if (share !== undefined && (used.get(candidate.tier) ?? 0) + bytes <= share && size + bytes <= MAX_PRIME_BYTES) take(candidate);
  }
  for (const candidate of candidates) {
    if (!chosen.has(candidate) && size + Buffer.byteLength(candidate.text) <= MAX_PRIME_BYTES) take(candidate);
  }
  return candidates.filter((candidate) => chosen.has(candidate)).map(({ file, text }) => ({ file, text }));
}

export async function gatherInventory(
  rootPath: string,
  previousSnapshot?: Readonly<Record<string, string>>
): Promise<RepositoryInventory> {
  const root = await realpath(rootPath);
  const paths: string[] = [];
  const limitations: string[] = [];
  const policy = await currentPolicy();
  // Breadth-first, so when the file limit is reached every area of the
  // repository is listed at its top levels rather than only the first folders
  // in alphabetical order.
  const walk = async (): Promise<void> => {
    const queue = [root];
    let entriesLeft = MAX_WALK_DIRECTORY_ENTRIES;
    for (let next = 0; next < queue.length && paths.length < MAX_FILES; next++) {
      let entries;
      try {
        entries = await readdir(queue[next]!, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (paths.length >= MAX_FILES) return;
        if (--entriesLeft < 0) {
          limitations.push(`Inventory stopped after ${MAX_WALK_DIRECTORY_ENTRIES.toLocaleString("en")} folder entries.`);
          return;
        }
        const absolutePath = resolve(queue[next]!, entry.name);
        if (entry.isSymbolicLink()) continue;
        const rel = canonicalRelative(relative(root, absolutePath));
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(entry.name)) continue;
          if (policy.blockedBy(rel) || await isIgnored(root, rel, true)) continue;
          queue.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (
          isSecretOrGenerated(rel) ||
          policy.blockedBy(rel) ||
          isEditorExcluded(root, rel) ||
          !eligiblePath(rel) ||
          await isIgnored(root, rel)
        ) continue;
        paths.push(rel);
      }
    }
  };
  // A restricted repository is not read at all, so nothing from it can reach an overview or context.
  const restricted = await policy.repositoryRestriction(root);
  if (restricted) limitations.push(`No files were read because ${restricted}.`);
  else await walk();
  if (paths.length >= MAX_FILES) limitations.push(`Inventory stopped at ${MAX_FILES} eligible files.`);

  // Only what priming may send is read: evidence files, then other files while
  // the priming budget has room. Every other file is tracked by size and
  // modification time, and explanations read the files they need themselves.
  const rank = rankerFor(paths);
  const ranked = [...paths].sort(byRank(rank));
  const files: InventoryFile[] = [];
  const snapshot: Record<string, string> = {};
  let scannedBytes = 0;
  let evidenceFiles = 0;
  let fillFiles = 0;
  let fillBudget: number | undefined;
  let bounded = false;
  for (const path of ranked) {
    const absolutePath = resolve(root, path);
    if (!isWithin(root, await realpath(absolutePath))) continue;
    const fileStat = await stat(absolutePath);
    const size = fileStat.size;
    if (size > MAX_FILE_BYTES) {
      snapshot[path] = `oversize:${size}:${fileStat.mtimeMs}`;
      continue;
    }
    const tier = rank(path);
    if (tier >= EVIDENCE_RANKS && fillBudget === undefined) {
      // Evidence is read; what priming would leave unused is filled with other files.
      const used = selectPrimeFiles(files, rank).reduce((total, { text }) => total + Buffer.byteLength(text), 0);
      fillBudget = MAX_PRIME_BYTES - used;
    }
    const wanted = tier < EVIDENCE_RANKS
      ? evidenceFiles < MAX_EVIDENCE_FILES
      : tier < 20 && fillBudget! > 0 && fillFiles < MAX_FILL_FILES;
    if (!wanted || scannedBytes + size > MAX_SNAPSHOT_BYTES) {
      if (tier < EVIDENCE_RANKS || (tier < 20 && fillBudget! > 0)) bounded = true;
      snapshot[path] = `unread:${size}:${fileStat.mtimeMs}`;
      continue;
    }
    scannedBytes += size;
    if (tier < EVIDENCE_RANKS) evidenceFiles++;
    else fillFiles++;
    try {
      const content = await readDocumentOrDisk(absolutePath);
      if (content.includes("\0")) {
        snapshot[path] = `binary:${size}`;
        continue;
      }
      const hash = fingerprint(content);
      snapshot[path] = hash;
      const file: InventoryFile = {
        relativePath: path,
        absolutePath,
        content,
        hash,
        size: Buffer.byteLength(content, "utf8"),
        languageId: vscodeLanguage(path)
      };
      files.push(file);
      if (tier >= EVIDENCE_RANKS) fillBudget! -= Buffer.byteLength(primeText(file, rank));
    } catch {
      snapshot[path] = `unreadable:${size}`;
      limitations.push(`Could not read ${path}; it was omitted from context.`);
    }
  }
  if (bounded) {
    limitations.push("Priming read was bounded; some lower-priority files were not read for the repository overview.");
  }
  const gitHead = await gitHeadFingerprint(root, limitations);
  if (gitHead) snapshot[GIT_HEAD_SNAPSHOT_KEY] = gitHead;

  const selected = selectPrimeFiles(files, rank);
  const primedPaths = selected.map(({ file }) => file.relativePath);
  const inventoryText = selected.map(({ file, text }) => `--- ${file.relativePath} ---\n${text}`).join("\n\n");
  const languageIds = [...new Set(paths.map(vscodeLanguage).filter((id): id is string => id !== null))].sort();
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
    changedPaths,
    outline: folderOutline(paths),
    folders: foldersOf(paths)
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
        if (entry.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(entry.name) || policy.blockedBy(rel) || await isIgnored(root, rel, true)) continue;
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

/**
 * Why a folder may not be previewed or walked, or undefined when it may:
 * its real path must stay in the repository (no symlinks out), and no folder
 * on its path may be hidden, a dependency or build folder, blocked by the
 * organization policy, or ignored.
 */
export async function folderExclusion(root: string, relativeFolder: string): Promise<string | undefined> {
  const folder = resolve(root, relativeFolder);
  if (!isWithin(root, folder)) return "it is outside the repository";
  let real: string;
  try {
    real = await realpath(folder);
  } catch {
    return "it cannot be read";
  }
  if (!isWithin(root, real) || canonicalRelative(relative(root, real)) !== canonicalRelative(relative(root, folder))) {
    return "it is a link to another location";
  }
  const policy = await currentPolicy();
  const segments = relativeFolder ? relativeFolder.split("/") : [];
  for (let index = 0; index < segments.length; index++) {
    const name = segments[index]!;
    const path = segments.slice(0, index + 1).join("/");
    if (name.startsWith(".") || ALWAYS_SKIP_DIRS.has(name)) return "it is a hidden, dependency, build, or vendored folder";
    if (policy.blockedBy(path)) return "your organization's exclusion policy blocks it";
    if (await isIgnored(root, path, true)) return "a .gitignore or .copilotignore file excludes it";
  }
  return undefined;
}

/** Eligible files under a folder, at any depth, in path order; `complete` is false when the walk was cut short. */
export async function listEligibleFiles(
  rootPath: string,
  relativeFolder: string,
  maxEntries = MAX_WALK_ENTRIES
): Promise<{ files: string[]; complete: boolean }> {
  const root = await realpath(rootPath);
  if (await folderExclusion(root, relativeFolder)) return { files: [], complete: true };
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
  const excluded = await folderExclusion(root, relativeFolder);
  if (excluded) throw new Error(`This folder is not previewed because ${excluded}.`);
  const policy = await currentPolicy();
  const budget = { entries: MAX_WALK_ENTRIES };
  const folders: FolderChild[] = [];
  const files: FolderChild[] = [];
  let capped = false;
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const rel = canonicalRelative(relative(root, resolve(folder, entry.name)));
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || ALWAYS_SKIP_DIRS.has(entry.name) || policy.blockedBy(rel) || await isIgnored(root, rel, true)) continue;
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
  return (await sharingExclusionReport(rootPath, filePath))?.reason;
}

export interface SharingExclusionReport {
  readonly reason: string;
  readonly source: string;
  readonly rule?: string;
}

/** The same decision used before generation, with provenance for local diagnostics. */
export async function sharingExclusionReport(rootPath: string, filePath: string): Promise<SharingExclusionReport | undefined> {
  let root: string;
  let file: string;
  try {
    root = await realpath(rootPath);
    file = await realpath(filePath);
  } catch {
    root = resolve(rootPath);
    file = resolve(filePath);
  }
  if (!isWithin(root, file)) return { reason: "it is outside the repository", source: "Repository boundary" };
  const rel = canonicalRelative(relative(root, file));
  const policy = await currentPolicy();
  const restricted = await policy.repositoryRestriction(root);
  if (restricted) return { reason: restricted, source: "Restricted remotes policy" };
  const blocked = policy.blockedBy(rel);
  if (blocked) return { reason: `your organization's exclusion policy blocks files matching '${blocked}'`, source: "Blocked file patterns policy", rule: blocked };
  const folders = rel.split("/").slice(0, -1);
  if (folders.some((folder) => ALWAYS_SKIP_DIRS.has(folder))) return { reason: "it is in a dependency, build, or vendored folder", source: "Built-in safeguards" };
  if (isSecretOrGenerated(rel)) return { reason: "it is hidden, secret-like, or generated", source: "Built-in safeguards" };
  const editor = editorExclusion(root, rel);
  if (editor) return { reason: "VS Code's files.exclude or search.exclude setting excludes it", ...editor };
  const ignored = await ignoredBy(root, rel);
  if (ignored) return { reason: "a .gitignore or .copilotignore file excludes it", ...ignored };
  return undefined;
}
