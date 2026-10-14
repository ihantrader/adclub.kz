import { describe, expect, it } from "vitest";
import {
  lowRatingSignalMove,
  ratingFollowsOrderEvent,
  ratingOrderOutcome,
  ratingPercent,
  roundRating,
  shareOnScale,
  supplierRating,
  tallyRatingOrders,
  type RatingInputs,
  type RatingOrderFacts,
  type RatingRules,
} from "./supplier-rating";

const RULES: RatingRules = {
  minReviews: 5,
  minOrders: 5,
  weights: { reviews: 0.6, response_rate: 0.2, deadline_rate: 0.2 },
};

/** An ordinary order of an item in stock answered, taken on and given out in time. */
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

function inputs(patch: Partial<RatingInputs> = {}): RatingInputs {
  return {
    reviewsCount: 0,
    reviewsScoreSum: 0,
    answered: 0,
    answerRequired: 0,
    kept: 0,
    judged: 0,
    ...patch,
  };
}

describe("ratingOrderOutcome — what one order says about its supplier", () => {
  const cases: [string, Partial<RatingOrderFacts>, string | null, string | null][] = [
    // stock
    ["stock given out in time", {}, "answered", "kept"],
    [
      "stock: the supplier was silent",
      { status: "response_expired", answered: false, expiredUnanswered: true, takenOn: false },
      "silent",
      null,
    ],
    [
      "stock: silent, then closed by an administrator",
      {
        status: "completed",
        answered: false,
        expiredUnanswered: true,
        takenOn: false,
        closedByAdmin: true,
      },
      "silent",
      null,
    ],
    [
      "stock: declined at once — an answer",
      { status: "declined_by_supplier", takenOn: false },
      "answered",
      null,
    ],
    [
      "stock: declined after accepting — the supplier failed",
      { status: "declined_by_supplier" },
      "answered",
      "missed",
    ],
    [
      "stock: the reserve expired — the user didn't come",
      { status: "reserve_expired" },
      "answered",
      null,
    ],
    [
      "stock: closed late after the reserve — no better, no worse",
      { status: "completed", closedLate: true },
      "answered",
      null,
    ],
    [
      "stock: closed by an administrator without a code",
      { status: "completed", closedByAdmin: true },
      "answered",
      null,
    ],
    [
      "stock: cancelled by the user while new",
      { status: "cancelled_by_user", answered: false, takenOn: false },
      null,
      null,
    ],
    [
      "stock: cancelled by the user after accepting",
      { status: "cancelled_by_user" },
      "answered",
      null,
    ],
    [
      "stock: cancelled by the administrator while new",
      { status: "cancelled_by_admin", answered: false, takenOn: false },
      null,
      null,
    ],
    ["stock: still waiting to be given out", { status: "ready" }, "answered", null],
    [
      "stock: still waiting for the answer",
      { status: "created", answered: false, takenOn: false },
      null,
      null,
    ],
    // on order
    ["on order: given out, no overdue", { kind: "on_order" }, "answered", "kept"],
    [
      "on order: the supply overdue, still on its way",
      { kind: "on_order", status: "accepted", supplyOverdue: true },
      "answered",
      "missed",
    ],
    [
      "on order: overdue, given out later all the same",
      { kind: "on_order", supplyOverdue: true },
      "answered",
      "missed",
    ],
    [
      "on order: another term proposed, the user said no",
      { kind: "on_order", status: "cancelled_by_user", takenOn: false },
      "answered",
      null,
    ],
    [
      "on order: another term proposed, the user was silent",
      { kind: "on_order", status: "term_expired", takenOn: false },
      "answered",
      null,
    ],
    [
      "on order: declined while the user thought the term over",
      { kind: "on_order", status: "declined_by_supplier", takenOn: false },
      "answered",
      null,
    ],
    [
      "on order: the user didn't come for the goods",
      { kind: "on_order", status: "reserve_expired" },
      "answered",
      null,
    ],
    // service
    ["service: done by the code", { kind: "service" }, "answered", "kept"],
    [
      "service: the visit left unresolved by the supplier",
      { kind: "service", status: "visit_unresolved" },
      "answered",
      "missed",
    ],
    [
      "service: unresolved, then closed late by the code",
      { kind: "service", status: "completed", closedLate: true },
      "answered",
      null,
    ],
    ["service: the user did not come", { kind: "service", status: "no_show" }, "answered", null],
    [
      "service: declined after confirming the time",
      { kind: "service", status: "declined_by_supplier" },
      "answered",
      "missed",
    ],
    [
      "service: silent",
      {
        kind: "service",
        status: "response_expired",
        answered: false,
        expiredUnanswered: true,
        takenOn: false,
      },
      "silent",
      null,
    ],
    // test orders
    ["a test order judges nobody", { isTest: true }, null, null],
    [
      "a test order the supplier was silent on",
      { isTest: true, status: "response_expired", answered: false, expiredUnanswered: true },
      null,
      null,
    ],
  ];

  it.each(cases)("%s", (_name, patch, answer, term) => {
    expect(ratingOrderOutcome(order(patch))).toEqual({ answer, term });
  });
});

