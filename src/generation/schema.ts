import type {
  ExplanationFormat,
  ComparisonCatalogue,
  ComparisonCatalogueEntry,
  ComparisonFlowchart,
  ComparisonFlowNode,
  ComparisonVisualScope,
  ComparisonVisualSide,
  ComparisonUnit,
  ComparisonTextItem,
  FileComparisonDraft,
  FileSummary,
  Flowchart,
  FolderSummary,
  ProjectFlowsDraft,
  FlowNode,
  FunctionExplanation,
  MapPart,
  ProjectMap,
  PseudocodeLine,
  RepositoryOverview,
  RepositoryPriming
} from "../core/types";
import { SchemaValidationError } from "./jsonResponse";

const string = { type: "string" };
const integer = { type: "integer" };
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

const mapSchema = objectSchema(
  {
    summary: string,
    parts: {
      type: "array",
      items: objectSchema(
        {
          id: string,
          path: string,
          level: { type: "string", enum: ["group", "component", "module", "support", "external"] },
          name: string,
          summary: string,
          detail: string,
          offers: string,
          uses: string
        },
        ["id", "path", "level", "name", "summary", "detail", "offers", "uses"]
      )
    },
    links: { type: "array", items: objectSchema({ from: string, to: string, label: string }, ["from", "to", "label"]) }
  },
  ["summary", "parts", "links"]
);

/** The overview and the project map, made in one priming or review request. */
export const primingSchema = objectSchema(
  { ...(overviewSchema.properties as Record<string, unknown>), map: mapSchema },
  [...(overviewSchema.required as string[]), "map"]
);

const inputSchema = objectSchema({ label: string, name: string, description: string }, ["label", "name", "description"]);
const stepSchema = objectSchema(
  { title: string, detail: string, phase: string, startLine: integer, endLine: integer },
  ["title", "detail", "phase", "startLine", "endLine"]
);
const noteSchema = objectSchema({ heading: string, text: string }, ["heading", "text"]);

const pseudocodeSchema = {
  type: "array",
  items: objectSchema(
    { text: string, depth: integer, startLine: integer, endLine: integer },
    ["text", "depth", "startLine", "endLine"]
  )
};
const flowchartSchema = objectSchema(
  {
    nodes: {
      type: "array",
      items: objectSchema(
        { id: string, kind: { type: "string", enum: ["start", "action", "decision", "end", "show"] }, label: string, parent: string, startLine: integer, endLine: integer },
        ["id", "kind", "label", "parent", "startLine", "endLine"]
      )
    },
    edges: { type: "array", items: objectSchema({ from: string, to: string, label: string }, ["from", "to", "label"]) }
  },
  ["nodes", "edges"]
);
const formatSchemas: Record<ExplanationFormat, Record<string, unknown>> = {
  pseudocode: pseudocodeSchema,
  flowchart: flowchartSchema
};

/** The explanation schema with the requested extra views as required fields. */
export function explanationSchemaFor(formats: readonly ExplanationFormat[]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: string,
    purpose: string,
    inputs: { type: "array", items: inputSchema },
    result: string,
    steps: { type: "array", items: stepSchema },
    notes: { type: "array", items: noteSchema },
    role: string,
    edgeCases: string,
    languageNotes: string,
    limitations: stringArray
  };
  for (const format of formats) base[format] = formatSchemas[format];
  return objectSchema(base, Object.keys(base));
}

export const explanationSchema = explanationSchemaFor([]);

/** Schema for adding one view to a saved explanation. */
export function formatSchemaFor(format: ExplanationFormat): Record<string, unknown> {
  return objectSchema({ [format]: formatSchemas[format] }, [format]);
}

export const fileSummarySchema = objectSchema({ summary: string }, ["summary"]);

