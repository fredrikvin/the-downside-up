import type * as vscode from "vscode";

export interface FunctionTarget {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly selection: vscode.Range;
  readonly languageId: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly source: string;
  readonly symbolId: string;
  readonly structuralFingerprint: string;
  /** How the function was found, such as `rust-tree-sitter` or `vscode-symbols`. */
  readonly analysis: string;
}

export interface ContextInput {
  readonly id: string;
  readonly uri: vscode.Uri;
  readonly description: string;
  readonly text: string;
  readonly fingerprint: string;
  readonly version: number;
}

export interface RepositoryOverview {
  readonly purpose: string;
  readonly components: string;
  readonly flows: string;
  readonly conventions: string;
  readonly uncertainties: string;
  readonly limitations: string[];
}

export interface ExplanationInput {
  /** Friendly name, such as "Organization ID". */
  readonly label: string;
  /** Name in the code, such as `orgID`. */
  readonly name: string;
  readonly description: string;
}

/** Source lines an explanation item covers, checked by the extension before they are used. */
export interface LineLinked {
  /** 1-based lines of the function source; 0 when not tied to lines. */
  readonly startLine: number;
  readonly endLine: number;
  /** Trimmed text of the first line, recorded by the extension to find the item again after lines shift. */
  readonly anchor?: string;
}

export interface PseudocodeLine extends LineLinked {
  readonly text: string;
  /** Indentation level, 0-4. */
  readonly depth: number;
}

/** `show` is an exit that returns something shown on screen, such as a React element. */
export type FlowNodeKind = "start" | "action" | "decision" | "end" | "show";

export interface FlowNode extends LineLinked {
  readonly id: string;
  readonly kind: FlowNodeKind;
  readonly label: string;
  /**
   * The `show` node this node is drawn inside, as part of the logic that
   * decides what appears within it (such as a button's label); absent at the
   * top level.
   */
  readonly parent?: string;
}

export interface FlowEdge {
  readonly from: string;
  readonly to: string;
  /** Such as "yes", "no", or "error"; empty for plain sequence. */
  readonly label: string;
}

