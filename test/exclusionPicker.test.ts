import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { chooseExclusionFile, chooseExclusionFolder } from "../src/presentation/exclusionPicker";
import { exclusionWizardHtml, type ExclusionRole } from "../src/presentation/exclusionWizard";
import { workspace } from "./vscode";

const ui = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  createWebviewPanel: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  update: vi.fn()
}));

vi.mock("vscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vscode")>();
  return {
    ...original,
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { Active: -1 },
    window: ui,
    workspace: {
      ...original.workspace,
      getConfiguration: (section?: string) => ({
        ...original.workspace.getConfiguration(section),
        update: ui.update
      })
    }
  };
});

let folder: string;
type WizardAction = { file?: string; direction?: "next" | "back" | "save" | "cancel" | "close"; invalid?: boolean; duplicate?: boolean };
let wizardActions: WizardAction[];
interface WizardState {
  step: number;
  revision: number;
  names: string[];
  roles: ExclusionRole[];
  selected: number;
  assignments: number[];
}
let wizardViews: WizardState[];
const settings = ["blockedFilePatternsFile", "restrictedRemotesFile", "allowedRepositoriesFile"] as const;

beforeEach(async () => {
  vi.resetAllMocks();
  workspace.__resetConfiguration();
  wizardActions = [];
  wizardViews = [];
  ui.createWebviewPanel.mockImplementation(() => {
    const handlers = new Map<string, (value?: unknown) => void>();
    const listen = (event: string, handler: (value?: unknown) => void) => {
      handlers.set(event, handler);
      return { dispose: () => handlers.delete(event) };
    };
    const panel = {
      onDidDispose: (handler: () => void) => listen("dispose", handler),
      dispose: vi.fn(() => handlers.get("dispose")?.()),
      webview: {
        set html(_value: string) { queueMicrotask(() => handlers.get("message")?.({ action: "ready" })); },
        onDidReceiveMessage: (handler: (value?: unknown) => void) => listen("message", handler),
        postMessage: (state: WizardState) => {
          const snapshot = structuredClone(state);
          queueMicrotask(() => {
            wizardViews.push(snapshot);
            const action = wizardActions.shift() ?? { direction: "cancel" };
            if (action.direction === "close") { handlers.get("dispose")?.(); return; }
            const message = {
              action: action.direction,
              revision: snapshot.revision,
              selected: action.file ? snapshot.names.indexOf(action.file) + 1 : 0
            };
            if (action.invalid) {
              for (const invalid of [null, {}, { ...message, revision: -1 }, { ...message, selected: -1 },
                { ...message, selected: 1.5 }, { ...message, selected: snapshot.names.length + 1 },
                { ...message, selected: "../escape" }, { ...message, action: "save" }]) {
                handlers.get("message")?.(invalid);
              }
            }
            if (snapshot.step < 3) {
              expect(ui.update).not.toHaveBeenCalled();
            }
            handlers.get("message")?.(message);
            if (action.duplicate) handlers.get("message")?.(message);
          });
          return Promise.resolve(true);
        }
      }
    };
    return panel;
  });
  folder = await mkdtemp(resolve(tmpdir(), "downside-up-policy-picker-"));
});

afterEach(async () => {
  workspace.__resetConfiguration();
  await rm(folder, { recursive: true, force: true });
});

