import { describe, expect, it } from "vitest";
import {
  ratingOrderOutcome,
  ratingPercent,
  tallyRatingOrders,
  type RatingOrderFacts,
} from "./supplier-rating";
import { shiftCalendarDay, statsPeriodRange, supplierPeriodStats } from "./supplier-stats";

function order(patch: Partial<RatingOrderFacts> = {}): RatingOrderFacts {
  return {
    isTest: false,
    kind: "stock",
    status: "completed",
    answered: true,
    expiredUnanswered: false,
    takenOn: true,
    closedLate: false,
    closedByAdmin: false,
    supplyOverdue: false,
    ...patch,
  };
}

/** Orders of all three kinds, each with a test twin that must count nowhere. */
const TABLE: RatingOrderFacts[] = [
  // stock
  order(),
  order({ status: "completed", closedLate: true }),
  order({ status: "completed", closedByAdmin: true }),
  order({ status: "response_expired", answered: false, expiredUnanswered: true, takenOn: false }),
  order({ status: "cancelled_by_user", answered: false, takenOn: false }),
  order({ status: "cancelled_by_user" }),
  order({ status: "declined_by_supplier", takenOn: false }),
  order({ status: "declined_by_supplier" }),
  order({ status: "reserve_expired" }),
  order({ status: "accepted" }),
  order({ status: "created", answered: false, takenOn: false }),
  // under order
  order({ kind: "on_order" }),
  order({ kind: "on_order", status: "ready", supplyOverdue: true }),
  order({ kind: "on_order", status: "term_expired", takenOn: false }),
  order({
    kind: "on_order",
    status: "response_expired",
    answered: false,
    expiredUnanswered: true,
    takenOn: false,
  }),
  // services
  order({ kind: "service" }),
  order({ kind: "service", status: "no_show" }),
  order({ kind: "service", status: "visit_unresolved" }),
  order({ kind: "service", status: "cancelled_by_admin", answered: false, takenOn: false }),
  order({ kind: "service", status: "declined_by_supplier", takenOn: false }),
];

const WITH_TESTS = [...TABLE, ...TABLE.map((entry) => ({ ...entry, isTest: true }))];

describe("supplierPeriodStats — S-STAT-01", () => {
  it("counts the outcomes of the period, never a test order", () => {
    const stats = supplierPeriodStats(WITH_TESTS, 5);
    expect(stats.orders).toEqual({
      total: TABLE.length,
      completed: 5,
      completedServices: 1,
      cancelledByUser: 2,
      declinedBySupplier: 3,
      expiredNoResponse: 2,
    });
  });

  it("takes the shares from ratingOrderOutcome, the rating's own table", () => {
    const stats = supplierPeriodStats(WITH_TESTS, 5);
    let answered = 0;
    let answerRequired = 0;
    let kept = 0;
    let judged = 0;
    for (const entry of TABLE) {
      const { answer, term } = ratingOrderOutcome(entry);
      if (answer !== null) answerRequired += 1;
      if (answer === "answered") answered += 1;
      if (term !== null) judged += 1;
      if (term === "kept") kept += 1;
    }
    expect(stats.shares).toMatchObject({ answered, answerRequired, kept, judged, minOrders: 5 });
    expect(stats.shares).toMatchObject(tallyRatingOrders(WITH_TESTS));
    expect(stats.shares.responseRate).toBeCloseTo(answered / answerRequired, 10);
    expect(stats.shares.responsePercent).toBe(ratingPercent(answered / answerRequired));
    expect(stats.shares.onTimeRate).toBeCloseTo(kept / judged, 10);
    expect(stats.shares.onTimePercent).toBe(ratingPercent(kept / judged));
  });

  it("leaves a share out with too few orders behind it («Мало заявок для оценки»)", () => {
    const few = supplierPeriodStats([order(), order(), order({ isTest: true })], 3);
    expect(few.shares.answerRequired).toBe(2);
    expect(few.shares.responseRate).toBeNull();
    expect(few.shares.responsePercent).toBeNull();
    expect(few.shares.onTimeRate).toBeNull();
    const enough = supplierPeriodStats([order(), order(), order()], 3);
    expect(enough.shares.responsePercent).toBe(100);
    expect(enough.shares.onTimePercent).toBe(100);
  });

  it("is empty for a period without orders", () => {
    const stats = supplierPeriodStats([order({ isTest: true })], 5);
    expect(stats.orders.total).toBe(0);
    expect(stats.shares.responseRate).toBeNull();
  });
});

describe("statsPeriodRange — days of Almaty, today included", () => {
  it("counts calendar days back from today", () => {
    expect(statsPeriodRange("2026-11-16", 7)).toEqual({ from: "2026-11-10", to: "2026-11-16" });
    expect(statsPeriodRange("2026-03-01", 30)).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(statsPeriodRange("2026-11-16", 1)).toEqual({ from: "2026-11-16", to: "2026-11-16" });
    expect(shiftCalendarDay("2024-03-01", -1)).toBe("2024-02-29");
  });
});
