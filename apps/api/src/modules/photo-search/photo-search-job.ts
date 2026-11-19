import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
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
 * that are on the showcase** (at least one offer users see), the ones with
 * more offers first, each not more often than once in
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

/** Items whose offers `due` checks against the showcase rule at most. */
export const PHOTO_SEARCH_DUE_POOL = 200;

@Injectable()
export class PhotoSearchRunner implements PeriodicJobHandler {
  private readonly logger = new Logger("PhotoSearchJob");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PhotoSearchService) private readonly search: PhotoSearchService,
  ) {}

  /**
   * The items due, best first (the job and its tests). The price of the
   * query does not grow with the catalog (TASK-068.A): the showcase rule —
   * the costly part, hours and closed dates of every location — is checked
   * only for a pool of at most `PHOTO_SEARCH_DUE_POOL` items picked by the
   * partial index of active offers, the ones with more active offers first;
   * of them the ones with more offers users see come first. An item whose
   * active offers are all off the showcase may take a place in the pool; the
   * pool is ten times a run's batch, so the run still finds work.
   */
  async due(limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const retryDays = await this.settings.get("photo_search_retry_days");
    const rows = await this.database.db.execute<{ id: string }>(sql`
      WITH pool AS (
        SELECT i.id, i.photo_search_at, i.created_at
        FROM catalog_item i
        JOIN ${offer} ON ${offer.itemId} = i.id AND ${offer.status} = 'active'
        WHERE i.status = 'active' AND i.item_type <> 'service'
          AND i.primary_photo_id IS NULL
          AND (i.photo_search_at IS NULL OR i.photo_search_at < now() - make_interval(days => ${retryDays}))
          AND NOT EXISTS (
            SELECT 1 FROM item_photo p WHERE p.item_id = i.id AND p.status = 'proposed'
          )
        GROUP BY i.id
        ORDER BY count(*) DESC, i.photo_search_at ASC NULLS FIRST, i.created_at, i.id
        LIMIT ${Math.max(PHOTO_SEARCH_DUE_POOL, limit)}
      )
      SELECT pool.id
      FROM pool
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS shown FROM ${offer}
        WHERE ${offer.itemId} = pool.id AND ${shownOffers()}
      ) o
      WHERE o.shown > 0
      ORDER BY o.shown DESC, pool.photo_search_at ASC NULLS FIRST, pool.created_at, pool.id
      LIMIT ${limit}`);
    return rows.rows.map((row) => row.id);
  }

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    if (!this.search.enabled) {
      return { worked: false };
    }
    const remaining = await this.search.remainingToday();
    const items = await this.due(Math.min(remaining, PHOTO_SEARCH_JOB_BATCH));
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
