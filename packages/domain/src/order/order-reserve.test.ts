import { describe, expect, it } from "vitest";
import type { ReceiptDayHours, ReceiptSchedule } from "../offer/receipt-date";
import {
  acceptedReserveEnd,
  readyReserveEnd,
  reserveWarningAt,
  startOfLocalDate,
} from "./order-reserve";

const ALMATY = "Asia/Almaty"; // UTC+5 all year

/** Monday to Friday 9–18, the weekend off. */
const fiveDays: ReceiptDayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day <= 5 ? [{ from: "09:00", to: "18:00" }] : [],
}));

const schedule = (closedDates: string[] = []): ReceiptSchedule => ({
  timeZone: ALMATY,
  weeklyHours: fiveDays,
  closedDates,
});

/** An instant given in Almaty time. */
const almaty = (local: string) => new Date(`${local}+05:00`);

describe("startOfLocalDate", () => {
  it("is midnight of the date in the time zone", () => {
    expect(startOfLocalDate("2026-09-23", ALMATY).toISOString()).toBe("2026-09-22T19:00:00.000Z");
    expect(startOfLocalDate("2026-01-01", "Europe/London").toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    // A summer date in London (UTC+1).
    expect(startOfLocalDate("2026-07-01", "Europe/London").toISOString()).toBe(
      "2026-06-30T23:00:00.000Z",
    );
  });
});

describe("acceptedReserveEnd", () => {
  it("counts from now when the point still works today (Wednesday 10:00)", () => {
    expect(acceptedReserveEnd(almaty("2026-09-23T10:00:00"), 0, schedule(), 24)).toEqual(
      almaty("2026-09-24T10:00:00"),
    );
  });

  it("after closing on Friday counts from the start of Monday", () => {
    expect(acceptedReserveEnd(almaty("2026-09-25T19:30:00"), 0, schedule(), 24)).toEqual(
      almaty("2026-09-29T00:00:00"),
    );
  });

  it("on a Saturday counts from the start of Monday", () => {
    expect(acceptedReserveEnd(almaty("2026-09-26T12:00:00"), 0, schedule(), 3)).toEqual(
      almaty("2026-09-28T03:00:00"),
    );
  });

  it("skips a closed date the same way", () => {
    expect(
      acceptedReserveEnd(almaty("2026-09-23T19:00:00"), 0, schedule(["2026-09-24"]), 24),
    ).toEqual(almaty("2026-09-26T00:00:00"));
  });

  it("with a term of working days counts from the receipt date", () => {
    // Wednesday + 2 working days = Friday.
    expect(acceptedReserveEnd(almaty("2026-09-23T10:00:00"), 2, schedule(), 24)).toEqual(
      almaty("2026-09-26T00:00:00"),
    );
  });

  it("counts from now without a schedule or without a receipt date", () => {
    const at = almaty("2026-09-26T12:00:00");
    expect(acceptedReserveEnd(at, 0, null, 24)).toEqual(almaty("2026-09-27T12:00:00"));
    expect(
      acceptedReserveEnd(at, 0, { timeZone: ALMATY, weeklyHours: null, closedDates: [] }, 24),
    ).toEqual(almaty("2026-09-27T12:00:00"));
  });
});

describe("readyReserveEnd", () => {
  it("starts again from «ready»", () => {
    expect(
      readyReserveEnd(almaty("2026-09-24T10:00:00"), almaty("2026-09-24T09:00:00"), 24),
    ).toEqual(almaty("2026-09-25T09:00:00"));
  });

  it("never shortens a reserve already promised", () => {
    const promised = almaty("2026-09-29T00:00:00");
    expect(readyReserveEnd(promised, almaty("2026-09-25T19:40:00"), 24)).toEqual(promised);
  });

  it("without a reserve yet is the fresh one", () => {
    expect(readyReserveEnd(null, almaty("2026-09-25T10:00:00"), 2)).toEqual(
      almaty("2026-09-25T12:00:00"),
    );
  });
});

describe("reserveWarningAt", () => {
  it("is the warning hours before the end", () => {
    expect(
      reserveWarningAt(almaty("2026-09-24T10:00:00"), 3, almaty("2026-09-23T10:00:00")),
    ).toEqual(almaty("2026-09-24T07:00:00"));
  });

  it("is not before the reserve began: a short reserve is warned about at once", () => {
    const from = almaty("2026-09-23T10:00:00");
    expect(reserveWarningAt(almaty("2026-09-23T11:00:00"), 3, from)).toEqual(from);
  });
});
