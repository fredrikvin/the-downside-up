import {
  comparisonProblem,
  snapshotSignature,
  type ChangedFile,
  type ComparisonRef,
  type ComparisonSnapshot,
  type DiffUri
} from "./context/comparison";
import { resolve } from "node:path";
import { nextReviewFile } from "./presentation/prefetch";
import type { RequestPriority } from "./presentation/requestScheduler";

/** A changed file that review mode explains ahead of the reader, as the two versions that were confirmed. */
export interface ReviewItem {
  /** Modified-side path, or the deleted file's path (working or committed). */
  readonly path: string;
  readonly file: ChangedFile;
  readonly ref: ComparisonRef;
  /** The versions as confirmed; reading something else later marks the item outdated. */
  readonly confirmed: string;
  status: "pending" | "explaining" | "done" | "failed" | "skipped" | "outdated";
}

export interface ReviewHost {
  /** The shared request scheduler. */
  readonly scheduler: {
    readonly prefetchCapacity: number;
    schedule<T>(priority: RequestPriority, task: () => Promise<T>): Promise<T>;
    onCapacityChange(listener: () => void): () => void;
  };
  /** Reads a confirmed pair of versions again. */
  read(ref: ComparisonRef): Promise<ComparisonSnapshot>;
  /** Whether a current comparison is saved for exactly this snapshot; never generates. */
  isCurrent(snapshot: ComparisonSnapshot): Promise<boolean>;
  /** Explains and saves one comparison; `reread` is its final freshness check. */
  explain(snapshot: ComparisonSnapshot, reread: () => Promise<ComparisonSnapshot>, signal: AbortSignal): Promise<unknown>;
  /**
   * Whether background requests may send code now, decided without a prompt:
   * the workspace is trusted and the model that explains comparisons is approved.
   */
  sharingAllowed(root: string): Promise<boolean>;
  /** The repository-relative path being read in this repository, which goes first. */
  readingPath(root: string): string | undefined;
  /** Marks a background request, so consent is never asked for it. */
  background(signal: AbortSignal): void;
  /** Item states changed. */
  changed(): void;
  /** Review stopped on its own; tells the reader why. */
  stoppedWith(notice: { readonly tone: "info" | "error"; readonly text: string }): void;
  /** Pause before a failed file is tried once more; 5 seconds by default. */
  readonly retryDelayMs?: number;
}

export const MAX_REVIEW_FAILURES = 3;

/** Matches a graph's single historical document (add/delete/Open File) only inside the confirmed set. */
export function reviewedDocument(items: readonly ReviewItem[], uri: DiffUri): ReviewItem | undefined {
  if (uri.scheme !== "git") return undefined;
  let query: { path?: unknown; ref?: unknown };
  try { query = JSON.parse(uri.query) as typeof query; } catch { return undefined; }
  if (typeof query?.path !== "string" || typeof query.ref !== "string") return undefined;
  return items.find((item) => [item.ref.original, item.ref.modified].some((side) =>
    side.source.kind === "revision" && side.source.hash === query.ref &&
    resolve(item.ref.root, side.path) === query.path));
}

/** Compact preparation progress; files with failures are never counted as ready. */
export function commitProgress(session: Pick<Review, "items" | "stopped">): { text: string; canStop: boolean } {
  const count = (status: ReviewItem["status"]) => session.items.filter((item) => item.status === status).length;
  const preparing = count("explaining");
  const problems = count("failed") + count("skipped") + count("outdated");
  const canStop = !session.stopped && session.items.some((item) => item.status === "pending" || item.status === "explaining");
  return {
    text: `Commit: ${count("done")}/${session.items.length} ready` +
      (preparing ? ` · ${preparing} preparing` : "") +
      (problems ? ` · ${problems} not ready` : "") +
      (session.stopped ? " · stopped" : ""),
    canStop
  };
}

const stopped = (): DOMException => new DOMException("Review stopped.", "AbortError");

/**
 * Review mode: explains a confirmed set of changed files in the background,
 * with the request slots explicit requests leave free, the file being read
 * first. Each file's reading and cache check happen inside its request slot,
 * so files not yet started stay pending and follow the reader. Reader
 * movement only reorders the set; it never adds to it.
 */
export class Review {
  stopped = false;
  /** The latest failure, for the notice shown when review stops. */
  lastError: string | undefined;
  /** Incremented on every stop and start, so an old loop and its queued work end. */
  private generation = 0;
  private woken = false;
  private wake: (() => void) | undefined;
  private readonly controllers = new Map<ReviewItem, AbortController>();
  private readonly retried = new Set<ReviewItem>();
  /** Failed files waiting to be tried again, which keep the loop alive. */
  private readonly retrying = new Set<ReviewItem>();
  private readonly unsubscribeCapacityChange: () => void;

  constructor(
    private readonly host: ReviewHost,
    readonly root: string,
    /** Such as "since main (merge base 1a2b3c4)" or "in commit 1a2b3c4". */
    readonly base: string,
    readonly items: ReviewItem[],
    readonly kind: "working" | "commit" = "working"
  ) {
    this.unsubscribeCapacityChange = host.scheduler.onCapacityChange(() => this.wakeUp());
  }

