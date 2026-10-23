import { describe, expect, it, vi } from "vitest";
import { ExplanationService } from "../src/controller";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { withConsent } from "../src/cache/consent";
import { MockProvider } from "../src/generation/mock";
import { ModelSetupRequired, modelBoundTask, providerConfigured, selectedProvider } from "../src/generation/selection";
import { RequestScheduler } from "../src/presentation/requestScheduler";

describe("production model configuration", () => {
  it("never transfers a queued follow-up summary to a newly selected model", async () => {
    const scheduler = new RequestScheduler(() => 1);
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = scheduler.schedule("explicit", async () => { started(); await gate; });
    await running;
    let modelId = "old";
    const send = vi.fn(async () => undefined);
    const pending = scheduler.schedule("explicit", modelBoundTask(() => ({ kind: "openai", modelId }), send));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    modelId = "chosen";
    release();
    await Promise.all([blocker, rejected]);
    expect(send).not.toHaveBeenCalled();
    await expect(modelBoundTask(() => ({ kind: "openai", modelId }), send)()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "none", "mock", "unknown"])("requires setup for %s without silently choosing a model", (provider) => {
    const descriptor = selectedProvider({ provider, languageModel: "previous real model" }, false);
    expect(descriptor).toEqual({ kind: "vscode-lm", modelId: "" });
    expect(providerConfigured(descriptor, false)).toBe(false);
  });

  it("preserves explicitly configured real providers and requires an LM model", () => {
    expect(selectedProvider({ provider: "vscode-lm", languageModel: "  My model " }, false))
      .toEqual({ kind: "vscode-lm", modelId: "My model" });
    expect(selectedProvider({ provider: "openai", openaiModel: "gpt-custom" }, false))
      .toEqual({ kind: "openai", modelId: "gpt-custom" });
    expect(selectedProvider({ provider: "openai" }, false)).toEqual({ kind: "openai", modelId: "gpt-4.1-mini" });
    expect(providerConfigured(selectedProvider({ provider: "vscode-lm" }, false), false)).toBe(false);
  });

  it("requires explicit mock opt-in in both configuration and the harness", () => {
    expect(selectedProvider({}, true).kind).not.toBe("mock");
    const descriptor = selectedProvider({ provider: "mock" }, true);
    expect(descriptor).toEqual({ kind: "mock", modelId: new MockProvider().modelId });
    expect(providerConfigured(descriptor, true)).toBe(true);
    expect(providerConfigured(descriptor, false)).toBe(false);
  });

  it.each(["mock", "none", "vscode-lm"])("gates every generation API before scans, consent, cache or providers (%s)", async (provider) => {
    const store = new MemoryRepositoryCacheStore();
    const read = vi.spyOn(store, "read");
    const update = vi.spyOn(store, "update");
    const createProvider = vi.fn();
    const authorizeExternalData = vi.fn();
    const service = new ExplanationService({
      store, createProvider, authorizeExternalData,
      describeProvider: () => provider === "mock" ? { kind: "mock", modelId: "mock" } : selectedProvider({ provider }, false),
      // Even a saved separate overview selection cannot enable an unconfigured installation.
      describeOverviewProvider: () => ({ kind: "openai", modelId: "configured-overview" })
    });
    const requests = [
      () => service.explain("/unread", undefined as never, undefined as never),
      () => service.refreshRepositoryContext("/unread"),
      () => service.addExplanationFormat("/unread", undefined as never, undefined as never, "flowchart"),
      () => service.explainSnapshot("/unread", undefined as never, undefined as never),
      () => service.explainSnapshot("/unread", undefined as never, undefined as never, undefined, "pseudocode"),
      () => service.describeProjectFlows("/unread", undefined as never),
      () => service.summarizeFolder("/unread", undefined as never),
      () => service.summarizeFile("/unread", undefined as never),
      () => service.explainComparison(undefined as never, vi.fn())
    ];
    for (const request of requests) await expect(request()).rejects.toBeInstanceOf(ModelSetupRequired);
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
    expect(authorizeExternalData).not.toHaveBeenCalled();
  });

  it("hides saved mock content without migrating the cache or deleting real records/consent", async () => {
    const store = new MemoryRepositoryCacheStore();
    const mock = new MockProvider();
    const generated = await mock.explainRepository({
      repositoryName: "test", inventory: "", languageIds: [], folders: "", mapDetail: "brief"
    });
    const summary = (provider: "mock" | "openai") => ({
      path: `${provider}.ts`, summary: `${provider} summary`, fingerprint: "source", provider,
      model: "test", promptVersion: "test", savedAt: 1
    });
    const cache = withConsent({
      schemaVersion: 2, consent: null, explanations: {},
      overview: { value: generated.value.overview, config: "mock:test:version", contentVersion: "test",
        checkedSnapshot: {}, primedPaths: [], checkedAt: 1 },
      projectMap: { value: generated.value.map, config: "mock:test:version", provider: "mock", savedAt: 1 },
      fileSummaries: { mock: summary("mock"), real: summary("openai") }
    }, "openai", "approved-model", 1);
    await store.write("/test", cache);
    const service = new ExplanationService({
      store, describeProvider: () => ({ kind: "openai", modelId: "approved-model" }),
      createProvider: vi.fn(), authorizeExternalData: vi.fn()
    });
    expect(await service.savedOverview("/test")).toBeUndefined();
    expect(await service.savedProjectMap("/test")).toBeUndefined();
    const visible = await service.readCache("/test");
    expect(visible.fileSummaries).toEqual({ real: summary("openai") });
    expect(visible.consents).toEqual(cache.consents);
    expect(await store.read("/test")).toEqual(cache);
    const harness = new ExplanationService({
      allowMock: true, store, describeProvider: () => ({ kind: "mock", modelId: mock.modelId }),
      createProvider: async () => mock, authorizeExternalData: vi.fn()
    });
    expect(await harness.savedOverview("/test")).toEqual(generated.value.overview);
  });
});
