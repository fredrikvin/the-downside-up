import { posix } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { GuidanceRequest } from "../support";
import { namedChildren } from "../treeSitter";
import { pythonImports, pythonModulePath, type PythonImport } from "./imports";
import { pythonDefinition, pythonFunctionNodes, withPythonSyntaxTree } from "./syntax";

export interface PythonGuidanceRequest extends GuidanceRequest {
  /** Optional eligible snapshot inventory, never a filesystem scan or a package lookup. */
  readonly hasFile?: (path: string) => boolean;
}

// Hard limits apply before recursive walks. Output consists only of these fixed snippets,
// in this order; no source text, identifiers, paths or import spelling is interpolated.
const MAX_SOURCE = 256 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 100;
const NOTES = {
  async: "Python async function: calling it creates a coroutine; its body runs when awaited or scheduled. Await may suspend and resume it; async does not by itself mean parallel execution.",
  generator: "Python generator: calling it creates an iterator; its body runs as it is advanced. Yield produces a value and suspends, rather than permanently exiting; resumption continues from there.",
  asyncGenerator: "Python async generator: calling it creates an asynchronous iterator, not a coroutine result. Its body runs as asynchronous iteration advances it; yield suspends and await may suspend too.",
  context: "Python context managers: with enters each manager before its body and exits entered managers in reverse order when leaving, including on exceptions. Async with awaits entry and exit. Do not assume an arbitrary manager closes a resource or propagates an exception; its exit can suppress one.",
  decorators: "Python decorators: decorator expressions are evaluated when the definition executes, and decorators are applied from the bottom upward. They can replace the callable; do not infer an unknown decorator's behavior from its name.",
  defaults: "Python defaults: default expressions are evaluated in the enclosing scope when the definition executes, not on every call. Their resulting objects are reused for omitted arguments; distinguish this from execution of the callable body.",
  nested: "Python nested callables: executing a definition or lambda creates a callable; its body does not run merely because the enclosing function runs. A later call can execute it, with captured enclosing bindings. Keep later execution separate in steps, phases, pseudocode and flowcharts.",
  exceptions: "Python exceptions: distinguish raising, matching handlers, and normal completion. An else suite runs only when the try suite completes normally. Finally runs when leaving its try, including during return or exception propagation; a return or raise there can replace the pending outcome.",
  mutation: "Python visible updates: distinguish rebinding a local name from changing an object's attributes or indexed contents, deletion, and in-place operations. Augmented assignment may mutate or rebind depending on the object. A mutator-like method name is a cue, not proof of an effect; do not infer receiver types.",
  numpy: "NumPy background, conditional on the explicit import referring to NumPy: explain array-wise operations, broadcasting, axes and reductions, indexing and reshape when present. Distinguish element-wise * from matrix @. Views versus copies depend on the operation; do not invent dimensions, dtype, values or unconditional sharing.",
  pandas: "pandas background, conditional on the explicit import referring to pandas: explain label alignment, label-based .loc versus position-based .iloc, filtering, grouping, joins and missing values when present. Distinguish returned data from mutation; do not invent columns, row counts, uniqueness, ordering or version-specific copy behavior.",
  torch: "PyTorch background, conditional on the explicit import referring to PyTorch: explain tensor operations and explicit device transfers when present. Gradient recording and accumulation, backward computation and optimizer steps are distinct; backward alone does not establish a parameter update. eval() changes module mode, not gradient recording; no_grad disables recording in its scope and detach separates a tensor from its gradient history. Do not invent shape, dtype, device, parameter updates or training success.",
  imports: "Import evidence is static, not verification of an installed distribution: local modules, import hooks and monkey patches may change meaning. Do not infer library types from names such as df, model or optimizer, or transfer these profiles to unrelated receivers."
} as const;
type Note = keyof typeof NOTES;
type Library = "numpy" | "pandas" | "torch";
interface Binding {
  readonly imported?: PythonImport;
  readonly end: number;
}
interface Scope {
  readonly kind: "module" | "function" | "class" | "comprehension";
  readonly parent?: Scope;
  readonly bindings: Map<string, Binding>;
  star: boolean;
}
const CALLABLES = new Set(["function_definition", "class_definition", "decorated_definition", "lambda"]);
const COMPREHENSIONS = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);
const CONDITIONAL = new Set(["if_statement", "try_statement", "for_statement", "while_statement", "match_statement", "with_statement"]);
const MUTATOR_NAMES = new Set(["append", "extend", "insert", "remove", "pop", "clear", "sort", "reverse",
  "update", "setdefault", "add", "discard", "difference_update", "intersection_update", "symmetric_difference_update"]);

