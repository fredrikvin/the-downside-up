import type {
  FileComparisonDraft,
  FileSummary,
  FolderSummary,
  FunctionExplanation,
  ProjectFlowsDraft,
  GenerationResult,
  RepositoryPriming
} from "../core/types";
import { estimateTokens } from "../core/fingerprint";
import {
  explanationSchemaFor,
  formatSchemaFor,
  comparisonSchema,
  fileSummarySchema,
  folderSummarySchema,
  projectFlowsSchema,
  primingSchema,
  partFlowsSchema,
  parseExplanation,
  parseComparison,
  parseFileSummary,
  parseFolderSummary,
  parseProjectFlows,
  parseFormat,
  parsePriming,
  parsePartFlows
} from "./schema";
import { comparisonPrompt, explanationPrompt, fileSummaryPrompt, folderSummaryPrompt, formatPrompt, partFlowsPrompt, projectFlowsPrompt, overviewPrompt, reviewPrompt } from "./prompts";
import type {
  ExplanationPromptInput,
  ComparisonPromptInput,
  FileSummaryPromptInput,
  FolderSummaryPromptInput,
  ProjectFlowsPromptInput,
  FormatPromptInput,
  GenerationProvider,
  OverviewReviewPromptInput,
  PartFlowsPromptInput,
  RepositoryPromptInput
} from "./provider";

interface ResponseShape {
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string } | null;
  readonly output?: Array<{
    readonly type?: string;
    readonly refusal?: string;
    readonly content?: Array<{ readonly type?: string; readonly text?: string }>;
  }>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export class OpenAIProvider implements GenerationProvider {
  readonly kind = "openai" as const;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string
  ) {}

  async explainRepository(
    input: RepositoryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryPriming>> {
    const [system, user] = overviewPrompt(input);
    return this.request(system, user, "repository_overview", primingSchema, parsePriming, signal);
  }

  async reviewRepository(
    input: OverviewReviewPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryPriming>> {
    const [system, user] = reviewPrompt(input);
    return this.request(system, user, "repository_overview_review", primingSchema, parsePriming, signal);
  }

  async explainFunction(
    input: ExplanationPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FunctionExplanation>> {
    const [system, user] = explanationPrompt(input);
    return this.request(system, user, "function_explanation", explanationSchemaFor(input.formats), parseExplanation, signal);
  }

  async summarizeFile(
    input: FileSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileSummary>> {
    const [system, user] = fileSummaryPrompt(input);
    return this.request(system, user, "file_summary", fileSummarySchema, parseFileSummary, signal);
  }

  async explainComparison(
    input: ComparisonPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileComparisonDraft>> {
    const [system, user] = comparisonPrompt(input);
    return this.request(system, user, "file_comparison", comparisonSchema, parseComparison, signal);
  }

  async summarizeFolder(
    input: FolderSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FolderSummary>> {
    const [system, user] = folderSummaryPrompt(input);
    return this.request(system, user, "folder_summary", folderSummarySchema, parseFolderSummary, signal);
  }

  async describeFlows(
    input: ProjectFlowsPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<ProjectFlowsDraft>> {
    const [system, user] = projectFlowsPrompt(input);
    return this.request(system, user, "project_flows", projectFlowsSchema, parseProjectFlows, signal);
  }

  async describePartFlows(
    input: PartFlowsPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<ProjectFlowsDraft>> {
    const [system, user] = partFlowsPrompt(input);
    return this.request(system, user, "part_flows", partFlowsSchema, parsePartFlows, signal);
  }

  async explainFormat(
    input: FormatPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<Pick<FunctionExplanation, "pseudocode" | "flowchart">>> {
    const [system, user] = formatPrompt(input);
    return this.request(system, user, `function_${input.format}`, formatSchemaFor(input.format), (value) => parseFormat(value, input.format), signal);
  }

  private async request<T>(
    system: string,
    user: string,
    schemaName: string,
    schema: Record<string, unknown>,
    parse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<GenerationResult<T>> {
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    const requestController = new AbortController();
    const timeout = setTimeout(
      () => requestController.abort(new DOMException("The provider request timed out.", "TimeoutError")),
      90_000
    );
    const onAbort = () => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: requestController.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.modelId,
          store: false,
          max_output_tokens: 1_600,
          input: [
            { role: "system", content: [{ type: "input_text", text: system }] },
            { role: "user", content: [{ type: "input_text", text: user }] }
          ],
          text: {
            format: {
              type: "json_schema",
              name: schemaName,
              strict: true,
              schema
            }
          }
        })
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      if (requestController.signal.aborted) {
        throw new Error("The OpenAI request timed out after 90 seconds.");
      }
      throw new Error(
        `OpenAI network request failed: ${error instanceof Error ? error.message : "unknown network error"}`
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new Error("OpenAI rejected the API key. Check or replace it.");
      if (status === 429) throw new Error("OpenAI rate limit or quota reached. Try again later.");
      throw new Error(`OpenAI request failed with HTTP ${status}. No automatic retry was made.`);
    }

    const body = (await response.json()) as ResponseShape;
    if (body.status === "incomplete" || body.incomplete_details) {
      throw new Error(`OpenAI response was incomplete (${body.incomplete_details?.reason ?? "unknown reason"}).`);
    }
    const content = body.output?.flatMap((entry) => entry.content ?? []) ?? [];
    const refusal = content.find((entry) => entry.type === "refusal")?.text;
    if (refusal) throw new Error(`The provider refused the request: ${refusal.slice(0, 500)}`);
    const output = content.find((entry) => entry.type === "output_text")?.text;
    if (!output) throw new Error("OpenAI returned no structured output.");

    let decoded: unknown;
    try {
      decoded = JSON.parse(output) as unknown;
    } catch {
      throw new Error("OpenAI returned malformed structured output.");
    }
    const usage = body.usage;
    return {
      value: parse(decoded),
      provider: "openai",
      usage: usage?.input_tokens !== undefined && usage.output_tokens !== undefined
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            estimated: false
          }
        : {
            inputTokens: estimateTokens(system + user),
            outputTokens: estimateTokens(output),
            estimated: true
          }
    };
  }
}
