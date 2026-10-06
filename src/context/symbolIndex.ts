import * as vscode from "vscode";
import type { RepositoryInventory } from "./inventory";
import { listGoFunctions } from "../languages/go";
import { listRustFunctions } from "../languages/rust";

const MAX_SYMBOL_FILES = 20;
const MAX_SYMBOLS = 120;
const MAX_SYMBOL_BYTES = 16 * 1024;
const LANGUAGE_LOOKUP_MS = 700;

function flattenSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  parent = ""
): string[] {
  const result: string[] = [];
  for (const symbol of symbols) {
    const qualified = parent ? `${parent}.${symbol.name}` : symbol.name;
    const isFunction = [
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor
    ].includes(symbol.kind);
    if (isFunction) {
      const detail = symbol instanceof vscode.DocumentSymbol ? symbol.detail : "";
      result.push(`  ${qualified}${detail ? ` ${detail}` : ""}`);
    }
    if (symbol instanceof vscode.DocumentSymbol) {
      result.push(...flattenSymbols(symbol.children, qualified));
    }
    if (result.length >= MAX_SYMBOLS) break;
  }
  return result;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function addLocalSymbolOutline(
  inventory: RepositoryInventory
): Promise<RepositoryInventory> {
  const indexedSourceFiles = inventory.primedPaths
    .map((path) => inventory.files.find((file) => file.relativePath === path))
    .filter((file) => file?.languageId !== null && file?.languageId !== undefined);
  const sourceFiles = indexedSourceFiles.slice(0, MAX_SYMBOL_FILES);
  const outline: string[] = [];
  const limitations = [...inventory.limitations];
  const start = Date.now();

  for (const file of sourceFiles) {
    if (!file || outline.length >= MAX_SYMBOLS || Date.now() - start > 2_500) break;
    if (file.languageId === "rust") {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.absolutePath));
        const functions = await listRustFunctions(document);
        outline.push(...functions.slice(0, 20).map(
          (entry) => `  ${file.relativePath}: ${entry.qualifiedName} ${entry.signature}`
        ));
      } catch {
        limitations.push(`Rust symbols were unavailable for ${file.relativePath}.`);
      }
      continue;
    }
    if (file.languageId === "go") {
      try {
        const functions = await listGoFunctions({ getText: () => file.content });
        outline.push(...functions.slice(0, 20).map(
          (entry) => `  ${file.relativePath}: ${entry.qualifiedName} ${entry.signature}`
        ));
      } catch {
        limitations.push(`Go symbols were unavailable for ${file.relativePath}.`);
      }
      continue;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.absolutePath));
      const symbols = await withTimeout(
        Promise.resolve(vscode.commands.executeCommand<
          (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
        >("vscode.executeDocumentSymbolProvider", document.uri)),
        LANGUAGE_LOOKUP_MS
      );
      if (symbols?.length) {
        outline.push(...flattenSymbols(symbols).slice(0, 20).map(
          (entry) => `  ${file.relativePath}: ${entry.trim()}`
        ));
      } else {
        limitations.push(`No VS Code document symbols were available for ${file.relativePath}.`);
      }
    } catch {
      limitations.push(`VS Code symbol lookup failed for ${file.relativePath}.`);
    }
  }
  if (indexedSourceFiles.length > MAX_SYMBOL_FILES || Date.now() - start > 2_500) {
    limitations.push("Repository symbol outline was time- and size-bounded.");
  }

  let symbolText = outline.length > 0
    ? `\n\nLocally observed symbol outline (not a call graph):\n${outline.slice(0, MAX_SYMBOLS).join("\n")}`
    : "\n\nNo symbol outline could be collected from available local tooling.";
  while (
    Buffer.byteLength(symbolText, "utf8") > MAX_SYMBOL_BYTES &&
    outline.length > 0
  ) {
    outline.pop();
    symbolText = `\n\nLocally observed symbol outline (not a call graph):\n${outline.join("\n")}`;
  }
  return {
    ...inventory,
    inventoryText: inventory.inventoryText + symbolText,
    limitations: [...new Set(limitations)]
  };
}
