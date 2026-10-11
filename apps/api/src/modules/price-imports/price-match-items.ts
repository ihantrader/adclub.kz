import { supplierOffers, type NameRow, type SupplierOfferType } from "@adclub/domain";
import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { itemNameMatches, spellingKey } from "../catalog";

/**
 * What matching, the review and the application of a price list know of a
 * catalog item (TASK-047): whether it can take a row at all, and what tells
 * it from another one — the Russian name, the brand's spellings, the
 * article, the subcategory.
 */
export interface MatchItem {
  id: string;
  itemType: "part" | "generic" | "service";
  /** An active item of a visible subcategory (as a supplier and a user see the catalog). */
  available: boolean;
  brandId: string | null;
  article: string | null;
  articleNorm: string | null;
  name: string;
  brandSpellings: string[];
  /** The subcategory, and the node above it (Russian). */
  categoryName: string;
  parentName: string;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  item_type: MatchItem["itemType"];
  available: boolean;
  brand_id: string | null;
  article: string | null;
  article_norm: string | null;
  name: string | null;
  category_name: string | null;
  parent_name: string | null;
  brand_spellings: string[] | null;
}

function select(where: SQL): SQL {
  return sql`
    SELECT i.id, i.item_type, i.brand_id, i.article, i.article_norm,
      (i.status = 'active' AND c.status = 'active' AND coalesce(p.status, 'active') = 'active') AS available,
      (SELECT t.text FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = i.id
         AND t.field = 'name' AND t.lang = 'ru') AS name,
      (SELECT t.text FROM translation t WHERE t.entity_type = 'category' AND t.entity_id = c.id
         AND t.field = 'name' AND t.lang = 'ru') AS category_name,
      (SELECT t.text FROM translation t WHERE t.entity_type = 'category' AND t.entity_id = p.id
         AND t.field = 'name' AND t.lang = 'ru') AS parent_name,
      (SELECT array_agg(bs.text ORDER BY bs.is_name DESC, bs.text) FROM brand_spelling bs
         WHERE bs.brand_id = i.brand_id) AS brand_spellings
    FROM catalog_item i
    JOIN category c ON c.id = i.category_id
    LEFT JOIN category p ON p.id = c.parent_id
    WHERE ${where}`;
}

function itemOf(row: ItemRow): MatchItem {
  return {
    id: row.id,
    itemType: row.item_type,
    available: row.available,
    brandId: row.brand_id,
    article: row.article,
    articleNorm: row.article_norm,
    name: row.name ?? "",
    brandSpellings: row.brand_spellings ?? [],
    categoryName: row.category_name ?? "",
    parentName: row.parent_name ?? "",
  };
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/** Texts of any content (commas, quotes) as one parameter: a JSON array unpacked by the database. */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

/** Items by id, whatever their state. */
export async function itemsByIds(
  executor: DbExecutor,
  ids: readonly string[],
): Promise<Map<string, MatchItem>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, MatchItem>();
  if (unique.length === 0) return found;
  const rows = await executor.execute<ItemRow>(select(sql`i.id = ANY(${uuidArray(unique)})`));
  for (const row of rows.rows) found.set(row.id, itemOf(row));
  return found;
}

/** Available items by their normalized article (step 2), services among them. */
export async function itemsByArticles(
  executor: DbExecutor,
  norms: readonly string[],
): Promise<Map<string, MatchItem[]>> {
  const unique = [...new Set(norms)];
  const found = new Map<string, MatchItem[]>();
  if (unique.length === 0) return found;
  const rows = await executor.execute<ItemRow>(
    select(
      sql`i.article_norm = ANY(${textArray(unique)}) AND i.status = 'active' AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'`,
    ),
  );
  for (const row of rows.rows) {
    const item = itemOf(row);
    const list = found.get(item.articleNorm!) ?? [];
    list.push(item);
    found.set(item.articleNorm!, list);
  }
  return found;
}

/** The brands a spelling of the file names, by the uniqueness key of spellings (any case, any spacing). */
export async function brandsBySpelling(
  executor: DbExecutor,
  spellings: readonly string[],
): Promise<Map<string, string[]>> {
  const keys = [...new Set(spellings.map(spellingKey).filter((key) => key !== ""))];
  const found = new Map<string, string[]>();
  if (keys.length === 0) return found;
  const rows = await executor.execute<{ key: string; brand_id: string }>(
    sql`SELECT key, brand_id FROM brand_spelling WHERE key = ANY(${textArray(keys)})`,
  );
  for (const row of rows.rows) {
    found.set(row.key, [...(found.get(row.key) ?? []), row.brand_id]);
  }
  return found;
}

/** The brands a row names: the spelling of its brand cell (unknown — none). */
export function rowBrandIds(brand: string | null, brands: Map<string, string[]>): string[] {
  return brand ? (brands.get(spellingKey(brand)) ?? []) : [];
}

/** How many items the search by name considers for one row. */
const SEARCH_POOL = 30;

/**
 * Step 3: candidates by the name — the same match as the supplier's search
 * of an item (`itemNameMatches`: any reading of a word, another layout, a
 * transliteration), for each of the row's most telling words, among the
 * available goods. The domain decides which of them fit.
 */
export async function searchCandidates(
  executor: DbExecutor,
  words: readonly string[],
): Promise<MatchItem[]> {
  if (words.length === 0) return [];
  const matches = sql.join(
    words.map((word) => itemNameMatches(sql`i.id`, word)),
    sql` OR `,
  );
  const rows = await executor.execute<ItemRow>(
    select(
      sql`i.item_type IN ('part', 'generic') AND i.status = 'active' AND c.status = 'active'
        AND coalesce(p.status, 'active') = 'active' AND (${matches})
        ORDER BY i.created_at DESC, i.id DESC LIMIT ${SEARCH_POOL}`,
    ),
  );
  return rows.rows.map(itemOf);
}

/** Why an item can't take a row of a company's price list; `null` — it can. */
export type ItemRefusal = "unavailable" | "service_item" | "supplier_type";

export function itemRefusal(
  item: MatchItem | undefined,
  supplierType: SupplierOfferType,
): ItemRefusal | null {
  if (!item || !item.available) return "unavailable";
  // Services have prices by model (TASK-019): they are never imported.
  if (item.itemType === "service") return "service_item";
  if (!supplierOffers(supplierType, item.itemType)) return "supplier_type";
  return null;
}

/** An item as the rules of the name see it. */
export function nameCandidate(item: MatchItem) {
  return {
    itemId: item.id,
    name: item.name,
    brandSpellings: item.brandSpellings,
    article: item.article,
    context: `${item.categoryName} ${item.parentName}`,
  };
}

/** A row of the file as the rules of the name see it. */
export function nameRow(parsed: {
  name: string | null;
  brand: string | null;
  articleNorm: string | null;
}): NameRow {
  return { name: parsed.name, brand: parsed.brand, articleNorm: parsed.articleNorm };
}
