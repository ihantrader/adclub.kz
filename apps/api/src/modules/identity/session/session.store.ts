import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import {
  account,
  adminUser,
  session,
  supplier,
  supplierMember,
  type MembershipStatus,
  type SessionKindValue,
  type SessionRevokedReason,
} from "../schema";

export interface NewSession {
  id: string;
  accountId: string;
  kind: SessionKindValue;
  supplierId: string | null;
  supplierMemberId: string | null;
  refreshSeed: string;
  loginChallengeId: string | null;
  clientPlatform: string | null;
  clientVersion: string | null;
  deviceName: string | null;
  lastIp: string | null;
  now: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date | null;
}

/**
 * What the access check needs, read by primary key on every request —
 * with the current state of what gives the session its rights: the
 * membership of a cabinet session, the administrator record of an admin
 * panel session (`null` when there is none).
 */
export interface SessionAccessRow {
  id: string;
  accountId: string;
  kind: SessionKindValue;
  supplierId: string | null;
  supplierMemberId: string | null;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  membershipStatus: MembershipStatus | null;
  adminUserId: string | null;
  adminStatus: MembershipStatus | null;
  adminTotpConfigured: boolean | null;
}

export interface SessionRefreshRow extends SessionAccessRow {
  refreshSeed: string;
  refreshGeneration: number;
  refreshRotatedAt: Date | null;
  absoluteExpiresAt: Date | null;
}

export interface SessionSummaryRow {
  id: string;
  kind: SessionKindValue;
  supplier: { id: string; name: string; city: string } | null;
  deviceName: string | null;
  clientPlatform: string | null;
  clientVersion: string | null;
  lastIp: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

/** What to do with a session locked for a refresh (decided by the service). */
export type RefreshDecision =
  | { kind: "rotate"; generation: number; expiresAt: Date; lastIp: string | null }
  | { kind: "touch"; lastIp: string | null }
  | { kind: "revoke"; reason: SessionRevokedReason };

/** Which of an account's active sessions to end. */
export type SessionSelection =
  { kind: "one"; sessionId: string } | { kind: "all_except"; sessionId: string } | { kind: "all" };

const accessColumns = {
  id: session.id,
  accountId: session.accountId,
  kind: session.kind,
  supplierId: session.supplierId,
  supplierMemberId: session.supplierMemberId,
  lastUsedAt: session.lastUsedAt,
  expiresAt: session.expiresAt,
  revokedAt: session.revokedAt,
  revokedReason: session.revokedReason,
  membershipStatus: supplierMember.status,
  adminUserId: adminUser.id,
  adminStatus: adminUser.status,
  adminTotpConfigured: sql<
    boolean | null
  >`CASE WHEN ${adminUser.id} IS NULL THEN NULL ELSE ${adminUser.totpSecret} IS NOT NULL END`,
};

const refreshColumns = {
  ...accessColumns,
  refreshSeed: session.refreshSeed,
  refreshGeneration: session.refreshGeneration,
  refreshRotatedAt: session.refreshRotatedAt,
  absoluteExpiresAt: session.absoluteExpiresAt,
};

const summaryColumns = {
  id: session.id,
  kind: session.kind,
  supplier: { id: supplier.id, name: supplier.name, city: supplier.city },
  deviceName: session.deviceName,
  clientPlatform: session.clientPlatform,
  clientVersion: session.clientVersion,
  lastIp: session.lastIp,
  createdAt: session.createdAt,
  lastUsedAt: session.lastUsedAt,
  expiresAt: session.expiresAt,
};

function isActive(now: Date): SQL {
  return and(isNull(session.revokedAt), gt(session.expiresAt, now))!;
}

/** The administrator record behind an admin panel session (no row for other kinds). */
function adminOfSession(): SQL {
  return and(eq(adminUser.accountId, session.accountId), eq(session.kind, "admin_web"))!;
}

/** Persistence of `session` (ARCHITECTURE 5.1, 8.2). */
@Injectable()
export class SessionStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async create(row: NewSession, executor: DbExecutor = this.database.db): Promise<void> {
    await executor.insert(session).values({
      id: row.id,
      accountId: row.accountId,
      kind: row.kind,
      supplierId: row.supplierId,
      supplierMemberId: row.supplierMemberId,
      refreshSeed: row.refreshSeed,
      refreshGeneration: 0,
      loginChallengeId: row.loginChallengeId,
      clientPlatform: row.clientPlatform,
      clientVersion: row.clientVersion,
      deviceName: row.deviceName,
      lastIp: row.lastIp,
      lastUsedAt: row.now,
      expiresAt: row.expiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      createdAt: row.now,
      updatedAt: row.now,
    });
  }

