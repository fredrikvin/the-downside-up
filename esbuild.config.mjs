import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const rustGrammar = require.resolve("tree-sitter-wasms/out/tree-sitter-rust.wasm");
const treeSitterRuntime = require.resolve("web-tree-sitter/tree-sitter.wasm");

const outdir = resolve("dist");

async function bundle() {
  await mkdir(outdir, { recursive: true });
  await Promise.all([
    copyFile(rustGrammar, resolve(outdir, "tree-sitter-rust.wasm")),
    copyFile(treeSitterRuntime, resolve(outdir, "tree-sitter.wasm"))
  ]);
  await build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: true,
    external: ["vscode", "web-tree-sitter"],
    outfile: resolve(outdir, "extension.js"),
    logLevel: "info"
  });
  await build({
    entryPoints: ["test/extensionHost/runner.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    external: ["vscode", "web-tree-sitter"],
    outfile: resolve(outdir, "test/index.js"),
    logLevel: "info"
  });
}

await bundle();
