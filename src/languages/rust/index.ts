import {
  UNRESOLVED_DEPENDENCIES,
  type Dependency,
  type LanguageSupport
} from "../support";
import { findRustDependencies } from "./dependencies";
import { rustFileImports } from "./imports";
import { describeRustSource } from "./outline";
import { findRustDeclarations, findRustFunction, initializeRustParserAt, listRustFunctions, withRustSyntaxTree } from "./syntax";
import { fingerprint } from "../../core/fingerprint";
import { namedChildren, structuralTokens } from "../treeSitter";

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
  async textFingerprint(source) {
    const tokens = await withRustSyntaxTree(source, structuralTokens);
    return fingerprint(tokens ?? source);
  },
  async preamble(source) {
    return (await withRustSyntaxTree(source, (root) => {
      const parts: string[] = [];
      const visit = (node: typeof root) => {
        if (["use_declaration", "extern_crate_declaration", "const_item", "line_comment", "block_comment"].includes(node.type)) {
          parts.push(node.text);
        } else if (node.type === "mod_item") {
          const body = node.childForFieldName("body");
          if (body) namedChildren(body).forEach(visit);
          else parts.push(node.text);
        }
      };
      namedChildren(root).forEach(visit);
      return parts.slice(0, 120).join("\n");
    })) ?? "";
  },
  async findDependencies(request) {
    const local = await sameFileItems(request.path, request.text, request.line, request.name);
    const found = await findRustDependencies(request)
      .catch(() => ({ dependencies: [], limitations: [UNRESOLVED_DEPENDENCIES] }));
    return { ...found, local };
  },
  findDirectCalls: (request) => findRustDependencies({ ...request, directCallsOnly: true }),
  directCallManifests: ["Cargo.toml"],
  fileImports: rustFileImports
};
