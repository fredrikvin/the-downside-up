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
  const currentMap = new Map(current.map((input) => [
    `${input.path}\0${input.description}`,
    input.fingerprint
  ]));
  return previous.every(
    (input) => currentMap.get(`${input.path}\0${input.description}`) === input.fingerprint
  );
}
