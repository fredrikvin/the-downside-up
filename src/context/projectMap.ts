import type { FolderLevel, MapLink, MapPart, ProjectMap } from "../core/types";

/**
 * Local groundwork for the project map: a bounded folder outline with
 * markers of components (manifests, container and deployment files, API
 * contracts, READMEs), deployment facts reduced to names, checks of the map a
 * model returns, and what each folder page shows from it. No I/O, so it is
 * unit-tested directly.
 */

/** A folder in the outline sent while priming: how many eligible files it holds and what marks it. */
export interface FolderOutlineEntry {
  /** Repository-relative path, or "" for the repository root. */
  readonly path: string;
  /** Eligible files at any depth below it. */
  readonly files: number;
  /** Such as "go.mod", "Dockerfile", "AsyncAPI", or "README", for files directly inside it. */
  readonly markers: readonly string[];
}

const MAX_OUTLINE_ENTRIES = 250;
const MAX_OUTLINE_DEPTH = 6;
/** Folders this shallow are always listed; deeper ones only when they hold a marker. */
const SHALLOW_DEPTH = 2;
const MAX_OUTLINE_BYTES = 12 * 1024;

const MANIFESTS = new Map([
  ["package.json", "package.json"],
  ["go.mod", "go.mod"],
  ["cargo.toml", "Cargo.toml"],
  ["pyproject.toml", "pyproject.toml"],
  ["setup.py", "setup.py"],
  ["pom.xml", "pom.xml"],
  ["build.gradle", "build.gradle"],
  ["build.gradle.kts", "build.gradle"],
  ["gemfile", "Gemfile"],
  ["composer.json", "composer.json"]
]);

const DEPLOYMENT_FOLDERS = new Set(["manifests", "k8s", "kubernetes", "helm", "charts", "deploy", "deployment", "deployments", "kustomize"]);

export const isContainerFile = (name: string): boolean => /^(?:Dockerfile|Containerfile)(?:\..+)?$/i.test(name);
const isComposeFile = (name: string): boolean => /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(name);

/** Whether a file describes deployment (Compose, Kubernetes, Helm), so only facts reduced to names are shared from it. */
export function isDeploymentFile(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  if (!/\.ya?ml$/i.test(name)) return false;
  if (isComposeFile(name) || /^(?:kustomization|Chart)\.ya?ml$/i.test(name)) return true;
  return segments.slice(0, -1).some((segment) => DEPLOYMENT_FOLDERS.has(segment.toLowerCase()));
}

/**
 * Whether a file is an API contract: OpenAPI, AsyncAPI, protobuf, or a
 * GraphQL schema. A `.graphql` file counts only when its name or folder says
 * schema, since most are queries and operations.
 */
export function isContractFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  if (/(?:openapi|swagger|asyncapi)[^/]*\.(?:ya?ml|json)$/i.test(name) || /\.(?:graphqls|proto)$/i.test(name)) return true;
  return /\.(?:graphql|gql)$/i.test(name) && /schema/i.test(path);
}

const GENERATED_FOLDER = /^(?:__generated__|generated)$/i;
const GENERATED_FILE = /(?:\.generated\.[^/]+|\.gen\.go|_generated\.go|\.pb\.go|_pb2(?:_grpc)?\.py|\.min\.[cm]?js|\.d\.ts)$/i;

/** Generated code (by folder or file name), which says little about the project: never primed, and no marker. */
export function isGeneratedSource(path: string): boolean {
  return GENERATED_FILE.test(path) || path.split("/").slice(0, -1).some((segment) => GENERATED_FOLDER.test(segment));
}