describe("tallyRatingOrders", () => {
  it("counts answers and terms of the three kinds, test orders out", () => {
    const tally = tallyRatingOrders([
      order(),
      order({ kind: "on_order" }),
      order({ kind: "service" }),
      order({
        status: "response_expired",
        answered: false,
        expiredUnanswered: true,
        takenOn: false,
      }),
      order({ status: "declined_by_supplier" }),
      order({ status: "completed", closedLate: true }),
      order({ status: "reserve_expired" }),
      order({ isTest: true }),
      order({ isTest: true, status: "response_expired", answered: false, expiredUnanswered: true }),
    ]);
    expect(tally).toEqual({ answered: 6, answerRequired: 7, kept: 3, judged: 4 });
  });
});

describe("supplierRating — the examples", () => {
  it("no reviews and no orders — a new supplier, no shares", () => {
    expect(supplierRating(inputs(), RULES)).toEqual({
      score: null,
      isNew: true,
      reviewsAverage: null,
      responseRate: null,
      onTimeRate: null,
    });
  });

  it("four 5★ and 100 % of answers are still a new supplier — the shares are kept", () => {
    const rating = supplierRating(
      inputs({
        reviewsCount: 4,
        reviewsScoreSum: 20,
        answered: 10,
        answerRequired: 10,
        kept: 8,
        judged: 8,
      }),
      RULES,
    );
    expect(rating).toEqual({
      score: null,
      isNew: true,
      reviewsAverage: 5,
      responseRate: 1,
      onTimeRate: 1,
    });
  });

  it("exactly at the threshold — the rating is shown", () => {
    const rating = supplierRating(
      inputs({
        reviewsCount: 5,
        reviewsScoreSum: 25,
        answered: 10,
        answerRequired: 10,
        kept: 8,
        judged: 8,
      }),
      RULES,
    );
    expect(rating.score).toBe(5);
    expect(rating.isNew).toBe(false);
  });

  it("the example of the task: 5 reviews, 8 of 10 answered, all in time", () => {
    // scores 5, 5, 4, 4, 3 → 4.2; answers 80 % → 4.2 ★; terms 100 % → 5 ★.
    const rating = supplierRating(
      inputs({
        reviewsCount: 5,
        reviewsScoreSum: 21,
        answered: 8,
        answerRequired: 10,
        kept: 8,
        judged: 8,
      }),
      RULES,
    );
    // 0.6 × 4.2 + 0.2 × 4.2 + 0.2 × 5 = 4.36 → 4.4
    expect(rating.score).toBe(4.4);
    expect(rating.responseRate).toBe(0.8);
    expect(rating.onTimeRate).toBe(1);
    expect(ratingPercent(rating.responseRate!)).toBe(80);
  });

  it("everybody silent — the answers pull the rating down to the bottom of their weight", () => {
    const rating = supplierRating(
      inputs({ reviewsCount: 5, reviewsScoreSum: 25, answered: 0, answerRequired: 10 }),
      RULES,
    );
    // The terms: no order reached a verdict — their weight goes to the others.
    // (0.6 × 5 + 0.2 × 1) / 0.8 = 4
    expect(rating.score).toBe(4);
    expect(rating.responseRate).toBe(0);
    expect(rating.onTimeRate).toBeNull();
  });

  it("everything in time and every score 5 — 5.0", () => {
    const rating = supplierRating(
      inputs({
        reviewsCount: 7,
        reviewsScoreSum: 35,
        answered: 20,
        answerRequired: 20,
        kept: 15,
        judged: 15,
      }),
      RULES,
    );
    expect(rating.score).toBe(5);
  });

  it("too few orders for a share — «Мало заявок», the scores alone", () => {
    const rating = supplierRating(
      inputs({
        reviewsCount: 5,
        reviewsScoreSum: 18,
        answered: 2,
        answerRequired: 4,
        kept: 1,
        judged: 4,
      }),
      RULES,
    );
    expect(rating.responseRate).toBeNull();
    expect(rating.onTimeRate).toBeNull();
    expect(rating.score).toBe(3.6);
  });

  it("weights are data: the reviews alone, or the shares alone", () => {
    const data = inputs({
      reviewsCount: 5,
      reviewsScoreSum: 15,
      answered: 10,
      answerRequired: 10,
      kept: 10,
      judged: 10,
    });
    expect(
      supplierRating(data, {
        ...RULES,
        weights: { reviews: 1, response_rate: 0, deadline_rate: 0 },
      }).score,
    ).toBe(3);
    expect(
      supplierRating(data, {
        ...RULES,
        weights: { reviews: 0, response_rate: 0.5, deadline_rate: 0.5 },
      }).score,
    ).toBe(5);
  });

  it("stays between 1 and 5 and rounds half up to one decimal", () => {
    expect(roundRating(4.25)).toBe(4.3);
    expect(roundRating(4.249)).toBe(4.2);
    expect(shareOnScale(0)).toBe(1);
    expect(shareOnScale(1)).toBe(5);
    const worst = supplierRating(
      inputs({
        reviewsCount: 5,
        reviewsScoreSum: 5,
        answered: 0,
        answerRequired: 10,
        kept: 0,
        judged: 10,
      }),
      RULES,
    );
    expect(worst.score).toBe(1);
  });

  it("a whole percent is rounded down", () => {
    expect(ratingPercent(0.996)).toBe(99);
    expect(ratingPercent(1)).toBe(100);
    expect(ratingPercent(0.8)).toBe(80);
    expect(ratingPercent(0.29)).toBe(29);
  });
});

