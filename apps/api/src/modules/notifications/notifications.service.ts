import { Inject, Injectable, Logger } from "@nestjs/common";
import type { NotificationKind, PushTargetValue, RegisterPushTokenBody } from "@adclub/contracts";
import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { account, session } from "../identity";
import { AppSettings } from "../settings";
import { fallbackShareOf, PushFallbacks } from "./push-fallback";
import { sendPushJob } from "./push-jobs";
import { maskToken } from "./push-provider";
import {
  pushLangOf,
  pushTemplate,
  renderPushText,
  type PushLang,
  type PushTemplateCode,
} from "./push-templates";
import {
  deviceToken,
  notification,
  notificationDelivery,
  notificationRecipientState,
  type DeliveryStatus,
  type NotificationRow,
  type NotificationStatus,
} from "./schema";

/**
 * Push notifications to the user (TASK-051; PRODUCT 15; SCREENS 8.4;
 * ARCHITECTURE 9.3, 4.79). The only entrance for other modules: they queue
 * a notification in the transaction of their own event (`enqueue`), and the
 * worker sends it to each of the person's devices (`PushSender`).
 *
 * Nothing about a notification is written to a log but its kind, its
 * template, its language and masked tokens: neither a token nor a text
 * leaves the process (requirement 3).
 */

/** What a module asks to be sent. */
export interface EnqueueNotificationInput {
  kind: NotificationKind;
  /** The text of SCREENS 8.4 — must be of this kind. */
  template: PushTemplateCode;
  recipientAccountId: string;
  /** The recipient's language (`languageOf`), read in the same transaction. */
  lang: PushLang;
  /** The values of the template's placeholders; every one is required. */
  variables: Readonly<Record<string, string>>;
  /**
   * The values in Russian when `lang` is English: the WhatsApp copy of a
   * critical push (TASK-052) has no English template. Not needed otherwise.
   */
  fallbackVariables?: Readonly<Record<string, string>>;
  /** What a tap opens. */
  target: PushTargetValue;
  /** What it is about (an order, a review, a subscription). */
  subject: { type: string; id: string | null };
  /**
   * One event, one person, one notification — built from the event's own row
   * (an order's version, a subscription's version), so a repeated job, a
   * second worker or a lost race write the same notification.
   */
  dedupeKey: string;
}

export interface QueuedNotification {
  id: string;
  /** False — this notification already existed: nothing created, nothing queued twice. */
  created: boolean;
  /** How many devices it is on its way to (0 — the person has none for push). */
  devices: number;
}

/**
 * A session that still holds: not ended and not past its expiry. A token
 * whose session does not hold gets nothing — whatever ended the session
 * (ARCHITECTURE 4.79: bound to the session, not to a list of exits).
 */
export function liveSession(): SQL {
  return sql`(${session.revokedAt} IS NULL
    AND ${session.expiresAt} > now()
    AND (${session.absoluteExpiresAt} IS NULL OR ${session.absoluteExpiresAt} > now()))`;
}

/** The statuses of a delivery that end it. */
const DELIVERY_SETTLED: readonly DeliveryStatus[] = ["sent", "failed", "unknown", "cancelled"];

/**
 * What a notification is, from what became of its deliveries (status only
 * forward): one device that got it is enough for `sent`; while any is on its
 * way it is `queued`; otherwise the worst that happened — `unknown` before
 * `failed` before `cancelled`.
 */
export function notificationStatusOf(deliveries: readonly DeliveryStatus[]): NotificationStatus {
  if (deliveries.length === 0) return "no_device";
  if (deliveries.includes("sent")) return "sent";
  if (deliveries.some((status) => !DELIVERY_SETTLED.includes(status))) return "queued";
  if (deliveries.includes("unknown")) return "unknown";
  if (deliveries.includes("failed")) return "failed";
  return "cancelled";
}

