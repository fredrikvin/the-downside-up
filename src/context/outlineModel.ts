import type { SourceReference } from "./related";
import type { Description } from "./outlineText";

const MAX_DOCUMENTATION_LENGTH = 1_200;

export type OutlineKind =
  | "import"
  | "module"
  | "function"
  | "type"
  | "impl"
  | "constant"
  | "variable"
  | "field"
  | "macro"
  | "comment";

/** An outline entry before IDs and references are assigned. */
export interface OutlineEntryDraft {
  readonly kind: OutlineKind;
  /** Short label shown before the name, such as "Function" or "Import". */
  readonly kindLabel: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly depth: number;
  /** First line of the entry, including attached documentation and attributes. */
  readonly startLine: number;
  readonly endLine: number;
  readonly nameLine: number;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly description: Description;
  readonly documentation?: string;
  readonly notes: readonly Description[];
  /** True when the entry is a function body that Explain can target. */
  readonly explainable: boolean;
  /** Primary local objects that stay visible independently of optional details. */
  readonly alwaysVisible?: boolean;
  /** False for explainable data objects that cannot have routine callers. */
  readonly showCallers?: boolean;
  /** Locally built structured details; never generated HTML. */
  readonly previewTable?: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly Description[])[];
  };
}

export interface OutlineEntry extends OutlineEntryDraft {
  readonly id: string;
  readonly reference: SourceReference;
}

export function boundedDocumentation(lines: readonly string[]): string | undefined {
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return undefined;
  return text.length > MAX_DOCUMENTATION_LENGTH
    ? `${text.slice(0, MAX_DOCUMENTATION_LENGTH - 1).trimEnd()}…`
    : text;
}

export function commentDraft(
  start: number,
  end: number,
  text: string,
  lines: readonly string[],
  depth = 0
): OutlineEntryDraft {
  const line = lines[start] ?? "";
  return {
    kind: "comment",
    kindLabel: "Comment",
    name: "",
    qualifiedName: "",
    depth,
    startLine: start,
    endLine: end,
    nameLine: start,
    nameStart: line.length - line.trimStart().length,
    nameEnd: line.length,
    description: [{ text }],
    notes: [],
    explainable: false
  };
}
