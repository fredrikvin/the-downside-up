import { extname } from "node:path";
import { editorSupport } from "./editor";
import { goSupport } from "./go";
import { javascriptSupport } from "./javascript";
import { pythonSupport } from "./python";
import { rustSupport } from "./rust";
import { sqlSupport } from "./sql";
import type { LanguageSupport } from "./support";
import { formatTolerantFingerprint } from "../core/fingerprint";

/**
 * Languages with bundled analysis. To add one, create a folder that exports
 * a `LanguageSupport`, list it here, and, for a Tree-sitter grammar, add the
 * grammar to `esbuild.config.mjs`.
 */
const BUNDLED: readonly LanguageSupport[] = [rustSupport, goSupport, javascriptSupport, pythonSupport, sqlSupport];

export interface LanguageFile {
  readonly languageId?: string;
  /** A file path or URI path, used when the language ID is not one of the language's own. */
  readonly path?: string;
}

/** The bundled language for a file, by language ID or file extension. */
export function bundledLanguageFor(file: LanguageFile): LanguageSupport | undefined {
  const extension = file.path ? extname(file.path).toLowerCase() : "";
  return BUNDLED.find((support) =>
    (file.languageId !== undefined && support.languageIds.includes(file.languageId)) ||
    (extension !== "" && support.fileExtensions.includes(extension))
  );
}

/** The bundled language for a file, or the editor-tooling fallback. */
export function languageFor(file: LanguageFile): LanguageSupport {
  return bundledLanguageFor(file) ?? editorSupport;
}

export function sourceFingerprint(source: string, file: LanguageFile): Promise<string> {
  const support = languageFor(file);
  return support.textFingerprint?.(source, file.path ?? "") ?? Promise.resolve(formatTolerantFingerprint(source));
}

/** The language ID recorded for a bundled language's file extension. */
export function bundledLanguageIdForPath(path: string): string | undefined {
  return bundledLanguageFor({ path })?.languageIds[0];
}

const initialized = new Map<LanguageSupport, Promise<void>>();

/** Loads a language's parsers once, from the extension's `dist/`. */
export function initializeLanguage(support: LanguageSupport, extensionPath: string): Promise<void> {
  let ready = initialized.get(support);
  if (!ready) {
    ready = support.initialize?.(extensionPath) ?? Promise.resolve();
    initialized.set(support, ready);
  }
  return ready;
}
