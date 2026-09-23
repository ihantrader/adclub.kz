import type { OfferShowcase as OfferShowcaseSign } from "@adclub/contracts";
import {
  offerVisibility,
  RECEIPT_DATE_HORIZON_DAYS,
  scheduleFact,
  type SupplierPauseReason,
} from "@adclub/domain";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { receiptSchedules } from "./offer-receipt";
import { offer } from "./schema";

/**
 * Whether users see an offer (TASK-018 requirement 6; ARCHITECTURE 4.28,
 * 4.30). This is the one server rule: the cabinet's sign, the admin view
 * and the client catalog (TASK-020) all take it from here. The decision
 * itself is the pure `offerVisibility` of `@adclub/domain`; `shownOffers`
 * is the same rule as a SQL condition for lists that must only select
 * shown offers — the integration tests keep the two, and the catalog's
 * answer, in agreement.
 *
 * Nothing is stored: a supplier's pause or block, an archived item or a
 * hidden category hide an offer only while they last, and the offer's own
 * status never changes because of them. Since TASK-020 (D-060) the pickup
 * point's schedule hides its offers too when there is no receipt date to
 * show: no hours given, or no working day in the horizon after today — no
 * day of the week works, or closed dates close it all (TASK-020.A). That
 * is `scheduleFact` of the receipt date, the one reason a date can't be
 * had; the cabinet names it.
 */

interface FactsRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  offer_status: "active" | "withdrawn" | "suspended";
  pause_reason: SupplierPauseReason | null;
  blocked: boolean;
  item_status: string;
  category_visible: boolean;
  has_city: boolean;
}

/** The showcase sign of each offer (by id) at `at`. */
export async function offerShowcase(
  executor: DbExecutor,
  offerIds: readonly string[],
  at: Date = new Date(),
): Promise<Map<string, OfferShowcaseSign>> {
  const result = new Map<string, OfferShowcaseSign>();
  if (offerIds.length === 0) {
    return result;
  }
  const facts = await executor.execute<FactsRow>(sql`
    SELECT o.id,
      o.location_id,
      o.status AS offer_status,
      s.pause_reason,
      s.blocked_at IS NOT NULL AS blocked,
      i.status AS item_status,
      (c.status = 'active' AND coalesce(p.status, 'active') = 'active') AS category_visible,
      EXISTS (SELECT 1 FROM city WHERE city.id = l.city_id) AS has_city
    FROM offer o
    JOIN supplier s ON s.id = o.supplier_id
    JOIN catalog_item i ON i.id = o.item_id
    JOIN category c ON c.id = i.category_id
    LEFT JOIN category p ON p.id = c.parent_id
    JOIN supplier_location l ON l.id = o.location_id
    WHERE ${inArray(sql`o.id`, [...offerIds])}
  `);
  const schedules = await receiptSchedules(
    executor,
    facts.rows.map((row) => row.location_id),
  );
  for (const row of facts.rows) {
    const schedule = schedules.get(row.location_id);
    result.set(
      row.id,
      offerVisibility({
        offerStatus: row.offer_status,
        supplierPauseReason: row.pause_reason,
        supplierBlocked: row.blocked,
        itemStatus: row.item_status,
        categoryVisible: row.category_visible,
        hasCity: row.has_city,
        schedule: schedule ? scheduleFact(at, schedule) : "hours_not_set",
      }),
    );
  }
  return result;
}

/**
 * The same rule as a condition on `offer` at `at`: only offers users see.
 * The supplier's `status = 'active'` is exactly «neither paused nor
 * blocked» — the database keeps it so (ARCHITECTURE 4.26 I254). The
 * point's schedule, as `scheduleFact`: the hours are given, and one of the
 * `RECEIPT_DATE_HORIZON_DAYS` days after today in the point's time zone
 * has an interval on its day of the week and isn't a closed date. The
 * points are worked out once per statement (an uncorrelated subquery),
 * not once per offer.
 */
export function shownOffers(at: Date = new Date()): SQL {
  return sql`(
    ${offer.status} = 'active'
    AND EXISTS (SELECT 1 FROM supplier s WHERE s.id = ${offer.supplierId} AND s.status = 'active')
    AND EXISTS (
      SELECT 1 FROM catalog_item i
      JOIN category c ON c.id = i.category_id
      LEFT JOIN category p ON p.id = c.parent_id
      WHERE i.id = ${offer.itemId} AND i.status = 'active'
        AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'
    )
    AND ${offer.locationId} IN (
      SELECT l.id FROM supplier_location l
      JOIN city ON city.id = l.city_id
      JOIN supplier ls ON ls.id = l.supplier_id
      WHERE l.weekly_hours IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM generate_series(1, ${RECEIPT_DATE_HORIZON_DAYS}::int) AS g(n)
          CROSS JOIN LATERAL (
            SELECT (${at.toISOString()}::timestamptz AT TIME ZONE ls.time_zone)::date + g.n AS day
          ) AS d
          WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(l.weekly_hours) AS w
              WHERE (w ->> 'day')::int = extract(isodow FROM d.day)::int
                AND jsonb_array_length(w -> 'intervals') > 0
            )
            AND NOT EXISTS (
              SELECT 1 FROM supplier_closed_date cd
              WHERE cd.location_id = l.id AND cd.closed_on = d.day
            )
        )
    )
  )`;
}
