import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { cacheKey, fingerprint } from "../core/fingerprint";
import type { ContextInput, FunctionTarget, TrackedInput } from "../core/types";
import type { RepositoryInventory } from "./inventory";
import { isEligibleRelativePath } from "./inventory";
import { languageFor } from "../languages/registry";
import {
  isCallable,
  lineScanPreamble,
  UNRESOLVED_DEPENDENCIES,
  type Dependency,
  type DependencyItem,
  type DependencyRequest,
  type DependencyResult
} from "../languages/support";

export interface SourceReference {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly startCharacter: number;
  readonly endCharacter: number;
  readonly description: string;
}

export interface FunctionContext {
  readonly inputs: TrackedInput[];
  readonly sourceReferences: SourceReference[];
  readonly referenceUris: Map<string, vscode.Uri>;
  readonly text: string;
  readonly limitations: string[];
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function pathFromUri(root: string, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") return undefined;
  const file = resolve(uri.fsPath);
  if (!isWithin(root, file)) return undefined;
  return relative(root, file).split(sep).join("/");
}

function referenceId(path: string, line: number): string {
  return `r-${cacheKey([path, String(line)]).slice(0, 16)}`;
}

async function loadAllowedSource(
  inventory: RepositoryInventory,
  relativePath: string
): Promise<{ uri: vscode.Uri; text: string } | undefined> {
  if (!isEligibleRelativePath(inventory.root, relativePath)) return undefined;
  const file = inventory.files.find((item) => item.relativePath === relativePath);
  if (!file) return undefined;
  const canonical = await realpath(file.absolutePath);
  if (!isWithin(inventory.root, canonical)) return undefined;
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === "file" && resolve(document.uri.fsPath) === canonical
  );
  if (open) return { uri: open.uri, text: open.getText() };
  const size = (await stat(canonical)).size;
  if (size > 256 * 1024) return undefined;
  try {
    return { uri: vscode.Uri.file(canonical), text: await readFile(canonical, "utf8") };
  } catch {
    return undefined;
  }
}

const MAX_DEPENDENCY_ITEM_BYTES = 4 * 1024;
const MAX_DEPENDENCY_BYTES = 16 * 1024;
/** Depth 2: signatures of functions that the functions used directly call. */
const MAX_DEPTH2_SOURCES = 8;
const MAX_DEPTH2_ITEMS = 12;
const MAX_DEPTH2_BYTES = 4 * 1024;

type AddInput = (
  path: string,
  description: string,
  text: string,
  structuralHash?: string,
  tracking?: Pick<TrackedInput, "depth" | "scope">
) => void;

/** Time allowed for editor lookups of everything a function uses, at both depths. */
const DEPENDENCY_TIME_BUDGET_MS = 4_000;

function dependencyRequest(
  target: FunctionTarget,
  targetPath: string,
  document: vscode.TextDocument,
  inventory: RepositoryInventory,
  extra: Pick<DependencyRequest, "onlyName" | "deadline"> = {}
): DependencyRequest {
  const readablePaths = new Set(inventory.files.map((file) => file.relativePath));
  return {
    ...extra,
    root: inventory.root,
    path: targetPath,
    text: document.getText(),
    line: target.range.start.line,
    name: target.name,
    readablePaths,
    unreadPaths: new Set(Object.keys(inventory.snapshot).filter((path) => !readablePaths.has(path))),
    load: async (path) => (await loadAllowedSource(inventory, path))?.text
  };
}

type Resolver = (request: DependencyRequest) => Promise<DependencyResult>;

const dependencyKey = (path: string, qualifiedName: string) => `${path}\0${qualifiedName}`;

const labelOf = (item: DependencyItem) => item.label ?? `${item.kind} ${item.qualifiedName}`;

/**
 * Adds items the function uses directly (depth 1). An item is sent and
 * tracked whole when it fits the budget, by signature when only that fits,
 * and otherwise omitted with a limitation, so tracking matches what was sent.
 */