  /** Starts, or continues after a stop, explaining the pending files in the background. */
  start(): void {
    this.stopped = false;
    const generation = ++this.generation;
    void this.run(generation).catch(() => this.stop());
  }

  /**
   * Stops starting files. A request already sent finishes and is saved; one
   * still waiting for a slot is not sent, and its file returns to pending
   * once its turn comes, so continuing never explains a file twice.
   */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.wakeUp();
    this.host.changed();
  }

  /** Stops and aborts every request this review has queued or sent; nothing more is saved. */
  cancel(): void {
    this.stop();
    for (const controller of this.controllers.values()) controller.abort();
    this.unsubscribeCapacityChange();
  }

  /** Looks for the next file again, such as after the reader moved or a slot freed. */
  wakeUp(): void {
    if (this.wake) this.wake();
    else this.woken = true;
  }

  /** Explains one file as an ordinary request, which may ask for code-sharing approval. */
  explainNow(item: ReviewItem): Promise<void> {
    if (!this.items.includes(item)) return Promise.reject(new Error("This file was not confirmed for review."));
    const generation = this.generation;
    return this.explain(item, "explicit", () => !this.stopped && this.generation === generation);
  }

  private waitForWake(): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve();
      };
    });
  }

  /**
   * Explains one file. The request slot is taken at once (before any read),
   * so the loop sees the slot as used; the confirmed versions are read again
   * inside it, and a changed file is marked outdated instead of explained.
   */
  private async explain(item: ReviewItem, priority: RequestPriority, shouldStart: () => boolean): Promise<void> {
    const controller = new AbortController();
    if (priority === "prefetch") this.host.background(controller.signal);
    this.controllers.set(item, controller);
    item.status = "explaining";
    try {
      item.status = await this.host.scheduler.schedule(priority, async (): Promise<ReviewItem["status"]> => {
        if (controller.signal.aborted || !shouldStart()) throw stopped();
        const snapshot = await this.host.read(item.ref);
        if (snapshotSignature(snapshot) !== item.confirmed) return "outdated";
        if (comparisonProblem(snapshot)) return "skipped";
        if (await this.host.isCurrent(snapshot)) return "done";
        if (controller.signal.aborted || !shouldStart()) throw stopped();
        await this.host.explain(snapshot, () => this.host.read(item.ref), controller.signal);
        return "done";
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        // Not started, cancelled, or sharing was not approved: nothing was saved.
        item.status = "pending";
      } else {
        const message = error instanceof Error ? error.message : String(error);
        if (/changed while/.test(message)) {
          item.status = "outdated";
        } else {
          item.status = "failed";
          this.lastError = message;
        }
      }
    } finally {
      this.controllers.delete(item);
    }
  }

  private async run(generation: number): Promise<void> {
    const active = () => !this.stopped && this.generation === generation;
    const pending = () => this.items.filter((item) => item.status === "pending");
    while (active()) {
      if (this.host.scheduler.prefetchCapacity === 0 || pending().length === 0) {
        const retryableFailure = this.items.some((item) => item.status === "failed" && !this.retried.has(item));
        if (pending().length === 0 && !this.items.some((item) => item.status === "explaining") && !retryableFailure && this.retrying.size === 0) {
          this.unsubscribeCapacityChange();
          this.host.changed();
          return;
        }
        await this.waitForWake();
        continue;
      }
      if (!(await this.host.sharingAllowed(this.root))) {
        if (!active()) return;
        this.host.stoppedWith({
          tone: "info",
          text: "Explaining changed files stopped: code sharing is not approved for this repository and model, or the workspace is not trusted."
        });
        this.stop();
        return;
      }
      // Chosen after the check, without awaiting, so the slot and the reader's position are current.
      if (!active() || this.host.scheduler.prefetchCapacity === 0) continue;
      const item = nextReviewFile(pending(), this.host.readingPath(this.root));
      if (!item) continue;
      const work = this.explain(item, "prefetch", active);
      this.host.changed();
      void work
        .then(() => this.afterAttempt(item, active))
        .finally(() => {
          this.host.changed();
          this.wakeUp();
        });
    }
  }

  /** A failed file is tried once more after a pause; several failures stop review with a notice. */
  private async afterAttempt(item: ReviewItem, active: () => boolean): Promise<void> {
    if (item.status !== "failed" || !active()) return;
    if (!this.retried.has(item)) {
      // Back off briefly, for example after a rate limit, then try this file once more.
      this.retried.add(item);
      this.retrying.add(item);
      try {
        await new Promise((resolve) => setTimeout(resolve, this.host.retryDelayMs ?? 5_000));
      } finally {
        this.retrying.delete(item);
      }
      if (item.status === "failed") item.status = "pending";
      return;
    }
    if (this.items.filter((candidate) => candidate.status === "failed").length >= MAX_REVIEW_FAILURES) {
      this.host.stoppedWith({ tone: "error", text: `Explaining changed files stopped after several errors: ${this.lastError ?? "generation failed"}` });
      this.stop();
    }
  }
}
