import { cacheKey } from "../core/fingerprint";
import type { TrackedInput } from "../core/types";

/**
 * Identifies a saved explanation. The repository overview is deliberately not
 * part of it: the overview is background context, so rewording it does not
 * outdate explanations whose own code and dependencies are unchanged.
 */
export function explanationCacheKey(
  symbolId: string,
  provider: string,
  model: string,
  settingsHash: string,
  promptVersion: string
): string {
  return cacheKey([
    "explanation-v2",
    symbolId,
    provider,
    model,
    settingsHash,
    promptVersion
  ]);
}

export function inputsMatch(
  previous: readonly TrackedInput[],
  current: readonly TrackedInput[]
): boolean {
  if (previous.length !== current.length) return false;
  const identity = (input: TrackedInput) => `${input.path}\0${input.description}\0${input.scope ?? "body"}`;
  const currentMap = new Map(current.map((input) => [identity(input), input.fingerprint]));
  return previous.every((input) => currentMap.get(identity(input)) === input.fingerprint);
}
