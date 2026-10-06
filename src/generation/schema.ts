import type { FunctionExplanation, RepositoryOverview } from "../core/types";

const string = { type: "string" };
const stringArray = { type: "array", items: string };

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const overviewSchema = objectSchema(
  {
    purpose: string,
    components: string,
    flows: string,
    conventions: string,
    uncertainties: string,
    limitations: stringArray
  },
  [
    "purpose",
    "components",
    "flows",
    "conventions",
    "uncertainties",
    "limitations"
  ]
);

export const explanationSchema = objectSchema(
  {
    purpose: string,
    role: string,
    inputsOutputsEffects: string,
    steps: string,
    errorsAndEdges: string,
    languageConcepts: string,
    limitations: stringArray
  },
  [
    "purpose",
    "role",
    "inputsOutputsEffects",
    "steps",
    "errorsAndEdges",
    "languageConcepts",
    "limitations"
  ]
);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The provider response was not a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readStrings(value: unknown, label: string, maxItems = 30): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((entry) => typeof entry !== "string" || entry.length > 1_500)
  ) {
    throw new Error(`The provider response contains invalid ${label}.`);
  }
  return value as string[];
}

function readText(
  source: Record<string, unknown>,
  key: string,
  maxLength = 4_000
): string {
  const value = source[key];
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`The provider response contains invalid "${key}".`);
  }
  return value;
}

export function parseOverview(value: unknown): RepositoryOverview {
  const source = record(value);
  const overview = {
    purpose: readText(source, "purpose", 2_000),
    components: readText(source, "components", 5_000),
    flows: readText(source, "flows", 5_000),
    conventions: readText(source, "conventions", 4_000),
    uncertainties: readText(source, "uncertainties", 3_000),
    limitations: readStrings(source.limitations, "limitations")
  };
  const words = Object.values(overview).flat().join(" ").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1_000) {
    throw new Error("The provider overview exceeded the 1,000-word limit.");
  }
  return overview;
}

export function parseExplanation(value: unknown): FunctionExplanation {
  const source = record(value);
  return {
    purpose: readText(source, "purpose", 2_000),
    role: readText(source, "role"),
    inputsOutputsEffects: readText(source, "inputsOutputsEffects"),
    steps: readText(source, "steps"),
    errorsAndEdges: readText(source, "errorsAndEdges"),
    languageConcepts: readText(source, "languageConcepts"),
    limitations: readStrings(source.limitations, "limitations")
  };
}
