import type { Description } from "../../context/outlineText";
import { describe } from "../../context/outlineText";
import { word, type SqlToken } from "./lexer";
import { sqlName, sqlStatements, type SqlDefinition, type SqlName } from "./syntax";

export interface SqlColumn {
  readonly name: SqlName;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: string;
  readonly details: string;
}

export interface SqlSchemaDetails {
  readonly columns: readonly SqlColumn[];
  readonly notes: readonly Description[];
  /** Separate statements belonging to this object, retained verbatim for context/tracking. */
  readonly supplements: string;
  readonly tokens: readonly SqlToken[];
}

export function sqlGroups(tokens: readonly SqlToken[]): SqlToken[][] {
  const groups: SqlToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    if (token.text === "," && depth === 0) groups.push([]);
    else groups.at(-1)!.push(token);
  }
  return groups.filter((group) => group.length);
}

function insideGroup(tokens: readonly SqlToken[], start: number): SqlToken[] {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i]!.text === "(") depth++;
    if (tokens[i]!.text === ")" && --depth === 0) return tokens.slice(start + 1, i);
  }
  return [];
}

function sameName(left: SqlName, right: SqlName, definitions: readonly SqlDefinition[]): boolean {
  if (left.parts.length > 1) return JSON.stringify(left.parts) === JSON.stringify(right.parts);
  return left.parts[0] === right.parts.at(-1) &&
    definitions.filter((entry) => entry.kind === "table" && entry.name.parts.at(-1) === left.parts[0]).length === 1;
}

function sourceOf(source: string, tokens: readonly SqlToken[]): string {
  return tokens.length ? source.slice(tokens[0]!.start, tokens.at(-1)!.end).trim().replace(/;$/, "") : "";
}

