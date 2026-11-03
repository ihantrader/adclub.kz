import { localDateTime } from "../offer/receipt-date";
import { startOfLocalDate } from "../order/order-reserve";
import type { SubscriptionAudience } from "./subscription-machine";

/**
 * Tariffs (PRODUCT 14.1, 14.2; ARCHITECTURE 5.10, 4.72; TASK-040): records
 * with dates, not constants. A rise is a new record with a future
 * `validFrom`; it is announced `announceBeforeDays` before it starts
 * (`price_increase_notice_text`, S-BILL-01 «С {дата} тариф — {цена}»,
 * M-SUB-02 «Объявлено повышение»).
 */
export interface PlanRecord {
  audience: SubscriptionAudience;
  validFrom: Date;
  /** `null` — open-ended. */
  validTo: Date | null;
  announceBeforeDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * **The plan in effect at `at`** for the audience: among the records whose
 * period holds `at` (`validFrom ≤ at < validTo`), the one that started last
 * — a new record takes over from its date without the old one being closed.
 */
export function planInEffect<Plan extends PlanRecord>(
  plans: readonly Plan[],
  audience: SubscriptionAudience,
  at: Date,
): Plan | null {
  let found: Plan | null = null;
  for (const plan of plans) {
    if (plan.audience !== audience) continue;
    if (plan.validFrom.getTime() > at.getTime()) continue;
    if (plan.validTo && plan.validTo.getTime() <= at.getTime()) continue;
    if (!found || plan.validFrom.getTime() > found.validFrom.getTime()) found = plan;
  }
  return found;
}

/**
 * **The announced change** at `at`: the nearest record that starts later
 * and whose announcement window has opened (`validFrom − announceBeforeDays
 * ≤ at`); `null` — nothing announced yet.
 */
export function announcedPlan<Plan extends PlanRecord>(
  plans: readonly Plan[],
  audience: SubscriptionAudience,
  at: Date,
): Plan | null {
  let found: Plan | null = null;
  for (const plan of plans) {
    if (plan.audience !== audience) continue;
    const starts = plan.validFrom.getTime();
    if (starts <= at.getTime()) continue;
    if (starts - plan.announceBeforeDays * DAY_MS > at.getTime()) continue;
    if (!found || starts < found.validFrom.getTime()) found = plan;
  }
  return found;
}

/**
 * **The earliest day a new tariff of the admin panel may start** (TASK-043,
 * ARCHITECTURE 4.78 I850), a day of `timeZone` (`YYYY-MM-DD`): tomorrow —
 * never today or a day gone (a term already being paid is not repriced under
 * the supplier's feet); a **rise** besides no earlier than the first day whose
 * 00:00 is `announceBeforeDays` days from now, so the notice of PRODUCT 14.1
 * («предупреждается заранее») is really shown that long. `firstTariff` —
 * nothing is in effect: the first tariff may start today (without it nobody
 * can subscribe).
 */
export function earliestPlanStart(input: {
  now: Date;
  announceBeforeDays: number;
  rise: boolean;
  firstTariff?: boolean;
  timeZone?: string;
}): string {
  const timeZone = input.timeZone ?? "Asia/Almaty";
  const today = localDateTime(input.now, timeZone).date;
  if (input.firstTariff) return today;
  const tomorrow = nextDate(today);
  if (!input.rise) return tomorrow;
  const ready = new Date(input.now.getTime() + input.announceBeforeDays * DAY_MS);
  let day = localDateTime(ready, timeZone).date;
  if (startOfLocalDate(day, timeZone).getTime() < ready.getTime()) day = nextDate(day);
  return day > tomorrow ? day : tomorrow;
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
