import { Inject, Injectable } from "@nestjs/common";
import { normalizeArticle, searchKey } from "@adclub/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { offer, shownOffers } from "../offers";
import { customerOrder, inSupplierStatistics } from "../orders";
import { supplierLocation } from "../suppliers";
import type { SearchOutboxSubjectKind } from "./schema";
import {
  documentHash,
  synonymMap,
  type SearchIndexDocument,
  type SearchIndexDocumentContent,
} from "./search-document";

/** Items whose documents are worked out in one go. */
export const SEARCH_DOCUMENT_BATCH = 500;
/** Popularity counts the orders of this many last days. */
export const POPULARITY_DAYS = 90;

const uuids = (list: readonly string[]) => sql`${`{${list.join(",")}}`}::uuid[]`;

function keysOf(texts: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    const key = searchKey(text);
    if (key !== "") {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * The documents of the search index, worked out from PostgreSQL — the
 * source of truth (TASK-045; ARCHITECTURE 10.1, 4.65). An item has a
 * document only when users can find it: active, in a visible subcategory,
 * with at least one offer the catalog shows — by the showcase rule's own SQL
 * twin `shownOffers` (the one the catalog's `visibleOffers` selects by; its
 * schedule part already leaves out every offer without a receipt date), not
 * by a copy of the rule. Popularity — orders of the last 90 days that
 * count in statistics (`inSupplierStatistics`, the SQL twin of
 * `countsInStatistics`).
 */
@Injectable()
export class SearchDocuments {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** The documents of these items now; `null` — the item is not to be in the index. */
  async build(
    itemIds: readonly string[],
    at: Date = new Date(),
  ): Promise<Map<string, SearchIndexDocument | null>> {
    const result = new Map<string, SearchIndexDocument | null>();
    const unique = [...new Set(itemIds)];
    for (let start = 0; start < unique.length; start += SEARCH_DOCUMENT_BATCH) {
      const batch = unique.slice(start, start + SEARCH_DOCUMENT_BATCH);
      for (const [id, document] of await this.buildBatch(this.database.db, batch, at)) {
        result.set(id, document);
      }
    }
    return result;
  }

  /** Every item that has an offer users see now — what a full build indexes. */
  async indexableItemIds(at: Date = new Date()): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ itemId: offer.itemId })
      .from(offer)
      .where(shownOffers(at));
    return rows.map((row) => row.itemId).sort();
  }

  /** The items the subjects of the outbox touch (an item stays even if it is gone now). */
  async itemsOf(
    subjects: readonly { kind: SearchOutboxSubjectKind; id: string }[],
  ): Promise<string[]> {
    const ids = (kind: SearchOutboxSubjectKind) => [
      ...new Set(subjects.filter((subject) => subject.kind === kind).map((s) => s.id)),
    ];
    const items = new Set(ids("item"));
    const executor = this.database.db;
    const add = async (query: ReturnType<typeof sql>) => {
      const rows = await executor.execute<{ id: string }>(query);
      for (const row of rows.rows) {
        items.add(row.id);
      }
    };
    const categories = ids("category");
    if (categories.length > 0) {
      await add(sql`
        SELECT i.id FROM catalog_item i JOIN category c ON c.id = i.category_id
        WHERE c.id = ANY(${uuids(categories)}) OR c.parent_id = ANY(${uuids(categories)})
      `);
    }
    const options = ids("option");
    if (options.length > 0) {
      await add(sql`
        SELECT DISTINCT item_id AS id FROM item_attribute_value
        WHERE value_option_id = ANY(${uuids(options)})
      `);
    }
    const brands = ids("brand");
    if (brands.length > 0) {
      await add(sql`SELECT id FROM catalog_item WHERE brand_id = ANY(${uuids(brands)})`);
    }
    const suppliers = ids("supplier");
    if (suppliers.length > 0) {
      await add(sql`
        SELECT DISTINCT item_id AS id FROM offer WHERE supplier_id = ANY(${uuids(suppliers)})
      `);
    }
    const locations = ids("location");
    if (locations.length > 0) {
      await add(sql`
        SELECT DISTINCT item_id AS id FROM offer WHERE location_id = ANY(${uuids(locations)})
      `);
    }
    return [...items];
  }

  /**
   * The synonyms of the index (ARCHITECTURE 10.2 п. 4): a group per
   * category with synonyms — its synonyms and its names in kk/ru/en — and
   * per item with two synonyms or more. Of visible categories only.
   */
  async synonyms(): Promise<Record<string, string[]>> {
    const rows = await this.database.db.execute<{ owner: string; text: string }>(sql`
      SELECT 'c' || s.category_id AS owner, s.term AS text FROM item_search_synonym s
      WHERE s.category_id IS NOT NULL
      UNION ALL
      SELECT 'c' || t.entity_id, t.text FROM translation t
      WHERE t.entity_type = 'category' AND t.field = 'name'
        AND t.entity_id IN (SELECT category_id FROM item_search_synonym WHERE category_id IS NOT NULL)
      UNION ALL
      SELECT 'i' || s.item_id, s.term FROM item_search_synonym s WHERE s.item_id IS NOT NULL
    `);
    const groups = new Map<string, string[]>();
    for (const row of rows.rows) {
      push(groups, row.owner, row.text);
    }
    return synonymMap([...groups.values()].map((texts) => keysOf(texts)));
  }

  private async buildBatch(
    executor: DbExecutor,
    itemIds: readonly string[],
    at: Date,
  ): Promise<Map<string, SearchIndexDocument | null>> {
    const result = new Map<string, SearchIndexDocument | null>(itemIds.map((id) => [id, null]));
    if (itemIds.length === 0) {
      return result;
    }
    const items = await executor.execute<{
      id: string;
      kind: "goods" | "services";
      category_id: string;
      parent_id: string | null;
      brand_id: string | null;
      article: string | null;
      article_norm: string | null;
    }>(sql`
      SELECT i.id, c.kind, i.category_id, c.parent_id, i.brand_id, i.article, i.article_norm
      FROM catalog_item i
      JOIN category c ON c.id = i.category_id
      LEFT JOIN category p ON p.id = c.parent_id
      WHERE i.id = ANY(${uuids(itemIds)}) AND i.status = 'active'
        AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'
    `);
    if (items.rows.length === 0) {
      return result;
    }
    const ids = items.rows.map((row) => row.id);
    const citiesOf = new Map<string, Set<string>>();
    const offered = await executor
      .selectDistinct({ itemId: offer.itemId, cityId: supplierLocation.cityId })
      .from(offer)
      .innerJoin(supplierLocation, eq(supplierLocation.id, offer.locationId))
      .where(and(inArray(offer.itemId, ids), shownOffers(at)));
    for (const entry of offered) {
      const cities = citiesOf.get(entry.itemId) ?? new Set<string>();
      cities.add(entry.cityId);
      citiesOf.set(entry.itemId, cities);
    }
    const shown = items.rows.filter((row) => citiesOf.has(row.id));
    if (shown.length === 0) {
      return result;
    }
    const shownIds = shown.map((row) => row.id);
    const categoryIds = [
      ...new Set(
        shown.flatMap((row) =>
          row.parent_id ? [row.category_id, row.parent_id] : [row.category_id],
        ),
      ),
    ];
    const brandIds = [...new Set(shown.flatMap((row) => (row.brand_id ? [row.brand_id] : [])))];
    const since = new Date(at.getTime() - POPULARITY_DAYS * 86_400_000);

    const [own, categoryTexts, brandTexts, values, orders] = await Promise.all([
      executor.execute<{ id: string; text: string }>(sql`
        SELECT t.entity_id AS id, t.text FROM translation t
        WHERE t.entity_type = 'catalog_item' AND t.field = 'name' AND t.entity_id = ANY(${uuids(shownIds)})
        UNION ALL
        SELECT s.item_id, s.term FROM item_search_synonym s WHERE s.item_id = ANY(${uuids(shownIds)})
      `),
      executor.execute<{ id: string; text: string }>(sql`
        SELECT t.entity_id AS id, t.text FROM translation t
        WHERE t.entity_type = 'category' AND t.field = 'name' AND t.entity_id = ANY(${uuids(categoryIds)})
        UNION ALL
        SELECT s.category_id, s.term FROM item_search_synonym s
        WHERE s.category_id = ANY(${uuids(categoryIds)})
      `),
      brandIds.length === 0
        ? Promise.resolve({ rows: [] as { id: string; text: string }[] })
        : executor.execute<{ id: string; text: string }>(sql`
            SELECT brand_id AS id, text FROM brand_spelling WHERE brand_id = ANY(${uuids(brandIds)})
          `),
      executor.execute<{ item_id: string; option_text: string }>(sql`
        SELECT v.item_id, t.text AS option_text
        FROM item_attribute_value v
        JOIN attribute a ON a.id = v.attribute_id
        JOIN translation t ON t.entity_type = 'attribute_option' AND t.field = 'name'
          AND t.entity_id = v.value_option_id
        WHERE v.item_id = ANY(${uuids(shownIds)})
          AND a.status = 'active' AND a.is_filterable AND a.value_type = 'enum'
      `),
      executor
        .select({ itemId: customerOrder.itemId, orders: sql<number>`count(*)::int` })
        .from(customerOrder)
        .where(
          and(
            inArray(customerOrder.itemId, shownIds),
            sql`${customerOrder.createdAt} >= ${since.toISOString()}::timestamptz`,
            inSupplierStatistics(),
          ),
        )
        .groupBy(customerOrder.itemId),
    ]);

    const ownOf = new Map<string, string[]>();
    for (const row of own.rows) push(ownOf, row.id, row.text);
    const categoryOf = new Map<string, string[]>();
    for (const row of categoryTexts.rows) push(categoryOf, row.id, row.text);
    const brandOf = new Map<string, string[]>();
    for (const row of brandTexts.rows) push(brandOf, row.id, row.text);
    const valuesOf = new Map<string, string[]>();
    for (const row of values.rows) push(valuesOf, row.item_id, row.option_text);
    const popularityOf = new Map(orders.map((row) => [row.itemId, Number(row.orders)]));

    for (const row of shown) {
      const content: SearchIndexDocumentContent = {
        id: row.id,
        kind: row.kind,
        categoryId: row.category_id,
        nodeId: row.parent_id,
        article:
          row.article === null
            ? []
            : [
                ...new Set(
                  [normalizeArticle(row.article).toLowerCase(), searchKey(row.article)].filter(
                    (value) => value !== "",
                  ),
                ),
              ].sort(),
        own: keysOf(ownOf.get(row.id) ?? []),
        brand: keysOf(row.brand_id ? (brandOf.get(row.brand_id) ?? []) : []),
        category: keysOf([
          ...(categoryOf.get(row.category_id) ?? []),
          ...(row.parent_id ? (categoryOf.get(row.parent_id) ?? []) : []),
        ]),
        values: keysOf(valuesOf.get(row.id) ?? []),
        cities: [...(citiesOf.get(row.id) ?? [])].sort(),
        popularity: popularityOf.get(row.id) ?? 0,
      };
      result.set(row.id, { ...content, hash: documentHash(content) });
    }
    return result;
  }
}
