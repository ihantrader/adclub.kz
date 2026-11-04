import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { PUSH_FALLBACK_SUBJECT_ID, type AdminSignalPayload } from "@adclub/contracts";
import { maskPhone } from "@adclub/domain";
import { and, asc, eq, gt, isNull, notInArray, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  definePeriodicJob,
  defineSweeperJob,
  EVERY_MINUTE,
  type JobRunOutcome,
  type PeriodicJobHandler,
  type Sweeper,
  type SweepResult,
} from "../../jobs";
import { account, whatsappAvailable, whatsappWordOf } from "../identity";
import {
  isMessageTemplateKey,
  MessageRenderError,
  Messaging,
  MessageSubjects,
  renderMessageText,
  type MessageLang,
  type MessageOutcome,
  type MessageTemplateKey,
} from "../messaging";
import { AppSettings } from "../settings";
import { AdminSignals } from "../signals";
import { fallbackDecision, type FallbackDecision, type FallbackInput } from "./fallback-rule";
import { NotificationSubjects } from "./notification-subjects";
import {
  notification,
  notificationRecipientState,
  type FallbackDecisionValue,
  type NotificationRow,
  type NotificationStatus,
} from "./schema";

/**
 * The WhatsApp fallback of a critical push to the user (TASK-052; PRODUCT 15;
 * ARCHITECTURE 9.3 level 3, 4.80). What the rule says (`fallbackDecision`) is
 * done here and only here:
 *
 * - **when** — `Notifications.enqueue` asks at once (a push with nowhere to
 *   go, a person whose push is unreliable), and the sweeper
 *   `notifications.fallback` asks every minute about every push not decided
 *   yet; each push is decided once (`fallback_decision`), under its row lock;
 * - **how** — a row of its own in `notification` (`channel = 'whatsapp'`,
 *   `fallback_of_id` → the push, unique) and one message of the existing
 *   gateway, `Messaging.enqueue` in the same transaction with the key
 *   `notification:<copy id>`: two workers, a repeated sweep and a lost race
 *   write one copy at most, and a rolled-back pass sends nothing;
 * - **while still worth it** — the gateway asks the subject `notification`
 *   before it sends (`stillSend`): a copy whose push was superseded or
 *   confirmed meanwhile, or whose number turned out to have no WhatsApp, is
 *   not sent. What the gateway's message became is mirrored on the copy.
 *
 * Nothing about it is logged but ids, kinds, templates and a masked number.
 */

export const pushFallbackJob = defineSweeperJob({ name: "notifications.fallback" });

