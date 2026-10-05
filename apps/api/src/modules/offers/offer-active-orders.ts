import { activeOrderStatuses } from "@adclub/domain";
import { inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";

interface CountRow extends Record<string, unknown> {
  offer_id: string;
  active: number;
}

/**
 * «Активные заявки: N» of each offer (SCREENS S-OFF-01; TASK-032,
 * ARCHITECTURE 4.48): the orders on it that are still going through —
 * `activeOrderStatuses` of `@adclub/domain`, the same statuses the supplier's
 * tabs «Новые» and «В работе» hold (TASK-021). Only the offer's own
 * company's orders count: an order belongs to the supplier it was placed
 * with, and the join on the offer's supplier keeps that a property of the
 * query rather than of the caller. Offers without active orders are absent
 * from the map (0). The offers module can't import the orders module (that
 * one depends on this), hence plain SQL over `customer_order`.
 */
export async function activeOrderCounts(
  executor: DbExecutor,
  offerIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (offerIds.length === 0) {
    return result;
  }
  const rows = await executor.execute<CountRow>(sql`
    SELECT co.offer_id, count(*)::int AS active
    FROM customer_order co
    JOIN offer o ON o.id = co.offer_id AND o.supplier_id = co.supplier_id
    WHERE ${inArray(sql`co.offer_id`, [...offerIds])}
      AND ${inArray(sql`co.status`, [...activeOrderStatuses])}
    GROUP BY co.offer_id
  `);
  for (const row of rows.rows) {
    result.set(row.offer_id, row.active);
  }
  return result;
}
