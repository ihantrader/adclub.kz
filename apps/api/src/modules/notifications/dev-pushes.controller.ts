import { Controller, Get, Inject, Injectable } from "@nestjs/common";
import { desc, inArray } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { pushTemplate, renderPushText } from "./push-templates";
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
      let text: string | null;
      try {
        text = renderPushText(row.templateCode, row.lang, row.payload.variables);
      } catch {
        text = null;
      }
      return {
        id: row.id,
        kind: row.eventKind,
        template: row.templateCode,
        screen: pushTemplate(row.templateCode).screen,
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
      note: "Development only: the latest push notifications to users sent through the test provider (newest first), each device as a masked token, and whether the app confirmed them (ackedAt).",
      notifications: await this.outbox.latest(),
    };
  }
}