  async findForAccess(sessionId: string): Promise<SessionAccessRow | undefined> {
    const [row] = await this.database.db
      .select(accessColumns)
      .from(session)
      .leftJoin(supplierMember, eq(supplierMember.id, session.supplierMemberId))
      .leftJoin(adminUser, adminOfSession())
      .where(eq(session.id, sessionId));
    return row;
  }

  async findForRefresh(sessionId: string): Promise<SessionRefreshRow | undefined> {
    const [row] = await this.database.db
      .select(refreshColumns)
      .from(session)
      .leftJoin(supplierMember, eq(supplierMember.id, session.supplierMemberId))
      .leftJoin(adminUser, adminOfSession())
      .where(eq(session.id, sessionId));
    return row;
  }

  /**
   * Ends one session because it lost its context (membership removed,
   * administrator removed, second factor reset). No-op if already ended.
   */
  async revokeLost(sessionId: string, reason: SessionRevokedReason, now: Date): Promise<boolean> {
    const rows = await this.database.db
      .update(session)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(and(eq(session.id, sessionId), isNull(session.revokedAt)))
      .returning({ id: session.id });
    return rows.length > 0;
  }

  /** Ends every active admin panel session of an account, in the caller's transaction. */
  async revokeAdminSessions(
    accountId: string,
    reason: SessionRevokedReason,
    now: Date,
    tx: DbExecutor,
  ): Promise<string[]> {
    const rows = await tx
      .update(session)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(session.accountId, accountId),
          eq(session.kind, "admin_web"),
          isNull(session.revokedAt),
        ),
      )
      .returning({ id: session.id });
    return rows.map((row) => row.id);
  }

  /**
   * Ends every unended session bound to a membership (the employee was
   * removed), in the caller's transaction. Cabinet sessions only ever
   * carry a membership; their other sessions are not touched.
   */
  async revokeMemberSessions(
    memberId: string,
    reason: SessionRevokedReason,
    now: Date,
    tx: DbExecutor,
  ): Promise<string[]> {
    const rows = await tx
      .update(session)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(and(eq(session.supplierMemberId, memberId), isNull(session.revokedAt)))
      .returning({ id: session.id });
    return rows.map((row) => row.id);
  }

  /**
   * Moves an active cabinet session of `accountId` to another membership
   * of the same account; `false` if the session is no longer active.
   */
  async switchSupplier(
    input: { sessionId: string; accountId: string; supplierId: string; memberId: string },
    now: Date,
    tx: DbExecutor,
  ): Promise<boolean> {
    const rows = await tx
      .update(session)
      .set({ supplierId: input.supplierId, supplierMemberId: input.memberId, updatedAt: now })
      .where(
        and(
          eq(session.id, input.sessionId),
          eq(session.accountId, input.accountId),
          eq(session.kind, "supplier_web"),
          isActive(now),
        ),
      )
      .returning({ id: session.id });
    return rows.length > 0;
  }

  /**
   * Records use of a session, at most once per `minIntervalMs`, so an
   * active client doesn't turn every request into a write.
   */
  async touch(
    sessionId: string,
    now: Date,
    lastIp: string | null,
    minIntervalMs: number,
  ): Promise<void> {
    await this.database.db
      .update(session)
      .set({ lastUsedAt: now, lastIp, updatedAt: now })
      .where(
        and(
          eq(session.id, sessionId),
          isNull(session.revokedAt),
          lt(session.lastUsedAt, new Date(now.getTime() - minIntervalMs)),
        ),
      );
  }

  /**
   * Locks the session row, lets `decide` look at it and applies the
   * decision in the same transaction: concurrent refreshes of one session
   * are serialized, so a token generation is rotated exactly once.
   */
  async refreshLocked<T>(
    sessionId: string,
    now: Date,
    decide: (row: SessionRefreshRow | undefined) => { decision?: RefreshDecision; result: T },
  ): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select(refreshColumns)
        .from(session)
        .leftJoin(supplierMember, eq(supplierMember.id, session.supplierMemberId))
        .leftJoin(adminUser, adminOfSession())
        .where(eq(session.id, sessionId))
        .for("update", { of: session });
      const { decision, result } = decide(row);
      if (!row || !decision) {
        return result;
      }
      switch (decision.kind) {
        case "rotate":
          await tx
            .update(session)
            .set({
              refreshGeneration: decision.generation,
              refreshRotatedAt: now,
              expiresAt: decision.expiresAt,
              lastUsedAt: now,
              lastIp: decision.lastIp,
              updatedAt: now,
            })
            .where(eq(session.id, sessionId));
          break;
        case "touch":
          await tx
            .update(session)
            .set({ lastUsedAt: now, lastIp: decision.lastIp, updatedAt: now })
            .where(eq(session.id, sessionId));
          break;
        case "revoke":
          await tx
            .update(session)
            .set({ revokedAt: now, revokedReason: decision.reason, updatedAt: now })
            .where(and(eq(session.id, sessionId), isNull(session.revokedAt)));
          break;
      }
      return result;
    });
  }

  async findSummary(sessionId: string): Promise<
    | (SessionSummaryRow & {
        account: { id: string; phone: string; createdAt: Date };
        memberName: string | null;
      })
    | undefined
  > {
    const [row] = await this.database.db
      .select({
        ...summaryColumns,
        account: { id: account.id, phone: account.phone, createdAt: account.createdAt },
        memberName: supplierMember.displayName,
      })
      .from(session)
      .innerJoin(account, eq(account.id, session.accountId))
      .leftJoin(supplier, eq(supplier.id, session.supplierId))
      .leftJoin(supplierMember, eq(supplierMember.id, session.supplierMemberId))
      .where(eq(session.id, sessionId));
    return row;
  }

  /** Active sessions of an account, most recently used first. */
  async listActive(accountId: string, now: Date): Promise<SessionSummaryRow[]> {
    return this.database.db
      .select(summaryColumns)
      .from(session)
      .leftJoin(supplier, eq(supplier.id, session.supplierId))
      .where(and(eq(session.accountId, accountId), isActive(now)))
      .orderBy(desc(session.lastUsedAt), desc(session.createdAt));
  }

  /**
   * Ends the selected active sessions of one account — never another
   * account's — and returns the ids it ended with their kinds.
   */
  async revoke(
    accountId: string,
    selection: SessionSelection,
    reasonFor: (sessionId: string) => SessionRevokedReason,
    now: Date,
  ): Promise<{ id: string; kind: SessionKindValue }[]> {
    const filter =
      selection.kind === "one"
        ? eq(session.id, selection.sessionId)
        : selection.kind === "all_except"
          ? ne(session.id, selection.sessionId)
          : undefined;
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: session.id, kind: session.kind })
        .from(session)
        .where(and(eq(session.accountId, accountId), isActive(now), filter))
        .for("update");
      if (rows.length === 0) {
        return [];
      }
      const reasons = new Map<SessionRevokedReason, string[]>();
      for (const row of rows) {
        const reason = reasonFor(row.id);
        reasons.set(reason, [...(reasons.get(reason) ?? []), row.id]);
      }
      for (const [reason, ids] of reasons) {
        await tx
          .update(session)
          .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
          .where(and(inArray(session.id, ids), isNull(session.revokedAt)));
      }
      return rows;
    });
  }
}
