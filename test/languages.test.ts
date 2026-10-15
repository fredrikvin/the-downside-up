import { resolve } from "node:path";
import { Position as EditorPosition } from "vscode";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "./vscode";
import { findFunctionWithEditorTools } from "../src/languages/editor/symbols";
import {
  fingerprintRustSyntax,
  initializeRustParserAt
} from "../src/languages/rust/syntax";
import { bundledLanguageFor, bundledLanguageIdForPath, languageFor } from "../src/languages/registry";

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

  it("reads symbols shaped like VS Code's command results and skips anonymous callbacks", async () => {
    // `vscode.executeDocumentSymbolProvider` returns SymbolInformation objects that also carry
    // DocumentSymbol fields, so they are not `instanceof DocumentSymbol`.
    const merged = (name: string, kind: number, range: vscode.Range, selectionRange: vscode.Range, children: unknown[] = []) =>
      ({ name, kind, detail: "", containerName: "", location: { uri: vscode.Uri.file("/repo/a.js"), range }, range, selectionRange, children });
    const callback = merged("find() callback", vscode.SymbolKind.Function, new vscode.Range(1, 20, 1, 50), new vscode.Range(1, 20, 1, 50));
    const outer = merged("checkout", vscode.SymbolKind.Function, new vscode.Range(0, 0, 3, 1), new vscode.Range(0, 16, 0, 24), [callback]);
    const method = merged("add", vscode.SymbolKind.Method, new vscode.Range(5, 2, 7, 3), new vscode.Range(5, 2, 5, 5));
    const owner = merged("Catalog", vscode.SymbolKind.Class, new vscode.Range(4, 0, 8, 1), new vscode.Range(4, 6, 4, 13), [method]);
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue([outer, owner]);
    const document = {
      uri: vscode.Uri.file("/repo/a.js"),
      languageId: "javascript",
      getText: () => "function text"
    } as unknown as import("vscode").TextDocument;
    const at = (line: number, character: number) => findFunctionWithEditorTools(
      document,
      new vscode.Position(line, character) as unknown as import("vscode").Position
    );

    const inCallback = await at(1, 30);
    expect(inCallback?.qualifiedName).toBe("checkout");
    expect(inCallback?.selection).toEqual(new vscode.Range(0, 16, 0, 24));
    expect((await at(6, 4))?.qualifiedName).toBe("Catalog.add");
  });

  it("ignores safe formatting in editor-symbol functions while preserving indentation and strings", async () => {
    const symbol = new vscode.DocumentSymbol("f", "()", vscode.SymbolKind.Function,
      new vscode.Range(0, 0, 4, 0), new vscode.Range(0, 4, 0, 5));
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue([symbol]);
    let source = 'def f():\n    return "two  spaces"\n';
    const document = {
      uri: vscode.Uri.file("/repo/f.py"), languageId: "python", getText: () => source
    } as import("vscode").TextDocument;
    const at = () => findFunctionWithEditorTools(document, new EditorPosition(0, 4));
    const original = (await at())!;
    source = 'def f(): \r\n\r\n    return "two  spaces"  \r\n';
    expect((await at())!.structuralFingerprint).toBe(original.structuralFingerprint);
    expect((await at())!.symbolId).toBe(original.symbolId);
    source = 'def f():\n  return "two  spaces"\n';
    expect((await at())!.structuralFingerprint).not.toBe(original.structuralFingerprint);
    source = 'def f():\n    return "two spaces"\n';
    expect((await at())!.structuralFingerprint).not.toBe(original.structuralFingerprint);
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

  it("finds bundled languages by language ID or extension and falls back to editor tooling", () => {
    expect(bundledLanguageFor({ languageId: "rust" })?.name).toBe("Rust");
    expect(bundledLanguageFor({ languageId: "plaintext", path: "/repo/cmd/main.GO" })?.name).toBe("Go");
    expect(bundledLanguageFor({ languageId: "typescriptreact", path: "/repo/src/App.tsx" })?.name).toBe("JavaScript/TypeScript");
    expect(bundledLanguageFor({ languageId: "python", path: "/repo/src/app.py" })).toBeUndefined();
    expect(languageFor({ languageId: "python", path: "/repo/src/app.py" }).name).toBe("Editor tooling");
    expect(bundledLanguageIdForPath("src/lib.rs")).toBe("rust");
    expect(bundledLanguageIdForPath("src/app.py")).toBeUndefined();
  });
});
