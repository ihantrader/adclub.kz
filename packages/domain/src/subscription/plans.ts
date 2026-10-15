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
