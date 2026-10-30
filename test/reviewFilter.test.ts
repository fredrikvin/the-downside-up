import { describe, expect, it } from "vitest";
import { DEFAULT_LOW_VALUE_PATTERNS, reviewFilter, validReviewPattern } from "../src/context/reviewFilter";
import { workspace } from "./vscode";

describe("low-value review classification", () => {
  it.each(["package-lock.json", "Cargo.lock", "pnpm-lock.yaml", "bun.lock", "go.sum", "uv.lock",
    "vendored/a.ts", "third_party/a.ts", "third-party/a.ts", "generated/a.ts", "__generated__/a.ts",
    "a.generated.ts", "a.gen.go", "a_generated.go", "a.pb.go", "a_pb2.py", "a_pb2_grpc.py",
    "a.d.ts", "a.min.js", "a.min.mjs", "a.min.cjs", "a.min.css", "__snapshots__/a.txt", "a.snap"])(
    "matches root and nested %s", (path) => {
      expect(reviewFilter().classify(path)).toBeDefined();
      expect(reviewFilter().classify(`nested/${path}`)).toBeDefined();
    });

  it("classifies both rename paths without granting sharing eligibility", () => {
    const filter = reviewFilter();
    expect(filter.classify("a.d.ts", "src/a.ts")).toEqual({ pattern: "**/*.d.ts" });
    expect(filter.classify("src/a.ts", "generated/a.ts")).toBeDefined();
    expect(filter.classify("src/a.ts")).toBeUndefined();
    // Sharing-excluded paths are not made eligible by this separate classifier.
    expect(filter.classify("vendor/a.ts")).toBeUndefined();
    expect(filter.classify(".env")).toBeUndefined();
  });

  it("replaces defaults only at the user layer, with additive workspace and folder arrays", () => {
    expect(reviewFilter({ workspaceValue: [], workspaceFolderValue: [] }).patterns)
      .toEqual([...DEFAULT_LOW_VALUE_PATTERNS].sort());
    const filter = reviewFilter({ globalValue: ["**/manual/**"], workspaceValue: ["**/extra/**"],
      workspaceFolderValue: ["**/folder/**"] });
    expect(filter.classify("a.d.ts")).toBeUndefined();
    for (const path of ["manual/a.ts", "extra/a.ts", "folder/a.ts"]) expect(filter.classify(path)).toBeDefined();
    expect(reviewFilter({ globalValue: [] }).patterns).toEqual([]);
    expect(reviewFilter({ globalValue: ["a", "b", "a"] }).fingerprint)
      .toBe(reviewFilter({ globalValue: ["b", "a"] }).fingerprint);
  });

  it.each(["", "!a", "/a", "\\a", "C:/a", "../a", "a/../b", "a\\b", "a\nb", "a\u007fb", "a\u0085b", "a".repeat(257)])(
    "rejects invalid pattern %j", (pattern) => {
      expect(validReviewPattern(pattern)).toBe(false);
      expect(reviewFilter({ globalValue: [pattern] }).patterns).toEqual([]);
    });

  it("bounds each layer and disables comment, negation and extglob interpretation", () => {
    expect(reviewFilter({ globalValue: Array.from({ length: 129 }, (_, i) => `file${i}`) }).patterns).toHaveLength(128);
    expect(reviewFilter({ globalValue: ["#literal", "@(a|b)"] }).classify("#literal")).toBeDefined();
    expect(reviewFilter({ globalValue: ["@(a|b)"] }).classify("a")).toBeUndefined();
  });

  it("resolves inspected workspace-folder values additively", () => {
    workspace.__setConfiguration("downsideUp.review.lowValuePatterns", ["user/**"]);
    workspace.__setConfiguration("workspace:downsideUp.review.lowValuePatterns", []);
    workspace.__setConfiguration("folder:downsideUp.review.lowValuePatterns", ["folder/**"]);
    try {
      const filter = reviewFilter(workspace.getConfiguration("downsideUp").inspect("review.lowValuePatterns"));
      expect(filter.classify("user/a.ts")).toBeDefined();
      expect(filter.classify("folder/a.ts")).toBeDefined();
    } finally { workspace.__resetConfiguration(); }
  });
});
