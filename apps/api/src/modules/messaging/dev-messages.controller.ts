import { Controller, Get, Inject, Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { messageTemplate, renderMessageText } from "./message-templates";
import { inboundWebhookEvent, messageButtonPress, outboundMessage } from "./schema";

/** Not part of the contract; excluded from the served-routes check (as `/dev/login-codes`). */
export const DEV_MESSAGES_PATH = "/dev/messages";

interface DevMessage {
  id: string;
  template: string;
  screen: string;
  lang: string;
  phone: string;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failureKind: string | null;
  lastError: string | null;
  /** The text as the test channel would send it; `null` once the values are gone. */
  text: string | null;
  /** The payload of each quick reply (TASK-025): what a press of it sends back. */
  buttons: Record<string, string> | null;
}

/**
 * Development only: what the gateway sent, read from the database — the
 * worker sends the messages and the API shows them, so both processes are
 * seen through one page. It replaces `/dev/supplier-invitations` of
 * TASK-016: invitations are one template among others now.
 *
 * The text is only there while the message still has the values it would be
 * built from; once the message is settled they are cleared (ARCHITECTURE
 * 4.35), and what is left is the template, the language and the delivery.
 * Sent messages therefore keep their text only until they are settled —
 * which for the test channel is the same instant, so the page also keeps
 * what the channel really rendered.
 */
@Injectable()
export class DevMessageOutbox {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async latest(): Promise<{
    messages: DevMessage[];
    webhooks: {
      id: string;
      receivedAt: string;
      processedAt: string | null;
      result: string | null;
      summary: Record<string, number>;
      error: string | null;
    }[];
    buttonPresses: {
      id: string;
      messageId: string | null;
      buttonName: string | null;
      payload: string | null;
      fromPhone: string;
      receivedAt: string;
      appliedAt: string | null;
      outcome: string | null;
    }[];
  }> {
    const rows = await this.database.db
      .select()
      .from(outboundMessage)
      .orderBy(desc(outboundMessage.createdAt), desc(outboundMessage.id))
      .limit(30);
    const messages = rows.map((row): DevMessage => {
      let text: string | null = null;
      if (row.variables) {
        try {
          text = renderMessageText(row.template, row.lang, row.variables);
        } catch {
          text = null;
        }
      }
      return {
        id: row.id,
        template: row.template,
        screen: messageTemplate(row.template).screen,
        lang: row.lang,
        phone: row.phone,
        status: row.status,
        provider: row.provider,
        providerMessageId: row.providerMessageId,
        attempts: row.attempts,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        readAt: row.readAt?.toISOString() ?? null,
        failureKind: row.failureKind,
        lastError: row.lastError,
        text,
        buttons: row.buttonPayloads,
      };
    });
    const webhooks = (
      await this.database.db
        .select()
        .from(inboundWebhookEvent)
        .orderBy(desc(inboundWebhookEvent.receivedAt), desc(inboundWebhookEvent.id))
        .limit(20)
    ).map((row) => ({
      id: row.id,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      result: row.result,
      summary: row.summary,
      error: row.error,
    }));
    const buttonPresses = (
      await this.database.db
        .select()
        .from(messageButtonPress)
        .orderBy(desc(messageButtonPress.receivedAt), desc(messageButtonPress.id))
        .limit(20)
    ).map((row) => ({
      id: row.id,
      messageId: row.messageId,
      buttonName: row.buttonName,
      payload: row.payload,
      fromPhone: row.fromPhone,
      receivedAt: row.receivedAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
      outcome: row.outcome,
    }));
    return { messages, webhooks, buttonPresses };
  }
}

/**
 * Development only (the same switch as `/dev/login-codes`, never in
 * production): the latest messages of the gateway with their status, the
 * webhook deliveries the provider made and the buttons people pressed. No
 * filter parameter: a number in the URL would land in the access log.
 */
@Controller()
export class DevMessagesController {
  constructor(@Inject(DevMessageOutbox) private readonly outbox: DevMessageOutbox) {}

  @Get(DEV_MESSAGES_PATH)
  async list(): Promise<{ note: string } & Awaited<ReturnType<DevMessageOutbox["latest"]>>> {
    return {
      note: "Development only: the latest messages the gateway sent through the test channel (newest first), the webhook deliveries of the provider and the button presses. A message keeps its text only while it still has to be sent.",
      ...(await this.outbox.latest()),
    };
  }
}
