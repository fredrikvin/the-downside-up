import { describe, expect, it } from "vitest";
import { structureLayout } from "../src/presentation/structureLayout";

const boxes = (rows: string[][]) => rows.map((row) => row.filter((id) => !id.startsWith("\u0001"))).filter((row) => row.length);

const graph = (ids: string[], edges: Array<[string, string]>) => ({
  nodes: ids.map((id) => ({ id })),
  edges: edges.map(([from, to]) => ({ from, to, weight: 1 }))
});

describe("structure diagram layout", () => {
  it("puts importers above what they import", () => {
    const layout = structureLayout(graph(["types", "app", "service"], [["app", "service"], ["service", "types"], ["app", "types"]]));
    expect(boxes(layout.rows)).toEqual([["app"], ["service"], ["types"]]);
    expect(layout.rowKinds).toEqual(["layer", "layer", "layer"]);
    expect(layout.back).toEqual([]);
    // The edge skipping the middle row gets a waypoint there, beside the box.
    expect(layout.routes).toEqual({ "app\u0000types": ["\u00010"] });
    expect(layout.rows[1]).toHaveLength(2);
  });

  it("moves a folder most others import to a shared bottom row and hides its edges", () => {
    const layout = structureLayout(graph(
      ["a", "b", "c", "d", "utils", "readme"],
      [["a", "b"], ["a", "utils"], ["b", "utils"], ["c", "utils"], ["d", "c"], ["d", "utils"]]
    ));
    expect(boxes(layout.rows)).toEqual([["a", "d"], ["b", "c"], ["readme"], ["utils"]]);
    expect(layout.rowKinds).toEqual(["layer", "layer", "unconnected", "shared"]);
    expect(layout.usedBy).toEqual({ utils: 4 });
    expect(layout.hidden).toHaveLength(4);
  });

  it("draws the edge closing a cycle upward", () => {
    const layout = structureLayout(graph(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "b"]]));
    expect(boxes(layout.rows)).toEqual([["a"], ["b"], ["c"]]);
    expect(layout.back).toEqual(["c\u0000b"]);
  });

  it("orders a row under its neighbors to reduce crossings", () => {
    const layout = structureLayout(graph(["left", "right", "under-right", "under-left"], [["left", "under-left"], ["right", "under-right"]]));
    expect(layout.rows).toEqual([["left", "right"], ["under-left", "under-right"]]);
  });

  it("runs on its own, as the webview needs", () => {
    const standalone = new Function(`return (${structureLayout.toString()})`)() as typeof structureLayout;
    expect(standalone(graph(["a", "b"], [["a", "b"]])).rows).toEqual([["a"], ["b"]]);
  });
});
