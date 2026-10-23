import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { projectFlowsInput } from "../src/context/folderInput";
import { listEligibleFiles, listFolder } from "../src/context/inventory";
import { folderStructure } from "../src/context/structure";
import { checkedFlowReferences, checkedPartReferences, ExplanationService } from "../src/controller";
import { MockProvider } from "../src/generation/mock";
import { partFlowsPrompt, projectFlowsPrompt } from "../src/generation/prompts";
import { parsePartFlows, parseProjectFlows } from "../src/generation/schema";
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
      allowMock: true,
      store: new MemoryRepositoryCacheStore(),
      describeProvider: () => ({ kind: "mock", modelId: "fast" }),
      describeOverviewProvider: () => ({ kind: "mock", modelId: provider.modelId }),
      createProvider: async () => provider,
      authorizeExternalData: async () => true
    });
    const input = await rootFlowsInput();
    const request = { kind: "files" as const, input };
    expect(await service.findProjectFlows(root, request)).toBeUndefined();
    const result = await service.describeProjectFlows(root, request);
    expect(result.flows[0]!.refs.filter(Boolean)).toEqual([
      { path: "inventory/inventory.go", function: input.catalog[0]!.functions[0] },
      { path: "inventory/lookup.go", function: input.catalog[1]!.functions[0] }
    ]);
    expect(await service.findProjectFlows(root, request)).toMatchObject({ current: true });
    expect(await service.findProjectFlows(root, { kind: "files", input: { ...input, folderSummary: "Background only" } })).toMatchObject({ current: true });
    const changed = { kind: "files" as const, input: await rootFlowsInput({ "main.go": "Starts the app." }) };
    expect(await service.findProjectFlows(root, changed)).toMatchObject({ current: false });
  });
});

describe("flows between map parts", () => {
  const input = {
    repositoryName: "center",
    path: "",
    level: "project" as const,
    summary: "A device center.",
    parts: [
      { id: "web", name: "Web frontend", summary: "The web app.", place: "inside" as const },
      { id: "bff", name: "BFF", summary: "GraphQL API.", place: "inside" as const },
      { id: "devices", name: "Cameras", summary: "Devices.", place: "external" as const }
    ],
    links: [{ from: "web", to: "bff", label: "GraphQL" }, { from: "devices", to: "bff", label: "MQTT" }]
  };
  const paths = new Map([["web", "websites/web"], ["bff", "services/bff"]]);

  it("keeps a step's part only when the map lists it, opening parts in the repository as folders", () => {
    const draft = parsePartFlows({
      flows: [{
        title: "Viewing a camera",
        summary: "The app asks the BFF.",
        nodes: [
          { id: "s", kind: "start", label: "Open the page", part: "web" },
          { id: "a", kind: "action", label: "Ask for cameras", part: "bff" },
          { id: "b", kind: "action", label: "Report status", part: "devices" },
          { id: "c", kind: "action", label: "Invented", part: "ghost" },
          { id: "e", kind: "end", label: "Shown", part: "" }
        ],
        edges: [{ from: "s", to: "a", label: "GraphQL" }, { from: "a", to: "b", label: "" }, { from: "b", to: "c", label: "" }, { from: "c", to: "e", label: "" }]
      }]
    });
    const [flow] = checkedPartReferences(draft, input, paths);
    expect(flow!.refs).toEqual([
      { path: "websites/web", folder: true },
      { path: "services/bff", folder: true },
      null,
      null,
      null
    ]);
    const [system, user] = partFlowsPrompt(input);
    expect(system).toContain("a software project");
    expect(user).toContain("\"connections\"");
  });

  it("saves part flows and outdates them when the map's parts or links change", async () => {
    const provider = new MockProvider();
    const service = new ExplanationService({
      allowMock: true,
      store: new MemoryRepositoryCacheStore(),
      describeProvider: () => ({ kind: "mock", modelId: "fast" }),
      createProvider: async () => provider,
      authorizeExternalData: async () => true
    });
    const request = { kind: "parts" as const, input, paths };
    const result = await service.describeProjectFlows(root, request);
    expect(result.flows[0]!.refs.filter(Boolean)).toEqual([{ path: "websites/web", folder: true }, { path: "services/bff", folder: true }]);
    expect(await service.findProjectFlows(root, request)).toMatchObject({ current: true });
    expect(await service.findProjectFlows(root, { ...request, input: { ...input, summary: "Background only" } })).toMatchObject({ current: true });
    expect(await service.findProjectFlows(root, { ...request, input: { ...input, links: [input.links[0]!] } })).toMatchObject({ current: false });
  });
});