const spanSchema = objectSchema({ startLine: integer, endLine: integer }, ["startLine", "endLine"]);
const comparisonIdSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$", maxLength: 40 };
const comparisonOperationSchema = objectSchema(
  {
    id: comparisonIdSchema,
    label: string,
    kind: { type: "string", enum: ["start", "action", "decision", "end", "show", "none"] },
    startLine: integer,
    endLine: integer
  },
  ["id", "label", "kind", "startLine", "endLine"]
);
const comparisonSideSchema = objectSchema(
  {
    region: string,
    coverage: string,
    flowchartStatus: { type: "string", enum: ["available", "not-applicable", "unavailable"] },
    flowchartReason: string,
    operations: { type: "array", maxItems: 30, items: comparisonOperationSchema },
    steps: {
      type: "array", maxItems: 40,
      items: objectSchema({ operation: comparisonIdSchema, text: string, detail: string }, ["operation", "text", "detail"])
    },
    pseudocode: {
      type: "array", maxItems: 40,
      items: objectSchema(
        { operation: comparisonIdSchema, text: string, depth: { type: "integer", minimum: 0, maximum: 4 } },
        ["operation", "text", "depth"]
      )
    },
    edges: {
      type: "array", maxItems: 40,
      items: objectSchema({ from: comparisonIdSchema, to: comparisonIdSchema, label: string }, ["from", "to", "label"])
    }
  },
  ["region", "coverage", "flowchartStatus", "flowchartReason", "operations", "steps", "pseudocode", "edges"]
);
const comparisonVisualScopeSchema = objectSchema(
  {
    id: comparisonIdSchema,
    functionId: string,
    title: string,
    original: comparisonSideSchema,
    modified: comparisonSideSchema,
    operationMatches: {
      type: "array", maxItems: 30,
      items: objectSchema(
        { original: comparisonIdSchema, modified: comparisonIdSchema, meaning: string, difference: string },
        ["original", "modified", "meaning", "difference"]
      )
    },
    edgeMatches: {
      type: "array", maxItems: 40,
      items: objectSchema(
        { original: { type: "integer", minimum: 0, maximum: 39 }, modified: { type: "integer", minimum: 0, maximum: 39 }, meaning: string, difference: string },
        ["original", "modified", "meaning", "difference"]
      )
    }
  },
  ["id", "functionId", "title", "original", "modified", "operationMatches", "edgeMatches"]
);
const comparisonSummariesSchema = {
  type: "array", maxItems: 100,
  items: objectSchema({ functionId: comparisonIdSchema, summary: { type: "string", maxLength: 600 } }, ["functionId", "summary"])
};
export const comparisonSchema = objectSchema(
  {
    summary: string,
    added: comparisonSummariesSchema,
    removed: comparisonSummariesSchema,
    changes: {
      type: "array",
      items: objectSchema(
        { id: comparisonIdSchema, functionId: string, title: string, before: string, after: string, when: string, flow: string, original: spanSchema, modified: spanSchema, visualScopeId: { type: "string", pattern: "^[A-Za-z0-9_-]{0,40}$", maxLength: 40 } },
        ["id", "functionId", "title", "before", "after", "when", "flow", "original", "modified", "visualScopeId"]
      )
    },
    visualScopes: { type: "array", items: comparisonVisualScopeSchema },
    outside: string,
    possibleEffects: stringArray,
    limitations: stringArray
  },
  ["summary", "added", "removed", "changes", "visualScopes", "outside", "possibleEffects", "limitations"]
);

const flowNodeSchema = objectSchema(
  {
    id: string,
    kind: { type: "string", enum: ["start", "action", "decision", "end", "show"] },
    label: string,
    file: string,
    function: string
  },
  ["id", "kind", "label", "file", "function"]
);

export const projectFlowsSchema = objectSchema(
  {
    flows: {
      type: "array",
      items: objectSchema(
        {
          title: string,
          summary: string,
          nodes: { type: "array", items: flowNodeSchema },
          edges: { type: "array", items: objectSchema({ from: string, to: string, label: string }, ["from", "to", "label"]) }
        },
        ["title", "summary", "nodes", "edges"]
      )
    }
  },
  ["flows"]
);

export const folderSummarySchema = objectSchema(
  {
    summary: string,
    overview: string,
    parts: { type: "array", items: objectSchema({ name: string, summary: string }, ["name", "summary"]) },
    offers: string,
    uses: string
  },
  ["summary", "overview", "parts", "offers", "uses"]
);

/** Flows between the parts of a project map; each node names the part where its step happens. */
export const partFlowsSchema = objectSchema(
  {
    flows: {
      type: "array",
      items: objectSchema(
        {
          title: string,
          summary: string,
          nodes: {
            type: "array",
            items: objectSchema(
              { id: string, kind: { type: "string", enum: ["start", "action", "decision", "end", "show"] }, label: string, part: string },
              ["id", "kind", "label", "part"]
            )
          },
          edges: { type: "array", items: objectSchema({ from: string, to: string, label: string }, ["from", "to", "label"]) }
        },
        ["title", "summary", "nodes", "edges"]
      )
    }
  },
  ["flows"]
);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaValidationError("The provider response was not a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readStrings(value: unknown, label: string, maxItems = 30): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((entry) => typeof entry !== "string" || entry.length > 1_500)
  ) {
    throw new SchemaValidationError(`The provider response contains invalid ${label}.`);
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
    throw new SchemaValidationError(`The provider response contains invalid "${key}".`);
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

function readObjects<T>(
  value: unknown,
  label: string,
  maxItems: number,
  read: (item: Record<string, unknown>) => T
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new SchemaValidationError(`The provider response contains invalid ${label}.`);
  }
  return value.map((item) => read(record(item)));
}

/** A 1-based line number from the model, or 0; anything else counts as 0 rather than failing the explanation. */
function readLine(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
}