describe("ratingFollowsOrderEvent", () => {
  it("answers, verdicts and an overdue supply — yes; cancels, reserves, notes — no", () => {
    for (const action of [
      "accept",
      "decline",
      "expire_no_response",
      "close",
      "close_late",
      "supply_overdue",
    ]) {
      expect(ratingFollowsOrderEvent(action)).toBe(true);
    }
    for (const action of [
      "create",
      "cancel",
      "expire_reserve",
      "mark_no_show",
      "reserve_expiring",
    ]) {
      expect(ratingFollowsOrderEvent(action)).toBe(false);
    }
  });
});

describe("lowRatingSignalMove", () => {
  const base = { hadPrevious: true, threshold: 3.5, open: false, lastClosedByAdmin: false };

  it("a fall below the threshold opens a signal", () => {
    expect(lowRatingSignalMove({ ...base, previousScore: 4, score: 3.2 })).toBe("raise");
  });

  it("the first calculation already low opens one", () => {
    expect(
      lowRatingSignalMove({ ...base, hadPrevious: false, previousScore: null, score: 3 }),
    ).toBe("raise");
  });

  it("a new supplier becoming rated low opens one", () => {
    expect(lowRatingSignalMove({ ...base, previousScore: null, score: 3 })).toBe("raise");
  });

  it("still low with the signal open — refresh", () => {
    expect(lowRatingSignalMove({ ...base, open: true, previousScore: 3.2, score: 3.1 })).toBe(
      "refresh",
    );
  });

  it("closed by an administrator while still low — not again until a new fall", () => {
    expect(
      lowRatingSignalMove({ ...base, lastClosedByAdmin: true, previousScore: 3.2, score: 3.1 }),
    ).toBeNull();
  });

  it("already below a threshold just raised, nobody closed a signal — opens one", () => {
    expect(lowRatingSignalMove({ ...base, previousScore: 4, score: 4, threshold: 4.35 })).toBe(
      "raise",
    );
  });

  it("the last signal closed by itself (risen), low again — opens one", () => {
    expect(lowRatingSignalMove({ ...base, previousScore: 3.6, score: 3.4 })).toBe("raise");
  });

  it("risen above the threshold — the open signal closes by itself", () => {
    expect(lowRatingSignalMove({ ...base, open: true, previousScore: 3.2, score: 3.5 })).toBe(
      "close",
    );
  });

  it("back to «new» — the open signal closes", () => {
    expect(lowRatingSignalMove({ ...base, open: true, previousScore: 3.2, score: null })).toBe(
      "close",
    );
  });

  it("not low, nothing open — nothing", () => {
    expect(lowRatingSignalMove({ ...base, previousScore: 4, score: 4.5 })).toBeNull();
  });
});
