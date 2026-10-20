import { fingerprint } from "../../core/fingerprint";

export interface SqlToken {
  readonly kind: "word" | "number" | "identifier" | "string" | "dollar" | "comment" | "symbol" | "directive" | "terminator";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}

export const word = (token: SqlToken | undefined, value: string): boolean =>
  token?.kind === "word" && token.text.toLowerCase() === value;

export function lexSql(source: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let delimiter = ";";
  let i = 0;
  const push = (kind: SqlToken["kind"], start: number, closed = true) =>
    tokens.push({ kind, text: source.slice(start, i), start, end: i, closed });
  while (i < source.length) {
    if (/\s/.test(source[i]!)) { i++; continue; }
    const start = i;
    if (/^delimiter\b/i.test(source.slice(i, i + 10)) && !source.slice(source.lastIndexOf("\n", i - 1) + 1, i).trim()) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      const match = /^delimiter\s+(\S+)\s*$/i.exec(source.slice(start, i));
      if (match) { delimiter = match[1]!; push("directive", start); continue; }
      i = start;
    }
    if (source.startsWith("--", i) || source[i] === "#" && /\s/.test(source[i + 1] ?? "") &&
        !source.slice(source.lastIndexOf("\n", i - 1) + 1, i).trim()) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      push("comment", start);
    } else if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      push("comment", start, depth === 0);
    } else if (delimiter !== ";" && source.startsWith(delimiter, i)) {
      i += delimiter.length;
      push("terminator", start);
    } else if (source[i] === "'" || /^[eEnN]$/.test(source[i]!) && source[i + 1] === "'") {
      const escaped = delimiter !== ";" || source[i] !== "'" && source[i]!.toLowerCase() === "e";
      if (source[i] !== "'") i++;
      i++;
      let closed = false;
      while (i < source.length) {
        if (escaped && source[i] === "\\") { i = Math.min(i + 2, source.length); continue; }
        if (source[i++] === "'") {
          if (source[i] === "'") { i++; continue; }
          closed = true; break;
        }
      }
      push("string", start, closed);
    } else if (source[i] === '"' || source[i] === "`" || source[i] === "[") {
      const close = source[i] === "[" ? "]" : source[i]!;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i++] === close) {
          if (source[i] === close) { i++; continue; }
          closed = true; break;
        }
      }
      push("identifier", start, closed);
    } else if (source[i] === "$" && /^\$(?:[A-Za-z_][\w]*)?\$/.test(source.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(source.slice(i))![0];
      const end = source.indexOf(tag, i + tag.length);
      i = end < 0 ? source.length : end + tag.length;
      push("dollar", start, end >= 0);
    } else if (/\d/.test(source[i]!) || source[i] === "." && /\d/.test(source[i + 1] ?? "")) {
      const number = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source.slice(i))![0];
      i += number.length;
      push("number", start);
    } else if (/[A-Za-z_\u0080-\uffff]/.test(source[i]!) || source[i] === "#" && /[\w#]/.test(source[i + 1] ?? "")) {
      i++;
      while (i < source.length && /[\w$\u0080-\uffff]/.test(source[i]!) &&
        !(delimiter !== ";" && source.startsWith(delimiter, i))) i++;
      push("word", start);
    } else {
      i++;
      // Operator boundaries matter: `a > = b` must not fingerprint as `a >= b`.
      if (["::", ":=", ">=", "<=", "<>", "!=", "||", "&&", "->", "=>", "@@"].includes(source.slice(start, i + 1))) i++;
      push("symbol", start);
    }
  }
  return tokens;
}

export function dollarBody(token: SqlToken): string {
  const tag = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(token.text)?.[0] ?? "";
  return token.text.slice(tag.length, token.closed ? -tag.length : undefined);
}

export function sqlBodyLanguage(tokens: readonly SqlToken[]): string | undefined {
  const index = tokens.findIndex((token) => word(token, "language"));
  return index < 0 ? undefined : tokens[index + 1]?.text.replace(/^['"]|['"]$/g, "").toLowerCase();
}

export function sqlFingerprint(source: string): string {
  const tokens = lexSql(source);
  const bodies = new Set<SqlToken>();
  let statementStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === ";" || token.kind === "terminator" || token.kind === "directive") statementStart = i + 1;
    if (token.kind !== "dollar") continue;
    let previous = i - 1;
    while (tokens[previous]?.kind === "comment") previous--;
    if (!word(tokens[previous], "as")) continue;
    const header = tokens.slice(statementStart, i).filter((entry) => entry.kind !== "comment");
    if (!word(header.at(-1), "as") || !word(header[0], "create") ||
        !header.some((entry) => word(entry, "function") || word(entry, "procedure"))) continue;
    const end = tokens.findIndex((entry, index) => index > i && entry.text === ";");
    const language = sqlBodyLanguage(tokens.slice(statementStart, end < 0 ? undefined : end));
    if (!language || ["sql", "plpgsql"].includes(language)) bodies.add(token);
  }
  const normalize = (entries: readonly SqlToken[]): unknown[] => entries
    .filter((token) => token.kind !== "comment" || !token.closed || /^\/\*[!+]|^--\s*name:/i.test(token.text))
    .map((token) => token.closed && bodies.has(token)
      ? ["body", normalize(lexSql(dollarBody(token)))]
      : [token.kind, token.kind === "word" ? token.text.toLowerCase() : token.text, token.closed]);
  return fingerprint(JSON.stringify(normalize(tokens)));
}

export function sqlPosition(source: string, offset: number): { line: number; character: number } {
  const before = source.slice(0, offset);
  return { line: (before.match(/\n/g) ?? []).length, character: offset - (before.lastIndexOf("\n") + 1) };
}
