/**
 * The state machine of an order (PRODUCT 10.1–10.4; ARCHITECTURE 6.1, 6.2,
 * 4.31, 4.59; TASK-021, TASK-037). One table decides which action moves an
 * order of which kind from which status to which: the server applies a move
 * only through a conditional update that finds the order still in the
 * status the move starts from, so two people pressing at once can't both
 * win.
 *
 * **An item in stock** (`stock`): `created → accepted → ready → completed`;
 * besides — cancelled by the user, declined by the supplier, expired without
 * an answer, expired reserve. «Ready» is optional: an accepted order is
 * closed by its code straight away (D-040). Every final status is final but
 * one: an order whose pickup reserve expired is still given out by its code
 * inside the late close window (`close_late`, PRODUCT 10.7, ARCHITECTURE
 * 6.5) — a move of its own, so «the user came in time» never turns into
 * «anything may be closed afterwards». The administrator closes a disputed
 * order without a code (`admin_close`, D-043).
 *
 * **An item to order** (`on_order`, PRODUCT 10.3, ARCHITECTURE 6.2): the
 * same chain, and «Принята» means «срок подтверждён» — the user agreed to
 * the offer's term when ordering, so the supplier's confirmation of it
 * needs no second word. The supplier may propose another term instead
 * (`propose_term` → `term_proposed`); only the user's own «yes» takes the
 * order on (`agree_term`), their «no» cancels it (`reject_term`), and
 * silence expires it (`expire_term` → `term_expired` — the user's silence,
 * never held against the supplier). While the user thinks it over, the
 * supplier may still decline (D-072, TASK-039). The goods are not there until they
 * come: an order whose term is confirmed has no pickup reserve, «Готово к
 * выдаче» starts one (`on_order_pickup_reserve_hours`), and only that
 * reserve expires.
 */

/** `stock` — an item in stock; `on_order` — an item the supplier orders for the user (TASK-037). */
export const orderKinds = ["stock", "on_order"] as const;

export type OrderKind = (typeof orderKinds)[number];

export const orderStatuses = [
  "created",
  "accepted",
  "ready",
  "completed",
  "cancelled_by_user",
  "declined_by_supplier",
  "response_expired",
  "reserve_expired",
  // TASK-036.B: the administrator cancelled it, with a reason (A-ORD-02).
  "cancelled_by_admin",
  // TASK-037: under order — the supplier proposed another term, the user's answer is due.
  "term_proposed",
  // TASK-037: under order — the user did not answer the proposed term in time.
  "term_expired",
] as const;

export type OrderStatus = (typeof orderStatuses)[number];

/**
 * The statuses an order is still going through — **the one definition of
 * «активная заявка»** (TASK-023 requirement 1): it is active until it
 * reaches a final status. M-ORD-02 «Активные» shows exactly these («все
 * незавершённые»), the confirmation code is unique among these, and the
 * saved copy of the app holds these (a `created` order is in the copy too:
 * offline the user still sees «Ждём ответа поставщика», and D-026 gives
 * that card the district but not the address). An order under order whose
 * term waits for the user (`term_proposed`) is active: it is the one card
 * that asks the user for an answer (M-ORD-02 «Нужен ваш ответ»).
 */
export const activeOrderStatuses = [
  "created",
  "accepted",
  "ready",
  "term_proposed",
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
 * выдаче»; for an item under order «срок подтверждён» is the same
 * `accepted` (TASK-037), so it is here already; EPIC-13 adds «время
 * подтверждено» (a service).
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
 * The statuses in which the order waits for the user's own word (SCREENS
 * M-ORD-02, M-ORD-03 «Нужен ваш ответ»): another term proposed by the
 * supplier. EPIC-13 adds another time of a service here.
 */
export const answerAwaitingOrderStatuses = [
  "term_proposed",
] as const satisfies readonly ActiveOrderStatus[];

export function orderNeedsAnswer(status: OrderStatus): boolean {
  return (answerAwaitingOrderStatuses as readonly OrderStatus[]).includes(status);
}

/**
 * The moves. `accept`, `decline`, `mark_ready`, `close`, `close_late`,
 * `propose_term` — an employee of the supplier (`close` and `close_late`
 * only by the code or the QR); `cancel`, `agree_term`, `reject_term` — the
 * user; `admin_close` — the administrator, with a reason (D-043);
 * `admin_cancel` — the administrator, with a reason (TASK-036.B);
 * `expire_no_response`, `expire_reserve`, `expire_term` — the deadline
 * sweeper.
 */
