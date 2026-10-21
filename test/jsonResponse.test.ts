import { describe, expect, it } from "vitest";
import { ModelResponseError, parseModelResponse, SchemaValidationError } from "../src/generation/jsonResponse";

describe("content-free model response diagnostics", () => {
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
      parseModelResponse(output, "Test model", (value) => value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelResponseError);
    expect(failure).toMatchObject({ code, outputCharacters: output.length });
    const diagnostic = `${String(failure)}\n${JSON.stringify(failure)}\n${failure instanceof Error ? failure.stack : ""}`;
    expect(diagnostic).not.toContain("private-source");
    expect(diagnostic).toContain("No automatic retry");
    expect(diagnostic).toContain(`${output.length} characters received`);
    expect(failure).not.toHaveProperty("cause");
  });

  it("handles escaped quotes, backslashes and braces inside JSON strings", () => {
    const value = { text: 'a "quote" and \\ backslash, braces } ] {' };
    const output = JSON.stringify(value);
    expect(parseModelResponse(output, "Test", (decoded) => decoded)).toEqual(value);
    expect(() => parseModelResponse(output.slice(0, -1), "Test", (decoded) => decoded))
      .toThrow(/appears incomplete/);
  });

  it("preserves complete fenced JSON support without accepting arbitrary prose or repairing data", () => {
    expect(parseModelResponse('```json\n{"text":"ok"}\n```', "Test", (value) => value, true)).toEqual({ text: "ok" });
    expect(() => parseModelResponse('Here is the result: {"text":"ok"}', "Test", (value) => value, true))
      .toThrow(/malformed JSON/);
    expect(() => parseModelResponse('{"text":"ok",}', "Test", (value) => value))
      .toThrow(/malformed JSON/);
  });

  it("distinguishes valid JSON with invalid schema and includes only host-owned details", () => {
    const output = '{"text":"private-source"}';
    expect(() => parseModelResponse(output, "Test", () => { throw new SchemaValidationError('Invalid "summary".'); }))
      .toThrow(/failed schema validation.*invalid-schema.*Invalid "summary"/);
    let failure: unknown;
    try {
      parseModelResponse(output, "Test", () => { throw new Error("private-source"); });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid-schema", outputCharacters: output.length });
    expect(String(failure)).not.toContain("private-source");
  });
});
