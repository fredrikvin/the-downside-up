import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cacheKey } from "../core/fingerprint";
import type { RepositoryCache } from "../core/types";

export function emptyRepositoryCache(): RepositoryCache {
  return {
    schemaVersion: 2,
    consent: null,
    overview: null,
    explanations: {}
  };
}

function parseCache(raw: string): RepositoryCache {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 2 ||
    !("explanations" in parsed) ||
    typeof (parsed as { explanations?: unknown }).explanations !== "object"
  ) {
    throw new Error("The cached explanation data is invalid or from an unsupported version.");
  }
  return parsed as RepositoryCache;
}

export interface RepositoryCacheStore {
  read(root: string): Promise<RepositoryCache>;
  write(root: string, value: RepositoryCache): Promise<void>;
  /**
   * Aborts before commit; a committed update resolves even if subsequently aborted.
   * `validate` runs under the write lock immediately before commit; it must not read/update this store.
   */
  update(
    root: string,
    updater: (current: RepositoryCache) => RepositoryCache,
    signal?: AbortSignal,
    validate?: () => Promise<void>
  ): Promise<RepositoryCache>;
  clear(root: string): Promise<void>;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cache update cancelled.", "AbortError");
}

export class FileRepositoryCacheStore implements RepositoryCacheStore {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storageRoot: string,
    private readonly onChanged?: (root: string) => void
  ) {}

  private fileFor(root: string): string {
    return resolve(this.storageRoot, "repositories", cacheKey([root]), "cache.json");
  }

  private async readFile(file: string): Promise<RepositoryCache> {
    try {
      return parseCache(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRepositoryCache();
      throw new Error("The local cache could not be read. Clear it from the extension to recover.", {
        cause: error
      });
    }
  }

  async read(root: string): Promise<RepositoryCache> {
    const file = this.fileFor(root);
    await this.writes.get(file);
    return this.readFile(file);
  }

  protected async persist(file: string, value: RepositoryCache, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
    assertNotCancelled(signal);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await validate?.();
      assertNotCancelled(signal);
      // Rename cannot be cancelled: once issued, its outcome determines whether the update committed.
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async update(
    root: string,
    updater: (current: RepositoryCache) => RepositoryCache,
    signal?: AbortSignal,
    validate?: () => Promise<void>
  ): Promise<RepositoryCache> {
    const file = this.fileFor(root);
    const previous = this.writes.get(file) ?? Promise.resolve();
    const write = previous.then(async () => {
      assertNotCancelled(signal);
      const next = updater(await this.readFile(file));
      assertNotCancelled(signal);
      await this.persist(file, next, signal, validate);
      return next;
    });
    this.writes.set(file, write);
    try {
      const result = await write;
      this.onChanged?.(root);
      return result;
    } finally {
      if (this.writes.get(file) === write) this.writes.delete(file);
    }
  }

  async write(root: string, value: RepositoryCache): Promise<void> {
    await this.update(root, () => value);
  }

  async clear(root: string): Promise<void> {
    const file = this.fileFor(root);
    await this.writes.get(file);
    await rm(dirname(file), { recursive: true, force: true });
    this.onChanged?.(root);
  }
}

export class MemoryRepositoryCacheStore implements RepositoryCacheStore {
  private readonly values = new Map<string, RepositoryCache>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async read(root: string): Promise<RepositoryCache> {
    await this.locks.get(root);
    return structuredClone(this.values.get(root) ?? emptyRepositoryCache());
  }

  async write(root: string, value: RepositoryCache): Promise<void> {
    await this.update(root, () => value);
  }

  async update(
    root: string,
    updater: (current: RepositoryCache) => RepositoryCache,
    signal?: AbortSignal,
    validate?: () => Promise<void>
  ): Promise<RepositoryCache> {
    const previous = this.locks.get(root) ?? Promise.resolve();
    const operation = previous.then(async () => {
      assertNotCancelled(signal);
      const next = updater(structuredClone(this.values.get(root) ?? emptyRepositoryCache()));
      await validate?.();
      assertNotCancelled(signal);
      this.values.set(root, structuredClone(next));
      return structuredClone(next);
    });
    this.locks.set(root, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(root) === operation) this.locks.delete(root);
    }
  }

  async clear(root: string): Promise<void> {
    await this.locks.get(root);
    this.values.delete(root);
  }
}
