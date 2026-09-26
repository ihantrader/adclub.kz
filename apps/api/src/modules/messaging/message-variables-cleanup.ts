import { Logger } from "@nestjs/common";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import type { Sweeper, SweepResult } from "../../jobs";
import type { AppSettings } from "../settings";
import { outboundMessage } from "./schema";

/**
 * Clears the values of the placeholders of messages that are settled and
 * still hold them (ARCHITECTURE 4.35): a message refused for good keeps
 * them so the operator can retry it, and the rows of the test channel keep
 * them so development can see what would have gone out. After
 * `message_variables_retention_days` neither reason holds any more, and a
 * name and a telephone number have no business in a delivery log.
 *
 * Nothing else is deleted: the message itself, its template, language,
 * number and delivery stay as the log of what was sent.
 */
export class MessageVariablesCleanup implements Sweeper<Date> {
  private readonly logger = new Logger("Messaging");

  constructor(private readonly settings: AppSettings) {}

  async prepare(): Promise<Date> {
    const days = await this.settings.get("message_variables_retention_days");
    return new Date(Date.now() - days * 24 * 3600_000);
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
          isNotNull(outboundMessage.variables),
          isNotNull(outboundMessage.settledAt),
          lt(outboundMessage.settledAt, cutoff),
          batch.excludeIds.length > 0
            ? sql`${outboundMessage.id} <> ALL(${`{${batch.excludeIds.join(",")}}`}::uuid[])`
            : undefined,
        ),
      )
      .orderBy(outboundMessage.settledAt)
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, id: string): Promise<void> {
    await this.applyBatch(tx, cutoff, [id]);
  }

  async applyBatch(tx: DbExecutor, cutoff: Date, ids: string[]): Promise<void> {
    await tx
      .update(outboundMessage)
      .set({ variables: null, updatedAt: new Date() })
      .where(
        and(
          sql`${outboundMessage.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`,
          isNotNull(outboundMessage.settledAt),
          lt(outboundMessage.settledAt, cutoff),
        ),
      );
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Message values cleared rows=${String(result.processed)}`);
    }
  }
}
