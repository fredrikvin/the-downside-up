import { basename, extname, relative, sep } from "node:path";
import * as vscode from "vscode";
import { inputsMatch, explanationCacheKey } from "./cache/freshness";
import type { RepositoryCacheStore } from "./cache/store";
import { cachedUsage, type CachedUsage } from "./cache/usage";
import { cacheKey, fingerprint } from "./core/fingerprint";
import type {
  ExplanationFormat,
  ComparisonRecord,
  ComparisonSideRecord,
  ComparisonSpan,
  ExplanationRecord,
  FileComparison,
  FileSummaryRecord,
  FolderSummary,
  FolderSummaryRecord,
  ProjectFlow,
  ProjectFlowsDraft,
  ProjectFlowsRecord,
  FunctionExplanation,
  FunctionTarget,
  GenerationResult,
  OverviewRecord,
  ProjectMap,
  ProjectMapDetail,
  ProjectMapRecord,
  ProviderKind,
  RepositoryCache,
  RepositoryOverview,
  RepositoryPriming,
  Usage
} from "./core/types";
import { comparisonProblem, describeIdentity, type ComparisonSnapshot, type SideSnapshot } from "./context/comparison";
import { gatherInventory, sharingExclusion, type RepositoryInventory } from "./context/inventory";
import { checkedProjectMap, outlineText } from "./context/projectMap";
import {
  gatherFunctionContext,
  type FunctionContext
} from "./context/related";
import { addLocalSymbolOutline } from "./context/symbolIndex";
import { currentPolicy } from "./context/policy";
import { bundledLanguageIdForPath, languageFor, sourceFingerprint } from "./languages/registry";
import { normalizeStepLines } from "./presentation/stepLines";
import {
  COMPARISON_PROMPT_VERSION,
  comparisonPrompt,
  EXPLANATION_PROMPT_VERSION,
  explanationPrompt,
  fileSummaryPrompt,
  FOLDER_PROMPT_VERSION,
  folderSummaryPrompt,
  partFlowsPrompt,
  projectFlowsPrompt,
  formatPrompt,
  overviewPrompt,
  PROMPT_VERSION,
  reviewPrompt
} from "./generation/prompts";
import type {
  ComparisonPromptInput,
  ExplanationPromptInput,
  FileSummaryPromptInput,
  FlowCatalogEntry,
  FolderSummaryPromptInput,
  PartFlowsPromptInput,
  ProjectFlowsPromptInput,
  FormatPromptInput,
  GenerationProvider,
  OverviewReviewPromptInput,
  RepositoryPromptInput
} from "./generation/provider";

/**
 * What a folder's main flows are made from: a catalog of files and
 * functions (modules and plain folders), or the project map's parts
 * (project, groups, and components). `paths` gives each part's folder, so
 * flow steps can open it.
 */
export type FlowsRequest =
  | { readonly kind: "files"; readonly input: ProjectFlowsPromptInput }
  | { readonly kind: "parts"; readonly input: PartFlowsPromptInput; readonly paths: ReadonlyMap<string, string> };

export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly modelId: string;
}

export interface CacheStats {
  readonly usage?: CachedUsage;
  readonly explanations: number;
  readonly fileSummaries: number;
  readonly folderSummaries: number;
  readonly flows: number;
  readonly mapSavedAt?: number;
}

export type ProgressStage =
  | "checking"
  | "priming"
  | "reviewing"
  | "explaining"
  | "saving"
  | "complete";

export interface ExplanationProgress {
  readonly stage: ProgressStage;
  readonly detail: string;
  readonly usage?: Usage;
}

export interface ExplanationResult {
  readonly explanation: FunctionExplanation;
  readonly overview: RepositoryOverview;
  readonly context: FunctionContext;
  readonly provider: ProviderDescriptor;
  readonly usage?: Usage;
  readonly cached: boolean;
  readonly stale: boolean;
  /** The explanation was made with an earlier version of the repository overview. */
  readonly earlierOverview?: boolean;
}

export interface ExplanationServiceOptions {
  readonly store: RepositoryCacheStore;
  readonly describeProvider: () => ProviderDescriptor;
  /**
   * The model for project-level work (the repository overview and folder
   * summaries); defaults to the explanation model.
   */
  readonly describeOverviewProvider?: () => ProviderDescriptor;
  readonly createProvider: (descriptor: ProviderDescriptor) => Promise<GenerationProvider>;
  readonly authorizeExternalData: (
    root: string,
    descriptor: ProviderDescriptor,
    estimatedBytes: number,
    signal?: AbortSignal
  ) => Promise<boolean>;
  /** Extra views to include when generating explanations; none when omitted. */
  readonly explanationFormats?: () => readonly ExplanationFormat[];
  /** How much the project map describes each component; brief when omitted. */
  readonly projectMapDetail?: () => ProjectMapDetail;
  /** The largest explanation, added view, summary, or flows request, in bytes; DEFAULT_MAX_REQUEST_BYTES when omitted. */
  readonly maxRequestBytes?: () => number;
}

/** Default limit for every request but priming, which has its own. */
export const DEFAULT_MAX_REQUEST_BYTES = 96 * 1024;

const kib = (bytes: number): string => `${Math.ceil(bytes / 1024)} KiB`;

/** Why a request was not sent, naming its size, the limit, and the setting that changes it. */
function tooLarge(what: string, bytes: number, limit: number): Error {
  return new Error(
    `The ${what} request would be about ${kib(bytes)}, more than the ${kib(limit)} limit; no code was sent. Raise “Downside Up: Max Request Size” (downsideUp.maxRequestSize) to send it.`
  );
}

/** Priming holds the bounded inventory, symbol and folder outlines, and, when reviewing, the previous overview and map. */
const MAX_PRIMING_BYTES = 128 * 1024;
const MAX_FILE_SUMMARY_SOURCE_BYTES = 24 * 1024;

function fileSummaryKey(path: string, descriptor: ProviderDescriptor): string {
  return cacheKey([path, descriptor.kind, descriptor.modelId, EXPLANATION_PROMPT_VERSION]);
}

function comparisonKey(snapshot: ComparisonSnapshot, descriptor: ProviderDescriptor): string {
  const { original, modified } = snapshot;
  return cacheKey(["comparison", original.identity, original.path, modified.identity, modified.path, descriptor.kind, descriptor.modelId, COMPARISON_PROMPT_VERSION]);
}

const sideRecord = (side: SideSnapshot): ComparisonSideRecord => ({ path: side.path, identity: side.identity, fingerprint: side.fingerprint, lines: side.lines });