// Like dependency analysis, binding targets are not general identifier references.
function patternNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (["attribute", "subscript", "type"].includes(node.type)) return [];
  return namedChildren(node).flatMap(patternNames);
}

function parts(node: SyntaxNode | null): string[] | undefined {
  if (!node) return undefined;
  if (node.type === "identifier") return [node.text];
  if (node.type !== "attribute") return undefined;
  const prefix = parts(node.childForFieldName("object"));
  const attribute = node.childForFieldName("attribute");
  return prefix && attribute ? [...prefix, attribute.text] : undefined;
}

function objectTarget(node: SyntaxNode): boolean {
  return ["attribute", "subscript"].includes(node.type) ||
    namedChildren(node).some(objectTarget);
}

function bounded(root: SyntaxNode): boolean {
  const stack: { node: SyntaxNode; depth: number }[] = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH || node.isMissing || node.isError) return false;
    for (const child of namedChildren(node)) stack.push({ node: child, depth: depth + 1 });
  }
  return true;
}

/** Expressions evaluated by the defining scope, never by the new callable's locals. */
function headerExpressions(node: SyntaxNode): SyntaxNode[] {
  const definition = pythonDefinition(node);
  const expressions = namedChildren(node).filter((child) => child.type === "decorator");
  const parameters = definition.childForFieldName("parameters");
  for (const parameter of parameters ? namedChildren(parameters) : []) {
    const value = parameter.childForFieldName("value");
    if (value) expressions.push(value);
  }
  return expressions;
}

function bindingScopes(root: SyntaxNode): Map<number, Scope> {
  const scopes = new Map<number, Scope>();
  const bind = (scope: Scope, name: string, end: number, imported?: PythonImport) => {
    scope.bindings.set(name, { end, imported: scope.bindings.has(name) ? undefined : imported });
  };
  const bindPattern = (scope: Scope, node: SyntaxNode | null) => {
    for (const name of patternNames(node)) bind(scope, name, node!.endIndex);
    // A visible write to an imported module attribute also invalidates that root.
    const attributes = (target: SyntaxNode): void => {
      if (target.type === "attribute") {
        const rootName = parts(target)?.[0];
        if (rootName) bind(scope, rootName, target.endIndex);
      } else if (target.type !== "subscript") {
        for (const child of namedChildren(target)) attributes(child);
      }
    };
    if (node) attributes(node);
  };
  const scan = (node: SyntaxNode, scope: Scope, conditional = false): void => {
    scopes.set(node.id, scope);
    const definition = pythonDefinition(node);
    if (CALLABLES.has(node.type)) {
      const name = definition.childForFieldName("name");
      if (name) bind(scope, name.text, node.endIndex);
      for (const expression of headerExpressions(node)) scan(expression, scope, conditional);
      const inner: Scope = {
        kind: definition.type === "class_definition" ? "class" : "function",
        parent: scope, bindings: new Map(), star: false
      };
      const parameters = definition.childForFieldName("parameters");
      for (const parameter of parameters ? namedChildren(parameters) : []) {
        const target = parameter.childForFieldName("name") ??
          (parameter.type === "typed_parameter" ? namedChildren(parameter)[0] ?? null : parameter);
        bindPattern(inner, target);
      }
      const body = definition.childForFieldName("body");
      if (body) scan(body, inner);
      // Class base expressions are not callable bodies or parameter defaults.
      if (inner.kind === "class") {
        const bases = definition.childForFieldName("superclasses");
        if (bases) scan(bases, scope, conditional);
      }
      return;
    }
    if (COMPREHENSIONS.has(node.type)) {
      const inner: Scope = { kind: "comprehension", parent: scope, bindings: new Map(), star: false };
      const children = namedChildren(node);
      const firstFor = children.find((child) => child.type === "for_in_clause");
      for (const child of children) {
        if (child.type === "for_in_clause") bindPattern(inner, child.childForFieldName("left"));
      }
      for (const child of children) {
        if (child.id === firstFor?.id) {
          // Python evaluates the outermost iterable in the enclosing scope.
          const right = child.childForFieldName("right");
          if (right) scan(right, scope, conditional);
        } else scan(child, inner, true);
      }
      return;
    }
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      for (const spec of pythonImports(node)) {
        if (spec.local === "*") scope.star = true;
        else bind(scope, spec.local, node.endIndex, conditional ? undefined : spec);
      }
      return;
    }
    if (["assignment", "augmented_assignment", "named_expression"].includes(node.type)) {
      // Assignment expressions in comprehensions can escape their implicit scope.
      let owner = scope;
      if (node.type === "named_expression") {
        while (owner.kind === "comprehension" && owner.parent) owner = owner.parent;
      }
      bindPattern(owner, node.childForFieldName(node.type === "named_expression" ? "name" : "left"));
    }
    if (node.type === "for_statement" || node.type === "for_in_clause") bindPattern(scope, node.childForFieldName("left"));
    if (node.type === "as_pattern") bindPattern(scope, node.childForFieldName("alias"));
    if (node.type === "case_pattern") bindPattern(scope, node);
    if (node.type === "delete_statement") {
      for (const child of namedChildren(node)) bindPattern(scope, child);
    }
    if (node.type === "global_statement" || node.type === "nonlocal_statement") {
      for (const name of namedChildren(node).flatMap(patternNames)) {
        bind(scope, name, node.endIndex);
        for (let parent = scope.parent; parent; parent = parent.parent) {
          if (parent.bindings.has(name) || parent.kind === "module") bind(parent, name, node.endIndex);
        }
      }
    }
    // exec can introduce or replace bindings which this static analysis cannot know.
    if (node.type === "call" && node.childForFieldName("function")?.text === "exec") scope.star = true;
    for (const child of namedChildren(node)) scan(child, scope, conditional || CONDITIONAL.has(node.type));
  };
  scan(root, { kind: "module", bindings: new Map(), star: false });
  return scopes;
}

