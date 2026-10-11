import { Inject, Injectable } from "@nestjs/common";
import {
  CATALOG_SEARCH_CATEGORIES_MAX,
  SHOWCASE_PAGE_DEFAULT_SIZE,
  type CatalogLanguage,
  type CatalogSearchAttributeFacet,
  type CatalogSearchCategory,
  type CatalogSearchCategoryFacet,
  type CatalogSearchEmptyReason,
  type CatalogSearchFacets,
  type CatalogSearchItem,
  type CatalogSearchQuery,
  type CatalogSearchResponse,
  type LocalizedText,
} from "@adclub/contracts";
import {
  articleQuery,
  compareSearchRankKeys,
  matchSearchDocuments,
  normalizeSearchText,
  SEARCH_RANK_KEY_NUMBERS,
  searchKey,
  searchRankKey,
  searchReading,
  searchVariant,
  searchVariants,
  type SearchDocument,
  type SearchMatch,
  type SearchRankKey,
  type SearchVariant,
} from "@adclub/domain";
import { inArray, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { catalogItem, loadTexts, localize, textsOf, type CatalogItemRow } from "../catalog";
import { CompatibilityEvaluator } from "../compatibility";
import { SearchIndex } from "../search-index";
import {
  groupByItem,
  offerFilterOf,
  offersInReach,
  visibleOffers,
  type VisibleOffer,
} from "./showcase-offers";
import { summarize } from "./showcase-ranking";
import { describeViewer, type Viewer } from "./showcase-visibility";
import { ShowcaseService } from "./showcase.service";

const NO_NAME: LocalizedText = { text: "", isFallback: true };

/** At most this many items are taken by the text of a query before the showcase rule. */
const CANDIDATES_MAX = 5000;
/** A word is corrected to a word of the catalog this similar (`pg_trgm`) or more. */
const CORRECTION_SIMILARITY_MIN = 0.4;
/** Words shorter than this are never corrected. */
const CORRECTION_WORD_MIN = 3;
/** From this many found items of one subcategory, compatibility is worked out by the subcategory. */
const EVALUATE_BY_SUBCATEGORY_FROM = 200;

const uuids = (list: readonly string[]) => sql`${`{${list.join(",")}}`}::uuid[]`;

interface TextMatch {
  match: Exclude<SearchMatch, "article">;
  own: boolean;
  /** The relevance the index gave it (0 without the index). */
  relevance: number;
  /** Its popularity as the index holds it (0 without the index). */
  popularity: number;
  /** What the results are for when not the query as typed (T-CAT-08); `null` — as typed. */
  reading: string | null;
}

interface Found {
  itemId: string;
  categoryId: string;
  match: SearchMatch;
  reading: string | null;
  offers: VisibleOffer[];
  key: SearchRankKey;
}

interface TextDocument extends SearchDocument {
  text: string;
}

function badCursor(): ApiException {
  const message = "Use the nextCursor of the previous answer, with the same query";
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path: "cursor", message }],
  });
}

