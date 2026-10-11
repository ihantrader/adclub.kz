import type { SearchTextMatch } from "./search-query";

/**
 * How a found item was found (TASK-044, TASK-045): `article` — its article
 * (or the article a supplier gave its visible offer) is the query; `exact` —
 * one of its texts is the query; `partial` — every word of the query begins
 * a word of its texts; `typo` — the search index found it with a typo
 * forgiven (or without a word nothing has), none of the above.
 */
export type SearchMatch = "article" | SearchTextMatch | "typo";

export interface SearchRankFacts {
  match: SearchMatch;
  /** It has an offer in the chosen city («Есть в {город}»). */
  inCity: boolean;
  /**
   * How relevant the search index found it, from 0 to 1 (its ranking score:
   * words, typos, proximity, the field — own name before category or
   * brand — exactness). 0 without the index (TASK-044: PostgreSQL).
   */
  relevance: number;
  /** Orders of it in the last 90 days that count in statistics (`countsInStatistics`). */
  popularity: number;
  /** Its own name or synonym matched, not only its category or brand. */
  own: boolean;
  /** The lowest price of its offers the viewer can get. */
  minPrice: number;
  id: string;
}

const MATCH_ORDER: Readonly<Record<SearchMatch, number>> = {
  article: 0,
  exact: 1,
  partial: 2,
  typo: 3,
};

/** Ranking scores differ in the fourth decimal at most for equal hits; coarser — equal. */
const RELEVANCE_STEP = 10_000;

/**
 * The one order of the users' search (TASK-044 requirement 3, TASK-045
 * requirement 2; ARCHITECTURE 10.2 п. 7, 4.64, 4.65): the article first,
 * then an exact name or synonym, then a partial match, then what only a
 * forgiven typo found; within each, an item with an offer in the chosen
 * city first («весь Казахстан» — no city, no such priority; services are
 * only ever in the city), then the relevance the index gave it, then its
 * popularity, then an item found by its own name before one found by its
 * category or brand, then the lower price; the id last, so equal items keep
 * one order from page to page. The key compares element by element.
 * Without the index relevance and popularity are 0, and the order is that
 * of TASK-044.
 */
export function searchRankKey(
  facts: SearchRankFacts,
): [number, number, number, number, number, number, string] {
  return [
    MATCH_ORDER[facts.match],
    facts.inCity ? 0 : 1,
    -Math.round(Math.max(0, Math.min(1, facts.relevance)) * RELEVANCE_STEP),
    -Math.max(0, Math.floor(facts.popularity)),
    facts.own ? 0 : 1,
    facts.minPrice,
    facts.id,
  ];
}

export type SearchRankKey = ReturnType<typeof searchRankKey>;

/** The number of parts of a key that are numbers (the id is the last). */
export const SEARCH_RANK_KEY_NUMBERS = 6;

export function compareSearchRankKeys(a: SearchRankKey, b: SearchRankKey): number {
  for (let index = 0; index < SEARCH_RANK_KEY_NUMBERS; index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return a[6] < b[6] ? -1 : a[6] > b[6] ? 1 : 0;
}