export function sqlSchemaDetails(
  source: string, entry: SqlDefinition, definitions: readonly SqlDefinition[], statements = sqlStatements(source)
): SqlSchemaDetails {
  const related = statements.filter((tokens) => {
    if (tokens[0]?.start === entry.start) return false;
    if (word(tokens[0], "alter") && word(tokens[1], "table")) {
      const name = sqlName(tokens, word(tokens[2], "only") ? 3 : 2);
      return entry.kind === "table" && name !== undefined && sameName(name, entry.name, definitions);
    }
    if (word(tokens[0], "create") && entry.kind === "table" &&
        (word(tokens[1], "index") || word(tokens[1], "unique") && word(tokens[2], "index"))) {
      const name = sqlName(tokens, tokens.findIndex((token) => word(token, "on")) + 1);
      return name !== undefined && sameName(name, entry.name, definitions);
    }
    if (word(tokens[0], "comment") && word(tokens[1], "on") && word(tokens[2], entry.kind)) {
      const name = sqlName(tokens, 3);
      return name !== undefined && JSON.stringify(name.parts) === JSON.stringify(entry.name.parts);
    }
    return false;
  });
  const notes: Description[] = [];
  const text = (value: string) => notes.push([{ text: value }]);
  const keys = new Map<string, string[]>();
  const required = new Set<string>();
  const defaults = new Map<string, string>();
  const columns: SqlColumn[] = [];
  const chunks: SqlToken[][] = [];
  if (entry.kind === "table") {
    const open = entry.tokens.findIndex((token, index) => index >= entry.name.next && token.text === "(");
    if (open >= 0) chunks.push(...sqlGroups(insideGroup(entry.tokens, open)));
  }
  chunks.push(...related.filter((tokens) => word(tokens[0], "alter")).map((tokens) => [...tokens]));
  const recordKey = (name: string, value: string) => keys.set(name, [...(keys.get(name) ?? []), value]);
  const constraint = (tokens: readonly SqlToken[], ownColumn?: SqlName) => {
    const primary = tokens.findIndex((token, index) => word(token, "primary") && word(tokens[index + 1], "key"));
    const unique = tokens.findIndex((token) => word(token, "unique"));
    const foreign = tokens.findIndex((token) => word(token, "foreign"));
    if (primary >= 0 || unique >= 0) {
      const at = primary >= 0 ? primary + 2 : unique + 1;
      const names = ownColumn ? [ownColumn] : sqlGroups(insideGroup(tokens, at)).flatMap((group) => {
        const name = sqlName(group, 0);
        return name ? [name] : [];
      });
      const label = primary >= 0 ? "Primary key" : "Unique";
      names.forEach((name) => {
        recordKey(name.parts[0]!, label.toLowerCase());
        if (primary >= 0) required.add(name.parts[0]!);
      });
      text(`${label}: ${names.map((name) => name.name).join(", ")}.`);
    }
    const referenceAt = tokens.findIndex((token) => word(token, "references"));
    const target = referenceAt < 0 ? undefined : sqlName(tokens, referenceAt + 1);
    if (target) {
      const sourceColumns = ownColumn ? ownColumn.name : foreign >= 0
        ? sourceOf(source, insideGroup(tokens, foreign + 2)) : "";
      const targetColumns = tokens[target.next]?.text === "(" ? sourceOf(source, insideGroup(tokens, target.next)) : "";
      const targets = definitions.filter((candidate) => candidate.kind === "table" && sameName(target, candidate.name, definitions));
      notes.push([
        { text: sourceColumns ? `Foreign key (${sourceColumns}) references ` : "References " },
        { text: target.qualified, code: true, ...(targets.length === 1 ? { target: targets[0]!.qualifiedName } : {}) },
        { text: `${targetColumns ? ` (${targetColumns})` : ""}.` }
      ]);
      const deleteAt = tokens.findIndex((token, index) => word(token, "on") && word(tokens[index + 1], "delete"));
      if (deleteAt >= 0) {
        const action = sourceOf(source, tokens.slice(deleteAt + 2, deleteAt + (word(tokens[deleteAt + 2], "set") || word(tokens[deleteAt + 2], "no") ? 4 : 3)));
        text(`On delete: ${action.toLowerCase()}.`);
      }
      if (ownColumn) recordKey(ownColumn.parts[0]!, `references ${target.qualified}${targetColumns ? ` (${targetColumns})` : ""}`);
    }
    const check = tokens.findIndex((token) => word(token, "check"));
    if (check >= 0) text(`Check: ${sourceOf(source, tokens.slice(check + 1))}.`);
  };
  for (const tokens of chunks) {
    const isAlter = word(tokens[0], "alter");
    const name = sqlName(tokens, 0);
    const isColumn = !isAlter && name && !["constraint", "primary", "foreign", "unique", "check", "exclude", "like"].some((key) => word(tokens[0], key));
    constraint(tokens, isColumn ? name : undefined);
    if (isAlter) {
      const at = tokens.findIndex((token) => word(token, "column"));
      const column = at < 0 ? undefined : sqlName(tokens, at + 1);
      const defaultAt = tokens.findIndex((token) => word(token, "default"));
      if (column && defaultAt >= 0) defaults.set(column.parts[0]!, sourceOf(source, tokens.slice(defaultAt + 1)));
      if (column && tokens.some((token, index) => word(token, "not") && word(tokens[index + 1], "null"))) required.add(column.parts[0]!);
    }
    if (!isColumn) continue;
    let depth = 0;
    const boundary = tokens.findIndex((token, index) => {
      if (token.text === "(") depth++;
      if (token.text === ")") depth--;
      return index >= name.next && depth === 0 && [
        "not", "null", "default", "generated", "primary", "unique", "references", "check", "constraint", "collate"
      ].some((key) => word(token, key));
    });
    const typeEnd = boundary < 0 ? tokens.length : boundary;
    const defaultAt = tokens.findIndex((token) => word(token, "default"));
    let defaultEnd = tokens.length;
    if (defaultAt >= 0) {
      depth = 0;
      for (let i = defaultAt + 1; i < tokens.length; i++) {
        if (tokens[i]!.text === "(") depth++;
        if (tokens[i]!.text === ")") depth--;
        if (depth === 0 && ["not", "constraint", "primary", "unique", "references", "check"].some((key) => word(tokens[i], key))) {
          defaultEnd = i; break;
        }
      }
    }
    const generatedAt = tokens.findIndex((token) => word(token, "generated"));
    columns.push({
      name, type: sourceOf(source, tokens.slice(name.next, typeEnd)),
      required: tokens.some((token, index) => word(token, "not") && word(tokens[index + 1], "null")),
      defaultValue: defaultAt < 0 ? "" : sourceOf(source, tokens.slice(defaultAt + 1, defaultEnd)),
      details: generatedAt < 0 ? "" : sourceOf(source, tokens.slice(generatedAt))
    });
  }
  for (const tokens of related) {
    if (word(tokens[0], "create")) text(`Index: ${sourceOf(source, tokens)}.`);
    if (word(tokens[0], "comment")) {
      const value = tokens.at(-2);
      if (value?.kind === "string") text(value.text.slice(1, -1).replace(/''/g, "'"));
    }
  }
  if (entry.kind === "type") {
    const enumAt = entry.tokens.findIndex((token) => word(token, "enum"));
    if (enumAt >= 0) text(`Allowed values: ${entry.tokens.slice(enumAt + 1).filter((token) => token.kind === "string").map((token) => token.text).join(", ")}.`);
  }
  if (entry.kind === "sequence") {
    notes.push(describe().text("Number generator: ").code(entry.source.slice(entry.signature.length) || entry.source).text(".").build());
  }
  if (entry.kind === "index") {
    const on = entry.tokens.findIndex((token) => word(token, "on"));
    const table = sqlName(entry.tokens, on + 1);
    if (table) {
      const targets = definitions.filter((candidate) => candidate.kind === "table" && sameName(table, candidate.name, definitions));
      notes.push([
        { text: entry.tokens.some((token) => word(token, "unique")) ? "Unique index on " : "Index on " },
        { text: table.qualified, code: true, ...(targets.length === 1 ? { target: targets[0]!.qualifiedName } : {}) },
        { text: "." }
      ]);
      const rest = entry.tokens.slice(table.next);
      notes.push([{ text: `Definition: ${sourceOf(source, rest)}.` }]);
    }
  }
  return {
    columns: columns.map((column) => ({
      ...column, required: column.required || required.has(column.name.parts[0]!),
      defaultValue: defaults.get(column.name.parts[0]!) ?? column.defaultValue,
      details: [column.details, ...(keys.get(column.name.parts[0]!) ?? [])].filter(Boolean).join("; ")
    })),
    notes, supplements: related.map((tokens) => source.slice(tokens[0]!.start, tokens.at(-1)!.end)).join("\n"),
    tokens: related.flat()
  };
}
