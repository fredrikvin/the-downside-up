import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import * as vscode from "vscode";

/**
 * An optional organization exclusion policy, read from plain-text files
 * named in user settings, one entry per line with `#` comments. Some
 * organizations already keep files like these for their Copilot hook
 * scripts, so they can be used as they are:
 *
 * - blocked file patterns: gitignore-style patterns for files that are never
 *   shared, in any repository;
 * - restricted remotes: remote URL prefixes (`*` matches anything) whose
 *   repositories are shared only after opting in with a `.copilotignore` (at
 *   the repository root or a folder above it) or a `.allowed-services` file
 *   naming `copilot` at the Git root;
 * - allowed repositories: repository paths (`*` matches one path segment)
 *   that may be shared without opting in.
 *
 * A setting that is empty, or names a file that cannot be read, adds nothing.
 */
export interface PolicySettings {
  readonly blockedFilePatternsFile: string;
  readonly restrictedRemotesFile: string;
  readonly allowedRepositoriesFile: string;
}

const SETTING_KEYS: Record<keyof PolicySettings, string> = {
  blockedFilePatternsFile: "exclusion.blockedFilePatternsFile",
  restrictedRemotesFile: "exclusion.restrictedRemotesFile",
  allowedRepositoriesFile: "exclusion.allowedRepositoriesFile"
};

/** Reads the policy settings from user settings only, so a repository cannot loosen them. */
export function policySettings(): PolicySettings {
  const configuration = vscode.workspace.getConfiguration("downsideUp");
  const read = (key: string) => {
    const value = configuration.inspect<string>(key)?.globalValue;
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    blockedFilePatternsFile: read(SETTING_KEYS.blockedFilePatternsFile),
    restrictedRemotesFile: read(SETTING_KEYS.restrictedRemotesFile),
    allowedRepositoriesFile: read(SETTING_KEYS.allowedRepositoriesFile)
  };
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

const linesCache = new Map<string, { mtimeMs: number; lines: string[] }>();

export interface PolicyFileReport {
  readonly setting: keyof PolicySettings;
  readonly path?: string;
  readonly status: "not configured" | "loaded" | "missing" | "unreadable";
  readonly error?: string;
  readonly entries: readonly { line: number; text: string; active: boolean }[];
}

function parsedPolicyLines(text: string): Array<{ line: number; text: string; active: boolean }> {
  return text.split(/\r?\n/).map((text, index) => ({
    line: index + 1, text: text.trim(), active: Boolean(text.trim()) && !text.trim().startsWith("#")
  }));
}

/** Fresh, local diagnostics using exactly the parser used by enforcement. */
export async function policyFileReports(): Promise<PolicyFileReport[]> {
  clearPolicyCache();
  const settings = policySettings();
  return Promise.all((Object.keys(SETTING_KEYS) as Array<keyof PolicySettings>).map(async (setting) => {
    if (!settings[setting]) return { setting, status: "not configured", entries: [] };
    const path = expandHome(settings[setting]);
    try {
      const text = await readFile(path, "utf8");
      return { setting, path, status: "loaded", entries: parsedPolicyLines(text) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      return { setting, path, status: code === "ENOENT" ? "missing" : "unreadable",
        error: error instanceof Error ? error.message : String(error), entries: [] };
    }
  }));
}

/** Non-empty, non-comment lines of a policy file, or none when it cannot be read. */
async function policyLines(path: string): Promise<string[]> {
  if (!path) return [];
  const file = expandHome(path);
  try {
    const { mtimeMs } = await stat(file);
    const cached = linesCache.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.lines;
    const lines = parsedPolicyLines(await readFile(file, "utf8")).filter((entry) => entry.active).map((entry) => entry.text);
    linesCache.set(file, { mtimeMs, lines });
    return lines;
  } catch {
    return [];
  }
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/**
 * Converts a gitignore-style pattern to a regular expression, as the hooks
 * do: a pattern containing a slash is anchored at the start of the path,
 * others match at any depth, and a match on a folder covers its contents.
 */
export function globToRegex(pattern: string): RegExp {
  let source = pattern.replace(/\/$/, "");
  const anchored = source.startsWith("/") || source.includes("/");
  source = source.replace(/^\//, "");
  let body = "";
  for (let index = 0; index < source.length; index++) {
    const rest = source.slice(index);
    if (rest.startsWith("**/")) {
      body += "(.+/)?";
      index += 2;
    } else if (rest.startsWith("**")) {
      body += ".*";
      index += 1;
    } else if (source[index] === "*") {
      body += "[^/]*";
    } else if (source[index] === "?") {
      body += "[^/]";
    } else if (source[index] === "[" && source.indexOf("]", index + 1) > index) {
      const end = source.indexOf("]", index + 1);
      const inner = source.slice(index + 1, end);
      body += `[${inner.startsWith("!") ? `^${inner.slice(1)}` : inner}]`;
      index = end;
    } else {
      body += escapeRegex(source[index]!);
    }
  }
  return new RegExp(anchored ? `^${body}(/.*)?$` : `(^|/)${body}(/.*)?$`);
}

/** A remote URL prefix pattern: `*` matches anything, and a trailing `*` is implied. */
export function remotePatternToRegex(pattern: string): RegExp {
  const glob = pattern.endsWith("*") ? pattern : `${pattern}*`;
  return new RegExp(`^${[...glob].map((char) => (char === "*" ? ".*" : char === "?" ? "." : escapeRegex(char))).join("")}$`);
}

/** The repository path of a remote URL: `ssh://user@host:29418/team/repo.git` gives `team/repo`. */
export function repositoryPathOfRemote(url: string): string {
  let path = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url;
  if (path.includes("@")) path = path.slice(path.indexOf("@") + 1);
  path = path.includes("/") ? path.slice(path.indexOf("/") + 1) : "";
  return path.replace(/\.git$/, "");
}

/** A repository path pattern: `*` matches one path segment, and the whole path must match. */
export function repositoryPatternToRegex(pattern: string): RegExp {
  return new RegExp(`^${[...pattern].map((char) => (char === "*" ? "[^/]*" : escapeRegex(char))).join("")}$`);
}

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolveOutput(stdout);
    });
  });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isFile(), () => false);
}

