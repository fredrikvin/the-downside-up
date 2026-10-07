import * as assert from "node:assert/strict";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { findFunctionWithEditorTools } from "../../src/languages/vscodeSymbols";
import { buildFileOverview } from "../../src/context/fileOverview";
import type { DownsideUpTestApi } from "../../src/extension";
import { findGoFunction, initializeGoParserAt } from "../../src/languages/go";
import { findRustFunction, initializeRustParserAt } from "../../src/languages/rust";

async function waitFor<T>(
  operation: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 45_000
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let pending = operation();
  while (Date.now() < end) {
    const remaining = end - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolveWait) => {
        timer = setTimeout(() => resolveWait({ done: false }), Math.min(100, remaining));
      })
    ]);
    if (timer) clearTimeout(timer);
    if (!outcome.done) continue;
    if (outcome.value !== undefined) return outcome.value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    pending = operation();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForPanel(): Promise<vscode.Tab> {
  return waitFor(
    async () => vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => tab.label.startsWith("Downside Up:")),
    "Downside Up side-by-side webview"
  );
}

export async function run(): Promise<void> {
  console.log("Downside Up integration tests: activating extension.");
  const extension = vscode.extensions.getExtension("the-downside-up.the-downside-up");
  assert.ok(extension, "The development extension is installed.");
  assert.equal(extension.isActive, false, "The extension starts inactive before a contributed command is run.");

  const rustRoot = resolve(__dirname, "../../fixtures/rust-app");
  const rustFile = resolve(rustRoot, "src/main.rs");
  const rustDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(rustFile));
  const rustEditor = await vscode.window.showTextDocument(rustDocument, vscode.ViewColumn.One);
  await initializeRustParserAt(extension.extensionPath);
  const rustSource = rustDocument.getText();
  const rustOutline = await buildFileOverview(rustDocument, "src/main.rs");
  assert.ok(rustOutline.entries.some((entry) => entry.kindLabel === "Function" && entry.name === "checkout" && entry.explainable));
  assert.deepEqual(
    rustOutline.entries.map((entry) => entry.startLine),
    [...rustOutline.entries.map((entry) => entry.startLine)].sort((left, right) => left - right),
    "Outline entries follow source order."
  );
  const inventoryDocument = await vscode.workspace.openTextDocument(
    vscode.Uri.file(resolve(rustRoot, "src/inventory.rs"))
  );
  const inventoryOutline = await buildFileOverview(inventoryDocument, "src/inventory.rs");
  assert.ok(inventoryOutline.entries.some((entry) => entry.kindLabel === "Struct" && entry.name === "Book"));
  const rustCursor = rustDocument.positionAt(rustSource.indexOf("fn checkout") + 5);
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  assert.ok(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .some((tab) => tab.label === "Downside Up" || tab.label.startsWith("Downside Up:")),
    "The local file preview opens without selecting a function."
  );
  const rustTarget = await findRustFunction(rustDocument, rustCursor);
  console.log("Downside Up integration tests: Rust function lookup completed.");
  const implDocument = await vscode.workspace.openTextDocument({
    language: "rust",
    content: "struct Foo;\nstruct Bar;\nimpl Foo { fn new() -> Self { Foo } }\nimpl Bar { fn new() -> Self { Bar } }\nimpl Default for Foo { fn default() -> Self { Foo } }\n"
  });
  const implNames = await Promise.all([2, 3, 4].map(async (line) => {
    const text = implDocument.lineAt(line).text;
    const column = text.indexOf("fn ") + 4;
    return findRustFunction(implDocument, new vscode.Position(line, column));
  }));
  assert.deepEqual(
    implNames.map((target) => target?.qualifiedName),
    ["Foo::new", "Bar::new", "<Foo as Default>::default"],
    "Methods in different impl blocks have distinct identities."
  );
  assert.equal(new Set(implNames.map((target) => target?.symbolId)).size, 3);
  assert.equal(rustTarget?.name, "checkout");
  assert.equal(rustTarget?.languageId, "rust");
  assert.match(rustTarget?.signature ?? "", /fn checkout/);
  rustEditor.selection = new vscode.Selection(rustCursor, rustCursor);
  await vscode.commands.executeCommand("downsideUp.explainFunction");
  assert.equal(extension.isActive, true, "The contributed command activated the extension.");
  assert.ok(
    (await vscode.commands.getCommands(true)).includes("downsideUp.selectLanguageModel"),
    "The language model picker command is registered."
  );
  console.log("Downside Up integration tests: Rust explanation command completed.");
  const rustPanel = await waitForPanel();
  assert.equal(rustPanel.label, "Downside Up: main.rs");

  const jsRoot = resolve(__dirname, "../../fixtures/js-app");
  const goRoot = resolve(__dirname, "../../fixtures/go-app");
  // VS Code rejects a second folder change in this session, so both folders are added at once.
  assert.ok(vscode.workspace.updateWorkspaceFolders(
    1,
    0,
    { uri: vscode.Uri.file(jsRoot), name: "js-app" },
    { uri: vscode.Uri.file(goRoot), name: "go-app" }
  ), "The JavaScript and Go fixture folders are added.");
  const jsFile = resolve(jsRoot, "src/checkout.js");
  const jsDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(jsFile));
  const jsEditor = await vscode.window.showTextDocument(jsDocument, vscode.ViewColumn.One);
  const jsSource = jsDocument.getText();
  const jsCursor = jsDocument.positionAt(jsSource.indexOf("checkout") + 3);
  const jsTarget = await waitFor(
    () => findFunctionWithEditorTools(jsDocument, jsCursor),
    "built-in JavaScript document symbols"
  );
  console.log("Downside Up integration tests: JavaScript symbol lookup completed.");
  assert.equal(jsTarget.name, "checkout");
  assert.equal(jsTarget.analysis, "vscode-symbols");
  jsEditor.selection = new vscode.Selection(jsCursor, jsCursor);
  await vscode.commands.executeCommand("downsideUp.explainFunction");
  console.log("Downside Up integration tests: JavaScript explanation command completed.");
  const jsPanel = await waitForPanel();
  assert.equal(jsPanel.label, "Downside Up: checkout.js");

  const racingRustEditor = await vscode.window.showTextDocument(rustDocument, vscode.ViewColumn.One);
  racingRustEditor.selection = new vscode.Selection(rustCursor, rustCursor);
  const olderRequest = vscode.commands.executeCommand("downsideUp.explainFunction");
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));

  const otherCursor = jsDocument.positionAt(jsSource.indexOf("describeCatalog") + 5);
  const otherTarget = await waitFor(
    () => findFunctionWithEditorTools(jsDocument, otherCursor),
    "second JavaScript function symbol"
  );
  assert.equal(otherTarget.name, "describeCatalog");
  const racingJsEditor = await vscode.window.showTextDocument(jsDocument, vscode.ViewColumn.One);
  racingJsEditor.selection = new vscode.Selection(otherCursor, otherCursor);
  const newerRequest = vscode.commands.executeCommand("downsideUp.explainFunction");
  await Promise.all([olderRequest, newerRequest]);
  const finalPanel = await waitForPanel();
  assert.equal(finalPanel.label, "Downside Up: checkout.js", "The newer request's file is shown.");

  const api = extension.exports as DownsideUpTestApi | undefined;
  assert.ok(api, "Read-only test hooks are available in extension test mode.");
  await vscode.window.tabGroups.close(finalPanel);
  await waitFor(
    async () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .some((tab) => tab.label.startsWith("Downside Up")) ? undefined : true,
    "the preview to close"
  );
  assert.deepEqual(api.previewExplanations(), [], "Closing the preview clears in-memory explanation state.");
  await vscode.window.showTextDocument(jsDocument, vscode.ViewColumn.One);
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  const reopened = await waitFor(async () => {
    const views = api.previewExplanations();
    const ready = views.filter((view) => view.status === "current").map((view) => view.functionName);
    return ready.includes("checkout") && ready.includes("describeCatalog") ? views : undefined;
  }, "saved explanations listed as ready after reopening the preview");
  assert.ok(reopened.every((view) => !view.expanded), "Saved explanations are listed collapsed, not opened.");
  console.log("Downside Up integration tests: saved explanations listed after reopening the preview.");

  const goDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(goRoot, "main.go")));
  await waitFor(
    async () => vscode.workspace.getWorkspaceFolder(goDocument.uri) ? true : undefined,
    "the Go workspace folder"
  );
  await initializeGoParserAt(extension.extensionPath);
  const lookupDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(goRoot, "inventory/lookup.go")));
  const methodTarget = await findGoFunction(
    lookupDocument,
    lookupDocument.positionAt(lookupDocument.getText().indexOf(") FindAvailable(") + 4)
  );
  assert.equal(methodTarget?.qualifiedName, "Catalog.FindAvailable", "Go methods are named by receiver type.");
  assert.equal(methodTarget?.analysis, "go-tree-sitter", "Go discovery does not need a language server.");
  const goEditor = await vscode.window.showTextDocument(goDocument, vscode.ViewColumn.One);
  const goCursor = goDocument.positionAt(goDocument.getText().indexOf("func checkout") + 6);
  goEditor.selection = new vscode.Selection(goCursor, goCursor);
  await vscode.commands.executeCommand("downsideUp.explainFunction");
  await waitFor(
    async () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .some((tab) => tab.label === "Downside Up: main.go") ? true : undefined,
    "the Go preview"
  );
  await waitFor(
    async () => api.previewExplanations()
      .some((view) => view.functionName === "checkout" && view.status === "current") ? true : undefined,
    "the Go explanation in the preview outline"
  );
  console.log("Downside Up integration tests: Go explanation command completed.");

  const downsideUpSettings = vscode.workspace.getConfiguration("downsideUp");
  await downsideUpSettings.update("prefetch.window", 1, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.dependencies", 0, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.enabled", true, vscode.ConfigurationTarget.Global);
  const statusOf = (name: string) => api.previewExplanations().find((view) => view.functionName === name);
  const prefetchEditor = await vscode.window.showTextDocument(lookupDocument, vscode.ViewColumn.One);
  const lineOf = (text: string) => lookupDocument.positionAt(lookupDocument.getText().indexOf(text)).line;
  prefetchEditor.selection = new vscode.Selection(lineOf(") FindAvailable("), 0, lineOf(") FindAvailable("), 0);
  await waitFor(
    async () => statusOf("Catalog.FindAvailable")?.status === "current" ? true : undefined,
    "the function nearest the cursor to be prefetched"
  );
  assert.equal(statusOf("Catalog.FindAvailable")?.expanded, false, "Prefetched explanations stay collapsed.");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  assert.equal(statusOf("Catalog.MarkUnavailable"), undefined, "Functions outside the prefetch window are not requested.");
  prefetchEditor.selection = new vscode.Selection(lineOf(") MarkUnavailable("), 0, lineOf(") MarkUnavailable("), 0);
  await waitFor(
    async () => statusOf("Catalog.MarkUnavailable")?.status === "current" ? true : undefined,
    "the prefetch window to follow the cursor"
  );
  console.log("Downside Up integration tests: prefetching followed the reader.");

  const hoverText = async (document: vscode.TextDocument, needle: string, offset: number): Promise<string> => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      document.positionAt(document.getText().indexOf(needle) + offset)
    ) ?? [];
    return hovers.flatMap((hover) => hover.contents)
      .map((content) => typeof content === "string" ? content : content.value)
      .join("\n");
  };
  const savedHover = await hoverText(goDocument, "catalog.FindAvailable(", "catalog.".length + 2);
  assert.match(savedHover, /Downside Up/, "Hovering a call shows its saved explanation.");
  assert.match(savedHover, /Catalog\.FindAvailable/);
  assert.doesNotMatch(
    await hoverText(goDocument, "storage.Persist(", "storage.".length + 2),
    /Downside Up/,
    "Hovering a call without a saved explanation shows nothing and generates nothing."
  );
  assert.equal(
    api.allExplanations().some((view) => view.functionName === "Persist"),
    false,
    "Hovering did not request an explanation."
  );

  await downsideUpSettings.update("prefetch.dependencies", 3, vscode.ConfigurationTarget.Global);
  const readingEditor = await vscode.window.showTextDocument(goDocument, vscode.ViewColumn.One);
  const checkoutLine = goDocument.positionAt(goDocument.getText().indexOf("func checkout")).line + 2;
  readingEditor.selection = new vscode.Selection(checkoutLine, 0, checkoutLine, 0);
  await waitFor(
    async () => api.allExplanations()
      .some((view) => view.functionName === "Persist" && view.path.endsWith("storage/storage.go") && view.status === "current")
      ? true : undefined,
    "a function called from another package to be prefetched"
  );
  assert.match(
    await hoverText(goDocument, "storage.Persist(", "storage.".length + 2),
    /Downside Up/,
    "The prefetched function's explanation now shows on hover."
  );
  await downsideUpSettings.update("prefetch.enabled", undefined, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.window", undefined, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.dependencies", undefined, vscode.ConfigurationTarget.Global);
  console.log("Downside Up integration tests: other-file prefetching and saved-explanation hovers work.");

  const legacyDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(goRoot, "legacy/legacy.go")));
  const legacyEditor = await vscode.window.showTextDocument(legacyDocument, vscode.ViewColumn.One);
  const rateCursor = legacyDocument.positionAt(legacyDocument.getText().indexOf("func Rate") + 6);
  legacyEditor.selection = new vscode.Selection(rateCursor, rateCursor);
  await vscode.commands.executeCommand("downsideUp.explainFunction");
  const refused = await waitFor(
    async () => api.allExplanations().find((view) => view.functionName === "Rate" && view.status === "failed"),
    "an explanation request for a .copilotignore'd file to be refused"
  );
  assert.match(refused.error ?? "", /excluded from AI explanations because a \.gitignore or \.copilotignore file excludes it/);
  console.log("Downside Up integration tests: excluded files are never explained.");

  const unsupported = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: "an arbitrary block"
  });
  const unsupportedEditor = await vscode.window.showTextDocument(unsupported);
  unsupportedEditor.selection = new vscode.Selection(0, 2, 0, 2);
  const unsupportedTarget = await findFunctionWithEditorTools(
    unsupported,
    unsupportedEditor.selection.active
  );
  assert.equal(unsupportedTarget, undefined, "Plain text has no guessable function symbol.");
  assert.equal(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.label.startsWith("Downside Up:")).length,
    1,
    "Unsupported plaintext discovery did not open another explanation."
  );
}
