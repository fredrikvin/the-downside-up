import { memo } from "react";
import { formatPrice } from "./format";
import type { CartLine } from "./types";

interface CartItemProps {
  line: CartLine;
  onRemove: (id: string) => void;
}

export const CartItem = memo(({ line, onRemove }: CartItemProps) => (
  <li>
    {line.title} × {line.quantity}: {formatPrice(line.priceCents * line.quantity)}
    <button onClick={() => onRemove(line.id)}>Remove</button>
  </li>
));
