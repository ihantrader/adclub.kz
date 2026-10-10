import { describe, expect, it } from "vitest";
import { desiredAtOf, settleVisitChoice, visitChoiceDays, visitDayLabel } from "./visit-choice";

const options = {
  days: [
    // Today, from the next minute to the closing of the point.
    { date: "2026-10-10", intervals: [{ from: "17:46", to: "18:00" }] },
    { date: "2026-10-12", intervals: [{ from: "09:00", to: "11:00" }] },
    // Nothing whole is left of it: not offered.
    { date: "2026-10-13", intervals: [{ from: "17:58", to: "18:00" }] },
  ],
};

describe("the day and the time of a visit (M-ORD-01, a service)", () => {
  it("offers the server's days with their times, only the days that have one left", () => {
    expect(visitChoiceDays(options)).toEqual([
      { date: "2026-10-10", times: ["17:50"] },
      { date: "2026-10-12", times: ["09:00", "09:30", "10:00", "10:30"] },
    ]);
    expect(visitChoiceDays({ days: [] })).toEqual([]);
  });

  it("starts on the first day without a time, and keeps a choice that is still offered", () => {
    const days = visitChoiceDays(options);
    expect(settleVisitChoice(null, days)).toEqual({ date: "2026-10-10", time: null });
    expect(settleVisitChoice({ date: "2026-10-12", time: "10:00" }, days)).toEqual({
      date: "2026-10-12",
      time: "10:00",
    });
    expect(settleVisitChoice(null, [])).toBeNull();
  });

  it("drops a time no longer offered, and a day no longer offered (the point closed it)", () => {
    const days = visitChoiceDays(options);
    expect(settleVisitChoice({ date: "2026-10-12", time: "11:00" }, days)).toEqual({
      date: "2026-10-12",
      time: null,
    });
    expect(settleVisitChoice({ date: "2026-10-14", time: "10:00" }, days)).toEqual({
      date: "2026-10-10",
      time: null,
    });
  });

  it("sends the chosen time at the point as an instant, nothing without a time", () => {
    expect(desiredAtOf({ date: "2026-10-12", time: "11:00" }, "Asia/Almaty")).toBe(
      "2026-10-12T06:00:00.000Z",
    );
    expect(desiredAtOf({ date: "2026-10-12", time: null }, "Asia/Almaty")).toBeNull();
    expect(desiredAtOf(null, "Asia/Almaty")).toBeNull();
  });

  it("names the days: today, tomorrow, otherwise the day of the week and the date", () => {
    expect(visitDayLabel("2026-10-10", "2026-10-10")).toEqual({ kind: "today" });
    expect(visitDayLabel("2026-10-11", "2026-10-10")).toEqual({ kind: "tomorrow" });
    expect(visitDayLabel("2026-10-12", "2026-10-10")).toEqual({
      kind: "date",
      weekday: 1,
      month: 10,
      day: 12,
    });
    expect(visitDayLabel("2026-11-01", "2026-10-31")).toEqual({ kind: "tomorrow" });
    expect(visitDayLabel("2026-10-18", "2026-10-10")).toMatchObject({ weekday: 7 });
  });
});
