import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  definePeriodicJob,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { offer, shownOffers } from "../offers";
import { AppSettings } from "../settings";
import { PhotoSearchService, PhotoSearchSkipped } from "./photo-search.service";

/**
 * `catalog.search-photos` (TASK-068, D-076; ARCHITECTURE 13.2, 4.95) —
 * hourly: searches photos of active products **without an approved photo
 * that are on the showcase** (at least one offer users see) — of the
 * `PHOTO_SEARCH_DUE_POOL` that wait longest the ones with more offers
 * first (`dueItems`) — each not more often than once in
 * `photo_search_retry_days`, and all searches of the day — this job's and
 * the administrator's button — within `photo_search_per_day`. An item whose
 * candidates still wait for moderation is not searched again. A run takes at
 * most `PHOTO_SEARCH_JOB_BATCH` items, so the day's budget spreads over the
 * day; `operator jobs:run catalog.search-photos` — now.
 */
export const photoSearchJob = definePeriodicJob({
  name: "catalog.search-photos",
  timeoutSeconds: 1800,
  // The next hour is the retry.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => "41 * * * *",
});

export const photoSearchJobCatalog = [photoSearchJob];

/** Items one run searches at most. */
export const PHOTO_SEARCH_JOB_BATCH = 20;

/**
 * Items on the showcase among which «more offers first» holds: the walk
 * stops having found this many, and the run takes the best of them.
 */
export const PHOTO_SEARCH_DUE_POOL = 200;

/** Items one query of the walk reads from the index. */
export const PHOTO_SEARCH_DUE_PAGE = 1000;

/** Where a page of the walk ended: the key of `catalog_item_photo_search_due_idx`, as text. */
interface DueCursor {
  searchedAt: string;
  createdAt: string;
  id: string;
}

interface DuePageRow extends Record<string, unknown> {
  id: string;
  searched_at: string;
  created_at: string;
  shown: number;
  n: number;
}

/** What a walk did — the job logs nothing of it; the measurements read it. */
export interface DueWalk {
  /** The items to search, best first. */
  ids: string[];
  /** Queries made. */
  pages: number;
  /** Items read from the index. */
  read: number;
}

/**
 * One page of the walk: the next `pageSize` products that may be searched
 * (active, not a service, without a primary photo, due by `dueBefore`), in
 * the order they wait, and of them the ones on the showcase with the number
 * of offers users see. The statement reads `pageSize` entries of the
 * partial index `catalog_item_photo_search_due_idx` and the offers of those
 * items — nothing else, whatever the size of the catalog. The showcase is
 * decided by `shownOffers()` alone; an item whose candidates wait for
 * moderation counts as not shown. The last row of the page always comes
 * back: it is where the next page starts.
 */
function duePage(
  executor: DbExecutor,
  options: { dueBefore: Date; at: Date; after: DueCursor | null; pageSize: number },
) {
  const key = sql`coalesce(i.photo_search_at, '-infinity'::timestamptz)`;
  const after = options.after
    ? sql`AND (${key}, i.created_at, i.id) > (${options.after.searchedAt}::timestamptz, ${options.after.createdAt}::timestamptz, ${options.after.id}::uuid)`
    : sql``;
  return executor.execute<DuePageRow>(sql`
    WITH page AS MATERIALIZED (
      SELECT i.id, ${key} AS searched_at, i.created_at,
        row_number() OVER (ORDER BY ${key}, i.created_at, i.id)::int AS n
      FROM catalog_item i
      WHERE i.status = 'active' AND i.item_type <> 'service' AND i.primary_photo_id IS NULL
        AND ${key} < ${options.dueBefore.toISOString()}::timestamptz
        ${after}
      ORDER BY ${key}, i.created_at, i.id
      LIMIT ${options.pageSize}
    ), shown AS MATERIALIZED (
      SELECT ${offer.itemId} AS id, count(*)::int AS shown
      FROM ${offer}
      WHERE ${offer.itemId} IN (SELECT page.id FROM page) AND ${shownOffers(options.at)}
      GROUP BY ${offer.itemId}
    ), judged AS MATERIALIZED (
      SELECT page.id, page.searched_at, page.created_at, page.n,
        CASE WHEN EXISTS (
          SELECT 1 FROM item_photo p WHERE p.item_id = page.id AND p.status = 'proposed'
        ) THEN 0 ELSE coalesce(shown.shown, 0) END AS shown
      FROM page LEFT JOIN shown ON shown.id = page.id
    )
    SELECT id, searched_at::text AS searched_at, created_at::text AS created_at, shown, n
    FROM judged
    WHERE shown > 0 OR n = (SELECT max(n) FROM judged)
    ORDER BY n`);
}

