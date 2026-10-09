import { basename } from "node:path";
import * as vscode from "vscode";
import { isAnonymousFunction, isDocumentSymbol } from "../languages/editor/symbols";
import { scanImports } from "./imports";
import { capitalize, clauses, describe, type Description } from "./outlineText";
import { bundledLanguageFor } from "../languages/registry";
import {
  boundedDocumentation,
  commentDraft,
  type OutlineEntry,
  type OutlineEntryDraft,
  type OutlineKind
} from "./outlineModel";

export type { OutlineEntry, OutlineEntryDraft, OutlineKind } from "./outlineModel";

export interface FileOverview {
  readonly fileName: string;
  readonly path: string;
  readonly languageId: string;
  readonly lineCount: number;
  readonly purpose?: string;
  readonly entries: readonly OutlineEntry[];
  readonly limitations: readonly string[];
}

const MAX_ENTRIES = 400;
const MAX_FILE_BYTES = 256 * 1024;
const SYMBOL_TIMEOUT_MS = 900;

type CommentStyle = "c" | "hash" | "dash";

interface CommentBlock {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const HASH_LANGUAGES = new Set([
  "python", "ruby", "shellscript", "perl", "r", "yaml", "toml", "powershell", "makefile",
  "dockerfile", "coffeescript", "elixir", "julia", "nim", "crystal", "raku"
]);
const DASH_LANGUAGES = new Set(["sql", "lua", "haskell", "elm", "ada"]);

function commentStyle(languageId: string): CommentStyle {
  if (HASH_LANGUAGES.has(languageId)) return "hash";
  if (DASH_LANGUAGES.has(languageId)) return "dash";
  return "c";
}

/** Groups consecutive full-line comments into blocks; blank lines end a block. */
function scanComments(lines: readonly string[], style: CommentStyle): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let current: { start: number; lines: string[] } | undefined;
  let inBlock = false;
  const close = (end: number) => {
    if (!current) return;
    const text = boundedDocumentation(current.lines);
    if (text) blocks.push({ start: current.start, end, text });
    current = undefined;
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    let content: string | undefined;
    if (style === "c") {
      if (inBlock) {
        content = trimmed.replace(/\*\/.*$/, "").replace(/^\*+\s?/, "");
        if (trimmed.includes("*/")) inBlock = false;
      } else if (trimmed.startsWith("//")) {
        content = trimmed.replace(/^\/\/[/!]*\s?/, "");
      } else if (trimmed.startsWith("/*")) {
        const closing = trimmed.indexOf("*/", 2);
        if (closing === -1) {
          inBlock = true;
          content = trimmed.replace(/^\/\*+!?\s?/, "");
        } else if (!trimmed.slice(closing + 2).trim()) {
          content = trimmed.slice(0, closing).replace(/^\/\*+!?\s?/, "");
        }
      }
    } else if (style === "hash" && trimmed.startsWith("#") && !(index === 0 && trimmed.startsWith("#!"))) {
      content = trimmed.replace(/^#+\s?/, "");
    } else if (style === "dash" && trimmed.startsWith("--")) {
      content = trimmed.replace(/^-{2,}\s?/, "");
    }
    if (content === undefined) {
      close(index - 1);
      return;
    }
    current ??= { start: index, lines: [] };
    current.lines.push(content.trim());
  });
  close(lines.length - 1);
  return blocks;
}

function isCodeLine(line: string | undefined): boolean {
  return Boolean(line?.trim()) && !line!.trim().startsWith("#!");
}

interface FlatSymbol {
  readonly symbol: vscode.DocumentSymbol | vscode.SymbolInformation;
  readonly depth: number;
  readonly parent?: vscode.DocumentSymbol;
  readonly range: vscode.Range;
  readonly selection: vscode.Range;
}

