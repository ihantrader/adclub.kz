import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import type { TranslationEntityType } from "./schema";

/**
 * The order of the translation queue (TASK-054; ARCHITECTURE 4.97): what a
 * buyer meets first is translated first.
 *
 * - 0 — the structure everyone sees: categories, attributes, list options,
 *   the titles of maintenance plans;
 * - 1 — an item with an offer on the showcase;
 * - 2 — any other item.
 *
 * Within a group the task that waits longest goes first. A run takes its
 * batch by `(priority, updated_at, id)` — one partial index — so nothing
 * low waits for ever: when the groups above are empty, it is next.
 */
export const TRANSLATION_PRIORITY = {
  structure: 0,
  onShowcase: 1,
  other: 2,
} as const;

export type TranslationPriorityValue =
  (typeof TRANSLATION_PRIORITY)[keyof typeof TRANSLATION_PRIORITY];

/**
 * Which items of `itemIds` have an offer on the showcase now. The rule is
 * the offers module's (`shownOffers`); the catalog cannot depend on it, so
 * it is handed in (`CatalogItemListRules.registerShownItems`, the minute
 * job of the offers module).
 */
export type ShownItems = (executor: DbExecutor, itemIds: readonly string[]) => Promise<Set<string>>;

/** The priority of a task of `entityType`; an item's — by whether it is on the showcase. */
export function priorityOf(
  entityType: TranslationEntityType,
  onShowcase: boolean,
): TranslationPriorityValue {
  if (entityType !== "catalog_item") {
    return TRANSLATION_PRIORITY.structure;
  }
  return onShowcase ? TRANSLATION_PRIORITY.onShowcase : TRANSLATION_PRIORITY.other;
}

/** Items read per page of the walk. */
export const TRANSLATION_PRIORITY_PAGE = 1000;

export interface PriorityWalk {
  pages: number;
  /** Items whose translation waits, read. */
  items: number;
  /** Tasks moved up (the item is on the showcase now) and down (it is not). */
  raised: number;
  lowered: number;
}

/**
 * Moves the waiting tasks of items between «on the showcase» and «the
 * rest» (the minute job `catalog.translation-priority`). The walk reads
 * the items whose translation waits in pages (`translation_task_pending_item_idx`),
 * asks the showcase about the items of a page only and writes only the
 * tasks whose place changed — no query reads more than a page, and none
 * reads the offers of the whole catalog. The age of a task (`updated_at`)
 * stays: a risen task keeps its place among the ones that wait as long.
 */
export async function walkItemPriorities(
  executor: DbExecutor,
  shownItems: ShownItems,
  options: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<PriorityWalk> {
  const pageSize = options.pageSize ?? TRANSLATION_PRIORITY_PAGE;
  const walk: PriorityWalk = { pages: 0, items: 0, raised: 0, lowered: 0 };
  let after: string | null = null;
  while (!options.signal?.aborted) {
    const page: { rows: { entity_id: string }[] } = await executor.execute<{
      entity_id: string;
    }>(sql`
      SELECT DISTINCT entity_id FROM translation_task
      WHERE status = 'pending' AND entity_type = 'catalog_item'
        ${after ? sql`AND entity_id > ${after}::uuid` : sql``}
      ORDER BY entity_id
      LIMIT ${pageSize}`);
    const ids: string[] = page.rows.map((row) => row.entity_id);
    if (ids.length === 0) {
      break;
    }
    walk.pages += 1;
    walk.items += ids.length;
    const shown = [...(await shownItems(executor, ids))];
    const moved = await executor.execute<{ priority: number }>(sql`
      WITH wanted AS (
        SELECT id, CASE WHEN entity_id = ANY(${toUuidArray(shown)}) THEN ${TRANSLATION_PRIORITY.onShowcase}::smallint
                        ELSE ${TRANSLATION_PRIORITY.other}::smallint END AS priority
        FROM translation_task
        WHERE status = 'pending' AND entity_type = 'catalog_item'
          AND entity_id = ANY(${toUuidArray(ids)})
      )
      UPDATE translation_task t SET priority = wanted.priority
      FROM wanted
      WHERE t.id = wanted.id AND t.priority <> wanted.priority
      RETURNING t.priority`);
    for (const row of moved.rows) {
      if (Number(row.priority) === TRANSLATION_PRIORITY.onShowcase) {
        walk.raised += 1;
      } else {
        walk.lowered += 1;
      }
    }
    if (ids.length < pageSize) {
      break;
    }
    after = ids.at(-1)!;
  }
  return walk;
}

function toUuidArray(ids: readonly string[]) {
  return sql`ARRAY[${
    ids.length > 0
      ? sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )
      : sql``
  }]::uuid[]`;
}
