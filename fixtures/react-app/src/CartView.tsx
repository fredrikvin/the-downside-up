import { useEffect } from "react";
import { CartItem } from "./CartItem";
import { formatPrice } from "./format";
import type { CartViewProps } from "./types";
import { useCart } from "./useCart";

// The shopping cart page.

export function CartView({ initialLines, onCheckout }: CartViewProps) {
  const cart = useCart(initialLines);

  useEffect(() => {
    document.title = `Cart (${cart.lines.length})`;
  }, [cart.lines.length]);

  const handleCheckout = () => {
    onCheckout(cart.totalCents);
  };

  if (cart.lines.length === 0) {
    return <p>Your cart is empty.</p>;
  }

  return (
    <section>
      <ul>
        {cart.lines.map((line) => (
          <CartItem key={line.id} line={line} onRemove={cart.remove} />
        ))}
      </ul>
      <p>Total: {formatPrice(cart.totalCents)}</p>
      <button onClick={handleCheckout}>Check out</button>
    </section>
  );
}
