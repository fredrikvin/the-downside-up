import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRepositoryCacheStore, MemoryRepositoryCacheStore, type RepositoryCacheStore } from "../src/cache/store";
import { cachedUsage } from "../src/cache/usage";
import { fingerprint } from "../src/core/fingerprint";
import type { ComparisonRecord, RepositoryCache } from "../src/core/types";
import { ExplanationService } from "../src/controller";
import { snapshotSignature, type ComparisonRef, type ComparisonSnapshot } from "../src/context/comparison";
import {
  buildReviewSummaryRequest, reviewComparisonKey, reviewSummaryScopeKey, type ReviewSummaryScope
} from "../src/context/reviewSummary";
import { MockProvider } from "../src/generation/mock";
import { COMPARISON_PROMPT_VERSION, reviewSummaryPrompt } from "../src/generation/prompts";
import { parseReviewSummary } from "../src/generation/schema";
import { workspace } from "./vscode";

const policy = vi.hoisted(() => ({ exclusion: undefined as string | undefined, restriction: undefined as string | undefined }));
vi.mock("../src/context/inventory", () => ({
  sharingExclusion: vi.fn(async () => policy.exclusion),
  gatherInventory: vi.fn(() => { throw new Error("Summary must not gather repository context."); })
}));
vi.mock("../src/context/policy", () => ({
  currentPolicy: async () => ({ repositoryRestriction: async () => policy.restriction })
}));

const root = "/review-summary";
const hash = "a".repeat(40);
const functions = { kind: "openai" as const, modelId: "Functions" };
const overview = { kind: "openai" as const, modelId: "Overview" };
const ref = (path = "a.ts"): ComparisonRef => ({
  root, original: { path, source: { kind: "revision", hash } }, modified: { path, source: { kind: "working" } }
});
const snapshot = (reference = ref(), text = "raw modified source"): ComparisonSnapshot => ({
  root,
  original: { path: reference.original.path, identity: `revision:${hash}`, state: "present", detail: "",
    text: "raw original source", fingerprint: fingerprint("raw original source"), lines: 1 },
  modified: { path: reference.modified.path, identity: "working", state: "present", detail: "",
    text, fingerprint: fingerprint(text), lines: 1 }
});
function scopeFor(references = [ref()]): ReviewSummaryScope {
  return {
    kind: "working", root, base: hash,
    items: references.map((reference) => ({
      path: reference.modified.path, ref: reference, confirmed: snapshotSignature(snapshot(reference))
    }))
  };
}
function comparison(source = snapshot()): ComparisonRecord {
  return {
    original: source.original, modified: source.modified,
    catalogue: { version: 1, fingerprint: "catalogue", classified: false, entries: [], limitations: [] },
    comparison: {
      summary: "The saved explanation reports a retry.",
      changes: [{ id: "retry", title: "Retry", before: "Stops", after: "Tries twice", when: "On failure",
        flow: "Retries before stopping", original: { start: 1, end: 1 }, modified: { start: 1, end: 1 } }],
      outside: "An import changed.", possibleEffects: ["More requests may be made."], limitations: ["Calls were not executed."]
    },
    provider: functions.kind, model: functions.modelId, promptVersion: COMPARISON_PROMPT_VERSION, savedAt: 1
  };
}
async function save(store: RepositoryCacheStore, source = snapshot(), change?: (record: ComparisonRecord) => ComparisonRecord) {
  const record = comparison(source);
  await store.update(root, (current) => ({
    ...current, comparisons: { ...current.comparisons, [reviewComparisonKey(source, functions)]: change ? change(record) : record }
  }));
}
function harness(store: RepositoryCacheStore = new MemoryRepositoryCacheStore()) {
  const provider = new MockProvider();
  const createProvider = vi.fn(async () => provider);
  const authorizeExternalData = vi.fn(async () => true);
  let functionsModel = functions;
  let overviewModel = overview;
  let limit = 96 * 1024;
  const read = vi.fn(async (reference: ComparisonRef) => snapshot(reference));
  const service = new ExplanationService({
    store, describeProvider: () => functionsModel, describeOverviewProvider: () => overviewModel,
    createProvider, authorizeExternalData, maxRequestBytes: () => limit
  });
  return {
    store, provider, service, read, createProvider, authorizeExternalData,
    setFunctionsModel: (modelId: string) => { functionsModel = { ...functions, modelId }; },
    setOverviewModel: (modelId: string) => { overviewModel = { ...overview, modelId }; },
    setLimit: (value: number) => { limit = value; }
  };
}
const abortSignal = () => new AbortController().signal;
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
class GatedStore extends MemoryRepositoryCacheStore {
  beforeCommit?: () => Promise<void>;
  afterCommit?: () => void;
  override async update(
    repository: string, updater: (current: RepositoryCache) => RepositoryCache,
    signal?: AbortSignal, validate?: () => Promise<void>
  ): Promise<RepositoryCache> {
    const saved = await super.update(repository, updater, signal, async () => {
      await this.beforeCommit?.();
      await validate?.();
    });
    this.afterCommit?.();
    return saved;
  }
}

