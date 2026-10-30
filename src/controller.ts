import { basename, extname, relative, resolve, sep } from "node:path";
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
  ReviewSummaryRecord,
  Usage
} from "./core/types";
import { comparisonProblem, describeIdentity, snapshotSignature, type ChangedFile, type ComparisonSnapshot, type SideSnapshot } from "./context/comparison";
import {
  buildReviewSummaryRequest, reviewComparisonCurrent, reviewSnapshotMatches, validateReviewSummaryScope,
  type PreparedReviewSummary, type ReviewSummaryRead, type ReviewSummaryScope
} from "./context/reviewSummary";
import { parseReviewSummary } from "./generation/schema";
import { comparisonCatalogue } from "./context/comparisonFunctions";
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
import type { ReviewExportData, ReviewExportFile } from "./presentation/reviewExport";
import { ModelSetupRequired, providerConfigured } from "./generation/selection";
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
  reviewPrompt,
  REVIEW_SUMMARY_PROMPT_VERSION
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
  readonly overview?: RepositoryOverview;
  readonly context: FunctionContext;
  readonly provider: ProviderDescriptor;
  readonly usage?: Usage;
  readonly cached: boolean;
  readonly stale: boolean;
  /** The explanation was made with an earlier version of the repository overview. */
  readonly earlierOverview?: boolean;
}

/** Isolated historical file context; callers must re-resolve moving refs and compare exact text. */
export interface SnapshotExplanationSource {
  readonly side: SideSnapshot;
  readonly occurrenceId: string;
  readonly validate: () => Promise<void>;
}

export interface ExplanationServiceOptions {
  /** Current host-owned review filter, rechecked before dispatch and persistence. */
  readonly reviewFilterFingerprint?: (root: string) => string;
  /** Only extension development/test harnesses may opt in to deterministic placeholders. */
  readonly allowMock?: boolean;
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
  /** Complete repository priming/review budget; defaults to 256 KiB. */
  readonly maxProjectContextRequestBytes?: () => number;
}

