import { describe, expect, it } from "vitest";
import { receiptDate, type ReceiptSchedule } from "../offer/receipt-date";
import {
  leadDaysForDate,
  proposedTermProblem,
  supplyOverdue,
  supplyOverdueAt,
  termAnswerBy,
  termOptions,
} from "./order-term";

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

describe("termOptions (TASK-039)", () => {
  // Monday 5 October 2026, 11:00 in Almaty.
  const monday = new Date("2026-10-05T06:00:00Z");

  it("gives one working day per term, nearest first, without the agreed term", () => {
    const options = termOptions(monday, weekdays, 3, 7);
    expect(options).toEqual([
      { leadDays: 1, readyOn: "2026-10-06" },
      { leadDays: 2, readyOn: "2026-10-07" },
      // 3 — the agreed term (Thursday) — left out.
      { leadDays: 4, readyOn: "2026-10-09" },
      // The weekend is no working day.
      { leadDays: 5, readyOn: "2026-10-12" },
      { leadDays: 6, readyOn: "2026-10-13" },
      { leadDays: 7, readyOn: "2026-10-14" },
    ]);
    // Every date is what `receiptDate` gives for its term — the one rule.
    for (const option of options) {
      expect(receiptDate(monday, option.leadDays, weekdays)).toMatchObject({
        ok: true,
        date: option.readyOn,
      });
    }
  });

  it("skips the closed dates of the point", () => {
    const closed: ReceiptSchedule = {
      ...weekdays,
      closedDates: ["2026-10-07"],
    };
    const options = termOptions(monday, closed, 5, 3);
    expect(options.map((option) => option.readyOn)).toEqual([
      "2026-10-06",
      "2026-10-08",
      "2026-10-09",
    ]);
  });

  it("is empty for a point without hours", () => {
    expect(termOptions(monday, { ...weekdays, weeklyHours: null }, 3, 7)).toEqual([]);
  });

  it("finds the term of a chosen date, and nothing for a day off or the agreed date", () => {
    const options = termOptions(monday, weekdays, 3, 7);
    expect(leadDaysForDate(options, "2026-10-12")).toBe(5);
    expect(leadDaysForDate(options, "2026-10-10")).toBeNull();
    expect(leadDaysForDate(options, "2026-10-08")).toBeNull();
    expect(leadDaysForDate(options, "2026-11-30")).toBeNull();
  });
});
