import { useState } from "react";
import { loadErrorText } from "../errors";
import { useLoad, type Loaded } from "../use-load";

export interface PageOf<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface Paged<T, P extends PageOf<T>> {
  /** The first page as `useLoad` holds it (its loading, error, reload). */
  first: Loaded<P>;
  /** The rows of the first page and of every «Показать ещё» after it. */
  items: T[];
  total: number;
  /** There is more after the shown rows. */
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  loadMore: () => Promise<void>;
}

/**
 * A list read by the server's cursor (X22): the first page under `key` (the
 * filters), «Показать ещё» adds the next one; new filters start anew.
 */
export function usePagedList<T, P extends PageOf<T>>(
  load: (cursor?: string) => Promise<P>,
  key: string,
): Paged<T, P> {
  const first = useLoad<P>(() => load(), key);
  const [more, setMore] = useState<{ key: string; items: T[]; next: string | null }>({
    key: "",
    items: [],
    next: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = more.key === key ? more : { key, items: [], next: null };
  const next = extra.items.length > 0 ? extra.next : (first.data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await load(next);
      setMore({ key, items: [...extra.items, ...page.items], next: page.nextCursor });
    } catch (thrown) {
      setMoreError(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    first,
    items: [...(first.data?.items ?? []), ...extra.items],
    total: first.data?.total ?? 0,
    hasMore: next !== null,
    loadingMore,
    moreError,
    loadMore,
  };
}
