import { posix } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import { fingerprint } from "../core/fingerprint";
import { rustSignature, rustStructuralTokens, withRustSyntaxTree } from "../languages/rust";

/**
 * Depth-1 cross-file dependencies for a Rust function, found with Tree-sitter
 * and Cargo's file-layout conventions (no compiler or language server).
 */

export type RustItemKind =
  | "function"
  | "method"
  | "struct"
  | "enum"
  | "union"
  | "trait"
  | "type alias"
  | "constant"
  | "static";

export interface RustItem {
  readonly kind: RustItemKind;
  readonly name: string;
  /** Base type name of the `impl` block that holds a method. */
  readonly owner?: string;
  readonly qualifiedName: string;
  /** Inline `mod` blocks enclosing the item inside its file. */
  readonly modules: readonly string[];
  readonly source: string;
  readonly signature: string;
  readonly fingerprint: string;
  readonly signatureFingerprint: string;
}

export interface RustDependency {
  readonly path: string;
  readonly item: RustItem;
}

export interface RustDependencyRequest {
  /** Repository-relative path of the file that holds the function. */
  readonly path: string;
  readonly text: string;
  /** Zero-based line where the function item starts. */
  readonly line: number;
  readonly name: string;
  /** Repository-relative paths whose content can be loaded. */
  readonly readablePaths: ReadonlySet<string>;
  /** Repository-relative paths known to exist but not read (budget or size). */
  readonly unreadPaths?: ReadonlySet<string>;
  readonly load: (path: string) => Promise<string | undefined>;
  readonly maxDependencies?: number;
}

export interface RustDependencyResult {
  readonly dependencies: RustDependency[];
  readonly limitations: string[];
}

interface UseBinding {
  readonly local: string;
  readonly path: readonly string[];
  readonly scope: string;
}

interface GlobImport {
  readonly path: readonly string[];
  readonly scope: string;
}

interface FunctionUsage {
  readonly scope: readonly string[];
  readonly bindings: UseBinding[];
  readonly globs: GlobImport[];
  readonly names: string[];
  readonly paths: string[][];
  readonly methods: string[];
}

interface CrateLayout {
  /** Directory holding the crate root file and its child module files. */
  readonly rootDir: string;
  readonly rootFile: string | undefined;
}

interface ModuleLocation {
  readonly file: string;
  readonly inline: readonly string[];
}

const ITEM_KINDS: Record<string, RustItemKind> = {
  struct_item: "struct",
  enum_item: "enum",
  union_item: "union",
  trait_item: "trait",
  type_item: "type alias",
  const_item: "constant",
  static_item: "static",
  function_item: "function"
};
const TYPE_KINDS = new Set<RustItemKind>(["struct", "enum", "union", "trait", "type alias"]);
const DEFAULT_MAX_DEPENDENCIES = 16;

const scopeKey = (path: readonly string[]): string => path.join("::");

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((entry): entry is SyntaxNode => entry !== null);
}

/** Splits `a::b::<T>::C<U>` into `["a", "b", "C"]`. */
function segments(text: string): string[] {
  let value = text;
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(/<[^<>]*>/g, "");
  }
  return value.split("::").map((part) => part.trim()).filter(Boolean);
}

function typeBaseName(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  const parts = segments(node.text.replace(/^&\s*(?:mut\s+)?/, ""));
  return parts[parts.length - 1];
}

function collectUses(
  node: SyntaxNode,
  prefix: readonly string[],
  scope: string,
  bindings: UseBinding[],
  globs: GlobImport[]
): void {
  switch (node.type) {
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      const alias = node.childForFieldName("alias");
      if (path && alias) bindings.push({ local: alias.text, path: [...prefix, ...segments(path.text)], scope });
      return;
    }
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const list = node.childForFieldName("list");
      if (list) collectUses(list, path ? [...prefix, ...segments(path.text)] : prefix, scope, bindings, globs);
      return;
    }
    case "use_list":
      for (const entry of named(node)) collectUses(entry, prefix, scope, bindings, globs);
      return;
    case "use_wildcard":
      globs.push({ path: [...prefix, ...segments(node.text.replace(/::\s*\*\s*$/, "").replace(/^\*$/, ""))], scope });
      return;
    case "self":
      if (prefix.length > 0) bindings.push({ local: prefix[prefix.length - 1]!, path: [...prefix], scope });
      return;
    default: {
      const path = [...prefix, ...segments(node.text)];
      if (path[path.length - 1] === "self") path.pop();
      const local = path[path.length - 1];
      if (local) bindings.push({ local, path, scope });
    }
  }
}

