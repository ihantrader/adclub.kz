import { isApiError } from "@adclub/api-client";
import type { OrderFulfillment } from "@adclub/contracts";

/**
 * The rules of the checkout (M-ORD-01, TASK-030) without React Native:
 * the key that makes one attempt one order, what each answer of
 * `POST /orders` leads to, the sum and the ways to get the item.
 */

// ---------------------------------------------------------- the key of an attempt

/** What one order is: another offer, quantity or way to get it is another order. */
export interface CheckoutAttempt {
  offerId: string;
  quantity: number;
  fulfillment: OrderFulfillment;
}

/**
 * `idempotencyKey` of `POST /orders` (ARCHITECTURE 4.31 I311): the server
 * returns the order it already made for a key it has seen, so a lost
 * answer sent again never makes a second order. One set of keys lives as
 * long as one checkout screen:
 *
 * - the same attempt gets the same key, every time — a retry after a
 *   network failure, «Оформить по новой цене», «Оформить ещё одну» are all
 *   the same order still being placed (the price and the permission to have
 *   another active order are not part of what the key names);
 * - another quantity, way to get it or offer gets a key of its own: the
 *   server refuses a seen key with another order in it
 *   (`ORDER_IDEMPOTENCY_MISMATCH`), and it would be another order;
 * - going back to an attempt already sent (2 → 3 → 2) reuses its key, so an
 *   order that was made by a lost answer is found again, not doubled.
 */
export interface AttemptKeys {
  keyFor(attempt: CheckoutAttempt): string;
}

export function createAttemptKeys(newKey: () => string): AttemptKeys {
  const keys = new Map<string, string>();
  return {
    keyFor(attempt) {
      const id = `${attempt.offerId}|${attempt.quantity}|${attempt.fulfillment}`;
      let key = keys.get(id);
      if (key === undefined) {
        key = newKey();
        keys.set(id, key);
      }
      return key;
    },
  };
}

// ---------------------------------------------------------- the answers

/** What the checkout does with an answer that is not an order (TASK-030 requirement 1). */
export type CheckoutFailure =
  /** «Цена изменилась: было N ₸, стало M ₸» → «Оформить по новой цене» / «Отмена». */
  | { kind: "price_changed"; expectedPrice: number; currentPrice: number }
  /** «Поставщик снял это предложение» → back to the card, its offers loaded afresh. */
  | { kind: "offer_unavailable" }
  /** The screen loads the offer again and shows the ways it really has. */
  | { kind: "fulfillment_unavailable" }
  /** «У вас уже есть заявка на это предложение» → «Открыть её» / «Оформить ещё одну». */
  | { kind: "duplicate_active"; existingOrderId: string }
  /** M-AUTH-03, then back here. */
  | { kind: "registration_incomplete" }
  /** The stand-in for the subscription (TASK-030 requirement 2). */
  | { kind: "club_access_required" }
  /** «Под заказ» — stage C; the checkout is never opened for one, but the server is the judge. */
  | { kind: "kind_not_supported" }
  /** More than the server allows now (the limit was lowered): the offer is loaded again. */
  | { kind: "quantity_invalid" }
  /** 429: «Слишком много попыток» with the minutes, and «Повторить». */
  | { kind: "rate_limited"; minutes: number }
  /** The session is over: the app is already a guest; the screen leaves. */
  | { kind: "session_ended" }
  /**
   * No answer, or the server failed: the order may have been made. «Повторить»
   * sends the same attempt with the same key — the server answers with that
   * order if it exists.
   */
  | { kind: "network" }
  | { kind: "other" };

function detailsOf(error: unknown): Record<string, unknown> {
  if (!isApiError(error)) return {};
  const { details } = error;
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

export function checkoutFailure(error: unknown): CheckoutFailure {
  if (!isApiError(error)) return { kind: "other" };
  const details = detailsOf(error);
  switch (error.code) {
    case "ORDER_PRICE_CHANGED": {
      const expectedPrice = Number(details.expectedPrice);
      const currentPrice = Number(details.currentPrice);
      return Number.isFinite(expectedPrice) && Number.isFinite(currentPrice)
        ? { kind: "price_changed", expectedPrice, currentPrice }
        : { kind: "offer_unavailable" };
    }
    case "ORDER_OFFER_UNAVAILABLE":
      return { kind: "offer_unavailable" };
    case "ORDER_FULFILLMENT_UNAVAILABLE":
      return { kind: "fulfillment_unavailable" };
    case "ORDER_DUPLICATE_ACTIVE":
      return typeof details.existingOrderId === "string"
        ? { kind: "duplicate_active", existingOrderId: details.existingOrderId }
        : { kind: "other" };
    case "REGISTRATION_INCOMPLETE":
      return { kind: "registration_incomplete" };
    case "SUBSCRIPTION_REQUIRED":
      return { kind: "club_access_required" };
    case "ORDER_KIND_NOT_SUPPORTED":
      return { kind: "kind_not_supported" };
    case "VALIDATION_ERROR":
      return { kind: "quantity_invalid" };
    case "RATE_LIMITED": {
      const seconds = Number(details.retryAfterSeconds);
      return {
        kind: "rate_limited",
        minutes: Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60)),
      };
    }
    case "SESSION_ENDED":
    case "AUTH_REQUIRED":
    case "ACCESS_TOKEN_EXPIRED":
      return { kind: "session_ended" };
    case "NETWORK_ERROR":
    case "SERVICE_UNAVAILABLE":
    case "INTERNAL_ERROR":
    case "INVALID_RESPONSE":
      return { kind: "network" };
    default:
      return error.status >= 500 ? { kind: "network" } : { kind: "other" };
  }
}

// ---------------------------------------------------------- the offer

/** The ways to get the item an offer has; the first is the one chosen by default. */
export function fulfillmentOptions(offer: {
  pickup: boolean;
  delivery: boolean;
}): OrderFulfillment[] {
  return [
    ...(offer.pickup ? ["pickup" as const] : []),
    ...(offer.delivery ? ["delivery" as const] : []),
  ];
}

/** The chosen way if the offer still has it, otherwise its first one (`null` — none). */
export function settleFulfillment(
  chosen: OrderFulfillment | null,
  offer: { pickup: boolean; delivery: boolean },
): OrderFulfillment | null {
  const options = fulfillmentOptions(offer);
  return chosen !== null && options.includes(chosen) ? chosen : (options[0] ?? null);
}

/** 1 … the server's limit; anything else (0, a fraction, more than allowed) is brought inside. */
export function settleQuantity(quantity: number, maxQuantity: number): number {
  const max = Math.max(1, Math.floor(maxQuantity));
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(max, Math.max(1, Math.round(quantity)));
}

/**
 * «После готовности заказ держат для вас N суток» (M-ORD-01): whole days
 * when the setting is a number of days, hours otherwise — never rounded
 * into a promise the server does not make.
 */
export function reserveDuration(hours: number): { unit: "days" | "hours"; count: number } {
  return hours > 0 && hours % 24 === 0
    ? { unit: "days", count: hours / 24 }
    : { unit: "hours", count: hours };
}

/**
 * This app places an order from an offer «В наличии» only. The server takes
 * «Под заказ» since TASK-037; the app gets the screens of its term (the
 * date, «Нужен ваш ответ», «Согласиться» / «Отказаться») with TASK-039 and
 * opens the button then.
 */
export function canOrderOffer(offer: { availability: string }): boolean {
  return offer.availability === "in_stock";
}
