import * as vscode from "vscode";

const SEEN_KEY = "prefetchOnboardingShown";

export function prefetchOnboarding(state: vscode.Memento): () => Promise<void> {
  let started = false;
  return async () => {
    if (started || state.get<boolean>(SEEN_KEY)) return;
    started = true;
    const settings = vscode.workspace.getConfiguration("downsideUp");
    if (settings.inspect<boolean>("prefetch.enabled")?.globalValue !== undefined) return;
    await state.update(SEEN_KEY, true);
    const answer = await vscode.window.showInformationMessage(
      "Enable background explanations? Downside Up can prepare function explanations and Git diff comparisons as you read, using your provider's quota or billing. It only runs in trusted workspaces after sharing is approved for the repository and model. You can turn it off in user settings.",
      "Enable prefetch",
      "Not now"
    );
    if (answer !== "Enable prefetch") return;
    if (settings.inspect<boolean>("prefetch.enabled")?.globalValue !== undefined) return;
    await settings.update("prefetch.enabled", true, vscode.ConfigurationTarget.Global);
  };
}
