import { basename } from "node:path";
import * as vscode from "vscode";
import type { ExplanationResult, ExplanationService, SavedComparison, SnapshotExplanationSource } from "./controller";
import {
  comparisonProblem,
  describeIdentity,
  readComparison,
  resolveNativeDiff,
  snapshotSignature,
  type ComparisonRef,
  type ComparisonSnapshot,
  type DiffUri,
  type SideSnapshot,
  type SnapshotOptions
} from "./context/comparison";
import { findRepositoryRoot, sharingExclusion } from "./context/inventory";
import { formatUsage } from "./generation/provider";
import type { ComparisonCatalogueEntry, ComparisonVisualScope, ExplanationFormat, FunctionTarget } from "./core/types";
import type { ChangeFunctionCardView, ChangeView, ExplanationView } from "./presentation/panel";
import { languageFor } from "./languages/registry";
import { fingerprint } from "./core/fingerprint";

export interface ChangeSessionHost {
  readonly service: ExplanationService;
  /** Opens one-based lines of one side of the shown diff, checked by the caller's snapshot. */
  readonly reveal: (uri: vscode.Uri, startLine: number, endLine: number, side: "original" | "modified") => Promise<void>;
  /** Runs a request in a shared slot, behind explicit requests when prefetching. */
  readonly schedule: <T>(task: () => Promise<T>, priority?: "explicit" | "prefetch") => Promise<T>;
  readonly prefetch?: {
    readonly enabled: () => boolean;
    readonly allowed: (root: string) => Promise<boolean>;
    readonly background: (signal: AbortSignal) => void;
  };
  /** The shown state changed; draw it again. */
  readonly changed: () => void;
  /** The same linked masks, pseudocode layout, and format state as ordinary explanations. */
  readonly explanationView?: (state: ChangeCardState, entryId: string) => ExplanationView;
}

export interface ChangeCardState {
  readonly key: string;
  readonly side: "original" | "modified";
  readonly value: { readonly root: string; readonly target: FunctionTarget; readonly document: vscode.TextDocument };
  readonly validate: () => Promise<void>;
  readonly scope?: SnapshotExplanationSource;
  view: Omit<ExplanationView, "entryId">;
  result?: ExplanationResult;
  controller?: AbortController;
  loadingFormat?: ExplanationFormat;
  formatError?: string;
}

interface Shown {
  readonly key: string;
  readonly originalUri: vscode.Uri;
  readonly modifiedUri: vscode.Uri;
  root?: string;
  ref?: ComparisonRef;
  snapshot?: ComparisonSnapshot;
  /** Why this pair cannot be explained. */
  problem?: string;
  saved?: SavedComparison;
  error?: string;
  detail?: string;
  controller?: AbortController;
  prefetching?: boolean;
  prefetchAttempted?: boolean;
}

/** Reading options for a snapshot: unsaved editor text stands in for the working file, and exclusions are checked per side. */
export function snapshotOptions(): SnapshotOptions {
  const buffers = new Map<string, string>();
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme === "file" && document.isDirty) buffers.set(document.uri.fsPath, document.getText());
  }
  return { buffers, exclusion: (root, path) => sharingExclusion(root, path).catch(() => "its exclusion could not be checked") };
}

const toDiffUri = (uri: vscode.Uri): DiffUri => ({ scheme: uri.scheme, fsPath: uri.fsPath, query: uri.query });
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The native diff shown in the preview. Showing it only looks up a saved
 * explanation, then optionally prefetches with existing sharing approval.
 * Explicit requests may ask for consent for the exact versions shown.
 */
export class ChangeSession {
  private shown: Shown | undefined;
  private epoch = 0;
  private bindingEpoch = 0;
  private savedEpoch = 0;
  private readonly cards = new Map<string, ChangeCardState>();
  private readonly cardLoads = new Map<string, Promise<ChangeCardState | undefined>>();
  private readonly cardErrors = new Map<string, string>();
  private readonly cardRequests = new Map<string, AbortController>();

  constructor(private readonly host: ChangeSessionHost) {}

