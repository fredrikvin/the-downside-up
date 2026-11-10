import { fingerprint } from "../../core/fingerprint";
import type { LanguageSupport } from "../support";
import { structuralTokens } from "../treeSitter";
import { findSvelteDependencies, svelteImportPreamble } from "./dependencies";
import { svelteGuidance } from "./guidance";
import { svelteFileImports } from "./imports";
import { describeSvelteSource } from "./outline";
import { findSvelteFunction, svelteComparisonFunctions, listSvelteFunctions, withSvelteSyntaxTree } from "./syntax";
import { scanSvelte } from "./blocks";
import { initializeJavaScriptParsersAt } from "../javascript/syntax";

/** Svelte components use the existing TypeScript grammar plus a bounded block scanner. */
export const svelteSupport: LanguageSupport = {
  name: "Svelte",
  languageIds: ["svelte"],
  fileExtensions: [".svelte"],
  initialize: initializeJavaScriptParsersAt,
  findFunction: findSvelteFunction,
  listFunctions: listSvelteFunctions,
  comparisonFunctions: svelteComparisonFunctions,
  describeSource: describeSvelteSource,
  async textFingerprint(source, path) {
    const scan = scanSvelte(source);
    if (!scan.supported) return fingerprint(source);
    const script = await withSvelteSyntaxTree(source, path, structuralTokens);
    const markup = scan.markupView.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
    return fingerprint(JSON.stringify([script ?? scan.scriptView, markup]));
  },
  async preamble(source, path) {
    return svelteImportPreamble(source, path);
  },
  findDependencies: findSvelteDependencies,
  explanationGuidance: svelteGuidance,
  fileImports: svelteFileImports
};
