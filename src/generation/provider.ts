import type {
  ExplanationFormat,
  FileSummary,
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
  /** Extra views to include besides the steps. */
  readonly formats: readonly ExplanationFormat[];
}

/** Input for adding one extra view to a saved explanation. */
export interface FormatPromptInput {
  readonly repositoryName: string;
  readonly languageId: string;
  readonly functionName: string;
  readonly signature: string;
  readonly source: string;
  readonly format: ExplanationFormat;
  /** Titles of the saved steps, so the new view tells the same story. */
  readonly stepTitles: readonly string[];
}

export interface FileSummaryPromptInput {
  readonly repositoryName: string;
  readonly path: string;
  readonly languageId: string;
  readonly source: string;
  readonly truncated: boolean;
  readonly repositoryPurpose?: string;
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
  summarizeFile(
    input: FileSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileSummary>>;
  explainFormat(
    input: FormatPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<Pick<FunctionExplanation, "pseudocode" | "flowchart">>>;
}

export function formatUsage(usage: Usage): string {
  return usage.estimated
    ? `Estimated tokens: ${usage.inputTokens} input / ${usage.outputTokens} output`
    : `Provider-reported tokens: ${usage.inputTokens} input / ${usage.outputTokens} output`;
}
