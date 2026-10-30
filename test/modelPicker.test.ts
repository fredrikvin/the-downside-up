import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseLanguageModel, chooseOverviewModelForSetup, openAISetup } from "../src/presentation/modelPicker";
import { selectedProvider } from "../src/generation/selection";

const host = vi.hoisted(() => ({
  selectChatModels: vi.fn(), pick: vi.fn(), warning: vi.fn(), info: vi.fn(), command: vi.fn(),
  update: vi.fn(), settings: {} as Record<string, string>
}));
vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  lm: { selectChatModels: host.selectChatModels },
  window: { showQuickPick: host.pick, showWarningMessage: host.warning, showInformationMessage: host.info },
  workspace: { getConfiguration: () => ({ update: host.update }) },
  commands: { executeCommand: host.command }
}));

const sendRequest = vi.fn();
const model = { vendor: "copilot", name: "Real model", id: "real", maxInputTokens: 1000, sendRequest };
const describeProvider = () => selectedProvider({
  provider: host.settings.provider, languageModel: host.settings["languageModel.model"]
}, false);
const describeOverviewProvider = () => selectedProvider({
  provider: host.settings.provider, languageModel: host.settings["languageModel.overviewModel"]
}, false);

beforeEach(() => {
  vi.clearAllMocks();
  host.settings = { provider: "mock" };
  host.selectChatModels.mockResolvedValue([model]);
  host.pick.mockResolvedValue(undefined);
  host.warning.mockResolvedValue(undefined);
  host.update.mockImplementation(async (key: string, value: string) => { host.settings[key] = value; });
});

describe("configuration-only model picker", () => {
  it("chooses a real model without generating, requesting sharing approval, or accepting repository input", async () => {
    host.pick.mockImplementation(async (items) => items[0]);
    expect(await chooseLanguageModel(describeProvider)).toBe(true);
    expect(host.settings).toEqual({ provider: "vscode-lm", "languageModel.model": "Real model" });
    expect(host.update.mock.calls).toEqual([["languageModel.model", "Real model", 1], ["provider", "vscode-lm", 1]]);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(host.warning).not.toHaveBeenCalled();
    expect(host.info).toHaveBeenCalledWith(expect.stringContaining("Request an explanation or map the project"));
  });

  it("leaves legacy mock settings unconfigured when cancelled", async () => {
    expect(await chooseLanguageModel(describeProvider)).toBe(false);
    expect(host.update).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(describeProvider()).toEqual({ kind: "vscode-lm", modelId: "" });
  });

  it.each([{ models: [] }, { models: [{ ...model, vendor: "copilotcli" }] }])("does not fall back when no usable models are available", async ({ models }) => {
    host.selectChatModels.mockResolvedValue(models);
    expect(await chooseLanguageModel(describeProvider)).toBe(false);
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining("No VS Code language models"), "OpenAI setup");
    expect(host.pick).not.toHaveBeenCalled();
    expect(host.update).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("offers OpenAI settings when model discovery fails, without selecting a provider", async () => {
    host.selectChatModels.mockRejectedValue(new Error("unavailable"));
    host.warning.mockResolvedValue("OpenAI setup");
    expect(await chooseLanguageModel(describeProvider)).toBe(false);
    expect(host.command).toHaveBeenCalledWith("workbench.action.openSettings", "@ext:FredrikVinkvist.the-downside-up");
    expect(host.update).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    await openAISetup();
    expect(host.command).toHaveBeenCalledTimes(2);
  });

  it("reports an overriding workspace configuration without silently proceeding", async () => {
    host.pick.mockImplementation(async (items) => items[0]);
    host.update.mockResolvedValue(undefined);
    expect(await chooseLanguageModel(() => ({ kind: "vscode-lm", modelId: "" }))).toBe(false);
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining("workspace settings"));
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("configures only the Overview model when review-summary setup is needed", async () => {
    host.pick.mockImplementation(async (items) => items[0]);
    expect(await chooseOverviewModelForSetup(describeOverviewProvider)).toBe(true);
    expect(host.settings).toEqual({ provider: "vscode-lm", "languageModel.overviewModel": "Real model" });
    expect(describeProvider()).toEqual({ kind: "vscode-lm", modelId: "" });
    expect(describeOverviewProvider()).toEqual({ kind: "vscode-lm", modelId: "Real model" });
    expect(host.update.mock.calls).toEqual([
      ["languageModel.overviewModel", "Real model", 1],
      ["provider", "vscode-lm", 1]
    ]);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(host.info).toHaveBeenCalledWith(expect.stringContaining("No Functions model was selected"));
  });
});
