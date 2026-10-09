import { estimateTokens } from "../core/fingerprint";
import type {
  ExplanationFormat,
  FileSummary,
  FunctionExplanation,
  GenerationResult,
  RepositoryOverview
} from "../core/types";
import type {
  ExplanationPromptInput,
  FileSummaryPromptInput,
  FormatPromptInput,
  GenerationProvider,
  OverviewReviewPromptInput,
  RepositoryPromptInput
} from "./provider";

/** Placeholder views that cover the whole function, so tests can exercise rendering and line links. */
function mockFormats(formats: readonly ExplanationFormat[], source: string): Pick<FunctionExplanation, "pseudocode" | "flowchart"> {
  const lastLine = Math.max(1, source.split(/\r?\n/).length);
  return {
    ...(formats.includes("pseudocode") ? {
      pseudocode: [
        { text: "start the function (mock mode does not interpret it)", depth: 0, startLine: 1, endLine: 1 },
        { text: "do the work shown in the source", depth: 1, startLine: 1, endLine: lastLine }
      ]
    } : {}),
    ...(formats.includes("flowchart") ? {
      flowchart: {
        nodes: [
          { id: "start", kind: "start" as const, label: "Start", startLine: 1, endLine: 1 },
          { id: "check", kind: "decision" as const, label: "Mock check?", startLine: 1, endLine: lastLine },
          { id: "work", kind: "action" as const, label: "Do the work", startLine: 1, endLine: lastLine },
          { id: "stop", kind: "end" as const, label: "Return early", startLine: 0, endLine: 0 },
          { id: "done", kind: "end" as const, label: "Done", startLine: 0, endLine: 0 }
        ],
        edges: [
          { from: "start", to: "check", label: "" },
          { from: "check", to: "stop", label: "yes" },
          { from: "check", to: "work", label: "no" },
          { from: "work", to: "done", label: "" }
        ]
      }
    } : {})
  };
}

export class MockProvider implements GenerationProvider {
  readonly kind = "mock" as const;
  readonly modelId = "deterministic-mock-v1";
  requests = 0;
  delayMs = 0;
  failure: "network" | "malformed" | "refusal" | "none" = "none";

  private async respond<T>(input: string, result: T, signal?: AbortSignal): Promise<GenerationResult<T>> {
    this.requests++;
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, this.delayMs);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(new DOMException("The request was cancelled.", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    if (this.failure === "network") throw new Error("Mock provider network failure.");
    if (this.failure === "malformed") throw new Error("The provider response was not valid JSON.");
    if (this.failure === "refusal") throw new Error("The provider refused this request.");
    const serialized = JSON.stringify(result);
    return {
      value: result,
      provider: "mock",
      usage: {
        inputTokens: estimateTokens(input),
        outputTokens: estimateTokens(serialized),
        estimated: true
      }
    };
  }

  explainRepository(
    input: RepositoryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryOverview>> {
    const value: RepositoryOverview = {
      purpose: `Mock mode: repository purpose has not been interpreted. ${input.repositoryName} contains ${input.languageIds.join(", ") || "unknown-language"} files.`,
      components: `Mock mode does not analyze architecture. Inventory: ${input.inventory.slice(0, 2_000)}`,
      flows: "Mock mode does not infer application flows.",
      conventions: "Mock mode does not infer project conventions.",
      uncertainties: "This is deterministic placeholder output, not a semantic repository explanation. Configure a real provider for code interpretation.",
      limitations: ["Mock provider does not understand source semantics."]
    };
    return this.respond(input.inventory, value, signal);
  }

  reviewRepository(
    input: OverviewReviewPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryOverview>> {
    if (input.changedPaths.length === 0) {
      return this.respond(input.inventory, input.previous, signal);
    }
    const value: RepositoryOverview = {
      purpose: `${input.previous.purpose} Rechecked snapshot; mock mode cannot assess semantic changes.`,
      components: input.previous.components,
      flows: input.previous.flows,
      conventions: input.previous.conventions,
      uncertainties: "Mock review does not determine whether changed code alters architectural intent.",
      limitations: ["Mock provider cannot semantically review repository changes."]
    };
    return this.respond(input.inventory, value, signal);
  }

  explainFunction(
    input: ExplanationPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FunctionExplanation>> {
    const value: FunctionExplanation = {
      title: `Mock explanation of ${input.functionName}`,
      purpose: `Mock mode selected ${input.functionName}; what it does has not been interpreted.`,
      inputs: [],
      result: "Mock mode does not describe results.",
      steps: [{ title: "Not interpreted", detail: "Mock mode does not explain behavior. Choose a language model for a real explanation.", startLine: 1, endLine: Math.max(1, input.source.split(/\r?\n/).length) }],
      notes: [],
      role: "Mock mode does not infer where this fits in the application.",
      edgeCases: "Mock mode does not analyze edge cases.",
      languageNotes: `Mock mode does not explain ${input.languageId} features.`,
      limitations: ["Deterministic mock placeholder; not a real code explanation."],
      ...mockFormats(input.formats, input.source)
    };
    return this.respond(input.source + input.relatedContext, value, signal);
  }

  summarizeFile(
    input: FileSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileSummary>> {
    return this.respond(input.source, { summary: `Mock summary of ${input.path}; the file has not been interpreted.` }, signal);
  }

  explainFormat(
    input: FormatPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<Pick<FunctionExplanation, "pseudocode" | "flowchart">>> {
    return this.respond(input.source, mockFormats([input.format], input.source), signal);
  }
}