export interface Flowchart {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

/** Optional views of a function's flow besides the numbered steps. */
export type ExplanationFormat = "pseudocode" | "flowchart";

export interface ExplanationStep extends LineLinked {
  /** Short plain-language step title, such as "Request the wearer". */
  readonly title: string;
  readonly detail: string;
  /**
   * When the step runs, for code that runs at different times, such as
   * "Each time it is shown" or "When the person clicks Check out"; absent
   * when every step runs in one call.
   */
  readonly phase?: string;
}

export interface ExplanationNote {
  /** Section heading for something worth knowing, such as "Cleanup". */
  readonly heading: string;
  readonly text: string;
}

/**
 * A plain-language explanation for readers who do not know the language.
 * The core reads on its own; `role`, `edgeCases`, and `languageNotes` are
 * extra detail shown on request.
 */
export interface FunctionExplanation {
  /** Short action phrase, such as "Fetch a wearer". */
  readonly title: string;
  /** One sentence on what the function is for. */
  readonly purpose: string;
  readonly inputs: readonly ExplanationInput[];
  /** What comes back, or an empty string when nothing does. */
  readonly result: string;
  readonly steps: readonly ExplanationStep[];
  /** Extra sections only when relevant, such as cleanup or background work. */
  readonly notes: readonly ExplanationNote[];
  readonly role: string;
  readonly edgeCases: string;
  readonly languageNotes: string;
  readonly limitations: string[];
  /** Present when generated; added later on request for saved explanations. */
  readonly pseudocode?: readonly PseudocodeLine[];
  readonly flowchart?: Flowchart;
}

export interface FileSummary {
  /** One plain-language sentence on what the file does. */
  readonly summary: string;
}

/** A plain-language summary of a folder, made from its contents' names and saved summaries. */
export interface FolderSummary {
  /** One sentence on what the folder is for. */
  readonly summary: string;
  /** A few sentences on how its parts fit together. */
  readonly overview: string;
  /** One sentence for each listed file or subfolder that had no summary of its own. */
  readonly parts: ReadonlyArray<{ readonly name: string; readonly summary: string }>;
  /** For components: what it provides to others, such as APIs or events. */
  readonly offers?: string;
  /** For components: what it relies on, such as other services or databases. */
  readonly uses?: string;
}

/**
 * How far a folder page zooms: the project shows its main parts, a group
 * (such as `services/`) its members, a component (a service, app, or
 * library) its internal parts, a module its files, and support folders
 * (docs, tools, tests, infrastructure) only a short description.
 */
export type FolderLevel = "group" | "component" | "module" | "support";

/** A part of the project map: a repository folder at some level, or something outside the repository. */
export interface MapPart {
  /** Short unique id, used by links and flows. */
  readonly id: string;
  /** Repository-relative folder; absent for things outside the repository, such as devices or cloud services. */
  readonly path?: string;
  readonly level: FolderLevel | "external";
  /** Plain name, such as "Inventory service". */
  readonly name: string;
  /** One plain sentence. */
  readonly summary: string;
  /** With detailed maps, for components: a few sentences, what it provides, and what it relies on. */
  readonly detail?: string;
  readonly offers?: string;
  readonly uses?: string;
}

/** A connection between two map parts, such as a frontend calling a service over GraphQL. */
export interface MapLink {
  readonly from: string;
  readonly to: string;
  /** How, in a few words, such as "GraphQL" or "MQTT events". */
  readonly label: string;
}

/** The project's parts at every level and how they connect, made while priming the repository. */
export interface ProjectMap {
  /** Two or three sentences about the whole project. */
  readonly summary: string;
  readonly parts: readonly MapPart[];
  readonly links: readonly MapLink[];
}

export type ProjectMapDetail = "brief" | "detailed";

export interface ProjectMapRecord {
  readonly value: ProjectMap;
  /** Provider, model, prompt version, and detail setting it was made with. */
  readonly config: string;
  readonly savedAt: number;
}

/** What priming or reviewing a repository returns: the overview used for explanations, and the project map. */
export interface RepositoryPriming {
  readonly overview: RepositoryOverview;
  readonly map: ProjectMap;
}

/** Where a project flow's step happens: a repository file and, optionally, a function in it, or a mapped folder. */
export interface FlowReference {
  /** Repository-relative path. */
  readonly path: string;
  /** Qualified function name as the extension lists it. */
  readonly function?: string;
  /** True when `path` is a folder of the project map, opened as a folder preview. */
  readonly folder?: boolean;
}

/** A main flow through a folder or project, drawn as a flowchart whose steps point to code. */
export interface ProjectFlow {
  /** Such as "Checking out a book". */
  readonly title: string;
  readonly summary: string;
  readonly chart: Flowchart;
  /** For each node of `chart`, by index: where its step happens, when the extension could confirm it. */
  readonly refs: ReadonlyArray<FlowReference | null>;
}

/** Flows as a model returns them, before the extension checks their references. */
export interface ProjectFlowsDraft {
  readonly flows: ReadonlyArray<{
    readonly title: string;
    readonly summary: string;
    readonly chart: Flowchart;
    /** For each node, the file and function the model named; empty strings when none. */
    readonly refs: ReadonlyArray<{ readonly file: string; readonly function: string }>;
  }>;
}

export interface ProjectFlowsRecord {
  readonly path: string;
  readonly flows: readonly ProjectFlow[];
  readonly fingerprint: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly promptVersion: string;
  readonly savedAt: number;
}

export interface FolderSummaryRecord {
  /** Repository-relative folder path, or "" for the repository root. */
  readonly path: string;
  readonly value: FolderSummary;
  /** Fingerprint of the input it was made from (names, saved summaries, outlines, README, imports). */
  readonly fingerprint: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly promptVersion: string;
  readonly savedAt: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimated: boolean;
}

export type ProviderKind = "mock" | "openai" | "vscode-lm";

export type ExternalProviderKind = Exclude<ProviderKind, "mock">;

export interface GenerationResult<T> {
  readonly value: T;
  readonly usage: Usage;
  readonly provider: ProviderKind;
}

export interface TrackedInput {
  readonly path: string;
  readonly description: string;
  readonly fingerprint: string;
  /** Distance from the explained function: 0 for itself, 1 for items it uses directly. Absent for callers and file context. */
  readonly depth?: number;
  /** Whether the fingerprint covers the whole item or only its signature; absent means the whole item. */
  readonly scope?: "body" | "signature";
}

export interface ExplanationRecord {
  readonly key: string;
  readonly symbolId: string;
  readonly languageId: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly signature: string;
  readonly explanation: FunctionExplanation;
  readonly inputs: TrackedInput[];
  readonly overviewVersion: string;
  readonly explanationConfig: string;
  readonly promptVersion: string;
  readonly provider: ProviderKind;
  readonly savedAt: number;
}

export interface OverviewRecord {
  readonly value: RepositoryOverview;
  readonly contentVersion: string;
  readonly checkedSnapshot: Record<string, string>;
  /** Repository files sent when priming; a change to any of them prompts an overview review. */
  readonly primedPaths: string[];
  readonly checkedAt: number;
  readonly config: string;
}

export interface RepositoryCache {
  readonly schemaVersion: 1;
  readonly consent: {
    readonly provider: ExternalProviderKind;
    readonly model: string;
    readonly acceptedAt: number;
  } | null;
  /** Every approval for this repository, one per model; `consent` is the latest. */
  readonly consents?: ReadonlyArray<{
    readonly provider: ExternalProviderKind;
    readonly model: string;
    readonly acceptedAt: number;
  }>;
  readonly overview: OverviewRecord | null;
  readonly explanations: Record<string, ExplanationRecord>;
  /** AI file summaries keyed by path, provider, model, and prompt version. */
  readonly fileSummaries?: Record<string, FileSummaryRecord>;
  /** AI folder summaries keyed by path, provider, model, and prompt version. */
  readonly folderSummaries?: Record<string, FolderSummaryRecord>;
  /** AI project flows keyed by folder path, provider, model, and prompt version. */
  readonly projectFlows?: Record<string, ProjectFlowsRecord>;
  /**
   * The project map, made in the same request as the overview but saved
   * apart from it, so map changes never outdate saved explanations.
   */
  readonly projectMap?: ProjectMapRecord | null;
}

export interface FileSummaryRecord {
  readonly path: string;
  readonly summary: string;
  /** Fingerprint of the file text (whitespace-insensitive) the summary was made from. */
  readonly fingerprint: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly promptVersion: string;
  readonly savedAt: number;
}
