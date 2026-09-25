import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, asc, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { defineSweeperJob, JobRegistry, type Sweeper, type SweepResult } from "../../jobs";
import { AppSettings } from "../settings";
import { customerOrder } from "./schema";

/**
 * The key of a creation request doesn't live for ever (TASK-022, debt 7 of
 * TASK-021). `idempotencyKey` is what the app sends so that a double tap or
 * a repeat after a lost answer finds the order already made — it matters
 * for minutes, not for years, and a key kept for ever is one more piece of
 * a request stored next to an order (PRODUCT 17). Once an order has been
 * finished for `cleanup_order_idempotency_retention_days`, the key is
 * cleared: the order itself, its journal and its money stay untouched.
 *
 * Orders still going on are never touched, so a repeat of a creation always
 * finds its order while that order is alive.
 */
export const orderIdempotencyCleanupJob = defineSweeperJob({
  name: "orders.cleanup-idempotency-keys",
});

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OrderIdempotencyCleanup implements Sweeper<Date>, OnModuleInit {
  private readonly logger = new Logger("OrderCleanup");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  onModuleInit(): void {
    this.registry.sweep(orderIdempotencyCleanupJob, this);
  }

  async prepare(): Promise<Date> {
    const days = await this.settings.get("cleanup_order_idempotency_retention_days");
    return new Date(Date.now() - days * DAY_MS);
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const found = await tx
      .select({ id: customerOrder.id })
      .from(customerOrder)
      .where(
        and(
          isNotNull(customerOrder.idempotencyKey),
          isNotNull(customerOrder.finishedAt),
          lt(customerOrder.finishedAt, cutoff),
          batch.excludeIds.length > 0 ? notInArray(customerOrder.id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(customerOrder.finishedAt))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return found.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, orderId: string): Promise<void> {
    await this.applyBatch(tx, cutoff, [orderId]);
  }

  async applyBatch(tx: DbExecutor, cutoff: Date, ids: string[]): Promise<void> {
    // The retention is checked again: an order still going on is never
    // touched even if the claim and the update disagreed.
    await tx
      .update(customerOrder)
      .set({ idempotencyKey: null })
      .where(
        and(
          inArray(customerOrder.id, ids),
          isNotNull(customerOrder.finishedAt),
          lt(customerOrder.finishedAt, cutoff),
          sql`${customerOrder.status} NOT IN ('created', 'accepted', 'ready')`,
        ),
      );
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Idempotency keys cleared orders=${String(result.processed)}`);
    }
  }
}
