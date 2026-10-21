import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MemoryRepositoryCacheStore } from "../src/cache/store";
import { ChangeSession, type ChangeSessionHost } from "../src/changeSession";
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

function session(onGenerate?: () => Promise<void>, options: Partial<Pick<ChangeSessionHost, "prefetch" | "schedule">> = {}) {
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
  const changes = new ChangeSession({
    service, reveal: async () => undefined, schedule: (task) => task(), changed: () => undefined, ...options
  });
  return { changes, provider, sent, service };
}

function prefetchOptions(allowed = true) {
  return { enabled: vi.fn(() => true), allowed: vi.fn(async () => allowed), background: vi.fn() };
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

  it("preloads a diff with background priority and a marked no-prompt signal when opted in", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const prefetch = prefetchOptions();
    const priorities: Array<string | undefined> = [];
    const { changes, provider } = session(undefined, {
      prefetch,
      schedule: (task, priority) => { priorities.push(priority); return task(); }
    });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("current"));
    expect(provider.requests).toBe(1);
    expect(priorities).toEqual(["prefetch"]);
    expect(prefetch.allowed).toHaveBeenCalledWith(root);
    expect(prefetch.background).toHaveBeenCalledWith(expect.any(AbortSignal));

    changes.clear();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    expect(changes.view(() => "id")?.status).toBe("current");
    expect(provider.requests).toBe(1);
  });

  it.each(["disabled", "unapproved", "untrusted"] as const)("sends nothing when prefetch is %s", async (reason) => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const prefetch = prefetchOptions(reason !== "unapproved");
    prefetch.enabled.mockReturnValue(reason !== "disabled");
    workspace.isTrusted = reason !== "untrusted";
    const { changes, provider } = session(undefined, { prefetch });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.busy).toBe(false));
    expect(provider.requests).toBe(0);
    expect(changes.view(() => "id")?.message ?? "").not.toContain("not approved");
  });

  it("can start after enabling prefetch or granting sharing approval while the diff is shown", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const prefetch = prefetchOptions(false);
    const { changes, provider } = session(undefined, { prefetch });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.busy).toBe(false));
    prefetch.allowed.mockResolvedValue(true);
    await changes.prefetch();
    expect(changes.view(() => "id")?.status).toBe("current");
    expect(provider.requests).toBe(1);
  });

  it("does not regenerate on edits, refreshes, or repeated show events", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes, provider } = session(undefined, { prefetch: prefetchOptions() });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("current"));
    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    await changes.refresh();
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await changes.prefetch();
    expect(changes.view(() => "id")?.status).toBe("outdated");
    expect(provider.requests).toBe(1);
  });

  it("surfaces a failed prefetch without automatically retrying it", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes, sent } = session(async () => { throw new Error("Invalid JSON"); }, { prefetch: prefetchOptions() });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("failed"));
    await changes.refresh();
    await changes.prefetch();
    expect(changes.view(() => "id")?.message).toBe("Invalid JSON");
    expect(sent).toHaveLength(1);
  });

  it.each(["disabled", "switched", "refreshed", "cancelled"] as const)(
    "drops a queued prefetch when %s before a request slot opens",
    async (reason) => {
      await writeFile(join(root, "a.txt"), "export const a = 2;\n");
      const prefetch = prefetchOptions();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const queued = vi.fn();
      const { changes, provider } = session(undefined, {
        prefetch,
        schedule: async (task) => { queued(); await gate; return task(); }
      });
      await changes.show(headOf("a.txt"), uri("file", "a.txt"));
      await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce());
      if (reason === "disabled") prefetch.enabled.mockReturnValue(false);
      else if (reason === "switched") changes.clear();
      else if (reason === "refreshed") await changes.refresh();
      else changes.cancel();
      release();
      await vi.waitFor(() => expect(changes.busy).toBe(false));
      expect(provider.requests).toBe(0);
    }
  );

  it("rejects a prefetched comparison if either source changes during generation", async () => {
    await writeFile(join(root, "a.txt"), "export const a = 2;\n");
    const { changes } = session(async () => {
      await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    }, { prefetch: prefetchOptions() });
    await changes.show(headOf("a.txt"), uri("file", "a.txt"));
    await vi.waitFor(() => expect(changes.view(() => "id")?.status).toBe("failed"));
    expect(changes.view(() => "id")?.message).toContain("changed while");
    expect(changes.view(() => "id")?.result).toBeUndefined();
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
      reveal: async (target, start, end, side) => { opened.push(`${side}:${target.scheme}:${start}-${end}`); },
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
    expect(opened).toEqual(["original:git:1-2"]);
    const modifiedStep = visual.scope.modified.steps[0];
    if (!modifiedStep) throw new Error("Expected a modified-side step.");
    expect(visual.modifiedLinks[modifiedStep.occurrenceId]).toBeTruthy();
    await callbacks.get(visual.modifiedLinks[modifiedStep.occurrenceId]!)?.();
    expect(opened).toEqual(["original:git:1-2", "modified:file:1-2"]);

    await writeFile(join(root, "a.txt"), "export const a = 3;\n");
    await changes.refresh();
    expect(changes.view(() => "stale")?.result?.visualScopes?.[0]?.originalLinks).toEqual({});
  });
});
