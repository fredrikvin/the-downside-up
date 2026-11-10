import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initializeJavaScriptParsersAt } from "../src/languages/javascript/syntax";
import { javascriptGuidance } from "../src/languages/javascript/guidance";
import { scanSvelte } from "../src/languages/svelte/blocks";
import { findSvelteDependencies } from "../src/languages/svelte/dependencies";
import { SVELTE_COMPONENT_GUIDANCE, SVELTE_NESTED_GUIDANCE, svelteGuidance } from "../src/languages/svelte/guidance";
import { svelteFileImports } from "../src/languages/svelte/imports";
import { describeSvelteSource } from "../src/languages/svelte/outline";
import { componentSignature, findSvelteFunction, listSvelteFunctions, svelteComparisonFunctions } from "../src/languages/svelte/syntax";
import { svelteSupport } from "../src/languages/svelte";
import { Position, Uri } from "./vscode";

function documentAt(path: string, text: string) {
  return {
    uri: Uri.file(path),
    languageId: "svelte",
    version: 1,
    getText: () => text
  } as unknown as import("vscode").TextDocument;
}

beforeAll(async () => {
  await initializeJavaScriptParsersAt(resolve("."));
});

describe("Svelte block scanner", () => {
  it("preserves offsets across module scripts, TypeScript scripts, markup, and styles", () => {
    const source = [
      "<script context=\"module\">export const prefix = \"x\";</script>",
      "<script lang=\"ts\">function run() { return \"<\\\\/script>\"; }</script>",
      "<!-- <script>ignored()</script> -->",
      "{#if ready}<p>yes</p>{/if}",
      "<style>p { color: red }</style>"
    ].join("\n");
    const scan = scanSvelte(source);
    expect(scan.supported).toBe(true);
    expect(scan.scripts).toHaveLength(2);
    expect(scan.scripts.map((block) => [block.module, block.typescript])).toEqual([[true, false], [false, true]]);
    expect(scan.scriptView.length).toBe(source.length);
    expect(scan.scriptView.indexOf("function run")).toBe(source.indexOf("function run"));
    expect(scan.markupView).toContain("{#if ready}");
    expect(scan.markupView).not.toContain("color: red");
    expect(scan.scriptView).not.toContain("ignored()");
  });

  it("declines overlarge source instead of scanning it without bounds", () => {
    expect(scanSvelte("x".repeat(256 * 1024 + 1)).supported).toBe(false);
  });

  it("does not mistake tags inside quoted attributes for component blocks", () => {
    const scan = scanSvelte('<div title="<script>not code</script>"><p>text</p></div>');
    expect(scan.supported).toBe(true);
    expect(scan.scripts).toEqual([]);
    expect(scan.markupView).toContain("<div title=");
  });
});

