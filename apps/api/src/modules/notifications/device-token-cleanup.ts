import { Logger } from "@nestjs/common";
import { and, eq, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import type { Sweeper, SweepResult } from "../../jobs";
import { session } from "../identity";
import type { AppSettings } from "../settings";
import { deviceToken } from "./schema";

interface CleanupContext {
  /** Tokens taken off push before this are deleted. */
  deleteBefore: Date;
}

/**
 * `notifications.cleanup-device-tokens` (TASK-051 requirement 2): a token
 * whose session no longer holds is taken off push here too — the sender
 * already sends it nothing, this keeps the table saying so — and a token
 * taken off push longer ago than `push_token_retention_days` is deleted.
 */
export class DeviceTokenCleanup implements Sweeper<CleanupContext> {
  private readonly logger = new Logger("Notifications");

  constructor(private readonly settings: AppSettings) {}

  async prepare(): Promise<CleanupContext> {
    const days = await this.settings.get("push_token_retention_days");
    return { deleteBefore: new Date(Date.now() - days * 86_400_000) };
  }

  async claim(
    tx: DbExecutor,
    context: CleanupContext,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: deviceToken.id })
      .from(deviceToken)
      .innerJoin(session, eq(session.id, deviceToken.sessionId))
      .where(
        and(
          or(
            and(
              isNotNull(deviceToken.deactivatedAt),
              lt(deviceToken.deactivatedAt, context.deleteBefore),
            ),
            and(
              isNull(deviceToken.deactivatedAt),
              sql`NOT (${session.revokedAt} IS NULL AND ${session.expiresAt} > now()
                AND (${session.absoluteExpiresAt} IS NULL OR ${session.absoluteExpiresAt} > now()))`,
            ),
          ),
          batch.excludeIds.length > 0 ? notInArray(deviceToken.id, batch.excludeIds) : undefined,
        ),
      )
      .limit(batch.limit)
      .for("update", { of: deviceToken, skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, context: CleanupContext, id: string): Promise<void> {
    const [row] = await tx.select().from(deviceToken).where(eq(deviceToken.id, id)).for("update");
    if (!row) return;
    if (row.deactivatedAt) {
      if (row.deactivatedAt.getTime() < context.deleteBefore.getTime()) {
        await tx.delete(deviceToken).where(eq(deviceToken.id, id));
      }
      return;
    }
    const now = new Date();
    await tx
      .update(deviceToken)
      .set({ deactivatedAt: now, deactivatedReason: "session_ended", updatedAt: now })
      .where(and(eq(deviceToken.id, id), isNull(deviceToken.deactivatedAt)));
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Device tokens cleaned rows=${String(result.processed)}`);
    }
  }
}
