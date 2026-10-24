import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calendarDayOf,
  dateLangOf,
  formatDayMonth,
  formatDayTime,
  formatFullDate,
  formatMonthYear,
  formatWeekdayDayMonth,
  weekdayName,
} from "./dates";
import type { Lang } from "./translate";

const LOCALES: Record<Lang, string> = { kk: "kk-KZ", ru: "ru", en: "en" };
const LANGS: Lang[] = ["kk", "ru", "en"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dates in words (TASK-080 requirement 7)", () => {
  // Node has full ICU: our dictionary must say what it says, month by month.
  it("writes every month as full ICU does, long and short", () => {
    for (const lang of LANGS) {
      for (let month = 1; month <= 12; month++) {
        const date = new Date(Date.UTC(2026, month - 1, 13, 12));
        for (const width of ["long", "short"] as const) {
          const expected = new Intl.DateTimeFormat(LOCALES[lang], {
            day: "numeric",
            month: width,
            timeZone: "UTC",
          }).format(date);
          expect(formatDayMonth({ month, day: 13 }, lang, width), `${lang} ${month} ${width}`).toBe(
            expected,
          );
        }
      }
    }
  });

  it("writes a day to choose and a whole date with its weekday as full ICU does", () => {
    for (const lang of LANGS) {
      for (let offset = 0; offset < 7; offset++) {
        const iso = `2026-10-${String(12 + offset)}`;
        const day = calendarDayOf(iso)!;
        const date = new Date(`${iso}T12:00:00Z`);
        const intl = (options: Intl.DateTimeFormatOptions) =>
          new Intl.DateTimeFormat(LOCALES[lang], { ...options, timeZone: "UTC" }).format(date);
        expect(formatWeekdayDayMonth(day, lang)).toBe(
          intl({ weekday: "short", day: "numeric", month: "short" }),
        );
        expect(formatFullDate(day, lang)).toBe(
          intl({ weekday: "short", day: "numeric", month: "long", year: "numeric" }),
        );
        expect(formatFullDate(day, lang, "long")).toBe(
          intl({ weekday: "long", day: "numeric", month: "long", year: "numeric" }),
        );
      }
    }
  });

  it("writes a month of a year as full ICU does", () => {
    for (const lang of LANGS) {
      for (let month = 1; month <= 12; month++) {
        const expected = new Intl.DateTimeFormat(LOCALES[lang], {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2026, month - 1, 1)));
        expect(formatMonthYear(2026, month, lang), `${lang} ${month}`).toBe(expected);
      }
    }
  });

  it("writes «21 қазан, 09:11» even where Intl has no Kazakh at all", () => {
    const Native = Intl.DateTimeFormat;
    // A browser with a cut set of languages: Kazakh is not there (its names come out as «M10»).
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      const asked = Array.isArray(locales) ? locales[0] : locales;
      if (asked?.startsWith("kk")) throw new RangeError("no Kazakh data");
      return new Native(locales, options);
    } as unknown as typeof Intl.DateTimeFormat);
    const at = Date.UTC(2026, 9, 21, 4, 11); // 09:11 in Almaty (UTC+5)
    expect(formatDayTime(at, "Asia/Almaty", "kk")).toBe("21 қазан, 09:11");
    expect(formatDayTime(at, "Asia/Almaty", "kk", "short")).toBe("21 қаз., 09:11");
    expect(formatDayTime(at, "Asia/Almaty", "ru")).toBe("21 октября, 09:11");
    expect(formatDayTime(at, "Asia/Almaty", "en")).toBe("October 21, 09:11");
    expect(spy.mock.calls.every(([locales]) => !String(locales).startsWith("kk"))).toBe(true);
  });

  it("names weekdays from Monday and reads the language of a locale", () => {
    expect(weekdayName(1, "kk")).toBe("дс");
    expect(weekdayName(7, "ru", "long")).toBe("воскресенье");
    expect(dateLangOf("kk-KZ")).toBe("kk");
    expect(dateLangOf("en")).toBe("en");
    expect(dateLangOf("ru-RU")).toBe("ru");
    expect(calendarDayOf("2026-10-12")?.weekday).toBe(1);
    expect(calendarDayOf("12.10.2026")).toBeNull();
  });
});
