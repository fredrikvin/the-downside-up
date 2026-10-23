import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { ChangeSession, type ChangeSessionHost } from "../src/changeSession";
import { ExplanationService } from "../src/controller";
import type { ComparisonPromptInput } from "../src/generation/provider";
import { MockProvider } from "../src/generation/mock";
import { javascriptSupport } from "../src/languages/javascript";
import { commitComparisonRef, commitScope, readComparison, snapshotSignature } from "../src/context/comparison";
import { Review, type ReviewHost, type ReviewItem } from "../src/review";
import { RequestScheduler } from "../src/presentation/requestScheduler";

beforeAll(() => javascriptSupport.initialize!(process.cwd()));

let root = "";
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const uri = (scheme: string, path: string, query = "") => {
  const fsPath = join(root, path);
  return { scheme, fsPath, path: fsPath, query, toString: () => `${scheme}:${fsPath}?${query}` } as unknown as vscode.Uri;
};
const headOf = (path: string) => uri("git", path, JSON.stringify({ path: join(root, path), ref: "HEAD" }));
const workspace = vscode.workspace as unknown as Record<string, unknown>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dsu-change-session-")));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(root, "a.txt"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  workspace.isTrusted = true;
  workspace.getWorkspaceFolder = (target: { fsPath: string }) => target.fsPath.startsWith(root) ? { uri: { fsPath: root } } : undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete workspace.isTrusted;
  delete workspace.getWorkspaceFolder;
  await rm(root, { recursive: true, force: true });
});

async function cardSession() {
  await writeFile(join(root, "functions.ts"), "export function removed() {\n return 'old';\n}\n");
  git("add", "functions.ts"); git("commit", "-q", "-m", "original function");
  await writeFile(join(root, "functions.ts"), "export function added() {\n return 'new';\n}\n");
  vi.spyOn(vscode.workspace, "openTextDocument").mockImplementation((async (target: vscode.Uri) => {
    const ref = target.scheme === "git" ? (JSON.parse(target.query) as { ref: string }).ref : undefined;
    const text = target.scheme === "git" ? git("show", `${ref || ""}:functions.ts`) + "\n" : await readFile(target.fsPath, "utf8");
    return {
      uri: target, languageId: "typescript", getText: () => text, lineCount: text.split("\n").length,
      lineAt: (line: number) => ({ text: text.split("\n")[line] ?? "" })
    } as vscode.TextDocument;
  }) as unknown as typeof vscode.workspace.openTextDocument);
  const { changes, provider, service } = session();
  await changes.show(headOf("functions.ts"), uri("file", "functions.ts"));
  await changes.explain();
  const view = () => changes.view(() => "card-link")!;
  return { changes, provider, service, view };
}

