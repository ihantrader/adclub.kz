/**
 * Reloading a list that is already on screen without shrinking it under the
 * reader (TASK-028.A, ARCHITECTURE 4.39). A list the person has scrolled is
 * several pages long; asking the server for «the first page» again would cut
 * it back to one, and the scroll position with it. So the reload asks for as
 * many rows as the reader has — the first request as large as one page may
 * be, the rest by the cursor — and hands back all of them at once.
 *
 * Plain TypeScript over an injected page loader, so the rule is tested
 * without React Native or a server (`showcase-rows.test.ts`).
 */
export interface RowsPage {
  items: { id: string }[];
  nextCursor: string | null;
}

export interface LoadRowsOptions<Page extends RowsPage> {
  /** One request of the server: after `cursor`, `limit` rows (none — the server's own page). */
  fetchPage: (request: { cursor?: string; limit?: number }) => Promise<Page>;
  /**
   * How many rows the reader has. Asked again before each further page, so a
   * page that landed while this was loading is not thrown away by it.
   */
  target: () => number;
  /** The most rows a request may ask for. */
  pageMax: number;
  /** The size of the server's own page. */
  defaultSize: number;
  signal?: AbortSignal;
}

export interface LoadedRows<Page extends RowsPage> {
  /** The first page's answer: the category, the car, the totals, the brands. */
  first: Page;
  /** Every row loaded, in the server's order, without repeats. */
  items: Page["items"][number][];
  /** Where the next page starts; `null` — there is none. */
  cursor: string | null;
}

export async function loadRows<Page extends RowsPage>({
  fetchPage,
  target,
  pageMax,
  defaultSize,
  signal,
}: LoadRowsOptions<Page>): Promise<LoadedRows<Page>> {
  const wanted = target();
  const first = await fetchPage(wanted > defaultSize ? { limit: Math.min(wanted, pageMax) } : {});
  let items = first.items;
  let cursor = first.nextCursor;

  // A list longer than one page comes back in pages, by the cursor of the
  // one before, until it is as long as the reader's was.
  while (cursor !== null && !signal?.aborted) {
    const missing = target() - items.length;
    if (missing <= 0) break;
    const next = await fetchPage({ cursor, limit: Math.min(missing, pageMax) });
    const known = new Set(items.map((item) => item.id));
    items = [...items, ...next.items.filter((item) => !known.has(item.id))];
    cursor = next.nextCursor;
  }
  return { first, items, cursor };
}
