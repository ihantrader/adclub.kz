/**
 * The date a user gets an item (PRODUCT 9, 9.1; ARCHITECTURE 13.2, 4.28;
 * TASK-018 requirement 4). One function for every consumer: the preview
 * of the supplier's cabinet, the catalog (TASK-020) and orders (EPIC-08).
 *
 * The term of an offer is counted in working days of its pickup point in
 * the point's time zone:
 *
 * - a working day is a day of the week with at least one working interval
 *   that isn't one of the point's closed dates; a point open around the
 *   clock works every day that isn't closed;
 * - term 0 («in stock, take it now»): the day of the confirmation if it is
 *   a working day and the confirmation came before the end of its working
 *   hours; otherwise the nearest working day after it;
 * - term N > 0: the N-th working day after the day of the confirmation
 *   (the day itself never counts, whatever the hour);
 * - the date isn't calculated when the hours aren't given yet, and when
 *   the point has no working day in the `RECEIPT_DATE_HORIZON_DAYS` days
 *   after the day of the confirmation (`scheduleFact`) — no day of the
 *   week works, or closed dates close the whole horizon. That fact is the
 *   only reason a date can't be had: the showcase rule, its SQL twin and
 *   the catalog all take it (TASK-020.A, ARCHITECTURE 4.30), so an offer
 *   is either shown with a date everywhere or hidden with its reason.
 *   With a working day in the horizon a date is always found, however
 *   far a long term takes it past later closed dates.
 */

/** One working interval, `HH:MM`–`HH:MM` (`24:00` only as an end), never across midnight. */
export interface ReceiptInterval {
  from: string;
  to: string;
}

/** A day of the week by ISO number (1 — Monday … 7 — Sunday); no intervals — a day off. */
export interface ReceiptDayHours {
  day: number;
  intervals: readonly ReceiptInterval[];
}

export interface ReceiptSchedule {
  /** IANA time zone of the pickup point (its supplier's). */
  timeZone: string;
  /** Seven days, Monday first; `null` — the hours aren't given yet. */
  weeklyHours: readonly ReceiptDayHours[] | null;
  /** Dates the point doesn't work, `YYYY-MM-DD` in its time zone. */
  closedDates: readonly string[];
}

/** How many days after today must hold a working day for the point to take orders. */
export const RECEIPT_DATE_HORIZON_DAYS = 60;

export type ReceiptDateUnavailable = "hours_not_set" | "no_working_day";

/**
 * Whether the point can give a receipt date at `at` (D-060, TASK-020.A):
 * `hours_not_set` — the hours aren't given; `no_working_day` — none of
 * the `RECEIPT_DATE_HORIZON_DAYS` days after today (in the point's time
 * zone) is a working day; otherwise `ok`.
 */
export type ScheduleFact = "ok" | ReceiptDateUnavailable;

export type ReceiptDateResult =
  | {
      ok: true;
      /** The date the user gets the item, `YYYY-MM-DD` in the point's time zone. */
      date: string;
      /** The day of the confirmation there (a client says «today», «tomorrow» by it). */
      confirmedOn: string;
    }
  | { ok: false; reason: ReceiptDateUnavailable; confirmedOn: string };

/** The date and the minute of the day of an instant in a time zone. */
export function localDateTime(instant: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function minutesOf(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** The next calendar date (`YYYY-MM-DD`). */
export function nextDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** ISO day of the week of a date: 1 — Monday … 7 — Sunday. */
export function isoWeekday(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function workingDays(schedule: ReceiptSchedule): ((date: string) => boolean) | null {
  const weeklyHours = schedule.weeklyHours;
  if (weeklyHours === null) {
    return null;
  }
  const closed = new Set(schedule.closedDates);
  return (date: string) =>
    !closed.has(date) &&
    (weeklyHours.find((entry) => entry.day === isoWeekday(date))?.intervals.length ?? 0) > 0;
}

/** Is there a working day among the horizon's days after `today`? */
function worksWithinHorizon(isWorking: (date: string) => boolean, today: string): boolean {
  let date = today;
  for (let day = 0; day < RECEIPT_DATE_HORIZON_DAYS; day += 1) {
    date = nextDate(date);
    if (isWorking(date)) {
      return true;
    }
  }
  return false;
}

/** The schedule fact of a point at `at` — the one reason a receipt date can't be had. */
export function scheduleFact(at: Date, schedule: ReceiptSchedule): ScheduleFact {
  const isWorking = workingDays(schedule);
  if (!isWorking) {
    return "hours_not_set";
  }
  const today = localDateTime(at, schedule.timeZone).date;
  return worksWithinHorizon(isWorking, today) ? "ok" : "no_working_day";
}

/**
 * The receipt date for a confirmation at `confirmedAt` and a term of
 * `leadDays` working days (an integer from 0).
 */
export function receiptDate(
  confirmedAt: Date,
  leadDays: number,
  schedule: ReceiptSchedule,
): ReceiptDateResult {
  if (!Number.isInteger(leadDays) || leadDays < 0) {
    throw new RangeError("The term is a whole number of working days from 0");
  }
  const local = localDateTime(confirmedAt, schedule.timeZone);
  const confirmedOn = local.date;
  const isWorking = workingDays(schedule);
  if (!isWorking) {
    return { ok: false, reason: "hours_not_set", confirmedOn };
  }
  if (!worksWithinHorizon(isWorking, confirmedOn)) {
    return { ok: false, reason: "no_working_day", confirmedOn };
  }
  const intervalsOf = (date: string) =>
    schedule.weeklyHours?.find((entry) => entry.day === isoWeekday(date))?.intervals ?? [];

  if (leadDays === 0 && isWorking(confirmedOn)) {
    const closesAt = Math.max(...intervalsOf(confirmedOn).map((entry) => minutesOf(entry.to)));
    if (local.minutes < closesAt) {
      return { ok: true, date: confirmedOn, confirmedOn };
    }
  }
  // Term 0 after closing (or on a day off) — the nearest working day; term
  // N — the N-th. It ends: some day of the week works (the horizon has a
  // working day) and the closed dates are finitely many.
  let remaining = Math.max(leadDays, 1);
  let date = confirmedOn;
  for (;;) {
    date = nextDate(date);
    if (isWorking(date)) {
      remaining -= 1;
      if (remaining === 0) {
        return { ok: true, date, confirmedOn };
      }
    }
  }
}
