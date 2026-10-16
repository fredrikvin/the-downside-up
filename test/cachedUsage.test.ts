import { describe, expect, it } from "vitest";
import { emptyRepositoryCache } from "../src/cache/store";
import { cachedUsage } from "../src/cache/usage";
import type { RepositoryCache } from "../src/core/types";

describe("tokens in current cache", () => {
  it("totals retained records by role, provider, and model without counting the map twice", () => {
    const usage = { inputTokens: 10, outputTokens: 2, estimated: true };
    const file = { path: "a.ts", summary: "A", fingerprint: "v1", provider: "vscode-lm" as const, model: "Fast", promptVersion: "1", savedAt: 1, usage };
    const cache: RepositoryCache = {
      ...emptyRepositoryCache(),
      projectMap: { value: { summary: "", parts: [], links: [] }, config: "1", savedAt: 1, usage, model: "Strong", provider: "vscode-lm" },
      fileSummaries: { a: file, b: { ...file, model: "Other", provider: "openai" } }
    };
    const result = cachedUsage(cache);
    expect(result.inputTokens).toBe(30);
    expect(result.outputTokens).toBe(6);
    expect(result.estimated).toBe(true);
    expect(result.models).toHaveLength(3);
    expect(result.models).toContainEqual(expect.objectContaining({ role: "Overview", model: "Strong", inputTokens: 10 }));
    expect(result.models).toContainEqual(expect.objectContaining({ role: "Functions", model: "Fast", inputTokens: 10 }));
    const replaced = cachedUsage({ ...cache, fileSummaries: { a: { ...file, usage: { ...usage, inputTokens: 50 } } } });
    expect(replaced.inputTokens).toBe(60);
    expect(cachedUsage(emptyRepositoryCache()).inputTokens).toBe(0);
  });

  it("reports missing usage rather than implying a complete zero total", () => {
    const cache = emptyRepositoryCache();
    const result = cachedUsage({
      ...cache,
      projectMap: { value: { summary: "", parts: [], links: [] }, config: "1", savedAt: 1 }
    });
    expect(result.unrecorded).toBe(1);
    expect(result.inputTokens).toBe(0);
  });
});
