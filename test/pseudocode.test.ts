import { describe, expect, it } from "vitest";
import { pseudocodeTokens } from "../src/presentation/pseudocode";

describe("plain-language pseudocode highlighting", () => {
  it("recognizes control words without requiring source-language syntax", () => {
    const tokens = pseudocodeTokens("If the request failed and retries < 3: return false");
    expect(tokens.filter((token) => token.kind)).toEqual([
      { text: "If", kind: "keyword" }, { text: "and", kind: "keyword" },
      { text: "<", kind: "operator" }, { text: "3", kind: "number" },
      { text: ":", kind: "operator" }, { text: "return", kind: "keyword" },
      { text: "false", kind: "literal" }
    ]);
    expect(pseudocodeTokens("for each item:").filter((token) => token.kind === "keyword"))
      .toEqual([{ text: "for each", kind: "keyword" }]);
    expect(pseudocodeTokens("otherwise wait until ready").filter((token) => token.kind === "keyword").map((token) => token.text))
      .toEqual(["otherwise", "wait", "until"]);
  });

  it("keeps quoted literals and code names intact instead of coloring their contents", () => {
    expect(pseudocodeTokens('show "if 12 \\"yes\\"" and `returnValue`')).toEqual([
      { text: "show", kind: "keyword" }, { text: " " },
      { text: '"if 12 \\"yes\\""', kind: "string" }, { text: " " },
      { text: "and", kind: "keyword" }, { text: " " },
      { text: "`returnValue`", kind: "name" }
    ]);
    expect(pseudocodeTokens("return 'not ready'").at(-1)).toEqual({ text: "'not ready'", kind: "string" });
    expect(pseudocodeTokens("don't change the caller's value").filter((token) => token.kind)).toEqual([]);
  });

  it("does not color word fragments, identifiers, or unsupported prose", () => {
    const text = "gift format returned somewhere falsehood nullValue item3 caféif ifé";
    expect(pseudocodeTokens(text)).toEqual([{ text }]);
    expect(pseudocodeTokens("Copy the request into the queue")).toEqual([{ text: "Copy the request into the queue" }]);
    expect(pseudocodeTokens("")).toEqual([]);
  });

  it("preserves all text including markup, whitespace, incomplete quotes and punctuation", () => {
    for (const text of [
      "  if `ready`:\n    return -2.5e+3",
      'show "<script>alert(1)</script>"',
      '<img src=x onerror="run()">',
      "return `unfinished",
      'show "unfinished',
      "retry-count <- 0x2A",
      "x ".repeat(24_000)
    ]) {
      expect(pseudocodeTokens(text).map((token) => token.text).join("")).toBe(text);
    }
  });
});