export interface PreparedReviewExport {
  readonly data: ReviewExportData;
  readonly head?: string;
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
export const DEFAULT_MAX_PROJECT_CONTEXT_REQUEST_BYTES = 256 * 1024;
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
  readonly catalogue?: import("./core/types").ComparisonCatalogue;
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

function boundedPrimingInput(input: RepositoryPromptInput, limit: number): RepositoryPromptInput {
  const bytes = (candidate: RepositoryPromptInput) => Buffer.byteLength(overviewPrompt(candidate).join(""), "utf8");
  if (bytes(input) <= limit) return input;
  const lines = input.inventory.split("\n");
  const note = `[Repository inventory truncated to fit the complete ${kib(limit)} request budget.]`;
  const candidate = (count: number): RepositoryPromptInput => ({
    ...input,
    inventory: [...lines.slice(0, count), note].join("\n")
  });
  if (bytes(candidate(0)) > limit) {
    throw new Error(`The repository-priming metadata exceeds ${kib(limit)}; no code was sent. Raise “Downside Up: Max Project Context Request Size” (downsideUp.maxProjectContextRequestSize) to send it.`);
  }
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(candidate(mid)) <= limit) low = mid;
    else high = mid - 1;
  }
  return candidate(low);
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

  private requireModel(overview = false): void {
    const descriptor = overview ? this.overviewDescriptor() : this.options.describeProvider();
    if (!providerConfigured(this.options.describeProvider(), this.options.allowMock === true) ||
        !providerConfigured(descriptor, this.options.allowMock === true)) throw new ModelSetupRequired();
  }

  /** Hide historical placeholders without rewriting caches or changing real-model consent. */
  async readCache(root: string): Promise<RepositoryCache> {
    const cache = await this.options.store.read(root);
    if (this.options.allowMock) return cache;
    const real = <T extends { readonly provider?: ProviderKind }>(records?: Record<string, T>) =>
      Object.fromEntries(Object.entries(records ?? {}).filter(([, record]) => record.provider !== "mock"));
    return {
      ...cache,
      overview: cache.overview?.config.startsWith("mock:") ? null : cache.overview,
      projectMap: cache.projectMap?.provider === "mock" || cache.projectMap?.config.startsWith("mock:")
        ? null : cache.projectMap,
      explanations: real(cache.explanations),
      fileSummaries: real(cache.fileSummaries),
      folderSummaries: real(cache.folderSummaries),
      projectFlows: real(cache.projectFlows),
      comparisons: real(cache.comparisons),
      reviewSummaries: real(cache.reviewSummaries)
    };
  }

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
    const cache = await this.readCache(root);
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
    const cache = await this.readCache(root);
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
    onProgress?: (progress: ExplanationProgress) => void,
    validateSource?: () => Promise<void>
  ): Promise<ExplanationResult> {
    this.requireModel(true);
    const descriptor = this.options.describeProvider();
    const requestId = JSON.stringify([
      root,
      target.symbolId,
      target.structuralFingerprint,
      descriptor.kind,
      descriptor.modelId,
      validateSource ? fingerprint(document.getText()) : "working"
    ]);
    const existing = this.inFlight.get(requestId);
    if (existing) return existing;
    const request = this.explainFresh(root, target, document, descriptor, signal, onProgress, validateSource);
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
    onProgress?: (progress: ExplanationProgress) => void,
    validateSource?: () => Promise<void>
  ): Promise<ExplanationResult> {
    const startingFence = this.fence(root);
    const sourceAtStart = document.getText();
    const progress = (stage: ProgressStage, detail: string, usage?: Usage) =>
      onProgress?.({ stage, detail, ...(usage ? { usage } : {}) });
    progress("checking", "Checking source, repository context, and local cache.");
    assertNotCancelled(signal);
    await validateSource?.();
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
      await validateSource?.();
      const current = this.options.describeProvider();
      if (vscode.workspace.isTrusted === false || current.kind !== descriptor.kind || current.modelId !== descriptor.modelId ||
          await sharingExclusion(root, target.uri.fsPath)) {
        throw new Error("Source sharing policy or model changed before dispatch; nothing was sent.");
      }
      const provider = await this.options.createProvider(using);
      assertNotCancelled(signal);
      await validateSource?.();
      return call(provider);
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
      let cache = await this.readCache(root);
      const baseInventory = await gatherInventory(root, cache.overview?.checkedSnapshot);
      const inventory = await addLocalSymbolOutline(baseInventory);
      const context = await this.functionContext(target, document, inventory);
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
    await validateSource?.();

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
    const validateCommit = async () => {
      assertNotCancelled(signal);
      await validateSource?.();
      const current = this.options.describeProvider();
      const inventoryNow = await gatherInventory(root, inventory.snapshot);
      const targetNow = await this.refreshedTarget(target, document, sourceAtStart);
      const contextNow = targetNow && await this.functionContext(targetNow, document, inventoryNow);
      if (vscode.workspace.isTrusted === false || current.kind !== descriptor.kind || current.modelId !== descriptor.modelId ||
          this.fence(root) !== startingFence || await sharingExclusion(root, target.uri.fsPath) ||
          !contextNow || !inputsMatch(context.inputs, contextNow.inputs) ||
          context.inputs.some((input) => !Object.hasOwn(inventoryNow.snapshot, input.path))) {
        throw new Error("Source or repository context changed before persistence; the explanation was not saved.");
      }
    };
    await this.options.store.update(root, (current) => {
      if (this.fence(root) !== startingFence) return current;
      return {
        ...current,
        explanations: {
          ...current.explanations,
          [key]: entry
        }
      };
    }, signal, validateCommit);
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
    this.requireModel(true);
    // Exclusive with explanations' overview phase, so the overview is never rebuilt twice at once.
    return this.exclusive(root, () => this.refreshRepositoryContextNow(root, signal, onProgress));
  }

  /** The size limit for every request but priming. */
  private maxRequestBytes(): number {
    const limit = this.options.maxRequestBytes?.();
    return limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_REQUEST_BYTES;
  }

  private maxProjectContextRequestBytes(): number {
    const limit = this.options.maxProjectContextRequestBytes?.();
    return limit !== undefined && Number.isFinite(limit)
      ? Math.min(1024 * 1024, Math.max(128 * 1024, Math.round(limit)))
      : DEFAULT_MAX_PROJECT_CONTEXT_REQUEST_BYTES;
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
    const cache = await this.readCache(root);
    const baseInventory = await gatherInventory(root, cache.overview?.checkedSnapshot);
    const inventory = await addLocalSymbolOutline(baseInventory);
    const authorize = async (bytes: number) => {
      if (descriptor.kind !== "mock") {
        const accepted = await this.options.authorizeExternalData(
          root,
          descriptor,
          bytes,
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
      async (bytes, request) => {
        await authorize(bytes);
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
    const limit = this.maxProjectContextRequestBytes();
    const previous = cache.overview;
    let review: OverviewReviewPromptInput | undefined;
    const limitations: string[] = [];
    if (previous && previous.config === overviewConfig) {
      review = {
        ...prompt,
        previous: previous.value,
        ...(cache.projectMap?.config === mapConfig ? { previousMap: cache.projectMap.value } : {}),
        changedPaths: inventory.changedPaths
      };
      const [system, user] = reviewPrompt(review);
      const requestBytes = Buffer.byteLength(system + user, "utf8");
      if (requestBytes > limit) {
        review = undefined;
        limitations.push(`The repository overview and map were rebuilt from current bounded evidence because including the previous versions exceeded the ${kib(limit)} request budget.`);
      }
    }
    let generated: GenerationResult<RepositoryPriming>;
    const reviewInput = review;
    if (reviewInput) {
      const requestBytes = Buffer.byteLength(reviewPrompt(reviewInput).join(""), "utf8");
      onStage("reviewing");
      generated = await send(requestBytes, (provider) => provider.reviewRepository(reviewInput, signal));
    } else {
      const bounded = boundedPrimingInput(prompt, limit);
      if (bounded !== prompt) {
        limitations.push(`Repository inventory was truncated to fit the complete ${kib(limit)} request budget.`);
      }
      const [system, user] = overviewPrompt(bounded);
      const requestBytes = Buffer.byteLength(system + user, "utf8");
      onStage("priming");
      generated = await send(requestBytes, (provider) => provider.explainRepository(bounded, signal));
    }
    assertNotCancelled(signal);
    if (this.fence(root) !== startingFence) {
      throw new Error("The repository cache was cleared while context was being refreshed.");
    }
    const normalized = normalizedOverview(generated.value.overview, descriptor.kind);
    const value = { ...normalized, limitations: [...new Set([...normalized.limitations, ...limitations])] };
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
    signal?: AbortSignal,
    validateSource?: () => Promise<void>
  ): Promise<ExplanationResult> {
    this.requireModel();
    const startingFence = this.fence(root);
    await validateSource?.();
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
    const provider = await this.options.createProvider(descriptor);
    await validateSource?.();
    assertNotCancelled(signal);
    const generated = await provider.explainFormat(input, signal);
    assertNotCancelled(signal);
    const added = normalizeStepLines(generated.value, target.source);
    await validateSource?.();
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
    const validateCommit = async () => {
      assertNotCancelled(signal);
      await validateSource?.();
      const current = this.options.describeProvider();
      const inventoryNow = await gatherInventory(root);
      const targetNow = await this.refreshedTarget(target, document, sourceAtStart);
      const contextNow = targetNow && await this.functionContext(targetNow, document, inventoryNow);
      if (vscode.workspace.isTrusted === false || current.kind !== descriptor.kind || current.modelId !== descriptor.modelId ||
          this.fence(root) !== startingFence || await sharingExclusion(root, target.uri.fsPath) ||
          !contextNow || !inputsMatch(saved.context.inputs, contextNow.inputs)) {
        throw new Error("The function changed before persistence; the view was not saved.");
      }
    };
    await this.options.store.update(root, (current) => {
      const record = current.explanations[key];
      if (!record || this.fence(root) !== startingFence) return current;
      return { ...current, explanations: { ...current.explanations, [key]: {
        ...record, explanation, model: descriptor.modelId,
        formatUsage: { ...record.formatUsage, [format]: generated.usage }
      } } };
    }, signal, validateCommit);
    return { ...latest, explanation, usage: generated.usage, cached: false };
  }

  /** Snapshot cache entries are namespaced and can never satisfy working-file lookup, hover, or prefetch. */
  private snapshotKey(target: FunctionTarget, scope: SnapshotExplanationSource, descriptor: ProviderDescriptor): string {
    return cacheKey(["snapshot-context-1", scope.side.path, scope.side.identity, scope.side.fingerprint,
      scope.occurrenceId, target.symbolId, descriptor.kind, descriptor.modelId, EXPLANATION_PROMPT_VERSION, EXPLANATION_SETTINGS]);
  }

  private async snapshotContext(target: FunctionTarget, scope: SnapshotExplanationSource): Promise<FunctionContext> {
    const language = languageFor({ languageId: target.languageId, path: scope.side.path });
    const preamble = (await language.preamble?.(scope.side.text, scope.side.path) ?? "").slice(0, 4096);
    return {
      text: preamble ? `Same-snapshot preamble (bounded to 4096 characters):\n${preamble}` : "",
      inputs: [{ path: scope.side.path, description: `Isolated snapshot ${scope.side.identity}`, fingerprint: scope.side.fingerprint, depth: 0 }],
      sourceReferences: [], referenceUris: new Map(),
      limitations: ["Historical callers and cross-file dependencies were not resolved; only the selected snapshot's function and bounded same-file preamble are used."]
    };
  }

  async findSnapshotExplanation(
    root: string, target: FunctionTarget, scope: SnapshotExplanationSource
  ): Promise<ExplanationResult | undefined> {
    await scope.validate();
    const descriptor = this.options.describeProvider();
    const key = this.snapshotKey(target, scope, descriptor);
    const record = (await this.readCache(root)).explanations[key];
    if (!record || record.promptVersion !== EXPLANATION_PROMPT_VERSION) return undefined;
    return {
      explanation: record.explanation, context: await this.snapshotContext(target, scope), provider: descriptor,
      cached: true, stale: false
    };
  }

  /** One explicit historical detail/format request; no overview, current dependencies, or file summary. */
  async explainSnapshot(
    root: string, target: FunctionTarget, scope: SnapshotExplanationSource,
    signal?: AbortSignal, format?: ExplanationFormat
  ): Promise<ExplanationResult> {
    this.requireModel();
    const requestId = JSON.stringify([root, "snapshot", this.snapshotKey(target, scope, this.options.describeProvider()), format ?? "explanation"]);
    const pending = this.inFlight.get(requestId);
    if (pending) return pending;
    const request = this.explainSnapshotFresh(root, target, scope, signal, format);
    this.inFlight.set(requestId, request);
    try {
      return await request;
    } finally {
      if (this.inFlight.get(requestId) === request) this.inFlight.delete(requestId);
    }
  }

  private async explainSnapshotFresh(
    root: string, target: FunctionTarget, scope: SnapshotExplanationSource,
    signal?: AbortSignal, format?: ExplanationFormat
  ): Promise<ExplanationResult> {
    const descriptor = this.options.describeProvider();
    const startingFence = this.fence(root);
    const key = this.snapshotKey(target, scope, descriptor);
    const validate = async () => {
      assertNotCancelled(signal);
      const latest = this.options.describeProvider();
      if (vscode.workspace.isTrusted === false || this.fence(root) !== startingFence ||
          latest.kind !== descriptor.kind || latest.modelId !== descriptor.modelId ||
          await sharingExclusion(root, resolve(root, scope.side.path)) ||
          await (await currentPolicy()).repositoryRestriction(root)) {
        throw new Error("The snapshot, sharing policy, or model changed; the explanation was not saved.");
      }
      await scope.validate();
      assertNotCancelled(signal);
    };
    await validate();
    const saved = await this.findSnapshotExplanation(root, target, scope);
    if (format && !saved) throw new Error("Regenerate the snapshot explanation before adding a format.");
    if (format && saved?.explanation[format]) return saved;
    if (!format && saved) return saved;
    const context = await this.snapshotContext(target, scope);
    const guidance = await languageFor({ languageId: target.languageId, path: scope.side.path }).explanationGuidance?.({
      path: scope.side.path, text: scope.side.text, line: target.range.start.line,
      name: target.name, qualifiedName: target.qualifiedName
    });
    const common = {
      repositoryName: basename(root), languageId: target.languageId, functionName: target.qualifiedName,
      signature: target.signature, source: target.source, ...(guidance ? { guidance } : {})
    };
    const explanationInput: ExplanationPromptInput = {
      ...common, relatedContext: context.text, limitations: context.limitations,
      formats: this.options.explanationFormats?.() ?? []
    };
    const formatInput: FormatPromptInput | undefined = format ? {
      ...common, format, stepTitles: saved!.explanation.steps.map((step) => step.title)
    } : undefined;
    const [system, user] = formatInput ? formatPrompt(formatInput) : explanationPrompt(explanationInput);
    const bytes = Buffer.byteLength(system + user, "utf8");
    if (bytes > this.maxRequestBytes()) throw tooLarge("snapshot explanation", bytes, this.maxRequestBytes());
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, bytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    await validate();
    const provider = await this.options.createProvider(descriptor);
    await validate();
    const generated = formatInput ? await provider.explainFormat(formatInput, signal)
      : await provider.explainFunction(explanationInput, signal);
    await validate();
    const content = normalizeStepLines(generated.value, target.source);
    const explanation = {
      ...(saved?.explanation ?? {}), ...content,
      limitations: [...new Set([...(saved?.explanation.limitations ?? []), ...((content as Partial<FunctionExplanation>).limitations ?? []), ...context.limitations])]
    } as FunctionExplanation;
    await this.options.store.update(root, (cache) => {
      const previous = cache.explanations[key];
      const record: ExplanationRecord = {
        key, symbolId: `snapshot:${scope.occurrenceId}`, languageId: target.languageId, path: scope.side.path,
        qualifiedName: target.qualifiedName, signature: target.signature, explanation,
        inputs: context.inputs, overviewVersion: "snapshot-context-1",
        explanationConfig: fingerprint(EXPLANATION_SETTINGS), promptVersion: EXPLANATION_PROMPT_VERSION,
        provider: descriptor.kind, model: descriptor.modelId, savedAt: Date.now(),
        usage: format ? previous?.usage : generated.usage,
        ...(format ? { formatUsage: { ...previous?.formatUsage, [format]: generated.usage } } : {})
      };
      return { ...cache, explanations: { ...cache.explanations, [key]: record } };
    }, signal, validate);
    // Persistence rename is the commit point. Do not recheck cancellation after a committed write.
    return { explanation, context, provider: descriptor, usage: generated.usage, cached: false, stale: false };
  }

  /** Cache-only lookup of the AI summary of a file; `current` is false when the file changed since. */
  async findFileSummary(
    root: string,
    document: vscode.TextDocument
  ): Promise<{ summary: string; current: boolean } | undefined> {
    const descriptor = this.options.describeProvider();
    const path = relative(root, document.uri.fsPath).split(sep).join("/");
    const record = (await this.readCache(root)).fileSummaries?.[fileSummaryKey(path, descriptor)];
    if (!record) return undefined;
    return { summary: record.summary, current: record.fingerprint === await sourceFingerprint(document.getText(), { path, languageId: document.languageId }) };
  }

  /** Saved one-sentence file summaries for the explanation model, current or not, by path. */
  async savedFileSummaries(root: string): Promise<Map<string, string>> {
    const descriptor = this.options.describeProvider();
    const saved = (await this.readCache(root)).fileSummaries ?? {};
    return new Map(Object.values(saved)
      .filter((record) => record.provider === descriptor.kind && record.model === descriptor.modelId && record.promptVersion === EXPLANATION_PROMPT_VERSION)
      .map((record) => [record.path, record.summary]));
  }

  /** The saved repository overview, from the cache only. */
  async savedOverview(root: string): Promise<RepositoryOverview | undefined> {
    return (await this.readCache(root)).overview?.value;
  }

  /** The repository overview's purpose, components, and flows, as background for project flows. */
  async overviewBackground(root: string): Promise<ProjectFlowsPromptInput["overview"]> {
    const overview = (await this.readCache(root)).overview?.value;
    return overview ? { purpose: overview.purpose, components: overview.components, flows: overview.flows } : undefined;
  }

  /**
   * The saved project map, from the cache only; `current` is false when it
   * was made with another overview model or detail setting. It is reviewed
   * with the repository overview, so it is never older than that.
   */
  async savedProjectMap(root: string): Promise<{ map: ProjectMap; current: boolean } | undefined> {
    const record = (await this.readCache(root)).projectMap;
    return record ? { map: record.value, current: record.config === this.mapConfig(this.overviewDescriptor()) } : undefined;
  }

  /** Cache-only lookup of a folder's saved project flows; `current` is false when their input changed since. */
  async findProjectFlows(
    root: string,
    request: FlowsRequest
  ): Promise<{ flows: readonly ProjectFlow[]; current: boolean } | undefined> {
    const record = (await this.readCache(root)).projectFlows?.[projectFlowsKey(request.input.path, this.overviewDescriptor())];
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
    this.requireModel(true);
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
    return (await this.readCache(root)).folderSummaries?.[folderSummaryKey(path, this.overviewDescriptor())]?.value.summary;
  }

  /** Cache-only lookup of a folder's saved summary; `current` is false when its input changed since. */
  async findFolderSummary(
    root: string,
    input: FolderSummaryPromptInput
  ): Promise<{ value: FolderSummary; current: boolean } | undefined> {
    const record = (await this.readCache(root)).folderSummaries?.[folderSummaryKey(input.path, this.overviewDescriptor())];
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
    this.requireModel(true);
    const startingFence = this.fence(root);
    const descriptor = this.overviewDescriptor();
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (restricted) throw new Error(`Nothing was sent because ${restricted}.`);
    const repositoryPurpose = (await this.readCache(root)).overview?.value.purpose;
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
    const saved = (await this.readCache(root)).fileSummaries ?? {};
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
    this.requireModel();
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
    const repositoryPurpose = (await this.readCache(root)).overview?.value.purpose;
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
    const record = (await this.readCache(snapshot.root)).comparisons?.[comparisonKey(snapshot, this.options.describeProvider())];
    return record?.promptVersion === COMPARISON_PROMPT_VERSION && record.catalogue?.version === 1 ? savedComparison(record, snapshot) : undefined;
  }

  /** Local eligibility only; this never prompts or starts a provider request. */
  private async reviewSummaryAllowed(ref: import("./context/comparison").ComparisonRef): Promise<boolean> {
    return vscode.workspace.isTrusted !== false &&
      !(await sharingExclusion(ref.root, resolve(ref.root, ref.original.path))) &&
      !(await sharingExclusion(ref.root, resolve(ref.root, ref.modified.path)));
  }

  /** Local source preparation and summary cache lookup; never generates or prompts. */
  async prepareReviewSummary(scope: ReviewSummaryScope, read: ReviewSummaryRead): Promise<PreparedReviewSummary> {
    validateReviewSummaryScope(scope);
    const checkFilter = (): void => {
      if (this.options.reviewFilterFingerprint && this.options.reviewFilterFingerprint(scope.root) !== scope.filterFingerprint) {
        throw new Error("The review filter changed. Confirm the review again before summarizing.");
      }
    };
    checkFilter();
    const cache = await this.readCache(scope.root);
    const restricted = await (await currentPolicy()).repositoryRestriction(scope.root);
    const request = await buildReviewSummaryRequest(
      scope, cache, this.options.describeProvider(), this.overviewDescriptor(), read,
      (ref) => restricted ? Promise.resolve(false) : this.reviewSummaryAllowed(ref), this.maxRequestBytes()
    );
    const saved = cache.reviewSummaries?.[request.scopeKey];
    checkFilter();
    // Explanation-only historical summaries must not appear as source-grounded content.
    const record = saved?.promptVersion === REVIEW_SUMMARY_PROMPT_VERSION ? saved : undefined;
    return {
      scopeKey: request.scopeKey, coverage: request.input.coverage,
      evidence: record?.evidence ?? request.evidence,
      ...(record ? { record } : {}),
      current: Boolean(record && record.promptVersion === REVIEW_SUMMARY_PROMPT_VERSION && record.fingerprint === request.fingerprint),
      canGenerate: request.evidence.length > 0 && request.bytes <= this.maxRequestBytes()
    };
  }

  /**
   * Builds a review export from saved records only. No provider, consent,
   * priming, or cache-write path is reachable here.
   */
  async prepareReviewExport(
    scope: ReviewSummaryScope,
    read: ReviewSummaryRead,
    provenance: { readonly head?: string; readonly commit?: string; readonly parent?: string }
  ): Promise<PreparedReviewExport> {
    const trusted = (): boolean => vscode.workspace.isTrusted !== false;
    if (!trusted()) throw new Error("Export requires a trusted workspace.");
    validateReviewSummaryScope(scope);
    const filterFingerprint = this.options.reviewFilterFingerprint?.(scope.root);
    if (filterFingerprint !== undefined && filterFingerprint !== scope.filterFingerprint) {
      throw new Error("The review filter changed. Confirm the review again before exporting.");
    }
    const startingFence = this.fence(scope.root);
    const policy = await currentPolicy();
    const report = await policy.repositoryReport(scope.root);
    if (report.restricted || report.error) {
      throw new Error(report.restricted
        ? "Repository sharing is now restricted; the review cannot be exported."
        : "Repository sharing policy could not be verified; the review cannot be exported.");
    }
    const cache = await this.readCache(scope.root);
    const functions = { ...this.options.describeProvider() };
    const overview = { ...this.overviewDescriptor() };
    const requestLimit = this.maxRequestBytes();
    const settingsMatch = (): boolean => {
      const currentFunctions = this.options.describeProvider();
      const currentOverview = this.overviewDescriptor();
      return currentFunctions.kind === functions.kind && currentFunctions.modelId === functions.modelId &&
        currentOverview.kind === overview.kind && currentOverview.modelId === overview.modelId &&
        this.maxRequestBytes() === requestLimit;
    };
    const request = await buildReviewSummaryRequest(
      scope, cache, functions, overview, read,
      async (ref) => {
        if (!trusted()) return false;
        const [original, modified] = await Promise.all([
          sharingExclusion(ref.root, resolve(ref.root, ref.original.path)),
          sharingExclusion(ref.root, resolve(ref.root, ref.modified.path))
        ]);
        return !original && !modified;
      },
      requestLimit
    );
    if (!trusted() || !settingsMatch() || this.fence(scope.root) !== startingFence ||
        (this.options.reviewFilterFingerprint && this.options.reviewFilterFingerprint(scope.root) !== scope.filterFingerprint)) {
      throw new Error("Workspace trust, cache state, or review filter changed. Try exporting again.");
    }
    const savedSummary = cache.reviewSummaries?.[request.scopeKey];
    if (!savedSummary || savedSummary.promptVersion !== REVIEW_SUMMARY_PROMPT_VERSION ||
        savedSummary.fingerprint !== request.fingerprint ||
        savedSummary.provider !== overview.kind || savedSummary.model !== overview.modelId ||
        JSON.stringify(savedSummary.evidence) !== JSON.stringify(request.evidence)) {
      throw new Error("The review summary is missing or outdated. Generate a current summary before exporting.");
    }
    if (savedSummary.coverage.lowValue === undefined) {
      throw new Error("This saved summary predates current review coverage and cannot be exported.");
    }

    const files: ReviewExportFile[] = [];
    for (const item of scope.items) {
      const snapshot = await read(item.ref);
      if (!reviewSnapshotMatches(item.ref, snapshot) ||
          snapshotSignature(snapshot) !== item.confirmed ||
          comparisonProblem(snapshot)) {
        files.push({ path: item.path, oldPath: item.ref.original.path !== item.path ? item.ref.original.path : undefined,
          status: "unavailable", reason: "the confirmed source is no longer available or has changed" });
        continue;
      }
      const allowed = await this.reviewSummaryAllowed(item.ref);
      if (!allowed) {
        files.push({ path: item.path, oldPath: item.ref.original.path !== item.path ? item.ref.original.path : undefined,
          status: "unavailable", reason: "a sharing exclusion now applies" });
        continue;
      }
      const key = comparisonKey(snapshot, functions);
      const record = cache.comparisons?.[key];
      const isCurrent = Boolean(record && reviewComparisonCurrent(record, snapshot, functions));
      if (isCurrent && record) {
        files.push({ path: item.path, oldPath: item.ref.original.path !== item.path ? item.ref.original.path : undefined,
          status: item.lowValue ? "low-value" : "current", comparison: record });
      } else {
        files.push({ path: item.path, oldPath: item.ref.original.path !== item.path ? item.ref.original.path : undefined,
          status: item.lowValue ? "low-value" : record ? "outdated" : "missing",
          reason: item.lowValue ? `excluded from summary evidence by ${item.lowValue.pattern}` :
            record ? "saved comparison is outdated or was made with another model" : "no saved current comparison" });
      }
    }
    for (const item of scope.items) {
      const latest = await read(item.ref);
      if (!reviewSnapshotMatches(item.ref, latest) || comparisonProblem(latest) ||
          snapshotSignature(latest) !== item.confirmed || !(await this.reviewSummaryAllowed(item.ref))) {
        throw new Error(`The confirmed source for ${item.path} changed while the export was prepared.`);
      }
    }
    if (!trusted() || !settingsMatch() || this.fence(scope.root) !== startingFence ||
        (this.options.reviewFilterFingerprint && this.options.reviewFilterFingerprint(scope.root) !== scope.filterFingerprint)) {
      throw new Error("Workspace trust, cache state, or review filter changed. Try exporting again.");
    }
    const finalPolicy = await (await currentPolicy()).repositoryReport(scope.root);
    if (finalPolicy.restricted || finalPolicy.error || !trusted() || !settingsMatch() ||
        this.fence(scope.root) !== startingFence ||
        (this.options.reviewFilterFingerprint && this.options.reviewFilterFingerprint(scope.root) !== scope.filterFingerprint)) {
      throw new Error("Repository sharing policy changed or could not be verified; the review cannot be exported.");
    }
    const data: ReviewExportData = {
      kind: scope.kind,
      base: scope.base,
      ...(provenance.head ? { head: provenance.head } : {}),
      ...(provenance.commit ? { commit: provenance.commit } : {}),
      ...(provenance.parent ? { parent: provenance.parent } : {}),
      summary: savedSummary,
      coverage: savedSummary.coverage,
      evidence: savedSummary.evidence,
      files,
      exportedAt: Date.now()
    };
    return { data, ...(provenance.head ? { head: provenance.head } : {}) };
  }

  /**
   * One explicit Overview-model request from frozen confirmed source diffs.
   * No overview priming, per-file generation or background consent.
   */
  async summarizeReview(scope: ReviewSummaryScope, read: ReviewSummaryRead, signal: AbortSignal): Promise<PreparedReviewSummary> {
    if (!providerConfigured(this.overviewDescriptor(), this.options.allowMock === true)) throw new ModelSetupRequired();
    assertNotCancelled(signal);
    validateReviewSummaryScope(scope);
    const confirmedScope = (): ReviewSummaryScope => ({
      kind: scope.kind, base: scope.base, root: scope.root,
      filterFingerprint: scope.filterFingerprint,
      items: scope.items.map(({ path, ref, confirmed, lowValue }) => ({ path, ref, confirmed, lowValue })),
      excluded: scope.excluded, skipped: scope.skipped, truncated: scope.truncated
    });
    const frozen = structuredClone(confirmedScope());
    const startingScope = JSON.stringify(frozen);
    const root = frozen.root;
    const startingFence = this.fence(root);
    const descriptor = { ...this.overviewDescriptor() };
    const functions = { ...this.options.describeProvider() };
    const limit = this.maxRequestBytes();
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (vscode.workspace.isTrusted === false || restricted) {
      throw new Error("Trust this workspace and resolve repository sharing restrictions before summarizing the review.");
    }
    const cache = await this.readCache(root);
    const request = await buildReviewSummaryRequest(
      frozen, cache, functions, descriptor, read, (ref) => this.reviewSummaryAllowed(ref), limit
    );
    if (!request.evidence.length || request.bytes > limit) {
      throw new Error("No current confirmed source diffs fit the review summary. Refresh the review sources or raise Downside Up: Max Request Size.");
    }
    const checkSettings = (): void => {
      const currentOverview = this.overviewDescriptor();
      if (vscode.workspace.isTrusted === false || this.fence(root) !== startingFence ||
          JSON.stringify(confirmedScope()) !== startingScope || this.maxRequestBytes() !== limit ||
          (this.options.reviewFilterFingerprint && this.options.reviewFilterFingerprint(root) !== frozen.filterFingerprint) ||
          descriptor.kind !== currentOverview.kind || descriptor.modelId !== currentOverview.modelId) {
        throw new Error("The review scope, sharing settings, or models changed; the review summary was discarded.");
      }
    };
    const validate = async (): Promise<void> => {
      assertNotCancelled(signal);
      checkSettings();
      if (await (await currentPolicy()).repositoryRestriction(root)) {
        throw new Error("Repository sharing is now restricted; the review summary was discarded.");
      }
      for (const consumed of request.consumed) {
        if (!(await this.reviewSummaryAllowed(consumed.item.ref))) {
          throw new Error("A file is no longer eligible for sharing; the review summary was discarded.");
        }
        const snapshot = await read(consumed.item.ref);
        if (!reviewSnapshotMatches(consumed.item.ref, snapshot) || comparisonProblem(snapshot) ||
            snapshotSignature(snapshot) !== consumed.item.confirmed) {
          throw new Error("A file changed while the review was summarized; the summary was discarded.");
        }
      }
      checkSettings();
      assertNotCancelled(signal);
    };
    await validate();
    const existing = cache.reviewSummaries?.[request.scopeKey];
    if (existing?.promptVersion === REVIEW_SUMMARY_PROMPT_VERSION && existing.fingerprint === request.fingerprint) {
      return this.prepareReviewSummary(frozen, read);
    }
    if (descriptor.kind !== "mock" &&
        !(await this.options.authorizeExternalData(root, descriptor, request.bytes, signal))) {
      throw new DOMException("External data sharing was not authorized.", "AbortError");
    }
    await validate();
    const provider = await this.options.createProvider(descriptor);
    await validate();
    const generated = await provider.summarizeReview(request.input, signal);
    const value = parseReviewSummary(generated.value, request.evidence.map((entry) => entry.id));
    // Fixed host coverage notices plus twenty validated model limitations.
    // Keep every valid caveat rather than silently truncating its meaning.
    const limitations = [...new Set([...request.input.limitations, ...value.limitations])];
    const record: ReviewSummaryRecord = {
      value: { ...value, limitations }, coverage: request.input.coverage, evidence: request.evidence,
      provider: descriptor.kind, model: descriptor.modelId, usage: generated.usage,
      promptVersion: REVIEW_SUMMARY_PROMPT_VERSION, fingerprint: request.fingerprint, savedAt: Date.now()
    };
    await validate();
    await this.options.store.update(root, (current) => {
      assertNotCancelled(signal);
      return { ...current, reviewSummaries: { ...current.reviewSummaries, [request.scopeKey]: record } };
    }, signal, async () => {
      // The write lock is held. Never reenter the store from this hook.
      await validate();
    });
    // Atomic rename is the commit point. Never reject a committed result for late cancellation.
    // Background file comparisons are not evidence and cannot invalidate this result.
    const prepared = await this.prepareReviewSummary(frozen, read).catch((): PreparedReviewSummary => ({
      scopeKey: request.scopeKey, coverage: record.coverage, evidence: record.evidence,
      record, current: false, canGenerate: false
    }));
    return prepared.record ? prepared : { ...prepared, record, evidence: record.evidence, current: false };
  }

  /**
   * Explains what the change between two exact versions of one file does,
   * on explicit request or opted-in prefetch, with one bounded request holding both sides.
   * `reread` reads the sides again after the model answers; a result is
   * rejected, not saved, when either side changed meanwhile.
   */
  async explainComparison(
    snapshot: ComparisonSnapshot,
    reread: () => Promise<ComparisonSnapshot>,
    signal?: AbortSignal
  ): Promise<SavedComparison & { usage?: Usage; cached: boolean }> {
    this.requireModel();
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
    const repositoryPurpose = (await this.readCache(root)).overview?.value.purpose;
    const input: ComparisonPromptInput = {
      repositoryName: basename(root),
      languageId: bundledLanguageIdForPath(path) ?? (extname(path).slice(1) || "text"),
      original: side(snapshot.original),
      modified: side(snapshot.modified),
      catalogue: await comparisonCatalogue(snapshot),
      ...(repositoryPurpose ? { repositoryPurpose } : {})
    };
    const [system, user] = comparisonPrompt(input);
    const requestBytes = Buffer.byteLength(system + user, "utf8");
    if (requestBytes > this.maxRequestBytes()) throw tooLarge("change", requestBytes, this.maxRequestBytes());
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const validate = async () => {
      const latest = await reread();
      assertNotCancelled(signal);
      const current = this.options.describeProvider();
      if (vscode.workspace.isTrusted === false || current.kind !== descriptor.kind || current.modelId !== descriptor.modelId ||
          this.fence(root) !== startingFence || comparisonProblem(latest) ||
          JSON.stringify(latest) !== JSON.stringify(snapshot) ||
          await sharingExclusion(root, resolve(root, snapshot.original.path)) || await sharingExclusion(root, resolve(root, snapshot.modified.path))) {
        throw new Error("The files changed while the change was being explained, so the result was discarded.");
      }
    };
    await validate();
    const provider = await this.options.createProvider(descriptor);
    await validate();
    const generated = await provider.explainComparison(input, signal);
    assertNotCancelled(signal);
    await validate();
    const comparison: FileComparison = {
      ...generated.value,
      limitations: [...new Set([...generated.value.limitations, ...input.catalogue!.limitations])],
      changes: generated.value.changes.map((change) => ({
        ...change,
        original: checkedSpan(change.original, snapshot.original),
        modified: checkedSpan(change.modified, snapshot.modified)
      }))
    };
    const record: ComparisonRecord = {
      catalogue: input.catalogue,
      original: sideRecord(snapshot.original),
      modified: sideRecord(snapshot.modified),
      comparison,
      usage: generated.usage,
      provider: descriptor.kind,
      model: descriptor.modelId,
      promptVersion: COMPARISON_PROMPT_VERSION,
      savedAt: Date.now()
    };
    let saved = false;
    // The write may wait behind others; a cancel or cache clear meanwhile still discards the result.
    await this.options.store.update(root, (current) => {
      if (this.fence(root) !== startingFence || signal?.aborted) return current;
      saved = true;
      return { ...current, comparisons: { ...current.comparisons, [comparisonKey(snapshot, descriptor)]: record } };
    }, signal, validate);
    if (!saved) {
      assertNotCancelled(signal);
      throw new Error("The files changed while the change was being explained, so the result was discarded.");
    }
    return { ...savedComparison(record, snapshot), usage: generated.usage, cached: false };
  }

  async clearCache(root: string): Promise<void> {
    this.generationFences.set(root, this.fence(root) + 1);
    await this.options.store.clear(root);
  }
}

function savedComparison(record: ComparisonRecord, snapshot: ComparisonSnapshot): SavedComparison {
  return {
    comparison: record.comparison,
    catalogue: record.catalogue,
    current: record.original.fingerprint === snapshot.original.fingerprint && record.modified.fingerprint === snapshot.modified.fingerprint,
    savedAt: record.savedAt,
    model: record.model,
    ...(record.usage ? { usage: record.usage } : {}),
    original: record.original,
    modified: record.modified
  };
}
