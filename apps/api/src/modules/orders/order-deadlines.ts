import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { defineSweeperJob, JobRegistry, type Sweeper, type SweepResult } from "../../jobs";
import { OrderTransitions, type DeadlineOutcome } from "./order-transitions";

/**
 * The deadlines of orders (ARCHITECTURE 13.1, 13.2, 6.1, 4.31; TASK-021
 * requirement 3): every minute one sweeper takes the orders past a
 * deadline — no answer by `respond_by` (→ `response_expired`, the journal
 * says «нет ответа»), the end of the pickup reserve (→ `reserve_expired`),
 * the time to warn that the reserve ends — in batches, and applies the move
 * through the same state machine as people (`OrderTransitions.applyDue`).
 *
 * The deadlines live in the orders, not in the queue: a worker that was
 * down for hours finds everything that fell due and applies it once
 * (a reserve already over is expired without a warning first). The claim
 * locks the rows (`SKIP LOCKED`), the move is conditional and re-checks
 * the deadline, so a second worker, a repeat of the run or a person acting
 * at the same moment never applies anything twice.
 */

export const orderDeadlinesJob = defineSweeperJob({ name: "orders.apply-deadlines" });

export const orderJobCatalog = [orderDeadlinesJob];

@Injectable()
export class OrderDeadlineSweeper implements Sweeper<void>, OnModuleInit {
  private readonly logger = new Logger("OrderDeadlines");
  private readonly done = new Map<Exclude<DeadlineOutcome, null>, number>();

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(OrderTransitions) private readonly transitions: OrderTransitions,
  ) {}

  onModuleInit(): void {
    this.registry.sweep(orderDeadlinesJob, this);
  }

  async prepare(): Promise<void> {
    this.done.clear();
  }

  async claim(
    tx: DbExecutor,
    _context: void,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const now = new Date().toISOString();
    const excluded =
      batch.excludeIds.length > 0
        ? sql`AND o.id NOT IN (${sql.join(
            batch.excludeIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
    // Each due condition has its own partial index (the migration).
    const due = await tx.execute<{ id: string }>(sql`
      SELECT o.id FROM customer_order o
      WHERE o.id IN (
          SELECT id FROM customer_order
          WHERE status = 'created' AND respond_by <= ${now}::timestamptz
          UNION ALL
          SELECT id FROM customer_order
          WHERE status IN ('accepted', 'ready') AND expires_at IS NOT NULL
            AND expires_at <= ${now}::timestamptz
          UNION ALL
          SELECT id FROM customer_order
          WHERE status IN ('accepted', 'ready') AND reserve_warned_at IS NULL
            AND reserve_warn_at <= ${now}::timestamptz
        )
        ${excluded}
      ORDER BY least(
        CASE WHEN o.status = 'created' THEN o.respond_by END,
        CASE WHEN o.status <> 'created' THEN o.expires_at END,
        CASE WHEN o.status <> 'created' AND o.reserve_warned_at IS NULL THEN o.reserve_warn_at END
      ), o.id
      LIMIT ${batch.limit}
      FOR UPDATE OF o SKIP LOCKED
    `);
    return due.rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, _context: void, id: string): Promise<void> {
    const outcome = await this.transitions.applyDue(tx, id);
    if (outcome) {
      this.done.set(outcome, (this.done.get(outcome) ?? 0) + 1);
    }
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      const parts = [...this.done.entries()].map(([what, rows]) => `${what}=${String(rows)}`);
      this.logger.log(`Order deadlines applied ${parts.join(" ")}`);
    }
  }
}

/** The orders module's background jobs, for the worker process. */
@Module({ providers: [OrderTransitions, OrderDeadlineSweeper] })
export class OrderJobsModule {}
