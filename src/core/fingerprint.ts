import { createHash } from "node:crypto";

export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Conservative fallback: never normalize possible multiline literals or continuations. */
export function formatTolerantFingerprint(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (/'''|"""|`|\/\*|\[=*\[|<<|\$(?:[A-Za-z_]\w*)?\$|%\w?[([{<]|:\s*[|>]|\\[ \t]*\r?$/m.test(value) || lines.some((line) =>
    /['"]/.test(line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "")))) return fingerprint(value);
  return fingerprint(lines
    .map((line) => line.replace(/[ \t]+$/, "")).filter((line) => line.trim() !== "").join("\n"));
}

export function cacheKey(parts: readonly string[]): string {
  return fingerprint(parts.map((part) => `${part.length}:${part}`).join("|"));
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