describe("explicit change function cards", () => {
  it("restores cached added and removed details when returning to a saved diff without provider requests", async () => {
    const { changes, provider, view } = await cardSession();
    const added = view().result!.added![0]!.id;
    const removed = view().result!.removed![0]!.id;
    await changes.explainCard(added);
    await changes.explainCard(removed);
    const requests = provider.requests;
    changes.clear();
    await changes.show(headOf("functions.ts"), uri("file", "functions.ts"));
    expect(changes.cardState(added)?.view.status).toBe("current");
    expect(changes.cardState(removed)?.view.status).toBe("current");
    expect(changes.cardState(added)?.view.detail).toBe("Saved explanation");
    expect(changes.cardState(removed)?.view.detail).toBe("Saved explanation");
    expect(view().result!.added![0]!.explanation?.status).toBe("current");
    expect(view().result!.removed![0]!.explanation?.status).toBe("current");
    expect(provider.requests).toBe(requests);
  });

  it("leaves uncached details collapsed when returning to a saved diff", async () => {
    const { changes, provider, view } = await cardSession();
    const id = view().result!.added![0]!.id;
    changes.clear();
    await changes.show(headOf("functions.ts"), uri("file", "functions.ts"));
    expect(changes.cardState(id)).toBeUndefined();
    expect(view().result!.added![0]!.explanation).toBeUndefined();
    expect(provider.requests).toBe(1);
  });

  it("does not attach a late cache lookup after leaving the diff", async () => {
    const { changes, provider, service, view } = await cardSession();
    const id = view().result!.added![0]!.id;
    await changes.explainCard(id);
    const requests = provider.requests;
    changes.clear();
    const lookup = service.findCachedExplanation.bind(service);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(service, "findCachedExplanation").mockImplementation(async (...args) => {
      started();
      await gate;
      return lookup(...args);
    });
    const opening = changes.show(headOf("functions.ts"), uri("file", "functions.ts"));
    await entered;
    changes.clear();
    release();
    await opening;
    expect(changes.cardStates()).toEqual([]);
    expect(changes.active).toBe(false);
    expect(provider.requests).toBe(requests);
  });

  it("does not request details from showing, rendering, refreshing, prefetch or comparison generation", async () => {
    const { changes, provider, view } = await cardSession();
    expect(provider.requests).toBe(1);
    expect(view().result?.added?.[0]?.name).toBe("added");
    expect(view().result?.removed?.[0]?.name).toBe("removed");
    expect(changes.cardStates()).toEqual([]);
    view(); view(); await changes.refresh(); await changes.prefetch();
    expect(provider.requests).toBe(1);
    expect(changes.cardStates()).toEqual([]);
    const id = view().result!.removed![0]!.id;
    await changes.explainCard(id);
    expect(provider.requests).toBe(2);
    expect(changes.cardState(id)?.view.status).toBe("current");
    expect(changes.cardState(id)?.value.target.source).toContain("'old'");
    expect(changes.cardState(id)?.scope?.side.identity).toMatch(/^revision:/);
    await changes.refresh();
    expect(changes.cardState(id)?.view.status).toBe("current");
    expect(provider.requests).toBe(2);
  });

  it("uses the normal cache for a working-side addition without a follow-up file-summary request", async () => {
    const { changes, provider, service, view } = await cardSession();
    const id = view().result!.added![0]!.id;
    await changes.explainCard(id);
    const state = changes.cardState(id)!;
    expect(state.view.status).toBe("current");
    expect(state.scope).toBeUndefined();
    expect(await service.findCachedExplanation(root, state.value.target, state.value.document)).toBeDefined();
    expect((await service.readCache(root)).fileSummaries).toBeUndefined();
    const requests = provider.requests;
    await changes.explainCard(id);
    expect(provider.requests).toBe(requests);
  });

  it("rejects stale card ids after snapshot edits or switching away, with no extra requests", async () => {
    const { changes, provider, view } = await cardSession();
    const id = view().result!.removed![0]!.id;
    await writeFile(join(root, "functions.ts"), "export function other() {}\n");
    await changes.refresh();
    await changes.explainCard(id);
    expect(changes.hasCard(id)).toBe(false);
    expect(provider.requests).toBe(1);
    changes.clear();
    await changes.explainCard(id);
    expect(provider.requests).toBe(1);
  });

  it("refuses a document/snapshot mismatch without sending detail source", async () => {
    const { changes, provider, view } = await cardSession();
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({ getText: () => "wrong revision" } as vscode.TextDocument);
    const id = view().result!.removed![0]!.id;
    await changes.explainCard(id);
    expect(provider.requests).toBe(1);
    expect(view().result?.removed?.[0]).toMatchObject({ canExplain: false, note: expect.stringContaining("does not match") });
  });

  it("rejects a moving HEAD before card dispatch, without mistaking the new original for historical evidence", async () => {
    const { changes, provider, view } = await cardSession();
    const id = view().result!.removed![0]!.id;
    git("add", "functions.ts"); git("commit", "-q", "-m", "HEAD moved");
    await changes.explainCard(id);
    expect(provider.requests).toBe(1);
    expect(view().result?.removed?.[0]?.note).toContain("snapshot changed");
  });

  it("explains index-side additions in isolated snapshot mode, never from the working file", async () => {
    const { changes, provider, service, view } = await cardSession();
    git("add", "functions.ts");
    await changes.show(headOf("functions.ts"), uri("git", "functions.ts", JSON.stringify({ path: join(root, "functions.ts"), ref: "" })));
    await changes.explain();
    const id = view().result!.added![0]!.id;
    await writeFile(join(root, "functions.ts"), "export function workingOnly() {}\n");
    await changes.explainCard(id);
    expect(changes.cardState(id)?.view.status).toBe("current");
    expect(changes.cardState(id)?.scope?.side.identity).toBe("index");
    expect(changes.cardState(id)?.value.target.source).toContain("'new'");
    expect((await service.readCache(root)).overview).toBeNull();
    expect(provider.requests).toBe(3);
  });

  it.each(["cancel", "clear", "refresh"] as const)("deduplicates clicks and cancels card work on %s", async (action) => {
    const { changes, provider, service, view } = await cardSession();
    const id = view().result!.removed![0]!.id;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const explain = provider.explainFunction.bind(provider);
    vi.spyOn(provider, "explainFunction").mockImplementation(async (input, signal) => {
      entered(); await gate; return explain(input, signal);
    });
    const pending = changes.explainCard(id);
    await started;
    await changes.explainCard(id);
    expect(changes.busy).toBe(true);
    if (action === "cancel") changes.cancelCard(id);
    else if (action === "clear") changes.clear();
    else {
      await writeFile(join(root, "functions.ts"), "export function next() {}\n");
      await changes.refresh();
    }
    release(); await pending;
    expect(Object.keys((await service.readCache(root)).explanations)).toHaveLength(0);
    if (action === "cancel") expect(changes.cardState(id)?.view.status).toBe("cancelled");
  });
});

