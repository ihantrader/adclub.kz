import { searchVariants } from "@adclub/domain";
import { sql, type SQL } from "drizzle-orm";
import { escapeLike } from "./catalog-paging";
import { normalizeText } from "./catalog-texts";

/**
 * «A part of the name of an item in any language» for the searches of the
 * administrator (A-CAT-04, the search in the header) and of the supplier
 * (S-OFF-02): the query as typed, case ignored (as before), **or** any
 * reading of it the users' search takes (TASK-044; ARCHITECTURE 4.64) — the
 * key with `ё` and the Kazakh letters folded («тежегиш» finds «тежегіш»),
 * another keyboard layout («rjkjlrb» finds «колодки»), a transliteration.
 * The answers of both routes are as they were; only more is found.
 */
export function itemNameMatches(itemId: SQL, query: string): SQL {
  const pattern = `%${escapeLike(normalizeText(query))}%`;
  const readings = searchVariants(query).map(
    (variant) => sql`strpos(search_key(t.text), ${variant.key}) > 0`,
  );
  const either = readings.length === 0 ? sql`` : sql` OR ${sql.join(readings, sql` OR `)}`;
  return sql`EXISTS (SELECT 1 FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = ${itemId} AND t.field = 'name' AND (lower(t.text) LIKE lower(${pattern}) ESCAPE '\\'${either}))`;
}
