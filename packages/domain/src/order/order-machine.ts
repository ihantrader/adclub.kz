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
 * straight away (D-040). Every final status is final but one: an order
 * whose pickup reserve expired is still given out by its code inside the
 * late close window (`close_late`, PRODUCT 10.7, ARCHITECTURE 6.5) — a
 * move of its own, so «the user came in time» never turns into «anything
 * may be closed afterwards». The administrator closes a disputed order
 * without a code (`admin_close`, D-043).
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

/**
 * The statuses an order is still going through — **the one definition of
 * «активная заявка»** (TASK-023 requirement 1): it is active until it
 * reaches a final status. M-ORD-02 «Активные» shows exactly these («все
 * незавершённые»), the confirmation code is unique among these, and the
 * saved copy of the app holds these (a `created` order is in the copy too:
 * offline the user still sees «Ждём ответа поставщика», and D-026 gives
 * that card the district but not the address).
 */
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
 * The narrower set PRODUCT 6.7 names — the orders «по которым предстоит
 * получение»: the supplier has taken them on and the item is waiting for
 * the user, so the confirmation code and the way to the pickup point
 * matter offline. For an item in stock that is «принята» and «готова к
 * выдаче»; EPIC-13 adds «срок подтверждён» (under order) and «время
 * подтверждено» (a service) here, not to `activeOrderStatuses`.
 *
 * It is a subset of `activeOrderStatuses`, not a second definition of
 * «active»: the saved copy carries every active order and marks these
 * apart (`awaitsReceipt`), because M-ORD-02 shows all of them offline.
 */
export const awaitingReceiptOrderStatuses = [
  "accepted",
  "ready",
] as const satisfies readonly ActiveOrderStatus[];

export function orderAwaitsReceipt(status: OrderStatus): boolean {
  return (awaitingReceiptOrderStatuses as readonly OrderStatus[]).includes(status);
}

/**
 * The moves. `accept`, `decline`, `mark_ready`, `close`, `close_late` — an
 * employee of the supplier (`close` and `close_late` only by the code or
 * the QR); `cancel` — the user; `admin_close` — the administrator, with a
 * reason (D-043); `expire_no_response`, `expire_reserve` — the deadline
 * sweeper.
 */
export const orderActions = [
  "accept",
  "decline",
  "mark_ready",
  "close",
  "close_late",
  "admin_close",
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
  close_late: "supplier",
  admin_close: "admin",
  cancel: "user",
  expire_no_response: "system",
  expire_reserve: "system",
} as const satisfies Record<OrderAction, "supplier" | "user" | "admin" | "system">;

const moves: Record<OrderAction, { from: readonly OrderStatus[]; to: OrderStatus }> = {
  accept: { from: ["created"], to: "accepted" },
  // Before or after accepting (no goods after all), also once ready.
  decline: { from: ["created", "accepted", "ready"], to: "declined_by_supplier" },
  mark_ready: { from: ["accepted"], to: "ready" },
  // D-040: straight from «accepted» too.
  close: { from: ["accepted", "ready"], to: "completed" },
  // PRODUCT 10.7: only an expired reserve, and only inside the window —
  // an order the supplier never answered can't be closed late at all.
  close_late: { from: ["reserve_expired"], to: "completed" },
  // D-043: a disputed order, going on or expired; never a cancelled, a
  // declined or an already given out one.
  admin_close: {
    from: ["created", "accepted", "ready", "response_expired", "reserve_expired"],
    to: "completed",
  },
  // Until the order is given out, after accepting too.
  cancel: { from: ["created", "accepted", "ready"], to: "cancelled_by_user" },
  expire_no_response: { from: ["created"], to: "response_expired" },
  // Pickup only: the server never sets a reserve for delivery.
  expire_reserve: { from: ["accepted", "ready"], to: "reserve_expired" },
};

/** The two moves that give an order out by its code or its QR. */
export const orderCloseActions = ["close", "close_late"] as const satisfies readonly OrderAction[];

export type OrderCloseAction = (typeof orderCloseActions)[number];

/** The statuses an action starts from. */
export function orderActionSources(action: OrderAction): readonly OrderStatus[] {
  return moves[action].from;
}

/** Where `action` takes an order in status `from`; `null` — the action isn't possible there. */
export function orderTransition(from: OrderStatus, action: OrderAction): OrderStatus | null {
  const move = moves[action];
  return move.from.includes(from) ? move.to : null;
}
