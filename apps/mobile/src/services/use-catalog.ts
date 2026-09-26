import type {
  CategoryAttributesResponse,
  CategoryTreeResponse,
  ShowcaseItemResponse,
  ShowcaseItemQuery,
  ShowcaseListItem,
  ShowcaseListResponse,
  ShowcaseListSort,
} from "@adclub/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { FilterQuery } from "../catalog/filters";
import type { VehicleQuery } from "../catalog/vehicle-query";
import { useLanguage } from "../state/language";
import { apiClient } from "./api";
import { failureOf, useRequest, type RequestFailure, type RequestState } from "./use-request";

/**
 * The catalog for users (TASK-020): the category tree, the description of a
 * category's filters, a page of a subcategory and the card of an item.
 *
 * An answer to a guest is cacheable for a minute (`CATALOG_CLIENT_CACHE_SECONDS`,
 * ARCHITECTURE 4.15, 4.29), so the app reloads anything older than that when
 * the user comes back to a screen: a price that has changed must not stay on
 * screen just because the phone was in a pocket.
 */
export const CATALOG_STALE_MS = 60_000;

export function useCategoryTree(): RequestState<CategoryTreeResponse> {
  const { lang } = useLanguage();
  return useRequest(`categories:${lang}`, (signal) => apiClient.getCatalogCategories({ signal }), {
    staleAfterMs: CATALOG_STALE_MS,
  });
}

export function useCategoryAttributes(
  categoryId: string | null,
): RequestState<CategoryAttributesResponse> {
  const { lang } = useLanguage();
  return useRequest(categoryId ? `attributes:${categoryId}:${lang}` : null, (signal) =>
    apiClient.getCatalogCategoryAttributes({ categoryId: categoryId ?? "" }, { signal }),
  );
}

/**
 * How many items a set of filters would leave («Показать N позиций»,
 * M-CAT-03). The number is the server's `total` — the app never counts
 * anything itself — and one item is asked for, not a page.
 */
export function useShowcaseTotal(options: {
  categoryId: string;
  cityId?: string;
  vehicle: VehicleQuery;
  filters: FilterQuery;
  enabled: boolean;
}): RequestState<ShowcaseListResponse> {
  const { lang } = useLanguage();
  const query = {
    ...(options.cityId ? { cityId: options.cityId } : {}),
    ...options.vehicle,
    ...options.filters,
    limit: 1,
  };
  return useRequest(
    options.enabled ? `total:${options.categoryId}:${lang}:${JSON.stringify(query)}` : null,
    (signal) => apiClient.getShowcaseItems({ categoryId: options.categoryId }, { signal, query }),
  );
}

/** Waits for the user to stop changing something before asking the server. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface ShowcaseItemOptions {
  cityId?: string;
  vehicle: VehicleQuery;
  sort: NonNullable<ShowcaseItemQuery["sort"]>;
}

export function useShowcaseItem(
  itemId: string,
  { cityId, vehicle, sort }: ShowcaseItemOptions,
): RequestState<ShowcaseItemResponse> {
  const { lang } = useLanguage();
  const query = { ...(cityId ? { cityId } : {}), ...vehicle, sort };
  return useRequest(
    `item:${itemId}:${lang}:${JSON.stringify(query)}`,
    (signal) => apiClient.getShowcaseItem({ itemId }, { signal, query }),
    { staleAfterMs: CATALOG_STALE_MS },
  );
}

export interface ShowcaseListOptions {
  categoryId: string;
  cityId?: string;
  vehicle: VehicleQuery;
  filters: FilterQuery;
  sort: ShowcaseListSort;
}

export interface ShowcaseListState {
  status: "loading" | "ready" | "error";
  failure: RequestFailure | null;
  /** The first page's answer: the category, the car, the totals, the brands. */
  page: ShowcaseListResponse | null;
  /** Every item loaded so far, in the server's order, without repeats. */
  items: ShowcaseListItem[];
  /** A page is being loaded on top of the ones already shown. */
  loadingMore: boolean;
  /** `true` while the whole list is being replaced (a new sort, a new filter). */
  refreshing: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  reloadIfStale: () => void;
}

