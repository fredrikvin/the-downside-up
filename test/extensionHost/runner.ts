import * as assert from "node:assert/strict";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { findFunctionWithEditorTools } from "../../src/languages/vscodeSymbols";
import { buildFileOverview } from "../../src/context/fileOverview";
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
      .find((tab) => tab.label.startsWith("Code Shadow:")),
    "Code Shadow side-by-side webview"
  );
}

export async function run(): Promise<void> {
  console.log("Code Shadow integration tests: activating extension.");
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
      .some((tab) => tab.label === "Code Shadow" || tab.label.startsWith("Code Shadow:")),
    "The local file preview opens without selecting a function."
  );
  const rustTarget = await findRustFunction(rustDocument, rustCursor);
  console.log("Code Shadow integration tests: Rust function lookup completed.");
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
  console.log("Code Shadow integration tests: Rust explanation command completed.");
  const rustPanel = await waitForPanel();
  assert.equal(rustPanel.label, "Code Shadow: main.rs");

  const jsRoot = resolve(__dirname, "../../fixtures/js-app");
  vscode.workspace.updateWorkspaceFolders(1, 0, {
    uri: vscode.Uri.file(jsRoot),
    name: "js-app"
  });
  const jsFile = resolve(jsRoot, "src/checkout.js");
  const jsDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(jsFile));
  const jsEditor = await vscode.window.showTextDocument(jsDocument, vscode.ViewColumn.One);
  const jsSource = jsDocument.getText();
  const jsCursor = jsDocument.positionAt(jsSource.indexOf("checkout") + 3);
  const jsTarget = await waitFor(
    () => findFunctionWithEditorTools(jsDocument, jsCursor),
    "built-in JavaScript document symbols"
  );
  console.log("Code Shadow integration tests: JavaScript symbol lookup completed.");
  assert.equal(jsTarget.name, "checkout");
  assert.equal(jsTarget.analysis, "vscode-symbols");
  jsEditor.selection = new vscode.Selection(jsCursor, jsCursor);
  await vscode.commands.executeCommand("downsideUp.explainFunction");
  console.log("Code Shadow integration tests: JavaScript explanation command completed.");
  const jsPanel = await waitForPanel();
  assert.equal(jsPanel.label, "Code Shadow: checkout.js");

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
  assert.equal(finalPanel.label, "Code Shadow: checkout.js", "The newer request's file is shown.");

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
      .filter((tab) => tab.label.startsWith("Code Shadow:")).length,
    1,
    "Unsupported plaintext discovery did not open another explanation."
  );
}