describe("exclusion file pickers", () => {
  it.each(settings)("writes %s only to user settings, with a native single-file picker", async (setting) => {
    const path = resolve(folder, "my policy.rules");
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(path)]);
    await chooseExclusionFile(setting);
    expect(ui.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false
    }));
    expect(ui.update).toHaveBeenCalledExactlyOnceWith(`exclusion.${setting}`, path, vscode.ConfigurationTarget.Global);
    expect(ui.showErrorMessage).not.toHaveBeenCalled();
  });

  it("starts at the current user path, expands tilde, and ignores workspace values", async () => {
    workspace.__setConfiguration("downsideUp.exclusion.blockedFilePatternsFile", "~/policies/blocks");
    workspace.__setConfiguration("workspace:downsideUp.exclusion.blockedFilePatternsFile", "/workspace/other");
    ui.showOpenDialog.mockResolvedValue(undefined);
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.showOpenDialog.mock.calls[0]![0].defaultUri.fsPath).toBe(resolve(homedir(), "policies/blocks"));
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("leaves settings unchanged on cancellation or an empty selection", async () => {
    for (const selection of [undefined, []]) {
      ui.showOpenDialog.mockResolvedValue(selection);
      await chooseExclusionFile("restrictedRemotesFile");
      expect(ui.update).not.toHaveBeenCalled();
    }
  });

  it("rejects nonlocal selection and surfaces dialog and settings-write errors", async () => {
    ui.showOpenDialog.mockResolvedValue([{ scheme: "https", fsPath: "/not-local" }]);
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.update).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("local policy file"));
    ui.showOpenDialog.mockRejectedValueOnce(new Error("Dialog unavailable"));
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Dialog unavailable"));
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(resolve(folder, "rules"))]);
    ui.update.mockRejectedValueOnce(new Error("Settings are read-only"));
    await chooseExclusionFile("blockedFilePatternsFile");
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Settings are read-only"));
  });
});

