import type {
  ComparisonCatalogueEntry, ComparisonChangeDraft, ComparisonRecord, ComparisonVisualScope, ComparisonVisualSide
} from "../core/types";
import {
  renderReviewComparisonFlowchart,
  renderReviewSummaryDiagram,
  type ReviewExportData,
  type ReviewExportFile
} from "./reviewExport";

const MAX_BODY_BYTES = 60_000;

export interface ReviewPublicationFile {
  readonly path: string;
  readonly body: string;
  readonly overview: string;
  readonly functions: readonly ReviewPublicationFunction[];
}

export interface ReviewPublicationFunction {
  readonly id: string;
  readonly identity: string;
  readonly category: ComparisonCatalogueEntry["category"];
  readonly body: string;
  readonly original?: { readonly start: number; readonly end: number };
  readonly modified?: { readonly start: number; readonly end: number };
}

export interface ReviewPublication {
  readonly summary: string;
  readonly files: readonly ReviewPublicationFile[];
}

function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeMarkdownText(value: string): string {
  const escaped = [...value].map((character) => {
    if (character === "&") return "&amp;";
    if (character === "@") return "＠";
    if (/[\\`*_{}\[\]()#+!|>~]/.test(character)) return `\\${character}`;
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return character;
  }).join("");
  return escaped
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]{1,31}):/gi, "$1&#58;")
    .replace(/\b((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?=\/|[?#:]|\b)/gi,
      (domain) => domain.replace(/\./g, "&#46;"));
}

function codeSpan(value: string): string {
  // Code spans suppress Markdown links, but keep at-signs inert as well so
  // host-side notification scanners cannot interpret an arbitrary mention.
  const text = cleanText(value).replace(/@/g, "＠");
  if (!text) return "``";
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const delimiter = "`".repeat(Math.max(1, ...runs.map((run) => run + 1)));
  const needsPadding = text.startsWith(" ") || text.endsWith(" ") || text.startsWith("`") || text.endsWith("`");
  return `${delimiter}${needsPadding ? " " : ""}${text}${needsPadding ? " " : ""}${delimiter}`;
}

/**
 * Renders untrusted prose as inert Markdown. Balanced backtick spans remain
 * inline code; all other Markdown structure, mentions, and autolinks are neutralized.
 */
export function renderReviewPublicationText(value: string): string {
  const text = cleanText(value);
  const parts: string[] = [];
  let position = 0;
  while (position < text.length) {
    const opening = text.indexOf("`", position);
    if (opening < 0) {
      parts.push(escapeMarkdownText(text.slice(position)));
      break;
    }
    parts.push(escapeMarkdownText(text.slice(position, opening)));
    let end = opening;
    while (text[end] === "`") end += 1;
    const delimiter = text.slice(opening, end);
    let closing = -1;
    for (let candidate = text.indexOf("`", end); candidate >= 0; candidate = text.indexOf("`", candidate + 1)) {
      let candidateEnd = candidate;
      while (text[candidateEnd] === "`") candidateEnd += 1;
      if (text.slice(candidate, candidateEnd) === delimiter) {
        closing = candidate;
        break;
      }
    }
    if (closing < 0) {
      parts.push("&#96;".repeat(delimiter.length));
      position = end;
      continue;
    }
    parts.push(codeSpan(text.slice(end, closing)));
    position = closing + delimiter.length;
  }
  return parts.join("");
}

function relativePath(path: string): string {
  const normalized = cleanText(path).replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("../")) {
    return normalized.split("/").filter(Boolean).at(-1) ?? "file";
  }
  return normalized || "file";
}

function bulletList(values: readonly string[]): string {
  return values.map((value) => `- ${renderReviewPublicationText(value)}`).join("\n");
}

function summaryBody(data: ReviewExportData): string {
  const summary = data.summary.value;
  const omittedFiles = data.files.filter((file) =>
    !file.comparison || (file.status !== "current" && file.status !== "low-value")
  );
  const themes = summary.themes.map((theme) =>
      `- **${renderReviewPublicationText(theme.title)}**: ${renderReviewPublicationText(theme.text)}`
    ).join("\n");
  const omissionDetails = omittedFiles.map((file) => {
      const path = relativePath(file.path);
      return `- ${renderReviewPublicationText(path)} — ${renderReviewPublicationText(file.reason ?? file.status)}`;
    }).join("\n");
  const unlistedOmissions = Math.max(0, data.coverage.unavailable + data.coverage.omitted -
    omittedFiles.filter((file) => file.status === "missing" || file.status === "outdated" ||
      file.status === "unavailable").length);
  const caveats = summary.limitations.filter((notice) => ![
    "Grounded only in confirmed source diffs with bounded surrounding context;",
    "Low-value files remain in the confirmed review but are excluded from summary evidence.",
    "Surrounding source is bounded:",
    "Bounded diff alignment retained replacement regions"
  ].some((prefix) => notice.startsWith(prefix)));

  return [
    "## Review summary",
    renderReviewPublicationText(summary.summary) || "No summary recorded.",
    "",
    ...(themes ? ["### Themes", themes, ""] : []),
    ...(summary.diagram ? ["### Affected parts", renderReviewSummaryDiagram(data.summary, []), ""] : []),
    ...(data.coverage.unavailable + data.coverage.omitted > 0
      ? ["**Incomplete coverage:** some confirmed diffs could not be included. See Review details.", ""] : []),
    "<details>",
    "<summary>Review details</summary>",
    "",
    ...(summary.possibleEffects.length ? ["### Possible effects", bulletList(summary.possibleEffects), ""] : []),
    ...(caveats.length ? ["### Review caveats", bulletList(caveats), ""] : []),
    "### Coverage",
    `- Confirmed files: ${data.coverage.total}`,
    `- Included in summary evidence: ${data.coverage.included}`,
    `- Unavailable: ${data.coverage.unavailable}`,
    `- Omitted for budget: ${data.coverage.omitted}`,
    `- Low-value: ${data.coverage.lowValue}`,
    ...(unlistedOmissions ? [`- Additional omissions without an individual file record: ${unlistedOmissions}`] : []),
    "",
    ...(omissionDetails ? ["### Files without an included saved comparison", omissionDetails, ""] : []),
    "### Model",
    renderReviewPublicationText(`${data.summary.provider} · ${data.summary.model}`),
    "",
    "</details>"
  ].join("\n");
}

function lineRange(start: number, end: number, total: number): string | undefined {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end <= total
    ? start === end ? `line ${start}` : `lines ${start}-${end}` : undefined;
}

function functionRange(record: ComparisonRecord, entry: ComparisonCatalogueEntry, side: "original" | "modified") {
  const source = entry[side];
  if (!source || !Number.isSafeInteger(source.startColumn) || !Number.isSafeInteger(source.endColumn) ||
      source.startColumn < 0 || source.endColumn < 0 ||
      (source.startLine === source.endLine && source.endColumn <= source.startColumn)) return undefined;
  const start = source.startLine + 1;
  // Source ranges end exclusively; column zero belongs to the preceding line.
  const end = source.endLine + (source.endColumn === 0 && source.endLine > source.startLine ? 0 : 1);
  return lineRange(start, end, record[side].lines) ? { start, end } : undefined;
}

function sourceRanges(record: ComparisonRecord, entry: ComparisonCatalogueEntry): string {
  return (["original", "modified"] as const).flatMap((side) => {
    const range = functionRange(record, entry, side);
    return range ? [`${side === "original" ? "Before" : "After"} ${lineRange(range.start, range.end, record[side].lines)}`] : [];
  }).join("; ");
}

function changeBody(record: ComparisonRecord, change: ComparisonChangeDraft): string {
  const ranges = (["original", "modified"] as const).flatMap((side) => {
    const range = lineRange(change[side].start, change[side].end, record[side].lines);
    return range ? [`${side === "original" ? "Before" : "After"} ${range}`] : [];
  });
  return [
    `#### ${renderReviewPublicationText(change.title)}`,
    "",
    ...(ranges.length ? [`**Changed lines:** ${ranges.join("; ")}.`, ""] : []),
    `- **Before:** ${renderReviewPublicationText(change.before || "No previous behavior recorded.")}`,
    `- **After:** ${renderReviewPublicationText(change.after || "No resulting behavior recorded.")}`,
    ...(change.when ? [`- **When:** ${renderReviewPublicationText(change.when)}`] : []),
    ...(change.flow ? [`- **Flow:** ${renderReviewPublicationText(change.flow)}`] : [])
  ].join("\n");
}

function executionBody(
  record: ComparisonRecord, changes: readonly ComparisonChangeDraft[], scopes: readonly ComparisonVisualScope[]
): string {
  const scopeIds = new Set(scopes.map((scope) => scope.id));
  return [
    ...changes.filter((change) => !change.visualScopeId || !scopeIds.has(change.visualScopeId))
      .map((change) => changeBody(record, change)),
    ...scopes.map((scope) => [
      ...changes.filter((change) => change.visualScopeId === scope.id).map((change) => changeBody(record, change)),
      renderScope(scope)
    ].join("\n\n"))
  ].join("\n\n");
}

function renderSideText(
  side: ComparisonVisualSide,
  field: "steps" | "pseudocode",
  absentText: string
): string {
  if (side.presence === "absent") return absentText;
  const items = side[field];
  if (!items.length) return "No items recorded.";
  return items.map((item, index) => {
    const indentation = field === "pseudocode" ? "&emsp;".repeat(Math.max(0, Math.min(4, item.depth ?? 0))) : "";
    const contents = field === "pseudocode" ? codeSpan(item.text) : renderReviewPublicationText(item.text);
    const detail = field === "steps" && item.detail ? ` — ${renderReviewPublicationText(item.detail)}` : "";
    return `${field === "steps" ? `${index + 1}. ` : `- ${indentation}`}${contents}${detail}`;
  }).join("\n");
}

function renderFlowchartSide(side: ComparisonVisualSide): string {
  if (side.presence === "absent") return "Not present in this version.";
  if (side.flowchartStatus === "available" && side.flowchart.nodes.length) {
    return renderReviewComparisonFlowchart(side);
  }
  const status = side.flowchartStatus === "not-applicable" ? "Not applicable." : "Unavailable.";
  return side.flowchartReason
    ? `${status} ${renderReviewPublicationText(side.flowchartReason)}`
    : status;
}

function renderScope(scope: ComparisonVisualScope): string {
  const hasPseudocode = scope.original.pseudocode.length > 0 || scope.modified.pseudocode.length > 0;
  const hasFlowchart = [scope.original, scope.modified].some((side) =>
    side.flowchartStatus === "available" && side.flowchart.nodes.length > 0
  );
  const sections = [
    `#### Execution detail: ${renderReviewPublicationText(scope.title)}`,
    "",
    "<details>",
    "<summary>Steps</summary>",
    "",
    "**Before**",
    renderSideText(scope.original, "steps", "Not present in this version."),
    "",
    "**After**",
    renderSideText(scope.modified, "steps", "Not present in this version."),
    "",
    "</details>",
    ...(hasPseudocode ? [
      "",
      "<details>",
      "<summary>Pseudocode</summary>",
      "",
      "**Before**",
      renderSideText(scope.original, "pseudocode", "Not present in this version."),
      "",
      "**After**",
      renderSideText(scope.modified, "pseudocode", "Not present in this version."),
      "",
      "</details>"
    ] : []),
    ...(hasFlowchart ? [
      "",
      "<details>",
      "<summary>Flowchart</summary>",
      "",
      "**Before**",
      renderFlowchartSide(scope.original),
      "",
      "**After**",
      renderFlowchartSide(scope.modified),
      "",
      "</details>"
    ] : [])
  ];
  return sections.join("\n");
}

function fileSections(file: ReviewExportFile): Omit<ReviewPublicationFile, "path"> {
  const record = file.comparison!;
  const comparison = record.comparison;
  const scopes = comparison.visualScopes ?? [];
  const entries = record.catalogue?.entries ?? [];
  const identity = (entry: ComparisonCatalogueEntry) =>
    JSON.stringify([entry.kind, entry.name, (entry.modified ?? entry.original)?.signature]);
  const groups = entries.flatMap((entry) => {
    const changes = comparison.changes.filter((change) => change.functionId === entry.id);
    const visuals = scopes.filter((scope) => scope.functionId === entry.id);
    const summary = entry.category === "changed" ? undefined :
      comparison[entry.category]?.find((item) => item.functionId === entry.id)?.summary;
    if (!changes.length && !visuals.length && !summary) return [];
    const ranges = sourceRanges(record, entry);
    const body = [
      `### ${codeSpan(entry.name)}`,
      `**${entry.category === "added" ? "Added" : entry.category === "removed" ? "Removed" : "Changed"} ${renderReviewPublicationText(entry.kind)}**` +
        (ranges ? ` — ${ranges}.` : ""),
      ...(summary ? [renderReviewPublicationText(summary)] : []),
      executionBody(record, changes, visuals)
    ].filter(Boolean).join("\n\n");
    const key = identity(entry);
    return [{
      id: entry.id, identity: entries.filter((other) => identity(other) === key).length === 1 ? key : JSON.stringify([key, entry.id]),
      category: entry.category, body, original: functionRange(record, entry, "original"), modified: functionRange(record, entry, "modified")
    }];
  });
  const knownIds = new Set(entries.map((entry) => entry.id));
  const unassigned = [
    ...(["added", "removed"] as const).flatMap((category) =>
      (comparison[category] ?? []).filter((item) => !knownIds.has(item.functionId)).map((item) =>
        `**${category === "added" ? "Added" : "Removed"} function (name unavailable):** ${renderReviewPublicationText(item.summary)}`)),
    executionBody(record,
      comparison.changes.filter((change) => !change.functionId || !knownIds.has(change.functionId)),
      scopes.filter((scope) => !scope.functionId || !knownIds.has(scope.functionId)))
  ].filter(Boolean).join("\n\n");
  const intro = [
    renderReviewPublicationText(comparison.summary) || "Saved comparison",
    ...(file.status === "low-value" ? ["_Low-value file; excluded from summary evidence._"] : [])
  ];
  const remainder = [
    ...(unassigned ? ["### Changes without a recorded function\n\n" + unassigned] : []),
    ...(comparison.outside ? ["### Other\n\n" + renderReviewPublicationText(comparison.outside)] : []),
    ...(comparison.possibleEffects.length ? ["### Possible effects\n\n" + bulletList(comparison.possibleEffects)] : [])
  ];
  return {
    body: [...intro, ...groups.map((group) => group.body), ...remainder].join("\n\n"),
    overview: [...intro, ...remainder].join("\n\n"),
    functions: groups
  };
}

function assertBodySize(body: string, label: string): void {
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(
      `Review publication ${label} is ${bytes} UTF-8 bytes; the limit is ${MAX_BODY_BYTES}. ` +
      "Reduce the saved review detail before publishing."
    );
  }
}

/** Renders a deterministic, inert GitHub PR publication from saved review data only. */
export function renderReviewPublication(data: ReviewExportData): ReviewPublication {
  const summary = summaryBody(data);
  assertBodySize(summary, "summary");
  const files = data.files
    .filter((file) => file.comparison && (file.status === "current" || file.status === "low-value"))
    .map((file) => {
      const path = file.path;
      const sections = fileSections(file);
      assertBodySize(sections.overview, `file ${path}`);
      for (const group of sections.functions) assertBodySize(group.body, `function in ${path}`);
      return { path, ...sections };
    });
  return { summary, files };
}