function usesIn(container: SyntaxNode, scope: string, bindings: UseBinding[], globs: GlobImport[]): void {
  for (const entry of named(container)) {
    if (entry.type !== "use_declaration") continue;
    const argument = entry.childForFieldName("argument");
    if (argument) collectUses(argument, [], scope, bindings, globs);
  }
}

function findFunctionNode(root: SyntaxNode, line: number, name: string): SyntaxNode | undefined {
  let found: SyntaxNode | undefined;
  const visit = (node: SyntaxNode) => {
    if (found || node.startPosition.row > line || node.endPosition.row < line) return;
    if (node.type === "function_item" && node.startPosition.row === line &&
      node.childForFieldName("name")?.text === name) {
      found = node;
      return;
    }
    for (const entry of named(node)) visit(entry);
  };
  visit(root);
  return found;
}

function functionUsage(root: SyntaxNode, fn: SyntaxNode, fileModule: readonly string[]): FunctionUsage {
  const inline: string[] = [];
  const containers: Array<{ node: SyntaxNode; scope: readonly string[] }> = [];
  for (let parent = fn.parent; parent; parent = parent.parent) {
    if (parent.type === "mod_item") {
      const name = parent.childForFieldName("name")?.text;
      const body = parent.childForFieldName("body");
      if (name) inline.unshift(name);
      if (body) containers.push({ node: body, scope: [] });
    }
  }
  const scope = [...fileModule, ...inline];
  const bindings: UseBinding[] = [];
  const globs: GlobImport[] = [];
  usesIn(root, scopeKey(fileModule), bindings, globs);
  // Each enclosing inline module's own `use` declarations, outermost first.
  containers.reverse().forEach(({ node }, index) =>
    usesIn(node, scopeKey([...fileModule, ...inline.slice(0, index + 1)]), bindings, globs)
  );
  const names: string[] = [];
  const paths: string[][] = [];
  const methods: string[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const seenMethods = new Set<string>();
  const visit = (node: SyntaxNode) => {
    if (node.type === "token_tree") {
      // Macro arguments are raw tokens: recover `.method(` calls and `a::b` paths.
      const tokens = node.children.filter((entry): entry is SyntaxNode => entry !== null);
      tokens.forEach((token, index) => {
        if (token.type === "identifier" && tokens[index - 1]?.type === "." &&
          tokens[index + 1]?.type === "token_tree" && tokens[index + 1]!.text.startsWith("(") &&
          !seenMethods.has(token.text)) {
          seenMethods.add(token.text);
          methods.push(token.text);
        }
        if (tokens[index + 1]?.type === "::" && tokens[index - 1]?.type !== "::" && /^[A-Za-z_]/.test(token.text)) {
          const path = [token.text];
          for (let next = index + 2; tokens[next] && /^[A-Za-z_]/.test(tokens[next]!.text); next += 2) {
            path.push(tokens[next]!.text);
            if (tokens[next + 1]?.type !== "::") break;
          }
          const key = scopeKey(path);
          if (path.length > 1 && !seenPaths.has(key)) {
            seenPaths.add(key);
            paths.push(path);
          }
        }
      });
    }
    if (node.type === "use_declaration") {
      const argument = node.childForFieldName("argument");
      if (argument) collectUses(argument, [], scopeKey(scope), bindings, globs);
      return;
    }
    if (node.type === "scoped_identifier" || node.type === "scoped_type_identifier") {
      if (node.childForFieldName("path")?.type === "bracketed_type") return;
      const path = segments(node.text);
      const key = scopeKey(path);
      if (path.length > 1 && !seenPaths.has(key)) {
        seenPaths.add(key);
        paths.push(path);
      }
      for (const entry of named(node)) if (entry.type === "type_arguments") visit(entry);
      return;
    }
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const field = callee?.type === "field_expression" ? callee.childForFieldName("field") : null;
      if (field && !seenMethods.has(field.text)) {
        seenMethods.add(field.text);
        methods.push(field.text);
      }
    }
    if ((node.type === "identifier" || node.type === "type_identifier") && !seenNames.has(node.text)) {
      seenNames.add(node.text);
      names.push(node.text);
    }
    for (const entry of named(node)) visit(entry);
  };
  for (const field of ["parameters", "return_type", "body", "type_parameters"]) {
    const part = fn.childForFieldName(field);
    if (part) visit(part);
  }
  return { scope, bindings, globs, names, paths, methods };
}

