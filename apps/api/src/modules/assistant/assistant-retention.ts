import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { defineSweeperJob, type Sweeper, type SweepResult } from "../../jobs";
import { AppSettings } from "../settings";
import { assistantComplaint, assistantDialog, assistantMessage } from "./schema";

/**
 * `assistant.anonymize-messages` (TASK-062; ARCHITECTURE 11.1 point 6,
 * 4.85): every minute, the messages of dialogs with the assistant older than
 * `assistant_retention_days` lose their words — the text, the tool calls
 * (their arguments hold the person's words) and the quick replies — and get
 * `anonymized_at`; the text of a complaint about such an answer goes with
 * them. The rows, the kinds, the intents and the items of the answers stay
 * for the statistics.
 */
export const anonymizeAssistantMessagesJob = defineSweeperJob({
  name: "assistant.anonymize-messages",
});

export const assistantJobCatalog = [anonymizeAssistantMessagesJob];

const due = (days: number) =>
  and(
    isNull(assistantMessage.anonymizedAt),
    sql`${assistantMessage.createdAt} < now() - make_interval(days => ${days})`,
  );

/**
 * TASK-072 (D-077): the member deleted the account — every message of their
 * dialogs loses its words at once, as the sweeper does after
 * `assistant_retention_days`, and so does the text of a complaint about
 * them. The dialogs, their costs and the complaints stay (the administrator
 * resolves a complaint on what is left); the dialog keeps no car.
 */
export async function anonymizeDialogsOfAccount(
  tx: DbExecutor,
  accountId: string,
): Promise<number> {
  const dialogs = await tx
    .select({ id: assistantDialog.id })
    .from(assistantDialog)
    .where(eq(assistantDialog.accountId, accountId));
  const ids = dialogs.map((dialog) => dialog.id);
  if (ids.length === 0) {
    return 0;
  }
  await tx
    .update(assistantMessage)
    .set({
      text: null,
      toolCalls: [],
      reply: sql`CASE WHEN ${assistantMessage.reply} ? 'question' AND ${assistantMessage.reply} -> 'question' <> 'null'::jsonb
                      THEN jsonb_set(${assistantMessage.reply}, '{question,options}', '[]'::jsonb)
                      ELSE ${assistantMessage.reply} END`,
      anonymizedAt: sql`COALESCE(${assistantMessage.anonymizedAt}, now())`,
    })
    .where(inArray(assistantMessage.dialogId, ids));
  await tx
    .update(assistantComplaint)
    .set({ text: null, updatedAt: sql`now()` })
    .where(inArray(assistantComplaint.dialogId, ids));
  await tx
    .update(assistantDialog)
    .set({ carId: null, updatedAt: sql`now()` })
    .where(inArray(assistantDialog.id, ids));
  return ids.length;
}

@Injectable()
export class AssistantRetention implements Sweeper<number> {
  private readonly logger = new Logger("Assistant");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AppSettings) private readonly settings: AppSettings) {}

  prepare(): Promise<number> {
    return this.settings.get("assistant_retention_days");
  }

  async claim(
    tx: DbExecutor,
    days: number,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: assistantMessage.id })
      .from(assistantMessage)
      .where(
        and(
          due(days),
          batch.excludeIds.length > 0
            ? notInArray(assistantMessage.id, batch.excludeIds)
            : undefined,
        ),
      )
      .orderBy(asc(assistantMessage.createdAt))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, days: number, id: string): Promise<void> {
    await this.applyBatch(tx, days, [id]);
  }

  async applyBatch(tx: DbExecutor, days: number, ids: string[]): Promise<void> {
    await tx
      .update(assistantMessage)
      .set({
        text: null,
        toolCalls: [],
        reply: sql`CASE WHEN ${assistantMessage.reply} ? 'question' AND ${assistantMessage.reply} -> 'question' <> 'null'::jsonb
                        THEN jsonb_set(${assistantMessage.reply}, '{question,options}', '[]'::jsonb)
                        ELSE ${assistantMessage.reply} END`,
        anonymizedAt: sql`now()`,
      })
      .where(and(inArray(assistantMessage.id, ids), due(days)));
    await tx
      .update(assistantComplaint)
      .set({ text: null, updatedAt: sql`now()` })
      .where(inArray(assistantComplaint.messageId, ids));
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Assistant messages made impersonal: ${String(result.processed)}`);
    }
  }
}
