import type { Node as SyntaxNode } from "web-tree-sitter";
import { boundedDocumentation, commentDraft, type OutlineEntryDraft, type OutlineKind } from "../context/outlineModel";
import { capitalize, clauses, describe, type Description } from "../context/outlineText";
import { goReceiverType, withGoSyntaxTree } from "./go";
import { allChildren, namedChildren as named } from "./treeSitter";

const MAX_DRAFTS = 500;

type Builder = ReturnType<typeof describe>;

interface Context {
  readonly lines: readonly string[];
  readonly drafts: OutlineEntryDraft[];
  readonly purpose: string[];
  packageName?: string;
}

interface Pending {
  comment?: { start: number; end: number; lines: string[] };
  directives: SyntaxNode[];
}

interface Preamble {
  readonly startLine: number;
  readonly notes: Description[];
  readonly documentation?: string;
}

function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

function fields(node: SyntaxNode, name: string): SyntaxNode[] {
  return node.childrenForFieldName(name).filter((entry): entry is SyntaxNode => entry !== null);
}

function character(lines: readonly string[], row: number, byteColumn: number): number {
  const line = lines[row] ?? "";
  return Buffer.from(line, "utf8").subarray(0, byteColumn).toString("utf8").length;
}

function endRow(node: SyntaxNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

const isExported = (name: string): boolean => /^\p{Lu}/u.test(name);

function subject(label: string, name: string, extra: string[] = []): Builder {
  const words = [isExported(name) ? "exported" : "", ...extra, label].filter(Boolean).join(" ");
  return describe().text(capitalize(words)).text(" ").code(name);
}

function commentText(comment: string): string {
  return comment
    .replace(/^\/\/\s?/, "")
    .replace(/^\/\*+\s?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s?/, ""))
    .join("\n")
    .trim();
}

function isDirective(comment: string): boolean {
  return /^\/\/(?:go:|line |export |extern )/.test(comment) || /^\/\/\s*\+build\b/.test(comment);
}

function directiveNote(comment: string): Description {
  const text = comment.trim();
  const build = /^\/\/go:build\s+(.+)$/.exec(text);
  if (build) return describe().text("Built only when ").code(build[1]!).text(" holds.").build();
  if (/^\/\/\s*\+build\b/.test(text)) return describe().text("Legacy build constraint ").code(text).text(".").build();
  const generate = /^\/\/go:generate\s+(.+)$/.exec(text);
  if (generate) return describe().code("go generate").text(" runs ").code(generate[1]!).text(".").build();
  const embed = /^\/\/go:embed\s+(.+)$/.exec(text);
  if (embed) return describe().text("Embeds files matching ").code(embed[1]!).text(" at build time.").build();
  return describe().text("Compiler directive ").code(text).text(".").build();
}

function isStandardLibrary(path: string): boolean {
  return !path.split("/")[0]!.includes(".");
}