export function parseExplanation(value: unknown): FunctionExplanation {
  const source = record(value);
  return {
    title: readText(source, "title", 120),
    purpose: readText(source, "purpose", 2_000),
    inputs: readObjects(source.inputs, "inputs", 20, (item) => ({
      label: readText(item, "label", 120),
      name: readText(item, "name", 200),
      description: readText(item, "description", 1_000)
    })),
    result: readText(source, "result", 1_500),
    steps: readObjects(source.steps, "steps", 15, (item) => {
      // A missing or unusable phase only loses the grouping, not the explanation.
      const phase = typeof item.phase === "string" ? item.phase.trim().slice(0, 80) : "";
      return {
        title: readText(item, "title", 160),
        detail: readText(item, "detail", 1_500),
        ...(phase ? { phase } : {}),
        startLine: readLine(item, "startLine"),
        endLine: readLine(item, "endLine")
      };
    }),
    notes: readObjects(source.notes, "notes", 6, (item) => ({
      heading: readText(item, "heading", 80),
      text: readText(item, "text", 1_500)
    })),
    role: readText(source, "role", 2_000),
    edgeCases: readText(source, "edgeCases", 2_000),
    languageNotes: readText(source, "languageNotes", 2_000),
    limitations: readStrings(source.limitations, "limitations"),
    ...readFormats(source)
  };
}

const MAX_FLOW_NODES = 24;
const MAX_FLOW_EDGES = 40;
/** How deep `show` nodes may be drawn inside each other. */
const MAX_FLOW_NESTING = 3;

function parsePseudocode(value: unknown): PseudocodeLine[] {
  return readObjects(value, "pseudocode", 40, (item) => {
    const depth = item.depth;
    return {
      text: readText(item, "text", 300),
      depth: typeof depth === "number" && Number.isInteger(depth) ? Math.min(4, Math.max(0, depth)) : 0,
      startLine: readLine(item, "startLine"),
      endLine: readLine(item, "endLine")
    };
  });
}

/**
 * Keeps a node's parent only when it is another `show` node and the nesting
 * is at most `MAX_FLOW_NESTING` deep without a cycle; otherwise the node is
 * drawn at the top level.
 */
function checkedParents(nodes: readonly FlowNode[]): FlowNode[] {
  const withoutParent = ({ parent: _dropped, ...rest }: FlowNode): FlowNode => rest;
  const kinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const direct = nodes.map((node) =>
    node.parent && (node.parent === node.id || kinds.get(node.parent) !== "show") ? withoutParent(node) : node);
  const parentOf = new Map(direct.map((node) => [node.id, node.parent]));
  const tooDeep = (id: string): boolean => {
    let current = parentOf.get(id);
    for (let level = 1; current; level++) {
      // A cycle never reaches the top, so it also ends here.
      if (level > MAX_FLOW_NESTING) return true;
      current = parentOf.get(current);
    }
    return false;
  };
  return direct.map((node) => (node.parent && tooDeep(node.id) ? withoutParent(node) : node));
}

/**
 * Checks the flowchart's structure: bounded size, unique node IDs, edges
 * between known nodes, and nesting inside `show` nodes. An edge between nodes
 * at different nesting levels is dropped, since each level is drawn as its
 * own flow.
 */
function parseFlowchart(value: unknown): Flowchart {
  const source = record(value);
  const nodes = checkedParents(readObjects(source.nodes, "flowchart nodes", MAX_FLOW_NODES, (item): FlowNode => {
    const kind = item.kind;
    if (kind !== "start" && kind !== "action" && kind !== "decision" && kind !== "end" && kind !== "show") {
      throw new Error("The provider response contains an invalid flowchart node kind.");
    }
    const parent = typeof item.parent === "string" ? item.parent.trim() : "";
    return {
      id: readText(item, "id", 40),
      kind,
      label: readText(item, "label", 160),
      ...(parent ? { parent } : {}),
      startLine: readLine(item, "startLine"),
      endLine: readLine(item, "endLine")
    };
  }));
  const ids = new Set(nodes.map((node) => node.id));
  if (nodes.length === 0 || ids.size !== nodes.length || nodes.every((node) => node.parent)) {
    throw new Error("The provider response contains an invalid flowchart.");
  }
  const edges = readObjects(source.edges, "flowchart edges", MAX_FLOW_EDGES, (item) => ({
    from: readText(item, "from", 40),
    to: readText(item, "to", 40),
    label: readText(item, "label", 40)
  }));
  if (edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) {
    throw new Error("The provider response contains a flowchart edge to an unknown node.");
  }
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent ?? ""]));
  return { nodes, edges: edges.filter((edge) => parentOf.get(edge.from) === parentOf.get(edge.to)) };
}

