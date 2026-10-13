import { posix } from "node:path";
import type { ImportRequest } from "../support";
import { importsOf } from "./dependencies";
import { withGoSyntaxTree } from "./syntax";

/** The folder and module path of the nearest go.mod above a folder. */
async function moduleOf(folder: string, request: ImportRequest): Promise<{ dir: string; path: string } | undefined> {
  for (let directory = folder; ; directory = posix.dirname(directory)) {
    const text = await request.readFile(directory === "." ? "go.mod" : `${directory}/go.mod`);
    const path = text ? /^\s*module\s+("?)([^\s"]+)\1/m.exec(text)?.[2] : undefined;
    if (path) return { dir: directory, path };
    if (directory === "." || directory === "") return undefined;
  }
}

/** Package folders inside the same module that a Go file imports. */
export async function goFileImports(request: ImportRequest): Promise<string[]> {
  const imports = (await withGoSyntaxTree(request.text, (root) => importsOf(root).imports)) ?? [];
  const module = imports.length ? await moduleOf(posix.dirname(request.path), request) : undefined;
  if (!module) return [];
  const targets = new Set<string>();
  for (const spec of imports) {
    if (spec.path !== module.path && !spec.path.startsWith(`${module.path}/`)) continue;
    const rest = spec.path.slice(module.path.length + 1);
    targets.add(posix.normalize(posix.join(module.dir, rest || ".")));
  }
  targets.delete(posix.dirname(request.path));
  return [...targets];
}
