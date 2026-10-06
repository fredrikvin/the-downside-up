import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { fingerprint } from "../core/fingerprint";

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
  const extension = extname(relativePath).toLowerCase();
  const file = basename(relativePath);
  return TEXT_EXTENSIONS.has(extension) ||
    file === "Cargo.toml" ||
    file === "Cargo.lock" ||
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

async function isIgnored(root: string, relativePath: string): Promise<boolean> {
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
    ".rs": "rust",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".py": "python",
    ".go": "go",
    ".java": "java",
    ".cs": "csharp"
  };
  return map[extension] ?? null;
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
      !TEXT_EXTENSIONS.has(extname(file.relativePath).toLowerCase()) &&
      !/^(?:Cargo\.toml|Cargo\.lock|package\.json|package-lock\.json)$/.test(basename(file.relativePath))
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
        if (await isIgnored(root, rel)) continue;
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = canonicalRelative(relative(root, absolutePath));
      if (
        isSecretOrGenerated(rel) ||
        isEditorExcluded(root, rel) ||
        !eligiblePath(rel) ||
        await isIgnored(root, rel)
      ) continue;
      paths.push(rel);
    }
  };
  await visit(root);
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

export function byteHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isEligibleRelativePath(root: string, path: string): boolean {
  return isWithin(resolve(root), resolve(root, path)) && !isSecretOrGenerated(path) && eligiblePath(path);
}
