import { Controller, Get, Inject, Injectable } from "@nestjs/common";
import { desc, inArray } from "drizzle-orm";
import { DatabaseService } from "../../database";
import {
  isMessageTemplateKey,
  messageTemplate,
  renderMessageText,
  type MessageTemplateKey,
} from "../messaging";
import { fallbackLangOf } from "./push-fallback";
import { pushTemplate, renderPushText, type PushTemplateCode } from "./push-templates";
import { notification, notificationDelivery } from "./schema";

/** Not part of the contract; excluded from the served-routes check (as `/dev/messages`). */
export const DEV_PUSHES_PATH = "/dev/pushes";

/**
 * Development only, and only while the provider is the test one: the latest
 * notifications with their text, what they open, each device they went to
 * (the token as a mask) and whether the app confirmed them — read from the
 * database, so whichever worker sent them, one page shows them.
 */
@Injectable()
export class DevPushOutbox {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async latest() {
    const rows = await this.database.db
      .select()
      .from(notification)
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(30);
    const deliveries =
      rows.length === 0
        ? []
        : await this.database.db
            .select()
            .from(notificationDelivery)
            .where(
              inArray(
                notificationDelivery.notificationId,
                rows.map((row) => row.id),
              ),
            );
    return rows.map((row) => {
      // TASK-052: a WhatsApp copy is written by its message template (kk/ru).
      const whatsapp = row.channel === "whatsapp" && isMessageTemplateKey(row.templateCode);
      let text: string | null;
      let screen: string | null = null;
      try {
        if (whatsapp) {
          const key = row.templateCode as MessageTemplateKey;
          screen = messageTemplate(key).screen;
          text = renderMessageText(key, fallbackLangOf(row.lang), row.payload.variables);
        } else {
          const code = row.templateCode as PushTemplateCode;
          screen = pushTemplate(code).screen;
          text = renderPushText(code, row.lang, row.payload.variables);
        }
      } catch {
        text = null;
      }
      return {
        id: row.id,
        channel: row.channel,
        fallbackOfId: row.fallbackOfId,
        fallbackDecision: row.fallbackDecision,
        outboundMessageId: row.outboundMessageId,
        kind: row.eventKind,
        template: row.templateCode,
        screen,
        lang: row.lang,
        text,
        target: row.payload.target,
        subject: { type: row.subjectType, id: row.subjectId },
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        ackedAt: row.ackedAt?.toISOString() ?? null,
        deliveries: deliveries
          .filter((delivery) => delivery.notificationId === row.id)
          .map((delivery) => ({
            id: delivery.id,
            token: delivery.tokenMask,
            platform: delivery.platform,
            status: delivery.status,
            attempts: delivery.attempts,
            failureKind: delivery.failureKind,
            lastError: delivery.lastError,
            sentAt: delivery.sentAt?.toISOString() ?? null,
          })),
      };
    });
  }
}

@Controller()
export class DevPushesController {
  constructor(@Inject(DevPushOutbox) private readonly outbox: DevPushOutbox) {}

  @Get(DEV_PUSHES_PATH)
  async list() {
    return {
      note: "Development only: the latest push notifications to users sent through the test provider (newest first), each device as a masked token, and whether the app confirmed them (ackedAt). A row with channel whatsapp is the WhatsApp copy of the push fallbackOfId names (TASK-052); its message is on /dev/messages.",
      notifications: await this.outbox.latest(),
    };
  }
}
