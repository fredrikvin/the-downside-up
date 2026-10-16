import { posix } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import { fingerprint } from "../../core/fingerprint";
import { goBaseTypeName, goFunctionNodes, goReceiverType, goSignature, withGoSyntaxTree } from "./syntax";
import { allChildren, namedChildren, structuralTokens } from "../treeSitter";

/**
 * Depth-1 dependencies for a Go function, found with Tree-sitter and the Go
 * module layout (no compiler or gopls): package-level items from any file of
 * the same package, items of imported packages inside the current module, and
 * methods of the types the function uses.
 */

export type GoItemKind = "function" | "method" | "type" | "type alias" | "constant" | "variable";

export interface GoItem {
  readonly kind: GoItemKind;
  readonly name: string;
  /** Receiver base type of a method. */
  readonly owner?: string;
  readonly qualifiedName: string;
  readonly source: string;
  readonly signature: string;
  readonly fingerprint: string;
  readonly signatureFingerprint: string;
  /** Zero-based line where the declaration starts. */
  readonly line: number;
  /** Same-package result types of a function or method, used to match later method calls. */
  readonly resultTypes?: readonly string[];
}

export interface GoDependency {
  readonly path: string;
  readonly item: GoItem;
}

export interface GoDependencyRequest {
  /** Repository-relative path of the file that holds the function. */
  readonly path: string;
  readonly text: string;
  /** Zero-based line where the function declaration starts. */
  readonly line: number;
  readonly name: string;
  readonly readablePaths: ReadonlySet<string>;
  readonly unreadPaths?: ReadonlySet<string>;
  readonly load: (path: string) => Promise<string | undefined>;
  readonly maxDependencies?: number;
  readonly directCallsOnly?: boolean;
}

export interface GoDependencyResult {
  readonly dependencies: GoDependency[];
  /** The file's package clause and import declarations. */
  readonly preamble: string;
  readonly limitations: string[];
}

interface ParsedFile {
  readonly packageName: string | undefined;
  readonly items: GoItem[];
}

interface ImportSpec {
  readonly alias: string | undefined;
  readonly path: string;
}

interface FunctionUsage {
  readonly qualifiedName: string;
  readonly names: string[];
  readonly qualified: Array<[string, string]>;
  readonly methods: string[];
}

const DEFAULT_MAX_DEPENDENCIES = 16;
const TYPE_KINDS = new Set<GoItemKind>(["type", "type alias"]);

function signatureOf(node: SyntaxNode, text: string): { signature: string; signatureFingerprint: string } {
  const signature = node.type === "function_declaration" || node.type === "method_declaration"
    ? goSignature(node)
    : text.split("{")[0]!.trim();
  return { signature, signatureFingerprint: fingerprint(signature.replace(/\s+/g, " ")) };
}

/** Result types declared in the function's own package (not qualified with another package). */
function resultTypes(node: SyntaxNode): string[] {
  const result = node.childForFieldName("result");
  if (!result) return [];
  const types = result.type === "parameter_list"
    ? namedChildren(result).map((entry) => entry.childForFieldName("type"))
    : [result];
  return types.flatMap((type) => {
    let base = type;
    while (base && (base.type === "pointer_type" || base.type === "generic_type" || base.type === "parenthesized_type")) {
      base = base.type === "generic_type" ? base.childForFieldName("type") : namedChildren(base)[0] ?? null;
    }
    const name = base?.type === "type_identifier" ? goBaseTypeName(base) : undefined;
    return name ? [name] : [];
  });
}

