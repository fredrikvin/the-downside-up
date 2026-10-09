import { resolve } from "node:path";
import type { Node as SyntaxNode } from "web-tree-sitter";
import * as vscode from "vscode";
import { resolveSites, type LookupSite } from "../editor/dependencies";
import type { DependencyRequest, DependencyResult } from "../support";
import { namedChildren } from "../treeSitter";
import { javascriptDeclarationAt, javascriptFunctionNodes, javascriptPosition, withJavaScriptSyntaxTree } from "./syntax";

/** Components, hooks, and types add to plain calls, so JavaScript looks up more names than other languages. */
const MAX_LOOKUPS = 40;
/** How long to wait for VS Code's TypeScript server to load a repository's project. */
const WARM_UP_MS = 15_000;
const WARM_UP_RETRY_MS = 300;

export const TYPESCRIPT_LOADING =
  "VS Code's TypeScript language features were still loading the project, so some things this function uses may be missing.";

const readyRoots = new Set<string>();
const gaveUpRoots = new Set<string>();

/** Forgets which repositories TypeScript has loaded, so tests can start from a cold session. */
export function resetTypeScriptReadiness(): void {
  readyRoots.clear();
  gaveUpRoots.clear();
}

type Definitions = Array<vscode.Location | vscode.LocationLink>;

/**
 * Waits until VS Code's TypeScript server has loaded the repository's
 * project. While it loads, a syntax-only server answers go-to-definition
 * within a file, so an imported name leads only to its `import` line. The
 * probe is a name imported from a relative path: once it leads elsewhere,
 * cross-file definitions work. Without this, a function explained right
 * after VS Code starts would be saved without what it uses and shown as
 * outdated once the project has loaded. A repository that never answers is
 * only waited for once.
 */
async function waitForTypeScript(
  root: string,
  uri: vscode.Uri,
  probe: vscode.Position,
  isImportLine: (line: number) => boolean
): Promise<boolean> {
  if (readyRoots.has(root)) return true;
  const deadline = Date.now() + (gaveUpRoots.has(root) ? 0 : WARM_UP_MS);
  await Promise.race([
    Promise.resolve(vscode.extensions.getExtension("vscode.typescript-language-features")?.activate()).catch(() => undefined),
    new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, deadline - Date.now())))
  ]);
  for (;;) {
    const result = await Promise.race([
      Promise.resolve(vscode.commands.executeCommand<Definitions | undefined>("vscode.executeDefinitionProvider", uri, probe))
        .catch(() => undefined),
      new Promise<undefined>((resolveWait) => setTimeout(() => resolveWait(undefined), Math.max(1, deadline - Date.now())))
    ]);
    const first = result?.[0];
    if (first) {
      const target = "targetUri" in first ? first.targetUri : first.uri;
      const line = ("targetUri" in first ? (first.targetSelectionRange ?? first.targetRange) : first.range).start.line;
      if (target.toString() !== uri.toString() || !isImportLine(line)) {
        readyRoots.add(root);
        gaveUpRoots.delete(root);
        return true;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, WARM_UP_RETRY_MS));
  }
  gaveUpRoots.add(root);
  return false;
}

