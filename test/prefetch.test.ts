import { describe, expect, it } from "vitest";
import { nextPrefetch, prefetchDistance, prefetchFocusLine } from "../src/presentation/prefetch";

const fn = (key: string, startLine: number, endLine: number) => ({ key, startLine, endLine, nameLine: startLine });
const functions = [fn("a", 0, 4), fn("b", 10, 14), fn("c", 20, 24), fn("d", 30, 34), fn("e", 40, 44)];

function order(focusLine: number, window: number): string[] {
  const done = new Set<string>();
  for (let next = nextPrefetch(functions, focusLine, window, done); next; next = nextPrefetch(functions, focusLine, window, done)) {
    done.add(next.key);
  }
  return [...done];
}

describe("prefetch ordering", () => {
  it("measures distance to a function's lines", () => {
    expect(prefetchDistance(fn("x", 10, 14), 12)).toBe(0);
    expect(prefetchDistance(fn("x", 10, 14), 7)).toBe(3);
    expect(prefetchDistance(fn("x", 10, 14), 20)).toBe(6);
  });

  it("starts where the reader is and spreads outward", () => {
    expect(order(22, 0)).toEqual(["c", "b", "d", "a", "e"]);
    expect(order(0, 0)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("limits fetching to a window of the nearest functions", () => {
    expect(order(22, 3)).toEqual(["c", "b", "d"]);
    expect(order(44, 2)).toEqual(["e", "d"]);
  });

  it("moves the window with the reader without refetching", () => {
    const done = new Set(["a", "b"]);
    expect(nextPrefetch(functions, 2, 2, done)).toBeUndefined();
    expect(nextPrefetch(functions, 26, 2, done)?.key).toBe("c");
    done.add("c");
    expect(nextPrefetch(functions, 26, 2, done)?.key).toBe("d");
  });

  it("follows the cursor when visible, otherwise the middle of the screen", () => {
    expect(prefetchFocusLine(15, { start: 10, end: 40 })).toBe(15);
    expect(prefetchFocusLine(2, { start: 10, end: 40 })).toBe(25);
    expect(prefetchFocusLine(7, undefined)).toBe(7);
  });
});
