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

export type FlowNodeKind = "start" | "action" | "decision" | "end";

export interface FlowNode extends LineLinked {
  readonly id: string;
  readonly kind: FlowNodeKind;
  readonly label: string;
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
  readonly overview: OverviewRecord | null;
  readonly explanations: Record<string, ExplanationRecord>;
  /** AI file summaries keyed by path, provider, model, and prompt version. */
  readonly fileSummaries?: Record<string, FileSummaryRecord>;
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
