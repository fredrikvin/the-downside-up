import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherInventory, sharingExclusion } from "../src/context/inventory";
import {
  clearPolicyCache,
  currentPolicy,
  globToRegex,
  policyFileReports,
  remotePatternToRegex,
  repositoryPathOfRemote,
  repositoryPatternToRegex
} from "../src/context/policy";
import { workspace } from "./vscode";

describe("policy patterns", () => {
  it("matches blocked file patterns like gitignore, at any depth unless they contain a slash", () => {
    const matches = (pattern: string, path: string) => globToRegex(pattern).test(path);
    expect(matches("settings.local", "settings.local")).toBe(true);
    expect(matches("settings.local", "config/settings.local")).toBe(true);
    expect(matches("settings.local", "config/settings.localx")).toBe(false);
    expect(matches("*.vault", "tls/server.vault")).toBe(true);
    expect(matches(".cloud*", ".cloud-config/foo")).toBe(true);
    expect(matches("deploy*.yml", "infra/deploy-prod.yml")).toBe(true);
    expect(matches("*.tokenrc*", "ci.tokenrc.bak")).toBe(true);
    expect(matches("build-workdir", "out/build-workdir/recipe/file.c")).toBe(true);
    expect(matches("docs/private", "docs/private/plan.md")).toBe(true);
    expect(matches("docs/private", "other/docs/private/plan.md")).toBe(false);
    expect(matches("**/generated/*.ts", "a/b/generated/x.ts")).toBe(true);
    expect(matches("file[0-9].txt", "file7.txt")).toBe(true);
  });

  it("matches remotes by prefix and repositories by path segments", () => {
    expect(remotePatternToRegex("ssh://git.example.com/").test("ssh://git.example.com/team/app")).toBe(true);
    expect(remotePatternToRegex("https://*.example.com/*").test("https://git.eu.example.com/team/app.git")).toBe(true);
    expect(remotePatternToRegex("ssh://git.example.com/").test("https://github.com/team/app.git")).toBe(false);
    expect(repositoryPathOfRemote("ssh://user@git.example.com:29418/team/app.git")).toBe("team/app");
    expect(repositoryPathOfRemote("https://git.example.com/project.git")).toBe("project");
    expect(repositoryPatternToRegex("team/*").test("team/app")).toBe(true);
    expect(repositoryPatternToRegex("team/*").test("team/app/sub")).toBe(false);
  });
});

