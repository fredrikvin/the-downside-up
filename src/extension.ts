import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { FileRepositoryCacheStore } from "./cache/store";
import {
  ExplanationService,
  type ExplanationResult,
  type ProviderDescriptor
} from "./controller";
import { findRepositoryRoot, gatherInventory, sharingExclusion, type RepositoryInventory } from "./context/inventory";
import { findCalledFunctions, type CalledFunction } from "./context/related";
import { buildFileOverview, type FileOverview, type OutlineEntry } from "./context/fileOverview";
import type { ExplanationFormat, FunctionExplanation, FunctionTarget, LineLinked, RepositoryOverview } from "./core/types";
import { MockProvider } from "./generation/mock";
import { OpenAIProvider } from "./generation/openai";
import {
  isUsableLanguageModelVendor,
  LanguageModelProvider,
  languageModelDescriptorId,
  parseLanguageModelDescriptorId
} from "./generation/languageModel";
import { formatUsage } from "./generation/provider";
import { nextPrefetch, prefetchFocusLine } from "./presentation/prefetch";
import { RequestScheduler, singleFlight } from "./presentation/requestScheduler";
import { outlineInclude, visibleOutline } from "./presentation/outlineFilter";
import { innermostAt, pseudocodeLayout, stepRanges, stepsAt, type StepRange } from "./presentation/stepLines";
import { findGoFunction, initializeGoParser, isGoDocument } from "./languages/go";
import { findRustFunction, initializeRustParser } from "./languages/rust";
import { findFunctionWithEditorTools } from "./languages/vscodeSymbols";
import {
  ExplanationPanel,
  type ExplanationView,
  type PanelAction,
  type FormatSettings,
  type LinkedKind,
  type PanelNotice
} from "./presentation/panel";
import { innermostRangeAt } from "./presentation/scrollSync";

const API_KEY_SECRET = "theDownsideUp.openai.apiKey";
const MOCK_LIMITATION = "Mock mode is deterministic placeholder output, not a real code explanation.";
const EARLIER_OVERVIEW_NOTE =
  "Made with an earlier version of the repository overview. It is still current for this function's code and what it uses; regenerate it to use the latest overview.";
const OVERVIEW_RELEVANT_PATH =
  /(?:^|\/)(?:README(?:\.[^/]*)?|ARCHITECTURE(?:\.[^/]*)?|Cargo\.(?:toml|lock)|package(?:-lock)?\.json|(?:main|index|lib|mod)\.(?:rs|[cm]?js|jsx|mjs|cjs|ts|tsx))$/i;

interface SelectedFunction {
  readonly root: string;
  readonly target: FunctionTarget;
  readonly document: vscode.TextDocument;
}

interface PreviewFile {
  readonly document: vscode.TextDocument;
  readonly root: string;
  readonly overview: FileOverview;
  /** Why the file must not be shared with a provider, if it must not. */
  readonly exclusion?: string;
}

type StoredView = Omit<ExplanationView, "entryId" | "expanded">;

/** Background prefetching for the file shown in the preview. */
interface PrefetchSession {
  readonly root: string;
  readonly document: vscode.TextDocument;
  /** Functions present when the file was shown; functions added by later edits are not prefetched. */
  readonly names: ReadonlySet<string>;
  readonly attempted: Set<string>;
  /** Other-file functions already considered, by path and qualified name. */
  readonly attemptedDependencies: Set<string>;
  /** Other-file functions each function of the file calls, resolved once per session. */
  readonly calledBy: Map<string, CalledFunction[]>;
  /** Functions already retried once after a failure. */
  readonly retried: Set<string>;
  stopped: boolean;
  /** Set when the session was woken while not waiting, so the wake is not lost. */
  woken: boolean;
  wake?: () => void;
}

