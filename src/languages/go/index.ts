import { UNRESOLVED_DEPENDENCIES, type LanguageSupport } from "../support";
import { goFileImports } from "./imports";
import { findGoDependencies } from "./dependencies";
import { describeGoSource } from "./outline";
import { findGoFunction, goComparisonFunctions, initializeGoParserAt, listGoFunctions, withGoSyntaxTree } from "./syntax";
import { fingerprint } from "../../core/fingerprint";
import { namedChildren, structuralTokens } from "../treeSitter";

export const goSupport: LanguageSupport = {
  name: "Go",
  languageIds: ["go"],
  fileExtensions: [".go"],
  initialize: initializeGoParserAt,
  findFunction: findGoFunction,
  listFunctions: (source) => listGoFunctions({ getText: () => source }),
  comparisonFunctions: goComparisonFunctions,
  async preamble(source) {
    return (await withGoSyntaxTree(source, (root) => namedChildren(root)
      .filter((node) => node.type === "package_clause" || node.type === "import_declaration")
      .map((node) => node.text).join("\n"))) ?? "";
  },
  describeSource: describeGoSource,
  async textFingerprint(source) {
    const tokens = await withGoSyntaxTree(source, structuralTokens);
    return fingerprint(tokens ?? source);
  },
  // The package clause and import block come from the parser with the dependencies.
  findDependencies: (request) =>
    findGoDependencies(request)
      .catch(() => ({ dependencies: [], preamble: "", limitations: [UNRESOLVED_DEPENDENCIES] })),
  findDirectCalls: (request) => findGoDependencies({ ...request, directCallsOnly: true }),
  directCallManifests: ["go.mod", "go.work"],
  fileImports: goFileImports
};
