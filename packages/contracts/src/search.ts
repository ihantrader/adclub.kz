import { z } from "zod";
import { catalogLanguageSchema, categoryKindSchema, localizedTextSchema } from "./catalog";
import { resolvedCompatibilityVehicleSchema } from "./compatibility";
import {
  SHOWCASE_PAGE_MAX_SIZE,
  showcaseCitySchema,
  showcaseListItemSchema,
  showcaseVehicleQueryShape,
  showcaseViewerSchema,
} from "./showcase";

/**
 * The search of the catalog for users (PRODUCT 7, 8.1, 8.2; SCREENS M-CAT-04,
 * T-CAT-08; ARCHITECTURE 10.2, 4.64; TASK-044): an article, a name in any
 * language, a synonym, typed in the wrong layout or in transliteration.
 * Open to guests, as the catalog: it shows nothing the catalog would not —
 * only items with offers the viewer can get (services only in the chosen
 * city), and only what D-029 lets a list show for the car. The answer is
 * cached as the catalog's (`public, max-age=60` to a guest, `private,
 * no-store` to a session).
 */

/** The shortest query searched for (one letter — 400) and the longest (longer — 400). */
export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 100;

/** Categories suggested above the results. */
export const CATALOG_SEARCH_CATEGORIES_MAX = 3;

/**
 * `GET /catalog/search`. `q` — from two to a hundred characters (spaces at
 * the ends are not counted); `cityId` and the car — as in the list of a
 * subcategory; pages by `cursor` = `nextCursor` with the same query. The
 * suggestions while typing are the same route with a small `limit`.
 */
export const catalogSearchQuerySchema = z.object({
  q: z.string().trim().min(SEARCH_QUERY_MIN_LENGTH).max(SEARCH_QUERY_MAX_LENGTH),
  cityId: z.uuid().optional(),
  ...showcaseVehicleQueryShape,
  limit: z.coerce.number().int().min(1).max(SHOWCASE_PAGE_MAX_SIZE).optional(),
  cursor: z.string().min(1).max(500).optional(),
});

export type CatalogSearchQuery = z.infer<typeof catalogSearchQuerySchema>;

/**
 * How an item was found: `article` — its article, or the article a supplier
 * gave its visible offer, is the query (the block «по артикулу», always
 * first); `exact` — its name or synonym, or the name or synonym of its
 * category, or its brand, is the query; `partial` — every word of the query
 * begins a word of its texts.
 */
export const catalogSearchMatchSchema = z.enum(["article", "exact", "partial"]);

export type CatalogSearchMatch = z.infer<typeof catalogSearchMatchSchema>;

/** A found item: a row of M-CAT-02, how it was found and its subcategory. */
export const catalogSearchItemSchema = showcaseListItemSchema.extend({
  match: catalogSearchMatchSchema,
  category: z.object({
    id: z.uuid(),
    kind: categoryKindSchema,
    name: localizedTextSchema,
  }),
});

export type CatalogSearchItem = z.infer<typeof catalogSearchItemSchema>;

/**
 * A category whose name or synonym matches the query: a node (`level` 1,
 * opens its subcategories) or a subcategory (`level` 2, opens its list).
 */
export const catalogSearchCategorySchema = z.object({
  id: z.uuid(),
  level: z.union([z.literal(1), z.literal(2)]),
  kind: categoryKindSchema,
  name: localizedTextSchema,
  /** The node of a subcategory; `null` for a node. */
  parentName: localizedTextSchema.nullable(),
});

export type CatalogSearchCategory = z.infer<typeof catalogSearchCategorySchema>;

/**
 * Why nothing was found: `vehicle` — something matches, but nothing of it
 * fits this car (another car of the garage may have it); `city_required` —
 * only services match, and services are shown by the chosen city;
 * `no_items` — nothing matches that users can get.
 */
export const catalogSearchEmptyReasonSchema = z.enum(["vehicle", "city_required", "no_items"]);

export type CatalogSearchEmptyReason = z.infer<typeof catalogSearchEmptyReasonSchema>;

export const catalogSearchResponseSchema = z.object({
  language: catalogLanguageSchema,
  /** The query as read: lower case, signs as spaces («04465 0k090»). */
  query: z.string(),
  /**
   * T-CAT-08 «Показаны результаты по «{запрос}»»: the results are for this
   * reading of the query — another layout, a transliteration or a corrected
   * word — because the query as typed found nothing; `null` — as typed.
   */
  usedQuery: z.string().nullable(),
  city: showcaseCitySchema.nullable(),
  vehicle: resolvedCompatibilityVehicleSchema.nullable(),
  viewer: showcaseViewerSchema,
  /** In the one order of the search: the article first, then exact, then partial. */
  items: z.array(catalogSearchItemSchema),
  /** Every item found, over all pages. */
  total: z.number().int(),
  /** `null` unless `total` is 0. */
  empty: catalogSearchEmptyReasonSchema.nullable(),
  /**
   * Services match the query, but no city is chosen: they are not among the
   * results (services are only by a city) — «Выберите город».
   */
  cityRequired: z.boolean(),
  /** Categories that match the query, at most three. */
  categories: z.array(catalogSearchCategorySchema).max(CATALOG_SEARCH_CATEGORIES_MAX),
  nextCursor: z.string().nullable(),
});

export type CatalogSearchResponse = z.infer<typeof catalogSearchResponseSchema>;

// ---------------------------------------------------- synonyms (administrator)

/**
 * A synonym a user may search an item or a category by (ARCHITECTURE 10.2
 * п. 4; TASK-044): «колодки», «brake pads», «тежегіш қалыптары» for
 * «Тормозные колодки». A synonym of a category finds every item of it
 * (of a node — of its subcategories). `lang` — optional, for the
 * administrator's reading: a synonym is searched in every language.
 */
export const searchSynonymSchema = z.object({
  id: z.uuid(),
  term: z.string(),
  lang: catalogLanguageSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type SearchSynonym = z.infer<typeof searchSynonymSchema>;

export const searchSynonymListSchema = z.object({
  synonyms: z.array(searchSynonymSchema),
});

export type SearchSynonymList = z.infer<typeof searchSynonymListSchema>;

/**
 * A new synonym. Two synonyms of one item or category may not read the same
 * (case, `ё`, Kazakh letters and signs ignored) — 409
 * `CATALOG_SYNONYM_EXISTS`; one equal to a name is allowed.
 */
export const addSearchSynonymBodySchema = z.object({
  term: z.string().trim().min(SEARCH_QUERY_MIN_LENGTH).max(SEARCH_QUERY_MAX_LENGTH),
  lang: catalogLanguageSchema.nullable().optional(),
});

export type AddSearchSynonymBody = z.infer<typeof addSearchSynonymBodySchema>;

export const searchSynonymPathSchema = z.object({ synonymId: z.uuid() });

export type SearchSynonymPath = z.infer<typeof searchSynonymPathSchema>;

/** `details` of `CATALOG_SYNONYM_EXISTS`: the synonym that already reads the same. */
export const catalogSynonymExistsDetailsSchema = z.object({ existingSynonymId: z.uuid() });

export type CatalogSynonymExistsDetails = z.infer<typeof catalogSynonymExistsDetailsSchema>;