export const orderActions = [
  "accept",
  "decline",
  "mark_ready",
  "close",
  "close_late",
  "admin_close",
  "admin_cancel",
  "cancel",
  "expire_no_response",
  "expire_reserve",
  "propose_term",
  "agree_term",
  "reject_term",
  "expire_term",
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
  admin_cancel: "admin",
  cancel: "user",
  expire_no_response: "system",
  expire_reserve: "system",
  propose_term: "supplier",
  agree_term: "user",
  reject_term: "user",
  expire_term: "system",
} as const satisfies Record<OrderAction, "supplier" | "user" | "admin" | "system">;

interface Move {
  from: readonly OrderStatus[];
  to: OrderStatus;
}

/** The moves of an order on an item in stock (ARCHITECTURE 6.1). */
const stockMoves: Partial<Record<OrderAction, Move>> = {
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
  // TASK-036.B: an order still going on — the same statuses the user may
  // cancel from. An expired order is over already: nothing is left to
  // cancel (its late close window is the supplier's, and the
  // administrator settles a dispute about it with `admin_close`).
  admin_cancel: { from: ["created", "accepted", "ready"], to: "cancelled_by_admin" },
  // Until the order is given out, after accepting too.
  cancel: { from: ["created", "accepted", "ready"], to: "cancelled_by_user" },
  expire_no_response: { from: ["created"], to: "response_expired" },
  // Pickup only: the server never sets a reserve for delivery.
  expire_reserve: { from: ["accepted", "ready"], to: "reserve_expired" },
};

/**
 * The moves of an order on an item to order (ARCHITECTURE 6.2, TASK-037):
 * the moves of an item in stock, the waiting for the user's answer to
 * another term besides, and a reserve only once the goods have come.
 */
const onOrderMoves: Partial<Record<OrderAction, Move>> = {
  ...stockMoves,
  // «Подтвердить срок»: the term the user agreed to when ordering.
  accept: { from: ["created"], to: "accepted" },
  // Another term — only the user's own «yes» takes the order on (PRODUCT 10.3).
  propose_term: { from: ["created"], to: "term_proposed" },
  agree_term: { from: ["term_proposed"], to: "accepted" },
  // «Отказаться»: the user said no to the term — the order is the user's
  // cancel (ARCHITECTURE 6.2), and the supplier hears it like one (W-04).
  reject_term: { from: ["term_proposed"], to: "cancelled_by_user" },
  // The user's silence; never held against the supplier.
  expire_term: { from: ["term_proposed"], to: "term_expired" },
  // D-072: the supplier may learn the goods won't come at all while the
  // user is still thinking over the term — waiting for the answer would be
  // pointless. Declined like any other order; the reason stays unseen.
  decline: {
    from: ["created", "term_proposed", "accepted", "ready"],
    to: "declined_by_supplier",
  },
  // The user may cancel while their answer is due, too (the same «no»).
  cancel: { from: ["created", "term_proposed", "accepted", "ready"], to: "cancelled_by_user" },
  admin_cancel: {
    from: ["created", "term_proposed", "accepted", "ready"],
    to: "cancelled_by_admin",
  },
  // D-043 for both expiries without an agreement: «the goods were handed
  // over all the same» is the administrator's to settle.
  admin_close: {
    from: [
      "created",
      "term_proposed",
      "accepted",
      "ready",
      "response_expired",
      "term_expired",
      "reserve_expired",
    ],
    to: "completed",
  },
  // A confirmed term has no reserve: the goods are not there yet. Only
  // «Готово к выдаче» starts one (`on_order_pickup_reserve_hours`).
  expire_reserve: { from: ["ready"], to: "reserve_expired" },
};

const movesByKind: Record<OrderKind, Partial<Record<OrderAction, Move>>> = {
  stock: stockMoves,
  on_order: onOrderMoves,
};

/** The two moves that give an order out by its code or its QR. */
export const orderCloseActions = ["close", "close_late"] as const satisfies readonly OrderAction[];

export type OrderCloseAction = (typeof orderCloseActions)[number];

/** The statuses an action starts from for an order of `kind`; none — the kind has no such move. */
export function orderActionSources(action: OrderAction, kind: OrderKind): readonly OrderStatus[] {
  return movesByKind[kind][action]?.from ?? [];
}

/**
 * Where `action` takes an order of `kind` in status `from`; `null` — the
 * action isn't possible there.
 */
export function orderTransition(
  from: OrderStatus,
  action: OrderAction,
  kind: OrderKind,
): OrderStatus | null {
  const move = movesByKind[kind][action];
  return move?.from.includes(from) ? move.to : null;
}
