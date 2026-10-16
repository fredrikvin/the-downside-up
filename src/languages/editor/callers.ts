import * as vscode from "vscode";

export interface CallerLocation {
  readonly name: string;
  readonly uri: vscode.Uri;
  readonly position: vscode.Position;
  /** Local fallback snapshot, checked again before navigation after the picker. */
  readonly source?: string;
}

/** Native incoming calls only, not references that may merely mention the function. */
export async function incomingCallers(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<{ available: boolean; callers: CallerLocation[] }> {
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    "vscode.prepareCallHierarchy", uri, position
  );
  if (!items?.length) return { available: false, callers: [] };
  const callers = new Map<string, CallerLocation>();
  // Bound follow-up lookups for providers returning multiple possible targets.
  for (const item of items.slice(0, 8)) {
    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      "vscode.provideIncomingCalls", item
    );
    for (const call of incoming ?? []) {
      const from = call.from;
      const at = call.fromRanges[0]?.start ?? from.selectionRange.start;
      const key = `${from.uri.toString()}:${from.selectionRange.start.line}:${from.selectionRange.start.character}`;
      if (!callers.has(key)) callers.set(key, { name: from.name, uri: from.uri, position: at });
      if (callers.size >= 100) return { available: true, callers: [...callers.values()] };
    }
  }
  return { available: true, callers: [...callers.values()] };
}
