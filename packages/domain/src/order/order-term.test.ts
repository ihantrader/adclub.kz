import { describe, expect, it } from "vitest";
import { receiptDate, type ReceiptSchedule } from "../offer/receipt-date";
import { proposedTermProblem, supplyOverdue, supplyOverdueAt, termAnswerBy } from "./order-term";

const ALMATY = "Asia/Almaty";

/** Monday to Friday 09:00–18:00; Saturday and Sunday off. */
const weekdays: ReceiptSchedule = {
  timeZone: ALMATY,
  weeklyHours: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    intervals: day <= 5 ? [{ from: "09:00", to: "18:00" }] : [],
  })),
  closedDates: [],
};

describe("proposedTermProblem", () => {
  it("takes another whole number of working days within the bound", () => {
    expect(proposedTermProblem(5, 3, 60)).toBeNull();
    expect(proposedTermProblem(1, 3, 60)).toBeNull();
    expect(proposedTermProblem(60, 3, 60)).toBeNull();
  });

  it("refuses the term already agreed (that one is «Подтвердить срок»)", () => {
    expect(proposedTermProblem(3, 3, 60)).toBe("same_term");
  });

  it("refuses 0 days, a fraction and more than the bound", () => {
    expect(proposedTermProblem(0, 3, 60)).toBe("out_of_range");
    expect(proposedTermProblem(-1, 3, 60)).toBe("out_of_range");
    expect(proposedTermProblem(2.5, 3, 60)).toBe("out_of_range");
    expect(proposedTermProblem(61, 3, 60)).toBe("out_of_range");
  });
});

describe("termAnswerBy", () => {
  it("is the proposal plus the hours of the setting", () => {
    const at = new Date("2026-10-05T06:00:00Z");
    expect(termAnswerBy(at, 24).toISOString()).toBe("2026-10-06T06:00:00.000Z");
  });
});

describe("the supply of an order under order", () => {
  it("is promised on a working day of the point: a term that ends on a weekend moves to Monday", () => {
    // Thursday 2026-10-08, 12:00 in Almaty; 2 working days → Monday 12.10.
    const confirmed = new Date("2026-10-08T07:00:00Z");
    expect(receiptDate(confirmed, 2, weekdays)).toEqual({
      ok: true,
      date: "2026-10-12",
      confirmedOn: "2026-10-08",
    });
  });

  it("is overdue from the start of the next day in the point's time zone", () => {
    const at = supplyOverdueAt("2026-10-12", ALMATY);
    // Almaty is UTC+5: midnight of 13.10 there is 19:00 UTC on 12.10.
    expect(at.toISOString()).toBe("2026-10-12T19:00:00.000Z");
    expect(supplyOverdue("2026-10-12", ALMATY, new Date(at.getTime() - 1))).toBe(false);
    expect(supplyOverdue("2026-10-12", ALMATY, at)).toBe(true);
  });
});
