/** Shows an amount in cents as dollars, such as "$12.50". */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export const sum = <T,>(items: readonly T[], value: (item: T) => number): number =>
  items.reduce((total, item) => total + value(item), 0);
