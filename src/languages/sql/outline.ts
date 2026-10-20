import { boundedDocumentation, commentDraft, type OutlineEntryDraft } from "../../context/outlineModel";
import { describe, type Description } from "../../context/outlineText";
import type { SourceDescription } from "../support";
import { lexSql, sqlPosition, word } from "./lexer";
import { explainableSql, sqlDefinitions, sqlStatements, sqlName, type SqlDefinition } from "./syntax";
import { sqlSchemaDetails } from "./schema";

function queryNotes(entry: SqlDefinition, definitions: readonly SqlDefinition[]): Description[] {
  const notes: Description[] = [];
  const cardinality: Record<string, string> = {
    ":one": "Returns one row.", ":many": "Returns multiple rows.",
    ":exec": "Executes without returning rows.", ":execrows": "Returns the number of affected rows.",
    ":execresult": "Returns execution metadata.", ":copyfrom": "Copies multiple input rows."
  };
  if (entry.annotation) notes.push([{ text: cardinality[entry.annotation] ?? `Query mode: ${entry.annotation}.` }]);
  const parameters = new Set<string>();
  const relations = new Set<string>();
  const tokens = entry.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "$" && tokens[i + 1]?.kind === "number") parameters.add(`$${tokens[i + 1]!.text}`);
    if (token.text === "@" && tokens[i + 1]?.kind === "word") parameters.add(`@${tokens[i + 1]!.text}`);
    if (word(token, "sqlc") && tokens[i + 1]?.text === "." &&
        (word(tokens[i + 2], "arg") || word(tokens[i + 2], "narg")) && tokens[i + 3]?.text === "(") {
      const parameter = tokens[i + 4];
      if (parameter) parameters.add(parameter.kind === "string" ? parameter.text.slice(1, -1) : parameter.text);
    }
    if (["from", "join", "update", "into"].some((key) => word(token, key))) {
      const name = sqlName(tokens, i + 1);
      if (!name || relations.has(name.qualified)) continue;
      relations.add(name.qualified);
      const targets = definitions.filter((candidate) => ["table", "view"].includes(candidate.kind) &&
        (name.parts.length > 1 ? JSON.stringify(name.parts) === JSON.stringify(candidate.name.parts) : name.parts[0] === candidate.name.parts.at(-1)));
      notes.push([
        { text: "Uses " }, { text: name.qualified, code: true, ...(targets.length === 1 ? { target: targets[0]!.qualifiedName } : {}) }, { text: "." }
      ]);
    }
  }
  if (parameters.size) notes.unshift([{ text: `Inputs: ${[...parameters].join(", ")}.` }]);
  return notes;
}

function queryDescription(entry: SqlDefinition): string {
  const actions: Record<string, string> = {
    select: "reads matching rows", insert: "adds rows", update: "changes matching rows",
    delete: "removes matching rows", merge: "merges rows", values: "returns the listed values",
    call: "calls a database routine", exec: "executes a database routine", execute: "executes database logic"
  };
  let depth = 0;
  for (const token of entry.tokens) {
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    const action = token.kind === "word" ? actions[token.text.toLowerCase()] : undefined;
    if (depth === 0 && action) return ` ${action}.`;
  }
  return " defines a database query.";
}

export async function describeSqlSource(source: string): Promise<SourceDescription> {
  const drafts: OutlineEntryDraft[] = [];
  const lines = source.split(/\r?\n/);
  const definitions = sqlDefinitions(source);
  const statements = sqlStatements(source);
  const comments = lexSql(source).filter((token) => token.kind === "comment");
  const commentText = (text: string) => text.replace(/^--\s?|^#\s?|^\/\*+\s?|\s*\*\/$/g, "").trim();
  const leading = comments.filter((token) => token.start < (definitions[0]?.start ?? source.length) &&
    !source.slice(0, token.start).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim());
  const used = new Set(leading);
  for (const entry of definitions.slice(0, 500)) {
    const name = sqlPosition(source, entry.name.start);
    const end = sqlPosition(source, entry.name.end);
    const attached = comments.filter((token) => token.end <= entry.start && !source.slice(token.end, entry.start).trim() && !used.has(token));
    attached.forEach((token) => used.add(token));
    const kindLabel = entry.kind[0]!.toUpperCase() + entry.kind.slice(1);
    const schemaObject = ["table", "type", "index", "sequence", "extension"].includes(entry.kind);
    const details = schemaObject ? sqlSchemaDetails(source, entry, definitions, statements) : undefined;
    drafts.push({
      kind: schemaObject ? "type" : "function", kindLabel,
      name: entry.name.name, qualifiedName: entry.qualifiedName, depth: 0,
      startLine: entry.startLine, endLine: entry.endLine,
      nameLine: name.line, nameStart: name.character,
      nameEnd: end.line === name.line ? end.character : (lines[name.line]?.length ?? name.character),
      description: describe().text(`${kindLabel} `).code(entry.name.qualified).text(
        entry.kind === "view" ? " defines a saved query." :
        entry.kind === "trigger" ? " runs when its configured database event occurs." :
        entry.kind === "table" ? ` stores rows in ${details?.columns.length ?? 0} columns.` :
        entry.kind === "query" ? queryDescription(entry) :
        ["function", "procedure"].includes(entry.kind) ? " defines database logic." : " defines a database object."
      ).build(),
      documentation: boundedDocumentation(attached.map((token) => commentText(token.text))),
      notes: entry.kind === "query" ? queryNotes(entry, definitions) : details?.notes ?? [],
      explainable: explainableSql(entry), alwaysVisible: true,
      showCallers: ["function", "procedure"].includes(entry.kind),
      ...(details?.columns.length ? {
        previewTable: {
          headers: ["Column", "Type", "Required", "Default / rules"],
          rows: details.columns.map((column) => [
            [{ text: column.name.name, code: true, target: `${entry.qualifiedName}.${column.name.name}` }],
            [{ text: column.type, code: true, target: column.type }],
            [{ text: column.required ? "Yes" : "No" }],
            [{ text: [column.defaultValue ? `Default: ${column.defaultValue}` : "", column.details].filter(Boolean).join("; ") || "-" }]
          ])
        }
      } : {})
    });
    if (details) {
      for (const column of details.columns) {
        const position = sqlPosition(source, column.name.start);
        drafts.push({
          kind: "field", kindLabel: "Column", name: column.name.name,
          qualifiedName: `${entry.qualifiedName}.${column.name.name}`, depth: 1,
          startLine: position.line, endLine: position.line,
          nameLine: position.line, nameStart: position.character, nameEnd: position.character + column.name.name.length,
          description: describe().text("Column ").code(column.name.name).text(" (").code(column.type).text(").").build(),
          notes: [], explainable: false
        });
      }
    }
  }
  for (const token of comments) {
    if (used.has(token) || definitions.some((entry) => entry.start <= token.start && entry.end >= token.end)) continue;
    drafts.push(commentDraft(sqlPosition(source, token.start).line, sqlPosition(source, token.end).line, commentText(token.text), lines));
  }
  drafts.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);
  return { purpose: boundedDocumentation(leading.map((token) => commentText(token.text))), drafts: drafts.slice(0, 500) };
}