/** What a file tells about the folder that holds it, if anything. */
function markerFor(path: string): string | undefined {
  if (isGeneratedSource(path)) return undefined;
  const name = path.split("/").pop() ?? "";
  const lower = name.toLowerCase();
  const manifest = MANIFESTS.get(lower);
  if (manifest) return manifest;
  if (/\.csproj$/i.test(name)) return ".csproj";
  if (isContainerFile(name)) return "Dockerfile";
  if (isComposeFile(name)) return "Compose";
  if (isDeploymentFile(path)) return "Kubernetes or Helm";
  if (/(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/i.test(name)) return "OpenAPI";
  if (/asyncapi[^/]*\.(?:ya?ml|json)$/i.test(name)) return "AsyncAPI";
  if (/\.(?:graphqls?|gql)$/i.test(name)) return isContractFile(path) ? "GraphQL schema" : undefined;
  if (/\.proto$/i.test(name)) return "protobuf";
  if (/^readme(?:\.|$)/i.test(name)) return "README";
  if (/^(?:main\.(?:go|rs|py|java|kt|cs)|(?:index|main|server|app)\.(?:[cm]?[jt]sx?)|app\.py|__main__\.py)$/i.test(name)) return "entry point";
  return undefined;
}

const parentOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};
const depthOf = (path: string): number => (path ? path.split("/").length : 0);

/** Whether `path` is `folder` or inside it; everything is inside the root (""). */
export const isWithinFolder = (path: string, folder: string): boolean =>
  folder === "" || path === folder || path.startsWith(`${folder}/`);

/**
 * Builds a bounded outline from eligible repository files: every folder up
 * to two levels deep, deeper folders that hold a marker (up to six levels),
 * and the folders above those, so the tree stays connected. Shallow folders
 * win when the outline is too long.
 */
export function folderOutline(files: readonly string[]): FolderOutlineEntry[] {
  const counts = new Map<string, number>([["", 0]]);
  const markers = new Map<string, Set<string>>();
  for (const file of files) {
    const folder = parentOf(file);
    const marker = markerFor(file);
    if (marker) {
      if (!markers.has(folder)) markers.set(folder, new Set());
      markers.get(folder)!.add(marker);
    }
    for (let current = folder; ; current = parentOf(current)) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
      if (current === "") break;
    }
  }
  const wanted = [...counts.keys()]
    .filter((path) => depthOf(path) <= SHALLOW_DEPTH || (markers.has(path) && depthOf(path) <= MAX_OUTLINE_DEPTH))
    .sort((left, right) => depthOf(left) - depthOf(right) || left.localeCompare(right))
    .slice(0, MAX_OUTLINE_ENTRIES);
  const included = new Set(wanted);
  for (const path of wanted) {
    for (let current = parentOf(path); current !== ""; current = parentOf(current)) included.add(current);
  }
  return [...included]
    .sort((left, right) => (left === "" ? -1 : right === "" ? 1 : left.localeCompare(right)))
    .slice(0, MAX_OUTLINE_ENTRIES + MAX_OUTLINE_DEPTH)
    .map((path) => ({ path, files: counts.get(path) ?? 0, markers: [...(markers.get(path) ?? [])].sort() }));
}

