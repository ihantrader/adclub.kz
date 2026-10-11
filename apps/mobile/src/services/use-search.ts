import type { CatalogSearchItem, CatalogSearchResponse } from "@adclub/contracts";
import { useCallback, useState } from "react";
import type { VehicleQuery } from "../catalog/vehicle-query";
import { useLanguage } from "../state/language";
import { apiClient } from "./api";
import { CATALOG_STALE_MS } from "./use-catalog";
import { failureOf, useRequest, type RequestFailure, type RequestState } from "./use-request";

/**
 * The search of the catalog (M-CAT-04, TASK-044): the suggestions while
 * typing and the results page by page — both the one route
 * `GET /catalog/search`, the suggestions a short page of it. Everything the
 * screen shows is the server's answer: what matches, in which order, for
 * which car and city, and the reading of the query («Показаны результаты
 * по …»). The app never filters or sorts anything itself.
 */

/** Items asked for while typing: the article first, a few positions. */
export const SUGGESTION_LIMIT = 5;

export interface SearchOptions {
  cityId?: string;
  vehicle: VehicleQuery;
}

function queryOf(q: string, { cityId, vehicle }: SearchOptions) {
  return { q, ...(cityId ? { cityId } : {}), ...vehicle };
}

/** The suggestions for a query typed (and settled); `null` — nothing to suggest yet. */
export function useSearchSuggestions(
  q: string | null,
  options: SearchOptions,
): RequestState<CatalogSearchResponse> {
  const { lang } = useLanguage();
  const query = q === null ? null : { ...queryOf(q, options), limit: SUGGESTION_LIMIT };
  const scope = `suggest:${lang}:${JSON.stringify({ ...options.vehicle, city: options.cityId })}`;
  return useRequest(
    query ? `${scope}:${query.q}` : null,
    (signal) => apiClient.searchCatalog({ signal, query: query! }),
    { scope },
  );
}

export interface SearchResultsState {
  first: RequestState<CatalogSearchResponse>;
  /** Every item loaded so far, in the server's order, without repeats. */
  items: CatalogSearchItem[];
  hasMore: boolean;
  loadingMore: boolean;
  /** The last page failed (the list stays). */
  moreFailure: RequestFailure | null;
  loadMore: () => void;
}

/**
 * The results of a query searched for, page by page: the next page is
 * `cursor = nextCursor` with the same query, so no item is lost or shown
 * twice while offers change. A new query, car or city starts anew.
 */
export function useSearchResults(q: string | null, options: SearchOptions): SearchResultsState {
  const { lang } = useLanguage();
  const query = q === null ? null : queryOf(q, options);
  const key = query ? `search:${lang}:${JSON.stringify(query)}` : null;
  const first = useRequest(key, (signal) => apiClient.searchCatalog({ signal, query: query! }), {
    staleAfterMs: CATALOG_STALE_MS,
  });
  const [more, setMore] = useState<{
    answer: CatalogSearchResponse | null;
    items: CatalogSearchItem[];
    cursor: string | null;
    loading: boolean;
    failure: RequestFailure | null;
  }>({ answer: null, items: [], cursor: null, loading: false, failure: null });

  // The pages belong to the first page they were loaded after: a new answer
  // (another query, a reload) leaves them behind by itself.
  const own = more.answer !== null && more.answer === first.data;
  const pages = own ? more.items : [];
  const cursor = own ? more.cursor : (first.data?.nextCursor ?? null);
  const known = new Set((first.data?.items ?? []).map((item) => item.id));
  const items = [...(first.data?.items ?? []), ...pages.filter((item) => !known.has(item.id))];

  const loadMore = useCallback(() => {
    const answer = first.data;
    if (!answer || !query || cursor === null || (own && more.loading)) return;
    setMore({ answer, items: own ? more.items : [], cursor, loading: true, failure: null });
    apiClient
      .searchCatalog({ query: { ...query, cursor } })
      .then((page) => {
        setMore((current) =>
          current.answer !== answer
            ? current
            : {
                answer,
                items: [...current.items, ...page.items],
                cursor: page.nextCursor,
                loading: false,
                failure: null,
              },
        );
      })
      .catch((error: unknown) => {
        setMore((current) =>
          current.answer !== answer
            ? current
            : { ...current, loading: false, failure: failureOf(error) },
        );
      });
  }, [first.data, query, cursor, own, more.loading, more.items]);

  return {
    first,
    items,
    hasMore: cursor !== null,
    loadingMore: own && more.loading,
    moreFailure: own ? more.failure : null,
    loadMore,
  };
}
