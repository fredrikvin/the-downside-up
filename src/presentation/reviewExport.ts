import type {
  ComparisonRecord,
  ReviewSummaryCoverage,
  ReviewSummaryEvidence,
  ReviewSummaryRecord
} from "../core/types";

export interface ReviewExportFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "current" | "low-value" | "missing" | "outdated" | "unavailable";
  readonly reason?: string;
  readonly comparison?: ComparisonRecord;
}

export interface ReviewExportData {
  readonly kind: "working" | "commit";
  readonly base: string;
  readonly head?: string;
  readonly commit?: string;
  readonly parent?: string;
  readonly summary: ReviewSummaryRecord;
  readonly coverage: ReviewSummaryCoverage;
  readonly evidence: readonly ReviewSummaryEvidence[];
  readonly files: readonly ReviewExportFile[];
  readonly exportedAt: number;
}

const markdownText = (value: string): string => {
  const visible = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...visible].map((character) => {
    if (character === "&") return "&amp;";
    if (/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(character)) {
      return `&#${character.codePointAt(0)};`;
    }
    return character;
  }).join("");
};

const htmlText = (value: string, singleLine = false): string => {
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(singleLine ? /[\r\n]+/g : /$^/, " ");
  return [...clean].map((character) => {
    if (character === "&") return "&amp;";
    if (/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(character)) {
      return `&#${character.codePointAt(0)};`;
    }
    return character;
  }).join("");
};

const codeBlock = (lines: readonly string[]): string =>
  `<pre><code>${htmlText(lines.join("\n"))}</code></pre>`;

const pathFor = (file: Pick<ReviewExportFile, "path" | "oldPath">): string =>
  file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;

const list = (values: readonly string[]): string =>
  values.length ? values.map((value) => `- ${markdownText(value)}`).join("\n") : "- None recorded";

