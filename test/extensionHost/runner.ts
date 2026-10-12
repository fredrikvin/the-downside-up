import * as assert from "node:assert/strict";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { findFunctionWithEditorTools } from "../../src/languages/editor/symbols";
import { buildFileOverview } from "../../src/context/fileOverview";
import { findRepositoryRoot, gatherInventory } from "../../src/context/inventory";
import { findCalledFunctions, gatherFunctionContext } from "../../src/context/related";
import { javascriptSupport } from "../../src/languages/javascript";
import type { DownsideUpTestApi } from "../../src/extension";
import { findGoFunction, initializeGoParserAt } from "../../src/languages/go/syntax";
import { findRustFunction, initializeRustParserAt } from "../../src/languages/rust/syntax";

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

async function findFunctionTarget(document: vscode.TextDocument, position: vscode.Position) {
  return javascriptSupport.findFunction(document, position);
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
  await javascriptSupport.initialize!(extension.extensionPath);
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
  rustEditor.selection = new vscode.Selection(rustCursor, rustCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  assert.equal(extension.isActive, true, "The contributed command activated the extension.");
  assert.ok(
    (await vscode.commands.getCommands(true)).includes("downsideUp.selectLanguageModel"),
    "The language model picker command is registered."
  );
  console.log("Downside Up integration tests: Rust explanation from a selection completed.");
  const rustPanel = await waitForPanel();
  assert.equal(rustPanel.label, "Downside Up: main.rs");

  const jsRoot = resolve(__dirname, "../../fixtures/js-app");
  const goRoot = resolve(__dirname, "../../fixtures/go-app");
  const reactRoot = resolve(__dirname, "../../fixtures/react-app");
  // VS Code rejects a second folder change in this session, so all folders are added at once.
  assert.ok(vscode.workspace.updateWorkspaceFolders(
    1,
    0,
    { uri: vscode.Uri.file(jsRoot), name: "js-app" },
    { uri: vscode.Uri.file(goRoot), name: "go-app" },
    { uri: vscode.Uri.file(reactRoot), name: "react-app" }
  ), "The JavaScript, Go, and React fixture folders are added.");
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
  jsEditor.selection = new vscode.Selection(jsCursor, jsCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  console.log("Downside Up integration tests: JavaScript explanation from a selection completed.");
  const jsPanel = await waitForPanel();
  assert.equal(jsPanel.label, "Downside Up: checkout.js");

  const racingRustEditor = await vscode.window.showTextDocument(rustDocument, vscode.ViewColumn.One);
  racingRustEditor.selection = new vscode.Selection(rustCursor, rustCursor.translate(0, 1));
  const olderRequest = vscode.commands.executeCommand("downsideUp.showFileOverview");
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));

  const otherCursor = jsDocument.positionAt(jsSource.indexOf("describeCatalog") + 5);
  const otherTarget = await waitFor(
    () => findFunctionWithEditorTools(jsDocument, otherCursor),
    "second JavaScript function symbol"
  );
  assert.equal(otherTarget.name, "describeCatalog");
  const racingJsEditor = await vscode.window.showTextDocument(jsDocument, vscode.ViewColumn.One);
  racingJsEditor.selection = new vscode.Selection(otherCursor, otherCursor.translate(0, 1));
  const newerRequest = vscode.commands.executeCommand("downsideUp.showFileOverview");
  await Promise.all([olderRequest, newerRequest]);
  const finalPanel = await waitForPanel();
  assert.equal(finalPanel.label, "Downside Up: checkout.js", "The newer request's file is shown.");

  const api = extension.exports as DownsideUpTestApi | undefined;
  assert.ok(api, "Read-only test hooks are available in extension test mode.");
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
  assert.ok(
    reopened.filter((view) => view.status === "current").every((view) => view.expanded),
    "Current saved explanations open by default, like a document."
  );
  assert.deepEqual(
    api.shownOutline().map((entry) => entry.kindLabel),
    ["Function", "Function"],
    "The concise preview lists only functions."
  );
  await waitFor(
    async () => api.fileSummary()?.current ? true : undefined,
    "the AI file summary made after explaining a function in the file"
  );
  console.log("Downside Up integration tests: saved explanations listed after reopening the preview.");

  const jsRepository = await findRepositoryRoot(jsRoot);
  const jsCalled = await waitFor(async () => {
    const called = await findCalledFunctions(jsTarget, jsDocument, await gatherInventory(jsRepository));
    return called.some((entry) => entry.qualifiedName === "persist") ? called : undefined;
  }, "the JavaScript call to persist resolved by go-to-definition");
  assert.deepEqual(
    jsCalled.map((entry) => `${entry.path.split("/").slice(-2).join("/")} ${entry.qualifiedName}`),
    ["src/storage.js persist"],
    "Calls into the standard library are not followed."
  );
  assert.doesNotMatch(
    await hoverText(jsDocument, "persist(book)", 2),
    /Downside Up/,
    "Hovering a JavaScript call without a saved explanation shows nothing."
  );
  const storageDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(jsRoot, "src/storage.js")));
  const storageEditor = await vscode.window.showTextDocument(storageDocument, vscode.ViewColumn.One);
  const persistCursor = storageDocument.positionAt(storageDocument.getText().indexOf("persist") + 2);
  storageEditor.selection = new vscode.Selection(persistCursor, persistCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(
    async () => api.allExplanations().some((view) => view.functionName === "persist" && view.status === "current") ? true : undefined,
    "the explanation of the called JavaScript function"
  );
  assert.match(
    await hoverText(jsDocument, "persist(book)", 2),
    /Downside Up[\s\S]*persist/,
    "Hovering a JavaScript call shows its saved explanation."
  );
  console.log("Downside Up integration tests: JavaScript calls resolved through TypeScript go-to-definition.");

  const cartViewDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(reactRoot, "src/CartView.tsx")));
  await vscode.window.showTextDocument(cartViewDocument, vscode.ViewColumn.One);
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(
    async () => api.shownOutline().map((entry) => `${entry.kindLabel} ${entry.name}`).join(", ") === "Component CartView, Function handleCheckout"
      ? true : undefined,
    "the React component and its handler in the concise preview"
  );
  assert.equal(
    api.allExplanations().some((view) => view.functionName === "CartView"),
    false,
    "Opening the preview with a plain cursor in a function does not generate its explanation."
  );
  const cartViewCursor = cartViewDocument.positionAt(cartViewDocument.getText().indexOf("document.title"));
  const cartView = await findFunctionTarget(cartViewDocument, cartViewCursor);
  assert.equal(cartView?.qualifiedName, "CartView", "Code in an effect callback belongs to the component.");
  assert.equal(cartView?.analysis, "javascript-tree-sitter");
  const reactRepository = await findRepositoryRoot(reactRoot);
  const reactCalled = await waitFor(async () => {
    const called = await findCalledFunctions(cartView!, cartViewDocument, await gatherInventory(reactRepository));
    return called.length >= 3 ? called : undefined;
  }, "TypeScript go-to-definition for the component's hooks, children, and helpers");
  assert.deepEqual(
    reactCalled.map((entry) => `${entry.path.split("/").slice(-2).join("/")} ${entry.qualifiedName}`),
    ["src/useCart.ts useCart", "src/CartItem.tsx CartItem", "src/format.ts formatPrice"],
    "Hooks, rendered components, and helpers are found in order of first use."
  );
  const reactContext = await gatherFunctionContext(cartView!, cartViewDocument, await gatherInventory(reactRepository));
  assert.ok(
    reactContext.inputs.some((input) => input.path.endsWith("src/types.ts") && input.description === "interface CartViewProps" && input.depth === 1),
    "The props interface is sent and tracked."
  );
  const cartItemDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(reactRoot, "src/CartItem.tsx")));
  const cartItemEditor = await vscode.window.showTextDocument(cartItemDocument, vscode.ViewColumn.One);
  const cartItemCursor = cartItemDocument.positionAt(cartItemDocument.getText().indexOf("const CartItem") + 8);
  cartItemEditor.selection = new vscode.Selection(cartItemCursor, cartItemCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(
    async () => api.allExplanations().some((view) => view.functionName === "CartItem" && view.status === "current") ? true : undefined,
    "the explanation of the memo-wrapped arrow component"
  );
  await vscode.window.showTextDocument(cartViewDocument, vscode.ViewColumn.One);
  assert.match(
    await hoverText(cartViewDocument, "<CartItem", 3),
    /Downside Up[\s\S]*CartItem/,
    "Hovering a rendered component shows its saved explanation."
  );
  console.log("Downside Up integration tests: React components, hooks, and props types resolved.");

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
  goEditor.selection = new vscode.Selection(goCursor, goCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
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
  console.log("Downside Up integration tests: Go explanation from a selection completed.");

  const checkoutBody = goDocument.positionAt(goDocument.getText().indexOf("catalog.MarkUnavailable(book.Title)"));
  goEditor.selection = new vscode.Selection(checkoutBody, checkoutBody);
  await waitFor(
    async () => api.stepHighlight()?.functionName === "checkout" && api.stepHighlight()!.steps.includes(0) ? true : undefined,
    "the step under the cursor to be highlighted"
  );
  goEditor.selection = new vscode.Selection(0, 0, 0, 0);
  await waitFor(async () => api.stepHighlight() === undefined ? true : undefined, "the step highlight to clear outside the function");
  await api.revealStep("checkout", 0);
  const stepSelection = vscode.window.activeTextEditor!.selection;
  const checkoutStart = goDocument.positionAt(goDocument.getText().indexOf("func checkout")).line;
  assert.ok(stepSelection.isEmpty, "Clicking a step does not select text, so VS Code does not mark matching lines elsewhere.");
  assert.equal(stepSelection.start.line, checkoutStart, "Clicking a step moves the cursor to its first line.");
  const stepLines = api.revealedLines();
  assert.ok(stepLines && stepLines.start === checkoutStart && stepLines.end > stepLines.start, "The step's lines are highlighted.");
  console.log("Downside Up integration tests: steps follow the cursor and select their lines.");

  await api.addFormat("checkout", "flowchart");
  const withFlowchart = api.explanationOf("checkout");
  assert.ok(withFlowchart?.flowchart?.nodes.length, "A flowchart can be added to a saved explanation.");
  assert.equal(withFlowchart?.pseudocode, undefined, "Only the requested view is added.");
  goEditor.selection = new vscode.Selection(checkoutBody, checkoutBody);
  await waitFor(
    async () => api.stepHighlight()?.nodes.length ? true : undefined,
    "flowchart nodes under the cursor to be highlighted"
  );
  const nodeIndex = withFlowchart!.flowchart!.nodes.findIndex((node) => node.endLine > node.startLine);
  await api.revealStep("checkout", nodeIndex, "node");
  assert.ok(api.revealedLines(), "Clicking a node highlights its lines.");
  await waitFor(
    async () => JSON.stringify(api.stepHighlight()?.nodes) === JSON.stringify([nodeIndex]) ? true : undefined,
    "exactly the clicked node to stay highlighted"
  );
  const moved = vscode.window.activeTextEditor!;
  moved.selection = new vscode.Selection(checkoutBody, checkoutBody);
  await waitFor(async () => api.revealedLines() === undefined ? true : undefined, "the line highlight to clear when the cursor moves");
  console.log("Downside Up integration tests: a flowchart is added on request and follows the cursor.");

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
  assert.equal(statusOf("Catalog.FindAvailable")?.expanded, true, "Prefetched explanations open when ready.");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  assert.equal(statusOf("Catalog.MarkUnavailable"), undefined, "Functions outside the prefetch window are not requested.");
  prefetchEditor.selection = new vscode.Selection(lineOf(") MarkUnavailable("), 0, lineOf(") MarkUnavailable("), 0);
  await waitFor(
    async () => statusOf("Catalog.MarkUnavailable")?.status === "current" ? true : undefined,
    "the prefetch window to follow the cursor"
  );
  console.log("Downside Up integration tests: prefetching followed the reader.");

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
  legacyEditor.selection = new vscode.Selection(rateCursor, rateCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
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
