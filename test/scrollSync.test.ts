import { describe, expect, it } from "vitest";
import { innermostRangeAt, lineForOffset, monotonicAnchors, offsetForLine } from "../src/presentation/scrollSync";

describe("preview scroll synchronization", () => {
  const anchors = [
    { line: 3, top: 100 },
    { line: 10, top: 300 },
    { line: 10, top: 340 },
    { line: 14, top: 420 }
  ];

  it("interpolates between rendered anchors like the Markdown preview", () => {
    expect(offsetForLine(anchors, 0, 20, 600)).toBe(0);
    expect(offsetForLine(anchors, 1.5, 20, 600)).toBe(50);
    expect(offsetForLine(anchors, 3, 20, 600)).toBe(100);
    expect(offsetForLine(anchors, 6.5, 20, 600)).toBe(200);
    expect(offsetForLine(anchors, 10, 20, 600)).toBe(300);
    expect(offsetForLine(anchors, 12, 20, 600)).toBe(380);
    expect(offsetForLine(anchors, 17, 20, 600)).toBe(510);
    expect(offsetForLine(anchors, 40, 20, 600)).toBe(600);
    expect(offsetForLine([], 5, 10, 200)).toBe(100);
  });

  it("is self-contained so it can run inside the webview", () => {
    const serialized = new Function(`return (${offsetForLine.toString()});`)() as typeof offsetForLine;
    expect(serialized(anchors, 6.5, 20, 600)).toBe(200);
    const inverse = new Function(`return (${lineForOffset.toString()});`)() as typeof lineForOffset;
    expect(inverse(anchors, 200, 20, 600)).toBe(6.5);
  });

  it("maps preview offsets back to source lines for preview-to-editor sync", () => {
    expect(lineForOffset(anchors, 0, 20, 600)).toBe(0);
    expect(lineForOffset(anchors, 50, 20, 600)).toBe(1.5);
    expect(lineForOffset(anchors, 100, 20, 600)).toBe(3);
    expect(lineForOffset(anchors, 320, 20, 600)).toBe(10);
    expect(lineForOffset(anchors, 510, 20, 600)).toBe(17);
    expect(lineForOffset(anchors, 900, 20, 600)).toBe(20);
    for (const line of [0, 2, 3, 7.25, 12, 18]) {
      expect(lineForOffset(anchors, offsetForLine(anchors, line, 20, 600), 20, 600)).toBeCloseTo(line);
    }
  });

  it("drops anchors that would make scrolling go backwards", () => {
    const anchors = [
      { line: 10, top: 100 },
      { line: 10, top: 300 },
      { line: 12, top: 450 },
      { line: 18, top: 380 },
      { line: 20, top: 900 }
    ];
    expect(monotonicAnchors(anchors)).toEqual([anchors[0], anchors[1], anchors[2], anchors[4]]);
    expect(offsetForLine(monotonicAnchors(anchors), 16, 40, 2000)).toBeGreaterThan(450);
    expect(new Function(`return (${monotonicAnchors.toString()})`)()(anchors)).toHaveLength(4);
  });

  it("picks the innermost entry at a cursor line", () => {
    const ranges = [
      { id: "impl", startLine: 10, endLine: 30 },
      { id: "method", startLine: 12, endLine: 15 },
      { id: "other", startLine: 40, endLine: 41 }
    ];
    expect(innermostRangeAt(ranges, 13)?.id).toBe("method");
    expect(innermostRangeAt(ranges, 20)?.id).toBe("impl");
    expect(innermostRangeAt(ranges, 35)).toBeUndefined();
  });
});
