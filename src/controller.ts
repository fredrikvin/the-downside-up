import { basename, relative, sep } from "node:path";
import type * as vscode from "vscode";
import { inputsMatch, explanationCacheKey } from "./cache/freshness";
import type { RepositoryCacheStore } from "./cache/store";
import { cacheKey, fingerprint } from "./core/fingerprint";
import type {
  ExplanationFormat,
  ExplanationRecord,
  FileSummaryRecord,
  FunctionExplanation,
  FunctionTarget,
  GenerationResult,
  OverviewRecord,
  ProviderKind,
  RepositoryOverview,
  Usage
} from "./core/types";
import { gatherInventory, sharingExclusion, type RepositoryInventory } from "./context/inventory";
import {
  gatherFunctionContext,
  type FunctionContext
} from "./context/related";
import { addLocalSymbolOutline } from "./context/symbolIndex";
import { currentPolicy } from "./context/policy";
import { languageFor } from "./languages/registry";
import { normalizeStepLines } from "./presentation/stepLines";
import {
  EXPLANATION_PROMPT_VERSION,
  explanationPrompt,
  fileSummaryPrompt,
  formatPrompt,
  overviewPrompt,
  PROMPT_VERSION,
  reviewPrompt
} from "./generation/prompts";
import type {
  ExplanationPromptInput,
  FileSummaryPromptInput,
  FormatPromptInput,
  GenerationProvider,
  OverviewReviewPromptInput,
  RepositoryPromptInput
} from "./generation/provider";

export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly modelId: string;
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
  readonly createProvider: (descriptor: ProviderDescriptor) => Promise<GenerationProvider>;
  readonly authorizeExternalData: (
    root: string,
    descriptor: ProviderDescriptor,
    estimatedBytes: number,
    signal?: AbortSignal
  ) => Promise<boolean>;
  /** Extra views to include when generating explanations; none when omitted. */
  readonly explanationFormats?: () => readonly ExplanationFormat[];
}

const MAX_PRIMING_BYTES = 96 * 1024;
const MAX_EXPLANATION_BYTES = 48 * 1024;
const MAX_FILE_SUMMARY_SOURCE_BYTES = 24 * 1024;

function fileSummaryKey(path: string, descriptor: ProviderDescriptor): string {
  return cacheKey([path, descriptor.kind, descriptor.modelId, EXPLANATION_PROMPT_VERSION]);
}

