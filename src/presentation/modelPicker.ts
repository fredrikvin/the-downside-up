import * as vscode from "vscode";
import type { ProviderDescriptor } from "../controller";
import { orderLanguageModels, resolveLanguageModel } from "../generation/languageModel";

export const openAISetup = (): Thenable<unknown> =>
  vscode.commands.executeCommand("workbench.action.openSettings", "@ext:FredrikVinkvist.the-downside-up");

export async function availableLanguageModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return orderLanguageModels(await vscode.lm.selectChatModels());
  } catch {
    return [];
  }
}

export const languageModelItem = (model: vscode.LanguageModelChat, current: vscode.LanguageModelChat | undefined) => ({
  label: model.name,
  description: `${model.vendor}${current?.vendor === model.vendor && current.id === model.id ? " · current" : ""}`,
  detail: `Up to ${model.maxInputTokens.toLocaleString()} input tokens · ${model.id}`,
  model
});

/** Configuration only. The caller must not resume generation after choosing a model. */
export async function chooseLanguageModel(describeProvider: () => ProviderDescriptor): Promise<boolean> {
  const models = await availableLanguageModels();
  if (models.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      "No VS Code language models are available. Install and sign in to GitHub Copilot, or install another extension that provides language models, then try again. You can also configure OpenAI with your own API key.",
      "OpenAI setup"
    );
    if (answer === "OpenAI setup") await openAISetup();
    return false;
  }

  const descriptor = describeProvider();
  const current = descriptor.kind === "vscode-lm" ? resolveLanguageModel(models, descriptor.modelId) : undefined;
  const picked = await vscode.window.showQuickPick(models.map((model) => languageModelItem(model, current)), {
    title: "Choose the language model for Downside Up",
    placeHolder: "Choosing sends no code and generates nothing. Request an explanation afterward; sharing requires approval.",
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return false;
  const settings = vscode.workspace.getConfiguration("downsideUp");
  await settings.update("languageModel.model", picked.model.name, vscode.ConfigurationTarget.Global);
  await settings.update("provider", "vscode-lm", vscode.ConfigurationTarget.Global);
  const effective = describeProvider();
  if (effective.kind !== "vscode-lm" || resolveLanguageModel(models, effective.modelId) !== picked.model) {
    await vscode.window.showWarningMessage(
      "The model was saved in user settings, but workspace settings for downsideUp.provider or downsideUp.languageModel override it. Update or remove those workspace settings to use the chosen model."
    );
    return false;
  }
  await vscode.window.showInformationMessage(
    `Downside Up will use ${picked.model.name} (${picked.model.vendor}) through VS Code. Request an explanation or map the project to use it; you will be asked before any code is shared.`
  );
  return true;
}

/** Configures an Overview-only VS Code model without selecting a Functions model. */
export async function chooseOverviewModelForSetup(
  describeOverviewProvider: () => ProviderDescriptor
): Promise<boolean> {
  const models = await availableLanguageModels();
  if (models.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      "No VS Code language models are available. Install and sign in to GitHub Copilot, or install another extension that provides language models, then try again.",
      "OpenAI setup"
    );
    if (answer === "OpenAI setup") await openAISetup();
    return false;
  }
  const descriptor = describeOverviewProvider();
  const current = descriptor.kind === "vscode-lm" ? resolveLanguageModel(models, descriptor.modelId) : undefined;
  const picked = await vscode.window.showQuickPick(models.map((model) => languageModelItem(model, current)), {
    title: "Choose the review summary model",
    placeHolder: "Used only for review summaries. Choosing sends no code; sharing approval is requested only when you generate a summary.",
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return false;
  const settings = vscode.workspace.getConfiguration("downsideUp");
  await settings.update("languageModel.overviewModel", picked.model.name, vscode.ConfigurationTarget.Global);
  await settings.update("provider", "vscode-lm", vscode.ConfigurationTarget.Global);
  const effective = describeOverviewProvider();
  if (effective.kind !== "vscode-lm" || resolveLanguageModel(models, effective.modelId) !== picked.model) {
    await vscode.window.showWarningMessage(
      "The Overview model was saved in user settings, but workspace settings override the provider or Overview model. Update or remove those workspace settings before generating a review summary."
    );
    return false;
  }
  await vscode.window.showInformationMessage(
    `Downside Up will use ${picked.model.name} (${picked.model.vendor}) for review summaries. No Functions model was selected; code sharing requires a separate approval when you generate a summary.`
  );
  return true;
}
