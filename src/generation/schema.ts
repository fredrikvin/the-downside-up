import type {
  ExplanationFormat,
  ComparisonFlowchart,
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
const comparisonOccurrenceSchema = objectSchema(
  { id: string, startLine: integer, endLine: integer },
  ["id", "startLine", "endLine"]
);
const comparisonUnitSchema = objectSchema(
  {
    id: string,
    label: string,
    side: { type: "string", enum: ["original", "modified"] },
    occurrence: comparisonOccurrenceSchema
  },
  ["id", "label", "side", "occurrence"]
);
const comparisonTextItemSchema = objectSchema(
  { id: string, text: string, detail: string, depth: integer, occurrenceId: string, startLine: integer, endLine: integer },
  ["id", "text", "detail", "depth", "occurrenceId", "startLine", "endLine"]
);
const comparisonFlowchartSchema = objectSchema(
  {
    nodes: {
      type: "array",
      items: objectSchema(
        { id: string, kind: { type: "string", enum: ["start", "action", "decision", "end", "show"] }, label: string, occurrenceId: string },
        ["id", "kind", "label", "occurrenceId"]
      )
    },
    edges: {
      type: "array",
      items: objectSchema({ id: string, from: string, to: string, label: string }, ["id", "from", "to", "label"])
    }
  },
  ["nodes", "edges"]
);
const comparisonSideSchema = objectSchema(
  {
    presence: { type: "string", enum: ["present", "absent"] },
    region: string,
    coverage: string,
    flowchartStatus: { type: "string", enum: ["available", "not-applicable", "unavailable"] },
    flowchartReason: string,
    steps: { type: "array", items: comparisonTextItemSchema },
    pseudocode: { type: "array", items: comparisonTextItemSchema },
    flowchart: comparisonFlowchartSchema
  },
  ["presence", "region", "coverage", "flowchartStatus", "flowchartReason", "steps", "pseudocode", "flowchart"]
);
const comparisonVisualScopeSchema = objectSchema(
  {
    id: string,
    title: string,
    original: comparisonSideSchema,
    modified: comparisonSideSchema,
    units: { type: "array", items: comparisonUnitSchema },
    unitCorrespondences: {
      type: "array",
      items: objectSchema(
        { originalUnitId: string, modifiedUnitId: string, meaning: string, difference: string },
        ["originalUnitId", "modifiedUnitId", "meaning", "difference"]
      )
    },
    edgeCorrespondences: {
      type: "array",
      items: objectSchema(
        { originalEdgeId: string, modifiedEdgeId: string, meaning: string, difference: string },
        ["originalEdgeId", "modifiedEdgeId", "meaning", "difference"]
      )
    }
  },
  ["id", "title", "original", "modified", "units", "unitCorrespondences", "edgeCorrespondences"]
);
export const comparisonSchema = objectSchema(
  {
    summary: string,
    changes: {
      type: "array",
      items: objectSchema(
        { id: string, title: string, before: string, after: string, when: string, flow: string, original: spanSchema, modified: spanSchema, visualScopeId: string },
        ["id", "title", "before", "after", "when", "flow", "original", "modified", "visualScopeId"]
      )
    },
    visualScopes: { type: "array", items: comparisonVisualScopeSchema },
    outside: string,
    possibleEffects: stringArray,
    limitations: stringArray
  },
  ["summary", "changes", "visualScopes", "outside", "possibleEffects", "limitations"]
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

function readObjects<T>(
  value: unknown,
  label: string,
  maxItems: number,
  read: (item: Record<string, unknown>) => T
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`The provider response contains invalid ${label}.`);
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

function comparisonStrings(value: unknown, label: string, maxItems: number, maxLength = 200): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid visual ${label}.`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length > maxLength) throw new Error(`Invalid visual ${label}.`);
    return entry.trim();
  });
}

function parseComparisonSide(
  value: unknown,
  side: "original" | "modified",
  expectedPresent: boolean,
  lineCount: number
): ComparisonVisualSide {
  const source = record(value);
  const presence = source.presence;
  if ((presence !== "present" && presence !== "absent") || (presence === "present") !== expectedPresent) {
    throw new Error("Visual side presence does not match the supplied snapshot.");
  }
  const region = readText(source, "region", 300).trim();
  const coverage = readText(source, "coverage", 500).trim();
  if ((expectedPresent && !region) || !coverage) throw new Error("Visual side coverage is missing.");

  const flowchartStatus = source.flowchartStatus;
  if (flowchartStatus !== "available" && flowchartStatus !== "not-applicable" && flowchartStatus !== "unavailable") {
    throw new Error("Invalid visual flowchart status.");
  }
  const flowchartReason = readText(source, "flowchartReason", 300).trim();
  const chartSource = record(source.flowchart);
  const rawNodes = chartSource.nodes;
  const rawEdges = chartSource.edges;
  if (!Array.isArray(rawNodes) || rawNodes.length > MAX_FLOW_NODES || !Array.isArray(rawEdges) || rawEdges.length > MAX_FLOW_EDGES) {
    throw new Error("Visual flowchart exceeds its per-side limit.");
  }
  const chart: ComparisonFlowchart = {
    nodes: rawNodes.map((rawNode) => {
      const node = record(rawNode);
      const kind = node.kind;
      if (kind !== "start" && kind !== "action" && kind !== "decision" && kind !== "end" && kind !== "show") {
        throw new Error("Invalid comparison flowchart node kind.");
      }
      const id = readText(node, "id", 40);
      const occurrenceId = readText(node, "occurrenceId", 40);
      if (!comparisonId(id) || !comparisonId(occurrenceId)) throw new Error("Invalid comparison flowchart node reference.");
      return { id, kind, label: readText(node, "label", 160).trim(), occurrenceId };
    }),
    edges: rawEdges.map((rawEdge) => {
      const edge = record(rawEdge);
      const id = readText(edge, "id", 40);
      if (!comparisonId(id)) throw new Error("Invalid comparison flowchart edge id.");
      return {
        id,
        from: readText(edge, "from", 40),
        to: readText(edge, "to", 40),
        label: readText(edge, "label", 80).trim()
      };
    })
  };
  const nodeIds = new Set(chart.nodes.map((node) => node.id));
  if (nodeIds.size !== chart.nodes.length || chart.nodes.some((node) => !node.label) ||
      new Set(chart.edges.map((edge) => edge.id)).size !== chart.edges.length ||
      chart.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) {
    throw new Error("Invalid comparison flowchart references.");
  }
  if (flowchartStatus === "available") {
    if (!expectedPresent || chart.nodes.length === 0 || flowchartReason) throw new Error("Available flowchart has no usable graph.");
  } else if (chart.nodes.length > 0 || chart.edges.length > 0 || !flowchartReason) {
    throw new Error("Unavailable flowchart needs an explicit reason and an empty graph.");
  }
  if (!expectedPresent && (region || chart.nodes.length || chart.edges.length)) {
    throw new Error(`The ${side} side is absent but has visual content.`);
  }

  const parseItems = (raw: unknown, label: string, maxItems: number, pseudocode: boolean): ComparisonTextItem[] =>
    readObjects(raw, label, maxItems, (item) => {
      const id = readText(item, "id", 40);
      const occurrenceId = readText(item, "occurrenceId", 40);
      if (!comparisonId(id) || !comparisonId(occurrenceId)) throw new Error(`Invalid visual ${label} reference.`);
      const span = checkedComparisonSpan({ startLine: item.startLine, endLine: item.endLine }, lineCount);
      const depth = item.depth;
      if (pseudocode && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 4)) {
        throw new Error("Invalid comparison pseudocode depth.");
      }
      return {
        id,
        text: readText(item, "text", 300).trim(),
        ...(pseudocode ? {} : { detail: readText(item, "detail", 500).trim() }),
        ...(pseudocode ? { depth: depth as number } : {}),
        occurrenceId,
        ...span
      };
    });
  return {
    presence,
    region,
    coverage,
    flowchartStatus,
    flowchartReason,
    steps: parseItems(source.steps, "comparison steps", 40, false),
    pseudocode: parseItems(source.pseudocode, "comparison pseudocode", 40, true),
    flowchart: chart
  };
}

function parseComparisonVisualScope(value: unknown, bounds: ComparisonLineBounds): ComparisonVisualScope {
  const source = record(value);
  const id = readText(source, "id", 40);
  if (!comparisonId(id)) throw new Error("Invalid comparison visual scope id.");
  const original = parseComparisonSide(source.original, "original", bounds.originalPresent, bounds.originalLines);
  const modified = parseComparisonSide(source.modified, "modified", bounds.modifiedPresent, bounds.modifiedLines);
  const units = readObjects(source.units, "comparison units", 60, (item): ComparisonUnit => {
    const unitId = readText(item, "id", 40);
    const label = readText(item, "label", 160).trim();
    const side = item.side;
    if (!comparisonId(unitId) || !label || (side !== "original" && side !== "modified")) {
      throw new Error("Invalid comparison unit.");
    }
    const occurrenceSource = record(item.occurrence);
    const occurrenceId = readText(occurrenceSource, "id", 40);
    if (!comparisonId(occurrenceId)) throw new Error("Invalid comparison occurrence id.");
    const span = checkedComparisonSpan(
      { startLine: occurrenceSource.startLine, endLine: occurrenceSource.endLine },
      side === "original" ? bounds.originalLines : bounds.modifiedLines
    );
    if (span.startLine === 0 || (side === "original" ? !bounds.originalPresent : !bounds.modifiedPresent)) {
      throw new Error("A semantic occurrence needs a source span on a present side.");
    }
    return { id: unitId, label, side, occurrence: { id: occurrenceId, ...span } };
  });
  if (new Set(units.map((unit) => unit.id)).size !== units.length) throw new Error("Duplicate comparison unit id.");

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const occurrenceBySide = {
    original: new Map(units.filter((unit) => unit.side === "original").map((unit) => [unit.occurrence.id, unit.id])),
    modified: new Map(units.filter((unit) => unit.side === "modified").map((unit) => [unit.occurrence.id, unit.id]))
  };
  if (occurrenceBySide.original.size !== units.filter((unit) => unit.side === "original").length ||
      occurrenceBySide.modified.size !== units.filter((unit) => unit.side === "modified").length) {
    throw new Error("Duplicate side-specific occurrence id.");
  }

  const unitCorrespondences = readObjects(source.unitCorrespondences, "unit correspondences", 60, (item) => {
    const originalUnitId = readText(item, "originalUnitId", 40);
    const modifiedUnitId = readText(item, "modifiedUnitId", 40);
    if (unitById.get(originalUnitId)?.side !== "original" || unitById.get(modifiedUnitId)?.side !== "modified") {
      throw new Error("Unit correspondence crosses or misses a side.");
    }
    return {
      originalUnitId,
      modifiedUnitId,
      meaning: readText(item, "meaning", 200).trim(),
      difference: readText(item, "difference", 300).trim()
    };
  });
  if (new Set(unitCorrespondences.map((match) => match.originalUnitId)).size !== unitCorrespondences.length ||
      new Set(unitCorrespondences.map((match) => match.modifiedUnitId)).size !== unitCorrespondences.length) {
    throw new Error("Unit correspondences must be one-to-one.");
  }
  const matchedUnits = new Map(unitCorrespondences.map((match) => [match.originalUnitId, match.modifiedUnitId]));

  const validateSideReferences = (side: ComparisonVisualSide, name: "original" | "modified") => {
    const occurrences = occurrenceBySide[name];
    for (const node of side.flowchart.nodes) {
      if (!occurrences.has(node.occurrenceId)) throw new Error("Flowchart node references an occurrence on the wrong side.");
    }
    for (const item of [...side.steps, ...side.pseudocode]) {
      if (!occurrences.has(item.occurrenceId) || !item.text) throw new Error("Comparison text references an unknown occurrence.");
    }
  };
  validateSideReferences(original, "original");
  validateSideReferences(modified, "modified");
  const originalEdges = new Map(original.flowchart.edges.map((edge) => [edge.id, edge]));
  const modifiedEdges = new Map(modified.flowchart.edges.map((edge) => [edge.id, edge]));
  const nodeOccurrence = (side: ComparisonVisualSide, nodeId: string) =>
    side.flowchart.nodes.find((node) => node.id === nodeId)?.occurrenceId;
  const edgeCorrespondences = readObjects(source.edgeCorrespondences, "edge correspondences", MAX_COMPARISON_EDGES, (item) => {
    const originalEdgeId = readText(item, "originalEdgeId", 40);
    const modifiedEdgeId = readText(item, "modifiedEdgeId", 40);
    const originalEdge = originalEdges.get(originalEdgeId);
    const modifiedEdge = modifiedEdges.get(modifiedEdgeId);
    if (!originalEdge || !modifiedEdge) throw new Error("Edge correspondence references an unknown edge.");
    const fromOriginal = occurrenceBySide.original.get(nodeOccurrence(original, originalEdge.from) ?? "");
    const fromModified = occurrenceBySide.modified.get(nodeOccurrence(modified, modifiedEdge.from) ?? "");
    const toOriginal = occurrenceBySide.original.get(nodeOccurrence(original, originalEdge.to) ?? "");
    const toModified = occurrenceBySide.modified.get(nodeOccurrence(modified, modifiedEdge.to) ?? "");
    if (matchedUnits.get(fromOriginal ?? "") !== fromModified || matchedUnits.get(toOriginal ?? "") !== toModified) {
      throw new Error("Corresponding edges do not connect corresponding operations.");
    }
    return {
      originalEdgeId,
      modifiedEdgeId,
      meaning: readText(item, "meaning", 200).trim(),
      difference: readText(item, "difference", 300).trim()
    };
  });
  if (new Set(edgeCorrespondences.map((match) => match.originalEdgeId)).size !== edgeCorrespondences.length ||
      new Set(edgeCorrespondences.map((match) => match.modifiedEdgeId)).size !== edgeCorrespondences.length) {
    throw new Error("Edge correspondences must be one-to-one.");
  }
  return {
    id,
    title: readText(source, "title", 160).trim(),
    original,
    modified,
    units,
    unitCorrespondences,
    edgeCorrespondences
  };
}

/** Keeps valid textual changes even when the optional paired visual representation is malformed. */
export function parseComparison(value: unknown, bounds?: ComparisonLineBounds): FileComparisonDraft {
  const source = record(value);
  const changes = Array.isArray(source.changes) ? source.changes.slice(0, 60) : [];
  const text = (item: Record<string, unknown>, key: string, max: number) =>
    typeof item[key] === "string" && (item[key] as string).length <= max ? (item[key] as string).trim() : "";
  const seenChangeIds = new Set<string>();
  let malformedVisual = false;
  const parsedChanges = changes.flatMap((change) => {
    if (typeof change !== "object" || change === null) return [];
    const item = change as Record<string, unknown>;
    const id = item.id;
    if (!comparisonId(id) || seenChangeIds.has(id)) return [];
    const scope = item.visualScopeId;
    let visualScopeId: string | undefined;
    if (typeof scope === "string" && scope.length <= 40 && (!scope || comparisonId(scope))) {
      visualScopeId = scope || undefined;
    } else {
      malformedVisual = true;
    }
    const parsed = {
      id,
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
    seenChangeIds.add(id);
    return [parsed];
  });
  let visualScopes: ComparisonVisualScope[] | undefined;
  if (!malformedVisual && source.visualScopes !== undefined) {
    try {
      if (!Array.isArray(source.visualScopes) || source.visualScopes.length > MAX_COMPARISON_SCOPES) {
        throw new Error("Too many comparison visual scopes.");
      }
      if (source.visualScopes.length > 0 && !bounds) throw new Error("Snapshot line counts are required.");
      const totals = { nodes: 0, edges: 0, text: 0 };
      visualScopes = source.visualScopes.map((rawScope) => {
        const scope = parseComparisonVisualScope(rawScope, bounds!);
        totals.nodes += scope.original.flowchart.nodes.length + scope.modified.flowchart.nodes.length;
        totals.edges += scope.original.flowchart.edges.length + scope.modified.flowchart.edges.length;
        totals.text += comparisonTextLength(scope);
        if (totals.nodes > MAX_COMPARISON_NODES || totals.edges > MAX_COMPARISON_EDGES || totals.text > MAX_COMPARISON_TEXT) {
          throw new Error("Comparison visual response exceeds its total budget.");
        }
        return scope;
      });
      if (new Set(visualScopes.map((scope) => scope.id)).size !== visualScopes.length) throw new Error("Duplicate comparison visual scope id.");
      const scopeIds = new Set(visualScopes.map((scope) => scope.id));
      if (parsedChanges.some((change) => change.visualScopeId && !scopeIds.has(change.visualScopeId))) {
        throw new Error("A change references an unknown visual scope.");
      }
    } catch {
      visualScopes = undefined;
      malformedVisual = true;
    }
  } else {
    malformedVisual = true;
  }
  if (parsedChanges.some((change) => change.visualScopeId) && !visualScopes?.length) malformedVisual = true;
  const limitations = readStrings(source.limitations, "limitations", 10).map((entry) => entry.trim()).filter(Boolean);
  if (malformedVisual) {
    const notice = "The paired visual comparison was omitted because its data was invalid or exceeded the safety limits; the textual comparison is still available.";
    if (limitations.length >= 10) limitations.splice(9, 1, notice);
    else limitations.push(notice);
  }
  return {
    summary: readText(source, "summary", 800).trim(),
    changes: parsedChanges,
    ...(visualScopes?.length ? { visualScopes } : {}),
    outside: optionalText(source, "outside", 1_200),
    possibleEffects: readStrings(source.possibleEffects, "possible effects", 10).map((entry) => entry.trim()).filter(Boolean),
    limitations
  };
}
