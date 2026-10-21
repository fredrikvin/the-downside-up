import { fingerprint } from "../core/fingerprint";
import type { ComparisonCatalogue, ComparisonCatalogueEntry, ComparisonFunctionSource } from "../core/types";
import { languageFor } from "../languages/registry";
import type { ComparisonFunction, FunctionDiscovery } from "../languages/support";
import type { ComparisonSnapshot } from "./comparison";

const UNCLASSIFIED = "Function classification is unavailable or incomplete for at least one snapshot. No added or removed functions are inferred; textual changes include unclassified regions under Other changes.";

/** Match only language-owned identities; ambiguous duplicates never pair by lexical order or proximity. */
export function classifyComparisonFunctions(
  original: FunctionDiscovery, modified: FunctionDiscovery, snapshotFingerprint: string
): ComparisonCatalogue {
  const limitations = [...new Set([...original.limitations, ...modified.limitations])];
  const base = { version: 1 as const, fingerprint: snapshotFingerprint };
  if (original.status !== "complete" || modified.status !== "complete") {
    return { ...base, classified: false, entries: [], limitations: [...limitations, UNCLASSIFIED] };
  }
  const entries: ComparisonCatalogueEntry[] = [];
  const source = ({ source: _text, matchKey: _key, signatureFingerprint: _sig, kind: _kind, ...range }: ComparisonFunction): ComparisonFunctionSource => range;
  const add = (category: ComparisonCatalogueEntry["category"], before?: ComparisonFunction, after?: ComparisonFunction) => {
    entries.push({
      id: `fn-${fingerprint(JSON.stringify([snapshotFingerprint, category, before, after])).slice(0, 28)}`,
      category, name: (after ?? before)!.qualifiedName, kind: (after ?? before)!.kind,
      ...(before ? { original: source(before) } : {}), ...(after ? { modified: source(after) } : {})
    });
  };
  const keys = new Set([...original.entries, ...modified.entries].map((entry) => entry.matchKey));
  for (const key of keys) {
    let left = original.entries.filter((entry) => entry.matchKey === key);
    let right = modified.entries.filter((entry) => entry.matchKey === key);
    const pair = (before: ComparisonFunction, after: ComparisonFunction) => {
      left = left.filter((entry) => entry !== before);
      right = right.filter((entry) => entry !== after);
      if (before.fingerprint !== after.fingerprint) add("changed", before, after);
    };
    if (left.length === 1 && right.length === 1) {
      pair(left[0]!, right[0]!);
    } else {
      for (const field of ["signatureFingerprint", "fingerprint"] as const) {
        for (const before of [...left]) {
          const matches = right.filter((after) => after[field] === before[field]);
          if (matches.length === 1 && left.filter((entry) => entry[field] === before[field]).length === 1) pair(before, matches[0]!);
        }
      }
      if (left.length && right.length) limitations.push("Ambiguous duplicate functions are shown as removed and added; no rename or occurrence-order matching was inferred.");
    }
    left.forEach((entry) => add("removed", entry));
    right.forEach((entry) => add("added", undefined, entry));
  }
  if (entries.length > 100) return { ...base, classified: false, entries: [], limitations: [...limitations, "The 100-entry comparison catalogue limit was exceeded.", UNCLASSIFIED] };
  return { ...base, classified: true, entries, limitations: [...new Set(limitations)] };
}

/** Both inventories use the exact authorized snapshot texts, with no working-tree fallback. */
export async function comparisonCatalogue(snapshot: ComparisonSnapshot): Promise<ComparisonCatalogue> {
  const discover = async (side: ComparisonSnapshot["original"]): Promise<FunctionDiscovery> => {
    if (side.state === "absent") return { status: "complete", entries: [], limitations: [] };
    const language = languageFor({ path: side.path });
    try {
      return await language.comparisonFunctions?.(side.text, side.path)
        ?? { status: "unavailable", entries: [], limitations: [] };
    } catch {
      return { status: "unavailable", entries: [], limitations: [] };
    }
  };
  return classifyComparisonFunctions(await discover(snapshot.original), await discover(snapshot.modified),
    fingerprint(JSON.stringify([snapshot.root, snapshot.original, snapshot.modified])));
}
