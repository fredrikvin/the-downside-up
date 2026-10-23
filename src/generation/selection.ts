import type { ProviderDescriptor } from "../controller";

export interface ProviderSettings {
  readonly provider?: string;
  readonly languageModel?: string;
  readonly openaiModel?: string;
}

/** An empty LM descriptor is deliberately unusable: never choose a real model implicitly. */
export function selectedProvider(settings: ProviderSettings, allowMock: boolean): ProviderDescriptor {
  if (settings.provider === "mock" && allowMock) return { kind: "mock", modelId: "deterministic-mock-v1" };
  if (settings.provider === "openai") return { kind: "openai", modelId: settings.openaiModel?.trim() || "gpt-4.1-mini" };
  return { kind: "vscode-lm", modelId: settings.provider === "vscode-lm" ? settings.languageModel?.trim() || "" : "" };
}

export function providerConfigured(descriptor: ProviderDescriptor, allowMock: boolean): boolean {
  return descriptor.kind === "mock" ? allowMock : Boolean(descriptor.modelId.trim());
}

/** A queued follow-up belongs to the requesting model, never a later picker selection. */
export function modelBoundTask<T>(describe: () => ProviderDescriptor, task: () => Promise<T>): () => Promise<T> {
  const requested = describe();
  return async () => {
    const current = describe();
    if (current.kind !== requested.kind || current.modelId !== requested.modelId) {
      throw new DOMException("The model changed before this request started.", "AbortError");
    }
    return task();
  };
}

export class ModelSetupRequired extends Error {
  constructor() {
    super("Choose a model in the Downside Up preview before requesting an explanation. No code was sent.");
    this.name = "ModelSetupRequired";
  }
}