describe("exclusion folder picker", () => {
  async function files() {
    await writeFile(resolve(folder, "blocks.rules"), "private/**");
    await writeFile(resolve(folder, "remotes.rules"), "ssh://example.invalid/");
    await writeFile(resolve(folder, "allowed.rules"), "team/app");
    await mkdir(resolve(folder, "subfolder"));
    await writeFile(resolve(folder, "subfolder", "nested.rules"), "not listed");
    await symlink(resolve(folder, "blocks.rules"), resolve(folder, "linked.rules"));
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(folder)]);
  }

  it("assigns arbitrary filenames after collecting all choices, with no recursive listing", async () => {
    await files();
    const picked = ["blocks.rules", "remotes.rules", "allowed.rules"];
    wizardActions = [...picked.map((file) => ({ file, direction: "next" as const })), { direction: "save" }];
    await chooseExclusionFolder();
    expect(ui.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    }));
    expect(ui.update.mock.calls).toEqual(settings.map((setting, index) => [
      `exclusion.${setting}`, resolve(folder, picked[index]!), vscode.ConfigurationTarget.Global
    ]));
    expect(wizardViews.map((view) => view.step)).toEqual([0, 1, 2, 3]);
    expect(wizardViews[0]!.names).toEqual(["allowed.rules", "blocks.rules", "remotes.rules"]);
    expect(wizardViews[0]!.roles.map((role) => role.hint)).toEqual([
      expect.stringContaining("*.vault"), expect.stringContaining("ssh://"), expect.stringContaining("team/app")
    ]);
    expect(wizardViews[3]!.assignments).toEqual([2, 3, 1]);
    expect(ui.createWebviewPanel).toHaveBeenCalledWith(
      "theDownsideUp.exclusionSetup", "Content-exclusion files", vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
    );
  });

  it("preserves skipped settings", async () => {
    await files();
    wizardActions = [{ direction: "next" }, { file: "remotes.rules", direction: "next" }, { direction: "next" }, { direction: "save" }];
    await chooseExclusionFolder();
    expect(ui.update).toHaveBeenCalledExactlyOnceWith("exclusion.restrictedRemotesFile", resolve(folder, "remotes.rules"), vscode.ConfigurationTarget.Global);
  });

  it("does not write any setting if assignment is cancelled midway", async () => {
    await files();
    wizardActions = [{ file: "blocks.rules", direction: "next" }, { direction: "cancel" }];
    await chooseExclusionFolder();
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("handles a cancelled picker and an empty folder without changing settings", async () => {
    ui.showOpenDialog.mockResolvedValueOnce(undefined);
    await chooseExclusionFolder();
    expect(ui.createWebviewPanel).not.toHaveBeenCalled();
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(folder)]);
    await chooseExclusionFolder();
    expect(ui.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("no regular files"));
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("surfaces unreadable-directory errors", async () => {
    ui.showOpenDialog.mockResolvedValue([vscode.Uri.file(resolve(folder, "missing"))]);
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Could not configure"));
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("rejects nonlocal folders and reports failed settings writes", async () => {
    ui.showOpenDialog.mockResolvedValue([{ scheme: "https", fsPath: "/not-local" }]);
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("local policy folder"));
    expect(ui.createWebviewPanel).not.toHaveBeenCalled();
    await files();
    wizardActions = settings.map(() => ({ file: "allowed.rules", direction: "next" }));
    wizardActions.push({ direction: "save" });
    ui.update.mockRejectedValueOnce(new Error("Settings are read-only"));
    await chooseExclusionFolder();
    expect(ui.showErrorMessage).toHaveBeenLastCalledWith(expect.stringContaining("Settings are read-only"));
    expect(ui.update).toHaveBeenCalledTimes(1);
  });

  it("supports Back from assignment and review screens and remembers choices", async () => {
    await files();
    wizardActions = [
      { file: "blocks.rules", direction: "next" },
      { file: "blocks.rules", direction: "back" },
      { file: "allowed.rules", direction: "next" },
      { file: "remotes.rules", direction: "next" },
      { direction: "next" },
      { direction: "back" },
      { file: "blocks.rules", direction: "next" },
      { direction: "save" }
    ];
    await chooseExclusionFolder();
    expect(wizardViews.map((view) => view.step)).toEqual([0, 1, 0, 1, 2, 3, 2, 3]);
    expect(wizardViews[2]!.selected).toBe(2);
    expect(wizardViews[3]!.selected).toBe(2);
    expect(ui.update.mock.calls).toEqual([
      ["exclusion.blockedFilePatternsFile", resolve(folder, "allowed.rules"), vscode.ConfigurationTarget.Global],
      ["exclusion.restrictedRemotesFile", resolve(folder, "remotes.rules"), vscode.ConfigurationTarget.Global],
      ["exclusion.allowedRepositoriesFile", resolve(folder, "blocks.rules"), vscode.ConfigurationTarget.Global]
    ]);
  });

  it("leaves settings untouched if the final review is cancelled", async () => {
    await files();
    wizardActions = settings.map(() => ({ file: "blocks.rules", direction: "next" }));
    wizardActions.push({ direction: "cancel" });
    await chooseExclusionFolder();
    expect(wizardViews).toHaveLength(4);
    expect(ui.update).not.toHaveBeenCalled();
  });

  it("ignores invalid assignments and duplicate navigation messages", async () => {
    await files();
    wizardActions = [
      { file: "blocks.rules", direction: "next", invalid: true, duplicate: true },
      { direction: "next" }, { direction: "next" }, { direction: "save", duplicate: true }
    ];
    await chooseExclusionFolder();
    expect(wizardViews.map((view) => view.step)).toEqual([0, 1, 2, 3]);
    expect(ui.update).toHaveBeenCalledExactlyOnceWith(
      "exclusion.blockedFilePatternsFile", resolve(folder, "blocks.rules"), vscode.ConfigurationTarget.Global
    );
  });

  it("leaves settings untouched when the panel is closed", async () => {
    await files();
    wizardActions = [{ file: "blocks.rules", direction: "next" }, { direction: "close" }];
    await chooseExclusionFolder();
    expect(ui.update).not.toHaveBeenCalled();
  });
});

describe("exclusion setup webview", () => {
  it("uses radio choices without a textbox and keeps a restrictive content policy", () => {
    const html = exclusionWizardHtml("test-nonce");
    expect(html).toContain('radio.type = "radio"');
    expect(html).not.toMatch(/type=["'](?:text|search)|createQuickPick|placeholder|innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
    expect(html).toContain("default-src 'none'; style-src 'nonce-test-nonce'; script-src 'nonce-test-nonce';");
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script nonce="test-nonce">']);
    expect(html).toContain('text.textContent = name');
    expect(html).toContain('byId("next").disabled = true');
    expect(html).toContain('if (!state || pending) return');
  });

  it("renders file choices and review as text, remembers choices, and sends navigation once", () => {
    class Element {
      children: Element[] = [];
      textContent = "";
      type = "";
      name = "";
      checked = false;
      disabled = false;
      className = "";
      handlers = new Map<string, () => void>();
      focus = vi.fn();
      constructor(readonly tag: string) {}
      append(...children: Element[]) { this.children.push(...children); }
      replaceChildren() { this.children = []; }
      addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler); }
      trigger(event: string) { this.handlers.get(event)?.(); }
      elements(): Element[] { return [this, ...this.children.flatMap((child) => child.elements())]; }
    }
    const elements = new Map<string, Element>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id)!;
    };
    const postMessage = vi.fn();
    let render: (event: { data: WizardState }) => void = () => { throw new Error("No render handler registered"); };
    const html = exclusionWizardHtml("test");
    const start = html.indexOf('<script nonce="test">') + '<script nonce="test">'.length;
    new Function("acquireVsCodeApi", "document", "window", html.slice(start, html.indexOf("</script>", start)))(
      () => ({ postMessage }),
      { getElementById: element, createElement: (tag: string) => new Element(tag) },
      { addEventListener: (_event: string, handler: typeof render) => { render = handler; } }
    );
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ action: "ready" });
    const filename = "<img src=x onerror=alert(1)>.rules";
    const state: WizardState = {
      step: 0, revision: 0, names: [filename], selected: 0, assignments: [0, 0, 0],
      roles: settings.map((setting) => ({ title: `Choose ${setting}`, hint: "Expected contents", current: "/current/file" }))
    };
    render({ data: state });
    const choices = element("choices").elements();
    const radios = choices.filter((choice) => choice.tag === "input");
    expect(radios.map((radio) => radio.type)).toEqual(["radio", "radio"]);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(choices.some((choice) => choice.textContent === filename)).toBe(true);
    expect(element("back").disabled).toBe(true);
    expect(element("hint").textContent).toContain("Expected contents");
    radios[1]!.trigger("change");
    expect(postMessage).toHaveBeenCalledTimes(1);
    element("next").trigger("click");
    element("next").trigger("click");
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ action: "next", revision: 0, selected: 1 });
    expect(element("next").disabled).toBe(true);
    render({ data: { ...state, step: 1, revision: 1, selected: 1 } });
    expect(element("choices").elements().filter((choice) => choice.tag === "input").map((radio) => radio.checked)).toEqual([false, true]);
    element("back").trigger("click");
    expect(postMessage).toHaveBeenLastCalledWith({ action: "back", revision: 1, selected: 1 });
    render({ data: { ...state, step: 3, revision: 2, assignments: [1, 0, 0] } });
    expect(element("choices").elements().filter((choice) => choice.tag === "input")).toEqual([]);
    expect(element("choices").elements().filter((choice) => choice.tag === "dd").map((choice) => choice.textContent)).toEqual([
      filename, "Keep current setting: /current/file", "Keep current setting: /current/file"
    ]);
    expect(element("next").textContent).toBe("Save");
    element("next").trigger("click");
    expect(postMessage).toHaveBeenLastCalledWith({ action: "save", revision: 2, selected: 0 });
    render({ data: { ...state, revision: 3 } });
    element("cancel").trigger("click");
    expect(postMessage).toHaveBeenLastCalledWith({ action: "cancel", revision: 3, selected: 0 });
  });
});
