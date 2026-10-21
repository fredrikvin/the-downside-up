import type { LanguageSupport } from "../support";
import { findEditorDependencies } from "./dependencies";
import { editorComparisonFunctions, findFunctionWithEditorTools } from "./symbols";

/**
 * The fallback for languages without bundled analysis: functions come from
 * the editor's document symbols and called functions from its
 * go-to-definition, so both depend on the installed language extension.
 */
export const editorSupport: LanguageSupport = {
  name: "Editor tooling",
  languageIds: [],
  fileExtensions: [],
  findFunction: findFunctionWithEditorTools,
  comparisonFunctions: editorComparisonFunctions,
  findDependencies: findEditorDependencies
};
