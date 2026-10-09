export interface CartLine {
  id: string;
  title: string;
  priceCents: number;
  quantity: number;
}

export interface CartViewProps {
  initialLines: CartLine[];
  onCheckout: (totalCents: number) => void;
}
