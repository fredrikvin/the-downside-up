import type { Dependency, DependencyItem, DependencyRequest, DependencyResult } from "../support";
import { dollarBody, lexSql, sqlBodyLanguage, sqlFingerprint, word, type SqlToken } from "./lexer";
import { sqlDefinitions, sqlName, sqlPreamble, type SqlDefinition, type SqlName } from "./syntax";

interface Reference {
  readonly name: SqlName;
  readonly call: boolean;
}

const NON_CALLS = new Set([
  "as", "in", "not", "exists", "select", "from", "where", "on", "over", "filter",
  "values", "table", "returns", "return", "if", "while", "case", "when", "then",
  "and", "or", "using", "with", "recursive", "partition", "order", "group",
  "cast", "extract", "substring", "trim", "coalesce", "nullif", "greatest", "least",
  "count", "sum", "avg", "min", "max", "row_number", "rank", "dense_rank"
]);

function cteNames(tokens: readonly SqlToken[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!word(tokens[i], "with")) continue;
    let index = i + (word(tokens[i + 1], "recursive") ? 2 : 1);
    while (index < tokens.length) {
      const name = sqlName(tokens, index);
      if (!name || name.parts.length !== 1) break;
      index = name.next;
      const skipGroup = () => {
        let depth = 0;
        do {
          if (tokens[index]?.text === "(") depth++;
          if (tokens[index]?.text === ")") depth--;
          index++;
        } while (index < tokens.length && depth);
      };
      if (tokens[index]?.text === "(") skipGroup();
      if (!word(tokens[index], "as")) break;
      index++;
      if (word(tokens[index], "not")) index++;
      if (word(tokens[index], "materialized")) index++;
      if (tokens[index]?.text !== "(") break;
      names.add(name.parts[0]!);
      skipGroup();
      if (tokens[index]?.text !== ",") break;
      index++;
    }
  }
  return names;
}

