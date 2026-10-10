import { describe, expect, it } from "vitest";
import type { ReceiptSchedule } from "../offer/receipt-date";
import {
  isLateCancel,
  noShowVerdict,
  serviceRespondBy,
  timeAnswerBy,
  visitDays,
  visitTimeProblem,
  visitUntil,
} from "./order-visit";

const ALMATY = "Asia/Almaty";

/** Monday to Friday 09:00–13:00 and 14:00–18:00; Saturday 10:00–14:00; Sunday off. */
const point: ReceiptSchedule = {
  timeZone: ALMATY,
  weeklyHours: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    intervals:
      day <= 5
        ? [
            { from: "09:00", to: "13:00" },
            { from: "14:00", to: "18:00" },
          ]
        : day === 6
          ? [{ from: "10:00", to: "14:00" }]
          : [],
  })),
  closedDates: ["2026-10-07"],
};

/** Monday 5 October 2026, 10:30 in Almaty (UTC+5). */
const now = new Date("2026-10-05T05:30:00Z");

/** A local time of Almaty as an instant. */
function almaty(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:00`);
}

describe("visitTimeProblem", () => {
  it("takes a whole minute inside a working interval, today or later within the horizon", () => {
    expect(visitTimeProblem(almaty("2026-10-05", "11:00"), now, point, 30)).toBeNull();
    expect(visitTimeProblem(almaty("2026-10-05", "17:59"), now, point, 30)).toBeNull();
    expect(visitTimeProblem(almaty("2026-10-06", "09:00"), now, point, 30)).toBeNull();
    expect(visitTimeProblem(almaty("2026-10-10", "13:30"), now, point, 30)).toBeNull();
    expect(visitTimeProblem(almaty("2026-11-04", "09:00"), now, point, 30)).toBeNull();
  });

  it("refuses a time not later than now", () => {
    expect(visitTimeProblem(almaty("2026-10-05", "10:30"), now, point, 30)).toBe("past");
    expect(visitTimeProblem(almaty("2026-10-05", "09:00"), now, point, 30)).toBe("past");
    expect(visitTimeProblem(almaty("2026-10-01", "11:00"), now, point, 30)).toBe("past");
  });

  it("refuses a time outside the hours: the break, after closing, the end itself, a day off", () => {
    expect(visitTimeProblem(almaty("2026-10-05", "13:30"), now, point, 30)).toBe("outside_hours");
    expect(visitTimeProblem(almaty("2026-10-05", "18:00"), now, point, 30)).toBe("outside_hours");
    expect(visitTimeProblem(almaty("2026-10-06", "08:59"), now, point, 30)).toBe("outside_hours");
    expect(visitTimeProblem(almaty("2026-10-10", "14:00"), now, point, 30)).toBe("outside_hours");
    expect(visitTimeProblem(almaty("2026-10-11", "11:00"), now, point, 30)).toBe("outside_hours");
  });

  it("refuses a closed date of the point", () => {
    expect(visitTimeProblem(almaty("2026-10-07", "11:00"), now, point, 30)).toBe("closed_date");
  });

  it("refuses a time beyond the horizon in the point's own calendar", () => {
    expect(visitTimeProblem(almaty("2026-11-05", "09:00"), now, point, 30)).toBe("too_far");
    expect(visitTimeProblem(almaty("2026-10-06", "09:00"), now, point, 0)).toBe("too_far");
    expect(visitTimeProblem(almaty("2026-10-05", "11:00"), now, point, 0)).toBeNull();
  });

  it("refuses a time with seconds and a point without hours", () => {
    expect(visitTimeProblem(new Date("2026-10-05T06:00:30Z"), now, point, 30)).toBe(
      "not_whole_minute",
    );
    expect(
      visitTimeProblem(almaty("2026-10-05", "11:00"), now, { ...point, weeklyHours: null }, 30),
    ).toBe("hours_not_set");
  });

  it("reads the hours in the point's time zone, not the server's", () => {
    // 11:00 in Almaty is 06:00 UTC: inside the hours there, whatever UTC says.
    expect(visitTimeProblem(new Date("2026-10-05T06:00:00Z"), now, point, 30)).toBeNull();
    // 20:00 UTC on Monday is 01:00 on Tuesday in Almaty — the point is closed.
    expect(visitTimeProblem(new Date("2026-10-05T20:00:00Z"), now, point, 30)).toBe(
      "outside_hours",
    );
  });
});

describe("visitDays", () => {
  const days = visitDays(now, point, 6);

  it("lists the working days from today to the horizon, closed dates and days off left out", () => {
    expect(days.map((day) => day.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
    ]);
    expect(days[1]!.intervals).toEqual([
      { from: "09:00", to: "13:00" },
      { from: "14:00", to: "18:00" },
    ]);
    expect(days[4]!.intervals).toEqual([{ from: "10:00", to: "14:00" }]);
  });

  it("cuts today to what is still ahead", () => {
    expect(days[0]!.intervals).toEqual([
      { from: "10:31", to: "13:00" },
      { from: "14:00", to: "18:00" },
    ]);
    // After closing, today is not offered at all.
    expect(visitDays(almaty("2026-10-05", "18:30"), point, 1).map((day) => day.date)).toEqual([
      "2026-10-06",
    ]);
  });

  it("offers only times the check takes", () => {
    for (const day of visitDays(now, point, 30)) {
      for (const interval of day.intervals) {
        expect(visitTimeProblem(almaty(day.date, interval.from), now, point, 30)).toBeNull();
      }
    }
  });

  it("is empty without hours", () => {
    expect(visitDays(now, { ...point, weeklyHours: null }, 30)).toEqual([]);
  });
});

describe("the deadlines of a visit", () => {
  it("the supplier answers by the setting, but never after the time asked for", () => {
    const at = almaty("2026-10-05", "10:30");
    expect(serviceRespondBy(at, 2, almaty("2026-10-06", "11:00")).toISOString()).toBe(
      almaty("2026-10-05", "12:30").toISOString(),
    );
    // Asked for in 30 minutes: the answer is due by then.
    expect(serviceRespondBy(at, 2, almaty("2026-10-05", "11:00")).toISOString()).toBe(
      almaty("2026-10-05", "11:00").toISOString(),
    );
  });

  it("the user answers another time by the setting, but never after that time", () => {
    const at = almaty("2026-10-05", "10:30");
    expect(timeAnswerBy(at, 24, almaty("2026-10-08", "15:00")).toISOString()).toBe(
      almaty("2026-10-06", "10:30").toISOString(),
    );
    expect(timeAnswerBy(at, 24, almaty("2026-10-05", "15:00")).toISOString()).toBe(
      almaty("2026-10-05", "15:00").toISOString(),
    );
  });

  it("marks a no-show only from the visit's time to the end of its window", () => {
    const visitAt = almaty("2026-10-06", "15:00");
    const until = visitUntil(visitAt, 2);
    expect(until.toISOString()).toBe(almaty("2026-10-06", "17:00").toISOString());
    expect(noShowVerdict(visitAt, until, almaty("2026-10-06", "14:59"))).toBe("too_early");
    expect(noShowVerdict(visitAt, until, visitAt)).toBe("allowed");
    expect(noShowVerdict(visitAt, until, almaty("2026-10-06", "16:59"))).toBe("allowed");
    expect(noShowVerdict(visitAt, until, until)).toBe("too_late");
  });

  it("calls a cancel late when less than the setting is left before the visit", () => {
    const visitAt = almaty("2026-10-06", "15:00");
    expect(isLateCancel(visitAt, almaty("2026-10-06", "12:59"), 2)).toBe(false);
    expect(isLateCancel(visitAt, almaty("2026-10-06", "13:00"), 2)).toBe(false);
    expect(isLateCancel(visitAt, almaty("2026-10-06", "13:01"), 2)).toBe(true);
    expect(isLateCancel(visitAt, almaty("2026-10-06", "16:00"), 2)).toBe(true);
    expect(isLateCancel(visitAt, almaty("2026-10-06", "14:59"), 0)).toBe(false);
  });
});
