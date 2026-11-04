import { Inject, Injectable, Logger } from "@nestjs/common";
import { desc, inArray } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { NotificationNotFoundError, Notifications } from "./notifications.service";
import { countWithoutWhatsapp } from "../identity";
import { notification, notificationDelivery, type NotificationStatus } from "./schema";

const STATUSES: readonly NotificationStatus[] = [
  "queued",
  "sent",
  "no_device",
  "failed",
  "unknown",
  "cancelled",
  "delivered",
  "read",
];

export class NotificationsCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationsCommandError";
  }
}

/**
 * What the operator can see and do about pushes (`push:list`, `push:retry`,
 * `push:status`). Never a whole token and never the text's values: the kind,
 * the template, the language, the status and masked tokens.
 */
@Injectable()
export class NotificationsAdmin {
  private readonly logger = new Logger("Notifications");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(Notifications) private readonly notifications: Notifications,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(options: { limit?: number; status?: string }): Promise<unknown> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    if (options.status !== undefined && !STATUSES.includes(options.status as NotificationStatus)) {
      throw new NotificationsCommandError(
        `There is no status ${options.status} (${STATUSES.join(", ")})`,
      );
    }
    const rows = await this.notifications.latest({
      limit,
      status: options.status as NotificationStatus | undefined,
    });
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
            )
            .orderBy(desc(notificationDelivery.createdAt));
    const copies =
      rows.length === 0
        ? []
        : await this.database.db
            .select()
            .from(notification)
            .where(
              inArray(
                notification.fallbackOfId,
                rows.map((row) => row.id),
              ),
            );
    return {
      provider: this.config.push.provider,
      notifications: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        kind: row.eventKind,
        template: row.templateCode,
        lang: row.lang,
        status: row.status,
        subject: { type: row.subjectType, id: row.subjectId },
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        ackedAt: row.ackedAt?.toISOString() ?? null,
        // TASK-052: what became of the WhatsApp copy (on a push), or whose copy this is.
        fallback:
          row.channel === "push"
            ? {
                decision: row.fallbackDecision ?? "pending",
                decidedAt: row.fallbackDecidedAt?.toISOString() ?? null,
                copy: (() => {
                  const copy = copies.find((item) => item.fallbackOfId === row.id);
                  return copy
                    ? {
                        id: copy.id,
                        template: copy.templateCode,
                        status: copy.status,
                        messageId: copy.outboundMessageId,
                      }
                    : null;
                })(),
              }
            : { of: row.fallbackOfId, messageId: row.outboundMessageId },
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
            canRetry: delivery.status === "failed" || delivery.status === "unknown",
          })),
      })),
    };
  }

  async retry(id: string): Promise<unknown> {
    try {
      const result = await this.notifications.retry(id);
      if (result.queued.length === 0) {
        throw new NotificationsCommandError(
          `Nothing to retry: ${result.skipped.map((row) => `${row.id} is ${row.status}`).join(", ")} — only failed and unknown deliveries are sent again`,
        );
      }
      this.logger.log(`Push queued again by the operator deliveries=${result.queued.join(",")}`);
      return result;
    } catch (error) {
      if (error instanceof NotificationNotFoundError) {
        throw new NotificationsCommandError(error.message);
      }
      throw error;
    }
  }

  async status(): Promise<unknown> {
    return {
      provider: this.config.push.provider,
      byKind: await this.notifications.countsByKind(),
      deliveries: await this.notifications.deliveryCounts(),
      unacked: await this.notifications.unacked(),
      // TASK-052: the WhatsApp fallback.
      fallback: {
        share: await this.notifications.fallbackShare(),
        decisions: await this.notifications.fallbackDecisions(),
        copies: await this.notifications.fallbackCounts(),
        pushUnreliable: await this.notifications.unreliableCount(),
        withoutWhatsapp: await countWithoutWhatsapp(this.database.db),
      },
    };
  }
}
