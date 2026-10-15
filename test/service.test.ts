import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRepositoryCacheStore, MemoryRepositoryCacheStore } from "../src/cache/store";
import type { FunctionTarget } from "../src/core/types";
import { ExplanationService } from "../src/controller";
import { MockProvider } from "../src/generation/mock";
import { COMPONENT_GUIDANCE } from "../src/languages/javascript/guidance";
import { initializeJavaScriptParsersAt } from "../src/languages/javascript/syntax";
import { Range, Position, Uri } from "./vscode";

const harness = vi.hoisted(() => ({
  functionHash: "function-v1",
  storageHash: "storage-v1",
  unrelatedHash: "unrelated-v1",
  gitHeadHash: "head-main",
  primedPaths: ["README.md"],
  source: "export function checkout(catalog, title) { return catalog.find(title); }",
  gatherInventory: undefined as unknown as (...args: unknown[]) => unknown,
  gatherFunctionContext: undefined as unknown as (...args: unknown[]) => unknown,
  exclusion: undefined as string | undefined
}));

vi.mock("../src/context/inventory", () => ({
  gatherInventory: (...args: unknown[]) => harness.gatherInventory(...args),
  sharingExclusion: async () => harness.exclusion
}));
vi.mock("../src/context/related", () => ({
  gatherFunctionContext: (...args: unknown[]) => harness.gatherFunctionContext(...args)
}));

const root = resolve("fixtures/js-app");
const documentUri = Uri.file(resolve(root, "src/checkout.js"));

function makeInventory(_root: string, previous?: Record<string, string>) {
  const snapshot: Record<string, string> = {
    "README.md": "readme-v1",
    "src/checkout.js": harness.functionHash,
    "src/storage.js": harness.storageHash,
    "src/unrelated.js": harness.unrelatedHash,
    "\0git-head": harness.gitHeadHash
  };
  const changedPaths = [...new Set([
    ...Object.keys(previous ?? {}),
    ...Object.keys(snapshot)
  ])]
    .filter((path) => previous?.[path] !== snapshot[path])
    .map((path) => path === "\0git-head" ? "[Git branch/HEAD]" : path);
  return {
    root,
    name: "js-app",
    files: [],
    snapshot,
    primedPaths: [...harness.primedPaths],
    inventoryText: "--- README.md ---\nA tiny library checkout fixture.",
    languageIds: ["javascript"],
    limitations: [],
    changedPaths,
    outline: [{ path: "", files: 3, markers: ["README"] }, { path: "src", files: 2, markers: ["package.json"] }],
    folders: new Set(["src"])
  };
}

function makeContext(target: FunctionTarget) {
  const selectedPath = "src/checkout.js";
  const relatedPath = "src/storage.js";
  return {
    inputs: [
      { path: selectedPath, description: "selected checkout", fingerprint: harness.functionHash },
      { path: relatedPath, description: "related storage declaration", fingerprint: harness.storageHash }
    ],
    sourceReferences: [{
      id: "selected-function",
      path: selectedPath,
      line: 0,
      startCharacter: 16,
      endCharacter: 24,
      description: "Selected function checkout"
    }],
    referenceUris: new Map([["selected-function", target.uri]]),
    text: `${harness.source}\n\npersist(book);`,
    limitations: []
  };
}

function setHarness(): void {
  harness.functionHash = "function-v1";
  harness.storageHash = "storage-v1";
  harness.unrelatedHash = "unrelated-v1";
  harness.gitHeadHash = "head-main";
  harness.primedPaths = ["README.md"];
  harness.exclusion = undefined;
  harness.source = "export function checkout(catalog, title) { return catalog.find(title); }";
  harness.gatherInventory = (...args: unknown[]) =>
    makeInventory(args[0] as string, args[1] as Record<string, string> | undefined);
  harness.gatherFunctionContext = (...args: unknown[]) =>
    makeContext(args[0] as FunctionTarget);
}

function target(): FunctionTarget {
  const functionRange = new Range(new Position(0, 0), new Position(0, 90));
  return {
    uri: documentUri,
    range: functionRange,
    selection: new Range(new Position(0, 16), new Position(0, 24)),
    languageId: "javascript",
    name: "checkout",
    qualifiedName: "checkout",
    signature: "checkout(catalog, title)",
    source: harness.source,
    symbolId: "symbol-checkout",
    structuralFingerprint: harness.functionHash,
    analysis: "vscode-symbols"
  } as unknown as FunctionTarget;
}