@Injectable()
export class Notifications {
  private readonly logger = new Logger("Notifications");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PushFallbacks) private readonly fallbacks: PushFallbacks,
  ) {}

  /** The language a person's push is written in: their account's, Russian without one. */
  async languageOf(tx: DbExecutor, accountId: string): Promise<PushLang> {
    const [row] = await tx
      .select({ language: account.language })
      .from(account)
      .where(eq(account.id, accountId));
    return pushLangOf(row?.language);
  }

  /**
   * Writes the notification and queues it to every device of the person
   * whose session holds — in the caller's transaction, so the notification
   * exists if and only if its event does (ARCHITECTURE 13.1).
   */
  async enqueue(tx: DbExecutor, input: EnqueueNotificationInput): Promise<QueuedNotification> {
    if (pushTemplate(input.template).kind !== input.kind) {
      throw new Error(`The push template ${input.template} is not of the kind ${input.kind}`);
    }
    // Renders only to check: the text is built again when it is sent.
    renderPushText(input.template, input.lang, input.variables);
    const { push_send_attempts: attempts, push_retry_delay_seconds: delaySeconds } =
      await this.settings.values();
    const [created] = await tx
      .insert(notification)
      .values({
        dedupeKey: input.dedupeKey,
        recipientAccountId: input.recipientAccountId,
        eventKind: input.kind,
        channel: "push",
        templateCode: input.template,
        lang: input.lang,
        payload: {
          target: input.target,
          variables: { ...input.variables },
          ...(input.fallbackVariables ? { fallbackVariables: { ...input.fallbackVariables } } : {}),
        },
        subjectType: input.subject.type,
        subjectId: input.subject.id,
      })
      .onConflictDoNothing({ target: notification.dedupeKey })
      .returning({ id: notification.id });
    if (!created) {
      const [existing] = await tx
        .select({ id: notification.id })
        .from(notification)
        .where(eq(notification.dedupeKey, input.dedupeKey));
      return { id: existing!.id, created: false, devices: 0 };
    }
    const tokens = await tx
      .select({ id: deviceToken.id, token: deviceToken.token, platform: deviceToken.platform })
      .from(deviceToken)
      .innerJoin(session, eq(session.id, deviceToken.sessionId))
      .where(
        and(
          eq(deviceToken.accountId, input.recipientAccountId),
          isNull(deviceToken.deactivatedAt),
          liveSession(),
        ),
      );
    if (tokens.length === 0) {
      await tx
        .update(notification)
        .set({ status: "no_device", updatedAt: new Date() })
        .where(eq(notification.id, created.id));
      this.logger.log(
        `Push not sent: no device notification=${created.id} kind=${input.kind} template=${input.template}`,
      );
      // TASK-052: nowhere to push — a critical event goes to WhatsApp at once.
      await this.fallbacks.consider(tx, created.id);
      return { id: created.id, created: true, devices: 0 };
    }
    const deliveries = await tx
      .insert(notificationDelivery)
      .values(
        tokens.map((token) => ({
          notificationId: created.id,
          deviceTokenId: token.id,
          tokenMask: maskToken(token.token),
          platform: token.platform,
          maxAttempts: attempts,
        })),
      )
      .returning({ id: notificationDelivery.id });
    for (const delivery of deliveries) {
      await this.queue.enqueue(
        sendPushJob,
        { deliveryId: delivery.id },
        { tx, retry: { limit: Math.max(0, attempts - 1), delaySeconds } },
      );
    }
    this.logger.log(
      `Push queued notification=${created.id} kind=${input.kind} template=${input.template} lang=${input.lang} devices=${String(deliveries.length)}`,
    );
    // TASK-052: a person whose push is unreliable gets a critical event in
    // WhatsApp at once; anyone else — after the timeout (the sweeper).
    await this.fallbacks.consider(tx, created.id);
    return { id: created.id, created: true, devices: deliveries.length };
  }

  /**
   * Registers this device's token for this session (requirement 2). A token
   * is one device: the same token sent by another session — the same phone
   * signed in with another number — moves here. A session has one device: a
   * token the platform replaced takes the place of the old one.
   */
  async registerToken(
    current: { sessionId: string; accountId: string },
    body: RegisterPushTokenBody,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .delete(deviceToken)
        .where(
          and(eq(deviceToken.sessionId, current.sessionId), ne(deviceToken.token, body.token)),
        );
      await tx
        .insert(deviceToken)
        .values({
          accountId: current.accountId,
          sessionId: current.sessionId,
          platform: body.platform,
          token: body.token,
          deviceModel: body.deviceModel ?? null,
          registeredAt: now,
        })
        .onConflictDoUpdate({
          target: deviceToken.token,
          set: {
            accountId: current.accountId,
            sessionId: current.sessionId,
            platform: body.platform,
            deviceModel: body.deviceModel ?? null,
            deactivatedAt: null,
            deactivatedReason: null,
            registeredAt: now,
            updatedAt: now,
          },
        });
    });
    this.logger.log(
      `Push token registered session=${current.sessionId} platform=${body.platform} token=${maskToken(body.token)}`,
    );
  }

  /** Takes this session's device off push (the app's sign-out; the session's end does it anyway). */
  async removeToken(sessionId: string): Promise<void> {
    const now = new Date();
    await this.database.db
      .update(deviceToken)
      .set({ deactivatedAt: now, deactivatedReason: "removed", updatedAt: now })
      .where(and(eq(deviceToken.sessionId, sessionId), isNull(deviceToken.deactivatedAt)));
  }

  /**
   * The app got or opened this push (requirement 5). Only the person's own;
   * `null` — none of theirs (someone else's and a missing one alike). A
   * repeat keeps the first moment.
   */
  async ack(accountId: string, notificationId: string): Promise<Date | null> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .update(notification)
        .set({ ackedAt: sql`coalesce(${notification.ackedAt}, now())`, updatedAt: new Date() })
        .where(
          and(eq(notification.id, notificationId), eq(notification.recipientAccountId, accountId)),
        )
        .returning({ ackedAt: notification.ackedAt });
      if (row) {
        await resetUnackedStreak(tx, accountId);
      }
      return row?.ackedAt ?? null;
    });
  }

  /**
   * The screen of a subject is open: every notification of it to this person
   * not confirmed yet is confirmed — the person sees the state itself.
   */
  async ackSubject(
    accountId: string,
    subject: { type: string; id: string },
    executor: DbExecutor = this.database.db,
  ): Promise<number> {
    const rows = await executor
      .update(notification)
      .set({ ackedAt: sql`now()`, updatedAt: new Date() })
      .where(
        and(
          eq(notification.recipientAccountId, accountId),
          eq(notification.subjectType, subject.type),
          eq(notification.subjectId, subject.id),
          eq(notification.channel, "push"),
          isNull(notification.ackedAt),
        ),
      )
      .returning({ id: notification.id });
    if (rows.length > 0) {
      await resetUnackedStreak(executor, accountId);
    }
    return rows.length;
  }

  /** How many critical pushes in a row went unconfirmed, and since when push is unreliable (TASK-052). */
  async recipientState(
    accountId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<{ unackedStreak: number; pushUnreliableSince: Date | null }> {
    const threshold = await this.settings.get("push_unreliable_after");
    const [row] = await executor
      .select()
      .from(notificationRecipientState)
      .where(eq(notificationRecipientState.accountId, accountId));
    const streak = row?.unackedStreak ?? 0;
    return {
      unackedStreak: streak,
      pushUnreliableSince: streak >= threshold ? (row?.unackedSince ?? null) : null,
    };
  }

  /** How many people's push is unreliable now (metrics, `push:status`). */
  async unreliableCount(): Promise<number> {
    const threshold = await this.settings.get("push_unreliable_after");
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationRecipientState)
      .where(sql`${notificationRecipientState.unackedStreak} >= ${threshold}`);
    return row?.count ?? 0;
  }

  /** WhatsApp copies by kind and what became of them (metrics, `push:status`). */
  async fallbackCounts(): Promise<{ kind: string; status: string; count: number }[]> {
    const rows = await this.database.db
      .select({
        kind: notification.eventKind,
        status: notification.status,
        count: sql<string>`count(*)`,
      })
      .from(notification)
      .where(eq(notification.channel, "whatsapp"))
      .groupBy(notification.eventKind, notification.status);
    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  }

  /** Why pushes got no copy, or got one, by decision (`push:status`). */
  async fallbackDecisions(): Promise<Record<string, number>> {
    const rows = await this.database.db
      .select({ decision: notification.fallbackDecision, count: sql<string>`count(*)` })
      .from(notification)
      .where(eq(notification.channel, "push"))
      .groupBy(notification.fallbackDecision);
    return Object.fromEntries(rows.map((row) => [row.decision ?? "pending", Number(row.count)]));
  }

  /** The share of critical pushes in the window copied to WhatsApp (metrics, signal). */
  async fallbackShare(): Promise<{
    criticalPushes: number;
    fallbacks: number;
    share: number;
    windowHours: number;
  }> {
    const values = await this.settings.values();
    const share = await fallbackShareOf(
      this.database.db,
      values.critical_notification_kinds,
      values.push_unacked_window_hours,
    );
    return { ...share, windowHours: values.push_unacked_window_hours };
  }

  /** The latest notifications for the operator and the development page. */
  async latest(options: {
    limit: number;
    status?: NotificationStatus;
  }): Promise<NotificationRow[]> {
    return this.database.db
      .select()
      .from(notification)
      .where(options.status ? eq(notification.status, options.status) : undefined)
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(options.limit);
  }

  /** Notifications of a subject (tests and the development page). */
  async ofSubject(type: string, id: string): Promise<NotificationRow[]> {
    return this.database.db
      .select()
      .from(notification)
      .where(and(eq(notification.subjectType, type), eq(notification.subjectId, id)))
      .orderBy(desc(notification.createdAt));
  }

  /** How many notifications of each kind are in each state (metrics, `push:status`). */
  async countsByKind(): Promise<{ kind: string; status: string; count: number }[]> {
    const rows = await this.database.db
      .select({
        kind: notification.eventKind,
        status: notification.status,
        count: sql<string>`count(*)`,
      })
      .from(notification)
      .where(eq(notification.channel, "push"))
      .groupBy(notification.eventKind, notification.status);
    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  }

  /**
   * Of the pushes sent in the last `push_unacked_window_hours`, how many the
   * app has not confirmed (metrics; what TASK-052 will act on).
   */
  async unacked(): Promise<{ sent: number; unacked: number; windowHours: number }> {
    const windowHours = await this.settings.get("push_unacked_window_hours");
    const rows = await this.database.db.execute<{ sent: string; unacked: string }>(sql`
      SELECT count(*)::text AS sent,
             count(*) FILTER (WHERE acked_at IS NULL)::text AS unacked
      FROM notification
      WHERE channel = 'push' AND status = 'sent' AND sent_at > now() - make_interval(hours => ${windowHours})
    `);
    const row = rows.rows[0];
    return { sent: Number(row?.sent ?? 0), unacked: Number(row?.unacked ?? 0), windowHours };
  }

  /** How many deliveries are in each state. */
  async deliveryCounts(): Promise<Record<string, number>> {
    const rows = await this.database.db
      .select({ status: notificationDelivery.status, count: sql<string>`count(*)` })
      .from(notificationDelivery)
      .groupBy(notificationDelivery.status);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  /**
   * Puts a delivery that failed or whose outcome is unknown back on the
   * queue (the operator: `push:retry`). One that certainly reached the
   * provider is never sent again. Accepts a delivery's id or a
   * notification's (then every such delivery of it).
   */
  async retry(
    id: string,
  ): Promise<{ queued: string[]; skipped: { id: string; status: string }[] }> {
    const { push_send_attempts: attempts, push_retry_delay_seconds: delaySeconds } =
      await this.settings.values();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationDelivery)
        .where(
          sql`${notificationDelivery.id} = ${id} OR ${notificationDelivery.notificationId} = ${id}`,
        )
        .for("update");
      if (rows.length === 0) {
        throw new NotificationNotFoundError(id);
      }
      const queued: string[] = [];
      const skipped: { id: string; status: string }[] = [];
      for (const row of rows) {
        if (row.status !== "failed" && row.status !== "unknown") {
          skipped.push({ id: row.id, status: row.status });
          continue;
        }
        await tx
          .update(notificationDelivery)
          .set({
            status: "queued",
            claimedUntil: null,
            settledAt: null,
            failureKind: null,
            maxAttempts: row.attempts + attempts,
            updatedAt: new Date(),
          })
          .where(eq(notificationDelivery.id, row.id));
        await this.queue.enqueue(
          sendPushJob,
          { deliveryId: row.id },
          { tx, retry: { limit: Math.max(0, attempts - 1), delaySeconds } },
        );
        queued.push(row.id);
      }
      if (queued.length > 0) {
        await rollupNotification(tx, rows[0]!.notificationId);
      }
      return { queued, skipped };
    });
  }
}

