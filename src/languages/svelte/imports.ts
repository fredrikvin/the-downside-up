import { posix } from "node:path";
import type { ImportRequest } from "../support";
import { scanSvelte } from "./blocks";
import { moduleSpecifiers } from "../javascript/imports";
import { withSvelteSyntaxTree } from "./syntax";

const EXTENSIONS = [".svelte", ".svelte.ts", ".svelte.js", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function resolveFile(base: string, request: Pick<ImportRequest, "hasFile">): string | undefined {
  if (base === ".." || base.startsWith("../")) return undefined;
  const extension = posix.extname(base);
  const candidates = [
    base,
    ...EXTENSIONS.filter((candidate) => !base.endsWith(candidate)).map((candidate) => base + candidate),
    ...EXTENSIONS.map((candidate) => `${base}/index${candidate}`),
    ...(extension === ".js" ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".svelte.ts"] : [])
  ];
  return candidates.find((candidate) => request.hasFile(candidate));
}

function targetFor(
  specifier: string,
  folder: string,
  request: Pick<ImportRequest, "hasFile">
): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveFile(posix.normalize(posix.join(folder, specifier)), request);
  }
  if (specifier.startsWith("$lib/")) {
    const base = posix.normalize(posix.join("src/lib", specifier.slice("$lib/".length)));
    if (!base.startsWith("src/lib/")) return undefined;
    return resolveFile(base, request);
  }
  return undefined;
}

/** Local Svelte component/module imports, including the default SvelteKit `$lib` alias. */
export async function svelteFileImports(request: ImportRequest): Promise<string[]> {
  const scan = scanSvelte(request.text);
  if (!scan.supported) return [];
  const specifiers = await withSvelteSyntaxTree(request.text, request.path, moduleSpecifiers) ?? [];
  const folder = posix.dirname(request.path);
  const targets = new Set<string>();
  for (const specifier of specifiers) {
    const target = targetFor(specifier, folder, request);
    if (target) targets.add(target);
  }
  targets.delete(request.path);
  return [...targets];
}

export function resolveSvelteImport(
  specifier: string,
  request: Pick<ImportRequest, "path" | "hasFile">
): string | undefined {
  return targetFor(specifier, posix.dirname(request.path), request);
}
