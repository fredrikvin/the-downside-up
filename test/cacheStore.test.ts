import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileRepositoryCacheStore, emptyRepositoryCache } from "../src/cache/store";

it("validates after the temporary write and before atomic rename, preserving the previous record on rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsu-precommit-"));
  try {
    const store = new FileRepositoryCacheStore(directory);
    const root = "/repo";
    const original = emptyRepositoryCache();
    await store.write(root, original);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let changed = false;
    const pending = store.update(root, (cache) => ({ ...cache, consent: {
      provider: "openai", model: "new", acceptedAt: 1
    } }), undefined, async () => {
      expect((await readdir(directory, { recursive: true })).some((name) => name.endsWith(".tmp"))).toBe(true);
      entered(); await gate;
      if (changed) throw new Error("Source moved before commit");
    });
    await started; changed = true; release();
    await expect(pending).rejects.toThrow("Source moved before commit");
    expect(await store.read(root)).toEqual(original);
    expect((await readdir(directory, { recursive: true })).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
