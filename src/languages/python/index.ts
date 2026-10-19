import { fingerprint } from "../../core/fingerprint";
import type { LanguageSupport } from "../support";
import { structuralTokens } from "../treeSitter";
import { findPythonDependencies } from "./dependencies";
import { pythonFileImports } from "./imports";
import { describePythonSource } from "./outline";
import { findPythonFunction, initializePythonParserAt, listPythonFunctions, withPythonSyntaxTree } from "./syntax";

export const pythonSupport: LanguageSupport = {
  name: "Python",
  languageIds: ["python"],
  fileExtensions: [".py"],
  initialize: initializePythonParserAt,
  findFunction: findPythonFunction,
  listFunctions: listPythonFunctions,
  describeSource: describePythonSource,
  async textFingerprint(source) {
    const tokens = await withPythonSyntaxTree(source, structuralTokens);
    return fingerprint(tokens ?? source);
  },
  findDependencies: findPythonDependencies,
  findDirectCalls: (request) => findPythonDependencies({ ...request, directCallsOnly: true }),
  fileImports: pythonFileImports
};
