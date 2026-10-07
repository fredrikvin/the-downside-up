import { basename, relative, sep } from "node:path";
import type * as vscode from "vscode";
import { inputsMatch, explanationCacheKey } from "./cache/freshness";
import type { RepositoryCacheStore } from "./cache/store";
import { fingerprint } from "./core/fingerprint";
import type {
  ExplanationRecord,
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
import {
  explanationPrompt,
  overviewPrompt,
  PROMPT_VERSION,
  reviewPrompt
} from "./generation/prompts";
import type {
  ExplanationPromptInput,
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
}

const MAX_PRIMING_BYTES = 96 * 1024;
const MAX_EXPLANATION_BYTES = 48 * 1024;
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
    const overviewConfig = `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}`;
    if (!overview || overview.config !== overviewConfig) return results;
    const settingsHash = fingerprint(EXPLANATION_SETTINGS);
    const candidates = targets.flatMap((target) => {
      const cached = cache.explanations[explanationCacheKey(
        target.symbolId,
        descriptor.kind,
        descriptor.modelId,
        overview.contentVersion,
        settingsHash,
        PROMPT_VERSION
      )];
      return cached &&
        cached.promptVersion === PROMPT_VERSION &&
        cached.explanationConfig === settingsHash &&
        cached.overviewVersion === overview.contentVersion
        ? [{ target, cached }]
        : [];
    });
    if (candidates.length === 0) return results;
    const inventory = await gatherInventory(root, overview.checkedSnapshot);
    if (needsOverviewReview(inventory, overview)) return results;
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
        stale: false
      });
    }
    return results;
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

    const overviewConfig = `${descriptor.kind}:${descriptor.modelId}:${PROMPT_VERSION}`;
    const shouldReview =
      !cache.overview ||
      cache.overview.config !== overviewConfig ||
      needsOverviewReview(inventory, cache.overview);
    const usages: Usage[] = [];
    let overviewRecord = cache.overview;
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

    if (!overviewRecord) throw new Error("Repository context could not be prepared.");
    if (this.fence(root) !== startingFence) throw new Error("The repository cache was cleared.");
    const settingsHash = fingerprint(EXPLANATION_SETTINGS);
    const key = explanationCacheKey(
      target.symbolId,
      descriptor.kind,
      descriptor.modelId,
      overviewRecord.contentVersion,
      settingsHash,
      PROMPT_VERSION
    );
    const cached = cache.explanations[key];
    if (
      cached &&
      cached.promptVersion === PROMPT_VERSION &&
      cached.explanationConfig === settingsHash &&
      cached.overviewVersion === overviewRecord.contentVersion &&
      inputsMatch(cached.inputs, context.inputs)
    ) {
      progress("complete", "Cached explanation is current: recorded inputs match.");
      const usage = usageTotal(usages);
      return {
        explanation: cached.explanation,
        overview: overviewRecord.value,
        context,
        provider: descriptor,
        ...(usage ? { usage } : {}),
        cached: true,
        stale: false
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
    const explanation = generated.value;
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
      promptVersion: PROMPT_VERSION,
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
    const startingFence = this.fence(root);
    const descriptor = this.options.describeProvider();
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

  async clearCache(root: string): Promise<void> {
    this.generationFences.set(root, this.fence(root) + 1);
    await this.options.store.clear(root);
  }

  readCache(root: string) {
    return this.options.store.read(root);
  }
}
