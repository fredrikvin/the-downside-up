import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hasConsent, withConsent } from "../src/cache/consent";
import { emptyRepositoryCache, MemoryRepositoryCacheStore } from "../src/cache/store";
import { ExplanationService } from "../src/controller";
import type { FunctionTarget } from "../src/core/types";
import { MockProvider } from "../src/generation/mock";
import { Position, Range, Uri } from "./vscode";

describe("per-model consent", () => {
  it("keeps one approval per model, so a second model does not drop the first", () => {
    let cache = withConsent(emptyRepositoryCache(), "vscode-lm", "copilot/fast", 1);
    cache = withConsent(cache, "vscode-lm", "copilot/strong", 2);
    expect(hasConsent(cache, "vscode-lm", "copilot/fast")).toBe(true);
    expect(hasConsent(cache, "vscode-lm", "copilot/strong")).toBe(true);
    expect(hasConsent(cache, "openai", "copilot/fast")).toBe(false);
    expect(cache.consent).toMatchObject({ model: "copilot/strong" });
    cache = withConsent(cache, "vscode-lm", "copilot/fast", 3);
    expect(cache.consents).toHaveLength(2);
  });

  it("reads approvals saved before per-model records existed", () => {
    const old = { ...emptyRepositoryCache(), consent: { provider: "openai" as const, model: "gpt", acceptedAt: 1 } };
    expect(hasConsent(old, "openai", "gpt")).toBe(true);
  });
});

describe("the overview model", () => {
  const root = resolve("fixtures/js-app");
  const source = "export function checkout(catalog, title) { return catalog.find(title); }";
  const document = {
    uri: Uri.file(resolve(root, "src/checkout.js")),
    languageId: "javascript",
    version: 1,
    getText: () => source
  } as unknown as import("vscode").TextDocument;
  const target = {
    uri: document.uri,
    range: new Range(new Position(0, 0), new Position(0, source.length)),
    selection: new Range(new Position(0, 16), new Position(0, 24)),
    languageId: "javascript",
    name: "checkout",
    qualifiedName: "checkout",
    signature: "checkout(catalog, title)",
    source,
    symbolId: "symbol-checkout",
    structuralFingerprint: "checkout-v1",
    analysis: "vscode-symbols"
  } as unknown as FunctionTarget;

  it("primes the repository with the overview model and explains with the explanation model", async () => {
    const explainer = new MockProvider();
    const planner = new MockProvider();
    const explain = vi.spyOn(explainer, "explainFunction");
    const prime = vi.spyOn(planner, "explainRepository");
    const asked: string[] = [];
    const service = new ExplanationService({
      allowMock: true,
      store: new MemoryRepositoryCacheStore(),
      describeProvider: () => ({ kind: "mock", modelId: "fast" }),
      describeOverviewProvider: () => ({ kind: "mock", modelId: "strong" }),
      createProvider: async (descriptor) => {
        asked.push(descriptor.modelId);
        return descriptor.modelId === "strong" ? planner : explainer;
      },
      authorizeExternalData: async () => true
    });
    await service.explain(root, target, document);
    expect(prime).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(["strong", "fast"]);

    const summary = await service.summarizeFolder(root, { repositoryName: "js-app", path: "src", parts: [{ name: "a.js", kind: "file" }], imports: [] });
    expect(summary.value.summary).toContain("Mock summary");
    expect(asked.at(-1)).toBe("strong");
  });
});
