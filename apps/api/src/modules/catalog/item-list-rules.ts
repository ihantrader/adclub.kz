import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";

/** A condition over one item: `item` is the SQL of its id. */
export type ItemCondition = (item: SQL) => SQL;

/** Offers on sale of each item; items without any are absent (0). */
export type OffersOnSaleCounts = (
  executor: DbExecutor,
  itemIds: readonly string[],
) => Promise<Map<string, number>>;

/**
 * The rules of the admin items list that belong to other modules
 * (TASK-035; ARCHITECTURE 4.53): «без совместимости» is the compatibility
 * module's rule, «есть предложения» and the number of offers in a row the
 * offers module's. Both of those depend on the catalog, so the catalog
 * can't import them; they register their rule here when the application
 * starts, and the list and the home screen's counter go through this one
 * registry — never a second copy of a rule.
 */
@Injectable()
export class CatalogItemListRules {
  private withoutCompatibilityRule: ItemCondition | null = null;
  private offersRule: { onSale: ItemCondition; counts: OffersOnSaleCounts } | null = null;

  registerWithoutCompatibility(rule: ItemCondition): void {
    this.withoutCompatibilityRule = rule;
  }

  registerOffersOnSale(onSale: ItemCondition, counts: OffersOnSaleCounts): void {
    this.offersRule = { onSale, counts };
  }

  withoutCompatibility(item: SQL): SQL {
    if (!this.withoutCompatibilityRule) {
      throw new Error("The compatibility module has not registered its list rule");
    }
    return this.withoutCompatibilityRule(item);
  }

  hasOffersOnSale(item: SQL): SQL {
    if (!this.offersRule) {
      throw new Error("The offers module has not registered its list rule");
    }
    return this.offersRule.onSale(item);
  }

  /** Offers on sale per item; without the offers module (operator command) — none known. */
  async offersOnSale(
    executor: DbExecutor,
    itemIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (!this.offersRule || itemIds.length === 0) {
      return new Map();
    }
    return this.offersRule.counts(executor, itemIds);
  }
}

/**
 * «Без фото» (A-HOME, A-CAT-04): the item has no approved photo — the client
 * catalog shows it with a placeholder (TASK-013).
 */
export function withoutApprovedPhoto(item: SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM item_photo p WHERE p.item_id = ${item} AND p.status = 'approved')`;
}
