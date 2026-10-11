import { Inject, Injectable } from "@nestjs/common";
import {
  CATALOG_SEARCH_CATEGORIES_MAX,
  SHOWCASE_PAGE_DEFAULT_SIZE,
  type CatalogLanguage,
  type CatalogSearchCategory,
  type CatalogSearchEmptyReason,
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
  searchKey,
  searchRankKey,
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
import { catalogItem, loadTexts, localize, textsOf } from "../catalog";
import { CompatibilityEvaluator } from "../compatibility";
import { groupByItem, offersInReach, visibleOffers, type VisibleOffer } from "./showcase-offers";
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

const uuids = (list: readonly string[]) => sql`${`{${list.join(",")}}`}::uuid[]`;

interface TextMatch {
  match: "exact" | "partial";
  own: boolean;
  /** The variant that matched best. */
  variant: number;
  /** The query as typed matched too (no T-CAT-08 for this item). */
  asTyped: boolean;
}

interface Found {
  itemId: string;
  match: SearchMatch;
  own: boolean;
  /** The text of the reading it was found by; `null` — as typed or by the article. */
  reading: string | null;
  offers: VisibleOffer[];
  key: SearchRankKey;
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
    key.length !== 5 ||
    !key.slice(0, 4).every((part) => typeof part === "number" && Number.isFinite(part)) ||
    typeof key[4] !== "string"
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

/**
 * The search of the catalog for users (TASK-044; ARCHITECTURE 10.2, 4.64;
 * SCREENS M-CAT-04). Until the search index (TASK-045) it works on
 * PostgreSQL:
 *
 * 1. the query is read by `@adclub/domain` — its variants (the layouts,
 *    the transliteration) and the article it may be;
 * 2. the article branch: `catalog_item.article_norm` and the supplier's own
 *    article of a visible offer equal to the article;
 * 3. the text branch: the items whose names (kk/ru/en), synonyms, the names
 *    and synonyms of their categories and the spellings of their brands
 *    match a variant (`matchSearchDocuments`) — the database picks the
 *    candidates by the beginnings of words, the domain decides;
 * 4. nothing matched — a word of the query is corrected to the most similar
 *    word of the catalog (`pg_trgm`), and the corrected reading is searched
 *    (T-CAT-08);
 * 5. what is shown is what the catalog would show, by its own functions and
 *    nothing else: the showcase rule and the receipt date (`visibleOffers`),
 *    a service only in the chosen city at the price for the car's model
 *    (`offersInReach`), D-029 (`CompatibilityEvaluator`, `listed`), what the
 *    viewer sees of a supplier (`showcase-visibility`, through the card);
 * 6. the one order — `searchRankKey` of the domain.
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

    // The reading of the query: its variants; nothing matched — a corrected one.
    let variants = searchVariants(query.q);
    let texts = await this.textMatches(executor, variants);
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
    const results =
      reachable.size === 0
        ? []
        : await this.compatibility.evaluate(
            vehicle,
            { kind: "items", itemIds: [...reachable.keys()] },
            executor,
          );
    const resultOf = new Map(results.map((result) => [result.itemId, result]));
    const found: Found[] = results
      .filter((result) => result.listed)
      .map((result) => {
        const { offers, match } = reachable.get(result.itemId)!;
        const text = texts.get(result.itemId);
        const summary = summarize(offers, cityId);
        const own = match === "article" ? true : (text?.own ?? false);
        return {
          itemId: result.itemId,
          match,
          own,
          reading:
            match === "article" || !text || text.asTyped ? null : variants[text.variant]!.text,
          offers,
          key: searchRankKey({
            match,
            own,
            inCity: summary.inCity,
            minPrice: summary.minPrice,
            id: result.itemId,
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
      ...new Set(page.map((entry) => rowOf.get(entry.itemId)!.categoryId)),
    ]);
    const items: CatalogSearchItem[] = page.map((entry) => {
      const row = rowOf.get(entry.itemId)!;
      return {
        ...described.get(entry.itemId)!,
        compatibility: resultOf.get(entry.itemId)!,
        offers: summarize(entry.offers, cityId),
        match: entry.match,
        category: {
          id: row.categoryId,
          kind: row.categoryKind,
          name: localize(textsOf(categoryTexts, row.categoryId, "name"), lang) ?? NO_NAME,
        },
      };
    });

    // T-CAT-08: the reading the results are for when the query as typed found
    // nothing of them (the first found by text tells which).
    const byText = found.filter((entry) => entry.match !== "article");
    const usedQuery =
      corrected ??
      (byText.length > 0 && byText.every((entry) => entry.reading !== null)
        ? byText[0]!.reading
        : null);
    const empty: CatalogSearchEmptyReason | null =
      found.length > 0
        ? null
        : (reachableAny || otherModels) && vehicle !== null
          ? "vehicle"
          : cityRequired
            ? "city_required"
            : "no_items";

    return {
      language: lang,
      query: normalizeSearchText(query.q),
      usedQuery,
      city: chosenCity,
      vehicle,
      viewer: describeViewer(viewer),
      items,
      total: found.length,
      empty,
      cityRequired,
      categories: await this.categories(executor, variants, lang),
      nextCursor: remaining.length > limit && last ? encodeCursor(last.key) : null,
    };
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

  /** The items a reading of the query matches, by `matchSearchDocuments`. */
  private async textMatches(
    executor: DbExecutor,
    variants: readonly SearchVariant[],
  ): Promise<Map<string, TextMatch>> {
    const matches = new Map<string, TextMatch>();
    if (variants.length === 0) {
      return matches;
    }
    // A text of an item matching a variant has its longest stem in one of
    // its texts: the candidates are found by that, through the index.
    const leading = [
      ...new Set(
        variants.flatMap((variant) =>
          variant.stems.length === 0
            ? []
            : [[...variant.stems].sort((a, b) => b.length - a.length)[0]!],
        ),
      ),
    ];
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
    const byItem = new Map<string, SearchDocument[]>();
    for (const row of documents.rows) {
      const list = byItem.get(row.item_id) ?? [];
      list.push({ key: searchKey(row.text), own: row.own });
      byItem.set(row.item_id, list);
    }
    for (const [itemId, docs] of byItem) {
      const best = matchSearchDocuments(variants, docs);
      if (best) {
        matches.set(itemId, {
          ...best,
          asTyped: best.variant === 0 || matchSearchDocuments(variants.slice(0, 1), docs) !== null,
        });
      }
    }
    return matches;
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
    const leading = [
      ...new Set(
        variants.flatMap((variant) =>
          variant.stems.length === 0
            ? []
            : [[...variant.stems].sort((a, b) => b.length - a.length)[0]!],
        ),
      ),
    ];
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
