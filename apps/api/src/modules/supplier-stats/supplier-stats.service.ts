import { Inject, Injectable } from "@nestjs/common";
import type { SupplierStats, SupplierStatsPeriod } from "@adclub/contracts";
import { statsPeriodRange, supplierPeriodStats } from "@adclub/domain";
import { eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { supplier } from "../identity";
import { viewFacts } from "../offer-views";
import { ratingOrderFacts, supplierRating } from "../ratings";
import { AppSettings } from "../settings";

/**
 * The statistics of a supplier (S-STAT-01; TASK-071; PRODUCT 12.6, 13;
 * ARCHITECTURE 4.89). **`of` is the one count**: the cabinet's «Статистика»
 * (`GET /supplier/stats`, the session's company) and the admin's card of the
 * supplier (`GET /admin/suppliers/{id}/stats`) both call it, so the numbers
 * cannot part.
 *
 * Nothing is counted here anew:
 *
 * - the orders and the shares — the facts of the rating (`ratingOrderFacts`
 *   over the period of Almaty) judged by `supplierPeriodStats` of
 *   `@adclub/domain`, that is `countsInStatistics`, `ratingOrderOutcome` and
 *   the threshold `ratingShares` with `rating_min_orders`;
 * - the views — `viewFacts` (TASK-070);
 * - the rating — the snapshot `SupplierRatings.recompute` wrote, over the
 *   rating's own window.
 *
 * What is never in it: who looked, who ordered, the people of the orders,
 * other suppliers.
 */
@Injectable()
export class SupplierStatsService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async of(supplierId: string, period: SupplierStatsPeriod): Promise<SupplierStats> {
    const db = this.database.db;
    const [minOrders, windowDays, minReviews] = await Promise.all([
      this.settings.get("rating_min_orders"),
      this.settings.get("rating_window_days"),
      this.settings.get("rating_min_reviews"),
    ]);
    const today = await almatyToday(db);
    const range = statsPeriodRange(today, Number(period));
    const [facts, views, [rating]] = await Promise.all([
      ratingOrderFacts(db, [supplierId], range),
      viewFacts(db, { ...range, supplierIds: [supplierId], byDay: false }),
      db.select().from(supplierRating).where(eq(supplierRating.supplierId, supplierId)),
    ]);
    const stats = supplierPeriodStats(facts, minOrders);
    const seen = views[0]?.views ?? { guest: 0, user: 0, club: 0 };
    return {
      period,
      ...range,
      orders: stats.orders,
      views: { total: seen.guest + seen.user + seen.club, club: seen.club },
      shares: {
        responseRate: stats.shares.responseRate,
        responsePercent: stats.shares.responsePercent,
        answered: stats.shares.answered,
        answerRequired: stats.shares.answerRequired,
        onTimeRate: stats.shares.onTimeRate,
        onTimePercent: stats.shares.onTimePercent,
        kept: stats.shares.kept,
        judged: stats.shares.judged,
        minOrders: stats.shares.minOrders,
      },
      rating: {
        score: rating?.score === null || rating === undefined ? null : Number(rating.score),
        isNew: rating ? rating.score === null : true,
        reviewsCount: rating?.reviewsCount ?? 0,
        windowDays,
        minReviews,
      },
    };
  }

  /** The admin's look: an unknown supplier is a 404, as every card of it. */
  async ofKnown(supplierId: string, period: SupplierStatsPeriod): Promise<SupplierStats> {
    const [known] = await this.database.db
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!known) {
      throw new ApiException(404, "NOT_FOUND", "No such supplier");
    }
    return this.of(supplierId, period);
  }
}

/** Today of Almaty by the database's clock (one for every process). */
async function almatyToday(executor: DbExecutor): Promise<string> {
  const result = await executor.execute<{ day: string }>(
    sql`SELECT ((now() AT TIME ZONE 'Asia/Almaty')::date)::text AS day`,
  );
  return result.rows[0]!.day;
}
