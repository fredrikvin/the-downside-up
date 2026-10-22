import { describe, expect, it } from "vitest";
import { unapprovedModels, withConsent } from "../src/cache/consent";
import { emptyRepositoryCache } from "../src/cache/store";
import { snapshotSignature, type ComparisonRef, type ComparisonSnapshot } from "../src/context/comparison";
import { RequestScheduler } from "../src/presentation/requestScheduler";
import { Review, commitProgress, reviewNavigation, reviewedDocument, type ReviewHost, type ReviewItem } from "../src/review";

const root = "/repo";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const side = (path: string, identity: string, text: string) => ({
  path, identity, state: "present" as const, detail: "", text, fingerprint: `fp:${text}`, lines: text.split("\n").length
});

/** A fake repository: each path has a base and a working text, which tests may change. */
class Fixture {
  readonly texts = new Map<string, string>();
  readonly reads: string[] = [];
  readonly explained: string[] = [];
  readonly saved: string[] = [];
  readonly signals: AbortSignal[] = [];
  readonly backgroundSignals: AbortSignal[] = [];
  readonly notices: string[] = [];
  reading: string | undefined;
  allowed = true;
  /** When set, reads wait for the test to release them. */
  slowReads: Deferred<void>[] | undefined;
  /** How each explanation ends; by default it saves at once. */
  outcome: (path: string, signal: AbortSignal) => Promise<void> = async () => undefined;
  review!: Review;
  readonly scheduler: RequestScheduler;

  constructor(limit: number) {
    const scheduler = new RequestScheduler(() => limit);
    this.scheduler = scheduler;
    const host: ReviewHost = {
      scheduler: {
        get prefetchCapacity() { return scheduler.prefetchCapacity; },
        schedule: (priority, task) => scheduler.schedule(priority, task),
        onCapacityChange: (listener) => scheduler.onCapacityChange(listener)
      },
      read: async (ref) => {
        this.reads.push(ref.modified.path);
        if (this.slowReads) {
          const wait = deferred();
          this.slowReads.push(wait);
          await wait.promise;
        }
        return this.snapshot(ref.modified.path);
      },
      isCurrent: async (snapshot) => this.saved.includes(snapshot.modified.path),
      explain: async (snapshot, reread, signal) => {
        const path = snapshot.modified.path;
        this.explained.push(path);
        this.signals.push(signal);
        await this.outcome(path, signal);
        if (signal.aborted) throw new DOMException("Cancelled.", "AbortError");
        if (snapshotSignature(await reread()) !== snapshotSignature(snapshot)) throw new Error("The files changed while the change was being explained.");
        this.saved.push(path);
      },
      sharingAllowed: async () => this.allowed,
      readingPath: () => this.reading,
      background: (signal) => this.backgroundSignals.push(signal),
      changed: () => undefined,
      stoppedWith: (notice) => this.notices.push(notice.text),
      retryDelayMs: 0
    };
    this.host = host;
  }

  readonly host: ReviewHost;

  snapshot(path: string): ComparisonSnapshot {
    return { root, original: side(path, "revision:" + "1".repeat(40), "base"), modified: side(path, "working", this.texts.get(path) ?? "") };
  }

  items(...paths: string[]): ReviewItem[] {
    return paths.map((path) => {
      this.texts.set(path, `${path} edited`);
      const ref: ComparisonRef = { root, original: { path, source: { kind: "revision", hash: "1".repeat(40) } }, modified: { path, source: { kind: "working" } } };
      return { path, file: { status: "modified", path }, ref, confirmed: snapshotSignature(this.snapshot(path)), status: "pending" };
    });
  }

  start(...paths: string[]): Review {
    this.review = new Review(this.host, root, "since HEAD", this.items(...paths));
    this.review.start();
    return this.review;
  }