/**
 * Reads optional extra views. An invalid view is dropped with a limitation
 * instead of failing the whole explanation.
 */
function readFormats(source: Record<string, unknown>): Pick<FunctionExplanation, "pseudocode" | "flowchart"> {
  const result: { pseudocode?: PseudocodeLine[]; flowchart?: Flowchart } = {};
  if (source.pseudocode !== undefined) {
    try {
      result.pseudocode = parsePseudocode(source.pseudocode);
    } catch {
      // Dropped; the panel offers to generate it again.
    }
  }
  if (source.flowchart !== undefined) {
    try {
      result.flowchart = parseFlowchart(source.flowchart);
    } catch {
      // Dropped; the panel offers to generate it again.
    }
  }
  return result;
}

/** Parses a single view added to a saved explanation; an invalid view fails the request. */
export function parseFormat(value: unknown, format: ExplanationFormat): Pick<FunctionExplanation, "pseudocode" | "flowchart"> {
  const source = record(value);
  return format === "pseudocode"
    ? { pseudocode: parsePseudocode(source.pseudocode) }
    : { flowchart: parseFlowchart(source.flowchart) };
}

const MAX_PROJECT_FLOWS = 3;

/**
 * Project flows, each checked like a function's flowchart (bounded size,
 * unique ids, edges between known nodes); a malformed flow is dropped
 * rather than failing the others. References are read as given and checked
 * against the repository by the caller.
 */
export function parseProjectFlows(value: unknown): ProjectFlowsDraft {
  const source = record(value);
  if (!Array.isArray(source.flows)) throw new Error("The provider response contains invalid flows.");
  const flows: ProjectFlowsDraft["flows"][number][] = [];
  for (const item of source.flows.slice(0, MAX_PROJECT_FLOWS)) {
    try {
      const flow = record(item);
      const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : [];
      const chart = parseFlowchart({
        nodes: rawNodes.map((node) => ({ ...record(node), parent: "", startLine: 0, endLine: 0 })),
        edges: flow.edges
      });
      const refs = rawNodes.map((node) => {
        const { file, function: name } = record(node);
        return {
          file: typeof file === "string" ? file.trim().replace(/^\.\//, "") : "",
          function: typeof name === "string" ? name.trim() : ""
        };
      });
      flows.push({ title: readText(flow, "title", 120).trim(), summary: readText(flow, "summary", 600).trim(), chart, refs });
    } catch {
      // A malformed flow is left out.
    }
  }
  return { flows };
}

/** Optional text: trimmed and bounded, or empty when missing or unusable. */
function optionalText(source: Record<string, unknown>, key: string, maxLength: number): string {
  const value = source[key];
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * The project map from a priming or review reply. It is read leniently: a
 * malformed part or link is dropped, and a missing map is empty, so the
 * overview still serves explanations. Folder paths are checked against the
 * repository by the caller.
 */
export function parseProjectMap(value: unknown): ProjectMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { summary: "", parts: [], links: [] };
  const source = value as Record<string, unknown>;
  const levels = new Set(["group", "component", "module", "support", "external"]);
  const parts: MapPart[] = (Array.isArray(source.parts) ? source.parts.slice(0, 120) : []).flatMap((item): MapPart[] => {
    if (typeof item !== "object" || item === null) return [];
    const part = item as Record<string, unknown>;
    const id = optionalText(part, "id", 60);
    const name = optionalText(part, "name", 80);
    const level = part.level;
    if (!id || !name || typeof level !== "string" || !levels.has(level)) return [];
    const path = optionalText(part, "path", 300);
    const detail = optionalText(part, "detail", 1_200);
    const offers = optionalText(part, "offers", 500);
    const uses = optionalText(part, "uses", 500);
    return [{
      id,
      ...(path ? { path } : {}),
      level: level as MapPart["level"],
      name,
      summary: optionalText(part, "summary", 300),
      ...(detail ? { detail } : {}),
      ...(offers ? { offers } : {}),
      ...(uses ? { uses } : {})
    }];
  });
  const links = (Array.isArray(source.links) ? source.links.slice(0, 200) : []).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const link = item as Record<string, unknown>;
    const from = optionalText(link, "from", 60);
    const to = optionalText(link, "to", 60);
    return from && to ? [{ from, to, label: optionalText(link, "label", 40) }] : [];
  });
  return { summary: optionalText(source, "summary", 1_200), parts, links };
}

/** The overview (checked strictly, as explanations rely on it) and the project map (read leniently). */
export function parsePriming(value: unknown): RepositoryPriming {
  const source = record(value);
  const { map, ...overview } = source;
  return { overview: parseOverview(overview), map: parseProjectMap(map) };
}

/**
 * Flows between map parts, checked like project flows; each node's part id
 * is returned in `refs[].file` for the caller to check against the map.
 */
