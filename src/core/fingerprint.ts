import { createHash } from "node:crypto";

export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function cacheKey(parts: readonly string[]): string {
  return fingerprint(parts.map((part) => `${part.length}:${part}`).join("|"));
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
