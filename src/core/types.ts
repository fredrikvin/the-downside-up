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
  readonly analysis: "rust-tree-sitter" | "vscode-symbols";
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

export interface FunctionExplanation {
  readonly purpose: string;
  readonly role: string;
  readonly inputsOutputsEffects: string;
  readonly steps: string;
  readonly errorsAndEdges: string;
  readonly languageConcepts: string;
  readonly limitations: string[];
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
}