function otherTarget(): FunctionTarget {
  return {
    ...target(),
    name: "describeCatalog",
    qualifiedName: "describeCatalog",
    symbolId: "symbol-describe-catalog",
    source: "export function describeCatalog(catalog) { return catalog.length; }",
    structuralFingerprint: "describe-catalog-v1"
  } as FunctionTarget;
}

const fakeDocument = {
  uri: documentUri,
  languageId: "javascript",
  version: 1,
  getText: () => harness.source
} as unknown as import("vscode").TextDocument;

function createService(
  store: MemoryRepositoryCacheStore | FileRepositoryCacheStore,
  provider: MockProvider,
  authorized = true,
  formats: Array<"pseudocode" | "flowchart"> = []
): ExplanationService {
  return new ExplanationService({
    store,
    describeProvider: () => ({ kind: "mock", modelId: provider.modelId }),
    createProvider: async () => provider,
    authorizeExternalData: async () => authorized,
    explanationFormats: () => formats
  });
}

describe("ExplanationService", () => {
  beforeEach(() => setHarness());
  afterEach(() => vi.restoreAllMocks());

  it("counts saved cache records across models without checking source or calling a provider", async () => {
    const store = new MemoryRepositoryCacheStore();
    const provider = new MockProvider();
    const service = createService(store, provider);
    expect(await service.cacheStats(root)).toEqual({ explanations: 0, fileSummaries: 0, folderSummaries: 0, flows: 0 });
    await service.explain(root, target(), fakeDocument);
    await service.summarizeFile(root, fakeDocument);
    await store.update(root, (cache) => {
      const record = Object.values(cache.explanations)[0]!;
      const summary = Object.values(cache.fileSummaries!)[0]!;
      return {
        ...cache,
        explanations: { ...cache.explanations, "other-model": { ...record, explanationConfig: "another model" } },
        fileSummaries: { ...cache.fileSummaries, "other-model": { ...summary, model: "other" } },
        folderSummaries: { folder: { path: "", value: { summary: "A folder", overview: "", parts: [] }, fingerprint: "old", provider: "mock", model: "other", promptVersion: "old", savedAt: 1 } },
        projectFlows: { flows: { path: "", flows: [], fingerprint: "old", provider: "mock", model: "other", promptVersion: "old", savedAt: 1 } }
      };
    });
    const inventory = vi.fn(harness.gatherInventory);
    const related = vi.fn(harness.gatherFunctionContext);
    harness.gatherInventory = inventory;
    harness.gatherFunctionContext = related;
    const requests = provider.requests;
    expect(await service.cacheStats(root)).toEqual({ explanations: 2, fileSummaries: 2, folderSummaries: 1, flows: 1, mapSavedAt: expect.any(Number) });
    expect(inventory).not.toHaveBeenCalled();
    expect(related).not.toHaveBeenCalled();
    expect(provider.requests).toBe(requests);
    await service.clearCache(root);
    expect(await service.cacheStats(root)).toEqual({ explanations: 0, fileSummaries: 0, folderSummaries: 0, flows: 0 });
  });

  it("notifies the header after a successful disk-cache write or clear, not after reads", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "downside-up-stats-"));
    const changed = vi.fn();
    try {
      const store = new FileRepositoryCacheStore(directory, changed);
      const service = createService(store, new MockProvider());
      await service.cacheStats(root);
      expect(changed).not.toHaveBeenCalled();
      await service.explain(root, target(), fakeDocument);
      expect(changed).toHaveBeenCalledWith(root);
      changed.mockClear();
      await service.cacheStats(root);
      expect(changed).not.toHaveBeenCalled();
      await service.clearCache(root);
      expect(changed).toHaveBeenCalledExactlyOnceWith(root);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("primes before explaining, then revisits without provider calls", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    const first = await service.explain(root, target(), fakeDocument);
    expect(first.cached).toBe(false);
    expect(provider.requests).toBe(2);

    const second = await service.explain(root, target(), fakeDocument);
    expect(second.cached).toBe(true);
    expect(provider.requests).toBe(2);
    expect(second.explanation.purpose).toContain("Mock mode");
  });

  it("reuses one repository overview while explaining different functions", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);
    const anotherFunction = {
      ...target(),
      name: "describeCatalog",
      qualifiedName: "describeCatalog",
      symbolId: "symbol-describe-catalog",
      source: "export function describeCatalog(catalog) { return catalog.length; }",
      structuralFingerprint: "describe-catalog-v1"
    };

    const result = await service.explain(root, anotherFunction, fakeDocument);

    expect(result.cached).toBe(false);
    expect(provider.requests).toBe(3);
  });

  it("primes the repository once when explanations run in parallel", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    const another = {
      ...target(),
      name: "describeCatalog",
      qualifiedName: "describeCatalog",
      symbolId: "symbol-describe-catalog",
      source: "export function describeCatalog(catalog) { return catalog.length; }",
      structuralFingerprint: "describe-catalog-v1"
    };

    const [first, second] = await Promise.all([
      service.explain(root, target(), fakeDocument),
      service.explain(root, another, fakeDocument)
    ]);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(provider.requests).toBe(3);
  });

  it("returns only a fresh cached explanation without making provider requests", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);
    const calls = provider.requests;

    const cached = await service.findCachedExplanation(root, target(), fakeDocument);
    expect(cached?.cached).toBe(true);
    expect(provider.requests).toBe(calls);

    harness.functionHash = "changed";
    expect(await service.findCachedExplanation(root, target(), fakeDocument)).toBeUndefined();
    expect(provider.requests).toBe(calls);
  });

  it("reuses persistent cache after recreating the service", async () => {
    const storage = await mkdtemp(resolve(tmpdir(), "downside-up-cache-"));
    try {
      const firstProvider = new MockProvider();
      const firstStore = new FileRepositoryCacheStore(storage);
      await createService(firstStore, firstProvider).explain(root, target(), fakeDocument);
      expect(firstProvider.requests).toBe(2);

      const restartedProvider = new MockProvider();
      const restartedStore = new FileRepositoryCacheStore(storage);
      const restarted = await createService(restartedStore, restartedProvider)
        .explain(root, target(), fakeDocument);
      expect(restarted.cached).toBe(true);
      expect(restartedProvider.requests).toBe(0);
    } finally {
      await rm(storage, { recursive: true, force: true });
    }
  });

  it("finds saved explanations for several functions at once, gathering context only for saved ones", async () => {
    const storage = await mkdtemp(resolve(tmpdir(), "downside-up-cache-"));
    try {
      const firstProvider = new MockProvider();
      await createService(new FileRepositoryCacheStore(storage), firstProvider)
        .explain(root, target(), fakeDocument);
      const unsaved = { ...target(), name: "unsaved", qualifiedName: "unsaved", symbolId: "symbol-unsaved" };

      const inventoryCalls: unknown[] = [];
      const contextTargets: string[] = [];
      const gatherInventory = harness.gatherInventory;
      const gatherContext = harness.gatherFunctionContext;
      harness.gatherInventory = (...args: unknown[]) => {
        inventoryCalls.push(args);
        return gatherInventory(...args);
      };
      harness.gatherFunctionContext = (...args: unknown[]) => {
        contextTargets.push((args[0] as FunctionTarget).symbolId);
        return gatherContext(...args);
      };
      const restartedProvider = new MockProvider();
      const restarted = createService(new FileRepositoryCacheStore(storage), restartedProvider);

      const found = await restarted.findCachedExplanations(root, [unsaved, target()], fakeDocument);
      expect([...found.keys()]).toEqual(["symbol-checkout"]);
      expect(found.get("symbol-checkout")?.cached).toBe(true);
      expect(contextTargets).toEqual(["symbol-checkout"]);
      expect(inventoryCalls).toHaveLength(1);

      expect((await restarted.findCachedExplanations(root, [unsaved], fakeDocument)).size).toBe(0);
      expect(inventoryCalls).toHaveLength(1);

      harness.functionHash = "function-v2";
      expect((await restarted.findCachedExplanations(root, [target()], fakeDocument)).size).toBe(0);
      expect(restartedProvider.requests).toBe(0);
    } finally {
      await rm(storage, { recursive: true, force: true });
    }
  });

  it("invalidates edited function and relevant surrounding context independently", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);

    harness.functionHash = "function-v2";
    harness.source = "export function checkout(catalog, title) { return catalog.lookup(title); }";
    const functionResult = await service.explain(root, target(), fakeDocument);
    expect(functionResult.cached).toBe(false);
    expect(provider.requests).toBe(3);

    harness.storageHash = "storage-v2";
    const contextResult = await service.explain(root, target(), fakeDocument);
    expect(contextResult.cached).toBe(false);
    expect(provider.requests).toBe(4);
  });

  it("preserves an otherwise valid explanation after an unrelated edit", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);
    const calls = provider.requests;

    harness.unrelatedHash = "unrelated-v2";
    const result = await service.explain(root, target(), fakeDocument);
    expect(result.cached).toBe(true);
    expect(provider.requests).toBe(calls);
  });

  it("reviews repository context when any primed file changes, cited or not", async () => {
    harness.primedPaths = ["README.md", "src/unrelated.js"];
    const provider = new MockProvider();
    const review = vi.spyOn(provider, "reviewRepository");
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);
    expect(review).not.toHaveBeenCalled();

    harness.unrelatedHash = "unrelated-v2";
    const unchanged = await service.explain(root, target(), fakeDocument);
    expect(unchanged.cached).toBe(true);
    expect(review).not.toHaveBeenCalled();

    await service.explain(root, otherTarget(), fakeDocument);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].changedPaths).toEqual(["src/unrelated.js"]);
  });

  it("reviews repository context after a branch switch", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);
    const calls = provider.requests;

    harness.gitHeadHash = "head-feature";
    const unchanged = await service.explain(root, target(), fakeDocument);
    expect(unchanged.cached).toBe(true);
    expect(provider.requests).toBe(calls);

    const other = await service.explain(root, otherTarget(), fakeDocument);
    expect(other.cached).toBe(false);
    expect(provider.requests).toBe(calls + 2);
  });

  it("sends nothing when an explanation request is over the size limit, and says which setting raises it", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    let limit = 8 * 1024;
    const service = new ExplanationService({
      store,
      describeProvider: () => ({ kind: "mock", modelId: provider.modelId }),
      createProvider: async () => provider,
      authorizeExternalData: async () => true,
      maxRequestBytes: () => limit
    });
    const large = { ...target(), source: `export function checkout() {\n${"  catalog.find(title);\n".repeat(400)}}` } as FunctionTarget;
    await expect(service.explain(root, large, fakeDocument)).rejects.toThrow(/about \d+ KiB, more than the 8 KiB limit; no code was sent\. Raise “Downside Up: Max Request Size”/);
    expect(provider.requests).toBe(0);
    limit = 64 * 1024;
    expect((await service.explain(root, large, fakeDocument)).cached).toBe(false);
  });

  it("maps the project while priming and saves the map apart from the overview", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    expect(await service.savedProjectMap(root)).toBeUndefined();
    await service.explain(root, target(), fakeDocument);
    const saved = await service.savedProjectMap(root);
    expect(saved?.current).toBe(true);
    expect(saved?.map.parts.map((part) => `${part.path ?? ""}:${part.level}`)).toEqual(["src:component", ":external"]);
    const cache = await store.read(root);
    expect(Object.keys(cache.overview!.value)).not.toContain("map");
  });

  it("keeps explanations current when only the project map changes", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    await service.explain(root, target(), fakeDocument);
    const requests = provider.requests;
    await store.update(root, (current) => ({
      ...current,
      projectMap: { ...current.projectMap!, value: { ...current.projectMap!.value, summary: "Edited map." } }
    }));
    const again = await service.explain(root, target(), fakeDocument);
    expect(again.cached).toBe(true);
    expect(again.earlierOverview).toBeFalsy();
    expect(provider.requests).toBe(requests);
  });

  it("maps the project again with the next new explanation after the map detail setting changes", async () => {
    const provider = new MockProvider();
    let detail: "brief" | "detailed" = "brief";
    const service = new ExplanationService({
      store: new MemoryRepositoryCacheStore(),
      describeProvider: () => ({ kind: "mock", modelId: provider.modelId }),
      createProvider: async () => provider,
      authorizeExternalData: async () => true,
      projectMapDetail: () => detail
    });
    await service.explain(root, target(), fakeDocument);
    expect((await service.savedProjectMap(root))?.map.parts[0]?.detail).toBeUndefined();
    detail = "detailed";
    expect((await service.savedProjectMap(root))?.current).toBe(false);
    const requests = provider.requests;
    expect((await service.explain(root, target(), fakeDocument)).cached).toBe(true);
    expect(provider.requests).toBe(requests);
    await service.explain(root, otherTarget(), fakeDocument);
    expect(provider.requests).toBe(requests + 2);
    const saved = await service.savedProjectMap(root);
    expect(saved?.current).toBe(true);
    expect(saved?.map.parts[0]?.detail).toBe("Mock detail of src.");
  });

  it("keeps explanations current when only the repository overview changes", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    await service.explain(root, target(), fakeDocument);
    const before = (await store.read(root)).overview!.contentVersion;

    harness.primedPaths = ["README.md"];
    harness.gitHeadHash = "head-feature";
    expect((await service.findCachedExplanation(root, target(), fakeDocument))?.earlierOverview).toBe(false);
    await service.explain(root, otherTarget(), fakeDocument);
    expect((await store.read(root)).overview!.contentVersion).not.toBe(before);

    const calls = provider.requests;
    const saved = await service.findCachedExplanation(root, target(), fakeDocument);
    expect(saved?.cached).toBe(true);
    expect(saved?.earlierOverview).toBe(true);
    expect((await service.explain(root, target(), fakeDocument)).earlierOverview).toBe(true);
    expect(provider.requests).toBe(calls);

    harness.functionHash = "function-v2";
    expect(await service.findCachedExplanation(root, target(), fakeDocument)).toBeUndefined();
  });

  it("advances checked snapshot without changing unchanged overview content version", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    await service.explain(root, target(), fakeDocument);
    const before = (await store.read(root)).overview!;
    const refreshed = await service.refreshRepositoryContext(root);
    const after = (await store.read(root)).overview!;

    expect(refreshed.overview).toEqual(before.value);
    expect(after.contentVersion).toBe(before.contentVersion);
    expect(after.checkedSnapshot).toEqual(before.checkedSnapshot);
    expect(provider.requests).toBe(3);
  });

  it("does not save a current explanation when source changes in flight", async () => {
    const provider = new MockProvider();
    provider.delayMs = 20;
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    const request = service.explain(root, target(), fakeDocument);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    harness.functionHash = "function-edited-during-request";
    harness.source = "export function checkout(catalog, title) { return null; }";
    await expect(request).rejects.toThrow(/changed while the explanation was generating/i);
    expect(Object.keys((await store.read(root)).explanations)).toHaveLength(0);
  });

  it("deduplicates concurrent equivalent requests", async () => {
    const provider = new MockProvider();
    provider.delayMs = 10;
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    const [first, second] = await Promise.all([
      service.explain(root, target(), fakeDocument),
      service.explain(root, target(), fakeDocument)
    ]);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(provider.requests).toBe(2);
  });

  it("supports cancellation, surfaces provider failures, and fences Clear Cache", async () => {
    const provider = new MockProvider();
    provider.delayMs = 100;
    const store = new MemoryRepositoryCacheStore();
    const service = createService(store, provider);
    const controller = new AbortController();
    const cancelled = service.explain(root, target(), fakeDocument, controller.signal);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    provider.delayMs = 50;
    const duringClear = service.explain(root, target(), fakeDocument);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    await service.clearCache(root);
    await expect(duringClear).rejects.toThrow(/cache was cleared/i);
    expect(await store.read(root)).toMatchObject({
      overview: null,
      explanations: {}
    });

    provider.delayMs = 0;
    provider.failure = "network";
    await expect(service.explain(root, target(), fakeDocument)).rejects.toThrow(/network failure/i);
  });

  it("shows malformed and refused mock responses as explicit errors", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    provider.failure = "malformed";
    await expect(service.explain(root, target(), fakeDocument)).rejects.toThrow(/not valid JSON/i);
    provider.failure = "refusal";
    await expect(service.explain(root, target(), fakeDocument)).rejects.toThrow(/refused/i);
  });

  it("includes enabled views and adds a missing view to a saved explanation", async () => {
    const provider = new MockProvider();
    const store = new MemoryRepositoryCacheStore();
    const withPseudocode = createService(store, provider, true, ["pseudocode"]);
    const first = await withPseudocode.explain(root, target(), fakeDocument);
    expect(first.explanation.pseudocode?.length).toBeGreaterThan(0);
    expect(first.explanation.flowchart).toBeUndefined();
    expect(first.explanation.pseudocode![1]).toMatchObject({ startLine: 1, anchor: harness.source.trim() });

    const calls = provider.requests;
    const added = await withPseudocode.addExplanationFormat(root, target(), fakeDocument, "flowchart");
    expect(added.explanation.flowchart?.nodes.length).toBe(5);
    expect(added.explanation.pseudocode).toEqual(first.explanation.pseudocode);
    expect(provider.requests).toBe(calls + 1);
    expect((await withPseudocode.findCachedExplanation(root, target(), fakeDocument))?.explanation.flowchart).toBeDefined();

    await withPseudocode.addExplanationFormat(root, target(), fakeDocument, "flowchart");
    expect(provider.requests).toBe(calls + 1);

    harness.functionHash = "changed";
    await expect(withPseudocode.addExplanationFormat(root, target(), fakeDocument, "pseudocode"))
      .rejects.toThrow("no longer current");
  });

  it("summarizes a file once, reuses it while current, and marks it outdated after edits", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    expect(await service.findFileSummary(root, fakeDocument)).toBeUndefined();

    const first = await service.summarizeFile(root, fakeDocument);
    expect(first?.summary).toContain("src/checkout.js");
    expect(provider.requests).toBe(1);
    expect(await service.findFileSummary(root, fakeDocument)).toEqual({ summary: first!.summary, current: true });

    await service.summarizeFile(root, fakeDocument);
    expect(provider.requests).toBe(1);

    harness.source = "export  function checkout(catalog, title)\n{ return catalog.find(title); }";
    expect((await service.findFileSummary(root, fakeDocument))?.current).toBe(true);
    harness.source = "export function checkout(catalog, title) { return catalog.lookup(title); }";
    expect((await service.findFileSummary(root, fakeDocument))?.current).toBe(false);
    await service.summarizeFile(root, fakeDocument);
    expect(provider.requests).toBe(2);

    harness.exclusion = "a .gitignore or .copilotignore file excludes it";
    harness.source = "export const changed = true;";
    expect(await service.summarizeFile(root, fakeDocument)).toBeUndefined();
    expect(provider.requests).toBe(2);
  });

  it("refuses to explain a function in an excluded file before any provider request", async () => {
    const provider = new MockProvider();
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    harness.exclusion = "a .gitignore or .copilotignore file excludes it";
    await expect(service.explain(root, target(), fakeDocument)).rejects.toThrow(
      "checkout.js is excluded from AI explanations because a .gitignore or .copilotignore file excludes it. Nothing was sent"
    );
    expect(provider.requests).toBe(0);
  });

  it("never requests external code after consent is declined", async () => {
    for (const descriptor of [
      { kind: "openai" as const, modelId: "test-model" },
      { kind: "vscode-lm" as const, modelId: "copilot/test-model" }
    ]) {
      const store = new MemoryRepositoryCacheStore();
      const provider = new MockProvider();
      const authorizations: string[] = [];
      const externalService = new ExplanationService({
        store,
        describeProvider: () => descriptor,
        createProvider: async () => provider,
        authorizeExternalData: async (_root, requested) => {
          authorizations.push(`${requested.kind}:${requested.modelId}`);
          return false;
        }
      });
      await expect(externalService.explain(root, target(), fakeDocument))
        .rejects.toMatchObject({ name: "AbortError" });
      await expect(externalService.refreshRepositoryContext(root))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(authorizations).toEqual([
        `${descriptor.kind}:${descriptor.modelId}`,
        `${descriptor.kind}:${descriptor.modelId}`
      ]);
      expect(provider.requests).toBe(0);
      expect((await store.read(root)).overview).toBeNull();
    }
  });

  it("adds the language's background for React components to the prompt, and none for other functions", async () => {
    await initializeJavaScriptParsersAt(resolve("."));
    const provider = new MockProvider();
    const explain = vi.spyOn(provider, "explainFunction");
    const service = createService(new MemoryRepositoryCacheStore(), provider);
    await service.explain(root, target(), fakeDocument);
    expect(explain.mock.calls[0]![0].guidance).toBeUndefined();

    harness.source = "export function Cart({ lines }) { return <ul>{lines.map((line) => <li>{line}</li>)}</ul>; }";
    await service.explain(root, { ...target(), name: "Cart", qualifiedName: "Cart", symbolId: "symbol-cart", source: harness.source }, fakeDocument);
    expect(explain.mock.calls[1]![0].guidance).toBe(COMPONENT_GUIDANCE);
  });
});