describe("organization exclusion policy", () => {
  let base: string;
  let repo: string;
  let policyDir: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const setting = (key: string, value: string, scope: "user" | "workspace" = "user") =>
    workspace.__setConfiguration(`${scope === "workspace" ? "workspace:" : ""}downsideUp.exclusion.${key}`, value);
  const exclusion = (path: string) => {
    clearPolicyCache();
    return sharingExclusion(repo, resolve(repo, path));
  };

  beforeEach(async () => {
    workspace.__resetConfiguration();
    base = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-policy-")));
    repo = resolve(base, "app");
    policyDir = resolve(base, "policy");
    await mkdir(resolve(repo, "src"), { recursive: true });
    await mkdir(resolve(repo, "infra"), { recursive: true });
    await mkdir(policyDir);
    await writeFile(resolve(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await writeFile(resolve(repo, "infra/deploy-prod.yml"), "config: value\n");
    await writeFile(resolve(repo, "README.md"), "# App\n");
    git("init", "-q");
    git("remote", "add", "origin", "ssh://git.example.com/team/app.git");
    await writeFile(resolve(policyDir, "blocked.conf"), "# Deployment settings\ndeploy*.yml\n*.vault\n");
    await writeFile(resolve(policyDir, "restricted.conf"), "ssh://git.example.com/\n");
    await writeFile(resolve(policyDir, "allowed.conf"), "other/*\n");
  });

  afterEach(async () => {
    workspace.__resetConfiguration();
    clearPolicyCache();
    await rm(base, { recursive: true, force: true });
  });

  it("changes nothing without settings", async () => {
    expect(await exclusion("src/a.ts")).toBeUndefined();
    expect(await exclusion("infra/deploy-prod.yml")).toBeUndefined();
  });

  it("reports fresh load failures, empty files, original lines, and the enforcement parser", async () => {
    const unconfigured = await policyFileReports();
    expect(unconfigured.every((report) => report.status === "not configured")).toBe(true);
    const path = resolve(policyDir, "blocked.conf");
    setting("blockedFilePatternsFile", path);
    await writeFile(path, " # comment\r\n\r\n  deploy*.yml  \r\n*.vault\r\n");
    const [blocked] = await policyFileReports();
    expect(blocked).toMatchObject({ path, status: "loaded" });
    expect(blocked!.entries).toEqual([
      { line: 1, text: "# comment", active: false },
      { line: 2, text: "", active: false },
      { line: 3, text: "deploy*.yml", active: true },
      { line: 4, text: "*.vault", active: true },
      { line: 5, text: "", active: false }
    ]);
    expect((await currentPolicy()).blockedBy("infra/deploy-prod.yml")).toBe("deploy*.yml");
    await writeFile(path, "");
    expect((await policyFileReports())[0]).toMatchObject({ status: "loaded" });
    expect((await currentPolicy()).blockedBy("infra/deploy-prod.yml")).toBeUndefined();
    await rm(path);
    expect((await policyFileReports())[0]).toMatchObject({ status: "missing", entries: [] });
    setting("blockedFilePatternsFile", policyDir);
    expect((await policyFileReports())[0]).toMatchObject({ status: "unreadable", entries: [] });
    expect((await currentPolicy()).blockedBy("infra/deploy-prod.yml")).toBeUndefined();
  });

  it("explains remote restrictions and each existing exception without exposing remote credentials", async () => {
    setting("restrictedRemotesFile", resolve(policyDir, "restricted.conf"));
    setting("allowedRepositoriesFile", resolve(policyDir, "allowed.conf"));
    const report = () => currentPolicy().then((policy) => policy.repositoryReport(repo));
    expect(await report()).toEqual({ restricted: true, matchedRule: "ssh://git.example.com/" });
    await writeFile(resolve(repo, ".allowed-services"), "copilot\n");
    expect(await report()).toMatchObject({ restricted: false, exception: expect.stringContaining(".allowed-services") });
    await rm(resolve(repo, ".allowed-services"));
    await writeFile(resolve(base, ".copilotignore"), "");
    expect(await report()).toMatchObject({ restricted: false, exception: expect.stringContaining(".copilotignore") });
    await rm(resolve(base, ".copilotignore"));
    await writeFile(resolve(policyDir, "allowed.conf"), "team/*\n");
    await policyFileReports();
    expect(await report()).toMatchObject({ restricted: false, exception: "Allowed-repositories rule: team/*" });
    git("remote", "set-url", "origin", "https://github.com/team/app.git");
    expect(await report()).toEqual({ restricted: false });
    expect(await (await currentPolicy()).repositoryReport(policyDir)).toMatchObject({ error: expect.stringContaining("could not be inspected") });
  });

  it("never shares files matching blocked patterns, in the scan or as the explained file", async () => {
    setting("blockedFilePatternsFile", resolve(policyDir, "blocked.conf"));
    expect(await exclusion("infra/deploy-prod.yml")).toBe("your organization's exclusion policy blocks files matching 'deploy*.yml'");
    expect(await exclusion("src/a.ts")).toBeUndefined();
    clearPolicyCache();
    const inventory = await gatherInventory(repo);
    expect(inventory.files.map((file) => file.relativePath)).toEqual(["README.md", "src/a.ts"]);
  });

  it("restricts repositories with a listed remote until they opt in", async () => {
    setting("restrictedRemotesFile", resolve(policyDir, "restricted.conf"));
    setting("allowedRepositoriesFile", resolve(policyDir, "allowed.conf"));
    expect(await exclusion("src/a.ts")).toMatch(/restricts this repository/);
    clearPolicyCache();
    const inventory = await gatherInventory(repo);
    expect(inventory.files).toEqual([]);
    expect(inventory.limitations.join(" ")).toMatch(/No files were read because .*restricts this repository/);

    await writeFile(resolve(repo, ".allowed-services"), "jira\ncopilot\n");
    expect(await exclusion("src/a.ts")).toBeUndefined();
    await rm(resolve(repo, ".allowed-services"));

    await writeFile(resolve(repo, ".copilotignore"), "");
    expect(await exclusion("src/a.ts")).toBeUndefined();
    await rm(resolve(repo, ".copilotignore"));

    await writeFile(resolve(policyDir, "allowed.conf"), "team/*\n");
    expect(await exclusion("src/a.ts")).toBeUndefined();
    await writeFile(resolve(policyDir, "allowed.conf"), "other/*\n");

    git("remote", "set-url", "origin", "https://github.com/team/app.git");
    expect(await exclusion("src/a.ts")).toBeUndefined();
  });

  it("ignores policy settings from the workspace, so a repository cannot change them", async () => {
    setting("blockedFilePatternsFile", resolve(policyDir, "blocked.conf"));
    setting("blockedFilePatternsFile", "", "workspace");
    expect(await exclusion("infra/deploy-prod.yml")).toMatch(/blocks files matching/);
    workspace.__resetConfiguration();
    setting("restrictedRemotesFile", resolve(policyDir, "restricted.conf"), "workspace");
    expect(await exclusion("src/a.ts")).toBeUndefined();
  });

  it("applies .copilotignore files in folders above the repository", async () => {
    await writeFile(resolve(base, ".copilotignore"), "app/src/a.ts\n");
    expect(await sharingExclusion(repo, resolve(repo, "src/a.ts"))).toBe("a .gitignore or .copilotignore file excludes it");
    expect(await sharingExclusion(repo, resolve(repo, "README.md"))).toBeUndefined();
  });
});
