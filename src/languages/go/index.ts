import { UNRESOLVED_DEPENDENCIES, type LanguageSupport } from "../support";
import { goFileImports } from "./imports";
import { findGoDependencies } from "./dependencies";
import { describeGoSource } from "./outline";
import { findGoFunction, initializeGoParserAt, listGoFunctions, withGoSyntaxTree } from "./syntax";
import { fingerprint } from "../../core/fingerprint";
import { structuralTokens } from "../treeSitter";

export const goSupport: LanguageSupport = {
  name: "Go",
  languageIds: ["go"],
  fileExtensions: [".go"],
  initialize: initializeGoParserAt,
  findFunction: findGoFunction,
  listFunctions: (source) => listGoFunctions({ getText: () => source }),
  describeSource: describeGoSource,
  async textFingerprint(source) {
    const tokens = await withGoSyntaxTree(source, structuralTokens);
    return fingerprint(tokens ?? source);
  },
  // The package clause and import block come from the parser with the dependencies.
  findDependencies: (request) =>
    findGoDependencies(request)
      .catch(() => ({ dependencies: [], preamble: "", limitations: [UNRESOLVED_DEPENDENCIES] })),
  fileImports: goFileImports
};
