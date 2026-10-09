import { useMemo, useState } from "react";
import { sum } from "./format";
import type { CartLine } from "./types";

/** Keeps the cart's lines and their total. */
export function useCart(initialLines: CartLine[]) {
  const [lines, setLines] = useState<CartLine[]>(initialLines);
  const totalCents = useMemo(() => sum(lines, (line) => line.priceCents * line.quantity), [lines]);

  function remove(id: string) {
    setLines((current) => current.filter((line) => line.id !== id));
  }

  return { lines, totalCents, remove };
}
