import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFileOverview } from "../src/context/fileOverview";
import { initializeGoParserAt } from "../src/languages/go";
import { CONCISE_OUTLINE, outlineInclude, visibleOutline } from "../src/presentation/outlineFilter";
import { Uri } from "./vscode";

beforeAll(async () => {
  await initializeGoParserAt(resolve("."));
});

const source = [
  "// Package demo shows the filter.",
  "package demo",
  "",
  "import \"fmt\"",
  "",
  "const Limit = 3",
  "",
  "type Box struct {",
  "\tsize int",
  "}",
  "",
  "// A standalone comment.",
  "",
  "func (b *Box) Grow(by int) int {",
  "\tnext := b.size + by",
  "\treturn next",
  "}",
  "",
  "func Show(b Box) {",
  "\tfmt.Println(b.size)",
  "}"
].join("\n");

async function entries() {
  const document = { uri: Uri.file("/workspace/demo.go"), languageId: "go", getText: () => source } as unknown as import("vscode").TextDocument;
  return (await buildFileOverview(document, "demo.go")).entries;
}

describe("concise outline", () => {
  it("shows only functions, without local signature descriptions, by default", async () => {
    const visible = visibleOutline(await entries(), CONCISE_OUTLINE);
    expect(visible.map((entry) => [entry.kindLabel, entry.qualifiedName, entry.depth])).toEqual([
      ["Method", "Box.Grow", 0],
      ["Function", "Show", 0]
    ]);
    expect(visible.every((entry) => entry.description.length === 0 && entry.notes.length === 0)).toBe(true);
  });

  it("adds each kind of detail on request and keeps nesting relative to visible items", async () => {
    const all = await entries();
    const everything = visibleOutline(all, outlineInclude({
      imports: true, types: true, values: true, locals: true, comments: true, modules: true, functionDetails: true
    }));
    expect(everything.map((entry) => [entry.kindLabel, entry.depth])).toEqual(all.map((entry) => [entry.kindLabel, entry.depth]));
    expect(everything.find((entry) => entry.name === "Grow")!.description.length).toBeGreaterThan(0);

    const withLocals = visibleOutline(all, outlineInclude({ locals: true, imports: true }));
    expect(withLocals.map((entry) => [entry.kindLabel, entry.depth])).toEqual([
      ["Import", 0],
      ["Method", 0],
      ["Local", 1],
      ["Function", 0]
    ]);
    expect(visibleOutline(all, outlineInclude({ values: true })).some((entry) => entry.name === "Limit")).toBe(true);
    expect(visibleOutline(all, outlineInclude({ values: true })).some((entry) => entry.kindLabel === "Local")).toBe(false);
  });

  it("treats missing or invalid settings as concise", () => {
    expect(outlineInclude(undefined)).toEqual(CONCISE_OUTLINE);
    expect(outlineInclude({ imports: "yes" })).toEqual(CONCISE_OUTLINE);
  });
});

describe("fixture", () => {
  it("keeps every method of the Go fixture", async () => {
    const document = {
      uri: Uri.file("/workspace/inventory/lookup.go"),
      languageId: "go",
      getText: () => readFileSync(resolve("fixtures/go-app/inventory/lookup.go"), "utf8")
    } as unknown as import("vscode").TextDocument;
    const visible = visibleOutline((await buildFileOverview(document, "inventory/lookup.go")).entries, CONCISE_OUTLINE);
    expect(visible.map((entry) => entry.qualifiedName)).toEqual(["Catalog.FindAvailable", "Catalog.MarkUnavailable"]);
  });
});
