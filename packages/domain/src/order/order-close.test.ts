import { describe, expect, it } from "vitest";
import { lateCloseUntil, orderCloseVerdict, type OrderCloseFacts } from "./order-close";

const EXPIRED = new Date("2026-09-20T10:00:00Z");

function facts(over: Partial<OrderCloseFacts> = {}): OrderCloseFacts {
  return { status: "reserve_expired", finishedAt: EXPIRED, lateCloseUntil: null, ...over };
}

describe("lateCloseUntil", () => {
  it("is the expiry plus the setting", () => {
    expect(lateCloseUntil(EXPIRED, 48).toISOString()).toBe("2026-09-22T10:00:00.000Z");
    expect(lateCloseUntil(EXPIRED, 0).toISOString()).toBe(EXPIRED.toISOString());
  });
});

describe("orderCloseVerdict", () => {
  const now = new Date("2026-09-21T10:00:00Z");

  it("gives out an accepted and a ready order now (D-040)", () => {
    for (const status of ["accepted", "ready"] as const) {
      expect(orderCloseVerdict(facts({ status, finishedAt: null }), now)).toEqual({ kind: "now" });
    }
  });

  it("asks to accept an order first", () => {
    expect(orderCloseVerdict(facts({ status: "created", finishedAt: null }), now)).toEqual({
      kind: "refused",
      reason: "not_accepted",
      at: null,
    });
  });

  it("says an order already given out is closed", () => {
    expect(orderCloseVerdict(facts({ status: "completed" }), now)).toEqual({ kind: "closed" });
  });

  it("never closes a cancelled, a declined or an unanswered order", () => {
    for (const status of [
      "cancelled_by_user",
      "declined_by_supplier",
      "response_expired",
    ] as const) {
      expect(orderCloseVerdict(facts({ status }), now)).toEqual({
        kind: "refused",
        reason: status,
        at: EXPIRED,
      });
    }
  });

  it("closes an expired reserve inside the window, and not at its edge or after", () => {
    const until = lateCloseUntil(EXPIRED, 48);
    expect(orderCloseVerdict(facts({ lateCloseUntil: until }), now)).toEqual({
      kind: "late",
      expiredAt: EXPIRED,
      until,
    });
    // Exactly at the end of the window it is over, and so is a second later.
    for (const at of [until, new Date(until.getTime() + 1000)]) {
      expect(orderCloseVerdict(facts({ lateCloseUntil: until }), at)).toEqual({
        kind: "refused",
        reason: "late_window_passed",
        at: EXPIRED,
      });
    }
    // A zero window closes at once.
    expect(orderCloseVerdict(facts({ lateCloseUntil: EXPIRED }), EXPIRED)).toEqual({
      kind: "refused",
      reason: "late_window_passed",
      at: EXPIRED,
    });
  });

  it("refuses an expired reserve without a window (an order from before the window existed)", () => {
    expect(orderCloseVerdict(facts({ lateCloseUntil: null }), now)).toEqual({
      kind: "refused",
      reason: "late_window_passed",
      at: EXPIRED,
    });
  });
});
