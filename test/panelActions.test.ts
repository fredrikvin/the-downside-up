import { describe, expect, it, vi } from "vitest";
import { ExplanationPanel, type PanelAction } from "../src/presentation/panel";

const harness = vi.hoisted(() => ({ receive: (_message: unknown): void => undefined }));
vi.mock("vscode", () => ({
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: "",
        onDidReceiveMessage: (receive: typeof harness.receive) => {
          harness.receive = receive;
          return { dispose: () => undefined };
        }
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeViewState: () => ({ dispose: () => undefined })
    })
  }
}));

describe("header action validation", () => {
  it("accepts only known actions, never model-provided regeneration targets", () => {
    const actions: PanelAction[] = [];
    const panel = new ExplanationPanel("Test", (action) => actions.push(action));
    for (const message of [
      { type: "chooseModel" },
      { type: "chooseOverviewModel" },
      { type: "regenerateOutdated", paths: ["/untrusted/path"], model: "untrusted" },
      { type: "clearCache" },
      { type: "chooseModels" },
      { type: "unknown" },
      { type: ["regenerateOutdated"] },
      null
    ]) harness.receive(message);
    expect(actions).toEqual([{ type: "chooseModel" }, { type: "chooseOverviewModel" }, { type: "regenerateOutdated" }, { type: "clearCache" }]);
    panel.dispose();
  });
});
