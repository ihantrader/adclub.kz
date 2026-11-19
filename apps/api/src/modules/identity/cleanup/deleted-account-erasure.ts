import { randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import { deletedPhoneOf } from "@adclub/domain";
import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray } from "drizzle-orm";
import type { DbExecutor } from "../../../database";
import { defineSweeperJob, type Sweeper, type SweepResult } from "../../../jobs";
import { account, accountConsent } from "../schema";

/**
 * `identity.erase-deleted-accounts` (TASK-072, D-077; ARCHITECTURE 4.96):
 * every minute, a deleted account whose `deleted_at` is older than
 * `deleted_account_retention_days` loses its last traces — the keyed hash
 * of the number (replaced by random letters: nothing links it to a number
 * any more) and the journal of consents — and gets `erased_at`. Its
 * orders, reviews and the action journal stay impersonal, as they were.
 */
export const deletedAccountErasureJob = defineSweeperJob({
  name: "identity.erase-deleted-accounts",
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** What is due: deleted before the cutoff and not erased yet. */
const due = (cutoff: Date) =>
  and(isNotNull(account.deletedAt), isNull(account.erasedAt), lt(account.deletedAt, cutoff));

export class DeletedAccountErasure implements Sweeper<Date> {
  private readonly logger = new Logger("AccountDeletion");

  constructor(private readonly retentionDays: () => Promise<number>) {}

  async prepare(): Promise<Date> {
    return new Date(Date.now() - (await this.retentionDays()) * DAY_MS);
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          due(cutoff),
          batch.excludeIds.length > 0 ? notInArray(account.id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(account.deletedAt))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, id: string): Promise<void> {
    await this.applyBatch(tx, cutoff, [id]);
  }

  async applyBatch(tx: DbExecutor, cutoff: Date, ids: string[]): Promise<void> {
    const erased = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(inArray(account.id, ids), due(cutoff)));
    for (const row of erased) {
      await tx
        .update(account)
        .set({
          phone: deletedPhoneOf(randomBytes(32).toString("hex")),
          erasedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(account.id, row.id));
      await tx.delete(accountConsent).where(eq(accountConsent.accountId, row.id));
    }
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Deleted accounts erased: ${String(result.processed)}`);
    }
  }
}
