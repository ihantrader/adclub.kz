import { createHash } from "node:crypto";

/**
 * The document of an item in the search index and the settings of the
 * index (TASK-045; ARCHITECTURE 10.1, 4.65). Every text is stored as its
 * key (`searchKey` of `@adclub/domain`: lower case, signs as spaces, Kazakh
 * letters folded), and a query is sent as the keys of its variants: the
 * index compares exactly what the domain compares, and «тежегиш» finds
 * «тежегіш» there as well.
 *
 * Nothing of a person is in it: names, synonyms, brands, categories, values
 * of characteristics, city ids, a count of orders. Not the texts of
 * warranties, not suppliers.
 */
export interface SearchIndexDocument {
  id: string;
  kind: "goods" | "services";
  /** The subcategory. */
  categoryId: string;
  /** Its node. */
  nodeId: string | null;
  /** The article as `article_norm` (lower case) and as a key («04465 0k090»). */
  article: string[];
  /** The item's own names (kk/ru/en) and synonyms. */
  own: string[];
  /** The spellings of its brand. */
  brand: string[];
  /** The names and synonyms of its subcategory and node. */
  category: string[];
  /**
   * The names of the values of its filterable list characteristics («5w 30»,
   * «api sp»): searchable. The counts of the facets are not taken from the
   * index — they are of what is really shown (ARCHITECTURE 4.65).
   */
  values: string[];
  /** The cities of its offers users see. */
  cities: string[];
  /** Orders of it in the last 90 days that count in statistics. */
  popularity: number;
  /** Of everything above but `popularity`: what the nightly check compares. */
  hash: string;
}

export type SearchIndexDocumentContent = Omit<SearchIndexDocument, "hash">;

/** At most this many items are taken from the index for one variant of a query. */
export const SEARCH_INDEX_CANDIDATES_MAX = 5000;

/**
 * The settings of the index. The order of the searchable fields is the
 * order of relevance (Meilisearch's `attribute` rule): the article, the
 * item's own name, its brand, its category, its values. Typos are forgiven
 * as Meilisearch does by default — one from five letters, two from nine —
 * except in articles, where a typo is another part. Popularity is the last
 * ranking rule.
 */
export function searchIndexSettings(synonyms: Record<string, string[]>): object {
  return {
    searchableAttributes: ["article", "own", "brand", "category", "values"],
    filterableAttributes: ["kind", "categoryId", "nodeId", "cities"],
    sortableAttributes: ["popularity"],
    rankingRules: [
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "exactness",
      "popularity:desc",
    ],
    typoTolerance: {
      enabled: true,
      minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 },
      disableOnAttributes: ["article"],
    },
    pagination: { maxTotalHits: SEARCH_INDEX_CANDIDATES_MAX },
    synonyms,
  };
}

/** The hash a document carries: of its content but its popularity, the fields in a fixed order. */
export function documentHash(content: SearchIndexDocumentContent): string {
  const { popularity: _popularity, ...rest } = content;
  const ordered = Object.fromEntries(
    Object.entries(rest)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
  );
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 32);
}

/** Terms of one group of synonyms, each at most this many words; a group at most this many terms. */
const SYNONYM_WORDS_MAX = 5;
const SYNONYM_GROUP_MAX = 20;

/**
 * The synonyms of the index from groups (ARCHITECTURE 10.2 п. 4): every
 * term of a group stands for every other — «колодки» ≡ «тормозные колодки»
 * ≡ «brake pads» ≡ «тежегиш калыптары» (keys). A group is a category's
 * synonyms with its own names in kk/ru/en, or an item's synonyms. A term in
 * two groups stands for the terms of both. Terms are keys; empty ones,
 * longer ones and duplicates are left out.
 */
export function synonymMap(groups: readonly (readonly string[])[]): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const group of groups) {
    const terms = [
      ...new Set(
        group.filter((term) => term !== "" && term.split(" ").length <= SYNONYM_WORDS_MAX),
      ),
    ].slice(0, SYNONYM_GROUP_MAX);
    if (terms.length < 2) {
      continue;
    }
    for (const term of terms) {
      const others = map.get(term) ?? new Set<string>();
      for (const other of terms) {
        if (other !== term) {
          others.add(other);
        }
      }
      map.set(term, others);
    }
  }
  return Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([term, others]) => [term, [...others].sort()]),
  );
}

export function synonymsHash(synonyms: Record<string, string[]>): string {
  return createHash("sha256").update(JSON.stringify(synonyms)).digest("hex").slice(0, 32);
}
