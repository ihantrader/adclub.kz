import { createHmac } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { OfferViewerKind } from "@adclub/contracts";
import { sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { rateLimitSubject } from "../../redis/rate-limit-subject";
import type { Viewer } from "../showcase";

/** How often the views of the process go to the database. */
const FLUSH_INTERVAL_MS = 2_000;
/** Views of one statement (5 parameters each — far under PostgreSQL's 65 535). */
const BATCH_SIZE = 2_000;
/**
 * Views the process keeps while the database doesn't take them; beyond that
 * new ones are dropped (and counted in the log) — the catalog never grows its
 * memory because of the views.
 */
const MAX_PENDING = 20_000;

const ALMATY_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Almaty",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The day of Almaty of a moment, `YYYY-MM-DD`. */
export function almatyDayOf(at: Date): string {
  return ALMATY_DAY.format(at);
}

/** The kind of a viewer by what the showcase decided about them (`viewerOf`, `ClubAccess`). */
export function viewerKindOf(viewer: Viewer): OfferViewerKind {
  if (viewer.accountId === null) {
    return "guest";
  }
  return viewer.clubAccess ? "club" : "user";
}

interface PendingView {
  offerId: string;
  day: string;
  key: string;
  kind: OfferViewerKind;
  /** Only to leave out an employee looking at their own company; never stored. */
  accountId: string | null;
}

/**
 * The views of offers (TASK-070; ARCHITECTURE 4.88). The catalog calls `seen`
 * once an answer that shows offers is ready — the card of an item, M-CAT-09
 * from an offer — and returns at once: **the view is not on the path of the
 * answer** and not in its transaction. `seen` only puts the view into the
 * process's memory (and never throws); every `FLUSH_INTERVAL_MS` a batch goes
 * to the database in one statement:
 *
 * - the raw view — `offer_view_event`, its key the offer, the day of Almaty
 *   and an HMAC of the viewer with that day (the account, or a guest's
 *   address by its rate-limit subject: IPv6 by /64) under the server's
 *   secret. The same viewer the same day is the same row, so a second look —
 *   from this process or from another replica of the API — counts nothing
 *   (`ON CONFLICT DO NOTHING` on the primary key);
 * - only the rows that were new add to `offer_view_daily` (offer, day, kind),
 *   in the same statement: the totals can't run ahead of the raw views or
 *   count one twice;
 * - an employee of the offer's own company (an active membership of the
 *   account) is left out in the same statement — their looking is not a
 *   client's.
 *
 * Lost: what a process held when it died (at most `FLUSH_INTERVAL_MS` of its
 * views; a graceful stop writes them first), and, while the database refuses,
 * whatever is over `MAX_PENDING`. The signal counts thousands of views over
 * a month; that is the price of a card that never waits.
 */
@Injectable()
export class OfferViews implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger("OfferViews");
  private pending = new Map<string, PendingView>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<unknown> = Promise.resolve();
  private dropped = 0;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /** How many views wait for the database (tests and the log). */
  get waiting(): number {
    return this.pending.size;
  }

  /**
   * The viewer was shown these offers now. Never throws and never waits:
   * whatever goes wrong here, the answer of the catalog is not touched.
   */
  seen(viewer: Viewer, offerIds: readonly string[], address: string | undefined): void {
    try {
      if (offerIds.length === 0) {
        return;
      }
      const day = almatyDayOf(new Date());
      const identity =
        viewer.accountId !== null ? `a:${viewer.accountId}` : `g:${rateLimitSubject(address)}`;
      const key = createHmac("sha256", this.config.session.tokenSecret)
        .update(`offer-view|${day}|${identity}`)
        .digest("base64url")
        .slice(0, 32);
      const kind = viewerKindOf(viewer);
      for (const offerId of new Set(offerIds)) {
        const id = `${offerId}|${day}|${key}`;
        if (this.pending.has(id)) {
          continue;
        }
        if (this.pending.size >= MAX_PENDING) {
          this.dropped += 1;
          continue;
        }
        this.pending.set(id, { offerId, day, key, kind, accountId: viewer.accountId });
      }
    } catch (error) {
      this.logger.warn(`A view could not be kept: ${String(error)}`);
    }
  }

  /**
   * Writes what waits, batch by batch. Never throws: a batch the database
   * refused goes back to wait for the next flush. One flush at a time.
   */
  flush(): Promise<{ written: number; failed: number }> {
    const run = this.flushing.then(() => this.writeAll());
    this.flushing = run.catch(() => undefined);
    return run;
  }

  private async writeAll(): Promise<{ written: number; failed: number }> {
    if (this.dropped > 0) {
      this.logger.warn(`Views dropped over the limit of waiting ones: ${String(this.dropped)}`);
      this.dropped = 0;
    }
    let written = 0;
    let failed = 0;
    while (this.pending.size > 0) {
      const batch = [...this.pending.entries()].slice(0, BATCH_SIZE);
      for (const [id] of batch) {
        this.pending.delete(id);
      }
      try {
        await this.write(batch.map(([, view]) => view));
        written += batch.length;
      } catch (error) {
        failed += batch.length;
        for (const [id, view] of batch) {
          if (this.pending.size < MAX_PENDING) {
            this.pending.set(id, view);
          }
        }
        this.logger.warn(
          `Views not written, kept for the next try count=${String(batch.length)}: ${String(error)}`,
        );
        break;
      }
    }
    return { written, failed };
  }

  private async write(views: readonly PendingView[]): Promise<void> {
    const values = sql.join(
      views.map(
        (view) =>
          sql`(${view.offerId}::uuid, ${view.day}::date, ${view.key}::text, ${view.kind}::text, ${view.accountId}::uuid)`,
      ),
      sql`, `,
    );
    // Ordered, so two replicas writing the same rows take their locks in one order.
    await this.database.db.execute(sql`
      WITH incoming (offer_id, day, viewer_key, viewer_kind, account_id) AS (VALUES ${values}),
      fresh AS (
        INSERT INTO offer_view_event (offer_id, day, viewer_key, viewer_kind, supplier_id)
        SELECT i.offer_id, i.day, i.viewer_key, i.viewer_kind, o.supplier_id
        FROM incoming AS i
        JOIN offer AS o ON o.id = i.offer_id
        WHERE i.account_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM supplier_member AS m
          WHERE m.account_id = i.account_id
            AND m.supplier_id = o.supplier_id
            AND m.status = 'active'
        )
        ORDER BY i.offer_id, i.day, i.viewer_key
        ON CONFLICT DO NOTHING
        RETURNING offer_id, day, viewer_kind, supplier_id
      )
      INSERT INTO offer_view_daily (offer_id, day, viewer_kind, supplier_id, views)
      SELECT offer_id, day, viewer_kind, supplier_id, count(*)::int
      FROM fresh
      GROUP BY offer_id, day, viewer_kind, supplier_id
      ORDER BY offer_id, day, viewer_kind
      ON CONFLICT (offer_id, day, viewer_kind)
      DO UPDATE SET views = offer_view_daily.views + EXCLUDED.views
    `);
  }
}

/**
 * The one recorder of the process: a plain module, so every module that
 * imports it (the catalog's card, M-CAT-09) shares one instance and one
 * batch.
 */
@Module({ providers: [OfferViews], exports: [OfferViews] })
export class OfferViewsRecorderModule {}
