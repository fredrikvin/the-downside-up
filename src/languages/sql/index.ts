import type { LanguageSupport } from "../support";
import { findSqlDependencies } from "./dependencies";
import { sqlFingerprint } from "./lexer";
import { describeSqlSource } from "./outline";
import { findSqlFunction, listSqlFunctions, sqlPreamble } from "./syntax";

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
  directCallNote: "SQL names only; overloads are candidates, and repeated definitions use lexical file order.",
  findDirectCalls: (request) => findSqlDependencies({ ...request, directCallsOnly: true })
};
