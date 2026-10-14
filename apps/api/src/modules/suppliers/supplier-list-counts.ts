import { Injectable } from "@nestjs/common";
import type { AdminSupplierListRating, SupplierRatingFilter } from "@adclub/contracts";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";

/** The rating's part of A-SUP-02 (TASK-050), owned by the ratings module. */
export interface SupplierListRatings {
  of(
    executor: DbExecutor,
    supplierIds: readonly string[],
  ): Promise<Map<string, AdminSupplierListRating>>;
  condition(filter: SupplierRatingFilter): Promise<SQL>;
}

/** A number per supplier; suppliers without any are absent. */
export type SupplierCounts = (
  executor: DbExecutor,
  supplierIds: readonly string[],
) => Promise<Map<string, number>>;

interface CountRow extends Record<string, unknown> {
  supplier_id: string;
  n: number;
}

/** Active employees of each supplier (A-SUP-02). */
export async function activeMemberCounts(
  executor: DbExecutor,
  supplierIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (supplierIds.length === 0) {
    return counts;
  }
  const rows = await executor.execute<CountRow>(sql`
    SELECT m.supplier_id, count(*)::int AS n FROM supplier_member m
    WHERE ${inArray(sql`m.supplier_id`, [...supplierIds])} AND m.status = 'active'
    GROUP BY m.supplier_id
  `);
  for (const row of rows.rows) {
    counts.set(row.supplier_id, Number(row.n));
  }
  return counts;
}

/**
 * The numbers of the suppliers' list that other modules own (TASK-036,
 * A-SUP-02): the offers module depends on this one, so it registers its
 * count here when it starts (as it does for the catalog's items list,
 * ARCHITECTURE 4.53 I556) — what «в продаже» means stays its rule.
 */
@Injectable()
export class SupplierListCounts {
  private offersOnSaleCount: SupplierCounts | null = null;
  private ratingSource: SupplierListRatings | null = null;

  registerOffersOnSale(counts: SupplierCounts): void {
    this.offersOnSaleCount = counts;
  }

  /** TASK-050: the ratings module tells the list its column and its filter. */
  registerRatings(source: SupplierListRatings): void {
    this.ratingSource = source;
  }

  /** The rating per supplier; without the ratings module — none known. */
  ratings(
    executor: DbExecutor,
    supplierIds: readonly string[],
  ): Promise<Map<string, AdminSupplierListRating>> {
    return this.ratingSource
      ? this.ratingSource.of(executor, supplierIds)
      : Promise.resolve(new Map());
  }

  /** The condition of the filter «рейтинг»; without the ratings module — nothing matches. */
  ratingCondition(filter: SupplierRatingFilter): Promise<SQL> {
    return this.ratingSource ? this.ratingSource.condition(filter) : Promise.resolve(sql`false`);
  }

  /** Offers on sale per supplier; without the offers module (operator command) — none known. */
  offersOnSale(executor: DbExecutor, supplierIds: readonly string[]): Promise<Map<string, number>> {
    return this.offersOnSaleCount
      ? this.offersOnSaleCount(executor, supplierIds)
      : Promise.resolve(new Map());
  }
}