function session(onGenerate?: () => Promise<void>, options: Partial<Pick<ChangeSessionHost, "prefetch" | "schedule">> = {}) {
  const provider = new MockProvider();
  const sent: ComparisonPromptInput[] = [];
  const explain = provider.explainComparison.bind(provider);
  vi.spyOn(provider, "explainComparison").mockImplementation(async (input, signal) => {
    sent.push(input);
    await onGenerate?.();
    const result = await explain(input, signal);
    const functionId = input.catalogue?.entries.find((entry) => entry.category === "changed")?.id;
    const change = { functionId, title: "Value", before: "1", after: "2", when: "always", flow: "", original: { start: 1, end: 1 }, modified: { start: 1, end: 1 } };
    return { ...result, value: { ...result.value, changes: [change] } };
  });
  const service = new ExplanationService({
    store: new MemoryRepositoryCacheStore(),
    describeProvider: () => ({ kind: "mock", modelId: provider.modelId }),
    createProvider: async () => provider,
    authorizeExternalData: async () => true
  });
  const changes = new ChangeSession({
    service, reveal: async () => undefined, schedule: (task) => task(), changed: () => undefined,
    explanationView: (state, entryId) => ({ ...state.view, entryId }), ...options
  });
  return { changes, provider, sent, service };
}

function prefetchOptions(allowed = true) {
  return { enabled: vi.fn(() => true), allowed: vi.fn(async () => allowed), background: vi.fn() };
}

