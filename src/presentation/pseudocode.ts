export interface PseudocodeToken {
  readonly text: string;
  readonly kind?: "name" | "string" | "keyword" | "literal" | "number" | "operator";
}

/** A display-only lexer for plain-language pseudocode, also embedded in the webview. */
export function pseudocodeTokens(text: string): PseudocodeToken[] {
  const tokens: PseudocodeToken[] = [];
  const pattern = /(`[^`\r\n]+`)|("(?:\\.|[^"\\\r\n])*"|(?<![\p{L}\p{N}_])'(?:\\.|[^'\\\r\n])*')|(?<![\p{L}\p{N}_])((?:else\s+if|for\s+each|end\s+(?:if|for|while|when)|if|else|otherwise|then|for|while|until|repeat|when|return|yield|break|continue|stop|wait|await|try|catch|finally|throw|raise|show|set|call|and|or|not))(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(true|false|null|none)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?![\p{L}\p{N}_])|(<-|->|<=|>=|!=|==|&&|\|\||[=<>+*/%:-])/giu;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > end) tokens.push({ text: text.slice(end, start) });
    const kind = match[1] ? "name" : match[2] ? "string" : match[3] ? "keyword"
      : match[4] ? "literal" : match[5] ? "number" : "operator";
    tokens.push({ text: match[0], kind });
    end = start + match[0].length;
  }
  if (end < text.length) tokens.push({ text: text.slice(end) });
  return tokens;
}
