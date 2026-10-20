import { Position, Range, type TextDocument } from "vscode";
import { cacheKey } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import type { FunctionSlice } from "../support";
import { lexSql, sqlFingerprint, sqlPosition, word, type SqlToken } from "./lexer";

export interface SqlName {
  readonly name: string;
  readonly qualified: string;
  readonly parts: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

export interface SqlDefinition {
  readonly kind: "function" | "procedure" | "trigger" | "view" | "table" | "type" | "index";
  readonly name: SqlName;
  readonly qualifiedName: string;
  readonly source: string;
  readonly signature: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokens: readonly SqlToken[];
  readonly body: readonly SqlToken[];
}

export const explainableSql = (entry: SqlDefinition): boolean =>
  ["function", "procedure", "trigger", "view"].includes(entry.kind);

export function sqlName(tokens: readonly SqlToken[], index: number): SqlName | undefined {
  const identifier = (token: SqlToken | undefined) => token?.closed && ["word", "identifier"].includes(token.kind);
  if (!identifier(tokens[index])) return undefined;
  const first = tokens[index]!;
  const names: string[] = [];
  const parts: string[] = [];
  let last = first;
  do {
    last = tokens[index++]!;
    names.push(last.text);
    parts.push(last.kind === "word" ? last.text.toLowerCase() :
      last.text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`").replace(/]]/g, "]"));
    if (tokens[index]?.text !== "." || !identifier(tokens[index + 1])) break;
    index++;
  } while (true);
  return { name: names.at(-1)!, qualified: names.join("."), parts, start: first.start, end: last.end, next: index };
}

export function sqlStatements(source: string): SqlToken[][] {
  const tokens = lexSql(source).filter((token) => token.kind !== "comment" || !token.closed);
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let parentheses = 0;
  const blocks: string[] = [];
  const go = (token: SqlToken) => word(token, "go") &&
    /^\s*GO\s*(?:--.*)?$/i.test(source.slice(source.lastIndexOf("\n", token.start - 1) + 1,
      source.indexOf("\n", token.end) < 0 ? source.length : source.indexOf("\n", token.end)));
  const tsql = tokens.some(go) ||
    tokens.some((token, index) => word(token, "create") && word(tokens[index + 1], "or") && word(tokens[index + 2], "alter"));
  const flush = () => {
    if (current.length) statements.push(current);
    current = []; parentheses = 0; blocks.length = 0;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "directive" || token.kind === "terminator" || go(token)) {
      flush(); continue;
    }
    const routine = current.slice(0, 24).some((entry) => ["function", "procedure", "trigger"].some((kind) => word(entry, kind))) &&
      word(current[0], "create");
    if (word(token, "create") && parentheses === 0 && blocks.length === 0 && current.length && !(routine && tsql)) flush();
    current.push(token);
    if (token.text === "(") parentheses++;
    if (token.text === ")") parentheses = Math.max(0, parentheses - 1);
    if (routine && token.kind === "word") {
      if ((word(token, "begin") || word(token, "case")) && !word(tokens[i - 1], "end")) blocks.push(token.text.toLowerCase());
      if (word(token, "end") && !["if", "loop", "while", "repeat"].some((kind) => word(tokens[i + 1], kind))) blocks.pop();
    }
    if (token.text === ";" && parentheses === 0 && blocks.length === 0 && !(routine && tsql)) flush();
  }
  flush();
  return statements;
}

function argumentTypes(tokens: readonly SqlToken[], index: number): string | undefined {
  if (tokens[index]?.text !== "(") return undefined;
  const args: SqlToken[][] = [[]];
  let depth = 0;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === ")" && depth === 0) break;
    if (token.text === "," && depth === 0) { args.push([]); continue; }
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    args.at(-1)!.push(token);
  }
  const types = args.filter((arg) => arg.length).map((arg) => {
    let entries = arg.filter((token) => !["in", "out", "inout", "variadic"].some((mode) => word(token, mode)));
    const defaultIndex = entries.findIndex((token) => word(token, "default") || token.text === "=");
    if (defaultIndex >= 0) entries = entries.slice(0, defaultIndex);
    // Multiword built-in types are types without an argument name.
    if (entries.length > 1 && ["word", "identifier"].includes(entries[1]!.kind) &&
        !["double", "character", "timestamp", "time", "national", "bit"].some((type) => word(entries[0], type))) entries = entries.slice(1);
    return entries.map((token) => token.kind === "word" ? token.text.toLowerCase() : token.text).join(" ");
  });
  return `(${types.join(", ")})`;
}

export function sqlDefinitions(source: string): SqlDefinition[] {
  const definitions: SqlDefinition[] = [];
  for (const tokens of sqlStatements(source)) {
    if (!word(tokens[0], "create") || tokens.some((token) => !token.closed)) continue;
    let index = 1;
    if (word(tokens[index], "or") && (word(tokens[index + 1], "replace") || word(tokens[index + 1], "alter"))) index += 2;
    while (["temporary", "temp", "unlogged", "unique", "materialized"].some((modifier) => word(tokens[index], modifier))) index++;
    if (word(tokens[index], "definer")) {
      while (index < Math.min(tokens.length, 24) && !word(tokens[index], "function") && !word(tokens[index], "procedure") && !word(tokens[index], "trigger")) index++;
    }
    const kind = tokens[index]?.text.toLowerCase();
    if (!kind || !["function", "procedure", "trigger", "view", "table", "type", "index"].includes(kind)) continue;
    index++;
    if (word(tokens[index], "if") && word(tokens[index + 1], "not") && word(tokens[index + 2], "exists")) index += 3;
    const name = sqlName(tokens, index);
    if (!name) continue;
    const definitionKind = kind as SqlDefinition["kind"];
    let depth = 0;
    let bodyIndex = tokens.length;
    for (let i = name.next; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.text === "(") depth++;
      if (token.text === ")") depth--;
      const statementBody = ["function", "procedure"].includes(kind) &&
        ["select", "insert", "update", "delete", "call", "with"].some((key) => word(token, key)) ||
        kind === "trigger" && word(token, "set") && word(tokens[i - 1], "row");
      if (depth === 0 && (word(token, "as") || word(token, "begin") || word(token, "return") || word(token, "execute") || statementBody)) {
        bodyIndex = i;
        break;
      }
    }
    const start = tokens[0]!.start;
    const end = tokens.at(-1)!.end;
    const signatureEnd = tokens[bodyIndex]?.start ?? end;
    const overload = ["function", "procedure"].includes(kind) ? argumentTypes(tokens, name.next) : undefined;
    definitions.push({
      kind: definitionKind, name, qualifiedName: name.qualified + (overload ?? ""),
      source: source.slice(start, end), signature: source.slice(start, signatureEnd).trimEnd(),
      start, end, startLine: sqlPosition(source, start).line, endLine: sqlPosition(source, end).line,
      tokens, body: tokens.slice(bodyIndex)
    });
  }
  return definitions;
}

export async function listSqlFunctions(source: string): Promise<FunctionSlice[]> {
  return sqlDefinitions(source).filter(explainableSql).map((entry) => ({
    name: entry.name.name, qualifiedName: entry.qualifiedName, signature: entry.signature,
    source: entry.source, startLine: entry.startLine, endLine: entry.endLine,
    fingerprint: sqlFingerprint(entry.source)
  }));
}

export async function findSqlFunction(document: TextDocument, position: Position): Promise<FunctionTarget | undefined> {
  const source = document.getText();
  const at = (offset: number) => {
    const result = sqlPosition(source, offset);
    return new Position(result.line, result.character);
  };
  const found = sqlDefinitions(source).filter(explainableSql).find((entry) =>
    new Range(at(entry.start), at(entry.end)).contains(position));
  if (!found) return undefined;
  return {
    uri: document.uri, range: new Range(at(found.start), at(found.end)),
    selection: new Range(at(found.name.start), at(found.name.end)),
    languageId: "sql", name: found.name.name, qualifiedName: found.qualifiedName,
    signature: found.signature, source: found.source,
    symbolId: cacheKey(["sql-lexer-v1", document.uri.path, found.kind, found.qualifiedName]),
    structuralFingerprint: sqlFingerprint(found.source), analysis: "sql-lexer"
  };
}

export function sqlPreamble(source: string, before = source.length): string {
  return sqlStatements(source).filter((tokens) => tokens[0]!.start < before &&
    (word(tokens[0], "use") || word(tokens[0], "set") && word(tokens[1], "search_path")))
    .slice(-40).map((tokens) => source.slice(tokens[0]!.start, tokens.at(-1)!.end)).join("\n");
}
