import type { Node as SyntaxNode } from "web-tree-sitter";
import { fingerprint } from "../../core/fingerprint";
import type { Dependency, DependencyItem, DependencyRequest, DependencyResult } from "../support";
import { javascriptSites, type JsSite } from "../javascript/dependencies";
import { javascriptFunctionNodes, javascriptSignature, withJavaScriptSyntaxTree } from "../javascript/syntax";
import { scanSvelte, svelteAnalysisSource } from "./blocks";
import { resolveSvelteImport } from "./imports";
import { componentName, componentSignature, functionEntries, withSvelteSyntaxTree } from "./syntax";

interface ImportedName {
  readonly local: string;
  readonly specifier: string;
}

function importBindings(root: SyntaxNode): ImportedName[] {
  const found: ImportedName[] = [];
  for (const statement of root.namedChildren.filter((node) => node?.type === "import_statement")) {
    if (!statement) continue;
    const text = statement.text;
    const match = /^\s*import\s+(?:type\s+)?([\s\S]+?)\s+from\s*["']([^"']+)["']/.exec(text);
    if (!match) continue;
    const clause = match[1]!.trim();
    const specifier = match[2]!;
    const named = /\{([^}]*)\}/.exec(clause)?.[1];
    if (named) {
      for (const part of named.split(",")) {
        const [original, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        if (original) found.push({ local: alias ?? original, specifier });
      }
    }
    const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
    if (namespace) found.push({ local: namespace, specifier });
    const defaultName = clause.split(",")[0]?.trim();
    if (defaultName && !defaultName.startsWith("{") && !defaultName.startsWith("*")) {
      found.push({ local: defaultName.replace(/^type\s+/, ""), specifier });
    }
  }
  return found;
}

