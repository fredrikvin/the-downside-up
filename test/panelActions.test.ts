import { describe, expect, it, vi } from "vitest";
import { ExplanationPanel, type PanelAction, type PanelState } from "../src/presentation/panel";

const harness = vi.hoisted(() => ({ receive: (_message: unknown): void => undefined, close: (): void => undefined }));
const postMessage = vi.hoisted(() => vi.fn());
vi.mock("vscode", () => ({
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => {
      let disposed = false;
      const webview = {
        html: "",
        postMessage,
        onDidReceiveMessage: (receive: typeof harness.receive) => {
          harness.receive = receive;
          return { dispose: () => undefined };
        }
      };
      return {
        get webview() {
          if (disposed) throw new Error("Webview is disposed");
          return webview;
        },
        dispose: () => { disposed = true; harness.close(); },
        onDidDispose: (close: () => void) => {
          harness.close = close;
          return { dispose: () => undefined };
        },
        onDidChangeViewState: () => ({ dispose: () => undefined })
      };
    }
  }
}));

describe("header action validation", () => {
  it("ignores reentrant cleanup and late messages after closing, and allows a new panel", async () => {
    const state: PanelState = {
      provider: "mock", models: { explanation: "mock" }, busy: false, hasRepository: false,
      explanations: [], showDetails: false, formats: { pseudocode: false, flowchart: false, initial: "steps" },
      review: { text: "Commit: 1/2 ready", canStop: true }
    };
    const action = vi.fn();
    const navigate = vi.fn(async () => undefined);
    const panel = new ExplanationPanel("Test", action, () => {
      panel.updateReview({ text: "Commit: 1/2 ready · stopped", canStop: false });
    });
    panel.update(state);
    panel.setReferenceHandlers(new Map([["source", navigate]]));
    panel.setFileReferenceHandlers(new Map([["file", navigate]]));
    postMessage.mockClear();
    expect(() => panel.panel.dispose()).not.toThrow();
    expect(() => {
      panel.update(state);
      panel.updateReview(state.review);
      panel.scrollToLine(4);
      panel.highlightEntry("entry-1");
      panel.highlightSteps("entry-1", { steps: [0], pseudocode: [], nodes: [] });
      harness.receive({ type: "ready" });
      harness.receive({ type: "stopReview" });
      panel.dispose();
    }).not.toThrow();
    await panel.navigate("source");
    await panel.navigate("file");
    expect(navigate).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    const reopened = new ExplanationPanel("Reopened", action);
    reopened.update(state);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "state", state });
    reopened.dispose();
  });

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
      { type: "reviewNavigation", token: "opaque-token-1234567890", direction: "next", path: "/untrusted" },
      { type: "reviewNavigation", token: "short", direction: "next" },
      { type: "reviewNavigation", token: "opaque-token-1234567890", direction: "jump", path: "/untrusted" },
      { type: "unknown" },
      { type: ["regenerateOutdated"] },
      null
    ]) harness.receive(message);
    expect(actions).toEqual([
      { type: "chooseModel" }, { type: "chooseOverviewModel" }, { type: "regenerateOutdated" },
      { type: "clearCache" }, { type: "stopReview" }, { type: "showCallers", entryId: "entry-1" },
      { type: "explainChanges" },
      { type: "reviewNavigation", token: "opaque-token-1234567890", direction: "next" }
    ]);
    panel.dispose();
  });
});
