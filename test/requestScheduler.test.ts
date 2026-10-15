import { describe, expect, it } from "vitest";
import { RequestScheduler, singleFlight } from "../src/presentation/requestScheduler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((done) => setTimeout(done, 0));

describe("request scheduler", () => {
  it("runs up to the limit at once and starts the next when one finishes", async () => {
    const scheduler = new RequestScheduler(() => 2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) => scheduler.schedule("explicit", async () => {
      started.push(index);
      await gate.promise;
    }));
    await tick();
    expect(started).toEqual([0, 1]);
    gates[0]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(runs);
    expect(scheduler.running).toBe(0);
  });

  it("starts explicit requests before waiting prefetches and keeps a slot for them", async () => {
    const scheduler = new RequestScheduler(() => 3);
    const started: string[] = [];
    const gate = deferred();
    const run = (name: string, priority: "explicit" | "prefetch") =>
      scheduler.schedule(priority, async () => {
        started.push(name);
        await gate.promise;
      });
    const prefetches = ["p1", "p2", "p3"].map((name) => run(name, "prefetch"));
    await tick();
    expect(started).toEqual(["p1", "p2"]);
    expect(scheduler.prefetchCapacity).toBe(0);
    const explicit = run("e1", "explicit");
    await tick();
    expect(started).toEqual(["p1", "p2", "e1"]);
    gate.resolve();
    await Promise.all([...prefetches, explicit]);
    expect(started).toEqual(["p1", "p2", "e1", "p3"]);
  });

  it("lets prefetching use the only slot when the limit is 1, and clamps the limit to 1-8", async () => {
    const single = new RequestScheduler(() => 1);
    expect(single.prefetchCapacity).toBe(1);
    await single.schedule("prefetch", async () => undefined);
    expect(new RequestScheduler(() => 0).prefetchCapacity).toBe(1);
    expect(new RequestScheduler(() => 20).prefetchCapacity).toBe(7);
  });

  it("reports task errors to the caller and frees the slot", async () => {
    const scheduler = new RequestScheduler(() => 1);
    await expect(scheduler.schedule("explicit", async () => {
      throw new Error("failed");
    })).rejects.toThrow("failed");
    await expect(scheduler.schedule("explicit", async () => "next")).resolves.toBe("next");
  });

  it("makes released prefetch capacity visible before notifying a completed caller", async () => {
    const scheduler = new RequestScheduler(() => 1);
    for (let index = 0; index < 10; index++) {
      expect(scheduler.prefetchCapacity).toBe(1);
      await scheduler.schedule("prefetch", async () => undefined);
      expect(scheduler.running).toBe(0);
    }
    await expect(scheduler.schedule("prefetch", () => { throw new Error("sync failure"); })).rejects.toThrow("sync failure");
    expect(scheduler.prefetchCapacity).toBe(1);
    await expect(scheduler.schedule("prefetch", async () => { throw new Error("async failure"); })).rejects.toThrow("async failure");
    expect(scheduler.prefetchCapacity).toBe(1);
  });
});

describe("single flight", () => {
  it("shares one run per key until it settles", async () => {
    const pending = new Map<string, Promise<boolean>>();
    let calls = 0;
    const gate = deferred();
    const ask = () => singleFlight(pending, "repo\0model", async () => {
      calls++;
      await gate.promise;
      return true;
    });
    const answers = Promise.all([ask(), ask(), ask()]);
    gate.resolve();
    expect(await answers).toEqual([true, true, true]);
    expect(calls).toBe(1);
    await ask();
    expect(calls).toBe(2);
  });
});
