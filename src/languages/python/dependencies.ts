import type { Node as SyntaxNode } from "web-tree-sitter";
import { fingerprint } from "../../core/fingerprint";
import type { Dependency, DependencyItem, DependencyRequest, DependencyResult } from "../support";
import { allChildren, namedChildren, structuralTokens } from "../treeSitter";
import { pythonImports, pythonModulePath, type PythonImport } from "./imports";
import { pythonDefinition, pythonQualifiedName, pythonSignature, withPythonSyntaxTree } from "./syntax";

interface Binding {
  readonly item?: DependencyItem;
  readonly imported?: PythonImport;
}

interface Scope {
  readonly kind: "module" | "function" | "class";
  readonly parent?: Scope;
  readonly bindings: Map<string, Binding>;
  star: boolean;
}

interface Usage {
  readonly scope: Scope;
  readonly names: string[];
  readonly attributes: string[][];
  readonly receiver?: string;
  readonly owner?: Scope;
}

interface ParsedFile {
  readonly module: Scope;
  readonly usage?: Usage;
  readonly preamble: string;
}

function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (["attribute", "subscript", "type"].includes(node.type)) return [];
  return namedChildren(node).flatMap((child) => patternNames(child));
}

function parameters(node: SyntaxNode): string[] {
  const list = node.childForFieldName("parameters");
  return list ? namedChildren(list).flatMap((parameter) => {
    const name = parameter.childForFieldName("name");
    if (name) return patternNames(name);
    if (parameter.type === "typed_parameter") return patternNames(namedChildren(parameter)[0] ?? null);
    return patternNames(parameter);
  }) : [];
}

function attributeParts(node: SyntaxNode): string[] | undefined {
  if (node.type === "identifier") return [node.text];
  if (node.type !== "attribute") return undefined;
  const object = node.childForFieldName("object");
  const attribute = node.childForFieldName("attribute");
  const prefix = object ? attributeParts(object) : undefined;
  return prefix && attribute ? [...prefix, attribute.text] : undefined;
}

function itemOf(node: SyntaxNode, qualifiedName: string, kind: string, name: string): DependencyItem {
  const definition = pythonDefinition(node);
  const body = definition.childForFieldName("body");
  const header = allChildren(definition).filter((child) => child.id !== body?.id).map(structuralTokens).join("");
  const decorators = node.type === "decorated_definition"
    ? namedChildren(node).filter((child) => child.type === "decorator").map(structuralTokens).join("")
    : "";
  const signature = body ? pythonSignature(node) : node.text;
  return {
    kind, name, qualifiedName, source: node.text, signature,
    line: node.startPosition.row, fingerprint: fingerprint(structuralTokens(node)),
    signatureFingerprint: fingerprint(body ? decorators + header : structuralTokens(node))
  };
}