/** The production review/cache/visible-comparison path with deterministic request gates. */
describe("commit preparation in the shared review queue", () => {
  const gate = () => {
    let release!: () => void;
    return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
  };
  const prepare = async (onGenerate?: () => Promise<void>) => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    git("add", "."); git("commit", "-q", "-m", "selected");
    const scope = await commitScope(root, "HEAD");
    const { changes, service, provider, sent } = session(onGenerate);
    const items: ReviewItem[] = [];
    for (const file of scope.files) {
      const ref = commitComparisonRef(root, scope, file);
      const snapshot = await readComparison(ref);
      items.push({ path: file.path, file, ref, confirmed: snapshotSignature(snapshot), status: "pending" });
    }
    const completed = gate();
    const scheduler = new RequestScheduler(() => 2);
    const host: ReviewHost = {
      scheduler, read: (ref) => readComparison(ref),
      isCurrent: async (snapshot) => Boolean((await service.findComparison(snapshot))?.current),
      explain: async (snapshot, reread, signal) => {
        const saved = await service.explainComparison(snapshot, reread, signal);
        await changes.comparisonSaved(snapshot);
        return saved;
      },
      sharingAllowed: async () => vscode.workspace.isTrusted,
      readingPath: () => changes.path,
      background: () => undefined,
      changed: () => { if (items.every((item) => item.status === "done" || item.status === "pending" && review.stopped)) completed.release(); },
      stoppedWith: () => undefined
    };
    const review = new Review(host, root, "selected commit", items, "commit");
    const gitSide = (path: string, ref: string) => uri("git", path, JSON.stringify({ path: join(root, path), ref }));
    return { review, host, changes, provider, service, sent, scope, completed, gitSide };
  };

  it("updates a comparison already being read after background persistence and reuses native graph cache keys", async () => {
    const entered = gate();
    const release = gate();
    const { review, changes, provider, service, sent, scope, completed, gitSide } = await prepare(async () => { entered.release(); await release.promise; });
    const showing = changes.show(gitSide("a.txt", scope.parent), gitSide("a.txt", scope.commit));
    expect(changes.view(() => "link")?.reading).toBe(true);
    await showing;
    expect(changes.view(() => "link")?.reading).toBeUndefined();
    expect(changes.view(() => "link")?.status).toBe("ready");
    review.start();
    await entered.promise;
    // Today's checked-out file and HEAD are not part of the confirmed commit pair.
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    git("add", "."); git("commit", "-q", "-m", "later HEAD");
    release.release();
    await completed.promise;
    expect(sent).toMatchObject([{ original: { source: "export const a = 1;\n" }, modified: { source: "export const a = 2;\n" } }]);
    expect(changes.view(() => "link")?.status).toBe("current");
    expect((await service.findComparison(await readComparison(review.items[0]!.ref)))?.current).toBe(true);
    expect(changes.cardStates()).toEqual([]);
    expect(provider.requests).toBe(1);
    // Native pair cache misses outside that immutable set do not extend review.
    await changes.show(gitSide("a.txt", scope.commit), gitSide("a.txt", git("rev-parse", "HEAD")));
    await changes.refresh();
    await changes.prefetch();
    expect(changes.view(() => "link")?.status).toBe("ready");
    expect(provider.requests).toBe(1);
    expect(review.items).toHaveLength(1);
    review.cancel();
  });

  it("picks up a background save while the initial cache lookup is still loading", async () => {
    const { review, changes, service, provider, scope, gitSide } = await prepare();
    const entered = gate();
    const release = gate();
    const lookup = service.findComparison.bind(service);
    vi.spyOn(service, "findComparison").mockImplementationOnce(async (snapshot) => {
      const missing = await lookup(snapshot);
      entered.release();
      await release.promise;
      return missing;
    });
    const opening = changes.show(gitSide("a.txt", scope.parent), gitSide("a.txt", scope.commit));
    await entered.promise;
    const snapshot = await readComparison(review.items[0]!.ref);
    await service.explainComparison(snapshot, () => readComparison(review.items[0]!.ref));
    await changes.comparisonSaved(snapshot);
    release.release();
    await opening;
    expect(changes.view(() => "link")?.status).toBe("current");
    expect(provider.requests).toBe(1);
    review.cancel();
  });

  it.each(["before commit", "after commit"] as const)("cancellation %s respects the shared persistence commit point", async (when) => {
    const entered = gate();
    const release = gate();
    const prepared = await prepare(when === "before commit" ? async () => { entered.release(); await release.promise; } : undefined);
    const { review, host, service } = prepared;
    if (when === "after commit") {
      const explain = host.explain;
      host.explain = async (...args) => {
        const saved = await explain(...args);
        // Atomic persistence has returned success, but the queue hasn't received it yet.
        review.cancel();
        return saved;
      };
    }
    const work = review.explainNow(review.items[0]!);
    if (when === "before commit") {
      await entered.promise;
      review.cancel();
      release.release();
    }
    await work;
    expect(review.items[0]!.status).toBe(when === "before commit" ? "pending" : "done");
    expect(Boolean((await service.findComparison(await readComparison(review.items[0]!.ref)))?.current)).toBe(when === "after commit");
    review.cancel();
  });

  it("rechecks trust and historical-path exclusions before sending, without expanding the set", async () => {
    const { review, host, provider } = await prepare();
    host.read = (ref) => readComparison(ref, { exclusion: async () => "blocked after confirmation" });
    await review.explainNow(review.items[0]!);
    expect(review.items[0]!.status).toBe("outdated");
    expect(provider.requests).toBe(0);
    review.items[0]!.status = "pending";
    workspace.isTrusted = false;
    review.start();
    // sharingAllowed's false result stops the queue before it reads or sends.
    await preparedStop(review, host);
    expect(provider.requests).toBe(0);
    review.cancel();
  });
});