function fileItems(root: SyntaxNode): ParsedFile {
  const items: GoItem[] = [];
  let packageName: string | undefined;
  const push = (kind: GoItemKind, name: string, node: SyntaxNode, text: string, owner?: string) => {
    items.push({
      kind,
      name,
      ...(owner ? { owner } : {}),
      qualifiedName: owner ? `${owner}.${name}` : name,
      source: text,
      ...signatureOf(node, text),
      fingerprint: fingerprint(structuralTokens(node)),
      line: node.startPosition.row
    });
  };
  for (const { node, name, qualifiedName } of goFunctionNodes(root)) {
    const owner = node.type === "method_declaration" ? goReceiverType(node) : undefined;
    if (node.type === "method_declaration" && !owner) continue;
    items.push({
      kind: owner ? "method" : "function",
      name: name.text,
      ...(owner ? { owner } : {}),
      qualifiedName,
      source: node.text,
      ...signatureOf(node, node.text),
      fingerprint: fingerprint(structuralTokens(node)),
      line: node.startPosition.row,
      resultTypes: resultTypes(node)
    });
  }
  for (const node of namedChildren(root)) {
    if (node.type === "package_clause") {
      packageName = namedChildren(node)[0]?.text;
    } else if (node.type === "type_declaration") {
      const grouped = allChildren(node).some((entry) => entry.type === "(");
      for (const spec of namedChildren(node).filter((entry) => entry.type === "type_spec" || entry.type === "type_alias")) {
        const name = spec.childForFieldName("name")?.text;
        if (!name) continue;
        push(spec.type === "type_alias" ? "type alias" : "type", name, grouped ? spec : node, grouped ? `type ${spec.text}` : node.text);
      }
    } else if (node.type === "const_declaration" || node.type === "var_declaration") {
      // A const group shares `iota` and implicit repetition, so each constant tracks its whole group.
      const isConst = node.type === "const_declaration";
      const grouped = allChildren(node).some((entry) => entry.type === "(");
      for (const spec of namedChildren(node).filter((entry) => entry.type === "const_spec" || entry.type === "var_spec")) {
        for (const identifier of namedChildren(spec).filter((entry) => entry.type === "identifier")) {
          const whole = isConst || !grouped;
          push(isConst ? "constant" : "variable", identifier.text, whole ? node : spec, whole ? node.text : `var ${spec.text}`);
        }
      }
    }
  }
  return { packageName, items };
}

