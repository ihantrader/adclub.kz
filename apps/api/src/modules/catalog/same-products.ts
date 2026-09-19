import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";

/**
 * Products that are the same as another one (TASK-011.A; ARCHITECTURE
 * 4.17): a `generic` item with a brand whose every identifying value — of
 * each active attribute of its category that counts for completeness — is
 * filled and equal to another product's of the same category and brand
 * (the rule `CatalogItemsService.sameProduct` refuses a change by). Such a
 * pair is refused only when a change of an item's identity makes it; a
 * change of the structure can make pairs, and they stay until the
 * administrator deals with them.
 *
 * `categoryId` narrows it to one category.
 */
export function sameProductItemIds(categoryId?: string): SQL {
  const inCategory = categoryId ? sql`AND i.category_id = ${categoryId}` : sql``;
  return sql`
    WITH identifying AS (
      SELECT a.id, a.category_id FROM attribute a
      WHERE a.status = 'active' AND a.is_required_for_complete
    ),
    needed AS (
      SELECT category_id, count(*) AS total FROM identifying GROUP BY category_id
    ),
    signed AS (
      SELECT i.id, i.category_id, i.brand_id,
        jsonb_object_agg(
          v.attribute_id,
          jsonb_build_array(v.value_num, v.value_option_id, v.value_bool, lower(v.value_text))
        ) AS signature
      FROM catalog_item i
      JOIN identifying a ON a.category_id = i.category_id
      JOIN item_attribute_value v ON v.item_id = i.id AND v.attribute_id = a.id
      JOIN needed n ON n.category_id = i.category_id
      WHERE i.item_type = 'generic' AND i.brand_id IS NOT NULL ${inCategory}
      GROUP BY i.id, i.category_id, i.brand_id, n.total
      HAVING count(*) = n.total
    )
    SELECT s.id FROM signed s
    WHERE EXISTS (
      SELECT 1 FROM signed o
      WHERE o.id <> s.id
        AND o.category_id = s.category_id
        AND o.brand_id = s.brand_id
        AND o.signature = s.signature
    )`;
}

/** How many products of the category are the same as another one. */
export async function countSameProductItems(
  executor: DbExecutor,
  categoryId: string,
): Promise<number> {
  const result = await executor.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM (${sameProductItemIds(categoryId)}) same`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
