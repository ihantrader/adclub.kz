import type { OrderStatus } from "./order-machine";

/**
 * When an order may be given out against the code or the QR the customer
 * shows (PRODUCT 10.1, 10.2, 10.7; ARCHITECTURE 6.1, 6.5, 4.32; TASK-022).
 * One function decides it for the scanner's answer and for the close
 * itself, so the screen never offers «Выдать» on an order the server would
 * refuse:
 *
 * - accepted or ready — give it out now (D-040: «Готова к выдаче» is not
 *   a required step);
 * - the pickup reserve expired and the late close window is still open —
 *   give it out late («Срок заявки истёк {когда}. Если клиент был у вас
 *   вовремя, заявку можно закрыть»); the window is the setting
 *   `order_late_close_hours`, fixed on the order when the reserve expired;
 * - anything else — refused, with the reason the screen shows: the order
 *   is not accepted yet, the customer cancelled it, the supplier declined
 *   it, it expired without the supplier's answer (PRODUCT 10.7: such an
 *   order is never closed late), or the window has passed.
 */

/** The facts of the order itself the decision is made from. */
export interface OrderCloseFacts {
  status: OrderStatus;
  /** When the order reached a final status; `null` — it is still going on. */
  finishedAt: Date | null;
  /** The end of the late close window, set when the pickup reserve expired. */
  lateCloseUntil: Date | null;
}

/** Why an order can't be given out against a code that does point at it. */
export type OrderCloseRefusal =
  | "not_accepted"
  | "cancelled_by_user"
  | "declined_by_supplier"
  | "response_expired"
  | "late_window_passed";

export type OrderCloseVerdict =
  /** Give it out now (the move `close`). */
  | { kind: "now" }
  /** Give it out late (the move `close_late`): when it expired and until when. */
  | { kind: "late"; expiredAt: Date; until: Date }
  /** Already given out. */
  | { kind: "closed" }
  | { kind: "refused"; reason: OrderCloseRefusal; at: Date | null };

const HOUR_MS = 60 * 60 * 1000;

/** The end of the late close window of an order whose reserve expired at `expiredAt`. */
export function lateCloseUntil(expiredAt: Date, lateCloseHours: number): Date {
  return new Date(expiredAt.getTime() + lateCloseHours * HOUR_MS);
}

export function orderCloseVerdict(facts: OrderCloseFacts, at: Date): OrderCloseVerdict {
  switch (facts.status) {
    case "accepted":
    case "ready":
      return { kind: "now" };
    case "created":
      return { kind: "refused", reason: "not_accepted", at: null };
    case "completed":
      return { kind: "closed" };
    case "cancelled_by_user":
    case "declined_by_supplier":
    case "response_expired":
      return { kind: "refused", reason: facts.status, at: facts.finishedAt };
    case "reserve_expired": {
      const until = facts.lateCloseUntil;
      // The window is a stored deadline, as every other one (13.4): a
      // later change of the setting never moves it. At `until` itself the
      // window is over.
      if (until && facts.finishedAt && at < until) {
        return { kind: "late", expiredAt: facts.finishedAt, until };
      }
      return { kind: "refused", reason: "late_window_passed", at: facts.finishedAt };
    }
  }
}
