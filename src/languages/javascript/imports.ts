import { posix } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { ImportRequest } from "../support";
import { namedChildren } from "../treeSitter";
import { withJavaScriptSyntaxTree } from "./syntax";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** TypeScript projects import `./a.js` for the file `./a.ts`. */
const COMPILED_TO_SOURCE: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"]
};

/** Module specifiers in import and re-export statements, `require(...)`, and `import(...)`. */
export function moduleSpecifiers(root: SyntaxNode): string[] {
  const found: string[] = [];
  const text = (node: SyntaxNode | null | undefined) =>
    node && node.type === "string" ? node.text.slice(1, -1) : undefined;
  const visit = (node: SyntaxNode) => {
    if (node.type === "import_statement" || node.type === "export_statement") {
      const source = text(node.childForFieldName("source"));
      if (source) found.push(source);
    } else if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const argument = namedChildren(node.childForFieldName("arguments") ?? node)[0];
      if ((callee?.type === "import" || callee?.text === "require") && argument) {
        const source = text(argument);
        if (source) found.push(source);
      }
    }
    for (const child of namedChildren(node)) visit(child);
  };
  visit(root);
  return found;
}

/** Strips comments and trailing commas so a tsconfig.json can be parsed as JSON. */
function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? "");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}

interface PathAliases {
  /** Repository-relative folder the aliases resolve from. */
  readonly base: string;
  readonly paths: ReadonlyArray<readonly [string, readonly string[]]>;
}

/** The nearest tsconfig.json or jsconfig.json with `paths`, searching up from a folder. */
async function aliasesFor(folder: string, request: ImportRequest): Promise<PathAliases | undefined> {
  for (let directory = folder; ; directory = posix.dirname(directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const file = directory === "." ? name : `${directory}/${name}`;
      const text = await request.readFile(file);
      if (text === undefined) continue;
      try {
        const options = (parseJsonc(text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
        if (options?.paths) {
          return {
            base: posix.normalize(posix.join(directory, options.baseUrl ?? ".")),
            paths: Object.entries(options.paths).filter(([, targets]) => Array.isArray(targets))
          };
        }
      } catch {
        // An unreadable tsconfig adds no aliases.
      }
    }
    if (directory === "." || directory === "") return undefined;
  }
}

function resolveFile(base: string, request: ImportRequest): string | undefined {
  if (base.startsWith("..")) return undefined;
  const extension = posix.extname(base);
  const candidates = [
    base,
    ...(COMPILED_TO_SOURCE[extension] ?? []).map((source) => base.slice(0, -extension.length) + source),
    ...EXTENSIONS.map((candidate) => base + candidate),
    ...EXTENSIONS.map((candidate) => `${base}/index${candidate}`)
  ];
  return candidates.find((candidate) => request.hasFile(candidate));
}

/** Files a JavaScript or TypeScript file imports by relative path or tsconfig path alias. */
export async function javascriptFileImports(request: ImportRequest): Promise<string[]> {
  const specifiers = (await withJavaScriptSyntaxTree(request.text, request.path, moduleSpecifiers)) ?? [];
  const folder = posix.dirname(request.path);
  let aliases: PathAliases | undefined | null = null;
  const targets = new Set<string>();
  for (const specifier of specifiers) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const resolved = resolveFile(posix.normalize(posix.join(folder, specifier)), request);
      if (resolved) targets.add(resolved);
      continue;
    }
    aliases ??= await aliasesFor(folder, request);
    for (const [pattern, replacements] of aliases?.paths ?? []) {
      const star = pattern.indexOf("*");
      const matches = star < 0 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
      if (!matches) continue;
      const captured = star < 0 ? "" : specifier.slice(star, specifier.length - (pattern.length - star - 1));
      const resolved = replacements
        .map((replacement) => resolveFile(posix.normalize(posix.join(aliases!.base, replacement.replace("*", captured))), request))
        .find(Boolean);
      if (resolved) {
        targets.add(resolved);
        break;
      }
    }
  }
  targets.delete(request.path);
  return [...targets];
}