/** Local names bound by imports from relative or aliased paths, and the lines of all imports. */
function importsOf(root: SyntaxNode): { names: Set<string>; lines: Set<number> } {
  const names = new Set<string>();
  const lines = new Set<number>();
  for (const statement of namedChildren(root).filter((node) => node.type === "import_statement")) {
    for (let line = statement.startPosition.row; line <= statement.endPosition.row; line++) lines.add(line);
    const source = statement.childForFieldName("source")?.text.replace(/^["']|["']$/g, "") ?? "";
    if (!/^(?:\.{1,2}\/|\/|@\/|~\/)/.test(source)) continue;
    const visit = (node: SyntaxNode) => {
      if (node.type === "identifier" && node.parent?.type !== "import_specifier") names.add(node.text);
      else if (node.type === "import_specifier") names.add((node.childForFieldName("alias") ?? node.childForFieldName("name"))?.text ?? "");
      else if (node.type !== "string") namedChildren(node).forEach(visit);
    };
    visit(statement);
  }
  return { names, lines };
}

export interface JsSite {
  readonly name: string;
  readonly kind: "call" | "component" | "type";
  /** Zero-based row and UTF-16 column of the name. */
  readonly row: number;
  readonly column: number;
}

/** The name node a call or JSX tag refers to: `persist`, `api.save` gives `save`, `<Cart.Item>` gives `Item`. */
function calledName(node: SyntaxNode | null): SyntaxNode | undefined {
  if (!node) return undefined;
  if (node.type === "identifier") return node;
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property");
    return property?.type === "property_identifier" ? property : undefined;
  }
  if (node.type === "nested_identifier") return namedChildren(node).at(-1);
  return undefined;
}

/**
 * Names a function uses that may be defined elsewhere, first use of each in
 * source order: calls, capitalized JSX tags (the components it renders), and
 * type names. Its own name and its type parameters are skipped.
 */
export function javascriptSites(declaration: SyntaxNode, fn: SyntaxNode, ownName: SyntaxNode | null): JsSite[] {
  const typeParameters = new Set(
    namedChildren(fn.childForFieldName("type_parameters") ?? fn)
      .filter((entry) => entry.type === "type_parameter")
      .map((entry) => entry.childForFieldName("name")?.text)
  );
  const sites: JsSite[] = [];
  const seen = new Set<string>();
  const add = (node: SyntaxNode | undefined, kind: JsSite["kind"]) => {
    if (!node || seen.has(node.text) || (ownName && node.startIndex === ownName.startIndex)) return;
    seen.add(node.text);
    sites.push({ name: node.text, kind, row: node.startPosition.row, column: node.startPosition.column });
  };
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case "call_expression":
        add(calledName(node.childForFieldName("function")), "call");
        break;
      case "jsx_opening_element":
      case "jsx_self_closing_element": {
        const name = node.childForFieldName("name");
        const target = calledName(name);
        // Lowercase tags such as `<div>` are HTML elements, not components.
        if (target && /^\p{Lu}/u.test(target.text)) add(target, "component");
        break;
      }
      case "type_identifier":
        if (!typeParameters.has(node.text)) add(node, "type");
        break;
    }
    for (const child of namedChildren(node)) visit(child);
  };
  visit(declaration);
  return sites;
}

/**
 * Items a JavaScript or TypeScript function uses: the functions, hooks, and
 * methods it calls, the components it renders, and the types it names, each
 * resolved with the editor's go-to-definition (built in for these languages)
 * and read with the bundled grammar.
 */
export async function findJavaScriptDependencies(request: DependencyRequest): Promise<DependencyResult> {
  const found = await withJavaScriptSyntaxTree(request.text, request.path, (root) => {
    const functions = javascriptFunctionNodes(root);
    const entry = functions.find((candidate) => candidate.node.startPosition.row === request.line && candidate.simpleName === request.name) ??
      functions.find((candidate) => candidate.simpleName === request.name);
    if (!entry) return undefined;
    const imports = importsOf(root);
    const sites = javascriptSites(entry.node, entry.fn, entry.name)
      .map((site) => ({ name: site.name, position: javascriptPosition(site) }));
    return {
      start: javascriptPosition(entry.node.startPosition),
      end: javascriptPosition(entry.node.endPosition),
      sites,
      imports
    };
  });
  if (!found) return { dependencies: [], limitations: [] };
  const sites: LookupSite[] = found.sites.filter((site) => request.onlyName === undefined || site.name === request.onlyName);
  if (sites.length === 0) return { dependencies: [], limitations: [] };
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(request.root, request.path)));
  // Without imports from the repository, same-file definitions work before the project has loaded.
  const imported = (site: LookupSite) => found.imports.names.has(site.name);
  const probe = (sites.find(imported) ?? found.sites.find(imported))?.position;
  const ready = !probe || await waitForTypeScript(request.root, document.uri, probe, (line) => found.imports.lines.has(line));
  const result = await resolveSites(request, {
    document,
    range: new vscode.Range(found.start, found.end),
    sites,
    maxLookups: MAX_LOOKUPS,
    async itemAt({ path, position, text }) {
      return withJavaScriptSyntaxTree(text, path, (root) => javascriptDeclarationAt(root, position.line, position.character));
    }
  });
  return ready ? result : { ...result, limitations: [...result.limitations, TYPESCRIPT_LOADING] };
}
