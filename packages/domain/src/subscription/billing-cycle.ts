import { localDateTime } from "../offer/receipt-date";
import { visitInstant } from "../order/order-visit";
import { startOfLocalDate } from "../order/order-reserve";

/**
 * The calendar of a supplier's card subscription and the rules of its
 * retries (PRODUCT 14.1, 14.3; ARCHITECTURE 9.4.2, 18.5, 4.77; TASK-042).
 *
 * **A period is a run of calendar days, not of hours.** It begins on the day
 * the card was charged and ends at the start (00:00 in Almaty) of the same
 * day number of the next month: paid on 31 January — until 28 February
 * (29 in a leap year), then until 31 March, the number never drifts, because
 * the *anchor day* of the first period is kept. The daily job charges at
 * `billing_notify_hour` on the day the term ends, so «Активна до 1 декабря»
 * means the next charge is on 1 December.
 */

/** The time zone of the club's billing: periods end on its midnights. */
export const BILLING_TIME_ZONE = "Asia/Almaty";

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The date `months` calendar months after `date` (`YYYY-MM-DD`) on
 * `anchorDay`, or on the last day of that month when it is shorter.
 */
export function addCalendarMonths(date: string, months: number, anchorDay: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(nextYear, nextMonth));
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface SubscriptionPeriod {
  /** Where the paid term ends: a midnight of the billing time zone. */
  end: Date;
  /** The day of the month the term is counted on; the end is never earlier than it allows. */
  anchorDay: number;
}

/** The first period, bought on the day `startedAt` falls on. */
export function firstPeriod(
  startedAt: Date,
  timeZone: string = BILLING_TIME_ZONE,
): SubscriptionPeriod {
  const { date } = localDateTime(startedAt, timeZone);
  const anchorDay = Number(date.slice(8, 10));
  return { end: startOfLocalDate(addCalendarMonths(date, 1, anchorDay), timeZone), anchorDay };
}

/**
 * The period a payment made at `paidAt` buys when the term ended at
 * `previousEnd`. **It continues the old term, it does not start at the day
 * of payment** — paying two days late gives no free days and takes none
 * (the next end is the next month's same number). A term overdue by more
 * than a month would, continued, end in the past and charge again the next
 * morning for days the supplier was off the showcase: then the payment
 * starts a fresh period from its own day.
 */
export function renewalPeriod(
  previousEnd: Date,
  anchorDay: number,
  paidAt: Date,
  timeZone: string = BILLING_TIME_ZONE,
): SubscriptionPeriod {
  const { date } = localDateTime(previousEnd, timeZone);
  const end = startOfLocalDate(addCalendarMonths(date, 1, anchorDay), timeZone);
  if (end.getTime() > paidAt.getTime()) {
    return { end, anchorDay };
  }
  return firstPeriod(paidAt, timeZone);
}

/**
 * The next moment the daily job runs after `from`: `hour`:00 in the billing
 * time zone (`billing_notify_hour`), strictly later than `from`. It is the
 * date W-05 promises («Повторим {дата}»).
 */
export function nextDailyRun(from: Date, hour: number, timeZone: string = BILLING_TIME_ZONE): Date {
  const { date } = localDateTime(from, timeZone);
  const time = `${String(hour).padStart(2, "0")}:00`;
  const today = new Date(visitInstant(date, time, timeZone));
  if (today.getTime() > from.getTime()) {
    return today;
  }
  // The same hour of the following day; the day length varies only in a
  // time zone with a clock change, which Almaty has not had since 2024.
  const nextDay = localDateTime(new Date(today.getTime() + 36 * 3_600_000), timeZone).date;
  return new Date(visitInstant(nextDay, time, timeZone));
}

/** The end of the retries after the first failed charge: `billing_retry_days` days on. */
export function retryWindowEnd(failedAt: Date, retryDays: number): Date {
  return new Date(failedAt.getTime() + retryDays * 24 * 3_600_000);
}

/**
 * Whether the daily job may try to charge a subscription whose charge was
 * refused by the bank `declinedCount` times in this period: the first
 * attempt is day 0, so with `billing_retry_days` = 3 there are three
 * attempts (days 0, 1, 2) and on day 3 the retries are over — the
 * subscription is suspended when the window ends (ARCHITECTURE 18.5). A
 * charge the provider could not process (unavailable, unknown) is not a
 * refusal and uses none of them.
 */
export function bankRetriesLeft(declinedCount: number, retryDays: number): boolean {
  return declinedCount < retryDays;
}
