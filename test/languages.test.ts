import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "./vscode";
import { findFunctionWithEditorTools } from "../src/languages/vscodeSymbols";
import {
  fingerprintRustSyntax,
  initializeRustParserAt
} from "../src/languages/rust";

describe("language analysis", () => {
  it("discovers Rust syntax and fingerprints token structure without losing literal contents", async () => {
    await initializeRustParserAt(resolve("."));
    const first = await fingerprintRustSyntax(
      'fn render() { let text = "value { braces }"; println!("{text}"); }\n'
    );
    const reformatted = await fingerprintRustSyntax(
      'fn render(){\n let text="value { braces }" ;\n println!("{text}") ;\n}\n'
    );
    const changedLiteral = await fingerprintRustSyntax(
      'fn render(){\n let text="value [ braces ]" ;\n println!("{text}") ;\n}\n'
    );
    expect(reformatted).toBe(first);
    expect(changedLiteral).not.toBe(first);
  });

  it("uses VS Code built-in document symbols to find JavaScript functions", async () => {
    const nested = new vscode.DocumentSymbol(
      "format",
      "()",
      vscode.SymbolKind.Function,
      new vscode.Range(1, 2, 2, 3),
      new vscode.Range(1, 11, 1, 17)
    );
    const outer = new vscode.DocumentSymbol(
      "checkout",
      "(catalog, title)",
      vscode.SymbolKind.Function,
      new vscode.Range(0, 0, 4, 1),
      new vscode.Range(0, 16, 0, 24),
      [nested]
    );
    const documentSymbols = [outer];
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(documentSymbols);
    const source = "export function checkout(catalog, title) {\n  function format() { return title; }\n  return format();\n}";
    const document = {
      uri: vscode.Uri.file("/repo/src/checkout.js"),
      languageId: "javascript",
      getText(range?: vscode.Range) {
        return range?.start.line === 1 ? "  function format() { return title; }" : source;
      }
    } as unknown as import("vscode").TextDocument;

    const result = await findFunctionWithEditorTools(
      document,
      new vscode.Position(1, 14) as unknown as import("vscode").Position
    );
    expect(result?.name).toBe("format");
    expect(result?.analysis).toBe("vscode-symbols");
    expect(result?.languageId).toBe("javascript");
    expect(result?.structuralFingerprint).toBeDefined();
  });

  it("returns no function when the installed editor has no symbol provider", async () => {
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const document = {
      uri: vscode.Uri.file("/repo/src/example.unknown"),
      languageId: "plaintext",
      getText: () => "some arbitrary block"
    } as unknown as import("vscode").TextDocument;
    await expect(findFunctionWithEditorTools(
      document,
      new vscode.Position(0, 3) as unknown as import("vscode").Position
    ))
      .resolves.toBeUndefined();
  });
});