/** A saved comparison, current or not. */
export interface SavedComparison {
  readonly comparison: FileComparison;
  /** False when either side's text changed since the comparison was made. */
  readonly current: boolean;
  readonly savedAt: number;
  readonly model: string;
  readonly usage?: Usage;
  readonly original: ComparisonSideRecord;
  readonly modified: ComparisonSideRecord;
}

/** Keeps a span only when it lies inside a present side's lines, so links never point at lines that are not there. */
function checkedSpan(span: ComparisonSpan, side: SideSnapshot): ComparisonSpan {
  return side.state === "present" && span.start >= 1 && span.end >= span.start && span.end <= side.lines ? span : { start: 0, end: 0 };
}

function folderSummaryKey(path: string, descriptor: ProviderDescriptor): string {
  return cacheKey(["folder", path, descriptor.kind, descriptor.modelId, FOLDER_PROMPT_VERSION]);
}

function projectFlowsKey(path: string, descriptor: ProviderDescriptor): string {
  return cacheKey(["flows", path, descriptor.kind, descriptor.modelId, FOLDER_PROMPT_VERSION]);
}

/**
 * What project flows depend on: the catalog and imports, or the map's parts
 * and links; the repository overview, folder summary, and map summary are
 * background, not tracked.
 */
function flowsInputFingerprint(request: FlowsRequest): string {
  if (request.kind === "parts") {
    const { input } = request;
    return fingerprint(JSON.stringify(["parts", input.path, input.level, input.parts, input.links]));
  }
  const { input } = request;
  return fingerprint(JSON.stringify([input.path, input.catalog, input.imports, input.truncated]));
}

/** Keeps a step's part only when the map lists it; parts in the repository open their folder. */
export function checkedPartReferences(draft: ProjectFlowsDraft, input: PartFlowsPromptInput, paths: ReadonlyMap<string, string>): ProjectFlow[] {
  const known = new Set(input.parts.map((part) => part.id));
  return draft.flows.map((flow) => ({
    title: flow.title,
    summary: flow.summary,
    chart: flow.chart,
    refs: flow.chart.nodes.map((_, index) => {
      const id = flow.refs[index]?.file ?? "";
      const path = known.has(id) ? paths.get(id) : undefined;
      return path ? { path, folder: true } : null;
    })
  }));
}

/**
 * Keeps a flow step's reference only when it names a catalog file, and its
 * function only when that file lists it, so navigation never goes to a place
 * the extension did not find itself.
 */
export function checkedFlowReferences(draft: ProjectFlowsDraft, catalog: readonly FlowCatalogEntry[]): ProjectFlow[] {
  const functions = new Map(catalog.map((entry) => [entry.path, new Set(entry.functions)]));
  return draft.flows.map((flow) => ({
    title: flow.title,
    summary: flow.summary,
    chart: flow.chart,
    refs: flow.chart.nodes.map((_, index) => {
      const ref = flow.refs[index];
      if (!ref?.file || !functions.has(ref.file)) return null;
      return functions.get(ref.file)!.has(ref.function) ? { path: ref.file, function: ref.function } : { path: ref.file };
    })
  }));
}

/** What a folder summary depends on; the repository's name and purpose and the map's sentence are background, not tracked. */
function folderInputFingerprint(input: FolderSummaryPromptInput): string {
  return fingerprint(JSON.stringify([input.path, input.parts, input.imports, input.readme ?? "", input.level ?? "", input.contracts ?? []]));
}

const EXPLANATION_SETTINGS = "experienced-programmer-v1";

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
}

function overviewFingerprint(value: RepositoryOverview): string {
  return fingerprint(JSON.stringify(value));
}

function usageTotal(values: readonly Usage[]): Usage | undefined {
  if (values.length === 0) return undefined;
  return {
    inputTokens: values.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: values.reduce((sum, item) => sum + item.outputTokens, 0),
    estimated: values.some((item) => item.estimated)
  };
}

function inputToOverview(inventory: RepositoryInventory, mapDetail: ProjectMapDetail): RepositoryPromptInput {
  return {
    repositoryName: inventory.name,
    inventory: inventory.inventoryText,
    languageIds: inventory.languageIds,
    folders: outlineText(inventory.outline),
    mapDetail
  };
}

function isOverviewRelevantPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  return (
    /^(?:readme|architecture|design|contributing)(?:\.|$)/.test(name) ||
    name === ".gitignore" ||
    name === ".copilotignore" ||
    /^(?:cargo\.toml|cargo\.lock|package\.json|package-lock\.json|pyproject\.toml|go\.mod|pom\.xml|build\.gradle)$/.test(name) ||
    /(?:^|\/)(?:main|index|lib|mod)\.(?:rs|[cm]?js|jsx|mjs|cjs|ts|tsx|py|go|java)$/.test(path)
  );
}

function needsOverviewReview(
  inventory: RepositoryInventory,
  overview: OverviewRecord
): boolean {
  if (inventory.changedPaths.includes("[Git branch/HEAD]")) return true;
  // Every file sent for priming counts, not only ones the model chose to mention.
  const primed = new Set(overview.primedPaths ?? []);
  return inventory.changedPaths.some((path) => {
    const addedOrRemoved =
      overview.checkedSnapshot[path] === undefined || inventory.snapshot[path] === undefined;
    return addedOrRemoved || primed.has(path) || isOverviewRelevantPath(path);
  });
}

function normalizedOverview(result: RepositoryOverview, provider: ProviderKind): RepositoryOverview {
  return provider === "mock"
    ? {
        ...result,
        limitations: [...new Set([
          ...result.limitations,
          "Mock mode is deterministic placeholder output, not semantic repository analysis."
        ])]
      }
    : result;
}

function withOverview(
  value: RepositoryOverview,
  contentVersion: string,
  snapshot: Record<string, string>,
  primedPaths: readonly string[],
  config: string
): OverviewRecord {
  return {
    value,
    contentVersion,
    checkedSnapshot: snapshot,
    primedPaths: [...primedPaths],
    checkedAt: Date.now(),
    config
  };
}

interface ContextLookup {
  readonly context: Promise<FunctionContext>;
  readonly identity: string;
  readonly snapshot: Readonly<Record<string, string>>;
  readonly dirty: ReadonlyMap<string, string>;
  paths?: readonly string[];
}

export class ExplanationService {
  private readonly inFlight = new Map<string, Promise<ExplanationResult>>();
  private readonly generationFences = new Map<string, number>();
  private readonly contexts = new Map<string, ContextLookup>();

  constructor(private readonly options: ExplanationServiceOptions) {}