  get active(): boolean { return this.shown !== undefined; }
  get busy(): boolean { return Boolean(this.shown?.controller) || this.cardRequests.size > 0; }
  get root(): string | undefined { return this.shown?.root; }
  /** Exact resolved source pair currently bound to the preview, including both identities and paths. */
  get comparisonRef(): ComparisonRef | undefined { return this.shown?.ref; }
  /** Repository-relative path of the shown file, once read. */
  get path(): string | undefined {
    const snapshot = this.shown?.snapshot;
    return snapshot ? (snapshot.modified.state === "absent" ? snapshot.original.path : snapshot.modified.path) : undefined;
  }
  get fileName(): string | undefined { return this.shown ? basename(this.shown.modifiedUri.path) : undefined; }

  shows(original: vscode.Uri, modified: vscode.Uri): boolean {
    return this.shown?.key === keyOf(original, modified);
  }

  /** Whether a document is one side of the shown diff, such as a Git document that changes when HEAD or the index does. */
  involves(uri: vscode.Uri): boolean {
    const shown = this.shown;
    return Boolean(shown && (shown.originalUri.toString() === uri.toString() || shown.modifiedUri.toString() === uri.toString()));
  }

  clear(): void {
    this.epoch++;
    this.shown?.controller?.abort();
    this.shown = undefined;
    this.clearCards();
  }

  cancel(): void {
    this.shown?.controller?.abort();
    for (const controller of this.cardRequests.values()) controller.abort();
    for (const card of this.cards.values()) card.controller?.abort();
  }

  private clearCards(): void {
    this.bindingEpoch++;
    for (const controller of this.cardRequests.values()) controller.abort();
    this.cardRequests.clear();
    for (const card of this.cards.values()) card.controller?.abort();
    this.cards.clear();
    this.cardLoads.clear();
    this.cardErrors.clear();
  }

  /** Model/policy changes fence card state without requesting new explanations. */
  invalidateCards(): void { this.clearCards(); }

  stopPrefetch(): void {
    if (this.shown?.prefetching) this.shown.controller?.abort();
  }

