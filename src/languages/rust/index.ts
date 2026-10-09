import {
  lineScanPreamble,
  UNRESOLVED_DEPENDENCIES,
  type Dependency,
  type LanguageSupport
} from "../support";
import { findRustDependencies } from "./dependencies";
import { describeRustSource } from "./outline";
import { findRustDeclarations, findRustFunction, initializeRustParserAt, listRustFunctions } from "./syntax";

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Same-file context: functions the function calls by name and the types,
 * traits, constants, and statics it names. Cross-file items come from the
 * crate's `use` declarations and paths.
 */
async function sameFileItems(path: string, text: string, line: number, name: string): Promise<Dependency[]> {
  const functions = await listRustFunctions({ getText: () => text }).catch(() => []);
  const target = functions.find((entry) => entry.startLine === line && entry.name === name);
  if (!target) return [];
  const local: Dependency[] = [];
  for (const related of functions) {
    if (
      related.qualifiedName !== target.qualifiedName &&
      related.name !== target.name &&
      new RegExp(`\\b${escape(related.name)}\\s*\\(`).test(target.source)
    ) {
      local.push({
        path,
        item: {
          kind: "function",
          name: related.name,
          qualifiedName: related.qualifiedName,
          line: related.startLine,
          source: related.source,
          signature: related.signature,
          fingerprint: related.fingerprint,
          signatureFingerprint: "",
          label: `called function ${related.qualifiedName}`
        }
      });
    }
  }
  const names = new Set(`${target.signature}\n${target.source}`.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []);
  for (const declaration of await findRustDeclarations({ getText: () => text }, names).catch(() => [])) {
    local.push({
      path,
      item: {
        kind: declaration.kind,
        name: declaration.name,
        qualifiedName: declaration.name,
        line: declaration.line,
        source: declaration.source,
        signature: declaration.source,
        fingerprint: declaration.fingerprint,
        signatureFingerprint: "",
        label: `${declaration.kind} ${declaration.name}`
      }
    });
  }
  return local;
}

export const rustSupport: LanguageSupport = {
  name: "Rust",
  languageIds: ["rust"],
  fileExtensions: [".rs"],
  initialize: initializeRustParserAt,
  findFunction: findRustFunction,
  listFunctions: (source) => listRustFunctions({ getText: () => source }),
  describeSource: describeRustSource,
  async preamble(source) {
    const functions = await listRustFunctions({ getText: () => source }).catch(() => []);
    return lineScanPreamble(source, functions);
  },
  async findDependencies(request) {
    const local = await sameFileItems(request.path, request.text, request.line, request.name);
    const found = await findRustDependencies(request)
      .catch(() => ({ dependencies: [], limitations: [UNRESOLVED_DEPENDENCIES] }));
    return { ...found, local };
  }
};