/**
 * The items due, best first (TASK-068.B; ARCHITECTURE 4.95): the walk goes
 * over the products without a photo in the order they wait — never searched
 * first, then searched longest ago, the older first — page by page, each
 * page its own bounded query (`duePage`), until `pool` items on the
 * showcase are found or the due items end. Of the found the ones with more
 * offers users see come first. So an item on the showcase is reached
 * whatever stands before it: items nobody offers, items of a supplier
 * without hours, paused or blocked are read and passed, they hold no place.
 * What the walk costs in all grows with the number of due items it has to
 * pass; no single query does.
 */
export async function dueItems(
  executor: DbExecutor,
  options: {
    limit: number;
    retryDays: number;
    at?: Date;
    signal?: AbortSignal;
    pool?: number;
    pageSize?: number;
  },
): Promise<DueWalk> {
  const walk: DueWalk = { ids: [], pages: 0, read: 0 };
  if (options.limit <= 0) return walk;
  const at = options.at ?? new Date();
  const dueBefore = new Date(at.getTime() - options.retryDays * 86_400_000);
  const pool = Math.max(options.pool ?? PHOTO_SEARCH_DUE_POOL, options.limit);
  const pageSize = options.pageSize ?? PHOTO_SEARCH_DUE_PAGE;
  const found: { id: string; shown: number }[] = [];
  let after: DueCursor | null = null;
  while (found.length < pool && !options.signal?.aborted) {
    const { rows } = await duePage(executor, { dueBefore, at, after, pageSize });
    const last = rows.at(-1);
    if (!last) break;
    walk.pages += 1;
    walk.read += last.n;
    for (const row of rows) {
      if (row.shown > 0) found.push({ id: row.id, shown: row.shown });
    }
    if (last.n < pageSize) break;
    after = { searchedAt: last.searched_at, createdAt: last.created_at, id: last.id };
  }
  // The sort is stable: among equals the one that waits longer stays first.
  walk.ids = found
    .slice(0, pool)
    .sort((a, b) => b.shown - a.shown)
    .slice(0, options.limit)
    .map((row) => row.id);
  return walk;
}

@Injectable()
export class PhotoSearchRunner implements PeriodicJobHandler {
  private readonly logger = new Logger("PhotoSearchJob");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PhotoSearchService) private readonly search: PhotoSearchService,
  ) {}

  /** The items due, best first (the job and its tests) — `dueItems`. */
  async due(limit: number, signal?: AbortSignal): Promise<string[]> {
    if (limit <= 0) return [];
    const retryDays = await this.settings.get("photo_search_retry_days");
    const walk = await dueItems(this.database.db, { limit, retryDays, signal });
    return walk.ids;
  }

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    if (!this.search.enabled) {
      return { worked: false };
    }
    const remaining = await this.search.remainingToday();
    const items = await this.due(Math.min(remaining, PHOTO_SEARCH_JOB_BATCH), context.signal);
    let searched = 0;
    let candidates = 0;
    for (const itemId of items) {
      if (context.signal.aborted) break;
      try {
        const outcome = await this.search.search(itemId, "job", { role: "system" });
        searched += 1;
        candidates += outcome.candidates;
      } catch (error) {
        if (error instanceof PhotoSearchSkipped) {
          // The budget ran out or the provider is down: the rest waits for the next run.
          if (
            error.reason === "budget" ||
            error.reason === "provider" ||
            error.reason === "disabled"
          ) {
            this.logger.warn(`Photo search stopped: ${error.reason}`);
            break;
          }
          continue;
        }
        // Not the item's trouble (storage, the database): the next items would
        // spend paid searches on the same failure — the rest waits for the next run.
        this.logger.error(
          `Photo search failed item=${itemId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    this.logger.log(`Photo searches searched=${String(searched)} candidates=${String(candidates)}`);
    return { worked: searched > 0 };
  }
}
