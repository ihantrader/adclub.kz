import type { CatalogItemListQuery } from "@adclub/contracts";
import { routePaths, withQuery } from "../router";

/**
 * The filters of the items list (A-CAT-04; TASK-035) — in the address under
 * the very names of `GET /admin/catalog/items`, so a link of a home card
 * (`adminHomeCatalogFilters` of the contract) opens the list with exactly
 * the filters the server counted, and the list asks the server with them
 * unchanged. Unknown or malformed values are left out.
 */
export const ITEM_FILTER_KEYS = [
  "q",
  "categoryId",
  "brandId",
  "type",
  "status",
  "completeness",
  "sameProduct",
  "hasOffers",
  "withoutPhoto",
  "withoutCompatibility",
  "withoutTranslation",
] as const;

export type ItemFilterKey = (typeof ITEM_FILTER_KEYS)[number];

export type ItemFilters = Partial<Record<ItemFilterKey, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED: Record<ItemFilterKey, (value: string) => boolean> = {
  q: (value) => value.trim().length > 0 && value.length <= 200,
  categoryId: (value) => UUID.test(value),
  brandId: (value) => UUID.test(value),
  type: (value) => ["part", "generic", "service"].includes(value),
  status: (value) => ["draft", "active", "archived"].includes(value),
  completeness: (value) => ["complete", "incomplete"].includes(value),
  sameProduct: (value) => value === "matching",
  hasOffers: (value) => value === "true",
  withoutPhoto: (value) => value === "true",
  withoutCompatibility: (value) => value === "true",
  withoutTranslation: (value) => value === "true",
};

/** The filters of an address. */
export function itemFiltersOf(query: URLSearchParams): ItemFilters {
  const filters: ItemFilters = {};
  for (const key of ITEM_FILTER_KEYS) {
    const value = query.get(key);
    if (value !== null && ALLOWED[key](value)) filters[key] = value;
  }
  return filters;
}

/** The address of the list with these filters. */
export function itemsLink(filters: ItemFilters): string {
  return withQuery(routePaths.catalogItems, filters);
}

/** The query of `GET /admin/catalog/items` for these filters. */
export function listQueryOf(
  filters: ItemFilters,
  page: { limit: number; cursor?: string },
): CatalogItemListQuery {
  return { ...filters, ...page } as CatalogItemListQuery;
}

/** Whether any filter narrows the list. */
export function filtered(filters: ItemFilters): boolean {
  return Object.values(filters).some(Boolean);
}
