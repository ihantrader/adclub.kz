/**
 * The state machine of an order on an item in stock (PRODUCT 10.1, 10.2,
 * 10.4; ARCHITECTURE 6.1, 4.31; TASK-021). One table decides which action
 * moves an order from which status to which: the server applies a move
 * only through a conditional update that finds the order still in the
 * status the move starts from, so two people pressing at once can't both
 * win.
 *
 * `created → accepted → ready → completed`; besides — cancelled by the
 * user, declined by the supplier, expired without an answer, expired
 * reserve. «Ready» is optional: an accepted order is closed by its code
 * straight away (D-040). Every final status is final: nothing moves an
 * order out of it (the late close of an expired reserve — TASK-022 — is a
 * move of its own, not in this table yet).
 */

export const orderStatuses = [
  "created",
  "accepted",
  "ready",
  "completed",
  "cancelled_by_user",
  "declined_by_supplier",
  "response_expired",
  "reserve_expired",
] as const;

export type OrderStatus = (typeof orderStatuses)[number];

/** The statuses an order is still going through; the code of an order is unique among these. */
export const activeOrderStatuses = [
  "created",
  "accepted",
  "ready",
] as const satisfies readonly OrderStatus[];

export type ActiveOrderStatus = (typeof activeOrderStatuses)[number];

export function isActiveOrderStatus(status: OrderStatus): status is ActiveOrderStatus {
  return (activeOrderStatuses as readonly OrderStatus[]).includes(status);
}

/**
 * The moves. `accept`, `decline`, `mark_ready`, `close` — an employee of
 * the supplier (`close` by the code or QR — TASK-022); `cancel` — the user;
 * `expire_no_response`, `expire_reserve` — the deadline sweeper.
 */
export const orderActions = [
  "accept",
  "decline",
  "mark_ready",
  "close",
  "cancel",
  "expire_no_response",
  "expire_reserve",
] as const;

export type OrderAction = (typeof orderActions)[number];

/** Who may make each move. */
export const orderActionActor = {
  accept: "supplier",
  decline: "supplier",
  mark_ready: "supplier",
  close: "supplier",
  cancel: "user",
  expire_no_response: "system",
  expire_reserve: "system",
} as const satisfies Record<OrderAction, "supplier" | "user" | "system">;

const moves: Record<OrderAction, { from: readonly OrderStatus[]; to: OrderStatus }> = {
  accept: { from: ["created"], to: "accepted" },
  // Before or after accepting (no goods after all), also once ready.
  decline: { from: ["created", "accepted", "ready"], to: "declined_by_supplier" },
  mark_ready: { from: ["accepted"], to: "ready" },
  // D-040: straight from «accepted» too.
  close: { from: ["accepted", "ready"], to: "completed" },
  // Until the order is given out, after accepting too.
  cancel: { from: ["created", "accepted", "ready"], to: "cancelled_by_user" },
  expire_no_response: { from: ["created"], to: "response_expired" },
  // Pickup only: the server never sets a reserve for delivery.
  expire_reserve: { from: ["accepted", "ready"], to: "reserve_expired" },
};

/** The statuses an action starts from. */
export function orderActionSources(action: OrderAction): readonly OrderStatus[] {
  return moves[action].from;
}

/** Where `action` takes an order in status `from`; `null` — the action isn't possible there. */
export function orderTransition(from: OrderStatus, action: OrderAction): OrderStatus | null {
  const move = moves[action];
  return move.from.includes(from) ? move.to : null;
}