function lookup(scope: Scope | undefined, name: string, index: number): PythonImport | undefined {
  for (let current = scope; current; current = current.parent) {
    // A method's free variables do not close over its class namespace.
    if (current !== scope && current.kind === "class") continue;
    if (current.star) return undefined;
    const binding = current.bindings.get(name);
    if (binding) return binding.end <= index ? binding.imported : undefined;
  }
  return undefined;
}

function library(spec: PythonImport, attributes: readonly string[], request: PythonGuidanceRequest): Library | undefined {
  const root = spec.module.split(".")[0];
  if (root !== "numpy" && root !== "pandas" && root !== "torch") return undefined;
  if (spec.member === "*" || (!spec.member && attributes.length === 0)) return undefined;
  const prefix = spec.prefix ? spec.prefix.split(".") : [];
  if (prefix.some((part, index) => attributes[index] !== part)) return undefined;
  // Merely referencing the root of an unaliased submodule import is not use of that submodule.
  if (!spec.member && attributes.length <= prefix.length) return undefined;
  const path = request.path.replace(/\\/g, "/");
  if (posix.basename(path) === `${root}.py` || path.split("/").slice(0, -1).includes(root)) return undefined;
  if (request.hasFile) {
    const hasFile = request.hasFile;
    // Check individual candidates too: pythonModulePath deliberately returns undefined
    // for ambiguity, whereas both unique and ambiguous local origins suppress profiles.
    let conflict = false;
    pythonModulePath(spec.module, path, (candidate) => {
      const exists = hasFile(candidate);
      conflict ||= exists;
      return exists;
    });
    for (const base of [root, `src/${root}`, posix.join(posix.dirname(path), root)]) {
      conflict ||= hasFile(`${base}.py`) || hasFile(`${base}/__init__.py`);
    }
    if (conflict) return undefined;
  }
  return root;
}

