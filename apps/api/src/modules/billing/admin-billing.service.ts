import { Inject, Injectable } from "@nestjs/common";
import {
  adminBillingSupplierListQuerySchema,
  adminChargeListQuerySchema,
  adminUserSubscriptionListQuerySchema,
  type AdminBillingPeriodQuery,
  type AdminBillingSummary,
  type AdminBillingSupplier,
  type AdminBillingSupplierPage,
  type AdminCharge,
  type AdminChargePage,
  type AdminChargeStatus,
  type AdminUserSubscriptionListQuery,
  type AdminUserSubscriptionPage,
  type PaymentDeclineReason,
  type SupplierBillingGroup,
  type SupplierChargeKind,
  type SupplierSubscriptionStatus,
} from "@adclub/contracts";
import {
  BILLING_TIME_ZONE,
  daysUntilPause,
  hidePhone,
  localDateTime,
  pastDueNextRetry,
  startOfLocalDate,
  subscriptionAccess,
  type SubscriptionStatus,
} from "@adclub/domain";
import { sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { subscriptionAccessUntilSql } from "../club-access";
import { AppSettings } from "../settings";
import { userSearchCondition } from "../users";
import { termKey } from "./payment-charger";
import { Plans } from "./plans.service";

/** The queries as the validation pipe hands them over (comma lists are arrays by then). */
export type AdminBillingSupplierQuery = z.output<typeof adminBillingSupplierListQuerySchema>;
export type AdminChargeQuery = z.output<typeof adminChargeListQuerySchema>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The groups «Неуспешные» shows when none is asked for. */
export const FAILED_GROUPS: readonly SupplierBillingGroup[] = [
  "declined",
  "awaiting_provider",
  "paused",
];

/** «Платежи поставщиков не прошли» of the home screen (TASK-043 requirement 6). */
export const UNPAID_GROUPS: readonly SupplierBillingGroup[] = ["declined", "paused"];

function at(moment: Date): SQL {
  return sql`${moment.toISOString()}::timestamptz`;
}

function invalidCursor(): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", "The paging cursor is not one we issued", {
    details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
  });
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** A text position at the database's precision: `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. */
function timePosition(column: SQL): SQL<string> {
  return sql<string>`to_char((${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

// ------------------------------------------------- users' subscriptions (I847)

/** The first applied `started` of the subscription `s`: «новая за период» counts this moment. */
const STARTED_AT = sql`(SELECT min(e.event_at) FROM billing_event e
  WHERE e.subscription_id = s.id AND e.kind = 'started' AND e.outcome = 'applied')`;

/**
 * The move of the subscription `s` into the final state `expired` — the
 * expiry, a refund, a revocation, a lapse of time — the latest applied
 * event bringing it; a subscription ended by a newer one (`replaced`) has
 * no event of its own and ends when it was changed. Only a subscription
 * that **is** `expired` has ended: one that lapsed and was renewed
 * (`expired_unconfirmed` → `active`) or an older bad event of a live one
 * does not count.
 */
const ENDED = sql`LEFT JOIN LATERAL (
  SELECT e.event_at AS at, e.kind AS kind FROM billing_event e
  WHERE e.subscription_id = s.id AND e.outcome = 'applied' AND e.to_status = 'expired'
  ORDER BY e.event_at DESC LIMIT 1
) ended_event ON true`;
const ENDED_AT = sql`(CASE WHEN s.status = 'expired' THEN coalesce(ended_event.at, s.updated_at) END)`;
const ENDED_KIND = sql`(CASE WHEN s.status = 'expired' THEN coalesce(ended_event.kind, 'replaced') END)`;

/** Every filter of A-BILL-02 but the tab: the tab is the one thing the counts of the tabs vary. */
function userFilters(query: AdminUserSubscriptionListQuery): SQL[] {
  const where: SQL[] = [sql`s.audience = 'user'`];
  if (query.status) where.push(sql`s.status = ${query.status}`);
  if (query.platform === "other") where.push(sql`s.purchase_platform IS NULL`);
  else if (query.platform) where.push(sql`s.purchase_platform = ${query.platform}`);
  if (query.provider) where.push(sql`s.provider = ${query.provider}`);
  if (query.accountId) where.push(sql`s.account_id = ${query.accountId}::uuid`);
  if (query.q) where.push(userSearchCondition(query.q));
  if (query.startedFrom) where.push(sql`${STARTED_AT} >= ${query.startedFrom}::timestamptz`);
  if (query.startedTo) where.push(sql`${STARTED_AT} < ${query.startedTo}::timestamptz`);
  if (query.endedFrom) where.push(sql`${ENDED_AT} >= ${query.endedFrom}::timestamptz`);
  if (query.endedTo) where.push(sql`${ENDED_AT} < ${query.endedTo}::timestamptz`);
  return where;
}

// --------------------------------------------- the suppliers' groups (I847)

/**
 * **The one billing group of a supplier** `sp` (its current subscription is
 * `cur`): the first that holds of paused → declined → awaiting the payment
 * system → paid → none. The summary counts with it, the lists filter with
 * it, so a number and its list never disagree and nobody is in two groups.
 */
const SUPPLIER_GROUP = sql`(CASE
  WHEN sp.billing_paused_at IS NOT NULL OR cur.status = 'suspended' THEN 'paused'
  WHEN cur.status = 'past_due' THEN 'declined'
  WHEN EXISTS (SELECT 1 FROM payment_attempt w
    WHERE w.supplier_id = sp.id AND w.status IN ('unavailable', 'unknown')) THEN 'awaiting_provider'
  WHEN cur.status IN ('active', 'cancelled') THEN 'paid'
  ELSE 'none'
END)`;

const SUPPLIER_FROM = sql`supplier sp
  LEFT JOIN subscription cur ON cur.supplier_id = sp.id AND cur.status <> 'expired'`;

const GROUP_RANK: Record<SupplierBillingGroup, number> = {
  declined: 0,
  awaiting_provider: 1,
  paused: 2,
  paid: 3,
  none: 4,
};

/** The list's order: the nearest pause first, the refusals, the waiting, the pauses, the rest. */
const SUPPLIER_SORT_AT = sql`(CASE
  WHEN cur.status = 'past_due' AND sp.billing_paused_at IS NULL THEN cur.grace_until
  ELSE coalesce(sp.billing_paused_at, cur.current_period_end)
END)`;

function supplierSearch(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const digits = q.replace(/\D/g, "");
  const name = sql`sp.name ILIKE ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`;
  return digits.length >= 3 ? sql`(${name} OR sp.bin LIKE ${`%${digits}%`})` : name;
}

// --------------------------------------------------------- charges (A-BILL-03)

interface ChargeFilters {
  from?: string;
  to?: string;
  supplierId?: string;
  status?: readonly AdminChargeStatus[];
  kind?: readonly SupplierChargeKind[];
}

function chargeFilters(filters: ChargeFilters): SQL {
  const where: SQL[] = [sql`pa.status <> 'cancelled'`];
  if (filters.from) where.push(sql`pa.created_at >= ${filters.from}::timestamptz`);
  if (filters.to) where.push(sql`pa.created_at < ${filters.to}::timestamptz`);
  if (filters.supplierId) where.push(sql`pa.supplier_id = ${filters.supplierId}::uuid`);
  if (filters.status?.length) {
    where.push(
      sql`pa.status IN (${sql.join(
        filters.status.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    );
  }
  if (filters.kind?.length) {
    where.push(
      sql`pa.kind IN (${sql.join(
        filters.kind.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    );
  }
  return sql.join(where, sql` AND `);
}

/**
 * «Биллинг» of the admin panel (SCREENS 7.8 A-BILL-01…03; TASK-043;
 * ARCHITECTURE 4.78): the summary and the lists its cards open. **A number
 * of the summary is a count of a list's own function with that list's
 * filters** — `countUserSubscriptions`, `supplierGroupCounts`,
 * `chargeTotals` — so a card and its list never disagree (I847). Nothing
 * here writes: the administrator charges nothing and changes no status.
 * Numbers of people go out partly hidden; a card's token never leaves
 * `payment_method` (only its mask is read).
 */
@Injectable()
export class AdminBilling {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  /** The default period: the last 30 days of Almaty, today included. */
  period(query: AdminBillingPeriodQuery, now: Date = new Date()): { from: string; to: string } {
    const today = localDateTime(now, BILLING_TIME_ZONE).date;
    const shift = (date: string, days: number) => {
      const day = new Date(`${date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + days);
      return day.toISOString().slice(0, 10);
    };
    return {
      from: query.from ?? startOfLocalDate(shift(today, -29), BILLING_TIME_ZONE).toISOString(),
      to: query.to ?? startOfLocalDate(shift(today, 1), BILLING_TIME_ZONE).toISOString(),
    };
  }

  // ------------------------------------------------------------ A-BILL-01

  async summary(query: AdminBillingPeriodQuery): Promise<AdminBillingSummary> {
    const now = new Date();
    const { from, to } = this.period(query, now);
    const users = (filters: Partial<AdminUserSubscriptionListQuery>) =>
      this.countUserSubscriptions(
        adminUserSubscriptionListQuerySchema.parse({ tab: "active", ...filters }),
        now,
      );
    const [total, ios, android, other, started, ended, groups, succeeded, declined, plan] =
      await Promise.all([
        users({}),
        users({ platform: "ios" }),
        users({ platform: "android" }),
        users({ platform: "other" }),
        users({ tab: "all", startedFrom: from, startedTo: to }),
        users({ tab: "ended", endedFrom: from, endedTo: to }),
        this.supplierGroupCounts(undefined),
        this.chargeTotals({ from, to, status: ["succeeded"] }),
        this.chargeTotals({ from, to, status: ["declined"] }),
        this.plans.supplierNow(now),
      ]);
    return {
      period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      users: {
        active: {
          total: total.active,
          ios: ios.active,
          android: android.active,
          other: other.active,
        },
        started: started.all,
        ended: ended.ended,
      },
      suppliers: groups,
      charges: {
        succeeded: { count: succeeded.count, amount: succeeded.amount },
        declined: { count: declined.count },
      },
      supplierPlan: plan,
      at: now.toISOString(),
    };
  }

  // ------------------------------------------------------------ A-BILL-02

  /** The counts of the three tabs with the other filters. */
  async countUserSubscriptions(
    query: AdminUserSubscriptionListQuery,
    now: Date,
  ): Promise<{ active: number; ended: number; all: number }> {
    const until = await this.accessUntil();
    const { rows } = await this.database.db.execute<{ active: number; all: number }>(sql`
      SELECT count(*) FILTER (WHERE ${until} > ${at(now)})::int AS active, count(*)::int AS all
      FROM subscription s JOIN account ON account.id = s.account_id ${ENDED}
      WHERE ${sql.join(userFilters(query), sql` AND `)}
    `);
    const row = rows[0] ?? { active: 0, all: 0 };
    return {
      active: Number(row.active),
      ended: Number(row.all) - Number(row.active),
      all: Number(row.all),
    };
  }

  async userSubscriptions(
    query: AdminUserSubscriptionListQuery,
  ): Promise<AdminUserSubscriptionPage> {
    const now = new Date();
    const [until, toleranceHours] = await Promise.all([
      this.accessUntil(),
      this.settings.get("store_lag_tolerance_hours"),
    ]);
    const where = userFilters(query);
    if (query.tab === "active") where.push(sql`${until} > ${at(now)}`);
    if (query.tab === "ended") where.push(sql`(${until} IS NULL OR ${until} <= ${at(now)})`);
    if (query.expiringDays) {
      where.push(sql`${until} > ${at(now)}`);
      where.push(sql`${until} <= ${at(new Date(now.getTime() + query.expiringDays * DAY_MS))}`);
    }
    let after: SQL | undefined;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!TIME_POSITION.test(cursor.position)) throw invalidCursor();
      after = sql`(s.created_at, s.id) < (${cursor.position}::timestamptz, ${cursor.id}::uuid)`;
    }
    const filter = sql.join(where, sql` AND `);
    const [{ rows }, counts, { rows: counted }] = await Promise.all([
      this.database.db.execute<{
        id: string;
        account_id: string;
        name: string | null;
        phone: string;
        status: SubscriptionStatus;
        purchase_platform: "ios" | "android" | null;
        provider: "store" | "card_kz" | "test";
        current_period_end: string;
        grace_until: string | null;
        unconfirmed_since: string | null;
        started_at: string | null;
        ended_at: string | null;
        ended_kind: string | null;
        position: string;
      }>(sql`
        SELECT s.id, s.account_id, account.name, account.phone, s.status, s.purchase_platform,
          s.provider, s.current_period_end, s.grace_until, s.unconfirmed_since,
          ${STARTED_AT} AS started_at, ${ENDED_AT} AS ended_at, ${ENDED_KIND} AS ended_kind,
          ${timePosition(sql`s.created_at`)} AS position
        FROM subscription s JOIN account ON account.id = s.account_id ${ENDED}
        WHERE ${filter} ${after ? sql`AND ${after}` : sql``}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ${query.limit + 1}
      `),
      this.countUserSubscriptions(query, now),
      this.database.db.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total
        FROM subscription s JOIN account ON account.id = s.account_id ${ENDED}
        WHERE ${filter}
      `),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      subscriptions: page.map((row) => {
        const access = subscriptionAccess(
          {
            status: row.status,
            periodEnd: new Date(row.current_period_end),
            graceUntil: row.grace_until ? new Date(row.grace_until) : null,
            unconfirmedSince: row.unconfirmed_since ? new Date(row.unconfirmed_since) : null,
          },
          now,
          toleranceHours * HOUR_MS,
        );
        return {
          id: row.id,
          accountId: row.account_id,
          name: row.name,
          phone: hidePhone(row.phone),
          status: row.status,
          grantsAccess: access.granted,
          platform: row.purchase_platform,
          provider: row.provider,
          periodEnd: iso(row.current_period_end)!,
          accessUntil: access.until?.toISOString() ?? null,
          startedAt: iso(row.started_at),
          ended:
            row.ended_at && row.ended_kind
              ? { at: iso(row.ended_at)!, kind: row.ended_kind }
              : null,
        };
      }),
      total: Number(counted[0]?.total ?? 0),
      counts,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }

  /** `subscriptionAccessUntil` of `s` with the tolerance in effect (the twin of `ClubAccess`). */
  private async accessUntil(): Promise<SQL> {
    const toleranceHours = await this.settings.get("store_lag_tolerance_hours");
    return subscriptionAccessUntilSql(sql.raw("s"), toleranceHours * HOUR_MS);
  }

  // ------------------------------------------------------------ A-BILL-03

  /** Every group's count, with the search (the summary passes none). */
  async supplierGroupCounts(q: string | undefined): Promise<AdminBillingSupplierPage["counts"]> {
    const search = supplierSearch(q);
    const { rows } = await this.database.db.execute<{ grp: SupplierBillingGroup; n: number }>(sql`
      SELECT ${SUPPLIER_GROUP} AS grp, count(*)::int AS n
      FROM ${SUPPLIER_FROM}
      ${search ? sql`WHERE ${search}` : sql``}
      GROUP BY 1
    `);
    const of = (group: SupplierBillingGroup) =>
      Number(rows.find((row) => row.grp === group)?.n ?? 0);
    return {
      paid: of("paid"),
      declined: of("declined"),
      awaitingProvider: of("awaiting_provider"),
      paused: of("paused"),
      none: of("none"),
    };
  }

  async suppliers(query: AdminBillingSupplierQuery): Promise<AdminBillingSupplierPage> {
    const groups = query.groups ?? [...FAILED_GROUPS];
    const now = new Date();
    const search = supplierSearch(query.q);
    let after: SQL | undefined;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const [rank, moment] = cursor.position.split("|");
      if (
        !rank ||
        !/^\d$/.test(rank) ||
        !moment ||
        !(moment === "~" || TIME_POSITION.test(moment))
      ) {
        throw invalidCursor();
      }
      after = sql`(x.rank, x.sort_key, x.id) > (${Number(rank)}, ${moment}, ${cursor.id}::uuid)`;
    }
    const rankCase = sql.join(
      Object.entries(GROUP_RANK).map(([group, rank]) => sql`WHEN ${group} THEN ${rank}`),
      sql` `,
    );
    const inner = sql`
      SELECT sp.id, sp.name, sp.billing_paused_at, sp.admin_paused_at,
        cur.id AS subscription_id, cur.status AS subscription_status,
        cur.current_period_end, cur.grace_until,
        ${SUPPLIER_GROUP} AS grp,
        coalesce(${timePosition(SUPPLIER_SORT_AT)}, '~') AS sort_key
      FROM ${SUPPLIER_FROM}
      ${search ? sql`WHERE ${search}` : sql``}
    `;
    const groupList = sql.join(
      groups.map((group) => sql`${group}`),
      sql`, `,
    );
    const [{ rows }, { rows: counted }, counts, hour, retryDays] = await Promise.all([
      this.database.db.execute<{
        id: string;
        name: string;
        billing_paused_at: string | null;
        admin_paused_at: string | null;
        subscription_id: string | null;
        subscription_status: SupplierSubscriptionStatus | null;
        current_period_end: string | null;
        grace_until: string | null;
        grp: SupplierBillingGroup;
        rank: number;
        sort_key: string;
      }>(sql`
        SELECT * FROM (
          SELECT inner_rows.*, (CASE inner_rows.grp ${rankCase} END) AS rank FROM (${inner}) inner_rows
        ) x
        WHERE x.grp IN (${groupList}) ${after ? sql`AND ${after}` : sql``}
        ORDER BY x.rank, x.sort_key, x.id
        LIMIT ${query.limit + 1}
      `),
      this.database.db.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total FROM (${inner}) x WHERE x.grp IN (${groupList})
      `),
      this.supplierGroupCounts(query.q),
      this.settings.get("billing_notify_hour"),
      this.settings.get("billing_retry_days"),
    ]);
    const page = rows.slice(0, query.limit);
    const details = await this.supplierDetails(page);
    const last = page.at(-1);
    return {
      suppliers: page.map((row): AdminBillingSupplier => {
        const facts = details.get(row.id)!;
        const pauseAt =
          row.grp === "declined" && row.grace_until ? new Date(row.grace_until) : null;
        const lastDecline = facts.declines[0] ?? null;
        return {
          supplierId: row.id,
          name: row.name,
          group: row.grp,
          subscriptionStatus: row.subscription_status,
          periodEnd: iso(row.current_period_end),
          cardMask: facts.cardMask,
          pausedSince: iso(row.billing_paused_at),
          adminPaused: row.admin_paused_at !== null,
          lastDecline: lastDecline
            ? {
                at: lastDecline.at.toISOString(),
                reason: lastDecline.reason,
                amount: lastDecline.amount,
              }
            : null,
          declines: facts.declines.length,
          // The retry W-05 promised (one rule with the cabinet and the daily job, I849).
          nextRetryAt:
            row.grp === "declined"
              ? (pastDueNextRetry({
                  declinedCount: facts.declines.length,
                  lastDeclinedAt: lastDecline?.at ?? null,
                  graceUntil: pauseAt,
                  retryDays,
                  hour,
                  now,
                })?.toISOString() ?? null)
              : null,
          pauseAt: pauseAt?.toISOString() ?? null,
          daysToPause: pauseAt ? daysUntilPause(pauseAt, now) : null,
          waiting: facts.waiting,
        };
      }),
      total: Number(counted[0]?.total ?? 0),
      counts,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(`${String(last.rank)}|${last.sort_key}`, last.id)
          : null,
    };
  }

  /** The refusals of the unpaid term, the waiting charge and the card of each supplier of a page. */
  private async supplierDetails(
    page: readonly {
      id: string;
      subscription_id: string | null;
      current_period_end: string | null;
    }[],
  ) {
    const result = new Map<
      string,
      {
        declines: { at: Date; reason: PaymentDeclineReason; amount: number }[];
        waiting: AdminBillingSupplier["waiting"];
        cardMask: string | null;
      }
    >(page.map((row) => [row.id, { declines: [], waiting: null, cardMask: null }]));
    if (page.length === 0) return result;
    const ids = sql.join(
      page.map((row) => sql`${row.id}::uuid`),
      sql`, `,
    );
    const keys = page
      .filter((row) => row.subscription_id && row.current_period_end)
      .map((row) => termKey(row.subscription_id!, new Date(row.current_period_end!)));
    const [declines, waiting, cards] = await Promise.all([
      keys.length === 0
        ? Promise.resolve({
            rows: [] as {
              supplier_id: string;
              at: string;
              reason: PaymentDeclineReason;
              amount: number;
            }[],
          })
        : this.database.db.execute<{
            supplier_id: string;
            at: string;
            reason: PaymentDeclineReason;
            amount: number;
          }>(sql`
            SELECT supplier_id, coalesce(resolved_at, created_at) AS at, decline_reason AS reason, amount
            FROM payment_attempt
            WHERE period_key IN (${sql.join(
              keys.map((key) => sql`${key}`),
              sql`, `,
            )})
              AND status = 'declined'
            ORDER BY coalesce(resolved_at, created_at) DESC
          `),
      this.database.db.execute<{
        supplier_id: string;
        status: "unavailable" | "unknown";
        since: string;
        next_try_at: string | null;
        amount: number;
      }>(sql`
        SELECT DISTINCT ON (supplier_id) supplier_id, status,
          coalesce(first_failure_at, created_at) AS since, next_try_at, amount
        FROM payment_attempt
        WHERE supplier_id IN (${ids}) AND status IN ('unavailable', 'unknown')
        ORDER BY supplier_id, created_at DESC
      `),
      this.database.db.execute<{ supplier_id: string; mask: string }>(sql`
        SELECT supplier_id, mask FROM payment_method
        WHERE supplier_id IN (${ids}) AND status = 'active'
      `),
    ]);
    for (const row of declines.rows) {
      result.get(row.supplier_id)?.declines.push({
        at: new Date(row.at),
        reason: row.reason,
        amount: Number(row.amount),
      });
    }
    for (const row of waiting.rows) {
      const entry = result.get(row.supplier_id);
      if (entry) {
        entry.waiting = {
          status: row.status,
          since: iso(row.since)!,
          nextTryAt: iso(row.next_try_at),
          amount: Number(row.amount),
        };
      }
    }
    for (const row of cards.rows) {
      const entry = result.get(row.supplier_id);
      if (entry) entry.cardMask = row.mask;
    }
    return result;
  }

  /** The count and the sum of the charges matching the filters (the summary and «История»). */
  async chargeTotals(filters: ChargeFilters): Promise<{ count: number; amount: number }> {
    const { rows } = await this.database.db.execute<{ n: number; amount: string | null }>(sql`
      SELECT count(*)::int AS n, coalesce(sum(pa.amount), 0)::bigint AS amount
      FROM payment_attempt pa WHERE ${chargeFilters(filters)}
    `);
    return { count: Number(rows[0]?.n ?? 0), amount: Number(rows[0]?.amount ?? 0) };
  }

  async charges(query: AdminChargeQuery): Promise<AdminChargePage> {
    const filters: ChargeFilters = {
      from: query.from,
      to: query.to,
      supplierId: query.supplierId,
      status: query.status,
      kind: query.kind,
    };
    let after: SQL | undefined;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!TIME_POSITION.test(cursor.position)) throw invalidCursor();
      after = sql`(pa.created_at, pa.id) < (${cursor.position}::timestamptz, ${cursor.id}::uuid)`;
    }
    const [{ rows }, totals] = await Promise.all([
      this.database.db.execute<{
        id: string;
        created_at: string;
        supplier_id: string;
        supplier_name: string;
        kind: SupplierChargeKind;
        status: AdminChargeStatus;
        decline_reason: PaymentDeclineReason | null;
        amount: number;
        period_from: string;
        period_to: string;
        card_mask: string | null;
        member_id: string | null;
        member_name: string | null;
        resolved_at: string | null;
        next_try_at: string | null;
        position: string;
      }>(sql`
        SELECT pa.id, pa.created_at, pa.supplier_id, sp.name AS supplier_name, pa.kind, pa.status,
          pa.decline_reason, pa.amount, pa.period_from, pa.period_to,
          coalesce(pm.mask, cb.card_mask) AS card_mask,
          pa.requested_by_member_id AS member_id, m.display_name AS member_name,
          pa.resolved_at, pa.next_try_at,
          ${timePosition(sql`pa.created_at`)} AS position
        FROM payment_attempt pa
        JOIN supplier sp ON sp.id = pa.supplier_id
        LEFT JOIN payment_method pm ON pm.id = pa.payment_method_id
        LEFT JOIN card_binding cb ON cb.id = pa.binding_id
        LEFT JOIN supplier_member m ON m.id = pa.requested_by_member_id
        WHERE ${chargeFilters(filters)} ${after ? sql`AND ${after}` : sql``}
        ORDER BY pa.created_at DESC, pa.id DESC
        LIMIT ${query.limit + 1}
      `),
      this.chargeTotals(filters),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      charges: page.map((row): AdminCharge => ({
        id: row.id,
        at: iso(row.created_at)!,
        supplier: { id: row.supplier_id, name: row.supplier_name },
        kind: row.kind,
        status: row.status,
        declineReason: row.status === "declined" ? row.decline_reason : null,
        amount: Number(row.amount),
        currency: "KZT",
        periodFrom: iso(row.period_from)!,
        periodTo: iso(row.period_to)!,
        cardMask: row.card_mask,
        requestedBy: row.member_id ? { memberId: row.member_id, name: row.member_name } : null,
        resolvedAt: iso(row.resolved_at),
        nextTryAt:
          row.status === "unavailable" || row.status === "unknown" ? iso(row.next_try_at) : null,
      })),
      total: totals.count,
      totalAmount: totals.amount,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }

  /** «Платежи поставщиков не прошли · N» of the home screen: the `total` of that list. */
  async unpaidSuppliers(): Promise<number> {
    const counts = await this.supplierGroupCounts(undefined);
    return counts.declined + counts.paused;
  }
}
