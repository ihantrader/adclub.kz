import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskPhone, normalizeKzMobilePhone } from "@adclub/domain";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue, type Sweeper, type SweepResult } from "../../jobs";
import { Metrics, sanitizeForLog } from "../../observability";
import { AppSettings } from "../settings";
import { applyButtonPressJob } from "./button-presses";
import { applyWebhookEventJob } from "./message-jobs";
import { Messaging, type DeliveryStatus } from "./messaging.service";
import { messageTemplates } from "./message-templates";
import { inboundWebhookEvent, messageButtonPress } from "./schema";
import { webhookEventId } from "./webhook-signature";

/**
 * What the provider sends back (TASK-024 requirement 4). Two things matter
 * now: what became of a message we sent, and that somebody pressed a
 * button. Everything else — a text message a person wrote, a change of a
 * template's status, a kind that does not exist yet — is accepted, counted
 * and left alone: a webhook that fails is a webhook the provider keeps
 * repeating.
 *
 * The receipt and the applying are deliberately apart. The request only
 * checks the signature, writes the delivery down and queues the work, so
 * the provider gets its 200 in milliseconds; the worker parses and applies
 * it. Applying is idempotent twice over: the delivery is one row keyed by
 * the digest of its body, and every status it carries only ever moves a
 * message forward.
 */

