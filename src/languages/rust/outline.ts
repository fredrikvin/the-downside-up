import type { Node as SyntaxNode } from "web-tree-sitter";
import { boundedDocumentation, commentDraft, type OutlineEntryDraft, type OutlineKind } from "../../context/outlineModel";
import { capitalize, clauses, describe, type Description } from "../../context/outlineText";
import { withRustSyntaxTree } from "./syntax";

const MAX_DRAFTS = 500;

interface Context {
  readonly lines: readonly string[];
  readonly drafts: OutlineEntryDraft[];
  readonly purpose: string[];
}

interface Container {
  readonly kind: "root" | "module" | "impl" | "trait";
  readonly depth: number;
  readonly path: readonly string[];
  readonly typeName?: string;
}

interface Pending {
  docs: string[];
  docStart?: number;
  attributes: SyntaxNode[];
  comment?: { start: number; end: number; lines: string[] };
}

type Builder = ReturnType<typeof describe>;

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((entry): entry is SyntaxNode => entry !== null);
}

function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

function childOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return named(node).find((entry) => entry.type === type);
}


function endRow(node: SyntaxNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

function visibility(node: SyntaxNode): string | undefined {
  const modifier = childOfType(node, "visibility_modifier")?.text.replace(/\s+/g, "");
  if (!modifier) return undefined;
  if (modifier === "pub") return "public";
  if (modifier === "pub(crate)") return "crate-visible";
  if (modifier === "pub(super)") return "parent-module-visible";
  if (modifier === "pub(self)") return undefined;
  return "restricted-visibility";
}

function subject(node: SyntaxNode, label: string, name: string, extra: string[] = []): Builder {
  const words = [visibility(node), ...extra, label].filter(Boolean).join(" ");
  return describe().text(capitalize(words)).text(" ").code(name);
}

function docText(comment: string): string | undefined {
  if (/^\/\/\/(?!\/)/.test(comment)) return comment.replace(/^\/\/\/\s?/, "");
  if (/^\/\*\*(?![*/])/.test(comment)) {
    return comment
      .replace(/^\/\*\*\s?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((line) => line.trim().replace(/^\*\s?/, ""))
      .join("\n");
  }
  return undefined;
}

function innerDocText(comment: string): string | undefined {
  if (comment.startsWith("//!")) return comment.replace(/^\/\/!\s?/, "");
  if (comment.startsWith("/*!")) return comment.replace(/^\/\*!\s?/, "").replace(/\*\/$/, "");
  return undefined;
}

function plainCommentText(comment: string): string {
  return comment
    .replace(/^\/\/+\s?/, "")
    .replace(/^\/\*+\s?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s?/, ""))
    .join("\n")
    .trim();
}

function attributeNote(attribute: SyntaxNode): Description {
  const text = attribute.text.replace(/\s+/g, " ");
  const inner = childOfType(attribute, "attribute");
  const path = inner ? (named(inner)[0]?.text ?? "") : "";
  const argumentsNode = inner ? field(inner, "arguments") : null;
  if (path === "derive" && argumentsNode) {
    const traits = named(argumentsNode).map((entry) => entry.text).filter((entry) => /^[\w:]+$/.test(entry));
    if (traits.length) {
      return describe().text("Derives ").list(traits, (builder, item) => builder.code(item), 12).text(".").build();
    }
  }
  if (text === "#[test]") return describe().text("Runs as a unit test (").code(text).text(").").build();
  if (text === "#[cfg(test)]") return describe().text("Compiled only when running tests (").code(text).text(").").build();
  if (path === "cfg") return describe().text("Compiled only when ").code(text).text(" holds.").build();
  return describe().text("Attribute ").code(text).text(".").build();
}

function parameterList(parameters: SyntaxNode | null): { self?: SyntaxNode; values: SyntaxNode[] } {
  const result: { self?: SyntaxNode; values: SyntaxNode[] } = { values: [] };
  for (const entry of parameters ? named(parameters) : []) {
    if (entry.type === "self_parameter") result.self = entry;
    else if (entry.type === "parameter" || entry.type === "variadic_parameter") result.values.push(entry);
  }
  return result;
}

function selfPhrase(node: SyntaxNode): Description {
  const text = node.text.replace(/\s+/g, " ");
  if (text.startsWith("&") && /\bmut\b/.test(text)) {
    return describe().text("borrows the value mutably (").code(text).text(")").build();
  }
  if (text.startsWith("&")) return describe().text("borrows the value (").code(text).text(")").build();
  return describe().text("takes ownership of the value (").code(text).text(")").build();
}

function describeParameter(builder: Builder, parameter: SyntaxNode): void {
  const pattern = field(parameter, "pattern");
  const type = field(parameter, "type");
  if (childOfType(parameter, "mutable_specifier")) builder.text("mutable ");
  builder.code(pattern?.text ?? parameter.text);
  if (type) builder.text(" (").code(type.text).text(")");
}

function functionDescription(node: SyntaxNode, container: Container, label: string): Description {
  const name = field(node, "name")?.text ?? "";
  const modifiers = childOfType(node, "function_modifiers")?.text.split(/\s+/).filter((word) =>
    ["async", "const", "unsafe"].includes(word)
  ) ?? [];
  const head = subject(node, label, name, modifiers);
  if (container.typeName && (container.kind === "impl" || container.kind === "trait")) {
    head.text(container.kind === "trait" ? " of trait " : " of ").code(container.typeName);
  }
  const { self, values } = parameterList(field(node, "parameters"));
  const parts: Description[] = [];
  if (self) parts.push(selfPhrase(self));
  if (values.length) parts.push(describe().text("takes ").list(values, describeParameter).build());
  else if (!self) parts.push(describe().text("takes no arguments").build());
  const returned = field(node, "return_type");
  parts.push(returned
    ? describe().text("returns ").code(returned.text).build()
    : describe().text("returns nothing").build());
  return describe().append(head.build()).text(" ").append(clauses(parts)).text(".").build();
}

function genericNotes(node: SyntaxNode): Description[] {
  const notes: Description[] = [];
  const typeParameters = field(node, "type_parameters");
  if (typeParameters) notes.push(describe().text("Generic over ").code(typeParameters.text).text(".").build());
  const where = childOfType(node, "where_clause");
  if (where) notes.push(describe().text("Constraint ").code(where.text).text(".").build());
  return notes;
}

function fieldList(builder: Builder, body: SyntaxNode | null, intro: string): void {
  if (!body) return;
  if (body.type === "field_declaration_list") {
    const fields = named(body).filter((entry) => entry.type === "field_declaration");
    if (!fields.length) return;
    builder.text(intro).text(fields.length > 1 ? "fields " : "field ").list(fields, (target, entry) => {
      target.code(field(entry, "name")?.text ?? "?");
      const type = field(entry, "type");
      if (type) target.text(" (").code(type.text).text(childOfType(entry, "visibility_modifier") ? ", public)" : ")");
    });
  } else if (body.type === "ordered_field_declaration_list") {
    const types = named(body).filter((entry) => entry.type !== "visibility_modifier" && entry.type !== "attribute_item");
    if (types.length) builder.text(intro).text("holding ").list(types, (target, entry) => target.code(entry.text));
  }
}

function useTargets(node: SyntaxNode, prefix: string): Array<{ from: string; name: string; alias?: string }> {
  const join = (left: string, right: string) => (left && right ? `${left}::${right}` : left || right);
  switch (node.type) {
    case "scoped_identifier": {
      const path = field(node, "path")?.text ?? "";
      return [{ from: join(prefix, path), name: field(node, "name")?.text ?? node.text }];
    }
    case "use_as_clause": {
      const path = field(node, "path");
      const alias = field(node, "alias")?.text;
      return path ? useTargets(path, prefix).map((entry) => ({ ...entry, ...(alias ? { alias } : {}) })) : [];
    }
    case "scoped_use_list": {
      const path = field(node, "path")?.text ?? "";
      const list = field(node, "list");
      return list ? useTargets(list, join(prefix, path)) : [];
    }
    case "use_list":
      return named(node).flatMap((entry) => useTargets(entry, prefix));
    case "use_wildcard": {
      const path = named(node)[0]?.text ?? "";
      return [{ from: join(prefix, path), name: "*" }];
    }
    default: {
      if (node.text === "self" && prefix) {
        const separator = prefix.lastIndexOf("::");
        return [{ from: separator === -1 ? "" : prefix.slice(0, separator), name: prefix.slice(separator + 2) }];
      }
      return [{ from: prefix, name: node.text }];
    }
  }
}

function pathHint(path: string): string {
  const root = path.split("::")[0];
  if (path === "super") return " (the parent module)";
  if (path === "crate") return " (the crate root)";
  if (path === "self") return " (this module)";
  if (root === "std" || root === "core" || root === "alloc") return " (the standard library)";
  if (root === "crate") return " (in this crate)";
  if (root === "super") return " (relative to the parent module)";
  return "";
}

function useDescription(node: SyntaxNode): Description {
  const argument = field(node, "argument");
  const targets = argument ? useTargets(argument, "") : [];
  const groups = new Map<string, Array<{ name: string; alias?: string }>>();
  for (const target of targets) {
    const group = groups.get(target.from) ?? [];
    group.push(target);
    groups.set(target.from, group);
  }
  const reexport = Boolean(visibility(node));
  const builder = describe().text(reexport ? "Re-exports " : "Imports ");
  builder.list([...groups.entries()], (target, [from, names]) => {
    const everything = names.some((entry) => entry.name === "*");
    if (everything) target.text("everything public");
    const specific = names.filter((entry) => entry.name !== "*");
    if (everything && specific.length) target.text(" and ");
    target.list(specific, (inner, entry) => {
      inner.code(entry.name);
      if (entry.alias) inner.text(" as ").code(entry.alias);
    });
    if (from) target.text(" from ").code(from).text(pathHint(from));
  });
  return builder.text(".").build();
}

function letDescription(node: SyntaxNode): Description {
  const pattern = field(node, "pattern");
  const type = field(node, "type");
  const value = field(node, "value");
  const mutable = Boolean(childOfType(node, "mutable_specifier"));
  const destructures = pattern && pattern.type !== "identifier";
  const builder = describe().text(destructures ? "Destructures into " : mutable ? "Declares mutable local " : "Declares local ")
    .code(pattern?.text ?? "_");
  if (type) builder.text(" of type ").code(type.text);
  if (value) builder.text(", set to ").code(value.text);
  if (field(node, "alternative")) builder.text(", returning early if the pattern does not match");
  return builder.text(".").build();
}

class RustDescriber {
  constructor(private readonly context: Context) {}

  private push(draft: Omit<OutlineEntryDraft, "notes"> & { notes?: readonly Description[] }): void {
    if (this.context.drafts.length >= MAX_DRAFTS) return;
    this.context.drafts.push({ notes: [], ...draft });
  }

  private nameRange(node: SyntaxNode, nameNode: SyntaxNode | null): Pick<OutlineEntryDraft, "nameLine" | "nameStart" | "nameEnd"> {
    const target = nameNode ?? node;
    const row = target.startPosition.row;
    const end = target.endPosition.row === row ? target.endPosition.column : Buffer.byteLength(this.context.lines[row] ?? "", "utf8");
    return {
      nameLine: row,
      nameStart: target.startPosition.column,
      nameEnd: end
    };
  }

  private flushComment(pending: Pending, depth: number): void {
    if (!pending.comment) return;
    const text = boundedDocumentation(pending.comment.lines);
    if (text) this.context.drafts.push(commentDraft(pending.comment.start, pending.comment.end, text, this.context.lines, depth));
    pending.comment = undefined;
  }

  private flushOrphans(pending: Pending, depth: number): void {
    this.flushComment(pending, depth);
    if (pending.docs.length && pending.docStart !== undefined) {
      const text = boundedDocumentation(pending.docs);
      if (text) this.context.drafts.push(commentDraft(pending.docStart, pending.docStart + pending.docs.length - 1, text, this.context.lines, depth));
    }
    pending.docs = [];
    pending.docStart = undefined;
    pending.attributes = [];
  }

  visitItems(parent: SyntaxNode, container: Container): void {
    const pending: Pending = { docs: [], attributes: [] };
    for (const node of named(parent)) {
      if (this.context.drafts.length >= MAX_DRAFTS) return;
      const row = node.startPosition.row;
      if (node.type === "line_comment" || node.type === "block_comment") {
        const text = node.text.trimEnd();
        const inner = innerDocText(text);
        if (inner !== undefined) {
          if (container.kind === "root") this.context.purpose.push(inner);
          continue;
        }
        const doc = docText(text);
        if (doc !== undefined) {
          this.flushComment(pending, container.depth);
          pending.docStart ??= row;
          pending.docs.push(...doc.split("\n"));
          continue;
        }
        if (pending.comment && pending.comment.end >= row - 1) {
          pending.comment.end = endRow(node);
          pending.comment.lines.push(plainCommentText(text));
        } else {
          this.flushComment(pending, container.depth);
          pending.comment = { start: row, end: endRow(node), lines: [plainCommentText(text)] };
        }
        continue;
      }
      if (node.type === "attribute_item") {
        pending.attributes.push(node);
        continue;
      }
      if (node.type === "inner_attribute_item" || node.type === "empty_statement") continue;

      const firstAttribute = pending.attributes[0]?.startPosition.row;
      const commentAttached = pending.comment !== undefined && pending.comment.end >= (firstAttribute ?? row) - 1;
      const docLines = [
        ...(commentAttached ? pending.comment!.lines : []),
        ...pending.docs
      ];
      const startLine = Math.min(
        row,
        firstAttribute ?? row,
        pending.docStart ?? row,
        commentAttached ? pending.comment!.start : row
      );
      if (!commentAttached) this.flushComment(pending, container.depth);
      const documentation = boundedDocumentation(docLines);
      const notes = pending.attributes.map(attributeNote);
      pending.docs = [];
      pending.docStart = undefined;
      pending.attributes = [];
      pending.comment = undefined;
      this.visitItem(node, container, { startLine, notes, ...(documentation ? { documentation } : {}) });
    }
    this.flushOrphans(pending, container.depth);
  }

  private visitItem(
    node: SyntaxNode,
    container: Container,
    preamble: { startLine: number; notes: Description[]; documentation?: string }
  ): void {
    const nameNode = field(node, "name");
    const name = nameNode?.text ?? "";
    const qualified = [...container.path, name].filter(Boolean).join("::");
    const common = {
      depth: container.depth,
      startLine: preamble.startLine,
      endLine: endRow(node),
      ...this.nameRange(node, nameNode),
      ...(preamble.documentation ? { documentation: preamble.documentation } : {}),
      qualifiedName: qualified,
      name
    };
    const entry = (
      kind: OutlineKind,
      kindLabel: string,
      description: Description,
      extraNotes: Description[] = [],
      explainable = false
    ) => this.push({ ...common, kind, kindLabel, description, notes: [...preamble.notes, ...extraNotes], explainable });

    switch (node.type) {
      case "use_declaration":
        this.push({ ...common, name: "", qualifiedName: "", ...this.nameRange(node, null), kind: "import", kindLabel: "Import", description: useDescription(node), notes: preamble.notes, explainable: false });
        return;
      case "extern_crate_declaration":
        entry("import", "Extern crate", describe().text("Links the external crate ").code(name).text(".").build());
        return;
      case "mod_item": {
        const body = field(node, "body");
        if (!body) {
          entry("module", "Module", subject(node, "module", name).text(", loaded from ").code(`${name}.rs`).text(" or ").code(`${name}/mod.rs`).text(".").build());
          return;
        }
        entry("module", "Module", subject(node, "inline module", name).text(".").build());
        this.visitItems(body, { kind: "module", depth: container.depth + 1, path: [...container.path, name] });
        return;
      }
      case "function_item":
      case "function_signature_item": {
        const inImpl = container.kind === "impl" || container.kind === "trait";
        const hasSelf = Boolean(parameterList(field(node, "parameters")).self);
        const label = container.kind === "trait"
          ? (node.type === "function_item" ? "provided method" : "required method")
          : inImpl ? (hasSelf ? "method" : "associated function") : "function";
        const notes = genericNotes(node);
        if (container.kind === "root" && name === "main") {
          notes.unshift(describe().text("Program entry point: runs when the binary starts.").build());
        }
        entry("function", capitalize(label), functionDescription(node, container, label), notes, node.type === "function_item");
        const body = field(node, "body");
        if (body) this.visitBody(body, container.depth + 1, qualified);
        return;
      }
      case "struct_item": {
        const body = field(node, "body");
        const builder = subject(node, body ? (body.type === "ordered_field_declaration_list" ? "tuple struct" : "struct") : "unit struct", name);
        if (body?.type === "field_declaration_list" && !named(body).some((entry) => entry.type === "field_declaration")) builder.text(" with no fields");
        fieldList(builder, body, " with ");
        entry("type", "Struct", builder.text(".").build(), genericNotes(node));
        return;
      }
      case "union_item": {
        const builder = subject(node, "union", name);
        fieldList(builder, field(node, "body"), " overlaying ");
        entry("type", "Union", builder.text(".").build(), genericNotes(node));
        return;
      }
      case "enum_item": {
        const variants = named(field(node, "body") ?? node).filter((entry) => entry.type === "enum_variant");
        const builder = subject(node, "enum", name);
        if (variants.length) {
          builder.text(variants.length > 1 ? " with variants " : " with variant ").list(variants, (target, variant) => {
            target.code(field(variant, "name")?.text ?? variant.text);
            const body = field(variant, "body");
            if (body?.type === "ordered_field_declaration_list") {
              target.text(" (holding ").list(named(body), (inner, entry) => inner.code(entry.text)).text(")");
            } else if (body?.type === "field_declaration_list") {
              target.text(" (with ").list(named(body).filter((entry) => entry.type === "field_declaration"), (inner, entry) =>
                inner.code(field(entry, "name")?.text ?? entry.text)
              ).text(")");
            }
          }, 12);
        }
        entry("type", "Enum", builder.text(".").build(), genericNotes(node));
        return;
      }
      case "trait_item": {
        const builder = subject(node, "trait", name);
        const bounds = field(node, "bounds");
        if (bounds) builder.text(" requiring ").code(bounds.text.replace(/^:\s*/, ""));
        entry("type", "Trait", builder.text(".").build(), genericNotes(node));
        const body = field(node, "body");
        if (body) this.visitItems(body, { kind: "trait", depth: container.depth + 1, path: [...container.path, name], typeName: name });
        return;
      }
      case "impl_item": {
        const type = field(node, "type")?.text ?? "?";
        const trait = field(node, "trait")?.text;
        const body = field(node, "body");
        const empty = !body || named(body).every((entry) => entry.type.endsWith("comment"));
        const builder = describe();
        if (trait) {
          builder.text(node.children.some((entry) => entry?.type === "!") ? "Opts out of " : "Implements ").code(trait).text(" for ").code(type);
          if (empty) builder.text(", using only the trait's default methods");
        } else {
          builder.text("Methods and associated functions of ").code(type);
        }
        this.push({
          ...common,
          name: type,
          qualifiedName: trait ? `${trait} for ${type}` : type,
          ...this.nameRange(node, field(node, "type")),
          kind: "impl",
          kindLabel: trait ? "Trait implementation" : "Implementation",
          description: builder.text(".").build(),
          notes: [...preamble.notes, ...genericNotes(node)],
          explainable: false
        });
        if (body) this.visitItems(body, { kind: "impl", depth: container.depth + 1, path: [...container.path, type], typeName: type });
        return;
      }
      case "const_item":
      case "static_item": {
        const isStatic = node.type === "static_item";
        const mutable = isStatic && Boolean(childOfType(node, "mutable_specifier"));
        const builder = subject(node, isStatic ? (mutable ? "mutable static" : "static") : "constant", name);
        const type = field(node, "type");
        const value = field(node, "value");
        if (type) builder.text(" of type ").code(type.text);
        if (value) builder.text(", set to ").code(value.text);
        const notes = mutable ? [describe().text("Reading or writing it requires ").code("unsafe").text(".").build()] : [];
        entry("constant", isStatic ? "Static" : "Constant", builder.text(".").build(), notes);
        return;
      }
      case "type_item": {
        const type = field(node, "type");
        const builder = subject(node, "type alias", name);
        if (type) builder.text(" for ").code(type.text);
        entry("type", "Type alias", builder.text(".").build(), genericNotes(node));
        return;
      }
      case "associated_type": {
        entry("type", "Associated type", describe().text("Associated type ").code(name).text(" that implementors choose.").build());
        return;
      }
      case "macro_definition":
        entry("macro", "Macro", describe().text("Defines the macro ").code(`${name}!`).text(" with ").code("macro_rules!").text(".").build());
        return;
      case "macro_invocation": {
        const macro = field(node, "macro")?.text ?? node.text.split("!")[0] ?? "";
        this.push({ ...common, name: `${macro}!`, qualifiedName: `${macro}!`, ...this.nameRange(node, field(node, "macro")), kind: "macro", kindLabel: "Macro call", description: describe().text("Expands the macro ").code(`${macro}!`).text(" at item level.").build(), notes: preamble.notes, explainable: false });
        return;
      }
      case "foreign_mod_item":
        this.push({ ...common, name: "extern", qualifiedName: "extern", ...this.nameRange(node, null), kind: "module", kindLabel: "Foreign block", description: describe().text("Declares items provided by foreign code (").code(node.text.split("{")[0]!.trim()).text(").").build(), notes: preamble.notes, explainable: false });
        return;
      default:
        if (name && node.type.endsWith("_item")) {
          const label = node.type.replace(/_item$/, "").replace(/_/g, " ");
          entry("type", capitalize(label), subject(node, label, name).text(".").build());
        }
    }
  }

  private visitBody(body: SyntaxNode, depth: number, owner: string): void {
    for (const statement of named(body)) {
      if (this.context.drafts.length >= MAX_DRAFTS) return;
      if (statement.type === "let_declaration") {
        const pattern = field(statement, "pattern");
        const name = pattern?.text ?? "";
        this.push({
          kind: "variable",
          kindLabel: "Local",
          name,
          qualifiedName: `${owner}::${name}`,
          depth,
          startLine: statement.startPosition.row,
          endLine: endRow(statement),
          ...this.nameRange(statement, pattern),
          description: letDescription(statement),
          explainable: false
        });
      } else if (statement.type === "function_item" || statement.type === "struct_item" ||
        statement.type === "enum_item" || statement.type === "const_item" || statement.type === "static_item" ||
        statement.type === "use_declaration" || statement.type === "impl_item") {
        this.visitItem(statement, { kind: "module", depth, path: [owner] }, { startLine: statement.startPosition.row, notes: [] });
      }
    }
  }
}

/** Describes Rust items in source order from the bundled Tree-sitter grammar. */
export async function describeRustSource(
  source: string
): Promise<{ purpose?: string; drafts: OutlineEntryDraft[] }> {
  const lines = source.split("\n");
  const context: Context = { lines, drafts: [], purpose: [] };
  const parsed = await withRustSyntaxTree(source, (root) => {
    new RustDescriber(context).visitItems(root, { kind: "root", depth: 0, path: [] });
    return true;
  });
  if (!parsed) throw new Error("Tree-sitter could not parse the Rust source.");
  const purpose = boundedDocumentation(context.purpose);
  return { ...(purpose ? { purpose } : {}), drafts: context.drafts };
}
