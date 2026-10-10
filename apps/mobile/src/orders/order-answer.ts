import { isApiError } from "@adclub/api-client";
import type { OnOrderTerm, OrderStatusValue } from "@adclub/contracts";

/**
 * The user's answer to another term of an order under order (TASK-039;
 * SCREENS M-ORD-03 block 2 «Ответ пользователя», F5): what the block says
 * and what a refused answer says. The move itself is the server's — the
 * app sends «Согласиться» or «Отказаться» with the version it saw and shows
 * the order the server answers with.
 */

/** «Поставщик предлагает другой срок: {date} (было {was}). Ответьте до {time}». */
export interface TermAnswer {
  /** The proposed date (the point's calendar date). */
  readyOn: string;
  /** The date the user agreed to by ordering; `null` — the point had no working day then. */
  was: string | null;
  /** The answer is due then. */
  answerBy: string;
}

/**
 * The block is drawn while the order waits for the user's word — and only
 * then: an order that moved on (agreed, declined, expired) has no answer to
 * give, whatever the term still says.
 */
export function termAnswer(order: {
  status: OrderStatusValue;
  onOrderTerm: OnOrderTerm | null;
}): TermAnswer | null {
  const proposed = order.onOrderTerm?.proposed;
  if (order.status !== "term_proposed" || !proposed) return null;
  return {
    readyOn: proposed.readyOn,
    was: order.onOrderTerm?.expected.readyOn ?? null,
    answerBy: proposed.answerBy,
  };
}

/**
 * What a refused answer says (the screen loads the order again either
 * way): the deadline passed — «Вы не ответили на предложение поставщика»;
 * the supplier declined first (D-072) — «Поставщик отказал»; anything else
 * that moved it — the order as it is now; no answer at all — try again.
 */
export type TermAnswerProblem = "expired" | "declined" | "changed" | "failed" | "session_ended";

export function termAnswerProblem(error: unknown): TermAnswerProblem {
  if (!isApiError(error)) return "failed";
  switch (error.code) {
    case "ORDER_STATE_CONFLICT": {
      const details = error.details as { currentStatus?: unknown } | undefined;
      const status = details?.currentStatus;
      if (status === "term_expired") return "expired";
      if (status === "declined_by_supplier") return "declined";
      return "changed";
    }
    case "NOT_FOUND":
      return "changed";
    case "SESSION_ENDED":
    case "AUTH_REQUIRED":
    case "ACCESS_TOKEN_EXPIRED":
      return "session_ended";
    default:
      return "failed";
  }
}

export const termAnswerProblemKeys = {
  expired: "order.answer.expired",
  declined: "order.answer.declined",
  changed: "order.cancelChanged",
  failed: "order.answer.failed",
} as const satisfies Record<Exclude<TermAnswerProblem, "session_ended">, string>;

/**
 * «Срок поставки прошёл — свяжитесь с поставщиком» (M-ORD-03): the server
 * said the confirmed date passed and the goods are not ready; once ready or
 * over, the line has nothing to say.
 */
export function supplyOverdue(order: {
  status: OrderStatusValue;
  onOrderTerm: OnOrderTerm | null;
}): boolean {
  return order.status === "accepted" && Boolean(order.onOrderTerm?.overdueSince);
}
