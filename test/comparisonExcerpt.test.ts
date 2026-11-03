import { describe, expect, it } from "vitest";
import type { ComparisonContextRequest, ComparisonSourceRange } from "../src/core/types";
import type { ComparisonSnapshot } from "../src/context/comparison";
import type { ComparisonFunction, FunctionDiscovery } from "../src/languages/support";
import {
  buildComparisonExcerpt, expandComparisonExcerpt, excerptOmitted, type ComparisonExcerpt
} from "../src/context/comparisonExcerpt";
import { classifyComparisonFunctions } from "../src/context/comparisonFunctions";
import { comparisonSourceLines, sourceDiff, sourceHunks } from "../src/context/sourceDiff";

function snapshot(before: string | undefined, after: string | undefined): ComparisonSnapshot {
  const side = (text: string | undefined) => ({
    path: "a.ts", identity: "working", state: text === undefined ? "absent" as const : "present" as const,
    detail: "", text: text ?? "", fingerprint: "exact", lines: comparisonSourceLines(text ?? "").length
  });
  return { root: "/repo", original: side(before), modified: side(after) };
}

function fn(name: string, start: number, end: number, signature = `function ${name}()`): ComparisonFunction {
  return {
    name, qualifiedName: name, signature, startLine: start - 1, endLine: end - 1,
    startColumn: 0, endColumn: 1, nameLine: start - 1, nameColumn: 0,
    source: "", fingerprint: name, signatureFingerprint: name, matchKey: name, kind: "function"
  };
}

function inventories(original: readonly ComparisonFunction[] = [], modified = original) {
  const discovery = (entries: readonly ComparisonFunction[]): FunctionDiscovery => ({
    status: "complete", entries, limitations: []
  });
  const before = discovery(original);
  const after = discovery(modified);
  return { original: before, modified: after, catalogue: classifyComparisonFunctions(before, after, "snapshot") };
}

const contains = (ranges: readonly ComparisonSourceRange[], start: number, end = start) =>
  ranges.some((range) => range.start <= start && range.end >= end);
const count = (excerpt: ComparisonExcerpt) => [...excerpt.original, ...excerpt.modified]
  .reduce((sum, range) => sum + range.end - range.start + 1, 0);
const limitLines = (limit: number) => (excerpt: ComparisonExcerpt) => count(excerpt) <= limit;
const request = (side: "original" | "modified", startLine: number, endLine = startLine): ComparisonContextRequest =>
  ({ side, startLine, endLine, reason: "Need the relevant source." });
const notices = (excerpt: ComparisonExcerpt) => excerpt.limitations.join(" ");

/** Match the integration's obligation to measure the serialized source and notices, not range metadata alone. */
function serialized(snapshot: ComparisonSnapshot, excerpt: ComparisonExcerpt): number {
  const render = (side: "original" | "modified") => {
    const lines = comparisonSourceLines(snapshot[side].text);
    return excerpt[side].map((range) => ({
      ...range, source: lines.slice(range.start - 1, range.end)
    }));
  };
  return Buffer.byteLength(JSON.stringify({
    original: render("original"), modified: render("modified"), limitations: excerpt.limitations
  }));
}

