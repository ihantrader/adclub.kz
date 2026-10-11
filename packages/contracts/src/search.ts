import { z } from "zod";
import { catalogLanguageSchema, categoryKindSchema, localizedTextSchema } from "./catalog";
import { resolvedCompatibilityVehicleSchema } from "./compatibility";
import {
  SHOWCASE_PAGE_MAX_SIZE,
  showcaseBrandSchema,
  showcaseCitySchema,
  showcaseListItemSchema,
  showcaseListQuerySchema,
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
  /**
   * The chip of a subcategory (TASK-045): only the found items of it. With
   * it, the filters of M-CAT-03 apply as in the list of that subcategory —
   * `attributes`, `brandIds`, `availability`, `receiving`, `onlyMyCity`
   * (without it they are ignored) — and the answer carries the facets of
   * its characteristics and brands.
   */
  categoryId: z.uuid().optional(),
  onlyMyCity: showcaseListQuerySchema.shape.onlyMyCity,
  availability: showcaseListQuerySchema.shape.availability,
  receiving: showcaseListQuerySchema.shape.receiving,
  brandIds: showcaseListQuerySchema.shape.brandIds,
  attributes: showcaseListQuerySchema.shape.attributes,
  limit: z.coerce.number().int().min(1).max(SHOWCASE_PAGE_MAX_SIZE).optional(),
  cursor: z.string().min(1).max(500).optional(),
});

export type CatalogSearchQuery = z.infer<typeof catalogSearchQuerySchema>;

/**
 * How an item was found: `article` — its article, or the article a supplier
 * gave its visible offer, is the query (the block «по артикулу», always
 * first); `exact` — its name or synonym, or the name or synonym of its
 * category, or its brand, is the query; `partial` — every word of the query
 * begins a word of its texts — or, with the search index (TASK-045), the
 * words match with a typo forgiven.
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

/** A subcategory of the found items and how many of them are in it (a chip of M-CAT-04). */
export const catalogSearchCategoryFacetSchema = z.object({
  id: z.uuid(),
  kind: categoryKindSchema,
  name: localizedTextSchema,
  /** The node it is in. */
  parentName: localizedTextSchema.nullable(),
  count: z.number().int(),
});

export type CatalogSearchCategoryFacet = z.infer<typeof catalogSearchCategoryFacetSchema>;

/**
 * How many of the found items of the chosen subcategory have each value of
 * a filterable characteristic: a list — by option, yes/no — by value
 * (TASK-045). A count is of the items that pass every other filter (the
 * filter of the characteristic itself left out, so choosing «5W-30» still
 * tells how many «5W-40» would add). Numbers have no counts.
 */
export const catalogSearchAttributeFacetSchema = z.object({
  attributeId: z.uuid(),
  options: z.array(z.object({ optionId: z.uuid(), count: z.number().int() })),
  values: z.array(z.object({ value: z.boolean(), count: z.number().int() })),
});

export type CatalogSearchAttributeFacet = z.infer<typeof catalogSearchAttributeFacetSchema>;

/**
 * The facets of the results (TASK-045; ARCHITECTURE 4.65). Every number is
 * exact: of the items the search really shows — after the showcase rule,
 * the city of services and D-029 — never of what the index merely found.
 */
export const catalogSearchFacetsSchema = z.object({
  /** The subcategories of all found items (before `categoryId`), most items first. */
  categories: z.array(catalogSearchCategoryFacetSchema),
  /**
   * With `categoryId`: the brands of its found items before the other
   * filters (as the list's `brands`); without it — empty.
   */
  brands: z.array(showcaseBrandSchema.extend({ count: z.number().int() })),
  /** With `categoryId`: its filterable characteristics; without it — empty. */
  attributes: z.array(catalogSearchAttributeFacetSchema),
});

export type CatalogSearchFacets = z.infer<typeof catalogSearchFacetsSchema>;

export const catalogSearchResponseSchema = z.object({
  language: catalogLanguageSchema,
  /** The query as read: lower case, signs as spaces («04465 0k090»). */
  query: z.string(),
  /**
   * T-CAT-08 «Показаны результаты по «{запрос}»»: the results are for this
   * reading of the query — another layout, a transliteration, a corrected
   * word (a typo the search forgave, TASK-045) or without a word nothing
   * has — because the query as typed found nothing as it is; `null` — as
   * typed.
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
  /** The chips of subcategories and the filters of the chosen one (TASK-045). */
  facets: catalogSearchFacetsSchema,
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
