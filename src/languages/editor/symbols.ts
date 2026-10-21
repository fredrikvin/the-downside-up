import * as vscode from "vscode";
import { cacheKey, formatTolerantFingerprint } from "../../core/fingerprint";
import type { FunctionTarget } from "../../core/types";
import type { FunctionDiscovery } from "../support";

/**
 * Whether a symbol has document-symbol ranges and children. Symbols returned
 * by `vscode.executeDocumentSymbolProvider` are `SymbolInformation` objects
 * that also carry these fields, so `instanceof DocumentSymbol` is false.
 */
export function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return "selectionRange" in symbol && "children" in symbol && Array.isArray(symbol.children);
}

const functionKinds = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor
]);

/**
 * An unnamed function the symbol provider names by its position, such as
 * TypeScript's `find() callback` or `<function>`. These are part of the
 * function around them rather than functions of their own.
 */
export function isAnonymousFunction(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): boolean {
  return functionKinds.has(symbol.kind) && (symbol.name.trim() === "" || /[\s()<>]/.test(symbol.name));
}

function flattenSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ancestors: readonly string[] = []
): Array<{ symbol: vscode.DocumentSymbol | vscode.SymbolInformation; qualified: string }> {
  const flattened: Array<{
    symbol: vscode.DocumentSymbol | vscode.SymbolInformation;
    qualified: string;
  }> = [];
  for (const symbol of symbols) {
    if (isAnonymousFunction(symbol)) continue;
    const qualified = [...ancestors, symbol.name].join(".");
    flattened.push({ symbol, qualified });
    if (isDocumentSymbol(symbol)) {
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
        isDocumentSymbol(symbol)
          ? symbol.range
          : symbol.location.range,
      selection:
        isDocumentSymbol(symbol)
          ? symbol.selectionRange
          : symbol.location.range
    }))
    .filter((entry) => entry.range.contains(position))
    .sort((a, b) => a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line));
  const selected = candidates[0];
  if (!selected) return undefined;
  const source = document.getText(selected.range);
  const detail = isDocumentSymbol(selected.symbol)
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
    structuralFingerprint: formatTolerantFingerprint(source),
    analysis: "vscode-symbols"
  };
}

/** A revision must supply its own document; working-tree symbols are never historical evidence. */
export async function editorComparisonFunctions(source: string, _path: string, document?: vscode.TextDocument): Promise<FunctionDiscovery> {
  if (!document || document.getText() !== source) return { status: "unavailable", entries: [], limitations: [] };
  const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
    "vscode.executeDocumentSymbolProvider", document.uri);
  // Symbol providers do not attest completeness (including a successful empty response).
  if (!symbols) return { status: "unavailable", entries: [], limitations: [] };
  return {
    status: "partial",
    entries: [],
    limitations: ["Editor symbol discovery does not guarantee a complete callable inventory; this comparison remains unclassified."]
  };
}