describe("Svelte component and script function discovery", () => {
  const path = resolve("fixtures/svelte-app/src/App.svelte");
  const source = readFileSync(path, "utf8");

  it("lists the component and its named script functions, and selects each by location", async () => {
    const entries = await listSvelteFunctions(source, path);
    expect(entries.map((entry) => entry.qualifiedName)).toEqual(["App", "App.increment"]);
    const document = documentAt(path, source);
    const markupPosition = new Position(source.split("\n").findIndex((line) => line.includes("<Card")), 2) as unknown as import("vscode").Position;
    expect(await findSvelteFunction(document, markupPosition)).toMatchObject({
      name: "App", qualifiedName: "App", analysis: "svelte-scanner"
    });
    expect((await findSvelteFunction(document, markupPosition))?.source).not.toContain("color: red");
    const functionPosition = new Position(source.split("\n").findIndex((line) => line.includes("count += 1")), 6) as unknown as import("vscode").Position;
    expect(await findSvelteFunction(document, functionPosition)).toMatchObject({
      name: "increment", qualifiedName: "App.increment", analysis: "svelte-scanner"
    });
  });

  it("includes the whole component and script functions in comparisons", async () => {
    const result = await svelteComparisonFunctions(source, path);
    expect(result.status).toBe("complete");
    expect(result.entries.map((entry) => [entry.kind, entry.qualifiedName])).toEqual([
      ["component", "App"], ["function", "App.increment"]
    ]);
  });

  it("qualifies module-script functions separately from instance-script functions", async () => {
    const path = "/repo/src/Panel.svelte";
    const source = [
      '<script context="module">export function create() { return 1; }</script>',
      "<script>function update() { return 2; }</script>",
      "<p>Panel</p>"
    ].join("\n");
    const entries = await listSvelteFunctions(source, path);
    expect(entries.map((entry) => entry.qualifiedName)).toEqual([
      "Panel", "Panel.module.create", "Panel.update"
    ]);
  });

  it("uses the TypeScript grammar for lang=ts scripts and extracts rune props", async () => {
    const path = "/repo/src/Typed.svelte";
    const source = [
      '<script lang="ts">',
      "  let { label, count = 0 }: { label: string; count?: number } = $props();",
      "  const identity = <T>(value: T): T => value;",
      "</script><p>{identity(label)}</p>"
    ].join("\n");
    const entries = await listSvelteFunctions(source, path);
    expect(entries.map((entry) => entry.qualifiedName)).toContain("Typed.identity");
    expect(componentSignature(source, "Typed")).toBe("Typed takes props { label, count = 0 }");
  });

  it("excludes style-only changes from Svelte structure fingerprints", async () => {
    const before = await svelteSupport.textFingerprint!(source, path);
    const after = await svelteSupport.textFingerprint!(source.replace("color: red", "color: blue"), path);
    expect(after).toBe(before);
  });
});

describe("Svelte outlines, imports, and guidance", () => {
  const path = resolve("fixtures/svelte-app/src/App.svelte");
  const source = readFileSync(path, "utf8");

  it("describes the component and its script functions", async () => {
    const outline = await describeSvelteSource(source, path);
    expect(outline.drafts.filter((entry) => entry.explainable).map((entry) => entry.qualifiedName))
      .toEqual(["App", "App.increment"]);
    expect(outline.drafts.some((entry) => entry.kindLabel === "Markup")).toBe(true);
  });

  it("resolves relative component imports and the conventional SvelteKit $lib alias", async () => {
    const files = new Set([
      "src/App.svelte",
      "components/Card.svelte",
      "src/lib/state.svelte.ts"
    ]);
    expect(await svelteFileImports({
      path: "src/App.svelte", text: source,
      hasFile: (path) => files.has(path),
      readFile: async () => undefined
    })).toEqual(["components/Card.svelte", "src/lib/state.svelte.ts"]);
  });

  it("resolves imported Svelte components statically without a Svelte language server", async () => {
    const card = readFileSync(resolve("fixtures/svelte-app/components/Card.svelte"), "utf8");
    const result = await findSvelteDependencies({
      root: resolve("fixtures/svelte-app"),
      path: "src/App.svelte",
      text: source,
      line: 0,
      name: "App",
      readablePaths: new Set(["src/App.svelte", "components/Card.svelte"]),
      load: async (path) => path === "components/Card.svelte" ? card : undefined
    });
    expect(result.dependencies.map(({ path, item }) => [path, item.kind, item.name]))
      .toContainEqual(["components/Card.svelte", "component", "Card"]);
  });

  it("provides fixed guidance for components and their script functions", async () => {
    expect(await svelteGuidance({
      path, text: source, line: 0, name: "App", qualifiedName: "App"
    })).toBe(SVELTE_COMPONENT_GUIDANCE);
    const functionEntry = (await listSvelteFunctions(source, path)).find((entry) => entry.name === "increment")!;
    expect(await svelteGuidance({
      path, text: source, line: functionEntry.startLine,
      name: functionEntry.name, qualifiedName: functionEntry.qualifiedName
    })).toBe(SVELTE_NESTED_GUIDANCE);
  });

  it("adds rune guidance to JavaScript functions in .svelte.ts modules", async () => {
    const modulePath = "/repo/src/counter.svelte.ts";
    const moduleText = "export function createCounter() { return $state(0); }";
    const guidance = await javascriptGuidance({
      path: modulePath, text: moduleText, line: 0,
      name: "createCounter", qualifiedName: "createCounter"
    });
    expect(guidance).toContain("Svelte rune module");
    expect(guidance).toContain("$state");
  });
});