/** The AI explanation section of one function, kept while the preview is open. */
interface FunctionAi {
  readonly key: string;
  value: SelectedFunction;
  view: StoredView;
  result?: ExplanationResult;
  expanded: boolean;
  /** Set when the reader collapsed the section, so it is not reopened automatically. */
  collapsedByUser?: boolean;
  /** An extra view being added on request, and the last error doing so. */
  loadingFormat?: ExplanationFormat;
  formatError?: string;
  controller?: AbortController;
  /** Incremented to discard results of superseded lookups and generations. */
  epoch: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

/** Outline names may carry a receiver, like gopls's `(*Catalog).Add`; discovered functions use the bare name. */
function outlineNameMatches(entryName: string, name: string): boolean {
  return entryName === name || entryName.endsWith(`).${name}`);
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export function activate(context: vscode.ExtensionContext): DownsideUpTestApi | undefined {
  const cacheStore = new FileRepositoryCacheStore(context.globalStorageUri.fsPath);
  const mockProvider = new MockProvider();
  let panel: ExplanationPanel | undefined;
  let preview: PreviewFile | undefined;
  const functions = new Map<string, FunctionAi>();
  /** The latest repository overview, kept with the root it describes. */
  let repositoryContext: { root: string; overview: RepositoryOverview } | undefined;
  let notice: PanelNotice | undefined;
  let repositoryJob: AbortController | undefined;
  const maxConcurrentRequests = (): number => {
    const value = vscode.workspace.getConfiguration("downsideUp").get<number>("maxConcurrentRequests", 3) ?? 3;
    return Number.isFinite(value) ? Math.min(8, Math.max(1, Math.floor(value))) : 3;
  };
  const scheduler = new RequestScheduler(maxConcurrentRequests);
  let previewEpoch = 0;
  let selectionLookupEpoch = 0;
  let savedLookupEpoch = 0;
  /** Files whose functions were already checked for saved explanations while the preview is open. */
  const savedLookupDone = new Set<string>();
  let prefetchSession: PrefetchSession | undefined;
  /** Signals of prefetch requests, so the consent check never prompts for them. */
  const prefetchSignals = new WeakSet<AbortSignal>();
  /** One code-sharing prompt per repository and model, shared by parallel requests. */
  const consentPrompts = new Map<string, Promise<boolean>>();
  /** The AI summary of the previewed file, if one is saved. */
  let fileSummary: { uri: string; text: string; current: boolean } | undefined;
  const summaryRuns = new Map<string, Promise<void>>();
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  const recheckPaths = new Set<string>();
  let recheckEverything = false;
  let suppressEditorSyncUntil = 0;
  let lastEditorTopLine: number | undefined;
  let lastTextEditor = vscode.window.activeTextEditor;
  const rootWatchers = new Map<string, vscode.Disposable[]>();



  const describeProvider = (): ProviderDescriptor => {
    const settings = vscode.workspace.getConfiguration("downsideUp");
    const configured = settings.get<string>("provider", "mock");
    if (configured === "vscode-lm") {
      const vendor = settings.get<string>("languageModel.vendor", "copilot").trim() || "copilot";
      const id = settings.get<string>("languageModel.id", "").trim();
      return { kind: "vscode-lm", modelId: languageModelDescriptorId(vendor, id) };
    }
    if (configured === "openai") {
      const model = settings.get<string>("openai.model", "gpt-4.1-mini").trim();
      return { kind: "openai", modelId: model || "gpt-4.1-mini" };
    }
    return { kind: "mock", modelId: mockProvider.modelId };
  };

  const service = new ExplanationService({
    store: cacheStore,
    describeProvider,
    createProvider: async (descriptor) => {
      if (descriptor.kind === "mock") return mockProvider;
      if (descriptor.kind === "vscode-lm") {
        const reference = parseLanguageModelDescriptorId(descriptor.modelId);
        if (!reference) {
          throw new Error("No language model is selected. Run “Downside Up: Choose Language Model”.");
        }
        if (!isUsableLanguageModelVendor(reference.vendor)) {
          throw new Error(
            `Models from “${reference.vendor}” cannot answer extension requests. Run “Downside Up: Choose Language Model” and pick another model.`
          );
        }
        const [model] = await vscode.lm.selectChatModels({ vendor: reference.vendor, id: reference.id });
        if (!model) {
          throw new Error(
            `Language model “${reference.id}” from “${reference.vendor}” is not available. Sign in to its provider (for example GitHub Copilot) or run “Downside Up: Choose Language Model”.`
          );
        }
        return new LanguageModelProvider(descriptor.modelId, model);
      }
      const key = await context.secrets.get(API_KEY_SECRET);
      if (!key) {
        throw new Error("No OpenAI API key is stored. Run “Downside Up: Set OpenAI API Key”.");
      }
      return new OpenAIProvider(descriptor.modelId, key);
    },
    explanationFormats: () => {
      const formats = formatSettings();
      return [
        ...(formats.pseudocode ? ["pseudocode" as const] : []),
        ...(formats.flowchart ? ["flowchart" as const] : [])
      ];
    },
    authorizeExternalData: async (root, descriptor, estimatedBytes, signal) => {
      if (signal && prefetchSignals.has(signal)) {
        // Prefetching only uses code-sharing consent that was already given; it never asks.
        if (descriptor.kind === "mock") return true;
        if (!vscode.workspace.isTrusted) return false;
        const saved = (await cacheStore.read(root)).consent;
        return saved?.provider === descriptor.kind && saved.model === descriptor.modelId;
      }
      if (descriptor.kind === "mock") return true;
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showErrorMessage(
          "External code sharing is disabled in an untrusted workspace. Trust the workspace before using a language model provider."
        );
        return false;
      }
      const cache = await cacheStore.read(root);
      if (
        cache.consent?.provider === descriptor.kind &&
        cache.consent.model === descriptor.modelId
      ) {
        return true;
      }
      const provider = descriptor.kind;
      // Parallel requests share one prompt for the same repository and model.
      return singleFlight(consentPrompts, `${root}\0${descriptor.kind}\0${descriptor.modelId}`, async () => {
        const approximateTokens = Math.ceil(estimatedBytes / 4);
        const reference = descriptor.kind === "vscode-lm"
          ? parseLanguageModelDescriptorId(descriptor.modelId)
          : undefined;
        const destination = descriptor.kind === "vscode-lm"
          ? `Provider: VS Code language model from “${reference?.vendor ?? "unknown"}”\nModel: ${reference?.id ?? descriptor.modelId}`
          : `Provider: OpenAI Responses API\nModel: ${descriptor.modelId}`;
        const terms = descriptor.kind === "vscode-lm"
          ? "Requests use your existing subscription with that provider (for GitHub Copilot, your Copilot plan) and may count toward its usage limits. Data handling follows that provider's terms and your organization's policies. VS Code may also ask you to allow The Downside Up to use language models."
          : "Your API usage is billed separately. Review OpenAI's data controls; store:false does not guarantee zero provider-side retention.";
        const accept = descriptor.kind === "vscode-lm" ? "Send code to language model" : "Send code to OpenAI";
        const action = await vscode.window.showWarningMessage(
          `Downside Up will send selected functions, relevant snippets, repository documentation, and (for one-sentence file summaries) the text of files whose functions you explain, from:\n\n${root}\n\n${destination}\nEstimated context: about ${approximateTokens.toLocaleString()} tokens (byte-based estimate)\n\n${terms} This consent is saved for this repository and model. Clear the repository cache to revoke it.`,
          { modal: true },
          accept
        );
        if (action !== accept) return false;
        await cacheStore.update(root, (current) => ({
          ...current,
          consent: {
            provider,
            model: descriptor.modelId,
            acceptedAt: Date.now()
          }
        }));
        return true;
      });
    }
  });

  const chooseLanguageModel = async (): Promise<boolean> => {
    let models: readonly vscode.LanguageModelChat[];
    try {
      models = (await vscode.lm.selectChatModels())
        .filter((model) => isUsableLanguageModelVendor(model.vendor))
        .sort((left, right) =>
          Number(right.vendor === "copilot") - Number(left.vendor === "copilot") ||
          left.vendor.localeCompare(right.vendor) ||
          left.name.localeCompare(right.name)
        );
    } catch {
      models = [];
    }
    if (models.length === 0) {
      await vscode.window.showWarningMessage(
        "No VS Code language models are available. Install and sign in to GitHub Copilot, or install another extension that provides language models, then try again."
      );
      return false;
    }
    const current = parseLanguageModelDescriptorId(
      describeProvider().kind === "vscode-lm" ? describeProvider().modelId : ""
    );
    const picked = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: model.name,
        description: `${model.vendor} · ${model.id}${
          current?.vendor === model.vendor && current.id === model.id ? " · current" : ""
        }`,
        detail: `Family ${model.family}, version ${model.version}; up to ${model.maxInputTokens.toLocaleString()} input tokens`,
        model
      })),
      {
        title: "Choose the language model for Downside Up",
        placeHolder: "Uses your existing subscription with the model's provider. No code is sent until you explain a function and accept the sharing prompt.",
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!picked) return false;
    const settings = vscode.workspace.getConfiguration("downsideUp");
    await settings.update("languageModel.vendor", picked.model.vendor, vscode.ConfigurationTarget.Global);
    await settings.update("languageModel.id", picked.model.id, vscode.ConfigurationTarget.Global);
    await settings.update("provider", "vscode-lm", vscode.ConfigurationTarget.Global);
    const effective = describeProvider();
    if (effective.modelId !== languageModelDescriptorId(picked.model.vendor, picked.model.id)) {
      await vscode.window.showWarningMessage(
        "The model was saved in user settings, but workspace settings for downsideUp.provider or downsideUp.languageModel override it. Update or remove those workspace settings to use the chosen model."
      );
      return false;
    }
    await vscode.window.showInformationMessage(
      `Downside Up will use ${picked.model.name} (${picked.model.vendor}) through VS Code. Explain a function to use it; you will be asked before any code is shared.`
    );
    return true;
  };

  const ensureLanguageModelSelected = async (): Promise<boolean> => {
    const descriptor = describeProvider();
    if (descriptor.kind !== "vscode-lm") return true;
    const reference = parseLanguageModelDescriptorId(descriptor.modelId);
    if (reference && isUsableLanguageModelVendor(reference.vendor)) return true;
    if (reference) {
      await vscode.window.showWarningMessage(
        `The configured model “${reference.id}” from “${reference.vendor}” cannot answer extension requests. Choose another model.`
      );
    }
    return chooseLanguageModel();
  };

  const filePath = (root: string, uri: vscode.Uri): string =>
    relative(root, uri.fsPath).split(sep).join("/");

  const stateKey = (root: string, target: FunctionTarget): string => `${root}\0${target.symbolId}`;

  /** Finds the outline entry for a function, tolerating line shifts after edits. */
  const entryForTarget = (target: FunctionTarget): OutlineEntry | undefined => {
    if (!preview || !sameUri(preview.document.uri, target.uri)) return undefined;
    const candidates = preview.overview.entries.filter((entry) => entry.explainable && outlineNameMatches(entry.name, target.name));
    const line = target.selection.start.line;
    return candidates.find((entry) => entry.nameLine === line) ??
      [...candidates].sort((left, right) => Math.abs(left.nameLine - line) - Math.abs(right.nameLine - line))[0];
  };

  const previewStates = (): Array<{ state: FunctionAi; entry: OutlineEntry }> => {
    if (!preview) return [];
    const result: Array<{ state: FunctionAi; entry: OutlineEntry }> = [];
    const used = new Set<string>();
    const states = [...functions.values()].filter((state) => sameUri(state.value.document.uri, preview!.document.uri));
    // Exact name-line matches first, so a same-named neighbour cannot claim a function's entry.
    for (const exact of [true, false]) {
      for (const state of states) {
        if (result.some((item) => item.state === state)) continue;
        const entry = entryForTarget(state.value.target);
        if (!entry || used.has(entry.id) || (exact && entry.nameLine !== state.value.target.selection.start.line)) continue;
        used.add(entry.id);
        result.push({ state, entry });
      }
    }
    return result;
  };

  const columnFor = (uri: vscode.Uri): vscode.ViewColumn =>
    vscode.window.visibleTextEditors.find((editor) => sameUri(editor.document.uri, uri))?.viewColumn ??
    lastTextEditor?.viewColumn ??
    vscode.ViewColumn.One;

  const reveal = async (uri: vscode.Uri, line: number, start: number, end: number): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      viewColumn: columnFor(uri),
      selection: new vscode.Range(line, start, line, Math.max(start, end)),
      preserveFocus: false
    });
  };

  interface ItemRanges {
    readonly steps: Array<StepRange | undefined>;
    readonly pseudocode: Array<StepRange | undefined>;
    readonly nodes: Array<StepRange | undefined>;
  }

  /** Document lines of each step, pseudocode line, and flowchart node, checked against the function as it is now. */
  const currentItemRanges = (state: FunctionAi): ItemRanges | undefined => {
    const explanation = state.view.explanation;
    if (state.view.status !== "current" || !explanation) return undefined;
    const { target } = state.value;
    const map = (items: readonly LineLinked[] | undefined) => stepRanges(items ?? [], target.source, target.range.start.line);
    return { steps: map(explanation.steps), pseudocode: map(explanation.pseudocode), nodes: map(explanation.flowchart?.nodes) };
  };

  const NO_ITEMS = { steps: [], pseudocode: [], nodes: [] };

  /**
   * Lines of a clicked step, pseudocode line, or node, shown with a line
   * highlight rather than a selection (VS Code would also highlight every
   * other line with the same text), until the reader moves the cursor.
   */
  const revealDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full
  });
  context.subscriptions.push(revealDecoration);
  let revealed: {
    uri: string;
    caret: vscode.Position;
    entryId: string;
    kind: LinkedKind;
    index: number;
    start: number;
    end: number;
    editor?: vscode.TextEditor;
  } | undefined;

  const clearReveal = (): void => {
    if (!revealed) return;
    revealed.editor?.setDecorations(revealDecoration, []);
    revealed = undefined;
  };

  /** The last highlight, for the extension-host tests. */
  let lastStepHighlight: { functionName: string; steps: number[]; pseudocode: number[]; nodes: number[] } | undefined;

  /** Highlights the items of the innermost explained function at the editor's cursor or selection. Local only. */
  const syncStepHighlight = (selection?: vscode.Selection, reveal = false): void => {
    if (!panel || !preview) return;
    lastStepHighlight = undefined;
    const editor = vscode.window.visibleTextEditors.find((candidate) => sameUri(candidate.document.uri, preview!.document.uri));
    const current = selection ?? editor?.selection;
    if (!current) {
      panel.highlightSteps(undefined, NO_ITEMS, reveal);
      return;
    }
    const line = current.active.line;
    const match = previewStates()
      .filter(({ state }) => state.expanded && state.value.target.range.start.line <= line && state.value.target.range.end.line >= line)
      .sort((left, right) =>
        (left.state.value.target.range.end.line - left.state.value.target.range.start.line) -
        (right.state.value.target.range.end.line - right.state.value.target.range.start.line)
      )[0];
    const ranges = match ? currentItemRanges(match.state) : undefined;
    if (!match || !ranges) {
      panel.highlightSteps(undefined, NO_ITEMS, reveal);
      return;
    }
    let items: { steps: number[]; pseudocode: number[]; nodes: number[] };
    if (revealed && revealed.entryId === match.entry.id && current.isEmpty && current.active.isEqual(revealed.caret)) {
      // The reader clicked this item, so exactly it stays highlighted.
      items = { steps: [], pseudocode: [], nodes: [] };
      items[revealed.kind === "step" ? "steps" : revealed.kind === "pseudocode" ? "pseudocode" : "nodes"].push(revealed.index);
    } else {
      // A cursor picks the innermost items on its line; a selection of several lines picks all it touches.
      const at = (list: Array<StepRange | undefined>) => current.start.line === current.end.line
        ? innermostAt(list, current.active.line)
        : stepsAt(list, current.start.line, current.end.line);
      items = { steps: at(ranges.steps), pseudocode: at(ranges.pseudocode), nodes: at(ranges.nodes) };
    }
    lastStepHighlight = { functionName: match.state.view.functionName, ...items };
    panel.highlightSteps(match.entry.id, items, reveal);
  };

  /** Selects an item's lines in the editor; the lines come from the host's own check, never the model alone. */
  const revealItem = async (entryId: string, kind: LinkedKind, index: number): Promise<void> => {
    const state = existingStateForEntry(entryId);
    const ranges = state ? currentItemRanges(state) : undefined;
    const range = ranges?.[kind === "step" ? "steps" : kind === "pseudocode" ? "pseudocode" : "nodes"][index];
    if (!state || !range) return;
    const document = state.value.document;
    const end = Math.min(range.end, document.lineCount - 1);
    const caret = new vscode.Position(range.start, 0);
    clearReveal();
    const current: NonNullable<typeof revealed> = { uri: document.uri.toString(), caret, entryId, kind, index, start: range.start, end };
    revealed = current;
    // The click came from the preview, so the editor scroll it causes must not scroll the preview.
    suppressEditorSyncUntil = Date.now() + 800;
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: columnFor(document.uri),
      selection: new vscode.Selection(caret, caret),
      preserveFocus: false
    });
    if (revealed !== current) return;
    const lines = new vscode.Range(range.start, 0, end, 0);
    current.editor = editor;
    editor.setDecorations(revealDecoration, [lines]);
    editor.revealRange(lines, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    syncStepHighlight();
  };

  const formatSettings = (): FormatSettings => {
    const settings = vscode.workspace.getConfiguration("downsideUp");
    const formats = settings.get<Record<string, unknown>>("explanations.formats") ?? {};
    const initial = settings.get<string>("explanations.initialFormat", "steps");
    return {
      pseudocode: formats.pseudocode === true,
      flowchart: formats.flowchart === true,
      initial: initial === "pseudocode" || initial === "flowchart" ? initial : "steps"
    };
  };

  /** Generates one missing view for a current saved explanation, on the reader's request. */
  const addFormat = async (entryId: string, format: ExplanationFormat): Promise<void> => {
    const state = existingStateForEntry(entryId);
    if (!state || !state.result || state.loadingFormat || state.view.status !== "current") return;
    state.loadingFormat = format;
    state.formatError = undefined;
    const epoch = state.epoch;
    render();
    try {
      const result = await scheduler.schedule("explicit", () =>
        service.addExplanationFormat(state.value.root, state.value.target, state.value.document, format)
      );
      if (state.epoch !== epoch || !functions.has(state.key)) return;
      applyResult(state, result);
    } catch (error) {
      if (state.epoch === epoch) state.formatError = errorMessage(error);
    } finally {
      state.loadingFormat = undefined;
      render();
    }
  };

  /** The preview's outline entries that the "Preview: Include" setting shows. */
  const shownEntries = (): OutlineEntry[] => preview
    ? visibleOutline(preview.overview.entries, outlineInclude(vscode.workspace.getConfiguration("downsideUp").get("preview.include")))
    : [];

  const render = (): void => {
    if (!panel) return;
    const descriptor = describeProvider();
    const handlers = new Map<string, () => Promise<void>>();
    const explanations: ExplanationView[] = [];
    for (const { state, entry } of previewStates()) {
      const result = state.result;
      const references = state.view.references.map((reference) => ({ ...reference, id: `${entry.id}:${reference.id}` }));
      const ranges = currentItemRanges(state);
      explanations.push({
        ...state.view,
        references,
        entryId: entry.id,
        expanded: state.expanded,
        ...(ranges
          ? {
              linked: { steps: ranges.steps.map(Boolean), pseudocode: ranges.pseudocode.map(Boolean), nodes: ranges.nodes.map(Boolean) },
              itemLines: {
                steps: ranges.steps.map((range) => range?.start ?? -1),
                pseudocode: ranges.pseudocode.map((range) => range?.start ?? -1),
                nodes: ranges.nodes.map((range) => range?.start ?? -1)
              }
            }
          : {}),
        ...(ranges && state.view.explanation?.pseudocode
          ? {
              pseudocodeLayout: pseudocodeLayout(
                ranges.pseudocode,
                state.view.explanation.pseudocode.map((line) => line.depth),
                (line) => line >= 0 && line < state.value.document.lineCount ? state.value.document.lineAt(line).text : ""
              )
            }
          : {}),
        ...(state.loadingFormat ? { loadingFormat: state.loadingFormat } : {}),
        ...(state.formatError ? { formatError: state.formatError } : {})
      });
      if (!result) continue;
      for (const reference of result.context.sourceReferences) {
        const uri = result.context.referenceUris.get(reference.id);
        if (uri) {
          handlers.set(`${entry.id}:${reference.id}`, () =>
            reveal(uri, reference.line, reference.startCharacter, reference.endCharacter)
          );
        }
      }
    }
    const shownContext = preview && repositoryContext?.root === preview.root ? repositoryContext : undefined;
    panel.setReferenceHandlers(handlers);
    const summary = preview && fileSummary?.uri === preview.document.uri.toString() ? fileSummary : undefined;
    panel.update({
      provider: descriptor.kind,
      model: descriptor.modelId || "no model selected",
      ...(preview ? { document: { ...preview.overview, entries: shownEntries() } } : {}),
      explanations,
      ...(summary ? { summary: { text: summary.text, current: summary.current } } : {}),
      showDetails: vscode.workspace.getConfiguration("downsideUp").get<boolean>("explanations.showDetails", false) === true,
      formats: formatSettings(),
      ...(shownContext ? { overview: shownContext.overview } : {}),
      ...(notice ? { notice } : {}),
      busy: Boolean(repositoryJob),
      hasRepository: Boolean(preview)
    });
    syncStepHighlight();
  };

  const emptyView = (target: FunctionTarget): StoredView => ({
    functionName: target.qualifiedName,
    status: "loading",
    detail: "",
    references: [],
    limitations: []
  });

  const loadingView = (state: FunctionAi, detail: string): StoredView => ({
    ...state.view,
    status: "loading",
    detail,
    error: undefined
  });

  const applyResult = (state: FunctionAi, result: ExplanationResult): void => {
    state.result = result;
    state.view = {
      functionName: state.value.target.qualifiedName,
      status: "current",
      detail: result.cached ? "Saved explanation; the code it describes is unchanged" : "Generated just now",
      ...(result.usage ? { usage: formatUsage(result.usage) } : {}),
      explanation: result.explanation,
      references: result.context.sourceReferences,
      limitations: [...new Set([
        ...result.context.limitations,
        ...result.explanation.limitations,
        ...(result.earlierOverview ? [EARLIER_OVERVIEW_NOTE] : []),
        ...(result.provider.kind === "mock" ? [MOCK_LIMITATION] : [])
      ])]
    };
    // Current explanations read like a document, so they open unless the reader closed them.
    if (!state.collapsedByUser) state.expanded = true;
    repositoryContext = { root: state.value.root, overview: result.overview };
    installRootWatcher(state.value.root);
  };

  /** Shows the saved AI summary of the previewed file, if any; local cache only. */
  const loadFileSummary = async (document: vscode.TextDocument, root: string): Promise<void> => {
    const found = await service.findFileSummary(root, document).catch(() => undefined);
    if (!preview || !sameUri(preview.document.uri, document.uri)) return;
    fileSummary = found ? { uri: document.uri.toString(), text: found.summary, current: found.current } : undefined;
    render();
  };

  /**
   * Summarizes a file after one of its functions was freshly explained, when
   * no current summary is saved. Consent was already given for that
   * explanation, so this never prompts; it shares the request slots.
   */
  const summarizeAfterExplanation = (
    root: string,
    document: vscode.TextDocument,
    priority: "explicit" | "prefetch"
  ): void => {
    const key = `${root}\0${document.uri.toString()}`;
    if (summaryRuns.has(key)) return;
    const controller = new AbortController();
    prefetchSignals.add(controller.signal);
    const run = scheduler.schedule(priority, () => service.summarizeFile(root, document, controller.signal))
      .then(async (result) => {
        if (result && preview && sameUri(preview.document.uri, document.uri)) await loadFileSummary(document, root);
      })
      .catch(() => undefined)
      .finally(() => summaryRuns.delete(key));
    summaryRuns.set(key, run);
  };

  const stateFor = (value: SelectedFunction): FunctionAi => {
    const key = stateKey(value.root, value.target);
    let state = functions.get(key);
    if (!state) {
      state = { key, value, view: emptyView(value.target), expanded: false, epoch: 0 };
      functions.set(key, state);
    } else {
      state.value = value;
    }
    return state;
  };

  const forget = (state: FunctionAi): void => {
    state.epoch++;
    state.controller?.abort();
    functions.delete(state.key);
  };

  const syncWithEditor = (editor: vscode.TextEditor | undefined): void => {
    if (!panel || !preview || !editor || !sameUri(editor.document.uri, preview.document.uri)) return;
    lastEditorTopLine = editor.visibleRanges[0]?.start.line ?? 0;
    panel.scrollToLine(lastEditorTopLine);
    panel.highlightEntry(innermostRangeAt(shownEntries(), editor.selection.active.line)?.id);
  };

  const scheduleRecheck = (path?: string): void => {
    if (path === undefined) recheckEverything = true;
    else recheckPaths.add(path);
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => void recheckSaved(), 700);
  };

  /**
   * Marks functions of the shown file that have a current saved explanation as
   * ready, so they survive closing the preview or restarting VS Code. This is a
   * local cache lookup only; misses stay collapsed and never generate.
   */
  const markSavedExplanations = async (document: vscode.TextDocument, root: string): Promise<void> => {
    const lookup = ++savedLookupEpoch;
    const fileKey = `${root}\0${document.uri.toString()}`;
    const version = document.version;
    const stillCurrent = () =>
      lookup === savedLookupEpoch && Boolean(panel) && Boolean(preview) &&
      sameUri(preview!.document.uri, document.uri) && document.version === version;
    const targets: FunctionTarget[] = [];
    const seen = new Set<string>();
    for (const entry of preview?.overview.entries ?? []) {
      if (!entry.explainable) continue;
      let target: FunctionTarget | undefined;
      try {
        target = await findFunctionTarget(document, new vscode.Position(entry.nameLine, entry.nameStart));
      } catch {
        target = undefined;
      }
      if (!stillCurrent()) return;
      if (!target || seen.has(target.symbolId) || functions.has(stateKey(root, target))) continue;
      seen.add(target.symbolId);
      targets.push(target);
    }
    let found = new Map<string, ExplanationResult>();
    try {
      if (targets.length > 0) found = await service.findCachedExplanations(root, targets, document);
    } catch {
      found = new Map();
    }
    if (!stillCurrent()) return;
    savedLookupDone.add(fileKey);
    let changed = false;
    for (const target of targets) {
      const cached = found.get(target.symbolId);
      if (!cached || functions.has(stateKey(root, target))) continue;
      applyResult(stateFor({ root, target, document }), cached);
      changed = true;
    }
    if (changed) render();
  };

  const showPreview = async (document: vscode.TextDocument, root: string): Promise<void> => {
    const epoch = ++previewEpoch;
    const overview = await buildFileOverview(document, filePath(root, document.uri));
    const exclusion = await sharingExclusion(root, document.uri.fsPath).catch(() => undefined);
    if (epoch !== previewEpoch || !panel) return;
    const fileChanged = !preview || !sameUri(preview.document.uri, document.uri);
    preview = { document, root, overview, ...(exclusion ? { exclusion } : {}) };
    panel.panel.title = `Downside Up: ${overview.fileName}`;
    const handlers = new Map<string, () => Promise<void>>();
    for (const entry of overview.entries) {
      const { line, startCharacter, endCharacter } = entry.reference;
      handlers.set(entry.id, () => reveal(document.uri, line, startCharacter, endCharacter));
    }
    panel.setFileReferenceHandlers(handlers);
    void loadFileSummary(document, root);
    if (fileChanged) {
      notice = exclusion
        ? { tone: "info", text: `AI explanations are off for this file because ${exclusion}. Local descriptions are still shown.` }
        : undefined;
      // Queued prefetches of the previous file are dropped; a request already sent finishes and is saved.
      stopPrefetch();
      if (previewStates().some(({ state }) => state.result)) scheduleRecheck(filePath(root, document.uri));
    }
    render();
    if (fileChanged || !savedLookupDone.has(`${root}\0${document.uri.toString()}`)) {
      const lookup = markSavedExplanations(document, root).catch(() => undefined);
      // Prefetching starts after saved explanations are marked, so they are not requested again.
      if (fileChanged) {
        void lookup.then(() => {
          if (preview && sameUri(preview.document.uri, document.uri)) startPrefetch(document, root);
        });
      }
    }
    // Only a file switch re-aligns the preview; rebuilding the same file keeps the reader's place.
    if (fileChanged) {
      syncWithEditor(vscode.window.visibleTextEditors.find((editor) => sameUri(editor.document.uri, document.uri)));
    }
  };

  const resolveRoot = async (document: vscode.TextDocument): Promise<string | undefined> => {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return folder ? findRepositoryRoot(folder.uri.fsPath) : undefined;
  };

  const previewDocument = async (document: vscode.TextDocument): Promise<void> => {
    if (!panel || document.uri.scheme !== "file") return;
    const name = document.uri.path.split("/").pop() ?? "this file";
    try {
      const root = await resolveRoot(document);
      if (!root) {
        notice = { tone: "info", text: `${name} is outside the open workspace folders, so it is not described.` };
        render();
        return;
      }
      await showPreview(document, root);
    } catch (error) {
      notice = { tone: "error", text: `Could not describe ${name}: ${errorMessage(error)}` };
      render();
    }
  };

  /** Watches each repository that has a shown explanation, so outside edits mark it outdated. */
  const installRootWatcher = (root: string): void => {
    if (rootWatchers.has(root)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), "**/*")
    );
    const onExternalFileChange = (uri: vscode.Uri, structural: boolean) => {
      const path = filePath(root, uri);
      const tracked = [...functions.values()].some((state) =>
        state.value.root === root && state.result?.context.inputs.some((input) => input.path === path)
      );
      if (!tracked && !structural && !OVERVIEW_RELEVANT_PATH.test(path)) return;
      scheduleRecheck(tracked ? path : undefined);
    };
    rootWatchers.set(root, watcher ? [
      watcher,
      watcher.onDidChange((uri) => onExternalFileChange(uri, false)),
      watcher.onDidCreate((uri) => onExternalFileChange(uri, true)),
      watcher.onDidDelete((uri) => onExternalFileChange(uri, true))
    ] : []);
  };

  /** Re-resolves a function against the current source, since edits may have moved it. */
  const currentTarget = async (state: FunctionAi): Promise<SelectedFunction | undefined> => {
    const { root, document, target } = state.value;
    const line = target.selection.start.line;
    const positions = preview && sameUri(preview.document.uri, document.uri)
      ? preview.overview.entries
          .filter((entry) => entry.explainable && outlineNameMatches(entry.name, target.name))
          .sort((left, right) => Math.abs(left.nameLine - line) - Math.abs(right.nameLine - line))
          .slice(0, 8)
          .map((entry) => new vscode.Position(entry.nameLine, entry.nameStart))
      : [];
    if (positions.length === 0) positions.push(target.selection.start);
    for (const position of positions) {
      try {
        const resolved = await findFunctionTarget(document, position);
        // Only the same function identity counts; a same-named neighbour is a different function.
        if (resolved && stateKey(root, resolved) === state.key) return { root, document, target: resolved };
      } catch {
        // Try the next candidate position.
      }
    }
    return undefined;
  };

  /**
   * After edits, model changes, or file changes, checks shown explanations
   * against the cache. This is local only: stale ones are marked outdated and
   * never regenerated automatically.
   */
  const recheckSaved = async (): Promise<void> => {
    const paths = new Set(recheckPaths);
    const everything = recheckEverything;
    recheckPaths.clear();
    recheckEverything = false;
    for (const state of [...functions.values()]) {
      if (state.controller || !state.result || !functions.has(state.key)) continue;
      const own = filePath(state.value.root, state.value.document.uri);
      const affected = everything || paths.has(own) ||
        state.result.context.inputs.some((input) => paths.has(input.path));
      if (!affected) continue;
      const epoch = ++state.epoch;
      const current = await currentTarget(state);
      if (state.epoch !== epoch || state.controller || !functions.has(state.key)) continue;
      if (!current) {
        // The function was removed or its identity changed; its section starts fresh.
        forget(state);
        render();
        continue;
      }
      let cached: ExplanationResult | undefined;
      try {
        cached = await service.findCachedExplanation(current.root, current.target, current.document);
      } catch {
        cached = undefined;
      }
      if (state.epoch !== epoch || state.controller || !functions.has(state.key)) continue;
      state.value = current;
      if (cached) {
        applyResult(state, cached);
      } else {
        state.view = {
          ...state.view,
          status: "outdated",
          detail: "The code, its context, or the model changed since this explanation was made",
          error: undefined
        };
      }
      render();
    }
  };

  /**
   * Generates (or loads a still-current saved) explanation for an explicit
   * request, or for prefetching, which keeps the section collapsed, never
   * prompts, and is dropped if `shouldStart` is false when its turn comes.
   */
  const generate = async (
    state: FunctionAi,
    options: { prefetch?: { shouldStart: () => boolean } } = {}
  ): Promise<void> => {
    if (state.controller) return;
    const prefetching = options.prefetch;
    if (!prefetching && (!(await ensureLanguageModelSelected()) || state.controller)) return;
    const controller = new AbortController();
    const epoch = ++state.epoch;
    state.controller = controller;
    if (!prefetching) state.expanded = true;
    else prefetchSignals.add(controller.signal);
    installRootWatcher(state.value.root);
    state.view = loadingView(
      state,
      prefetching
        ? "Prefetching…"
        : scheduler.running >= maxConcurrentRequests()
          ? "Waiting for another explanation to finish…"
          : "Checking repository context and saved explanations…"
    );
    render();
    let started = false;
    // A request still waiting in the queue settles as soon as it is cancelled.
    controller.signal.addEventListener("abort", () => {
      if (started || state.epoch !== epoch) return;
      state.epoch++;
      if (state.controller === controller) state.controller = undefined;
      state.view = { ...state.view, status: "cancelled", detail: "Cancelled; nothing was sent", error: undefined };
      render();
    }, { once: true });
    try {
      const result = await scheduler.schedule(prefetching ? "prefetch" : "explicit", async () => {
        if (controller.signal.aborted) throw new DOMException("The request was cancelled.", "AbortError");
        if (prefetching && !prefetching.shouldStart()) throw new DOMException("Prefetching moved on.", "AbortError");
        started = true;
        if (state.epoch === epoch) {
          state.view = loadingView(state, "Checking repository context and saved explanations…");
          render();
        }
        const current = await currentTarget(state);
        if (!current) throw new Error(`Could not find ${state.view.functionName} in the current source.`);
        state.value = current;
        return await service.explain(current.root, current.target, current.document, controller.signal, (progress) => {
          if (state.epoch !== epoch) return;
          state.view = {
            ...state.view,
            detail: progress.detail,
            ...(progress.usage ? { usage: formatUsage(progress.usage) } : {})
          };
          render();
        });
      });
      if (state.epoch !== epoch) return;
      applyResult(state, result);
      if (!result.cached) summarizeAfterExplanation(state.value.root, state.value.document, prefetching ? "prefetch" : "explicit");
    } catch (error) {
      if (state.epoch !== epoch) return;
      const userCancelled = controller.signal.aborted;
      const declined = !userCancelled && error instanceof DOMException && error.name === "AbortError";
      if (prefetching && (declined || !started)) {
        // A prefetch that was not approved or not started leaves the section untouched.
        forget(state);
        return;
      }
      state.view = userCancelled || declined
        ? {
            ...state.view,
            status: "cancelled",
            detail: userCancelled ? "Cancelled; nothing was saved" : "Nothing was sent: code sharing was not approved",
            error: undefined
          }
        : { ...state.view, status: "failed", detail: "Generation failed", error: errorMessage(error) };
    } finally {
      if (state.controller === controller) state.controller = undefined;
      render();
    }
  };

  /** Expands a function's AI section: shows a saved explanation, or generates one when none is current. */
  const openExplanation = async (state: FunctionAi): Promise<void> => {
    state.expanded = true;
    if (state.controller || state.view.explanation || state.view.status === "failed" || state.view.status === "cancelled") {
      render();
      return;
    }
    const epoch = ++state.epoch;
    state.view = loadingView(state, "Looking for a saved explanation…");
    render();
    let cached: ExplanationResult | undefined;
    try {
      cached = await service.findCachedExplanation(state.value.root, state.value.target, state.value.document);
    } catch {
      cached = undefined;
    }
    if (state.epoch !== epoch || !functions.has(state.key)) return;
    if (cached) {
      applyResult(state, cached);
      render();
      return;
    }
    if (!state.expanded) {
      // Collapsed again before anything was generated: treat it as never opened.
      forget(state);
      render();
      return;
    }
    await generate(state);
  };

  const existingStateForEntry = (entryId: string): FunctionAi | undefined =>
    previewStates().find(({ entry }) => entry.id === entryId)?.state;

  /** Resolves a preview entry to the function's current source; IDs come from the host-built outline. */
  const resolveEntryState = async (entryId: string): Promise<FunctionAi | undefined> => {
    if (!preview) return undefined;
    const entry = preview.overview.entries.find((candidate) => candidate.id === entryId && candidate.explainable);
    if (!entry) return undefined;
    const { document, root } = preview;
    const existing = existingStateForEntry(entryId);
    let target: FunctionTarget | undefined;
    try {
      target = await findFunctionTarget(document, new vscode.Position(entry.nameLine, entry.nameStart));
    } catch {
      target = undefined;
    }
    if (!target) {
      if (existing) return existing;
      notice = { tone: "error", text: `Could not locate ${entry.name} in the current source. Try again after the preview updates.` };
      render();
      return undefined;
    }
    return stateFor({ root, target, document });
  };

  const prefetchSettings = (): { enabled: boolean; window: number; dependencies: number } => {
    const settings = vscode.workspace.getConfiguration("downsideUp");
    const count = (key: string, fallback: number) => {
      const value = settings.get<number>(key, fallback) ?? fallback;
      return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
    };
    return {
      enabled: settings.get<boolean>("prefetch.enabled", false) === true,
      window: count("prefetch.window", 10),
      dependencies: count("prefetch.dependencies", 3)
    };
  };

  /** A recent inventory for resolving names; freshness checks still scan the repository themselves. */
  const inventoryMemo = new Map<string, { at: number; value: Promise<RepositoryInventory> }>();
  const recentInventory = (root: string): Promise<RepositoryInventory> => {
    const hit = inventoryMemo.get(root);
    if (hit && Date.now() - hit.at < 5_000) return hit.value;
    const value = gatherInventory(root);
    inventoryMemo.set(root, { at: Date.now(), value });
    value.catch(() => inventoryMemo.delete(root));
    return value;
  };

  /** Opens the file that defines a called function and finds the function there. */
  const targetForCalled = async (
    root: string,
    called: CalledFunction
  ): Promise<{ target: FunctionTarget; document: vscode.TextDocument } | undefined> => {
    const absolute = resolve(root, called.path);
    if (!isWithin(root, absolute)) return undefined;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    const line = Math.min(called.line, document.lineCount - 1);
    const target = await findFunctionTarget(
      document,
      new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex)
    );
    return target && target.name === called.name ? { target, document } : undefined;
  };

  /** Stops prefetching; a request already sent finishes and is saved, queued ones are dropped. */
  const stopPrefetch = (): void => {
    if (!prefetchSession) return;
    prefetchSession.stopped = true;
    wakeSession(prefetchSession);
    prefetchSession = undefined;
  };

  /** Wakes a waiting session, or remembers the wake so the next wait returns at once. */
  function wakeSession(session: PrefetchSession): void {
    if (session.wake) session.wake();
    else session.woken = true;
  }

  const wakePrefetch = (): void => {
    if (prefetchSession) wakeSession(prefetchSession);
  };

  const waitForWake = (session: PrefetchSession): Promise<void> => {
    if (session.woken) {
      session.woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      session.wake = () => {
        session.wake = undefined;
        resolve();
      };
    });
  };

  /** Whether prefetching may send code now, decided without any prompt. */
  const prefetchAllowed = async (root: string): Promise<boolean> => {
    const descriptor = describeProvider();
    if (descriptor.kind === "mock") return true;
    if (!vscode.workspace.isTrusted) return false;
    if (descriptor.kind === "vscode-lm") {
      const reference = parseLanguageModelDescriptorId(descriptor.modelId);
      if (!reference || !isUsableLanguageModelVendor(reference.vendor)) return false;
    }
    const consent = (await cacheStore.read(root)).consent;
    return consent?.provider === descriptor.kind && consent.model === descriptor.modelId;
  };

  /**
   * Shows the saved explanation of a hovered call to a Rust or Go function.
   * It reads only the local cache and never generates; generated text is
   * escaped so it renders as plain text.
   */
  const hoverProvider: vscode.HoverProvider = {
    provideHover: async (document, position, token) => {
      if (document.uri.scheme !== "file") return undefined;
      if (!vscode.workspace.getConfiguration("downsideUp").get<boolean>("hover.savedExplanations", true)) return undefined;
      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (!wordRange) return undefined;
      const word = document.getText(wordRange);
      const root = await resolveRoot(document).catch(() => undefined);
      if (!root || token.isCancellationRequested) return undefined;
      const enclosing = await findFunctionTarget(document, position).catch(() => undefined);
      // Only calls inside a function body; hovering a function's own name is left to other hovers.
      if (!enclosing || enclosing.selection.contains(position) || token.isCancellationRequested) return undefined;
      const called = await recentInventory(root)
        .then((inventory) => findCalledFunctions(enclosing, document, inventory))
        .then((all) => all.find((entry) => entry.name === word))
        .catch(() => undefined);
      if (!called || token.isCancellationRequested) return undefined;
      const resolved = await targetForCalled(root, called).catch(() => undefined);
      if (!resolved || token.isCancellationRequested) return undefined;
      const saved = functions.get(stateKey(root, resolved.target));
      const explanation = saved?.view.status === "current" && saved.view.explanation
        ? saved.view.explanation
        : (await service.findCachedExplanation(root, resolved.target, resolved.document).catch(() => undefined))?.explanation;
      if (!explanation || token.isCancellationRequested) return undefined;
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown("**");
      markdown.appendText(explanation.title || called.qualifiedName);
      markdown.appendMarkdown("** · Downside Up, saved AI explanation of ");
      markdown.appendText(called.qualifiedName);
      markdown.appendMarkdown("\n\n");
      markdown.appendText(explanation.purpose);
      return new vscode.Hover(markdown, wordRange);
    }
  };

  /** A section that has, or is getting, an explanation or a result the reader should see. */
  const hasOutcome = (state: FunctionAi | undefined): boolean =>
    Boolean(state && (state.controller || state.view.explanation || state.view.status !== "loading"));

  /** The function to prefetch next: the nearest one without an outcome in the window around the reader. */
  const nextPrefetchEntry = (session: PrefetchSession, window: number, includeDone = false): OutlineEntry | undefined => {
    if (!preview || !sameUri(preview.document.uri, session.document.uri)) return undefined;
    const candidates = preview.overview.entries
      .filter((entry) => entry.explainable && session.names.has(entry.qualifiedName))
      .map((entry) => ({ entry, key: entry.qualifiedName, startLine: entry.startLine, endLine: entry.endLine, nameLine: entry.nameLine }));
    const done = new Set(includeDone ? [] : session.attempted);
    for (const { entry } of includeDone ? [] : candidates) {
      if (hasOutcome(existingStateForEntry(entry.id))) done.add(entry.qualifiedName);
    }
    const editor = vscode.window.visibleTextEditors.find((candidate) => sameUri(candidate.document.uri, session.document.uri));
    const visible = editor?.visibleRanges[0];
    const focus = prefetchFocusLine(
      editor?.selection.active.line ?? lastEditorTopLine ?? 0,
      visible ? { start: visible.start.line, end: visible.end.line } : undefined
    );
    return nextPrefetch(candidates, focus, window, done)?.entry;
  };

  /** The shown file's function nearest the reader, done or not. */
  const readingEntry = (session: PrefetchSession): OutlineEntry | undefined =>
    nextPrefetchEntry(session, 1, true);

  /**
   * The next function in another file that the function being read calls,
   * among the first `limit` it calls; ones already explained count toward the
   * limit, so it never fetches more than `limit` for one function.
   */
  const nextDependencyState = async (
    session: PrefetchSession,
    reading: OutlineEntry,
    limit: number
  ): Promise<{ state: FunctionAi; release: () => void } | undefined> => {
    let called = session.calledBy.get(reading.qualifiedName);
    if (!called) {
      const target = await findFunctionTarget(session.document, new vscode.Position(reading.nameLine, reading.nameStart))
        .catch(() => undefined);
      const ownPath = filePath(session.root, session.document.uri);
      const all = target
        ? await recentInventory(session.root)
          .then((inventory) => findCalledFunctions(target, session.document, inventory))
          .catch(() => [])
        : [];
      called = all.filter((entry, index) =>
        entry.path !== ownPath &&
        all.findIndex((other) => other.path === entry.path && other.qualifiedName === entry.qualifiedName) === index
      );
      session.calledBy.set(reading.qualifiedName, called);
    }
    for (const entry of called.slice(0, limit)) {
      const key = `${entry.path}\0${entry.qualifiedName}`;
      if (session.attemptedDependencies.has(key)) continue;
      session.attemptedDependencies.add(key);
      const resolved = await targetForCalled(session.root, entry).catch(() => undefined);
      if (!resolved) continue;
      const existing = functions.get(stateKey(session.root, resolved.target));
      if (hasOutcome(existing)) continue;
      return {
        state: stateFor({ root: session.root, target: resolved.target, document: resolved.document }),
        release: () => session.attemptedDependencies.delete(key)
      };
    }
    return undefined;
  };

  /**
   * Explains the shown file's functions in the background, filling the
   * request slots that explicit requests leave free, nearest to the reader
   * first: each time a slot frees, the next function is chosen from the
   * reader's current position. Right after the function being read, the
   * functions it calls in other files come next. It waits for the reader to
   * move when its window is done. A failed request is retried once after a
   * pause; a second failure stops prefetching with a notice.
   */
  const runPrefetch = async (session: PrefetchSession): Promise<void> => {
    const active = () => !session.stopped && prefetchSession === session;
    const launch = (state: FunctionAi, key: string, release: () => void): void => {
      void generate(state, { prefetch: { shouldStart: active } })
        .then(async () => {
          if (state.view.status !== "failed" || !active()) return;
          if (session.retried.has(key)) {
            notice = { tone: "error", text: `Prefetching stopped after an error: ${state.view.error ?? "generation failed"}` };
            render();
            stopPrefetch();
            return;
          }
          // Back off briefly, for example after a rate limit, then try this function once more.
          session.retried.add(key);
          await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
          if (!active() || state.view.status !== "failed") return;
          forget(state);
          release();
          render();
        })
        .finally(() => wakeSession(session));
    };
    while (active()) {
      const { enabled, window, dependencies } = prefetchSettings();
      if (!enabled) {
        stopPrefetch();
        return;
      }
      if (scheduler.prefetchCapacity === 0) {
        await waitForWake(session);
        continue;
      }
      const entry = nextPrefetchEntry(session, window);
      const reading = dependencies > 0 ? readingEntry(session) : undefined;
      if (reading && entry?.id !== reading.id && (await prefetchAllowed(session.root))) {
        const dependency = active() ? await nextDependencyState(session, reading, dependencies) : undefined;
        if (!active()) return;
        if (dependency) {
          launch(dependency.state, `dependency\0${dependency.state.key}`, dependency.release);
          continue;
        }
      }
      if (!entry) {
        await waitForWake(session);
        continue;
      }
      if (!(await prefetchAllowed(session.root))) {
        if (!active()) return;
        notice = {
          tone: "info",
          text: "Prefetching is waiting: it runs only in a trusted workspace after you have explained one function with the current model, which approves code sharing for this repository."
        };
        render();
        stopPrefetch();
        return;
      }
      if (!active()) return;
      session.attempted.add(entry.qualifiedName);
      let target: FunctionTarget | undefined;
      try {
        target = await findFunctionTarget(session.document, new vscode.Position(entry.nameLine, entry.nameStart));
      } catch {
        target = undefined;
      }
      if (!target || !active()) continue;
      const state = stateFor({ root: session.root, target, document: session.document });
      if (hasOutcome(state)) continue;
      launch(state, entry.qualifiedName, () => session.attempted.delete(entry.qualifiedName));
    }
  };

  /** Starts prefetching for the shown file when the user setting allows it. */
  const startPrefetch = (document: vscode.TextDocument, root: string): void => {
    stopPrefetch();
    if (!panel || !preview || !sameUri(preview.document.uri, document.uri) || preview.exclusion || !prefetchSettings().enabled) return;
    const names = new Set(preview.overview.entries.filter((entry) => entry.explainable).map((entry) => entry.qualifiedName));
    if (names.size === 0) return;
    const session: PrefetchSession = {
      root,
      document,
      names,
      attempted: new Set(),
      attemptedDependencies: new Set(),
      calledBy: new Map(),
      retried: new Set(),
      stopped: false,
      woken: false
    };
    prefetchSession = session;
    void runPrefetch(session).catch(() => {
      if (prefetchSession === session) stopPrefetch();
    });
  };

  async function handlePanelAction(action: PanelAction): Promise<void> {
    switch (action.type) {
      case "navigate":
        await panel?.navigate(action.referenceId);
        return;
      case "expand": {
        const state = await resolveEntryState(action.entryId);
        if (state) {
          state.collapsedByUser = false;
          await openExplanation(state);
        }
        return;
      }
      case "collapse": {
        const state = existingStateForEntry(action.entryId);
        if (state) {
          state.expanded = false;
          state.collapsedByUser = true;
          render();
        }
        return;
      }
      case "regenerate": {
        const state = await resolveEntryState(action.entryId);
        if (state) await generate(state);
        return;
      }
      case "cancelEntry":
        existingStateForEntry(action.entryId)?.controller?.abort();
        return;
      case "cancel":
        repositoryJob?.abort();
        return;
      case "refreshContext":
        await refreshRepositoryContext();
        return;
      case "clearCache":
        await clearRepositoryCache();
        return;
      case "chooseModel":
        await chooseLanguageModel();
        render();
        return;
      case "revealItem":
        await revealItem(action.entryId, action.kind, action.index);
        return;
      case "addFormat":
        await addFormat(action.entryId, action.format);
        return;
      case "revealLine": {
        const current = preview;
        if (!current) return;
        const editor = vscode.window.visibleTextEditors.find((candidate) => sameUri(candidate.document.uri, current.document.uri));
        if (!editor) return;
        const line = Math.min(action.line, editor.document.lineCount - 1);
        if (line === lastEditorTopLine) return;
        lastEditorTopLine = line;
        suppressEditorSyncUntil = Date.now() + 250;
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
        return;
      }
    }
  }

  const ensurePanel = (): ExplanationPanel => {
    if (panel) return panel;
    const created = new ExplanationPanel(
      "Downside Up",
      (action) => void handlePanelAction(action),
      () => {
        if (panel !== created) return;
        clearReveal();
        stopPrefetch();
        for (const state of [...functions.values()]) forget(state);
        savedLookupEpoch++;
        savedLookupDone.clear();
        repositoryJob?.abort();
        repositoryJob = undefined;
        preview = undefined;
        notice = undefined;
        panel = undefined;
      },
      (visible) => {
        if (visible && lastTextEditor) void previewDocument(lastTextEditor.document);
      }
    );
    panel = created;
    return created;
  };

  /** Shows a saved explanation for selected function text; a cache miss never generates. */
  const showSavedExplanation = async (
    document: vscode.TextDocument,
    root: string,
    selection: vscode.Selection,
    lookup: number
  ): Promise<void> => {
    let target: FunctionTarget | undefined;
    try {
      target = await findFunctionTarget(document, selection.start);
    } catch {
      target = undefined;
    }
    if (lookup !== selectionLookupEpoch || !panel?.panel.visible) return;
    if (!target || !target.range.contains(selection.start) || !target.range.contains(selection.end)) return;
    const existing = functions.get(stateKey(root, target));
    if (existing && (existing.controller || existing.view.explanation)) {
      if (!existing.expanded) {
        existing.expanded = true;
        render();
      }
      return;
    }
    const cached = await service.findCachedExplanation(root, target, document);
    if (lookup !== selectionLookupEpoch || !cached) return;
    const state = stateFor({ root, target, document });
    if (state.controller) return;
    state.epoch++;
    state.expanded = true;
    applyResult(state, cached);
    render();
  };

  const rootForCommand = async (): Promise<string | undefined> => {
    if (preview) return preview.root;
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === "file") {
      try {
        return await resolveRoot(editor.document);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const refreshRepositoryContext = async (): Promise<void> => {
    const root = await rootForCommand();
    if (!root) {
      await vscode.window.showInformationMessage("Open a source file in a workspace folder first.");
      return;
    }
    if (repositoryJob || !(await ensureLanguageModelSelected())) return;
    const controller = new AbortController();
    repositoryJob = controller;
    notice = { tone: "progress", text: "Refreshing repository context by request…" };
    render();
    try {
      const result = await scheduler.schedule("explicit", () => {
        if (controller.signal.aborted) throw new DOMException("The request was cancelled.", "AbortError");
        return service.refreshRepositoryContext(root, controller.signal, (progress) => {
          if (repositoryJob !== controller) return;
          notice = { tone: "progress", text: progress.detail };
          render();
        });
      });
      if (repositoryJob !== controller) return;
      const previous = repositoryContext?.root === root ? repositoryContext.overview : undefined;
      const changed = Boolean(previous && JSON.stringify(previous) !== JSON.stringify(result.overview));
      repositoryContext = { root, overview: result.overview };
      notice = {
        tone: "info",
        text: `${changed ? "Repository context changed. Saved explanations stay current; they note that an earlier overview was used." : "Repository context checked."} ${formatUsage(result.usage)}`
      };
      if (changed) scheduleRecheck();
    } catch (error) {
      if (repositoryJob !== controller) return;
      notice = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
        ? { tone: "info", text: "Repository context refresh cancelled; nothing was sent or saved." }
        : { tone: "error", text: `Repository context refresh failed: ${errorMessage(error)}` };
    } finally {
      if (repositoryJob === controller) repositoryJob = undefined;
      render();
    }
  };

  const clearRepositoryCache = async (): Promise<void> => {
    const root = await rootForCommand();
    if (!root) {
      await vscode.window.showInformationMessage("Open a source file in a workspace folder first.");
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Clear The Downside Up's local overview, explanations, and saved code-sharing consent for this repository?\n\n${root}`,
      { modal: true },
      "Clear repository cache"
    );
    if (answer !== "Clear repository cache") return;
    stopPrefetch();
    savedLookupEpoch++;
    for (const state of [...functions.values()]) if (state.value.root === root) forget(state);
    repositoryJob?.abort();
    repositoryJob = undefined;
    await service.clearCache(root);
    if (repositoryContext?.root === root) repositoryContext = undefined;
    notice = { tone: "info", text: "Repository cache and saved code-sharing consent cleared." };
    render();
  };

  const chooseWorkspace = async (document?: vscode.TextDocument): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      await vscode.window.showWarningMessage("Open a local repository folder before explaining code.");
      return undefined;
    }
    const folder = document ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
    if (folder) return folder;
    if (folders.length === 1) return folders[0];
    const chosen = await vscode.window.showQuickPick(
      folders.map((entry) => ({ label: entry.name, description: entry.uri.fsPath, folder: entry })),
      { placeHolder: "Choose which repository contains the active source file" }
    );
    return chosen?.folder;
  };

  const findFunctionTarget = async (
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<FunctionTarget | undefined> => {
    let target: FunctionTarget | undefined;
    if (document.languageId === "rust" || extname(document.uri.fsPath).toLowerCase() === ".rs") {
      await initializeRustParser(context);
      target = await findRustFunction(document, position);
    } else if (isGoDocument(document)) {
      await initializeGoParser(context);
      target = await findGoFunction(document, position);
    }
    return target ?? findFunctionWithEditorTools(document, position);
  };

  const selectFunction = async (): Promise<SelectedFunction | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showWarningMessage("Open a source file and place the cursor inside a function.");
      return undefined;
    }
    const folder = await chooseWorkspace(editor.document);
    if (!folder) return undefined;
    if (editor.document.uri.scheme !== "file") {
      await vscode.window.showWarningMessage("This prototype supports local file workspaces only.");
      return undefined;
    }
    let root: string;
    try {
      root = await findRepositoryRoot(folder.uri.fsPath);
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Could not resolve the repository root: ${error instanceof Error ? error.message : "unknown error"}`
      );
      return undefined;
    }
    let target: FunctionTarget | undefined;
    try {
      target = await findFunctionTarget(editor.document, editor.selection.active);
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Function discovery is unavailable: ${error instanceof Error ? error.message : "unknown tooling error"}`
      );
    }
    if (!target) {
      await vscode.window.showInformationMessage(
        `No enclosing function or method was found for ${editor.document.languageId}. Ensure the editor has a language symbol provider; this command does not explain arbitrary blocks.`
      );
      return undefined;
    }
    return { root, target, document: editor.document };
  };


  const explainCommand = async (): Promise<void> => {
    const value = await selectFunction();
    if (!value) return;
    ensurePanel();
    if (!preview || !sameUri(preview.document.uri, value.document.uri)) await showPreview(value.document, value.root);
    const state = stateFor(value);
    if (state.view.status === "outdated" || state.view.status === "failed" || state.view.status === "cancelled") {
      await generate(state);
    } else {
      await openExplanation(state);
    }
  };

  const openPreviewCommand = async (resource?: vscode.Uri): Promise<void> => {
    let document: vscode.TextDocument | undefined;
    if (resource instanceof vscode.Uri && resource.scheme === "file") {
      document = await vscode.workspace.openTextDocument(resource);
    } else {
      const editor = vscode.window.activeTextEditor ?? lastTextEditor;
      document = editor?.document;
      if (editor) lastTextEditor = editor;
    }
    if (!document || document.uri.scheme !== "file") {
      await vscode.window.showWarningMessage("Open a local source file to preview it with Downside Up.");
      return;
    }
    if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
      await vscode.window.showWarningMessage("Open the source file inside a workspace folder to preview it.");
      return;
    }
    const existing = panel;
    ensurePanel();
    if (existing) existing.panel.reveal(undefined, true);
    await previewDocument(document);
  };

  const cancelExplanations = (): void => {
    stopPrefetch();
    repositoryJob?.abort();
    for (const state of functions.values()) state.controller?.abort();
  };

  const setApiKey = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: "Store OpenAI API key securely",
      prompt: "The key is stored in VS Code SecretStorage and is never placed in settings or the repository.",
      password: true,
      ignoreFocusOut: true
    });
    if (!value) return;
    await context.secrets.store(API_KEY_SECRET, value.trim());
    await vscode.window.showInformationMessage("OpenAI API key stored in VS Code SecretStorage.");
  };

  const removeApiKey = async (): Promise<void> => {
    await context.secrets.delete(API_KEY_SECRET);
    await vscode.window.showInformationMessage("Stored OpenAI API key removed.");
  };



  const onDocumentChange = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0 || event.document.uri.scheme !== "file") return;
    if (revealed?.uri === event.document.uri.toString()) clearReveal();
    const current = preview;
    if (current && sameUri(event.document.uri, current.document.uri)) {
      // A cache lookup that started before this edit would describe the old source.
      selectionLookupEpoch++;
      savedLookupEpoch++;
      if (selectionTimer) clearTimeout(selectionTimer);
      if (panel) {
        if (outlineTimer) clearTimeout(outlineTimer);
        const edited = event.document;
        outlineTimer = setTimeout(() => {
          if (!preview || !sameUri(preview.document.uri, edited.uri)) return;
          void showPreview(edited, current.root).catch(() => undefined);
        }, 300);
      }
    }
    for (const state of functions.values()) {
      if (!state.result) continue;
      const path = filePath(state.value.root, event.document.uri);
      if (sameUri(state.value.document.uri, event.document.uri) ||
        state.result.context.inputs.some((input) => input.path === path)) {
        scheduleRecheck(path);
        break;
      }
    }
  });

  const onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
    // Focus moving to the preview or another panel leaves no active text editor.
    if (!editor) return;
    lastTextEditor = editor;
    selectionLookupEpoch++;
    if (selectionTimer) clearTimeout(selectionTimer);
    if (outlineTimer) clearTimeout(outlineTimer);
    if (panel?.panel.visible) void previewDocument(editor.document);
  });

  const onVisibleRangesChange = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    if (!panel?.panel.visible || !preview || !sameUri(event.textEditor.document.uri, preview.document.uri)) return;
    // Scrolling either side moves the reading position that prefetching spreads out from.
    wakePrefetch();
    const line = event.visibleRanges[0]?.start.line ?? 0;
    // Ignore the editor scrolling that the preview itself requested, and repeated ranges.
    if (Date.now() < suppressEditorSyncUntil) {
      lastEditorTopLine = line;
      return;
    }
    if (line === lastEditorTopLine) return;
    lastEditorTopLine = line;
    panel.scrollToLine(line);
  });

  const onTextSelectionChange = vscode.window.onDidChangeTextEditorSelection((event) => {
    lastTextEditor = event.textEditor;
    const moved = event.selections[0];
    if (revealed && (event.textEditor.document.uri.toString() !== revealed.uri || !moved?.isEmpty || !moved.active.isEqual(revealed.caret))) {
      clearReveal();
    }
    if (!panel?.panel.visible || !preview || !sameUri(event.textEditor.document.uri, preview.document.uri)) return;
    const selection = event.selections[0];
    if (!selection) return;
    wakePrefetch();
    panel.highlightEntry(innermostRangeAt(shownEntries(), selection.active.line)?.id);
    // A cursor move in the code brings what it highlights into view; a click in the preview does not scroll it.
    syncStepHighlight(selection, !revealed);
    if (event.selections.length !== 1 || selection.isEmpty) return;
    if (selectionTimer) clearTimeout(selectionTimer);
    const lookup = ++selectionLookupEpoch;
    const { document, root } = preview;
    selectionTimer = setTimeout(() => {
      void showSavedExplanation(document, root, selection, lookup).catch((error: unknown) => {
        if (lookup !== selectionLookupEpoch) return;
        notice = { tone: "error", text: `Could not check saved explanations: ${errorMessage(error)}` };
        render();
      });
    }, 250);
  });

  const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("downsideUp.preview.include") ||
      event.affectsConfiguration("downsideUp.explanations")
    ) {
      render();
    }
    if (event.affectsConfiguration("downsideUp.maxConcurrentRequests")) {
      scheduler.pump();
      wakePrefetch();
    }
    if (event.affectsConfiguration("downsideUp.prefetch")) {
      if (!prefetchSettings().enabled) stopPrefetch();
      else if (prefetchSession) wakePrefetch();
      else if (panel && preview) startPrefetch(preview.document, preview.root);
    }
    if (
      !event.affectsConfiguration("downsideUp.provider") &&
      !event.affectsConfiguration("downsideUp.openai.model") &&
      !event.affectsConfiguration("downsideUp.languageModel")
    ) return;
    scheduleRecheck();
    // Saved explanations and file summaries are per model, so other ones may now apply.
    savedLookupDone.clear();
    if (preview) void loadFileSummary(preview.document, preview.root);
    stopPrefetch();
    if (panel && preview) {
      const { document, root } = preview;
      void markSavedExplanations(document, root).catch(() => undefined).then(() => {
        if (preview && sameUri(preview.document.uri, document.uri)) startPrefetch(document, root);
      });
    }
    render();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("downsideUp.explainFunction", explainCommand),
    vscode.commands.registerCommand("downsideUp.showFileOverview", openPreviewCommand),
    vscode.commands.registerCommand("downsideUp.refreshRepositoryContext", refreshRepositoryContext),
    vscode.commands.registerCommand("downsideUp.clearCache", clearRepositoryCache),
    vscode.commands.registerCommand("downsideUp.cancelExplanation", cancelExplanations),
    vscode.commands.registerCommand("downsideUp.setApiKey", setApiKey),
    vscode.commands.registerCommand("downsideUp.removeApiKey", removeApiKey),
    vscode.commands.registerCommand("downsideUp.selectLanguageModel", async () => {
      await chooseLanguageModel();
      render();
    }),
    onDocumentChange,
    onActiveEditorChange,
    onVisibleRangesChange,
    onTextSelectionChange,
    onConfigChange,
    vscode.languages.registerHoverProvider(
      [
        { scheme: "file", language: "rust" },
        { scheme: "file", language: "go" },
        { scheme: "file", pattern: "**/*.{rs,go}" }
      ],
      hoverProvider
    ),
    new vscode.Disposable(() => {
      cancelExplanations();
      if (selectionTimer) clearTimeout(selectionTimer);
      if (outlineTimer) clearTimeout(outlineTimer);
      if (recheckTimer) clearTimeout(recheckTimer);
      panel?.panel.dispose();
      for (const disposables of rootWatchers.values()) for (const disposable of disposables) disposable.dispose();
      rootWatchers.clear();
    })
  );

  // Read-only hooks for the extension-host tests; other extensions never receive them.
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    previewExplanations: () => previewStates().map(({ state }) => ({
      functionName: state.view.functionName,
      status: state.view.status,
      expanded: state.expanded
    })),
    stepHighlight: () => lastStepHighlight,
    revealedLines: () => revealed ? { start: revealed.start, end: revealed.end } : undefined,
    revealStep: async (functionName: string, step: number, kind: LinkedKind = "step") => {
      const found = previewStates().find(({ state }) => state.view.functionName === functionName);
      if (found) await revealItem(found.entry.id, kind, step);
    },
    addFormat: async (functionName: string, format: ExplanationFormat) => {
      const found = previewStates().find(({ state }) => state.view.functionName === functionName);
      if (found) await addFormat(found.entry.id, format);
    },
    explanationOf: (functionName: string) =>
      previewStates().find(({ state }) => state.view.functionName === functionName)?.state.view.explanation,
    shownOutline: () => shownEntries().map((entry) => ({ kindLabel: entry.kindLabel, name: entry.name })),
    fileSummary: () => fileSummary && preview && fileSummary.uri === preview.document.uri.toString()
      ? { text: fileSummary.text, current: fileSummary.current }
      : undefined,
    allExplanations: () => [...functions.values()].map((state) => ({
      functionName: state.view.functionName,
      status: state.view.status,
      path: filePath(state.value.root, state.value.document.uri),
      ...(state.view.error ? { error: state.view.error } : {})
    }))
  };
}

export interface DownsideUpTestApi {
  previewExplanations(): Array<{ functionName: string; status: string; expanded: boolean }>;
  allExplanations(): Array<{ functionName: string; status: string; path: string; error?: string }>;
  shownOutline(): Array<{ kindLabel: string; name: string }>;
  stepHighlight(): { functionName: string; steps: number[]; pseudocode: number[]; nodes: number[] } | undefined;
  revealStep(functionName: string, index: number, kind?: LinkedKind): Promise<void>;
  revealedLines(): { start: number; end: number } | undefined;
  addFormat(functionName: string, format: ExplanationFormat): Promise<void>;
  explanationOf(functionName: string): FunctionExplanation | undefined;
  fileSummary(): { text: string; current: boolean } | undefined;
}

export function deactivate(): void {}
