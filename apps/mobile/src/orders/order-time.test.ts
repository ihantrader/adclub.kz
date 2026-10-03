import { describe, expect, it } from "vitest";
import { clockText, deadlineText, updatedLabel, zonedParts } from "./order-time";

// Plain Node checks of moments in words (TASK-030).

const month = (n: number) =>
  [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ][n - 1]!;

describe("moments of the server", () => {
  it("are read in the zone of the point", () => {
    expect(zonedParts("2026-10-04T19:30:00.000Z", "Asia/Almaty")).toEqual({
      year: 2026,
      month: 10,
      day: 5,
      hour: 0,
      minute: 30,
    });
  });

  it("fall back to the device's clock for a zone the engine does not know, and refuse what is not a moment", () => {
    expect(zonedParts("2026-10-04T19:30:00.000Z", "Mars/Olympus")).not.toBeNull();
    expect(zonedParts("soon", "Asia/Almaty")).toBeNull();
  });

  it("say the clock only today, and the date too on another day", () => {
    const now = new Date("2026-10-04T05:00:00.000Z");
    expect(deadlineText("2026-10-04T10:00:00.000Z", "Asia/Almaty", now, month)).toBe("15:00");
    expect(deadlineText("2026-10-05T10:00:00.000Z", "Asia/Almaty", now, month)).toBe(
      "15:00, 5 октября",
    );
    // 23:30 UTC is already tomorrow in Almaty.
    expect(deadlineText("2026-10-04T19:30:00.000Z", "Asia/Almaty", now, month)).toBe(
      "00:30, 5 октября",
    );
  });
});

describe("«Обновлено в {время}»", () => {
  it("is the time while the copy is less than a day old, the date after that — by the server's time, not the phone's", () => {
    const served = "2026-10-04T05:12:00.000Z";
    const time = updatedLabel(served, new Date("2026-10-04T09:00:00.000Z"));
    expect(time?.kind).toBe("time");
    expect(time).toEqual({ kind: "time", time: clockText(zonedParts(served, null)!) });
    expect(updatedLabel(served, new Date("2026-10-05T05:12:00.000Z"))?.kind).toBe("date");
    expect(updatedLabel("never", new Date())).toBeNull();
  });
});
