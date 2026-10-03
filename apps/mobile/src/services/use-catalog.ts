import {
  SHOWCASE_PAGE_DEFAULT_SIZE,
  SHOWCASE_PAGE_MAX_SIZE,
  type CategoryAttributesResponse,
  type CategoryTreeResponse,
  type ShowcaseItemResponse,
  type ShowcaseItemQuery,
  type ShowcaseListItem,
  type ShowcaseListResponse,
  type ShowcaseListSort,
} from "@adclub/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { FilterQuery } from "../catalog/filters";
import type { VehicleQuery } from "../catalog/vehicle-query";
import { useLanguage } from "../state/language";
import { sessionStore } from "../state/stores";
import { apiClient } from "./api";
import { createRequestCache } from "./request-cache";
import { loadRows } from "./showcase-rows";
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

/**
 * The tree is read by the main screen and by every node opened from it: a
 * screen that opens within the minute starts with the answer the previous one
 * loaded — no skeleton while the platform is sliding it in — and reloads it
 * by the same rule when it is older (ARCHITECTURE 4.39).
 */
const treeAnswers = createRequestCache(CATALOG_STALE_MS);

export function useCategoryTree(): RequestState<CategoryTreeResponse> {
  const { lang } = useLanguage();
  return useRequest(`categories:${lang}`, (signal) => apiClient.getCatalogCategories({ signal }), {
    staleAfterMs: CATALOG_STALE_MS,
    cache: treeAnswers,
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
  // The scope is what the number is about — the category for this car and
  // city; the filters are what changes it. The last number stays on the
  // button while the next one is asked for (and while the sheet is not open),
  // so «Показать N позиций» does not flicker back to «Фильтры» on every tap.
  const scope = `total:${options.categoryId}:${lang}:${JSON.stringify(scopeQuery(options))}`;
  return useRequest(
    options.enabled ? `${scope}:${JSON.stringify(query)}` : null,
    (signal) => apiClient.getShowcaseItems({ categoryId: options.categoryId }, { signal, query }),
    { scope },
  );
}

/** The part of a list request that says which list this is, whatever the sort and the filters. */
function scopeQuery(options: { cityId?: string; vehicle: VehicleQuery }) {
  return { ...(options.cityId ? { cityId: options.cityId } : {}), ...options.vehicle };
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

/** The account the catalog speaks to; `guest` — nobody signed in. */
function useViewerKey(): string {
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  return session.status === "signed_in" ? session.session.accountId : "guest";
}

export function useShowcaseItem(
  itemId: string,
  { cityId, vehicle, sort }: ShowcaseItemOptions,
): RequestState<ShowcaseItemResponse> {
  const { lang } = useLanguage();
  const viewer = useViewerKey();
  const query = { ...(cityId ? { cityId } : {}), ...vehicle, sort };
  // Another order of the offers is the same card: it stays on screen, with
  // the refresh line, until the new answer arrives — not a skeleton in place
  // of the whole card and the reader back at the top (SCREENS 2.1).
  // Who is asking is part of the question (TASK-030): the card of a guest
  // names no supplier and says `viewer.signedIn: false`, so signing in
  // loads it again, as the account sees it — that is how «Оформить» pressed
  // by a guest goes on once they are back.
  const scope = `item:${itemId}:${lang}:${viewer}:${JSON.stringify(scopeQuery({ cityId, vehicle }))}`;
  return useRequest(
    `${scope}:${sort}`,
    (signal) => apiClient.getShowcaseItem({ itemId }, { signal, query }),
    { staleAfterMs: CATALOG_STALE_MS, scope },
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
  /**
   * `true` while the list on screen is being replaced or reloaded — the old
   * rows stay under the refresh line until the new ones arrive (SCREENS 2.1).
   */
  refreshing: boolean;
  hasMore: boolean;
  /**
   * Goes up by one each time a **different** list takes the place of the one
   * on screen (another sort, other filters, another car or city) — and only
   * then. The screen goes back to the top of the list when this changes, and
   * never for a reload of the same list or for one more page.
   */
  generation: number;
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
 *
 * **The list does not jump** (ARCHITECTURE 4.39): while the new list of the
 * same subcategory, car and city is loading, the old one stays — under the
 * refresh line, with its title, its brands and the reader's place — and is
 * replaced in one step when the answer arrives, when `generation` says the
 * screen may go back to the top. A different car, city or language is a
 * different question and starts from a skeleton. Reloading the list that is
 * on screen (coming back after a minute) asks for as many rows as it already
 * has, so it does not shrink under the reader.
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
  // What the list is about — the subcategory for this car and city, in this
  // language; the sort and the filters are what changes it within that.
  const scope = `${categoryId}:${lang}:${JSON.stringify({ ...(cityId ? { cityId } : {}), ...vehicle })}`;
  const key = `${scope}:${JSON.stringify({ ...filters, sort })}`;

  const [attempt, setAttempt] = useState(0);
  // What is on screen, tagged with the list it belongs to: a new key makes
  // the old content stale by itself, so nothing has to be cleared when a
  // request starts (which an effect may not do synchronously anyway).
  const [state, setState] = useState<{
    scope: string;
    key: string;
    page: ShowcaseListResponse | null;
    items: ShowcaseListItem[];
    cursor: string | null;
    failure: RequestFailure | null;
    loadingMore: boolean;
    generation: number;
  }>({
    scope: "",
    key: "",
    page: null,
    items: [],
    cursor: null,
    failure: null,
    loadingMore: false,
    generation: 0,
  });
  /** The request whose answer has arrived; anything else is still in flight. */
  const [settled, setSettled] = useState<string | null>(null);
  const loadedAt = useRef(0);
  const query = useRef(baseQuery);
  const shown = useRef(state);
  useEffect(() => {
    query.current = baseQuery;
    shown.current = state;
  });

  const request = `${key}#${attempt}`;

  // The first page: a new key replaces the whole list.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // Reloading the list that is on screen rebuilds as many rows as the reader
    // has — including a page that lands while this loads — so the list does
    // not shrink under them and take their place with it (`loadRows`).
    const rows = shown.current.key === key ? shown.current.items.length : 0;
    loadRows({
      fetchPage: ({ cursor, limit }) =>
        apiClient.getShowcaseItems(
          { categoryId },
          {
            signal,
            query: {
              ...query.current,
              ...(cursor !== undefined ? { cursor } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
          },
        ),
      target: () => Math.max(rows, shown.current.key === key ? shown.current.items.length : 0),
      pageMax: SHOWCASE_PAGE_MAX_SIZE,
      defaultSize: SHOWCASE_PAGE_DEFAULT_SIZE,
      signal,
    })
      .then(({ first, items, cursor }) => {
        if (signal.aborted) return;
        loadedAt.current = Date.now();
        setState((previous) => ({
          scope,
          key,
          page: first,
          items,
          cursor,
          failure: null,
          loadingMore: false,
          generation: previous.key === key ? previous.generation : previous.generation + 1,
        }));
        setSettled(request);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        loadedAt.current = Date.now();
        setState((previous) => ({
          // Reloading the same list keeps it on screen (SCREENS 2.1); a new
          // list that failed is not the old one, and shows the error.
          ...(previous.key === key
            ? previous
            : { page: null, items: [], cursor: null, generation: previous.generation }),
          scope,
          key,
          failure: failureOf(error),
          loadingMore: false,
        }));
        setSettled(request);
      });
    return () => controller.abort();
    // `key`, `scope` and `categoryId` only ever change together with `request`.
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
  // The old list of the same subcategory, car and city stays until the new
  // one arrives; anything else on screen belongs to another question.
  const carried = !fresh && state.scope === scope && state.page !== null;
  const showing = fresh || carried;
  const page = showing ? state.page : null;
  const failure = fresh ? state.failure : null;
  const pending = settled !== request;

  return {
    status: page !== null ? "ready" : pending ? "loading" : failure ? "error" : "loading",
    failure,
    page,
    items: showing ? state.items : [],
    loadingMore: fresh && state.loadingMore,
    refreshing: pending && page !== null,
    // Paging belongs to the list the cursor came with, never to a carried one.
    hasMore: fresh && state.cursor !== null,
    generation: state.generation,
    loadMore,
    reload,
    reloadIfStale,
  };
}