describe("diff-first comparison excerpts", () => {
  it("keeps a small edit in a near-limit file at absolute lines without sending the whole file", () => {
    const before = Array.from({ length: 18000 }, (_, i) => `source ${i + 1}`);
    const after = [...before];
    after[9999] = "changed";
    const source = snapshot(before.join("\n"), after.join("\n"));
    const excerpt = buildComparisonExcerpt(source, inventories(), limitLines(200));
    expect(contains(excerpt.original, 10000)).toBe(true);
    expect(contains(excerpt.modified, 10000)).toBe(true);
    expect(count(excerpt)).toBeLessThanOrEqual(200);
    expect(excerptOmitted(source, excerpt).original).toBeGreaterThan(17000);
    for (const notice of excerpt.limitations.filter((notice) => /omitted/i.test(notice))) {
      expect(notice).toContain("only supplied source can support behavior");
    }
  });

  it.each([
    [undefined, "added\nbody\n", [], [{ start: 1, end: 3 }]],
    ["removed\nbody\n", undefined, [{ start: 1, end: 3 }], []],
    ["old", "new", [{ start: 1, end: 1 }], [{ start: 1, end: 1 }]]
  ] as const)("preserves complete mandatory added/removed text (%s -> %s)", (before, after, original, modified) => {
    const excerpt = buildComparisonExcerpt(snapshot(before, after), inventories(), () => true);
    expect(excerpt.original).toEqual(original);
    expect(excerpt.modified).toEqual(modified);
  });

  it.each([
    ["a\nb", "a\nb\n", "modified"],
    ["a\nb\n", "a\nb", "original"],
    ["a\r\nb", "a\r\nb\r\n", "modified"],
    ["a\rb", "a\rb\r", "modified"],
    ["", "\n", "modified"],
    ["\n", "", "original"]
  ] as const)("retains terminal newline-only edits (%j -> %j)", (before, after, side) => {
    const source = snapshot(before, after);
    const diff = sourceDiff(source);
    const end = comparisonSourceLines(source[side].text).length;
    expect(contains(diff[side], end)).toBe(true);
    const mandatory = diff.original.concat(diff.modified).reduce((sum, range) => sum + range.end - range.start + 1, 0);
    const excerpt = buildComparisonExcerpt(source, inventories(), limitLines(mandatory));
    expect(contains(excerpt[side], end)).toBe(true);
    expect(count(excerpt)).toBe(mandatory);
  });

  it("tracks insertions and removals at their independent absolute positions", () => {
    const source = snapshot(
      "one\ntwo\nremove\nthree\nfour\nfive\nsix",
      "one\ntwo\nthree\nfour\nadd\nfive\nsix");
    const diff = sourceDiff(source);
    expect(diff.original).toEqual([{ start: 3, end: 3 }]);
    expect(diff.modified).toEqual([{ start: 5, end: 5 }]);
    expect(buildComparisonExcerpt(source, inventories(), limitLines(2))).toMatchObject({
      original: diff.original, modified: diff.modified
    });
  });

  it("merges touching hunk context while retaining disjoint mandatory ranges", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[9] = "first edit";
    after[13] = "second edit";
    const diff = sourceDiff(snapshot(before.join("\n"), after.join("\n")));
    expect(diff.original).toEqual([{ start: 10, end: 10 }, { start: 14, end: 14 }]);
    expect(diff.context.original).toEqual([{ start: 7, end: 17 }]);
    expect(diff.context.modified).toEqual([{ start: 7, end: 17 }]);
  });

  it("retains a bounded aligner's whole unresolved replacement, never dropping changed lines", () => {
    const before = ["prefix", ...Array.from({ length: 100 }, (_, i) => `old ${i}`), "suffix"];
    const after = ["prefix", ...Array.from({ length: 100 }, (_, i) => `new ${i}`), "suffix"];
    const excerpt = buildComparisonExcerpt(snapshot(before.join("\n"), after.join("\n")), inventories(), limitLines(200));
    expect(excerpt.original).toEqual([{ start: 2, end: 101 }]);
    expect(excerpt.modified).toEqual([{ start: 2, end: 101 }]);
    expect(notices(excerpt)).toContain("entire replacement region");
  });

  it("completes enclosing functions from the full inventory, including semantically unchanged functions", () => {
    const before = ["header", "function same() {", ...Array.from({ length: 20 }, (_, i) => ` // ${i}`), "}"];
    const after = [...before];
    after[11] = " // changed comment";
    const found = inventories([fn("same", 2, 23)]);
    expect(found.catalogue.entries).toEqual([]);
    const excerpt = buildComparisonExcerpt(snapshot(before.join("\n"), after.join("\n")), found, () => true);
    expect(contains(excerpt.original, 2, 23)).toBe(true);
    expect(contains(excerpt.modified, 2, 23)).toBe(true);
    expect(excerptOmitted(snapshot(before.join("\n"), after.join("\n")), excerpt)).toEqual({ original: 0, modified: 0 });
  });

  it("limits the language-neutral header to 80 lines before the first function", () => {
    const before = [...Array.from({ length: 100 }, (_, i) => `header ${i}`), "function f() {", "old", "}"];
    const after = [...before];
    after[101] = "new";
    const excerpt = buildComparisonExcerpt(snapshot(before.join("\n"), after.join("\n")), inventories([fn("f", 101, 103)]), () => true);
    expect(excerpt.original).toEqual([{ start: 1, end: 80 }, { start: 99, end: 103 }]);
    expect(excerpt.modified).toEqual(excerpt.original);
  });

  it("bounds header UTF-8 bytes to 8 KiB and never includes a partial header line", () => {
    const before = [...Array.from({ length: 10 }, () => "é".repeat(1024)), "function f() {", "old", "}"];
    const after = [...before];
    after[11] = "new";
    const excerpt = buildComparisonExcerpt(snapshot(before.join("\n"), after.join("\n")), inventories([fn("f", 11, 13)]), () => true);
    expect(excerpt.original[0]).toEqual({ start: 1, end: 3 });
    expect(contains(excerpt.original, 4)).toBe(false);
  });

  it("adds discovered multiline signature hints only for call-like names in changed lines", () => {
    const before = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    before[19] = "old()";
    before[59] = "function helper(";
    before[60] = " arg";
    before[61] = ") {";
    before[89] = "}";
    const after = [...before];
    after[19] = "helper(2); notCalled;";
    const found = inventories([
      fn("main", 10, 30), fn("helper", 60, 90, "function helper(\n arg\n)"), fn("notCalled", 100, 110)
    ]);
    const excerpt = buildComparisonExcerpt(snapshot(before.join("\n"), after.join("\n")), found, () => true);
    expect(contains(excerpt.modified, 60, 62)).toBe(true);
    expect(contains(excerpt.modified, 63)).toBe(false);
    expect(contains(excerpt.modified, 100)).toBe(false);
    expect(contains(excerpt.original, 60)).toBe(false);
    expect(notices(excerpt)).toContain("not resolved dependencies");
  });

  it("degrades to bare edits when context and complete bodies cannot fit, measuring the final serialized request", () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[49] = "a change";
    const source = snapshot(before.join("\n"), after.join("\n"));
    const found = inventories([fn("enclosing", 1, 100)]);
    let mandatory: ComparisonExcerpt | undefined;
    buildComparisonExcerpt(source, found, (candidate) => {
      mandatory ??= candidate;
      return count(candidate) <= 2;
    });
    const max = serialized(source, mandatory!);
    const excerpt = buildComparisonExcerpt(source, found, (candidate) => serialized(source, candidate) <= max);
    expect(excerpt.original).toEqual([{ start: 50, end: 50 }]);
    expect(excerpt.modified).toEqual([{ start: 50, end: 50 }]);
    expect(serialized(source, excerpt)).toBeLessThanOrEqual(max);
    expect(notices(excerpt)).toContain("Partial bodies do not establish complete behavior or safety");
  });

  it.each([[undefined, "huge addition"], ["huge removal", undefined]] as const)(
    "throws an actionable Max Request Size error instead of dropping a changed body", (before, after) => {
      expect(() => buildComparisonExcerpt(snapshot(before, after), inventories(), limitLines(0)))
        .toThrow(/Max Request Size.*Increase Max Request Size/);
    });

  it("does not truncate a huge added function to its signature or a partial body", () => {
    const body = ["function huge() {", ...Array.from({ length: 3000 }, () => "  doWork();"), "}"].join("\n");
    const source = snapshot(undefined, body);
    const found = inventories([], [fn("huge", 1, 3002)]);
    expect(() => buildComparisonExcerpt(source, found, (candidate) => serialized(source, candidate) <= 32 * 1024))
      .toThrow(/Max Request Size/);
  });

  it("reports incomplete discovery and rejects unreadable or oversized snapshots before scanning", () => {
    const source = snapshot("old", "new");
    const found = inventories();
    found.original = { status: "partial", entries: [], limitations: ["Unavailable inventory evidence."] };
    expect(notices(buildComparisonExcerpt(source, found, () => true))).toContain("Function discovery is incomplete");
    expect(() => buildComparisonExcerpt({ ...source, original: { ...source.original, state: "excluded" } }, found, () => true))
      .toThrow(/authorized/);
    expect(() => buildComparisonExcerpt(snapshot("é".repeat(131073), "new"), found, () => true)).toThrow(/256 KiB/);
  });

  it("preserves the review-summary legacy hunk wire output", () => {
    expect(sourceHunks(snapshot("one\nold\nthree\n", "one\nnew\nthree\n"))).toEqual({
      diff: "@@ -1,3 +1,3 @@\n one\n-old\n+new\n three",
      contextLines: 3, omittedContext: { original: 0, modified: 0 },
      limitations: ["Bounded diff alignment retained an entire replacement region; it may contain unchanged lines."]
    });
    expect(sourceHunks(snapshot("a\nb", "a\nb\n")).diff).toBe("@@ -1,2 +1,2 @@\n a\n b");
  });
});

