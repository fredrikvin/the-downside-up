import type { OutlineEntry } from "../context/outlineModel";

/** Which local outline items the preview shows besides functions and methods. */
export interface OutlineInclude {
  /** Import statements. */
  readonly imports: boolean;
  /** Structs, enums, interfaces, traits, type aliases, implementations, and fields. */
  readonly types: boolean;
  /** Constants and variables outside functions. */
  readonly values: boolean;
  /** Variables and constants declared inside functions. */
  readonly locals: boolean;
  /** Standalone comments. */
  readonly comments: boolean;
  /** Source documentation attached to functions and methods. */
  readonly functionComments: boolean;
  /** Modules, packages, and macros. */
  readonly modules: boolean;
  /** The local one-line signature description and notes under each function. */
  readonly functionDetails: boolean;
}

export const CONCISE_OUTLINE: OutlineInclude = {
  imports: false,
  types: false,
  values: false,
  locals: false,
  comments: false,
  functionComments: false,
  modules: false,
  functionDetails: false
};

export function outlineInclude(value: unknown): OutlineInclude {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const flag = (key: keyof OutlineInclude) => source[key] === true;
  return {
    imports: flag("imports"),
    types: flag("types"),
    values: flag("values"),
    locals: flag("locals"),
    comments: flag("comments"),
    functionComments: flag("functionComments"),
    modules: flag("modules"),
    functionDetails: flag("functionDetails")
  };
}

function contains(outer: OutlineEntry, inner: OutlineEntry): boolean {
  return outer.depth < inner.depth && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

/**
 * Keeps the entries the settings ask for, in order, and re-indents each by
 * the number of visible entries that enclose it. Functions are always kept;
 * Their local details and attached documentation have independent display flags.
 */
export function visibleOutline(entries: readonly OutlineEntry[], include: OutlineInclude): OutlineEntry[] {
  const ancestors: OutlineEntry[] = [];
  const visible: OutlineEntry[] = [];
  const visibleIds = new Set<string>();
  for (const entry of entries) {
    while (ancestors.length && !contains(ancestors[ancestors.length - 1]!, entry)) ancestors.pop();
    const insideFunction = ancestors.some((ancestor) => ancestor.kind === "function");
    let shown: boolean;
    switch (entry.kind) {
      case "function": shown = true; break;
      case "import": shown = include.imports; break;
      case "type":
      case "impl":
      case "field": shown = include.types; break;
      case "constant":
      case "variable": shown = insideFunction ? include.locals : include.values; break;
      case "comment": shown = include.comments; break;
      case "module":
      case "macro": shown = include.modules; break;
      default: shown = true;
    }
    if (entry.alwaysVisible) shown = true;
    if (entry.kind === "field" && ancestors.some((ancestor) => ancestor.previewTable)) shown = false;
    if (shown) {
      const depth = ancestors.filter((ancestor) => visibleIds.has(ancestor.id)).length;
      const detailed = entry.alwaysVisible || entry.kind !== "function" || include.functionDetails;
      visible.push({
        ...entry,
        depth,
        ...(entry.kind === "function" && !include.functionComments ? { documentation: undefined } : {}),
        ...(detailed ? {} : { description: [], notes: [] })
      });
      visibleIds.add(entry.id);
    }
    ancestors.push(entry);
  }
  return visible;
}
