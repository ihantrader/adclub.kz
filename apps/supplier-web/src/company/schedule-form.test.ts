import { weeklyHoursSchema } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  closedDateProblem,
  todayIn,
  upcomingClosedDates,
  weekFormOf,
  weeklyHoursOf,
  type WeekForm,
} from "./schedule-form";

const week = [
  { day: 1, intervals: [{ from: "09:00", to: "18:00" }] },
  {
    day: 2,
    intervals: [
      { from: "09:00", to: "13:00" },
      { from: "14:00", to: "18:00" },
    ],
  },
  { day: 3, intervals: [{ from: "00:00", to: "24:00" }] },
  {
    day: 4,
    intervals: [
      { from: "08:00", to: "10:00" },
      { from: "11:00", to: "12:00" },
      { from: "13:00", to: "20:00" },
    ],
  },
  { day: 5, intervals: [{ from: "10:00", to: "16:00" }] },
  { day: 6, intervals: [] },
  { day: 7, intervals: [] },
];

describe("S-COMP-01 hours", () => {
  it("reads every kind of day and gives back exactly what it read", () => {
    const form = weekFormOf(week);
    expect(form.map((day) => day.mode)).toEqual([
      "hours",
      "hours",
      "allDay",
      "custom",
      "hours",
      "off",
      "off",
    ]);
    expect(form[1]).toMatchObject({
      withBreak: true,
      from: "09:00",
      breakFrom: "13:00",
      breakTo: "14:00",
      to: "18:00",
    });
    const result = weeklyHoursOf(form);
    expect(result).toEqual({ ok: true, weeklyHours: week });
    // What the server accepts, checked by its own schema.
    if (result.ok) expect(weeklyHoursSchema.safeParse(result.weeklyHours).success).toBe(true);
  });

  it("starts a company without hours from a usual week that is not saved yet", () => {
    const form = weekFormOf(null);
    expect(form.map((day) => day.mode)).toEqual([
      "hours",
      "hours",
      "hours",
      "hours",
      "hours",
      "off",
      "off",
    ]);
  });

  it("refuses an end before the start and a break outside the day", () => {
    const form: WeekForm = weekFormOf(week);
    form[0] = { ...form[0]!, from: "18:00", to: "09:00" };
    form[4] = { ...form[4]!, withBreak: true, breakFrom: "17:00", breakTo: "19:00" };
    expect(weeklyHoursOf(form)).toEqual({ ok: false, invalidDays: [1, 5], noWorkingDay: false });
  });

  it("refuses a week without a single working day (D-060)", () => {
    const form = weekFormOf(week).map((day) => ({ ...day, mode: "off" as const }));
    expect(weeklyHoursOf(form)).toEqual({ ok: false, invalidDays: [], noWorkingDay: true });
  });
});

describe("S-COMP-01 days off", () => {
  it("takes today in the supplier's time zone, not the browser's", () => {
    // 20:30 UTC on 15 December is already 16 December in Almaty (UTC+5).
    const moment = new Date("2026-12-15T20:30:00Z");
    expect(todayIn("Asia/Almaty", moment)).toBe("2026-12-16");
    expect(todayIn("UTC", moment)).toBe("2026-12-15");
  });

  it("refuses a past date and a date already listed", () => {
    const existing = [{ date: "2026-12-16", note: null }];
    expect(closedDateProblem("2026-12-15", existing, "2026-12-16")).toBe("past");
    expect(closedDateProblem("2026-12-16", existing, "2026-12-16")).toBe("duplicate");
    expect(closedDateProblem("", existing, "2026-12-16")).toBe("empty");
    expect(closedDateProblem("2026-12-17", existing, "2026-12-16")).toBeNull();
  });

  it("shows only the days off from today on, in order", () => {
    expect(
      upcomingClosedDates(
        [
          { date: "2027-01-01", note: null },
          { date: "2026-12-01", note: "прошёл" },
          { date: "2026-12-16", note: "День Независимости" },
        ],
        "2026-12-10",
      ).map((item) => item.date),
    ).toEqual(["2026-12-16", "2027-01-01"]);
  });
});
