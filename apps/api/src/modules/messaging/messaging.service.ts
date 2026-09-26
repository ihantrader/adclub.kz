import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskPhone } from "@adclub/domain";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { sanitizeForLog } from "../../observability";
import { AppSettings } from "../settings";
import { sendMessageJob } from "./message-jobs";
import { failureKindOfCode } from "./whatsapp-cloud-channel";
import { renderMessageText, type MessageLang, type MessageTemplateKey } from "./message-templates";
import { outboundMessage, type MessageStatus, type OutboundMessageRow } from "./schema";

/**
 * Sending a message to a supplier's employee (TASK-024; PRODUCT 8.4, 15;
 * ARCHITECTURE 9.1, 4.35). The only entrance for other modules: they queue
 * a message in the transaction of their own event, and the worker sends it
 * (`MessageSender`).
 *
 * Nothing about a message is ever written to the log or to monitoring but
 * the template, the language, the status and a masked number: neither the
 * whole number nor the text leaves the process (requirement 6).
 */

/** What a module asks to be sent. */
export interface QueueMessageInput {
  template: MessageTemplateKey;
  /** E.164. */
  phone: string;
  /** The recipient's own language (`notification_language`). */
  lang: MessageLang;
  /** The template's placeholders by name; every declared one is required. */
  variables: Readonly<Record<string, string>>;
  /** What the message is about (`MessageSubjects`). */
  subject: { type: string; id: string | null };
  /**
   * One event, one recipient, one message. Built from the event's own row,
   * so a repeated job, a second worker or a retried transaction all write
   * the same message (`dedupe_key` is unique).
   */
  dedupeKey: string;
}

export interface QueuedMessage {
  id: string;
  /** False — this message already existed: nothing was created and nothing queued twice. */
  created: boolean;
}

/** Statuses a delivery event of the provider may set. */
export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** How far along the delivery chain a status is. */
const DELIVERY_RANK: Readonly<Record<DeliveryStatus, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
  // A failure is not a step of the chain: it may only overtake `sent`.
  failed: 1,
};

/** The states a message can be put back on the queue from (the operator's retry). */
const RETRYABLE: readonly MessageStatus[] = ["queued", "failed", "unknown"];

/** A status nothing the provider says can change any more. */
const TERMINAL: readonly MessageStatus[] = ["failed", "cancelled", "unknown"];

function isDeliveryStatus(status: MessageStatus): status is DeliveryStatus {
  return Object.hasOwn(DELIVERY_RANK, status);
}

/**
 * What a delivery event of the provider does to a message, or `null` — it
 * changes nothing (TASK-024 requirement 4). The provider does not
 * guarantee the order of its events and repeats a delivery until it gets a
 * 200, so:
 *
 * - a step of the chain applies only when it is further along than the one
 *   the message already has (`delivered` after `read` is dropped);
 * - a failure applies only while the message has got no further than
 *   "the provider took it" — a message already reported delivered or read
 *   is not undone;
 * - a message already settled for our own reasons (refused for good,
 *   cancelled, interrupted) is never changed by a late event.
 *
 * A pure function, so the whole table of cases is a unit test.
 */
export function deliveryTransition(
  current: MessageStatus,
  event: DeliveryStatus,
): DeliveryStatus | null {
  if (TERMINAL.includes(current)) {
    return null;
  }
  // A message that is still `queued` or `sending` has no delivery to report on
  // yet: the provider's id is written the moment it answers, a step before the
  // send is settled, and an event that finds the message in between must wait
  // for the settle — writing `delivered` there would break the row's own checks
  // (no send time yet) and the settle would then write `sent` over it.
  if (!isDeliveryStatus(current)) {
    return null;
  }
  const reached = DELIVERY_RANK[current];
  if (event === "failed") {
    return reached <= DELIVERY_RANK.sent ? "failed" : null;
  }
  return DELIVERY_RANK[event] > reached ? event : null;
}

