import { sql, type SQL } from "drizzle-orm";

/**
 * Transaction locks of the catalog (ARCHITECTURE 4.15 I145, 4.17).
 *
 * Every change of the structure (categories, attributes, options) takes
 * the structure lock exclusively: changes are rare, and serialized the
 * checks that span rows can't race. Every change of items takes it
 * shared: items don't wait for each other, but an item never checks its
 * category, attributes and options against a structure being changed in
 * the same moment — and completeness, recomputed by both, can't be left
 * behind by either (an attribute counted for completeness while a value
 * was written unseen).
 */
export const STRUCTURE_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('catalog_structure'))`;

export const STRUCTURE_LOCK_SHARED = sql`SELECT pg_advisory_xact_lock_shared(hashtext('catalog_structure'))`;

/**
 * The identity of products (`generic`) of one category: whether two of
 * them are the same depends on the values of both, so writers of a
 * category's products take turns (TASK-011 requirement 2). Ids are sorted
 * by the caller to always lock in one order.
 */
export function productIdentityLock(categoryId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext('catalog_item_identity'), hashtext(${categoryId}))`;
}