function fileItems(root: SyntaxNode): RustItem[] {
  const items: RustItem[] = [];
  const visit = (node: SyntaxNode, modules: readonly string[], impl?: { owner: string; trait?: string }) => {
    // Attributes such as `#[derive(Default)]` are part of an item's meaning.
    let attributes: SyntaxNode[] = [];
    for (const entry of named(node)) {
      if (entry.type === "attribute_item") {
        attributes.push(entry);
        continue;
      }
      const leading = attributes;
      attributes = [];
      if (entry.type === "mod_item") {
        const name = entry.childForFieldName("name")?.text;
        const body = entry.childForFieldName("body");
        if (name && body) visit(body, [...modules, name]);
        continue;
      }
      if (entry.type === "impl_item") {
        const owner = typeBaseName(entry.childForFieldName("type"));
        const body = entry.childForFieldName("body");
        const trait = entry.childForFieldName("trait")?.text;
        if (owner && body) visit(body, modules, { owner, ...(trait ? { trait } : {}) });
        continue;
      }
      const kind = ITEM_KINDS[entry.type];
      const name = entry.childForFieldName("name")?.text;
      if (!kind || !name) continue;
      const isMethod = kind === "function" && impl !== undefined;
      const signature = kind === "function" ? rustSignature(entry) : entry.text.split("{")[0]!.trim();
      const container = impl ? (impl.trait ? `<${impl.owner} as ${impl.trait}>` : impl.owner) : undefined;
      items.push({
        kind: isMethod ? "method" : kind,
        name,
        ...(impl ? { owner: impl.owner } : {}),
        qualifiedName: [...modules, ...(container ? [container] : []), name].join("::"),
        modules,
        source: [...leading.map((attribute) => attribute.text), entry.text].join("\n"),
        signature,
        fingerprint: fingerprint([...leading, entry].map(rustStructuralTokens).join("")),
        signatureFingerprint: fingerprint(signature.replace(/\s+/g, " "))
      });
    }
  };
  visit(root, []);
  return items;
}

