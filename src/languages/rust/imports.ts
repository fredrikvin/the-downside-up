import { posix } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { ImportRequest } from "../support";
import { allChildren } from "../treeSitter";
import { withRustSyntaxTree } from "./syntax";

/** The `src` folder of the crate a file belongs to: next to the nearest Cargo.toml above it. */
async function crateSource(folder: string, request: ImportRequest): Promise<string | undefined> {
  for (let directory = folder; ; directory = posix.dirname(directory)) {
    if (await request.readFile(directory === "." ? "Cargo.toml" : `${directory}/Cargo.toml`) !== undefined) {
      return directory === "." ? "src" : `${directory}/src`;
    }
    if (directory === "." || directory === "") return undefined;
  }
}

/** The folder holding a module's child modules: `src/a.rs` keeps them in `src/a/`; `lib.rs`, `main.rs`, and `mod.rs` beside them. */
function childModuleFolder(path: string): string {
  const name = posix.basename(path);
  return ["lib.rs", "main.rs", "mod.rs"].includes(name) ? posix.dirname(path) : path.slice(0, -".rs".length);
}

/** Module files and folders a Rust file declares with `mod` or names with `crate::` paths. */
export async function rustFileImports(request: ImportRequest): Promise<string[]> {
  const parsed = await withRustSyntaxTree(request.text, (root) => {
    const modules: string[] = [];
    const cratePaths: string[] = [];
    const visit = (node: SyntaxNode) => {
      // `mod name;` without a body loads another file.
      if (node.type === "mod_item" && !node.childForFieldName("body")) {
        const name = node.childForFieldName("name")?.text;
        if (name) modules.push(name);
      }
      if (node.type === "scoped_identifier" || node.type === "scoped_use_list" || node.type === "use_declaration") {
        const match = /^crate::([A-Za-z_][A-Za-z0-9_]*)/.exec(node.text.replace(/^use\s+/, "").replace(/^pub(\([^)]*\))?\s+use\s+/, ""));
        if (match) cratePaths.push(match[1]!);
      }
      for (const child of allChildren(node)) visit(child);
    };
    visit(root);
    return { modules, cratePaths };
  });
  if (!parsed) return [];
  const targets = new Set<string>();
  const folder = childModuleFolder(request.path);
  for (const name of parsed.modules) {
    const file = [`${folder}/${name}.rs`, `${folder}/${name}/mod.rs`].find((candidate) => request.hasFile(candidate));
    if (file) targets.add(file);
  }
  if (parsed.cratePaths.length) {
    const source = await crateSource(posix.dirname(request.path), request);
    for (const name of source ? parsed.cratePaths : []) {
      const file = [`${source}/${name}.rs`, `${source}/${name}/mod.rs`].find((candidate) => request.hasFile(candidate));
      if (file) targets.add(file);
    }
  }
  targets.delete(request.path);
  return [...targets];
}