/** Any confirmation of a person's push lifts «push не подтверждается» (TASK-052). */
async function resetUnackedStreak(executor: DbExecutor, accountId: string): Promise<void> {
  await executor
    .update(notificationRecipientState)
    .set({ unackedStreak: 0, unackedSince: null, updatedAt: new Date() })
    .where(
      and(
        eq(notificationRecipientState.accountId, accountId),
        sql`${notificationRecipientState.unackedStreak} > 0`,
      ),
    );
}

/** Writes the notification's status from its deliveries (after every change of one). */
export async function rollupNotification(tx: DbExecutor, notificationId: string): Promise<void> {
  const deliveries = await tx
    .select({
      status: notificationDelivery.status,
      sentAt: notificationDelivery.sentAt,
      providerMessageId: notificationDelivery.providerMessageId,
    })
    .from(notificationDelivery)
    .where(eq(notificationDelivery.notificationId, notificationId));
  const status = notificationStatusOf(deliveries.map((row) => row.status));
  const firstSent = deliveries
    .filter((row) => row.status === "sent" && row.sentAt)
    .sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime())[0];
  await tx
    .update(notification)
    .set({
      status,
      sentAt: firstSent?.sentAt ?? null,
      providerMessageId: firstSent?.providerMessageId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(notification.id, notificationId));
}

export class NotificationNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`There is no notification or delivery ${id}`);
    this.name = "NotificationNotFoundError";
  }
}
