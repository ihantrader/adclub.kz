import { searchKey, searchVariants } from "@adclub/domain";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { itemsByIds, type MatchItem } from "./price-match-items";

/** The shortest beginning of a word looked up, and the longest kept. */
const STEM_MIN = 3;
const STEM_MAX = 10;

/**
 * The names of the catalog's available goods in memory, for step 3 of
 * matching (TASK-047; ARCHITECTURE 4.67 I711): one query per matching run
 * instead of one search per row — a first price list of fifty thousand rows
 * the catalog doesn't know would otherwise search fifty thousand times.
 * Words are compared by the key of the users' search (`searchKey`: case,
 * «ё», the Kazakh letters folded) in every reading of a word the search
 * takes (`searchVariants`: another keyboard layout, a transliteration), by
 * the beginning of a word of a name in any language — what the supplier's
 * own search of an item finds, word by word.
 */
export class PriceNameIndex {
  private constructor(
    private readonly byStem: Map<string, string[]>,
    private readonly items: Map<string, MatchItem>,
  ) {}

  static async load(executor: DbExecutor): Promise<PriceNameIndex> {
    const rows = await executor.execute<{ id: string; text: string }>(sql`
      SELECT t.entity_id AS id, t.text
      FROM translation t
      JOIN catalog_item i ON i.id = t.entity_id
      JOIN category c ON c.id = i.category_id
      LEFT JOIN category p ON p.id = c.parent_id
      WHERE t.entity_type = 'catalog_item' AND t.field = 'name'
        AND i.item_type IN ('part', 'generic') AND i.status = 'active'
        AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'`);
    const byStem = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      for (const word of searchKey(row.text).split(" ")) {
        for (let length = STEM_MIN; length <= Math.min(word.length, STEM_MAX); length++) {
          const stem = word.slice(0, length);
          let ids = byStem.get(stem);
          if (!ids) {
            ids = new Set();
            byStem.set(stem, ids);
          }
          ids.add(row.id);
        }
      }
    }
    const ids = [...new Set(rows.rows.map((row) => row.id))];
    const items = new Map<string, MatchItem>();
    for (let start = 0; start < ids.length; start += 5000) {
      for (const [id, item] of await itemsByIds(executor, ids.slice(start, start + 5000))) {
        items.set(id, item);
      }
    }
    return new PriceNameIndex(
      new Map([...byStem].map(([stem, found]) => [stem, [...found].sort()])),
      items,
    );
  }

  /**
   * Items any of `words` begins a word of (each word's readings included),
   * those that more of the words name first, at most `limit`.
   */
  candidates(words: readonly string[], limit: number): MatchItem[] {
    const hits = new Map<string, number>();
    for (const word of words) {
      const named = new Set<string>();
      for (const variant of searchVariants(word)) {
        const key = variant.key.split(" ")[0] ?? "";
        if (key.length < STEM_MIN) continue;
        for (const id of this.byStem.get(key.slice(0, STEM_MAX)) ?? []) named.add(id);
      }
      for (const id of named) hits.set(id, (hits.get(id) ?? 0) + 1);
    }
    if (hits.size === 0) return [];
    const chosen = [...hits]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([id]) => id);
    return chosen.flatMap((id) => {
      const item = this.items.get(id);
      return item?.available && item.itemType !== "service" ? [item] : [];
    });
  }
}
