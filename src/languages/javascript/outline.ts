import type { Node as SyntaxNode } from "web-tree-sitter";
import { scanImports } from "../../context/imports";
import { boundedDocumentation, commentDraft, type OutlineEntryDraft } from "../../context/outlineModel";
import { capitalize, describe, type Description } from "../../context/outlineText";
import type { SourceDescription } from "../support";
import { namedChildren } from "../treeSitter";
import { javascriptFunctionNodes, unwrapFunction, withJavaScriptSyntaxTree, type JsFunctionNode } from "./syntax";

const MAX_DRAFTS = 500;

type Builder = ReturnType<typeof describe>;

interface CommentBlock {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly topLevel: boolean;
}

const KIND_LABELS = { function: "Function", method: "Method", component: "Component", hook: "Hook" } as const;

const WRAPPER_NOTES: Record<string, string> = {
  memo: "so it shows again only when its props change",
  forwardRef: "so a parent can reach the element it shows",
  useCallback: "so the same function is kept between renders"
};

function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}


function endRow(node: SyntaxNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

function commentText(comment: string): string {
  return comment
    .replace(/^\/\/\s?/, "")
    .replace(/^\/\*+\s?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s?/, "").replace(/^\/\/\s?/, ""))
    .join("\n")
    .trim();
}

/** Consecutive comments without blank lines between them form one block. */
function commentBlocks(root: SyntaxNode): CommentBlock[] {
  const comments: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "comment") comments.push(node);
    else namedChildren(node).forEach(visit);
  };
  visit(root);
  const blocks: CommentBlock[] = [];
  let current: { start: number; end: number; parts: string[]; topLevel: boolean } | undefined;
  const close = () => {
    if (!current) return;
    const text = boundedDocumentation(current.parts);
    if (text) blocks.push({ start: current.start, end: current.end, text, topLevel: current.topLevel });
    current = undefined;
  };
  for (const comment of comments) {
    const topLevel = comment.parent?.type === "program";
    if (current && comment.startPosition.row === current.end + 1 && current.topLevel === topLevel) {
      current.end = endRow(comment);
      current.parts.push(commentText(comment.text));
    } else {
      close();
      current = { start: comment.startPosition.row, end: endRow(comment), parts: [commentText(comment.text)], topLevel };
    }
  }
  close();
  return blocks;
}

function parameterList(fn: SyntaxNode): SyntaxNode[] {
  const single = field(fn, "parameter");
  if (single) return [single];
  const parameters = field(fn, "parameters");
  return parameters ? namedChildren(parameters).filter((entry) => entry.type !== "comment") : [];
}

function patternNames(pattern: SyntaxNode): string[] {
  if (pattern.type === "identifier" || pattern.type === "shorthand_property_identifier_pattern") return [pattern.text];
  if (pattern.type === "object_pattern") {
    return namedChildren(pattern).flatMap((entry) => {
      if (entry.type === "shorthand_property_identifier_pattern") return [entry.text];
      if (entry.type === "pair_pattern") return [field(entry, "key")?.text ?? entry.text];
      if (entry.type === "object_assignment_pattern") return patternNames(field(entry, "left") ?? entry);
      if (entry.type === "rest_pattern") return [`...${namedChildren(entry)[0]?.text ?? ""}`];
      return [];
    });
  }
  if (pattern.type === "array_pattern") return namedChildren(pattern).flatMap(patternNames);
  if (pattern.type === "assignment_pattern") return patternNames(field(pattern, "left") ?? pattern);
  if (pattern.type === "rest_pattern") return [`...${namedChildren(pattern)[0]?.text ?? ""}`];
  return [pattern.text];
}

function describeParameter(builder: Builder, parameter: SyntaxNode): void {
  const pattern = field(parameter, "pattern") ?? parameter;
  const type = field(parameter, "type");
  const value = field(parameter, "value") ?? (pattern.type === "assignment_pattern" ? field(pattern, "right") : null);
  const rest = pattern.type === "rest_pattern";
  const names = patternNames(pattern.type === "assignment_pattern" ? field(pattern, "left") ?? pattern : pattern);
  if (rest) builder.text("any number of ");
  if (parameter.type === "optional_parameter") builder.text("optional ");
  builder.code(rest ? names.join(", ").replace(/^\.\.\./, "") : names.length > 1 ? `{ ${names.join(", ")} }` : names[0] ?? pattern.text);
  const typeText = type ? namedChildren(type)[0]?.text ?? type.text.replace(/^:\s*/, "") : undefined;
  if (typeText) builder.text(" (").code(typeText).text(")");
  if (value) builder.text(", default ").code(value.text);
}

