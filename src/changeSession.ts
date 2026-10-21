import { basename } from "node:path";
import * as vscode from "vscode";
import type { ExplanationService, SavedComparison } from "./controller";
import {
  comparisonProblem,
  describeIdentity,
  readComparison,
  resolveNativeDiff,
  type ComparisonRef,
  type ComparisonSnapshot,
  type DiffUri,
  type SideSnapshot,
  type SnapshotOptions
} from "./context/comparison";
import { findRepositoryRoot, sharingExclusion } from "./context/inventory";
import { formatUsage } from "./generation/provider";
import type { ComparisonVisualScope } from "./core/types";
import type { ChangeView } from "./presentation/panel";

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

  constructor(private readonly host: ChangeSessionHost) {}

  get active(): boolean { return this.shown !== undefined; }
  get busy(): boolean { return Boolean(this.shown?.controller); }
  get root(): string | undefined { return this.shown?.root; }
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
  }

  cancel(): void {
    this.shown?.controller?.abort();
  }

  stopPrefetch(): void {
    if (this.shown?.prefetching) this.shown.controller?.abort();
  }

  /** Looks up a saved comparison, then prefetches on first showing when opted in. */
  async show(original: vscode.Uri, modified: vscode.Uri, force = false): Promise<void> {
    const key = keyOf(original, modified);
    if (this.shown?.key === key && !force) return;
    const epoch = ++this.epoch;
    const previous = this.shown?.key === key ? this.shown : undefined;
    if (!previous) this.shown?.controller?.abort();
    const shown: Shown = previous ?? { key, originalUri: original, modifiedUri: modified };
    this.shown = shown;
    if (!previous) this.host.changed();
    try {
      await this.load(shown);
    } catch (error) {
      shown.problem = `The change could not be read: ${error instanceof Error ? error.message : String(error)}`;
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

  private async rootFor(uri: vscode.Uri): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(uri.fsPath));
    return folder ? findRepositoryRoot(folder.uri.fsPath) : undefined;
  }

  private async load(shown: Shown): Promise<void> {
    shown.problem = undefined;
    shown.saved = undefined;
    const root = (await this.rootFor(shown.modifiedUri)) ?? (await this.rootFor(shown.originalUri));
    shown.root = root;
    if (!root) {
      shown.problem = "These files are outside the open workspace folders, so the change is not explained.";
      return;
    }
    if (!vscode.workspace.isTrusted) {
      shown.problem = "Reading changes requires a trusted workspace.";
      return;
    }
    const resolved = await resolveNativeDiff(root, toDiffUri(shown.originalUri), toDiffUri(shown.modifiedUri));
    if ("unsupported" in resolved) {
      shown.ref = undefined;
      shown.problem = resolved.unsupported;
      return;
    }
    shown.ref = resolved.ref;
    const snapshot = await readComparison(resolved.ref, snapshotOptions());
    shown.snapshot = snapshot;
    shown.problem = comparisonProblem(snapshot);
    if (!shown.problem) shown.saved = await this.host.service.findComparison(snapshot);
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
      if (this.shown === shown) shown.saved = result;
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
    const links = (change: SavedComparison["comparison"]["changes"][number]) => {
      const out: Array<{ referenceId: string; caption: string }> = [];
      // Lines were checked against the exact text explained; once either side changed they may name other code.
      if (!saved?.current) return out;
      for (const [name, span, uri] of [["Original", change.original, shown.originalUri], ["Modified", change.modified, shown.modifiedUri]] as const) {
        if (span.start < 1) continue;
        const caption = `${name} ${span.start === span.end ? "line" : "lines"} ${span.start === span.end ? span.start : `${span.start}–${span.end}`}`;
        out.push({ referenceId: register(() => this.host.reveal(uri, span.start, span.end, name === "Original" ? "original" : "modified")), caption });
      }
      return out;
    };
    const visualLinks = (scope: ComparisonVisualScope, name: "original" | "modified", uri: vscode.Uri): Record<string, string> => {
      if (!saved?.current) return {};
      return Object.fromEntries(scope.units
        .filter((unit) => unit.side === name)
        .map((unit) => [
          unit.occurrence.id,
          register(() => this.host.reveal(uri, unit.occurrence.startLine, unit.occurrence.endLine, name))
        ]));
    };
    const status: ChangeView["status"] = shown.controller ? "loading"
      : shown.problem ? "unavailable"
      : shown.error ? "failed"
      : saved ? (saved.current ? "current" : "outdated")
      : "ready";
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
          changes: saved.comparison.changes.map((change) => ({
            id: change.id,
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
