import * as assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { findFunctionWithEditorTools } from "../../src/languages/editor/symbols";
import { buildFileOverview } from "../../src/context/fileOverview";
import { findRepositoryRoot, gatherInventory, sharingExclusion } from "../../src/context/inventory";
import { findCalledFunctions, gatherFunctionContext } from "../../src/context/related";
import { javascriptSupport } from "../../src/languages/javascript";
import type { DownsideUpTestApi } from "../../src/extension";
import { findGoFunction, initializeGoParserAt } from "../../src/languages/go/syntax";
import { findRustFunction, initializeRustParserAt } from "../../src/languages/rust/syntax";
import { chooseExclusionAssignments } from "../../src/presentation/exclusionWizard";
import { incomingCallers } from "../../src/languages/editor/callers";
import { staticCallers } from "../../src/context/callers";
import { goSupport } from "../../src/languages/go";
import { rustSupport } from "../../src/languages/rust";
import { pythonSupport } from "../../src/languages/python";
import { sqlSupport } from "../../src/languages/sql";

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

/** A real Git original side: historical detail must not be resolved against today's file. */
async function testSnapshotFunctionCards(api: DownsideUpTestApi, document: vscode.TextDocument): Promise<void> {
  const root = await findRepositoryRoot(resolve(document.uri.fsPath, ".."));
  const path = document.uri.fsPath;
  const before = document.getText();
  const replace = async (text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
    await document.save();
  };
  try {
    await replace("export function addedOnly() {\n return 'modified-side';\n}\n");
    const uri = vscode.Uri.file(path);
    const originalUri = uri.with({ scheme: "git", query: JSON.stringify({ path, ref: "HEAD" }) });
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    assert.ok(gitExtension);
    const gitExports = await gitExtension.activate() as {
      getAPI(version: number): { openRepository(root: vscode.Uri): Promise<unknown> };
    };
    await gitExports.getAPI(1).openRepository(vscode.Uri.file(root));
    await vscode.commands.executeCommand("vscode.diff", originalUri, uri, "Function sections (test)");
    await vscode.commands.executeCommand("downsideUp.showFileOverview");
    await waitFor(async () => api.shownChange()?.fileName === "CartItem.tsx" ? true : undefined, "real Git function diff");
    await api.explainChange();
    const comparison = api.shownChange();
    assert.equal(comparison?.status, "current");
    assert.deepEqual(comparison.added.map((card) => card.name), ["addedOnly"]);
    assert.deepEqual(comparison.removed.map((card) => card.name), ["CartItem"]);
    assert.equal(comparison.added[0]?.explanation, undefined, "Comparison generation never generates Added details.");
    assert.equal(comparison.removed[0]?.explanation, undefined, "Comparison generation never generates Removed details.");
    const tabsBefore = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
    for (const [side, card, expected, firstLine] of [
      ["modified", comparison.added[0]!, "modified-side", 0],
      ["original", comparison.removed[0]!, "Remove", 9]
    ] as const) {
      await api.explainChangeFunction(card.id);
      const current = api.shownChange()![side === "modified" ? "added" : "removed"][0]!;
      assert.equal(current.explanation?.status, "current", current.explanation?.error);
      assert.match(api.changeFunctionSource(card.id) ?? "", new RegExp(expected), "The selected side is the explanation source.");
      if (side === "original") assert.ok(current.explanation?.limitations.some((text) => text.includes("Historical callers")));
      await api.addFormat(card.name, "pseudocode");
      await api.addFormat(card.name, "flowchart");
      for (const kind of ["step", "pseudocode", "node"] as const) {
        await api.revealStep(card.name, 0, kind);
        const sideUri = side === "modified" ? uri : originalUri;
        const editor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === sideUri.toString());
        assert.ok(editor && !editor.selection.isEmpty, `${kind} selects source in the ${side} diff side.`);
        assert.equal(editor.selection.start.line, firstLine);
        assert.equal(api.stepHighlight()?.functionName, card.name, "The card's normal items highlight with their own entry id.");
      }
    }
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, tabsBefore,
      "Card detail and source navigation do not open separate file tabs.");
    assert.ok(vscode.window.tabGroups.all.some((group) => group.activeTab?.input instanceof vscode.TabInputTextDiff));
    const other = await vscode.workspace.openTextDocument(resolve(document.uri.fsPath, "../CartView.tsx"));
    await vscode.window.showTextDocument(other, vscode.ViewColumn.One);
    await waitFor(async () => api.shownChange() === undefined ? true : undefined, "leaving the function diff");
    await vscode.commands.executeCommand("vscode.diff", originalUri, uri, "Function sections (test)");
    await vscode.commands.executeCommand("downsideUp.showFileOverview");
    await waitFor(async () => {
      const restored = api.shownChange();
      return restored?.added[0]?.explanation?.status === "current" && restored.removed[0]?.explanation?.status === "current"
        ? true : undefined;
    }, "cached Added and Removed explanations to expand on returning");
    assert.equal(api.shownChange()?.added[0]?.explanation?.detail, "Saved explanation");
    assert.equal(api.shownChange()?.removed[0]?.explanation?.detail, "Saved explanation");
    console.log("Downside Up integration tests: Added/Removed details and three formats reveal their exact native Git diff side.");
  } finally {
    await replace(before);
  }
}