/** Fixed, snapshot-local Python background; no IO, workspace execution, package discovery or receiver-type inference. */
export async function pythonGuidance(request: PythonGuidanceRequest): Promise<string | undefined> {
  if (Buffer.byteLength(request.text, "utf8") > MAX_SOURCE) return undefined;
  try {
    return await withPythonSyntaxTree(request.text, (root) => {
      if (root.hasError || !bounded(root)) return undefined;
      const entry = pythonFunctionNodes(root).find((candidate) =>
        candidate.node.startPosition.row === request.line && candidate.name.text === request.name &&
        candidate.qualifiedName === request.qualifiedName);
      if (!entry) return undefined;
      const scopes = bindingScopes(root);
      const notes = new Set<Note>();
      const profiles = new Set<Library>();
      let yields = false;
      let ownExecution = false;
      for (let parent = entry.node.parent; parent; parent = parent.parent) {
        if (parent.type === "function_definition" || parent.type === "lambda") notes.add("nested");
      }
      const use = (node: SyntaxNode) => {
        const names = parts(node);
        if (!names) return;
        const spec = lookup(scopes.get(node.id), names[0]!, node.startIndex);
        const profile = spec && library(spec, names.slice(1), request);
        if (profile) profiles.add(profile);
      };
      const header = (node: SyntaxNode) => {
        if (node.type === "decorated_definition") notes.add("decorators");
        const parameters = pythonDefinition(node).childForFieldName("parameters");
        if (parameters && namedChildren(parameters).some((parameter) => parameter.childForFieldName("value"))) notes.add("defaults");
        for (const expression of headerExpressions(node)) visit(expression);
      };
      const visit = (node: SyntaxNode): void => {
        if (node.type === "comment" || node.type === "type" ||
          node.type === "import_statement" || node.type === "import_from_statement" ||
          node.type === "case_pattern" || node.type === "global_statement" || node.type === "nonlocal_statement") return;
        if (CALLABLES.has(node.type)) {
          if (pythonDefinition(node).type === "class_definition") {
            // A class suite executes now; only the methods it creates run later.
            header(node);
            const definition = pythonDefinition(node);
            const bases = definition.childForFieldName("superclasses");
            if (bases) visit(bases);
            const body = definition.childForFieldName("body");
            const outerExecution = ownExecution;
            ownExecution = false;
            if (body) visit(body);
            ownExecution = outerExecution;
            return;
          }
          notes.add("nested");
          header(node);
          return;
        }
        if (node.type === "yield" && ownExecution) yields = true;
        if (node.type === "with_statement") notes.add("context");
        if (["try_statement", "raise_statement"].includes(node.type)) notes.add("exceptions");
        if (node.type === "augmented_assignment" || node.type === "delete_statement") notes.add("mutation");
        if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression") {
          const left = node.childForFieldName(node.type === "named_expression" ? "name" : "left");
          if (left && objectTarget(left)) {
            notes.add("mutation");
            visit(left);
          }
          const right = node.childForFieldName(node.type === "named_expression" ? "value" : "right");
          if (right) visit(right);
          return;
        }
        if (node.type === "for_statement" || node.type === "for_in_clause") {
          for (const child of namedChildren(node)) if (child.id !== node.childForFieldName("left")?.id) visit(child);
          return;
        }
        if (node.type === "as_pattern") {
          for (const child of namedChildren(node)) if (child.id !== node.childForFieldName("alias")?.id) visit(child);
          return;
        }
        if (node.type === "call") {
          const callee = node.childForFieldName("function");
          const method = callee?.type === "attribute" ? callee.childForFieldName("attribute")?.text : undefined;
          if (method && MUTATOR_NAMES.has(method)) notes.add("mutation");
        }
        if (node.type === "identifier") {
          const parent = node.parent;
          if (parent?.type !== "keyword_argument" || parent.childForFieldName("name")?.id !== node.id) use(node);
          return;
        }
        if (node.type === "attribute") {
          use(node);
          // Attribute labels are not references; a nontrivial object may contain calls.
          const object = node.childForFieldName("object");
          if (object && !parts(node)) visit(object);
          return;
        }
        for (const child of namedChildren(node)) visit(child);
      };
      header(entry.node);
      ownExecution = true;
      const body = entry.definition.childForFieldName("body");
      if (body) visit(body);
      const async = entry.definition.children.some((child) => child?.type === "async");
      if (yields) notes.add(async ? "asyncGenerator" : "generator");
      else if (async) notes.add("async");
      for (const profile of profiles) notes.add(profile);
      if (profiles.size) notes.add("imports");
      return (Object.keys(NOTES) as Note[]).filter((key) => notes.has(key)).map((key) => NOTES[key]).join("\n\n") || undefined;
    });
  } catch {
    // A missing bundled parser, parser failure or unavailable inventory is not evidence.
    return undefined;
  }
}
