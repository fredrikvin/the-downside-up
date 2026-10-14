import type {
  ExplanationFormat,
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
