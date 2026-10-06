import { cacheKey } from "../core/fingerprint";
import type { TrackedInput } from "../core/types";

export function explanationCacheKey(
  symbolId: string,
  provider: string,
  model: string,
  overviewVersion: string,
  settingsHash: string,
  promptVersion: string
): string {
  return cacheKey([
    symbolId,
    provider,
    model,
    overviewVersion,
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
