import { describe, expect, it } from "vitest";
import {
  combineClubAccess,
  subscriptionAccess,
  subscriptionAccessUntil,
} from "./subscription-access";
import {
  subscriptionTransition,
  type SubscriptionState,
  type SubscriptionStatus,
} from "./subscription-machine";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TOLERANCE = 48 * HOUR;
const now = new Date("2026-10-15T06:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);

function state(
  status: SubscriptionStatus,
  times: Partial<SubscriptionState> = {},
): SubscriptionState {
  return { status, periodEnd: at(10 * DAY), graceUntil: null, unconfirmedSince: null, ...times };
}

describe("whether a status gives club access — the table", () => {
  it.each([
    ["active, term ahead", state("active"), true, at(10 * DAY + TOLERANCE)],
    [
      "active, term passed an hour ago (sweeper not yet)",
      state("active", { periodEnd: at(-HOUR) }),
      true,
      at(-HOUR + TOLERANCE),
    ],
    [
      "active, term passed beyond the tolerance",
      state("active", { periodEnd: at(-49 * HOUR) }),
      false,
      null,
    ],
    [
      "grace",
      state("grace", { periodEnd: at(-DAY), graceUntil: at(5 * DAY) }),
      true,
      at(5 * DAY + TOLERANCE),
    ],
    [
      "grace with no end given",
      state("grace", { periodEnd: at(-DAY) }),
      true,
      at(-DAY + TOLERANCE),
    ],
    [
      "cancelled before the end of the paid term",
      state("cancelled", { periodEnd: at(3 * DAY) }),
      true,
      at(3 * DAY),
    ],
    ["cancelled after it", state("cancelled", { periodEnd: at(-HOUR) }), false, null],
    [
      "unconfirmed within the tolerance",
      state("expired_unconfirmed", { periodEnd: at(-HOUR), unconfirmedSince: at(-HOUR) }),
      true,
      at(-HOUR + TOLERANCE),
    ],
    [
      "unconfirmed past the tolerance",
      state("expired_unconfirmed", { periodEnd: at(-49 * HOUR), unconfirmedSince: at(-49 * HOUR) }),
      false,
      null,
    ],
    ["suspended", state("suspended"), false, null],
    ["expired", state("expired"), false, null],
    ["past_due (a supplier's)", state("past_due", { graceUntil: at(DAY) }), false, null],
  ])("%s", (_name, subscription, granted, until) => {
    expect(subscriptionAccess(subscription, now, TOLERANCE)).toEqual({ granted, until });
  });

  it("gives the same answer before the sweeper moves a status and after (no gap, no extra hour)", () => {
    for (const offset of [-HOUR, -47 * HOUR, -48 * HOUR, -49 * HOUR]) {
      const before = state("active", { periodEnd: at(offset) });
      const moved = subscriptionTransition(
        "user",
        before,
        { kind: "period_lapsed" },
        now,
        TOLERANCE,
      );
      expect(moved.kind).toBe("move");
      if (moved.kind !== "move") continue;
      expect(subscriptionAccess(moved.next, now, TOLERANCE)).toEqual(
        subscriptionAccess(before, now, TOLERANCE),
      );
      expect(subscriptionAccessUntil(moved.next, TOLERANCE)).toEqual(
        subscriptionAccessUntil(before, TOLERANCE),
      );
    }
  });
});

describe("club access from its two sources", () => {
  const manual = (ms: number) => ({ source: "manual" as const, until: at(ms) });
  const paid = (ms: number) => ({ source: "subscription" as const, until: at(ms) });

  it("is on if either gives it, until the farther end, named by whose end it is", () => {
    // A grant until 31.12 and a subscription until 15.11: until 31.12, by hand.
    expect(combineClubAccess([manual(77 * DAY), paid(31 * DAY)], now)).toEqual(manual(77 * DAY));
    expect(combineClubAccess([manual(5 * DAY), paid(31 * DAY)], now)).toEqual(paid(31 * DAY));
    expect(combineClubAccess([null, paid(DAY)], now)).toEqual(paid(DAY));
    expect(combineClubAccess([manual(DAY), null], now)).toEqual(manual(DAY));
  });

  it("names the subscription on a tie", () => {
    expect(combineClubAccess([manual(DAY), paid(DAY)], now)).toEqual(paid(DAY));
    expect(combineClubAccess([paid(DAY), manual(DAY)], now)).toEqual(paid(DAY));
  });

  it("ignores an end that has passed", () => {
    expect(combineClubAccess([manual(-HOUR), paid(0)], now)).toBeNull();
    expect(combineClubAccess([null, null], now)).toBeNull();
    expect(combineClubAccess([manual(-HOUR), paid(HOUR)], now)).toEqual(paid(HOUR));
  });
});