function describeFunction(entry: JsFunctionNode): Description {
  const fn = entry.fn;
  const prefix = fn.text.slice(0, 20);
  const words = [
    entry.isDefault ? "default-exported" : entry.exported ? "exported" : "",
    /^async\b/.test(prefix) ? "async" : "",
    fn.type.includes("generator") || /^(?:async\s+)?function\s*\*/.test(prefix) || /^\*/.test(fn.text) ? "generator" : "",
    entry.kind
  ].filter(Boolean).join(" ");
  const builder = describe().text(capitalize(words)).text(" ").code(entry.simpleName);
  const owner = entry.containers.at(-1);
  if (entry.kind === "method" && owner) builder.text(" of ").code(owner);
  const parameters = parameterList(fn);
  if (entry.kind === "component" && parameters[0]) {
    const props = parameters[0];
    const pattern = field(props, "pattern") ?? props;
    const type = field(props, "type");
    if (pattern.type === "object_pattern") {
      builder.text(" takes props ").list(patternNames(pattern), (target, name) => target.code(name));
    } else {
      builder.text(" takes ").code(pattern.text);
    }
    const typeText = type ? namedChildren(type)[0]?.text : undefined;
    if (typeText) builder.text(" (").code(typeText).text(")");
  } else if (parameters.length) {
    builder.text(" takes ").list(parameters, describeParameter);
  }
  const returnType = field(fn, "return_type");
  const returnText = returnType ? namedChildren(returnType)[0]?.text : undefined;
  if (returnText && entry.kind !== "component") builder.text(parameters.length ? " and returns " : " returns ").code(returnText);
  return builder.text(".").build();
}

function wrapperNotes(entry: JsFunctionNode): Description[] {
  return entry.wrappers.map((wrapper) => {
    const short = wrapper.split(".").at(-1) ?? wrapper;
    const why = WRAPPER_NOTES[short];
    const builder = describe().text("Wrapped in ").code(wrapper);
    return (why ? builder.text(`, ${why}`) : builder).text(".").build();
  });
}

/** Describes a local declaration, with React state and refs in plain terms. */
function describeLocal(declarator: SyntaxNode, owner: string, isConst: boolean): Description | undefined {
  const name = field(declarator, "name");
  if (!name) return undefined;
  const value = field(declarator, "value");
  const call = value?.type === "call_expression" ? field(value, "function")?.text : undefined;
  const firstArgument = value?.type === "call_expression"
    ? namedChildren(field(value, "arguments") ?? value).find((entry) => entry.type !== "comment")
    : undefined;
  const names = patternNames(name);
  if (call && /(?:^|\.)useState$/.test(call) && name.type === "array_pattern" && names.length >= 1) {
    const builder = describe().text("State ").code(names[0]!).text(" of ").code(owner);
    if (names[1]) builder.text(", changed with ").code(names[1]);
    if (firstArgument) builder.text(", starting at ").code(firstArgument.text);
    return builder.text(".").build();
  }
  if (call && /(?:^|\.)useReducer$/.test(call) && name.type === "array_pattern" && names.length >= 1) {
    const builder = describe().text("State ").code(names[0]!).text(" of ").code(owner);
    if (names[1]) builder.text(", changed by sending actions to ").code(names[1]);
    if (firstArgument) builder.text(", handled by ").code(firstArgument.text);
    return builder.text(".").build();
  }
  if (call && /(?:^|\.)useRef$/.test(call)) {
    const builder = describe().text("Reference ").code(names[0] ?? name.text).text(" kept between renders of ").code(owner);
    if (firstArgument) builder.text(", starting at ").code(firstArgument.text);
    return builder.text(".").build();
  }
  if (call && /(?:^|\.)useMemo$/.test(call)) {
    const dependencies = namedChildren(field(value!, "arguments") ?? value!).filter((entry) => entry.type !== "comment")[1];
    const builder = describe().text("Value ").list(names, (target, entry) => target.code(entry)).text(" remembered between renders of ").code(owner);
    if (dependencies) builder.text(", worked out again when ").code(dependencies.text).text(" changes");
    return builder.text(".").build();
  }
  if (call && /(?:^|\.)useContext$/.test(call)) {
    return describe().text("Reads ").list(names, (target, entry) => target.code(entry)).text(" from the shared context ")
      .code(firstArgument?.text ?? "?").text(".").build();
  }
  const builder = describe().text(names.length > 1 ? "Declares " : isConst ? "Constant " : "Variable ")
    .list(names, (target, entry) => target.code(entry))
    .text(" local to ").code(owner);
  if (value) builder.text(", set to ").code(value.text);
  return builder.text(".").build();
}

