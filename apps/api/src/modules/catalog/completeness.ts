import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";

/**
 * Completeness of items (PRODUCT 7.4; ARCHITECTURE 4.17): an item is
 * `incomplete` while an active attribute of its category that counts for
 * completeness has no value. The stored `catalog_item.completeness` is
 * brought to this in the transaction of every change that can move it —
 * values, a new attribute, an attribute archived or restored, the flag
 * switched, an item moved — under the structure lock, so it never differs
 * from the data (checked by the integration test against its own query).
 */
const actual = sql`CASE WHEN EXISTS (
  SELECT 1 FROM attribute a
  WHERE a.category_id = catalog_item.category_id
    AND a.status = 'active'
    AND a.is_required_for_complete
    AND NOT EXISTS (
      SELECT 1 FROM item_attribute_value v
      WHERE v.item_id = catalog_item.id AND v.attribute_id = a.id
    )
) THEN 'incomplete' ELSE 'complete' END`;

async function refresh(executor: DbExecutor, scope: SQL): Promise<void> {
  await executor.execute(
    sql`UPDATE catalog_item SET completeness = ${actual} WHERE ${scope} AND completeness <> ${actual}`,
  );
}

/** Every item of a category (a change of its attributes). */
export function refreshCategoryCompleteness(
  executor: DbExecutor,
  categoryId: string,
): Promise<void> {
  return refresh(executor, sql`catalog_item.category_id = ${categoryId}`);
}

/** These items (their values or category changed). */
export async function refreshItemsCompleteness(
  executor: DbExecutor,
  itemIds: readonly string[],
): Promise<void> {
  if (itemIds.length === 0) {
    return;
  }
  await refresh(
    executor,
    sql`catalog_item.id IN (${sql.join(
      itemIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
}