export function parsePartFlows(value: unknown): ProjectFlowsDraft {
  const source = record(value);
  if (!Array.isArray(source.flows)) throw new Error("The provider response contains invalid flows.");
  return parseProjectFlows({
    flows: source.flows.map((flow) => {
      if (typeof flow !== "object" || flow === null) return flow;
      const nodes = (flow as Record<string, unknown>).nodes;
      return {
        ...(flow as Record<string, unknown>),
        nodes: Array.isArray(nodes)
          ? nodes.map((node) => typeof node === "object" && node !== null
            ? { ...(node as Record<string, unknown>), file: (node as Record<string, unknown>).part, function: "" }
            : node)
          : nodes
      };
    })
  });
}

/** A folder summary; parts with blank or unusable text are dropped rather than failing it. */
export function parseFolderSummary(value: unknown): FolderSummary {
  const source = record(value);
  const parts = Array.isArray(source.parts) ? source.parts.slice(0, 200) : [];
  const offers = optionalText(source, "offers", 600);
  const uses = optionalText(source, "uses", 600);
  return {
    ...(offers ? { offers } : {}),
    ...(uses ? { uses } : {}),
    summary: readText(source, "summary", 600).trim(),
    overview: readText(source, "overview", 2_500).trim(),
    parts: parts.flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const { name, summary } = part as Record<string, unknown>;
      return typeof name === "string" && typeof summary === "string" && name.trim() && summary.trim() && summary.length <= 400
        ? [{ name: name.trim(), summary: summary.trim() }]
        : [];
    })
  };
}

export function parseFileSummary(value: unknown): FileSummary {
  return { summary: readText(record(value), "summary", 400).trim() };
}

function readSpan(value: unknown): { start: number; end: number } {
  const source = record(value);
  const start = source.startLine;
  const end = source.endLine;
  if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 1 || (end as number) < (start as number)) return { start: 0, end: 0 };
  return { start: start as number, end: end as number };
}

const MAX_COMPARISON_SCOPES = 12;
const MAX_COMPARISON_NODES = 96;
const MAX_COMPARISON_EDGES = 160;
const MAX_COMPARISON_TEXT = 48_000;
const COMPARISON_ID = /^[A-Za-z0-9_-]{1,40}$/;

interface ComparisonLineBounds {
  readonly catalogue?: ComparisonCatalogue;
  readonly originalLines: number;
  readonly modifiedLines: number;
  readonly originalPresent: boolean;
  readonly modifiedPresent: boolean;
}

function comparisonId(value: unknown): value is string {
  return typeof value === "string" && COMPARISON_ID.test(value);
}

function comparisonTextLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + comparisonTextLength(item), 0);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((total, item) => total + comparisonTextLength(item), 0);
  }
  return 0;
}

function checkedComparisonSpan(value: unknown, lineCount: number): { startLine: number; endLine: number } {
  const source = record(value);
  const start = source.startLine;
  const end = source.endLine;
  if (
    !Number.isInteger(start) || !Number.isInteger(end) ||
    (start as number) < 0 || (end as number) < 0 ||
    ((start as number) === 0) !== ((end as number) === 0) ||
    (start as number) > (end as number) ||
    (end as number) > lineCount
  ) {
    throw new Error("A visual source span is outside its comparison side.");
  }
  return { startLine: start as number, endLine: end as number };
}

interface ParsedComparisonSide {
  readonly view: ComparisonVisualSide;
  readonly units: ComparisonUnit[];
  readonly operations: ReadonlyMap<string, ComparisonUnit>;
}

