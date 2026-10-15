import type { LanguageSupport } from "../support";
import { javascriptFileImports } from "./imports";
import { namedChildren, structuralTokens } from "../treeSitter";
import { fingerprint } from "../../core/fingerprint";
import { findJavaScriptDependencies } from "./dependencies";
import { javascriptGuidance } from "./guidance";
import { describeJavaScriptSource } from "./outline";
import {
  findJavaScriptFunction,
  initializeJavaScriptParsersAt,
  JAVASCRIPT_EXTENSIONS,
  JAVASCRIPT_LANGUAGE_IDS,
  listJavaScriptFunctions,
  withJavaScriptSyntaxTree
} from "./syntax";

/**
 * JavaScript and TypeScript, including JSX and React. Functions, components,
 * and hooks are found with bundled Tree-sitter grammars; what a function uses
 * is resolved with VS Code's built-in TypeScript go-to-definition.
 */
export const javascriptSupport: LanguageSupport = {
  name: "JavaScript/TypeScript",
  languageIds: JAVASCRIPT_LANGUAGE_IDS,
  fileExtensions: JAVASCRIPT_EXTENSIONS,
  initialize: initializeJavaScriptParsersAt,
  findFunction: findJavaScriptFunction,
  listFunctions: listJavaScriptFunctions,
  describeSource: describeJavaScriptSource,
  async textFingerprint(source, path) {
    const tokens = await withJavaScriptSyntaxTree(source, path, structuralTokens);
    return fingerprint(tokens ?? source);
  },
  async preamble(source, path) {
    return (await withJavaScriptSyntaxTree(source, path, (root) => namedChildren(root)
      .filter((node) => node.type === "import_statement" ||
        (node.type === "export_statement" && /\bfrom\s*["']/.test(node.text) && !node.childForFieldName("declaration")))
      .map((node) => node.text)
      .join("\n"))) ?? "";
  },
  findDependencies: findJavaScriptDependencies,
  explanationGuidance: javascriptGuidance,
  fileImports: javascriptFileImports
};