/** The outline as compact text for a prompt, one folder per line, bounded. */
export function outlineText(entries: readonly FolderOutlineEntry[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const entry of entries) {
    const line = `${entry.path ? `${entry.path}/` : "(repository root)"} ${entry.files} file${entry.files === 1 ? "" : "s"}${entry.markers.length ? `; ${entry.markers.join(", ")}` : ""}`;
    if (size + line.length + 1 > MAX_OUTLINE_BYTES) {
      lines.push(`… ${entries.length - lines.length} more folders not listed`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** Every folder that holds eligible files, at any depth, for checking the paths a model returns. */
export function foldersOf(files: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const file of files) {
    for (let current = parentOf(file); current !== "" && !folders.has(current); current = parentOf(current)) folders.add(current);
  }
  return folders;
}

const MAX_FACTS = 20;
const MAX_FACTS_BYTES = 1_500;

/**
 * Reduces a Compose, Kubernetes, or Helm file to names: resource kinds and
 * names, Compose services and what they depend on, images, ports,
 * environment variable names, ConfigMap keys, and Kustomize resources.
 * Values of settings, environment variables, and config entries are never
 * kept, since they may hold credentials or internal addresses.
 */
export function deploymentFacts(text: string): string {
  const facts = {
    kinds: new Set<string>(),
    names: new Set<string>(),
    services: new Set<string>(),
    dependsOn: new Set<string>(),
    images: new Set<string>(),
    ports: new Set<string>(),
    env: new Set<string>(),
    config: new Set<string>(),
    resources: new Set<string>()
  };
  const add = (set: Set<string>, value: string) => {
    const clean = value.trim().replace(/^["']|["']$/g, "").slice(0, 120);
    if (clean && set.size < MAX_FACTS) set.add(clean);
  };
  // Mapping keys above the current line, with their indentation.
  const stack: Array<{ indent: number; key: string }> = [];
  let kind = "";
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (/^---/.test(raw)) {
      stack.length = 0;
      kind = "";
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    let content = raw.trim();
    let itemIndent = indent;
    const item = content.startsWith("- ") || content === "-";
    if (item) {
      content = content.slice(1).trim();
      itemIndent = indent + 2;
    }
    while (stack.length && stack[stack.length - 1]!.indent >= (item ? indent + 1 : indent)) stack.pop();
    const parent = stack[stack.length - 1]?.key ?? "";
    const keys = stack.map((entry) => entry.key);
    const pair = /^([\w.\-/]+)\s*:(?:\s+(.*))?$/.exec(content);
    if (!pair) {
      if (!item) continue;
      // A plain list item: Compose environment as KEY=value, dependencies, or Kustomize resources.
      if (parent === "environment") add(facts.env, content.split("=")[0]!);
      else if (parent === "depends_on") add(facts.dependsOn, content);
      else if (parent === "resources" && stack.length === 1) add(facts.resources, content);
      else if (parent === "ports") add(facts.ports, content.replace(/^["']|["']$/g, ""));
      continue;
    }
    const key = pair[1]!;
    const value = (pair[2] ?? "").replace(/\s+#.*$/, "").trim();
    if (stack.length === 0 && key === "kind") {
      kind = value;
      add(facts.kinds, value);
    }
    if (key === "image" && value) add(facts.images, value);
    if (/^(?:containerPort|targetPort|port|nodePort)$/.test(key) && /^\d+$/.test(value)) add(facts.ports, value);
    if (key === "name" && value && parent === "metadata") add(facts.names, value);
    if (key === "name" && value && item && parent === "env") add(facts.env, value);
    if (parent === "environment") add(facts.env, key);
    if (parent === "depends_on") add(facts.dependsOn, key);
    if (keys.length === 1 && keys[0] === "services" && !value) add(facts.services, key);
    if (keys.length === 1 && keys[0] === "data" && /^(?:ConfigMap|Secret)$/.test(kind)) add(facts.config, key);
    if (!value || value === "|" || value === ">" || value.startsWith("|") || value.startsWith(">")) {
      stack.push({ indent: itemIndent, key });
    }
  }
  const parts = [
    ["kinds", facts.kinds],
    ["names", facts.names],
    ["Compose services", facts.services],
    ["depends on", facts.dependsOn],
    ["images", facts.images],
    ["ports", facts.ports],
    ["environment variable names", facts.env],
    ["config keys", facts.config],
    ["resources", facts.resources]
  ] as const;
  const summary = parts
    .filter(([, set]) => set.size > 0)
    .map(([label, set]) => `${label}: ${[...set].join(", ")}`)
    .join("\n");
  return summary.length > MAX_FACTS_BYTES ? `${summary.slice(0, MAX_FACTS_BYTES)}…` : summary;
}

const MAX_MAP_PARTS = 60;
const MAX_MAP_LINKS = 80;
const LEVELS = new Set<MapPart["level"]>(["group", "component", "module", "support", "external"]);

const cleanPath = (path: string): string => path.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Keeps only what the extension can confirm: parts whose folder exists in
 * the repository (outside things have no folder), one part per folder and
 * id, and links between kept parts. Duplicate links are merged.
 */
export function checkedProjectMap(map: ProjectMap, exists: (path: string) => boolean): ProjectMap {
  const parts: MapPart[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const part of map.parts) {
    if (parts.length >= MAX_MAP_PARTS) break;
    // Diagrams use control characters internally (waypoints, edge keys), so ids never carry them.
    const id = part.id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!id || ids.has(id) || !LEVELS.has(part.level) || !part.name.trim()) continue;
    if (part.level === "external") {
      ids.add(id);
      const { path: _path, ...rest } = part;
      parts.push({ ...rest, id });
      continue;
    }
    const path = cleanPath(part.path ?? "");
    if (!path || paths.has(path) || path.split("/").some((segment) => segment === ".." || segment === ".") || !exists(path)) continue;
    ids.add(id);
    paths.add(path);
    parts.push({ ...part, id, path });
  }
  const links = new Map<string, MapLink>();
  const clean = (id: string) => id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  for (const raw of map.links) {
    if (links.size >= MAX_MAP_LINKS) break;
    const link = { ...raw, from: clean(raw.from), to: clean(raw.to) };
    if (!ids.has(link.from) || !ids.has(link.to) || link.from === link.to) continue;
    const key = `${link.from}\0${link.to}`;
    const label = link.label.trim().slice(0, 40);
    const existing = links.get(key);
    links.set(key, existing
      ? { ...existing, label: [...new Set([...existing.label.split(", "), label].filter(Boolean))].slice(0, 3).join(", ") }
      : { from: link.from, to: link.to, label });
  }
  return { summary: map.summary.trim(), parts, links: [...links.values()] };
}

/** How a folder page zooms: a map level, the project root, or a plain folder the map does not place. */
export type FolderPageLevel = "project" | FolderLevel | "folder";

const folderParts = (map: ProjectMap): Array<MapPart & { path: string }> =>
  map.parts.filter((part): part is MapPart & { path: string } => part.level !== "external" && part.path !== undefined);

/** The mapped part closest above a folder, not counting the folder itself. */
function nearestAbove(map: ProjectMap, path: string): (MapPart & { path: string }) | undefined {
  let best: (MapPart & { path: string }) | undefined;
  for (const part of folderParts(map)) {
    if (part.path !== path && isWithinFolder(path, part.path) && (!best || part.path.length > best.path.length)) best = part;
  }
  return best;
}

/** The map part for a folder, if the map lists it. */
export const mapPartAt = (map: ProjectMap, path: string): MapPart | undefined =>
  folderParts(map).find((part) => part.path === path);

/**
 * How a folder page zooms: the root is the project; a mapped folder has its
 * own level; a folder inside a component or module shows its files like a
 * module; one inside a support folder is support; anything else is a plain
 * folder, shown as before the map existed.
 */
export function folderLevel(map: ProjectMap | undefined, path: string): FolderPageLevel {
  if (!path) return "project";
  if (!map) return "folder";
  const own = mapPartAt(map, path);
  if (own) return own.level as FolderLevel;
  const above = nearestAbove(map, path);
  if (!above) return "folder";
  if (above.level === "component" || above.level === "module") return "module";
  return above.level === "support" ? "support" : "folder";
}

/** A box on a folder's map: one of its parts, or something outside it that they connect to. */
export interface MapViewNode {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** The folder it opens, for parts inside the repository. */
  readonly path?: string;
  /** Inside the shown folder, elsewhere in the repository, or outside the repository. */
  readonly place: "inside" | "outside" | "external";
  /** For parts inside a group, the group's name, shown as context. */
  readonly group?: string;
}

export interface MapView {
  readonly nodes: readonly MapViewNode[];
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string }>;
}

/** A project or group map shows at most this many boxes before components are drawn as their groups. */
const MAX_MAP_BOXES = 14;

/** The outermost parts of one level inside a folder (not the folder itself). */
function outermost(map: ProjectMap, path: string, level: FolderLevel): Array<MapPart & { path: string }> {
  const inside = folderParts(map).filter((part) => part.level === level && part.path !== path && isWithinFolder(part.path, path));
  return inside.filter((part) => !inside.some((other) => other !== part && isWithinFolder(part.path, other.path)));
}

/**
 * The map a folder page draws, one zoom level below the folder: the project
 * and groups show components (or their groups when there are too many), a
 * component shows its modules (or itself, with what it connects to, when it
 * has none). Each link is drawn between the boxes that hold its ends; ends
 * elsewhere in the repository are drawn as their outermost component, and
 * links inside a single box are left for that box's own page. Modules,
 * support folders, and plain folders have no map.
 */
export function mapView(map: ProjectMap | undefined, path: string): MapView | undefined {
  if (!map) return undefined;
  const level = folderLevel(map, path);
  let boxes: Array<MapPart & { path: string }>;
  if (level === "project" || level === "group" || level === "folder") {
    boxes = outermost(map, path, "component");
    if (boxes.length === 0) boxes = outermost(map, path, "module");
    if (boxes.length > MAX_MAP_BOXES) {
      const groups = outermost(map, path, "group");
      const collapsed = new Map<string, MapPart & { path: string }>();
      for (const box of boxes) {
        const group = groups.find((candidate) => isWithinFolder(box.path, candidate.path));
        collapsed.set((group ?? box).id, group ?? box);
      }
      boxes = [...collapsed.values()];
    }
  } else if (level === "component") {
    boxes = outermost(map, path, "module");
    if (boxes.length === 0) boxes = folderParts(map).filter((part) => part.path === path);
  } else {
    return undefined;
  }
  if (boxes.length === 0) return undefined;
  const byId = new Map(map.parts.map((part) => [part.id, part]));
  const groups = folderParts(map).filter((part) => part.level === "group");
  const groupName = (part: MapPart & { path: string }) =>
    groups.filter((group) => group.path !== part.path && isWithinFolder(part.path, group.path) && !isWithinFolder(path, group.path))
      .sort((left, right) => right.path.length - left.path.length)[0]?.name;
  const nodes = new Map<string, MapViewNode>();
  for (const box of boxes) {
    const group = groupName(box);
    nodes.set(box.id, { id: box.id, name: box.name, summary: box.summary, path: box.path, place: "inside", ...(group ? { group } : {}) });
  }
  const components = folderParts(map).filter((part) => part.level === "component");
  const endpoint = (id: string): string | undefined => {
    const part = byId.get(id);
    if (!part) return undefined;
    if (part.level === "external" || part.path === undefined) {
      if (!nodes.has(part.id)) nodes.set(part.id, { id: part.id, name: part.name, summary: part.summary, place: "external" });
      return part.id;
    }
    const partPath = part.path;
    if (isWithinFolder(partPath, path) && partPath !== path) {
      return boxes.find((box) => isWithinFolder(partPath, box.path))?.id;
    }
    if (partPath === path || isWithinFolder(path, partPath)) {
      // The shown folder itself, or a folder above it: only a component drawn as its own single box takes it.
      return boxes.length === 1 && boxes[0]!.path === path ? boxes[0]!.id : undefined;
    }
    const outer = components
      .filter((component) => isWithinFolder(partPath, component.path))
      .sort((left, right) => left.path.length - right.path.length)[0] ?? part as MapPart & { path: string };
    if (!nodes.has(outer.id)) {
      nodes.set(outer.id, { id: outer.id, name: outer.name, summary: outer.summary, path: outer.path, place: "outside" });
    }
    return outer.id;
  };
  const edges = new Map<string, { from: string; to: string; label: string }>();
  for (const link of map.links) {
    const from = endpoint(link.from);
    const to = endpoint(link.to);
    if (!from || !to || from === to) continue;
    // Links between two outside ends say nothing about this folder.
    if (nodes.get(from)!.place !== "inside" && nodes.get(to)!.place !== "inside") continue;
    const key = `${from}\0${to}`;
    const existing = edges.get(key);
    const label = existing
      ? [...new Set([...existing.label.split(", "), link.label].filter(Boolean))].slice(0, 3).join(", ")
      : link.label;
    edges.set(key, { from, to, label });
  }
  const connected = new Set([...edges.values()].flatMap((edge) => [edge.from, edge.to]));
  const shown = [...nodes.values()].filter((node) => node.place === "inside" || connected.has(node.id));
  if (shown.length < 2) return undefined;
  return { nodes: shown, edges: [...edges.values()] };
}

/**
 * The parts listed on a project or group page: mapped parts whose closest
 * mapped folder above is this one, with outside things listed on the
 * project page.
 */
export function mapMembers(map: ProjectMap | undefined, path: string): MapPart[] {
  if (!map) return [];
  const inside = folderParts(map).filter((part) => part.path !== path && isWithinFolder(part.path, path)
    && (nearestAbove(map, part.path)?.path ?? "") === path);
  return [...inside, ...(path === "" ? map.parts.filter((part) => part.level === "external") : [])];
}
