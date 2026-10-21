import { estimateTokens } from "../core/fingerprint";
import type {
  ExplanationFormat,
  FileComparisonDraft,
  FileSummary,
  FolderSummary,
  FunctionExplanation,
  ProjectFlowsDraft,
  GenerationResult,
  MapPart,
  ProjectMap,
  RepositoryOverview,
  RepositoryPriming
} from "../core/types";
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

const COMPONENT_MARKERS = /\b(?:package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|pom\.xml|build\.gradle|Dockerfile|\.csproj)\b/;
const SUPPORT_FOLDERS = new Set(["docs", "doc", "tools", "scripts", "test", "tests", "infra", "infrastructure"]);

/**
 * A deterministic map from the folder outline, for tests: the outermost
 * folders with a manifest or Dockerfile are components, folders holding two
 * or more of them are groups, well-known top-level folders are support, and
 * the components are chained together with one outside service.
 */
function mockMap(input: RepositoryPromptInput): ProjectMap {
  const folders = input.folders.split("\n").flatMap((line) => {
    const match = /^(\S+)\/ \d+ files?(?:; (.*))?$/.exec(line);
    return match ? [{ path: match[1]!, markers: match[2] ?? "" }] : [];
  });
  const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
  const components: string[] = [];
  for (const folder of folders) {
    if (COMPONENT_MARKERS.test(folder.markers) && !components.some((component) => within(folder.path, component))) components.push(folder.path);
  }
  const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const groups = [...new Set(components.map(parentOf))].filter((parent) => parent && components.filter((component) => parentOf(component) === parent).length >= 2);
  const support = folders.filter((folder) => !folder.path.includes("/") && SUPPORT_FOLDERS.has(folder.path.toLowerCase())).map((folder) => folder.path);
  const name = (path: string) => path.split("/").pop()!;
  const parts: MapPart[] = [
    ...groups.map((path) => ({ id: `group-${path}`, path, level: "group" as const, name: name(path), summary: `Mock group ${path}.` })),
    ...components.map((path) => ({ id: `component-${path}`, path, level: "component" as const, name: name(path), summary: `Mock component ${path}.`, ...(input.mapDetail === "detailed" ? { detail: `Mock detail of ${path}.`, offers: "Mock offers.", uses: "Mock uses." } : {}) })),
    ...support.filter((path) => !components.some((component) => within(component, path))).map((path) => ({ id: `support-${path}`, path, level: "support" as const, name: name(path), summary: `Mock support folder ${path}.` })),
    ...(components.length ? [{ id: "outside", level: "external" as const, name: "Mock outside service", summary: "Something outside the repository, in mock mode." }] : [])
  ];
  const links = [
    ...components.slice(1).map((path, index) => ({ from: `component-${components[index]}`, to: `component-${path}`, label: "mock link" })),
    ...(components.length ? [{ from: "outside", to: `component-${components[0]}`, label: "mock events" }] : [])
  ];
  return { summary: `Mock mode: ${input.repositoryName} has not been interpreted; its map comes from folder markers only.`, parts, links };
}

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
  ): Promise<GenerationResult<RepositoryPriming>> {
    const overview: RepositoryOverview = {
      purpose: `Mock mode: repository purpose has not been interpreted. ${input.repositoryName} contains ${input.languageIds.join(", ") || "unknown-language"} files.`,
      components: `Mock mode does not analyze architecture. Inventory: ${input.inventory.slice(0, 2_000)}`,
      flows: "Mock mode does not infer application flows.",
      conventions: "Mock mode does not infer project conventions.",
      uncertainties: "This is deterministic placeholder output, not a semantic repository explanation. Configure a real provider for code interpretation.",
      limitations: ["Mock provider does not understand source semantics."]
    };
    return this.respond(input.inventory, { overview, map: mockMap(input) }, signal);
  }

  reviewRepository(
    input: OverviewReviewPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<RepositoryPriming>> {
    if (input.changedPaths.length === 0) {
      return this.respond(input.inventory, { overview: input.previous, map: input.previousMap ?? mockMap(input) }, signal);
    }
    const overview: RepositoryOverview = {
      purpose: `${input.previous.purpose} Rechecked snapshot; mock mode cannot assess semantic changes.`,
      components: input.previous.components,
      flows: input.previous.flows,
      conventions: input.previous.conventions,
      uncertainties: "Mock review does not determine whether changed code alters architectural intent.",
      limitations: ["Mock provider cannot semantically review repository changes."]
    };
    return this.respond(input.inventory, { overview, map: mockMap(input) }, signal);
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

  explainComparison(
    input: ComparisonPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FileComparisonDraft>> {
    const makeSide = (side: ComparisonPromptInput["original"], name: "original" | "modified") => {
      if (!side.present) {
        return {
          presence: "absent" as const,
          region: "",
          coverage: "This file does not exist on this side.",
          flowchartStatus: "not-applicable" as const,
          flowchartReason: "There is no source on this side.",
          steps: [],
          pseudocode: [],
          flowchart: { nodes: [], edges: [] }
        };
      }
      const occurrenceId = `mock-${name}-operation`;
      const lineCount = side.source.split(/\r\n|\r|\n/).length;
      const occurrence = { id: occurrenceId, startLine: 1, endLine: Math.max(1, lineCount) };
      return {
        presence: "present" as const,
        region: "The whole file (placeholder only).",
        coverage: "Mock mode does not interpret behavior; the view is illustrative placeholder data.",
        flowchartStatus: "available" as const,
        flowchartReason: "",
        steps: [{ id: `mock-${name}-step`, text: "Placeholder operation", detail: "Mock output is not source analysis.", occurrenceId, startLine: 1, endLine: Math.max(1, lineCount) }],
        pseudocode: [{ id: `mock-${name}-pseudo`, text: "perform the placeholder operation", detail: "", depth: 0, occurrenceId, startLine: 1, endLine: Math.max(1, lineCount) }],
        flowchart: {
          nodes: [
            { id: `mock-${name}-start`, kind: "start" as const, label: "Start", occurrenceId },
            { id: `mock-${name}-operation-node`, kind: "action" as const, label: "Placeholder operation", occurrenceId },
            { id: `mock-${name}-end`, kind: "end" as const, label: "Finish", occurrenceId }
          ],
          edges: [
            { id: `mock-${name}-edge-1`, from: `mock-${name}-start`, to: `mock-${name}-operation-node`, label: "" },
            { id: `mock-${name}-edge-2`, from: `mock-${name}-operation-node`, to: `mock-${name}-end`, label: "" }
          ]
        }
      };
    };
    const original = makeSide(input.original, "original");
    const modified = makeSide(input.modified, "modified");
    const units = [
      ...(input.original.present ? [{ id: "mock-before", label: "Placeholder operation", side: "original" as const, occurrence: { id: "mock-original-operation", startLine: 1, endLine: Math.max(1, input.original.source.split(/\r\n|\r|\n/).length) } }] : []),
      ...(input.modified.present ? [{ id: "mock-after", label: "Placeholder operation", side: "modified" as const, occurrence: { id: "mock-modified-operation", startLine: 1, endLine: Math.max(1, input.modified.source.split(/\r\n|\r|\n/).length) } }] : [])
    ];
    const bothSidesPresent = input.original.present && input.modified.present;
    const edgeCorrespondences = bothSidesPresent
      ? [
          { originalEdgeId: "mock-original-edge-1", modifiedEdgeId: "mock-modified-edge-1", meaning: "Placeholder sequence", difference: "Not analyzed by mock mode." },
          { originalEdgeId: "mock-original-edge-2", modifiedEdgeId: "mock-modified-edge-2", meaning: "Placeholder sequence", difference: "Not analyzed by mock mode." }
        ]
      : [];
    return this.respond(input.original.source + "\0" + input.modified.source, {
      summary: `Mock comparison of ${input.modified.path}; the change has not been interpreted.`,
      changes: [{
        id: "mock-change",
        title: "Placeholder comparison",
        before: input.original.present ? "Mock mode does not interpret the original behavior." : "",
        after: input.modified.present ? "Mock mode does not interpret the modified behavior." : "",
        when: "",
        flow: "",
        original: input.original.present ? { start: 1, end: Math.max(1, input.original.source.split(/\r\n|\r|\n/).length) } : { start: 0, end: 0 },
        modified: input.modified.present ? { start: 1, end: Math.max(1, input.modified.source.split(/\r\n|\r|\n/).length) } : { start: 0, end: 0 },
        visualScopeId: "mock-scope"
      }],
      visualScopes: [{
        id: "mock-scope",
        title: "Placeholder behavior",
        original,
        modified,
        units,
        unitCorrespondences: bothSidesPresent
          ? [{ originalUnitId: "mock-before", modifiedUnitId: "mock-after", meaning: "Placeholder operation", difference: "Not analyzed by mock mode." }]
          : [],
        edgeCorrespondences
      }],
      outside: "",
      possibleEffects: [],
      limitations: ["Deterministic mock placeholder; not a real explanation of the change."]
    }, signal);
  }

  summarizeFolder(
    input: FolderSummaryPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<FolderSummary>> {
    return this.respond(JSON.stringify(input.parts), {
      summary: `Mock summary of ${input.path || "the repository"}; its contents have not been interpreted.`,
      overview: "Mock mode does not describe how the parts fit together. Choose a language model for a real summary.",
      parts: input.parts.filter((part) => !part.summary).map((part) => ({ name: part.name, summary: `Mock description of ${part.name}.` })),
      ...(input.level === "component" ? { offers: "Mock offers of this component.", uses: "Mock uses of this component." } : {})
    }, signal);
  }

  describeFlows(
    input: ProjectFlowsPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<ProjectFlowsDraft>> {
    const steps = input.catalog.slice(0, 2);
    const nodes = [
      { id: "start", kind: "start" as const, label: "Start", startLine: 0, endLine: 0 },
      ...steps.map((entry, index) => ({ id: `step${index}`, kind: "action" as const, label: `Mock step in ${entry.path}`, startLine: 0, endLine: 0 })),
      { id: "end", kind: "end" as const, label: "Done", startLine: 0, endLine: 0 }
    ];
    return this.respond(JSON.stringify(input.catalog), {
      flows: [{
        title: "Mock flow",
        summary: "Mock mode does not describe flows. Choose a language model for real ones.",
        chart: { nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id, label: "" })) },
        refs: [
          { file: "", function: "" },
          ...steps.map((entry) => ({ file: entry.path, function: entry.functions[0] ?? "" })),
          { file: "", function: "" }
        ]
      }]
    }, signal);
  }

  describePartFlows(
    input: PartFlowsPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<ProjectFlowsDraft>> {
    const steps = input.parts.slice(0, 2);
    const nodes = [
      { id: "start", kind: "start" as const, label: "Start", startLine: 0, endLine: 0 },
      ...steps.map((part, index) => ({ id: `step${index}`, kind: "action" as const, label: `Mock step in ${part.name}`, startLine: 0, endLine: 0 })),
      { id: "end", kind: "end" as const, label: "Done", startLine: 0, endLine: 0 }
    ];
    return this.respond(JSON.stringify(input.parts), {
      flows: [{
        title: "Mock flow between parts",
        summary: "Mock mode does not describe flows. Choose a language model for real ones.",
        chart: { nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id, label: "" })) },
        refs: [{ file: "", function: "" }, ...steps.map((part) => ({ file: part.id, function: "" })), { file: "", function: "" }]
      }]
    }, signal);
  }

  explainFormat(
    input: FormatPromptInput,
    signal?: AbortSignal
  ): Promise<GenerationResult<Pick<FunctionExplanation, "pseudocode" | "flowchart">>> {
    return this.respond(input.source, mockFormats([input.format], input.source), signal);
  }
}