async function preparedStop(review: Review, host: ReviewHost): Promise<void> {
  if (review.stopped) return;
  await new Promise<void>((resolve) => {
    const changed = host.changed;
    host.changed = () => { changed(); if (review.stopped) resolve(); };
  });
}

describe("the shown native diff", () => {
  it("only looks up a saved explanation when shown or refreshed", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes, provider } = session();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.refresh();
    expect(changes.view(() => "id")?.status).toBe("ready");
    expect(provider.requests).toBe(0);
  });

  it("preloads a diff with background priority and a marked no-prompt signal when opted in", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const prefetch = prefetchOptions();
    const priorities: Array<string | undefined> = [];
    const { changes, provider } = session(undefined, {
      prefetch,
      schedule: (task, priority) => { priorities.push(priority); return task(); }
    });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("current"));
    expect(provider.requests).toBe(1);
    expect(priorities).toEqual(["prefetch"]);
    expect(prefetch.allowed).toHaveBeenCalledWith(root);
    expect(prefetch.background).toHaveBeenCalledWith(expect.any(AbortSignal));

    changes.clear();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    expect(changes.view(() => "id")?.status).toBe("current");
    expect(provider.requests).toBe(1);
  });

  it.each(["disabled", "unapproved", "untrusted"] as const)("sends nothing when prefetch is %s", async (reason) => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const prefetch = prefetchOptions(reason !== "unapproved");
    prefetch.enabled.mockReturnValue(reason !== "disabled");
    workspace.isTrusted = reason !== "untrusted";
    const { changes, provider } = session(undefined, { prefetch });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.busy).toBe(false));
    expect(provider.requests).toBe(0);
    expect(changes.view(() => "id")?.message ?? "").not.toContain("not approved");
  });

  it("can start after enabling prefetch or granting sharing approval while the diff is shown", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const prefetch = prefetchOptions(false);
    const { changes, provider } = session(undefined, { prefetch });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.busy).toBe(false));
    prefetch.allowed.mockResolvedValue(true);
    await changes.prefetch();
    expect(changes.view(() => "id")?.status).toBe("current");
    expect(provider.requests).toBe(1);
  });

  it("does not regenerate on edits, refreshes, or repeated show events", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes, provider } = session(undefined, { prefetch: prefetchOptions() });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("current"));
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    await changes.refresh();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.prefetch();
    expect(changes.view(() => "id")?.status).toBe("outdated");
    expect(provider.requests).toBe(1);
  });

  it("surfaces a failed prefetch without automatically retrying it", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes, sent } = session(async () => { throw new Error("Invalid JSON"); }, { prefetch: prefetchOptions() });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("failed"));
    await changes.refresh();
    await changes.prefetch();
    expect(changes.view(() => "id")?.message).toBe("Invalid JSON");
    expect(sent).toHaveLength(1);
  });

  it.each(["disabled", "switched", "refreshed", "cancelled"] as const)(
    "drops a queued prefetch when %s before a request slot opens",
    async (reason) => {
      await writeFile(join(root, "a.txt"), "export const a = 2;\n");
      const prefetch = prefetchOptions();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const queued = vi.fn();
      const { changes, provider } = session(undefined, {
        prefetch,
        schedule: async (task) => { queued(); await gate; return task(); }
      });
      await changes.show(headOf("a.txt"), uri("file", "a.txt"));
      await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce());
      if (reason === "disabled") prefetch.enabled.mockReturnValue(false);
      else if (reason === "switched") changes.clear();
      else if (reason === "refreshed") await changes.refresh();
      else changes.cancel();
      release();
      await vi.waitFor(() => expect(changes.busy).toBe(false));
      expect(provider.requests).toBe(0);
    }
  );

  it("rejects a prefetched comparison if either source changes during generation", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes } = session(async () => {
      await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    }, { prefetch: prefetchOptions() });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("failed"));
    expect(changes.view(() => "id")?.message).toContain("changed while");
    expect(changes.view(() => "id")?.result).toBeUndefined();
  });

  it("explains what HEAD is when asked, not the commit it named when the diff was shown", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    git("add", "a.txt");
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    const { changes, sent } = session();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    git("commit", "-q", "-m", "two");
    await changes.explain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.original.source).toBe("export const a = 2;\n");
    expect(sent[0]!.modified.source).toBe("export const a = 3;\n");
    expect(changes.view(() => "id")?.status).toBe("current");
  });

  it("discards a result when HEAD moves while it is generated", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    git("add", "a.txt");
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    const { changes } = session(async () => { git("commit", "-q", "-m", "two"); });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.explain();
    const view = changes.view(() => "id");
    expect(view?.status).toBe("failed");
    expect(view?.message).toContain("changed while");
    expect(view?.result).toBeUndefined();
  });

  it("hides line links of an explanation once either version changed", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes } = session();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.explain();
    const links = (view: ReturnType<typeof changes.view>) => view?.result?.changes.flatMap((change) => change.links) ?? [];
    const current = changes.view(() => "id");
    expect(current?.result?.outdated).toBeUndefined();
    expect(links(current).map((link) => link.caption)).toEqual(["Original line 1", "Modified line 1"]);
    await writeFile(join(root, "a.txt"), "export const a = 2;\n\n");
    await changes.refresh();
    const view = changes.view(() => "id");
    expect(view?.status).toBe("outdated");
    expect(view?.result?.outdated).toBe(true);
    expect(links(view)).toEqual([]);
  });

  it("adds paired visual views with navigation ids checked against each exact side", async () => {
    await writeFile(join(root, "a.ts"), "export function a() {\n return 1;\n}\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "function");
    await writeFile(join(root, "a.ts"), "export function a() {\n return 2;\n}\n");
    const opened: string[] = [];
    const { service } = session();
    const changes = new ChangeSession({
      service,
      reveal: async (target, start, end, side) => { opened.push(`${side}:${target.scheme}:${start}-${end}`); },
      schedule: (task) => task(),
      changed: () => undefined
    });
    await changes.show(headOf("a.ts"), uri("file", "a.ts"));
    await changes.explain();

    const callbacks = new Map<string, () => Promise<void>>();
    const view = changes.view((open) => {
      const id = `ref-${callbacks.size}`;
      callbacks.set(id, open);
      return id;
    });
    const visual = view?.result?.visualScopes?.[0];
    if (!visual) throw new Error("Expected the saved comparison to include paired visual data.");
    expect(visual?.scope.original.steps).toHaveLength(1);
    expect(visual?.scope.modified.pseudocode).toHaveLength(1);
    const originalStep = visual.scope.original.steps[0];
    if (!originalStep) throw new Error("Expected an original-side step.");
    const occurrenceId = originalStep.occurrenceId;
    const reference = visual.originalLinks[occurrenceId];
    if (!reference) throw new Error("Expected a host-validated original-side link.");
    await callbacks.get(reference)?.();
    expect(opened).toEqual(["original:git:1-3"]);
    const modifiedStep = visual.scope.modified.steps[0];
    if (!modifiedStep) throw new Error("Expected a modified-side step.");
    expect(visual.modifiedLinks[modifiedStep.occurrenceId]).toBeTruthy();
    await callbacks.get(visual.modifiedLinks[modifiedStep.occurrenceId]!)?.();
    expect(opened).toEqual(["original:git:1-3", "modified:file:1-3"]);
    const changed = view?.result?.changes[0];
    expect(changed).toMatchObject({ functionName: "a", kindLabel: "Function" });
    const functionReference = changed?.functionLink?.referenceId;
    if (!functionReference) throw new Error("Expected a host-owned changed function link.");
    await callbacks.get(functionReference)?.();
    expect(opened.at(-1)).toBe("modified:file:1-3");

    await writeFile(join(root, "a.ts"), "export function a() {\n return 3;\n}\n");
    await expect(callbacks.get(functionReference)?.()).rejects.toThrow("comparison changed");
    await changes.refresh();
    expect(changes.view(() => "stale")?.result?.visualScopes?.[0]?.originalLinks).toEqual({});
    expect(changes.view(() => "stale")?.result?.changes[0]?.functionLink).toBeUndefined();
  });
});