@Injectable()
export class Messaging {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /**
   * Writes the message and queues its sending — in the caller's
   * transaction, so the message exists if and only if the event that
   * caused it does (ARCHITECTURE 13.1). The variables are checked here, so
   * a template used wrongly fails where the mistake is, not in the worker.
   */
  async enqueue(tx: DbExecutor, input: QueueMessageInput): Promise<QueuedMessage> {
    // One snapshot, read once: concurrent `get`s while the cache refreshes would
    // hand the first caller fresh values and the rest the stale ones — a message
    // must not be given the attempts of one moment and the pause of another.
    const {
      message_body_max_length: maxLength,
      message_send_attempts: attempts,
      message_retry_delay_seconds: delaySeconds,
    } = await this.settings.values();
    // Renders only to check: the text itself is built again when the
    // message is sent, from the values stored with it.
    renderMessageText(input.template, input.lang, input.variables, maxLength);
    const [created] = await tx
      .insert(outboundMessage)
      .values({
        dedupeKey: input.dedupeKey,
        template: input.template,
        lang: input.lang,
        phone: input.phone,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        variables: { ...input.variables },
        maxAttempts: attempts,
      })
      .onConflictDoNothing({ target: outboundMessage.dedupeKey })
      .returning({ id: outboundMessage.id });
    if (!created) {
      const [existing] = await tx
        .select({ id: outboundMessage.id })
        .from(outboundMessage)
        .where(eq(outboundMessage.dedupeKey, input.dedupeKey));
      // The unique key held: the same event asked twice.
      return { id: existing!.id, created: false };
    }
    await this.queue.enqueue(
      sendMessageJob,
      { messageId: created.id },
      // The declaration's retries are the queue's backstop; the settings decide
      // how many attempts this message really gets (the first run plus
      // retries), and the handler ends the message on the last one.
      { tx, retry: { limit: Math.max(0, attempts - 1), delaySeconds } },
    );
    this.logger.log(
      `Message queued message=${created.id} template=${input.template} lang=${input.lang} phone=${maskPhone(input.phone)}`,
    );
    return { id: created.id, created: true };
  }

  /** One message, whatever its state. */
  async byId(
    id: string,
    executor: DbExecutor = this.database.db,
  ): Promise<OutboundMessageRow | undefined> {
    const [row] = await executor.select().from(outboundMessage).where(eq(outboundMessage.id, id));
    return row;
  }

  /** The message a provider's id names; `undefined` — none of ours. */
  async byProviderMessageId(
    tx: DbExecutor,
    providerMessageId: string,
  ): Promise<OutboundMessageRow | undefined> {
    const [row] = await tx
      .select()
      .from(outboundMessage)
      .where(eq(outboundMessage.providerMessageId, providerMessageId));
    return row;
  }

  /**
   * Applies one delivery event of the provider. The order of events is not
   * guaranteed (requirement 4): a status is written only when it is further
   * along than the one the message already has, so `delivered` arriving
   * after `read` changes nothing. Returns whether anything changed, so a
   * repeated delivery can be seen for what it is.
   */
  async applyDeliveryStatus(
    tx: DbExecutor,
    input: {
      providerMessageId: string;
      status: DeliveryStatus;
      at: Date;
      /** The provider's reason for a failure; never the text of the message. */
      reason?: string;
      failureCode?: number;
    },
  ): Promise<{ applied: boolean; messageId?: string; settled?: boolean }> {
    const [row] = await tx
      .select()
      .from(outboundMessage)
      .where(eq(outboundMessage.providerMessageId, input.providerMessageId))
      .for("update");
    if (!row) {
      return { applied: false };
    }
    if (row.status === "queued" || row.status === "sending") {
      // Known, but its send is not settled yet: not applied, and not "nothing" —
      // the caller waits for the settle (`WebhookEvents.apply`).
      return { applied: false, messageId: row.id, settled: false };
    }
    const target = deliveryTransition(row.status, input.status);
    if (target === null) {
      return { applied: false, messageId: row.id };
    }
    const now = new Date();
    const patch: Partial<typeof outboundMessage.$inferInsert> = {
      status: target,
      updatedAt: now,
      settledAt: row.settledAt ?? now,
    };
    if (target === "delivered") {
      patch.deliveredAt = input.at;
    }
    if (target === "read") {
      // A `read` that overtook `delivered`: it was delivered, evidently.
      patch.readAt = input.at;
      patch.deliveredAt = row.deliveredAt ?? input.at;
    }
    if (target === "sent") {
      patch.sentAt = row.sentAt ?? input.at;
    }
    if (target === "failed") {
      // What the provider says went wrong, in our own terms; a code we don't
      // know is a plain refusal (nothing about it is worth retrying blindly).
      patch.failureKind = failureKindOfCode(input.failureCode) ?? "rejected";
      // The provider's own title for the failure: written by somebody else,
      // so it goes through the sanitizer like every provider string we keep.
      patch.lastError =
        sanitizeForLog(
          [
            input.failureCode === undefined ? undefined : `error ${String(input.failureCode)}`,
            input.reason,
          ]
            .filter(Boolean)
            .join(" "),
        ).slice(0, 500) || "the provider reported a failure";
    }
    await tx.update(outboundMessage).set(patch).where(eq(outboundMessage.id, row.id));
    return { applied: true, messageId: row.id };
  }

