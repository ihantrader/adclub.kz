import type { OrderView } from "./order-view";

/**
 * The order the order screen has just shown, in memory only (TASK-030):
 * the full-screen QR opened from it shows the very same code, even in the
 * moment before the saved copy has caught up with an order accepted a
 * second ago. Nothing here is written anywhere; the code never becomes a
 * parameter of a screen. Forgotten with the session (`forgetOpenedOrders`).
 */
const opened = new Map<string, OrderView>();

export function rememberOpenedOrder(order: OrderView): void {
  if (order.confirmation) opened.set(order.id, order);
  else opened.delete(order.id);
}

export function openedOrder(orderId: string): OrderView | null {
  return opened.get(orderId) ?? null;
}

export function forgetOpenedOrders(): void {
  opened.clear();
}
