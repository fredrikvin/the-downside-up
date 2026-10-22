import { describe, expect, it, vi } from "vitest";
import { ExplanationPanel, type PanelAction, type PanelState } from "../src/presentation/panel";

const harness = vi.hoisted(() => ({ receive: (_message: unknown): void => undefined }));
const postMessage = vi.hoisted(() => vi.fn());
vi.mock("vscode", () => ({
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: "",
        postMessage,
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
  it("updates and replays review progress without sending a full render for each transition", () => {
    const panel = new ExplanationPanel("Test", () => undefined);
    const state: PanelState = {
      provider: "mock", models: { explanation: "mock" }, busy: false, hasRepository: false,
      explanations: [], showDetails: false, formats: { pseudocode: false, flowchart: false, initial: "steps" }
    };
    panel.update(state);
    postMessage.mockClear();
    const review = { text: "Commit: 1/2 ready", canStop: true };
    panel.updateReview(review);
    panel.updateReview(review);
    expect(postMessage.mock.calls).toEqual([[{ type: "review", review }]]);
    harness.receive({ type: "ready" });
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state: { ...state, review } });
    panel.updateReview(undefined);
    harness.receive({ type: "ready" });
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state });
    panel.dispose();
  });

  it("accepts only known actions, never model-provided regeneration targets", () => {
    const actions: PanelAction[] = [];
    const panel = new ExplanationPanel("Test", (action) => actions.push(action));
    for (const message of [
      { type: "chooseModel" },
      { type: "chooseOverviewModel" },
      { type: "regenerateOutdated", paths: ["/untrusted/path"], model: "untrusted" },
      { type: "clearCache" },
      { type: "stopReview", paths: ["/untrusted"], commit: "untrusted" },
      { type: "showCallers", entryId: "entry-1", uri: "/untrusted" },
      { type: "showCallers", entryId: 4 },
      { type: "chooseModels" },
      { type: "explainChanges", path: "/untrusted" },
      { type: "unknown" },
      { type: ["regenerateOutdated"] },
      null
    ]) harness.receive(message);
    expect(actions).toEqual([{ type: "chooseModel" }, { type: "chooseOverviewModel" }, { type: "regenerateOutdated" }, { type: "clearCache" }, { type: "stopReview" }, { type: "showCallers", entryId: "entry-1" }, { type: "explainChanges" }]);
    panel.dispose();
  });
});
