import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import {
  canOrderOffer,
  checkoutFailure,
  checkoutKind,
  checkoutReserve,
  createAttemptKeys,
  fulfillmentOptions,
  reserveDuration,
  settleFulfillment,
  settleQuantity,
} from "./checkout";

// Plain Node checks of the checkout (M-ORD-01, TASK-030 requirement 1, AC-2, AC-3).

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

const OFFER = "offer-1";

describe("the key of an attempt (idempotencyKey)", () => {
  it("is made once per screen and survives a retry: a lost answer sent again is the same order", () => {
    const keys = createAttemptKeys(counter());
    const attempt = { offerId: OFFER, quantity: 2, fulfillment: "pickup" as const };
    const first = keys.keyFor(attempt);
    expect(keys.keyFor(attempt)).toBe(first);
    expect(keys.keyFor({ ...attempt })).toBe(first);
  });

  it("is another key for another quantity, way to get it or offer — another order", () => {
    const keys = createAttemptKeys(counter());
    const base = { offerId: OFFER, quantity: 2, fulfillment: "pickup" as const };
    const a = keys.keyFor(base);
    const b = keys.keyFor({ ...base, quantity: 3 });
    const c = keys.keyFor({ ...base, fulfillment: "delivery" });
    const d = keys.keyFor({ ...base, offerId: "offer-2" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("goes back to the key already sent when the attempt is the same again (2 → 3 → 2)", () => {
    const keys = createAttemptKeys(counter());
    const two = keys.keyFor({ offerId: OFFER, quantity: 2, fulfillment: "pickup" });
    keys.keyFor({ offerId: OFFER, quantity: 3, fulfillment: "pickup" });
    expect(keys.keyFor({ offerId: OFFER, quantity: 2, fulfillment: "pickup" })).toBe(two);
  });

  it("belongs to one screen: a new checkout makes new keys", () => {
    const make = counter();
    const attempt = { offerId: OFFER, quantity: 1, fulfillment: "pickup" as const };
    expect(createAttemptKeys(make).keyFor(attempt)).not.toBe(
      createAttemptKeys(make).keyFor(attempt),
    );
  });
});

function apiError(status: number, code: string, details?: unknown) {
  return new ApiError({ status, code: code as never, message: code, details, retryable: false });
}

describe("the key of a visit for a service (TASK-039.B)", () => {
  it("is another key for another car or time, and the same again for the same visit", () => {
    const keys = createAttemptKeys(counter());
    const visit = {
      offerId: "offer-1",
      quantity: 1,
      fulfillment: "pickup" as const,
      carId: "car-1",
      desiredAt: "2026-10-12T06:00:00.000Z",
    };
    const first = keys.keyFor(visit);
    expect(keys.keyFor({ ...visit, desiredAt: "2026-10-12T10:00:00.000Z" })).not.toBe(first);
    expect(keys.keyFor({ ...visit, carId: "car-2" })).not.toBe(first);
    expect(keys.keyFor({ ...visit })).toBe(first);
  });

  it("says a refused time at the time and a car gone from the garage at the car", () => {
    const refused = (path: string) =>
      checkoutFailure(apiError(400, "VALIDATION_ERROR", [{ path, message: "no" }]));
    expect(refused("desiredAt")).toEqual({ kind: "time_refused" });
    expect(refused("carId")).toEqual({ kind: "car_invalid" });
    expect(refused("quantity")).toEqual({ kind: "quantity_invalid" });
  });
});

describe("what each answer of POST /orders leads to", () => {
  it("names every case of TASK-030 requirement 1 with its own action", () => {
    expect(
      checkoutFailure(
        apiError(409, "ORDER_PRICE_CHANGED", { expectedPrice: 6500, currentPrice: 7000 }),
      ),
    ).toEqual({
      kind: "price_changed",
      expectedPrice: 6500,
      currentPrice: 7000,
    });
    expect(checkoutFailure(apiError(409, "ORDER_OFFER_UNAVAILABLE"))).toEqual({
      kind: "offer_unavailable",
    });
    expect(checkoutFailure(apiError(409, "ORDER_FULFILLMENT_UNAVAILABLE"))).toEqual({
      kind: "fulfillment_unavailable",
    });
    expect(
      checkoutFailure(
        apiError(409, "ORDER_DUPLICATE_ACTIVE", { existingOrderId: "order-9", number: 1009 }),
      ),
    ).toEqual({ kind: "duplicate_active", existingOrderId: "order-9" });
    expect(checkoutFailure(apiError(403, "REGISTRATION_INCOMPLETE"))).toEqual({
      kind: "registration_incomplete",
    });
    expect(checkoutFailure(apiError(403, "SUBSCRIPTION_REQUIRED"))).toEqual({
      kind: "club_access_required",
    });
    expect(checkoutFailure(apiError(409, "ORDER_KIND_NOT_SUPPORTED"))).toEqual({
      kind: "kind_not_supported",
    });
    expect(checkoutFailure(apiError(400, "VALIDATION_ERROR"))).toEqual({
      kind: "quantity_invalid",
    });
    expect(checkoutFailure(apiError(429, "RATE_LIMITED", { retryAfterSeconds: 125 }))).toEqual({
      kind: "rate_limited",
      minutes: 3,
    });
    expect(checkoutFailure(apiError(401, "SESSION_ENDED"))).toEqual({ kind: "session_ended" });
    expect(checkoutFailure(apiError(401, "AUTH_REQUIRED"))).toEqual({ kind: "session_ended" });
  });

  it("treats no answer and a failing server as «maybe made»: retry with the same key", () => {
    expect(checkoutFailure(apiError(0, "NETWORK_ERROR"))).toEqual({ kind: "network" });
    expect(checkoutFailure(apiError(503, "SERVICE_UNAVAILABLE"))).toEqual({ kind: "network" });
    expect(checkoutFailure(apiError(500, "INTERNAL_ERROR"))).toEqual({ kind: "network" });
    expect(checkoutFailure(apiError(502, "UNKNOWN_ERROR"))).toEqual({ kind: "network" });
  });

  it("never shows a code: an unknown refusal is a plain error, an unreadable detail is not trusted", () => {
    expect(checkoutFailure(apiError(409, "UNKNOWN_ERROR"))).toEqual({ kind: "other" });
    expect(checkoutFailure(new Error("boom"))).toEqual({ kind: "other" });
    expect(checkoutFailure(apiError(409, "ORDER_DUPLICATE_ACTIVE", {}))).toEqual({ kind: "other" });
    // A price change without the prices can't be asked about: the offer is loaded again.
    expect(checkoutFailure(apiError(409, "ORDER_PRICE_CHANGED"))).toEqual({
      kind: "offer_unavailable",
    });
    expect(checkoutFailure(apiError(429, "RATE_LIMITED"))).toEqual({
      kind: "rate_limited",
      minutes: 1,
    });
  });
});

describe("the offer on the checkout", () => {
  it("offers the ways it has, pickup first", () => {
    expect(fulfillmentOptions({ pickup: true, delivery: true })).toEqual(["pickup", "delivery"]);
    expect(fulfillmentOptions({ pickup: false, delivery: true })).toEqual(["delivery"]);
    expect(fulfillmentOptions({ pickup: false, delivery: false })).toEqual([]);
  });

  it("keeps the chosen way while the offer has it, otherwise its first", () => {
    expect(settleFulfillment("delivery", { pickup: true, delivery: true })).toBe("delivery");
    expect(settleFulfillment("delivery", { pickup: true, delivery: false })).toBe("pickup");
    expect(settleFulfillment(null, { pickup: false, delivery: true })).toBe("delivery");
    expect(settleFulfillment("pickup", { pickup: false, delivery: false })).toBeNull();
  });

  it("brings the quantity inside 1 … the server's limit (0, a fraction, too many, not a number)", () => {
    expect(settleQuantity(2, 50)).toBe(2);
    expect(settleQuantity(0, 50)).toBe(1);
    expect(settleQuantity(-3, 50)).toBe(1);
    expect(settleQuantity(2.6, 50)).toBe(3);
    expect(settleQuantity(80, 50)).toBe(50);
    expect(settleQuantity(Number.NaN, 50)).toBe(1);
    // A repeat of 10 after the limit went down to 7.
    expect(settleQuantity(10, 7)).toBe(7);
  });

  it("says the reserve in days when the setting is whole days, in hours otherwise", () => {
    expect(reserveDuration(24)).toEqual({ unit: "days", count: 1 });
    expect(reserveDuration(72)).toEqual({ unit: "days", count: 3 });
    expect(reserveDuration(36)).toEqual({ unit: "hours", count: 36 });
    expect(reserveDuration(1)).toEqual({ unit: "hours", count: 1 });
  });

  it("orders an offer in stock, under order (TASK-039) and a service (TASK-039.B), nothing else", () => {
    expect(canOrderOffer({ availability: "in_stock" })).toBe(true);
    expect(canOrderOffer({ availability: "on_order" })).toBe(true);
    expect(canOrderOffer({ availability: "service" })).toBe(false);
    // A service's offer has the neutral availability of goods (ARCHITECTURE 4.61 I627).
    expect(canOrderOffer({ availability: "in_stock" }, "service")).toBe(true);
    expect(checkoutKind({ availability: "on_order" })).toBe("on_order");
    expect(checkoutKind({ availability: "in_stock" })).toBe("stock");
    expect(checkoutKind({ availability: "in_stock" }, "service")).toBe("service");
    expect(checkoutKind({ availability: "in_stock" }, "part")).toBe("stock");
  });

  it("promises no reserve of a visit", () => {
    expect(checkoutReserve("service", { pickupReserveHours: 24 })).toBeNull();
  });

  it("promises the reserve of the kind: once ready, or once the goods have come", () => {
    const ordering = { pickupReserveHours: 24, onOrderPickupReserveHours: 72 };
    expect(checkoutReserve("stock", ordering)).toEqual({ onOrder: false, unit: "days", count: 1 });
    expect(checkoutReserve("on_order", ordering)).toEqual({
      onOrder: true,
      unit: "days",
      count: 3,
    });
    expect(
      checkoutReserve("on_order", { pickupReserveHours: 24, onOrderPickupReserveHours: 36 }),
    ).toEqual({ onOrder: true, unit: "hours", count: 36 });
    // An older server says nothing of it: nothing is promised.
    expect(checkoutReserve("on_order", { pickupReserveHours: 24 })).toBeNull();
  });
});
