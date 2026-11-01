import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  bankRetriesLeft,
  bankRetryWindowEnd,
  BILLING_TIME_ZONE,
  firstPeriod,
  nextBankRetry,
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

describe("the next bank retry", () => {
  it("is the daily run of the next local day, not of the refusal's own day", () => {
    // «Оплатить сейчас» refused at 08:00, before the job's 10:00: not «today», tomorrow.
    expect(nextBankRetry(almaty("2026-11-05T08:00:00"), 10)).toEqual({
      day: "2026-11-06",
      at: almaty("2026-11-06T10:00:00"),
    });
    // The daily job's own refusal at 10:00:05.
    expect(nextBankRetry(almaty("2026-11-05T10:00:05"), 10).at.toISOString()).toBe(
      almaty("2026-11-06T10:00:00").toISOString(),
    );
    // Late in the evening: still the next day.
    expect(nextBankRetry(almaty("2026-11-05T23:59:00"), 10).day).toBe("2026-11-06");
  });

  it("crosses a month and a year, and goes by the billing time zone", () => {
    expect(nextBankRetry(almaty("2026-12-31T12:00:00"), 10).day).toBe("2027-01-01");
    expect(nextBankRetry(almaty("2028-02-28T12:00:00"), 7).at.toISOString()).toBe(
      almaty("2028-02-29T07:00:00").toISOString(),
    );
    // 20:00 UTC on the fifth is already the sixth in Almaty: the retry is on the seventh.
    expect(nextBankRetry(new Date("2026-11-05T20:00:00Z"), 10).day).toBe("2026-11-07");
  });
});

describe("the end of the retries' window", () => {
  const tuning = { retryDays: 3, hour: 10 };

  it("is three days from the first refusal when every try happens on its day", () => {
    const first = almaty("2026-11-05T10:00:05");
    for (const [count, last] of [
      [1, first],
      [2, almaty("2026-11-06T10:00:04")],
    ] as const) {
      expect(
        bankRetryWindowEnd({
          ...tuning,
          firstDeclinedAt: first,
          lastDeclinedAt: last,
          declinedCount: count,
        }).toISOString(),
      ).toBe(almaty("2026-11-08T10:00:05").toISOString());
    }
    // The third refusal on day 2: a day after it, a few seconds past the three days.
    const third = almaty("2026-11-07T10:00:06");
    expect(
      bankRetryWindowEnd({
        ...tuning,
        firstDeclinedAt: first,
        lastDeclinedAt: third,
        declinedCount: 3,
      }).toISOString(),
    ).toBe(almaty("2026-11-08T10:00:06").toISOString());
  });

  it("grows by what a provider outage took: the second refusal on day 4 still has its retry", () => {
    const first = almaty("2026-11-05T10:00:05");
    const second = almaty("2026-11-09T14:00:00");
    const end = bankRetryWindowEnd({
      ...tuning,
      firstDeclinedAt: first,
      lastDeclinedAt: second,
      declinedCount: 2,
    });
    // One try is owed (10 November), and a day after it.
    expect(end.toISOString()).toBe(almaty("2026-11-11T10:00:00").toISOString());
    expect(end.getTime()).toBeGreaterThan(nextBankRetry(second, 10).at.getTime());
  });

  it("gives a day after the last refusal when the provider held the last try past the window", () => {
    const end = bankRetryWindowEnd({
      ...tuning,
      firstDeclinedAt: almaty("2026-11-05T10:00:05"),
      lastDeclinedAt: almaty("2026-11-10T15:00:00"),
      declinedCount: 3,
    });
    expect(end.toISOString()).toBe(almaty("2026-11-11T15:00:00").toISOString());
  });
});
