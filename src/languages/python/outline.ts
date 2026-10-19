import type { Node as SyntaxNode } from "web-tree-sitter";
import { boundedDocumentation, commentDraft, type OutlineEntryDraft } from "../../context/outlineModel";
import { scanImports } from "../../context/imports";
import { describe, type Description } from "../../context/outlineText";
import type { SourceDescription } from "../support";
import { namedChildren } from "../treeSitter";
import { pythonDefinition, pythonDocstring, pythonFunctionNodes, withPythonSyntaxTree } from "./syntax";

function functionDescription(node: SyntaxNode, method: boolean): Description {
  const name = node.childForFieldName("name")!.text;
  const isAsync = node.text.startsWith("async ");
  const builder = describe().text(isAsync ? method ? "Async method " : "Async function " : method ? "Method " : "Function ").code(name);
  const parameters = node.childForFieldName("parameters");
  const args = parameters ? namedChildren(parameters).filter((parameter, index) =>
    parameter.type !== "comment" && !["keyword_separator", "positional_separator"].includes(parameter.type) &&
    !(method && index === 0 && /^(self|cls)$/.test(parameter.text))) : [];
  if (args.length) builder.text(" takes ").list(args, (target, parameter) => target.code(parameter.text));
  else builder.text(" takes no arguments");
  const result = node.childForFieldName("return_type");
  if (result) builder.text(" and returns ").code(result.text);
  return builder.text(".").build();
}

export async function describePythonSource(source: string): Promise<SourceDescription> {
  return (await withPythonSyntaxTree(source, (root) => {
    const drafts: OutlineEntryDraft[] = [];
    const functions = new Map(pythonFunctionNodes(root).map((entry) => [entry.node.id, entry]));
    const lines = source.split(/\r?\n/);
    const imports = new Map(scanImports("python", lines).map((entry) => [entry.startLine, entry]));
    const push = (
      node: SyntaxNode, nameNode: SyntaxNode, name: string, qualifiedName: string,
      kind: OutlineEntryDraft["kind"], kindLabel: string, depth: number,
      description: Description, documentation?: string, notes: Description[] = []
    ) => {
      if (drafts.length >= 500) return;
      drafts.push({
        kind, kindLabel, name, qualifiedName, depth, description,
        startLine: node.startPosition.row, endLine: node.endPosition.row,
        nameLine: nameNode.startPosition.row, nameStart: nameNode.startPosition.column,
        nameEnd: nameNode.endPosition.row === nameNode.startPosition.row ? nameNode.endPosition.column : (lines[nameNode.startPosition.row]?.length ?? 0),
        documentation, notes, explainable: kind === "function"
      });
    };
    const visit = (node: SyntaxNode, containers: string[], owner?: "function" | "class") => {
      if (drafts.length >= 500) return;
      const definition = pythonDefinition(node);
      if (definition.type === "function_definition" || definition.type === "class_definition") {
        const name = definition.childForFieldName("name");
        const body = definition.childForFieldName("body");
        if (!name || !body) return;
        const names = [...containers, name.text];
        const fn = functions.get(node.id);
        const documentation = boundedDocumentation([pythonDocstring(body) ?? ""]);
        const decorators = node.type === "decorated_definition"
          ? namedChildren(node).filter((child) => child.type === "decorator").map((child) =>
            describe().text("Decorated with ").code(child.text.slice(1)).text(".").build()) : [];
        if (fn) {
          push(node, name, name.text, fn.qualifiedName, "function", fn.method ? "Method" : "Function",
            containers.length, functionDescription(definition, fn.method), documentation, decorators);
        } else {
          const builder = describe().text("Class ").code(name.text);
          const bases = definition.childForFieldName("superclasses");
          if (bases) builder.text(" with bases ").list(namedChildren(bases), (target, base) => target.code(base.text));
          push(node, name, name.text, names.join("."), "type", "Class", containers.length, builder.text(".").build(), documentation, decorators);
        }
        for (const child of namedChildren(definition).filter((entry) => entry.type === "comment")) {
          visit(child, names, fn ? "function" : "class");
        }
        for (const child of namedChildren(body)) visit(child, names, fn ? "function" : "class");
        return;
      }
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        push(node, node, node.text, node.text, "import", "Import", containers.length,
          imports.get(node.startPosition.row)?.description ?? describe().text("Import ").code(node.text).text(".").build());
        return;
      }
      if (node.type === "assignment") {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "identifier") {
          const constant = !owner && /^[A-Z_][A-Z_0-9]*$/.test(left.text);
          const kind = constant ? "constant" : owner === "class" ? "field" : "variable";
          const label = constant ? "Constant" : owner === "class" ? "Field" : owner ? "Local" : "Variable";
          const builder = describe().text(`${label} `).code(left.text);
          const annotation = node.childForFieldName("type");
          if (annotation) builder.text(" (").code(annotation.text).text(")");
          if (right) builder.text(", set to ").code(right.text);
          push(node, left, left.text, [...containers, left.text].join("."), kind, label, containers.length, builder.text(".").build());
        }
      }
      if (node.type === "comment") {
        drafts.push(commentDraft(node.startPosition.row, node.endPosition.row, node.text.replace(/^#\s?/, ""), lines, containers.length));
        return;
      }
      if (node.type === "lambda") return;
      for (const child of namedChildren(node)) visit(child, containers, owner);
    };
    for (const node of namedChildren(root)) visit(node, []);
    drafts.sort((left, right) => left.startLine - right.startLine || left.depth - right.depth);
    let purpose = boundedDocumentation([pythonDocstring(root) ?? ""]);
    const consumed = new Set<OutlineEntryDraft>();
    const attached = drafts.map((entry) => {
      if (!["function", "type", "constant"].includes(entry.kind)) return entry;
      const comments: OutlineEntryDraft[] = [];
      let previousLine = entry.startLine - 1;
      for (let index = drafts.indexOf(entry) - 1; index >= 0; index--) {
        const candidate = drafts[index]!;
        if (candidate.kind !== "comment" || candidate.endLine !== previousLine || candidate.depth !== entry.depth) break;
        comments.unshift(candidate);
        consumed.add(candidate);
        previousLine = candidate.startLine - 1;
      }
      if (!comments.length) return entry;
      return {
        ...entry, startLine: comments[0]!.startLine,
        documentation: boundedDocumentation([...comments.map((comment) => comment.description.map((part) => part.text).join("")), entry.documentation ?? ""])
      };
    });
    if (!purpose && drafts[0]?.kind === "comment" && drafts[0].startLine === 0 && !consumed.has(drafts[0])) {
      const leading: string[] = [];
      let line = 0;
      for (const entry of drafts) {
        if (entry.kind !== "comment" || entry.startLine !== line || consumed.has(entry)) break;
        leading.push(entry.description.map((part) => part.text).join(""));
        consumed.add(entry);
        line = entry.endLine + 1;
      }
      purpose = boundedDocumentation(leading);
    }
    return { purpose, drafts: attached.filter((entry) => !consumed.has(entry)) };
  })) ?? { drafts: [] };
}
