import * as vscode from "vscode";
import { cacheKey, fingerprint } from "../core/fingerprint";
import type { FunctionTarget } from "../core/types";

const functionKinds = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor
]);

function flattenSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ancestors: readonly string[] = []
): Array<{ symbol: vscode.DocumentSymbol | vscode.SymbolInformation; qualified: string }> {
  const flattened: Array<{
    symbol: vscode.DocumentSymbol | vscode.SymbolInformation;
    qualified: string;
  }> = [];
  for (const symbol of symbols) {
    const qualified = [...ancestors, symbol.name].join(".");
    flattened.push({ symbol, qualified });
    if (symbol instanceof vscode.DocumentSymbol) {
      flattened.push(...flattenSymbols(symbol.children, [...ancestors, symbol.name]));
    }
  }
  return flattened;
}

export async function findFunctionWithEditorTools(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<FunctionTarget | undefined> {
  const symbols = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >("vscode.executeDocumentSymbolProvider", document.uri);
  if (!symbols?.length) return undefined;
  const candidates = flattenSymbols(symbols)
    .filter(({ symbol }) => functionKinds.has(symbol.kind))
    .map(({ symbol, qualified }) => ({
      symbol,
      qualified,
      range:
        symbol instanceof vscode.DocumentSymbol
          ? symbol.range
          : symbol.location.range,
      selection:
        symbol instanceof vscode.DocumentSymbol
          ? symbol.selectionRange
          : symbol.location.range
    }))
    .filter((entry) => entry.range.contains(position))
    .sort((a, b) => a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line));
  const selected = candidates[0];
  if (!selected) return undefined;
  const source = document.getText(selected.range);
  const detail = selected.symbol instanceof vscode.DocumentSymbol
    ? selected.symbol.detail
    : "";
  const signature = detail || source.split(/\r?\n/, 1)[0]?.trim() || selected.symbol.name;
  const symbolId = cacheKey([
    "vscode-symbol-v1",
    document.languageId,
    document.uri.toString(),
    selected.qualified,
    signature
  ]);
  return {
    uri: document.uri,
    range: selected.range,
    selection: selected.selection,
    languageId: document.languageId,
    name: selected.symbol.name,
    qualifiedName: selected.qualified,
    signature,
    source,
    symbolId,
    structuralFingerprint: fingerprint(source),
    analysis: "vscode-symbols"
  };
}
