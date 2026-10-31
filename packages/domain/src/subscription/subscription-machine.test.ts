import { describe, expect, it } from "vitest";
import {
  audienceStatuses,
  dueTimeEvent,
  initialSubscriptionState,
  isCurrentSubscription,
  subscriptionEventKinds,
  subscriptionTransition,
  type SubscriptionAudience,
  type SubscriptionEvent,
  type SubscriptionEventKind,
  type SubscriptionState,
  type SubscriptionStatus,
} from "./subscription-machine";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TOLERANCE = 48 * HOUR;
const now = new Date("2026-10-15T06:00:00Z");
const ahead = (ms: number) => new Date(now.getTime() + ms);

/** A subscription in `status` whose moments are all still ahead (provider events). */
function stateIn(status: SubscriptionStatus): SubscriptionState {
  return {
    status,
    periodEnd: ahead(10 * DAY),
    graceUntil: status === "grace" || status === "past_due" ? ahead(12 * DAY) : null,
    unconfirmedSince: status === "expired_unconfirmed" ? ahead(-HOUR) : null,
  };
}

/** The same, with every moment passed long ago — time events are due. */
function lapsed(status: SubscriptionStatus): SubscriptionState {
  return {
    status,
    periodEnd: ahead(-10 * DAY),
    graceUntil: status === "grace" || status === "past_due" ? ahead(-9 * DAY) : null,
    unconfirmedSince: status === "expired_unconfirmed" ? ahead(-9 * DAY) : null,
  };
}

function event(kind: SubscriptionEventKind): SubscriptionEvent {
  return { kind, periodEnd: ahead(40 * DAY), graceUntil: ahead(20 * DAY) };
}

/**
 * Every move of the table, `audience:from:event` → to; every other pair of
 * an event the audience has is `stay`, and the events it hasn't are
 * `not_applicable`.
 */
const MOVES: Record<string, SubscriptionStatus> = {};
function moves(
  audience: SubscriptionAudience,
  from: SubscriptionStatus[],
  kind: string,
  to: SubscriptionStatus,
) {
  for (const status of from) MOVES[`${audience}:${status}:${kind}`] = to;
}
const USER_ALL = [...audienceStatuses.user];
const SUPPLIER_ALL = [...audienceStatuses.supplier];
moves("user", USER_ALL, "started", "active");
moves("user", USER_ALL, "renewed", "active");
moves("user", ["active", "expired_unconfirmed", "grace"], "grace_started", "grace");
moves("user", ["active", "grace", "expired_unconfirmed"], "suspended", "suspended");
moves("user", ["active", "grace", "expired_unconfirmed"], "cancelled", "cancelled");
moves("user", ["cancelled"], "cancel_withdrawn", "active");
for (const kind of ["expired", "refunded", "revoked"]) {
  moves(
    "user",
    USER_ALL.filter((status) => status !== "expired"),
    kind,
    "expired",
  );
}
moves("user", ["active"], "period_lapsed", "expired_unconfirmed");
moves("user", ["cancelled"], "period_lapsed", "expired");
moves("user", ["grace"], "grace_lapsed", "expired_unconfirmed");
moves("user", ["expired_unconfirmed"], "tolerance_lapsed", "expired");
moves("supplier", SUPPLIER_ALL, "started", "active");
moves("supplier", SUPPLIER_ALL, "renewed", "active");
moves("supplier", ["active", "past_due"], "payment_failed", "past_due");
moves("supplier", ["active", "past_due"], "suspended", "suspended");
moves("supplier", ["active"], "cancelled", "cancelled");
moves("supplier", ["cancelled"], "cancel_withdrawn", "active");
moves(
  "supplier",
  SUPPLIER_ALL.filter((status) => status !== "expired"),
  "expired",
  "expired",
);
moves("supplier", ["cancelled"], "period_lapsed", "expired");
moves("supplier", ["past_due"], "grace_lapsed", "suspended");

const NOT_FOR: Record<SubscriptionAudience, string[]> = {
  user: ["payment_failed"],
  supplier: ["grace_started", "refunded", "revoked", "tolerance_lapsed"],
};

const TIME_EVENTS = new Set(["period_lapsed", "grace_lapsed", "tolerance_lapsed"]);

describe("the subscription machine — every status × event", () => {
  for (const audience of ["user", "supplier"] as const) {
    for (const status of audienceStatuses[audience]) {
      for (const kind of subscriptionEventKinds) {
        const key = `${audience}:${status}:${kind}`;
        const expected = NOT_FOR[audience].includes(kind)
          ? "not_applicable"
          : (MOVES[key] ?? "stay");
        it(`${key} → ${expected}`, () => {
          const state = TIME_EVENTS.has(kind) ? lapsed(status) : stateIn(status);
          const result = subscriptionTransition(audience, state, event(kind), now, TOLERANCE);
          if (expected === "not_applicable" || expected === "stay") {
            expect(result.kind).toBe(expected);
          } else {
            expect(result).toMatchObject({ kind: "move", next: { status: expected } });
          }
        });
      }
    }
  }
});

