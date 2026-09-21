import type { DayHours, OfferReceipt } from "@adclub/contracts";
import { receiptDate, type ReceiptSchedule } from "@adclub/domain";
import { inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";

/**
 * The schedules of pickup points for the receipt date (TASK-018
 * requirement 4; ARCHITECTURE 4.28): the point's hours, its time zone
 * (the supplier's) and its closed dates. The date itself is always
 * `receiptDate` of `@adclub/domain` — here, in the catalog (TASK-020) and
 * in orders (EPIC-08).
 */

interface ScheduleRow extends Record<string, unknown> {
  id: string;
  time_zone: string;
  weekly_hours: DayHours[] | null;
  closed: string[] | null;
}

export async function receiptSchedules(
  executor: DbExecutor,
  locationIds: readonly string[],
): Promise<Map<string, ReceiptSchedule>> {
  const schedules = new Map<string, ReceiptSchedule>();
  const ids = [...new Set(locationIds)];
  if (ids.length === 0) {
    return schedules;
  }
  // Closed dates from two days ago on: a confirmation «now» is never
  // earlier than yesterday in any time zone; older ones are history.
  const rows = await executor.execute<ScheduleRow>(sql`
    SELECT l.id, s.time_zone, l.weekly_hours,
      (SELECT array_agg(to_char(d.closed_on, 'YYYY-MM-DD') ORDER BY d.closed_on)
         FROM supplier_closed_date d
        WHERE d.location_id = l.id AND d.closed_on >= current_date - 2) AS closed
    FROM supplier_location l
    JOIN supplier s ON s.id = l.supplier_id
    WHERE ${inArray(sql`l.id`, ids)}
  `);
  for (const row of rows.rows) {
    schedules.set(row.id, {
      timeZone: row.time_zone,
      weeklyHours: row.weekly_hours,
      closedDates: row.closed ?? [],
    });
  }
  return schedules;
}

/** The receipt date of a term for an order confirmed at `confirmedAt`, as the contract gives it. */
export function describeReceipt(
  schedule: ReceiptSchedule,
  leadDays: number,
  confirmedAt: Date,
): OfferReceipt {
  const result = receiptDate(confirmedAt, leadDays, schedule);
  return {
    confirmedAt: confirmedAt.toISOString(),
    confirmedOn: result.confirmedOn,
    timeZone: schedule.timeZone,
    leadDays,
    date: result.ok ? result.date : null,
    unavailable: result.ok ? null : result.reason,
  };
}