function flatten(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  depth = 0,
  parent?: vscode.DocumentSymbol,
  result: FlatSymbol[] = []
): FlatSymbol[] {
  for (const symbol of symbols) {
    if (result.length >= MAX_ENTRIES) break;
    if (isAnonymousFunction(symbol)) continue;
    const documentSymbol = isDocumentSymbol(symbol) ? symbol : undefined;
    result.push({
      symbol,
      depth,
      ...(parent ? { parent } : {}),
      range: documentSymbol ? documentSymbol.range : (symbol as vscode.SymbolInformation).location.range,
      selection: documentSymbol ? documentSymbol.selectionRange : (symbol as vscode.SymbolInformation).location.range
    });
    if (documentSymbol && symbol.kind !== vscode.SymbolKind.Enum) {
      flatten(documentSymbol.children, depth + 1, documentSymbol, result);
    }
  }
  return result;
}

const FUNCTION_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor
]);

const IGNORED_KINDS = new Set([
  vscode.SymbolKind.File,
  vscode.SymbolKind.String,
  vscode.SymbolKind.Number,
  vscode.SymbolKind.Boolean,
  vscode.SymbolKind.Array,
  vscode.SymbolKind.Null,
  vscode.SymbolKind.Key,
  vscode.SymbolKind.EnumMember,
  vscode.SymbolKind.Operator
]);

function kindName(kind: vscode.SymbolKind): string {
  const names: Partial<Record<vscode.SymbolKind, string>> = {
    [vscode.SymbolKind.Module]: "module",
    [vscode.SymbolKind.Namespace]: "namespace",
    [vscode.SymbolKind.Package]: "package",
    [vscode.SymbolKind.Class]: "class",
    [vscode.SymbolKind.Method]: "method",
    [vscode.SymbolKind.Property]: "property",
    [vscode.SymbolKind.Field]: "field",
    [vscode.SymbolKind.Constructor]: "constructor",
    [vscode.SymbolKind.Enum]: "enum",
    [vscode.SymbolKind.Interface]: "interface",
    [vscode.SymbolKind.Function]: "function",
    [vscode.SymbolKind.Variable]: "variable",
    [vscode.SymbolKind.Constant]: "constant",
    [vscode.SymbolKind.Object]: "object",
    [vscode.SymbolKind.Struct]: "struct",
    [vscode.SymbolKind.Event]: "event",
    [vscode.SymbolKind.TypeParameter]: "type parameter"
  };
  return names[kind] ?? "symbol";
}

function outlineKind(kind: vscode.SymbolKind): OutlineKind {
  if (FUNCTION_KINDS.has(kind)) return "function";
  if ([vscode.SymbolKind.Module, vscode.SymbolKind.Namespace, vscode.SymbolKind.Package].includes(kind)) return "module";
  if ([vscode.SymbolKind.Property, vscode.SymbolKind.Field, vscode.SymbolKind.Event].includes(kind)) return "field";
  if (kind === vscode.SymbolKind.Constant) return "constant";
  if (kind === vscode.SymbolKind.Variable) return "variable";
  return "type";
}

/** Text from the symbol's start, bounded, used to read a declaration's parameters and type. */
function declarationText(lines: readonly string[], range: vscode.Range): string {
  return lines.slice(range.start.line, Math.min(range.end.line, range.start.line + 8) + 1)
    .join("\n")
    .slice(0, 1_200);
}

function balancedParameters(text: string, from: number): { inner: string; end: number } | undefined {
  const open = text.indexOf("(", from);
  if (open === -1) return undefined;
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const character = text[index]!;
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character) && text[index - 1] !== "=") depth--;
    if (depth === 0) return { inner: text.slice(open + 1, index), end: index };
  }
  return undefined;
}

