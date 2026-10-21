import type { ComparisonPromptInput } from "../src/generation/provider";
import type { ComparisonCatalogue, ComparisonFunctionSource } from "../src/core/types";

const functionSource: ComparisonFunctionSource = {
  name: "request", qualifiedName: "request", signature: "request()", fingerprint: "source",
  startLine: 1, endLine: 9, startColumn: 0, endColumn: 1, nameLine: 1, nameColumn: 9
};
export const comparisonFunctionCatalogue: ComparisonCatalogue = {
  version: 1, fingerprint: "catalogue", classified: true, limitations: [],
  entries: [
    { id: "added", category: "added", name: "added", kind: "function", modified: functionSource },
    { id: "removed", category: "removed", name: "removed", kind: "function", original: functionSource },
    { id: "changed", category: "changed", name: "request", kind: "function",
      original: { ...functionSource, endLine: 7 }, modified: functionSource }
  ]
};

export function classifiedComparisonResponse() {
  const response = comparisonResponse();
  return {
    ...response,
    added: [{ functionId: "added", summary: "Adds a helper." }],
    removed: [{ functionId: "removed", summary: "Removed a helper; other callers may have used it." }],
    changes: response.changes.map((change) => ({ ...change, functionId: "changed" })),
    visualScopes: response.visualScopes.map((scope) => ({ ...scope, functionId: "changed" }))
  };
}

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