export const pushFallbackShareJob = definePeriodicJob({
  name: "notifications.watch-fallback-share",
  timeoutSeconds: 60,
  // The next run a minute later is the retry.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

/** The gateway's subject of a copy: the copy's own `notification` row. */
export const FALLBACK_SUBJECT = "notification";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The WhatsApp template of a push template (`user_<code>`), if there is one. */
export function fallbackTemplateOf(pushTemplate: string): MessageTemplateKey | null {
  const key = `user_${pushTemplate}`;
  return isMessageTemplateKey(key) ? key : null;
}

/** There are no English WhatsApp templates: a person reading English gets the Russian one. */
export function fallbackLangOf(lang: string): MessageLang {
  return lang === "kk" ? "kk" : "ru";
}

interface FallbackSettings {
  critical: readonly string[];
  timeoutMinutes: number;
  maxAgeHours: number;
  perAccountDay: number;
  unreliableAfter: number;
  maxLength: number;
}

@Injectable()
export class PushFallbacks implements OnModuleInit {
  private readonly logger = new Logger("Notifications");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(MessageSubjects) private readonly subjects: MessageSubjects,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(NotificationSubjects) private readonly notificationSubjects: NotificationSubjects,
  ) {}

  onModuleInit(): void {
    this.subjects.register(FALLBACK_SUBJECT, {
      stillSend: (tx, subjectId) => this.stillSend(tx, subjectId),
      onResult: (tx, subjectId, outcome) => this.onResult(tx, subjectId, outcome),
      onDelivery: (tx, subjectId, status) => this.onDelivery(tx, subjectId, status),
    });
  }

  async settingsNow(): Promise<FallbackSettings> {
    const values = await this.settings.values();
    return {
      critical: values.critical_notification_kinds,
      timeoutMinutes: values.push_ack_timeout_minutes,
      maxAgeHours: values.push_fallback_max_age_hours,
      perAccountDay: values.push_fallback_per_account_day,
      unreliableAfter: values.push_unreliable_after,
      maxLength: values.message_body_max_length,
    };
  }

  /**
   * Asks the rule about one push and does what it says, in the caller's
   * transaction. Returns what was decided (`null` — nothing to decide: not
   * a push, gone, decided already).
   */
  async consider(
    tx: DbExecutor,
    notificationId: string,
    known?: FallbackSettings,
  ): Promise<FallbackDecision | null> {
    const [row] = await tx
      .select()
      .from(notification)
      .where(eq(notification.id, notificationId))
      .for("update");
    if (!row || row.channel !== "push" || row.fallbackDecision !== null) {
      return null;
    }
    const settings = known ?? (await this.settingsNow());
    const now = new Date();
    const base: FallbackInput = {
      critical: settings.critical.includes(row.eventKind),
      status: row.status,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      ackedAt: row.ackedAt,
      superseded: false,
      current: true,
      unreliable: false,
      whatsapp: true,
      fallbacksToday: 0,
      now,
      timeoutMinutes: settings.timeoutMinutes,
      maxAgeHours: settings.maxAgeHours,
      perAccountDay: settings.perAccountDay,
    };
    // The cheap answers first: nothing else is read for a push that is not
    // critical or was confirmed.
    let decision = fallbackDecision(base);
    let phone: string | null = null;
    if (decision.kind !== "skip") {
      const facts = await this.factsOf(tx, row, now, settings.critical);
      phone = facts.phone;
      decision = fallbackDecision({
        ...base,
        superseded: facts.superseded,
        current: facts.current,
        unreliable: facts.streak >= settings.unreliableAfter,
        whatsapp: whatsappAvailable(facts.word),
        fallbacksToday: facts.fallbacksToday,
      });
    }
    if (decision.kind === "wait") {
      return decision;
    }
    if (decision.kind === "skip") {
      await this.decide(tx, row.id, decision.reason, now);
      if (decision.timedOut) {
        await this.countUnacked(tx, row.recipientAccountId, now);
      }
      if (decision.reason === "rate_limited") {
        this.logger.warn(
          `Push fallback refused: the daily limit of the recipient notification=${row.id} kind=${row.eventKind} limit=${String(settings.perAccountDay)}`,
        );
      } else if (decision.reason === "no_whatsapp") {
        this.logger.log(`Push fallback impossible: no WhatsApp notification=${row.id}`);
      }
      return decision;
    }
    const sent = await this.send(tx, row, phone!, settings, now);
    if (!sent) {
      // A template that cannot carry these values: a defect of ours, logged; the
      // push stays what it was.
      await this.decide(tx, row.id, "render_failed", now);
      return null;
    }
    if (decision.cause === "timeout") {
      await this.countUnacked(tx, row.recipientAccountId, now);
    }
    return decision;
  }

  private async factsOf(
    tx: DbExecutor,
    row: NotificationRow,
    now: Date,
    critical: readonly string[],
  ): Promise<{
    phone: string;
    superseded: boolean;
    current: boolean;
    streak: number;
    word: Awaited<ReturnType<typeof whatsappWordOf>>;
    fallbacksToday: number;
  }> {
    const [owner] = await tx
      .select({ phone: account.phone })
      .from(account)
      .where(eq(account.id, row.recipientAccountId));
    const phone = owner!.phone;
    // Only a later *critical* push takes the place of this one: «готово к выдаче»
    // (not critical by default) right after «принята» must not silence it.
    const superseded =
      row.subjectId === null || critical.length === 0
        ? false
        : (
            await tx.execute<{ later: boolean }>(sql`
              SELECT EXISTS (
                SELECT 1 FROM notification later
                WHERE later.channel = 'push'
                  AND later.event_kind = ANY(${`{${critical.join(",")}}`}::text[])
                  AND later.recipient_account_id = ${row.recipientAccountId}
                  AND later.subject_type = ${row.subjectType}
                  AND later.subject_id = ${row.subjectId}
                  AND later.id <> ${row.id}
                  -- The row's own time from the database: a JS date has no microseconds.
                  AND (later.created_at, later.id) >
                    (SELECT self.created_at, self.id FROM notification self WHERE self.id = ${row.id})
              ) AS later
            `)
          ).rows[0]?.later === true;
    const [state] = await tx
      .select({ streak: notificationRecipientState.unackedStreak })
      .from(notificationRecipientState)
      .where(eq(notificationRecipientState.accountId, row.recipientAccountId));
    const [today] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(notification)
      .where(
        and(
          eq(notification.recipientAccountId, row.recipientAccountId),
          eq(notification.channel, "whatsapp"),
          gt(notification.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    return {
      phone,
      superseded,
      current: await this.notificationSubjects.stillCurrent(
        tx,
        row.subjectType,
        row.subjectId,
        row.eventKind,
      ),
      streak: state?.streak ?? 0,
      word: await whatsappWordOf(tx, phone),
      fallbacksToday: today?.count ?? 0,
    };
  }

  /** Writes the copy and queues its message; `false` — the template cannot render it. */
  private async send(
    tx: DbExecutor,
    row: NotificationRow,
    phone: string,
    settings: FallbackSettings,
    now: Date,
  ): Promise<boolean> {
    const template = fallbackTemplateOf(row.templateCode);
    const lang = fallbackLangOf(row.lang);
    const variables = row.payload.fallbackVariables ?? row.payload.variables;
    if (!template) {
      this.logger.error(
        `Push fallback has no template notification=${row.id} template=${row.templateCode}`,
      );
      return false;
    }
    try {
      renderMessageText(template, lang, variables, settings.maxLength);
    } catch (error) {
      if (error instanceof MessageRenderError) {
        this.logger.error(
          `Push fallback cannot be rendered notification=${row.id} template=${template} reason=${error.reason}`,
        );
        return false;
      }
      throw error;
    }
    const [copy] = await tx
      .insert(notification)
      .values({
        dedupeKey: `fallback:${row.id}`,
        recipientAccountId: row.recipientAccountId,
        eventKind: row.eventKind,
        channel: "whatsapp",
        templateCode: template,
        lang,
        payload: { target: row.payload.target, variables: { ...variables } },
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        fallbackOfId: row.id,
      })
      .onConflictDoNothing()
      .returning({ id: notification.id });
    if (copy) {
      const message = await this.messaging.enqueue(tx, {
        template,
        phone,
        lang,
        variables,
        subject: { type: FALLBACK_SUBJECT, id: copy.id },
        dedupeKey: `notification:${copy.id}`,
      });
      await tx
        .update(notification)
        .set({ outboundMessageId: message.id, updatedAt: now })
        .where(eq(notification.id, copy.id));
      this.logger.log(
        `Push fallback queued notification=${row.id} copy=${copy.id} kind=${row.eventKind} template=${template} lang=${lang} phone=${maskPhone(phone)}`,
      );
    }
    await this.decide(tx, row.id, "sent", now);
    return true;
  }

  private async decide(
    tx: DbExecutor,
    id: string,
    decision: FallbackDecisionValue,
    now: Date,
  ): Promise<void> {
    await tx
      .update(notification)
      .set({ fallbackDecision: decision, fallbackDecidedAt: now, updatedAt: now })
      .where(eq(notification.id, id));
  }

  /** One more critical push in a row not confirmed in time. */
  private async countUnacked(tx: DbExecutor, accountId: string, now: Date): Promise<void> {
    await tx
      .insert(notificationRecipientState)
      .values({ accountId, unackedStreak: 1, unackedSince: now, updatedAt: now })
      .onConflictDoUpdate({
        target: notificationRecipientState.accountId,
        set: {
          unackedStreak: sql`${notificationRecipientState.unackedStreak} + 1`,
          unackedSince: sql`coalesce(${notificationRecipientState.unackedSince}, ${now.toISOString()}::timestamptz)`,
          updatedAt: now,
        },
      });
  }

  /**
   * Whether the gateway may still send this copy: its push is still the
   * latest about the subject, nobody confirmed it, and the number is not
   * known to have no WhatsApp.
   */
  private async stillSend(tx: DbExecutor, copyId: string | null): Promise<boolean> {
    if (!copyId) return false;
    const [copy] = await tx
      .select()
      .from(notification)
      .where(eq(notification.id, copyId))
      .for("update");
    if (!copy?.fallbackOfId) return false;
    const [push] = await tx
      .select()
      .from(notification)
      .where(eq(notification.id, copy.fallbackOfId));
    if (!push) return false;
    if (push.ackedAt) {
      this.logger.log(`Push fallback not sent: the push was confirmed copy=${copy.id}`);
      return false;
    }
    const facts = await this.factsOf(tx, push, new Date(), (await this.settingsNow()).critical);
    if (facts.superseded || !facts.current) {
      this.logger.log(`Push fallback not sent: the event is no longer current copy=${copy.id}`);
      return false;
    }
    if (!whatsappAvailable(facts.word)) {
      this.logger.log(`Push fallback not sent: no WhatsApp copy=${copy.id}`);
      return false;
    }
    return true;
  }

  private async onResult(
    tx: DbExecutor,
    copyId: string | null,
    outcome: MessageOutcome,
  ): Promise<void> {
    if (!copyId || outcome.kind === "retrying") return;
    const now = new Date();
    const status: NotificationStatus =
      outcome.kind === "sent"
        ? "sent"
        : outcome.kind === "failed"
          ? "failed"
          : outcome.kind === "cancelled"
            ? "cancelled"
            : "unknown";
    await tx
      .update(notification)
      .set({
        status,
        sentAt: outcome.kind === "sent" ? now : undefined,
        providerMessageId: outcome.kind === "sent" ? outcome.providerMessageId : undefined,
        updatedAt: now,
      })
      .where(and(eq(notification.id, copyId), eq(notification.channel, "whatsapp")));
  }

  private async onDelivery(
    tx: DbExecutor,
    copyId: string | null,
    status: "sent" | "delivered" | "read" | "failed",
  ): Promise<void> {
    if (!copyId) return;
    const now = new Date();
    await tx
      .update(notification)
      .set({
        status,
        sentAt: sql`coalesce(${notification.sentAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(and(eq(notification.id, copyId), eq(notification.channel, "whatsapp")));
  }
}

/** The sweeper `notifications.fallback`: every push not decided yet, each once a run. */
export class PushFallbackSweep implements Sweeper<{
  settings: FallbackSettings;
  seen: Set<string>;
}> {
  private readonly logger = new Logger("Notifications");

  constructor(private readonly fallbacks: PushFallbacks) {}

  async prepare(): Promise<{ settings: FallbackSettings; seen: Set<string> }> {
    return { settings: await this.fallbacks.settingsNow(), seen: new Set() };
  }

  async claim(
    tx: DbExecutor,
    context: { seen: Set<string> },
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const excluded = [...context.seen, ...batch.excludeIds];
    const rows = await tx
      .select({ id: notification.id })
      .from(notification)
      .where(
        and(
          eq(notification.channel, "push"),
          isNull(notification.fallbackDecision),
          excluded.length > 0 ? notInArray(notification.id, excluded) : undefined,
        ),
      )
      .orderBy(asc(notification.createdAt), asc(notification.id))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(
    tx: DbExecutor,
    context: { settings: FallbackSettings; seen: Set<string> },
    id: string,
  ): Promise<void> {
    context.seen.add(id);
    await this.fallbacks.consider(tx, id, context.settings);
  }

  summary(result: SweepResult): void {
    if (result.failed > 0) {
      this.logger.warn(`Push fallback sweep failed rows=${String(result.failed)}`);
    }
  }
}

/** The share of critical pushes in the window that went to WhatsApp. */
export async function fallbackShareOf(
  executor: DbExecutor,
  critical: readonly string[],
  windowHours: number,
): Promise<{ criticalPushes: number; fallbacks: number; share: number }> {
  if (critical.length === 0) {
    return { criticalPushes: 0, fallbacks: 0, share: 0 };
  }
  const result = await executor.execute<{ total: string; copied: string }>(sql`
    SELECT count(*)::text AS total,
           -- A copy the gateway then cancelled (confirmed or no longer current) did not go.
           count(*) FILTER (WHERE fallback_decision = 'sent' AND NOT EXISTS (
             SELECT 1 FROM notification copy
             WHERE copy.fallback_of_id = notification.id AND copy.status = 'cancelled'
           ))::text AS copied
    FROM notification
    WHERE channel = 'push'
      AND event_kind = ANY(${`{${critical.join(",")}}`}::text[])
      AND created_at > now() - make_interval(hours => ${windowHours})
  `);
  const total = Number(result.rows[0]?.total ?? 0);
  const copied = Number(result.rows[0]?.copied ?? 0);
  return { criticalPushes: total, fallbacks: copied, share: total === 0 ? 0 : copied / total };
}

/**
 * The signal `push_fallback_high` (requirement 5): the share of critical
 * pushes copied to WhatsApp in `push_unacked_window_hours` is above
 * `push_fallback_signal_share` with at least `push_fallback_signal_min` of
 * them. One open signal about push itself; it closes by itself when the
 * share is back under the threshold.
 */
@Injectable()
export class PushFallbackShareWatch implements PeriodicJobHandler {
  private readonly logger = new Logger("Notifications");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async run(): Promise<JobRunOutcome> {
    const values = await this.settings.values();
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('notifications.watch-fallback-share'))`,
      );
      const windowHours = values.push_unacked_window_hours;
      const share = await fallbackShareOf(tx, values.critical_notification_kinds, windowHours);
      const at = new Date();
      const payload: AdminSignalPayload = {
        criticalPushes: share.criticalPushes,
        fallbacks: share.fallbacks,
        fallbackShare: Math.round(share.share * 1000) / 1000,
        threshold: Math.round(values.push_fallback_signal_share * 100),
        windowHours,
      };
      const high =
        share.criticalPushes >= values.push_fallback_signal_min &&
        share.share > values.push_fallback_signal_share;
      const current = await this.signals.openOf(
        tx,
        "push_fallback_high",
        "channel",
        PUSH_FALLBACK_SUBJECT_ID,
      );
      if (high) {
        await this.signals.raise(tx, {
          kind: "push_fallback_high",
          subjectType: "channel",
          subjectId: PUSH_FALLBACK_SUBJECT_ID,
          payload: {
            ...payload,
            since: current?.payload.since ?? at.toISOString(),
          },
          at,
        });
        return { worked: true };
      }
      if (current) {
        await this.signals.close(tx, {
          kind: "push_fallback_high",
          subjectType: "channel",
          subjectId: PUSH_FALLBACK_SUBJECT_ID,
          payload: { ...current.payload, ...payload, endedAt: at.toISOString() },
          at,
        });
        this.logger.log(
          `Push fallback share back under the threshold share=${share.share.toFixed(3)}`,
        );
        return { worked: true };
      }
      return { worked: false };
    });
  }
}
