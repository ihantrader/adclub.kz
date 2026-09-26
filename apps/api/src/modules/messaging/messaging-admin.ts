import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskPhone } from "@adclub/domain";
import { desc } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { APP_CONFIG, type AppConfig } from "../../config";
import { isMessageTemplateKey, messageTemplate } from "./message-templates";
import { MessageNotFoundError, Messaging } from "./messaging.service";
import { inboundWebhookEvent, type MessageStatus } from "./schema";
import { webhookSignatureHeader } from "./webhook-signature";
import { WHATSAPP_WEBHOOK_PATH } from "../../common/http";

/**
 * What the operator can see and do about messages (TASK-024 requirement 6).
 * Never the values of the placeholders and never a whole number: a name and
 * a telephone are in the database of Kazakhstan, not in a console someone
 * scrolls through.
 */
@Injectable()
export class MessagingAdmin {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The latest messages with their status, newest first. */
  async list(options: { limit?: number; status?: string; template?: string }): Promise<unknown> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    if (options.template !== undefined && !isMessageTemplateKey(options.template)) {
      throw new MessagingCommandError(`There is no message template ${options.template}`);
    }
    const rows = await this.messaging.latest({
      limit,
      status: options.status as MessageStatus | undefined,
      template: options.template,
    });
    return {
      provider: this.config.messaging.provider,
      counts: await this.messaging.countsByStatus(),
      messages: rows.map((row) => ({
        id: row.id,
        template: row.template,
        screen: messageTemplate(row.template).screen,
        lang: row.lang,
        // Only the mask: a whole number never leaves the process.
        phone: maskPhone(row.phone),
        status: row.status,
        attempts: row.attempts,
        provider: row.provider,
        providerMessageId: row.providerMessageId,
        subject: { type: row.subjectType, id: row.subjectId },
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        readAt: row.readAt?.toISOString() ?? null,
        failureKind: row.failureKind,
        lastError: row.lastError,
        /** Whether the message can still be retried (its values are there). */
        canRetry: row.variables !== null,
      })),
    };
  }

  /** Puts a message that failed or was interrupted back on the queue. */
  async retry(messageId: string): Promise<unknown> {
    try {
      const result = await this.messaging.retry(messageId);
      if (!result.queued) {
        throw new MessagingCommandError(
          `The message ${messageId} is ${result.status} and its values are gone: ask the event again instead of retrying the message`,
        );
      }
      this.logger.log(`Message queued again by the operator message=${messageId}`);
      return { messageId, status: result.status };
    } catch (error) {
      if (error instanceof MessageNotFoundError) {
        throw new MessagingCommandError(error.message);
      }
      throw error;
    }
  }

  /** The latest webhook deliveries of the provider and what each held. */
  async webhooks(limit = 20): Promise<unknown> {
    const rows = await this.database.db
      .select({
        id: inboundWebhookEvent.id,
        receivedAt: inboundWebhookEvent.receivedAt,
        processedAt: inboundWebhookEvent.processedAt,
        result: inboundWebhookEvent.result,
        summary: inboundWebhookEvent.summary,
        error: inboundWebhookEvent.error,
      })
      .from(inboundWebhookEvent)
      .orderBy(desc(inboundWebhookEvent.receivedAt), desc(inboundWebhookEvent.id))
      .limit(Math.min(Math.max(limit, 1), 200));
    return {
      events: rows.map((row) => ({
        ...row,
        receivedAt: row.receivedAt.toISOString(),
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Development and tests only: sends a webhook to this deployment's own
   * address, signed with the configured app secret, so the whole path —
   * the signature check, the receipt, the queue and the applying — can be
   * tried without Meta. Nothing external is called: the request goes to
   * `localhost`.
   */
  async devWebhook(input: {
    messageId?: string;
    providerMessageId?: string;
    status?: string;
    /**
     * A press: the name of a quick reply of the message (`confirm`,
     * `decline`) — the payload the message was sent with and, as the sender,
     * the number it was sent to; or a raw payload (anything with a `:`).
     */
    button?: string;
    /** The sender of the press instead of the recipient (a press from another number). */
    from?: string;
    twice?: boolean;
    badSignature?: boolean;
  }): Promise<unknown> {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new MessagingCommandError("dev:messages:webhook runs in development and test only");
    }
    let providerMessageId = input.providerMessageId;
    let row: Awaited<ReturnType<Messaging["byId"]>>;
    if (input.messageId) {
      row = await this.messaging.byId(input.messageId);
      if (!row) {
        throw new MessagingCommandError(`There is no message ${input.messageId}`);
      }
      if (!row.providerMessageId) {
        throw new MessagingCommandError(
          `The message ${input.messageId} has no provider id yet (it is ${row.status})`,
        );
      }
      providerMessageId ??= row.providerMessageId;
    }
    if (!providerMessageId) {
      throw new MessagingCommandError("Give --message <id> or --provider-message-id <wamid>");
    }
    let payload = input.button;
    if (payload !== undefined && !payload.includes(":")) {
      const signed = row?.buttonPayloads?.[payload];
      if (!signed) {
        throw new MessagingCommandError(
          `The message has no button ${payload}; give a raw payload (with a ":") instead`,
        );
      }
      payload = signed;
    }
    const from = (input.from ?? row?.phone ?? "+77055550101").replace(/^\+/, "");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const value = payload
      ? {
          messaging_product: "whatsapp",
          messages: [
            {
              id: `wamid.DEVBUTTON${String(Date.now())}${String(Math.random()).slice(2, 8)}`,
              from,
              type: "button",
              timestamp,
              button: { payload, text: input.button },
              context: { id: providerMessageId },
            },
          ],
        }
      : {
          messaging_product: "whatsapp",
          statuses: [
            {
              id: providerMessageId,
              status: input.status ?? "delivered",
              timestamp,
              recipient_id: "77055550101",
              ...(input.status === "failed"
                ? { errors: [{ code: 131026, title: "Message undeliverable" }] }
                : {}),
            },
          ],
        };
    const body = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "dev", changes: [{ field: "messages", value }] }],
      }),
      "utf8",
    );
    const url = `http://127.0.0.1:${String(this.config.port)}${WHATSAPP_WEBHOOK_PATH}`;
    const appSecret = this.config.messaging.whatsapp.appSecret;
    if (!appSecret) {
      throw new MessagingCommandError("WHATSAPP_APP_SECRET is not configured");
    }
    const signature = input.badSignature
      ? webhookSignatureHeader(body, "a-secret-nobody-configured")
      : webhookSignatureHeader(body, appSecret);
    const deliveries = input.twice ? 2 : 1;
    const answers: { status: number; body: string }[] = [];
    for (let i = 0; i < deliveries; i++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body,
      });
      answers.push({ status: response.status, body: (await response.text()).slice(0, 200) });
    }
    return { url, providerMessageId, deliveries: answers };
  }
}

export class MessagingCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingCommandError";
  }
}