function references(entry: SqlDefinition, direct: boolean): { refs: Reference[]; dynamic: boolean } {
  const language = sqlBodyLanguage(entry.tokens);
  const bodyTokens = entry.body.flatMap((token) => token.kind === "dollar" && (!language || ["sql", "plpgsql"].includes(language))
    ? lexSql(dollarBody(token)) : [token]).filter((token) => token.kind !== "comment");
  // A trigger's ON relation is in its header, not its body.
  const tokens = entry.kind === "trigger" ? [
    ...entry.tokens.slice(0, entry.tokens.length - entry.body.length), ...bodyTokens
  ] : bodyTokens;
  const ctes = cteNames(tokens);
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const add = (name: SqlName | undefined, call: boolean) => {
    if (!name || !call && name.parts.length === 1 && ctes.has(name.parts[0]!)) return;
    const key = `${call}:${JSON.stringify(name.parts)}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ name, call });
  };
  let dynamic = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (word(token, "execute") || word(token, "exec")) {
      const next = tokens[i + 1];
      if (next?.kind === "string" || next?.kind === "dollar" || next?.text === "(") dynamic = true;
    }
    const relation = ["from", "join", "into", "update"].some((keyword) => word(token, keyword)) ||
      entry.kind === "trigger" && word(token, "on");
    if (!direct && relation) {
      let index = i + 1;
      if (word(tokens[index], "only")) index++;
      const name = sqlName(tokens, index);
      add(name, name !== undefined && (word(token, "from") || word(token, "join")) && tokens[name.next]?.text === "(");
      // SQL's comma-separated FROM list, including aliases.
      if (word(token, "from") && name) {
        index = name.next;
        while (index < tokens.length) {
          if (word(tokens[index], "as")) index += 2;
          else if (tokens[index]?.kind === "identifier" || tokens[index]?.kind === "word" &&
            !["where", "join", "left", "right", "inner", "outer", "full", "cross", "group", "order", "limit", "having", "union", "on", "returning"].some((key) => word(tokens[index], key))) index++;
          if (tokens[index]?.text !== ",") break;
          const next = sqlName(tokens, index + 1);
          if (!next) break;
          add(next, tokens[next.next]?.text === "(");
          index = next.next;
        }
      }
    }
    if (["call", "exec", "execute", "perform"].some((keyword) => word(token, keyword))) {
      let index = i + 1;
      if (language === "plpgsql" && word(token, "execute") &&
          !word(tokens[index], "function") && !word(tokens[index], "procedure")) {
        dynamic = true;
        continue;
      }
      if (word(tokens[index], "function") || word(tokens[index], "procedure")) index++;
      // EXEC @result = proc ... is statically named; EXEC @variable is not.
      if (tokens[index]?.text === "@") {
        if (tokens[index + 2]?.text === "=") index += 3;
        else { dynamic = true; continue; }
      }
      if (!word(tokens[index], "immediate")) add(sqlName(tokens, index), true);
      else dynamic = true;
    }
    if (i > 0 && tokens[i - 1]?.text === ".") continue;
    const name = sqlName(tokens, i);
    if (name && tokens[name.next]?.text === "(" && !word(tokens[i - 1], "into") &&
        !(name.parts.length === 1 && token.kind === "word" && NON_CALLS.has(name.parts[0]!))) add(name, true);
    if (!direct && token.text === "::") add(sqlName(tokens, i + 1), false);
  }
  return { refs, dynamic };
}

function itemOf(entry: SqlDefinition): DependencyItem {
  return {
    kind: ["function", "procedure"].includes(entry.kind) ? "function" : entry.kind,
    label: `${entry.kind} ${entry.qualifiedName}`,
    name: entry.name.name, qualifiedName: entry.qualifiedName, line: entry.startLine,
    source: entry.source, signature: entry.signature,
    fingerprint: sqlFingerprint(entry.source), signatureFingerprint: sqlFingerprint(entry.signature)
  };
}

function searchSchemas(preamble: string): string[] {
  let schemas: string[] = [];
  for (const tokens of sqlPreambleStatements(preamble)) {
    if (word(tokens[0], "use")) schemas = sqlName(tokens, 1)?.parts.slice() ?? [];
    if (word(tokens[0], "set") && word(tokens[1], "search_path")) {
      schemas = tokens.slice(2).flatMap((token) => {
        if (["to", "default"].some((key) => word(token, key))) return [];
        const name = sqlName([token], 0);
        return name?.parts ?? [];
      });
    }
  }
  return schemas;
}

function sqlPreambleStatements(source: string): SqlToken[][] {
  const statements: SqlToken[][] = [[]];
  for (const token of lexSql(source)) {
    if (token.kind === "comment") continue;
    if (token.text === ";") statements.push([]);
    else statements.at(-1)!.push(token);
  }
  return statements;
}

export async function findSqlDependencies(
  request: DependencyRequest & { readonly directCallsOnly?: boolean }
): Promise<DependencyResult> {
  const definitions = sqlDefinitions(request.text);
  const target = definitions.find((entry) => entry.startLine === request.line && entry.name.name === request.name);
  if (!target) return { dependencies: [], limitations: ["The SQL unit could not be resolved."] };
  const preamble = sqlPreamble(request.text, target.start);
  const limitations = new Set<string>([
    "SQL lookup is syntactic, not database-aware; search paths, aliases, dialect extensions, and runtime objects may be unresolved."
  ]);
  const { refs, dynamic } = references(target, request.directCallsOnly ?? false);
  const selectedRefs = refs.filter((ref) => !request.onlyName || ref.name.name === request.onlyName);
  if (dynamic) limitations.add("Dynamic SQL is not resolved or tracked.");
  const language = sqlBodyLanguage(target.tokens);
  if (language && !["sql", "plpgsql"].includes(language)) limitations.add("Non-SQL routine bodies are not resolved.");
  const expired = () => request.deadline !== undefined && Date.now() >= request.deadline;
  const max = Math.max(0, request.maxDependencies ?? 16);
  const dependencies: Dependency[] = [];
  if (!selectedRefs.length || !max) return { dependencies, preamble, limitations: [...limitations] };
  const catalog: Array<{ path: string; entry: SqlDefinition }> = definitions.map((entry) => ({ path: request.path, entry }));
  let bytes = Buffer.byteLength(request.text);
  let loaded = 1;
  for (const path of [...request.readablePaths].filter((path) => /\.sql$/i.test(path) && path !== request.path).sort()) {
    if (expired()) break;
    if (loaded >= 100 || bytes >= 2 * 1024 * 1024) {
      limitations.add("SQL dependency lookup reached its 100-file or 2 MiB limit.");
      break;
    }
    const text = await request.load(path);
    loaded++;
    if (text === undefined) { limitations.add("An eligible SQL file was unavailable or excluded."); continue; }
    const size = Buffer.byteLength(text);
    if (size > 256 * 1024 || bytes + size > 2 * 1024 * 1024) {
      limitations.add("Some SQL files were omitted to stay within the text budget.");
      continue;
    }
    bytes += size;
    catalog.push(...sqlDefinitions(text).map((entry) => ({ path, entry })));
  }
  if (expired()) limitations.add("SQL dependency lookup stopped at its time limit.");
  if (request.unreadPaths?.size) limitations.add("SQL definitions outside the readable inventory were not inspected.");
  const schemas = searchSchemas(preamble);
  const currentSchema = target.name.parts.length > 1 ? target.name.parts.slice(0, -1).join(".") : undefined;
  const added = new Set<string>();
  if (selectedRefs.length > 160) limitations.add("SQL dependency lookup was limited to 160 distinct references.");
  for (const ref of selectedRefs.slice(0, 160)) {
    if (expired()) break;
    const eligible = catalog.filter(({ entry }) =>
      (ref.call ? ["function", "procedure"].includes(entry.kind) : ["table", "view", "type"].includes(entry.kind)) &&
      (ref.name.parts.length > 1 ? JSON.stringify(entry.name.parts) === JSON.stringify(ref.name.parts)
        : entry.name.parts.at(-1) === ref.name.parts[0]));
    // Repeated CREATEs are migration snapshots, not overloads. Prefer the last
    // path/statement, but state the assumption rather than claiming DB order.
    const latest = new Map<string, (typeof eligible)[number]>();
    for (const candidate of eligible.sort((a, b) => a.path.localeCompare(b.path) || a.entry.start - b.entry.start)) {
      const key = `${candidate.entry.kind}:${JSON.stringify(candidate.entry.name.parts)}:${candidate.entry.qualifiedName.slice(candidate.entry.name.qualified.length)}`;
      if (latest.has(key)) limitations.add("Repeated SQL definitions use the last file in lexical path order, not database migration order.");
      latest.set(key, candidate);
    }
    let matches = [...latest.values()];
    if (ref.name.parts.length === 1) {
      const prefixes = [...schemas, ...(currentSchema ? [currentSchema] : [])];
      const preferred = prefixes.find((schema) => matches.some(({ entry }) => entry.name.parts.slice(0, -1).join(".") === schema));
      if (preferred !== undefined) matches = matches.filter(({ entry }) => entry.name.parts.slice(0, -1).join(".") === preferred);
      const namespaces = new Set(matches.map(({ entry }) => entry.name.parts.slice(0, -1).join(".")));
      if (namespaces.size > 1) {
        limitations.add("Ambiguous unqualified SQL names in different schemas were not resolved.");
        continue;
      }
    }
    if (matches.length > 1 && ref.call) limitations.add("SQL routine overloads are matched by name, not argument types; all matching overloads are candidates.");
    for (const { path, entry } of matches) {
      if (path === request.path && entry.start === target.start) continue;
      const key = `${path}:${entry.start}`;
      if (added.has(key)) continue;
      if (dependencies.length >= max) {
        limitations.add("Some SQL dependencies were omitted at the item limit.");
        break;
      }
      added.add(key);
      dependencies.push({ path, item: itemOf(entry) });
    }
  }
  if (expired()) limitations.add("SQL dependency lookup stopped at its time limit.");
  return { dependencies, preamble, limitations: [...limitations] };
}
