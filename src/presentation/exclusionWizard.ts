import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export interface ExclusionRole {
  readonly title: string;
  readonly hint: string;
  readonly current: string;
}

export function exclusionWizardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Content-exclusion files</title>
  <style nonce="${nonce}">
    body { max-width: 720px; margin: 0 auto; padding: 24px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    h1 { font-size: 1.4em; }
    #progress, .detail { color: var(--vscode-descriptionForeground); }
    fieldset { border: 0; padding: 0; margin: 20px 0; }
    legend { margin-bottom: 12px; }
    label { display: flex; align-items: baseline; gap: 10px; padding: 10px; cursor: pointer; overflow-wrap: anywhere; }
    label:hover { background: var(--vscode-list-hoverBackground); }
    input { accent-color: var(--vscode-focusBorder); }
    .detail { display: block; margin-top: 4px; }
    dl { margin: 24px 0; }
    dt { font-weight: bold; margin-top: 20px; }
    dd { margin: 6px 0; overflow-wrap: anywhere; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
    button { border: 1px solid var(--vscode-button-border, transparent); padding: 6px 14px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: .5; cursor: default; }
    :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <p id="progress" aria-live="polite"></p>
    <h1 id="title" tabindex="-1">Content-exclusion files</h1>
    <p id="hint"></p>
    <div id="choices"></div>
    <nav aria-label="Setup navigation">
      <button id="back" class="secondary" type="button" disabled>Back</button>
      <button id="next" type="button" disabled>Next</button>
      <button id="cancel" class="secondary" type="button">Cancel</button>
    </nav>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    let state;
    let selected = 0;
    let pending = false;
    function send(action) {
      if (!state || pending) return;
      pending = true;
      byId("back").disabled = true;
      byId("next").disabled = true;
      vscode.postMessage({ action, revision: state.revision, selected });
    }
    byId("back").addEventListener("click", () => send("back"));
    byId("next").addEventListener("click", () => send(state.step === 3 ? "save" : "next"));
    byId("cancel").addEventListener("click", () => send("cancel"));
    window.addEventListener("message", (event) => {
      state = event.data;
      pending = false;
      selected = state.selected;
      byId("progress").textContent = "Step " + (state.step + 1) + " of 4";
      byId("title").textContent = state.step === 3 ? "Review content-exclusion files" : state.roles[state.step].title;
      byId("hint").textContent = state.step === 3
        ? "Review all three assignments. Use Back to correct them, or Save to apply them to user settings."
        : state.roles[state.step].hint + ". Select a file, then choose Next.";
      byId("back").disabled = state.step === 0;
      byId("next").disabled = false;
      byId("next").textContent = state.step === 3 ? "Save" : "Next";
      const choices = byId("choices");
      choices.replaceChildren();
      if (state.step === 3) {
        const list = document.createElement("dl");
        state.roles.forEach((role, index) => {
          const term = document.createElement("dt");
          term.textContent = role.title.replace("Choose ", "");
          const description = document.createElement("dd");
          description.textContent = state.assignments[index] === 0
            ? "Keep current setting: " + role.current
            : state.names[state.assignments[index] - 1];
          list.append(term, description);
        });
        choices.append(list);
      } else {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = "Policy file";
        group.append(legend);
        ["Keep current setting", ...state.names].forEach((name, index) => {
          const label = document.createElement("label");
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "policy-file";
          radio.checked = index === selected;
          radio.addEventListener("change", () => { selected = index; });
          const text = document.createElement("span");
          text.textContent = name;
          if (index === 0) {
            const detail = document.createElement("span");
            detail.className = "detail";
            detail.textContent = state.roles[state.step].current;
            text.append(detail);
          }
          label.append(radio, text);
          group.append(label);
        });
        choices.append(group);
      }
      byId("title").focus();
    });
    vscode.postMessage({ action: "ready" });
  </script>
</body>
</html>`;
}

export function chooseExclusionAssignments(
  roles: readonly ExclusionRole[],
  names: readonly string[]
): Promise<readonly number[] | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "theDownsideUp.exclusionSetup",
    "Content-exclusion files",
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
  );
  return new Promise((resolve) => {
    const assignments = roles.map(() => 0);
    let step = 0;
    let revision = 0;
    let finished = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (result: readonly number[] | undefined) => {
      if (finished) return;
      finished = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      panel.dispose();
      resolve(result);
    };
    const render = () => {
      void panel.webview.postMessage({ roles, names, assignments, step, revision, selected: assignments[step] ?? 0 });
    };
    subscriptions.push(
      panel.onDidDispose(() => finish(undefined)),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (typeof message !== "object" || message === null || !("action" in message)) return;
        if (message.action === "ready") { render(); return; }
        if (!("revision" in message) || message.revision !== revision) return;
        if (message.action === "cancel") { finish(undefined); return; }
        if (message.action === "save" && step === roles.length) { finish([...assignments]); return; }
        if (message.action !== "back" && message.action !== "next") return;
        if (message.action === "back" && step === 0) return;
        if (step < roles.length) {
          if (!("selected" in message) || typeof message.selected !== "number"
            || !Number.isInteger(message.selected) || message.selected < 0 || message.selected > names.length) return;
          assignments[step] = message.selected;
        } else if (message.action === "next") return;
        step += message.action === "back" ? -1 : 1;
        revision++;
        render();
      })
    );
    panel.webview.html = exclusionWizardHtml(randomBytes(24).toString("hex"));
  });
}