function encodeCursor(key: SearchRankKey): string {
  return Buffer.from(JSON.stringify({ k: key }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): SearchRankKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  const key = (parsed as { k?: unknown } | null)?.k;
  if (
    !Array.isArray(key) ||
    key.length !== SEARCH_RANK_KEY_NUMBERS + 1 ||
    !key
      .slice(0, SEARCH_RANK_KEY_NUMBERS)
      .every((part) => typeof part === "number" && Number.isFinite(part)) ||
    typeof key[SEARCH_RANK_KEY_NUMBERS] !== "string"
  ) {
    throw badCursor();
  }
  return key as SearchRankKey;
}

/** `expression LIKE '% stem%'` for any of the stems: a word of the text begins with it. */
function beginsAnyWord(expression: SQL, stems: readonly string[]): SQL {
  // Stems are made of digits and the letters of `searchKey` only: nothing to escape.
  return sql`(${sql.join(
    stems.map((stem) => sql`${expression} LIKE ${`% ${stem}%`}`),
    sql` OR `,
  )})`;
}

/** The longest stem of each variant: a text matching it has that beginning of a word. */
function leadingStems(variants: readonly SearchVariant[]): string[] {
  return [
    ...new Set(
      variants.flatMap((variant) =>
        variant.stems.length === 0
          ? []
          : [[...variant.stems].sort((a, b) => b.length - a.length)[0]!],
      ),
    ),
  ];
}

/**
 * The search of the catalog for users (TASK-044, TASK-045; ARCHITECTURE
 * 10.2, 4.64, 4.65; SCREENS M-CAT-04):
 *
 * 1. the query is read by `@adclub/domain` — its variants (the layouts,
 *    the transliteration) and the article it may be;
 * 2. the article branch, on PostgreSQL: `catalog_item.article_norm` and the
 *    supplier's own article of a visible offer equal to the article — first;
 * 3. the text branch: the search index (Meilisearch) finds and ranks the
 *    candidates of all variants in one `multi-search`, typos forgiven; the
 *    domain then tells how each matched (`matchSearchDocuments`: exact,
 *    partial — or only a forgiven typo) by the item's texts in PostgreSQL.
 *    Without the index, or when it does not answer, the text branch of
 *    TASK-044 on PostgreSQL answers instead (the database picks the
 *    candidates by the beginnings of words, the domain decides);
 * 4. nothing matched — a word of the query is corrected to the most similar
 *    word of the catalog (`pg_trgm`), and the corrected reading is searched
 *    (T-CAT-08) — the index forgives typos itself, this catches the rest
 *    (a first letter in the wrong layout);
 * 5. what is shown is what the catalog would show, by its own functions and
 *    nothing else — whatever the index says: the showcase rule and the
 *    receipt date (`visibleOffers`), a service only in the chosen city at
 *    the price for the car's model (`offersInReach`), D-029
 *    (`CompatibilityEvaluator`, `listed`), what the viewer sees of a
 *    supplier (`showcase-visibility`, through the card). An index behind
 *    the database can only fail to find, never show more;
 * 6. the facets — the subcategories of what is shown and, in a chosen one,
 *    its brands and characteristics — are counted over what is shown;
 *    the filters of a chosen subcategory are the list's (`offerFilterOf`,
 *    `attributeFilter`);
 * 7. the one order — `searchRankKey` of the domain.
 *
 * The query is never logged nor journaled: it may be a phone number.
 */
@Injectable()
export class CatalogSearchService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CompatibilityEvaluator) private readonly compatibility: CompatibilityEvaluator,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(SearchIndex) private readonly index: SearchIndex,
  ) {}

  async search(
    query: CatalogSearchQuery,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<CatalogSearchResponse> {
    const executor = this.database.db;
    const now = new Date();
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const limit = query.limit ?? SHOWCASE_PAGE_DEFAULT_SIZE;
    const [chosenCity, vehicle] = await Promise.all([
      this.showcase.chosenCity(executor, query.cityId, lang),
      this.showcase.vehicle(executor, query),
    ]);
    const cityId = chosenCity?.id ?? null;

    // The reading of the query: its variants — through the index, or the
    // database without it; nothing matched — a corrected one.
    let variants = searchVariants(query.q);
    let texts =
      (await this.indexMatches(executor, variants, cityId)) ??
      (await this.textMatches(executor, variants));
    let corrected: string | null = null;
    if (texts.size === 0 && variants.length > 0) {
      const correction = await this.correction(executor, variants);
      if (correction) {
        const found = await this.textMatches(executor, [correction]);
        if (found.size > 0) {
          variants = [correction];
          texts = found;
          corrected = correction.text;
        }
      }
    }
    const article = articleQuery(query.q);
    const byArticle = article
      ? await this.articleMatches(executor, article)
      : { itemIds: new Set<string>(), offerIds: new Set<string>(), offerItemIds: [] };

    // What users can get of them — the catalog's own functions.
    const ids = [...new Set([...byArticle.itemIds, ...byArticle.offerItemIds, ...texts.keys()])];
    const shown = groupByItem(await visibleOffers(executor, { itemIds: ids }, now));
    const rows =
      shown.size === 0
        ? []
        : await executor
            .select()
            .from(catalogItem)
            .where(inArray(catalogItem.id, [...shown.keys()]));
    const rowOf = new Map(rows.map((row) => [row.id, row]));
    let cityRequired = false;
    let reachableAny = false;
    let otherModels = false;
    const reachable = new Map<string, { offers: VisibleOffer[]; match: SearchMatch }>();
    for (const row of rows) {
      const offers = shown.get(row.id) ?? [];
      if (row.categoryKind === "services" && cityId === null) {
        cityRequired = true;
        continue;
      }
      const inReach = offersInReach(row.categoryKind, offers, cityId, vehicle?.modelId ?? null);
      if (inReach.length === 0) {
        otherModels ||= row.categoryKind === "services" && offers.some((o) => o.cityId === cityId);
        continue;
      }
      const match: SearchMatch | null =
        byArticle.itemIds.has(row.id) || inReach.some((entry) => byArticle.offerIds.has(entry.id))
          ? "article"
          : (texts.get(row.id)?.match ?? null);
      if (match) {
        reachableAny = true;
        reachable.set(row.id, { offers: inReach, match });
      }
    }

    // D-029: only what a list may show for the car.
    const results = await this.evaluate(vehicle, reachable.keys(), rowOf, executor);
    const resultOf = new Map(results.map((result) => [result.itemId, result]));
    const listed = results.filter((result) => result.listed);

    // The chips count every listed item; a chosen subcategory narrows the
    // results to it and applies its filters, as its list does.
    const categoryFacets = await this.categoryFacets(executor, listed, rowOf, lang);
    let kept = listed.map((result) => result.itemId);
    let offersOf = new Map(kept.map((id) => [id, reachable.get(id)!.offers]));
    let facets: CatalogSearchFacets = { categories: categoryFacets, brands: [], attributes: [] };
    if (query.categoryId) {
      const narrowed = await this.narrow(executor, query, cityId, kept, rowOf, offersOf);
      kept = narrowed.itemIds;
      offersOf = narrowed.offersOf;
      facets = { ...facets, brands: narrowed.brands, attributes: narrowed.attributes };
    }

    const found: Found[] = kept
      .map((itemId) => {
        const { match } = reachable.get(itemId)!;
        const text = texts.get(itemId);
        const offers = offersOf.get(itemId)!;
        const summary = summarize(offers, cityId);
        return {
          itemId,
          categoryId: rowOf.get(itemId)!.categoryId,
          match,
          reading: match === "article" || !text ? null : text.reading,
          offers,
          key: searchRankKey({
            match,
            own: match === "article" ? true : (text?.own ?? false),
            inCity: summary.inCity,
            relevance: text?.relevance ?? 0,
            popularity: text?.popularity ?? 0,
            minPrice: summary.minPrice,
            id: itemId,
          }),
        };
      })
      .sort((a, b) => compareSearchRankKeys(a.key, b.key));

    const remaining = cursor
      ? found.filter((entry) => compareSearchRankKeys(entry.key, cursor) > 0)
      : found;
    const page = remaining.slice(0, limit);
    const last = page.at(-1);
    const described = await this.showcase.describeItems(
      executor,
      page.map((entry) => rowOf.get(entry.itemId)!),
      lang,
    );
    const categoryTexts = await loadTexts(executor, "category", [
      ...new Set(page.map((entry) => entry.categoryId)),
    ]);
    const items: CatalogSearchItem[] = page.map((entry) => {
      const row = rowOf.get(entry.itemId)!;
      return {
        ...described.get(entry.itemId)!,
        compatibility: resultOf.get(entry.itemId)!,
        offers: summarize(entry.offers, cityId),
        // A typo forgiven is a partial match to a client (the enum is unchanged).
        match: entry.match === "typo" ? "partial" : entry.match,
        category: {
          id: row.categoryId,
          kind: row.categoryKind,
          name: localize(textsOf(categoryTexts, row.categoryId, "name"), lang) ?? NO_NAME,
        },
      };
    });

    // T-CAT-08: the reading the results are for when the query as typed found
    // nothing of them as it is (the first found by text tells which).
    const byText = found.filter((entry) => entry.match !== "article");
    const asRead = normalizeSearchText(query.q);
    const reading =
      corrected ??
      (byText.length > 0 && byText.every((entry) => entry.reading !== null)
        ? byText[0]!.reading
        : null);
    const usedQuery = reading !== null && reading !== asRead ? reading : null;
    const empty: CatalogSearchEmptyReason | null =
      found.length > 0
        ? null
        : (reachableAny || otherModels) && vehicle !== null && listed.length === 0
          ? "vehicle"
          : cityRequired && listed.length === 0
            ? "city_required"
            : "no_items";
    const readingVariant = usedQuery ? searchVariant(usedQuery) : null;

    return {
      language: lang,
      query: asRead,
      usedQuery,
      city: chosenCity,
      vehicle,
      viewer: describeViewer(viewer),
      items,
      total: found.length,
      empty,
      cityRequired,
      categories: await this.categories(
        executor,
        readingVariant ? [...variants, readingVariant] : variants,
        lang,
      ),
      facets,
      nextCursor: remaining.length > limit && last ? encodeCursor(last.key) : null,
    };
  }

  /**
   * The one calculation of compatibility (`CompatibilityEvaluator`) for the
   * found items, in the order given. Many found items of one subcategory
   * are worked out by the subcategory (the list's way, 4.29 I290: a
   * subcategory in one statement is tens of times faster than thousands of
   * ids) and kept for the found ones; the rest — by their ids. The same
   * result either way.
   */
  private async evaluate(
    vehicle: Awaited<ReturnType<ShowcaseService["vehicle"]>>,
    itemIds: Iterable<string>,
    rowOf: ReadonlyMap<string, CatalogItemRow>,
    executor: DbExecutor,
  ) {
    const ids = [...itemIds];
    const bySubcategory = new Map<string, string[]>();
    for (const id of ids) {
      const categoryId = rowOf.get(id)!.categoryId;
      bySubcategory.set(categoryId, [...(bySubcategory.get(categoryId) ?? []), id]);
    }
    const wanted = new Set(ids);
    const byIds: string[] = [];
    const results: Awaited<ReturnType<CompatibilityEvaluator["evaluate"]>> = [];
    for (const [categoryId, members] of bySubcategory) {
      if (members.length < EVALUATE_BY_SUBCATEGORY_FROM) {
        byIds.push(...members);
        continue;
      }
      const whole = await this.compatibility.evaluate(
        vehicle,
        { kind: "category", categoryId },
        executor,
      );
      results.push(...whole.filter((result) => wanted.has(result.itemId)));
    }
    if (byIds.length > 0) {
      results.push(
        ...(await this.compatibility.evaluate(
          vehicle,
          { kind: "items", itemIds: byIds },
          executor,
        )),
      );
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return results.sort((a, b) => order.get(a.itemId)! - order.get(b.itemId)!);
  }

  // -------------------------------------------------------------- facets

  /** The subcategories of the listed items, most items first (a chip each). */
  private async categoryFacets(
    executor: DbExecutor,
    listed: readonly { itemId: string }[],
    rowOf: ReadonlyMap<string, CatalogItemRow>,
    lang: CatalogLanguage,
  ): Promise<CatalogSearchCategoryFacet[]> {
    const counts = new Map<string, number>();
    for (const { itemId } of listed) {
      const categoryId = rowOf.get(itemId)!.categoryId;
      counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
    }
    if (counts.size === 0) {
      return [];
    }
    const rows = await executor.execute<{
      id: string;
      kind: "goods" | "services";
      parent_id: string | null;
      sort: number;
    }>(sql`
      SELECT c.id, c.kind, c.parent_id, c.sort FROM category c
      WHERE c.id = ANY(${uuids([...counts.keys()])})
    `);
    const texts = await loadTexts(executor, "category", [
      ...new Set(rows.rows.flatMap((row) => (row.parent_id ? [row.id, row.parent_id] : [row.id]))),
    ]);
    return rows.rows
      .map((row) => ({
        row,
        facet: {
          id: row.id,
          kind: row.kind,
          name: localize(textsOf(texts, row.id, "name"), lang) ?? NO_NAME,
          parentName: row.parent_id ? localize(textsOf(texts, row.parent_id, "name"), lang) : null,
          count: counts.get(row.id) ?? 0,
        },
      }))
      .sort(
        (a, b) =>
          b.facet.count - a.facet.count ||
          a.row.sort - b.row.sort ||
          a.row.id.localeCompare(b.row.id),
      )
      .map(({ facet }) => facet);
  }

  /**
   * The results in the chosen subcategory with its filters (M-CAT-03, as
   * the list applies them): the offer filters, the brands, the
   * characteristics (`attributeFilter` — the list's own). The brands are
   * counted before the filters (as the list's `brands`); a characteristic's
   * values over the items that pass every other filter.
   */
  private async narrow(
    executor: DbExecutor,
    query: CatalogSearchQuery,
    cityId: string | null,
    itemIds: readonly string[],
    rowOf: ReadonlyMap<string, CatalogItemRow>,
    offersOf: ReadonlyMap<string, VisibleOffer[]>,
  ): Promise<{
    itemIds: string[];
    offersOf: Map<string, VisibleOffer[]>;
    brands: CatalogSearchFacets["brands"];
    attributes: CatalogSearchAttributeFacet[];
  }> {
    const categoryId = query.categoryId!;
    const inCategory = itemIds.filter((id) => rowOf.get(id)!.categoryId === categoryId);
    const brands = await this.showcase.brandFacet(
      executor,
      inCategory.map((id) => rowOf.get(id)!),
    );
    const offerFilter = offerFilterOf(query, cityId);
    const brandFilter = query.brandIds ? new Set(query.brandIds) : null;
    const passingOffers = new Map<string, VisibleOffer[]>();
    for (const id of inCategory) {
      const row = rowOf.get(id)!;
      if (brandFilter && (row.brandId === null || !brandFilter.has(row.brandId))) {
        continue;
      }
      const passing = (offersOf.get(id) ?? []).filter(offerFilter);
      if (passing.length > 0) {
        passingOffers.set(id, passing);
      }
    }
    const base = [...passingOffers.keys()];
    const filters = query.attributes ?? [];
    const passAll = await this.showcase.attributeFilter(executor, categoryId, filters, base);
    const attributes = await this.attributeFacets(executor, categoryId, filters, base, passAll);
    const kept = passAll ? base.filter((id) => passAll.has(id)) : base;
    return {
      itemIds: kept,
      offersOf: new Map(kept.map((id) => [id, passingOffers.get(id)!])),
      brands,
      attributes,
    };
  }

  private async attributeFacets(
    executor: DbExecutor,
    categoryId: string,
    filters: NonNullable<CatalogSearchQuery["attributes"]>,
    base: readonly string[],
    passAll: Set<string> | null,
  ): Promise<CatalogSearchAttributeFacet[]> {
    const attributes = await executor.execute<{ id: string; value_type: "enum" | "bool" }>(sql`
      SELECT a.id, a.value_type FROM attribute a
      WHERE a.category_id = ${categoryId} AND a.status = 'active' AND a.is_filterable
        AND a.value_type IN ('enum', 'bool')
      ORDER BY a.sort, a.code
    `);
    if (attributes.rows.length === 0 || base.length === 0) {
      return attributes.rows.map((row) => ({ attributeId: row.id, options: [], values: [] }));
    }
    const values = await executor.execute<{
      item_id: string;
      attribute_id: string;
      option_id: string | null;
      value_bool: boolean | null;
    }>(sql`
      SELECT item_id, attribute_id, value_option_id AS option_id, value_bool
      FROM item_attribute_value
      WHERE item_id = ANY(${uuids(base)})
        AND attribute_id = ANY(${uuids(attributes.rows.map((row) => row.id))})
    `);
    const facets: CatalogSearchAttributeFacet[] = [];
    for (const attribute of attributes.rows) {
      // The items that pass every filter but this attribute's own.
      const others = filters.filter((filter) => filter.attributeId !== attribute.id);
      const pass =
        others.length === filters.length
          ? passAll
          : await this.showcase.attributeFilter(executor, categoryId, others, base);
      const options = new Map<string, number>();
      const booleans = new Map<boolean, number>();
      for (const row of values.rows) {
        if (row.attribute_id !== attribute.id || (pass && !pass.has(row.item_id))) {
          continue;
        }
        if (attribute.value_type === "enum" && row.option_id) {
          options.set(row.option_id, (options.get(row.option_id) ?? 0) + 1);
        } else if (attribute.value_type === "bool" && row.value_bool !== null) {
          booleans.set(row.value_bool, (booleans.get(row.value_bool) ?? 0) + 1);
        }
      }
      facets.push({
        attributeId: attribute.id,
        options: [...options.entries()].map(([optionId, count]) => ({ optionId, count })),
        values: [...booleans.entries()].map(([value, count]) => ({ value, count })),
      });
    }
    return facets;
  }

  // ------------------------------------------------------------ article

  /**
   * Active items of visible subcategories whose article is this one, and
   * the offers a supplier gave this article (`offer.supplier_sku`, in the
   * same normal form as `normalizeArticle`): those count only while visible.
   */
  private async articleMatches(
    executor: DbExecutor,
    article: string,
  ): Promise<{ itemIds: Set<string>; offerIds: Set<string>; offerItemIds: string[] }> {
    const [items, offers] = await Promise.all([
      executor.execute<{ id: string }>(sql`
        SELECT i.id FROM catalog_item i
        JOIN category c ON c.id = i.category_id
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE i.article_norm = ${article} AND i.status = 'active'
          AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'
      `),
      executor.execute<{ id: string; item_id: string }>(sql`
        SELECT o.id, o.item_id FROM offer o
        WHERE o.supplier_sku IS NOT NULL
          AND regexp_replace(upper(o.supplier_sku), '[^A-Z0-9Ѐ-ӿ]+', '', 'g') = ${article}
      `),
    ]);
    return {
      itemIds: new Set(items.rows.map((row) => row.id)),
      offerIds: new Set(offers.rows.map((row) => row.id)),
      offerItemIds: offers.rows.map((row) => row.item_id),
    };
  }

  // --------------------------------------------------------------- text

  /**
   * The items the search index finds for the variants (TASK-045), and how
   * each matched by its texts: exact or partial (the domain's
   * `matchSearchDocuments`), or only with a typo forgiven — then the reading
   * of T-CAT-08 is worked out from its texts (`searchReading`). `null` — no
   * index, or it did not answer: the database searches instead.
   */
  private async indexMatches(
    executor: DbExecutor,
    variants: readonly SearchVariant[],
    cityId: string | null,
  ): Promise<Map<string, TextMatch> | null> {
    if (!this.index.enabled) {
      return null;
    }
    const candidates = await this.index.find({
      variants: variants.map((variant) => variant.key),
      cityId,
    });
    if (candidates === null) {
      return null;
    }
    const matches = new Map<string, TextMatch>();
    if (candidates.size === 0) {
      return matches;
    }
    const documents = await this.documentsOf(executor, [...candidates.keys()]);
    for (const [itemId, candidate] of candidates) {
      const docs = documents.get(itemId) ?? [];
      const best = matchSearchDocuments(variants, docs);
      const facts = { relevance: candidate.score, popularity: candidate.popularity };
      if (best) {
        const asTyped =
          best.variant === 0 || matchSearchDocuments(variants.slice(0, 1), docs) !== null;
        matches.set(itemId, {
          ...facts,
          match: best.match,
          own: best.own,
          reading: asTyped ? null : variants[best.variant]!.text,
        });
      } else {
        // Only a forgiven typo found it — or the index dropped words: it
        // stays only if a word of the query is really in its texts.
        const reading = searchReading(
          variants[candidate.variant] ?? variants[0]!,
          docs.map((doc) => doc.text),
        );
        if (reading.kept > 0) {
          matches.set(itemId, { ...facts, match: "typo", own: false, reading: reading.text });
        }
      }
    }
    return matches;
  }

  /** The items a reading of the query matches, by `matchSearchDocuments` (without the index). */
  private async textMatches(
    executor: DbExecutor,
    variants: readonly SearchVariant[],
  ): Promise<Map<string, TextMatch>> {
    const matches = new Map<string, TextMatch>();
    // A text of an item matching a variant has its longest stem in one of
    // its texts: the candidates are found by that, through the index.
    const leading = leadingStems(variants);
    if (leading.length === 0) {
      return matches;
    }
    const nameKey = sql`(' ' || search_key(t.text))`;
    const candidates = await executor.execute<{ id: string }>(sql`
      WITH cats AS (
        SELECT t.entity_id AS id FROM translation t
        WHERE t.entity_type = 'category' AND t.field = 'name' AND ${beginsAnyWord(nameKey, leading)}
        UNION
        SELECT s.category_id FROM item_search_synonym s
        WHERE s.category_id IS NOT NULL AND ${beginsAnyWord(sql`(' ' || s.term_key)`, leading)}
      )
      SELECT i.id FROM catalog_item i
      JOIN category c ON c.id = i.category_id
      LEFT JOIN category p ON p.id = c.parent_id
      WHERE i.status = 'active' AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'
        AND (
          i.id IN (
            SELECT t.entity_id FROM translation t
            WHERE t.entity_type = 'catalog_item' AND t.field = 'name'
              AND ${beginsAnyWord(nameKey, leading)}
          )
          OR i.id IN (
            SELECT s.item_id FROM item_search_synonym s
            WHERE s.item_id IS NOT NULL AND ${beginsAnyWord(sql`(' ' || s.term_key)`, leading)}
          )
          OR i.brand_id IN (
            SELECT b.brand_id FROM brand_spelling b
            WHERE ${beginsAnyWord(sql`(' ' || search_key(b.text))`, leading)}
          )
          OR c.id IN (SELECT id FROM cats)
          OR c.parent_id IN (SELECT id FROM cats)
        )
      LIMIT ${CANDIDATES_MAX}
    `);
    const ids = candidates.rows.map((row) => row.id);
    if (ids.length === 0) {
      return matches;
    }
    for (const [itemId, docs] of await this.documentsOf(executor, ids)) {
      const best = matchSearchDocuments(variants, docs);
      if (best) {
        const asTyped =
          best.variant === 0 || matchSearchDocuments(variants.slice(0, 1), docs) !== null;
        matches.set(itemId, {
          match: best.match,
          own: best.own,
          relevance: 0,
          popularity: 0,
          reading: asTyped ? null : variants[best.variant]!.text,
        });
      }
    }
    return matches;
  }

  /**
   * The texts of items a query is compared with: their names (kk/ru/en) and
   * synonyms (`own`), the names and synonyms of their subcategory and node,
   * the spellings of their brand.
   */
  private async documentsOf(
    executor: DbExecutor,
    ids: readonly string[],
  ): Promise<Map<string, TextDocument[]>> {
    const documents = await executor.execute<{ item_id: string; text: string; own: boolean }>(sql`
      SELECT t.entity_id AS item_id, t.text, true AS own FROM translation t
      WHERE t.entity_type = 'catalog_item' AND t.field = 'name' AND t.entity_id = ANY(${uuids(ids)})
      UNION ALL
      SELECT s.item_id, s.term, true FROM item_search_synonym s
      WHERE s.item_id = ANY(${uuids(ids)})
      UNION ALL
      SELECT i.id, t.text, false FROM catalog_item i
      JOIN category c ON c.id = i.category_id
      JOIN translation t ON t.entity_type = 'category' AND t.field = 'name'
        AND (t.entity_id = c.id OR t.entity_id = c.parent_id)
      WHERE i.id = ANY(${uuids(ids)})
      UNION ALL
      SELECT i.id, s.term, false FROM catalog_item i
      JOIN category c ON c.id = i.category_id
      JOIN item_search_synonym s ON s.category_id = c.id OR s.category_id = c.parent_id
      WHERE i.id = ANY(${uuids(ids)})
      UNION ALL
      SELECT i.id, b.text, false FROM catalog_item i
      JOIN brand_spelling b ON b.brand_id = i.brand_id
      WHERE i.id = ANY(${uuids(ids)})
    `);
    const byItem = new Map<string, TextDocument[]>();
    for (const row of documents.rows) {
      const list = byItem.get(row.item_id) ?? [];
      list.push({ key: searchKey(row.text), own: row.own, text: row.text });
      byItem.set(row.item_id, list);
    }
    return byItem;
  }

  /**
   * A reading of the query with its words corrected to the most similar
   * words of the catalog (`pg_trgm.similarity` of the keys, at least
   * `CORRECTION_SIMILARITY_MIN`): «лолодки» — «колодки». Of the variants,
   * the one whose words are all corrected the most surely; `null` — none.
   */
  private async correction(
    executor: DbExecutor,
    variants: readonly SearchVariant[],
  ): Promise<SearchVariant | null> {
    const asked = [
      ...new Set(
        variants.flatMap((variant) =>
          variant.key.split(" ").filter((word) => word.length >= CORRECTION_WORD_MIN),
        ),
      ),
    ];
    if (asked.length === 0) {
      return null;
    }
    const best = await executor.execute<{ asked: string; word: string; score: number }>(sql`
      WITH vocabulary AS (
        SELECT DISTINCT w FROM (
          SELECT regexp_split_to_table(search_text(t.text), ' ') AS w FROM translation t
          WHERE t.field = 'name' AND t.entity_type IN ('catalog_item', 'category')
          UNION ALL
          SELECT regexp_split_to_table(search_text(s.term), ' ') FROM item_search_synonym s
          UNION ALL
          SELECT regexp_split_to_table(search_text(b.text), ' ') FROM brand_spelling b
        ) words
        WHERE char_length(w) >= ${CORRECTION_WORD_MIN}
      )
      SELECT a.asked, top.w AS word, top.score
      FROM unnest(${`{${asked.join(",")}}`}::text[]) AS a(asked)
      CROSS JOIN LATERAL (
        SELECT v.w, similarity(translate(v.w, 'әғқңөұүһі', 'агкноуухи'), a.asked) AS score
        FROM vocabulary v
        ORDER BY score DESC, v.w
        LIMIT 1
      ) top
    `);
    const bestOf = new Map(best.rows.map((row) => [row.asked, row]));
    let chosen: { text: string; score: number } | null = null;
    for (const variant of variants) {
      let score = 0;
      let counted = 0;
      const words: string[] = [];
      let complete = true;
      for (const word of variant.key.split(" ")) {
        if (word.length < CORRECTION_WORD_MIN || /^\d+$/.test(word)) {
          words.push(word);
          continue;
        }
        const top = bestOf.get(word);
        if (!top || Number(top.score) < CORRECTION_SIMILARITY_MIN) {
          complete = false;
          break;
        }
        words.push(top.word);
        score += Number(top.score);
        counted += 1;
      }
      if (!complete || counted === 0) {
        continue;
      }
      const mean = score / counted;
      if (chosen === null || mean > chosen.score) {
        chosen = { text: words.join(" "), score: mean };
      }
    }
    if (!chosen) {
      return null;
    }
    const corrected = searchVariant(chosen.text);
    return corrected && !variants.some((variant) => variant.key === corrected.key)
      ? corrected
      : null;
  }

  // ---------------------------------------------------------- categories

  /**
   * Categories whose own names or synonyms match the reading of the query
   * (at most three): exact first, subcategories before nodes. Only active
   * ones under an active node — those the catalog opens.
   */
  private async categories(
    executor: DbExecutor,
    variants: readonly SearchVariant[],
    lang: CatalogLanguage,
  ): Promise<CatalogSearchCategory[]> {
    const leading = leadingStems(variants);
    if (leading.length === 0) {
      return [];
    }
    const rows = await executor.execute<{
      id: string;
      level: 1 | 2;
      kind: "goods" | "services";
      parent_id: string | null;
      sort: number;
      text: string;
    }>(sql`
      WITH visible AS (
        SELECT c.id, c.level, c.kind, c.parent_id, c.sort FROM category c
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE c.status = 'active' AND coalesce(p.status, 'active') = 'active'
      ),
      matched AS (
        SELECT t.entity_id AS id FROM translation t
        WHERE t.entity_type = 'category' AND t.field = 'name'
          AND ${beginsAnyWord(sql`(' ' || search_key(t.text))`, leading)}
        UNION
        SELECT s.category_id FROM item_search_synonym s
        WHERE s.category_id IS NOT NULL AND ${beginsAnyWord(sql`(' ' || s.term_key)`, leading)}
      )
      SELECT v.id, v.level, v.kind, v.parent_id, v.sort, t.text FROM visible v
      JOIN translation t ON t.entity_type = 'category' AND t.field = 'name' AND t.entity_id = v.id
      WHERE v.id IN (SELECT id FROM matched)
      UNION ALL
      SELECT v.id, v.level, v.kind, v.parent_id, v.sort, s.term FROM visible v
      JOIN item_search_synonym s ON s.category_id = v.id
      WHERE v.id IN (SELECT id FROM matched)
    `);
    const docs = new Map<string, { row: (typeof rows.rows)[number]; docs: SearchDocument[] }>();
    for (const row of rows.rows) {
      const entry = docs.get(row.id) ?? { row, docs: [] };
      entry.docs.push({ key: searchKey(row.text), own: true });
      docs.set(row.id, entry);
    }
    const ranked = [...docs.values()]
      .flatMap(({ row, docs: list }) => {
        const best = matchSearchDocuments(variants, list);
        return best ? [{ row, rank: best.match === "exact" ? 0 : 1 }] : [];
      })
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          b.row.level - a.row.level ||
          a.row.sort - b.row.sort ||
          a.row.id.localeCompare(b.row.id),
      )
      .slice(0, CATALOG_SEARCH_CATEGORIES_MAX);
    if (ranked.length === 0) {
      return [];
    }
    const texts = await loadTexts(executor, "category", [
      ...new Set(ranked.flatMap(({ row }) => (row.parent_id ? [row.id, row.parent_id] : [row.id]))),
    ]);
    return ranked.map(({ row }) => ({
      id: row.id,
      level: Number(row.level) === 1 ? 1 : 2,
      kind: row.kind,
      name: localize(textsOf(texts, row.id, "name"), lang) ?? NO_NAME,
      parentName: row.parent_id ? localize(textsOf(texts, row.parent_id, "name"), lang) : null,
    }));
  }
}