describe("the subscription machine — moments", () => {
  it("a renewal moves the term on and clears the grace and the unconfirmed mark", () => {
    const result = subscriptionTransition(
      "user",
      lapsed("expired_unconfirmed"),
      event("renewed"),
      now,
      TOLERANCE,
    );
    expect(result).toEqual({
      kind: "move",
      next: {
        status: "active",
        periodEnd: ahead(40 * DAY),
        graceUntil: null,
        unconfirmedSince: null,
      },
    });
  });

  it("a renewal that pays no further than we know is no effect and no rollback (duplicate, or early)", () => {
    const state = stateIn("active");
    expect(
      subscriptionTransition(
        "user",
        state,
        { kind: "renewed", periodEnd: state.periodEnd },
        now,
        TOLERANCE,
      ),
    ).toEqual({ kind: "stay" });
    expect(
      subscriptionTransition(
        "user",
        state,
        { kind: "renewed", periodEnd: ahead(DAY) },
        now,
        TOLERANCE,
      ),
    ).toEqual({ kind: "stay" });
    expect(subscriptionTransition("user", state, { kind: "renewed" }, now, TOLERANCE)).toEqual({
      kind: "stay",
    });
  });

  it("a late renewal restores an expired subscription retroactively (9.4.1 rule 7)", () => {
    const result = subscriptionTransition(
      "user",
      lapsed("expired"),
      event("renewed"),
      now,
      TOLERANCE,
    );
    expect(result).toMatchObject({ kind: "move", next: { status: "active" } });
  });

  it("a later grace moves the grace on, an earlier one changes nothing", () => {
    const state = stateIn("grace");
    expect(
      subscriptionTransition(
        "user",
        state,
        { kind: "grace_started", graceUntil: ahead(30 * DAY) },
        now,
        TOLERANCE,
      ),
    ).toMatchObject({ kind: "move", next: { status: "grace", graceUntil: ahead(30 * DAY) } });
    expect(
      subscriptionTransition(
        "user",
        state,
        { kind: "grace_started", graceUntil: ahead(DAY) },
        now,
        TOLERANCE,
      ),
    ).toEqual({ kind: "stay" });
  });

  it("the term passing marks the moment it stopped being confirmed", () => {
    const state = lapsed("active");
    expect(
      subscriptionTransition("user", state, { kind: "period_lapsed" }, now, TOLERANCE),
    ).toEqual({
      kind: "move",
      next: { ...state, status: "expired_unconfirmed", unconfirmedSince: state.periodEnd },
    });
    const grace = lapsed("grace");
    expect(subscriptionTransition("user", grace, { kind: "grace_lapsed" }, now, TOLERANCE)).toEqual(
      {
        kind: "move",
        next: {
          ...grace,
          status: "expired_unconfirmed",
          unconfirmedSince: grace.graceUntil,
          graceUntil: null,
        },
      },
    );
  });

  it("time that hasn't come changes nothing", () => {
    for (const status of audienceStatuses.user) {
      for (const kind of ["period_lapsed", "grace_lapsed", "tolerance_lapsed"] as const) {
        expect(subscriptionTransition("user", stateIn(status), { kind }, now, TOLERANCE).kind).toBe(
          "stay",
        );
      }
    }
  });

  it("the tolerance runs from the moment it stopped being confirmed", () => {
    const since = ahead(-47 * HOUR);
    const state: SubscriptionState = {
      status: "expired_unconfirmed",
      periodEnd: since,
      graceUntil: null,
      unconfirmedSince: since,
    };
    expect(dueTimeEvent("user", state, now, TOLERANCE)).toBeNull();
    expect(dueTimeEvent("user", state, ahead(HOUR), TOLERANCE)).toBe("tolerance_lapsed");
  });

  it("names the due time event, one at a time", () => {
    expect(dueTimeEvent("user", stateIn("active"), now, TOLERANCE)).toBeNull();
    expect(dueTimeEvent("user", lapsed("active"), now, TOLERANCE)).toBe("period_lapsed");
    expect(dueTimeEvent("user", lapsed("grace"), now, TOLERANCE)).toBe("grace_lapsed");
    expect(dueTimeEvent("user", lapsed("expired_unconfirmed"), now, TOLERANCE)).toBe(
      "tolerance_lapsed",
    );
    expect(dueTimeEvent("user", lapsed("expired"), now, TOLERANCE)).toBeNull();
    expect(dueTimeEvent("supplier", lapsed("active"), now, TOLERANCE)).toBeNull();
    expect(dueTimeEvent("supplier", lapsed("past_due"), now, TOLERANCE)).toBe("grace_lapsed");
  });
});

