import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { folderSummaryInput } from "../src/context/folderInput";
import { listFolder } from "../src/context/inventory";
import { folderStructure } from "../src/context/structure";
import { ExplanationService } from "../src/controller";
import { MockProvider } from "../src/generation/mock";
import { folderSummaryPrompt } from "../src/generation/prompts";
import { parseFolderSummary } from "../src/generation/schema";
import { initializeGoParserAt } from "../src/languages/go/syntax";

const root = resolve("fixtures/go-app");

beforeAll(async () => {
  await initializeGoParserAt(resolve("."));
});

async function rootInput(fileSummaries: Record<string, string> = {}) {
  const { children } = await listFolder(root, "");
  const structure = await folderStructure(root, "", children);
  return folderSummaryInput("go-app", "", children, structure, {
    fileSummary: (path) => fileSummaries[path],
    folderSummary: async () => undefined,
    text: (path) => readFile(resolve(root, path), "utf8"),
    contents: async (path) => (await listFolder(root, path)).children.map((child) => child.name)
  });
}

describe("folder summary input", () => {
  it("holds names, saved summaries, function names, and imports, but no code", async () => {
    const input = await rootInput({ "report.go": "Prints a report of the catalog." });
    expect(input.parts).toEqual([
      { name: "inventory", kind: "folder", contents: ["inventory.go", "lookup.go"] },
      { name: "storage", kind: "folder", contents: ["storage.go"] },
      { name: "go.mod", kind: "file" },
      { name: "main_test.go", kind: "file", contents: ["TestCheckoutMarksBookUnavailable"] },
      { name: "main.go", kind: "file", contents: ["main", "checkout"] },
      { name: "report.go", kind: "file", summary: "Prints a report of the catalog." }
    ]);
    expect(input.imports).toContainEqual({ from: "main.go", to: "storage" });
    const [, user] = folderSummaryPrompt(input);
    expect(user).not.toContain("func ");
    expect(user).toContain("(repository root)");
  });

  it("keeps only usable part descriptions", () => {
    expect(parseFolderSummary({
      summary: " A library app. ",
      overview: "main.go starts it.",
      parts: [{ name: "storage", summary: "Saves books." }, { name: "", summary: "x" }, { name: "a", summary: 3 }, "junk"]
    })).toEqual({ summary: "A library app.", overview: "main.go starts it.", parts: [{ name: "storage", summary: "Saves books." }] });
    expect(() => parseFolderSummary({ overview: "" })).toThrow(/invalid "summary"/);
  });
});

describe("folder summaries in the service", () => {
  const service = (store: MemoryRepositoryCacheStore, provider: MockProvider) => new ExplanationService({
    store,
    describeProvider: () => ({ kind: "mock", modelId: provider.modelId }),
    createProvider: async () => provider,
    authorizeExternalData: async () => true
  });

  it("saves a summary, describes only parts without one, and outdates it when the input changes", async () => {
    const store = new MemoryRepositoryCacheStore();
    const provider = new MockProvider();
    const explanations = service(store, provider);
    const input = await rootInput({ "report.go": "Prints a report of the catalog." });
    expect(await explanations.findFolderSummary(root, input)).toBeUndefined();

    const result = await explanations.summarizeFolder(root, input);
    expect(result.value.summary).toContain("Mock summary of the repository");
    expect(result.value.parts.map((part) => part.name)).toEqual(["inventory", "storage", "go.mod", "main_test.go", "main.go"]);
    expect(await explanations.findFolderSummary(root, input)).toMatchObject({ current: true });
    expect(await explanations.savedFolderSummary(root, "")).toBe(result.value.summary);

    const changed = await rootInput({ "report.go": "Prints a monthly report of the catalog." });
    expect(await explanations.findFolderSummary(root, changed)).toMatchObject({ current: false });
    // The repository's purpose is background and does not outdate it.
    expect(await explanations.findFolderSummary(root, { ...input, repositoryPurpose: "Something else" })).toMatchObject({ current: true });
  });
});