function mermaidLabel(value: string, fallback: string): string {
  const label = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/[^A-Za-z0-9 _.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return label || fallback;
}

function renderDiagram(record: ReviewSummaryRecord, evidence: readonly ReviewSummaryEvidence[]): string {
  const diagram = record.value.diagram;
  if (!diagram) return "";
  const paths = new Map(evidence.map((entry) => [entry.id, entry.path]));
  const ids = new Map(diagram.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["```mermaid", "flowchart LR"];
  for (const [index, node] of diagram.nodes.entries()) {
    const referenced = node.fileIds.map((id) => paths.get(id)).filter((path): path is string => Boolean(path));
    const suffix = referenced.length ? ` (${referenced.join(", ")})` : "";
    const label = mermaidLabel(`${node.label}${suffix}`, `Part ${index + 1}`);
    lines.push(`  n${index}["${label}"]`);
  }
  for (const edge of diagram.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from && to) lines.push(`  ${from} -->|${mermaidLabel(edge.label, "related")}| ${to}`);
  }
  lines.push("```");
  return lines.join("\n");
}

function evidencePaths(ids: readonly string[], evidence: readonly ReviewSummaryEvidence[]): string[] {
  const paths = new Map(evidence.map((entry) => [entry.id, entry.path]));
  return ids.map((id) => paths.get(id)).filter((path): path is string => Boolean(path));
}

function renderFile(file: ReviewExportFile): string {
  const record = file.comparison;
  if (!record) return "";
  const comparison = record.comparison;
  const headings = [
    `### ${markdownText(comparison.summary)}`,
    file.status === "low-value" ? "_Low-value file; excluded from summary evidence._" : "",
    `- Functions model: ${markdownText(record.model)} (${markdownText(record.provider)})`,
    `- Prompt: ${markdownText(record.promptVersion)}`,
    `- Explanation generated: ${markdownText(new Date(record.savedAt).toISOString())}`,
    "#### Added functions",
    list((comparison.added ?? []).map((entry) => {
      const name = record.catalogue?.entries.find((item) => item.id === entry.functionId && item.category === "added")?.name ?? entry.functionId;
      return `${name}: ${entry.summary}`;
    })),
    "#### Removed functions",
    list((comparison.removed ?? []).map((entry) => {
      const name = record.catalogue?.entries.find((item) => item.id === entry.functionId && item.category === "removed")?.name ?? entry.functionId;
      return `${name}: ${entry.summary}`;
    })),
    "#### Changed behavior",
    list(comparison.changes.map((change) => [
      change.title,
      change.before && `Before: ${change.before}`,
      change.after && `After: ${change.after}`,
      change.when && `When: ${change.when}`,
      change.flow && `Flow: ${change.flow}`
    ].filter(Boolean).join(" "))),
    "#### Other changes",
    list(comparison.outside ? [comparison.outside] : []),
    "#### Possible effects",
    list(comparison.possibleEffects),
    "#### Limitations",
    list(comparison.limitations),
    "#### Saved steps and pseudocode"
  ].filter(Boolean);
  for (const scope of comparison.visualScopes ?? []) {
    headings.push(`##### ${markdownText(scope.title)}`);
    for (const [sideName, side] of [["Before", scope.original], ["After", scope.modified]] as const) {
      if (side.steps.length) {
        headings.push(`###### ${sideName} steps`);
        headings.push(codeBlock(side.steps.map((item) => item.text)));
      }
      if (side.pseudocode.length) {
        headings.push(`###### ${sideName} pseudocode`);
        headings.push(codeBlock(side.pseudocode.map((item) => `${"  ".repeat(item.depth ?? 0)}${item.text}`)));
      }
    }
  }
  if (!(comparison.visualScopes ?? []).some((scope) =>
    scope.original.steps.length || scope.original.pseudocode.length ||
    scope.modified.steps.length || scope.modified.pseudocode.length)) {
    headings.push("No saved steps or pseudocode.");
  }
  return [
    "<details>",
    `<summary>${htmlText(pathFor(file), true)}</summary>`,
    "",
    ...headings,
    "",
    "</details>"
  ].join("\n");
}

/** Renders validated cache data as inert Markdown; it performs no I/O. */
export function renderReviewExport(data: ReviewExportData): string {
  const { summary, coverage } = data;
  const provenance = data.kind === "commit"
    ? [`Commit: ${data.commit ?? data.base}`, `Parent: ${data.parent ?? "none (root commit)"}`]
    : [`Base: ${data.base}`, `HEAD: ${data.head ?? "unknown"}`];
  const themes = summary.value.themes.map((theme) => [
    `### ${markdownText(theme.title)}`,
    markdownText(theme.text),
    `Files: ${evidencePaths(theme.fileIds, data.evidence).map(markdownText).join(", ") || "none"}`
  ].join("\n\n"));
  const unavailable = data.files
    .filter((file) => file.status !== "current" && file.status !== "low-value" || !file.comparison)
    .map((file) => `${pathFor(file)}: ${file.reason ?? file.status}`);
  const currentFiles = data.files.filter((file) => file.comparison &&
    (file.status === "current" || file.status === "low-value"));
  const generatedAt = new Date(summary.savedAt).toISOString();
  const exportedAt = new Date(data.exportedAt).toISOString();
  const sections = [
    "# Review summary export",
    "",
    ...provenance.map((line) => `- ${markdownText(line)}`),
    `- Overview model: ${markdownText(summary.model)} (${markdownText(summary.provider)})`,
    `- Prompt: ${markdownText(summary.promptVersion)}`,
    `- Summary generated: ${markdownText(generatedAt)}`,
    `- Exported: ${markdownText(exportedAt)}`,
    "",
    "## Summary",
    markdownText(summary.value.summary),
    "",
    "## Summary evidence",
    list(data.evidence.map((entry) => entry.path)),
    "",
    "## Themes",
    ...(themes.length ? themes : ["No themes recorded."]),
    "",
    ...(summary.value.diagram ? ["## Affected parts", renderDiagram(summary, data.evidence), ""] : []),
    "## Possible effects",
    list(summary.value.possibleEffects),
    "",
    "## Coverage",
    `- Confirmed files: ${coverage.total}`,
    `- Included as summary evidence: ${coverage.included}`,
    `- Unavailable: ${coverage.unavailable}`,
    `- Omitted for budget: ${coverage.omitted}`,
    `- Low-value: ${coverage.lowValue}`,
    "",
    "## Limitations",
    list(summary.value.limitations),
    "",
    "## Saved file explanations",
    ...(currentFiles.map(renderFile).filter(Boolean).flatMap((rendered) => [rendered, ""])),
    "## Files without a current explanation",
    list(unavailable)
  ];
  return sections.join("\n").trimEnd() + "\n";
}
