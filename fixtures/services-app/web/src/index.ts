export async function placeOrder(id: string): Promise<string> {
  const response = await fetch(`/orders?id=${encodeURIComponent(id)}`, { method: "POST" });
  return response.ok ? "placed" : "failed";
}
