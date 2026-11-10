import { scanImports } from "../../context/imports";
import { type OutlineEntryDraft } from "../../context/outlineModel";
import { describe, type Description } from "../../context/outlineText";
import type { SourceDescription } from "../support";
import { scanSvelte } from "./blocks";
import { componentName, componentSignature, functionEntries, withSvelteSyntaxTree } from "./syntax";

function lineAt(source: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset; index++) if (source[index] === "\n") line++;
  return line;
}

function draft(
  kind: OutlineEntryDraft["kind"],
  kindLabel: string,
  name: string,
  qualifiedName: string,
  startLine: number,
  endLine: number,
  nameStart: number,
  description: Description,
  explainable = false,
  depth = 0
): OutlineEntryDraft {
  return {
    kind, kindLabel, name, qualifiedName, depth, startLine, endLine,
    nameLine: startLine, nameStart, nameEnd: nameStart + name.length,
    description, notes: [], explainable
  };
}

export async function describeSvelteSource(source: string, path: string): Promise<SourceDescription> {
  const scan = scanSvelte(source);
  if (!scan.supported) return { drafts: [] };
  const lines = source.split(/\r?\n/);
  const scripts = scan.scripts;
  const drafts: OutlineEntryDraft[] = scanImports("svelte", lines)
    .filter((entry) => scripts.some((script) => entry.startLine >= lineAt(source, script.contentStart) &&
      entry.startLine <= lineAt(source, script.contentEnd)))
    .map((entry) => ({
      kind: "import",
      kindLabel: "Import",
      name: "",
      qualifiedName: "",
      depth: 0,
      startLine: entry.startLine,
      endLine: entry.endLine,
      nameLine: entry.startLine,
      nameStart: 0,
      nameEnd: entry.length,
      description: entry.description,
      notes: [],
      explainable: false
    }));

  const name = componentName(path);
  const signature = componentSignature(source, name);
  drafts.push(draft(
    "function", "Component", name, name, 0, Math.max(0, lines.length - 1), 0,
    describe().code(signature).text(" combines its script with its markup.").build(),
    true
  ));

  const root = await withSvelteSyntaxTree(source, path, (syntax) => {
    const functions = functionEntries(source, path, syntax);
    for (const { entry, qualifiedName, module } of functions) {
      const line = entry.node.startPosition.row;
      drafts.push(draft(
        "function", entry.kind === "method" ? "Method" : "Function",
        entry.simpleName, qualifiedName, line, Math.max(line, entry.node.endPosition.row),
        entry.name?.startPosition.column ?? entry.node.startPosition.column,
        describe().text(module ? "Rune-module function " : "Function ")
          .code(qualifiedName).text(" is defined in the component script.").build(),
        true,
        module ? 1 : 0
      ));

    }
    return true;
  });
  if (!root) return { drafts };

  for (const match of scan.scriptView.matchAll(/\$state\s*(?:<[^>]*>)?\s*\(\s*([^)]{0,80})\s*\)/g)) {
    const offset = match.index ?? 0;
    drafts.push(draft("variable", "State", "$state", `${name}.$state`, lineAt(source, offset),
      lineAt(source, offset), offset - (source.lastIndexOf("\n", offset - 1) + 1),
      describe().text("Reactive state in ").code(name).text(".").build(), false, 1));
  }
  for (const match of scan.scriptView.matchAll(/\$derived(?:\.by)?\s*\(/g)) {
    const offset = match.index ?? 0;
    drafts.push(draft("variable", "Derived value", "$derived", `${name}.$derived`, lineAt(source, offset),
      lineAt(source, offset), offset - (source.lastIndexOf("\n", offset - 1) + 1),
      describe().text("Value derived from other reactive values in ").code(name).text(".").build(), false, 1));
  }
  for (const match of scan.scriptView.matchAll(/\$effect(?:\.pre)?\s*\(/g)) {
    const offset = match.index ?? 0;
    drafts.push(draft("variable", "Effect", "$effect", `${name}.$effect`, lineAt(source, offset),
      lineAt(source, offset), offset - (source.lastIndexOf("\n", offset - 1) + 1),
      describe().text("Reactive effect in ").code(name).text(".").build(), false, 1));
  }

  const directives = [...scan.markupView.matchAll(/\{[#/@:]([a-z]+)\b/g)].map((match) => match[1]!);
  const modes = new Set(directives);
  if (modes.size || scan.markupView.trim()) {
    drafts.push(draft(
      "variable", "Markup", "Markup", `${name}.markup`, 0, Math.max(0, lines.length - 1), 0,
      modes.size
        ? describe().text("Markup includes ").list([...modes], (builder, mode) => builder.code(`{${mode}}`))
          .text(" blocks.").build()
        : describe().text("Markup shows the component's content and child components.").build(),
      false, 1
    ));
  }
  return { drafts };
}
