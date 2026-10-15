import { describe, expect, it } from "vitest";
import { announcedPlan, planInEffect, type PlanRecord } from "./plans";
import { purchaseLinkVerdict } from "./purchase-link";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-15T06:00:00Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

interface Plan extends PlanRecord {
  price: number;
}

function plan(price: number, fromDays: number, extra: Partial<Plan> = {}): Plan {
  return {
    audience: "user",
    price,
    validFrom: at(fromDays),
    validTo: null,
    announceBeforeDays: 7,
    ...extra,
  };
}

describe("the plan in effect on a date", () => {
  const plans = [plan(490, -30), plan(690, 1), plan(1000, -60, { audience: "supplier" })];

  it("is the record that started last among those holding the date", () => {
    expect(planInEffect(plans, "user", now)?.price).toBe(490);
    expect(planInEffect(plans, "user", at(1))?.price).toBe(690);
    expect(planInEffect(plans, "user", at(400))?.price).toBe(690);
    expect(planInEffect(plans, "supplier", now)?.price).toBe(1000);
  });

  it("has none before the first record and after an end with no successor", () => {
    expect(planInEffect(plans, "user", at(-31))).toBeNull();
    const ended = [plan(490, -30, { validTo: at(-1) })];
    expect(planInEffect(ended, "user", now)).toBeNull();
    expect(planInEffect(ended, "user", at(-2))?.price).toBe(490);
  });
});

describe("the announced change", () => {
  it("a price from tomorrow announced 7 days before — announced today, in effect tomorrow", () => {
    const plans = [plan(490, -30), plan(690, 1)];
    expect(announcedPlan(plans, "user", now)?.price).toBe(690);
    expect(planInEffect(plans, "user", at(1))?.price).toBe(690);
    expect(announcedPlan(plans, "user", at(1))).toBeNull();
  });

  it("is not announced before its window opens, and is announced on its first day", () => {
    const plans = [plan(490, -30), plan(690, 10)];
    expect(announcedPlan(plans, "user", now)).toBeNull();
    expect(announcedPlan(plans, "user", at(3))?.price).toBe(690);
    expect(announcedPlan(plans, "user", at(2.99))).toBeNull();
  });

  it("is the nearest of several, of its audience only", () => {
    const plans = [
      plan(490, -30),
      plan(790, 5),
      plan(690, 3),
      plan(2000, 1, { audience: "supplier" }),
    ];
    expect(announcedPlan(plans, "user", now)?.price).toBe(690);
    expect(announcedPlan(plans, "supplier", now)?.price).toBe(2000);
  });
});

describe("whose a purchase is", () => {
  it("stays with the account that first brought it", () => {
    expect(purchaseLinkVerdict({ purchaseOwner: "a", claimant: "a", otherCurrent: null })).toEqual({
      kind: "same_account",
    });
    expect(purchaseLinkVerdict({ purchaseOwner: "a", claimant: "b", otherCurrent: null })).toEqual({
      kind: "linked_to_another_account",
    });
  });

  it("is a new subscription of an account without one; another one giving access refuses it", () => {
    expect(purchaseLinkVerdict({ purchaseOwner: null, claimant: "a", otherCurrent: null })).toEqual(
      {
        kind: "link_new",
        replaces: false,
      },
    );
    expect(
      purchaseLinkVerdict({
        purchaseOwner: null,
        claimant: "a",
        otherCurrent: { grantsAccess: true },
      }),
    ).toEqual({ kind: "already_active" });
    expect(
      purchaseLinkVerdict({
        purchaseOwner: null,
        claimant: "a",
        otherCurrent: { grantsAccess: false },
      }),
    ).toEqual({ kind: "link_new", replaces: true });
  });
});
