import { describe, expect, it } from "vitest";
import {
  isoWeekday,
  nextDate,
  RECEIPT_DATE_HORIZON_DAYS,
  receiptDate,
  type ReceiptDayHours,
  type ReceiptSchedule,
} from "./receipt-date";

const ALMATY = "Asia/Almaty"; // UTC+5 all year

const withLunch = [
  { from: "09:00", to: "13:00" },
  { from: "14:00", to: "18:00" },
];

/** Monday to Friday 9–18 with a lunch break, Saturday 10–15, Sunday off. */
const sixDays: ReceiptDayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day <= 5 ? withLunch : day === 6 ? [{ from: "10:00", to: "15:00" }] : [],
}));

/** Monday to Friday 9–18, the weekend off. */
const fiveDays: ReceiptDayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day <= 5 ? [{ from: "09:00", to: "18:00" }] : [],
}));

const aroundTheClock: ReceiptDayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

/** Around the clock on working days, the weekend off. */
const weekdaysAroundTheClock: ReceiptDayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day <= 5 ? [{ from: "00:00", to: "24:00" }] : [],
}));

const allOff: ReceiptDayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, intervals: [] }));

function schedule(
  weeklyHours: ReceiptDayHours[] | null,
  closedDates: string[] = [],
  timeZone = ALMATY,
): ReceiptSchedule {
  return { timeZone, weeklyHours, closedDates };
}

/** An instant given as the local time of Almaty. */
const almaty = (local: string) => new Date(`${local}:00+05:00`);

interface Case {
  name: string;
  at: Date;
  leadDays: number;
  schedule: ReceiptSchedule;
  date: string;
}

