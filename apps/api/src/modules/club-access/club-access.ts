import { Inject, Injectable } from "@nestjs/common";
import type { ClubAccessState } from "@adclub/contracts";
import { combineClubAccess, subscriptionAccess, type SubscriptionAccess } from "@adclub/domain";
import { and, desc, eq, gt, inArray, isNull, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AppSettings } from "../settings";
import { clubAccessGrant, subscription, type SubscriptionRow } from "./schema";

const NONE: ClubAccessState = { granted: false, source: null, validUntil: null };

const HOUR_MS = 3_600_000;

/** Club access of one account and what it is made of. */
export interface ClubAccessSources {
  access: ClubAccessState;
  /** The end of the grant by hand in force; `null` — none. */
  manualUntil: Date | null;
  /** The account's current subscription (any status but `expired`); `null` — none. */
  subscription: SubscriptionRow | null;
  /** What that subscription gives now (`subscriptionAccess`). */
  subscriptionAccess: SubscriptionAccess;
}

function stateOfSources(
  manualUntil: Date | null,
  paid: SubscriptionAccess,
  at: Date,
): ClubAccessState {
  const best = combineClubAccess(
    [
      manualUntil ? { source: "manual", until: manualUntil } : null,
      paid.until ? { source: "subscription", until: paid.until } : null,
    ],
    at,
  );
  return best ? { granted: true, source: best.source, validUntil: best.until.toISOString() } : NONE;
}

function stateOfRow(row: SubscriptionRow) {
  return {
    status: row.status,
    periodEnd: row.currentPeriodEnd,
    graceUntil: row.graceUntil,
    unconfirmedSince: row.unconfirmedSince,
  };
}

const NO_SUBSCRIPTION: SubscriptionAccess = { granted: false, until: null };

/**
 * Whether an account has club access now (D-059; ARCHITECTURE 4.29, 4.72) —
 * the one function every rule of visibility asks (the names of suppliers and
 * the points of their offers, TASK-020; orders, EPIC-08; reviews, the
 * supplier's page). A guest has none.
 *
 * Two sources (TASK-040): a grant by hand that isn't ended and whose end is
 * ahead, and the account's subscription in a status that gives access
 * (`subscriptionAccess` of `@adclub/domain`, the tolerance —
 * `store_lag_tolerance_hours`). Access is on if either gives it, until the
 * farther end; `source` names whose end that is (a subscription on a tie).
 * The callers don't know which. Nothing is cached: an access that ends
 * while a session lasts is gone on the very next request.
 */
@Injectable()
export class ClubAccess {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async stateOf(
    accountId: string | null,
    executor: DbExecutor = this.database.db,
    at: Date = new Date(),
  ): Promise<ClubAccessState> {
    if (accountId === null) {
      return NONE;
    }
    return (await this.sourcesOf(accountId, executor, at)).access;
  }