  /**
   * Tooling can time out or discover additional callers without any source edit.
   * Reuse the same evidence while the selected document and tracked files are unchanged,
   * rather than treating a different tooling answer as a code change.
   */
  private functionContext(
    target: FunctionTarget,
    document: vscode.TextDocument,
    inventory: RepositoryInventory
  ): Promise<FunctionContext> {
    const dirty = vscode.workspace.textDocuments
      .filter((open) => open.isDirty && open.uri.scheme === "file")
      .flatMap<[string, string]>((open) => {
        const path = relative(inventory.root, open.uri.fsPath).split(sep).join("/");
        return Object.hasOwn(inventory.snapshot, path) ? [[path, fingerprint(open.getText())]] : [];
      })
      .sort(([left], [right]) => left.localeCompare(right));
    const identity = fingerprint(JSON.stringify([
      inventory.root, this.fence(inventory.root), target.symbolId, target.languageId, target.structuralFingerprint,
      fingerprint(document.getText())
    ]));
    const key = fingerprint(JSON.stringify([
      identity, Object.entries(inventory.snapshot).sort(([left], [right]) => left.localeCompare(right)), dirty
    ]));
    const dirtyMap = new Map(dirty);
    const hit = this.contexts.get(key) ?? [...this.contexts.values()].find((entry) =>
      entry.identity === identity && entry.paths?.every((path) =>
        inventory.snapshot[path] !== undefined &&
        inventory.snapshot[path] === entry.snapshot[path] &&
        dirtyMap.get(path) === entry.dirty.get(path)));
    if (hit) {
      for (const [oldKey, entry] of this.contexts) if (entry === hit) this.contexts.delete(oldKey);
      this.contexts.set(key, hit);
      return hit.context;
    }
    const context = gatherFunctionContext(target, document, inventory);
    const entry: ContextLookup = { context, identity, snapshot: inventory.snapshot, dirty: dirtyMap };
    this.contexts.set(key, entry);
    if (this.contexts.size > 64) this.contexts.delete(this.contexts.keys().next().value!);
    void context.then(
      (result) => { entry.paths = [...new Set(result.inputs.map((input) => input.path))]; },
      () => { if (this.contexts.get(key) === entry) this.contexts.delete(key); }
    );
    return context;
  }

  private async refreshedTarget(
    target: FunctionTarget,
    document: vscode.TextDocument,
    previousSource: string
  ): Promise<FunctionTarget | undefined> {
    if (document.getText() === previousSource) return target;
    const language = languageFor({ languageId: target.languageId, path: target.uri.fsPath });
    if (language.listFunctions) {
      const functions = await language.listFunctions(document.getText(), target.uri.fsPath);
      const matches = functions.filter((entry) => entry.qualifiedName === target.qualifiedName);
      if (matches.length !== 1) return undefined;
      const found = matches[0]!;
      const line = document.getText().split(/\r?\n/)[found.startLine] ?? "";
      const nameColumn = line.indexOf(found.name);
      const position = new vscode.Position(found.startLine, nameColumn >= 0 ? nameColumn : Math.max(0, line.search(/\S/)));
      const resolved = await language.findFunction(document, position);
      return resolved?.qualifiedName === target.qualifiedName ? resolved : undefined;
    }
    const found = await language.findFunction(document, target.selection.start);
    return found?.symbolId === target.symbolId ? found : undefined;
  }

  /** Saved records across all models; no source scanning or freshness checks. */
  async cacheStats(root: string): Promise<CacheStats> {
    const cache = await this.options.store.read(root);
    return {
      usage: cachedUsage(cache),
      explanations: Object.keys(cache.explanations).length,
      fileSummaries: Object.keys(cache.fileSummaries ?? {}).length,
      folderSummaries: Object.keys(cache.folderSummaries ?? {}).length,
      flows: Object.keys(cache.projectFlows ?? {}).length,
      ...(cache.projectMap ? { mapSavedAt: cache.projectMap.savedAt } : {})
    };
  }

  async findCachedExplanation(
    root: string,
    target: FunctionTarget,
    document: vscode.TextDocument
  ): Promise<ExplanationResult | undefined> {
    return (await this.findCachedExplanations(root, [target], document)).get(target.symbolId);
  }

  /**
   * Local, cache-only lookup for functions of one document, keyed by symbol ID.
   * Repository and function context are gathered only for functions with a
   * saved record; this never calls a provider.
   */
  async findCachedExplanations(
    root: string,
    targets: readonly FunctionTarget[],
    document: vscode.TextDocument
  ): Promise<Map<string, ExplanationResult>> {
    const results = new Map<string, ExplanationResult>();
    const descriptor = this.options.describeProvider();
    const cache = await this.options.store.read(root);
    const overview = cache.overview;
    if (!overview) return results;
    const settingsHash = fingerprint(EXPLANATION_SETTINGS);
    const candidates = targets.flatMap((target) => {
      const cached = cache.explanations[explanationCacheKey(
        target.symbolId,
        descriptor.kind,
        descriptor.modelId,
        settingsHash,
        EXPLANATION_PROMPT_VERSION
      )];
      return cached &&
        cached.promptVersion === EXPLANATION_PROMPT_VERSION &&
        cached.explanationConfig === settingsHash
        ? [{ target, cached }]
        : [];
    });
    if (candidates.length === 0) return results;
    // Freshness depends only on the function and what it uses, not on whether the overview is due for review.
    const inventory = await gatherInventory(root, overview.checkedSnapshot);
    for (const { target, cached } of candidates) {
      if (results.has(target.symbolId)) continue;
      const context = await this.functionContext(target, document, inventory);
      if (!inputsMatch(cached.inputs, context.inputs)) continue;
      results.set(target.symbolId, {
        explanation: cached.explanation,
        overview: overview.value,
        context,
        provider: descriptor,
        cached: true,
        stale: false,
        earlierOverview: cached.overviewVersion !== overview.contentVersion
      });
    }
    return results;
  }

  /** Background on this kind of function from its language support, such as how a React component runs. */
  private async guidanceFor(
    root: string,
    target: FunctionTarget,
    document: vscode.TextDocument
  ): Promise<{ guidance?: string }> {
    const path = relative(root, target.uri.fsPath).split(sep).join("/");
    const guidance = await languageFor({ languageId: target.languageId, path }).explanationGuidance?.({
      path,
      text: document.getText(),
      line: target.range.start.line,
      name: target.name,
      qualifiedName: target.qualifiedName
    }).catch(() => undefined);
    return guidance ? { guidance } : {};
  }

  private readonly overviewLocks = new Map<string, Promise<unknown>>();

  /** Runs `task` after earlier tasks for the same repository have settled. */
  private async exclusive<T>(root: string, task: () => Promise<T>): Promise<T> {
    const previous = this.overviewLocks.get(root) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.overviewLocks.set(root, settled);
    try {
      return await run;
    } finally {
      if (this.overviewLocks.get(root) === settled) this.overviewLocks.delete(root);
    }
  }