export function importsOf(root: SyntaxNode): { imports: ImportSpec[]; preamble: string } {
  const imports: ImportSpec[] = [];
  const parts: string[] = [];
  for (const node of namedChildren(root)) {
    if (node.type === "package_clause") parts.push(node.text);
    if (node.type !== "import_declaration") continue;
    parts.push(node.text);
    const specs: SyntaxNode[] = [];
    const visit = (entry: SyntaxNode) => {
      if (entry.type === "import_spec") specs.push(entry);
      else namedChildren(entry).forEach(visit);
    };
    visit(node);
    for (const spec of specs) {
      const path = spec.childForFieldName("path")?.text.replace(/^["`]|["`]$/g, "");
      if (path) imports.push({ alias: spec.childForFieldName("name")?.text, path });
    }
  }
  return { imports, preamble: parts.join("\n") };
}

function functionUsage(root: SyntaxNode, line: number, name: string, directOnly = false): FunctionUsage | undefined {
  const found = goFunctionNodes(root).find((entry) => entry.node.startPosition.row === line && entry.name.text === name);
  if (!found) return undefined;
  const names: string[] = [];
  const qualified: Array<[string, string]> = [];
  const methods: string[] = [];
  const seen = new Set<string>();
  const shadowed = new Set<string>();
  const identifiers = (node: SyntaxNode) => {
    if (node.type === "identifier") shadowed.add(node.text);
    namedChildren(node).forEach(identifiers);
  };
  const bindings = (node: SyntaxNode) => {
    if (node.type === "type_spec" || node.type === "type_alias") {
      const name = node.childForFieldName("name");
      if (name) shadowed.add(name.text);
    }
    if (["parameter_declaration", "variadic_parameter_declaration", "var_spec", "const_spec"].includes(node.type)) {
      for (const child of namedChildren(node)) if (child.type === "identifier") shadowed.add(child.text);
    }
    if (node.type === "short_var_declaration" || node.type === "range_clause") {
      const left = node.childForFieldName("left");
      if (left) identifiers(left);
    }
    namedChildren(node).forEach(bindings);
  };
  if (directOnly) {
    bindings(found.node);
    for (const child of namedChildren(root)) {
      if (child.type === "var_declaration" || child.type === "const_declaration") bindings(child);
    }
  }
  const once = (key: string, add: () => void) => {
    if (seen.has(key)) return;
    seen.add(key);
    add();
  };
  const visit = (node: SyntaxNode) => {
    if (directOnly) {
      if (node.type === "func_literal") return;
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        if (callee?.type === "identifier" && !shadowed.has(callee.text)) names.push(callee.text);
        if (callee?.type === "selector_expression") {
          const operand = callee.childForFieldName("operand");
          const field = callee.childForFieldName("field");
          if (operand?.type === "identifier" && field && !shadowed.has(operand.text)) qualified.push([operand.text, field.text]);
        }
      }
      namedChildren(node).forEach(visit);
      return;
    }
    if (node.type === "qualified_type") {
      const pkg = node.childForFieldName("package")?.text;
      const item = node.childForFieldName("name")?.text;
      if (pkg && item) once(`q:${pkg}.${item}`, () => qualified.push([pkg, item]));
      return;
    }
    if (node.type === "selector_expression") {
      const operand = node.childForFieldName("operand");
      const field = node.childForFieldName("field")?.text;
      if (operand?.type === "identifier" && field) once(`q:${operand.text}.${field}`, () => qualified.push([operand.text, field]));
      if (field && node.parent?.type === "call_expression" && node.parent.childForFieldName("function")?.id === node.id) {
        once(`m:${field}`, () => methods.push(field));
      }
    }
    if (node.type === "identifier" || node.type === "type_identifier") once(`n:${node.text}`, () => names.push(node.text));
    namedChildren(node).forEach(visit);
  };
  for (const field of ["receiver", "type_parameters", "parameters", "result", "body"]) {
    const part = found.node.childForFieldName(field);
    if (part) visit(part);
  }
  return { qualifiedName: found.qualifiedName, names, qualified, methods };
}

export async function findGoDependencies(request: GoDependencyRequest): Promise<GoDependencyResult> {
  const limitations = new Set<string>();
  const max = request.maxDependencies ?? DEFAULT_MAX_DEPENDENCIES;
  const dirOf = (path: string) => (posix.dirname(path) === "." ? "" : posix.dirname(path));
  const join = (...parts: string[]) => parts.filter(Boolean).join("/");

  const parsedTarget = await withGoSyntaxTree(request.text, (root) => ({
    usage: functionUsage(root, request.line, request.name, request.directCallsOnly),
    ...importsOf(root),
    packageName: fileItems(root).packageName
  }));
  if (!parsedTarget?.usage) return { dependencies: [], preamble: parsedTarget?.preamble ?? "", limitations: [] };
  const { usage, imports, preamble, packageName } = parsedTarget;

  const parsed = new Map<string, ParsedFile>();
  const parse = async (file: string): Promise<ParsedFile> => {
    const cached = parsed.get(file);
    if (cached) return cached;
    const text = file === request.path ? request.text : await request.load(file);
    const result = text === undefined
      ? { packageName: undefined, items: [] }
      : (await withGoSyntaxTree(text, fileItems)) ?? { packageName: undefined, items: [] };
    parsed.set(file, result);
    return result;
  };
  const goFilesIn = (dir: string, includeTests: boolean): string[] => {
    const inDir = (path: string) => dirOf(path) === dir && path.endsWith(".go") && (includeTests || !path.endsWith("_test.go"));
    for (const path of request.unreadPaths ?? []) {
      if (inDir(path)) limitations.add(`${path} was not read within the scan budget, so items used from it are not tracked.`);
    }
    return [...request.readablePaths].filter(inDir).sort();
  };
  /** Files of one package; directories may also hold an external `_test` package. */
  const packageFiles = async (dir: string, name: string | undefined, includeTests: boolean) => {
    const files: string[] = [];
    for (const file of goFilesIn(dir, includeTests)) {
      if (name === undefined || (await parse(file)).packageName === name) files.push(file);
    }
    return files;
  };

  // Imports inside this module map to directories through go.mod's module path.
  let moduleDir: string | undefined;
  for (let dir = dirOf(request.path); ; dir = dirOf(dir)) {
    if (request.readablePaths.has(join(dir, "go.mod"))) {
      moduleDir = dir;
      break;
    }
    if (dir === "") break;
  }
  const goMod = moduleDir === undefined ? undefined : await request.load(join(moduleDir, "go.mod"));
  const modulePath = goMod ? /^\s*module\s+("?)([^\s"]+)\1/m.exec(goMod)?.[2] : undefined;
  if (!modulePath) limitations.add("No go.mod module path was found; only items from this package are tracked.");
  if (request.readablePaths.has("go.work")) {
    limitations.add("Only packages of the current Go module are followed, not other modules in go.work.");
  }
  const importedPackages = new Map<string, { dir: string; name: string | undefined }>();
  const dotPackages: Array<{ dir: string; name: string | undefined }> = [];
  for (const spec of imports) {
    if (!modulePath || moduleDir === undefined || spec.alias === "_") continue;
    if (spec.path !== modulePath && !spec.path.startsWith(`${modulePath}/`)) continue;
    const dir = join(moduleDir, spec.path.slice(modulePath.length + 1));
    const files = goFilesIn(dir, false);
    const names = await Promise.all(files.map(async (file) => (await parse(file)).packageName));
    const name = names.find((entry) => entry !== undefined);
    const target = { dir, name };
    if (spec.alias === ".") dotPackages.push(target);
    else {
      const local = spec.alias ?? name ?? spec.path.split("/").pop()!;
      importedPackages.set(local, target);
    }
  }

  const dependencies: GoDependency[] = [];
  const added = new Set<string>();
  const ownerTypes: Array<{ dir: string; packageName: string | undefined; name: string }> = [];
  const add = (file: string, item: GoItem, dir: string, pkg: string | undefined): void => {
    if (request.directCallsOnly && item.kind !== "function") return;
    if (!request.directCallsOnly && file === request.path && item.qualifiedName === usage.qualifiedName) return;
    const key = `${file}\0${item.kind}\0${item.qualifiedName}`;
    if (added.has(key)) return;
    if (dependencies.length >= max) {
      limitations.add(`Only the first ${max} items used by this function are tracked.`);
      return;
    }
    added.add(key);
    dependencies.push({ path: file, item });
    if (TYPE_KINDS.has(item.kind)) ownerTypes.push({ dir, packageName: pkg, name: item.name });
    // `c := pkg.NewCatalog(); c.Add(...)` never names Catalog, so result types count as receivers too.
    for (const result of item.resultTypes ?? []) ownerTypes.push({ dir, packageName: pkg, name: result });
  };
  const lookup = async (dir: string, pkg: string | undefined, name: string, includeTests: boolean): Promise<void> => {
    const matches: Array<{ file: string; item: GoItem }> = [];
    for (const file of await packageFiles(dir, pkg, includeTests)) {
      const items = (await parse(file)).items.filter((entry) => entry.owner === undefined && entry.name === name);
      if (request.directCallsOnly) {
        for (const item of items) matches.push({ file, item });
        continue;
      }
      const item = items[0];
      if (item) {
        add(file, item, dir, pkg);
        return;
      }
    }
    if (matches.length === 1) add(matches[0]!.file, matches[0]!.item, dir, pkg);
  };

  const ownDir = dirOf(request.path);
  const isTest = request.path.endsWith("_test.go");
  for (const [pkg, name] of usage.qualified) {
    const imported = importedPackages.get(pkg);
    if (imported) await lookup(imported.dir, imported.name, name, false);
  }
  for (const name of usage.names) {
    if (importedPackages.has(name)) continue;
    await lookup(ownDir, packageName, name, isTest);
    if (!request.directCallsOnly) for (const dot of dotPackages) await lookup(dot.dir, dot.name, name, false);
  }
  // Method calls on values: the receiver type is unknown, so match methods of the used types.
  for (const method of usage.methods) {
    for (const owner of [...ownerTypes]) {
      for (const file of await packageFiles(owner.dir, owner.packageName, owner.dir === ownDir && isTest)) {
        for (const item of (await parse(file)).items) {
          if (item.kind === "method" && item.owner === owner.name && item.name === method) {
            add(file, item, owner.dir, owner.packageName);
          }
        }
      }
    }
  }
  return { dependencies, preamble, limitations: [...limitations] };
}
