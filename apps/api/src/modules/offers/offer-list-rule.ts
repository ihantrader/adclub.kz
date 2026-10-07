import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { CatalogItemListRules } from "../catalog";

/**
 * Statuses of an offer «в продаже» — the cabinet's tab «В продаже»
 * (TASK-018, TASK-032): active, or suspended by the system. Withdrawn ones
 * wait on the other tab.
 */
export const OFFER_ON_SALE_STATUSES = ["active", "suspended"] as const;

const onSaleList = sql.join(
  OFFER_ON_SALE_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/** «Есть предложения» (A-CAT-04): the item has an offer on sale. */
export function itemHasOffersOnSale(item: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM offer o WHERE o.item_id = ${item} AND o.status IN (${onSaleList}))`;
}

interface CountRow extends Record<string, unknown> {
  item_id: string;
  n: number;
}

/** Offers on sale of each item, by the same statuses; items without any are absent. */
export async function offersOnSaleCounts(
  executor: DbExecutor,
  itemIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (itemIds.length === 0) {
    return counts;
  }
  const rows = await executor.execute<CountRow>(sql`
    SELECT o.item_id, count(*)::int AS n FROM offer o
    WHERE ${inArray(sql`o.item_id`, [...itemIds])} AND o.status IN (${onSaleList})
    GROUP BY o.item_id
  `);
  for (const row of rows.rows) {
    counts.set(row.item_id, Number(row.n));
  }
  return counts;
}

/** Gives the catalog's items list this module's rule and counts (ARCHITECTURE 4.53). */
@Injectable()
export class OfferListRule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogItemListRules) private readonly rules: CatalogItemListRules) {}

  onModuleInit(): void {
    this.rules.registerOffersOnSale(itemHasOffersOnSale, offersOnSaleCounts);
  }
}