  private fence(root: string): number {
    return this.generationFences.get(root) ?? 0;
  }

  async explain(
    root: string,
    target: FunctionTarget,
    document: vscode.TextDocument,
    signal?: AbortSignal,
    onProgress?: (progress: ExplanationProgress) => void
  ): Promise<ExplanationResult> {
    const descriptor = this.options.describeProvider();
    const requestId = JSON.stringify([
      root,
      target.symbolId,
      target.structuralFingerprint,
      descriptor.kind,
      descriptor.modelId
    ]);
    const existing = this.inFlight.get(requestId);
    if (existing) return existing;
    const request = this.explainFresh(root, target, document, descriptor, signal, onProgress);
    this.inFlight.set(requestId, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(requestId) === request) this.inFlight.delete(requestId);
    }
  }

  private async explainFresh(
    root: string,
    target: FunctionTarget,
    document: vscode.TextDocument,
    descriptor: ProviderDescriptor,
    signal?: AbortSignal,
    onProgress?: (progress: ExplanationProgress) => void
  ): Promise<ExplanationResult> {
    const startingFence = this.fence(root);
    const sourceAtStart = document.getText();
    const progress = (stage: ProgressStage, detail: string, usage?: Usage) =>
      onProgress?.({ stage, detail, ...(usage ? { usage } : {}) });
    progress("checking", "Checking source, repository context, and local cache.");
    assertNotCancelled(signal);
    if (this.fence(root) !== startingFence) throw new Error("The repository cache was cleared.");
    const exclusion = await sharingExclusion(root, target.uri.fsPath);
    if (exclusion) {
      throw new Error(
        `${basename(target.uri.fsPath)} is excluded from AI explanations because ${exclusion}. Nothing was sent; its local description is still shown.`
      );
    }

    const overviewDescriptor = this.overviewDescriptor();
    const overviewConfig = `${overviewDescriptor.kind}:${overviewDescriptor.modelId}:${PROMPT_VERSION}`;
    const usages: Usage[] = [];
    const authorized = new Set<string>();
    const providerCallFor = async <T>(
      using: ProviderDescriptor,
      bytes: number,
      call: (provider: GenerationProvider) => Promise<GenerationResult<T>>
    ) => {
      const id = `${using.kind}\0${using.modelId}`;
      if (using.kind !== "mock" && !authorized.has(id)) {
        const accepted = await this.options.authorizeExternalData(root, using, bytes, signal);
        if (!accepted) {
          throw new DOMException("External code sharing was not authorized.", "AbortError");
        }
        authorized.add(id);
      }
      assertNotCancelled(signal);
      return call(await this.options.createProvider(using));
    };
    const providerCallForRequest = <T>(bytes: number, call: (provider: GenerationProvider) => Promise<GenerationResult<T>>) =>
      providerCallFor(descriptor, bytes, call);

    const settingsHash = fingerprint(EXPLANATION_SETTINGS);
    const key = explanationCacheKey(
      target.symbolId,
      descriptor.kind,
      descriptor.modelId,
      settingsHash,
      EXPLANATION_PROMPT_VERSION
    );
    const isCurrent = (record: ExplanationRecord | undefined, inputs: FunctionContext["inputs"]) =>
      Boolean(record &&
        record.promptVersion === EXPLANATION_PROMPT_VERSION &&
        record.explanationConfig === settingsHash &&
        inputsMatch(record.inputs, inputs));

    // Building or reviewing the overview is exclusive per repository: a parallel
    // request waits here, then finds the overview current and reuses it.
    const { cache, inventory, context, overviewRecord } = await this.exclusive(root, async () => {
      assertNotCancelled(signal);
      let cache = await this.options.store.read(root);
      const baseInventory = await gatherInventory(root, cache.overview?.checkedSnapshot);
      const inventory = await addLocalSymbolOutline(baseInventory);
      const context = await this.functionContext(target, document, inventory);
      if (Buffer.byteLength(inventory.inventoryText, "utf8") > MAX_PRIMING_BYTES) {
        throw new Error("Repository inventory exceeds the priming budget; no code was sent.");
      }
      const contextBytes = Buffer.byteLength(context.text, "utf8") + Buffer.byteLength(target.source, "utf8");
      if (contextBytes > this.maxRequestBytes()) throw tooLarge("explanation", contextBytes, this.maxRequestBytes());
      assertNotCancelled(signal);
      // A current saved explanation is returned without reviewing the overview first.
      if (cache.overview && isCurrent(cache.explanations[key], context.inputs)) {
        return { cache, inventory, context, overviewRecord: cache.overview };
      }

      const shouldReview =
        !cache.overview ||
        cache.overview.config !== overviewConfig ||
        cache.projectMap?.config !== this.mapConfig(overviewDescriptor) ||
        needsOverviewReview(inventory, cache.overview);
      let overviewRecord = cache.overview;

      if (shouldReview) {
        const primed = await this.primeRepository(
          root,
          inventory,
          cache,
          overviewDescriptor,
          (bytes, request) => providerCallFor(overviewDescriptor, bytes, request),
          (stage) => progress(stage, stage === "reviewing" ? "Reviewing bounded repository changes." : "Priming repository context."),
          startingFence,
          signal
        );
        usages.push(primed.usage);
        overviewRecord = primed.overview;
        cache = primed.cache;
      } else if (overviewRecord && inventory.changedPaths.length > 0) {
        overviewRecord = withOverview(
          overviewRecord.value,
          overviewRecord.contentVersion,
          inventory.snapshot,
          overviewRecord.primedPaths ?? [],
          overviewRecord.config
        );
        cache = await this.options.store.update(root, (current) => ({
          ...current,
          overview: overviewRecord!
        }));
      }
      return { cache, inventory, context, overviewRecord };
    });

    if (!overviewRecord) throw new Error("Repository context could not be prepared.");
    if (this.fence(root) !== startingFence) throw new Error("The repository cache was cleared.");
    const cached = cache.explanations[key];
    if (cached && isCurrent(cached, context.inputs)) {
      progress("complete", "Cached explanation is current: recorded inputs match.");
      const usage = usageTotal(usages);
      return {
        explanation: cached.explanation,
        overview: overviewRecord.value,
        context,
        provider: descriptor,
        ...(usage ? { usage } : {}),
        cached: true,
        stale: false,
        earlierOverview: cached.overviewVersion !== overviewRecord.contentVersion
      };
    }

    progress("explaining", `Generating an explanation with ${descriptor.kind === "mock" ? "deterministic mock mode" : descriptor.modelId}.`);
    const prompt: ExplanationPromptInput = {
      repositoryName: inventory.name,
      languageId: target.languageId,
      functionName: target.qualifiedName,
      signature: target.signature,
      source: target.source,
      overview: overviewRecord.value,
      formats: this.options.explanationFormats?.() ?? [],
      ...await this.guidanceFor(root, target, document),
      relatedContext: context.text,
      limitations: [...new Set([...inventory.limitations, ...context.limitations])]
    };
    const [systemPrompt, userPrompt] = explanationPrompt(prompt);
    const explanationBytes = Buffer.byteLength(systemPrompt + userPrompt, "utf8");
    if (explanationBytes > this.maxRequestBytes()) throw tooLarge("explanation", explanationBytes, this.maxRequestBytes());
    const generated = await providerCallForRequest(
      explanationBytes,
      (provider) => provider.explainFunction(prompt, signal)
    );
    usages.push(generated.usage);
    // Step lines come from the model, so they are checked against the source before they are saved.
    const explanation = normalizeStepLines(generated.value, target.source);
    assertNotCancelled(signal);

    progress("checking", "Rechecking source and tracked inputs before saving.");
    const latestInventory = await gatherInventory(root, inventory.snapshot);
    const latestTarget = await this.refreshedTarget(target, document, sourceAtStart);
    const latestContext = latestTarget && await this.functionContext(latestTarget, document, latestInventory);
    const excluded = await sharingExclusion(root, target.uri.fsPath);
    if (
      excluded ||
      !latestContext ||
      context.inputs.some((input) => !Object.hasOwn(latestInventory.snapshot, input.path)) ||
      !inputsMatch(context.inputs, latestContext.inputs) ||
      this.fence(root) !== startingFence
    ) {
      throw new Error(
        "Source or repository context changed while the explanation was generating. It was not saved as current; run Explain again."
      );
    }

    const entry: ExplanationRecord = {
      usage: generated.usage,
      model: descriptor.modelId,
      key,
      symbolId: target.symbolId,
      languageId: target.languageId,
      path: relative(root, target.uri.fsPath).split(sep).join("/"),
      qualifiedName: target.qualifiedName,
      signature: target.signature,
      explanation,
      inputs: context.inputs,
      overviewVersion: overviewRecord.contentVersion,
      explanationConfig: settingsHash,
      promptVersion: EXPLANATION_PROMPT_VERSION,
      provider: descriptor.kind,
      savedAt: Date.now()
    };
    progress("saving", "Persisting explanation and its source fingerprints.");
    await this.options.store.update(root, (current) => {
      if (this.fence(root) !== startingFence) return current;
      return {
        ...current,
        explanations: {
          ...current.explanations,
          [key]: entry
        }
      };
    });
    if (this.fence(root) !== startingFence) {
      throw new Error("The cache was cleared while generation was active; the result was discarded.");
    }
    const usage = usageTotal(usages);
    progress("complete", "Explanation is current for its recorded inputs.", usage);
    return {
      explanation,
      overview: overviewRecord.value,
      context: latestContext,
      provider: descriptor,
      ...(usage ? { usage } : {}),
      cached: false,
      stale: false
    };
  }

  async refreshRepositoryContext(
    root: string,
    signal?: AbortSignal,
    onProgress?: (progress: ExplanationProgress) => void
  ): Promise<{ overview: RepositoryOverview; usage: Usage }> {
    // Exclusive with explanations' overview phase, so the overview is never rebuilt twice at once.
    return this.exclusive(root, () => this.refreshRepositoryContextNow(root, signal, onProgress));
  }

  /** The size limit for every request but priming. */
  private maxRequestBytes(): number {
    const limit = this.options.maxRequestBytes?.();
    return limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_REQUEST_BYTES;
  }

  /** The model for the repository overview and folder summaries. */
  private overviewDescriptor(): ProviderDescriptor {
    return this.options.describeOverviewProvider?.() ?? this.options.describeProvider();
  }

  private async refreshRepositoryContextNow(
    root: string,
    signal?: AbortSignal,
    onProgress?: (progress: ExplanationProgress) => void
  ): Promise<{ overview: RepositoryOverview; usage: Usage }> {
    const startingFence = this.fence(root);
    const descriptor = this.overviewDescriptor();
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (restricted) throw new Error(`Nothing was sent because ${restricted}.`);
    const cache = await this.options.store.read(root);
    const baseInventory = await gatherInventory(root, cache.overview?.checkedSnapshot);
    const inventory = await addLocalSymbolOutline(baseInventory);
    if (Buffer.byteLength(inventory.inventoryText, "utf8") > MAX_PRIMING_BYTES) {
      throw new Error("Repository inventory exceeds the priming budget; no code was sent.");
    }
    const authorize = async () => {
      if (descriptor.kind !== "mock") {
        const accepted = await this.options.authorizeExternalData(
          root,
          descriptor,
          Buffer.byteLength(inventory.inventoryText, "utf8"),
          signal
        );
        if (!accepted) throw new DOMException("External code sharing was not authorized.", "AbortError");
      }
      assertNotCancelled(signal);
    };
    const primed = await this.primeRepository(
      root,
      inventory,
      cache,
      descriptor,
      async (_bytes, request) => {
        await authorize();
        return request(await this.options.createProvider(descriptor));
      },
      (stage) => onProgress?.({
        stage,
        detail: stage === "reviewing" ? "Reviewing repository context by request." : "Building repository context by request."
      }),
      startingFence,
      signal
    );
    return { overview: primed.overview.value, usage: primed.usage };
  }

  /** The map's settings: the overview model, prompt version, and detail setting it was made with. */
  private mapConfig(descriptor: ProviderDescriptor): string {
    return `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}:${this.options.projectMapDetail?.() ?? "brief"}`;
  }

  /**
   * Primes the repository, or reviews its overview when one was made with
   * the same model, in one request that returns the overview and the project
   * map. The map's folders are checked against the repository; it is saved
   * apart from the overview, so a changed map never outdates explanations.
   */
  private async primeRepository(
    root: string,
    inventory: RepositoryInventory,
    cache: RepositoryCache,
    descriptor: ProviderDescriptor,
    send: (
      bytes: number,
      request: (provider: GenerationProvider) => Promise<GenerationResult<RepositoryPriming>>
    ) => Promise<GenerationResult<RepositoryPriming>>,
    onStage: (stage: "priming" | "reviewing") => void,
    startingFence: number,
    signal?: AbortSignal
  ): Promise<{ overview: OverviewRecord; map: ProjectMap; cache: RepositoryCache; usage: Usage }> {
    const overviewConfig = `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}`;
    const mapConfig = this.mapConfig(descriptor);
    const prompt = inputToOverview(inventory, this.options.projectMapDetail?.() ?? "brief");
    const previous = cache.overview;
    let generated: GenerationResult<RepositoryPriming>;
    if (previous && previous.config === overviewConfig) {
      const review: OverviewReviewPromptInput = {
        ...prompt,
        previous: previous.value,
        ...(cache.projectMap?.config === mapConfig ? { previousMap: cache.projectMap.value } : {}),
        changedPaths: inventory.changedPaths
      };
      const [system, user] = reviewPrompt(review);
      const requestBytes = Buffer.byteLength(system + user, "utf8");
      if (requestBytes > MAX_PRIMING_BYTES) {
        throw new Error("The complete repository-review request exceeds 128 KiB; no code was sent.");
      }
      onStage("reviewing");
      generated = await send(requestBytes, (provider) => provider.reviewRepository(review, signal));
    } else {
      const [system, user] = overviewPrompt(prompt);
      const requestBytes = Buffer.byteLength(system + user, "utf8");
      if (requestBytes > MAX_PRIMING_BYTES) {
        throw new Error("The complete repository-priming request exceeds 128 KiB; no code was sent.");
      }
      onStage("priming");
      generated = await send(requestBytes, (provider) => provider.explainRepository(prompt, signal));
    }
    assertNotCancelled(signal);
    if (this.fence(root) !== startingFence) {
      throw new Error("The repository cache was cleared while context was being refreshed.");
    }
    const value = normalizedOverview(generated.value.overview, descriptor.kind);
    const version = overviewFingerprint(value);
    const overview = withOverview(
      value,
      previous?.value && version === overviewFingerprint(previous.value) ? previous.contentVersion : version,
      inventory.snapshot,
      inventory.primedPaths,
      overviewConfig
    );
    const map = checkedProjectMap(generated.value.map, (path) => inventory.folders.has(path));
    const mapRecord: ProjectMapRecord = { value: map, config: mapConfig, savedAt: Date.now(), usage: generated.usage, model: descriptor.modelId, provider: descriptor.kind };
    const updated = await this.options.store.update(root, (current) => this.fence(root) !== startingFence ? current : {
      ...current,
      overview,
      projectMap: mapRecord
    });
    return { overview, map, cache: updated, usage: generated.usage };
  }

  /**
   * Adds one extra view to a current saved explanation, for explanations
   * saved before that view was enabled. The function and its context must be
   * unchanged before and after the request; otherwise nothing is saved.
   */
  async addExplanationFormat(
    root: string,
    target: FunctionTarget,
    document: vscode.TextDocument,
    format: ExplanationFormat,
    signal?: AbortSignal
  ): Promise<ExplanationResult> {
    const startingFence = this.fence(root);
    const sourceAtStart = document.getText();
    const descriptor = this.options.describeProvider();
    const exclusion = await sharingExclusion(root, target.uri.fsPath);
    if (exclusion) throw new Error(`This file is excluded from AI explanations because ${exclusion}.`);
    const saved = await this.findCachedExplanation(root, target, document);
    if (!saved) throw new Error("The saved explanation is no longer current; regenerate it first.");
    if (saved.explanation[format]) return saved;
    const input: FormatPromptInput = {
      repositoryName: basename(root),
      languageId: target.languageId,
      functionName: target.qualifiedName,
      signature: target.signature,
      source: target.source,
      format,
      stepTitles: saved.explanation.steps.map((step) => step.title),
      ...await this.guidanceFor(root, target, document)
    };
    const [system, user] = formatPrompt(input);
    const requestBytes = Buffer.byteLength(system + user, "utf8");
    if (requestBytes > this.maxRequestBytes()) throw tooLarge(input.format, requestBytes, this.maxRequestBytes());
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const generated = await (await this.options.createProvider(descriptor)).explainFormat(input, signal);
    assertNotCancelled(signal);
    const added = normalizeStepLines(generated.value, target.source);
    const latestTarget = await this.refreshedTarget(target, document, sourceAtStart);
    const latest = latestTarget && await this.findCachedExplanation(root, latestTarget, document);
    if (!latest || await sharingExclusion(root, target.uri.fsPath) ||
        this.fence(root) !== startingFence || !inputsMatch(saved.context.inputs, latest.context.inputs)) {
      throw new Error("The function changed while the view was generating. It was not saved; try again.");
    }
    const key = explanationCacheKey(
      target.symbolId,
      descriptor.kind,
      descriptor.modelId,
      fingerprint(EXPLANATION_SETTINGS),
      EXPLANATION_PROMPT_VERSION
    );
    const explanation: FunctionExplanation = { ...latest.explanation, ...added };
    await this.options.store.update(root, (current) => {
      const record = current.explanations[key];
      if (!record || this.fence(root) !== startingFence) return current;
      return { ...current, explanations: { ...current.explanations, [key]: {
        ...record, explanation, model: descriptor.modelId,
        formatUsage: { ...record.formatUsage, [format]: generated.usage }
      } } };
    });
    return { ...latest, explanation, usage: generated.usage, cached: false };
  }

  /** Cache-only lookup of the AI summary of a file; `current` is false when the file changed since. */
  async findFileSummary(
    root: string,
    document: vscode.TextDocument
  ): Promise<{ summary: string; current: boolean } | undefined> {
    const descriptor = this.options.describeProvider();
    const path = relative(root, document.uri.fsPath).split(sep).join("/");
    const record = (await this.options.store.read(root)).fileSummaries?.[fileSummaryKey(path, descriptor)];
    if (!record) return undefined;
    return { summary: record.summary, current: record.fingerprint === await sourceFingerprint(document.getText(), { path, languageId: document.languageId }) };
  }

  /** Saved one-sentence file summaries for the explanation model, current or not, by path. */
  async savedFileSummaries(root: string): Promise<Map<string, string>> {
    const descriptor = this.options.describeProvider();
    const saved = (await this.options.store.read(root)).fileSummaries ?? {};
    return new Map(Object.values(saved)
      .filter((record) => record.provider === descriptor.kind && record.model === descriptor.modelId && record.promptVersion === EXPLANATION_PROMPT_VERSION)
      .map((record) => [record.path, record.summary]));
  }

  /** The saved repository overview, from the cache only. */
  async savedOverview(root: string): Promise<RepositoryOverview | undefined> {
    return (await this.options.store.read(root)).overview?.value;
  }

  /** The repository overview's purpose, components, and flows, as background for project flows. */
  async overviewBackground(root: string): Promise<ProjectFlowsPromptInput["overview"]> {
    const overview = (await this.options.store.read(root)).overview?.value;
    return overview ? { purpose: overview.purpose, components: overview.components, flows: overview.flows } : undefined;
  }

  /**
   * The saved project map, from the cache only; `current` is false when it
   * was made with another overview model or detail setting. It is reviewed
   * with the repository overview, so it is never older than that.
   */
  async savedProjectMap(root: string): Promise<{ map: ProjectMap; current: boolean } | undefined> {
    const record = (await this.options.store.read(root)).projectMap;
    return record ? { map: record.value, current: record.config === this.mapConfig(this.overviewDescriptor()) } : undefined;
  }

  /** Cache-only lookup of a folder's saved project flows; `current` is false when their input changed since. */
  async findProjectFlows(
    root: string,
    request: FlowsRequest
  ): Promise<{ flows: readonly ProjectFlow[]; current: boolean } | undefined> {
    const record = (await this.options.store.read(root)).projectFlows?.[projectFlowsKey(request.input.path, this.overviewDescriptor())];
    return record ? { flows: record.flows, current: record.fingerprint === flowsInputFingerprint(request) } : undefined;
  }

  /**
   * Describes a folder's main flows on explicit request with the overview
   * model. The request holds file paths, saved summaries, function names,
   * import edges, and background, never code; references the extension
   * cannot confirm are dropped before saving.
   */
  async describeProjectFlows(
    root: string,
    request: FlowsRequest,
    signal?: AbortSignal
  ): Promise<{ flows: readonly ProjectFlow[]; usage: Usage }> {
    const startingFence = this.fence(root);
    const descriptor = this.overviewDescriptor();
    const { input } = request;
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (restricted) throw new Error(`Nothing was sent because ${restricted}.`);
    const [system, user] = request.kind === "parts" ? partFlowsPrompt(request.input) : projectFlowsPrompt(request.input);
    const requestBytes = Buffer.byteLength(system + user, "utf8");
    if (requestBytes > this.maxRequestBytes()) throw tooLarge("flows", requestBytes, this.maxRequestBytes());
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const provider = await this.options.createProvider(descriptor);
    const generated = request.kind === "parts"
      ? await provider.describePartFlows(request.input, signal)
      : await provider.describeFlows(request.input, signal);
    assertNotCancelled(signal);
    const flows = request.kind === "parts"
      ? checkedPartReferences(generated.value, request.input, request.paths)
      : checkedFlowReferences(generated.value, request.input.catalog);
    if (flows.length === 0) throw new Error("The model returned no usable flows.");
    const record: ProjectFlowsRecord = {
      usage: generated.usage,
      path: input.path,
      flows,
      fingerprint: flowsInputFingerprint(request),
      provider: descriptor.kind,
      model: descriptor.modelId,
      promptVersion: FOLDER_PROMPT_VERSION,
      savedAt: Date.now()
    };
    await this.options.store.update(root, (current) => this.fence(root) !== startingFence ? current : {
      ...current,
      projectFlows: { ...current.projectFlows, [projectFlowsKey(input.path, descriptor)]: record }
    });
    return { flows, usage: generated.usage };
  }

  /** A folder's saved summary sentence for the current model, current or not, as input for its parent folder. */
  async savedFolderSummary(root: string, path: string): Promise<string | undefined> {
    return (await this.options.store.read(root)).folderSummaries?.[folderSummaryKey(path, this.overviewDescriptor())]?.value.summary;
  }

  /** Cache-only lookup of a folder's saved summary; `current` is false when its input changed since. */
  async findFolderSummary(
    root: string,
    input: FolderSummaryPromptInput
  ): Promise<{ value: FolderSummary; current: boolean } | undefined> {
    const record = (await this.options.store.read(root)).folderSummaries?.[folderSummaryKey(input.path, this.overviewDescriptor())];
    return record ? { value: record.value, current: record.fingerprint === folderInputFingerprint(input) } : undefined;
  }

  /**
   * Generates a folder summary on explicit request. The request holds names,
   * saved summaries, function and type names, import edges, and the folder's
   * README, never source code; a restricted repository sends nothing.
   * Descriptions of parts that are not listed, or that already have a
   * summary, are dropped.
   */
  async summarizeFolder(
    root: string,
    input: FolderSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<{ value: FolderSummary; usage: Usage }> {
    const startingFence = this.fence(root);
    const descriptor = this.overviewDescriptor();
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (restricted) throw new Error(`Nothing was sent because ${restricted}.`);
    const repositoryPurpose = (await this.options.store.read(root)).overview?.value.purpose;
    const prompt: FolderSummaryPromptInput = { ...input, ...(repositoryPurpose ? { repositoryPurpose } : {}) };
    const [system, user] = folderSummaryPrompt(prompt);
    const requestBytes = Buffer.byteLength(system + user, "utf8");
    if (requestBytes > this.maxRequestBytes()) throw tooLarge("folder summary", requestBytes, this.maxRequestBytes());
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const generated = await (await this.options.createProvider(descriptor)).summarizeFolder(prompt, signal);
    assertNotCancelled(signal);
    const needing = new Set(input.parts.filter((part) => !part.summary).map((part) => part.name));
    const value: FolderSummary = { ...generated.value, parts: generated.value.parts.filter((part) => needing.has(part.name)) };
    const record: FolderSummaryRecord = {
      usage: generated.usage,
      path: input.path,
      value,
      fingerprint: folderInputFingerprint(input),
      provider: descriptor.kind,
      model: descriptor.modelId,
      promptVersion: FOLDER_PROMPT_VERSION,
      savedAt: Date.now()
    };
    await this.options.store.update(root, (current) => this.fence(root) !== startingFence ? current : {
      ...current,
      folderSummaries: { ...current.folderSummaries, [folderSummaryKey(input.path, descriptor)]: record }
    });
    return { value, usage: generated.usage };
  }

  /**
   * Cache-only lookup of the saved summaries of several files at once, for a
   * folder preview; `text` reads a file's current text, or undefined when it
   * cannot be read (its summary is then shown as not current).
   */
  async findFileSummaries(
    root: string,
    paths: readonly string[],
    text: (path: string) => Promise<string | undefined>
  ): Promise<Map<string, { summary: string; current: boolean }>> {
    const descriptor = this.options.describeProvider();
    const saved = (await this.options.store.read(root)).fileSummaries ?? {};
    const found = new Map<string, { summary: string; current: boolean }>();
    for (const path of paths) {
      const record = saved[fileSummaryKey(path, descriptor)];
      if (!record) continue;
      const current = await text(path).catch(() => undefined);
      found.set(path, { summary: record.summary, current: current !== undefined && record.fingerprint === await sourceFingerprint(current, { path }) });
    }
    return found;
  }

  /**
   * Generates a one-sentence summary of a file unless a current one is saved.
   * Called only after a function in the file was explained, so code sharing
   * for the repository and model is already approved. Excluded files and
   * files that change during generation are never summarized or saved.
   */
  async summarizeFile(
    root: string,
    document: vscode.TextDocument,
    signal?: AbortSignal
  ): Promise<{ summary: string; usage?: Usage } | undefined> {
    const startingFence = this.fence(root);
    const descriptor = this.options.describeProvider();
    if (await sharingExclusion(root, document.uri.fsPath)) return undefined;
    const existing = await this.findFileSummary(root, document);
    if (existing?.current) return { summary: existing.summary };
    const text = document.getText();
    const startingFingerprint = await sourceFingerprint(text, { path: document.uri.fsPath, languageId: document.languageId });
    const bytes = Buffer.from(text, "utf8");
    const truncated = bytes.length > MAX_FILE_SUMMARY_SOURCE_BYTES;
    const path = relative(root, document.uri.fsPath).split(sep).join("/");
    const repositoryPurpose = (await this.options.store.read(root)).overview?.value.purpose;
    const input: FileSummaryPromptInput = {
      repositoryName: basename(root),
      path,
      languageId: document.languageId,
      source: truncated ? bytes.subarray(0, MAX_FILE_SUMMARY_SOURCE_BYTES).toString("utf8") : text,
      truncated,
      ...(repositoryPurpose ? { repositoryPurpose } : {})
    };
    const [system, user] = fileSummaryPrompt(input);
    const requestBytes = Buffer.byteLength(system + user, "utf8");
    if (requestBytes > this.maxRequestBytes()) return undefined;
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const generated = await (await this.options.createProvider(descriptor)).summarizeFile(input, signal);
    assertNotCancelled(signal);
    if (this.fence(root) !== startingFence ||
        await sourceFingerprint(document.getText(), { path, languageId: document.languageId }) !== startingFingerprint) {
      return undefined;
    }
    const record: FileSummaryRecord = {
      usage: generated.usage,
      path,
      summary: generated.value.summary,
      fingerprint: startingFingerprint,
      provider: descriptor.kind,
      model: descriptor.modelId,
      promptVersion: EXPLANATION_PROMPT_VERSION,
      savedAt: Date.now()
    };
    await this.options.store.update(root, (current) => this.fence(root) !== startingFence ? current : {
      ...current,
      fileSummaries: { ...current.fileSummaries, [fileSummaryKey(path, descriptor)]: record }
    });
    return { summary: record.summary, usage: generated.usage };
  }

  /** Cache-only lookup of a saved comparison for exactly these two sides; never generates. */
  async findComparison(snapshot: ComparisonSnapshot): Promise<SavedComparison | undefined> {
    const record = (await this.options.store.read(snapshot.root)).comparisons?.[comparisonKey(snapshot, this.options.describeProvider())];
    return record ? savedComparison(record, snapshot) : undefined;
  }

  /**
   * Explains what the change between two exact versions of one file does,
   * on explicit request only, with one bounded request holding both sides.
   * `reread` reads the sides again after the model answers; a result is
   * rejected, not saved, when either side changed meanwhile.
   */
  async explainComparison(
    snapshot: ComparisonSnapshot,
    reread: () => Promise<ComparisonSnapshot>,
    signal?: AbortSignal
  ): Promise<SavedComparison & { usage?: Usage; cached: boolean }> {
    const { root } = snapshot;
    const startingFence = this.fence(root);
    const descriptor = this.options.describeProvider();
    const problem = comparisonProblem(snapshot);
    if (problem) throw new Error(problem);
    const existing = await this.findComparison(snapshot);
    if (existing?.current) return { ...existing, cached: true };
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (restricted) throw new Error(`Nothing was sent because ${restricted}.`);
    const path = snapshot.modified.state === "present" ? snapshot.modified.path : snapshot.original.path;
    const side = (version: SideSnapshot): ComparisonPromptInput["original"] => ({
      path: version.path,
      label: describeIdentity(version.identity),
      present: version.state === "present",
      source: version.text
    });
    const repositoryPurpose = (await this.options.store.read(root)).overview?.value.purpose;
    const input: ComparisonPromptInput = {
      repositoryName: basename(root),
      languageId: bundledLanguageIdForPath(path) ?? (extname(path).slice(1) || "text"),
      original: side(snapshot.original),
      modified: side(snapshot.modified),
      ...(repositoryPurpose ? { repositoryPurpose } : {})
    };
    const [system, user] = comparisonPrompt(input);
    const requestBytes = Buffer.byteLength(system + user, "utf8");
    if (requestBytes > this.maxRequestBytes()) throw tooLarge("change", requestBytes, this.maxRequestBytes());
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const generated = await (await this.options.createProvider(descriptor)).explainComparison(input, signal);
    assertNotCancelled(signal);
    const latest = await reread();
    if (this.fence(root) !== startingFence ||
        latest.original.fingerprint !== snapshot.original.fingerprint || latest.original.identity !== snapshot.original.identity ||
        latest.modified.fingerprint !== snapshot.modified.fingerprint || latest.modified.identity !== snapshot.modified.identity) {
      throw new Error("The files changed while the change was being explained, so the result was discarded.");
    }
    const comparison: FileComparison = {
      ...generated.value,
      changes: generated.value.changes.map((change) => ({
        ...change,
        original: checkedSpan(change.original, snapshot.original),
        modified: checkedSpan(change.modified, snapshot.modified)
      }))
    };
    const record: ComparisonRecord = {
      original: sideRecord(snapshot.original),
      modified: sideRecord(snapshot.modified),
      comparison,
      usage: generated.usage,
      provider: descriptor.kind,
      model: descriptor.modelId,
      promptVersion: COMPARISON_PROMPT_VERSION,
      savedAt: Date.now()
    };
    await this.options.store.update(root, (current) => this.fence(root) !== startingFence ? current : {
      ...current,
      comparisons: { ...current.comparisons, [comparisonKey(snapshot, descriptor)]: record }
    });
    return { ...savedComparison(record, snapshot), usage: generated.usage, cached: false };
  }

  async clearCache(root: string): Promise<void> {
    this.generationFences.set(root, this.fence(root) + 1);
    await this.options.store.clear(root);
  }

  readCache(root: string) {
    return this.options.store.read(root);
  }
}

function savedComparison(record: ComparisonRecord, snapshot: ComparisonSnapshot): SavedComparison {
  return {
    comparison: record.comparison,
    current: record.original.fingerprint === snapshot.original.fingerprint && record.modified.fingerprint === snapshot.modified.fingerprint,
    savedAt: record.savedAt,
    model: record.model,
    ...(record.usage ? { usage: record.usage } : {}),
    original: record.original,
    modified: record.modified
  };
}
