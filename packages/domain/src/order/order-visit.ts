import { isoWeekday, localDateTime, nextDate, type ReceiptSchedule } from "../offer/receipt-date";

/**
 * The time of a visit for a service (PRODUCT 11; ARCHITECTURE 6.3, 4.62;
 * TASK-038). **The one check of a time**: the time the user asks for when
 * ordering and the time an employee proposes instead are both judged here,
 * by the pickup point's own hours and closed dates in its time zone — the
 * same schedule `receiptDate` counts working days by (TASK-016, D-060):
 *
 * - a whole minute, and later than now;
 * - no further than `service_booking_horizon_days` days from today there;
 * - on a date the point is not closed, inside one of the working intervals
 *   of that day of the week (`from` inclusive, `to` exclusive).
 *
 * Around it — the deadlines of a visit: the supplier answers by
 * `supplier_response_hours` but never later than the time asked for
 * (ARCHITECTURE 6.3), the user answers another time by
 * `time_agreement_hours` but never later than that time, the visit's window
 * lasts `service_grace_hours` after it, a no-show is marked only inside the
 * window, and a cancel is late when it comes less than `late_cancel_hours`
 * before the visit.
 */

/**
 * Why a time can't be a visit: `not_whole_minute`; `past` — not later than
 * now; `too_far` — beyond the horizon; `hours_not_set` — the point has no
 * hours; `closed_date` — the point is closed that day; `outside_hours` — not
 * inside a working interval of that day.
 */
export type VisitTimeProblem =
  "not_whole_minute" | "past" | "too_far" | "hours_not_set" | "closed_date" | "outside_hours";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function minutesOf(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function timeOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function intervalsOn(schedule: ReceiptSchedule, date: string) {
  return schedule.weeklyHours?.find((entry) => entry.day === isoWeekday(date))?.intervals ?? [];
}

/** The last date of the horizon: `horizonDays` days after `today`. */
function horizonEnd(today: string, horizonDays: number): string {
  let date = today;
  for (let day = 0; day < horizonDays; day += 1) {
    date = nextDate(date);
  }
  return date;
}

/** Whether `visitAt` may be the time of a visit at `at` (`null` — it may). */
export function visitTimeProblem(
  visitAt: Date,
  at: Date,
  schedule: ReceiptSchedule,
  horizonDays: number,
): VisitTimeProblem | null {
  if (visitAt.getTime() % MINUTE_MS !== 0) {
    return "not_whole_minute";
  }
  if (visitAt.getTime() <= at.getTime()) {
    return "past";
  }
  if (schedule.weeklyHours === null) {
    return "hours_not_set";
  }
  const local = localDateTime(visitAt, schedule.timeZone);
  const today = localDateTime(at, schedule.timeZone).date;
  if (local.date > horizonEnd(today, horizonDays)) {
    return "too_far";
  }
  if (schedule.closedDates.includes(local.date)) {
    return "closed_date";
  }
  const inside = intervalsOn(schedule, local.date).some(
    (interval) =>
      minutesOf(interval.from) <= local.minutes && local.minutes < minutesOf(interval.to),
  );
  return inside ? null : "outside_hours";
}

/** One working day of the point a visit may be on, with the times still open that day. */
export interface VisitDay {
  /** `YYYY-MM-DD` in the point's time zone. */
  date: string;
  /** `HH:MM`–`HH:MM`, `to` exclusive; today's start from the next whole minute. */
  intervals: { from: string; to: string }[];
}

/**
 * The days and hours a visit may be at `at` (SCREENS M-ORD-01 for a
 * service, S-ORD-04 «Предложить другое время»): every working day of the
 * point from today to the horizon, with its working intervals — today's cut
 * to what is still ahead. Every time inside them passes `visitTimeProblem`;
 * the screens offer nothing else. Empty — the point has no hours, or none
 * ahead.
 */
export function visitDays(at: Date, schedule: ReceiptSchedule, horizonDays: number): VisitDay[] {
  if (schedule.weeklyHours === null) {
    return [];
  }
  const now = localDateTime(at, schedule.timeZone);
  // The first whole minute later than now.
  const earliest = now.minutes + 1;
  const last = horizonEnd(now.date, horizonDays);
  const days: VisitDay[] = [];
  for (let date = now.date; date <= last; date = nextDate(date)) {
    if (schedule.closedDates.includes(date)) {
      continue;
    }
    const intervals = intervalsOn(schedule, date)
      .map((interval) => ({ from: minutesOf(interval.from), to: minutesOf(interval.to) }))
      .map((interval) =>
        date === now.date ? { from: Math.max(interval.from, earliest), to: interval.to } : interval,
      )
      .filter((interval) => interval.from < interval.to)
      .map((interval) => ({ from: timeOf(interval.from), to: timeOf(interval.to) }));
    if (intervals.length > 0) {
      days.push({ date, intervals });
    }
  }
  return days;
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/** Until when the supplier answers an order on a service made at `at`: never later than the visit asked for. */
export function serviceRespondBy(at: Date, responseHours: number, desiredAt: Date): Date {
  return earlier(new Date(at.getTime() + responseHours * HOUR_MS), desiredAt);
}

/** Until when the user answers another time proposed at `at`: never later than that time itself. */
export function timeAnswerBy(at: Date, agreementHours: number, proposedAt: Date): Date {
  return earlier(new Date(at.getTime() + agreementHours * HOUR_MS), proposedAt);
}

/** The end of the window of a visit: after it, a visit nobody closed or marked expires unresolved. */
export function visitUntil(visitAt: Date, graceHours: number): Date {
  return new Date(visitAt.getTime() + graceHours * HOUR_MS);
}

/**
 * Whether an employee may mark a no-show at `at`: `too_early` — the visit's
 * time has not come; `too_late` — its window is over (the visit has expired
 * unresolved); `allowed` — from the time of the visit to the end of its window.
 */
export function noShowVerdict(
  visitAt: Date,
  until: Date,
  at: Date,
): "allowed" | "too_early" | "too_late" {
  if (at.getTime() < visitAt.getTime()) {
    return "too_early";
  }
  return at.getTime() < until.getTime() ? "allowed" : "too_late";
}

/** A cancel of a confirmed visit less than `lateCancelHours` before it (ARCHITECTURE 6.3). */
export function isLateCancel(visitAt: Date, at: Date, lateCancelHours: number): boolean {
  return visitAt.getTime() - at.getTime() < lateCancelHours * HOUR_MS;
}