/** The parts of Meta's webhook body this platform reads. */
const payloadSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z
          .array(
            z.object({
              field: z.string().optional(),
              value: z
                .object({
                  messaging_product: z.string().optional(),
                  statuses: z
                    .array(
                      z.object({
                        id: z.string().optional(),
                        status: z.string().optional(),
                        timestamp: z.union([z.string(), z.number()]).optional(),
                        recipient_id: z.string().optional(),
                        errors: z
                          .array(
                            z.object({
                              code: z.number().optional(),
                              title: z.string().optional(),
                              message: z.string().optional(),
                            }),
                          )
                          .optional(),
                      }),
                    )
                    .optional(),
                  messages: z
                    .array(
                      z.object({
                        id: z.string().optional(),
                        from: z.string().optional(),
                        type: z.string().optional(),
                        timestamp: z.union([z.string(), z.number()]).optional(),
                        button: z
                          .object({ payload: z.string().optional(), text: z.string().optional() })
                          .optional(),
                        interactive: z
                          .object({
                            type: z.string().optional(),
                            button_reply: z
                              .object({ id: z.string().optional(), title: z.string().optional() })
                              .optional(),
                          })
                          .optional(),
                        context: z.object({ id: z.string().optional() }).optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const DELIVERY_STATUSES: readonly string[] = ["sent", "delivered", "read", "failed"];

/** All the button names of the registry: a payload naming one is recognised. */
const BUTTON_NAMES = new Set(
  Object.values(messageTemplates).flatMap((template) =>
    template.buttons.map((button) => button.name),
  ),
);

/**
 * How long an event about a message we do not know is waited on before it is
 * given up as "not ours". The provider can report on a message a moment before
 * the send that produced it has been recorded (the id is written right after
 * the provider answers, but the event and the write race), so a young event
 * about an unknown id is looked at again, not thrown away with its body.
 */
export const UNKNOWN_MESSAGE_GRACE_MS = 60_000;
/** How long before a deferred event is looked at again. */
export const DEFERRED_RETRY_MS = 20_000;

/** Thrown inside the applying transaction to roll it back: the event is looked at again later. */
class DeferEvent extends Error {}

export interface WebhookReceipt {
  eventId: string;
  /** False — this very delivery was already taken: nothing was created. */
  created: boolean;
}

@Injectable()
export class WebhookEvents {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /**
   * Takes one delivery whose signature has been checked: writes it down
   * and queues the applying. Nothing of the body is read here beyond
   * whether it is JSON at all — the parsing belongs to the worker.
   */
  async receive(body: Buffer): Promise<WebhookReceipt> {
    const externalId = webhookEventId(body);
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      // A signed body that is not JSON: written down all the same, so a
      // provider that changed its format is visible instead of silent.
      payload = { unparsed: true };
    }
    return this.database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(inboundWebhookEvent)
        .values({ provider: "whatsapp", externalId, payload: payload as Record<string, unknown> })
        .onConflictDoNothing({
          target: [inboundWebhookEvent.provider, inboundWebhookEvent.externalId],
        })
        .returning({ id: inboundWebhookEvent.id });
      if (!created) {
        const [existing] = await tx
          .select({ id: inboundWebhookEvent.id })
          .from(inboundWebhookEvent)
          .where(
            and(
              eq(inboundWebhookEvent.provider, "whatsapp"),
              eq(inboundWebhookEvent.externalId, externalId),
            ),
          );
        this.metrics.countWebhookEvent("repeated");
        return { eventId: existing!.id, created: false };
      }
      await this.queue.enqueue(applyWebhookEventJob, { eventId: created.id }, { tx });
      this.metrics.countWebhookEvent("received");
      return { eventId: created.id, created: true };
    });
  }

  /**
   * Applies one delivery. Every status it carries is written to its
   * message; every button press is stored and linked. An event about a
   * message we don't have, or of a kind nothing acts on, is `nothing_to_apply`
   * — which is a success: there is nothing for the provider to repeat.
   */
  async apply(eventId: string): Promise<{ result: "applied" | "nothing_to_apply" | "deferred" }> {
    try {
      return await this.applyOnce(eventId);
    } catch (error) {
      if (error instanceof DeferEvent) {
        this.logger.log(
          `Webhook event deferred, a message is not on record or settled yet event=${eventId}`,
        );
        return { result: "deferred" };
      }
      throw error;
    }
  }

  private async applyOnce(eventId: string): Promise<{ result: "applied" | "nothing_to_apply" }> {
    return this.database.db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(inboundWebhookEvent)
        .where(eq(inboundWebhookEvent.id, eventId))
        .for("update");
      if (!event) {
        return { result: "nothing_to_apply" as const };
      }
      if (event.processedAt && event.result !== "failed") {
        // Applied already: a repeat changes nothing (requirement 4).
        return { result: event.result === "applied" ? "applied" : "nothing_to_apply" };
      }
      // A signed body that was not JSON was stored as `{ unparsed: true }`.
      const unparsed = (event.payload as { unparsed?: unknown } | null)?.unparsed === true;
      const parsed = unparsed ? undefined : payloadSchema.safeParse(event.payload);
      const summary: Record<string, number> = {};
      // What the delivery held goes into its own row (`summary`), and the
      // metrics endpoint samples it from there: this runs in the worker,
      // whose memory nobody scrapes.
      const count = (kind: string) => {
        summary[kind] = (summary[kind] ?? 0) + 1;
      };
      let applied = 0;
      if (parsed === undefined) {
        count("unparsed_body");
      } else if (!parsed.success) {
        count("unknown_shape");
      } else {
        for (const entry of parsed.data.entry ?? []) {
          for (const change of entry.changes ?? []) {
            const value = change.value;
            if (!value) {
              count("unknown");
              continue;
            }
            for (const status of value.statuses ?? []) {
              applied += (await this.applyStatus(tx, status, count)) ? 1 : 0;
            }
            for (const message of value.messages ?? []) {
              applied += (await this.applyMessage(tx, event.id, message, count)) ? 1 : 0;
            }
            if ((value.statuses ?? []).length === 0 && (value.messages ?? []).length === 0) {
              count(change.field ? `other:${change.field}` : "other");
            }
          }
        }
        if ((parsed.data.entry ?? []).length === 0) {
          count("empty");
        }
      }
      // A status for a message we do not have yet, or whose send is not settled
      // yet: too soon to say it is not ours. The whole pass is rolled back —
      // whatever it applied is applied again with the rest, so the event's
      // result and counts describe one pass — and its body is kept until it is
      // finally settled.
      if (
        ((summary["status:unknown_message"] ?? 0) > 0 ||
          (summary["status:not_settled"] ?? 0) > 0) &&
        Date.now() - event.receivedAt.getTime() < UNKNOWN_MESSAGE_GRACE_MS
      ) {
        throw new DeferEvent();
      }
      const result = applied > 0 ? "applied" : ("nothing_to_apply" as const);
      await tx
        .update(inboundWebhookEvent)
        .set({
          processedAt: new Date(),
          result,
          // The body is gone the moment it has been applied: it carries the
          // numbers of recipients and whatever a person wrote (4.35).
          payload: null,
          summary,
          error: null,
        })
        .where(eq(inboundWebhookEvent.id, event.id));
      this.logger.log(
        `Webhook event applied event=${event.id} result=${result} ${Object.entries(summary)
          .map(([kind, n]) => `${kind}=${String(n)}`)
          .join(" ")}`,
      );
      return { result };
    });
  }

  /** Marks an event whose applying failed, so the retry can see it (the job throws). */
  async recordFailure(eventId: string, error: string): Promise<void> {
    await this.database.db
      .update(inboundWebhookEvent)
      .set({
        processedAt: new Date(),
        result: "failed",
        error: sanitizeForLog(error).slice(0, 500),
      })
      .where(eq(inboundWebhookEvent.id, eventId));
  }

  private async applyStatus(
    tx: DbExecutor,
    status: {
      id?: string;
      status?: string;
      timestamp?: string | number;
      errors?: { code?: number; title?: string; message?: string }[];
    },
    count: (kind: string) => void,
  ): Promise<boolean> {
    if (!status.id || !status.status || !DELIVERY_STATUSES.includes(status.status)) {
      count(status.status ? `status:${status.status}` : "status:unknown");
      return false;
    }
    const error = status.errors?.[0];
    const { applied, messageId, settled } = await this.messaging.applyDeliveryStatus(tx, {
      providerMessageId: status.id,
      status: status.status as DeliveryStatus,
      at: timestampOf(status.timestamp),
      reason: error?.title ?? error?.message,
      failureCode: error?.code,
    });
    if (settled === false) {
      // The message is ours but its send has not been settled yet: too soon.
      count("status:not_settled");
      return false;
    }
    if (messageId === undefined) {
      // An event about a message that is not ours (another deployment on
      // the same number, or one long deleted): accepted, not applied.
      count("status:unknown_message");
      return false;
    }
    count(applied ? `status:${status.status}` : `status:${status.status}:no_change`);
    return applied;
  }

  private async applyMessage(
    tx: DbExecutor,
    eventId: string,
    message: {
      id?: string;
      from?: string;
      type?: string;
      button?: { payload?: string; text?: string };
      interactive?: { button_reply?: { id?: string; title?: string } };
      context?: { id?: string };
    },
    count: (kind: string) => void,
  ): Promise<boolean> {
    const payload = message.button?.payload ?? message.interactive?.button_reply?.id;
    if (!message.id || payload === undefined) {
      // Anything a person typed themselves: not a button, nothing is done
      // with it, and its text is never stored (PRODUCT 15 — the platform
      // does not carry a chat).
      count(message.type ? `incoming:${message.type}` : "incoming");
      return false;
    }
    const fromPhone = phoneOf(message.from);
    if (!fromPhone) {
      count("button:unknown_sender");
      return false;
    }
    const context = message.context?.id;
    const related = context ? await this.messaging.byProviderMessageId(tx, context) : undefined;
    const [stored] = await tx
      .insert(messageButtonPress)
      .values({
        eventId,
        messageId: related?.id ?? null,
        providerMessageId: message.id,
        contextProviderMessageId: context ?? null,
        buttonName: BUTTON_NAMES.has(payload) ? payload : buttonNameOf(payload),
        payload: payload.slice(0, 500),
        fromPhone,
      })
      .onConflictDoNothing({ target: messageButtonPress.providerMessageId })
      .returning({ id: messageButtonPress.id });
    if (!stored) {
      count("button:repeated");
      return false;
    }
    // Stored and linked; what it means is decided out of this transaction's
    // way, by the module that owns the button (`ButtonPressApplier`,
    // TASK-025). Queued here, so a press exists if and only if its job does.
    await this.queue.enqueue(applyButtonPressJob, { pressId: stored.id }, { tx });
    this.logger.log(
      `Button press stored press=${stored.id} message=${related?.id ?? "unknown"} from=${maskPhone(fromPhone)}`,
    );
    count(related ? "button" : "button:unknown_message");
    return true;
  }
}

/**
 * The name of the button a payload names. Signed payloads carry the button
 * first (`confirm:<order>:<employee>:<expiry>:<signature>`, `ButtonPayloads`);
 * a payload we cannot read is stored with no name rather than guessed at.
 */
function buttonNameOf(payload: string): string | null {
  const head = payload.split(":")[0] ?? "";
  return BUTTON_NAMES.has(head) ? head : null;
}

/** Meta sends a Unix timestamp in seconds, as a string. */
function timestampOf(value: string | number | undefined): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date();
  }
  const at = new Date(seconds * 1000);
  // A timestamp from the future (a provider's clock) is not written down.
  return at.getTime() > Date.now() ? new Date() : at;
}

/** The sender of an incoming message, as E.164 (Meta sends it without the `+`). */
function phoneOf(from: string | undefined): string | null {
  if (!from) {
    return null;
  }
  const withPlus = from.startsWith("+") ? from : `+${from}`;
  return normalizeKzMobilePhone(withPlus) ?? (/^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null);
}

/**
 * Deletes webhook deliveries that have been applied and are older than
 * `webhook_event_retention_days` (their bodies are long gone; what remains
 * is the count of what they held).
 */
export class WebhookEventCleanup implements Sweeper<Date> {
  private readonly logger = new Logger("Messaging");

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
  ) {}

  async prepare(): Promise<Date> {
    const days = await this.settings.get("webhook_event_retention_days");
    return new Date(Date.now() - days * 24 * 3600_000);
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: inboundWebhookEvent.id })
      .from(inboundWebhookEvent)
      .where(
        and(
          isNotNull(inboundWebhookEvent.processedAt),
          lt(inboundWebhookEvent.processedAt, cutoff),
          batch.excludeIds.length > 0
            ? sql`${inboundWebhookEvent.id} <> ALL(${`{${batch.excludeIds.join(",")}}`}::uuid[])`
            : undefined,
        ),
      )
      .orderBy(inboundWebhookEvent.processedAt)
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, id: string): Promise<void> {
    await this.applyBatch(tx, cutoff, [id]);
  }

  async applyBatch(tx: DbExecutor, cutoff: Date, ids: string[]): Promise<void> {
    await tx
      .delete(inboundWebhookEvent)
      .where(
        and(
          sql`${inboundWebhookEvent.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`,
          isNotNull(inboundWebhookEvent.processedAt),
          lt(inboundWebhookEvent.processedAt, cutoff),
        ),
      );
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Webhook events deleted rows=${String(result.processed)}`);
    }
  }
}
