import type { OfferShowcase as OfferShowcaseSign } from "@adclub/contracts";
import { offerVisibility, type SupplierPauseReason } from "@adclub/domain";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { offer } from "./schema";

/**
 * Whether users see an offer (TASK-018 requirement 6; ARCHITECTURE 4.28).
 * This is the one server rule: the cabinet's sign, the admin view and the
 * client catalog (TASK-020) all take it from here. The decision itself is
 * the pure `offerVisibility` of `@adclub/domain`; `shownOffers` is the
 * same rule as a SQL condition for lists that must only select shown
 * offers — the integration test keeps the two in agreement.
 *
 * Nothing is stored: a supplier's pause or block, an archived item or a
 * hidden category hide an offer only while they last, and the offer's own
 * status never changes because of them.
 */

interface FactsRow extends Record<string, unknown> {
  id: string;
  offer_status: "active" | "withdrawn" | "suspended";
  pause_reason: SupplierPauseReason | null;
  blocked: boolean;
  item_status: string;
  category_visible: boolean;
  has_city: boolean;
}

/** The showcase sign of each offer (by id). */
export async function offerShowcase(
  executor: DbExecutor,
  offerIds: readonly string[],
): Promise<Map<string, OfferShowcaseSign>> {
  const result = new Map<string, OfferShowcaseSign>();
  if (offerIds.length === 0) {
    return result;
  }
  const facts = await executor.execute<FactsRow>(sql`
    SELECT o.id,
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
  for (const row of facts.rows) {
    result.set(
      row.id,
      offerVisibility({
        offerStatus: row.offer_status,
        supplierPauseReason: row.pause_reason,
        supplierBlocked: row.blocked,
        itemStatus: row.item_status,
        categoryVisible: row.category_visible,
        hasCity: row.has_city,
      }),
    );
  }
  return result;
}

/**
 * The same rule as a condition on `offer`: only offers users see. The
 * supplier's `status = 'active'` is exactly «neither paused nor blocked» —
 * the database keeps it so (ARCHITECTURE 4.26 I254).
 */
export function shownOffers(): SQL {
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
    AND EXISTS (
      SELECT 1 FROM supplier_location l JOIN city ON city.id = l.city_id
      WHERE l.id = ${offer.locationId}
    )
  )`;
}
