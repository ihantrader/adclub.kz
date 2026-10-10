import { ApiError } from "@adclub/api-client";
import type { OnOrderTerm } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { supplyOverdue, termAnswer, termAnswerProblem } from "./order-answer";

const term: OnOrderTerm = {
  expected: { leadDays: 3, readyOn: "2026-03-20" },
  proposed: {
    leadDays: 6,
    readyOn: "2026-03-25",
    at: "2026-03-17T08:00:00.000Z",
    answerBy: "2026-03-18T08:00:00.000Z",
  },
  confirmed: null,
  overdueSince: null,
};

function conflict(currentStatus: string): ApiError {
  return new ApiError({
    status: 409,
    code: "ORDER_STATE_CONFLICT",
    message: "moved",
    details: { currentStatus, version: 3 },
    retryable: false,
  });
}

describe("termAnswer (M-ORD-03 «Ответ пользователя»)", () => {
  it("says the new date, the old one and the deadline while the answer is due", () => {
    expect(termAnswer({ status: "term_proposed", onOrderTerm: term })).toEqual({
      readyOn: "2026-03-25",
      was: "2026-03-20",
      answerBy: "2026-03-18T08:00:00.000Z",
    });
  });

  it("is gone once the order moved on, whatever the term still says", () => {
    for (const status of [
      "accepted",
      "cancelled_by_user",
      "term_expired",
      "declined_by_supplier",
    ] as const) {
      expect(termAnswer({ status, onOrderTerm: term }), status).toBeNull();
    }
    expect(termAnswer({ status: "term_proposed", onOrderTerm: null })).toBeNull();
  });
});

describe("termAnswerProblem", () => {
  it("tells the passed deadline and the supplier's decline apart (D-072)", () => {
    expect(termAnswerProblem(conflict("term_expired"))).toBe("expired");
    expect(termAnswerProblem(conflict("declined_by_supplier"))).toBe("declined");
    expect(termAnswerProblem(conflict("cancelled_by_admin"))).toBe("changed");
  });

  it("asks to try again when there was no answer", () => {
    expect(
      termAnswerProblem(
        new ApiError({ status: 0, code: "NETWORK_ERROR", message: "offline", retryable: true }),
      ),
    ).toBe("failed");
    expect(termAnswerProblem(new Error("boom"))).toBe("failed");
    expect(
      termAnswerProblem(
        new ApiError({ status: 401, code: "SESSION_ENDED", message: "ended", retryable: false }),
      ),
    ).toBe("session_ended");
  });
});

describe("supplyOverdue", () => {
  it("is said for a confirmed term the server called overdue, and only then", () => {
    const overdue = { ...term, overdueSince: "2026-03-26T19:00:00.000Z" };
    expect(supplyOverdue({ status: "accepted", onOrderTerm: overdue })).toBe(true);
    expect(supplyOverdue({ status: "ready", onOrderTerm: overdue })).toBe(false);
    expect(supplyOverdue({ status: "accepted", onOrderTerm: term })).toBe(false);
    expect(supplyOverdue({ status: "accepted", onOrderTerm: null })).toBe(false);
  });
});
