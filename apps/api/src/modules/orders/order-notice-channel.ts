import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  WHATSAPP_CHANNEL_SUBJECT_ID,
  type AdminSignalPayload,
  type OrderNoticeState,
} from "@adclub/contracts";
import { sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  definePeriodicJob,
  EVERY_MINUTE,
  JobRegistry,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { AppSettings } from "../settings";
import { AdminSignals } from "../signals";
import {
  countWindow,
  isOutage,
  recoveredAt,
  summarizeSince,
  windowStart,
  type JudgedNotice,
} from "./notice-channel-verdict";
import { ORDER_SUBJECT } from "./order-notices";
import { databaseNow } from "./order-transitions";

/**
 * The detector of an outage of the channel of notices (TASK-025
 * requirement 4; PRODUCT 10.4; ARCHITECTURE 6.6, 13.2; SCREENS A-HOME). Every
 * minute it judges the notices of orders of the last
 * `whatsapp_outage_window_minutes` (`notice-channel-verdict.ts`) and, when
 * at least `whatsapp_outage_min_failures` of them failed and they are at
 * least `whatsapp_outage_error_ratio` of the judged ones, raises **one**
 * signal to the administrator about the channel (`whatsapp_outage`, its
 * subject — the channel; the unique index of open signals keeps it one):
 * since when, how many notices, of which orders and suppliers, what went
 * wrong. While the outage lasts the same signal is refreshed with each new
 * failure; the first notice delivered after the last failure closes it by
 * itself, with `endedAt` — the administrator does not have to, and cannot
 * forget to. The failures a closed signal told about are not counted again.
 *
 * **The deadlines of orders are never touched here** (PRODUCT 10.4): an
 * order whose notices never arrived expires by the common rule unless the
 * administrator extends it (`OrderTransitions.extend`, A-ORD-03).
 */

export const noticeChannelWatchJob = definePeriodicJob({
  name: "orders.watch-notice-channel",
  timeoutSeconds: 60,
  // The next run a minute later is the retry.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

const OUTAGE = {
  kind: "whatsapp_outage",
  subjectType: "channel",
  subjectId: WHATSAPP_CHANNEL_SUBJECT_ID,
} as const;

/**
 * The judgement of each notice of an order, in SQL (`notice-channel-verdict.ts`
 * says what it means). `now()` — the clock of the database, as every decision
 * about time (4.32 I336).
 */
function judged(timeoutMinutes: number) {
  const timeout = sql`make_interval(mins => ${timeoutMinutes})`;
  return {
    failedAt: sql<Date | null>`CASE
      WHEN m.status IN ('failed', 'unknown') THEN m.settled_at
      WHEN m.status IN ('queued', 'sending') AND m.created_at <= now() - ${timeout}
        THEN m.created_at + ${timeout}
      WHEN m.status = 'sent' AND m.provider IS DISTINCT FROM 'test' AND m.sent_at <= now() - ${timeout}
        THEN m.sent_at + ${timeout}
    END`,
    deliveredAt: sql<Date | null>`CASE
      WHEN m.status IN ('delivered', 'read') THEN m.delivered_at
      WHEN m.status = 'sent' AND m.provider = 'test' THEN m.sent_at
    END`,
  };
}

function dateOf(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value : new Date(String(value));
}

/** The notices of orders judged at or after `from`. */
export async function judgedNotices(
  executor: DbExecutor,
  from: Date,
  timeoutMinutes: number,
): Promise<JudgedNotice[]> {
  const { failedAt, deliveredAt } = judged(timeoutMinutes);
  const result = await executor.execute<{
    order_id: string | null;
    supplier_id: string | null;
    queued_at: unknown;
    failed_at: unknown;
    delivered_at: unknown;
    failure_kind: string | null;
  }>(sql`
    SELECT * FROM (
      SELECT m.subject_id AS order_id, o.supplier_id, m.created_at AS queued_at,
        -- A notice nobody knows the fate of has no kind of its own (4.35 I358).
        CASE WHEN m.status = 'unknown' THEN 'outcome_unknown' ELSE m.failure_kind END AS failure_kind,
        ${failedAt} AS failed_at, ${deliveredAt} AS delivered_at
      FROM outbound_message m
      LEFT JOIN customer_order o ON o.id = m.subject_id
      WHERE m.subject_type = ${ORDER_SUBJECT}
        AND m.status <> 'cancelled'
        -- «The number is not on WhatsApp» is a fact about the recipient, not
        -- about the channel: three employees without WhatsApp are no outage.
        AND m.failure_kind IS DISTINCT FROM 'no_whatsapp'
        -- A notice is judged within hours of being queued; the bound keeps
        -- the index doing the work (outbound_message_subject_created_idx).
        AND m.created_at >= ${from.toISOString()}::timestamptz - interval '2 days'
    ) judged
    WHERE failed_at >= ${from.toISOString()}::timestamptz
       OR delivered_at >= ${from.toISOString()}::timestamptz
       OR queued_at >= ${from.toISOString()}::timestamptz
  `);
  return result.rows.map((row) => ({
    orderId: row.order_id,
    supplierId: row.supplier_id,
    queuedAt: dateOf(row.queued_at)!,
    failedAt: dateOf(row.failed_at),
    deliveredAt: dateOf(row.delivered_at),
    failureKind: row.failure_kind,
  }));
}

/**
 * What became of the notices of new orders (W-01) of these orders
 * (A-ORD-03 marks the orders nobody was notified of).
 */
export async function noticeStatesOf(
  executor: DbExecutor,
  orderIds: readonly string[],
  timeoutMinutes: number,
): Promise<Map<string, OrderNoticeState>> {
  const states = new Map<string, OrderNoticeState>();
  if (orderIds.length === 0) {
    return states;
  }
  const { failedAt, deliveredAt } = judged(timeoutMinutes);
  const result = await executor.execute<{
    order_id: string;
    recipients: number;
    delivered: number;
    failed: number;
    pending: number;
  }>(sql`
    SELECT order_id,
      count(DISTINCT phone)::int AS recipients,
      (count(*) FILTER (WHERE delivered_at IS NOT NULL))::int AS delivered,
      (count(*) FILTER (WHERE failed_at IS NOT NULL))::int AS failed,
      (count(*) FILTER (WHERE delivered_at IS NULL AND failed_at IS NULL))::int AS pending
    FROM (
      SELECT m.subject_id AS order_id, m.phone, ${failedAt} AS failed_at, ${deliveredAt} AS delivered_at
      FROM outbound_message m
      WHERE m.subject_type = ${ORDER_SUBJECT}
        AND m.template = 'order_new'
        AND m.status <> 'cancelled'
        AND m.subject_id = ANY(${`{${orderIds.join(",")}}`}::uuid[])
    ) notices
    GROUP BY order_id
  `);
  for (const row of result.rows) {
    states.set(row.order_id, {
      recipients: Number(row.recipients),
      delivered: Number(row.delivered),
      failed: Number(row.failed),
      pending: Number(row.pending),
    });
  }
  return states;
}

function later(a: string | undefined, b: Date | null): string | undefined {
  if (!b) {
    return a;
  }
  return !a || new Date(a) < b ? b.toISOString() : a;
}

@Injectable()
export class NoticeChannelWatch implements PeriodicJobHandler, OnModuleInit {
  private readonly logger = new Logger("NoticeChannel");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(noticeChannelWatchJob, this);
  }

  async run(): Promise<JobRunOutcome> {
    const {
      whatsapp_outage_window_minutes: windowMinutes,
      whatsapp_outage_error_ratio: ratio,
      whatsapp_outage_min_failures: minFailures,
      whatsapp_outage_delivery_timeout_minutes: timeoutMinutes,
    } = await this.settings.values();
    return this.database.db.transaction(async (tx) => {
      // One judgement at a time, whoever runs it (the schedule, `jobs:run`).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('orders.watch-notice-channel'))`);
      const at = await databaseNow(tx);
      const open = await this.signals.openOf(tx, OUTAGE.kind, OUTAGE.subjectType, OUTAGE.subjectId);
      // What a closed signal already told about is not told again.
      const closed = open
        ? undefined
        : await this.signals.lastClosedOf(tx, OUTAGE.kind, OUTAGE.subjectType, OUTAGE.subjectId);
      const windowFrom = windowStart(
        at,
        windowMinutes,
        closed
          ? {
              lastFailureAt: closed.payload.lastFailureAt
                ? new Date(closed.payload.lastFailureAt)
                : null,
              closedAt: closed.closedAt,
            }
          : null,
      );
      const openSince = open?.payload.since ? new Date(open.payload.since) : null;
      const from = openSince && openSince < windowFrom ? openSince : windowFrom;
      const notices = await judgedNotices(tx, from, timeoutMinutes);
      const count = countWindow(notices, windowFrom);
      const outage = isOutage(count, { minFailures, ratio });
      if (!open && !outage) {
        return { worked: false };
      }
      const since = openSince ?? count.firstQueuedAt ?? at;
      const summary = summarizeSince(notices, since);
      const before: AdminSignalPayload = open?.payload ?? {};
      const kinds = { ...(before.failureKinds ?? {}) };
      for (const [kind, n] of Object.entries(summary.failureKinds)) {
        kinds[kind] = Math.max(kinds[kind] ?? 0, n);
      }
      const payload: AdminSignalPayload = {
        since: since.toISOString(),
        lastFailureAt: later(before.lastFailureAt, summary.lastFailedAt),
        // A notice counted failed may be delivered later (it was only late):
        // the signal keeps the most it has seen, it never shrinks.
        failedMessages: Math.max(before.failedMessages ?? 0, summary.failedMessages),
        judgedMessages: Math.max(before.judgedMessages ?? 0, count.judged),
        affectedOrders: Math.max(before.affectedOrders ?? 0, summary.affectedOrders),
        supplierIds: [...new Set([...(before.supplierIds ?? []), ...summary.supplierIds])].slice(
          0,
          50,
        ),
        failureKinds: kinds,
        windowMinutes,
      };
      let worked = false;
      const fresh =
        !open ||
        (summary.lastFailedAt !== null &&
          (!before.lastFailureAt || summary.lastFailedAt > new Date(before.lastFailureAt)));
      if (outage && fresh) {
        await this.signals.raise(tx, { ...OUTAGE, payload, at });
        worked = true;
        if (!open) {
          this.logger.warn(
            `Notice channel outage failed=${String(count.failed)} judged=${String(count.judged)} since=${payload.since ?? ""}`,
          );
        }
      }
      const lastFailure = payload.lastFailureAt ? new Date(payload.lastFailureAt) : null;
      const recovered = lastFailure ? recoveredAt(notices, lastFailure) : null;
      if (recovered && (open || worked)) {
        await this.signals.close(tx, {
          ...OUTAGE,
          payload: { ...payload, endedAt: recovered.toISOString() },
          at,
        });
        this.logger.log(
          `Notice channel delivers again since=${payload.since ?? ""} ended=${recovered.toISOString()} failed=${String(payload.failedMessages)}`,
        );
        worked = true;
      }
      return { worked };
    });
  }
}
