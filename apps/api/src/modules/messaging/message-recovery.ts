import { Logger } from "@nestjs/common";
import { and, asc, eq, lt, notInArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import type { Sweeper, SweepResult } from "../../jobs";
import type { MessageSubjects } from "./message-subjects";
import { outboundMessage, type OutboundMessageRow } from "./schema";

/**
 * A message whose sending was interrupted (ARCHITECTURE 4.35 I358). Its
 * attempt claimed it and never settled it — the process was killed, or the
 * bookkeeping after the provider's answer kept failing — and the claim has
 * run out.
 *
 * - If the provider's id had been written down, the provider certainly took
 *   the message: it is `sent`.
 * - If not, nobody can say: it is `unknown`, and a person decides. **Nothing
 *   is ever sent from here** — the second copy of a message to a real person
 *   is worse than a late one.
 *
 * Two things call this: the claim of a retried job (the ordinary case: the
 * queue brings the job back and finds the message like this) and a sweeper
 * that does not depend on any job being left (the job ran out of retries, was
 * deleted, or its worker never came back) — so a message never stays
 * `sending` for good with the name and number of a customer in its values.
 */
export async function recoverInterruptedMessage(
  tx: DbExecutor,
  row: OutboundMessageRow,
  subjects: MessageSubjects,
  logger: Logger,
): Promise<"sent" | "unknown"> {
  const now = new Date();
  if (row.providerMessageId) {
    const channel = row.provider === "test" ? "test" : "whatsapp";
    await tx
      .update(outboundMessage)
      .set({
        status: "sent",
        sentAt: row.sentAt ?? now,
        settledAt: now,
        claimedUntil: null,
        variables: row.provider === "test" ? row.variables : null,
        failureKind: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(outboundMessage.id, row.id));
    await subjects.onResult(tx, row.subjectType, row.subjectId, {
      kind: "sent",
      channel,
      providerMessageId: row.providerMessageId,
    });
    logger.warn(
      `Message recovered as sent message=${row.id} template=${row.template}: its attempt was interrupted after the provider answered`,
    );
    return "sent";
  }
  await tx
    .update(outboundMessage)
    .set({
      status: "unknown",
      settledAt: now,
      claimedUntil: null,
      // The values stay: the operator may decide to send it after all.
      lastError: "interrupted while sending",
      updatedAt: now,
    })
    .where(eq(outboundMessage.id, row.id));
  await subjects.onResult(tx, row.subjectType, row.subjectId, {
    kind: "unknown",
    reason: "interrupted while sending",
  });
  logger.warn(
    `Message left in an unknown state message=${row.id} template=${row.template}: an attempt was interrupted while sending`,
  );
  return "unknown";
}

/**
 * How long past its claim a `sending` message is left alone by the sweeper:
 * an attempt that is still in flight when its claim runs out (the job's own
 * limit is shorter than the claim, so this is only a settings mistake or a
 * slow settle) is not taken away from under it.
 */
export const RECOVERY_GRACE_MS = 60_000;

/** The sweeper that recovers interrupted messages nobody's job will come back for. */
export class InterruptedMessagesSweep implements Sweeper<Date> {
  private readonly logger = new Logger("Messaging");

  constructor(private readonly subjects: MessageSubjects) {}

  prepare(): Promise<Date> {
    return Promise.resolve(new Date(Date.now() - RECOVERY_GRACE_MS));
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: outboundMessage.id })
      .from(outboundMessage)
      .where(
        and(
          eq(outboundMessage.status, "sending"),
          lt(outboundMessage.claimedUntil, cutoff),
          batch.excludeIds.length > 0
            ? notInArray(outboundMessage.id, batch.excludeIds)
            : undefined,
        ),
      )
      .orderBy(asc(outboundMessage.claimedUntil))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, id: string): Promise<void> {
    const [row] = await tx
      .select()
      .from(outboundMessage)
      .where(eq(outboundMessage.id, id))
      .for("update");
    // Checked again under the lock: an attempt that settled in the meantime is left as it is.
    if (
      !row ||
      row.status !== "sending" ||
      !row.claimedUntil ||
      row.claimedUntil.getTime() >= cutoff.getTime()
    ) {
      return;
    }
    await recoverInterruptedMessage(tx, row, this.subjects, this.logger);
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Interrupted messages recovered rows=${String(result.processed)}`);
    }
  }
}
