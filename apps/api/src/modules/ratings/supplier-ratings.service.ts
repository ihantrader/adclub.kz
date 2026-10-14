import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AdminSignalPayload,
  AdminSupplierListRating,
  AdminSupplierRating,
  SupplierRatingFigures,
  SupplierRatingFilter,
  SupplierRatingRules,
} from "@adclub/contracts";
import {
  lowRatingSignalMove,
  RATING_FORMULA_VERSION,
  ratingIsLow,
  ratingPercent,
  supplierRating,
  type RatingRules,
  type SupplierRating,
} from "@adclub/domain";
import { asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { supplier } from "../identity";
import { AppSettings } from "../settings";
import { AdminSignals } from "../signals";
import { ratingInputs } from "./rating-facts";
import {
  supplierRating as ratingTable,
  supplierRatingHistory,
  type SupplierRatingRow,
} from "./schema";

/** How many changes of the history A-SUP-03 shows. */
const HISTORY_SHOWN = 50;

const KIND = "low_rating" as const;

/** What the rating of a supplier is shown as to users (M-CAT-07, M-CAT-09). */
export interface PublicRating {
  rating: { value: number; count: number } | null;
  newSupplier: boolean;
  responsePercent: number | null;
  onTimePercent: number | null;
}

/** No snapshot yet: a new supplier, too few orders for a share. */
const NOTHING_YET: PublicRating = {
  rating: null,
  newSupplier: true,
  responsePercent: null,
  onTimePercent: null,
};

function figuresOf(row: {
  score: number | null;
  isNew: boolean;
  reviewsCount: number;
  responseRate: number | null;
  onTimeRate: number | null;
}): SupplierRatingFigures {
  return {
    score: row.score === null ? null : Number(row.score),
    isNew: row.isNew,
    reviewsCount: row.reviewsCount,
    responseRate: row.responseRate === null ? null : Number(row.responseRate),
    onTimeRate: row.onTimeRate === null ? null : Number(row.onTimeRate),
  };
}

function sameFigures(a: SupplierRatingFigures, b: SupplierRatingFigures): boolean {
  return (
    a.score === b.score &&
    a.isNew === b.isNew &&
    a.reviewsCount === b.reviewsCount &&
    a.responseRate === b.responseRate &&
    a.onTimeRate === b.onTimeRate
  );
}

/** The rating of a snapshot as users see it; no snapshot — nothing yet. */
export function publicRatingOf(
  row: Pick<SupplierRatingRow, "score" | "reviewsCount" | "responseRate" | "onTimeRate"> | null,
): PublicRating {
  if (!row) {
    return NOTHING_YET;
  }
  return {
    rating: row.score === null ? null : { value: Number(row.score), count: row.reviewsCount },
    newSupplier: row.score === null,
    responsePercent: row.responseRate === null ? null : ratingPercent(Number(row.responseRate)),
    onTimePercent: row.onTimeRate === null ? null : ratingPercent(Number(row.onTimeRate)),
  };
}

/** The rating of a supplier as users see it (M-CAT-09); no snapshot — nothing yet. */
export async function publicRatingFor(
  executor: DbExecutor,
  supplierId: string,
): Promise<PublicRating> {
  const [row] = await executor
    .select()
    .from(ratingTable)
    .where(eq(ratingTable.supplierId, supplierId));
  return publicRatingOf(row ?? null);
}

/**
 * The rating of suppliers (TASK-050; PRODUCT 13; ARCHITECTURE 5.9, 13.2,
 * 4.71). **`recompute` is the one way a rating is written** — the worker's
 * job after an event and the nightly reconciliation both call it: the
 * numbers of the window (`rating-facts.ts`), the rating by `supplierRating`
 * of `@adclub/domain`, the snapshot, its history when what it shows changed,
 * and the signal «Низкий рейтинг» — in one transaction under a lock of the
 * supplier, so two calculations of one supplier never interleave (the later
 * one reads everything the earlier saw and more).
 */
@Injectable()
export class SupplierRatings {
  private readonly logger = new Logger("Ratings");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
  ) {}

  /** The rules of now: the settings of the group «Рейтинг». */
  async rules(): Promise<RatingRules & { windowDays: number }> {
    const [minReviews, minOrders, weights, windowDays] = await Promise.all([
      this.settings.get("rating_min_reviews"),
      this.settings.get("rating_min_orders"),
      this.settings.get("rating_weights"),
      this.settings.get("rating_window_days"),
    ]);
    return { minReviews, minOrders, weights, windowDays };
  }

  /**
   * Counts the rating of one supplier again and writes it. `changed` — what
   * it shows is not what it was (the history got an entry).
   */
  async recompute(
    supplierId: string,
    cause: "event" | "reconcile",
  ): Promise<{ changed: boolean; rating: SupplierRating | null }> {
    const rules = await this.rules();
    const threshold = await this.settings.get("rating_low_signal");
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`rating:${supplierId}`}))`);
      const [company] = await tx
        .select({ id: supplier.id, name: supplier.name })
        .from(supplier)
        .where(eq(supplier.id, supplierId));
      if (!company) {
        return { changed: false, rating: null };
      }
      const inputs = (await ratingInputs(tx, [supplierId], rules.windowDays)).get(supplierId)!;
      const rating = supplierRating(inputs, rules);
      const [previous] = await tx
        .select()
        .from(ratingTable)
        .where(eq(ratingTable.supplierId, supplierId));
      // The database's clock, as every deadline (one for the API and every worker).
      const clock = await tx.execute<{ ms: string }>(
        sql`SELECT (extract(epoch FROM now()) * 1000)::text AS ms`,
      );
      const at = new Date(Number(clock.rows[0]!.ms));
      const storedRules: SupplierRatingRules = {
        weights: rules.weights,
        minReviews: rules.minReviews,
        minOrders: rules.minOrders,
        windowDays: rules.windowDays,
      };
      const values = {
        score: rating.score,
        isNew: rating.isNew,
        reviewsCount: inputs.reviewsCount,
        reviewsAverage: rating.reviewsAverage,
        answeredCount: inputs.answered,
        answerRequiredCount: inputs.answerRequired,
        keptCount: inputs.kept,
        judgedCount: inputs.judged,
        responseRate: rating.responseRate,
        onTimeRate: rating.onTimeRate,
        formulaVersion: RATING_FORMULA_VERSION,
        rules: storedRules,
        computedAt: at,
      };
      await tx
        .insert(ratingTable)
        .values({ supplierId, ...values })
        .onConflictDoUpdate({ target: ratingTable.supplierId, set: values });
      const after = figuresOf(values);
      const before = previous ? figuresOf(previous) : null;
      const changed = before !== null && !sameFigures(before, after);
      if (before && changed) {
        await tx.insert(supplierRatingHistory).values({
          supplierId,
          cause,
          changedAt: at,
          before,
          after,
        });
      }
      await this.signal(tx, {
        supplierId,
        supplierName: company.name,
        previous: before,
        rating,
        reviewsCount: inputs.reviewsCount,
        threshold,
        at,
      });
      if (changed) {
        this.logger.log(
          `Rating changed supplier=${supplierId} cause=${cause} score=${String(before?.score ?? null)}->${String(rating.score)}`,
        );
      }
      return { changed, rating };
    });
  }

  /**
   * The nightly reconciliation: every supplier counted again by `recompute`.
   * Each supplier in its own transaction — a long night never holds one lock.
   */
  async reconcile(signal?: AbortSignal): Promise<{ suppliers: number; corrected: number }> {
    const ids = (
      await this.database.db.select({ id: supplier.id }).from(supplier).orderBy(asc(supplier.id))
    ).map((row) => row.id);
    let corrected = 0;
    let suppliers = 0;
    for (const id of ids) {
      if (signal?.aborted) {
        break;
      }
      const { changed } = await this.recompute(id, "reconcile");
      suppliers += 1;
      if (changed) {
        corrected += 1;
      }
    }
    this.logger.log(
      `Ratings reconciled suppliers=${String(suppliers)} corrected=${String(corrected)}`,
    );
    return { suppliers, corrected };
  }

  private async signal(
    tx: DbExecutor,
    input: {
      supplierId: string;
      supplierName: string;
      previous: SupplierRatingFigures | null;
      rating: SupplierRating;
      reviewsCount: number;
      threshold: number;
      at: Date;
    },
  ): Promise<void> {
    const open = await this.signals.openOf(tx, KIND, "supplier", input.supplierId);
    const closed = open
      ? undefined
      : await this.signals.lastClosedOf(tx, KIND, "supplier", input.supplierId);
    const move = lowRatingSignalMove({
      previousScore: input.previous?.score ?? null,
      hadPrevious: input.previous !== null,
      score: input.rating.score,
      threshold: input.threshold,
      open: open !== undefined,
      lastClosedByAdmin: closed?.closedByAdminId != null,
    });
    const payload: AdminSignalPayload = {
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      ...(input.rating.score !== null ? { rating: input.rating.score } : {}),
      ratingCount: input.reviewsCount,
      ratingThreshold: input.threshold,
    };
    if (move === "raise" || (move === "refresh" && open?.payload.rating !== input.rating.score)) {
      await this.signals.raise(tx, {
        kind: KIND,
        subjectType: "supplier",
        subjectId: input.supplierId,
        payload,
        at: input.at,
      });
    } else if (move === "close") {
      await this.signals.close(tx, {
        kind: KIND,
        subjectType: "supplier",
        subjectId: input.supplierId,
        payload: { ...open?.payload, ...payload, endedAt: input.at.toISOString() },
        at: input.at,
      });
    }
  }

  // ------------------------------------------------------------- reading

  /** A-SUP-02: the rating of each of these suppliers («новый» — `value` null). */
  async listOf(
    executor: DbExecutor,
    supplierIds: readonly string[],
  ): Promise<Map<string, AdminSupplierListRating>> {
    const found = new Map<string, AdminSupplierListRating>();
    if (supplierIds.length === 0) {
      return found;
    }
    const threshold = await this.settings.get("rating_low_signal");
    const rows = await executor
      .select({
        supplierId: ratingTable.supplierId,
        score: ratingTable.score,
        count: ratingTable.reviewsCount,
      })
      .from(ratingTable)
      .where(inArray(ratingTable.supplierId, [...supplierIds]));
    for (const row of rows) {
      const value = row.score === null ? null : Number(row.score);
      found.set(row.supplierId, {
        value,
        count: row.count,
        low: ratingIsLow(value, threshold),
      });
    }
    return found;
  }

  /** A-SUP-02 «рейтинг»: the condition on `supplier`. */
  async listCondition(filter: SupplierRatingFilter): Promise<SQL> {
    switch (filter) {
      case "new":
        return sql`NOT EXISTS (
          SELECT 1 FROM ${ratingTable} AS r
          WHERE r.supplier_id = supplier.id AND r.score IS NOT NULL
        )`;
      case "rated":
        return sql`EXISTS (
          SELECT 1 FROM ${ratingTable} AS r
          WHERE r.supplier_id = supplier.id AND r.score IS NOT NULL
        )`;
      case "low": {
        const threshold = await this.settings.get("rating_low_signal");
        return sql`EXISTS (
          SELECT 1 FROM ${ratingTable} AS r
          WHERE r.supplier_id = supplier.id AND r.score < ${threshold}
        )`;
      }
    }
  }

  /** A-SUP-03 «Рейтинг и отзывы». */
  async adminView(supplierId: string): Promise<AdminSupplierRating> {
    const db = this.database.db;
    const [company] = await db
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!company) {
      throw new ApiException(404, "NOT_FOUND", "No such supplier");
    }
    const [[row], history, threshold, rules] = await Promise.all([
      db.select().from(ratingTable).where(eq(ratingTable.supplierId, supplierId)),
      db
        .select()
        .from(supplierRatingHistory)
        .where(eq(supplierRatingHistory.supplierId, supplierId))
        .orderBy(desc(supplierRatingHistory.changedAt), desc(supplierRatingHistory.id))
        .limit(HISTORY_SHOWN),
      this.settings.get("rating_low_signal"),
      this.rules(),
    ]);
    const score = row?.score === null || row === undefined ? null : Number(row.score);
    return {
      score,
      isNew: row?.isNew ?? true,
      reviews: {
        count: row?.reviewsCount ?? 0,
        average: row?.reviewsAverage == null ? null : Number(row.reviewsAverage),
      },
      response: {
        answered: row?.answeredCount ?? 0,
        required: row?.answerRequiredCount ?? 0,
        rate: row?.responseRate == null ? null : Number(row.responseRate),
      },
      onTime: {
        kept: row?.keptCount ?? 0,
        judged: row?.judgedCount ?? 0,
        rate: row?.onTimeRate == null ? null : Number(row.onTimeRate),
      },
      rules: row?.rules ?? {
        weights: rules.weights,
        minReviews: rules.minReviews,
        minOrders: rules.minOrders,
        windowDays: rules.windowDays,
      },
      formulaVersion: row?.formulaVersion ?? RATING_FORMULA_VERSION,
      computedAt: row ? row.computedAt.toISOString() : null,
      lowThreshold: threshold,
      low: ratingIsLow(score, threshold),
      history: history.map((entry) => ({
        id: entry.id,
        cause: entry.cause,
        at: entry.changedAt.toISOString(),
        before: entry.before,
        after: entry.after,
      })),
    };
  }
}
