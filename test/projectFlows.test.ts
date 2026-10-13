import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { projectFlowsInput } from "../src/context/folderInput";
import { listEligibleFiles, listFolder } from "../src/context/inventory";
import { folderStructure } from "../src/context/structure";
import { checkedFlowReferences, ExplanationService } from "../src/controller";
import { MockProvider } from "../src/generation/mock";
import { projectFlowsPrompt } from "../src/generation/prompts";
import { parseProjectFlows } from "../src/generation/schema";
import { initializeGoParserAt } from "../src/languages/go/syntax";

const root = resolve("fixtures/go-app");

beforeAll(async () => {
  await initializeGoParserAt(resolve("."));
});

async function rootFlowsInput(summaries: Record<string, string> = {}) {
  const { children } = await listFolder(root, "");
  const structure = await folderStructure(root, "", children);
  const { files } = await listEligibleFiles(root, "");
  return projectFlowsInput("go-app", "", files, structure, {}, {
    fileSummaries: new Map(Object.entries(summaries)),
    text: (path) => readFile(resolve(root, path), "utf8")
  });
}

describe("project flow input", () => {
  it("catalogs files with summaries or functions, and no code", async () => {
    const input = await rootFlowsInput({ "report.go": "Prints a report." });
    expect(input.catalog.map((entry) => entry.path)).toEqual([
      "inventory/inventory.go",
      "inventory/lookup.go",
      "main_test.go",
      "main.go",
      "report.go",
      "storage/storage.go"
    ]);
    expect(input.catalog.find((entry) => entry.path === "main.go")?.functions).toEqual(["main", "checkout"]);
    expect(input.catalog.find((entry) => entry.path === "report.go")?.summary).toBe("Prints a report.");
    expect(input.truncated).toBe(false);
    const [, user] = projectFlowsPrompt(input);
    expect(user).not.toContain("func ");
  });
});

describe("project flows from a model", () => {
  const draft = parseProjectFlows({
    flows: [
      {
        title: "Checking out a book",
        summary: "Finds a book and saves it.",
        nodes: [
          { id: "s", kind: "start", label: "Start", file: "", function: "" },
          { id: "a", kind: "action", label: "Find the book", file: "./inventory/lookup.go", function: "Catalog.FindAvailable" },
          { id: "b", kind: "action", label: "Save it", file: "storage/storage.go", function: "Invented" },
          { id: "c", kind: "action", label: "Somewhere", file: "made/up.go", function: "Main" },
          { id: "e", kind: "end", label: "Done", file: "", function: "" }
        ],
        edges: [{ from: "s", to: "a", label: "" }, { from: "a", to: "b", label: "" }, { from: "b", to: "c", label: "" }, { from: "c", to: "e", label: "" }]
      },
      { title: "Broken", summary: "", nodes: [{ id: "x", kind: "start", label: "x", file: "", function: "" }], edges: [{ from: "x", to: "missing", label: "" }] }
    ]
  });

  it("drops malformed flows and keeps only references the extension can confirm", async () => {
    expect(draft.flows.map((flow) => flow.title)).toEqual(["Checking out a book"]);
    const input = await rootFlowsInput();
    const [flow] = checkedFlowReferences(draft, input.catalog);
    expect(flow!.refs).toEqual([
      null,
      { path: "inventory/lookup.go", function: "Catalog.FindAvailable" },
      { path: "storage/storage.go" },
      null,
      null
    ]);
  });

  it("saves flows with the overview model and outdates them when the catalog changes", async () => {
    const provider = new MockProvider();
    const service = new ExplanationService({
      store: new MemoryRepositoryCacheStore(),
      describeProvider: () => ({ kind: "mock", modelId: "fast" }),
      describeOverviewProvider: () => ({ kind: "mock", modelId: provider.modelId }),
      createProvider: async () => provider,
      authorizeExternalData: async () => true
    });
    const input = await rootFlowsInput();
    expect(await service.findProjectFlows(root, input)).toBeUndefined();
    const result = await service.describeProjectFlows(root, input);
    expect(result.flows[0]!.refs.filter(Boolean)).toEqual([
      { path: "inventory/inventory.go", function: input.catalog[0]!.functions[0] },
      { path: "inventory/lookup.go", function: input.catalog[1]!.functions[0] }
    ]);
    expect(await service.findProjectFlows(root, input)).toMatchObject({ current: true });
    expect(await service.findProjectFlows(root, { ...input, folderSummary: "Background only" })).toMatchObject({ current: true });
    const changed = await rootFlowsInput({ "main.go": "Starts the app." });
    expect(await service.findProjectFlows(root, changed)).toMatchObject({ current: false });
  });
});