function importDescription(node: SyntaxNode): Description {
  const specs: SyntaxNode[] = [];
  const visit = (entry: SyntaxNode) => {
    if (entry.type === "import_spec") specs.push(entry);
    else named(entry).forEach(visit);
  };
  visit(node);
  return describe().text(specs.length > 1 ? "Imports packages " : "Imports package ")
    .list(specs, (builder, spec) => {
      const path = field(spec, "path")?.text.replace(/^["`]|["`]$/g, "") ?? spec.text;
      const alias = field(spec, "name")?.text;
      builder.code(path);
      if (isStandardLibrary(path)) builder.text(" (standard library)");
      if (alias === "_") builder.text(" for its side effects only");
      else if (alias === ".") builder.text(" into this file's scope, so its names need no prefix");
      else if (alias) builder.text(" as ").code(alias);
    }, 12)
    .text(".").build();
}

function describeParameters(builder: Builder, list: readonly SyntaxNode[]): void {
  builder.list(list, (target, parameter) => {
    const names = fields(parameter, "name");
    const type = field(parameter, "type");
    const variadic = parameter.type === "variadic_parameter_declaration";
    if (names.length) {
      target.code(names.map((name) => name.text).join(", "));
      if (type) target.text(variadic ? " (any number of " : " (").code(type.text).text(variadic ? " values)" : ")");
    } else if (type) {
      target.text(variadic ? "any number of " : "").code(type.text).text(variadic ? " values" : "");
    }
  });
}

function parameterDeclarations(list: SyntaxNode | null): SyntaxNode[] {
  return list ? named(list).filter((entry) =>
    entry.type === "parameter_declaration" || entry.type === "variadic_parameter_declaration"
  ) : [];
}

function resultPhrase(result: SyntaxNode | null): Description {
  if (!result) return describe().text("returns nothing").build();
  if (result.type !== "parameter_list") return describe().text("returns ").code(result.text).build();
  const builder = describe().text("returns ");
  describeParameters(builder, parameterDeclarations(result));
  return builder.build();
}

function functionDescription(node: SyntaxNode, label: string, receiverType?: string): Description {
  const name = field(node, "name")?.text ?? "";
  const head = subject(label, name);
  if (receiverType) head.text(" of ").code(receiverType);
  const parameters = parameterDeclarations(field(node, "parameters"));
  const parts: Description[] = [];
  if (parameters.length) {
    const builder = describe().text("takes ");
    describeParameters(builder, parameters);
    parts.push(builder.build());
  } else {
    parts.push(describe().text("takes no arguments").build());
  }
  parts.push(resultPhrase(field(node, "result")));
  return describe().append(head.build()).text(" ").append(clauses(parts)).text(".").build();
}

function genericNote(node: SyntaxNode): Description[] {
  const parameters = field(node, "type_parameters");
  return parameters ? [describe().text("Generic over ").code(parameters.text).text(".").build()] : [];
}

function functionNotes(node: SyntaxNode, name: string, packageName: string | undefined): Description[] {
  const notes = genericNote(node);
  const firstType = parameterDeclarations(field(node, "parameters"))[0]?.childForFieldName("type")?.text;
  if (node.type === "function_declaration") {
    if (name === "main" && packageName === "main") {
      notes.unshift(describe().text("Program entry point: runs when the program starts.").build());
    } else if (name === "init") {
      notes.unshift(describe().text("Runs automatically when the package is initialized, before ").code("main").text(".").build());
    } else if (/^Test(?!\p{Ll})/u.test(name) && firstType === "*testing.T") {
      notes.unshift(describe().text("Runs as a test with ").code("go test").text(".").build());
    } else if (/^Benchmark/.test(name) && firstType === "*testing.B") {
      notes.unshift(describe().text("Runs as a benchmark with ").code("go test -bench").text(".").build());
    } else if (/^Fuzz/.test(name) && firstType === "*testing.F") {
      notes.unshift(describe().text("Runs as a fuzz test with ").code("go test -fuzz").text(".").build());
    }
  }
  return notes;
}

function receiverNote(node: SyntaxNode): Description[] {
  const receiver = field(node, "receiver");
  const parameter = receiver ? parameterDeclarations(receiver)[0] : undefined;
  const type = parameter?.childForFieldName("type");
  if (!parameter || !type) return [];
  const text = parameter.text.replace(/\s+/g, " ");
  return type.type === "pointer_type"
    ? [describe().text("Pointer receiver ").code(text).text(": changes through it affect the caller's value.").build()]
    : [describe().text("Value receiver ").code(text).text(": the method works on a copy.").build()];
}

function structDescription(builder: Builder, struct: SyntaxNode): void {
  const declarations = named(named(struct).find((entry) => entry.type === "field_declaration_list") ?? struct)
    .filter((entry) => entry.type === "field_declaration");
  const embedded = declarations.filter((entry) => fields(entry, "name").length === 0);
  const regular = declarations.filter((entry) => fields(entry, "name").length > 0);
  if (!declarations.length) {
    builder.text(" with no fields");
    return;
  }
  if (regular.length) {
    const count = regular.reduce((sum, entry) => sum + fields(entry, "name").length, 0);
    builder.text(count > 1 ? " with fields " : " with field ").list(regular, (target, entry) => {
      target.code(fields(entry, "name").map((name) => name.text).join(", "));
      const type = field(entry, "type");
      if (type) target.text(" (").code(type.text).text(")");
    }, 12);
  }
  if (embedded.length) {
    builder.text(regular.length ? ", embedding " : " embedding ")
      .list(embedded, (target, entry) => target.code(entry.text.replace(/\s*`[^`]*`$/, "")));
  }
}

function interfaceDescription(builder: Builder, iface: SyntaxNode): void {
  const methods = named(iface).filter((entry) => entry.type === "method_spec" || entry.type === "method_elem");
  const elements = named(iface).filter((entry) => entry.type === "constraint_elem" || entry.type === "type_elem");
  const constraints = elements.filter((entry) => /[|~]/.test(entry.text));
  const embedded = elements.filter((entry) => !/[|~]/.test(entry.text));
  if (!methods.length && !elements.length) {
    builder.text(" with no methods, so every type satisfies it");
    return;
  }
  const parts: Description[] = [];
  if (methods.length) {
    parts.push(describe().text(methods.length > 1 ? "requiring methods " : "requiring method ")
      .list(methods, (target, method) => target.code(field(method, "name")?.text ?? method.text), 12).build());
  }
  if (embedded.length) {
    parts.push(describe().text("embedding ").list(embedded, (target, entry) => target.code(entry.text)).build());
  }
  if (constraints.length) {
    parts.push(describe().text("allowing types ").list(constraints, (target, entry) => target.code(entry.text)).build());
  }
  builder.text(" ").append(clauses(parts));
}

class GoDescriber {
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
      nameStart: character(this.context.lines, row, target.startPosition.column),
      nameEnd: character(this.context.lines, row, end)
    };
  }

  private flushComment(pending: Pending, depth: number): void {
    if (!pending.comment) return;
    const text = boundedDocumentation(pending.comment.lines);
    if (text) this.context.drafts.push(commentDraft(pending.comment.start, pending.comment.end, text, this.context.lines, depth));
    pending.comment = undefined;
  }

  /** Visits declarations in order; an adjacent comment block is the next declaration's documentation. */
  visitDeclarations(parent: SyntaxNode, depth: number, visit: (node: SyntaxNode, preamble: Preamble) => void): void {
    const pending: Pending = { directives: [] };
    for (const node of named(parent)) {
      if (this.context.drafts.length >= MAX_DRAFTS) return;
      const row = node.startPosition.row;
      if (node.type === "comment") {
        const text = node.text.trimEnd();
        if (isDirective(text)) {
          pending.directives.push(node);
          continue;
        }
        if (pending.comment && pending.comment.end >= row - 1 && !pending.directives.length) {
          pending.comment.end = endRow(node);
          pending.comment.lines.push(commentText(text));
        } else {
          this.flushComment(pending, depth);
          pending.comment = { start: row, end: endRow(node), lines: [commentText(text)] };
        }
        continue;
      }
      const firstDirective = pending.directives[0]?.startPosition.row;
      const attached = pending.comment !== undefined && pending.comment.end >= (firstDirective ?? row) - 1;
      const startLine = Math.min(row, firstDirective ?? row, attached ? pending.comment!.start : row);
      if (!attached) this.flushComment(pending, depth);
      const documentation = attached ? boundedDocumentation(pending.comment!.lines) : undefined;
      const notes = pending.directives.map((directive) => directiveNote(directive.text));
      pending.comment = undefined;
      pending.directives = [];
      visit(node, { startLine, notes, ...(documentation ? { documentation } : {}) });
    }
    this.flushComment(pending, depth);
  }

  visitTopLevel(node: SyntaxNode, preamble: Preamble): void {
    const common = (nameNode: SyntaxNode | null, name: string, qualifiedName = name) => ({
      depth: 0,
      startLine: preamble.startLine,
      endLine: endRow(node),
      ...this.nameRange(node, nameNode),
      ...(preamble.documentation ? { documentation: preamble.documentation } : {}),
      name,
      qualifiedName
    });
    switch (node.type) {
      case "package_clause": {
        const name = named(node)[0]?.text ?? "";
        this.context.packageName = name;
        if (preamble.documentation) this.context.purpose.push(preamble.documentation);
        const builder = describe().text("Package ").code(name);
        if (name === "main") builder.text(", which builds an executable program");
        if (name.endsWith("_test")) {
          builder.text(", an external test package for ").code(name.replace(/_test$/, "")).text(" that sees only its exported names");
        }
        // The package's doc comment is the file's purpose, so the entry starts at the clause.
        const { documentation: _purpose, ...entry } = common(named(node)[0] ?? null, name);
        this.push({
          ...entry,
          startLine: preamble.documentation ? node.startPosition.row : preamble.startLine,
          kind: "module",
          kindLabel: "Package",
          description: builder.text(".").build(),
          notes: preamble.notes,
          explainable: false
        });
        return;
      }
      case "import_declaration":
        this.push({ ...common(null, ""), kind: "import", kindLabel: "Import", description: importDescription(node), notes: preamble.notes, explainable: false });
        return;
      case "function_declaration":
      case "method_declaration": {
        const nameNode = field(node, "name");
        const name = nameNode?.text ?? "";
        const receiver = node.type === "method_declaration" ? goReceiverType(node) : undefined;
        const label = receiver ? "method" : "function";
        const notes = [...preamble.notes, ...(receiver ? receiverNote(node) : []), ...functionNotes(node, name, this.context.packageName)];
        this.push({
          ...common(nameNode, name, receiver ? `${receiver}.${name}` : name),
          kind: "function",
          kindLabel: capitalize(label),
          description: functionDescription(node, label, receiver),
          notes,
          explainable: true
        });
        const body = field(node, "body");
        if (body) this.visitBody(body, receiver ? `${receiver}.${name}` : name);
        return;
      }
      case "type_declaration":
      case "const_declaration":
      case "var_declaration":
        this.visitGroup(node, preamble);
        return;
    }
  }

  private visitGroup(node: SyntaxNode, preamble: Preamble): void {
    const grouped = allChildren(node).some((entry) => entry.type === "(");
    const specs = named(node).filter((entry) => entry.type !== "comment");
    if (!grouped) {
      for (const spec of specs) this.visitSpec(node, spec, 0, preamble, undefined);
      return;
    }
    const kind: OutlineKind = node.type === "type_declaration" ? "type" : node.type === "const_declaration" ? "constant" : "variable";
    const label = node.type === "type_declaration" ? "types" : node.type === "const_declaration" ? "constants" : "variables";
    const names = specs.flatMap((spec) => fields(spec, "name").map((name) => name.text));
    const notes = [...preamble.notes];
    if (node.type === "const_declaration" && /\biota\b/.test(node.text)) {
      notes.push(describe().code("iota").text(" counts 0, 1, 2, … through this group, and a constant without a value repeats the previous expression.").build());
    }
    this.push({
      kind,
      kindLabel: capitalize(label),
      name: "",
      qualifiedName: "",
      depth: 0,
      startLine: preamble.startLine,
      endLine: endRow(node),
      ...this.nameRange(node, null),
      ...(preamble.documentation ? { documentation: preamble.documentation } : {}),
      description: describe().text(`Groups ${label} `).list(names, (builder, name) => builder.code(name), 12).text(".").build(),
      notes,
      explainable: false
    });
    let previousValue: string | undefined;
    this.visitDeclarations(node, 1, (spec, specPreamble) => {
      previousValue = this.visitSpec(node, spec, 1, specPreamble, previousValue) ?? previousValue;
    });
  }

  /** Describes one type, const, or var spec; returns the spec's value text for implicit repetition. */
  private visitSpec(declaration: SyntaxNode, spec: SyntaxNode, depth: number, preamble: Preamble, previousValue: string | undefined): string | undefined {
    const names = fields(spec, "name");
    const nameNode = names[0] ?? null;
    const name = names.map((entry) => entry.text).join(", ");
    const common = {
      depth,
      startLine: depth === 0 ? preamble.startLine : Math.min(preamble.startLine, spec.startPosition.row),
      endLine: endRow(depth === 0 ? declaration : spec),
      ...this.nameRange(spec, nameNode),
      ...(preamble.documentation ? { documentation: preamble.documentation } : {}),
      name: names[0]?.text ?? "",
      qualifiedName: names[0]?.text ?? ""
    };
    if (spec.type === "type_spec" || spec.type === "type_alias") {
      const type = field(spec, "type");
      let label = "type";
      let kindLabel = "Type";
      const builder = describe();
      const notes = [...preamble.notes, ...genericNote(spec)];
      if (spec.type === "type_alias") {
        builder.append(subject("type alias", name).build()).text(" for ").code(type?.text ?? "?");
        kindLabel = "Type alias";
      } else if (type?.type === "struct_type") {
        label = "struct";
        kindLabel = "Struct";
        builder.append(subject(label, name).build());
        structDescription(builder, type);
      } else if (type?.type === "interface_type") {
        label = "interface";
        kindLabel = "Interface";
        builder.append(subject(label, name).build());
        interfaceDescription(builder, type);
      } else {
        builder.append(subject(label, name).build()).text(" defined as ").code(type?.text ?? "?");
        if (type) notes.push(describe().text("A distinct type: values of ").code(type.text).text(" need a conversion to become ").code(name).text(".").build());
      }
      this.push({ ...common, kind: "type", kindLabel, description: builder.text(".").build(), notes, explainable: false });
      return undefined;
    }
    if (spec.type !== "const_spec" && spec.type !== "var_spec") return undefined;
    const isConst = spec.type === "const_spec";
    const type = field(spec, "type");
    const value = field(spec, "value");
    const label = isConst ? (names.length > 1 ? "constants" : "constant") : (names.length > 1 ? "package variables" : "package variable");
    const builder = describe().text(capitalize([isExported(name) ? "exported" : "", label].filter(Boolean).join(" "))).text(" ")
      .list(names, (target, entry) => target.code(entry.text));
    if (type) builder.text(" of type ").code(type.text);
    if (value) builder.text(", set to ").code(value.text);
    else if (isConst && previousValue) builder.text(", repeating ").code(previousValue).text(" for the next position in the group");
    this.push({ ...common, kind: isConst ? "constant" : "variable", kindLabel: isConst ? "Constant" : "Variable", description: builder.text(".").build(), notes: preamble.notes, explainable: false });
    return value?.text;
  }

  private visitBody(body: SyntaxNode, owner: string): void {
    for (const statement of named(body)) {
      if (this.context.drafts.length >= MAX_DRAFTS) return;
      if (statement.type === "short_var_declaration") {
        const left = named(field(statement, "left") ?? statement).filter((entry) => entry.type === "identifier" && entry.text !== "_");
        if (!left.length) continue;
        const right = field(statement, "right");
        const builder = describe().text(left.length > 1 ? "Declares locals " : "Declares local ")
          .list(left, (target, entry) => target.code(entry.text));
        if (right) builder.text(", set to ").code(right.text);
        this.pushLocal(statement, left[0]!, owner, builder.text(".").build());
      } else if (statement.type === "var_declaration" || statement.type === "const_declaration") {
        const isConst = statement.type === "const_declaration";
        for (const spec of named(statement).filter((entry) => entry.type === "var_spec" || entry.type === "const_spec")) {
          const names = fields(spec, "name");
          if (!names.length) continue;
          const type = field(spec, "type");
          const value = field(spec, "value");
          const builder = describe().text(isConst ? "Declares local constant " : names.length > 1 ? "Declares locals " : "Declares local ")
            .list(names, (target, entry) => target.code(entry.text));
          if (type) builder.text(" of type ").code(type.text);
          if (value) builder.text(", set to ").code(value.text);
          else if (!isConst) builder.text(", starting at its zero value");
          this.pushLocal(spec, names[0]!, owner, builder.text(".").build());
        }
      }
    }
  }

  private pushLocal(node: SyntaxNode, nameNode: SyntaxNode, owner: string, description: Description): void {
    this.push({
      kind: "variable",
      kindLabel: "Local",
      name: nameNode.text,
      qualifiedName: `${owner}.${nameNode.text}`,
      depth: 1,
      startLine: node.startPosition.row,
      endLine: endRow(node),
      ...this.nameRange(node, nameNode),
      description,
      explainable: false
    });
  }
}

/** Describes Go declarations in source order from the bundled Tree-sitter grammar. */
export async function describeGoSource(
  source: string
): Promise<{ purpose?: string; drafts: OutlineEntryDraft[] }> {
  const lines = source.split("\n");
  const context: Context = { lines, drafts: [], purpose: [] };
  const parsed = await withGoSyntaxTree(source, (root) => {
    const describer = new GoDescriber(context);
    describer.visitDeclarations(root, 0, (node, preamble) => describer.visitTopLevel(node, preamble));
    return true;
  });
  if (!parsed) throw new Error("Tree-sitter could not parse the Go source.");
  const purpose = boundedDocumentation(context.purpose);
  return { ...(purpose ? { purpose } : {}), drafts: context.drafts };
}