  /** Looks up a saved comparison, then prefetches on first showing when opted in. */
  async show(original: vscode.Uri, modified: vscode.Uri, force = false): Promise<void> {
    const key = keyOf(original, modified);
    if (this.shown?.key === key && !force) return;
    const epoch = ++this.epoch;
    const previous = this.shown?.key === key ? this.shown : undefined;
    if (!previous) {
      this.shown?.controller?.abort();
      this.clearCards();
    }
    const shown: Shown = previous ?? { key, originalUri: original, modifiedUri: modified };
    this.shown = shown;
    if (!previous) this.host.changed();
    try {
      await this.load(shown, epoch);
    } catch (error) {
      if (this.shown === shown && this.epoch === epoch) {
        shown.problem = `The change could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (epoch === this.epoch && this.shown === shown) {
      this.host.changed();
      if (!previous) void this.prefetch();
    }
  }

  /** Reads the same pair again, such as after an edit, a save, or a setting change. */
  async refresh(): Promise<void> {
    const shown = this.shown;
    if (shown) await this.show(shown.originalUri, shown.modifiedUri, true);
  }

  /** A background review saved this exact pair. Reload cache-only, never starting a request. */
  async comparisonSaved(snapshot: ComparisonSnapshot): Promise<void> {
    this.savedEpoch++;
    const shown = this.shown;
    if (shown?.snapshot?.root === snapshot.root &&
        snapshotSignature(shown.snapshot) === snapshotSignature(snapshot)) await this.refresh();
  }

  private async rootFor(uri: vscode.Uri): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(uri.fsPath));
    return folder ? findRepositoryRoot(folder.uri.fsPath) : undefined;
  }

  private async load(shown: Shown, epoch: number): Promise<void> {
    let savedEpoch = this.savedEpoch;
    const apply = (value: Partial<Shown>) => {
      if (this.shown === shown && this.epoch === epoch) Object.assign(shown, value);
    };
    const root = (await this.rootFor(shown.modifiedUri)) ?? (await this.rootFor(shown.originalUri));
    if (!root) {
      apply({ root, saved: undefined, problem: "These files are outside the open workspace folders, so the change is not explained." });
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.clearCards();
      apply({ root, saved: undefined, problem: "Reading changes requires a trusted workspace." });
      return;
    }
    const resolved = await resolveNativeDiff(root, toDiffUri(shown.originalUri), toDiffUri(shown.modifiedUri));
    if ("unsupported" in resolved) {
      apply({ root, ref: undefined, saved: undefined, problem: resolved.unsupported });
      return;
    }
    const snapshot = await readComparison(resolved.ref, snapshotOptions());
    const problem = comparisonProblem(snapshot);
    let saved = !problem ? await this.host.service.findComparison(snapshot) : undefined;
    // A review may persist after the lookup read but before this view is bound.
    while (!problem && savedEpoch !== this.savedEpoch && this.shown === shown && this.epoch === epoch) {
      savedEpoch = this.savedEpoch;
      saved = await this.host.service.findComparison(snapshot);
    }
    if (this.shown !== shown || this.epoch !== epoch) return;
    if (!saved?.current || (shown.snapshot && JSON.stringify(shown.snapshot) !== JSON.stringify(snapshot))) this.clearCards();
    apply({ root, ref: resolved.ref, snapshot, problem, saved });
    await this.restoreCards(shown, epoch);
  }

  /**
   * What the shown documents are now. A Git document such as `HEAD` or the
   * index names a version that moves, so it is resolved again for every read
   * rather than reusing the commit it named when the diff was shown.
   */
  private async currentPair(shown: Shown, root: string): Promise<ComparisonSnapshot> {
    const resolved = await resolveNativeDiff(root, toDiffUri(shown.originalUri), toDiffUri(shown.modifiedUri));
    if ("unsupported" in resolved) throw new Error(resolved.unsupported);
    return readComparison(resolved.ref, snapshotOptions());
  }

  private cardId(entry: ComparisonCatalogueEntry): string {
    return `change-${entry.id}`;
  }

  /** Opaque IDs are valid only for the current saved catalogue and exact pair. */
  hasCard(id: string): boolean {
    return Boolean(this.shown?.saved?.current && this.shown.saved.catalogue?.entries.some((entry) =>
      entry.category !== "changed" && this.cardId(entry) === id));
  }

  cardState(id: string): ChangeCardState | undefined {
    return this.hasCard(id) ? this.cards.get(id) : undefined;
  }

  cardStates(): ChangeCardState[] {
    return [...this.cards.values()].filter((card) => this.hasCard(card.key));
  }

  cancelCard(id: string): void { this.cardRequests.get(id)?.abort(); }

  private async resolveCard(id: string, cacheOnly = false): Promise<ChangeCardState | undefined> {
    if (!this.hasCard(id)) return undefined;
    const existing = this.cards.get(id);
    if (existing) { await existing.validate(); return existing; }
    const pending = this.cardLoads.get(id);
    if (pending) return pending;
    const load = this.loadCard(id, cacheOnly);
    this.cardLoads.set(id, load);
    try { return await load; } finally { if (this.cardLoads.get(id) === load) this.cardLoads.delete(id); }
  }

  private applyCardResult(card: ChangeCardState, result: ExplanationResult): void {
    card.result = result;
    card.view = {
      functionName: card.value.target.qualifiedName, status: "current", detail: result.cached ? "Saved explanation" : "Generated just now",
      explanation: result.explanation, references: [], limitations: [...new Set([...result.context.limitations, ...result.explanation.limitations])],
      ...(result.usage ? { usage: formatUsage(result.usage) } : {})
    };
  }

  private async restoreCards(shown: Shown, epoch: number): Promise<void> {
    const bindingEpoch = this.bindingEpoch;
    for (const entry of shown.saved?.current ? shown.saved.catalogue?.entries ?? [] : []) {
      if (this.shown !== shown || this.epoch !== epoch || this.bindingEpoch !== bindingEpoch) return;
      if (entry.category === "changed") continue;
      const id = this.cardId(entry);
      if (this.cards.has(id) || this.cardRequests.has(id)) continue;
      try {
        await this.resolveCard(id, true);
      } catch (error) {
        if (this.shown !== shown || this.epoch !== epoch || this.bindingEpoch !== bindingEpoch) return;
        this.cardErrors.set(id, `Could not load the saved function explanation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async loadCard(id: string, cacheOnly = false): Promise<ChangeCardState | undefined> {
    const bindingEpoch = this.bindingEpoch;
    const shown = this.shown!;
    const snapshot = shown.snapshot!;
    const entry = shown.saved!.catalogue!.entries.find((entry) => this.cardId(entry) === id)!;
    const side = entry.category === "removed" ? "original" : "modified";
    const version = snapshot[side];
    const uri = side === "original" ? shown.originalUri : shown.modifiedUri;
    const validate = async () => {
      if (this.shown !== shown || bindingEpoch !== this.bindingEpoch || !this.hasCard(id) || !vscode.workspace.isTrusted ||
          JSON.stringify(await this.currentPair(shown, snapshot.root)) !== JSON.stringify(snapshot)) {
        throw new Error("This function's diff snapshot changed. Explain the changes again before requesting its detail.");
      }
    };
    await validate();
    // Opening a document for analysis is not opening an editor/tab.
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() !== version.text) throw new Error("The diff document does not match its authorized snapshot; this function cannot be explained.");
    const range = entry[side]!;
    const target = await languageFor({ path: version.path }).findFunction(document, new vscode.Position(range.nameLine, range.nameColumn));
    if (!target || target.range.start.line !== range.startLine || target.range.start.character !== range.startColumn ||
        target.range.end.line !== range.endLine || target.range.end.character !== range.endColumn) {
      throw new Error("The function could not be resolved exactly in this diff snapshot.");
    }
    await validate();
    const scope: SnapshotExplanationSource | undefined = side === "modified" && uri.scheme === "file" && version.identity === "working"
      ? undefined : { side: version, occurrenceId: fingerprint(JSON.stringify([range, entry.id])), validate };
    const state: ChangeCardState = {
      key: id, side, value: { root: snapshot.root, target, document }, validate, ...(scope ? { scope } : {}),
      view: { functionName: entry.name, status: "loading", detail: "", references: [], limitations: [] }
    };
    if (cacheOnly) {
      const result = scope
        ? await this.host.service.findSnapshotExplanation(snapshot.root, target, scope)
        : await this.host.service.findCachedExplanation(snapshot.root, target, document);
      await validate();
      if (!result || result.stale) return undefined;
      this.applyCardResult(state, result);
    }
    this.cards.set(id, state);
    return state;
  }

  /** Only panel Explain/Regenerate/Generate actions call this method; render, review and prefetch never do. */
  async explainCard(id: string, format?: ExplanationFormat): Promise<void> {
    if (!this.hasCard(id) || this.cardRequests.has(id)) return;
    const controller = new AbortController();
    this.cardRequests.set(id, controller);
    let state: ChangeCardState | undefined;
    try {
      state = await this.resolveCard(id);
      // A concurrent cache-only load may have completed with a miss.
      if (!state && this.hasCard(id) && !controller.signal.aborted) state = await this.resolveCard(id);
      if (!state || controller.signal.aborted) return;
      state.controller = controller;
      state.loadingFormat = format;
      state.formatError = undefined;
      if (!format) state.view = { ...state.view, status: "loading", detail: "Explaining this function…" };
      this.host.changed();
      const card = state;
      const { root, target, document } = card.value;
      const result = await this.host.schedule(async () => {
        await card.validate();
        if (controller.signal.aborted) throw new DOMException("Cancelled.", "AbortError");
        return card.scope
          ? this.host.service.explainSnapshot(root, target, card.scope, controller.signal, format)
          : format ? this.host.service.addExplanationFormat(root, target, document, format, controller.signal, card.validate)
          : this.host.service.explain(root, target, document, controller.signal, undefined, card.validate);
      }, "explicit");
      if (this.cards.get(id) !== card) return;
      this.applyCardResult(card, result);
    } catch (error) {
      if (!state) {
        if (this.hasCard(id) && this.cardRequests.get(id) === controller && !controller.signal.aborted) {
          this.cardErrors.set(id, error instanceof Error ? error.message : "This snapshot function is unavailable.");
        }
        return;
      }
      if (this.cards.get(id) !== state) return;
      if (format) state.formatError = error instanceof Error ? error.message : "Could not add this format.";
      else state.view = { ...state.view, status: state.controller?.signal.aborted ? "cancelled" : "failed",
        detail: state.controller?.signal.aborted ? "Cancelled; nothing was saved" : "Generation failed",
        ...(state.controller?.signal.aborted ? {} : { error: error instanceof Error ? error.message : "Could not explain this function." }) };
    } finally {
      if (this.cardRequests.get(id) === controller) this.cardRequests.delete(id);
      if (state) { state.controller = undefined; state.loadingFormat = undefined; }
      this.host.changed();
    }
  }

  /** Explains the shown pair; the reader asked for it. */
  async explain(): Promise<void> {
    await this.generate(false);
  }

  /** Never prompts, retries a failed attempt, or regenerates an outdated saved comparison. */
  async prefetch(): Promise<void> {
    const shown = this.shown;
    if (!this.host.prefetch?.enabled() || !shown || shown.saved || shown.error || shown.problem || shown.prefetchAttempted) return;
    await this.generate(true);
  }

  private async generate(prefetching: boolean): Promise<void> {
    const shown = this.shown;
    const root = shown?.root;
    if (!shown?.ref || !root || shown.controller) return;
    const background = this.host.prefetch;
    const epoch = this.epoch;
    const controller = new AbortController();
    const mayPrefetch = () => this.shown === shown && epoch === this.epoch
      && vscode.workspace.isTrusted && background?.enabled() === true && !controller.signal.aborted;
    shown.controller = controller;
    shown.prefetching = prefetching;
    if (prefetching) this.host.prefetch?.background(controller.signal);
    shown.error = undefined;
    shown.detail = "Reading both versions…";
    this.host.changed();
    try {
      if (prefetching) {
        if (!background || !mayPrefetch() || !(await background.allowed(root)) || !mayPrefetch()) return;
        shown.prefetchAttempted = true;
      }
      const snapshot = await this.currentPair(shown, root);
      if (controller.signal.aborted) return;
      shown.snapshot = snapshot;
      shown.problem = comparisonProblem(snapshot);
      if (shown.problem) return;
      shown.detail = "Explaining the changes…";
      this.host.changed();
      // The final check reads the documents shown by then, so a moved HEAD or index discards the result.
      const result = await this.host.schedule(async () => {
        if (controller.signal.aborted || (prefetching && !mayPrefetch())) {
          throw new DOMException("Prefetching moved on.", "AbortError");
        }
        return this.host.service.explainComparison(snapshot, () => this.currentPair(shown, root), controller.signal);
      }, prefetching ? "prefetch" : "explicit");
      if (this.shown === shown) {
        shown.saved = result;
        await this.restoreCards(shown, this.epoch);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        shown.error = undefined;
      } else if (error instanceof DOMException && error.name === "AbortError" && prefetching) {
        shown.error = undefined;
      } else if (error instanceof DOMException && error.name === "AbortError") {
        shown.error = "Nothing was sent because sharing code with this model was not approved.";
      } else {
        shown.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      shown.controller = undefined;
      shown.prefetching = false;
      shown.detail = undefined;
      if (this.shown === shown) this.host.changed();
    }
  }

  /** The panel's view of the shown pair; link ids are registered through `register` and resolved by the host only. */
  view(register: (open: () => Promise<void>) => string): ChangeView | undefined {
    const shown = this.shown;
    if (!shown) return undefined;
    const snapshot = shown.snapshot;
    const side = (version: SideSnapshot | undefined, uri: vscode.Uri): string => {
      if (!version) return basename(uri.path);
      const label = capitalized(describeIdentity(version.identity));
      return version.state === "absent" ? `${label} (no file)` : label;
    };
    const original = snapshot?.original;
    const modified = snapshot?.modified;
    const renamed = original && modified && original.path !== modified.path;
    const path = modified?.state === "absent" ? original?.path : modified?.path;
    const facts = [
      renamed && modified?.state !== "absent" && original?.state !== "absent" ? `${original!.path} → ${modified!.path}` : path ?? shown.modifiedUri.path,
      original?.state === "absent" ? "added" : modified?.state === "absent" ? "deleted" : renamed ? "renamed" : ""
    ].filter(Boolean).join(" · ");
    const saved = shown.problem ? undefined : shown.saved;
    const revealCurrent = async (uri: vscode.Uri, start: number, end: number, side: "original" | "modified") => {
      if (this.shown !== shown || !saved?.current || !snapshot || !vscode.workspace.isTrusted ||
          JSON.stringify(await this.currentPair(shown, snapshot.root)) !== JSON.stringify(snapshot)) {
        throw new Error("The comparison changed; explain it again before following source links.");
      }
      await this.host.reveal(uri, start, end, side);
    };
    const links = (change: SavedComparison["comparison"]["changes"][number]) => {
      const out: Array<{ referenceId: string; caption: string }> = [];
      // Lines were checked against the exact text explained; once either side changed they may name other code.
      if (!saved?.current) return out;
      for (const [name, span, uri] of [["Original", change.original, shown.originalUri], ["Modified", change.modified, shown.modifiedUri]] as const) {
        if (span.start < 1) continue;
        const caption = `${name} ${span.start === span.end ? "line" : "lines"} ${span.start === span.end ? span.start : `${span.start}–${span.end}`}`;
        out.push({ referenceId: register(() => revealCurrent(uri, span.start, span.end, name === "Original" ? "original" : "modified")), caption });
      }
      return out;
    };
    const visualLinks = (scope: ComparisonVisualScope, name: "original" | "modified", uri: vscode.Uri): Record<string, string> => {
      if (!saved?.current) return {};
      return Object.fromEntries(scope.units
        .filter((unit) => unit.side === name)
        .map((unit) => [
          unit.occurrence.id,
          register(() => revealCurrent(uri, unit.occurrence.startLine, unit.occurrence.endLine, name))
        ]));
    };
    const status: ChangeView["status"] = shown.controller ? "loading"
      : shown.problem ? "unavailable"
      : shown.error ? "failed"
      : saved ? (saved.current ? "current" : "outdated")
      : "ready";
    const cards = (category: "added" | "removed"): ChangeFunctionCardView[] =>
      (saved?.comparison[category] ?? []).flatMap((summary) => {
        const entry = saved?.catalogue?.entries.find((entry) => entry.id === summary.functionId && entry.category === category);
        if (!entry) return [];
        const id = this.cardId(entry);
        const state = this.cardState(id);
        const side = category === "added" ? "modified" : "original";
        const range = entry[side]!;
        return [{
          id, name: entry.name, kindLabel: capitalized(entry.kind), summary: summary.summary,
          canExplain: Boolean(saved?.current && !shown.problem && !this.cardErrors.has(id)),
          ...(!saved?.current ? { note: "The comparison changed; explain it again before requesting function detail." }
            : this.cardErrors.has(id) ? { note: this.cardErrors.get(id) } : {}),
          ...(saved?.current ? { link: { caption: entry.name, referenceId: register(async () => {
            await revealCurrent(side === "original" ? shown.originalUri : shown.modifiedUri, range.startLine + 1, range.endLine + 1, side);
          }) } } : {}),
          ...(state && this.host.explanationView ? { explanation: this.host.explanationView(state, id) } : {})
        }];
      });
    return {
      key: shown.key,
      fileName: path ? basename(path) : basename(shown.modifiedUri.path),
      facts,
      originalLabel: side(original, shown.originalUri),
      modifiedLabel: side(modified, shown.modifiedUri),
      status,
      ...(shown.detail ? { detail: shown.detail } : {}),
      ...(shown.problem ?? shown.error ? { message: shown.problem ?? shown.error } : {}),
      canExplain: Boolean(shown.ref) && !shown.problem && !shown.controller,
      ...(saved ? {
        result: {
          summary: saved.comparison.summary,
          added: cards("added"),
          removed: cards("removed"),
          changes: saved.comparison.changes.map((change) => ({
            id: change.id,
            ...(change.functionId ? { functionName: saved.catalogue?.entries.find((entry) => entry.id === change.functionId)?.name } : {}),
            title: change.title, before: change.before, after: change.after, when: change.when, flow: change.flow, links: links(change),
            ...(change.visualScopeId ? { visualScopeId: change.visualScopeId } : {})
          })),
          visualScopes: (saved.comparison.visualScopes ?? []).map((scope) => ({
            scope,
            originalLinks: visualLinks(scope, "original", shown.originalUri),
            modifiedLinks: visualLinks(scope, "modified", shown.modifiedUri)
          })),
          outside: saved.comparison.outside,
          possibleEffects: saved.comparison.possibleEffects,
          limitations: saved.comparison.limitations,
          model: saved.model,
          ...(saved.usage ? { usage: formatUsage(saved.usage) } : {}),
          ...(saved.current ? {} : { outdated: true })
        }
      } : {})
    };
  }
}

const keyOf = (original: vscode.Uri, modified: vscode.Uri): string => `${original.toString()}\0${modified.toString()}`;
