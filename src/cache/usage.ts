import type { RepositoryCache, Usage } from "../core/types";

export interface CachedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimated: boolean;
  readonly unrecorded: number;
  readonly models: ReadonlyArray<{
    readonly role: "Overview" | "Functions";
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimated: boolean;
  }>;
}

export function cachedUsage(cache: RepositoryCache): CachedUsage {
  const groups = new Map<string, CachedUsage["models"][number]>();
  let unrecorded = 0;
  const add = (role: "Overview" | "Functions", provider: string, model: string, usage?: Usage) => {
    if (!usage) { unrecorded++; return; }
    const key = JSON.stringify([role, provider, model]);
    const previous = groups.get(key);
    groups.set(key, {
      role, provider, model,
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      estimated: Boolean(previous?.estimated || usage.estimated)
    });
  };
  if (cache.projectMap) add("Overview", cache.projectMap.provider ?? "unknown", cache.projectMap.model ?? "Unknown model", cache.projectMap.usage);
  for (const record of Object.values(cache.explanations)) {
    add("Functions", record.provider, record.model ?? "Unknown model", record.usage);
    for (const usage of Object.values(record.formatUsage ?? {})) add("Functions", record.provider, record.model ?? "Unknown model", usage);
  }
  for (const record of Object.values(cache.comparisons ?? {})) add("Functions", record.provider, record.model, record.usage);
  for (const record of Object.values(cache.fileSummaries ?? {})) add("Functions", record.provider, record.model, record.usage);
  for (const record of [...Object.values(cache.folderSummaries ?? {}), ...Object.values(cache.projectFlows ?? {}), ...Object.values(cache.reviewSummaries ?? {})]) {
    add("Overview", record.provider, record.model, record.usage);
  }
  const models = [...groups.values()].sort((a, b) => a.role.localeCompare(b.role) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return {
    inputTokens: models.reduce((sum, group) => sum + group.inputTokens, 0),
    outputTokens: models.reduce((sum, group) => sum + group.outputTokens, 0),
    estimated: models.some((group) => group.estimated),
    unrecorded, models
  };
}