function parseComparisonSide(
  value: unknown,
  side: "original" | "modified",
  expectedPresent: boolean,
  lineCount: number
): ParsedComparisonSide {
  const source = record(value);
  const region = readText(source, "region", 300).trim();
  const coverage = readText(source, "coverage", 500).trim();
  if ((expectedPresent && !region) || !coverage) throw new Error("Visual side coverage is missing.");

  const flowchartStatus = source.flowchartStatus;
  if (flowchartStatus !== "available" && flowchartStatus !== "not-applicable" && flowchartStatus !== "unavailable") {
    throw new Error("Invalid visual flowchart status.");
  }
  const flowchartReason = readText(source, "flowchartReason", 300).trim();
  const units: ComparisonUnit[] = [];
  const operations = new Map<string, ComparisonUnit>();
  const nodes = readObjects(source.operations, "comparison operations", 30, (operation): ComparisonFlowNode[] => {
    const id = readText(operation, "id", 40);
    const label = readText(operation, "label", 160).trim();
    if (!comparisonId(id) || operations.has(id) || !label) throw new Error("Invalid or duplicate comparison operation id or label.");
    const span = checkedComparisonSpan(operation, lineCount);
    if (!expectedPresent || span.startLine === 0) throw new Error("A semantic operation needs a source span on a present side.");
    const hostId = `${side}-${units.length}`;
    const unit: ComparisonUnit = { id: hostId, label, side, occurrence: { id: hostId, ...span } };
    units.push(unit);
    operations.set(id, unit);
    const kind = operation.kind;
    if (kind !== "start" && kind !== "action" && kind !== "decision" && kind !== "end" && kind !== "show" && kind !== "none") {
      throw new Error("Invalid comparison operation kind.");
    }
    return kind === "none" ? [] : [{ id: hostId, kind, label, occurrenceId: hostId }];
  }).flat();
  if (nodes.length > MAX_FLOW_NODES) throw new Error("Visual flowchart exceeds its per-side limit.");
  const nodeIds = new Set(nodes.map((node) => node.id));
  let edgeIndex = 0;
  const edges = readObjects(source.edges, "comparison edges", MAX_FLOW_EDGES, (edge) => {
    const from = operations.get(readText(edge, "from", 40))?.id;
    const to = operations.get(readText(edge, "to", 40))?.id;
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) throw new Error("Invalid comparison flowchart references.");
    return { id: `${side}-edge-${edgeIndex++}`, from, to, label: readText(edge, "label", 80).trim() };
  });
  const chart: ComparisonFlowchart = { nodes, edges };
  if (flowchartStatus === "available") {
    if (!expectedPresent || chart.nodes.length === 0 || flowchartReason) throw new Error("Available flowchart has no usable graph.");
  } else if (chart.nodes.length > 0 || chart.edges.length > 0 || !flowchartReason) {
    throw new Error("Unavailable flowchart needs an explicit reason and an empty graph.");
  }
  if (!expectedPresent && (region || units.length || chart.edges.length)) {
    throw new Error(`The ${side} side is absent but has visual content.`);
  }

  const parseItems = (raw: unknown, pseudocode: boolean): ComparisonTextItem[] => {
    let index = 0;
    return readObjects(raw, pseudocode ? "comparison pseudocode" : "comparison steps", 40, (item) => {
      const unit = operations.get(readText(item, "operation", 40));
      if (!unit) throw new Error("Comparison text references an unknown operation on this side.");
      const text = readText(item, "text", 300).trim();
      if (!text) throw new Error("Comparison text is empty.");
      const depth = item.depth;
      if (pseudocode && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 4)) {
        throw new Error("Invalid comparison pseudocode depth.");
      }
      return {
        id: `${side}-${pseudocode ? "pseudo" : "step"}-${index++}`,
        text,
        ...(pseudocode ? {} : { detail: readText(item, "detail", 500).trim() }),
        ...(pseudocode ? { depth: depth as number } : {}),
        occurrenceId: unit.occurrence.id,
        startLine: unit.occurrence.startLine,
        endLine: unit.occurrence.endLine
      };
    });
  };
  return {
    units,
    operations,
    view: {
      presence: expectedPresent ? "present" : "absent",
      region,
      coverage,
      flowchartStatus,
      flowchartReason,
      steps: parseItems(source.steps, false),
      pseudocode: parseItems(source.pseudocode, true),
      flowchart: chart
    }
  };
}

function comparisonMatches<T>(parse: () => T[], report: (reason: string) => void): T[] {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    report(error.message);
    return [];
  }
}

