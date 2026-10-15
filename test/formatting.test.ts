import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fingerprint, formatTolerantFingerprint } from "../src/core/fingerprint";
import { goSupport } from "../src/languages/go";
import { javascriptSupport } from "../src/languages/javascript";
import { rustSupport } from "../src/languages/rust";
import { sourceFingerprint } from "../src/languages/registry";

beforeAll(async () => {
  await Promise.all([goSupport, javascriptSupport, rustSupport].map((language) => language.initialize!(resolve("."))));
});

describe("formatting fingerprints", () => {
  it.each([
    ["example.go", 'package main\nimport "fmt"\nfunc f(x int) int { return x + 1 }',
      'package main\n\nimport "fmt"\nfunc f( x int ) int {\n\treturn x+1\n}\n'],
    ["example.rs", 'use std::fmt;\nfn f(x:i32)->i32 { x+1 }',
      'use std::fmt;\n\nfn f( x: i32 ) -> i32 {\n    x + 1\n}\n'],
    ["example.ts", 'import { x } from "lib";\nfunction f(a:number) { return a + x; }',
      'import {x} from "lib";\r\n\r\nfunction f( a: number ) {\r\n\treturn a+x;\r\n}\r\n']
  ])("ignores indentation and spacing in %s", async (path, original, formatted) => {
    expect(await sourceFingerprint(formatted, { path })).toBe(await sourceFingerprint(original, { path }));
  });

  it.each([
    ["example.go", 'package main\nfunc f() string { return `one\n  two` }', 'package main\nfunc f() string { return `one\n two` }'],
    ["example.rs", 'fn f() { let s = r#"one\n  two"#; }', 'fn f() { let s = r#"one\n two"#; }'],
    ["example.ts", 'function f() { return `one\n  two`; }', 'function f() { return `one\n two`; }'],
    ["example.tsx", 'function View(){ return <p>one  two</p>; }', 'function View(){ return <p>one two</p>; }'],
    ["example.ts", "function f() { return 1; }", "function f() { return 2; }"],
    ["example.ts", "function f() { return\nvalue; }", "function f() { return value; }"],
    ["example.go", "package main\nfunc f() { return\nvalue() }", "package main\nfunc f() { return value() }"]
  ])("preserves meaningful syntax and literal whitespace in %s", async (path, original, changed) => {
    expect(await sourceFingerprint(changed, { path })).not.toBe(await sourceFingerprint(original, { path }));
  });

  it("conservatively normalizes fallback languages without losing Python indentation or strings", () => {
    const original = 'def f():\n    text = "a  b"\n    return text\n';
    expect(formatTolerantFingerprint('def f():  \r\n\r\n    text = "a  b" \r\n    return text\t\r\n')).toBe(formatTolerantFingerprint(original));
    expect(formatTolerantFingerprint(original.replace("    return", "  return"))).not.toBe(formatTolerantFingerprint(original));
    expect(formatTolerantFingerprint(original.replace("a  b", "a b"))).not.toBe(formatTolerantFingerprint(original));
    for (const literal of ['"""a\n\n b"""', '"a\\\n  b"', "`a\n\n b`", "[=[a\n\n b]=]", "$body$a\n\n b$body$", "<<EOF\na\n\n b\nEOF"]) {
      expect(formatTolerantFingerprint(literal)).toBe(fingerprint(literal));
      expect(formatTolerantFingerprint(literal.replace("\n", "\n "))).not.toBe(formatTolerantFingerprint(literal));
    }
  });
});