class JavaScriptDescriber {
  readonly drafts: OutlineEntryDraft[] = [];
  readonly described = new Set<JsFunctionNode>();
  private readonly used = new Set<CommentBlock>();

  constructor(
    private readonly lines: readonly string[],
    private readonly blocks: readonly CommentBlock[]
  ) {}

  private documentation(row: number): CommentBlock | undefined {
    const block = this.blocks.find((candidate) => candidate.end === row - 1 && !this.used.has(candidate));
    if (block) this.used.add(block);
    return block;
  }

  private nameRange(node: SyntaxNode, name: SyntaxNode | null) {
    const target = name ?? node;
    return {
      nameLine: target.startPosition.row,
      nameStart: target.startPosition.column,
      nameEnd: name && name.endPosition.row === name.startPosition.row
        ? name.endPosition.column
        : target.startPosition.column
    };
  }

  push(
    node: SyntaxNode,
    name: SyntaxNode | null,
    draft: Omit<OutlineEntryDraft, "startLine" | "endLine" | "nameLine" | "nameStart" | "nameEnd" | "notes"> & { notes?: Description[] },
    outer: SyntaxNode = node
  ): void {
    if (this.drafts.length >= MAX_DRAFTS) return;
    const comment = this.documentation(outer.startPosition.row);
    this.drafts.push({
      ...draft,
      notes: draft.notes ?? [],
      startLine: comment?.start ?? outer.startPosition.row,
      endLine: endRow(node),
      ...this.nameRange(node, name),
      ...(comment ? { documentation: comment.text } : {})
    });
  }

  functionEntry(entry: JsFunctionNode, outer: SyntaxNode): void {
    if (this.described.has(entry)) return;
    this.described.add(entry);
    this.push(entry.node, entry.name, {
      kind: "function",
      kindLabel: KIND_LABELS[entry.kind],
      name: entry.simpleName,
      qualifiedName: entry.qualifiedName,
      depth: entry.containers.length,
      description: describeFunction(entry),
      notes: wrapperNotes(entry),
      explainable: true
    }, outer);
    this.locals(entry);
  }

  /** Declarations directly in a function's body. */
  private locals(entry: JsFunctionNode): void {
    const body = field(entry.fn, "body");
    if (!body || body.type !== "statement_block") return;
    for (const statement of namedChildren(body)) {
      if (statement.type !== "lexical_declaration" && statement.type !== "variable_declaration") continue;
      const isConst = /^const\b/.test(statement.text);
      for (const declarator of namedChildren(statement).filter((child) => child.type === "variable_declarator")) {
        if (unwrapFunction(field(declarator, "value"))) continue;
        const description = describeLocal(declarator, entry.simpleName, isConst);
        const name = field(declarator, "name");
        if (!description || !name) continue;
        this.push(declarator, name.type === "identifier" ? name : namedChildren(name)[0] ?? name, {
          kind: "variable",
          kindLabel: "Local",
          name: patternNames(name)[0] ?? name.text,
          qualifiedName: `${entry.qualifiedName}.${patternNames(name)[0] ?? name.text}`,
          depth: entry.containers.length + 1,
          description,
          explainable: false
        }, statement);
      }
    }
  }

