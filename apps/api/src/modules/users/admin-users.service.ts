import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminUser,
  type AdminUserGarageResponse,
  type AdminUserListQuery,
  type AdminUserPage,
  type AdminUserSessionListResponse,
  type AdminUserSummary,
} from "@adclub/contracts";
import { hidePhone, isRegistrationComplete, phoneSearchDigits } from "@adclub/domain";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { ClubAccess, clubAccessUntil } from "../club-access";
import { GarageService } from "../garage";
import { account, ipHint, SessionStore } from "../identity";
import { city } from "../suppliers";

/** An administrator acting in the admin panel. */
export interface AdminActor {
  accountId: string;
  adminId: string;
}

const DAY_MS = 86_400_000;

export function userNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such user");
}

function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

/** A text inside a LIKE pattern: its own `%`, `_` and `\` mean themselves. */
export function likeEscaped(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * **Who is a user of the app** (TASK-036.B; SCREENS A-USR-01): an account
 * that finished the registration, has (or had) a session of the app,
 * ordered, keeps cars or was given club access. An account that only works
 * in a cabinet or the admin panel is not one — it would be a stranger in
 * the list of the club's members. One condition for the list and the
 * header's search.
 */
export function appUserCondition(): SQL {
  return sql`(
    ${account.consentPhoneShareAt} IS NOT NULL
    OR EXISTS (SELECT 1 FROM session AS app WHERE app.account_id = ${account.id} AND app.kind = 'mobile')
    OR EXISTS (SELECT 1 FROM customer_order AS purchase WHERE purchase.user_account_id = ${account.id})
    OR EXISTS (SELECT 1 FROM club_access_grant AS access WHERE access.account_id = ${account.id})
    OR EXISTS (SELECT 1 FROM account_car AS car WHERE car.account_id = ${account.id})
  )`;
}

/**
 * The line a user is looked up by: digits of the phone (matched inside the
 * full stored number — the answer hides it all the same) or a part of the
 * name. An empty match is `false`, not «everyone».
 */
export function userSearchCondition(q: string): SQL {
  const digits = phoneSearchDigits(q);
  if (digits) {
    return sql`(${sql.join(
      digits.map((value) => sql`${account.phone} LIKE ${`%${value}%`}`),
      sql` OR `,
    )})`;
  }
  return sql`${account.name} ILIKE ${`%${likeEscaped(q.trim())}%`}`;
}

/** No-show marks of the account that still stand. */
const STANDING_NO_SHOWS = sql<number>`(SELECT count(*)::int FROM user_discipline_event AS mark
  WHERE mark.user_account_id = ${account.id} AND mark.revoked_at IS NULL)`;

/**
 * The users of the app in the admin panel (TASK-036.B; SCREENS A-USR-01,
 * A-USR-02): the list with its filters, the card, the garage to look at,
 * the sessions of the app and ending them. Club access is read only
 * through `ClubAccess` (and its SQL twin for the filter); granting and
 * revoking it stays `ClubAccessGrants`. A person's number goes out partly
 * hidden — in full only through `PhoneReveals`.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger("AdminUsers");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
    @Inject(GarageService) private readonly garage: GarageService,
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async list(query: AdminUserListQuery): Promise<AdminUserPage> {
    const now = new Date();
    const conditions: SQL[] = [appUserCondition()];
    if (query.q) {
      conditions.push(userSearchCondition(query.q));
    }
    const until = clubAccessUntil(account.id, now);
    if (query.clubAccess === "active") {
      conditions.push(sql`${until} IS NOT NULL`);
    } else if (query.clubAccess === "none") {
      conditions.push(sql`${until} IS NULL`);
    } else if (query.clubAccess === "expiring") {
      const horizon = new Date(now.getTime() + query.expiringDays * DAY_MS);
      conditions.push(sql`${until} <= ${horizon.toISOString()}::timestamptz`);
    }
    if (query.noShows === "true") {
      conditions.push(sql`${STANDING_NO_SHOWS} > 0`);
    }
    const filter = and(...conditions)!;
    const position = sql<string>`to_char(${account.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    let after: SQL | undefined;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!TIME_POSITION.test(cursor.position)) {
        throw validationError("cursor", "Use the nextCursor of the previous page");
      }
      after = sql`(${account.createdAt}, ${account.id}) < (${cursor.position}::timestamptz, ${cursor.id}::uuid)`;
    }
    const [rows, [counted]] = await Promise.all([
      this.database.db
        .select({
          id: account.id,
          name: account.name,
          phone: account.phone,
          consentPhoneShareAt: account.consentPhoneShareAt,
          createdAt: account.createdAt,
          cityName: city.nameRu,
          noShows: STANDING_NO_SHOWS,
          supplierMember: sql<boolean>`EXISTS (SELECT 1 FROM supplier_member AS member
            WHERE member.account_id = ${account.id} AND member.status = 'active')`,
          position,
        })
        .from(account)
        .leftJoin(city, eq(city.id, account.cityId))
        .where(and(filter, after))
        .orderBy(desc(account.createdAt), desc(account.id))
        .limit(query.limit + 1),
      this.database.db
        .select({ value: sql<number>`count(*)::int` })
        .from(account)
        .where(filter),
    ]);
    const page = rows.slice(0, query.limit);
    const access = await this.clubAccess.statesOf(
      page.map((row) => row.id),
      this.database.db,
      now,
    );
    const last = page.at(-1);
    return {
      users: page.map((row): AdminUserSummary => ({
        accountId: row.id,
        name: row.name,
        phone: hidePhone(row.phone),
        cityName: row.cityName ?? null,
        createdAt: row.createdAt.toISOString(),
        registrationCompleted: isRegistrationComplete(row),
        clubAccess: access.get(row.id)!,
        noShows: Number(row.noShows),
        supplierMember: Boolean(row.supplierMember),
      })),
      total: counted?.value ?? 0,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }

  async card(accountId: string): Promise<AdminUser> {
    const now = new Date();
    const [row] = await this.database.db
      .select({
        id: account.id,
        name: account.name,
        phone: account.phone,
        email: account.email,
        emailNewsConsent: account.emailNewsConsent,
        cityId: account.cityId,
        cityName: city.nameRu,
        language: account.language,
        createdAt: account.createdAt,
        consentPhoneShareAt: account.consentPhoneShareAt,
        consentVersion: account.consentVersion,
      })
      .from(account)
      .leftJoin(city, eq(city.id, account.cityId))
      .where(eq(account.id, accountId));
    if (!row) {
      throw userNotFound();
    }
    const [access, memberships, counts] = await Promise.all([
      this.clubAccess.stateOf(accountId, this.database.db, now),
      this.database.db.execute<{
        supplier_id: string;
        supplier_name: string;
        member_id: string;
        display_name: string;
        status: "active" | "removed";
      }>(sql`SELECT member.supplier_id, company.name AS supplier_name, member.id AS member_id,
          member.display_name, member.status
        FROM supplier_member AS member JOIN supplier AS company ON company.id = member.supplier_id
        WHERE member.account_id = ${accountId}
        ORDER BY member.status, company.name`),
      this.database.db.execute<{
        orders: number;
        active_orders: number;
        no_shows: number;
        no_shows_revoked: number;
        cars: number;
        sessions: number;
      }>(sql`SELECT
          (SELECT count(*)::int FROM customer_order WHERE user_account_id = ${accountId}) AS orders,
          (SELECT count(*)::int FROM customer_order WHERE user_account_id = ${accountId}
            AND status IN ('created', 'accepted', 'ready')) AS active_orders,
          (SELECT count(*)::int FROM user_discipline_event WHERE user_account_id = ${accountId}
            AND revoked_at IS NULL) AS no_shows,
          (SELECT count(*)::int FROM user_discipline_event WHERE user_account_id = ${accountId}
            AND revoked_at IS NOT NULL) AS no_shows_revoked,
          (SELECT count(*)::int FROM account_car WHERE account_id = ${accountId}) AS cars,
          (SELECT count(*)::int FROM session WHERE account_id = ${accountId} AND kind = 'mobile'
            AND revoked_at IS NULL AND expires_at > ${now.toISOString()}::timestamptz) AS sessions`),
    ]);
    const counted = counts.rows[0]!;
    return {
      accountId: row.id,
      name: row.name,
      phone: hidePhone(row.phone),
      email: row.email,
      emailNewsConsent: row.emailNewsConsent,
      city: row.cityId && row.cityName ? { id: row.cityId, name: row.cityName } : null,
      language: row.language,
      createdAt: row.createdAt.toISOString(),
      registrationCompleted: isRegistrationComplete(row),
      phoneShareConsent:
        row.consentPhoneShareAt && row.consentVersion
          ? { version: row.consentVersion, at: row.consentPhoneShareAt.toISOString() }
          : null,
      clubAccess: access,
      memberships: memberships.rows.map((member) => ({
        supplierId: member.supplier_id,
        supplierName: member.supplier_name,
        memberId: member.member_id,
        displayName: member.display_name,
        status: member.status,
      })),
      counts: {
        orders: Number(counted.orders),
        activeOrders: Number(counted.active_orders),
        noShows: Number(counted.no_shows),
        noShowsRevoked: Number(counted.no_shows_revoked),
        cars: Number(counted.cars),
        sessions: Number(counted.sessions),
      },
    };
  }

  async garageOf(accountId: string): Promise<AdminUserGarageResponse> {
    await this.requireAccount(this.database.db, accountId);
    return this.garage.list(accountId);
  }

  async sessionsOf(accountId: string): Promise<AdminUserSessionListResponse> {
    await this.requireAccount(this.database.db, accountId);
    const rows = await this.sessions.listAppSessions(accountId, new Date());
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        deviceName: row.deviceName,
        platform: row.clientPlatform,
        clientVersion: row.clientVersion,
        ipHint: ipHint(row.lastIp),
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * Ends one session of the user's app, or all of them (A-USR-02 «Завершить
   * все сессии»): the app gets `SESSION_ENDED` on its next request. A
   * cabinet or admin session of the same account is not the app's and
   * stays. Written to the journal in the same transaction.
   */
  async endSessions(
    accountId: string,
    sessionId: string | null,
    admin: AdminActor,
  ): Promise<number> {
    const now = new Date();
    const ended = await this.database.db.transaction(async (tx) => {
      await this.requireAccount(tx, accountId);
      const rows = await this.sessions.revokeAppSessions(accountId, sessionId, now, tx);
      if (sessionId && rows.length === 0) {
        throw new ApiException(404, "NOT_FOUND", "No such active session of the app");
      }
      if (rows.length > 0) {
        await this.audit.record(
          {
            action: auditActions.accountSessionsEnded,
            actor: { role: "admin", accountId: admin.accountId, adminId: admin.adminId },
            entityType: auditEntities.account,
            entityId: accountId,
            after: { ended: rows.length, ...(sessionId ? { one: true } : {}) },
          },
          tx,
        );
      }
      return rows.length;
    });
    this.logger.log(
      `App sessions ended by an administrator account=${accountId} ended=${String(ended)} admin=${admin.adminId}`,
    );
    return ended;
  }

  private async requireAccount(executor: DbExecutor, accountId: string): Promise<void> {
    const [row] = await executor
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, accountId));
    if (!row) {
      throw userNotFound();
    }
  }
}