function splitParameters(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function describeParameter(builder: ReturnType<typeof describe>, parameter: string): void {
  const withoutDefault = parameter.replace(/\s*=.*$/s, "").trim();
  const typed = /^([^:]+?)\??\s*:\s*(.+)$/s.exec(withoutDefault);
  if (typed && !/^\{|^\[/.test(typed[1]!)) {
    builder.code(typed[1]!.trim()).text(" (").code(typed[2]!.trim()).text(")");
  } else {
    builder.code(withoutDefault);
  }
}

function describeFunctionSymbol(
  entry: FlatSymbol,
  lines: readonly string[],
  languageId: string
): Description {
  const { symbol, parent } = entry;
  const declaration = declarationText(lines, entry.range);
  const firstLine = (lines[entry.range.start.line] ?? "").trim();
  const nameOffset = Math.max(0, declaration.indexOf(symbol.name));
  const parameters = balancedParameters(declaration, nameOffset);
  const subject = describe();
  const modifiers = [
    /^export\b/.test(firstLine) ? "exported" : "",
    /\bstatic\b/.test(firstLine.split("(")[0] ?? "") ? "static" : "",
    /\basync\b/.test(firstLine.split("(")[0] ?? "") ? "async" : ""
  ].filter(Boolean);
  const label = kindName(symbol.kind);
  if (symbol.kind === vscode.SymbolKind.Constructor) {
    subject.text("Constructor");
    if (parent) subject.text(" of ").code(parent.name);
  } else {
    subject.text(capitalize([...modifiers, label].join(" "))).text(" ").code(symbol.name);
    if (parent && symbol.kind === vscode.SymbolKind.Method) subject.text(" of ").code(parent.name);
  }
  const parts: Description[] = [];
  if (parameters) {
    const list = splitParameters(parameters.inner)
      .filter((parameter) => !(languageId === "python" && /^(self|cls)\b/.test(parameter)));
    parts.push(list.length
      ? describe().text("takes ").list(list, describeParameter).build()
      : describe().text("takes no arguments").build());
    const after = declaration.slice(parameters.end + 1);
    const returned =
      /^\s*(?::|->)\s*([^{=\n]+?)\s*(?:\{|=>|:\s*$|$)/m.exec(after)?.[1] ??
      (languageId === "go" ? /^\s*([^{\n]+?)\s*\{/.exec(after)?.[1] : undefined);
    if (returned?.trim()) parts.push(describe().text("returns ").code(returned.trim()).build());
  } else if (isDocumentSymbol(symbol) && symbol.detail) {
    parts.push(describe().text("has signature ").code(symbol.detail).build());
  }
  return describe().append(subject.build()).text(parts.length ? " " : "").append(clauses(parts)).text(".").build();
}

function describeValueSymbol(entry: FlatSymbol, lines: readonly string[]): Description {
  const { symbol, parent } = entry;
  const line = (lines[entry.selection.start.line] ?? "").slice(entry.selection.start.character);
  const before = (lines[entry.range.start.line] ?? "").trim();
  const exported = /^export\b/.test(before);
  const keyword = /\b(const|let|var|val|final|readonly)\b/.exec(before.split(symbol.name)[0] ?? "")?.[1];
  const afterName = line.slice(symbol.name.length);
  const type = /^\s*\??\s*:\s*([^=;,{]+?)\s*(?:[=;,]|$)/.exec(afterName)?.[1];
  const value = /^[^=]*?=(?!=|>)\s*(.+?)\s*;?\s*$/.exec(afterName)?.[1];
  let label = kindName(symbol.kind);
  if (symbol.kind === vscode.SymbolKind.Variable && (keyword === "const" || keyword === "final" || keyword === "val")) {
    label = "constant";
  }
  const builder = describe().text(capitalize([exported ? "exported" : "", label].filter(Boolean).join(" ")))
    .text(" ").code(symbol.name);
  if (parent && entry.depth > 0) {
    builder.text(FUNCTION_KINDS.has(parent.kind) ? " local to " : " of ").code(parent.name);
  }
  if (type) builder.text(" of type ").code(type);
  if (value) {
    if (/^(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/.test(value)) builder.text(", holding a function");
    else builder.text(", set to ").code(value);
  }
  return builder.text(".").build();
}

function describeTypeSymbol(entry: FlatSymbol, lines: readonly string[]): Description {
  const { symbol } = entry;
  const declaration = declarationText(lines, entry.range).split("{")[0] ?? "";
  const builder = describe();
  if (/^\s*export\b/.test(declaration)) builder.text("Exported ").text(kindName(symbol.kind));
  else builder.text(capitalize(kindName(symbol.kind)));
  builder.text(" ").code(symbol.name);
  const extendsMatch = /\bextends\s+([^{]+?)(?:\s+implements\b|$)/s.exec(declaration)?.[1];
  const implementsMatch = /\bimplements\s+([^{]+)/s.exec(declaration)?.[1];
  const pythonBases = /^\s*class\s+\w+\s*\(([^)]*)\)/.exec(declaration)?.[1];
  const bases = extendsMatch ?? pythonBases;
  if (bases?.trim()) {
    builder.text(" extends ").list(splitParameters(bases), (target, base) => target.code(base));
  }
  if (implementsMatch?.trim()) {
    builder.text(" and implements ").list(splitParameters(implementsMatch), (target, item) => target.code(item));
  }
  if (isDocumentSymbol(symbol) && symbol.kind === vscode.SymbolKind.Enum) {
    const members = symbol.children.filter((child) => child.kind === vscode.SymbolKind.EnumMember);
    if (members.length) builder.text(" with members ").list(members, (target, member) => target.code(member.name));
  }
  return builder.text(".").build();
}

function pythonDocstring(lines: readonly string[], range: vscode.Range): string | undefined {
  for (let line = range.start.line + 1; line <= Math.min(range.end.line, range.start.line + 6); line++) {
    const trimmed = lines[line]?.trim() ?? "";
    if (!trimmed) continue;
    const quote = /^[rubRUB]?("""|''')/.exec(trimmed)?.[1];
    if (!quote) return undefined;
    const collected: string[] = [];
    let text = trimmed.slice(trimmed.indexOf(quote) + 3);
    for (let current = line; current <= Math.min(range.end.line, line + 40); current++) {
      if (current > line) text = lines[current]!.trim();
      const closing = text.indexOf(quote);
      if (closing !== -1) {
        collected.push(text.slice(0, closing));
        return boundedDocumentation(collected);
      }
      collected.push(text);
    }
    return boundedDocumentation(collected);
  }
  return undefined;
}

async function documentSymbols(
  uri: vscode.Uri
): Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined | "failed"> {
  try {
    return await Promise.race([
      Promise.resolve(vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
      >("vscode.executeDocumentSymbolProvider", uri)),
      new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), SYMBOL_TIMEOUT_MS))
    ]);
  } catch {
    return "failed";
  }
}

async function describeWithEditorSymbols(
  document: vscode.TextDocument,
  lines: readonly string[]
): Promise<{ purpose?: string; drafts: OutlineEntryDraft[]; limitations: string[] }> {
  const languageId = document.languageId;
  const limitations: string[] = [];
  const symbols = await documentSymbols(document.uri);
  if (symbols === "failed") limitations.push("VS Code document-symbol lookup failed; functions and types are not described.");
  else if (!symbols) limitations.push("No VS Code document-symbol provider answered for this language; only imports and comments are described.");
  const flat = Array.isArray(symbols)
    ? flatten(symbols).filter((entry) => !IGNORED_KINDS.has(entry.symbol.kind))
    : [];
  const functionRanges = flat.filter((entry) => FUNCTION_KINDS.has(entry.symbol.kind)).map((entry) => entry.range);
  const insideFunction = (line: number) =>
    functionRanges.some((range) => range.start.line < line && line <= range.end.line);

  const comments = scanComments(lines, commentStyle(languageId));
  const usedComments = new Set<CommentBlock>();
  const attachedComment = (line: number): CommentBlock | undefined => {
    let above = line - 1;
    while (above >= 0 && /^\s*(?:@|\[)/.test(lines[above] ?? "")) above--;
    const block = comments.find((candidate) => candidate.end === above);
    if (block) usedComments.add(block);
    return block;
  };

  const drafts: OutlineEntryDraft[] = [];
  for (const entry of flat) {
    const { symbol } = entry;
    const kind = outlineKind(symbol.kind);
    const comment = attachedComment(entry.range.start.line);
    const documentation = comment?.text ??
      (languageId === "python" && (kind === "function" || kind === "type") ? pythonDocstring(lines, entry.range) : undefined);
    let description: Description;
    if (kind === "function") description = describeFunctionSymbol(entry, lines, languageId);
    else if (kind === "variable" || kind === "constant" || kind === "field") description = describeValueSymbol(entry, lines);
    else description = describeTypeSymbol(entry, lines);
    drafts.push({
      kind,
      kindLabel: capitalize(kindName(symbol.kind)),
      name: symbol.name,
      qualifiedName: entry.parent ? `${entry.parent.name}.${symbol.name}` : symbol.name,
      depth: entry.depth,
      startLine: comment?.start ?? entry.range.start.line,
      endLine: entry.range.end.line,
      nameLine: entry.selection.start.line,
      nameStart: entry.selection.start.character,
      nameEnd: entry.selection.end.character,
      description,
      ...(documentation ? { documentation } : {}),
      notes: [],
      explainable: FUNCTION_KINDS.has(symbol.kind)
    });
  }

  for (const statement of scanImports(languageId, lines, insideFunction)) {
    drafts.push({
      kind: "import",
      kindLabel: "Import",
      name: "",
      qualifiedName: "",
      depth: 0,
      startLine: statement.startLine,
      endLine: statement.endLine,
      nameLine: statement.startLine,
      nameStart: statement.indent,
      nameEnd: statement.length,
      description: statement.description,
      notes: [],
      explainable: false
    });
  }

  const firstCode = lines.findIndex(isCodeLine);
  const leading = comments[0];
  let purpose: string | undefined;
  if (leading && !usedComments.has(leading) && (firstCode === -1 || leading.start <= firstCode)) {
    purpose = leading.text;
    usedComments.add(leading);
  }
  for (const block of comments) {
    if (usedComments.has(block) || insideFunction(block.start)) continue;
    drafts.push(commentDraft(block.start, block.end, block.text, lines));
  }
  return { ...(purpose ? { purpose } : {}), drafts, limitations };
}

function finalize(drafts: readonly OutlineEntryDraft[], path: string): OutlineEntry[] {
  return [...drafts]
    .sort((left, right) => left.startLine - right.startLine || left.depth - right.depth)
    .slice(0, MAX_ENTRIES)
    .map((draft, index) => {
      const id = `entry-${index}`;
      return {
        ...draft,
        id,
        reference: {
          id,
          path,
          line: draft.nameLine,
          startCharacter: draft.nameStart,
          endCharacter: Math.max(draft.nameEnd, draft.nameStart),
          description: [draft.kindLabel, draft.qualifiedName].filter(Boolean).join(" ")
        }
      };
    });
}

/**
 * Builds a local, document-ordered description of the file. No provider
 * request is made; languages with bundled analysis use their parsers and
 * other languages use VS Code document symbols plus line-based import and
 * comment detection.
 */
export async function buildFileOverview(
  document: vscode.TextDocument,
  relativePath: string
): Promise<FileOverview> {
  const source = document.getText();
  const lines = source.split(/\r?\n/);
  const base = {
    fileName: basename(relativePath) || relativePath,
    path: relativePath,
    languageId: document.languageId,
    lineCount: lines.length
  };
  if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) {
    return {
      ...base,
      entries: [],
      limitations: ["This file is larger than 256 KiB, so it is not described."]
    };
  }
  let result: { purpose?: string; drafts: OutlineEntryDraft[]; limitations: string[] };
  const language = bundledLanguageFor({ languageId: document.languageId, path: document.uri.path });
  if (language?.describeSource) {
    try {
      result = { ...(await language.describeSource(source)), limitations: [] };
    } catch {
      const fallback = await describeWithEditorSymbols(document, lines);
      result = {
        ...fallback,
        limitations: [`The bundled ${language.name} parser was unavailable, so editor symbols were used.`, ...fallback.limitations]
      };
    }
  } else {
    result = await describeWithEditorSymbols(document, lines);
  }
  const entries = finalize(result.drafts, relativePath);
  const limitations = [...result.limitations];
  if (result.drafts.length > MAX_ENTRIES) limitations.push(`Only the first ${MAX_ENTRIES} items are described.`);
  return {
    ...base,
    ...(result.purpose ? { purpose: result.purpose } : {}),
    entries,
    limitations
  };
}
