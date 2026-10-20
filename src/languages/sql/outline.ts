import { boundedDocumentation, commentDraft, type OutlineEntryDraft } from "../../context/outlineModel";
import { describe } from "../../context/outlineText";
import type { SourceDescription } from "../support";
import { lexSql, sqlPosition, word } from "./lexer";
import { explainableSql, sqlDefinitions } from "./syntax";

export async function describeSqlSource(source: string): Promise<SourceDescription> {
  const drafts: OutlineEntryDraft[] = [];
  const lines = source.split(/\r?\n/);
  const definitions = sqlDefinitions(source);
  const comments = lexSql(source).filter((token) => token.kind === "comment");
  const commentText = (text: string) => text.replace(/^--\s?|^#\s?|^\/\*+\s?|\s*\*\/$/g, "").trim();
  const leading = comments.filter((token) => !source.slice(0, token.start).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim());
  const used = new Set(leading);
  for (const entry of definitions.slice(0, 500)) {
    const name = sqlPosition(source, entry.name.start);
    const end = sqlPosition(source, entry.name.end);
    const attached = comments.filter((token) => token.end <= entry.start && !source.slice(token.end, entry.start).trim() && !used.has(token));
    attached.forEach((token) => used.add(token));
    const kindLabel = entry.kind[0]!.toUpperCase() + entry.kind.slice(1);
    drafts.push({
      kind: explainableSql(entry) ? "function" : "type", kindLabel,
      name: entry.name.name, qualifiedName: entry.qualifiedName, depth: 0,
      startLine: entry.startLine, endLine: entry.endLine,
      nameLine: name.line, nameStart: name.character,
      nameEnd: end.line === name.line ? end.character : (lines[name.line]?.length ?? name.character),
      description: describe().text(`${kindLabel} `).code(entry.name.qualified).text(
        entry.kind === "view" ? " defines a saved query." :
        entry.kind === "trigger" ? " runs when its configured database event occurs." :
        entry.kind === "table" ? " stores rows with the declared columns." :
        ["function", "procedure"].includes(entry.kind) ? " defines database logic." : " defines a database object."
      ).build(),
      documentation: boundedDocumentation(attached.map((token) => commentText(token.text))),
      notes: [], explainable: explainableSql(entry)
    });
    if (entry.kind === "table") {
      let depth = 0;
      let columnStart = false;
      for (const token of entry.tokens.slice(entry.name.next)) {
        if (token.text === "(") { depth++; if (depth === 1) columnStart = true; continue; }
        if (token.text === ")") { depth--; continue; }
        if (token.text === "," && depth === 1) { columnStart = true; continue; }
        if (!columnStart || depth !== 1) continue;
        columnStart = false;
        if (!["word", "identifier"].includes(token.kind) ||
            ["constraint", "primary", "foreign", "unique", "check", "like", "exclude"].some((key) => word(token, key))) continue;
        const position = sqlPosition(source, token.start);
        drafts.push({
          kind: "field", kindLabel: "Column", name: token.text,
          qualifiedName: `${entry.name.qualified}.${token.text}`, depth: 1,
          startLine: position.line, endLine: position.line,
          nameLine: position.line, nameStart: position.character, nameEnd: position.character + token.text.length,
          description: describe().text("Column ").code(token.text).text(".").build(),
          notes: [], explainable: false
        });
      }
    }
  }
  for (const token of comments) {
    if (used.has(token) || definitions.some((entry) => entry.start <= token.start && entry.end >= token.end)) continue;
    drafts.push(commentDraft(sqlPosition(source, token.start).line, sqlPosition(source, token.end).line, commentText(token.text), lines));
  }
  drafts.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);
  return { purpose: boundedDocumentation(leading.map((token) => commentText(token.text))), drafts: drafts.slice(0, 500) };
}
