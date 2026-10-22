import { describe, expect, it } from "vitest";
import { graphCommitTarget } from "../src/context/commitCommand";

describe("verified Git graph command arguments", () => {
  const source = { id: "git", rootUri: { scheme: "file", fsPath: "/repo" } };
  it("accepts (SourceControl, HistoryItem), using only the immutable commit id", () => {
    expect(graphCommitTarget(source, { id: "a".repeat(40), parentIds: ["untrusted"], subject: "ignored" }))
      .toEqual({ root: "/repo", revision: "a".repeat(40) });
  });
  it.each([
    [undefined, undefined],
    [{ rootUri: source.rootUri }, { id: "a".repeat(40) }],
    [{ ...source, id: "other" }, { id: "a".repeat(40) }],
    [{ ...source, rootUri: { scheme: "vscode-remote", fsPath: "/repo" } }, { id: "a".repeat(40) }],
    [source, { id: "HEAD" }],
    [source, [{ id: "a".repeat(40) }]],
    [source, { hash: "a".repeat(40) }],
    [source, { id: "--upload-pack=evil" }],
    [null, null]
  ])("rejects unsupported or ambiguous argument shapes without guessing", (control, item) => {
    expect(() => graphCommitTarget(control, item)).toThrow("Choose one local Git commit");
  });
});