  statuses(): string[] {
    return this.review.items.map((item) => `${item.path} ${item.status}`);
  }
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe("review navigation matching", () => {
  const revision = (path: string, hash: string, root = "/repo"): ComparisonRef => ({
    root,
    original: { path, source: { kind: "revision", hash } },
    modified: { path, source: { kind: "revision", hash: "b".repeat(40) } }
  });

  it("orders confirmed files by path and requires both full side identities, paths, and repository", () => {
    const fixture = new Fixture(1);
    const items = fixture.items("z.ts", "a.ts", "m.ts");
    // The changed comparison is a rename: both paths and immutable revisions must match.
    const rename: ComparisonRef = {
      root,
      original: { path: "old.ts", source: { kind: "revision", hash: "a".repeat(40) } },
      modified: { path: "new.ts", source: { kind: "revision", hash: "b".repeat(40) } }
    };
    const added: ReviewItem = {
      path: "new.ts", file: { status: "renamed", path: "new.ts" }, ref: rename,
      confirmed: "confirmed", status: "done"
    };
    const mixed = [items[0]!, added, items[1]!, items[2]!];
    const matched = reviewNavigation(mixed, { ...rename, original: { ...rename.original }, modified: { ...rename.modified } });
    expect(matched?.items.map((item) => item.path)).toEqual(["a.ts", "m.ts", "new.ts", "z.ts"]);
    expect(matched?.index).toBe(2);
    expect(reviewNavigation(mixed, { ...rename, original: { ...rename.original, path: "other.ts" } })).toBeUndefined();
    expect(reviewNavigation(mixed, { ...rename, original: { path: "old.ts", source: { kind: "revision", hash: "c".repeat(40) } } })).toBeUndefined();
    expect(reviewNavigation(mixed, { ...rename, root: "/another-repo" })).toBeUndefined();
    expect(reviewNavigation(mixed, { ...rename, modified: { path: "new.ts", source: { kind: "working" } } })).toBeUndefined();
  });

  it("matches working and commit comparisons only to their exact pair, not matching names", () => {
    const fixture = new Fixture(1);
    const working = fixture.items("same.ts")[0]!;
    const ref = working.ref;
    expect(reviewNavigation([working], ref)?.index).toBe(0);
    expect(reviewNavigation([working], {
      ...ref,
      original: { ...ref.original, source: { kind: "revision", hash: "2".repeat(40) } }
    })).toBeUndefined();

    const commit: ReviewItem = {
      ...working,
      ref: {
        root,
        original: { path: "same.ts", source: { kind: "revision", hash: "3".repeat(40) } },
        modified: { path: "same.ts", source: { kind: "revision", hash: "4".repeat(40) } }
      }
    };
    expect(reviewNavigation([commit], commit.ref)?.index).toBe(0);
    expect(reviewNavigation([commit], ref)).toBeUndefined();
  });
});

describe("review mode", () => {
  it("does not allow an explicit request to add an unconfirmed file to the queue", async () => {
    const fixture = new Fixture(2);
    const review = new Review(fixture.host, root, "commit", fixture.items("a.ts"), "commit");
    const outside = fixture.items("outside.ts")[0]!;
    await expect(review.explainNow(outside)).rejects.toThrow("not confirmed");
    expect(fixture.reads).toEqual([]);
    expect(fixture.explained).toEqual([]);
    review.cancel();
  });

  it("binds graph Git documents only to exact confirmed revision/path identities", () => {
    const fixture = new Fixture(2);
    const item = fixture.items("a.ts")[0]!;
    const original = item.ref.original;
    const hash = "1".repeat(40);
    const document = (path: string, ref: string) => ({ scheme: "git", fsPath: path, query: JSON.stringify({ path, ref }) });
    expect(original.source).toEqual({ kind: "revision", hash });
    expect(reviewedDocument([item], document("/repo/a.ts", hash))).toBe(item);
    expect(reviewedDocument([item], document("/repo/a.ts", "HEAD"))).toBeUndefined();
    expect(reviewedDocument([item], document("/repo/outside.ts", hash))).toBeUndefined();
    expect(reviewedDocument([item], document("/elsewhere/a.ts", hash))).toBeUndefined();
    expect(reviewedDocument([item], { scheme: "git", fsPath: "/repo/a.ts", query: "null" })).toBeUndefined();
    expect(reviewedDocument([item], { ...document("/repo/a.ts", hash), scheme: "file" })).toBeUndefined();
  });

  it("reports compact commit progress without counting failed/skipped/outdated files as ready", () => {
    const fixture = new Fixture(2);
    const items = fixture.items("a.ts", "b.ts", "c.ts", "d.ts", "e.ts");
    items[0]!.status = "done";
    items[1]!.status = "explaining";
    items[2]!.status = "failed";
    expect(commitProgress({ items, stopped: false })).toEqual({ text: "Commit: 1/5 ready · 1 preparing · 1 not ready", canStop: true });
    expect(commitProgress({ items, stopped: true })).toEqual({ text: "Commit: 1/5 ready · 1 preparing · 1 not ready · stopped", canStop: false });
    for (const item of items) item.status = "done";
    expect(commitProgress({ items, stopped: false })).toEqual({ text: "Commit: 5/5 ready", canStop: false });
  });

  it("explains every confirmed file in the background and stops when done", async () => {
    const fixture = new Fixture(3);
    fixture.start("a.ts", "b.ts", "c.ts");
    await until(() => fixture.review.items.every((item) => item.status === "done"), "all files explained");
    expect(fixture.saved.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(fixture.backgroundSignals).toHaveLength(3);
  });

  it("takes a request slot before reading, so slow reads start one file per free slot and the rest follow the reader", async () => {
    const fixture = new Fixture(2);
    fixture.slowReads = [];
    fixture.start("a.ts", "b.ts", "c.ts", "d.ts", "e.ts");
    await settle();
    expect(fixture.reads).toEqual(["a.ts"]);
    expect(fixture.statuses()).toEqual(["a.ts explaining", "b.ts pending", "c.ts pending", "d.ts pending", "e.ts pending"]);

    fixture.reading = "d.ts";
    const first = fixture.slowReads;
    fixture.slowReads = undefined;
    for (const read of first) read.resolve();
    await until(() => fixture.saved.length === 5, "all files explained");
    expect(fixture.reads.indexOf("d.ts")).toBeLessThan(fixture.reads.indexOf("b.ts"));
    expect(fixture.explained.slice(0, 2)).toEqual(["a.ts", "d.ts"]);
  });

  it("lets an explicit request start while background work takes the other slots", async () => {
    const fixture = new Fixture(2);
    const release = deferred();
    fixture.outcome = async (path) => { if (path === "a.ts") await release.promise; };
    const review = fixture.start("a.ts", "b.ts", "c.ts");
    await settle();
    expect(fixture.explained).toEqual(["a.ts"]);
    await review.explainNow(review.items[2]!);
    expect(fixture.explained).toEqual(["a.ts", "c.ts"]);
    expect(review.items[2]!.status).toBe("done");
    release.resolve();
    await until(() => review.items.every((item) => item.status === "done"), "the rest explained");
    expect(fixture.explained.filter((path) => path === "c.ts")).toHaveLength(1);
  });

  it("aborts queued and running requests on cancel and saves nothing", async () => {
    const fixture = new Fixture(1);
    fixture.outcome = (_path, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
    const review = fixture.start("a.ts", "b.ts");
    await settle();
    expect(fixture.explained).toEqual(["a.ts"]);
    const queued = review.explainNow(review.items[1]!);
    await settle();
    expect(review.items[1]!.status).toBe("explaining");

    review.cancel();
    await queued;
    await settle();
    expect(fixture.signals.every((signal) => signal.aborted)).toBe(true);
    expect(fixture.explained).toEqual(["a.ts"]);
    expect(fixture.saved).toEqual([]);
    expect(fixture.statuses()).toEqual(["a.ts pending", "b.ts pending"]);
    expect(fixture.scheduler.running).toBe(0);
  });

  it("aborts sent work when a stopped review is retired", async () => {
    const fixture = new Fixture(1);
    fixture.outcome = (_path, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
    const review = fixture.start("a.ts");
    await until(() => fixture.explained.length === 1, "the request to be sent");
    review.stop();
    expect(fixture.signals[0]!.aborted).toBe(false);

    review.cancel();
    await until(() => fixture.signals[0]!.aborted, "the retired request to be aborted");
    await until(() => fixture.scheduler.running === 0, "the retired request to settle");
    expect(fixture.saved).toEqual([]);
    expect(review.items[0]!.status).toBe("pending");
  });

  it("keeps review items pending and follows the reader while explicit requests occupy every slot", async () => {
    const fixture = new Fixture(2);
    const first = deferred();
    const second = deferred();
    const explicit = [
      fixture.scheduler.schedule("explicit", () => first.promise),
      fixture.scheduler.schedule("explicit", () => second.promise)
    ];
    await settle();
    expect(fixture.scheduler.prefetchCapacity).toBe(0);

    const review = fixture.start("a.ts", "b.ts", "c.ts", "d.ts");
    await settle();
    expect(fixture.reads).toEqual([]);
    expect(review.items.every((item) => item.status === "pending")).toBe(true);

    fixture.reading = "d.ts";
    first.resolve();
    await until(() => fixture.reads.includes("d.ts"), "review to wake when an explicit slot frees");
    expect(fixture.reads[0]).toBe("d.ts");
    review.cancel();
    second.resolve();
    await Promise.all(explicit);
  });

  it("lets sent work finish on stop, and continuing does not explain an in-flight file twice", async () => {
    const fixture = new Fixture(1);
    const release = deferred();
    fixture.outcome = async (path) => { if (path === "a.ts") await release.promise; };
    const review = fixture.start("a.ts", "b.ts");
    await settle();
    review.stop();
    expect(review.items[0]!.status).toBe("explaining");
    review.start();
    await settle();
    expect(fixture.explained).toEqual(["a.ts"]);
    release.resolve();
    await until(() => review.items.every((item) => item.status === "done"), "both files explained");
    expect(fixture.explained).toEqual(["a.ts", "b.ts"]);
    expect(fixture.signals[0]!.aborted).toBe(false);
  });

  it("does not start queued work after a stop", async () => {
    const fixture = new Fixture(1);
    fixture.slowReads = [];
    const review = fixture.start("a.ts", "b.ts");
    await settle();
    review.stop();
    fixture.slowReads[0]!.resolve();
    await settle();
    expect(fixture.explained).toEqual([]);
    expect(fixture.statuses()).toEqual(["a.ts pending", "b.ts pending"]);
  });

  it("marks a file outdated when it changed since it was confirmed or while it was explained", async () => {
    const fixture = new Fixture(1);
    const review = new Review(fixture.host, root, "since HEAD", fixture.items("a.ts", "b.ts"));
    fixture.review = review;
    fixture.texts.set("a.ts", "a.ts  edited");
    fixture.outcome = async (path) => { if (path === "b.ts") fixture.texts.set("b.ts", "b.ts edited\n"); };
    review.start();
    await until(() => review.items.every((item) => item.status !== "pending" && item.status !== "explaining"), "both files handled");
    expect(fixture.statuses()).toEqual(["a.ts outdated", "b.ts outdated"]);
    expect(fixture.saved).toEqual([]);
  });

  it("tries a failed file once more, also when it is the last one", async () => {
    const fixture = new Fixture(1);
    let attempts = 0;
    fixture.outcome = async () => {
      if (++attempts === 1) throw new Error("rate limited");
    };
    const review = fixture.start("a.ts");
    await until(() => review.items[0]!.status === "done", "the retry to succeed");
    expect(attempts).toBe(2);
  });

  it("stops without reading anything when background sharing is not allowed", async () => {
    const fixture = new Fixture(2);
    fixture.allowed = false;
    const review = fixture.start("a.ts");
    await settle();
    expect(review.stopped).toBe(true);
    expect(fixture.reads).toEqual([]);
    expect(fixture.notices[0]).toContain("not approved");
  });

  it("needs approval only for the model that explains comparisons, not for a separate overview model", async () => {
    const functions = { kind: "openai", modelId: "functions-model" };
    const overview = { kind: "openai", modelId: "overview-model" };
    const cache = withConsent(emptyRepositoryCache(), "openai", "functions-model", 1);
    const consentId = async (model: { modelId: string }) => model.modelId;
    expect(await unapprovedModels(cache, [functions], consentId)).toEqual([]);
    expect(await unapprovedModels(cache, [functions, overview], consentId)).toEqual([overview]);
    expect(await unapprovedModels(emptyRepositoryCache(), [{ kind: "mock", modelId: "m" }], consentId)).toEqual([]);
    expect(await unapprovedModels(cache, [functions], async () => undefined)).toEqual([functions]);
  });
});