/**
 * A subcategory page by page (M-CAT-02). Paging is the server's cursor and
 * nothing else: the next page is `cursor = nextCursor` with **the same**
 * query, so a list never loses or repeats an item while offers change
 * underneath it (ARCHITECTURE 4.30 I301). Changing the sort or a filter
 * starts a new list rather than appending to the old one, and a page that
 * was in flight when that happened is thrown away.
 */
export function useShowcaseList({
  categoryId,
  cityId,
  vehicle,
  filters,
  sort,
}: ShowcaseListOptions): ShowcaseListState {
  const { lang } = useLanguage();
  const baseQuery = { ...(cityId ? { cityId } : {}), ...vehicle, ...filters, sort };
  const key = `${categoryId}:${lang}:${JSON.stringify(baseQuery)}`;

  const [attempt, setAttempt] = useState(0);
  // What is on screen, tagged with the list it belongs to: a new key makes
  // the old content stale by itself, so nothing has to be cleared when a
  // request starts (which an effect may not do synchronously anyway).
  const [state, setState] = useState<{
    key: string;
    page: ShowcaseListResponse | null;
    items: ShowcaseListItem[];
    cursor: string | null;
    failure: RequestFailure | null;
    loadingMore: boolean;
  }>({ key: "", page: null, items: [], cursor: null, failure: null, loadingMore: false });
  /** The request whose answer has arrived; anything else is still in flight. */
  const [settled, setSettled] = useState<string | null>(null);
  const loadedAt = useRef(0);
  const query = useRef(baseQuery);
  useEffect(() => {
    query.current = baseQuery;
  });

  const request = `${key}#${attempt}`;

  // The first page: a new key replaces the whole list.
  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .getShowcaseItems({ categoryId }, { signal: controller.signal, query: query.current })
      .then((response) => {
        if (controller.signal.aborted) return;
        loadedAt.current = Date.now();
        setState({
          key,
          page: response,
          items: response.items,
          cursor: response.nextCursor,
          failure: null,
          loadingMore: false,
        });
        setSettled(request);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        loadedAt.current = Date.now();
        setState((previous) => ({
          // Reloading the same list keeps it on screen (SCREENS 2.1).
          ...(previous.key === key ? previous : { page: null, items: [], cursor: null }),
          key,
          failure: failureOf(error),
          loadingMore: false,
        }));
        setSettled(request);
      });
    return () => controller.abort();
    // `key` and `categoryId` only ever change together with `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const loadMore = useCallback(() => {
    setState((previous) => {
      if (previous.cursor === null || previous.loadingMore) return previous;
      const cursor = previous.cursor;
      const listKey = previous.key;
      void apiClient
        .getShowcaseItems({ categoryId }, { query: { ...query.current, cursor } })
        .then((response) => {
          setState((current) => {
            // The list was replaced while the page was in flight.
            if (current.key !== listKey || current.cursor !== cursor) return current;
            const known = new Set(current.items.map((item) => item.id));
            return {
              ...current,
              items: [...current.items, ...response.items.filter((item) => !known.has(item.id))],
              cursor: response.nextCursor,
              loadingMore: false,
            };
          });
        })
        .catch((error: unknown) => {
          setState((current) =>
            current.key === listKey
              ? { ...current, loadingMore: false, failure: failureOf(error) }
              : current,
          );
        });
      return { ...previous, loadingMore: true, failure: null };
    });
  }, [categoryId]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const reloadIfStale = useCallback(() => {
    if (loadedAt.current !== 0 && Date.now() - loadedAt.current >= CATALOG_STALE_MS) reload();
  }, [reload]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") reloadIfStale();
    });
    return () => subscription.remove();
  }, [reloadIfStale]);

  const fresh = state.key === key;
  const page = fresh ? state.page : null;
  const failure = fresh ? state.failure : null;
  const pending = settled !== request;

  return {
    status: page !== null ? "ready" : pending ? "loading" : failure ? "error" : "loading",
    failure,
    page,
    items: fresh ? state.items : [],
    loadingMore: state.loadingMore,
    refreshing: pending && page !== null,
    hasMore: fresh && state.cursor !== null,
    loadMore,
    reload,
    reloadIfStale,
  };
}