  topLevel(node: SyntaxNode, functions: ReadonlyMap<number, JsFunctionNode>, exported = false, outer = node): void {
    const type = node.type;
    const ownFunction = functions.get(node.id);
    if (ownFunction) return this.functionEntry(ownFunction, outer);
    if (type === "import_statement") {
      const statement = scanImports("javascript", node.text.split("\n"))[0];
      if (statement) {
        this.push(node, null, { kind: "import", kindLabel: "Import", name: "", qualifiedName: "", depth: 0, description: statement.description, explainable: false });
      }
      return;
    }
    if (type === "export_statement") {
      const declaration = field(node, "declaration");
      if (declaration) return this.topLevel(declaration, functions, true, node);
      const value = field(node, "value");
      if (value && functions.has(node.id)) return;
      const reexport = scanImports("javascript", node.text.split("\n"))[0];
      const clause = namedChildren(node).find((child) => child.type === "export_clause");
      let description: Description | undefined = reexport?.description;
      if (!description && clause) {
        const names = namedChildren(clause).map((entry) => field(entry, "name")?.text ?? entry.text);
        description = describe().text("Exports ").list(names, (target, name) => target.code(name)).text(".").build();
      } else if (!description && value) {
        description = describe().text("Exports ").code(value.text).text(" as the default export.").build();
      }
      if (description) {
        this.push(node, null, { kind: "import", kindLabel: "Export", name: "", qualifiedName: "", depth: 0, description, explainable: false });
      }
      return;
    }
    if (type === "lexical_declaration" || type === "variable_declaration") {
      const isConst = /^const\b/.test(node.text);
      for (const declarator of namedChildren(node).filter((child) => child.type === "variable_declarator")) {
        const fn = functions.get(declarator.id);
        if (fn) {
          this.functionEntry(fn, outer);
          continue;
        }
        const name = field(declarator, "name");
        if (!name) continue;
        const valueNode = field(declarator, "value");
        const typeNode = field(declarator, "type");
        const names = patternNames(name);
        const builder = describe().text(capitalize([exported ? "exported" : "", isConst ? "constant" : "variable"].filter(Boolean).join(" ")))
          .text(" ").list(names, (target, entry) => target.code(entry));
        const typeText = typeNode ? namedChildren(typeNode)[0]?.text : undefined;
        if (typeText) builder.text(" of type ").code(typeText);
        if (valueNode) builder.text(", set to ").code(valueNode.text);
        this.push(declarator, name.type === "identifier" ? name : null, {
          kind: isConst ? "constant" : "variable",
          kindLabel: isConst ? "Constant" : "Variable",
          name: names[0] ?? name.text,
          qualifiedName: names[0] ?? name.text,
          depth: 0,
          description: builder.text(".").build(),
          explainable: false
        }, declarator === namedChildren(node)[0] ? outer : declarator);
        if (valueNode?.type === "object") {
          for (const member of namedChildren(valueNode)) {
            const memberFunction = functions.get(member.id);
            if (memberFunction) this.functionEntry(memberFunction, member);
          }
        }
      }
      return;
    }
    if (type === "class_declaration" || type === "abstract_class_declaration") {
      const name = field(node, "name");
      const body = field(node, "body");
      const heritage = namedChildren(node).find((child) => child.type === "class_heritage");
      const extendsClause = heritage ? namedChildren(heritage).find((child) => child.type === "extends_clause") : undefined;
      const implementsClause = heritage ? namedChildren(heritage).find((child) => child.type === "implements_clause") : undefined;
      const base = extendsClause ? namedChildren(extendsClause)[0]?.text : undefined;
      const isComponent = Boolean(base && /(?:^|\.)(?:Pure)?Component$/.test(base));
      const label = isComponent ? "class component" : type === "abstract_class_declaration" ? "abstract class" : "class";
      const builder = describe().text(capitalize([exported ? "exported" : "", label].filter(Boolean).join(" "))).text(" ").code(name?.text ?? "default");
      if (base) builder.text(" extends ").code(base);
      if (implementsClause) {
        builder.text(base ? " and implements " : " implements ").list(namedChildren(implementsClause), (target, entry) => target.code(entry.text));
      }
      this.push(node, name, {
        kind: "type",
        kindLabel: capitalize(label),
        name: name?.text ?? "default",
        qualifiedName: name?.text ?? "default",
        depth: 0,
        description: builder.text(".").build(),
        explainable: false
      }, outer);
      for (const member of body ? namedChildren(body) : []) {
        const memberFunction = functions.get(member.id);
        if (memberFunction) {
          this.functionEntry(memberFunction, member);
          continue;
        }
        if (member.type !== "public_field_definition" && member.type !== "field_definition") continue;
        const fieldName = field(member, "name") ?? field(member, "property");
        if (!fieldName) continue;
        const value = field(member, "value");
        const fieldBuilder = describe().text("Field ").code(fieldName.text).text(" of ").code(name?.text ?? "default");
        if (value) fieldBuilder.text(", set to ").code(value.text);
        this.push(member, fieldName, {
          kind: "field",
          kindLabel: "Field",
          name: fieldName.text,
          qualifiedName: `${name?.text ?? "default"}.${fieldName.text}`,
          depth: 1,
          description: fieldBuilder.text(".").build(),
          explainable: false
        });
      }
      return;
    }
    if (type === "interface_declaration") {
      const name = field(node, "name");
      const body = field(node, "body");
      const members = body ? namedChildren(body).map((member) => field(member, "name")?.text).filter((entry): entry is string => Boolean(entry)) : [];
      const extendsClause = namedChildren(node).find((child) => child.type === "extends_type_clause");
      const builder = describe().text(exported ? "Exported interface " : "Interface ").code(name?.text ?? "?");
      if (extendsClause) builder.text(" extends ").list(namedChildren(extendsClause), (target, entry) => target.code(entry.text));
      if (members.length) builder.text(extendsClause ? " and has " : " with ").list(members, (target, entry) => target.code(entry));
      this.push(node, name, { kind: "type", kindLabel: "Interface", name: name?.text ?? "", qualifiedName: name?.text ?? "", depth: 0, description: builder.text(".").build(), explainable: false }, outer);
      return;
    }
    if (type === "type_alias_declaration") {
      const name = field(node, "name");
      const value = field(node, "value");
      const builder = describe().text(exported ? "Exported type alias " : "Type alias ").code(name?.text ?? "?");
      if (value) builder.text(" for ").code(value.text);
      this.push(node, name, { kind: "type", kindLabel: "Type alias", name: name?.text ?? "", qualifiedName: name?.text ?? "", depth: 0, description: builder.text(".").build(), explainable: false }, outer);
      return;
    }
    if (type === "enum_declaration") {
      const name = field(node, "name");
      const body = field(node, "body");
      const members = body ? namedChildren(body).map((member) => (field(member, "name") ?? member).text) : [];
      const builder = describe().text(exported ? "Exported enum " : "Enum ").code(name?.text ?? "?");
      if (members.length) builder.text(" with ").list(members, (target, entry) => target.code(entry));
      this.push(node, name, { kind: "type", kindLabel: "Enum", name: name?.text ?? "", qualifiedName: name?.text ?? "", depth: 0, description: builder.text(".").build(), explainable: false }, outer);
      return;
    }
    // Statements such as `if` or expression calls may still hold named functions.
    for (const child of namedChildren(node)) {
      const nested = functions.get(child.id);
      if (nested) this.functionEntry(nested, child);
    }
  }

