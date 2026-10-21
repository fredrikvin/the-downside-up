import type { ComparisonPromptInput } from "../src/generation/provider";

export const comparisonInput: ComparisonPromptInput = {
  repositoryName: "sample",
  languageId: "typescript",
  original: { path: "request.ts", label: "Before", present: true, source: "\n".repeat(7) },
  modified: { path: "request.ts", label: "After", present: true, source: "\n".repeat(9) }
};

export const comparisonBounds = { originalLines: 8, modifiedLines: 10, originalPresent: true, modifiedPresent: true };

export function comparisonScope() {
  const side = (endLine: number) => ({
    region: "request handling",
    coverage: "The changed request path only.",
    flowchartStatus: "available",
    flowchartReason: "",
    operations: [
      { id: "start", kind: "start", label: "Start", startLine: 2, endLine: 2 },
      { id: "send", kind: "action", label: "Send request", startLine: 3, endLine }
    ],
    steps: [{ operation: "send", text: "Send the request", detail: "" }],
    pseudocode: [{ operation: "send", text: "send the request", depth: 0 }],
    edges: [{ from: "start", to: "send", label: "" }]
  });
  return {
    id: "request",
    title: "Request behavior",
    original: side(4),
    modified: side(6),
    operationMatches: [
      { original: "start", modified: "start", meaning: "Entry point", difference: "" },
      { original: "send", modified: "send", meaning: "Same request operation", difference: "The modified operation retries." }
    ],
    edgeMatches: [{ original: 0, modified: 0, meaning: "Entry into the request", difference: "The transition is preserved." }]
  };
}

export function comparisonResponse() {
  return {
    summary: "Adds a retry.",
    changes: [{
      id: "retry", title: "Retry", before: "Fails at once", after: "Tries twice",
      when: "", flow: "", original: { startLine: 2, endLine: 4 }, modified: { startLine: 2, endLine: 9 },
      visualScopeId: "request"
    }],
    visualScopes: [comparisonScope()],
    outside: "",
    possibleEffects: ["More load"],
    limitations: []
  };
}
