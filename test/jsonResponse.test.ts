import { describe, expect, it } from "vitest";
import { ModelResponseError, parseModelResponse, SchemaValidationError } from "../src/generation/jsonResponse";

describe("generic model response failures", () => {
  it.each([
    ['{"text":"private-source', "incomplete-json"],
    ['{"text":"private-source","items":[', "incomplete-json"],
    ['{"text":"private-source"} trailing', "malformed-json"],
    ['{"text":"private-source",}', "malformed-json"],
    ['{"text":"private-source"]', "malformed-json"],
    ["private-source: not JSON", "malformed-json"]
  ] as const)("classifies %s without leaking it", (output, code) => {
    let failure: unknown;
    try {
      parseModelResponse(output, (value) => value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelResponseError);
    expect(failure).toMatchObject({ code, outputCharacters: output.length });
    const diagnostic = `${String(failure)}\n${JSON.stringify(failure)}\n${failure instanceof Error ? failure.stack : ""}`;
    expect(diagnostic).not.toContain("private-source");
    expect(failure).toMatchObject({
      message: code === "incomplete-json"
        ? `Generation failed (incomplete-json after ${output.length} characters). No automatic retry was made; try again.`
        : "Generation failed (malformed-json). No automatic retry was made; try again."
    });
    expect(failure).not.toHaveProperty("cause");
  });

  it("handles escaped quotes, backslashes and braces inside JSON strings", () => {
    const value = { text: 'a "quote" and \\ backslash, braces } ] {' };
    const output = JSON.stringify(value);
    expect(parseModelResponse(output, (decoded) => decoded)).toEqual(value);
    expect(() => parseModelResponse(output.slice(0, -1), (decoded) => decoded))
      .toThrow(`Generation failed (incomplete-json after ${output.length - 1} characters). No automatic retry was made; try again.`);
  });

  it("preserves complete fenced JSON support without accepting arbitrary prose or repairing data", () => {
    expect(parseModelResponse('```json\n{"text":"ok"}\n```', (value) => value, true)).toEqual({ text: "ok" });
    expect(() => parseModelResponse('Here is the result: {"text":"ok"}', (value) => value, true))
      .toThrow("Generation failed (malformed-json).");
    expect(() => parseModelResponse('{"text":"ok",}', (value) => value))
      .toThrow("Generation failed (malformed-json).");
  });

  it("distinguishes valid JSON with invalid schema and shows only host-authored validation reasons", () => {
    const output = '{"text":"private-source"}';
    expect(() => parseModelResponse(output, () => { throw new SchemaValidationError('Invalid "summary".'); }))
      .toThrow('Generation failed (invalid-schema: Invalid "summary".). No automatic retry was made; try again.');
    expect(() => parseModelResponse(output, () => { throw new Error("Invalid Changed function id."); }))
      .toThrow("Generation failed (invalid-schema: Invalid Changed function id.).");
    for (const thrown of [new TypeError("private-source"), new Error(`private-source ${"x".repeat(200)}`)]) {
      let failure: unknown;
      try {
        parseModelResponse(output, () => { throw thrown; });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid-schema", outputCharacters: output.length,
        message: "Generation failed (invalid-schema). No automatic retry was made; try again." });
      expect(String(failure)).not.toContain("private-source");
    }
  });
});