function packageName(cargoToml: string): string | undefined {
  const section = /^\s*\[package\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(cargoToml)?.[1] ?? "";
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(section)?.[1]?.replace(/-/g, "_");
}

export async function findRustDependencies(request: RustDependencyRequest): Promise<RustDependencyResult> {
  const limitations = new Set<string>();
  const max = request.maxDependencies ?? DEFAULT_MAX_DEPENDENCIES;
  const exists = (path: string) => request.readablePaths.has(path);
  const noteUnread = (path: string) => {
    if (request.unreadPaths?.has(path)) {
      limitations.add(`${path} was not read within the scan budget, so items used from it are not tracked.`);
    }
  };

  // Cargo layout: the nearest Cargo.toml above the file decides the crate.
  let crateDir: string | undefined;
  for (let dir = posix.dirname(request.path); ; dir = posix.dirname(dir)) {
    const manifest = dir === "." ? "Cargo.toml" : `${dir}/Cargo.toml`;
    if (exists(manifest)) {
      crateDir = dir === "." ? "" : dir;
      break;
    }
    if (dir === "." || dir === "/" || dir === "") break;
  }
  const join = (...parts: string[]) => parts.filter(Boolean).join("/");
  const srcDir = crateDir === undefined ? posix.dirname(request.path) : join(crateDir, "src");
  if (crateDir === undefined) {
    limitations.add("No Cargo.toml was found above this file; module paths were resolved from its folder.");
  }
  const manifestText = crateDir === undefined ? undefined : await request.load(join(crateDir, "Cargo.toml"));
  const libName = manifestText ? packageName(manifestText) : undefined;
  const libRoot = exists(join(srcDir, "lib.rs")) ? join(srcDir, "lib.rs") : undefined;
  const fileName = posix.basename(request.path);
  const inSrc = request.path.startsWith(`${srcDir}/`) && !request.path.startsWith(`${srcDir}/bin/`);
  const isRootFile = !inSrc || (posix.dirname(request.path) === srcDir && (fileName === "main.rs" || fileName === "lib.rs"));

  const crate: CrateLayout = isRootFile
    ? { rootDir: posix.dirname(request.path) === "." ? "" : posix.dirname(request.path), rootFile: request.path }
    : { rootDir: srcDir, rootFile: libRoot ?? (exists(join(srcDir, "main.rs")) ? join(srcDir, "main.rs") : undefined) };
  const libCrate: CrateLayout | undefined = !inSrc && libRoot ? { rootDir: srcDir, rootFile: libRoot } : undefined;
  const fileModule = isRootFile
    ? []
    : request.path.slice(srcDir.length + 1).replace(/\.rs$/, "").split("/").filter((part, index, all) =>
        !(part === "mod" && index === all.length - 1)
      );

  const moduleFile = (layout: CrateLayout, path: readonly string[]): string | undefined => {
    if (path.length === 0) return layout.rootFile;
    const dir = join(layout.rootDir, ...path.slice(0, -1));
    const last = path[path.length - 1]!;
    const candidates = [join(dir, `${last}.rs`), join(dir, last, "mod.rs")];
    const found = candidates.find(exists);
    if (!found) candidates.forEach(noteUnread);
    return found;
  };
  /** Longest prefix stored in its own file; the rest are inline `mod` blocks. */
  const locate = (layout: CrateLayout, path: readonly string[]): ModuleLocation | undefined => {
    for (let length = path.length; length >= 0; length--) {
      const file = moduleFile(layout, path.slice(0, length));
      if (file) return { file, inline: path.slice(length) };
    }
    return undefined;
  };
  const isModule = (layout: CrateLayout, path: readonly string[]) => moduleFile(layout, path) !== undefined;

  /** Resolves a path's leading segments to an absolute module path, or undefined for external crates. */
  const absolute = (path: readonly string[], scope: readonly string[]): { layout: CrateLayout; path: string[] } | undefined => {
    const [first, ...rest] = path;
    if (first === undefined) return undefined;
    if (first === "crate") return { layout: crate, path: rest };
    if (first === "self") return { layout: crate, path: [...scope, ...rest] };
    if (first === "super") {
      let base = scope.slice(0, -1);
      while (rest[0] === "super") {
        rest.shift();
        base = base.slice(0, -1);
      }
      return { layout: crate, path: [...base, ...rest] };
    }
    if (libCrate && first === libName) return { layout: libCrate, path: rest };
    // Rust 2018 paths may start with a child module of the current scope.
    if (isModule(crate, [...scope, first])) return { layout: crate, path: [...scope, ...path] };
    return undefined;
  };

  const parsed = new Map<string, RustItem[]>();
  const itemsIn = async (file: string): Promise<RustItem[]> => {
    const cached = parsed.get(file);
    if (cached) return cached;
    const text = file === request.path ? request.text : await request.load(file);
    const items = text === undefined ? [] : (await withRustSyntaxTree(text, fileItems)) ?? [];
    parsed.set(file, items);
    return items;
  };

  const usage = await withRustSyntaxTree(request.text, (root) => {
    const fn = findFunctionNode(root, request.line, request.name);
    return fn ? functionUsage(root, fn, fileModule) : undefined;
  });
  if (!usage) return { dependencies: [], limitations: [...limitations] };

  const dependencies: RustDependency[] = [];
  const added = new Set<string>();
  const ownerTypes: Array<{ file: string; name: string }> = [];
  const add = (file: string, item: RustItem): void => {
    if (file === request.path) return;
    const key = `${file}\0${item.kind}\0${item.qualifiedName}`;
    if (added.has(key)) return;
    if (dependencies.length >= max) {
      limitations.add(`Only the first ${max} cross-file items used by this function are tracked.`);
      return;
    }
    added.add(key);
    dependencies.push({ path: file, item });
    if (TYPE_KINDS.has(item.kind)) ownerTypes.push({ file, name: item.name });
  };

  /** Finds `name` (or `owner::name`) inside a located module. */
  const findItem = async (location: ModuleLocation, name: string, owner?: string): Promise<RustItem | undefined> => {
    const items = await itemsIn(location.file);
    const inModule = items.filter((item) => scopeKey(item.modules) === scopeKey(location.inline));
    return owner
      ? inModule.find((item) => item.kind === "method" && item.owner === owner && item.name === name)
      : inModule.find((item) => item.owner === undefined && item.name === name);
  };

  const scope = scopeKey(usage.scope);
  const visibleScopes = new Set([scope]);
  for (const glob of usage.globs.filter((entry) => entry.scope === scope)) {
    const target = absolute(glob.path, usage.scope);
    if (target && target.layout === crate) visibleScopes.add(scopeKey(target.path));
  }
  const bindingFor = (local: string): UseBinding | undefined =>
    usage.bindings.find((binding) => binding.local === local && binding.scope === scope) ??
    usage.bindings.find((binding) => binding.local === local && visibleScopes.has(binding.scope));
  const scopeOf = (binding: UseBinding) => binding.scope === "" ? [] : binding.scope.split("::");

  /** Resolves a full path to an item, also trying `Type::member` as a type plus method. */
  const resolvePath = async (path: readonly string[], from: readonly string[]): Promise<void> => {
    const resolved = absolute(path, from);
    if (!resolved || resolved.path.length === 0) return;
    const { layout, path: full } = resolved;
    const item = full[full.length - 1]!;
    const location = locate(layout, full.slice(0, -1));
    const direct = location && await findItem(location, item);
    if (location && direct) {
      add(location.file, direct);
      return;
    }
    if (full.length < 2) return;
    const owner = full[full.length - 2]!;
    const ownerLocation = locate(layout, full.slice(0, -2));
    if (!ownerLocation) return;
    const type = await findItem(ownerLocation, owner);
    if (!type) return;
    add(ownerLocation.file, type);
    const method = await findItem(ownerLocation, item, owner);
    if (method) add(ownerLocation.file, method);
  };

  const expand = (path: readonly string[]): { path: string[]; from: readonly string[] } => {
    const binding = bindingFor(path[0]!);
    return binding
      ? { path: [...binding.path, ...path.slice(1)], from: scopeOf(binding) }
      : { path: [...path], from: usage.scope };
  };

  for (const path of usage.paths) {
    const { path: full, from } = expand(path);
    await resolvePath(full, from);
  }
  for (const name of usage.names) {
    const binding = bindingFor(name);
    if (binding) {
      await resolvePath(binding.path, scopeOf(binding));
      continue;
    }
    for (const visible of visibleScopes) {
      if (visible === scope) continue;
      const location = locate(crate, visible === "" ? [] : visible.split("::"));
      const item = location && await findItem(location, name);
      if (location && item) add(location.file, item);
    }
    for (const glob of usage.globs.filter((entry) => entry.scope === scope)) {
      const target = absolute(glob.path, usage.scope);
      const location = target && locate(target.layout, target.path);
      const item = location && location.file !== request.path && await findItem(location, name);
      if (location && item) add(location.file, item);
    }
  }
  // Method calls on values: the receiver type is unknown, so match methods of the used types.
  for (const method of usage.methods) {
    for (const owner of [...ownerTypes]) {
      const items = await itemsIn(owner.file);
      for (const item of items) {
        if (item.kind === "method" && item.owner === owner.name && item.name === method) add(owner.file, item);
      }
    }
  }
  return { dependencies, limitations: [...limitations] };
}