describe("bounded follow-up comparison context", () => {
  const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 249\n", "changed\n");
  const source = snapshot(before, after);
  const found = inventories([fn("enclosing", 100, 160)]);
  const initial = () => buildComparisonExcerpt(source, found, limitLines(2));

  it("expands to the smallest enclosing function, merges ranges and never removes existing evidence", () => {
    const original = initial();
    const expanded = expandComparisonExcerpt(source, found, original, [request("modified", 120, 125)], () => true);
    expect(expanded.original).toEqual(original.original);
    expect(expanded.modified).toEqual([{ start: 100, end: 160 }, { start: 250, end: 250 }]);
    const merged = expandComparisonExcerpt(source, found, expanded, [request("modified", 161, 250)], () => true);
    expect(merged.modified).toEqual([{ start: 100, end: 250 }]);
    expect(original.modified).toEqual([{ start: 250, end: 250 }]);
  });

  it("uses the exact requested range if the enclosing body exceeds budget", () => {
    const expanded = expandComparisonExcerpt(source, found, initial(), [request("original", 120, 125)], limitLines(8));
    expect(expanded.original).toEqual([{ start: 120, end: 125 }, { start: 250, end: 250 }]);
    expect(notices(expanded)).toContain("exact-range fallback=1");
    expect(notices(expanded)).toContain("Partial bodies");
  });

  it("declines over-budget context with an explicit limitation and no lost ranges", () => {
    const original = initial();
    const expanded = expandComparisonExcerpt(source, found, original, [request("modified", 10, 20)], limitLines(2));
    expect(expanded.original).toEqual(original.original);
    expect(expanded.modified).toEqual(original.modified);
    expect(notices(expanded)).toContain("budget declined=1");
  });

  it("reserves notice overhead so declined and duplicate requests still fit an exact final serialized budget", () => {
    const original = initial();
    const max = serialized(source, original);
    let finalChecked: ComparisonExcerpt | undefined;
    const expanded = expandComparisonExcerpt(source, found, original,
      [request("modified", 250), request("modified", 100, 120)], (candidate) => {
        finalChecked = candidate;
        return serialized(source, candidate) <= max;
      });
    expect(finalChecked).toEqual(expanded);
    expect(serialized(source, expanded)).toBeLessThanOrEqual(max);
    expect(notices(expanded)).toContain("duplicate/already supplied=1");
    expect(notices(expanded)).toContain("budget declined=1");
  });

  it("checks a fallback exactly if the caller changes its budget during expansion", () => {
    const original = initial();
    let checks = 0;
    let lastChecked: ComparisonExcerpt | undefined;
    const expanded = expandComparisonExcerpt(source, found, original, [request("modified", 120)], (candidate) => {
      checks++;
      lastChecked = candidate;
      return checks === 1 || count(candidate) <= 2;
    });
    expect(checks).toBe(3);
    expect(lastChecked).toEqual(expanded);
    expect(expanded.original).toEqual(original.original);
    expect(expanded.modified).toEqual(original.modified);
    expect(notices(expanded)).toContain("budget declined=1");
    expect(notices(expanded)).toContain("supplied=0");
  });

  it.each([
    request("original", 0), request("original", -1), request("original", 3, 2),
    request("original", 1, 201), request("original", 401), request("original", 1.5),
    request("original", 1, Number.NaN), request("original", 1, Infinity),
    { ...request("original", 1), reason: "" },
    { ...request("original", 1), side: "invented" },
    null
  ])("ignores invalid untrusted requests without throwing (%j)", (invalid) => {
    const original = initial();
    const expanded = expandComparisonExcerpt(source, found, original, [invalid] as ComparisonContextRequest[], () => true);
    expect(expanded.original).toEqual(original.original);
    expect(expanded.modified).toEqual(original.modified);
    expect(notices(expanded)).toContain("invalid=1");
  });

  it("bounds requests to six and 200 lines each", () => {
    const expanded = expandComparisonExcerpt(source, found, initial(),
      Array.from({ length: 7 }, (_, i) => request("original", 1 + i * 2)), () => true);
    expect(contains(expanded.original, 11)).toBe(true);
    expect(contains(expanded.original, 13)).toBe(false);
    expect(notices(expanded)).toContain("beyond six=some");
    const maxRange = expandComparisonExcerpt(source, inventories(), initial(), [request("modified", 1, 200)], () => true);
    expect(contains(maxRange.modified, 1, 200)).toBe(true);
  });

  it("marks absent sides and repeated requests explicitly, including declined duplicates", () => {
    const added = snapshot(undefined, "added");
    const original = buildComparisonExcerpt(added, inventories(), () => true);
    expect(notices(expandComparisonExcerpt(added, inventories(), original, [request("original", 1)], () => true)))
      .toContain("absent side=1");
    const duplicate = request("original", 10, 20);
    const expanded = expandComparisonExcerpt(source, found, initial(), [duplicate, duplicate], limitLines(2));
    expect(notices(expanded)).toContain("duplicate/already supplied=1");
    expect(notices(expanded)).toContain("budget declined=1");
  });

  it("returns explicit no-op notices when all requested ranges are already supplied", () => {
    const original = initial();
    const expanded = expandComparisonExcerpt(source, found, original, [request("original", 250), request("modified", 250)], () => true);
    expect(expanded.original).toEqual(original.original);
    expect(expanded.modified).toEqual(original.modified);
    expect(notices(expanded)).toContain("duplicate/already supplied=2");
    expect(notices(expanded)).toContain("Only supplied source can support behavior");
  });
});
