/** A structure diagram's boxes and import edges, as the layout needs them. */
export interface LayoutInput {
  readonly nodes: ReadonlyArray<{ readonly id: string }>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly weight: number }>;
}

export interface StructureLayout {
  /** Rows of node ids from top to bottom: layered rows, then unconnected nodes, then shared ones. */
  readonly rows: string[][];
  /** Which kind each row is, matching `rows`. */
  readonly rowKinds: Array<"layer" | "unconnected" | "shared">;
  /** Edges (as `from\u0000to`) that point upward because they close a cycle. */
  readonly back: string[];
  /** Edges not drawn because they lead to or from a shared node. */
  readonly hidden: string[];
  /** For each shared node, how many other boxes import it. */
  readonly usedBy: Record<string, number>;
  /**
   * Waypoints for edges that skip rows: invisible spacers (ids starting with
   * `\u0001`) placed in each row between the two ends, so the edge runs in
   * its own lane instead of through boxes.
   */
  readonly routes: Record<string, string[]>;
}

/**
 * Lays out an import graph in rows: importers above what they import, so
 * entry points sit on top and foundations below. A node imported by at least
 * half of the others (with five or more boxes) is "shared": it goes in a
 * bottom row and its edges are not drawn, so it does not pull arrows from
 * every box. Cycles are broken by depth-first search and their closing edges
 * are drawn upward. An edge that skips rows gets a waypoint in each row it
 * passes. Within each row, a few barycenter sweeps order nodes and waypoints
 * under their neighbors to reduce crossings. Self-contained, so it can run
 * in the webview as well as in tests.
 */
export function structureLayout(input: LayoutInput): StructureLayout {
  const ids = input.nodes.map((node) => node.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const key = (edge: { from: string; to: string }) => edge.from + "\u0000" + edge.to;
  const edges = input.edges.filter((edge) => order.has(edge.from) && order.has(edge.to) && edge.from !== edge.to);
  const importers = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const edge of edges) importers.get(edge.to)!.add(edge.from);
  const threshold = Math.max(3, Math.ceil((ids.length - 1) / 2));
  const shared = ids.length >= 5 ? ids.filter((id) => importers.get(id)!.size >= threshold) : [];
  const sharedSet = new Set(shared);
  const drawn = edges.filter((edge) => !sharedSet.has(edge.from) && !sharedSet.has(edge.to));
  const hidden = edges.filter((edge) => sharedSet.has(edge.from) || sharedSet.has(edge.to)).map(key);
  const usedBy: Record<string, number> = {};
  for (const id of shared) usedBy[id] = importers.get(id)!.size;

  const connected = new Set<string>();
  for (const edge of drawn) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const layered = ids.filter((id) => !sharedSet.has(id) && connected.has(id));
  const unconnected = ids.filter((id) => !sharedSet.has(id) && !connected.has(id));

  const outgoing = new Map<string, Array<{ from: string; to: string }>>(layered.map((id) => [id, []]));
  const indegree = new Map<string, number>(layered.map((id) => [id, 0]));
  for (const edge of drawn) {
    outgoing.get(edge.from)!.push(edge);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }
  const visit = new Map<string, number>();
  const back = new Set<string>();
  const dfs = (id: string): void => {
    visit.set(id, 1);
    for (const edge of outgoing.get(id)!) {
      const seen = visit.get(edge.to);
      if (seen === 1) back.add(key(edge));
      else if (!seen) dfs(edge.to);
    }
    visit.set(id, 2);
  };
  // Starting from nodes nothing imports keeps cycles' closing edges pointing upward.
  for (const id of [...layered].sort((left, right) => (indegree.get(left)! === 0 ? 0 : 1) - (indegree.get(right)! === 0 ? 0 : 1))) {
    if (!visit.get(id)) dfs(id);
  }
  const forward = drawn.filter((edge) => !back.has(key(edge)));

  const rank = new Map<string, number>(layered.map((id) => [id, 0]));
  const remaining = new Map<string, number>(layered.map((id) => [id, 0]));
  for (const edge of forward) remaining.set(edge.to, remaining.get(edge.to)! + 1);
  const queue = layered.filter((id) => remaining.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of forward) {
      if (edge.from !== id) continue;
      rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1));
      remaining.set(edge.to, remaining.get(edge.to)! - 1);
      if (remaining.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  const layers: string[][] = [];
  for (const id of layered) (layers[rank.get(id)!] = layers[rank.get(id)!] || []).push(id);
  for (const row of layers) row.sort((left, right) => order.get(left)! - order.get(right)!);
  // Waypoints for edges that skip rows; the segments between them take part in ordering.
  const routes: Record<string, string[]> = {};
  const segments: Array<{ from: string; to: string }> = [];
  let waypoint = 0;
  for (const edge of forward) {
    const start = rank.get(edge.from)!;
    const end = rank.get(edge.to)!;
    const chain: string[] = [];
    for (let row = start + 1; row < end; row++) {
      const id = "\u0001" + waypoint++;
      order.set(id, order.get(edge.from)!);
      layers[row]!.push(id);
      chain.push(id);
    }
    if (chain.length) routes[key(edge)] = chain;
    const points = [edge.from, ...chain, edge.to];
    for (let index = 1; index < points.length; index++) segments.push({ from: points[index - 1]!, to: points[index]! });
  }
  const rows = layers.filter(Boolean);

  // Positions are centered, since rows are drawn centered.
  const position = (id: string): number => {
    for (const row of rows) {
      const index = row.indexOf(id);
      if (index >= 0) return index - (row.length - 1) / 2;
    }
    return 0;
  };
  const sweep = (index: number, neighbors: (id: string) => string[]): void => {
    const row = rows[index]!;
    const centers = new Map(row.map((id, at) => {
      const around = neighbors(id).map(position);
      return [id, around.length ? around.reduce((sum, value) => sum + value, 0) / around.length : at - (row.length - 1) / 2] as const;
    }));
    row.sort((left, right) => centers.get(left)! - centers.get(right)! || order.get(left)! - order.get(right)!);
  };
  const above = (id: string) => segments.filter((edge) => edge.to === id).map((edge) => edge.from);
  const below = (id: string) => segments.filter((edge) => edge.from === id).map((edge) => edge.to);
  for (let iteration = 0; iteration < 4; iteration++) {
    for (let index = 1; index < rows.length; index++) sweep(index, above);
    for (let index = rows.length - 2; index >= 0; index--) sweep(index, below);
  }

  const rowKinds: Array<"layer" | "unconnected" | "shared"> = rows.map(() => "layer");
  if (unconnected.length) {
    rows.push(unconnected);
    rowKinds.push("unconnected");
  }
  if (shared.length) {
    rows.push(shared);
    rowKinds.push("shared");
  }
  return { rows, rowKinds, back: [...back], hidden, usedBy, routes };
}