function parseFile(root: SyntaxNode, target?: { line: number; name: string; direct: boolean }): ParsedFile {
  let usage: Usage | undefined;
  const preamble: string[] = [];
  const bind = (scope: Scope, name: string, binding: Binding = {}) => {
    scope.bindings.set(name, scope.bindings.has(name) ? {} : binding);
  };
  const scanScope = (body: SyntaxNode, kind: Scope["kind"], parent?: Scope, qualifiedName = ""): Scope => {
    const scope: Scope = {
      kind, parent, bindings: new Map(),
      star: pythonImports(body).some((spec) => spec.local === "*")
    };
    const scan = (node: SyntaxNode, conditional = false) => {
      const definition = pythonDefinition(node);
      if (definition.type === "function_definition" || definition.type === "class_definition") {
        const name = definition.childForFieldName("name")?.text;
        if (!name) return;
        const qualified = pythonQualifiedName(node, qualifiedName ? qualifiedName.split(".") : [], name);
        const isFunction = definition.type === "function_definition";
        const item = itemOf(node, qualified, isFunction ? kind === "class" ? "method" : "function" : "type", name);
        // Decorators may replace the callable; never infer a direct caller through them.
        bind(scope, name, conditional || (target?.direct && node.type === "decorated_definition") ? {} : { item });
        const childBody = definition.childForFieldName("body");
        if (!childBody) return;
        const childScope = scanScope(childBody, isFunction ? "function" : "class", scope, qualified);
        if (isFunction) {
          const params = parameters(definition);
          const receiverBound = childScope.bindings.has(params[0] ?? "");
          for (const parameter of params) bind(childScope, parameter);
          if (target && node.startPosition.row === target.line && name === target.name) {
            const names = new Set<string>();
            const attributes = new Map<string, string[]>();
            const collect = (entry: SyntaxNode) => {
              if (entry.id !== definition.id && ["function_definition", "class_definition", "decorated_definition", "lambda"].includes(entry.type)) return;
              if (target.direct && entry.type === "call") {
                const callee = entry.childForFieldName("function");
                const parts = callee ? attributeParts(callee) : undefined;
                if (parts?.length === 1) names.add(parts[0]!);
                else if (parts) attributes.set(parts.join("."), parts);
              }
              if (!target.direct && entry.type === "attribute") {
                const parts = attributeParts(entry);
                if (parts) {
                  attributes.set(parts.join("."), parts);
                  return;
                }
              }
              if (!target.direct && entry.type === "identifier") {
                const parent = entry.parent;
                const isLabel = parent?.type === "keyword_argument" && parent.childForFieldName("name")?.id === entry.id;
                if (!isLabel) names.add(entry.text);
              }
              namedChildren(entry).forEach(collect);
            };
            if (!target.direct) {
              for (const decorator of namedChildren(node).filter((child) => child.type === "decorator")) collect(decorator);
            }
            collect(target.direct ? childBody : definition);
            const receiver = kind === "class" && ["self", "cls"].includes(params[0] ?? "") &&
              !/@staticmethod\b/.test(node.text.slice(0, definition.startIndex - node.startIndex))
              ? params[0] : undefined;
            usage = {
              scope: childScope, names: [...names], attributes: [...attributes.values()],
              receiver: receiver && !receiverBound ? receiver : undefined,
              owner: kind === "class" ? scope : undefined
            };
          }
        }
        return;
      }
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        for (const imported of pythonImports(node)) {
          if (imported.local === "*") scope.star = true;
          else bind(scope, imported.local, conditional ? {} : { imported });
        }
        if (kind === "module") preamble.push(node.text);
        return;
      }
      if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression") {
        const left = node.childForFieldName(node.type === "named_expression" ? "name" : "left");
        for (const name of patternNames(left)) {
          const item = kind === "module" && node.type === "assignment" && left?.type === "identifier"
            ? itemOf(node, name, /^[A-Z_][A-Z_0-9]*$/.test(name) ? "constant" : "variable", name) : undefined;
          bind(scope, name, !conditional && item ? { item } : {});
        }
        if (kind === "module" && left?.text === "__all__") preamble.push(node.text);
      }
      if (node.type === "for_statement" || node.type === "for_in_clause") {
        for (const name of patternNames(node.childForFieldName("left"))) bind(scope, name);
      }
      if (node.type === "as_pattern") {
        for (const name of patternNames(node.childForFieldName("alias"))) bind(scope, name);
      }
      if (node.type === "case_pattern") {
        for (const name of patternNames(node)) bind(scope, name);
      }
      if (["global_statement", "nonlocal_statement", "delete_statement"].includes(node.type)) {
        for (const name of namedChildren(node).flatMap((child) => patternNames(child))) bind(scope, name);
      }
      if (node.type === "lambda") return;
      const branching = conditional || ["if_statement", "try_statement", "for_statement", "while_statement", "match_statement", "with_statement"].includes(node.type);
      for (const child of namedChildren(node)) scan(child, branching);
    };
    for (const child of namedChildren(body)) scan(child);
    return scope;
  };
  const module = scanScope(root, "module");
  return { module, usage, preamble: preamble.join("\n") };
}

function lookup(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current !== scope && current.kind === "class") continue;
    if (current.star) return undefined;
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return undefined;
}

