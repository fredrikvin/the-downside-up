import { fingerprint } from "../../core/fingerprint";
import type { LanguageSupport } from "../support";
import { namedChildren, structuralTokens } from "../treeSitter";
import { findPythonDependencies } from "./dependencies";
import { pythonFileImports } from "./imports";
import { describePythonSource } from "./outline";
import { findPythonFunction, initializePythonParserAt, listPythonFunctions, pythonComparisonFunctions, withPythonSyntaxTree } from "./syntax";

export const pythonSupport: LanguageSupport = {
  name: "Python",
  languageIds: ["python"],
  fileExtensions: [".py"],
  initialize: initializePythonParserAt,
  findFunction: findPythonFunction,
  listFunctions: listPythonFunctions,
  comparisonFunctions: pythonComparisonFunctions,
  async preamble(source) {
    return (await withPythonSyntaxTree(source, (root) => namedChildren(root)
      .filter((node) => node.type === "import_statement" || node.type === "import_from_statement")
      .map((node) => node.text).join("\n"))) ?? "";
  },
  describeSource: describePythonSource,
  async textFingerprint(source) {
    const tokens = await withPythonSyntaxTree(source, structuralTokens);
    return fingerprint(tokens ?? source);
  },
  findDependencies: findPythonDependencies,
  findDirectCalls: (request) => findPythonDependencies({ ...request, directCallsOnly: true }),
  fileImports: pythonFileImports
};
