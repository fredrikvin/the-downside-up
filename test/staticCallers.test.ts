import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Position, Range, Uri } from "vscode";
import { staticCallers } from "../src/context/callers";
import { goSupport } from "../src/languages/go";
import { rustSupport } from "../src/languages/rust";
import { pythonSupport } from "../src/languages/python";

const scan = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock("../src/context/inventory", () => ({
  listEligibleFiles: async () => ({ files: scan.files, complete: true })
}));

beforeAll(async () => {
  await goSupport.initialize!(resolve("."));
  await rustSupport.initialize!(resolve("."));
  await pythonSupport.initialize!(resolve("."));
});

describe("bounded local caller scan", () => {
  it.each([
    { support: goSupport, manifest: "go.mod", path: "main.go", text: "package main\nfunc target() {}\nfunc caller() { target() }\n" },
    { support: rustSupport, manifest: "Cargo.toml", path: "src/main.rs", text: "fn target() {}\nfn caller() { target(); }\n" },
    { support: pythonSupport, manifest: "pyproject.toml", path: "app.py", text: "def target():\n    pass\n\ndef caller():\n    target()\n" }
  ])("reverses $support.name direct calls without a language server", async ({ support, manifest, path, text }) => {
    const root = resolve("fixtures");
    scan.files = [manifest, path];
    const files: Record<string, string> = { [manifest]: "", [path]: text };
    const functions = await support.listFunctions!(text, path);
    const target = functions.find((fn) => fn.name === "target")!;
    const callers = await staticCallers(root, {
      uri: Uri.file(resolve(root, path)), name: "target",
      range: new Range(new Position(target.startLine, 0), new Position(target.endLine, 0))
    }, support, async (file) => files[file], () => false);
    expect(callers.map((caller) => caller.name)).toEqual(["caller"]);
    expect(callers[0]?.source).toBe(text);
    expect(callers[0]?.position.line).toBe(functions.find((fn) => fn.name === "caller")?.startLine);
    expect(await staticCallers(root, {
      uri: Uri.file(resolve(root, path)), name: "target",
      range: new Range(0, 0, 0, 0)
    }, support, async () => { throw new Error("Must not load after cancellation"); }, () => true)).toEqual([]);
  });

  it("does not read files omitted by the eligible scan", async () => {
    scan.files = [];
    const load = vi.fn();
    expect(await staticCallers(resolve("."), {
      uri: Uri.file(resolve("excluded.go")), name: "target", range: new Range(0, 0, 0, 0)
    }, goSupport, load, () => false)).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});
