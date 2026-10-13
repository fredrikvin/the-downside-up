import type {
  ExplanationFormat,
  FileSummary,
  FolderSummary,
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
  /** Background on this kind of function from the extension's language support, never from repository text. */
  readonly guidance?: string;
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
  /** Background on this kind of function from the extension's language support, never from repository text. */
  readonly guidance?: string;
}

export interface FileSummaryPromptInput {
  readonly repositoryName: string;
  readonly path: string;
  readonly languageId: string;
  readonly source: string;
  readonly truncated: boolean;
  readonly repositoryPurpose?: string;
}

/** One file or subfolder of a folder being summarized; names and summaries only, never code. */
export interface FolderPartInput {
  readonly name: string;
  readonly kind: "file" | "folder";
  /** Its saved summary, when there is one. */
  readonly summary?: string;
  /** For files without a summary: names of their functions and types. For folders without one: their contents' names. */
  readonly contents?: readonly string[];
}

export interface FolderSummaryPromptInput {
  readonly repositoryName: string;
  /** Repository-relative folder path, or "" for the repository root. */
  readonly path: string;
  readonly repositoryPurpose?: string;
  readonly parts: readonly FolderPartInput[];
  /** Import edges between the parts, by name. */
  readonly imports: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** The folder's README, bounded. */
  readonly readme?: string;
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
  summarizeFolder(
    input: FolderSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FolderSummary>>;
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
