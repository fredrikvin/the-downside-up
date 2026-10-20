import type { ExternalProviderKind, RepositoryCache } from "../core/types";

/** Whether code sharing was approved for this repository and model, as the latest approval or an earlier one. */
export function hasConsent(cache: RepositoryCache, provider: string, model: string): boolean {
  const matches = (entry: { provider: string; model: string } | null | undefined) =>
    Boolean(entry && entry.provider === provider && entry.model === model);
  return matches(cache.consent) || (cache.consents ?? []).some(matches);
}

/**
 * The models among `models` that lack code-sharing approval for the
 * repository, each listed once; the mock provider never needs approval.
 * `consentModelId` names the model approvals are recorded under, or
 * undefined when it cannot be determined (which counts as unapproved).
 */
export async function unapprovedModels<T extends { readonly kind: string; readonly modelId: string }>(
  cache: RepositoryCache,
  models: readonly T[],
  consentModelId: (model: T) => Promise<string | undefined>
): Promise<T[]> {
  const missing: T[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (model.kind === "mock") continue;
    const consentId = await consentModelId(model);
    const id = `${model.kind}\0${consentId ?? model.modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (consentId === undefined || !hasConsent(cache, model.kind, consentId)) missing.push(model);
  }
  return missing;
}

/**
 * Records an approval. Each repository keeps one approval per model, so using
 * a separate model for overviews does not ask again for the explanation model.
 */
export function withConsent(cache: RepositoryCache, provider: ExternalProviderKind, model: string, acceptedAt: number): RepositoryCache {
  const entry = { provider, model, acceptedAt };
  const earlier = [...(cache.consents ?? []), ...(cache.consent ? [cache.consent] : [])]
    .filter((existing) => !(existing.provider === provider && existing.model === model));
  const unique = earlier.filter((existing, index) =>
    earlier.findIndex((other) => other.provider === existing.provider && other.model === existing.model) === index);
  return { ...cache, consent: entry, consents: [...unique, entry] };
}
