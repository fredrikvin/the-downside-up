import type {
  ExplanationFormat,
  ComparisonCatalogue,
  FileComparisonDraft,
  FileSummary,
  FolderSummary,
  FunctionExplanation,
  ProjectFlowsDraft,
  GenerationResult,
  ProjectMap,
  ProjectMapDetail,
  ProviderKind,
  RepositoryOverview,
  RepositoryPriming,
  Usage
} from "../core/types";
import type { FolderPageLevel } from "../context/projectMap";

export interface RepositoryPromptInput {
  readonly repositoryName: string;
  readonly inventory: string;
  readonly languageIds: readonly string[];
  /** Bounded folder outline with component markers, one folder per line; the map's paths come from it. */
  readonly folders: string;
  /** Whether the map also describes each component in a few sentences. */
  readonly mapDetail: ProjectMapDetail;
}

export interface ExplanationPromptInput {
  readonly repositoryName: string;
  readonly languageId: string;
  readonly functionName: string;
  readonly signature: string;
  readonly source: string;
  readonly overview?: RepositoryOverview;
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

/** One side of a comparison: where it came from and its text, or no text when the file is absent on that side. */
export interface ComparisonSidePromptInput {
  readonly path: string;
  /** Plain words for what the side is, such as "the committed version" or "the working tree". */
  readonly label: string;
  readonly present: boolean;
  readonly source: string;
}

/** The exact original and modified text of one file in a diff. */
export interface ComparisonPromptInput {
  readonly repositoryName: string;
  readonly languageId: string;
  readonly original: ComparisonSidePromptInput;
  readonly modified: ComparisonSidePromptInput;
  readonly repositoryPurpose?: string;
  readonly catalogue?: ComparisonCatalogue;
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
  /** How the folder page zooms, from the project map; absent before there is one. */
  readonly level?: FolderPageLevel;
  /** The project map's sentence about this folder, as background. */
  readonly mapSummary?: string;
  /** For components: their API contracts (OpenAPI, AsyncAPI, GraphQL, protobuf), bounded. */
  readonly contracts?: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}

/** A part of the project map that flows may pass through: inside the folder, elsewhere in the repository, or outside it. */
export interface FlowPartInput {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly place: "inside" | "outside" | "external";
}

/** What flows between a project's, group's, or component's parts are made from: its map, never code. */
export interface PartFlowsPromptInput {
  readonly repositoryName: string;
  /** Repository-relative folder path, or "" for the repository root. */
  readonly path: string;
  readonly level: FolderPageLevel;
  /** The map's summary of the folder (or of the project), when there is one. */
  readonly summary?: string;
  readonly parts: readonly FlowPartInput[];
  readonly links: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string }>;
}

/** A file the flows may point to: its path, saved summary, and function names; never code. */
export interface FlowCatalogEntry {
  readonly path: string;
  readonly summary?: string;
  readonly functions: readonly string[];
}

export interface ProjectFlowsPromptInput {
  readonly repositoryName: string;
  /** Repository-relative folder path, or "" for the repository root. */
  readonly path: string;
  /** Background from the repository overview, when there is one. */
  readonly overview?: { readonly purpose: string; readonly components: string; readonly flows: string };
  /** The folder's saved summary, when there is one. */
  readonly folderSummary?: string;
  readonly catalog: readonly FlowCatalogEntry[];
  /** Import edges between the folder's parts, by path. */
  readonly imports: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** True when the catalog had to be shortened to fit the request. */
  readonly truncated: boolean;
}

export interface OverviewReviewPromptInput extends RepositoryPromptInput {
  readonly previous: RepositoryOverview;
  /** The saved project map, when it was made with the same settings. */
  readonly previousMap?: ProjectMap;
  readonly changedPaths: readonly string[];
}

export interface GenerationProvider {
  readonly kind: ProviderKind;
  readonly modelId: string;
  explainRepository(
    input: RepositoryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryPriming>>;
  reviewRepository(
    input: OverviewReviewPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryPriming>>;
  explainFunction(
    input: ExplanationPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FunctionExplanation>>;
  summarizeFile(
    input: FileSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileSummary>>;
  /** Explains what the change between two versions of one file does to behavior and flow. */
  explainComparison(
    input: ComparisonPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileComparisonDraft>>;
  summarizeFolder(
    input: FolderSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FolderSummary>>;
  describeFlows(
    input: ProjectFlowsPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<ProjectFlowsDraft>>;
  /** Flows between map parts; each node's part id is returned in `refs[].file`. */
  describePartFlows(
    input: PartFlowsPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<ProjectFlowsDraft>>;
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