export async function findPythonDependencies(request: DependencyRequest & { readonly directCallsOnly?: boolean }): Promise<DependencyResult> {
  const direct = request.directCallsOnly ?? false;
  const target = await withPythonSyntaxTree(request.text, (root) =>
    parseFile(root, { line: request.line, name: request.name, direct }));
  const limitations = new Set<string>();
  const dependencies: Dependency[] = [];
  const added = new Set<string>();
  const max = request.maxDependencies ?? 16;
  const parsed = new Map<string, ParsedFile>();
  if (target) parsed.set(request.path, target);
  if (!target?.usage) return { dependencies, preamble: target?.preamble ?? "", limitations: ["The Python function could not be resolved."] };
  if (direct && target.module.star) {
    return { dependencies, preamble: target.preamble, limitations: ["Python star imports make direct caller resolution ambiguous."] };
  }
  const usage = target.usage;
  const expired = () => request.deadline !== undefined && Date.now() >= request.deadline;
  const hasFile = (path: string) => request.readablePaths.has(path);
  const load = async (path: string): Promise<ParsedFile | undefined> => {
    if (parsed.has(path)) return parsed.get(path);
    if (!hasFile(path) || expired() || parsed.size >= 40) {
      limitations.add("Some Python modules were not read within the lookup budget.");
      return undefined;
    }
    const source = await request.load(path);
    if (source === undefined) {
      limitations.add("An imported Python module was unavailable or excluded.");
      return undefined;
    }
    const file = await withPythonSyntaxTree(source, (root) => parseFile(root, { line: -1, name: "", direct }));
    if (file) parsed.set(path, file);
    return file;
  };
  const add = (path: string, item: DependencyItem) => {
    if (direct && (item.kind !== "function" || item.qualifiedName !== item.name)) return;
    if (!direct && path === request.path && item.line === request.line && item.name === request.name) return;
    if (request.onlyName && request.onlyName !== item.name) return;
    const key = `${path}\0${item.line}\0${item.name}`;
    if (added.has(key)) return;
    if (dependencies.length >= max) {
      limitations.add(`Only the first ${max} items used by this function are tracked.`);
      return;
    }
    added.add(key);
    dependencies.push({ path, item });
  };
  const resolveImport = async (spec: PythonImport, attributes: string[]) => {
    if (expired()) return;
    const path = pythonModulePath(spec.module, request.path, hasFile);
    if (spec.member && attributes.length === 0 && path) {
      const file = await load(path);
      const binding = file && !file.module.star ? file.module.bindings.get(spec.member) : undefined;
      if (binding?.item) add(path, binding.item);
      else limitations.add("Python re-exports and dynamic module attributes are not followed.");
      return;
    }
    const prefix = spec.prefix ? spec.prefix.split(".") : [];
    if (prefix.some((part, index) => attributes[index] !== part)) return;
    const remaining = attributes.slice(prefix.length);
    if (remaining.length !== 1) return;
    const memberModule = spec.member
      ? pythonModulePath(`${spec.module}${spec.module.endsWith(".") ? "" : "."}${spec.member}`, request.path, hasFile)
      : path;
    if (memberModule) {
      const file = await load(memberModule);
      const binding = file && !file.module.star ? file.module.bindings.get(remaining[0]!) : undefined;
      if (binding?.item) add(memberModule, binding.item);
      else if (binding?.imported) limitations.add("Python re-exports are not followed.");
    } else if (request.unreadPaths?.size) {
      limitations.add("Imported Python modules outside the scan budget are not tracked.");
    }
  };
  for (const name of usage.names.slice(0, 80)) {
    if (expired()) break;
    const binding = lookup(usage.scope, name);
    if (binding?.item) add(request.path, binding.item);
    if (binding?.imported) await resolveImport(binding.imported, []);
  }
  for (const parts of usage.attributes.slice(0, 80)) {
    if (expired()) break;
    const [first, ...rest] = parts;
    if (!direct && first === usage.receiver && rest.length === 1) {
      const binding = usage.owner?.bindings.get(rest[0]!);
      if (binding?.item) add(request.path, binding.item);
    } else {
      const binding = first ? lookup(usage.scope, first) : undefined;
      if (binding?.imported) await resolveImport(binding.imported, rest);
    }
  }
  if (expired()) limitations.add("Python dependency lookup stopped at its time limit.");
  if (usage.names.length > 80 || usage.attributes.length > 80) limitations.add("Only the first 80 Python names and attribute references are inspected.");
  limitations.add("Python analysis is static: dynamic dispatch, inheritance, star imports, re-exports, and runtime import paths are not resolved.");
  return { dependencies, preamble: target.preamble, limitations: [...limitations] };
}
