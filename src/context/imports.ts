import { describe, type Description } from "./outlineText";

export interface ImportStatement {
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: number;
  readonly length: number;
  readonly description: Description;
}

const MAX_STATEMENT_LINES = 40;

const JS_LANGUAGES = new Set([
  "javascript", "javascriptreact", "typescript", "typescriptreact", "vue", "svelte", "astro"
]);
const JVM_LANGUAGES = new Set(["java", "kotlin", "scala", "groovy"]);
const C_LANGUAGES = new Set(["c", "cpp", "objective-c", "objective-cpp", "cuda-cpp"]);

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if ("{([<".includes(character)) depth++;
    if ("})]>".includes(character)) depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function aliased(builder: ReturnType<typeof describe>, name: string, alias?: string): void {
  builder.code(name);
  if (alias && alias !== name) builder.text(" as ").code(alias);
}

function describeJavaScript(statement: string): Description | undefined {
  const compact = statement.replace(/\s+/g, " ").trim();
  const sideEffect = /^import\s+["']([^"']+)["']/.exec(compact);
  if (sideEffect) {
    return describe().text("Loads ").code(sideEffect[1]!).text(" for its side effects.").build();
  }
  const match = /^(import|export)\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["']/.exec(compact);
  if (!match) return undefined;
  const [, verb, typeOnly, clause, source] = match;
  const items: Array<(builder: ReturnType<typeof describe>) => void> = [];
  for (const part of splitTopLevel(clause!)) {
    if (part.startsWith("{")) {
      for (const named of splitTopLevel(part.replace(/^\{|\}$/g, ""))) {
        const [name, alias] = named.replace(/^type\s+/, "").split(/\s+as\s+/);
        if (name) items.push((builder) => aliased(builder, name, alias));
      }
    } else if (part.startsWith("*")) {
      const namespace = /\*\s+as\s+(\S+)/.exec(part)?.[1];
      items.push((builder) => {
        builder.text("all exports");
        if (namespace) builder.text(" as namespace ").code(namespace);
      });
    } else {
      items.push((builder) => builder.text("the default export as ").code(part));
    }
  }
  if (items.length === 0) return undefined;
  const builder = describe().text(verb === "export" ? "Re-exports " : "Imports ");
  if (typeOnly) builder.text("types ");
  builder.list(items, (target, write) => write(target));
  return builder.text(" from ").code(source!).text(".").build();
}

function pythonModuleHint(module: string): string {
  if (/^\.+$/.test(module)) return module.length === 1 ? " (this package)" : " (a parent package)";
  return module.startsWith(".") ? " (relative to this package)" : "";
}

function describePython(statement: string): Description | undefined {
  const compact = statement.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
  const fromImport = /^from\s+(\S+)\s+import\s+\(?(.+?)\)?$/.exec(compact);
  if (fromImport) {
    const [, module, names] = fromImport;
    if (names!.trim() === "*") {
      return describe().text("Imports everything public from ").code(module!)
        .text(`${pythonModuleHint(module!)}.`).build();
    }
    const entries = splitTopLevel(names!).map((name) => name.split(/\s+as\s+/));
    return describe().text("Imports ")
      .list(entries, (builder, [name, alias]) => aliased(builder, name!, alias))
      .text(" from ").code(module!).text(`${pythonModuleHint(module!)}.`).build();
  }
  const plainImport = /^import\s+(.+)$/.exec(compact);
  if (!plainImport) return undefined;
  const modules = splitTopLevel(plainImport[1]!).map((name) => name.split(/\s+as\s+/));
  return describe().text(modules.length > 1 ? "Imports modules " : "Imports module ")
    .list(modules, (builder, [name, alias]) => aliased(builder, name!, alias))
    .text(".").build();
}

function describeGo(statement: string): Description | undefined {
  const specs = [...statement.matchAll(/(?:^|[\s(])([\w.]+\s+)?"([^"]+)"/g)].map((match) => ({
    alias: match[1]?.trim(),
    path: match[2]!
  }));
  if (specs.length === 0) return undefined;
  return describe().text(specs.length > 1 ? "Imports packages " : "Imports package ")
    .list(specs, (builder, spec) => {
      builder.code(spec.path);
      if (spec.alias === "_") builder.text(" for its side effects");
      else if (spec.alias === ".") builder.text(" into this file's scope");
      else if (spec.alias) builder.text(" as ").code(spec.alias);
    })
    .text(".").build();
}