describe("a subscription's beginning and its current statuses", () => {
  it("is created only by a paid term", () => {
    expect(initialSubscriptionState({ kind: "started", periodEnd: ahead(DAY) })).toEqual({
      status: "active",
      periodEnd: ahead(DAY),
      graceUntil: null,
      unconfirmedSince: null,
    });
    expect(initialSubscriptionState({ kind: "renewed", periodEnd: ahead(DAY) })?.status).toBe(
      "active",
    );
    expect(initialSubscriptionState({ kind: "started" })).toBeNull();
    for (const kind of subscriptionEventKinds.filter(
      (kind) => kind !== "started" && kind !== "renewed",
    )) {
      expect(initialSubscriptionState(event(kind))).toBeNull();
    }
  });

  it("counts every status but expired as current", () => {
    expect(audienceStatuses.user.filter(isCurrentSubscription)).toEqual([
      "active",
      "grace",
      "cancelled",
      "expired_unconfirmed",
      "suspended",
    ]);
  });
});

/**
 * A supplier's card subscription day by day (TASK-042; PRODUCT 14.3;
 * ARCHITECTURE 18.5): the first refusal opens the window of the retries,
 * the next refusals of the same term do not stretch it, a payment at any
 * moment — even on a pause — restores the subscription, and the window's end
 * is what pauses it.
 */
describe("a supplier's subscription, refusal by refusal", () => {
  const supplier = (state: SubscriptionState, e: SubscriptionEvent, at = now) =>
    subscriptionTransition("supplier", state, e, at, TOLERANCE);
  const active: SubscriptionState = {
    status: "active",
    periodEnd: ahead(-HOUR),
    graceUntil: null,
    unconfirmedSince: null,
  };
  const window = ahead(3 * DAY);

  it("passes into past due at the first refusal, with the window of three days", () => {
    const moved = supplier(active, { kind: "payment_failed", graceUntil: window });
    expect(moved).toEqual({
      kind: "move",
      next: {
        status: "past_due",
        periodEnd: active.periodEnd,
        graceUntil: window,
        unconfirmedSince: null,
      },
    });
  });

  it("does not stretch the window at the refusals that follow: the same end is no change", () => {
    const pastDue = { ...active, status: "past_due" as const, graceUntil: window };
    expect(supplier(pastDue, { kind: "payment_failed", graceUntil: window })).toEqual({
      kind: "stay",
    });
    // An end earlier than the known one (the term's first refusal, counted again) changes nothing either.
    expect(supplier(pastDue, { kind: "payment_failed", graceUntil: ahead(2 * DAY) })).toEqual({
      kind: "stay",
    });
  });

  it("does not pause before the window ends, and pauses once it has", () => {
    const pastDue = { ...active, status: "past_due" as const, graceUntil: window };
    expect(supplier(pastDue, { kind: "grace_lapsed" }, ahead(3 * DAY - 1))).toEqual({
      kind: "stay",
    });
    expect(dueTimeEvent("supplier", pastDue, ahead(3 * DAY - 1), TOLERANCE)).toBeNull();
    const paused = supplier(pastDue, { kind: "grace_lapsed" }, ahead(3 * DAY));
    expect(paused).toMatchObject({ kind: "move", next: { status: "suspended" } });
    expect(dueTimeEvent("supplier", pastDue, ahead(3 * DAY), TOLERANCE)).toBe("grace_lapsed");
  });

  it("restores the subscription from a payment in any status, on the old date and without a window", () => {
    const next = ahead(30 * DAY);
    for (const status of ["active", "past_due", "suspended", "cancelled", "expired"] as const) {
      const state: SubscriptionState = {
        status,
        periodEnd: ahead(-2 * DAY),
        graceUntil: status === "past_due" ? ahead(DAY) : null,
        unconfirmedSince: null,
      };
      expect(supplier(state, { kind: "renewed", periodEnd: next }), status).toEqual({
        kind: "move",
        next: { status: "active", periodEnd: next, graceUntil: null, unconfirmedSince: null },
      });
    }
  });

  it("takes a payment that pays nothing new as no change: a duplicate, or the same term twice", () => {
    const suspended = { ...active, status: "suspended" as const, periodEnd: ahead(30 * DAY) };
    expect(supplier(suspended, { kind: "renewed", periodEnd: ahead(30 * DAY) })).toEqual({
      kind: "stay",
    });
    expect(supplier(suspended, { kind: "renewed", periodEnd: ahead(20 * DAY) })).toEqual({
      kind: "stay",
    });
  });

  it("ignores a refusal that arrives after the pause or the end, and time alone never ends an active term", () => {
    for (const status of ["suspended", "cancelled", "expired"] as const) {
      const state = { ...active, status };
      expect(supplier(state, { kind: "payment_failed", graceUntil: window }), status).toEqual({
        kind: "stay",
      });
    }
    // A term passed without a charge is the processor's to charge, not time's to end.
    expect(supplier(active, { kind: "period_lapsed" })).toEqual({ kind: "stay" });
    expect(dueTimeEvent("supplier", active, ahead(DAY), TOLERANCE)).toBeNull();
  });
});
