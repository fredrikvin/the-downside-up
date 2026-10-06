import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(".");
const appCandidates = [
  process.env.VSCODE_EXECUTABLE_PATH,
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
].filter((path) => typeof path === "string" && existsSync(path));
const executable = appCandidates[0];
// A fresh profile per run: the tests add a workspace folder, and a reused
// profile would restore every earlier run's untitled workspace as a window.
const userDataDir = await mkdtemp(join(tmpdir(), "downside-up-test-"));

try {
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : { version: "stable" }),
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, "dist/test/index.js"),
    launchArgs: [
      "--disable-gpu",
      "--disable-workspace-trust",
      `--user-data-dir=${userDataDir}`,
      resolve(root, "fixtures/rust-app")
    ],
    extensionTestsEnv: {
      DSU_PROJECT_ROOT: root
    }
  });
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}
