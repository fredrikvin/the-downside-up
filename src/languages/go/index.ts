import { UNRESOLVED_DEPENDENCIES, type LanguageSupport } from "../support";
import { goFileImports } from "./imports";
import { findGoDependencies } from "./dependencies";
import { describeGoSource } from "./outline";
import { findGoFunction, initializeGoParserAt, listGoFunctions } from "./syntax";

export const goSupport: LanguageSupport = {
  name: "Go",
  languageIds: ["go"],
  fileExtensions: [".go"],
  initialize: initializeGoParserAt,
  findFunction: findGoFunction,
  listFunctions: (source) => listGoFunctions({ getText: () => source }),
  describeSource: describeGoSource,
  // The package clause and import block come from the parser with the dependencies.
  findDependencies: (request) =>
    findGoDependencies(request)
      .catch(() => ({ dependencies: [], preamble: "", limitations: [UNRESOLVED_DEPENDENCIES] })),
  fileImports: goFileImports
};
