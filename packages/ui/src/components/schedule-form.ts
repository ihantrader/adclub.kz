/**
 * The hours of a supplier's pickup point as a person edits them (S-COMP-01
 * in the cabinet, A-SUP-03 «Профиль» in the admin panel — one form for
 * both, TASK-036): per day of the week a day off, «круглосуточно», or the
 * hours with an optional break — and back to the server's form
 * (`PUT …/schedule`: seven days of intervals, ARCHITECTURE 4.26). A day
 * with more than one break stays as it was until it is changed here.
 *
 * The shapes below are those of `@adclub/contracts` (`HoursInterval`,
 * `DayHours`, `ClosedDate`), written out so the design system doesn't
 * depend on the contract; the test checks the result against its schema.
 */
export interface HoursInterval {
  from: string;
  to: string;
}

export interface DayHours {
  day: number;
  intervals: HoursInterval[];
}

export type WeeklyHours = DayHours[];

export interface ClosedDate {
  date: string;
  note: string | null;
}
export type DayMode = "off" | "hours" | "allDay" | "custom";

export interface DayForm {
  day: number;
  mode: DayMode;
  from: string;
  to: string;
  withBreak: boolean;
  breakFrom: string;
  breakTo: string;
  /** The intervals of a `custom` day, kept unchanged. */
  custom: HoursInterval[];
}

export type WeekForm = DayForm[];

const DEFAULT_DAY = {
  from: "09:00",
  to: "18:00",
  withBreak: false,
  breakFrom: "13:00",
  breakTo: "14:00",
  custom: [] as HoursInterval[],
};

function dayFormOf(day: number, intervals: readonly HoursInterval[]): DayForm {
  const [first, second] = intervals;
  if (!first) return { day, mode: "off", ...DEFAULT_DAY };
  if (intervals.length === 1 && first.from === "00:00" && first.to === "24:00") {
    return { day, mode: "allDay", ...DEFAULT_DAY };
  }
  if (intervals.length === 1) return { day, mode: "hours", ...DEFAULT_DAY, ...first };
  if (intervals.length === 2 && second) {
    return {
      day,
      mode: "hours",
      ...DEFAULT_DAY,
      from: first.from,
      breakFrom: first.to,
      breakTo: second.from,
      to: second.to,
      withBreak: true,
    };
  }
  return { day, mode: "custom", ...DEFAULT_DAY, custom: [...intervals] };
}

/**
 * The form for the company's hours; no hours yet (`null`) — a usual week to
 * start from (Monday to Friday 9 to 6), which is not saved until the
 * supplier saves it (the page says the hours are not set — D-060).
 */
export function weekFormOf(weeklyHours: WeeklyHours | null): WeekForm {
  if (!weeklyHours) {
    return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
      day,
      mode: day <= 5 ? "hours" : "off",
      ...DEFAULT_DAY,
    }));
  }
  return weeklyHours.map((day) => dayFormOf(day.day, day.intervals));
}

function minutes(time: string): number {
  const [hours = "0", mins = "0"] = time.split(":");
  return Number(hours) * 60 + Number(mins);
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function dayIntervals(day: DayForm): HoursInterval[] | null {
  switch (day.mode) {
    case "off":
      return [];
    case "allDay":
      return [{ from: "00:00", to: "24:00" }];
    case "custom":
      return day.custom;
    case "hours": {
      const points = day.withBreak
        ? [day.from, day.breakFrom, day.breakTo, day.to]
        : [day.from, day.to];
      if (!points.every((point) => TIME.test(point))) return null;
      const values = points.map(minutes);
      // Strictly increasing: the end after the start, the break inside the day.
      if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) return null;
      return day.withBreak
        ? [
            { from: day.from, to: day.breakFrom },
            { from: day.breakTo, to: day.to },
          ]
        : [{ from: day.from, to: day.to }];
    }
  }
}

export type WeekResult =
  | { ok: true; weeklyHours: DayHours[] }
  | { ok: false; invalidDays: number[]; noWorkingDay: boolean };

/** The server's form of the week, or the days whose times don't make sense. */
export function weeklyHoursOf(week: WeekForm): WeekResult {
  const invalidDays: number[] = [];
  const weeklyHours: DayHours[] = [];
  for (const day of week) {
    const intervals = dayIntervals(day);
    if (intervals === null) invalidDays.push(day.day);
    else weeklyHours.push({ day: day.day, intervals });
  }
  const noWorkingDay =
    invalidDays.length === 0 && weeklyHours.every((day) => day.intervals.length === 0);
  if (invalidDays.length > 0 || noWorkingDay) return { ok: false, invalidDays, noWorkingDay };
  return { ok: true, weeklyHours };
}

/** Today in the supplier's time zone, `YYYY-MM-DD` — days off start from it (S-COMP-01). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export type ClosedDateProblem = "past" | "duplicate" | "empty";

/** Why a day off can't be added: a past day, one already listed, no date at all. */
export function closedDateProblem(
  date: string,
  existing: readonly ClosedDate[],
  today: string,
): ClosedDateProblem | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "empty";
  if (date < today) return "past";
  if (existing.some((item) => item.date === date)) return "duplicate";
  return null;
}

/** Days off in date order, the past ones dropped (the server keeps only today on). */
export function upcomingClosedDates(dates: readonly ClosedDate[], today: string): ClosedDate[] {
  return dates.filter((item) => item.date >= today).sort((a, b) => a.date.localeCompare(b.date));
}