function parseComparisonVisualScope(
  value: unknown,
  bounds: ComparisonLineBounds,
  report: (reason: string) => void
): ComparisonVisualScope {
  const source = record(value);
  const id = readText(source, "id", 40);
  if (!comparisonId(id)) throw new Error("Invalid comparison visual scope id.");
  const original = parseComparisonSide(source.original, "original", bounds.originalPresent, bounds.originalLines);
  const modified = parseComparisonSide(source.modified, "modified", bounds.modifiedPresent, bounds.modifiedLines);

  const unitCorrespondences = comparisonMatches(() => {
    const matches = readObjects(source.operationMatches, "operation matches", 30, (item) => {
      const originalUnitId = original.operations.get(readText(item, "original", 40))?.id;
      const modifiedUnitId = modified.operations.get(readText(item, "modified", 40))?.id;
      if (!originalUnitId || !modifiedUnitId) {
        throw new Error("Unit correspondence crosses or misses a side.");
      }
      return {
        originalUnitId,
        modifiedUnitId,
        meaning: readText(item, "meaning", 200).trim(),
        difference: readText(item, "difference", 300).trim()
      };
    });
    if (new Set(matches.map((match) => match.originalUnitId)).size !== matches.length ||
        new Set(matches.map((match) => match.modifiedUnitId)).size !== matches.length) {
      throw new Error("Unit correspondences must be one-to-one.");
    }
    return matches;
  }, (reason) => report(`Operation matching was omitted: ${reason} Both side views remain available.`));
  const matchedUnits = new Map(unitCorrespondences.map((match) => [match.originalUnitId, match.modifiedUnitId]));

  const edgeAt = (side: ParsedComparisonSide, index: unknown) =>
    typeof index === "number" && Number.isInteger(index) && index >= 0 ? side.view.flowchart.edges[index] : undefined;
  const edgeCorrespondences = comparisonMatches(() => {
    const matches = readObjects(source.edgeMatches, "edge matches", MAX_FLOW_EDGES, (item) => {
      const originalEdge = edgeAt(original, item.original);
      const modifiedEdge = edgeAt(modified, item.modified);
      if (!originalEdge || !modifiedEdge) throw new Error("Edge correspondence references an unknown edge.");
      if (matchedUnits.get(originalEdge.from) !== modifiedEdge.from || matchedUnits.get(originalEdge.to) !== modifiedEdge.to) {
        throw new Error("Corresponding edges do not connect corresponding operations.");
      }
      return {
        originalEdgeId: originalEdge.id,
        modifiedEdgeId: modifiedEdge.id,
        meaning: readText(item, "meaning", 200).trim(),
        difference: readText(item, "difference", 300).trim()
      };
    });
    if (new Set(matches.map((match) => match.originalEdgeId)).size !== matches.length ||
        new Set(matches.map((match) => match.modifiedEdgeId)).size !== matches.length) {
      throw new Error("Edge correspondences must be one-to-one.");
    }
    return matches;
  }, (reason) => report(`Connection matching was omitted: ${reason} Both side charts remain available.`));
  return {
    id,
    title: readText(source, "title", 160).trim(),
    original: original.view,
    modified: modified.view,
    units: [...original.units, ...modified.units],
    unitCorrespondences,
    edgeCorrespondences
  };
}

