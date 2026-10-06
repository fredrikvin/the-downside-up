import type {
  FunctionExplanation,
  GenerationResult,
  ProviderKind,
  RepositoryOverview,
  Usage
} from "../core/types";

export interface RepositoryPromptInput {
  readonly repositoryName: string;
  readonly inventory: string;
  readonly languageIds: readonly string[];
}

export interface ExplanationPromptInput {
  readonly repositoryName: string;
  readonly languageId: string;
  readonly functionName: string;
  readonly signature: string;
  readonly source: string;
  readonly overview: RepositoryOverview;
  readonly relatedContext: string;
  readonly limitations: readonly string[];
}

export interface OverviewReviewPromptInput extends RepositoryPromptInput {
  readonly previous: RepositoryOverview;
  readonly changedPaths: readonly string[];
}

export interface GenerationProvider {
  readonly kind: ProviderKind;
  readonly modelId: string;
  explainRepository(
    input: RepositoryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryOverview>>;
  reviewRepository(
    input: OverviewReviewPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryOverview>>;
  explainFunction(
    input: ExplanationPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FunctionExplanation>>;
}

export function formatUsage(usage: Usage): string {
  return usage.estimated
    ? `Estimated tokens: ${usage.inputTokens} input / ${usage.outputTokens} output`
    : `Provider-reported tokens: ${usage.inputTokens} input / ${usage.outputTokens} output`;
}
