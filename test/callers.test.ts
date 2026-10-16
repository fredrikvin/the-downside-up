import { beforeEach, describe, expect, it, vi } from "vitest";
import { incomingCallers } from "../src/languages/editor/callers";
import { Position, Range, Uri } from "vscode";

const command = vi.hoisted(() => vi.fn());
vi.mock("vscode", async (original) => ({
  ...await original<typeof import("./vscode")>(),
  commands: { executeCommand: command }
}));

describe("incoming callers", () => {
  const uri = Uri.file("/project/source.ts");
  const position = new Position(2, 4);
  const from = {
    name: "caller", uri, selectionRange: new Range(5, 0, 5, 6)
  };
  beforeEach(() => command.mockReset());

  it("distinguishes unavailable call hierarchy from no incoming calls", async () => {
    command.mockResolvedValueOnce(undefined);
    expect(await incomingCallers(uri, position)).toEqual({ available: false, callers: [] });
    command.mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    expect(await incomingCallers(uri, position)).toEqual({ available: true, callers: [] });
  });

  it("deduplicates caller functions and navigates to the call site", async () => {
    command.mockResolvedValueOnce([{}, {}])
      .mockResolvedValue([{ from, fromRanges: [new Range(8, 2, 8, 9)] }]);
    const result = await incomingCallers(uri, position);
    expect(result.callers).toEqual([{ name: "caller", uri, position: new Position(8, 2) }]);
    expect(command.mock.calls[0]).toEqual(["vscode.prepareCallHierarchy", uri, position]);
    expect(command.mock.calls[1]?.[0]).toBe("vscode.provideIncomingCalls");
  });

  it("bounds follow-up lookups and propagates provider failures", async () => {
    command.mockResolvedValueOnce(Array.from({ length: 20 }, () => ({}))).mockResolvedValue([]);
    await incomingCallers(uri, position);
    expect(command).toHaveBeenCalledTimes(9);
    command.mockRejectedValueOnce(new Error("provider failed"));
    await expect(incomingCallers(uri, position)).rejects.toThrow("provider failed");
  });
});