  /** The latest messages for the operator and the development page (no variables — they are gone). */
  async latest(options: {
    limit: number;
    status?: MessageStatus;
    template?: MessageTemplateKey;
  }): Promise<OutboundMessageRow[]> {
    return this.database.db
      .select()
      .from(outboundMessage)
      .where(
        and(
          options.status ? eq(outboundMessage.status, options.status) : undefined,
          options.template ? eq(outboundMessage.template, options.template) : undefined,
        ),
      )
      .orderBy(desc(outboundMessage.createdAt), desc(outboundMessage.id))
      .limit(options.limit);
  }

  /** How many messages are in each state (metrics, `messages:list` summary). */
  async countsByStatus(): Promise<Record<string, number>> {
    const rows = await this.database.db
      .select({ status: outboundMessage.status, count: sql<string>`count(*)` })
      .from(outboundMessage)
      .groupBy(outboundMessage.status);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  /**
   * What the retained webhook deliveries held, by kind and how many of each
   * (`summary` of `inbound_webhook_event`). Deliveries are deleted after
   * `webhook_event_retention_days`, so this is what is on record, not a
   * count since the start.
   */
  async webhookEventKinds(): Promise<{ kind: string; count: number }[]> {
    const rows = await this.database.db.execute<{ kind: string; count: string }>(sql`
      SELECT entry.key AS kind, sum(entry.value::int)::text AS count
      FROM inbound_webhook_event, jsonb_each_text(summary) AS entry
      GROUP BY entry.key
    `);
    return rows.rows.map((row) => ({ kind: row.kind, count: Number(row.count) }));
  }

  /** How many messages of each template ended in each state (metrics). */
  async countsByTemplate(): Promise<{ template: string; status: string; count: number }[]> {
    const rows = await this.database.db
      .select({
        template: outboundMessage.template,
        status: outboundMessage.status,
        count: sql<string>`count(*)`,
      })
      .from(outboundMessage)
      .groupBy(outboundMessage.template, outboundMessage.status);
    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  }

  /**
   * Puts a message that failed or was interrupted back on the queue (the
   * operator: `messages:retry`). The variables were cleared when it was
   * settled, so what can be retried is a message whose values are still
   * there — a `queued` or `sending` one past its claim — or one the module
   * can queue again. A settled message is not resurrected here: the
   * operator is told to ask for the event again instead.
   */
  async retry(messageId: string): Promise<{ status: MessageStatus; queued: boolean }> {
    const { message_send_attempts: attempts, message_retry_delay_seconds: delaySeconds } =
      await this.settings.values();
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outboundMessage)
        .where(eq(outboundMessage.id, messageId))
        .for("update");
      if (!row) {
        throw new MessageNotFoundError(messageId);
      }
      // Only what did not certainly reach the provider can be sent again: a
      // message it took (`sent`, `delivered`, `read`) would go out twice, and a
      // cancelled one no longer has an event behind it. `unknown` is here on
      // purpose: it is exactly what a person decides.
      if (!RETRYABLE.includes(row.status) || row.variables === null) {
        return { status: row.status, queued: false };
      }
      await tx
        .update(outboundMessage)
        .set({
          status: "queued",
          claimedUntil: null,
          // Back in the queue means not settled: the row's own checks say so.
          settledAt: null,
          failureKind: null,
          // A whole new set of attempts, counted from where the message is.
          maxAttempts: row.attempts + attempts,
          updatedAt: new Date(),
        })
        .where(eq(outboundMessage.id, row.id));
      await this.queue.enqueue(
        sendMessageJob,
        { messageId: row.id },
        { tx, retry: { limit: Math.max(0, attempts - 1), delaySeconds } },
      );
      this.logger.log(`Message queued again message=${row.id} was=${row.status}`);
      return { status: "queued" as const, queued: true };
    });
  }

  /** Messages of a subject (the development page and tests). */
  async ofSubject(type: string, ids: readonly string[]): Promise<OutboundMessageRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.database.db
      .select()
      .from(outboundMessage)
      .where(
        and(
          eq(outboundMessage.subjectType, type),
          isNotNull(outboundMessage.subjectId),
          inArray(outboundMessage.subjectId, [...ids]),
        ),
      )
      .orderBy(desc(outboundMessage.createdAt));
  }
}

export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(`There is no message ${messageId}`);
    this.name = "MessageNotFoundError";
  }
}
