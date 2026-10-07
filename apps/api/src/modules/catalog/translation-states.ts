import type { TranslationQueueState } from "@adclub/contracts";
import { sql, type SQL } from "drizzle-orm";

/**
 * The states that mean «без перевода» (A-HOME, A-CAT-04; TASK-034, TASK-035):
 * no text in the language and none on its way — never asked for, or refused
 * for good. A queued translation is on its way and an outdated one still
 * has a text, so neither counts.
 */
export const UNTRANSLATED_STATES = [
  "missing",
  "failed",
] as const satisfies readonly TranslationQueueState[];

/**
 * Every pair (Russian text, target language) with what it holds now and its
 * state — `classified (entity_type, entity_id, field, lang, source_text,
 * current_text, current_origin, is_source_changed, failure, state)`, `state`
 * `NULL` for a pair that is in order (ARCHITECTURE 4.19). The one
 * classification: the translation queue lists it, the home screen counts it
 * and the items list filters by it (TASK-035). `filters` narrow the Russian
 * texts (`src`) and the languages (`l`).
 */
export function classifiedTranslations(filters: readonly SQL[]): SQL {
  return sql`
      WITH pairs AS (
        SELECT src.entity_type, src.entity_id, src.field, l.lang, src.text AS source_text,
               encode(sha256(convert_to(src.text, 'UTF8')), 'hex') AS source_hash
        FROM translation src
        CROSS JOIN (VALUES ('kk'), ('en')) AS l(lang)
        WHERE src.origin = 'source' AND src.lang = 'ru' ${sql.join([...filters], sql` `)}
      ), classified AS (
        SELECT p.entity_type, p.entity_id, p.field, p.lang, p.source_text,
               t.text AS current_text, t.origin AS current_origin,
               (t.id IS NOT NULL AND t.source_hash IS DISTINCT FROM p.source_hash) AS is_source_changed,
               k.failure AS failure,
               CASE WHEN k.status = 'failed' THEN 'failed'
                    WHEN k.status = 'pending' THEN 'queued'
                    WHEN t.id IS NULL THEN 'missing'
                    WHEN t.source_hash IS DISTINCT FROM p.source_hash THEN 'outdated'
               END AS state
        FROM pairs p
        LEFT JOIN translation t ON t.entity_type = p.entity_type AND t.entity_id = p.entity_id
          AND t.field = p.field AND t.lang = p.lang
        LEFT JOIN translation_task k ON k.entity_type = p.entity_type AND k.entity_id = p.entity_id
          AND k.field = p.field AND k.lang = p.lang
      )`;
}

/** The states of `UNTRANSLATED_STATES` as an SQL list. */
function untranslatedList(): SQL {
  return sql.join(
    UNTRANSLATED_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
}

/**
 * «Без перевода» of an item (A-CAT-04): some text of the item (its name)
 * is in a state of `UNTRANSLATED_STATES` in some target language.
 */
export function itemWithoutTranslation(item: SQL): SQL {
  return sql`${item} IN (${classifiedTranslations([sql`AND src.entity_type = 'catalog_item'`])}
      SELECT entity_id FROM classified WHERE state IN (${untranslatedList()}))`;
}