function describeLine(languageId: string, line: string): Description | undefined {
  const trimmed = line.trim();
  if (JVM_LANGUAGES.has(languageId)) {
    const match = /^import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?$/.exec(trimmed);
    if (!match) return undefined;
    const [, isStatic, path, wildcard, alias] = match;
    if (wildcard) return describe().text("Imports everything from ").code(path!).text(".").build();
    const separator = path!.lastIndexOf(".");
    const builder = describe().text(isStatic ? "Imports static member " : "Imports ");
    aliased(builder, path!.slice(separator + 1), alias);
    return separator > 0 ? builder.text(" from ").code(path!.slice(0, separator)).text(".").build() : builder.text(".").build();
  }
  if (languageId === "csharp") {
    const match = /^(global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.<>]+)\s*;$/.exec(trimmed);
    if (!match) return undefined;
    const [, global, isStatic, alias, target] = match;
    const builder = describe();
    if (alias) builder.text("Defines alias ").code(alias).text(" for ").code(target!);
    else builder.text(isStatic ? "Uses the static members of " : "Uses namespace ").code(target!);
    return builder.text(global ? " in every file of the project." : ".").build();
  }
  if (C_LANGUAGES.has(languageId)) {
    const match = /^#\s*(include|import)\s*([<"])([^>"]+)[>"]/.exec(trimmed);
    if (!match) return undefined;
    return describe().text(match[2] === "<" ? "Includes system header " : "Includes project header ")
      .code(match[3]!).text(".").build();
  }
  if (languageId === "php") {
    const match = /^use\s+(function\s+|const\s+)?([\w\\{}, ]+?)(?:\s+as\s+(\w+))?\s*;$/.exec(trimmed);
    if (!match) return undefined;
    const builder = describe().text("Imports ");
    aliased(builder, match[2]!.trim(), match[3]);
    return builder.text(".").build();
  }
  if (languageId === "ruby") {
    const match = /^(require|require_relative|load)\s*\(?\s*["']([^"']+)["']/.exec(trimmed);
    if (!match) return undefined;
    return describe().text(match[1] === "require_relative" ? "Loads the file " : "Loads the library ")
      .code(match[2]!).text(".").build();
  }
  if (languageId === "swift") {
    const match = /^(?:@\w+\s+)*import\s+(?:\w+\s+)?([\w.]+)$/.exec(trimmed);
    return match ? describe().text("Imports module ").code(match[1]!).text(".").build() : undefined;
  }
  return undefined;
}

function statementEnd(languageId: string, lines: readonly string[], start: number): number {
  const first = lines[start]!.trim();
  const limit = Math.min(lines.length - 1, start + MAX_STATEMENT_LINES);
  if (JS_LANGUAGES.has(languageId)) {
    for (let line = start; line <= limit; line++) {
      const text = lines.slice(start, line + 1).join("\n");
      if (/\bfrom\s+["'][^"']+["']/.test(text) || /^\s*import\s+["']/.test(text) || /;\s*$/.test(lines[line]!)) {
        return line;
      }
    }
    return start;
  }
  if (languageId === "python") {
    if (first.includes("(") && !first.includes(")")) {
      for (let line = start + 1; line <= limit; line++) if (lines[line]!.includes(")")) return line;
    }
    let line = start;
    while (line < limit && /\\\s*$/.test(lines[line]!)) line++;
    return line;
  }
  if (languageId === "go" && /^import\s*\($/.test(first)) {
    for (let line = start + 1; line <= limit; line++) if (lines[line]!.trim() === ")") return line;
  }
  return start;
}

function startsImport(languageId: string, line: string): boolean {
  const trimmed = line.trim();
  if (JS_LANGUAGES.has(languageId)) return /^(?:import\b(?!\s*\()|export\s+(?:type\s+)?(?:\*|\{[^}]*\}?)\s*(?:as\s+\w+\s+)?(?:from\b|$))/.test(trimmed);
  if (languageId === "python") return /^(?:from\s+\S+\s+import\b|import\s+\w)/.test(trimmed);
  if (languageId === "go") return /^import\b/.test(trimmed);
  return describeLine(languageId, line) !== undefined;
}

function describeStatement(languageId: string, statement: string): Description | undefined {
  if (JS_LANGUAGES.has(languageId)) return describeJavaScript(statement);
  if (languageId === "python") return describePython(statement);
  if (languageId === "go") return describeGo(statement);
  return describeLine(languageId, statement);
}

/**
 * Finds import-like statements line by line. Lines for which `skip` returns
 * true (for example function bodies) are not scanned.
 */
export function scanImports(
  languageId: string,
  lines: readonly string[],
  skip: (line: number) => boolean = () => false
): ImportStatement[] {
  const found: ImportStatement[] = [];
  for (let line = 0; line < lines.length; line++) {
    if (skip(line) || !startsImport(languageId, lines[line]!)) continue;
    const end = statementEnd(languageId, lines, line);
    const description = describeStatement(languageId, lines.slice(line, end + 1).join("\n"));
    if (description) {
      const text = lines[line]!;
      found.push({
        startLine: line,
        endLine: end,
        indent: text.length - text.trimStart().length,
        length: text.length,
        description
      });
    }
    line = end;
  }
  return found;
}