/** Whitespace-insensitive, so reformatting alone does not outdate a file summary. */
function fileTextFingerprint(text: string): string {
  return fingerprint(text.replace(/\s+/g, " ").trim());
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

function inputToOverview(inventory: RepositoryInventory): RepositoryPromptInput {
  return {
    repositoryName: inventory.name,
    inventory: inventory.inventoryText,
    languageIds: inventory.languageIds
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

export class ExplanationService {
  private readonly inFlight = new Map<string, Promise<ExplanationResult>>();
  private readonly generationFences = new Map<string, number>();

  constructor(private readonly options: ExplanationServiceOptions) {}

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
      const context = await gatherFunctionContext(target, document, inventory);
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

    const overviewConfig = `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}`;
    const usages: Usage[] = [];
    let externalSharingAuthorized = false;
    const providerCallForRequest = async <T>(
      bytes: number,
      call: (provider: GenerationProvider) => Promise<GenerationResult<T>>
    ) => {
      if (descriptor.kind !== "mock" && !externalSharingAuthorized) {
        const accepted = await this.options.authorizeExternalData(root, descriptor, bytes, signal);
        if (!accepted) {
          throw new DOMException("External code sharing was not authorized.", "AbortError");
        }
        externalSharingAuthorized = true;
      }
      assertNotCancelled(signal);
      return call(await this.options.createProvider(descriptor));
    };

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
      const context = await gatherFunctionContext(target, document, inventory);
      if (
        Buffer.byteLength(inventory.inventoryText, "utf8") > MAX_PRIMING_BYTES ||
        Buffer.byteLength(context.text, "utf8") > MAX_EXPLANATION_BYTES
      ) {
        throw new Error("Selected source context exceeds the prototype's request-size limit; no code was sent.");
      }
      assertNotCancelled(signal);
      // A current saved explanation is returned without reviewing the overview first.
      if (cache.overview && isCurrent(cache.explanations[key], context.inputs)) {
        return { cache, inventory, context, overviewRecord: cache.overview };
      }

      const shouldReview =
        !cache.overview ||
        cache.overview.config !== overviewConfig ||
        needsOverviewReview(inventory, cache.overview);
      let overviewRecord = cache.overview;

      if (shouldReview) {
        const previous = cache.overview;
        progress(previous ? "reviewing" : "priming", previous ? "Reviewing bounded repository changes." : "Priming repository context.");
        const prompt = inputToOverview(inventory);
        let generated: GenerationResult<RepositoryOverview>;
        if (previous && previous.config === overviewConfig) {
          const reviewInput: OverviewReviewPromptInput = {
            ...prompt,
            previous: previous.value,
            changedPaths: inventory.changedPaths
          };
          const [system, user] = reviewPrompt(reviewInput);
          const requestBytes = Buffer.byteLength(system + user, "utf8");
          if (requestBytes > MAX_PRIMING_BYTES) {
            throw new Error("The complete repository-review request exceeds 96 KiB; no code was sent.");
          }
          generated = await providerCallForRequest(
            requestBytes,
            (provider) => provider.reviewRepository(reviewInput, signal)
          );
        } else {
          const [system, user] = overviewPrompt(prompt);
          const requestBytes = Buffer.byteLength(system + user, "utf8");
          if (requestBytes > MAX_PRIMING_BYTES) {
            throw new Error("The complete repository-priming request exceeds 96 KiB; no code was sent.");
          }
          generated = await providerCallForRequest(
            requestBytes,
            (provider) => provider.explainRepository(prompt, signal)
          );
        }
        assertNotCancelled(signal);
        if (this.fence(root) !== startingFence) {
          throw new Error("The repository cache was cleared while context was being refreshed.");
        }
        usages.push(generated.usage);
        const value = normalizedOverview(generated.value, descriptor.kind);
        const version = overviewFingerprint(value);
        overviewRecord = withOverview(
          value,
          previous?.value && version === overviewFingerprint(previous.value)
            ? previous.contentVersion
            : version,
          inventory.snapshot,
          inventory.primedPaths,
          overviewConfig
        );
        cache = await this.options.store.update(root, (current) => ({
          ...current,
          overview: overviewRecord!
        }));
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
    if (explanationBytes > MAX_EXPLANATION_BYTES) {
      throw new Error("The complete explanation request exceeds 48 KiB; no code was sent.");
    }
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
    const latestContext = await gatherFunctionContext(target, document, latestInventory);
    if (
      latestInventory.changedPaths.length > 0 ||
      !inputsMatch(context.inputs, latestContext.inputs) ||
      this.fence(root) !== startingFence
    ) {
      throw new Error(
        "Source or repository context changed while the explanation was generating. It was not saved as current; run Explain again."
      );
    }

    const entry: ExplanationRecord = {
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
      context,
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

  private async refreshRepositoryContextNow(
    root: string,
    signal?: AbortSignal,
    onProgress?: (progress: ExplanationProgress) => void
  ): Promise<{ overview: RepositoryOverview; usage: Usage }> {
    const startingFence = this.fence(root);
    const descriptor = this.options.describeProvider();
    const restricted = await (await currentPolicy()).repositoryRestriction(root);
    if (restricted) throw new Error(`Nothing was sent because ${restricted}.`);
    const cache = await this.options.store.read(root);
    const baseInventory = await gatherInventory(root, cache.overview?.checkedSnapshot);
    const inventory = await addLocalSymbolOutline(baseInventory);
    if (Buffer.byteLength(inventory.inventoryText, "utf8") > MAX_PRIMING_BYTES) {
      throw new Error("Repository inventory exceeds the priming budget; no code was sent.");
    }
    const prompt = inputToOverview(inventory);
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
    let result: GenerationResult<RepositoryOverview>;
    if (cache.overview && cache.overview.config === `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}`) {
      const review: OverviewReviewPromptInput = {
        ...prompt,
        previous: cache.overview.value,
        changedPaths: inventory.changedPaths
      };
      const [system, user] = reviewPrompt(review);
      if (Buffer.byteLength(system + user, "utf8") > MAX_PRIMING_BYTES) {
        throw new Error("The complete repository-review request exceeds 96 KiB; no code was sent.");
      }
      onProgress?.({ stage: "reviewing", detail: "Reviewing repository context by request." });
      await authorize();
      result = await (await this.options.createProvider(descriptor)).reviewRepository(review, signal);
    } else {
      const [system, user] = overviewPrompt(prompt);
      if (Buffer.byteLength(system + user, "utf8") > MAX_PRIMING_BYTES) {
        throw new Error("The complete repository-priming request exceeds 96 KiB; no code was sent.");
      }
      onProgress?.({ stage: "priming", detail: "Building repository context by request." });
      await authorize();
      result = await (await this.options.createProvider(descriptor)).explainRepository(prompt, signal);
    }
    assertNotCancelled(signal);
    if (this.fence(root) !== startingFence) {
      throw new Error("The repository cache was cleared while context was being refreshed.");
    }
    const value = normalizedOverview(result.value, descriptor.kind);
    const version = overviewFingerprint(value);
    const overviewRecord = withOverview(
      value,
      cache.overview?.value && overviewFingerprint(cache.overview.value) === version
        ? cache.overview.contentVersion
        : version,
      inventory.snapshot,
      inventory.primedPaths,
      `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}`
    );
    await this.options.store.update(root, (current) => ({
      ...current,
      overview: overviewRecord
    }));
    return { overview: value, usage: result.usage };
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
    if (requestBytes > MAX_EXPLANATION_BYTES) {
      throw new Error("The function is too large for this view; no code was sent.");
    }
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const generated = await (await this.options.createProvider(descriptor)).explainFormat(input, signal);
    assertNotCancelled(signal);
    const added = normalizeStepLines(generated.value, target.source);
    const latest = await this.findCachedExplanation(root, target, document);
    if (!latest || this.fence(root) !== startingFence || !inputsMatch(saved.context.inputs, latest.context.inputs)) {
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
      return { ...current, explanations: { ...current.explanations, [key]: { ...record, explanation } } };
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
    return { summary: record.summary, current: record.fingerprint === fileTextFingerprint(document.getText()) };
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
    const startingFingerprint = fileTextFingerprint(text);
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
    if (requestBytes > MAX_EXPLANATION_BYTES) return undefined;
    assertNotCancelled(signal);
    if (descriptor.kind !== "mock" && !(await this.options.authorizeExternalData(root, descriptor, requestBytes, signal))) {
      throw new DOMException("External code sharing was not authorized.", "AbortError");
    }
    const generated = await (await this.options.createProvider(descriptor)).summarizeFile(input, signal);
    assertNotCancelled(signal);
    if (this.fence(root) !== startingFence || fileTextFingerprint(document.getText()) !== startingFingerprint) {
      return undefined;
    }
    const record: FileSummaryRecord = {
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

  async clearCache(root: string): Promise<void> {
    this.generationFences.set(root, this.fence(root) + 1);
    await this.options.store.clear(root);
  }

  readCache(root: string) {
    return this.options.store.read(root);
  }
}
