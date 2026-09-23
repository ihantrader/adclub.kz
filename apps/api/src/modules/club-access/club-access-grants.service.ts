import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  CLUB_ACCESS_MAX_DAYS,
  CLUB_ACCESS_PAGE_DEFAULT_SIZE,
  type ClubAccessActor,
  type ClubAccessGrant,
  type ClubAccessGrantPage,
  type ClubAccessGrantQuery,
  type ClubAccessGrantResponse,
} from "@adclub/contracts";
import { maskPhone, normalizeKzMobilePhone } from "@adclub/domain";
import { and, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { account, AccountStore } from "../identity";
import { ClubAccess } from "./club-access";
import { clubAccessGrant, type ClubAccessGrantRow } from "./schema";

/** Who gives or ends a grant. */
export type ClubAccessChanger =
  { role: "admin"; adminId: string; accountId: string } | { role: "operator" };

const DAY_MS = 86_400_000;

/**
 * Why a grant ended when a newer one replaced it (TASK-020.A): the history
 * names the replacement, not the reason of the new grant — that one is
 * the new grant's own.
 */
export function replacedReason(newGrantId: string): string {
  return `Заменена новой выдачей ${newGrantId}`;
}

function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

function notGranted(): ApiException {
  return new ApiException(
    409,
    "CLUB_ACCESS_NOT_GRANTED",
    "The account has no current grant of club access to revoke",
  );
}

function phoneOf(input: string): string {
  const phone = normalizeKzMobilePhone(input);
  if (!phone) {
    throw validationError("phone", "Not a Kazakhstan mobile number (+7 7xx xxx xx xx)");
  }
  return phone;
}

function actorOf(role: "admin" | "operator", adminId: string | null): ClubAccessActor {
  return { role, adminId };
}

function auditActor(changer: ClubAccessChanger) {
  return changer.role === "admin"
    ? { role: "admin" as const, adminId: changer.adminId, accountId: changer.accountId }
    : { role: "operator" as const };
}

/**
 * Club access given by hand (D-059; ARCHITECTURE 4.29): an administrator
 * (context `admin`) and the operator command give it to the account of a
 * phone number until a moment, with a reason, and end it early; the
 * journal of actions records both in the same transaction. A new grant
 * ends the account's open one («replaced»). What access an account has is
 * decided only by `ClubAccess`.
 */
@Injectable()
export class ClubAccessGrants {
  private readonly logger = new Logger(ClubAccessGrants.name);

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(ClubAccess) private readonly access: ClubAccess,
  ) {}

  async grant(
    input: { phone: string; validUntil: Date; reason: string },
    changer: ClubAccessChanger,
  ): Promise<ClubAccessGrantResponse> {
    const phone = phoneOf(input.phone);
    const reason = input.reason.trim();
    const now = new Date();
    if (Number.isNaN(input.validUntil.getTime()) || input.validUntil.getTime() <= now.getTime()) {
      throw validationError("validUntil", "Must be in the future");
    }
    if (input.validUntil.getTime() > now.getTime() + CLUB_ACCESS_MAX_DAYS * DAY_MS) {
      throw validationError("validUntil", `Must be at most ${CLUB_ACCESS_MAX_DAYS} days ahead`);
    }
    const adminId = changer.role === "admin" ? changer.adminId : null;
    // Known before the insert: the grant it replaces names it.
    const grantId = randomUUID();
    const result = await this.database.db.transaction(async (tx) => {
      const owner = await this.accounts.findOrCreateByPhone(phone, tx);
      // One change of an account's grants at a time: two grants at once
      // would both find no open grant, and one would fail on the key.
      await tx.execute(sql`SELECT id FROM account WHERE id = ${owner.id} FOR UPDATE`);
      const [previous] = await tx
        .update(clubAccessGrant)
        .set({
          endedAt: now,
          endedHow: "replaced",
          endedByRole: changer.role,
          endedByAdminId: adminId,
          endReason: replacedReason(grantId),
        })
        .where(and(eq(clubAccessGrant.accountId, owner.id), isNull(clubAccessGrant.endedAt)))
        .returning();
      const [row] = await tx
        .insert(clubAccessGrant)
        .values({
          id: grantId,
          accountId: owner.id,
          validUntil: input.validUntil,
          reason,
          grantedByRole: changer.role,
          grantedByAdminId: adminId,
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.clubAccessGranted,
          actor: auditActor(changer),
          entityType: auditEntities.clubAccessGrant,
          entityId: row!.id,
          before: previous
            ? { grantId: previous.id, validUntil: previous.validUntil.toISOString() }
            : undefined,
          after: {
            accountId: owner.id,
            phoneMasked: maskPhone(phone),
            source: "manual",
            validUntil: row!.validUntil.toISOString(),
            accountCreated: owner.created,
          },
          reason,
        },
        tx,
      );
      return { row: row!, accessNow: await this.access.stateOf(owner.id, tx) };
    });
    this.logger.log(
      `Club access granted grant=${result.row.id} account=${result.row.accountId} phone=${maskPhone(phone)} until=${result.row.validUntil.toISOString()} by=${changer.role}`,
    );
    return {
      grant: this.describe(result.row, maskPhone(phone), now),
      access: result.accessNow,
    };
  }

  async revoke(
    input: { phone: string; reason: string },
    changer: ClubAccessChanger,
  ): Promise<ClubAccessGrantResponse> {
    const phone = phoneOf(input.phone);
    const reason = input.reason.trim();
    const now = new Date();
    const adminId = changer.role === "admin" ? changer.adminId : null;
    const result = await this.database.db.transaction(async (tx) => {
      const owner = await this.accounts.findByPhone(phone, tx);
      if (!owner) {
        throw notGranted();
      }
      await tx.execute(sql`SELECT id FROM account WHERE id = ${owner.id} FOR UPDATE`);
      const [row] = await tx
        .update(clubAccessGrant)
        .set({
          endedAt: now,
          endedHow: "revoked",
          endedByRole: changer.role,
          endedByAdminId: adminId,
          endReason: reason,
        })
        .where(
          and(
            eq(clubAccessGrant.accountId, owner.id),
            isNull(clubAccessGrant.endedAt),
            gt(clubAccessGrant.validUntil, now),
          ),
        )
        .returning();
      if (!row) {
        throw notGranted();
      }
      await this.audit.record(
        {
          action: auditActions.clubAccessRevoked,
          actor: auditActor(changer),
          entityType: auditEntities.clubAccessGrant,
          entityId: row.id,
          before: { validUntil: row.validUntil.toISOString() },
          after: { accountId: owner.id, phoneMasked: maskPhone(phone), endedAt: now.toISOString() },
          reason,
        },
        tx,
      );
      return { row, accessNow: await this.access.stateOf(owner.id, tx) };
    });
    this.logger.log(
      `Club access revoked grant=${result.row.id} account=${result.row.accountId} phone=${maskPhone(phone)} by=${changer.role}`,
    );
    return {
      grant: this.describe(result.row, maskPhone(phone), now),
      access: result.accessNow,
    };
  }

  /** The grants and the access of one phone number's account (the operator command). */
  async statusOf(phoneInput: string): Promise<{
    accountId: string | null;
    access: ClubAccessGrantResponse["access"];
    grants: ClubAccessGrant[];
  }> {
    const phone = phoneOf(phoneInput);
    const owner = await this.accounts.findByPhone(phone);
    if (!owner) {
      return { accountId: null, access: await this.access.stateOf(null), grants: [] };
    }
    const page = await this.page({ status: "all", accountId: owner.id, limit: 100 });
    return {
      accountId: owner.id,
      access: await this.access.stateOf(owner.id),
      grants: page.grants,
    };
  }

  async page(query: ClubAccessGrantQuery): Promise<ClubAccessGrantPage> {
    const limit = query.limit ?? CLUB_ACCESS_PAGE_DEFAULT_SIZE;
    const now = new Date();
    const conditions: SQL[] = [];
    if ((query.status ?? "active") === "active") {
      conditions.push(isNull(clubAccessGrant.endedAt), gt(clubAccessGrant.validUntil, now));
    }
    if (query.accountId) {
      conditions.push(eq(clubAccessGrant.accountId, query.accountId));
    }
    if (query.cursor) {
      const after = decodeCursor(query.cursor);
      if (!TIME_POSITION.test(after.position)) {
        throw validationError("cursor", "Use the nextCursor of the previous answer");
      }
      conditions.push(
        sql`(${clubAccessGrant.createdAt}, ${clubAccessGrant.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await this.database.db
      .select({
        grant: clubAccessGrant,
        position: sql<string>`to_char(${clubAccessGrant.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(clubAccessGrant)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(clubAccessGrant.createdAt), desc(clubAccessGrant.id))
      .limit(limit + 1);
    const shown = rows.slice(0, limit);
    const phones = await this.phones(
      this.database.db,
      shown.map((entry) => entry.grant.accountId),
    );
    const last = shown.at(-1);
    return {
      grants: shown.map((entry) =>
        this.describe(entry.grant, phones.get(entry.grant.accountId) ?? "", now),
      ),
      nextCursor: rows.length > limit && last ? encodeCursor(last.position, last.grant.id) : null,
    };
  }

  private async phones(
    executor: DbExecutor,
    accountIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await executor
      .select({ id: account.id, phone: account.phone })
      .from(account)
      .where(inArray(account.id, ids));
    return new Map(rows.map((row) => [row.id, maskPhone(row.phone)]));
  }

  private describe(row: ClubAccessGrantRow, phoneMasked: string, now: Date): ClubAccessGrant {
    const status =
      row.endedHow ?? (row.validUntil.getTime() <= now.getTime() ? "expired" : "active");
    return {
      id: row.id,
      accountId: row.accountId,
      phoneMasked,
      source: row.source,
      status,
      validUntil: row.validUntil.toISOString(),
      reason: row.reason,
      grantedBy: actorOf(row.grantedByRole, row.grantedByAdminId),
      grantedAt: row.createdAt.toISOString(),
      revokedBy: row.endedByRole ? actorOf(row.endedByRole, row.endedByAdminId) : null,
      revokedAt: row.endedAt ? row.endedAt.toISOString() : null,
      revokeReason: row.endReason,
    };
  }
}
