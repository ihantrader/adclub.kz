import type { SearchTextMatch } from "./search-query";

/**
 * How a found item was found (TASK-044): `article` — its article (or the
 * article a supplier gave its visible offer) is the query; `exact` — one of
 * its texts is the query; `partial` — every word of the query begins a word
 * of its texts.
 */
export type SearchMatch = "article" | SearchTextMatch;

export interface SearchRankFacts {
  match: SearchMatch;
  /** Its own name or synonym matched, not only its category or brand. */
  own: boolean;
  /** It has an offer in the chosen city («Есть в {город}»). */
  inCity: boolean;
  /** The lowest price of its offers the viewer can get. */
  minPrice: number;
  id: string;
}

const MATCH_ORDER: Readonly<Record<SearchMatch, number>> = { article: 0, exact: 1, partial: 2 };

/**
 * The one order of the users' search (TASK-044 requirement 3;
 * ARCHITECTURE 10.2 п. 7, 4.64): the article first, then an exact name or
 * synonym, then a partial match; within each, an item with an offer in the
 * chosen city first (services are only ever in the city), then an item found
 * by its own name before one found by its category or brand, then the lower
 * price; the id last, so equal items keep one order from page to page. The
 * key compares element by element.
 */
export function searchRankKey(facts: SearchRankFacts): [number, number, number, number, string] {
  return [
    MATCH_ORDER[facts.match],
    facts.inCity ? 0 : 1,
    facts.own ? 0 : 1,
    facts.minPrice,
    facts.id,
  ];
}

export type SearchRankKey = ReturnType<typeof searchRankKey>;

export function compareSearchRankKeys(a: SearchRankKey, b: SearchRankKey): number {
  for (let index = 0; index < 4; index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0;
}
