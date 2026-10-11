/**
 * The recent queries of the search (M-CAT-04, TASK-044): kept on this
 * device only (`adclub.mobile.recent-searches`), never sent anywhere. The
 * newest first, at most ten, a query once — the same words in another case
 * or with other spaces are the same query and move to the top.
 *
 * Plain TypeScript, tested without React Native (`recent-searches.test.ts`).
 */
export const RECENT_SEARCHES_MAX = 10;

export const RECENT_SEARCHES_KEY = "adclub.mobile.recent-searches";

/** The query as it is kept: spaces collapsed, nothing else changed. */
export function tidyQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

const sameQuery = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The list with this query on top. A query of fewer than two characters is not kept. */
export function rememberSearch(list: readonly string[], query: string): string[] {
  const tidy = tidyQuery(query);
  if (tidy.length < 2) {
    return [...list];
  }
  return [tidy, ...list.filter((entry) => !sameQuery(entry, tidy))].slice(0, RECENT_SEARCHES_MAX);
}

/** The stored list, or `null` when what is stored is not one. */
export function parseRecentSearches(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  let list: string[] = [];
  for (const entry of [...raw].reverse()) {
    if (typeof entry === "string") {
      list = rememberSearch(list, entry);
    }
  }
  return list;
}
