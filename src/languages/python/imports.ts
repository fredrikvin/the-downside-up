import { posix } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { ImportRequest } from "../support";
import { namedChildren } from "../treeSitter";
import { withPythonSyntaxTree } from "./syntax";

export interface PythonImport {
  readonly local: string;
  readonly module: string;
  readonly member?: string;
  /** Unaliased `import a.b` binds `a`, not `b`. */
  readonly prefix: string;
  readonly line: number;
}

export function pythonImports(root: SyntaxNode): PythonImport[] {
  const imports: PythonImport[] = [];
  const statements = root.type === "import_statement" || root.type === "import_from_statement" ? [root] : namedChildren(root);
  for (const node of statements) {
    if (node.type !== "import_statement" && node.type !== "import_from_statement") continue;
    const module = node.childForFieldName("module_name");
    for (const child of namedChildren(node)) {
      if (child.id === module?.id || child.type === "comment") continue;
      if (child.type === "wildcard_import") {
        imports.push({ local: "*", module: module?.text ?? "", member: "*", prefix: "", line: node.startPosition.row });
        continue;
      }
      const name = child.type === "aliased_import" ? child.childForFieldName("name")?.text : child.text;
      const alias = child.type === "aliased_import" ? child.childForFieldName("alias")?.text : undefined;
      if (!name) continue;
      if (module) {
        imports.push({ local: alias ?? name, module: module.text, member: name, prefix: "", line: node.startPosition.row });
      } else {
        imports.push({
          local: alias ?? name.split(".")[0]!, module: name,
          prefix: alias ? "" : name.split(".").slice(1).join("."), line: node.startPosition.row
        });
      }
    }
  }
  return imports;
}

/** Returns only a unique eligible module; ambiguous roots are not guessed. */
export function pythonModulePath(module: string, path: string, hasFile: (path: string) => boolean): string | undefined {
  const dots = /^\.+/.exec(module)?.[0].length ?? 0;
  const rest = module.slice(dots).replace(/\./g, "/");
  const bases: string[] = [];
  if (dots) {
    let directory = posix.dirname(path);
    for (let up = 1; up < dots; up++) {
      if (directory === ".") return undefined;
      directory = posix.dirname(directory);
    }
    bases.push(posix.join(directory, rest));
  } else {
    const roots = new Set([".", "src"]);
    let directory = posix.dirname(path);
    while (hasFile(posix.join(directory, "__init__.py"))) {
      const parent = posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    roots.add(directory);
    for (const root of roots) bases.push(posix.join(root, rest));
  }
  const found = new Set<string>();
  for (const base of bases) {
    for (const candidate of [`${base}.py`, posix.join(base, "__init__.py")]) {
      if (candidate.startsWith("../") || posix.isAbsolute(candidate)) continue;
      if (hasFile(candidate)) found.add(candidate);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export async function pythonFileImports(request: ImportRequest): Promise<string[]> {
  const imports = (await withPythonSyntaxTree(request.text, pythonImports)) ?? [];
  const targets = new Set<string>();
  for (const spec of imports) {
    const module = pythonModulePath(spec.module, request.path, request.hasFile);
    if (module && module !== request.path) targets.add(module);
    if (spec.member && spec.member !== "*") {
      const separator = spec.module.endsWith(".") ? "" : ".";
      const child = pythonModulePath(`${spec.module}${separator}${spec.member}`, request.path, request.hasFile);
      if (child && child !== request.path) targets.add(child);
    }
  }
  return [...targets];
}
