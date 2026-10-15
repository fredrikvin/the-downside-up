import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { hasConsent, withConsent } from "./cache/consent";
import { FileRepositoryCacheStore } from "./cache/store";
import {
  ExplanationService,
  type ExplanationResult,
  type FlowsRequest,
  type ProviderDescriptor
} from "./controller";
import {
  findRepositoryRoot,
  gatherInventory,
  listEligibleFiles,
  listFolder,
  sharingExclusion,
  type FolderChild,
  type RepositoryInventory
} from "./context/inventory";
import { folderStructure, type StructureGraph } from "./context/structure";
import { folderSummaryInput, projectFlowsInput } from "./context/folderInput";
import { collectFolderTree, foldersToSummarize, type FolderTree } from "./context/folderTree";
import {
  folderLevel,
  isContractFile,
  mapMembers,
  mapPartAt,
  mapView,
  type FolderPageLevel
} from "./context/projectMap";
import type { FolderSummaryPromptInput, ProjectFlowsPromptInput } from "./generation/provider";
import { folderSummaryPrompt, partFlowsPrompt, projectFlowsPrompt } from "./generation/prompts";
import { findCalledFunctions, type CalledFunction } from "./context/related";
import { buildFileOverview, type FileOverview, type OutlineEntry } from "./context/fileOverview";
import type {
  ExplanationFormat,
  FlowReference,
  FolderSummary,
  FunctionExplanation,
  FunctionTarget,
  LineLinked,
  ProjectFlow,
  ProjectMap,
  ProjectMapDetail,
  RepositoryOverview,
  Usage
} from "./core/types";
import { MockProvider } from "./generation/mock";
import { OpenAIProvider } from "./generation/openai";
import {
  languageModelConsentId,
  LanguageModelProvider,
  orderLanguageModels,
  resolveLanguageModel
} from "./generation/languageModel";
import { formatUsage } from "./generation/provider";
import { nextPrefetch, nextReview, prefetchFocusLine } from "./presentation/prefetch";
import { baseChoices, changedLinesSince, recentCommits, touchesChange } from "./context/changes";
import { clearPolicyCache } from "./context/policy";
import { RequestScheduler, singleFlight } from "./presentation/requestScheduler";
import { outlineInclude, visibleOutline } from "./presentation/outlineFilter";
import { innermostAt, pseudocodeLayout, stepRanges, stepsAt, type StepRange } from "./presentation/stepLines";
import { findFunctionWithEditorTools } from "./languages/editor/symbols";
import { bundledLanguageFor, initializeLanguage } from "./languages/registry";
import {
  ExplanationPanel,
  type Crumb,
  type FolderView,
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

/** A folder previewed like a file: its children, saved file summaries, and import structure. */
interface FolderPreview {
  readonly root: string;
  /** Repository-relative path, or "" for the repository root. */
  readonly path: string;
  readonly children: readonly FolderChild[];
  /** Saved summaries of its files and subfolders, by path. */
  readonly summaries: ReadonlyMap<string, { summary: string; current: boolean }>;
  readonly structure?: StructureGraph;
  readonly limitations: readonly string[];
  /** What a folder summary would be made from, once the structure is known. */
  readonly input?: FolderSummaryPromptInput;
  readonly ai?: { value: FolderSummary; current: boolean };
  readonly summaryError?: string;
  /** How the page zooms, from the saved project map. */
  readonly level: FolderPageLevel;
  /** The saved project map; `current` is false when it was made with other settings. */
  readonly map?: { readonly map: ProjectMap; readonly current: boolean };
  /** What main flows would be made from, built after the structure. */
  readonly flowsInput?: FlowsRequest;
  readonly flows?: { flows: readonly ProjectFlow[]; current: boolean };
  readonly flowsError?: string;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A run that summarizes a folder and every subfolder below it, deepest first, then describes its main flows. */
interface FolderTreeJob {
  readonly root: string;
  readonly path: string;
  /** Every folder in the tree, so previews inside it show the run's progress. */
  readonly folders: ReadonlySet<string>;
  readonly controller: AbortController;
  readonly total: number;
  done: number;
  readonly running: Set<string>;
  readonly failed: string[];
  readonly usages: Usage[];
}

/** A checked and accepted tree run: the folders to summarize, leaves first, and whether flows follow. */
interface FolderTreePlan {
  readonly root: string;
  readonly path: string;
  readonly tree: FolderTree;
  readonly todo: ReadonlySet<string>;
  readonly flowsNeeded: boolean;
  /** The overview model the reader accepted; the run stops if it changes. */
  readonly model: ProviderDescriptor;
}

/** A background job that waits to be woken when a request slot frees or the reader moves. */
interface Wakeable {
  /** Set when the job was woken while not waiting, so the wake is not lost. */
  woken: boolean;
  wake?: () => void;
}

/** A changed function that review mode explains ahead of the reader. */
interface ReviewItem {
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly name: string;
  readonly qualifiedName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nameLine: number;
  readonly nameStart: number;
  status: "pending" | "explaining" | "done" | "failed" | "skipped";
}

/** Review mode: explains the functions changed since a base commit, nearest the reader first. */
interface ReviewSession extends Wakeable {
  readonly root: string;
  /** Such as "since main (merge base 1a2b3c4)". */
  readonly base: string;
  readonly items: ReviewItem[];
  readonly retried: Set<ReviewItem>;
  stopped: boolean;
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
  /** The repository the running context refresh (or project mapping) is for. */
  let repositoryJobRoot: string | undefined;
  /** Projects, per overview model, not mapped automatically again this session after a declined approval, a cancel, or a failure. */
  const autoMapSkipped = new Set<string>();
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
  let reviewSession: ReviewSession | undefined;
  /** The folder shown instead of a file, until the active editor changes. */
  let folderPreview: FolderPreview | undefined;
  /**
   * Folder summary and flow requests in progress, by kind, repository,
   * folder, and overview model, so they stay cancellable and are not started
   * twice when the reader moves away and back.
   */
  const folderJobs = new Map<string, AbortController>();
  const folderJobKey = (kind: "summary" | "flows" | "tree", root: string, path: string): string =>
    [kind, root, path, describeOverviewProvider().kind, describeOverviewProvider().modelId].join("\0");
  let folderEpoch = 0;
  /** Shown while a folder's listing loads; a file shown meanwhile, or the folder itself, replaces it. */
  let openingFolder: { epoch: number; name: string } | undefined;
  let treeJob: FolderTreeJob | undefined;
  /** Set while a tree run is being checked and confirmed, before it starts. */
  let planningTree = false;
  /** Whether a tree run covers this folder, so its own requests wait for the run. */
  const inTreeJob = (root: string, path: string): boolean => Boolean(treeJob && treeJob.root === root && treeJob.folders.has(path));
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
      return { kind: "vscode-lm", modelId: settings.get<string>("languageModel.model", "").trim() };
    }
    if (configured === "openai") {
      const model = settings.get<string>("openai.model", "gpt-4.1-mini").trim();
      return { kind: "openai", modelId: model || "gpt-4.1-mini" };
    }
    return { kind: "mock", modelId: mockProvider.modelId };
  };

  /**
   * The model for project-level work: the repository overview and folder
   * summaries. Set separately so a stronger model can do this rarer work;
   * empty settings use the explanation model.
   */
  const describeOverviewProvider = (): ProviderDescriptor => {
    const base = describeProvider();
    const settings = vscode.workspace.getConfiguration("downsideUp");
    if (base.kind === "vscode-lm") {
      const model = settings.get<string>("languageModel.overviewModel", "").trim();
      return model ? { kind: "vscode-lm", modelId: model } : base;
    }
    if (base.kind === "openai") {
      const model = settings.get<string>("openai.overviewModel", "").trim();
      return model ? { kind: "openai", modelId: model } : base;
    }
    return base;
  };

  const service = new ExplanationService({
    store: cacheStore,
    describeProvider,
    describeOverviewProvider,
    createProvider: async (descriptor) => {
      if (descriptor.kind === "mock") return mockProvider;
      if (descriptor.kind === "vscode-lm") {
        const model = await findLanguageModel(descriptor.modelId);
        if (!model) throw new Error(missingLanguageModelMessage(descriptor.modelId));
        return new LanguageModelProvider(descriptor.modelId, model);
      }
      const key = await context.secrets.get(API_KEY_SECRET);
      if (!key) {
        throw new Error("No OpenAI API key is stored. Run “Downside Up: Set OpenAI API Key”.");
      }
      return new OpenAIProvider(descriptor.modelId, key);
    },
    maxRequestBytes: () => {
      const kib = vscode.workspace.getConfiguration("downsideUp").get<number>("maxRequestSize", 96);
      return (typeof kib === "number" && Number.isFinite(kib) ? Math.min(512, Math.max(32, Math.round(kib))) : 96) * 1024;
    },
    projectMapDetail: (): ProjectMapDetail =>
      vscode.workspace.getConfiguration("downsideUp").get<string>("projectMap.detail", "brief") === "detailed" ? "detailed" : "brief",
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
        const consentId = await consentModelId(descriptor);
        return consentId !== undefined && hasConsent(await cacheStore.read(root), descriptor.kind, consentId);
      }
      if (descriptor.kind === "mock") return true;
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showErrorMessage(
          "External code sharing is disabled in an untrusted workspace. Trust the workspace before using a language model provider."
        );
        return false;
      }
      const model = descriptor.kind === "vscode-lm" ? await findLanguageModel(descriptor.modelId) : undefined;
      if (descriptor.kind === "vscode-lm" && !model) throw new Error(missingLanguageModelMessage(descriptor.modelId));
      // Language model consent names the vendor, so a same-named model from another vendor asks again.
      const consentId = model ? languageModelConsentId(model) : descriptor.modelId;
      if (hasConsent(await cacheStore.read(root), descriptor.kind, consentId)) return true;
      const provider = descriptor.kind;
      // Parallel requests share one prompt for the same repository and model.
      return singleFlight(consentPrompts, `${root}\0${descriptor.kind}\0${consentId}`, async () => {
        const approximateTokens = Math.ceil(estimatedBytes / 4);
        const destination = model
          ? `Provider: VS Code language model from “${model.vendor}”\nModel: ${model.name}`
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
        await cacheStore.update(root, (current) => withConsent(current, provider, consentId, Date.now()));
        afterConsent(root);
        return true;
      });
    }
  });

  const availableLanguageModels = async (): Promise<vscode.LanguageModelChat[]> => {
    try {
      return orderLanguageModels(await vscode.lm.selectChatModels());
    } catch {
      return [];
    }
  };

  /** The available model a setting names, or undefined; never prompts. */
  const findLanguageModel = async (setting: string): Promise<vscode.LanguageModelChat | undefined> =>
    setting ? resolveLanguageModel(await availableLanguageModels(), setting) : undefined;

  const missingLanguageModelMessage = (setting: string): string =>
    setting
      ? `The language model “${setting}” is not available. Sign in to its provider (for example GitHub Copilot) or run “Downside Up: Choose Language Model”.`
      : "No language model is selected. Run “Downside Up: Choose Language Model”.";

  /** The consent identity for a descriptor, or undefined when its language model is unavailable. */
  const consentModelId = async (descriptor: ProviderDescriptor): Promise<string | undefined> => {
    if (descriptor.kind !== "vscode-lm") return descriptor.modelId;
    const model = await findLanguageModel(descriptor.modelId);
    return model ? languageModelConsentId(model) : undefined;
  };

  const languageModelItem = (model: vscode.LanguageModelChat, current: vscode.LanguageModelChat | undefined) => ({
    label: model.name,
    description: `${model.vendor}${current?.vendor === model.vendor && current.id === model.id ? " · current" : ""}`,
    detail: `Up to ${model.maxInputTokens.toLocaleString()} input tokens · ${model.id}`,
    model
  });

  const chooseLanguageModel = async (): Promise<boolean> => {
    const models = await availableLanguageModels();
    if (models.length === 0) {
      await vscode.window.showWarningMessage(
        "No VS Code language models are available. Install and sign in to GitHub Copilot, or install another extension that provides language models, then try again."
      );
      return false;
    }
    const descriptor = describeProvider();
    const current = descriptor.kind === "vscode-lm" ? resolveLanguageModel(models, descriptor.modelId) : undefined;
    const picked = await vscode.window.showQuickPick(
      models.map((model) => languageModelItem(model, current)),
      {
        title: "Choose the language model for Downside Up",
        placeHolder: "Uses your existing subscription with the model's provider. No code is sent until you explain a function and accept the sharing prompt.",
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!picked) return false;
    const settings = vscode.workspace.getConfiguration("downsideUp");
    await settings.update("languageModel.model", picked.model.name, vscode.ConfigurationTarget.Global);
    await settings.update("provider", "vscode-lm", vscode.ConfigurationTarget.Global);
    const effective = describeProvider();
    if (effective.kind !== "vscode-lm" || resolveLanguageModel(models, effective.modelId) !== picked.model) {
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

  /** Picks the language model for the repository overview and folder summaries, or the explanation model. */
  const chooseOverviewModel = async (): Promise<void> => {
    if (describeProvider().kind !== "vscode-lm") {
      await vscode.window.showInformationMessage(
        describeProvider().kind === "openai"
          ? "With OpenAI, set the overview model in the setting downsideUp.openai.overviewModel."
          : "Choose a language model with “Downside Up: Choose Language Model” first; the overview model applies to VS Code language models."
      );
      return;
    }
    const models = await availableLanguageModels();
    const overviewSetting = vscode.workspace.getConfiguration("downsideUp").get<string>("languageModel.overviewModel", "").trim();
    const current = overviewSetting ? resolveLanguageModel(models, overviewSetting) : undefined;
    const same = {
      label: "Same as explanations",
      description: `use the explanation model for project-level work too${overviewSetting ? "" : " · current"}`,
      model: undefined as vscode.LanguageModelChat | undefined
    };
    const picked = await vscode.window.showQuickPick(
      [same, ...models.map((model) => languageModelItem(model, current))],
      {
        title: "Choose the model for project overviews",
        placeHolder: "Used for the repository overview and folder summaries, which are rarer and benefit from a stronger model. It asks once before sharing code.",
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!picked) return;
    await vscode.workspace.getConfiguration("downsideUp")
      .update("languageModel.overviewModel", picked.model?.name, vscode.ConfigurationTarget.Global);
  };

  const ensureLanguageModelSelected = async (): Promise<boolean> => {
    const descriptor = describeProvider();
    if (descriptor.kind !== "vscode-lm") return true;
    if (descriptor.modelId && (await findLanguageModel(descriptor.modelId))) return true;
    if (descriptor.modelId) {
      await vscode.window.showWarningMessage(
        `The language model “${descriptor.modelId}” is not available. Choose another model.`
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
    // Breadcrumbs and folder contents open folders and files through ids the host resolves.
    const target = (open: () => Promise<void>): string => {
      const id = `go-${handlers.size}`;
      handlers.set(id, open);
      return id;
    };
    const shownRoot = preview?.root ?? folderPreview?.root;
    const breadcrumbs = shownRoot === undefined
      ? undefined
      : crumbsFor(shownRoot, preview ? filePath(shownRoot, preview.document.uri) : folderPreview!.path, Boolean(preview), target);
    const folder = folderPreview && !preview ? folderView(folderPreview, target) : undefined;
    const shownContext = shownRoot !== undefined && repositoryContext?.root === shownRoot ? repositoryContext : undefined;
    panel.setReferenceHandlers(handlers);
    const summary = preview && fileSummary?.uri === preview.document.uri.toString() ? fileSummary : undefined;
    panel.update({
      provider: descriptor.kind,
      model: descriptor.modelId || "no model selected",
      ...(preview ? { document: { ...preview.overview, entries: shownEntries() } } : {}),
      ...(folder ? { folder } : {}),
      ...(breadcrumbs ? { breadcrumbs } : {}),
      explanations,
      ...(summary ? { summary: { text: summary.text, current: summary.current } } : {}),
      showDetails: vscode.workspace.getConfiguration("downsideUp").get<boolean>("explanations.showDetails", false) === true,
      formats: formatSettings(),
      ...(shownContext ? { overview: shownContext.overview } : {}),
      ...(notice ? { notice } : {}),
      ...(openingFolder ? { loading: { name: openingFolder.name } } : {}),
      busy: Boolean(repositoryJob || folderJobs.size),
      hasRepository: Boolean(preview || folderPreview)
    });
    syncStepHighlight();
  };

  /** Opens a repository file in the editor; the preview follows it. */
  const openRepositoryFile = async (root: string, path: string): Promise<void> => {
    const absolute = resolve(root, path);
    if (!isWithin(root, absolute)) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    const column = lastTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    await vscode.window.showTextDocument(document, { viewColumn: column, preview: true });
    // The editor may already have been active, which changes nothing; show the file anyway.
    await previewDocument(document);
  };

  /** `project › folder › … › file`: every step but the last opens that folder. */
  const crumbsFor = (root: string, path: string, isFile: boolean, target: (open: () => Promise<void>) => string): Crumb[] => {
    const segments = path ? path.split("/") : [];
    const crumbs: Crumb[] = [{ name: basename(root), target: target(() => showFolder(root, "")) }];
    segments.forEach((segment, index) => {
      const folderPath = segments.slice(0, index + 1).join("/");
      crumbs.push(isFile && index === segments.length - 1
        ? { name: segment }
        : { name: segment, target: target(() => showFolder(root, folderPath)) });
    });
    return crumbs;
  };

  /** What the project map shows on a folder page: what it says about the folder, its map, and its members. */
  const mapOnPage = (shown: FolderPreview, target: (open: () => Promise<void>) => string): Pick<FolderView, "about" | "map" | "members" | "mapState"> => {
    const saved = shown.map;
    if (!saved) return { mapState: "missing" };
    const part = shown.path ? mapPartAt(saved.map, shown.path) : undefined;
    const about = shown.path
      ? part && { summary: part.summary, ...(part.detail ? { detail: part.detail } : {}), ...(part.offers ? { offers: part.offers } : {}), ...(part.uses ? { uses: part.uses } : {}) }
      : saved.map.summary ? { summary: saved.map.summary } : undefined;
    const view = mapView(saved.map, shown.path);
    const open = (path: string) => target(() => showFolder(shown.root, path));
    const members = shown.level === "project" || shown.level === "group" ? mapMembers(saved.map, shown.path) : [];
    return {
      mapState: saved.current ? "current" : "other",
      ...(about ? { about } : {}),
      ...(view
        ? {
            map: {
              nodes: view.nodes.map((node) => ({
                id: node.id,
                name: node.name,
                summary: node.summary,
                place: node.place,
                ...(node.group ? { group: node.group } : {}),
                ...(node.path !== undefined ? { target: open(node.path) } : {})
              })),
              edges: view.edges
            }
          }
        : {}),
      ...(members.length
        ? { members: members.map((member) => ({ name: member.name, summary: member.summary, level: member.level, ...(member.path !== undefined ? { target: open(member.path) } : {}) })) }
        : {})
    };
  };

  const folderView = (shown: FolderPreview, target: (open: () => Promise<void>) => string): FolderView => {
    const parts = new Map((shown.ai?.value.parts ?? []).map((part) => [part.name, part.summary]));
    // The project and its groups are described by the map, so they are not summarized on their own.
    const describedByMap = (shown.level === "project" || shown.level === "group") && Boolean(shown.map);
    return {
    name: shown.path ? basename(shown.path) : basename(shown.root),
    path: shown.path,
    level: shown.level,
    ...mapOnPage(shown, target),
    ...(repositoryJob && repositoryJobRoot === shown.root && shown.level === "project"
      ? { mapping: `Mapping the project with ${describeOverviewProvider().modelId || describeOverviewProvider().kind}…` }
      : {}),
    fileCount: shown.children.reduce((total, child) => total + (child.kind === "folder" ? child.fileCount ?? 0 : 1), 0),
    children: shown.children.map((child) => {
      const summary = shown.summaries.get(child.path);
      return {
        ...child,
        target: target(() => child.kind === "folder" ? showFolder(shown.root, child.path) : openRepositoryFile(shown.root, child.path)),
        ...(summary ? { summary: { text: summary.summary, current: summary.current } } : {}),
        ...(!summary && parts.has(child.name) ? { partSummary: parts.get(child.name)! } : {})
      };
    }),
    ...(shown.structure ? { structure: { nodes: shown.structure.nodes, edges: shown.structure.edges } } : {}),
    limitations: [...shown.limitations, ...(shown.structure?.limitations ?? [])],
    ...(shown.ai && !describedByMap
      ? {
          ai: {
            summary: shown.ai.value.summary,
            overview: shown.ai.value.overview,
            ...(shown.ai.value.offers ? { offers: shown.ai.value.offers } : {}),
            ...(shown.ai.value.uses ? { uses: shown.ai.value.uses } : {}),
            current: shown.ai.current
          }
        }
      : {}),
    summarizing: folderJobs.has(folderJobKey("summary", shown.root, shown.path)),
    canSummarize: Boolean(shown.input) && !inTreeJob(shown.root, shown.path) && !describedByMap && shown.level !== "project",
    ...(shown.summaryError ? { summaryError: shown.summaryError } : {}),
    ...(shown.flows
      ? {
          flows: {
            current: shown.flows.current,
            items: shown.flows.flows.map((flow) => ({
              title: flow.title,
              summary: flow.summary,
              chart: flow.chart,
              links: flow.refs.map((ref) => ref
                ? { target: target(() => openReference(shown.root, ref)), caption: referenceCaption(ref) }
                : null)
            }))
          }
        }
      : {}),
    describingFlows: folderJobs.has(folderJobKey("flows", shown.root, shown.path)),
    canDescribeFlows: hasFlowsInput(shown.flowsInput) && !inTreeJob(shown.root, shown.path),
    canSummarizeTree: Boolean(shown.input) && !treeJob && !planningTree && folderJobs.size === 0 && !repositoryJob
      && shown.children.some((child) => child.kind === "folder"),
    ...(treeJob && inTreeJob(shown.root, shown.path)
      ? {
          tree: {
            name: treeJob.path ? basename(treeJob.path) : basename(treeJob.root),
            done: treeJob.done,
            total: treeJob.total,
            running: [...treeJob.running].map((folder) => treeJob!.path && folder.startsWith(`${treeJob!.path}/`)
              ? folder.slice(treeJob!.path.length + 1)
              : folder || basename(treeJob!.root))
          }
        }
      : {}),
    ...(shown.flowsError ? { flowsError: shown.flowsError } : {})
    };
  };

  const referenceCaption = (ref: FlowReference): string =>
    ref.folder ? `${basename(ref.path)}/` : ref.function ? `${basename(ref.path)} › ${ref.function}` : basename(ref.path);

  /** Opens the file a flow step points to, at its function when one is named; the preview follows. */
  const openReference = async (root: string, ref: FlowReference): Promise<void> => {
    const absolute = resolve(root, ref.path);
    if (!isWithin(root, absolute)) return;
    // Steps of flows between map parts open the part's folder.
    if (ref.folder) return showFolder(root, ref.path);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    let line = 0;
    const language = ref.function ? bundledLanguageFor({ languageId: document.languageId, path: document.uri.path }) : undefined;
    if (ref.function && language?.listFunctions) {
      await initializeLanguage(language, context.extensionPath).catch(() => undefined);
      const found = (await language.listFunctions(document.getText(), ref.path).catch(() => []))
        .find((entry) => entry.qualifiedName === ref.function);
      if (found) line = found.startLine;
    }
    const position = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(document, {
      viewColumn: lastTextEditor?.viewColumn ?? vscode.ViewColumn.One,
      selection: new vscode.Range(position, position)
    });
    await previewDocument(document);
  };

  /** A file's text for a request to a model: only for files that pass the per-file sharing check. */
  const shareableText = async (root: string, path: string): Promise<string | undefined> =>
    (await sharingExclusion(root, resolve(root, path)).catch(() => "unreadable")) ? undefined : repositoryText(root, path).catch(() => undefined);

  /** Reads a repository file's current text, preferring an open buffer; small files only. */
  const repositoryText = async (root: string, path: string): Promise<string | undefined> => {
    const absolute = resolve(root, path);
    if (!isWithin(root, absolute)) return undefined;
    const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && resolve(document.uri.fsPath) === absolute);
    if (open) return open.getText();
    if ((await stat(absolute)).size > 256 * 1024) return undefined;
    return readFile(absolute, "utf8");
  };

  /**
   * Previews a folder (or, with "", the repository root): its subfolders and
   * files with their saved summaries, and the import structure between them,
   * which is filled in when found. Local only; nothing is generated.
   */
  const showFolder = async (root: string, path: string): Promise<void> => {
    ensurePanel();
    const epoch = ++folderEpoch;
    previewEpoch++;
    // Listing a large repository takes a while; until then, the page shows a placeholder instead of looking unchanged.
    const opening = path ? basename(path) : basename(root);
    openingFolder = { epoch, name: opening };
    if (notice?.tone !== "progress") notice = undefined;
    render();
    let listing: Awaited<ReturnType<typeof listFolder>>;
    try {
      listing = await listFolder(root, path);
    } catch (error) {
      if (epoch === folderEpoch && panel) {
        openingFolder = undefined;
        notice = { tone: "info", text: errorMessage(error) };
        render();
      }
      return;
    }
    const { children, limitations } = listing;
    const files = children.filter((child) => child.kind === "file").map((child) => child.path);
    const summaries = await service.findFileSummaries(root, files, (file) => repositoryText(root, file)).catch(() => new Map());
    const savedMap = await service.savedProjectMap(root).catch(() => undefined);
    if (epoch !== folderEpoch || !panel) return;
    openingFolder = undefined;
    stopPrefetch();
    clearReveal();
    preview = undefined;
    notice = undefined;
    folderPreview = {
      root,
      path,
      children,
      summaries,
      limitations,
      level: folderLevel(savedMap?.map, path),
      ...(savedMap ? { map: savedMap } : {})
    };
    // The project page maps the project when it has no current map.
    if (!path && !savedMap?.current) void mapProjectAutomatically(root);
    panel.panel.title = `Downside Up: ${path ? basename(path) : basename(root)}`;
    // The project preview shows the saved repository overview near the top.
    if (!path && repositoryContext?.root !== root) {
      const overview = await service.savedOverview(root).catch(() => undefined);
      if (overview && epoch === folderEpoch) repositoryContext = { root, overview };
    }
    panel.setFileReferenceHandlers(new Map());
    render();
    const structure = await folderStructure(root, path, children).catch(() => undefined);
    const current = () => epoch === folderEpoch && folderPreview?.path === path && folderPreview.root === root;
    if (!current() || !structure) return;
    folderPreview = { ...folderPreview!, structure };
    render();
    const { subfolderSummaries, input } = await summaryInputFor(root, path, children, summaries, structure);
    if (!current() || !input) return;
    const saved = await service.findFolderSummary(root, input).catch(() => undefined);
    if (!current()) return;
    folderPreview = {
      ...folderPreview!,
      summaries: new Map([...folderPreview!.summaries, ...subfolderSummaries]),
      input,
      ...(saved ? { ai: saved } : {})
    };
    render();
    await loadFlowsInput(root, path, epoch);
  };

  /**
   * What a folder summary would be made from: its parts with their saved
   * summaries (subfolders' summaries count like files'), its imports, and
   * its README. Local only.
   */
  const summaryInputFor = async (
    root: string,
    path: string,
    children: readonly FolderChild[],
    summaries: ReadonlyMap<string, { summary: string }>,
    structure: StructureGraph | undefined
  ): Promise<{ subfolderSummaries: Map<string, { summary: string; current: boolean }>; input?: FolderSummaryPromptInput }> => {
    const subfolderSummaries = new Map<string, { summary: string; current: boolean }>();
    const saved = await service.savedProjectMap(root).catch(() => undefined);
    for (const child of children.filter((entry) => entry.kind === "folder")) {
      const summary = await service.savedFolderSummary(root, child.path).catch(() => undefined);
      // A subfolder without a summary of its own uses the project map's sentence about it.
      const fromMap = saved ? mapPartAt(saved.map, child.path)?.summary : undefined;
      if (summary || fromMap) subfolderSummaries.set(child.path, { summary: (summary ?? fromMap)!, current: Boolean(summary) || saved!.current });
    }
    const input = await folderSummaryInput(basename(root), path, children, structure, {
      fileSummary: (file) => summaries.get(file)?.summary,
      folderSummary: async (folder) => subfolderSummaries.get(folder)?.summary,
      text: (file) => shareableText(root, file),
      contents: async (folder) => (await listFolder(root, folder)).children.map((entry) => entry.name + (entry.kind === "folder" ? "/" : ""))
    }).catch(() => undefined);
    if (!input) return { subfolderSummaries };
    const level = folderLevel(saved?.map, path);
    const mapSummary = saved ? (path ? mapPartAt(saved.map, path)?.summary : saved.map.summary) : undefined;
    const contracts = level === "component" ? await contractsIn(root, path) : [];
    return {
      subfolderSummaries,
      input: {
        ...input,
        ...(saved ? { level } : {}),
        ...(mapSummary ? { mapSummary } : {}),
        ...(contracts.length ? { contracts } : {})
      }
    };
  };

  const MAX_CONTRACT_BYTES = 6 * 1024;
  const MAX_CONTRACTS_BYTES = 16 * 1024;

  /** A component's API contracts for its summary, bounded, and only from files that may be shared. */
  const contractsIn = async (root: string, path: string): Promise<Array<{ path: string; text: string }>> => {
    const { files } = await listEligibleFiles(root, path).catch(() => ({ files: [] as string[] }));
    const contracts: Array<{ path: string; text: string }> = [];
    let total = 0;
    for (const file of files.filter(isContractFile).sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
      const text = await shareableText(root, file);
      if (!text) continue;
      const bounded = Buffer.byteLength(text, "utf8") > MAX_CONTRACT_BYTES
        ? `${Buffer.from(text, "utf8").subarray(0, MAX_CONTRACT_BYTES).toString("utf8").replace(/\uFFFD+$/, "")}\n[… cut]`
        : text;
      if (total + Buffer.byteLength(bounded, "utf8") > MAX_CONTRACTS_BYTES) break;
      contracts.push({ path: file, text: bounded });
      total += Buffer.byteLength(bounded, "utf8");
    }
    return contracts;
  };

  /** Lists a folder that is not shown and builds its summary input, for runs over many folders. */
  const prepareFolderSummary = async (root: string, path: string): Promise<{ input: FolderSummaryPromptInput; structure?: StructureGraph } | undefined> => {
    const { children } = await listFolder(root, path);
    const files = children.filter((child) => child.kind === "file").map((child) => child.path);
    const summaries = await service.findFileSummaries(root, files, (file) => repositoryText(root, file)).catch(() => new Map<string, { summary: string; current: boolean }>());
    const structure = await folderStructure(root, path, children).catch(() => undefined);
    const { input } = await summaryInputFor(root, path, children, summaries, structure);
    return input ? { input, ...(structure ? { structure } : {}) } : undefined;
  };

  /** What main flows under a folder would be made from; local only. */
  const flowsInputFor = async (
    root: string,
    path: string,
    structure: StructureGraph | undefined,
    folderSummary: string | undefined
  ): Promise<ProjectFlowsPromptInput | undefined> => {
    const [{ files }, fileSummaries, overview] = await Promise.all([
      listEligibleFiles(root, path),
      service.savedFileSummaries(root).catch(() => new Map<string, string>()),
      service.overviewBackground(root).catch(() => undefined)
    ]);
    for (const language of new Set(files.map((file) => bundledLanguageFor({ path: file })).filter((entry) => entry !== undefined))) {
      await initializeLanguage(language!, context.extensionPath).catch(() => undefined);
    }
    return projectFlowsInput(basename(root), path, files, structure, {
      ...(overview ? { overview } : {}),
      ...(folderSummary ? { folderSummary } : {})
    }, {
      fileSummaries,
      text: (file) => shareableText(root, file)
    }).catch(() => undefined);
  };

  /**
   * What a folder's main flows would be made from, at its zoom level: the
   * project, groups, and components get flows between the connected parts
   * on their map; modules, plain folders, and a mapped project without
   * separate parts (a single library, say) get flows through files and
   * functions; support folders, and the project before it is mapped, get
   * none. Local only.
   */
  const flowsRequestFor = async (
    root: string,
    path: string,
    structure: StructureGraph | undefined,
    folderSummary: string | undefined
  ): Promise<FlowsRequest | undefined> => {
    const saved = await service.savedProjectMap(root).catch(() => undefined);
    const level = folderLevel(saved?.map, path);
    if (level === "support") return undefined;
    if (level === "project" && !saved) return undefined;
    const view = saved && (level === "project" || level === "group" || level === "component") ? mapView(saved.map, path) : undefined;
    if (view && view.edges.length === 0) return undefined;
    if (saved && view) {
      const summary = path ? mapPartAt(saved.map, path)?.summary : saved.map.summary;
      return {
        kind: "parts",
        input: {
          repositoryName: basename(root),
          path,
          level,
          ...(summary ? { summary } : {}),
          parts: view.nodes.map((node) => ({ id: node.id, name: node.name, summary: node.summary, place: node.place })),
          links: view.edges
        },
        paths: new Map(view.nodes.flatMap((node) => (node.path ? [[node.id, node.path] as const] : [])))
      };
    }
    const input = await flowsInputFor(root, path, structure, folderSummary);
    return input ? { kind: "files", input } : undefined;
  };

  /** Whether a flows request has anything to describe. */
  const hasFlowsInput = (request: FlowsRequest | undefined): boolean =>
    Boolean(request && (request.kind === "parts" || request.input.catalog.length));

  const flowsPromptText = (request: FlowsRequest): string =>
    (request.kind === "parts" ? partFlowsPrompt(request.input) : projectFlowsPrompt(request.input)).join("\n");

  /** Builds what main flows would be made from, and looks up saved ones; local only. */
  const loadFlowsInput = async (root: string, path: string, epoch: number): Promise<void> => {
    const current = () => epoch === folderEpoch && folderPreview?.path === path && folderPreview.root === root;
    if (!current()) return;
    const flowsInput = await flowsRequestFor(root, path, folderPreview!.structure, folderPreview!.ai?.value.summary);
    if (!current() || !flowsInput) return;
    const flows = await service.findProjectFlows(root, flowsInput).catch(() => undefined);
    if (!current()) return;
    const { flows: _previous, ...rest } = folderPreview!;
    folderPreview = { ...rest, flowsInput, ...(flows ? { flows } : {}) };
    render();
  };

  /** Describes the shown folder's main flows on explicit request; it may ask for code-sharing approval. */
  const describeShownFlows = async (): Promise<void> => {
    const shown = folderPreview;
    if (!shown?.flowsInput || inTreeJob(shown.root, shown.path)) return;
    if (!(await ensureLanguageModelSelected())) return;
    const key = folderJobKey("flows", shown.root, shown.path);
    if (folderJobs.has(key)) return;
    const controller = new AbortController();
    folderJobs.set(key, controller);
    const same = () => folderPreview?.root === shown.root && folderPreview.path === shown.path && folderJobKey("flows", shown.root, shown.path) === key;
    if (same()) folderPreview = { ...folderPreview!, flowsError: undefined };
    render();
    try {
      const result = await scheduler.schedule("explicit", () => service.describeProjectFlows(shown.root, shown.flowsInput!, controller.signal));
      if (same()) folderPreview = { ...folderPreview!, flows: { flows: result.flows, current: true } };
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      if (same() && !cancelled) folderPreview = { ...folderPreview!, flowsError: `Could not describe the main flows: ${errorMessage(error)}` };
    } finally {
      if (folderJobs.get(key) === controller) folderJobs.delete(key);
    }
    render();
  };

  /** Generates the shown folder's summary on explicit request; it may ask for code-sharing approval. */
  const summarizeShownFolder = async (): Promise<void> => {
    const shown = folderPreview;
    if (!shown?.input || inTreeJob(shown.root, shown.path)) return;
    if (!(await ensureLanguageModelSelected())) return;
    const key = folderJobKey("summary", shown.root, shown.path);
    if (folderJobs.has(key)) return;
    const controller = new AbortController();
    folderJobs.set(key, controller);
    // A result applies only to the same folder, still shown, with the same overview model.
    const same = () => folderPreview?.root === shown.root && folderPreview.path === shown.path && folderJobKey("summary", shown.root, shown.path) === key;
    if (same()) folderPreview = { ...folderPreview!, summaryError: undefined };
    render();
    try {
      const result = await scheduler.schedule("explicit", () => service.summarizeFolder(shown.root, shown.input!, controller.signal));
      if (same()) folderPreview = { ...folderPreview!, ai: { value: result.value, current: true } };
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      if (same() && !cancelled) folderPreview = { ...folderPreview!, summaryError: `Could not summarize this folder: ${errorMessage(error)}` };
    } finally {
      if (folderJobs.get(key) === controller) folderJobs.delete(key);
    }
    render();
  };

  const MAX_TREE_FOLDERS = 400;
  const MAX_TREE_REQUESTS = 100;

  /**
   * Summarizes the shown folder and every subfolder below it that has no
   * current summary, deepest first so each folder's request holds its
   * subfolders' new summaries, then describes the folder's main flows. The
   * whole tree is checked locally first, and nothing is sent until the reader
   * accepts the number of requests and the estimated size. Each request may
   * ask for code-sharing approval like a single folder summary.
   */
  const summarizeShownTree = async (confirm = true): Promise<void> => {
    const shown = folderPreview;
    if (!shown?.input || treeJob || planningTree || preview) return;
    // Marked before the first wait, so a second click while checking starts nothing.
    planningTree = true;
    render();
    let plan: FolderTreePlan | undefined;
    try {
      plan = await planFolderTree(shown.root, shown.path, confirm);
    } finally {
      planningTree = false;
      render();
    }
    if (plan) await runFolderTree(plan);
  };

  /** The shown folder's name in notices about a tree run. */
  const treeName = (root: string, path: string): string => path || basename(root);

  /** Notices about a tree run, shown only while the reader looks at a folder in the tree. */
  const treeNotice = (root: string, folders: ReadonlySet<string> | undefined, path: string, next: PanelNotice | undefined): void => {
    if (preview || folderPreview?.root !== root || !(folders ? folders.has(folderPreview.path) : folderPreview.path === path)) return;
    notice = next;
    render();
  };

  /** Checks the tree locally and asks before anything is sent; undefined when there is nothing to do. */
  const planFolderTree = async (root: string, path: string, confirm: boolean): Promise<FolderTreePlan | undefined> => {
    if (!(await ensureLanguageModelSelected())) return undefined;
    const name = treeName(root, path);
    const say = (next: PanelNotice | undefined) => treeNotice(root, undefined, path, next);
    const busyMessage = `Wait for the folder requests in progress to finish, or cancel them, before summarizing ${name} with its subfolders.`;
    if (folderJobs.size) {
      say({ tone: "info", text: busyMessage });
      return undefined;
    }
    const model = describeOverviewProvider();
    say({ tone: "progress", text: `Checking which folders under ${name} need a summary…` });
    const tree = await collectFolderTree(
      path,
      async (folder) => (await listFolder(root, folder)).children.filter((child) => child.kind === "folder").map((child) => child.path),
      MAX_TREE_FOLDERS
    ).catch(() => undefined);
    if (!tree) {
      say({ tone: "info", text: `${name} has more than ${MAX_TREE_FOLDERS} folders, or one could not be listed. Summarize smaller folders first.` });
      return undefined;
    }
    const prepared = new Map<string, { input: FolderSummaryPromptInput; structure?: StructureGraph }>();
    const current = new Set<string>();
    for (const folder of tree.folders) {
      const ready = await prepareFolderSummary(root, folder).catch(() => undefined);
      if (!ready) continue;
      prepared.set(folder, ready);
      if ((await service.findFolderSummary(root, ready.input).catch(() => undefined))?.current) current.add(folder);
    }
    // Once mapped, the project and its groups are described by the map, so they are not summarized.
    const mapped = await service.savedProjectMap(root).catch(() => undefined);
    const describedByMap = (folder: string) => {
      const level = mapped ? folderLevel(mapped.map, folder) : undefined;
      return level === "project" || level === "group";
    };
    const todo = new Set([...foldersToSummarize(tree, current)].filter((folder) => prepared.has(folder) && !describedByMap(folder)));
    const flowsInput = await flowsRequestFor(root, path, prepared.get(path)?.structure, undefined);
    const flowsNeeded = hasFlowsInput(flowsInput)
      && !(await service.findProjectFlows(root, flowsInput!).catch(() => undefined))?.current;
    const byMap = tree.folders.filter(describedByMap).length;
    if (todo.size === 0 && !flowsNeeded) {
      say({ tone: "info", text: `Every folder under ${name} (${tree.folders.length}) has a current summary${byMap ? " or is described by the project map" : ""}${hasFlowsInput(flowsInput) ? ", and its main flows are current" : ""}.` });
      return undefined;
    }
    if (todo.size > MAX_TREE_REQUESTS) {
      say({ tone: "info", text: `${plural(todo.size, "folder")} under ${name} need a summary, more than ${MAX_TREE_REQUESTS} in one run. Summarize smaller folders first.` });
      return undefined;
    }
    const requests = todo.size + (flowsNeeded ? 1 : 0);
    if (confirm) {
      const bytes = [...todo].reduce((total, folder) => total + Buffer.byteLength(folderSummaryPrompt(prepared.get(folder)!.input).join("\n"), "utf8"), 0)
        + (flowsNeeded ? Buffer.byteLength(flowsPromptText(flowsInput!), "utf8") : 0);
      const skipped = tree.folders.length - todo.size - byMap;
      const accept = `Send ${plural(requests, "request")}`;
      const answer = await vscode.window.showInformationMessage(
        `Summarize ${plural(todo.size, "folder")} under ${name}, deepest first${flowsNeeded ? ", then describe its main flows" : ""}?`,
        {
          modal: true,
          detail: [
            `${plural(requests, "request")} to ${model.modelId || model.kind}, about ${Math.ceil(bytes / 4).toLocaleString()} input tokens in all (byte-based estimate), plus the answers.`,
            skipped ? `${plural(skipped, "folder")} already ${skipped === 1 ? "has" : "have"} a current summary and ${skipped === 1 ? "is" : "are"} skipped.` : "",
            byMap ? `${plural(byMap, "folder")} (the project or a group) ${byMap === 1 ? "is" : "are"} described by the project map and ${byMap === 1 ? "is" : "are"} skipped.` : "",
            "Requests hold names, saved summaries, function names, imports, READMEs, and, for components, their API contracts; no other source code."
          ].filter(Boolean).join("\n\n")
        },
        accept
      );
      if (answer !== accept) {
        say(undefined);
        return undefined;
      }
    }
    const now = describeOverviewProvider();
    if (now.kind !== model.kind || now.modelId !== model.modelId) {
      say({ tone: "info", text: `The overview model changed while checking ${name}; nothing was sent.` });
      return undefined;
    }
    if (folderJobs.size) {
      say({ tone: "info", text: busyMessage });
      return undefined;
    }
    say(undefined);
    return { root, path, tree, todo, flowsNeeded, model };
  };

  /** Sends a planned tree run's requests, deepest folders first, then the flows. */
  const runFolderTree = async (plan: FolderTreePlan): Promise<void> => {
    const { root, path, tree, todo, flowsNeeded, model } = plan;
    if (treeJob) return;
    const controller = new AbortController();
    const job: FolderTreeJob = {
      root,
      path,
      folders: new Set(tree.folders),
      controller,
      total: todo.size + (flowsNeeded ? 1 : 0),
      done: 0,
      running: new Set(),
      failed: [],
      usages: []
    };
    treeJob = job;
    const treeKey = folderJobKey("tree", root, path);
    folderJobs.set(treeKey, controller);
    render();
    let modelChanged = false;
    /** Stops the run when the overview model changes, so nothing goes to a model the reader did not accept. */
    const checkModel = () => {
      const now = describeOverviewProvider();
      if (now.kind === model.kind && now.modelId === model.modelId) return;
      modelChanged = true;
      controller.abort();
    };
    const cancelled = (error: unknown) => controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
    /** Runs one request of the run, shown as running for `folder` and cancellable with the rest. */
    const step = async (kind: "summary" | "flows", folder: string, request: () => Promise<{ usage: Usage }>): Promise<void> => {
      checkModel();
      const key = folderJobKey(kind, root, folder);
      // Never replace another request's entry, which would make it impossible to cancel.
      if (controller.signal.aborted || folderJobs.has(key)) {
        if (!controller.signal.aborted) job.failed.push(`${folder || basename(root)} (another request for it was running)`);
        job.done++;
        return;
      }
      folderJobs.set(key, controller);
      job.running.add(folder);
      render();
      try {
        const result = await scheduler.schedule("explicit", () => {
          checkModel();
          if (controller.signal.aborted) throw new DOMException("The request was cancelled.", "AbortError");
          return request();
        });
        job.usages.push(result.usage);
      } catch (error) {
        // A declined code-sharing prompt stops the whole run.
        if (cancelled(error)) controller.abort();
        else job.failed.push(`${folder || basename(root)} (${errorMessage(error)})`);
      } finally {
        if (folderJobs.get(key) === controller) folderJobs.delete(key);
        job.running.delete(folder);
        job.done++;
        render();
      }
    };
    try {
      for (const level of tree.levels) {
        // Folders of one level only need the levels below, so they run side by side.
        await Promise.all(level.filter((folder) => todo.has(folder)).map((folder) => step("summary", folder, async () => {
          const ready = await prepareFolderSummary(root, folder);
          if (!ready) throw new Error("the folder could not be read");
          return service.summarizeFolder(root, ready.input, controller.signal);
        })));
        if (controller.signal.aborted) break;
        if (level.some((folder) => todo.has(folder))) await refreshShownFolder(root, job.folders);
      }
      if (flowsNeeded && !controller.signal.aborted) {
        await step("flows", path, async () => {
          const structure = (await prepareFolderSummary(root, path).catch(() => undefined))?.structure;
          const input = await flowsRequestFor(root, path, structure, await service.savedFolderSummary(root, path).catch(() => undefined));
          if (!hasFlowsInput(input)) throw new Error("no parts, or files with summaries or function names, were found");
          return service.describeProjectFlows(root, input!, controller.signal);
        });
      }
    } finally {
      if (folderJobs.get(treeKey) === controller) folderJobs.delete(treeKey);
      if (treeJob === job) treeJob = undefined;
    }
    await refreshShownFolder(root, job.folders);
    const usage = job.usages.length
      ? formatUsage({
          inputTokens: job.usages.reduce((total, item) => total + item.inputTokens, 0),
          outputTokens: job.usages.reduce((total, item) => total + item.outputTokens, 0),
          estimated: job.usages.some((item) => item.estimated)
        })
      : "";
    const name = treeName(root, path);
    const finished = job.usages.length;
    const text = modelChanged
      ? `Summarizing ${name} with its subfolders stopped because the overview model changed, after ${plural(finished, "finished request")}; finished summaries are saved.`
      : controller.signal.aborted
        ? `Summarizing ${name} with its subfolders was cancelled after ${plural(finished, "finished request")}; finished summaries are saved.`
        : `Summarized ${name} with its subfolders: ${plural(finished, "request")} succeeded${job.failed.length ? `, ${job.failed.length} failed: ${job.failed.slice(0, 3).join("; ")}${job.failed.length > 3 ? "; …" : ""}` : ""}.`;
    treeNotice(root, job.folders, path, {
      tone: job.failed.length && !controller.signal.aborted ? "error" : "info",
      text: usage ? `${text} ${usage}` : text
    });
    render();
  };

  /**
   * Shows newly saved summaries and flows in the shown folder, when it is in
   * `folders`, without new preview epochs, so a navigation that is still
   * loading is never undone. Local only.
   */
  const refreshShownFolder = async (root: string, folders: ReadonlySet<string>): Promise<void> => {
    const shown = folderPreview;
    if (preview || !shown || shown.root !== root || !folders.has(shown.path)) return;
    const epoch = folderEpoch;
    const shownEpoch = previewEpoch;
    const current = () => epoch === folderEpoch && shownEpoch === previewEpoch && !preview
      && folderPreview?.root === root && folderPreview.path === shown.path;
    const { subfolderSummaries, input } = await summaryInputFor(root, shown.path, shown.children, shown.summaries, shown.structure);
    if (!current() || !input) return;
    const saved = await service.findFolderSummary(root, input).catch(() => undefined);
    if (!current()) return;
    const { ai: _previous, ...rest } = folderPreview!;
    folderPreview = {
      ...rest,
      summaries: new Map([...rest.summaries, ...subfolderSummaries]),
      input,
      ...(saved ? { ai: saved } : {})
    };
    render();
    await loadFlowsInput(root, shown.path, epoch);
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
    // Opening a file leaves the folder preview, or the folder being opened.
    folderPreview = undefined;
    folderEpoch++;
    openingFolder = undefined;
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
  function wakeSession(session: Wakeable): void {
    if (session.wake) session.wake();
    else session.woken = true;
  }

  const wakePrefetch = (): void => {
    if (prefetchSession) wakeSession(prefetchSession);
    if (reviewSession) wakeSession(reviewSession);
  };

  const waitForWake = (session: Wakeable): Promise<void> => {
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
    const consentId = await consentModelId(descriptor);
    return consentId !== undefined && hasConsent(await cacheStore.read(root), descriptor.kind, consentId);
  };

  /**
   * Shows the saved explanation of a hovered call to a function, found the
   * same way as explanation context (bundled analysis or the editor's
   * go-to-definition). It reads only the local cache and never generates;
   * generated text is escaped so it renders as plain text.
   */
  const hoverProvider: vscode.HoverProvider = {
    provideHover: async (document, position, token) => {
      if (document.uri.scheme !== "file") return undefined;
      if (!vscode.workspace.getConfiguration("downsideUp").get<boolean>("hover.savedExplanations", true)) return undefined;
      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (!wordRange) return undefined;
      const word = document.getText(wordRange);
      // Editor-tooling languages only resolve call sites; skip other words before any lookup.
      const after = document.lineAt(wordRange.end.line).text.slice(wordRange.end.character);
      if (
        !bundledLanguageFor({ languageId: document.languageId, path: document.uri.path }) &&
        !/^\s*(?:<[^<>()]*>\s*)?\(/.test(after)
      ) return undefined;
      const root = await resolveRoot(document).catch(() => undefined);
      if (!root || token.isCancellationRequested) return undefined;
      const enclosing = await findFunctionTarget(document, position).catch(() => undefined);
      // Only calls inside a function body; hovering a function's own name is left to other hovers.
      if (!enclosing || enclosing.selection.contains(position) || token.isCancellationRequested) return undefined;
      const called = await recentInventory(root)
        .then((inventory) => findCalledFunctions(enclosing, document, inventory, word))
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

  const MAX_REVIEW_FAILURES = 3;
  const reviewStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  reviewStatus.command = "downsideUp.showChangedFunctions";

  /** Shows review progress in the status bar; clicking it lists the changed functions. */
  const updateReviewStatus = (): void => {
    const session = reviewSession;
    void vscode.commands.executeCommand("setContext", "downsideUp.hasReview", Boolean(session));
    if (!session) {
      reviewStatus.hide();
      return;
    }
    const count = (status: ReviewItem["status"]) => session.items.filter((item) => item.status === status).length;
    const finished = count("done") + count("failed") + count("skipped");
    const total = session.items.length;
    const failed = count("failed") ? `, ${count("failed")} failed` : "";
    reviewStatus.text = session.stopped
      ? `$(circle-slash) Downside Up: ${count("done")} of ${total} changed functions explained${failed}`
      : finished === total
        ? `$(check) Downside Up: ${count("done")} of ${total} changed functions explained${failed}`
        : `$(sync~spin) Downside Up: explaining changed functions, ${finished} of ${total}`;
    reviewStatus.tooltip = `Changed functions ${session.base}. Click to go to one${session.stopped || finished === total ? "" : " or stop"}.`;
    reviewStatus.show();
  };

  /** Stops review prefetching; a request already sent finishes and is saved. */
  const stopReview = (): void => {
    if (!reviewSession) return;
    reviewSession.stopped = true;
    wakeSession(reviewSession);
    for (const item of reviewSession.items) if (item.status === "explaining" || item.status === "pending") item.status = "pending";
    updateReviewStatus();
  };

  const dismissReview = (): void => {
    stopReview();
    reviewSession = undefined;
    updateReviewStatus();
  };

  /** The reader's file and position, when the shown file is in the review's repository. */
  const readingPosition = (root: string): { path: string; focusLine: number } | undefined => {
    if (!preview || preview.root !== root) return undefined;
    const editor = vscode.window.visibleTextEditors.find((candidate) => sameUri(candidate.document.uri, preview!.document.uri));
    const visible = editor?.visibleRanges[0];
    return {
      path: filePath(root, preview.document.uri),
      focusLine: prefetchFocusLine(
        editor?.selection.active.line ?? lastEditorTopLine ?? 0,
        visible ? { start: visible.start.line, end: visible.end.line } : undefined
      )
    };
  };

  /** Finds a changed function in its file as it is now. */
  const reviewTarget = async (root: string, item: ReviewItem): Promise<SelectedFunction | undefined> => {
    const document = await vscode.workspace.openTextDocument(item.uri);
    const line = Math.min(item.nameLine, document.lineCount - 1);
    const target = await findFunctionTarget(document, new vscode.Position(line, item.nameStart));
    return target && target.qualifiedName === item.qualifiedName ? { root, target, document } : undefined;
  };

  /**
   * Explains the changed functions in the background with the request slots
   * explicit requests leave free: in the file being read, nearest the reader
   * first, then in diff order. Explanations already current are kept. A
   * failed function is retried once after a pause; after several failures
   * review mode stops with a notice.
   */
  const runReview = async (session: ReviewSession): Promise<void> => {
    const active = () => !session.stopped && reviewSession === session;
    while (active()) {
      if (scheduler.prefetchCapacity === 0) {
        await waitForWake(session);
        continue;
      }
      const item = nextReview(session.items.filter((candidate) => candidate.status === "pending"), readingPosition(session.root));
      if (!item) {
        if (session.items.some((candidate) => candidate.status === "explaining")) {
          await waitForWake(session);
          continue;
        }
        updateReviewStatus();
        return;
      }
      if (!(await prefetchAllowed(session.root))) {
        if (!active()) return;
        notice = { tone: "info", text: "Explaining changed functions stopped: code sharing is not approved for this repository and model, or the workspace is not trusted." };
        render();
        stopReview();
        return;
      }
      item.status = "explaining";
      updateReviewStatus();
      const value = await reviewTarget(session.root, item).catch(() => undefined);
      if (!active()) {
        item.status = "pending";
        return;
      }
      if (!value) {
        item.status = "skipped";
        updateReviewStatus();
        continue;
      }
      const state = stateFor(value);
      if (state.controller || (state.view.status === "current" && state.view.explanation)) {
        // Already explained, or being explained by an explicit request.
        item.status = "done";
        updateReviewStatus();
        continue;
      }
      if (state.view.status === "failed" || state.view.status === "cancelled" || state.view.status === "outdated") forget(state);
      const fresh = stateFor(value);
      void generate(fresh, { prefetch: { shouldStart: active } })
        .then(async () => {
          if (fresh.view.status === "current") item.status = "done";
          else if (fresh.view.status === "failed" && active() && !session.retried.has(item)) {
            // Back off briefly, for example after a rate limit, then try this function once more.
            session.retried.add(item);
            await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
            if (fresh.view.status === "failed") forget(fresh);
            item.status = "pending";
          } else if (fresh.view.status === "failed") {
            item.status = "failed";
            if (session.items.filter((candidate) => candidate.status === "failed").length >= MAX_REVIEW_FAILURES && active()) {
              notice = { tone: "error", text: `Explaining changed functions stopped after several errors: ${fresh.view.error ?? "generation failed"}` };
              render();
              stopReview();
            }
          } else {
            // Not started, for example because review mode stopped first.
            item.status = "pending";
          }
          updateReviewStatus();
        })
        .finally(() => wakeSession(session));
    }
  };

  /**
   * Starts review mode for the functions changed since `base`. Running the
   * command is the explicit request; when code sharing is not approved yet,
   * the first function is explained as an ordinary request, which asks.
   */
  const startReview = async (root: string, base: string, baseLabel: string, confirm: boolean): Promise<number> => {
    const changed = await changedLinesSince(root, base);
    const items: ReviewItem[] = [];
    let excluded = 0;
    const paths = [...changed.keys()].sort();
    for (const path of paths.slice(0, MAX_REVIEW_FILES)) {
      const absolute = resolve(root, path);
      if (!isWithin(root, absolute)) continue;
      if (await sharingExclusion(root, absolute).catch(() => "unreadable")) {
        excluded++;
        continue;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute)).then((value) => value, () => undefined);
      if (!document) continue;
      const ranges = changed.get(path)!;
      const overview = await buildFileOverview(document, path).catch(() => undefined);
      for (const entry of overview?.entries ?? []) {
        if (!entry.explainable || !touchesChange(ranges, entry.startLine, entry.endLine)) continue;
        items.push({
          path,
          uri: document.uri,
          name: entry.name,
          qualifiedName: entry.qualifiedName,
          startLine: entry.startLine,
          endLine: entry.endLine,
          nameLine: entry.nameLine,
          nameStart: entry.nameStart,
          status: "pending"
        });
      }
    }
    const files = new Set(items.map((item) => item.path)).size;
    const notes = [
      paths.length > MAX_REVIEW_FILES ? `Only the first ${MAX_REVIEW_FILES} of ${paths.length} changed files are included.` : "",
      excluded ? `${excluded} changed file${excluded === 1 ? " is" : "s are"} excluded from AI explanations and skipped.` : ""
    ].filter(Boolean).join(" ");
    if (items.length === 0) {
      if (confirm) await vscode.window.showInformationMessage(`No changed functions were found ${baseLabel}. ${notes}`.trim());
      return 0;
    }
    if (confirm) {
      const accept = "Explain Changed Functions";
      const answer = await vscode.window.showInformationMessage(
        `Explain ${items.length} changed function${items.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} ${baseLabel} in the background? Functions with a current explanation are skipped; each new explanation is a request to your model provider.`,
        { modal: true, detail: notes || undefined },
        accept
      );
      if (answer !== accept) return 0;
    }
    stopReview();
    const session: ReviewSession = { root, base: baseLabel, items, retried: new Set(), stopped: false, woken: false };
    reviewSession = session;
    updateReviewStatus();
    if (!(await prefetchAllowed(root))) {
      // The first function is an ordinary request, so code sharing is approved the usual way.
      const first = items[0]!;
      const value = await reviewTarget(root, first).catch(() => undefined);
      if (value && reviewSession === session) {
        first.status = "explaining";
        updateReviewStatus();
        const state = stateFor(value);
        await generate(state);
        first.status = state.view.status === "current" ? "done" : "failed";
        updateReviewStatus();
      }
    }
    void runReview(session).catch(() => stopReview());
    return items.length;
  };

  const MAX_REVIEW_FILES = 200;

  /** Asks which changes to review and starts review mode. */
  const reviewChangesCommand = async (): Promise<void> => {
    const root = await rootForCommand() ?? (vscode.workspace.workspaceFolders?.length === 1
      ? await findRepositoryRoot(vscode.workspace.workspaceFolders[0]!.uri.fsPath).catch(() => undefined)
      : undefined);
    if (!root) {
      await vscode.window.showInformationMessage("Open a source file in the repository to review first.");
      return;
    }
    const choices = await baseChoices(root);
    if (choices.length === 0) {
      await vscode.window.showInformationMessage("Review mode needs a Git repository with at least one commit.");
      return;
    }
    const pickCommit = { label: "$(git-commit) Changes since a commit…", description: "choose from recent commits", phrase: "", commit: "" };
    const picked = await vscode.window.showQuickPick([...choices, pickCommit], {
      title: "Explain changed functions",
      placeHolder: "Compare the checked-out code with…"
    });
    if (!picked) return;
    let base = picked.commit;
    let label = picked.phrase;
    if (picked === pickCommit) {
      const commits = await recentCommits(root);
      const commit = await vscode.window.showQuickPick(
        commits.map((entry) => ({ label: entry.subject, description: `${entry.shortHash} · ${entry.when}`, commit: entry })),
        { title: "Explain functions changed since…", placeHolder: "The changes after this commit, up to the checked-out code, are included", matchOnDescription: true }
      );
      if (!commit) return;
      base = commit.commit.hash;
      label = `since ${commit.commit.shortHash}`;
    }
    if (!panel) {
      const editor = vscode.window.activeTextEditor ?? lastTextEditor;
      ensurePanel();
      if (editor?.document.uri.scheme === "file") await previewDocument(editor.document);
    }
    await startReview(root, base, label, true);
  };

  /** Lists the changed functions with their state; choosing one opens it, and the preview follows. */
  const showChangedFunctionsCommand = async (): Promise<void> => {
    const session = reviewSession;
    if (!session) {
      await vscode.window.showInformationMessage("No changes are being reviewed. Run \"Downside Up: Review Changes…\" first.");
      return;
    }
    const icons: Record<ReviewItem["status"], string> = {
      pending: "$(circle-outline)", explaining: "$(sync~spin)", done: "$(check)", failed: "$(error)", skipped: "$(circle-slash)"
    };
    const running = !session.stopped && session.items.some((item) => item.status === "pending" || item.status === "explaining");
    const control = running
      ? { label: "$(debug-stop) Stop explaining changed functions", action: "stop" as const }
      : { label: "$(close) Close review mode", action: "dismiss" as const };
    const resume = !running && session.items.some((item) => item.status === "pending")
      ? [{ label: "$(debug-start) Continue explaining changed functions", action: "resume" as const }]
      : [];
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { item?: ReviewItem; action?: "stop" | "dismiss" | "resume" }>(
      [
        ...session.items.map((item) => ({ label: `${icons[item.status]} ${item.qualifiedName}`, description: item.path, item })),
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        ...resume,
        control
      ],
      { title: `Changed functions ${session.base}`, placeHolder: "Go to a changed function", matchOnDescription: true }
    );
    if (!picked) return;
    if (picked.action === "stop") stopReview();
    else if (picked.action === "dismiss") dismissReview();
    else if (picked.action === "resume") {
      session.stopped = false;
      updateReviewStatus();
      void runReview(session).catch(() => stopReview());
    } else if (picked.item) {
      const position = new vscode.Position(picked.item.nameLine, picked.item.nameStart);
      const document = await vscode.workspace.openTextDocument(picked.item.uri);
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.One });
    }
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
        for (const job of folderJobs.values()) job.abort();
        return;
      case "summarizeFolder":
        await summarizeShownFolder();
        return;
      case "summarizeTree":
        await summarizeShownTree();
        return;
      case "describeFlows":
        await describeShownFlows();
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
        stopReview();
        for (const state of [...functions.values()]) forget(state);
        savedLookupEpoch++;
        savedLookupDone.clear();
        repositoryJob?.abort();
        repositoryJob = undefined;
        repositoryJobRoot = undefined;
        preview = undefined;
        folderPreview = undefined;
        openingFolder = undefined;
        notice = undefined;
        panel = undefined;
      },
      (visible) => {
        // A folder shown or being opened stays; otherwise catch up with the editor.
        if (visible && lastTextEditor && !folderPreview && !openingFolder) void previewDocument(lastTextEditor.document);
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
    if (folderPreview) return folderPreview.root;
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
    await refreshContextFor(root, false);
  };

  const autoMapKey = (root: string): string => {
    const model = describeOverviewProvider();
    return `${root}\0${model.kind}\0${model.modelId}`;
  };

  /**
   * Maps the project when its page opens without a current map. Opening the
   * project page is the request: the first time, it asks for code-sharing
   * approval like an explanation. It does nothing in an untrusted workspace,
   * without a usable model, while another refresh runs, or after the reader
   * declined, cancelled, or saw it fail this session (the page then offers
   * Map this project).
   */
  const mapProjectAutomatically = async (root: string): Promise<void> => {
    if (repositoryJob || autoMapSkipped.has(autoMapKey(root)) || !vscode.workspace.isTrusted) return;
    const model = describeOverviewProvider();
    if (model.kind === "vscode-lm" && !(await findLanguageModel(model.modelId))) return;
    if (model.kind === "openai" && !(await context.secrets.get(API_KEY_SECRET))) return;
    if (repositoryJob || folderPreview?.root !== root || folderPreview.path !== "" || preview) return;
    await refreshContextFor(root, true);
  };

  /** Refreshes the repository context and project map; `automatic` when the project page asked for a missing map. */
  const refreshContextFor = async (root: string, automatic: boolean): Promise<void> => {
    if (repositoryJob) return;
    const controller = new AbortController();
    repositoryJob = controller;
    repositoryJobRoot = root;
    notice = { tone: "progress", text: automatic ? "Mapping the project…" : "Refreshing repository context by request…" };
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
      // A shown folder of this repository picks up the new project map.
      if (!preview && folderPreview?.root === root) await showFolder(root, folderPreview.path);
      if (repositoryJob !== controller) return;
      notice = {
        tone: "info",
        text: `${changed ? "Repository context changed. Saved explanations stay current; they note that an earlier overview was used." : "Repository context and project map checked."} ${formatUsage(result.usage)}`
      };
      if (changed) scheduleRecheck();
    } catch (error) {
      if (repositoryJob !== controller) return;
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      // Not tried again on its own this session; the project page offers Map this project instead.
      if (automatic) autoMapSkipped.add(autoMapKey(root));
      notice = cancelled
        ? { tone: "info", text: automatic ? "Mapping the project was cancelled; nothing was sent or saved." : "Repository context refresh cancelled; nothing was sent or saved." }
        : { tone: "error", text: `${automatic ? "Mapping the project" : "Repository context refresh"} failed: ${errorMessage(error)}` };
    } finally {
      if (repositoryJob === controller) {
        repositoryJob = undefined;
        repositoryJobRoot = undefined;
      }
      render();
    }
  };

  /** Prefetching that stopped for lack of code-sharing approval starts again once it is given. */
  const afterConsent = (root: string): void => {
    if (!panel || !preview || preview.root !== root || prefetchSession || !prefetchSettings().enabled) return;
    if (notice?.text.startsWith("Prefetching is waiting")) notice = undefined;
    startPrefetch(preview.document, root);
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
    if (reviewSession?.root === root) dismissReview();
    savedLookupEpoch++;
    for (const state of [...functions.values()]) if (state.value.root === root) forget(state);
    repositoryJob?.abort();
    repositoryJob = undefined;
    repositoryJobRoot = undefined;
    autoMapSkipped.clear();
    await service.clearCache(root);
    if (repositoryContext?.root === root) repositoryContext = undefined;
    notice = { tone: "info", text: "Repository cache and saved code-sharing consent cleared." };
    render();
  };

  const findFunctionTarget = async (
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<FunctionTarget | undefined> => {
    const language = bundledLanguageFor({ languageId: document.languageId, path: document.uri.path });
    let target: FunctionTarget | undefined;
    if (language) {
      await initializeLanguage(language, context.extensionPath);
      target = await language.findFunction(document, position);
    }
    return target ?? findFunctionWithEditorTools(document, position);
  };

  /**
   * Opens the explanation of the function that holds a text selection,
   * generating or regenerating it when none is current. Selecting text and
   * opening the preview is the explicit request; anything else does nothing.
   */
  const explainSelection = async (document: vscode.TextDocument, selection: vscode.Selection): Promise<void> => {
    if (!preview || !sameUri(preview.document.uri, document.uri)) return;
    const { root } = preview;
    const target = await findFunctionTarget(document, selection.start).catch(() => undefined);
    if (!target || !target.range.contains(selection.start) || !target.range.contains(selection.end)) return;
    const state = stateFor({ root, target, document });
    if (state.view.status === "outdated" || state.view.status === "failed" || state.view.status === "cancelled") {
      await generate(state);
    } else {
      await openExplanation(state);
    }
  };

  /** Previews a folder chosen in the Explorer, relative to the repository that holds it. */
  const openFolderPreview = async (folder: vscode.Uri): Promise<void> => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(folder);
    if (!workspaceFolder) {
      await vscode.window.showWarningMessage("Open the folder inside a workspace folder to preview it.");
      return;
    }
    let root = await findRepositoryRoot(workspaceFolder.uri.fsPath);
    if (!isWithin(root, resolve(folder.fsPath))) root = await findRepositoryRoot(folder.fsPath);
    const existing = panel;
    ensurePanel();
    if (existing) existing.panel.reveal(undefined, true);
    await showFolder(root, relative(root, resolve(folder.fsPath)).split(sep).join("/"));
  };

  /** Previews the repository of the active file, or of the only workspace folder, at its root. */
  const previewProjectCommand = async (): Promise<void> => {
    const root = await rootForCommand() ?? (vscode.workspace.workspaceFolders?.length === 1
      ? await findRepositoryRoot(vscode.workspace.workspaceFolders[0]!.uri.fsPath).catch(() => undefined)
      : undefined);
    if (!root) {
      await vscode.window.showInformationMessage("Open a source file in the repository to preview first.");
      return;
    }
    const existing = panel;
    ensurePanel();
    if (existing) existing.panel.reveal(undefined, true);
    await showFolder(root, "");
  };

  /**
   * Opens or reveals the preview of the active file (or the given one); it
   * follows the editor's position. With a text selection inside a function,
   * that function's explanation is opened too, and generated or regenerated
   * when none is current. A plain cursor never starts generation.
   */
  const openPreviewCommand = async (resource?: vscode.Uri): Promise<void> => {
    let document: vscode.TextDocument | undefined;
    if (resource instanceof vscode.Uri && resource.scheme === "file" && (await stat(resource.fsPath).catch(() => undefined))?.isDirectory()) {
      await openFolderPreview(resource);
      return;
    }
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
    const editor = vscode.window.activeTextEditor ?? lastTextEditor;
    const selection = editor && sameUri(editor.document.uri, document.uri) && editor.selections.length === 1 && !editor.selection.isEmpty
      ? editor.selection
      : undefined;
    const existing = panel;
    ensurePanel();
    if (existing) existing.panel.reveal(undefined, true);
    await previewDocument(document);
    if (selection) await explainSelection(document, selection);
  };

  const cancelExplanations = (): void => {
    for (const job of folderJobs.values()) job.abort();
    stopPrefetch();
    stopReview();
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
    if (["downsideUp.provider", "downsideUp.languageModel", "downsideUp.openai", "downsideUp.projectMap"].some((key) => event.affectsConfiguration(key))) {
      // Folder summaries are saved per overview model, which falls back to the explanation model, so look again.
      if (panel && folderPreview && !preview) void showFolder(folderPreview.root, folderPreview.path);
    }
    if (event.affectsConfiguration("downsideUp.exclusion")) {
      clearPolicyCache();
      // The shown file may now be excluded, or allowed again.
      if (panel && preview) void previewDocument(preview.document);
    }
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
      !event.affectsConfiguration("downsideUp.languageModel.model")
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
    vscode.commands.registerCommand("downsideUp.showFileOverview", openPreviewCommand),
    vscode.commands.registerCommand("downsideUp.previewProject", previewProjectCommand),
    vscode.commands.registerCommand("downsideUp.selectOverviewModel", async () => {
      await chooseOverviewModel();
      render();
    }),
    vscode.commands.registerCommand("downsideUp.reviewChanges", reviewChangesCommand),
    vscode.commands.registerCommand("downsideUp.showChangedFunctions", showChangedFunctionsCommand),
    reviewStatus,
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
    vscode.languages.registerHoverProvider({ scheme: "file" }, hoverProvider),
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
    reviewChanges: (base: string) => {
      const root = preview?.root;
      return root ? startReview(root, base, "for testing", false) : Promise.resolve(0);
    },
    reviewItems: () => (reviewSession?.items ?? []).map((item) => ({ qualifiedName: item.qualifiedName, path: item.path, status: item.status })),
    stopReview: () => dismissReview(),
    shownFolder: () => folderPreview && !preview
      ? {
          path: folderPreview.path,
          children: folderPreview.children.map((child) => `${child.kind} ${child.path}`),
          edges: (folderPreview.structure?.edges ?? []).map((edge) => `${edge.from} > ${edge.to}`).sort(),
          ...(folderPreview.ai ? { summary: folderPreview.ai.value.summary, current: folderPreview.ai.current } : {}),
          ready: Boolean(folderPreview.input),
          hasOverview: repositoryContext?.root === folderPreview.root,
          level: folderPreview.level,
          mapState: folderPreview.map ? (folderPreview.map.current ? "current" : "other") : "missing",
          mapping: Boolean(repositoryJob && repositoryJobRoot === folderPreview.root),
          mapNodes: (folderPreview.map ? mapView(folderPreview.map.map, folderPreview.path)?.nodes ?? [] : []).map((node) => `${node.name}:${node.place}`).sort(),
          members: (folderPreview.level === "project" || folderPreview.level === "group") && folderPreview.map
            ? mapMembers(folderPreview.map.map, folderPreview.path).map((part) => `${part.name}:${part.level}`)
            : [],
          ...(folderPreview.ai?.value.offers ? { offers: folderPreview.ai.value.offers } : {}),
          ...(folderPreview.input?.contracts ? { contracts: folderPreview.input.contracts.map((contract) => contract.path) } : {})
        }
      : undefined,
    summarizeFolder: () => summarizeShownFolder(),
    summarizeTree: () => summarizeShownTree(false),
    describeFlows: () => describeShownFlows(),
    shownFlows: () => (folderPreview && !preview && folderPreview.flows
      ? folderPreview.flows.flows.map((flow) => ({ title: flow.title, refs: flow.refs.map((ref) => ref ? referenceCaption(ref) : null) }))
      : undefined),
    flowsKind: () => folderPreview?.flowsInput?.kind,
    flowsReady: () => Boolean(folderPreview?.flowsInput),
    previewFolder: (path: string) => preview ? showFolder(preview.root, path) : folderPreview ? showFolder(folderPreview.root, path) : Promise.resolve(),
    allExplanations: () => [...functions.values()].map((state) => ({
      functionName: state.view.functionName,
      status: state.view.status,
      path: filePath(state.value.root, state.value.document.uri),
      ...(state.view.error ? { error: state.view.error } : {})
    }))
  };
}

export interface DownsideUpTestApi {
  shownFolder(): {
    path: string;
    children: string[];
    edges: string[];
    summary?: string;
    current?: boolean;
    ready: boolean;
    hasOverview: boolean;
    level: string;
    mapState: string;
    mapping: boolean;
    mapNodes: string[];
    members: string[];
    offers?: string;
    contracts?: string[];
  } | undefined;
  summarizeFolder(): Promise<void>;
  summarizeTree(): Promise<void>;
  describeFlows(): Promise<void>;
  shownFlows(): Array<{ title: string; refs: Array<string | null> }> | undefined;
  flowsReady(): boolean;
  flowsKind(): "files" | "parts" | undefined;
  previewFolder(path: string): Promise<void>;
  reviewChanges(base: string): Promise<number>;
  reviewItems(): Array<{ qualifiedName: string; path: string; status: string }>;
  stopReview(): void;
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
