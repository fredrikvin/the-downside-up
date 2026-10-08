import { describe, expect, it } from "vitest";
import { panelHtml } from "../src/presentation/panel";

describe("preview webview document", () => {
  it("keeps a restrictive policy and renders content only as text", () => {
    const html = panelHtml("nonce-value");
    expect(html).toContain("default-src 'none'; style-src 'nonce-nonce-value'; script-src 'nonce-nonce-value';");
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(html).not.toMatch(/<(?:img|iframe|link)\b/);
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script nonce="nonce-value">']);
  });

  it("embeds the tested pure helpers instead of separate copies", () => {
    const html = panelHtml("n");
    expect(html).toContain("const offsetForLine = (function offsetForLine(");
    expect(html).toContain("const lineForOffset = (function lineForOffset(");
  });

  it("has a webview script that parses", () => {
    const html = panelHtml("n");
    const start = html.indexOf('<script nonce="n">') + '<script nonce="n">'.length;
    const script = html.slice(start, html.indexOf("</script>", start));
    expect(() => new Function(script)).not.toThrow();
  });
});
