import { Inject, Injectable, Logger } from "@nestjs/common";
import { describeError } from "../common/health";
import { DatabaseService, withoutQueryParameters, type DbExecutor } from "../database";
import type { PeriodicJobDefinition, SweepOptions } from "./job-definition";
import type { JobRunContext } from "./job-handler";

/**
 * A deadline sweeper's implementation (ARCHITECTURE 13.1, 4.12 I115): which
 * rows are due, and the transition to apply to one of them (or to a batch).
 */
export interface Sweeper<Context = void> {
  /** Once per run, before the first batch — e.g. thresholds from settings. */
  prepare(): Promise<Context>;
  /**
   * Due row ids, at most `limit`, locked for this transaction and skipping
   * rows another run holds: `… ORDER BY … LIMIT … FOR UPDATE SKIP LOCKED`.
   * Rows in `excludeIds` failed earlier in this run and must be left out.
   */
  claim(
    tx: DbExecutor,
    context: Context,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]>;
  /** The transition for one row. Idempotent. */
  apply(tx: DbExecutor, context: Context, id: string): Promise<void>;
  /**
   * The same transition for many rows at once (optional, faster). If it
   * fails, the batch is applied row by row, so one bad row fails alone.
   */
  applyBatch?(tx: DbExecutor, context: Context, ids: string[]): Promise<void>;
  /** Called after every run, e.g. to log what the run did in the module's words. */
  summary?(result: SweepResult): void;
}

export interface SweepResult {
  /** Rows the transition was applied to. */
  processed: number;
  /** Rows whose transition failed (left as they were; the next run tries again). */
  failed: number;
  batches: number;
  /** False when the run stopped early (time budget, shutdown) with rows possibly left. */
  complete: boolean;
}

const MAX_LOGGED_FAILURES = 10;

@Injectable()
export class SweepRunner {
  private readonly logger = new Logger("Sweeper");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * One run: batches in their own transactions until no due rows remain,
   * the time budget is spent or the worker is stopping. A row that fails
   * is rolled back to its savepoint, logged by id and skipped for the rest
   * of the run; the others go on. A failed batch transaction (database
   * down) fails the run.
   */
  async run<Context>(
    definition: PeriodicJobDefinition,
    sweeper: Sweeper<Context>,
    context: Pick<JobRunContext, "signal">,
    options: SweepOptions = requireSweep(definition),
  ): Promise<SweepResult> {
    const startedAt = Date.now();
    const deadline = startedAt + options.maxRunSeconds * 1000;
    const prepared = await sweeper.prepare();
    const failedIds: string[] = [];
    const result: SweepResult = { processed: 0, failed: 0, batches: 0, complete: false };

    for (;;) {
      if (context.signal.aborted || Date.now() >= deadline) {
        break;
      }
      const batch = await this.database.db.transaction(async (tx) => {
        const ids = await sweeper.claim(tx, prepared, {
          limit: options.batchSize,
          excludeIds: failedIds,
        });
        const outcome = { claimed: ids.length, processed: 0, failedIds: [] as string[] };
        if (ids.length === 0) {
          return outcome;
        }
        if (sweeper.applyBatch && ids.length > 1) {
          try {
            await tx.transaction((savepoint) => sweeper.applyBatch!(savepoint, prepared, ids));
            outcome.processed = ids.length;
            return outcome;
          } catch {
            // Row by row below, so only the rows at fault fail.
          }
        }
        for (const id of ids) {
          try {
            await tx.transaction((savepoint) => sweeper.apply(savepoint, prepared, id));
            outcome.processed += 1;
          } catch (error) {
            outcome.failedIds.push(id);
            if (failedIds.length + outcome.failedIds.length <= MAX_LOGGED_FAILURES) {
              this.logger.warn(
                `Sweep row failed job=${definition.name} row=${id} error=${describeError(withoutQueryParameters(error))}`,
              );
            }
          }
        }
        return outcome;
      });
      result.batches += batch.claimed > 0 ? 1 : 0;
      result.processed += batch.processed;
      result.failed += batch.failedIds.length;
      failedIds.push(...batch.failedIds);
      if (batch.claimed < options.batchSize) {
        result.complete = true;
        break;
      }
    }

    const message = `Sweep finished job=${definition.name} processed=${result.processed} failed=${result.failed} batches=${result.batches} complete=${String(result.complete)} durationMs=${Date.now() - startedAt}`;
    if (result.failed > 0) {
      this.logger.warn(message);
    } else if (result.processed > 0 || !result.complete) {
      this.logger.log(message);
    } else {
      this.logger.debug(message);
    }
    sweeper.summary?.(result);
    return result;
  }
}

function requireSweep(definition: PeriodicJobDefinition): SweepOptions {
  if (!definition.sweep) {
    throw new Error(`Job ${definition.name} is not a sweeper (defineSweeperJob)`);
  }
  return definition.sweep;
}
