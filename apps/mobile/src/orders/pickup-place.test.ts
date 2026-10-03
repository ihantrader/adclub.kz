import { describe, expect, it } from "vitest";
import { callUrl, mapsUrl, weeklyHoursLines } from "./pickup-place";

// Plain Node checks of «Поставщик и место» after acceptance (M-ORD-03, D-026).

const day = (n: number, intervals: Array<[string, string]>) => ({
  day: n,
  intervals: intervals.map(([from, to]) => ({ from, to })),
});

describe("the hours of the point", () => {
  it("join days in a row with the same hours", () => {
    const week = [
      ...[1, 2, 3, 4, 5].map((n) =>
        day(n, [
          ["09:00", "13:00"],
          ["14:00", "18:00"],
        ]),
      ),
      day(6, [["10:00", "16:00"]]),
      day(7, []),
    ];
    expect(weeklyHoursLines(week)).toEqual([
      { fromDay: 1, toDay: 5, hours: "09:00–13:00, 14:00–18:00" },
      { fromDay: 6, toDay: 6, hours: "10:00–16:00" },
      { fromDay: 7, toDay: 7, hours: null },
    ]);
  });

  it("say round the clock, and nothing when the server gave no hours", () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, [["00:00", "24:00"]]));
    expect(weeklyHoursLines(week)).toEqual([{ fromDay: 1, toDay: 7, hours: "allDay" }]);
    expect(weeklyHoursLines(null)).toEqual([]);
  });
});

describe("the links that leave the app", () => {
  it("open the system maps by the address the server gave, and nothing without one", () => {
    const place = { address: "ул. Райымбека, 200", cityName: "Алматы" };
    const query = encodeURIComponent("Алматы, ул. Райымбека, 200");
    expect(mapsUrl(place, "ios")).toBe(`maps://?q=${query}`);
    expect(mapsUrl(place, "android")).toBe(`geo:0,0?q=${query}`);
    expect(mapsUrl(place, "web")).toContain(query);
    expect(mapsUrl({ address: null, cityName: "Алматы" }, "ios")).toBeNull();
    expect(mapsUrl({ address: "  ", cityName: "Алматы" }, "ios")).toBeNull();
  });

  it("call the phone the server gave, and nothing without one", () => {
    expect(callUrl("+7 705 555 01 01")).toBe("tel:+77055550101");
    expect(callUrl(null)).toBeNull();
    expect(callUrl("—")).toBeNull();
  });
});