function markupSites(source: string): JsSite[] {
  const sites: JsSite[] = [];
  const seen = new Set<string>();
  const add = (name: string, matchIndex: number, componentTag = true) => {
    if ((componentTag && !/^\p{Lu}/u.test(name)) || seen.has(name)) return;
    seen.add(name);
    const before = source.slice(0, matchIndex);
    sites.push({
      name,
      kind: "component",
      row: before.split("\n").length - 1,
      column: matchIndex - (before.lastIndexOf("\n") + 1)
    });
  };
  for (const match of source.matchAll(/<\/?([A-Z][\w.]*)\b/g)) add(match[1]!, match.index! + match[0].indexOf(match[1]!));
  const ignored = new Set(["if", "else", "each", "await", "then", "catch", "key", "snippet", "render", "html", "debug"]);
  for (const expression of source.matchAll(/\{([^{}]*)\}/g)) {
    const body = expression[1]!
      .replace(/^\s*@(?:html|render|debug)\s+/, "")
      .replace(/^\s*#(?:if|each|await|key|snippet)\s+/, "")
      .replace(/^\s*:(?:else|then|catch)\b\s*/, "")
      .replace(/^\s*\/(?:if|each|await|key|snippet)\s*/, "");
    for (const identifier of body.matchAll(/[$A-Z_a-z][$\w]*/g)) {
      const name = identifier[0]!;
      if (ignored.has(name)) continue;
      add(name, expression.index! + 1 + identifier.index!, false);
    }
  }
  return sites;
}

function itemForFunction(
  entry: ReturnType<typeof javascriptFunctionNodes>[number],
  qualifiedName: string
): DependencyItem {
  const signature = javascriptSignature(entry);
  return {
    kind: entry.kind === "method" ? "method" : "function",
    name: entry.simpleName,
    qualifiedName,
    line: entry.node.startPosition.row,
    source: entry.node.text,
    signature,
    fingerprint: fingerprint(entry.node.text),
    signatureFingerprint: fingerprint(signature.replace(/\s+/g, " ").trim())
  };
}

function componentItem(path: string, source: string): DependencyItem {
  const name = componentName(path);
  const signature = componentSignature(source, name);
  return {
    kind: "component",
    name,
    qualifiedName: name,
    line: 0,
    source: svelteAnalysisSource(source),
    signature,
    fingerprint: fingerprint(source),
    signatureFingerprint: fingerprint(signature.replace(/\s+/g, " ").trim())
  };
}

async function targetItem(path: string, source: string, name: string): Promise<DependencyItem | undefined> {
  if (/\.svelte$/i.test(path)) return componentItem(path, source);
  return withJavaScriptSyntaxTree(source, path, (root) => {
    const entry = javascriptFunctionNodes(root).find((candidate) => candidate.simpleName === name);
    return entry ? itemForFunction(entry, entry.qualifiedName) : undefined;
  });
}

function requestSites(request: DependencyRequest, scanSource: string): Promise<{
  sites: JsSite[];
  imports: ImportedName[];
  localItems: readonly { readonly name: string; readonly item: DependencyItem }[];
}> {
  const scan = scanSvelte(scanSource);
  return withSvelteSyntaxTree(scanSource, request.path, (root) => {
    const functions = functionEntries(scanSource, request.path, root);
    const selected = functions.find((candidate) =>
      candidate.entry.simpleName === request.name && candidate.entry.node.startPosition.row === request.line);
    if (selected) {
      return {
        sites: javascriptSites(selected.entry.node, selected.entry.fn, selected.entry.name),
        imports: importBindings(root),
        localItems: functions.filter((candidate) =>
          candidate.entry !== selected.entry && candidate.entry.node.startPosition.row !== request.line)
          .map(({ entry, qualifiedName }) => ({ name: entry.simpleName, item: itemForFunction(entry, qualifiedName) }))
      };
    }
    if (request.name !== componentName(request.path)) return { sites: [], imports: [], localItems: [] };
    const sites = javascriptSites(root, root, null);
    const markup = markupSites(scan.markupView);
    return {
      sites: [...new Map([...sites, ...markup].map((site) => [site.name, site])).values()],
      imports: importBindings(root),
      localItems: functions.map(({ entry, qualifiedName }) =>
        ({ name: entry.simpleName, item: itemForFunction(entry, qualifiedName) }))
    };
  }).then((result) => result ?? { sites: [], imports: [], localItems: [] });
}

/** Resolves same-file functions and bounded local imports without requiring a Svelte language server. */
export async function findSvelteDependencies(request: DependencyRequest): Promise<DependencyResult> {
  if (!scanSvelte(request.text).supported) {
    return {
      dependencies: [],
      limitations: ["Svelte dependency lookup was skipped because the component exceeds the local scanner's bounds."]
    };
  }
  const found = await requestSites(request, request.text);
  const sites = found.sites.filter((site) => request.onlyName === undefined || site.name === request.onlyName);
  const dependencies: Dependency[] = [];
  const local: Dependency[] = [];
  const seen = new Set<string>();
  const limit = request.maxDependencies ?? 24;
  const imports = new Map<string, ImportedName[]>();
  for (const binding of found.imports) imports.set(binding.local, [...(imports.get(binding.local) ?? []), binding]);
  const localItems = new Map(found.localItems.map((item) => [item.name, item.item]));

  for (const site of sites) {
    const sameFile = localItems.get(site.name);
    if (sameFile) {
      const item = sameFile;
      const key = `${request.path}\0${item.qualifiedName}`;
      if (!seen.has(key)) {
        seen.add(key);
        local.push({ path: request.path, item });
      }
      continue;
    }
    for (const binding of imports.get(site.name) ?? []) {
      const target = resolveSvelteImport(binding.specifier, {
        path: request.path,
        hasFile: (path) => request.readablePaths.has(path)
      });
      if (!target || target === request.path || !request.readablePaths.has(target)) continue;
      const source = await request.load(target);
      if (source === undefined) continue;
      const item = await targetItem(target, source, site.name);
      if (!item) continue;
      const key = `${target}\0${item.qualifiedName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({ path: target, item });
      if (dependencies.length >= limit) break;
    }
    if (dependencies.length >= limit) break;
  }
  return { dependencies, local: local.slice(0, limit), limitations: [] };
}

export async function svelteImportPreamble(source: string, path: string): Promise<string> {
  const scan = scanSvelte(source);
  if (!scan.supported) return "";
  return await withSvelteSyntaxTree(source, path, (root) =>
    root.namedChildren.filter((node) => node?.type === "import_statement" || node?.type === "export_statement")
      .map((node) => node?.text ?? "").filter(Boolean).join("\n")) ?? "";
}
