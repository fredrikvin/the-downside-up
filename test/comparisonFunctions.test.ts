import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyComparisonFunctions, comparisonCatalogue } from "../src/context/comparisonFunctions";
import { languageFor } from "../src/languages/registry";
import { initializeLanguage } from "../src/languages/registry";
import type { FunctionDiscovery } from "../src/languages/support";
import type { ComparisonSnapshot } from "../src/context/comparison";

const discover = (source: string, path = "a.ts") => languageFor({ path }).comparisonFunctions!(source, path);
const classify = async (before: string, after: string, path = "a.ts") =>
  classifyComparisonFunctions(await discover(before, path), await discover(after, path), "snapshot");

beforeAll(async () => {
  for (const path of ["a.ts", "a.py", "a.go", "a.rs"]) await initializeLanguage(languageFor({ path }), resolve("."));
});

describe("exact snapshot function classification", () => {
  it("classifies additions, removals, executable signature and body changes, omitting unchanged functions", async () => {
    const result = await classify(
      "function removed() { return 0; }\nfunction changed(a: number) { return a; }\nfunction body() { return 1; }\nfunction same() { return 3; }",
      "function added() { return 2; }\nfunction changed(a: string) { return a; }\nfunction body() { return 2; }\nfunction same() { return 3; }");
    expect(result.classified).toBe(true);
    expect(result.entries.map((entry) => [entry.name, entry.category])).toEqual([
      ["removed", "removed"], ["changed", "changed"], ["body", "changed"], ["added", "added"]
    ]);
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(4);
    expect((await classify("function a() {}", "function a() {}")).entries).toEqual([]);
  });

  it("ignores comments and formatting while retaining literal contents", async () => {
    expect((await classify("function a(){return 1;}", "function a() {\n// comment\n return 1;\n}")).entries).toEqual([]);
    expect((await classify('function a(){return "a b";}', 'function a(){return "ab";}')).entries[0]?.category).toBe("changed");
    expect((await classify("def a():\n return 1\n", "def a():\n # comment\n return 1\n", "a.py")).entries).toEqual([]);
    expect((await classify("struct Foo<T>(T); impl Foo<i32> { fn work() {} }",
      "struct Foo<T>(T); impl Foo < i32 > { fn work( ) { /* note */ } }", "a.rs")).entries).toEqual([]);
  });

  it("keeps nested functions and treats renames and container moves as removed and added", async () => {
    const result = await classify("function outer(){ function old(){} }", "function outer(){ function next(){} }");
    expect(result.entries.map((entry) => [entry.name, entry.category])).toEqual([
      ["outer", "changed"], ["outer.old", "removed"], ["outer.next", "added"]
    ]);
    const moved = await classify("class A { work() {} }", "class B { work() {} }");
    expect(moved.entries.map((entry) => entry.category)).toEqual(["removed", "added"]);
    const rust = await classify("fn a() { fn inner() {} }\nfn b() {}", "fn a() {}\nfn b() { fn inner() {} }", "a.rs");
    expect(rust.entries.filter((entry) => entry.name.endsWith("inner")).map((entry) => entry.category)).toEqual(["removed", "added"]);
  });

  it("folds overload declarations into their implementation and counts overload-only signature edits", async () => {
    const before = "function f(a: string): string;\nfunction f(a: any) { return a; }";
    const after = "function f(a: number): number;\nfunction f(a: any) { return a; }";
    expect((await discover(before)).entries).toHaveLength(1);
    expect((await classify(before, after)).entries.map((entry) => entry.category)).toEqual(["changed"]);
  });

  it("pairs unique repeated init declarations by exact body, never by their lexical ordinal", async () => {
    const before = "package a\nfunc init(){ println(1) }\nfunc init(){ println(2) }\n";
    const after = "package a\nfunc init(){ println(2) }\nfunc init(){ println(1) }\n";
    expect((await classify(before, after, "a.go")).entries).toEqual([]);
    const ambiguous = await classify("function a(){}\nfunction a(){}", "function a(){return 1;}\nfunction a(){return 2;}");
    expect(ambiguous.entries.map((entry) => entry.category)).toEqual(["removed", "removed", "added", "added"]);
    expect(ambiguous.limitations.join(" ")).toContain("Ambiguous");
  });

  it("keeps SQL schema/query edits outside callable categories and disambiguates routine signatures", async () => {
    expect((await classify("", "CREATE TABLE a (id int); SELECT * FROM a;", "a.sql")).entries).toEqual([]);
    const result = await classify("", "CREATE FUNCTION f(a int) RETURNS int AS $$ SELECT a; $$ LANGUAGE sql;", "a.sql");
    expect(result.entries.map((entry) => entry.category)).toEqual(["added"]);
    expect((await classify("CREATE FUNCTION broken", "CREATE FUNCTION f() RETURNS int AS $$SELECT 1;$$ LANGUAGE sql;", "a.sql")).classified).toBe(false);
  });

  it("never interprets unavailable, partial, malformed, or over-budget discovery as an empty original", async () => {
    const complete = await discover("function added() {}");
    for (const status of ["partial", "unavailable"] as const) {
      const missing: FunctionDiscovery = { status, entries: [], limitations: [] };
      expect(classifyComparisonFunctions(missing, complete, "s")).toMatchObject({ classified: false, entries: [] });
    }
    const malformed = await classify("function missing( {", "function added() {}");
    expect(malformed).toMatchObject({ classified: false, entries: [] });
    expect((await classify("", Array.from({ length: 101 }, (_, i) => `function f${i}(){}`).join("\n"))).classified).toBe(false);
    expect((await classify("", "function added() {}")).entries[0]?.category).toBe("added");
  });

  it("safely falls back when the language has no complete snapshot inventory", async () => {
    const side = { path: "a.unknown", identity: "working", state: "present", detail: "", text: "text", fingerprint: "x", lines: 1 } as const;
    const snapshot: ComparisonSnapshot = { root: "/repo", original: { ...side, text: "before" }, modified: side };
    expect(await comparisonCatalogue(snapshot)).toMatchObject({ classified: false, entries: [] });
  });

  it("binds ids to snapshots rather than names alone", async () => {
    const empty = await discover("");
    const added = await discover("function a(){}");
    expect(classifyComparisonFunctions(empty, added, "one").entries[0]?.id)
      .not.toBe(classifyComparisonFunctions(empty, added, "two").entries[0]?.id);
  });
});
