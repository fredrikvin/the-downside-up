import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prefetchOnboarding } from "../src/presentation/prefetchOnboarding";

const ui = vi.hoisted(() => ({
  inspect: vi.fn(),
  update: vi.fn(),
  showInformationMessage: vi.fn()
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration: () => ({ inspect: ui.inspect, update: ui.update }) },
  window: { showInformationMessage: ui.showInformationMessage }
}));

function savedState(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); })
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  ui.inspect.mockReturnValue({ globalValue: undefined });
});

describe("first-preview prefetch onboarding", () => {
  it("enables only the user setting after an explicit choice, without granting sharing", async () => {
    ui.showInformationMessage.mockResolvedValue("Enable prefetch");
    await prefetchOnboarding(savedState())();
    expect(ui.showInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/quota or billing.*sharing is approved for the repository and model/),
      "Enable prefetch", "Not now"
    );
    expect(ui.update).toHaveBeenCalledExactlyOnceWith("prefetch.enabled", true, 1);
  });

  it.each(["Not now", undefined])("remembers dismissal (%s) across sessions without enabling", async (answer) => {
    const state = savedState();
    ui.showInformationMessage.mockResolvedValue(answer);
    await prefetchOnboarding(state)();
    await prefetchOnboarding(state)();
    expect(ui.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(ui.update).not.toHaveBeenCalled();
  });

  it.each([true, false])("respects an existing explicit user choice (%s)", async (enabled) => {
    ui.inspect.mockReturnValue({ globalValue: enabled });
    await prefetchOnboarding(savedState())();
    expect(ui.showInformationMessage).not.toHaveBeenCalled();
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("does not show duplicate prompts for concurrent preview openings", async () => {
    const offer = prefetchOnboarding(savedState());
    await Promise.all([offer(), offer()]);
    expect(ui.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a setting changed while the prompt was open", async () => {
    ui.showInformationMessage.mockImplementation(async () => {
      ui.inspect.mockReturnValue({ globalValue: false });
      return "Enable prefetch";
    });
    await prefetchOnboarding(savedState())();
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("propagates persistence errors to the host error handler", async () => {
    ui.showInformationMessage.mockResolvedValue("Enable prefetch");
    ui.update.mockRejectedValue(new Error("Settings are read-only"));
    await expect(prefetchOnboarding(savedState())()).rejects.toThrow("Settings are read-only");
  });
});