// 2026-09-22 is a Tuesday; 2026-09-25 — Friday; 2026-12-31 — Thursday.
const cases: Case[] = [
  {
    name: "in stock, a working morning — the same day",
    at: almaty("2026-09-22T10:00"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-22",
  },
  {
    name: "in stock, before opening — the same day",
    at: almaty("2026-09-22T07:30"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-22",
  },
  {
    name: "in stock, during the lunch break — the same day",
    at: almaty("2026-09-22T13:30"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-22",
  },
  {
    name: "in stock, a minute before closing — the same day",
    at: almaty("2026-09-22T17:59"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-22",
  },
  {
    name: "in stock, at closing time — the next working day",
    at: almaty("2026-09-22T18:00"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-23",
  },
  {
    name: "in stock, Friday evening after closing, a six-day week — Saturday",
    at: almaty("2026-09-25T19:00"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-26",
  },
  {
    name: "in stock, Friday evening after closing, a five-day week — Monday",
    at: almaty("2026-09-25T19:00"),
    leadDays: 0,
    schedule: schedule(fiveDays),
    date: "2026-09-28",
  },
  {
    name: "in stock, Saturday after its short day — Monday (Sunday is off)",
    at: almaty("2026-09-26T16:00"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-28",
  },
  {
    name: "in stock, on Sunday — Monday",
    at: almaty("2026-09-27T11:00"),
    leadDays: 0,
    schedule: schedule(sixDays),
    date: "2026-09-28",
  },
  {
    name: "one day, confirmed on a working morning — the next working day",
    at: almaty("2026-09-22T10:00"),
    leadDays: 1,
    schedule: schedule(sixDays),
    date: "2026-09-23",
  },
  {
    name: "one day, Friday evening, a five-day week — Monday",
    at: almaty("2026-09-25T20:00"),
    leadDays: 1,
    schedule: schedule(fiveDays),
    date: "2026-09-28",
  },
  {
    name: "two days, Friday morning, a five-day week — Tuesday",
    at: almaty("2026-09-25T09:30"),
    leadDays: 2,
    schedule: schedule(fiveDays),
    date: "2026-09-29",
  },
  {
    name: "five days over a weekend — a week later",
    at: almaty("2026-09-22T12:00"),
    leadDays: 5,
    schedule: schedule(fiveDays),
    date: "2026-09-29",
  },
  {
    name: "a closed date on a working day is skipped",
    at: almaty("2026-12-15T10:00"),
    leadDays: 1,
    schedule: schedule(fiveDays, ["2026-12-16", "2026-12-17"]),
    date: "2026-12-18",
  },
  {
    name: "in stock on a closed date — the next working day",
    at: almaty("2026-12-16T10:00"),
    leadDays: 0,
    schedule: schedule(fiveDays, ["2026-12-16", "2026-12-17"]),
    date: "2026-12-18",
  },
  {
    name: "a holiday right after the weekend — the week starts later",
    at: almaty("2027-03-19T19:00"), // Friday evening before Nauryz
    leadDays: 1,
    schedule: schedule(fiveDays, ["2027-03-22", "2027-03-23", "2027-03-24"]),
    date: "2027-03-25",
  },
  {
    name: "31 December, in stock after closing, New Year closed — the first working day of the year",
    at: almaty("2026-12-31T19:00"),
    leadDays: 0,
    schedule: schedule(fiveDays, ["2027-01-01", "2027-01-02"]),
    date: "2027-01-04",
  },
  {
    name: "31 December, three days over the New Year",
    at: almaty("2026-12-31T10:00"),
    leadDays: 3,
    schedule: schedule(fiveDays, ["2027-01-01", "2027-01-02", "2027-01-07"]),
    date: "2027-01-06",
  },
  {
    name: "around the clock, in stock a minute before midnight — the same day",
    at: almaty("2026-09-26T23:59"),
    leadDays: 0,
    schedule: schedule(aroundTheClock),
    date: "2026-09-26",
  },
  {
    name: "around the clock, Saturday, one day — Sunday",
    at: almaty("2026-09-26T12:00"),
    leadDays: 1,
    schedule: schedule(aroundTheClock),
    date: "2026-09-27",
  },
  {
    name: "around the clock, a closed date is still skipped",
    at: almaty("2026-09-26T12:00"),
    leadDays: 1,
    schedule: schedule(aroundTheClock, ["2026-09-27"]),
    date: "2026-09-28",
  },
  {
    name: "around the clock, in stock on a closed date — the next day",
    at: almaty("2026-09-27T12:00"),
    leadDays: 0,
    schedule: schedule(aroundTheClock, ["2026-09-27"]),
    date: "2026-09-28",
  },
  {
    name: "the day is the day of the point's time zone: 20:30 UTC Friday is Saturday night in Almaty",
    at: new Date("2026-09-25T20:30:00Z"),
    leadDays: 0,
    schedule: schedule(weekdaysAroundTheClock),
    date: "2026-09-28",
  },
  {
    name: "the same instant in London is still Friday",
    at: new Date("2026-09-25T20:30:00Z"),
    leadDays: 0,
    schedule: schedule(weekdaysAroundTheClock, [], "Europe/London"),
    date: "2026-09-25",
  },
  {
    name: "the closing hour is compared in the point's time zone",
    at: new Date("2026-09-22T12:30:00Z"), // 17:30 in Almaty
    leadDays: 0,
    schedule: schedule(fiveDays),
    date: "2026-09-22",
  },
  {
    name: "a working day after 59 closed days is still found",
    at: almaty("2026-09-22T19:00"),
    leadDays: 1,
    schedule: schedule(
      aroundTheClock,
      Array.from({ length: RECEIPT_DATE_HORIZON_DAYS - 1 }, (_, index) =>
        new Date(Date.UTC(2026, 8, 23 + index)).toISOString().slice(0, 10),
      ),
    ),
    date: "2026-11-21",
  },
];

describe("the receipt date", () => {
  it.each(cases)("$name", (entry) => {
    expect(receiptDate(entry.at, entry.leadDays, entry.schedule)).toMatchObject({
      ok: true,
      date: entry.date,
    });
  });

  it("gives the day of the confirmation in the point's time zone", () => {
    expect(receiptDate(new Date("2026-09-25T20:30:00Z"), 0, schedule(sixDays))).toMatchObject({
      confirmedOn: "2026-09-26",
    });
  });

  it("doesn't calculate a date before the hours are given", () => {
    expect(receiptDate(almaty("2026-09-22T10:00"), 0, schedule(null))).toEqual({
      ok: false,
      reason: "hours_not_set",
      confirmedOn: "2026-09-22",
    });
  });

  it("doesn't calculate a date when no day of the week works", () => {
    expect(receiptDate(almaty("2026-09-22T10:00"), 0, schedule(allOff))).toMatchObject({
      ok: false,
      reason: "no_working_day",
    });
  });

  it("doesn't calculate a date when the next 60 days are closed", () => {
    const closed = Array.from({ length: RECEIPT_DATE_HORIZON_DAYS }, (_, index) =>
      new Date(Date.UTC(2026, 8, 23 + index)).toISOString().slice(0, 10),
    );
    expect(
      receiptDate(almaty("2026-09-22T19:00"), 1, schedule(aroundTheClock, closed)),
    ).toMatchObject({ ok: false, reason: "no_working_day" });
    expect(
      receiptDate(almaty("2026-09-22T10:00"), 3, schedule(aroundTheClock, closed)),
    ).toMatchObject({ ok: false, reason: "no_working_day" });
  });

  it("refuses a term that isn't a whole number of days from 0", () => {
    expect(() => receiptDate(new Date(), -1, schedule(sixDays))).toThrow(RangeError);
    expect(() => receiptDate(new Date(), 1.5, schedule(sixDays))).toThrow(RangeError);
  });

  it("walks the calendar across months, years and a leap day", () => {
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
    expect(nextDate("2028-02-28")).toBe("2028-02-29");
    expect(nextDate("2027-02-28")).toBe("2027-03-01");
    expect(isoWeekday("2026-09-27")).toBe(7);
    expect(isoWeekday("2026-09-28")).toBe(1);
  });
});