function addDependencies(
  dependencies: readonly Dependency[],
  addInput: AddInput,
  limitations: string[]
): Dependency[] {
  const sentWhole: Dependency[] = [];
  let budget = MAX_DEPENDENCY_BYTES;
  for (const { path, item } of dependencies) {
    const label = labelOf(item);
    const fullBytes = Buffer.byteLength(item.source, "utf8");
    if (fullBytes <= MAX_DEPENDENCY_ITEM_BYTES && fullBytes <= budget) {
      addInput(path, label, item.source, item.fingerprint, { depth: 1, scope: "body" });
      budget -= fullBytes;
      sentWhole.push({ path, item });
      continue;
    }
    const signatureBytes = Buffer.byteLength(item.signature, "utf8");
    if (signatureBytes <= budget) {
      addInput(path, `signature of ${label}`, item.signature, item.signatureFingerprint, { depth: 1, scope: "signature" });
      budget -= signatureBytes;
      limitations.push("Some large items this function uses are included and tracked by signature only.");
      continue;
    }
    limitations.push(
      "Some items this function uses were omitted to fit the request budget; changes to them do not mark this explanation outdated."
    );
  }
  return sentWhole;
}

/**
 * Adds depth 2: the signatures of functions and methods that the functions
 * sent whole at depth 1 call. Only signatures are sent and tracked, so a
 * changed parameter or result outdates the explanation while a rewritten body
 * does not. Items already tracked, and the explained function, are skipped.
 */
async function addDepthTwoSignatures(
  sources: readonly Dependency[],
  base: DependencyRequest,
  resolve: Resolver,
  known: Set<string>,
  addInput: AddInput,
  limitations: string[]
): Promise<void> {
  let budget = MAX_DEPTH2_BYTES;
  let count = 0;
  let dropped = false;
  for (const { path, item } of sources.filter(({ item }) => isCallable(item)).slice(0, MAX_DEPTH2_SOURCES)) {
    const text = path === base.path ? base.text : await base.load(path);
    if (text === undefined) continue;
    const found = await resolve({ ...base, path, text, line: item.line, name: item.name }).catch(() => undefined);
    for (const next of found?.dependencies ?? []) {
      if (!isCallable(next.item)) continue;
      const key = dependencyKey(next.path, next.item.qualifiedName);
      if (known.has(key)) continue;
      known.add(key);
      const bytes = Buffer.byteLength(next.item.signature, "utf8");
      if (count >= MAX_DEPTH2_ITEMS || bytes > budget) {
        dropped = true;
        continue;
      }
      addInput(
        next.path,
        `signature of ${next.item.kind} ${next.item.qualifiedName}, used by ${item.qualifiedName}`,
        next.item.signature,
        next.item.signatureFingerprint,
        { depth: 2, scope: "signature" }
      );
      budget -= bytes;
      count++;
    }
  }
  if (dropped) {
    limitations.push("Some functions that this function's helpers call were left out to fit the request budget; changes to them are not tracked.");
  }
}

export interface CalledFunction {
  /** Repository-relative path of the file that defines it. */
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  /** Zero-based line where its declaration starts. */
  readonly line: number;
}

/**
 * Functions and methods a function calls directly, in order of first use,
 * including ones in the same file. Uses the bundled analysis for its
 * language, or the editor's go-to-definition for other languages. With
 * `onlyName`, other calls may be left out. Local analysis only.
 */
export async function findCalledFunctions(
  target: FunctionTarget,
  document: vscode.TextDocument,
  inventory: RepositoryInventory,
  onlyName?: string
): Promise<CalledFunction[]> {
  const targetPath = pathFromUri(inventory.root, target.uri);
  if (!targetPath) return [];
  const found = await languageFor({ languageId: target.languageId, path: targetPath })
    .findDependencies(dependencyRequest(target, targetPath, document, inventory, onlyName === undefined ? {} : { onlyName }));
  return [...found.dependencies, ...(found.local ?? [])]
    .filter(({ item }) => isCallable(item))
    .map(({ path, item }) => ({ path, name: item.name, qualifiedName: item.qualifiedName, line: item.line }));
}

