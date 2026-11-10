export interface SvelteBlock {
  readonly kind: "script" | "style";
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly module: boolean;
  readonly typescript: boolean;
}

export interface SvelteScan {
  readonly blocks: readonly SvelteBlock[];
  readonly scripts: readonly SvelteBlock[];
  readonly scriptView: string;
  readonly markupView: string;
  readonly supported: boolean;
}

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_BLOCKS = 64;

function blank(source: string): string {
  return source.replace(/[^\r\n]/g, " ");
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return -1;
}

function blockKind(source: string, start: number): SvelteBlock["kind"] | undefined {
  const rest = source.slice(start);
  if (/^<script(?=[\s>])/i.test(rest)) return "script";
  if (/^<style(?=[\s>])/i.test(rest)) return "style";
  return undefined;
}

function closingTag(source: string, kind: SvelteBlock["kind"], start: number): number {
  const lowered = source.toLowerCase();
  let index = lowered.indexOf(`</${kind}`, start);
  while (index >= 0 && !new RegExp(`^<\\/${kind}\\s*>`, "i").test(source.slice(index))) {
    index = lowered.indexOf(`</${kind}`, index + kind.length + 2);
  }
  return index;
}

/** Splits top-level component blocks while preserving original offsets. */
export function scanSvelte(source: string): SvelteScan {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return { blocks: [], scripts: [], scriptView: blank(source), markupView: blank(source), supported: false };
  }
  const blocks: SvelteBlock[] = [];
  let index = 0;
  let wellFormed = true;
  while (index < source.length && blocks.length < MAX_BLOCKS) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[index] !== "<" || source[index + 1] === "!") {
      index++;
      continue;
    }
    const kind = blockKind(source, index);
    if (!kind && !/[A-Za-z/]/.test(source[index + 1] ?? "")) {
      index++;
      continue;
    }
    const openEnd = tagEnd(source, index);
    if (openEnd < 0) {
      wellFormed = false;
      break;
    }
    if (!kind || source[index + 1] === "/") {
      index = openEnd;
      continue;
    }
    const closeStart = closingTag(source, kind, openEnd);
    if (closeStart < 0) {
      wellFormed = false;
      break;
    }
    const closeEnd = tagEnd(source, closeStart);
    if (closeEnd < 0) {
      wellFormed = false;
      break;
    }
    const attributes = source.slice(index, openEnd);
    blocks.push({
      kind,
      start: index,
      end: closeEnd,
      contentStart: openEnd,
      contentEnd: closeStart,
      module: kind === "script" && /\b(?:context\s*=\s*["']module["']|module)(?:\s|\/?>)/i.test(attributes),
      typescript: kind === "script" && /\blang\s*=\s*["']ts["']/i.test(attributes)
    });
    index = closeEnd;
  }

  const scripts = blocks.filter((block) => block.kind === "script");
  let scriptView = blank(source);
  let markupView = source;
  for (const block of blocks) {
    markupView = markupView.slice(0, block.start) + blank(source.slice(block.start, block.end)) + markupView.slice(block.end);
    if (block.kind === "script") {
      scriptView = scriptView.slice(0, block.contentStart) +
        source.slice(block.contentStart, block.contentEnd) + scriptView.slice(block.contentEnd);
    }
  }
  return {
    blocks,
    scripts,
    scriptView,
    markupView,
    supported: wellFormed && blocks.length < MAX_BLOCKS && index >= source.length
  };
}

export function svelteAnalysisSource(source: string, scan = scanSvelte(source)): string {
  let result = source;
  for (const block of scan.blocks.filter((entry) => entry.kind === "style")) {
    result = result.slice(0, block.start) + blank(source.slice(block.start, block.end)) + result.slice(block.end);
  }
  return result;
}
