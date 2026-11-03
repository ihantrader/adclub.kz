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
  return new Date(failedAt.getTime() + retryDays * DAY_MS);
}

const DAY_MS = 24 * 3_600_000;

function nextLocalDate(date: string): string {
  const next = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1),
  );
  return next.toISOString().slice(0, 10);
}

export interface BankRetry {
  /** The day of the billing time zone (`YYYY-MM-DD`) on which the daily job may try again. */
  day: string;
  /** When it does: `hour`:00 of that day. */
  at: Date;
}

/**
 * The next bank retry after a refusal at `declinedAt` (TASK-042.A,
 * ARCHITECTURE 4.77 I838): **the first run of the daily job on a later
 * local day than the refusal**. One rule for the three who need it — the
 * daily job (it retries on `day` or later, never on the day of a refusal),
 * W-05 («Повторим {дата}» is `at`) and the cabinet («Следующая попытка»).
 * A refusal of «Оплатить сейчас» at 08:00, before the job's hour, is
 * retried tomorrow, not «today at 10:00», because today has a refusal.
 */
export function nextBankRetry(
  declinedAt: Date,
  hour: number,
  timeZone: string = BILLING_TIME_ZONE,
): BankRetry {
  const day = nextLocalDate(localDateTime(declinedAt, timeZone).date);
  const at = new Date(visitInstant(day, `${String(hour).padStart(2, "0")}:00`, timeZone));
  return { day, at };
}

/**
 * The end of a term's retries' window after `declinedCount` refusals of the
 * bank (TASK-042.A, ARCHITECTURE 4.77 I837). It is never earlier than
 * `retryDays` days after the first refusal (the window of ARCHITECTURE
 * 18.5), and **never earlier than a day after the last try the bank is still
 * owed** — the next retry and the ones after it, one a day. A provider that
 * could not be reached delays the tries; it does not use them up: the window
 * grows by what the outage took, so the company gets every try and W-05
 * never promises a retry that the pause would come before.
 */
export function bankRetryWindowEnd(input: {
  firstDeclinedAt: Date;
  lastDeclinedAt: Date;
  declinedCount: number;
  retryDays: number;
  hour: number;
  timeZone?: string;
}): Date {
  const base = retryWindowEnd(input.firstDeclinedAt, input.retryDays);
  const owed = input.retryDays - input.declinedCount;
  const lastTry =
    owed > 0
      ? new Date(
          nextBankRetry(input.lastDeclinedAt, input.hour, input.timeZone).at.getTime() +
            (owed - 1) * DAY_MS,
        )
      : input.lastDeclinedAt;
  const afterLast = new Date(lastTry.getTime() + DAY_MS);
  return afterLast.getTime() > base.getTime() ? afterLast : base;
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

/**
 * **When a past-due subscription's card is tried again** (TASK-043,
 * ARCHITECTURE 4.78 I849): the retry W-05 promised after the last refusal
 * (`nextBankRetry`), or the next run of the daily job when that day is due
 * already; `null` — no more automatic tries: the retries are used up
 * (`bankRetriesLeft`) or the next run would come no earlier than the pause
 * (`graceUntil`, what W-05a names). One rule for the cabinet's «Следующая
 * попытка» (S-BILL-01) and the administrator's list (A-BILL-03).
 */
export function pastDueNextRetry(input: {
  declinedCount: number;
  lastDeclinedAt: Date | null;
  graceUntil: Date | null;
  retryDays: number;
  hour: number;
  now: Date;
  timeZone?: string;
}): Date | null {
  if (!bankRetriesLeft(input.declinedCount, input.retryDays)) return null;
  const timeZone = input.timeZone ?? BILLING_TIME_ZONE;
  const promised = input.lastDeclinedAt
    ? nextBankRetry(input.lastDeclinedAt, input.hour, timeZone).at
    : nextDailyRun(input.now, input.hour, timeZone);
  const run =
    promised.getTime() > input.now.getTime()
      ? promised
      : nextDailyRun(input.now, input.hour, timeZone);
  return input.graceUntil && run.getTime() >= input.graceUntil.getTime() ? null : run;
}

/**
 * «Дней до паузы» (A-BILL-03): how many days of the billing time zone lie
 * between today and the day of `pauseAt` — 0 on the day itself, never
 * below 0. `pauseAt` is `subscription.grace_until`, written by
 * `bankRetryWindowEnd` — the very moment W-05a names.
 */
export function daysUntilPause(
  pauseAt: Date,
  now: Date,
  timeZone: string = BILLING_TIME_ZONE,
): number {
  const day = (at: Date) => Date.parse(`${localDateTime(at, timeZone).date}T00:00:00Z`);
  return Math.max(0, Math.round((day(pauseAt) - day(now)) / DAY_MS));
}
