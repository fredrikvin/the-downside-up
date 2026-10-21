/** A validation message assembled only from the host's fixed schema labels, never model content. */
export class SchemaValidationError extends Error {}

export class ModelResponseError extends Error {
  readonly name = "ModelResponseError";

  constructor(
    readonly code: "incomplete-json" | "malformed-json" | "invalid-schema",
    readonly outputCharacters: number,
    model: string,
    detail?: string
  ) {
    const problem = code === "invalid-schema" ? "returned JSON that failed schema validation"
      : code === "incomplete-json" ? "did not return valid JSON: the response appears incomplete"
      : "did not return valid JSON: malformed JSON";
    super(`${model} ${problem} (${outputCharacters} characters received; ${code}).${detail ? ` ${detail}` : ""} No automatic retry was made.`);
  }
}

/** A diagnostic hint, not a proof of provider truncation and never a repair. */
function appearsIncomplete(text: string): boolean {
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  const open: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      else if (character.charCodeAt(0) < 32) return false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") open.push(character);
    else if (character === "}" || character === "]") {
      if (open.pop() !== (character === "}" ? "{" : "[")) return false;
    }
  }
  return quoted || open.length > 0;
}

/** Parses without retaining or exposing response text in errors, causes, or logs. */
export function parseModelResponse<T>(
  output: string,
  model: string,
  parse: (value: unknown) => T,
  allowFences = false
): T {
  const trimmed = output.trim();
  const fenced = allowFences ? /^```(?:json)?[^\n]*\n([\s\S]*?)\n?```$/i.exec(trimmed) : null;
  const text = fenced?.[1] ?? trimmed;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ModelResponseError(appearsIncomplete(text) ? "incomplete-json" : "malformed-json", output.length, model);
  }
  try {
    return parse(decoded);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new ModelResponseError(
      "invalid-schema", output.length, model,
      error instanceof SchemaValidationError ? error.message : undefined
    );
  }
}
