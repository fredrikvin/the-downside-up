import type { LanguageSupport } from "../support";
import { findSqlDependencies } from "./dependencies";
import { sqlFingerprint } from "./lexer";
import { describeSqlSource } from "./outline";
import { findSqlFunction, listSqlFunctions, sqlDefinitions, sqlPreamble, sqlStatements } from "./syntax";
import { lexSql, sqlPosition, word } from "./lexer";

export const sqlSupport: LanguageSupport = {
  name: "SQL",
  languageIds: ["sql"],
  fileExtensions: [".sql"],
  findFunction: findSqlFunction,
  listFunctions: listSqlFunctions,
  async comparisonFunctions(source) {
    const definitions = sqlDefinitions(source).filter((entry) => ["function", "procedure", "trigger"].includes(entry.kind));
    const knownStarts = new Set(definitions.map((entry) => entry.start));
    const incomplete = lexSql(source).some((token) => !token.closed) ||
      definitions.some((entry) => entry.body.length === 0) ||
      sqlStatements(source).some((tokens) => word(tokens[0], "create") &&
        tokens.slice(1, 24).some((token) => ["function", "procedure", "trigger"].some((kind) => word(token, kind))) &&
        !knownStarts.has(tokens[0]!.start));
    return {
      status: incomplete || definitions.length > 500 ? "partial" : "complete",
      entries: definitions.slice(0, 500).map((entry) => {
        const start = sqlPosition(source, entry.start);
        const end = sqlPosition(source, entry.end);
        const name = sqlPosition(source, entry.name.start);
        return {
          name: entry.name.name, qualifiedName: entry.qualifiedName, kind: entry.kind,
          matchKey: JSON.stringify([entry.kind, entry.name.parts]), signature: entry.signature,
          signatureFingerprint: sqlFingerprint(entry.signature), source: entry.source,
          fingerprint: sqlFingerprint(entry.source), startLine: start.line, endLine: end.line,
          startColumn: start.character, endColumn: end.character, nameLine: name.line, nameColumn: name.character
        };
      }),
      limitations: incomplete ? ["SQL routine discovery is incomplete for this snapshot."] : []
    };
  },
  describeSource: describeSqlSource,
  textFingerprint: async (source) => sqlFingerprint(source),
  preamble: async (source) => sqlPreamble(source),
  findDependencies: findSqlDependencies,
  async explanationGuidance(request) {
    const entry = sqlDefinitions(request.text).find((candidate) =>
      candidate.startLine === request.line && candidate.name.name === request.name);
    if (!entry) return undefined;
    if (entry.kind === "query") return "This unit is a SQL query, not an application function. Explain its input parameters, which rows it reads or changes, joins and filters, ordering, and returned rows or affected-row count. A sqlc name/mode annotation describes the query's application API. Do not claim the query has been executed or that rows exist.";
    if (["table", "type", "index", "sequence"].includes(entry.kind)) return "This unit declares database structure, not an application function. Explain what it stores or defines, column meanings grounded in the schema, required values, defaults, keys, constraints, and relationships. Related ALTER TABLE statements and indexes are part of the supplied context. Describe schema rules rather than inventing a runtime control flow; do not claim a database connection or execution. Mark inferred business meanings as uncertain.";
    return undefined;
  },
  directCallNote: "SQL names only; overloads are candidates, and repeated definitions use lexical file order.",
  findDirectCalls: (request) => findSqlDependencies({ ...request, directCallsOnly: true })
};
