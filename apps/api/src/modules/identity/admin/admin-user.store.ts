import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { account, adminBackupCode, adminUser, type MembershipStatus } from "../schema";

/** An administrator row, read under a lock before any second factor decision. */
export interface LockedAdmin {
  id: string;
  accountId: string;
  status: MembershipStatus;
  /** Encrypted (`sealSecret`, context = admin id); `null` until set up. */
  totpSecret: string | null;
  totpLastUsedStep: number | null;
}

export interface AdminSummaryRow {
  id: string;
  phone: string;
  totpConfigured: boolean;
  createdAt: Date;
}

/**
 * Administrators and their second factor (ARCHITECTURE 5.1, 8.1). Every
 * change that decides about the second factor runs in the caller's
 * transaction after `lock`, so concurrent sign-ins of one administrator
 * are serialized.
 */
@Injectable()
export class AdminUserStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findActiveByAccount(
    accountId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<{ id: string; totpConfigured: boolean } | undefined> {
    const [row] = await executor
      .select({ id: adminUser.id, totpSecret: adminUser.totpSecret })
      .from(adminUser)
      .where(and(eq(adminUser.accountId, accountId), eq(adminUser.status, "active")));
    return row && { id: row.id, totpConfigured: row.totpSecret !== null };
  }

  async lock(adminId: string, tx: DbExecutor): Promise<LockedAdmin | undefined> {
    const [row] = await tx
      .select({
        id: adminUser.id,
        accountId: adminUser.accountId,
        status: adminUser.status,
        totpSecret: adminUser.totpSecret,
        totpLastUsedStep: adminUser.totpLastUsedStep,
      })
      .from(adminUser)
      .where(eq(adminUser.id, adminId))
      .for("update");
    return row;
  }

  async lockByAccount(accountId: string, tx: DbExecutor): Promise<LockedAdmin | undefined> {
    const [row] = await tx
      .select({ id: adminUser.id })
      .from(adminUser)
      .where(eq(adminUser.accountId, accountId));
    return row ? this.lock(row.id, tx) : undefined;
  }

  /** Appoints the account: a new row, or a removed administrator made active again. */
  async grant(
    accountId: string,
    tx: DbExecutor,
  ): Promise<{ id: string; outcome: "created" | "restored" | "already_active" }> {
    const existing = await this.lockByAccount(accountId, tx);
    const now = new Date();
    if (!existing) {
      const [row] = await tx
        .insert(adminUser)
        .values({ accountId })
        .returning({ id: adminUser.id });
      return { id: row!.id, outcome: "created" };
    }
    if (existing.status === "active") {
      return { id: existing.id, outcome: "already_active" };
    }
    await tx
      .update(adminUser)
      .set({ status: "active", removedAt: null, updatedAt: now })
      .where(eq(adminUser.id, existing.id));
    return { id: existing.id, outcome: "restored" };
  }

  /** Removes the administrator; the second factor goes with it. */
  async markRemoved(adminId: string, now: Date, tx: DbExecutor): Promise<void> {
    await tx
      .update(adminUser)
      .set({
        status: "removed",
        removedAt: now,
        totpSecret: null,
        totpConfirmedAt: null,
        totpLastUsedStep: null,
        updatedAt: now,
      })
      .where(eq(adminUser.id, adminId));
    await this.revokeBackupCodes(adminId, now, tx);
  }

  /** Forgets the second factor and every backup code: setup is due at the next sign-in. */
  async clearTotp(adminId: string, now: Date, tx: DbExecutor): Promise<void> {
    await tx
      .update(adminUser)
      .set({ totpSecret: null, totpConfirmedAt: null, totpLastUsedStep: null, updatedAt: now })
      .where(eq(adminUser.id, adminId));
    await this.revokeBackupCodes(adminId, now, tx);
  }

  async setTotp(
    adminId: string,
    sealedSecret: string,
    usedStep: number,
    now: Date,
    tx: DbExecutor,
  ): Promise<void> {
    await tx
      .update(adminUser)
      .set({
        totpSecret: sealedSecret,
        totpConfirmedAt: now,
        totpLastUsedStep: usedStep,
        updatedAt: now,
      })
      .where(eq(adminUser.id, adminId));
  }

  async recordTotpStep(adminId: string, step: number, now: Date, tx: DbExecutor): Promise<void> {
    await tx
      .update(adminUser)
      .set({ totpLastUsedStep: step, updatedAt: now })
      .where(eq(adminUser.id, adminId));
  }

  /** The new set replaces the current one. */
  async replaceBackupCodes(
    adminId: string,
    codeHashes: string[],
    now: Date,
    tx: DbExecutor,
  ): Promise<void> {
    await this.revokeBackupCodes(adminId, now, tx);
    await tx.insert(adminBackupCode).values(
      codeHashes.map((codeHash) => ({
        adminUserId: adminId,
        codeHash,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  /** Spends a current, unused backup code; `false` if there is no such code. */
  async useBackupCode(
    adminId: string,
    codeHash: string,
    now: Date,
    tx: DbExecutor,
  ): Promise<boolean> {
    const rows = await tx
      .update(adminBackupCode)
      .set({ usedAt: now, updatedAt: now })
      .where(
        and(
          eq(adminBackupCode.adminUserId, adminId),
          eq(adminBackupCode.codeHash, codeHash),
          isNull(adminBackupCode.usedAt),
          isNull(adminBackupCode.revokedAt),
        ),
      )
      .returning({ id: adminBackupCode.id });
    return rows.length > 0;
  }

  async countUnusedBackupCodes(adminId: string, tx: DbExecutor): Promise<number> {
    const [row] = await tx
      .select({ value: count() })
      .from(adminBackupCode)
      .where(
        and(
          eq(adminBackupCode.adminUserId, adminId),
          isNull(adminBackupCode.usedAt),
          isNull(adminBackupCode.revokedAt),
        ),
      );
    return row?.value ?? 0;
  }

  async listActive(): Promise<AdminSummaryRow[]> {
    return this.database.db
      .select({
        id: adminUser.id,
        phone: account.phone,
        totpConfigured: sql<boolean>`${adminUser.totpSecret} IS NOT NULL`,
        createdAt: adminUser.createdAt,
      })
      .from(adminUser)
      .innerJoin(account, eq(account.id, adminUser.accountId))
      .where(eq(adminUser.status, "active"))
      .orderBy(asc(adminUser.createdAt), asc(adminUser.id));
  }

  async countActive(tx: DbExecutor): Promise<number> {
    const [row] = await tx
      .select({ value: count() })
      .from(adminUser)
      .where(eq(adminUser.status, "active"));
    return row?.value ?? 0;
  }

  private async revokeBackupCodes(adminId: string, now: Date, tx: DbExecutor): Promise<void> {
    await tx
      .update(adminBackupCode)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(adminBackupCode.adminUserId, adminId), isNull(adminBackupCode.revokedAt)));
  }
}