/** Keeps valid textual changes even when the optional paired visual representation is malformed. */
export function parseComparison(value: unknown, bounds?: ComparisonLineBounds): FileComparisonDraft {
  const source = record(value);
  const catalogue = bounds?.catalogue;
  const byId = new Map(catalogue?.entries.map((entry) => [entry.id, entry]));
  const summaries = (category: "added" | "removed") => {
    const values = source[category];
    if (!catalogue && values === undefined) return undefined;
    if (!Array.isArray(values) || values.length > 100) throw new Error("Invalid function summary coverage.");
    const seen = new Set<string>();
    const parsed = values.map((value) => {
      const item = record(value);
      const id = item.functionId;
      if (typeof id !== "string" || byId.get(id)?.category !== category || seen.has(id)) throw new Error("Invalid function summary id.");
      const summary = readText(item, "summary", 600).trim();
      if (!summary) throw new Error("Missing required function summary.");
      seen.add(id);
      return { functionId: id, summary };
    });
    if (catalogue?.entries.some((entry) => entry.category === category && !seen.has(entry.id))) throw new Error("Missing required function summary.");
    return parsed;
  };
  const added = summaries("added");
  const removed = summaries("removed");
  if (catalogue && comparisonTextLength(source) > 80_000) throw new Error("Comparison response exceeds its text budget.");
  const changedFunction = (id: unknown): ComparisonCatalogueEntry | undefined => {
    if (!catalogue?.classified) {
      if (catalogue && id !== "" && id !== undefined) throw new Error("Unclassified comparison references an unknown function id.");
      return undefined;
    }
    const entry = typeof id === "string" ? byId.get(id) : undefined;
    if (entry?.category !== "changed") throw new Error("Invalid Changed function id.");
    return entry;
  };
  const within = (start: number, end: number, range: ComparisonCatalogueEntry["original"]) =>
    start === 0 && end === 0 || Boolean(range && start >= range.startLine + 1 && end <= range.endLine + 1);
  const changes = Array.isArray(source.changes) ? source.changes.slice(0, 60) : [];
  const text = (item: Record<string, unknown>, key: string, max: number) =>
    typeof item[key] === "string" && (item[key] as string).length <= max ? (item[key] as string).trim() : "";
  const seenChangeIds = new Set<string>();
  let malformedVisual = false;
  const visualIssues: string[] = [];
  const parsedChanges = changes.flatMap((change) => {
    if (typeof change !== "object" || change === null) return [];
    const item = change as Record<string, unknown>;
    const fn = changedFunction(item.functionId);
    const id = item.id;
    if (!comparisonId(id) || seenChangeIds.has(id)) return [];
    const scope = item.visualScopeId;
    let visualScopeId: string | undefined;
    if (typeof scope === "string" && scope.length <= 40 && (!scope || comparisonId(scope))) {
      visualScopeId = scope || undefined;
    } else {
      visualIssues.push("A change's invalid visual scope link was omitted.");
    }
    const parsed = {
      id,
      ...(fn ? { functionId: fn.id } : {}),
      title: text(item, "title", 200),
      before: text(item, "before", 1_200),
      after: text(item, "after", 1_200),
      when: text(item, "when", 600),
      flow: text(item, "flow", 800),
      original: readSpan(item.original),
      modified: readSpan(item.modified),
      ...(visualScopeId ? { visualScopeId } : {})
    };
    if (!parsed.title || (!parsed.before && !parsed.after)) return [];
    if (fn && (!within(parsed.original.start, parsed.original.end, fn.original) ||
        !within(parsed.modified.start, parsed.modified.end, fn.modified))) throw new Error("Change evidence is outside its function.");
    seenChangeIds.add(id);
    return [parsed];
  });
  let visualScopes: ComparisonVisualScope[] | undefined;
  if (source.visualScopes !== undefined) {
    try {
      if (!Array.isArray(source.visualScopes) || source.visualScopes.length > MAX_COMPARISON_SCOPES) {
        throw new Error("Too many comparison visual scopes.");
      }
      if (source.visualScopes.length > 0 && !bounds) throw new Error("Snapshot line counts are required.");
      const totals = { nodes: 0, edges: 0, text: 0 };
      visualScopes = source.visualScopes.flatMap((rawScope, index) => {
        let scope: ComparisonVisualScope;
        const scopeIssues: string[] = [];
        try {
          const fn = changedFunction(record(rawScope).functionId);
          if (catalogue && !fn) throw new Error("Unclassified comparisons have no function visuals.");
          scope = parseComparisonVisualScope(rawScope, bounds!, (reason) => scopeIssues.push(reason));
          if (fn) {
            if (scope.units.some((unit) => !within(unit.occurrence.startLine, unit.occurrence.endLine, fn[unit.side]))) {
              throw new Error("Visual evidence is outside its function.");
            }
            scope = { ...scope, functionId: fn.id };
            if (!parsedChanges.some((change) => change.visualScopeId === scope.id && change.functionId === fn.id)) return [];
            if (parsedChanges.some((change) => change.visualScopeId === scope.id && change.functionId !== fn.id)) {
              throw new Error("Visual scope belongs to a different function.");
            }
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          visualIssues.push(`Visual scope ${index + 1} was omitted: ${error.message}`);
          return [];
        }
        totals.nodes += scope.original.flowchart.nodes.length + scope.modified.flowchart.nodes.length;
        totals.edges += scope.original.flowchart.edges.length + scope.modified.flowchart.edges.length;
        totals.text += comparisonTextLength(scope);
        if (totals.nodes > MAX_COMPARISON_NODES || totals.edges > MAX_COMPARISON_EDGES || totals.text > MAX_COMPARISON_TEXT) {
          throw new Error("Comparison visual response exceeds its total budget.");
        }
        visualIssues.push(...scopeIssues);
        return [scope];
      });
      if (new Set(visualScopes.map((scope) => scope.id)).size !== visualScopes.length) throw new Error("Duplicate comparison visual scope id.");
      const scopeIds = new Set(visualScopes.map((scope) => scope.id));
      if (parsedChanges.some((change) => change.visualScopeId && !scopeIds.has(change.visualScopeId))) {
        visualIssues.push("A change references an unavailable visual scope; its visual link was omitted.");
        for (const change of parsedChanges) {
          if (change.visualScopeId && !scopeIds.has(change.visualScopeId)) delete change.visualScopeId;
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      visualScopes = undefined;
      malformedVisual = true;
      visualIssues.push(error.message);
    }
  } else {
    malformedVisual = true;
  }
  if (source.visualScopes !== undefined && Array.isArray(source.visualScopes) && source.visualScopes.length > 0 && !visualScopes?.length) malformedVisual = true;
  const limitations = readStrings(source.limitations, "limitations", 10).map((entry) => entry.trim()).filter(Boolean);
  if (malformedVisual) {
    const notice = "The paired visual comparison was omitted because its data was invalid or exceeded the safety limits; the textual comparison is still available.";
    if (limitations.length >= 10) limitations.splice(9, 1, notice);
    else limitations.push(notice);
  }
  for (const issue of new Set(visualIssues)) {
    if (limitations.length < 10) limitations.push(issue);
    else limitations[9] = `${limitations[9]} ${issue}`.slice(0, 1_500);
  }
  return {
    summary: readText(source, "summary", 800).trim(),
    ...(added ? { added } : {}),
    ...(removed ? { removed } : {}),
    changes: parsedChanges,
    ...(visualScopes?.length ? { visualScopes } : {}),
    outside: optionalText(source, "outside", 1_200),
    possibleEffects: readStrings(source.possibleEffects, "possible effects", 10).map((entry) => entry.trim()).filter(Boolean),
    limitations
  };
}
