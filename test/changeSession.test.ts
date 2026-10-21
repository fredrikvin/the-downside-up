import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { ChangeSession } from "../src/changeSession";
import { ExplanationService } from "../src/controller";
import type { ComparisonPromptInput } from "../src/generation/provider";
import { MockProvider } from "../src/generation/mock";

let root = "";
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const uri = (scheme: string, path: string, query = "") => {
  const fsPath = join(root, path);
  return { scheme, fsPath, path: fsPath, query, toString: () => `${scheme}:${fsPath}?${query}` } as unknown as vscode.Uri;
};
const headOf = (path: string) => uri("git", path, JSON.stringify({ path: join(root, path), ref: "HEAD" }));
const workspace = vscode.workspace as unknown as Record<string, unknown>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dsu-change-session-")));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(root, "a.txt"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  workspace.isTrusted = true;
  workspace.getWorkspaceFolder = (target: { fsPath: string }) => target.fsPath.startsWith(root) ? { uri: { fsPath: root } } : undefined;
});

afterEach(async () => {
  delete workspace.isTrusted;
  delete workspace.getWorkspaceFolder;
  await rm(root, { recursive: true, force: true });
});

function session(onGenerate?: () => Promise<void>) {
  const provider = new MockProvider();
  const sent: ComparisonPromptInput[] = [];
  const explain = provider.explainComparison.bind(provider);
  vi.spyOn(provider, "explainComparison").mockImplementation(async (input, signal) => {
    sent.push(input);
    await onGenerate?.();
    const result = await explain(input, signal);
    const change = { title: "Value", before: "1", after: "2", when: "always", flow: "", original: { start: 1, end: 1 }, modified: { start: 1, end: 1 } };
    return { ...result, value: { ...result.value, changes: [change] } };
  });
  const service = new ExplanationService({
    store: new MemoryRepositoryCacheStore(),
    describeProvider: () => ({ kind: "mock", modelId: provider.modelId }),
    createProvider: async () => provider,
    authorizeExternalData: async () => true
  });
  const changes = new ChangeSession({ service, reveal: async () => undefined, schedule: (task) => task(), changed: () => undefined });
  return { changes, provider, sent, service };
}

describe("the shown native diff", () => {
  it("only looks up a saved explanation when shown or refreshed", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes, provider } = session();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.refresh();
    expect(changes.view(() => "id")?.status).toBe("ready");
    expect(provider.requests).toBe(0);
  });

  it("explains what HEAD is when asked, not the commit it named when the diff was shown", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    git("add", "a.txt");
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    const { changes, sent } = session();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    git("commit", "-q", "-m", "two");
    await changes.explain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.original.source).toBe("export const a = 2;\n");
    expect(sent[0]!.modified.source).toBe("export const a = 3;\n");
    expect(changes.view(() => "id")?.status).toBe("current");
  });

  it("discards a result when HEAD moves while it is generated", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    git("add", "a.txt");
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    const { changes } = session(async () => { git("commit", "-q", "-m", "two"); });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.explain();
    const view = changes.view(() => "id");
    expect(view?.status).toBe("failed");
    expect(view?.message).toContain("changed while");
    expect(view?.result).toBeUndefined();
  });

  it("hides line links of an explanation once either version changed", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes } = session();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.explain();
    const links = (view: ReturnType<typeof changes.view>) => view?.result?.changes.flatMap((change) => change.links) ?? [];
    const current = changes.view(() => "id");
    expect(current?.result?.outdated).toBeUndefined();
    expect(links(current).map((link) => link.caption)).toEqual(["Original line 1", "Modified line 1"]);
    await writeFile(join(root, "a.txt"), "export const a = 2;\n\n");
    await changes.refresh();
    const view = changes.view(() => "id");
    expect(view?.status).toBe("outdated");
    expect(view?.result?.outdated).toBe(true);
    expect(links(view)).toEqual([]);
  });

  it("adds paired visual views with navigation ids checked against each exact side", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const opened: string[] = [];
    const { service } = session();
    const changes = new ChangeSession({
      service,
      reveal: async (target, start, end) => { opened.push(`${target.scheme}:${start}-${end}`); },
      schedule: (task) => task(),
      changed: () => undefined
    });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.explain();

    const callbacks = new Map<string, () => Promise<void>>();
    const view = changes.view((open) => {
      const id = `ref-${callbacks.size}`;
      callbacks.set(id, open);
      return id;
    });
    const visual = view?.result?.visualScopes?.[0];
    if (!visual) throw new Error("Expected the saved comparison to include paired visual data.");
    expect(visual?.scope.original.steps).toHaveLength(1);
    expect(visual?.scope.modified.pseudocode).toHaveLength(1);
    const originalStep = visual.scope.original.steps[0];
    if (!originalStep) throw new Error("Expected an original-side step.");
    const occurrenceId = originalStep.occurrenceId;
    const reference = visual.originalLinks[occurrenceId];
    if (!reference) throw new Error("Expected a host-validated original-side link.");
    await callbacks.get(reference)?.();
    expect(opened).toEqual(["git:1-2"]);
    const modifiedStep = visual.scope.modified.steps[0];
    if (!modifiedStep) throw new Error("Expected a modified-side step.");
    expect(visual.modifiedLinks[modifiedStep.occurrenceId]).toBeTruthy();

    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    await changes.refresh();
    expect(changes.view(() => "stale")?.result?.visualScopes?.[0]?.originalLinks).toEqual({});
  });
});
