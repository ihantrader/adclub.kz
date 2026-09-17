import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { and, asc, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../../../database";
import { defineSweeperJob, JobRegistry, type Sweeper, type SweepResult } from "../../../jobs";
import { otpChallenge, session, signInStep } from "../schema";

/**
 * Cleanup of stale sign-in data (TASK-008, D-054; ARCHITECTURE 4.12, 14):
 * login codes, sign-in steps and sessions a while after they stopped being
 * usable. Rows still in use — a code or step not yet consumed and not
 * expired, a session neither ended nor expired — are never touched, and
 * `phone_verification` (the "no WhatsApp" mark) is not cleaned at all.
 * Login limits live in Redis and refresh token reuse only matters for live
 * sessions, so neither depends on these rows.
 */

/** Retention in days, from the `cleanup_*` settings. */
export interface SignInDataRetention {
  loginCodeDays: number;
  signInStepDays: number;
  sessionDays: number;
}

/** Provided by the settings module (TASK-007 pattern). */
export abstract class SignInDataRetentionSource {
  abstract getRetention(): Promise<SignInDataRetention>;
}

export const loginCodeCleanupJob = defineSweeperJob({ name: "identity.cleanup-login-codes" });
export const signInStepCleanupJob = defineSweeperJob({ name: "identity.cleanup-sign-in-steps" });
export const sessionCleanupJob = defineSweeperJob({ name: "identity.cleanup-sessions" });

export const identityJobCatalog = [loginCodeCleanupJob, signInStepCleanupJob, sessionCleanupJob];

const DAY_MS = 24 * 60 * 60 * 1000;

interface StaleRows {
  table: PgTable;
  label: string;
  id: PgColumn;
  /** When the row stopped being usable (the expression the cleanup index is on). */
  endedAt: SQL<Date>;
  retentionDays: (retention: SignInDataRetention) => number;
}

/** Deletes rows of one table whose end is older than the retention (a sweeper, I115). */
class StaleRowsSweeper implements Sweeper<Date> {
  private readonly logger = new Logger("SignInDataCleanup");

  constructor(
    private readonly rows: StaleRows,
    private readonly source: SignInDataRetentionSource,
  ) {}

  async prepare(): Promise<Date> {
    const days = this.rows.retentionDays(await this.source.getRetention());
    return new Date(Date.now() - days * DAY_MS);
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const { table, id, endedAt } = this.rows;
    const found = await tx
      .select({ id })
      .from(table)
      .where(
        and(
          lt(endedAt, cutoff),
          batch.excludeIds.length > 0 ? notInArray(id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(endedAt))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return found.map((row) => row.id as string);
  }

  async apply(tx: DbExecutor, cutoff: Date, rowId: string): Promise<void> {
    await this.applyBatch(tx, cutoff, [rowId]);
  }

  async applyBatch(tx: DbExecutor, cutoff: Date, ids: string[]): Promise<void> {
    const { table, id, endedAt } = this.rows;
    // The end is checked again: nothing still usable is deleted even if the
    // claim and the delete disagreed.
    await tx.delete(table).where(and(inArray(id, ids), lt(endedAt, cutoff)));
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(
        `Stale sign-in data deleted table=${this.rows.label} rows=${result.processed}`,
      );
    }
  }
}

@Injectable()
export class SignInDataCleanup implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(SignInDataRetentionSource) private readonly source: SignInDataRetentionSource,
  ) {}

  onModuleInit(): void {
    this.registry.sweep(
      loginCodeCleanupJob,
      new StaleRowsSweeper(
        {
          table: otpChallenge,
          label: "otp_challenge",
          id: otpChallenge.id,
          endedAt: sql<Date>`COALESCE(${otpChallenge.consumedAt}, ${otpChallenge.expiresAt})`,
          retentionDays: (retention) => retention.loginCodeDays,
        },
        this.source,
      ),
    );
    this.registry.sweep(
      signInStepCleanupJob,
      new StaleRowsSweeper(
        {
          table: signInStep,
          label: "sign_in_step",
          id: signInStep.id,
          endedAt: sql<Date>`COALESCE(${signInStep.consumedAt}, ${signInStep.expiresAt})`,
          retentionDays: (retention) => retention.signInStepDays,
        },
        this.source,
      ),
    );
    this.registry.sweep(
      sessionCleanupJob,
      new StaleRowsSweeper(
        {
          table: session,
          label: "session",
          id: session.id,
          endedAt: sql<Date>`COALESCE(${session.revokedAt}, ${session.expiresAt})`,
          retentionDays: (retention) => retention.sessionDays,
        },
        this.source,
      ),
    );
  }
}

/** The identity module's background jobs, for the worker process. */
@Module({ providers: [SignInDataCleanup] })
export class IdentityJobsModule {}
