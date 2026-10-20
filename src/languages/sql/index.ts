import type { LanguageSupport } from "../support";
import { findSqlDependencies } from "./dependencies";
import { sqlFingerprint } from "./lexer";
import { describeSqlSource } from "./outline";
import { findSqlFunction, listSqlFunctions, sqlDefinitions, sqlPreamble } from "./syntax";

export const sqlSupport: LanguageSupport = {
  name: "SQL",
  languageIds: ["sql"],
  fileExtensions: [".sql"],
  findFunction: findSqlFunction,
  listFunctions: listSqlFunctions,
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