export async function gatherFunctionContext(
  target: FunctionTarget,
  document: vscode.TextDocument,
  inventory: RepositoryInventory
): Promise<FunctionContext> {
  const inputs: TrackedInput[] = [];
  const sourceReferences: SourceReference[] = [];
  const referenceUris = new Map<string, vscode.Uri>();
  const limitations = [...inventory.limitations];
  const targetPath = pathFromUri(inventory.root, target.uri);
  if (!targetPath) throw new Error("The selected function is outside the selected repository root.");
  const lineUris = new Map<string, string>();
  const contextSnippets = new Map<string, string>();

  const addInput = (
    path: string,
    description: string,
    text: string,
    structuralHash?: string,
    tracking: Pick<TrackedInput, "depth" | "scope"> = {}
  ) => {
    inputs.push({
      path,
      description,
      fingerprint: structuralHash ?? fingerprint(text),
      ...tracking
    });
    contextSnippets.set(`${path}\0${description}`, `--- ${path} (${description}) ---\n${text}`);
  };

  addInput(
    targetPath,
    `selected ${target.qualifiedName}`,
    target.source,
    target.structuralFingerprint,
    { depth: 0 }
  );

  const language = languageFor({ languageId: target.languageId, path: targetPath });
  const request = dependencyRequest(target, targetPath, document, inventory, {
    deadline: Date.now() + DEPENDENCY_TIME_BUDGET_MS
  });
  const found: DependencyResult = await language.findDependencies(request)
    .catch(() => ({ dependencies: [], limitations: [UNRESOLVED_DEPENDENCIES] }));
  const preamble = found.preamble ??
    (language.preamble ? await language.preamble(request.text, request.path).catch(() => "") : lineScanPreamble(request.text));
  if (preamble) addInput(targetPath, "module imports and declarations", preamble);
  const local = found.local ?? [];
  for (const { path, item } of local) {
    addInput(path, labelOf(item), item.source, item.fingerprint, { depth: 1 });
  }
  limitations.push(...found.limitations);
  const sentWhole = addDependencies(found.dependencies, addInput, limitations);
  const known = new Set([
    dependencyKey(targetPath, target.qualifiedName),
    ...[...local, ...found.dependencies].map(({ path, item }) => dependencyKey(path, item.qualifiedName))
  ]);
  await addDepthTwoSignatures(
    [...local, ...sentWhole],
    request,
    (next) => language.findDependencies(next),
    known,
    addInput,
    limitations
  );

  let languageLocations: vscode.Location[] = [];
  try {
    languageLocations =
      (await Promise.race([
        vscode.commands.executeCommand<vscode.Location[] | undefined>(
          "vscode.executeReferenceProvider",
          target.uri,
          target.selection.start
        ),
        new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 1_800))
      ])) ?? [];
  } catch {
    limitations.push("The editor's reference provider was unavailable; related callers may be missing.");
  }

  for (const location of languageLocations.slice(0, 20)) {
    const path = pathFromUri(inventory.root, location.uri);
    if (!path || path === targetPath || lineUris.has(`${path}:${location.range.start.line}`)) continue;
    const loaded = await loadAllowedSource(inventory, path);
    if (!loaded) {
      limitations.push("Some editor references pointed to excluded or unindexed files.");
      continue;
    }
    const id = referenceId(path, location.range.start.line);
    lineUris.set(`${path}:${location.range.start.line}`, id);
    referenceUris.set(id, loaded.uri);
    const start = Math.max(0, location.range.start.line - 2);
    const end = Math.min(loaded.text.split(/\r?\n/).length, location.range.end.line + 3);
    const excerpt = loaded.text.split(/\r?\n/).slice(start, end).join("\n");
    const relativeLine = location.range.start.line;
    sourceReferences.push({
      id,
      path,
      line: relativeLine,
      startCharacter: location.range.start.character,
      endCharacter: location.range.end.character,
      description: `Reference to ${target.name}`
    });
    addInput(path, `reference to ${target.name} near line ${relativeLine + 1}`, excerpt);
  }
  if (languageLocations.length === 0) {
    limitations.push("No related callers were resolved by VS Code language tooling.");
  }

  const targetReference: SourceReference = {
    id: "selected-function",
    path: targetPath,
    line: target.range.start.line,
    startCharacter: target.selection.start.character,
    endCharacter: target.selection.end.character,
    description: `Selected function ${target.qualifiedName}`
  };
  sourceReferences.unshift(targetReference);
  referenceUris.set(targetReference.id, target.uri);

  const normalizedInputs = [...new Map(
    inputs.map((input) => [`${input.path}\0${input.description}`, input])
  ).values()];
  const text = [...contextSnippets.values()].join("\n\n");
  return {
    inputs: normalizedInputs,
    sourceReferences,
    referenceUris,
    text,
    limitations: [...new Set(limitations)]
  };
}