  /** Comments not attached to a declaration; the first, at the top of the file, is the file's purpose. */
  standaloneComments(firstCodeRow: number): string | undefined {
    let purpose: string | undefined;
    for (const block of this.blocks) {
      if (this.used.has(block) || !block.topLevel) continue;
      if (purpose === undefined && block.end < firstCodeRow && block === this.blocks[0]) {
        purpose = block.text;
        continue;
      }
      this.drafts.push(commentDraft(block.start, block.end, block.text, this.lines));
    }
    return purpose;
  }
}

/** Describes JavaScript and TypeScript declarations in source order from the bundled Tree-sitter grammars. */
export async function describeJavaScriptSource(source: string, path: string): Promise<SourceDescription> {
  const lines = source.split("\n");
  const result = await withJavaScriptSyntaxTree(source, path, (root) => {
    const all = javascriptFunctionNodes(root);
    const blocks = commentBlocks(root);
    const describer = new JavaScriptDescriber(lines, blocks);
    // Functions are keyed by their declaration node and, for `const` statements, by the declarator too.
    const byNode = new Map<number, JsFunctionNode>();
    for (const entry of all) {
      byNode.set(entry.node.id, entry);
      if (entry.node.type === "lexical_declaration" || entry.node.type === "variable_declaration") {
        const declarator = namedChildren(entry.node).find((child) => child.type === "variable_declarator");
        if (declarator) byNode.set(declarator.id, entry);
      }
    }
    const firstCode = namedChildren(root).find((child) => child.type !== "comment");
    for (const child of namedChildren(root)) {
      if (child.type !== "comment") describer.topLevel(child, byNode);
    }
    // Functions nested in others (such as event handlers inside a component) and in expressions.
    for (const entry of all) describer.functionEntry(entry, entry.node);
    const purpose = describer.standaloneComments(firstCode?.startPosition.row ?? lines.length);
    return { purpose, drafts: describer.drafts };
  });
  if (!result) throw new Error("Tree-sitter could not parse the JavaScript source.");
  return { ...(result.purpose ? { purpose: result.purpose } : {}), drafts: result.drafts };
}