export async function run(): Promise<void> {
  console.log("Downside Up integration tests: activating extension.");
  const extension = vscode.extensions.getExtension("FredrikVinkvist.the-downside-up");
  assert.ok(extension, "The development extension is installed.");
  assert.equal(extension.isActive, false, "The extension starts inactive before a contributed command is run.");
  const formatDefaults = vscode.workspace.getConfiguration("downsideUp").get("explanations.formats");
  assert.deepEqual(formatDefaults, { pseudocode: true, flowchart: true }, "Both explanation formats are enabled by default.");
  // Exercise adding missing views explicitly later in the suite.
  await vscode.workspace.getConfiguration("downsideUp").update(
    "explanations.formats", { pseudocode: false, flowchart: false }, vscode.ConfigurationTarget.Global
  );

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
  const exclusionSetup = chooseExclusionAssignments(
    ["blocked files", "restricted remotes", "allowed repositories"].map((role) => ({
      title: `Choose ${role}`, hint: "Choose a policy file", current: "Not configured"
    })),
    ["rules.conf"]
  );
  const exclusionTab = await waitFor(async () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .find((tab) => tab.label === "Content-exclusion files"), "content-exclusion setup panel");
  assert.ok(exclusionTab.input instanceof vscode.TabInputWebview, "Policy setup uses a webview rather than a text input.");
  await vscode.window.tabGroups.close(exclusionTab);
  assert.equal(await exclusionSetup, undefined, "Closing policy setup cancels without assignments.");
  console.log("Downside Up integration tests: Rust explanation from a selection completed.");
  const rustPanel = await waitForPanel();
  assert.equal(rustPanel.label, "Downside Up: main.rs");

  const jsRoot = resolve(__dirname, "../../fixtures/js-app");
  const goRoot = resolve(__dirname, "../../fixtures/go-app");
  const reactRoot = resolve(__dirname, "../../fixtures/react-app");
  const servicesRoot = resolve(__dirname, "../../fixtures/services-app");
  const pythonRoot = resolve(__dirname, "../../fixtures/python-app");
  const sqlRoot = resolve(__dirname, "../../fixtures/sql-app");
  // VS Code rejects a second folder change in this session, so all folders are added at once.
  assert.ok(vscode.workspace.updateWorkspaceFolders(
    1,
    0,
    { uri: vscode.Uri.file(jsRoot), name: "js-app" },
    { uri: vscode.Uri.file(goRoot), name: "go-app" },
    { uri: vscode.Uri.file(reactRoot), name: "react-app" },
    { uri: vscode.Uri.file(servicesRoot), name: "services-app" },
    { uri: vscode.Uri.file(pythonRoot), name: "python-app" },
    { uri: vscode.Uri.file(sqlRoot), name: "sql-app" }
  ), "The JavaScript, Go, React, services, Python, and SQL fixture folders are added.");
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
  const callersBefore = api.allExplanations().length;
  const callerLookupDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(jsRoot, "src/storage.js")));
  const nativeCallers = await waitFor(async () => {
    const result = await incomingCallers(callerLookupDocument.uri, callerLookupDocument.positionAt(callerLookupDocument.getText().indexOf("persist")));
    return result.available ? result : undefined;
  }, "TypeScript incoming call hierarchy");
  assert.ok(nativeCallers.callers.some((caller) => caller.name === "checkout"), "Native incoming calls locate persist's caller.");
  assert.equal(api.allExplanations().length, callersBefore, "Looking up callers does not request explanations.");
  for (const { root, path, support, callerName } of [
    { root: rustRoot, path: "src/main.rs", support: rustSupport, callerName: "main" },
    { root: goRoot, path: "main.go", support: goSupport, callerName: "main" },
    { root: pythonRoot, path: "main.py", support: pythonSupport, callerName: "main" },
    { root: sqlRoot, path: "routines.sql", support: sqlSupport, callerName: "public.checkout_first()" }
  ]) {
    await support.initialize?.(extension.extensionPath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(root, path)));
    const fn = (await support.listFunctions!(document.getText(), path)).find((item) => item.name === "checkout");
    assert.ok(fn);
    const callers = await staticCallers(root, {
      uri: document.uri, name: fn.name,
      range: new vscode.Range(fn.startLine, 0, fn.endLine, 0)
    }, support, async (file) => {
      const absolute = resolve(root, file);
      if (await sharingExclusion(root, absolute)) return undefined;
      return (await vscode.workspace.openTextDocument(vscode.Uri.file(absolute))).getText();
    }, () => false);
    assert.ok(callers.some((caller) => caller.name === callerName), `${support.name} fallback finds checkout's caller without a language server.`);
  }
  assert.equal(api.allExplanations().length, callersBefore, "Static caller lookup does not request explanations.");
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
  await waitFor(async () => {
    const views = api.previewExplanations();
    const ready = views.filter((view) => view.status === "current").map((view) => view.functionName);
    return ready.includes("checkout") && ready.includes("describeCatalog") ? views : undefined;
  }, "saved explanations listed as ready after reopening the preview");
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

  const headerBeforeEdit = await waitFor(
    async () => api.header().stats?.explanations ? api.header() : undefined,
    "saved record statistics in the header"
  );
  assert.ok(headerBeforeEdit.stats!.explanations >= 2);
  assert.ok(headerBeforeEdit.stats!.fileSummaries >= 1);
  assert.equal(headerBeforeEdit.stats!.outdatedHere, 0);
  assert.equal(headerBeforeEdit.crumbs[0]?.level, "project");
  assert.equal(headerBeforeEdit.crumbs.at(-1)?.level, "file");
  const savedExplanationCount = api.allExplanations().length;
  const describeBefore = api.explanationOf("describeCatalog");
  const changeCheckout = async (from: string, to: string) => {
    const source = jsDocument.getText();
    const offset = source.indexOf(from);
    assert.ok(offset >= 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(jsDocument.uri, new vscode.Range(jsDocument.positionAt(offset), jsDocument.positionAt(offset + from.length)), to);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };
  try {
    await changeCheckout("book.available = false;", "book.available = true;");
    await waitFor(
      async () => api.header().stats?.outdatedHere === 2 ? true : undefined,
      "the edited function and file summary to become outdated"
    );
    assert.equal(api.allExplanations().length, savedExplanationCount, "Local stats and freshness checks add no explanations.");
    const cancelledBatch = api.regenerateOutdated();
    api.cancel();
    await cancelledBatch;
    assert.equal(api.header().stats?.outdatedHere, 2, "Cancelling before generation leaves the outdated set untouched.");
    await api.regenerateOutdated();
    assert.equal(api.header().stats?.outdatedHere, 0, "The explicit batch refreshes the edited function and file summary.");
    assert.equal(api.previewExplanations().find((view) => view.functionName === "checkout")?.status, "current");
    assert.deepEqual(api.explanationOf("describeCatalog"), describeBefore, "The current neighbouring function is not regenerated.");
  } finally {
    await changeCheckout("book.available = true;", "book.available = false;");
  }
  await waitFor(async () => api.header().stats?.outdatedHere === 2 ? true : undefined, "the restored source to be rechecked");
  await api.regenerateOutdated();
  console.log("Downside Up integration tests: header statistics stay local and explicit regeneration targets only outdated items.");

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

  const badgePath = resolve(reactRoot, "src/Badge.tsx");
  const nextBadgePath = resolve(reactRoot, "src/Badge.next.tsx");
  const replaceInCartItem = async (from: string, to: string) => {
    const text = cartItemDocument.getText();
    const start = text.indexOf(from);
    assert.ok(start >= 0, `CartItem.tsx contains ${from}`);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cartItemDocument.uri, new vscode.Range(cartItemDocument.positionAt(start), cartItemDocument.positionAt(start + from.length)), to);
    await vscode.workspace.applyEdit(edit);
    await cartItemDocument.save();
  };
  try {
    await replaceInCartItem(">Remove<", ">Delete<");
    await writeFile(badgePath, "export function Badge({ count }: { count: number }) {\n  return <span>{count}</span>;\n}\n");
    await vscode.window.showTextDocument(cartViewDocument, vscode.ViewColumn.One);
    const badgeUri = vscode.Uri.file(badgePath);
    const nextBadgeUri = vscode.Uri.file(nextBadgePath);
    await writeFile(nextBadgePath, "export function Badge({ count }: { count: number }) {\n  return <b>{count}</b>;\n}\n");
    const requestsBefore = api.allExplanations().length;
    await vscode.commands.executeCommand("vscode.diff", badgeUri, nextBadgeUri, "Badge (test)");
    await vscode.commands.executeCommand("downsideUp.showFileOverview");
    const unexplained = await waitFor(async () => api.shownChange()?.fileName === "Badge.next.tsx" ? api.shownChange() : undefined, "a native diff in the preview");
    assert.equal(unexplained.status, "ready", "Opening a diff only looks up a saved explanation.");
    assert.equal(api.allExplanations().length, requestsBefore);
    await api.explainChange();
    assert.equal(api.shownChange()?.status, "current", "Explain changes is the explicit request for one diff.");
    for (const side of ["original", "modified", "modified", "original", "original"] as const) {
      await vscode.commands.executeCommand("downsideUp.showFileOverview");
      for (const visible of vscode.window.visibleTextEditors) visible.selection = new vscode.Selection(0, 0, 0, 0);
      await api.revealChange(side);
      const sideUri = (side === "original" ? badgeUri : nextBadgeUri).toString();
      // An unfocused test window may ignore side focus; the side's own editor is then selected without it.
      if (vscode.window.state.focused) {
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sideUri, `Selecting a ${side} item focuses its own side of the native diff.`);
      }
      const sideEditor = vscode.window.visibleTextEditors.find((editor) => editor.viewColumn === undefined && editor.document.uri.toString() === sideUri);
      assert.ok(sideEditor && !sideEditor.selection.isEmpty, `Selecting a ${side} item selects its range in its own side of the native diff.`);
      assert.ok(vscode.window.tabGroups.all.some((group) => group.activeTab?.input instanceof vscode.TabInputTextDiff),
        "Source selection keeps the native diff open.");
    }
    const repositoryRoot = await findRepositoryRoot(reactRoot);
    assert.equal(await api.commandRoot(), repositoryRoot, "Repository commands act on the shown diff's repository.");
    await testSnapshotFunctionCards(api, cartItemDocument);

    // So they do while a side that is not a workspace file (here the empty stand-in of an added file) has focus.
    await vscode.commands.executeCommand("vscode.diff", badgeUri.with({ scheme: "downside-up-empty", query: "HEAD" }), badgeUri, "Added Badge (test)");
    await vscode.commands.executeCommand("downsideUp.showFileOverview");
    await waitFor(async () => api.shownChange()?.fileName === "Badge.tsx" ? true : undefined, "an added file's diff in the preview");
    await vscode.commands.executeCommand("workbench.action.compareEditor.focusSecondarySide");
    if (vscode.window.state.focused) {
      await waitFor(async () => vscode.window.activeTextEditor?.document.uri.scheme === "downside-up-empty" ? true : undefined,
        "the comparison's empty side to receive focus");
      assert.equal(await api.commandRoot(), repositoryRoot, "Repository commands act on the shown diff's repository from its other side.");
    } else {
      assert.ok(vscode.window.visibleTextEditors.some((editor) => editor.document.uri.scheme === "downside-up-empty"),
        "The unfocused test window still exposes the comparison's empty side.");
    }

    await vscode.window.showTextDocument(cartViewDocument, vscode.ViewColumn.One);
    await waitFor(async () => api.shownChange() === undefined ? true : undefined, "an ordinary file to replace the diff in the preview");

    // Cancel aborts review requests already sent, so none of them is saved.
    api.mockDelay(1_500);
    try {
      assert.equal(await api.reviewChanges("HEAD"), 3);
      await waitFor(async () => api.reviewItems().some((item) => item.status === "explaining") ? true : undefined, "review requests in flight");
      api.cancel();
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      assert.deepEqual(api.reviewItems().map((item) => item.status), ["pending", "pending", "pending"], "Cancelled review requests are not saved.");
    } finally {
      api.mockDelay(0);
      api.stopReview();
    }

    assert.equal(await api.reviewChanges("HEAD"), 3, "The changed file and the two new files are queued.");
    assert.deepEqual(
      api.reviewItems().map((item) => `${item.path} ${item.change}`).sort(),
      ["src/Badge.next.tsx added", "src/Badge.tsx added", "src/CartItem.tsx modified"]
    );
    await waitFor(
      async () => api.reviewItems().every((item) => item.status === "done") ? true : undefined,
      "the changed files to be explained in review mode"
    );
    // The diff a review opens for an added file describes the same two versions the batch explained.
    const emptyBadge = badgeUri.with({ scheme: "downside-up-empty", query: "HEAD" });
    await vscode.commands.executeCommand("vscode.diff", emptyBadge, badgeUri, "Badge (test)");
    await vscode.commands.executeCommand("downsideUp.showFileOverview");
    const reviewed = await waitFor(async () => api.shownChange()?.fileName === "Badge.tsx" ? api.shownChange() : undefined, "the reviewed file's diff in the preview");
    assert.equal(reviewed.explained, true, "A diff opened from review shows the explanation the batch saved.");
    assert.equal(reviewed.status, "current");
    assert.match(reviewed.facts, /added/);
    api.stopReview();
  } finally {
    await replaceInCartItem(">Delete<", ">Remove<").catch(() => undefined);
    await rm(badgePath, { force: true });
    await rm(nextBadgePath, { force: true });
  }
  console.log("Downside Up integration tests: review mode explained the changed files.");

  const pythonDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(pythonRoot, "main.py")));
  const pythonCursor = pythonDocument.positionAt(pythonDocument.getText().indexOf("def checkout") + 6);
  const pythonTarget = await pythonSupport.findFunction(pythonDocument, pythonCursor);
  assert.equal(pythonTarget?.analysis, "python-tree-sitter", "Python discovery does not need Pylance.");
  const pythonInventoryDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(pythonRoot, "library/inventory.py")));
  const pythonMethod = await pythonSupport.findFunction(pythonInventoryDocument,
    pythonInventoryDocument.positionAt(pythonInventoryDocument.getText().indexOf("def find") + 5));
  assert.equal(pythonMethod?.qualifiedName, "Catalog.find");
  const pythonOutline = await buildFileOverview(pythonInventoryDocument, "library/inventory.py");
  assert.ok(pythonOutline.entries.some((entry) => entry.name === "reserve" && entry.kindLabel === "Method"));
  const pythonEditor = await vscode.window.showTextDocument(pythonDocument, vscode.ViewColumn.One);
  const pythonBefore = api.allExplanations().length;
  pythonEditor.selection = new vscode.Selection(pythonCursor, pythonCursor);
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  assert.equal(api.allExplanations().length, pythonBefore, "Opening Python with only a cursor does not generate.");
  pythonEditor.selection = new vscode.Selection(pythonCursor, pythonCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(async () => api.previewExplanations().some((view) => view.functionName === "checkout" && view.status === "current") ? true : undefined,
    "the Python explanation from a selection");
  await api.previewFolder("");
  const pythonFolder = await waitFor(async () => api.shownFolder()?.edges.length ? api.shownFolder() : undefined,
    "the Python repository's import structure");
  assert.ok(pythonFolder.edges.includes("main.py > library"), "Python import diagrams use bundled resolution.");
  console.log("Downside Up integration tests: Python discovery, callers, explanation, and structure completed.");

  const sqlDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(sqlRoot, "routines.sql")));
  const sqlCursor = sqlDocument.positionAt(sqlDocument.getText().indexOf("FUNCTION public.checkout") + 18);
  const sqlTarget = await sqlSupport.findFunction(sqlDocument, sqlCursor);
  assert.equal(sqlTarget?.analysis, "sql-lexer", "SQL discovery needs neither a database nor a language server.");
  assert.equal(sqlTarget?.qualifiedName, "public.checkout(integer)");
  const sqlSchema = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(sqlRoot, "schema.sql")));
  const sqlOutline = await buildFileOverview(sqlSchema, "schema.sql");
  assert.ok(sqlOutline.entries.some((entry) => entry.kindLabel === "Column" && entry.name === "title"));
  assert.ok(sqlOutline.entries.some((entry) => entry.kindLabel === "View" && entry.explainable));
  const booksPreview = sqlOutline.entries.find((entry) => entry.qualifiedName === "public.books")!;
  assert.ok(booksPreview.alwaysVisible && booksPreview.explainable, "SQL tables remain visible with concise preview settings and can be explicitly explained.");
  assert.ok(booksPreview.previewTable?.rows.some((row) => row[0]?.some((segment) => segment.text === "title")));
  assert.ok(booksPreview.notes.flat().some((segment) => segment.text.includes("Primary key: id")), "Later ALTER TABLE constraints are folded into the card.");
  assert.ok(booksPreview.previewTable?.rows[0]?.[0]?.[0]?.referenceId, "Column links use host-owned references.");
  const sqlContext = await gatherFunctionContext(sqlTarget!, sqlDocument, await gatherInventory(sqlRoot));
  assert.ok(sqlContext.inputs.some((input) => input.path === "routines.sql" && input.description.includes("reserve")));
  const sqlEditor = await vscode.window.showTextDocument(sqlDocument, vscode.ViewColumn.One);
  const sqlBefore = api.allExplanations().length;
  sqlEditor.selection = new vscode.Selection(sqlCursor, sqlCursor);
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  assert.equal(api.allExplanations().length, sqlBefore, "Opening SQL with only a cursor never generates.");
  sqlEditor.selection = new vscode.Selection(sqlCursor, sqlCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(async () => api.previewExplanations().some((view) =>
    view.functionName === "public.checkout(integer)" && view.status === "current") ? true : undefined,
  "the SQL explanation from a selection");
  console.log("Downside Up integration tests: SQL discovery, callers, context, outlines, and explicit explanation completed.");

  const sqlQueryDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(sqlRoot, "queries.sql")));
  const sqlQueryCursor = sqlQueryDocument.positionAt(sqlQueryDocument.getText().indexOf("GetAvailableBooks") + 4);
  const sqlQueryTarget = await sqlSupport.findFunction(sqlQueryDocument, sqlQueryCursor);
  assert.equal(sqlQueryTarget?.qualifiedName, "GetAvailableBooks", "sqlc query annotations name explainable units.");
  const sqlQueryContext = await gatherFunctionContext(sqlQueryTarget!, sqlQueryDocument, await gatherInventory(sqlRoot));
  assert.ok(sqlQueryContext.inputs.some((input) => input.path === "schema.sql" && input.description.includes("public.books")));
  assert.ok(sqlQueryContext.text.includes("books_pkey"), "Queries receive schema constraints declared in later ALTER statements.");
  const sqlQueryEditor = await vscode.window.showTextDocument(sqlQueryDocument, vscode.ViewColumn.One);
  const queryBefore = api.allExplanations().length;
  sqlQueryEditor.selection = new vscode.Selection(sqlQueryCursor, sqlQueryCursor);
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  assert.equal(api.allExplanations().length, queryBefore, "Opening query previews never generates.");
  sqlQueryEditor.selection = new vscode.Selection(sqlQueryCursor, sqlQueryCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(async () => api.previewExplanations().some((view) =>
    view.functionName === "GetAvailableBooks" && view.status === "current") ? true : undefined, "a named SQL query explanation");
  const sqlTableEditor = await vscode.window.showTextDocument(sqlSchema, vscode.ViewColumn.One);
  const tableCursor = sqlSchema.positionAt(sqlSchema.getText().indexOf("TABLE public.books") + 14);
  sqlTableEditor.selection = new vscode.Selection(tableCursor, tableCursor.translate(0, 1));
  await vscode.commands.executeCommand("downsideUp.showFileOverview");
  await waitFor(async () => api.previewExplanations().some((view) =>
    view.functionName === "public.books" && view.status === "current") ? true : undefined, "an explicit SQL table explanation");
  console.log("Downside Up integration tests: schema cards, constraint context, and named query/table explanations completed.");

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

  await api.previewFolder("");
  const goFolder = await waitFor(
    async () => api.shownFolder()?.edges.length ? api.shownFolder() : undefined,
    "the Go repository's folder preview with its import structure"
  );
  assert.equal(goFolder.path, "");
  assert.ok(goFolder.hasOverview, "The project preview shows the saved repository overview.");
  assert.ok(goFolder.children.includes("folder inventory") && goFolder.children.includes("file main.go"));
  assert.ok(!goFolder.children.some((child) => child.includes("legacy")), "Excluded folders are not listed.");
  assert.ok(goFolder.edges.includes("main.go > inventory") && goFolder.edges.includes("storage > inventory"));
  await waitFor(async () => api.shownFolder()?.ready ? true : undefined, "the folder summary input");
  assert.equal(api.shownFolder()?.summary, undefined, "Opening a folder preview generates nothing.");
  await api.summarizeFolder();
  assert.match(api.shownFolder()?.summary ?? "", /Mock summary of the repository/);
  await api.previewFolder("inventory");
  await api.previewFolder("");
  await waitFor(async () => api.shownFolder()?.current ? true : undefined, "the saved folder summary to be shown again as current");
  await waitFor(async () => api.flowsReady() ? true : undefined, "the project flow catalog");
  assert.equal(api.shownFlows(), undefined, "Opening a folder preview describes no flows.");
  await api.describeFlows();
  const flows = api.shownFlows();
  assert.equal(flows?.length, 1, "The mock model's flow is shown.");
  assert.ok(flows![0]!.refs.some((ref) => ref?.startsWith("inventory.go")), "Flow steps link to files and functions the extension found.");
  const appendGoNote = async (remove: boolean) => {
    const note = "\n// A temporary header-statistics test note.\n";
    const source = goDocument.getText();
    const edit = new vscode.WorkspaceEdit();
    if (remove) {
      const offset = source.lastIndexOf(note);
      assert.ok(offset >= 0);
      edit.delete(goDocument.uri, new vscode.Range(goDocument.positionAt(offset), goDocument.positionAt(offset + note.length)));
    } else {
      edit.insert(goDocument.uri, goDocument.positionAt(source.length), note);
    }
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };
  try {
    await appendGoNote(false);
    await api.previewFolder("");
    await waitFor(async () => api.shownFolder()?.ready && api.flowsReady() && api.header().stats?.outdatedHere === 1 ? true : undefined, "an outdated direct child file summary");
    assert.equal(api.header().stats?.scope, "folder");
    await api.regenerateOutdated();
    assert.equal(api.header().stats?.outdatedHere, 0, "Folder regeneration refreshes its listed outdated file summary without explaining any functions.");
  } finally {
    await appendGoNote(true);
  }
  await api.previewFolder("");
  await waitFor(async () => api.shownFolder()?.ready && api.flowsReady() ? true : undefined, "the folder input after restoring its file");
  await api.regenerateOutdated();
  await api.previewFolder("inventory");
  await waitFor(async () => api.shownFolder()?.ready && api.flowsReady() ? true : undefined, "the inventory folder's summary and flows inputs");
  await api.summarizeFolder();
  await api.describeFlows();
  const renameLookup = async (from: string, to: string) => {
    const source = lookupDocument.getText();
    const offset = source.indexOf(from);
    assert.ok(offset >= 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(lookupDocument.uri, new vscode.Range(lookupDocument.positionAt(offset), lookupDocument.positionAt(offset + from.length)), to);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };
  try {
    await renameLookup(") FindAvailable(", ") FindAnyAvailable(");
    await api.previewFolder("inventory");
    await waitFor(async () => api.shownFolder()?.ready && api.flowsReady() && api.header().stats?.outdatedHere === 2 ? true : undefined, "outdated folder summary and main flows");
    const beforeFolderBatch = api.allExplanations().length;
    await api.regenerateOutdated();
    assert.equal(api.header().stats?.outdatedHere, 0, "The fixed batch refreshes the folder summary and main flows.");
    assert.equal(api.allExplanations().length, beforeFolderBatch, "Folder regeneration never adds function requests.");
  } finally {
    await renameLookup(") FindAnyAvailable(", ") FindAvailable(");
  }
  await api.previewFolder("inventory");
  await waitFor(async () => api.shownFolder()?.ready && api.flowsReady() ? true : undefined, "the restored inventory folder inputs");
  await api.regenerateOutdated();
  await api.previewFolder("");
  await waitFor(async () => api.shownFlows()?.length === 1 ? true : undefined, "the saved flows to be shown again");
  await waitFor(async () => api.shownFolder()?.ready ? true : undefined, "the folder summary input before the tree run");
  await api.summarizeTree();
  // The project was mapped while priming, so the run leaves its description to the map and summarizes the folders below.
  assert.equal(api.shownFolder()?.mapState, "current");
  for (const folder of ["inventory", "storage"]) {
    await api.previewFolder(folder);
    await waitFor(
      async () => api.shownFolder()?.path === folder && api.shownFolder()?.current ? true : undefined,
      `the tree run to summarize ${folder}`
    );
  }
  await api.previewFolder("");
  await vscode.commands.executeCommand("downsideUp.showFileOverview", vscode.Uri.file(resolve(goRoot, "inventory")));
  await waitFor(async () => api.shownFolder()?.path === "inventory" ? true : undefined, "the Explorer command to preview a folder");
  // Opened in another editor group, so main.go's editor, used below, stays open.
  await vscode.window.showTextDocument(lookupDocument, { viewColumn: vscode.ViewColumn.Three, preview: false });
  await waitFor(
    async () => api.shownFolder() === undefined && api.shownOutline().some((entry) => entry.name === "FindAvailable") ? true : undefined,
    "opening a file to leave the folder preview"
  );
  assert.ok(api.shownOutline().every((entry) => !entry.documentation), "Function comments are hidden in the default concise preview.");
  const includeSettings = vscode.workspace.getConfiguration("downsideUp");
  const previousInclude = includeSettings.inspect("preview.include")?.globalValue;
  const beforeCommentToggle = api.allExplanations().length;
  try {
    await includeSettings.update("preview.include", { functionComments: true }, vscode.ConfigurationTarget.Global);
    await waitFor(async () => api.shownOutline().find((entry) => entry.name === "FindAvailable")?.documentation
      ? true : undefined, "function comments to appear after enabling the display setting");
    assert.equal(api.allExplanations().length, beforeCommentToggle, "Showing comments does not request AI explanations.");
    await includeSettings.update("preview.include", { functionComments: false }, vscode.ConfigurationTarget.Global);
    await waitFor(async () => api.shownOutline().every((entry) => !entry.documentation)
      ? true : undefined, "function comments to hide immediately");
    assert.equal(api.allExplanations().length, beforeCommentToggle, "Hiding comments does not request AI explanations.");
  } finally {
    await includeSettings.update("preview.include", previousInclude, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.window.showTextDocument(goDocument, goEditor.viewColumn);
  await waitFor(
    async () => api.previewExplanations().some((view) => view.functionName === "checkout") ? true : undefined,
    "the preview to show main.go again"
  );
  console.log("Downside Up integration tests: folder previews list contents and import structure.");

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
  assert.ok(nodeIndex >= 0, "The chart includes a source-linked node.");
  await api.revealStep("checkout", nodeIndex, "node");
  const node = withFlowchart!.flowchart!.nodes[nodeIndex]!;
  const nodeEditor = vscode.window.activeTextEditor!;
  assert.equal(nodeEditor.document.uri.toString(), goDocument.uri.toString(), "Clicking a node reveals the function's source document.");
  assert.ok(nodeEditor.selection.isEmpty, "Clicking a node uses a line highlight, not a text selection.");
  assert.equal(nodeEditor.selection.active.line, checkoutStart + node.startLine - 1, "Clicking a node moves the caret to its source line.");
  assert.deepEqual(api.revealedLines(), {
    start: checkoutStart + node.startLine - 1,
    end: checkoutStart + node.endLine - 1
  }, "Clicking a node highlights its exact source range.");
  await waitFor(
    async () => JSON.stringify(api.stepHighlight()?.nodes) === JSON.stringify([nodeIndex]) ? true : undefined,
    "exactly the clicked node to stay highlighted"
  );
  const moved = vscode.window.activeTextEditor!;
  moved.selection = new vscode.Selection(checkoutBody, checkoutBody);
  await waitFor(async () => api.revealedLines() === undefined ? true : undefined, "the line highlight to clear when the cursor moves");
  console.log("Downside Up integration tests: a flowchart is added on request and follows the cursor.");

  moved.selection = new vscode.Selection(0, 0, 0, 0);
  await waitFor(async () => api.stepHighlight() === undefined ? true : undefined, "the cursor to leave the explained function");
  const previousSelection = moved.selection;
  const revealingNode = api.revealStep("checkout", nodeIndex, "node");
  // Focus can report the old selection before showTextDocument has applied the requested caret.
  api.selectionEvent({
    textEditor: moved, selections: [previousSelection], kind: vscode.TextEditorSelectionChangeKind.Command
  });
  await revealingNode;
  assert.ok(api.revealedLines(), "An intermediate programmatic selection must not cancel a pending node click.");
  assert.deepEqual(api.stepHighlight()?.nodes, [nodeIndex], "The pending click retains exactly its node.");
  api.selectionEvent({
    textEditor: moved, selections: [previousSelection], kind: vscode.TextEditorSelectionChangeKind.Command
  });
  assert.ok(api.revealedLines(), "A delayed stale selection must not clear the completed node click.");
  assert.deepEqual(api.stepHighlight()?.nodes, [nodeIndex], "A stale event must not replace the clicked node's highlight.");
  // A real click at the same caret returns ownership to the code editor, even without a position change.
  api.selectionEvent({
    textEditor: moved, selections: [moved.selection], kind: vscode.TextEditorSelectionChangeKind.Mouse
  });
  assert.equal(api.revealedLines(), undefined, "An explicit code click releases preview-owned selection.");
  await Promise.all([
    api.revealStep("checkout", 0, "node"),
    api.revealStep("checkout", nodeIndex, "node")
  ]);
  assert.deepEqual(api.stepHighlight()?.nodes, [nodeIndex], "Rapid preview clicks leave only the latest node highlighted.");
  console.log("Downside Up integration tests: pending and stale selection events do not undo a preview click.");

  const downsideUpSettings = vscode.workspace.getConfiguration("downsideUp");
  const availableCommands = await vscode.commands.getCommands(true);
  for (const command of ["chooseBlockedFilePatternsFile", "chooseRestrictedRemotesFile", "chooseAllowedRepositoriesFile", "chooseExclusionFolder", "checkContentExclusions"]) {
    assert.ok(availableCommands.includes(`downsideUp.${command}`), `The ${command} policy picker is registered.`);
  }
  await downsideUpSettings.update("prefetch.window", 1, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.dependencies", 0, vscode.ConfigurationTarget.Global);
  const beforeApproval = api.allExplanations().length;
  await downsideUpSettings.update("provider", "openai", vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("openai.model", "test-explanation-model", vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.enabled", true, vscode.ConfigurationTarget.Global);
  await waitFor(
    async () => api.prefetchApproval()?.includes("test-explanation-model") ? true : undefined,
    "a persistent background-sharing approval banner without a provider request"
  );
  await downsideUpSettings.update("openai.overviewModel", "test-overview-model", vscode.ConfigurationTarget.Global);
  await waitFor(
    async () => api.prefetchApproval()?.length === 2 ? true : undefined,
    "the banner to include the separate overview model that prefetching also needs"
  );
  assert.deepEqual(api.prefetchApproval(), ["test-explanation-model", "test-overview-model"]);
  assert.equal(api.allExplanations().length, beforeApproval, "Waiting for approval never queues AI explanations.");
  await downsideUpSettings.update("prefetch.enabled", false, vscode.ConfigurationTarget.Global);
  await waitFor(async () => !api.prefetchApproval() ? true : undefined, "disabling prefetch to hide the approval banner");
  await downsideUpSettings.update("provider", "mock", vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("openai.model", undefined, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("openai.overviewModel", undefined, vscode.ConfigurationTarget.Global);
  await downsideUpSettings.update("prefetch.enabled", true, vscode.ConfigurationTarget.Global);
  assert.equal(api.prefetchApproval(), undefined, "Mock mode does not ask for external-sharing approval.");
  const statusOf = (name: string) => api.previewExplanations().find((view) => view.functionName === name);
  const prefetchEditor = await vscode.window.showTextDocument(lookupDocument, vscode.ViewColumn.One);
  const lineOf = (text: string) => lookupDocument.positionAt(lookupDocument.getText().indexOf(text)).line;
  prefetchEditor.selection = new vscode.Selection(lineOf(") FindAvailable("), 0, lineOf(") FindAvailable("), 0);
  await waitFor(
    async () => statusOf("Catalog.FindAvailable")?.status === "current" ? true : undefined,
    "the function nearest the cursor to be prefetched"
  );
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

  const preloadPath = resolve(goRoot, "prefetch_regression.go");
  const callerPath = resolve(goRoot, "prefetch_caller.go");
  const preloadNames = Array.from({ length: 6 }, (_, index) => `preload${index}`);
  let callerDocument: vscode.TextDocument | undefined;
  const references = vscode.languages.registerReferenceProvider({ language: "go", scheme: "file" }, {
    provideReferences(document) {
      if (document.uri.fsPath !== preloadPath || !callerDocument) return [];
      const offset = callerDocument.getText().search(/preload0\s*\(/);
      const start = callerDocument.positionAt(offset);
      return [new vscode.Location(callerDocument.uri, new vscode.Range(start, start.translate(0, 8)))];
    }
  });
  try {
    await writeFile(preloadPath, `package main\n\n${preloadNames.map((name) => `func ${name}() int { return 1 }`).join("\n\n")}\n`);
    await writeFile(callerPath, "package main\n\nfunc caller() int {\n\treturn preload0()\n}\n");
    callerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
    await downsideUpSettings.update("maxConcurrentRequests", 6, vscode.ConfigurationTarget.Global);
    await downsideUpSettings.update("prefetch.window", 10, vscode.ConfigurationTarget.Global);
    await downsideUpSettings.update("prefetch.dependencies", 0, vscode.ConfigurationTarget.Global);
    const preloadDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(preloadPath));
    const preloadEditor = await vscode.window.showTextDocument(preloadDocument, vscode.ViewColumn.One);
    await waitFor(async () => api.shownOutline().some((entry) => entry.name === "preload0") ? true : undefined, "the preload regression file outline");
    await downsideUpSettings.update("prefetch.enabled", true, vscode.ConfigurationTarget.Global);
    const allPreloaded = () => preloadNames.every((name) =>
      api.previewExplanations().some((view) => view.functionName === name && view.status === "current"));
    await waitFor(async () => allPreloaded() ? true : undefined, "all six functions to load without reader movement");
    await downsideUpSettings.update("prefetch.enabled", false, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.focusSecondEditorGroup");
    await vscode.window.showTextDocument(preloadDocument, vscode.ViewColumn.One);
    for (let index = 0; index < preloadNames.length; index++) {
      const cursor = preloadDocument.positionAt(preloadDocument.getText().indexOf(preloadNames[index]!) + 3);
      preloadEditor.selection = new vscode.Selection(cursor, cursor);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert.equal(allPreloaded(), true, "Refocusing and clicking unchanged functions keeps every explanation current at concurrency six.");
    console.log("Downside Up integration tests: six-function preload completes without movement, and refocusing does not invalidate it.");
    const replaceDocument = async (document: vscode.TextDocument, source: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    await replaceDocument(preloadDocument, `package main\n\n${preloadNames.map((name) => `func ${name}( ) int {\n\n    return 1\n}`).join("\n\n")}\n`);
    await replaceDocument(callerDocument, "package main\n\n\nfunc caller( ) int {\n\n    return preload0( )\n}\n");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert.equal(allPreloaded(), true, "Formatting the selected functions and moving caller lines keeps saved explanations current.");
    await replaceDocument(preloadDocument, preloadDocument.getText().replace("return 1", "return 2"));
    await waitFor(async () => api.previewExplanations().some((view) =>
      view.functionName === "preload0" && view.status === "outdated") ? true : undefined, "a real function edit to outdate its explanation");
    assert.equal(api.previewExplanations().filter((view) => view.status === "current").length, 5, "Other functions stay current and no automatic generation occurs.");
    console.log("Downside Up integration tests: formatting and caller-line shifts keep explanations current; a real edit outdates only the changed function.");
  } finally {
    references.dispose();
    await downsideUpSettings.update("prefetch.enabled", undefined, vscode.ConfigurationTarget.Global);
    await downsideUpSettings.update("prefetch.window", undefined, vscode.ConfigurationTarget.Global);
    await downsideUpSettings.update("prefetch.dependencies", undefined, vscode.ConfigurationTarget.Global);
    await downsideUpSettings.update("maxConcurrentRequests", undefined, vscode.ConfigurationTarget.Global);
    await rm(preloadPath, { force: true });
    await rm(callerPath, { force: true });
  }

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

  // The project map: made on request, then each folder page zooms to its level.
  const apiDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(resolve(servicesRoot, "services/api/main.go")));
  await vscode.window.showTextDocument(apiDocument, vscode.ViewColumn.One);
  await waitFor(async () => api.shownOutline().some((entry) => entry.name === "handleOrder") ? true : undefined, "the services fixture's file preview");
  // Opening the project page without a map maps the project.
  await vscode.commands.executeCommand("downsideUp.previewProject");
  const mapped = await waitFor(
    async () => api.shownFolder()?.path === "" && api.shownFolder()?.mapState === "current" && !api.shownFolder()?.mapping ? api.shownFolder() : undefined,
    "the project to be mapped when its page opens"
  );
  assert.equal(mapped.level, "project");
  assert.deepEqual(mapped.mapNodes, ["Mock outside service:external", "api:inside", "web:inside", "worker:inside"], "The project map shows components and what is outside.");
  assert.deepEqual(mapped.members, ["services:group", "web:component", "docs:support", "Mock outside service:external"]);
  await waitFor(async () => api.flowsKind() === "parts" ? true : undefined, "flows between the project's parts");
  await api.describeFlows();
  assert.deepEqual(api.shownFlows()?.[0]?.refs.filter(Boolean), ["api/", "worker/"], "Steps of the project's flows open the parts' folders.");

  await api.previewFolder("services");
  const group = await waitFor(async () => api.shownFolder()?.path === "services" ? api.shownFolder() : undefined, "the services group page");
  assert.equal(group.level, "group");
  assert.deepEqual(group.members, ["api:component", "worker:component"]);
  assert.deepEqual(group.mapNodes, ["Mock outside service:external", "api:inside", "web:outside", "worker:inside"], "A group's map shows its members and what they connect to.");

  await api.previewFolder("services/api");
  const component = await waitFor(
    async () => api.shownFolder()?.path === "services/api" && api.shownFolder()?.ready ? api.shownFolder() : undefined,
    "the api component page"
  );
  assert.equal(component.level, "component");
  const componentCrumbs = await waitFor(
    async () => api.header().crumbs.some((crumb) => crumb.level === "component") ? api.header().crumbs : undefined,
    "level-aware project breadcrumbs"
  );
  assert.deepEqual(componentCrumbs.map((crumb) => crumb.level), ["project", "group", "component"]);
  assert.ok(componentCrumbs.every((crumb) => crumb.summary), "Rich breadcrumbs reuse the saved map's summary.");
  assert.deepEqual(component.mapNodes, ["Mock outside service:external", "api:inside", "worker:outside"]);
  assert.deepEqual(component.contracts, ["services/api/api/openapi.yaml"], "A component's summary input holds its API contracts.");
  await api.summarizeFolder();
  assert.match(api.shownFolder()?.offers ?? "", /Mock offers/, "A component's summary says what it offers.");

  await api.previewFolder("services/api/api");
  await waitFor(async () => api.shownFolder()?.path === "services/api/api" && api.flowsReady() ? true : undefined, "a module's flow input");
  assert.equal(api.shownFolder()?.level, "module");
  assert.equal(api.flowsKind(), "files", "Inside a component, flows go through files and functions.");

  await api.previewFolder("docs");
  await waitFor(async () => api.shownFolder()?.path === "docs" && api.shownFolder()?.ready ? true : undefined, "the docs support page");
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(api.shownFolder()?.level, "support");
  assert.equal(api.flowsKind(), undefined, "Support folders have no flows.");
  console.log("Downside Up integration tests: the project map zooms from the project to groups, components, and modules.");

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
