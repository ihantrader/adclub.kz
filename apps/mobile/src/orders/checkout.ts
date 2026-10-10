import { isApiError } from "@adclub/api-client";
import type { OrderFulfillment } from "@adclub/contracts";

/**
 * The rules of the checkout (M-ORD-01, TASK-030) without React Native:
 * the key that makes one attempt one order, what each answer of
 * `POST /orders` leads to, the sum and the ways to get the item.
 */

// ---------------------------------------------------------- the key of an attempt

/**
 * What one order is: another offer, quantity or way to get it is another
 * order; of a service (TASK-039.B) — another car or time asked for.
 */
export interface CheckoutAttempt {
  offerId: string;
  quantity: number;
  fulfillment: OrderFulfillment;
  carId?: string;
  desiredAt?: string;
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
      const id = [
        attempt.offerId,
        attempt.quantity,
        attempt.fulfillment,
        attempt.carId ?? "",
        attempt.desiredAt ?? "",
      ].join("|");
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
  /**
   * TASK-039.B, a service: the time asked for is no longer one (the point
   * closed that day, the hours changed, the minute passed) — said at the
   * time, whose choices are loaded again.
   */
  | { kind: "time_refused" }
  /** The car is not one of the user's garage any more (removed on another device). */
  | { kind: "car_invalid" }
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
    case "VALIDATION_ERROR": {
      // The field the server refused (`details: [{ path, message }]`).
      const paths = Array.isArray(error.details)
        ? (error.details as unknown[]).map((entry) =>
            typeof entry === "object" && entry !== null
              ? String((entry as { path?: unknown }).path ?? "")
              : "",
          )
        : [];
      if (paths.includes("desiredAt")) return { kind: "time_refused" };
      if (paths.includes("carId")) return { kind: "car_invalid" };
      return { kind: "quantity_invalid" };
    }
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
 * The offers this app places an order from: «В наличии», since TASK-039
 * «Под заказ», since TASK-039.B a service («Записаться») — the server takes
 * all three (`POST /orders`). An offer on goods of an availability this
 * version does not know is not ordered here.
 */
export function canOrderOffer(offer: { availability: string }, itemType?: string): boolean {
  if (itemType === "service") return true;
  return offer.availability === "in_stock" || offer.availability === "on_order";
}

/** M-ORD-01 — the checkout of an offer «В наличии», «Под заказ» or of a service. */
export type CheckoutKind = "stock" | "on_order" | "service";

export function checkoutKind(offer: { availability: string }, itemType?: string): CheckoutKind {
  if (itemType === "service") return "service";
  return offer.availability === "on_order" ? "on_order" : "stock";
}

/**
 * The pickup reserve the checkout promises (M-ORD-01): «После готовности
 * заказ держат для вас N суток» of an item in stock (`pickup_reserve_hours`);
 * «После того как товар придёт, его держат для вас N суток» of an item under
 * order — its own, longer setting (`on_order_pickup_reserve_hours`). `null` —
 * nothing to promise: the server did not say it (an older one).
 */
export function checkoutReserve(
  kind: CheckoutKind,
  ordering: { pickupReserveHours: number; onOrderPickupReserveHours?: number | undefined },
): ({ onOrder: boolean } & ReturnType<typeof reserveDuration>) | null {
  if (kind === "stock") {
    return { onOrder: false, ...reserveDuration(ordering.pickupReserveHours) };
  }
  // A visit is not kept for anybody: there is no reserve to promise.
  if (kind === "service") return null;
  return ordering.onOrderPickupReserveHours === undefined
    ? null
    : { onOrder: true, ...reserveDuration(ordering.onOrderPickupReserveHours) };
}