/** `.copilotignore` files in `root` and the folders above it. */
async function copilotIgnoreAtOrAbove(root: string): Promise<string | undefined> {
  let directory = resolve(root);
  for (;;) {
    if (await exists(resolve(directory, ".copilotignore"))) return resolve(directory, ".copilotignore");
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export interface ExclusionPolicy {
  /** The blocked-file pattern a repository-relative path matches, if any. */
  blockedBy(relativePath: string): string | undefined;
  /** Why the whole repository may not be shared, or undefined when it may be. */
  repositoryRestriction(root: string): Promise<string | undefined>;
  repositoryReport(root: string): Promise<RepositoryPolicyReport>;
}

export interface RepositoryPolicyReport {
  readonly restricted: boolean;
  readonly matchedRule?: string;
  readonly exception?: string;
  readonly error?: string;
}

const restrictionCache = new Map<string, { at: number; key: string; value: Promise<string | undefined> }>();
const RESTRICTION_CACHE_MS = 10_000;

async function repositoryReport(root: string, restricted: readonly { pattern: string; regex: RegExp }[], allowed: readonly { pattern: string; regex: RegExp }[]): Promise<RepositoryPolicyReport> {
  let remoteOutput: string;
  try {
    remoteOutput = await git(root, ["remote", "-v"]);
  } catch {
    return { restricted: false, error: "Git remotes could not be inspected; remote policy could not be verified." };
  }
  const urls = [...new Set(remoteOutput
    .split("\n")
    .map((line) => line.split(/\s+/)[1])
    .filter((url): url is string => Boolean(url)))];
  const matchedRule = restricted.find(({ regex }) => urls.some((url) => regex.test(url)))?.pattern;
  if (!matchedRule) return { restricted: false };
  const optIn = await copilotIgnoreAtOrAbove(root);
  if (optIn) return { restricted: false, matchedRule, exception: `${optIn} exists (its file exclusions still apply)` };
  const top = (await git(root, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (top) {
    const services = await readFile(resolve(top, ".allowed-services"), "utf8").catch(() => "");
    if (/\bcopilot\b/i.test(services)) return { restricted: false, matchedRule, exception: `${resolve(top, ".allowed-services")} names copilot` };
  }
  const allowedRule = allowed.find(({ regex }) => urls.some((url) => regex.test(repositoryPathOfRemote(url))))?.pattern;
  if (allowedRule) return { restricted: false, matchedRule, exception: `Allowed-repositories rule: ${allowedRule}` };
  return { restricted: true, matchedRule };
}

/** The current policy from user settings; with no settings, it excludes nothing. */
export async function currentPolicy(): Promise<ExclusionPolicy> {
  const settings = policySettings();
  const [blocked, restricted, allowed] = await Promise.all([
    policyLines(settings.blockedFilePatternsFile),
    policyLines(settings.restrictedRemotesFile),
    policyLines(settings.allowedRepositoriesFile)
  ]);
  const blockedPatterns = blocked.map((pattern) => ({ pattern, regex: globToRegex(pattern) }));
  const restrictedPatterns = restricted.map((pattern) => ({ pattern, regex: remotePatternToRegex(pattern) }));
  const allowedPatterns = allowed.map((pattern) => ({ pattern, regex: repositoryPatternToRegex(pattern) }));
  const key = JSON.stringify([restricted, allowed]);
  return {
    blockedBy: (relativePath) => blockedPatterns.find(({ regex }) => regex.test(relativePath))?.pattern,
    repositoryReport: (root) => restrictedPatterns.length ? repositoryReport(root, restrictedPatterns, allowedPatterns) : Promise.resolve({ restricted: false }),
    repositoryRestriction(root) {
      if (restrictedPatterns.length === 0) return Promise.resolve(undefined);
      const cached = restrictionCache.get(root);
      if (cached && cached.key === key && Date.now() - cached.at < RESTRICTION_CACHE_MS) return cached.value;
      const value = repositoryReport(root, restrictedPatterns, allowedPatterns).then((report) => report.restricted
        ? "your organization's exclusion policy restricts this repository: it has no .copilotignore or .allowed-services file allowing Copilot"
        : undefined);
      restrictionCache.set(root, { at: Date.now(), key, value });
      return value;
    }
  };
}

/** Forgets cached repository decisions, for example after a policy file or `.copilotignore` changes. */
export function clearPolicyCache(): void {
  restrictionCache.clear();
  linesCache.clear();
}