  /** `stateOf`, with the grant by hand and the subscription it is made of. */
  async sourcesOf(
    accountId: string,
    executor: DbExecutor = this.database.db,
    at: Date = new Date(),
  ): Promise<ClubAccessSources> {
    // One after another: `executor` may be the caller's transaction — one connection.
    const toleranceMs = await this.toleranceMs();
    const [grant] = await executor
      .select({ validUntil: clubAccessGrant.validUntil })
      .from(clubAccessGrant)
      .where(
        and(
          eq(clubAccessGrant.accountId, accountId),
          isNull(clubAccessGrant.endedAt),
          gt(clubAccessGrant.validUntil, at),
        ),
      )
      .orderBy(desc(clubAccessGrant.validUntil))
      .limit(1);
    const [current] = await executor
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.accountId, accountId),
          eq(subscription.audience, "user"),
          ne(subscription.status, "expired"),
        ),
      )
      .limit(1);
    const manualUntil = grant?.validUntil ?? null;
    const paid = current
      ? subscriptionAccess(stateOfRow(current), at, toleranceMs)
      : NO_SUBSCRIPTION;
    return {
      access: stateOfSources(manualUntil, paid, at),
      manualUntil,
      subscription: current ?? null,
      subscriptionAccess: paid,
    };
  }

  /** `stateOf(…).granted`. */
  async has(accountId: string | null, executor?: DbExecutor): Promise<boolean> {
    return (await this.stateOf(accountId, executor)).granted;
  }

  /** `stateOf` of several accounts at once (the admin list of users, TASK-036.B). */
  async statesOf(
    accountIds: readonly string[],
    executor: DbExecutor = this.database.db,
    at: Date = new Date(),
  ): Promise<Map<string, ClubAccessState>> {
    const states = new Map<string, ClubAccessState>();
    const ids = [...new Set(accountIds)];
    for (const id of ids) states.set(id, NONE);
    if (ids.length === 0) {
      return states;
    }
    const toleranceMs = await this.toleranceMs();
    const grants = await executor
      .select({ accountId: clubAccessGrant.accountId, validUntil: clubAccessGrant.validUntil })
      .from(clubAccessGrant)
      .where(
        and(
          inArray(clubAccessGrant.accountId, ids),
          isNull(clubAccessGrant.endedAt),
          gt(clubAccessGrant.validUntil, at),
        ),
      );
    const subscriptions = await executor
      .select()
      .from(subscription)
      .where(
        and(
          inArray(subscription.accountId, ids),
          eq(subscription.audience, "user"),
          ne(subscription.status, "expired"),
        ),
      );
    const manual = new Map<string, Date>();
    for (const row of grants) {
      const known = manual.get(row.accountId);
      if (!known || row.validUntil.getTime() > known.getTime()) {
        manual.set(row.accountId, row.validUntil);
      }
    }
    const paid = new Map<string, SubscriptionAccess>();
    for (const row of subscriptions) {
      if (row.accountId)
        paid.set(row.accountId, subscriptionAccess(stateOfRow(row), at, toleranceMs));
    }
    for (const id of ids) {
      states.set(id, stateOfSources(manual.get(id) ?? null, paid.get(id) ?? NO_SUBSCRIPTION, at));
    }
    return states;
  }

  /**
   * The SQL twin of `stateOf(…).validUntil` with the tolerance in effect
   * (the admin list's filter of club access, TASK-036.B): `clubAccessUntil`.
   */
  async untilSql(accountId: SQL | AnyColumn, at: Date): Promise<SQL<Date | null>> {
    return clubAccessUntil(accountId, at, await this.toleranceMs());
  }

  private async toleranceMs(): Promise<number> {
    return (await this.settings.get("store_lag_tolerance_hours")) * HOUR_MS;
  }
}

/**
 * The SQL twin of `ClubAccess.stateOf` for lists that filter by it (the
 * admin list of users, TASK-036.B): the end of the account's club access
 * now, `NULL` — none. **The same rule** — the farther end of a grant by
 * hand in force and of what the current subscription gives
 * (`subscriptionAccessUntil`, case by case), both after `at` — so it and
 * `stateOf` change together (as `offerShowcase` and `shownOffers`, 4.28);
 * an integration test keeps them in agreement on the same data.
 */
export function clubAccessUntil(
  accountId: SQL | AnyColumn,
  at: Date,
  toleranceMs: number,
): SQL<Date | null> {
  const tolerance = sql`make_interval(secs => ${toleranceMs / 1000})`;
  const now = sql`${at.toISOString()}::timestamptz`;
  return sql<Date | null>`(SELECT max(ends.until) FROM (
      SELECT ${clubAccessGrant.validUntil} AS until FROM ${clubAccessGrant}
        WHERE ${clubAccessGrant.accountId} = ${accountId}
          AND ${clubAccessGrant.endedAt} IS NULL
      UNION ALL
      SELECT CASE paid.status
          WHEN 'active' THEN paid.current_period_end + ${tolerance}
          WHEN 'grace' THEN GREATEST(paid.current_period_end, paid.grace_until) + ${tolerance}
          WHEN 'cancelled' THEN paid.current_period_end
          WHEN 'expired_unconfirmed'
            THEN coalesce(paid.unconfirmed_since, paid.current_period_end) + ${tolerance}
        END
        FROM subscription AS paid
        WHERE paid.account_id = ${accountId} AND paid.audience = 'user' AND paid.status <> 'expired'
    ) AS ends WHERE ends.until > ${now})`;
}