beforeEach(() => {
  policy.exclusion = undefined;
  policy.restriction = undefined;
  Object.assign(workspace, { isTrusted: true });
});
afterEach(() => vi.restoreAllMocks());

describe("cache-only review summary preparation", () => {
  it("requires model setup before touching an invalid scope, sources, cache or consent", async () => {
    const store = new MemoryRepositoryCacheStore();
    const readCache = vi.spyOn(store, "read");
    const createProvider = vi.fn();
    const authorizeExternalData = vi.fn();
    const read = vi.fn();
    const service = new ExplanationService({
      store, describeProvider: () => ({ kind: "vscode-lm", modelId: "" }),
      describeOverviewProvider: () => overview, createProvider, authorizeExternalData
    });
    await expect(service.summarizeReview(undefined as never, read, abortSignal())).rejects.toMatchObject({ name: "ModelSetupRequired" });
    expect(readCache).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
    expect(authorizeExternalData).not.toHaveBeenCalled();
  });
  it("does not generate or authorize on any cache miss, including zero evidence", async () => {
    const h = harness();
    const prepared = await h.service.prepareReviewSummary(scopeFor(), h.read);
    expect(prepared).toMatchObject({
      current: false, canGenerate: false, evidence: [],
      coverage: { total: 1, included: 0, unavailable: 1, omitted: 0 }
    });
    await expect(h.service.summarizeReview(scopeFor(), h.read, abortSignal())).rejects.toThrow("Explain changes");
    expect(h.provider.requests).toBe(0);
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.authorizeExternalData).not.toHaveBeenCalled();
    expect((await h.store.read(root)).overview).toBeNull();
  });

  it("uses only current saved text and never source, spans, visuals or catalogue in the request", async () => {
    const h = harness();
    await save(h.store);
    const summarize = vi.spyOn(h.provider, "summarizeReview");
    const prepared = await h.service.summarizeReview({ ...scopeFor(), excluded: 2, skipped: 3, truncated: true }, h.read, abortSignal());
    const input = summarize.mock.calls[0]![0];
    expect(JSON.stringify(input)).not.toContain("raw original source");
    expect(JSON.stringify(input)).not.toContain("raw modified source");
    expect(JSON.stringify(input)).not.toContain("fingerprint");
    expect(JSON.stringify(input)).not.toContain("startLine");
    expect(JSON.stringify(input)).not.toContain("catalogue");
    expect(input.files[0]!.changes[0]).toEqual({
      title: "Retry", before: "Stops", after: "Tries twice", when: "On failure", flow: "Retries before stopping"
    });
    expect(h.createProvider).toHaveBeenCalledExactlyOnceWith(overview);
    expect(h.authorizeExternalData).toHaveBeenCalledWith(root, overview, expect.any(Number), expect.any(AbortSignal));
    expect(prepared).toMatchObject({ current: true, canGenerate: true, coverage: { included: 1 } });
    expect(prepared.record?.value.limitations.join(" ")).toContain("2 excluded");
    expect(prepared.record?.value.limitations.join(" ")).toContain("3 skipped");
    expect(prepared.record?.value.limitations.join(" ")).toContain("truncated");
    expect(prepared.record).toMatchObject({ provider: "openai", model: "Overview", usage: expect.any(Object) });
    expect(prepared.evidence[0]?.id).toBe(input.files[0]!.id);
    expect(prepared.evidence[0]?.ref).toEqual(ref());
    expect((await h.store.read(root)).overview).toBeNull();
    const usage = cachedUsage(await h.store.read(root));
    expect(usage.models).toContainEqual(expect.objectContaining({ role: "Overview", provider: "openai", model: "Overview" }));
    await h.service.summarizeReview({ ...scopeFor(), excluded: 2, skipped: 3, truncated: true }, h.read, abortSignal());
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("retains a stale record and its frozen navigation IDs without generating", async () => {
    const h = harness();
    await save(h.store);
    const first = await h.service.summarizeReview(scopeFor(), h.read, abortSignal());
    h.read.mockImplementation(async (reference) => snapshot(reference, "changed source"));
    const prepared = await h.service.prepareReviewSummary(scopeFor(), h.read);
    expect(prepared.current).toBe(false);
    expect(prepared.canGenerate).toBe(false);
    expect(prepared.coverage.unavailable).toBe(1);
    expect(prepared.record).toEqual(first.record);
    expect(prepared.evidence).toEqual(first.record?.evidence);
    expect(h.provider.requests).toBe(1);
    h.read.mockImplementation(async (reference) => snapshot(reference));
    h.setOverviewModel("new Overview");
    expect((await h.service.prepareReviewSummary(scopeFor(), h.read)).current).toBe(false);
  });

  it("selects whole entries in stable path order and counts available omissions", async () => {
    const h = harness();
    const refs = [ref("z.ts"), ref("a.ts"), ref("m.ts")];
    for (const reference of refs) await save(h.store, snapshot(reference));
    const scope = scopeFor(refs);
    const build = (limit: number, candidate = scope) => h.store.read(root).then((cache) =>
      buildReviewSummaryRequest(candidate, cache, functions, overview, h.read, async () => true, limit));
    const all = await build(100_000);
    const onlyOne = await build(all.bytes - 200);
    expect(onlyOne.evidence.length).toBeGreaterThan(0);
    expect(onlyOne.evidence.length).toBeLessThan(3);
    expect(onlyOne.evidence[0]?.path).toBe("a.ts");
    expect(onlyOne.input.coverage.omitted).toBe(3 - onlyOne.evidence.length);
    expect(onlyOne.bytes).toBeLessThanOrEqual(all.bytes - 200);
    const reversed = await build(100_000, { ...scope, items: [...scope.items].reverse() });
    expect(reversed.fingerprint).toBe(all.fingerprint);
    expect(reversed.evidence).toEqual(all.evidence);
    expect((await build(1)).input.coverage).toEqual({ total: 3, included: 0, unavailable: 0, omitted: 3 });
  });

  it("uses only the exact immutable sides of a commit scope", async () => {
    const h = harness();
    const reference: ComparisonRef = { ...ref(), modified: { path: "a.ts", source: { kind: "revision", hash: "b".repeat(40) } } };
    const source = { ...snapshot(reference), modified: { ...snapshot(reference).modified, identity: `revision:${"b".repeat(40)}` } };
    await save(h.store, source);
    h.read.mockResolvedValue(source);
    const scope: ReviewSummaryScope = {
      kind: "commit", root, base: hash,
      items: [{ path: "a.ts", ref: reference, confirmed: snapshotSignature(source) }]
    };
    const prepared = await h.service.summarizeReview(scope, h.read, abortSignal());
    expect(prepared.current).toBe(true);
    expect(prepared.record?.evidence[0]?.ref).toEqual(reference);
    h.read.mockResolvedValue(snapshot());
    expect((await h.service.prepareReviewSummary(scope, h.read)).canGenerate).toBe(false);
  });

  it.each(["wrong source", "wrong model", "old prompt", "missing catalogue", "wrong ref"])("rejects %s evidence without generation", async (problem) => {
    const h = harness();
    await save(h.store, snapshot(), (record) => {
      switch (problem) {
        case "wrong source": return { ...record, modified: { ...record.modified, fingerprint: "stale" } };
        case "wrong model": return { ...record, model: "another" };
        case "old prompt": return { ...record, promptVersion: "old" };
        case "missing catalogue": return { ...record, catalogue: undefined };
        default: return record;
      }
    });
    if (problem === "wrong ref") h.read.mockResolvedValue(snapshot(ref("elsewhere.ts")));
    expect((await h.service.prepareReviewSummary(scopeFor(), h.read)).canGenerate).toBe(false);
    expect(h.provider.requests).toBe(0);
  });

  it.each(["excluded", "restricted", "untrusted", "unreadable"])("refuses %s evidence", async (reason) => {
    const h = harness();
    await save(h.store);
    if (reason === "excluded") policy.exclusion = "excluded";
    if (reason === "restricted") policy.restriction = "restricted";
    if (reason === "untrusted") Object.assign(workspace, { isTrusted: false });
    if (reason === "unreadable") h.read.mockRejectedValue(new Error("Cannot read."));
    expect((await h.service.prepareReviewSummary(scopeFor(), h.read)).canGenerate).toBe(false);
    await expect(h.service.summarizeReview(scopeFor(), h.read, abortSignal())).rejects.toThrow();
    expect(h.authorizeExternalData).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("hides historical mock summaries in production without modifying cache", async () => {
    const h = harness();
    await save(h.store);
    const prepared = await h.service.summarizeReview(scopeFor(), h.read, abortSignal());
    await h.store.update(root, (current) => ({
      ...current, reviewSummaries: { [prepared.scopeKey]: { ...prepared.record!, provider: "mock" } }
    }));
    expect((await h.service.prepareReviewSummary(scopeFor(), h.read)).record).toBeUndefined();
    expect(Object.values((await h.store.read(root)).reviewSummaries!)[0]?.provider).toBe("mock");
  });

  it("validates references, duplicate pairs and bounds before reading sources", async () => {
    const h = harness();
    const scope = scopeFor();
    const invalid = [
      { ...scope, items: [...scope.items, ...scope.items] },
      { ...scope, items: Array.from({ length: 201 }, () => scope.items[0]!) },
      { ...scope, items: [{ ...scope.items[0]!, ref: { ...ref(), root: "/elsewhere" } }] },
      { ...scope, items: [{ ...scope.items[0]!, ref: { ...ref(), original: { path: "../secret", source: { kind: "working" as const } } } }] },
      { ...scope, items: [{ ...scope.items[0]!, ref: { ...ref(), original: { path: "a.ts", source: { kind: "revision" as const, hash: "HEAD" } } } }] },
      { ...scope, kind: "commit" as const },
      { ...scope, excluded: -1 }
    ];
    for (const candidate of invalid) {
      await expect(h.service.prepareReviewSummary(candidate, h.read)).rejects.toThrow();
      await expect(h.service.summarizeReview(candidate, h.read, abortSignal())).rejects.toThrow();
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.authorizeExternalData).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
  });
});

describe("review summary freshness and persistence", () => {
  it("uses Overview-model consent and honors a decline without generation", async () => {
    const h = harness();
    await save(h.store);
    h.authorizeExternalData.mockResolvedValue(false);
    await expect(h.service.summarizeReview(scopeFor(), h.read, abortSignal())).rejects.toMatchObject({ name: "AbortError" });
    expect(h.authorizeExternalData.mock.calls[0]?.slice(0, 2)).toEqual([root, overview]);
    expect(h.provider.requests).toBe(0);
    expect((await h.store.read(root)).reviewSummaries).toBeUndefined();
  });

  it.each(["source", "evidence", "model", "functions", "policy", "trust", "limit", "scope", "clear", "cancel"])("discards in-flight %s changes", async (change) => {
    const h = harness();
    await save(h.store);
    const scope = scopeFor();
    const controller = new AbortController();
    const started = gate();
    const release = gate();
    const original = h.provider.summarizeReview.bind(h.provider);
    vi.spyOn(h.provider, "summarizeReview").mockImplementation(async (input, signal) => {
      started.open();
      await release.promise;
      return original(input, signal);
    });
    const pending = h.service.summarizeReview(scope, h.read, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    switch (change) {
      case "source": h.read.mockImplementation(async (reference) => snapshot(reference, "changed")); break;
      case "evidence": await save(h.store, snapshot(), (record) => ({ ...record, savedAt: 2 })); break;
      case "model": h.setOverviewModel("changed"); break;
      case "functions": h.setFunctionsModel("changed"); break;
      case "policy": policy.exclusion = "new exclusion"; break;
      case "trust": Object.assign(workspace, { isTrusted: false }); break;
      case "limit": h.setLimit(2000); break;
      case "scope": Object.assign(scope, { excluded: 4 }); break;
      case "clear": await h.service.clearCache(root); break;
      case "cancel": controller.abort(); break;
    }
    release.open();
    await rejected;
    expect((await h.store.read(root)).reviewSummaries).toBeUndefined();
  });

  it("does not abort when previously unconsumed evidence finishes; frozen coverage is saved then marked outdated", async () => {
    const h = harness();
    const confirmed = scopeFor([ref("a.ts"), ref("b.ts")]);
    const scope = { ...confirmed, items: confirmed.items.map((item) => ({ ...item, status: "pending" })) };
    await save(h.store);
    const original = h.provider.summarizeReview.bind(h.provider);
    vi.spyOn(h.provider, "summarizeReview").mockImplementation(async (input, signal) => {
      scope.items[0]!.status = "done";
      scope.items[1]!.status = "explaining";
      await save(h.store, snapshot(ref("b.ts")));
      scope.items[1]!.status = "done";
      return original(input, signal);
    });
    const prepared = await h.service.summarizeReview(scope, h.read, abortSignal());
    expect(prepared.current).toBe(false);
    expect(prepared.coverage.included).toBe(2);
    expect(prepared.record?.coverage).toEqual({ total: 2, included: 1, unavailable: 1, omitted: 0 });
    expect(prepared.record?.evidence).toHaveLength(1);
    expect(prepared.record?.value.limitations.join(" ")).toContain("1 confirmed files");
  });

  it.each(["cancel", "source", "policy", "model"])("rechecks %s after the updater while the persistence lock is held", async (change) => {
    const store = new GatedStore();
    const h = harness(store);
    await save(store);
    const controller = new AbortController();
    store.beforeCommit = async () => {
      if (change === "cancel") controller.abort();
      if (change === "source") h.read.mockImplementation(async (reference) => snapshot(reference, "changed before commit"));
      if (change === "policy") policy.exclusion = "excluded at commit";
      if (change === "model") h.setOverviewModel("changed at commit");
    };
    await expect(h.service.summarizeReview(scopeFor(), h.read, controller.signal)).rejects.toThrow();
    expect((await store.read(root)).reviewSummaries).toBeUndefined();
  });

  it("checks locked comparison evidence after a queued replacement, without reentrant cache reads", async () => {
    const h = harness();
    await save(h.store);
    const originalUpdate = h.store.update.bind(h.store);
    let intercept = true;
    vi.spyOn(h.store, "update").mockImplementation(async (repository, update, signal, validate) => {
      if (intercept && signal) {
        intercept = false;
        await originalUpdate(repository, (current) => ({
          ...current, comparisons: Object.fromEntries(Object.entries(current.comparisons!).map(([key, value]) => [key, { ...value, savedAt: 7 }]))
        }));
      }
      return originalUpdate(repository, update, signal, validate);
    });
    await expect(h.service.summarizeReview(scopeFor(), h.read, abortSignal())).rejects.toThrow("saved file comparison changed");
    expect((await h.store.read(root)).reviewSummaries).toBeUndefined();
  });

  it("returns a saved success when cancellation happens after the commit point", async () => {
    const store = new GatedStore();
    const h = harness(store);
    await save(store);
    const controller = new AbortController();
    store.afterCommit = () => controller.abort();
    const prepared = await h.service.summarizeReview(scopeFor(), h.read, controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(prepared.current).toBe(true);
    expect((await store.read(root)).reviewSummaries?.[prepared.scopeKey]).toEqual(prepared.record);
  });

  it.each(["before", "after"])("honors cancellation %s the real atomic-rename commit point", async (when) => {
    const directory = await mkdtemp(join(tmpdir(), "downside-up-summary-"));
    class GatedFileStore extends FileRepositoryCacheStore {
      beforeCommit?: () => void;
      afterCommit?: () => void;
      protected override async persist(
        file: string, value: RepositoryCache, signal?: AbortSignal, validate?: () => Promise<void>
      ): Promise<void> {
        await super.persist(file, value, signal, async () => {
          this.beforeCommit?.();
          await validate?.();
        });
        this.afterCommit?.();
      }
    }
    try {
      const store = new GatedFileStore(directory);
      const h = harness(store);
      await store.update(root, (current) => ({
        ...current, comparisons: { [reviewComparisonKey(snapshot(), functions)]: comparison() }
      }));
      const controller = new AbortController();
      if (when === "before") store.beforeCommit = () => controller.abort();
      else store.afterCommit = () => controller.abort();
      const pending = h.service.summarizeReview(scopeFor(), h.read, controller.signal);
      if (when === "before") {
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect((await store.read(root)).reviewSummaries).toBeUndefined();
      } else {
        const prepared = await pending;
        expect(prepared.current).toBe(true);
        expect((await store.read(root)).reviewSummaries?.[prepared.scopeKey]).toEqual(prepared.record);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid provider references without persisting or a repair call", async () => {
    const h = harness();
    await save(h.store);
    vi.spyOn(h.provider, "summarizeReview").mockResolvedValue({
      provider: "mock", usage: { inputTokens: 1, outputTokens: 1, estimated: true },
      value: { summary: "Unsupported", themes: [{ title: "Theme", text: "Text", fileIds: ["invented"] }], possibleEffects: [], limitations: [] }
    });
    await expect(h.service.summarizeReview(scopeFor(), h.read, abortSignal())).rejects.toThrow("unknown");
    expect(h.provider.summarizeReview).toHaveBeenCalledTimes(1);
    expect((await h.store.read(root)).reviewSummaries).toBeUndefined();
  });
});

describe("review summary response and prompt", () => {
  const valid = {
    summary: "Reported changes.", themes: [{ title: "Retries", text: "Reported retries.", fileIds: ["file-a"] }],
    possibleEffects: ["May increase load."], limitations: ["Saved AI explanations only."]
  };
  it("bounds all output and rejects unknown, duplicate or absent theme references", () => {
    expect(parseReviewSummary(valid, ["file-a"])).toEqual(valid);
    for (const invalid of [
      { ...valid, summary: "x".repeat(3001) },
      { ...valid, summary: "" },
      { ...valid, themes: Array.from({ length: 13 }, () => valid.themes[0]) },
      { ...valid, themes: [{ ...valid.themes[0], title: "x".repeat(161) }] },
      { ...valid, themes: [{ ...valid.themes[0], text: "x".repeat(2001) }] },
      { ...valid, themes: [{ ...valid.themes[0], fileIds: ["unknown"] }] },
      { ...valid, themes: [{ ...valid.themes[0], fileIds: ["file-a", "file-a"] }] },
      { ...valid, themes: [{ ...valid.themes[0], fileIds: [] }] },
      { ...valid, possibleEffects: Array(21).fill("effect") },
      { ...valid, limitations: ["x".repeat(1501)] }
    ]) expect(() => parseReviewSummary(invalid, ["file-a"])).toThrow();
  });
  it("explicitly describes synthesis and incomplete coverage, never an independent code review", () => {
    const [system, user] = reviewSummaryPrompt({ coverage: { total: 2, included: 1, unavailable: 1, omitted: 0 }, files: [], limitations: [] });
    expect(system).toContain("untrusted AI explanations");
    expect(system).toContain("NOT an independent code review");
    expect(system).toContain("Do not invent certainty, intent");
    expect(JSON.parse(user).coverage.unavailable).toBe(1);
    expect(reviewSummaryScopeKey(scopeFor())).toBe(reviewSummaryScopeKey(scopeFor()));
  });
});
