import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  bankRetriesLeft,
  BILLING_TIME_ZONE,
  firstPeriod,
  nextDailyRun,
  renewalPeriod,
  retryWindowEnd,
} from "./billing-cycle";

const almaty = (iso: string) => new Date(`${iso}+05:00`);

describe("calendar months", () => {
  it("keeps the same day number", () => {
    expect(addCalendarMonths("2026-10-15", 1, 15)).toBe("2026-11-15");
    expect(addCalendarMonths("2026-12-15", 1, 15)).toBe("2027-01-15");
  });

  it("takes the last day of a shorter month and returns to the anchor day after it", () => {
    // 31 January → 28 February (2027) → 31 March: the number does not drift.
    expect(addCalendarMonths("2027-01-31", 1, 31)).toBe("2027-02-28");
    expect(addCalendarMonths("2027-02-28", 1, 31)).toBe("2027-03-31");
    expect(addCalendarMonths("2027-03-31", 1, 31)).toBe("2027-04-30");
    // A leap year.
    expect(addCalendarMonths("2028-01-31", 1, 31)).toBe("2028-02-29");
    expect(addCalendarMonths("2028-01-30", 1, 30)).toBe("2028-02-29");
    expect(addCalendarMonths("2027-01-29", 1, 29)).toBe("2027-02-28");
  });

  it("counts several months at once", () => {
    expect(addCalendarMonths("2026-11-30", 3, 30)).toBe("2027-02-28");
    expect(addCalendarMonths("2026-01-31", 12, 31)).toBe("2027-01-31");
  });
});

describe("the first period", () => {
  it("ends at the midnight of the same day next month in Almaty", () => {
    const period = firstPeriod(almaty("2026-10-05T14:35:00"));
    expect(period.anchorDay).toBe(5);
    expect(period.end.toISOString()).toBe(almaty("2026-11-05T00:00:00").toISOString());
  });

  it("goes by the day in Almaty, not in UTC", () => {
    // 02:00 on 1 December in Almaty is still 30 November in UTC.
    const period = firstPeriod(almaty("2026-12-01T02:00:00"));
    expect(period.anchorDay).toBe(1);
    expect(period.end.toISOString()).toBe(almaty("2027-01-01T00:00:00").toISOString());
  });

  it("starts on 31 January and ends on the 28th (29th in a leap year)", () => {
    expect(firstPeriod(almaty("2027-01-31T12:00:00")).end.toISOString()).toBe(
      almaty("2027-02-28T00:00:00").toISOString(),
    );
    expect(firstPeriod(almaty("2028-01-31T12:00:00")).end.toISOString()).toBe(
      almaty("2028-02-29T00:00:00").toISOString(),
    );
  });
});

describe("a renewal", () => {
  it("continues the old term, not the day of payment", () => {
    const previousEnd = almaty("2026-11-05T00:00:00");
    // Paid two days late: the term still ends on the fifth of next month.
    const period = renewalPeriod(previousEnd, 5, almaty("2026-11-07T10:05:00"));
    expect(period.end.toISOString()).toBe(almaty("2026-12-05T00:00:00").toISOString());
    expect(period.anchorDay).toBe(5);
  });

  it("keeps the anchor day through a short month", () => {
    const afterFebruary = renewalPeriod(
      almaty("2027-02-28T00:00:00"),
      31,
      almaty("2027-02-28T10:00:00"),
    );
    expect(afterFebruary.end.toISOString()).toBe(almaty("2027-03-31T00:00:00").toISOString());
    expect(afterFebruary.anchorDay).toBe(31);
  });

  it("starts afresh when the term was overdue for more than a month", () => {
    // The old term ended on 5 October; paid on 20 November: a continued term
    // would end on 5 November — in the past, and charge again tomorrow.
    const period = renewalPeriod(almaty("2026-10-05T00:00:00"), 5, almaty("2026-11-20T10:00:00"));
    expect(period.anchorDay).toBe(20);
    expect(period.end.toISOString()).toBe(almaty("2026-12-20T00:00:00").toISOString());
  });

  it("starts afresh exactly when the continued term would end now", () => {
    const period = renewalPeriod(almaty("2026-10-05T00:00:00"), 5, almaty("2026-11-05T00:00:00"));
    expect(period.anchorDay).toBe(5);
    expect(period.end.toISOString()).toBe(almaty("2026-12-05T00:00:00").toISOString());
  });
});

describe("the daily run", () => {
  it("is today at the hour when it has not come yet", () => {
    expect(nextDailyRun(almaty("2026-10-05T08:00:00"), 10).toISOString()).toBe(
      almaty("2026-10-05T10:00:00").toISOString(),
    );
  });

  it("is tomorrow once the hour has passed, or exactly now", () => {
    expect(nextDailyRun(almaty("2026-10-05T10:00:00"), 10).toISOString()).toBe(
      almaty("2026-10-06T10:00:00").toISOString(),
    );
    expect(nextDailyRun(almaty("2026-10-05T23:30:00"), 10).toISOString()).toBe(
      almaty("2026-10-06T10:00:00").toISOString(),
    );
  });

  it("crosses a month and a year", () => {
    expect(nextDailyRun(almaty("2026-12-31T11:00:00"), 10).toISOString()).toBe(
      almaty("2027-01-01T10:00:00").toISOString(),
    );
  });

  it("goes by the billing time zone", () => {
    expect(BILLING_TIME_ZONE).toBe("Asia/Almaty");
    // 20:00 UTC on the fifth is already 01:00 on the sixth in Almaty.
    expect(nextDailyRun(new Date("2026-10-05T20:00:00Z"), 10).toISOString()).toBe(
      almaty("2026-10-06T10:00:00").toISOString(),
    );
  });
});

describe("the retries after a refusal", () => {
  it("lasts billing_retry_days days from the first failure", () => {
    const failedAt = almaty("2026-11-05T10:00:05");
    expect(retryWindowEnd(failedAt, 3).toISOString()).toBe(
      almaty("2026-11-08T10:00:05").toISOString(),
    );
  });

  it("gives as many attempts as there are days: days 0, 1 and 2, then none", () => {
    // declinedCount = refusals already received in this period.
    expect([0, 1, 2, 3, 4].map((declined) => bankRetriesLeft(declined, 3))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(bankRetriesLeft(0, 1)).toBe(true);
    expect(bankRetriesLeft(1, 1)).toBe(false);
  });
});
