import { minimatch } from "minimatch";
import { fingerprint } from "../core/fingerprint";

/** Request-saving classification only; never grants permission to share a file. */
export interface LowValueClassification {
  readonly pattern: string;
}

export const DEFAULT_LOW_VALUE_PATTERNS: readonly string[] = Object.freeze([
  ...["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
    "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock",
    "composer.lock", "packages.lock.json"].map((name) => `**/${name}`),
  ...["vendored", "third_party", "third-party", "generated", "__generated__", "__snapshots__"]
    .map((name) => `**/${name}/**`),
  ...["*.generated.*", "*.gen.go", "*_generated.go", "*.pb.go", "*_pb2.py", "*_pb2_grpc.py",
    "*.d.ts", "*.min.js", "*.min.mjs", "*.min.cjs", "*.min.css", "*.snap"].map((name) => `**/${name}`)
]);

export function validReviewPattern(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/^[!/\\]|^[A-Za-z]:|[\\\x00-\x1f\x7f-\x9f]/.test(value) &&
    !value.split("/").includes("..");
}

export interface ReviewFilterLayers {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

export function reviewFilter(layers: ReviewFilterLayers = {}) {
  const patternsFrom = (value: unknown): string[] =>
    Array.isArray(value) ? value.slice(0, 128).filter(validReviewPattern) : [];
  const patterns = Object.freeze([...new Set([
    ...(Array.isArray(layers.globalValue) ? patternsFrom(layers.globalValue) : DEFAULT_LOW_VALUE_PATTERNS),
    ...patternsFrom(layers.workspaceValue), ...patternsFrom(layers.workspaceFolderValue)
  ])].sort());
  return Object.freeze({
    patterns,
    fingerprint: fingerprint(JSON.stringify(patterns)),
    classify(originalPath: string, modifiedPath = originalPath): LowValueClassification | undefined {
      const pattern = patterns.find((pattern) => [originalPath, modifiedPath].some((path) =>
        minimatch(path, pattern, { nonegate: true, nocomment: true, noext: true })));
      return pattern ? Object.freeze({ pattern }) : undefined;
    }
  });
}
