import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { ExplanationService, type SnapshotExplanationSource } from "../src/controller";
import { fingerprint } from "../src/core/fingerprint";
import { MockProvider } from "../src/generation/mock";
import { javascriptSupport } from "../src/languages/javascript";
import type { ExplanationPromptInput } from "../src/generation/provider";

let root = "";
beforeAll(() => javascriptSupport.initialize!(process.cwd()));
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "dsu-snapshot-"))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function setup(store = new MemoryRepositoryCacheStore()) {
  const provider = new MockProvider();
  let model = "model-a";
  const service = new ExplanationService({
    store, describeProvider: () => ({ kind: "mock", modelId: model }), createProvider: async () => provider,
    authorizeExternalData: async () => true
  });
  const text = 'import { oldHelper } from "./old";\nexport function removed() {\n  return oldHelper("historical");\n}\n';
  const document = {
    uri: vscode.Uri.file(join(root, "deleted.ts")), languageId: "typescript", getText: () => text
  } as vscode.TextDocument;
  const target = (await javascriptSupport.findFunction(document, new vscode.Position(1, 20)))!;
  expect(target).toBeDefined();
  const scope: SnapshotExplanationSource = {
    side: { path: "deleted.ts", identity: "revision:one", state: "present", detail: "", text, fingerprint: fingerprint(text), lines: 5 },
    occurrenceId: "removed-1", validate: vi.fn(async () => undefined)
  };
  return { store, provider, service, document, target, scope, setModel: (value: string) => { model = value; } };
}

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe("isolated snapshot function explanations", () => {
  it("uses only historical function and bounded same-file imports even if the file is deleted today", async () => {
    const { service, store, provider, target, scope } = await setup();
    await writeFile(join(root, "today.ts"), "export const currentSecretOfMeaning = 'never historical evidence';");
    const sent: ExplanationPromptInput[] = [];
    const explain = provider.explainFunction.bind(provider);
    vi.spyOn(provider, "explainFunction").mockImplementation((input, signal) => {
      sent.push(input); return explain(input, signal);
    });
    const result = await service.explainSnapshot(root, target, scope);
    expect(provider.requests).toBe(1);
    expect(sent[0]?.overview).toBeUndefined();
    expect(sent[0]?.source).toContain('"historical"');
    expect(sent[0]?.relatedContext).toContain('import { oldHelper }');
    expect(JSON.stringify(sent)).not.toContain("currentSecretOfMeaning");
    expect(result.explanation.limitations.join(" ")).toContain("Historical callers");
    expect(result.context.sourceReferences).toEqual([]);
    expect((await store.read(root)).overview).toBeNull();
    expect((await store.read(root)).fileSummaries).toBeUndefined();
  });

  it("isolates revision, path, occurrence and model keys and cannot satisfy a working-file cache lookup", async () => {
    const { service, target, document, scope, provider, setModel } = await setup();
    await service.explainSnapshot(root, target, scope);
    expect((await service.explainSnapshot(root, target, scope)).cached).toBe(true);
    for (const changed of [
      { ...scope, side: { ...scope.side, identity: "revision:two" } },
      { ...scope, side: { ...scope.side, identity: "index" } },
      { ...scope, side: { ...scope.side, path: "renamed.ts" } },
      { ...scope, occurrenceId: "other" },
      { ...scope, side: { ...scope.side, fingerprint: "different exact text" } }
    ]) expect(await service.findSnapshotExplanation(root, target, changed)).toBeUndefined();
    setModel("model-b");
    expect(await service.findSnapshotExplanation(root, target, scope)).toBeUndefined();
    await service.explainSnapshot(root, target, scope);
    expect(provider.requests).toBe(2);
    expect(await service.findCachedExplanation(root, target, document)).toBeUndefined();
  });

  it("deduplicates only the same snapshot scope, never different revisions", async () => {
    const { service, target, scope, provider } = await setup();
    const entered = gate(); const release = gate();
    const generate = provider.explainFunction.bind(provider);
    vi.spyOn(provider, "explainFunction").mockImplementation(async (input, signal) => {
      entered.release(); await release.promise; return generate(input, signal);
    });
    const first = service.explainSnapshot(root, target, scope);
    const same = service.explainSnapshot(root, target, scope);
    const other = service.explainSnapshot(root, target, { ...scope, side: { ...scope.side, identity: "index" } });
    await entered.promise; release.release();
    await Promise.all([first, same, other]);
    expect(provider.requests).toBe(2);
  });

  it("requires the selected repository/model's consent without priming and enforces the request budget", async () => {
    const { provider, target, scope } = await setup();
    const authorize = vi.fn(async () => false);
    const service = new ExplanationService({
      store: new MemoryRepositoryCacheStore(),
      describeProvider: () => ({ kind: "openai", modelId: "historical-model" }),
      createProvider: async () => provider,
      authorizeExternalData: authorize
    });
    await expect(service.explainSnapshot(root, target, scope)).rejects.toMatchObject({ name: "AbortError" });
    expect(authorize).toHaveBeenCalledWith(root, { kind: "openai", modelId: "historical-model" }, expect.any(Number), undefined);
    expect(provider.requests).toBe(0);
    const small = new ExplanationService({
      store: new MemoryRepositoryCacheStore(), describeProvider: () => ({ kind: "mock", modelId: "mock" }),
      createProvider: async () => provider, authorizeExternalData: authorize, maxRequestBytes: () => 100
    });
    await expect(small.explainSnapshot(root, target, scope)).rejects.toThrow("Max Request Size");
    expect(provider.requests).toBe(0);
  });

  it("checks freshness again after asynchronous provider creation, before dispatch", async () => {
    const { provider, target, scope } = await setup();
    let changed = false;
    const service = new ExplanationService({
      store: new MemoryRepositoryCacheStore(), describeProvider: () => ({ kind: "mock", modelId: "mock" }),
      createProvider: async () => { changed = true; return provider; }, authorizeExternalData: async () => true
    });
    await expect(service.explainSnapshot(root, target, { ...scope, validate: async () => {
      if (changed) throw new Error("snapshot moved");
    } })).rejects.toThrow("snapshot moved");
    expect(provider.requests).toBe(0);
  });

  it("rejects source or exclusion changes during generation and never saves the result", async () => {
    const { service, store, provider, target, scope } = await setup();
    let changed = false;
    const guarded = { ...scope, validate: async () => { if (changed) throw new Error("snapshot moved"); } };
    const explain = provider.explainFunction.bind(provider);
    vi.spyOn(provider, "explainFunction").mockImplementation(async (input, signal) => {
      const result = await explain(input, signal); changed = true; return result;
    });
    await expect(service.explainSnapshot(root, target, guarded)).rejects.toThrow("snapshot moved");
    expect((await store.read(root)).explanations).toEqual({});
    changed = false;
    await writeFile(join(root, ".copilotignore"), "deleted.ts\n");
    await expect(service.explainSnapshot(root, target, scope)).rejects.toThrow("sharing policy");
    expect(provider.requests).toBe(1);
  });

  it.each(["cancel", "source"] as const)("rejects %s while persistence waits, using a deterministic gate", async (reason) => {
    const { service, store, target, scope } = await setup();
    const entered = gate();
    const release = gate();
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation(async (root, updater, signal, validate) => {
      entered.release(); await release.promise; return update(root, updater, signal, validate);
    });
    let changed = false;
    const controller = new AbortController();
    const pending = service.explainSnapshot(root, target, { ...scope, validate: async () => { if (changed) throw new Error("snapshot moved"); } }, controller.signal);
    await entered.promise;
    if (reason === "cancel") controller.abort(); else changed = true;
    release.release();
    await expect(pending).rejects.toThrow();
    expect((await store.read(root)).explanations).toEqual({});
  });

  it("cancels a missing-format request before commit without losing the saved explanation", async () => {
    const { service, store, target, scope, provider } = await setup();
    await service.explainSnapshot(root, target, scope);
    const before = (await store.read(root)).explanations;
    const entered = gate(); const release = gate();
    const generate = provider.explainFormat.bind(provider);
    vi.spyOn(provider, "explainFormat").mockImplementation(async (input, signal) => {
      entered.release(); await release.promise; return generate(input, signal);
    });
    const controller = new AbortController();
    const pending = service.explainSnapshot(root, target, scope, controller.signal, "pseudocode");
    await entered.promise; controller.abort(); release.release();
    await expect(pending).rejects.toThrow();
    expect((await store.read(root)).explanations).toEqual(before);
  });

  it("reports success if cancellation arrives after persistence has committed", async () => {
    const { service, store, target, scope } = await setup();
    const controller = new AbortController();
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation(async (...args) => {
      const result = await update(...args); controller.abort(); return result;
    });
    const result = await service.explainSnapshot(root, target, scope, controller.signal);
    expect(result.cached).toBe(false);
    expect(Object.keys((await store.read(root)).explanations)).toHaveLength(1);
  });
});
