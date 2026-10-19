import { resolve } from "node:path";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pythonSupport } from "../src/languages/python";
import { findPythonDependencies } from "../src/languages/python/dependencies";
import { pythonFileImports } from "../src/languages/python/imports";
import { listPythonFunctions } from "../src/languages/python/syntax";
import { gatherInventory } from "../src/context/inventory";
import { gatherFunctionContext } from "../src/context/related";
import { inputsMatch } from "../src/cache/freshness";
import { Position, Uri } from "vscode";

beforeAll(() => pythonSupport.initialize!(resolve(".")));

async function dependencies(
  files: Record<string, string>, path = "app.py", name = "caller",
  extra: Partial<Parameters<typeof findPythonDependencies>[0]> = {}
) {
  const fn = (await listPythonFunctions(files[path]!)).find((entry) => entry.qualifiedName === name)!;
  return findPythonDependencies({
    root: "/repo", path, text: files[path]!, line: fn.startLine, name: fn.name,
    readablePaths: new Set(Object.keys(files)), load: async (file) => files[file], ...extra
  });
}

const names = (result: Awaited<ReturnType<typeof dependencies>>) => result.dependencies.map(({ path, item }) => `${path}:${item.qualifiedName}`);

describe("Python static dependencies and import diagrams", () => {
  it("resolves aliases, dotted modules, relative imports, constants and same-file helpers", async () => {
    const files = {
      "src/pkg/__init__.py": "",
      "src/pkg/helpers.py": "LIMIT = 3\ndef work():\n    return LIMIT\n",
      "src/pkg/model.py": "class Book:\n    pass\n",
      "src/pkg/app.py": `from .helpers import work as run
from .model import Book
import pkg.helpers as helper
import pkg.helpers
VALUE = 2
def local():
    return VALUE
def caller():
    book: Book = Book()
    return run() + helper.work() + pkg.helpers.work() + local() + VALUE
`
    };
    const result = await dependencies(files, "src/pkg/app.py");
    expect(names(result)).toEqual(expect.arrayContaining([
      "src/pkg/model.py:Book", "src/pkg/helpers.py:work", "src/pkg/app.py:local", "src/pkg/app.py:VALUE"
    ]));
    expect(names(result)).toHaveLength(4);
    expect(result.preamble).toContain("from .helpers import work as run");
    const imports = await pythonFileImports({
      path: "src/pkg/app.py", text: files["src/pkg/app.py"],
      hasFile: (path) => path in files, readFile: async (path) => files[path as keyof typeof files]
    });
    expect(imports.sort()).toEqual(["src/pkg/helpers.py", "src/pkg/model.py"]);
  });

  it("resolves imported submodules and parent-relative imports without reading outside the eligible set", async () => {
    const files = {
      "pkg/__init__.py": "",
      "pkg/inner/__init__.py": "",
      "pkg/helper.py": "def work():\n    pass\n",
      "pkg/inner/app.py": "from .. import helper as h\nfrom ..helper import work\ndef caller():\n    h.work()\n    work()\n"
    };
    const load = vi.fn(async (path: string) => files[path as keyof typeof files]);
    expect(names(await dependencies(files, "pkg/inner/app.py", "caller", { load }))).toEqual(["pkg/helper.py:work"]);
    expect(load.mock.calls.flat()).toEqual(expect.arrayContaining(["pkg/helper.py"]));
    const blockedLoad = vi.fn(async () => { throw new Error("Excluded modules must not be loaded"); });
    expect(names(await dependencies(files, "pkg/inner/app.py", "caller", {
      readablePaths: new Set(["pkg/inner/app.py"]), load: blockedLoad
    }))).toEqual([]);
    expect(blockedLoad).not.toHaveBeenCalled();
  });

  it("resolves enclosing functions and self/cls methods but not inherited/unknown receivers", async () => {
    const files = { "app.py": `def helper():
    pass
class Catalog:
    def save(self):
        pass
    def caller(self):
        def nested():
            return helper()
        self.save()
        other.save()
        return nested()
    @classmethod
    def build(cls):
        return cls.save()
` };
    expect(names(await dependencies(files, "app.py", "Catalog.caller"))).toEqual(["app.py:Catalog.caller.nested", "app.py:Catalog.save"]);
    expect(names(await dependencies(files, "app.py", "Catalog.caller.nested"))).toEqual(["app.py:helper"]);
    expect(names(await dependencies(files, "app.py", "Catalog.build"))).toEqual(["app.py:Catalog.save"]);
  });

  it.each([
    "def caller(target):\n    target()\n",
    "def caller():\n    target()\n    target = other\n",
    "def caller():\n    for target in things:\n        target()\n",
    "def caller():\n    with thing as target:\n        target()\n",
    "def caller():\n    try:\n        pass\n    except Exception as target:\n        target()\n",
    "def caller():\n    global target\n    target()\n",
    "def caller():\n    [target() for target in things]\n",
    "def caller():\n    match value:\n        case target:\n            target()\n"
  ])("does not infer calls through shadowed bindings: %s", async (caller) => {
    const result = await dependencies({ "app.py": "def target():\n    pass\n" + caller }, "app.py", "caller", { directCallsOnly: true });
    expect(names(result)).toEqual([]);
  });

  it("finds only direct module-level calls, not methods, decorators, defaults, callbacks or nested calls", async () => {
    const files = { "app.py": `def target():
    pass
@wrapper
def decorated():
    pass
class C:
    def method(self):
        target()
def caller(arg=target()):
    def nested():
        target()
    callback = lambda: target()
    consume(target)
    obj.target()
    decorated()
` };
    expect(names(await dependencies(files, "app.py", "caller", { directCallsOnly: true }))).toEqual([]);
    expect(names(await dependencies(files, "app.py", "C.method", { directCallsOnly: true }))).toEqual(["app.py:target"]);
    expect(names(await dependencies(files, "app.py", "caller.nested", { directCallsOnly: true }))).toEqual(["app.py:target"]);
  });

  it("rejects ambiguous modules, duplicate/reassigned definitions and star imports", async () => {
    const files = {
      "helper.py": "def target():\n    pass\n",
      "src/helper.py": "def target():\n    pass\n",
      "app.py": "from helper import target\ndef caller():\n    target()\n"
    };
    expect(names(await dependencies(files, "app.py", "caller", { directCallsOnly: true }))).toEqual([]);
    expect(names(await dependencies({ "app.py": "def target():\n    pass\ntarget = injected\ndef caller():\n    target()\n" }, "app.py", "caller", { directCallsOnly: true }))).toEqual([]);
    expect(names(await dependencies({ "app.py": "def target():\n    pass\nfrom unknown import *\ndef caller():\n    target()\n" }, "app.py", "caller", { directCallsOnly: true }))).toEqual([]);
  });

  it("finds aliased/module-qualified imported direct calls, but not decorated or re-exported targets", async () => {
    const files = {
      "helper.py": "def target():\n    pass\n@wrapper\ndef wrapped():\n    pass\nfrom other import exported\n",
      "app.py": "from helper import target as run, wrapped, exported\nimport helper as h\ndef caller():\n    run()\n    h.target()\n    wrapped()\n    exported()\n"
    };
    expect(names(await dependencies(files, "app.py", "caller", { directCallsOnly: true }))).toEqual(["helper.py:target"]);
  });

  it("tracks a function's decorator implementation as explanation context, not a call made by its body", async () => {
    const files = { "app.py": "def wrapper(fn):\n    return fn\n@wrapper\ndef caller():\n    pass\n" };
    expect(names(await dependencies(files))).toEqual(["app.py:wrapper"]);
    expect(names(await dependencies(files, "app.py", "caller", { directCallsOnly: true }))).toEqual([]);
  });

  it("tracks body changes but keeps helper signature fingerprints stable", async () => {
    const text = "def helper(x: str = 'two  spaces'):\n    return 1\ndef caller():\n    return helper()\n";
    const first = (await dependencies({ "app.py": text })).dependencies[0]!.item;
    const changed = (await dependencies({ "app.py": text.replace("return 1", "return 2") })).dependencies[0]!.item;
    expect(first.fingerprint).not.toBe(changed.fingerprint);
    expect(first.signatureFingerprint).toBe(changed.signatureFingerprint);
    const formatted = (await dependencies({ "app.py": text.replace("helper(x:", "helper( x :") })).dependencies[0]!.item;
    expect(first.signatureFingerprint).toBe(formatted.signatureFingerprint);
    const literal = (await dependencies({ "app.py": text.replace("two  spaces", "two spaces") })).dependencies[0]!.item;
    expect(first.signatureFingerprint).not.toBe(literal.signatureFingerprint);
  });

  it("honors item limits, onlyName, time limits and unsaved dependency buffers", async () => {
    const files = {
      "app.py": "from helper import first, second\ndef caller():\n    first()\n    second()\n",
      "helper.py": "def first():\n    return 'unsaved'\ndef second():\n    pass\n"
    };
    expect(names(await dependencies(files, "app.py", "caller", { maxDependencies: 1 }))).toEqual(["helper.py:first"]);
    expect(names(await dependencies(files, "app.py", "caller", { onlyName: "second" }))).toEqual(["helper.py:second"]);
    expect((await dependencies(files)).dependencies[0]?.item.source).toContain("'unsaved'");
    const load = vi.fn(async () => undefined);
    const expired = await dependencies(files, "app.py", "caller", { deadline: 0, load });
    expect(expired.dependencies).toEqual([]);
    expect(expired.limitations).toContain("Python dependency lookup stopped at its time limit.");
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps real explanation inputs current through formatting and depth-2 body edits, not behavior/signature edits", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "downside-up-python-")));
    const source = "from helper import work\ndef caller():\n    return work()\n";
    let helper = "from leaf import leaf\ndef work():\n    return leaf()\n";
    let leaf = "def leaf(value=1):\n    return value\n";
    const document = { uri: Uri.file(resolve(root, "app.py")), languageId: "python", version: 1, getText: () => source } as import("vscode").TextDocument;
    const context = async () => {
      await writeFile(resolve(root, "helper.py"), helper);
      await writeFile(resolve(root, "leaf.py"), leaf);
      const target = await pythonSupport.findFunction(document, new Position(2, 8));
      return gatherFunctionContext(target!, document, await gatherInventory(root));
    };
    try {
      await writeFile(resolve(root, "app.py"), source);
      const original = await context();
      expect(original.inputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "helper.py", description: "function work", depth: 1, scope: "body" }),
        expect.objectContaining({ path: "leaf.py", description: "signature of function leaf, used by work", depth: 2, scope: "signature" })
      ]));
      expect(original.text).not.toContain("return value");
      helper = helper.replace("def work():\n    return leaf()", "def work( ):\n\n  return leaf( )");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(true);
      leaf = leaf.replace("return value", "return value * 2");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(true);
      leaf = leaf.replace("value=1", "value=2");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
      leaf = leaf.replace("value=2", "value=1");
      helper = helper.replace("return leaf( )", "return leaf( ) + 1");
      expect(inputsMatch(original.inputs, (await context()).inputs)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
