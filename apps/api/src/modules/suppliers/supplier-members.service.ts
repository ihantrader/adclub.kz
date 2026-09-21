import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AddSupplierMemberBody,
  type AdminSupplierMember,
  type AdminSupplierMemberAddedResponse,
  type AdminSupplierMemberListResponse,
  type AdminSupplierMemberResponse,
  type AdminSupplierSession,
  type SupplierInvitation,
  type SupplierMemberAddedResponse,
  type SupplierMemberListResponse,
  type SupplierMemberRemovedResponse,
  type SupplierMemberResponse,
  type UpdateSupplierMemberBody,
} from "@adclub/contracts";
import { canEnableNotifications, maskPhone } from "@adclub/domain";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { rateLimitedException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { normalizeText } from "../catalog";
import {
  AccountStore,
  AdminUserStore,
  ipHint,
  SessionStore,
  supplier,
  supplierMember,
  SupplierMemberRemover,
  SupplierMembershipStore,
} from "../identity";
import { AppSettings } from "../settings";
import {
  companyMembersLock,
  kzPhone,
  lastMember,
  memberExists,
  memberState,
  notFound,
  notificationLimit,
  type SupplierAdminActor,
  type SupplierSelfActor,
} from "./supplier-common";
import { describeInvitation, SupplierInvitations } from "./supplier-invitations";
import {
  adminMember,
  cabinetMember,
  memberRows,
  notificationState,
  type MemberRow,
  type NotificationState,
} from "./supplier-member-rows";

const DAY_MS = 24 * 3600_000;

/**
 * Employees of a supplier (TASK-017; PRODUCT 12.6; SCREENS S-TEAM-01,
 * S-TEAM-02, A-SUP-03; ARCHITECTURE 8.3, 4.27). Every change of a
 * company's employees takes the company's transaction lock
 * (`companyMembersLock`) first, so the company never loses its last
 * employee and no more than `max_notified_members` have notifications on,
 * whatever runs at once. The company of a cabinet always comes from the
 * session: an employee of another company answers like a missing one.
 * Every action is in the action journal in its own transaction, with the
 * employee (or the administrator) as the actor; numbers reach the
 * application log only masked.
 */
@Injectable()
export class SupplierMembersService {
  private readonly logger = new Logger("SupplierMember");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(AdminUserStore) private readonly admins: AdminUserStore,
    @Inject(SupplierMembershipStore) private readonly memberships: SupplierMembershipStore,
    @Inject(SupplierMemberRemover) private readonly remover: SupplierMemberRemover,
    @Inject(SessionStore) private readonly sessions: SessionStore,
    @Inject(SupplierInvitations) private readonly invitations: SupplierInvitations,
  ) {}

  // ---------------------------------------------------------------- cabinet

  async list(actor: SupplierSelfActor): Promise<SupplierMemberListResponse> {
    const { rows, state } = await this.state(this.database.db, actor.supplierId, true);
    return {
      members: rows.map((row) => cabinetMember(row, state, actor.memberId)),
      notifications: state.summary,
    };
  }

  /** A colleague of the session's company (or the session's own employee). */
  async one(actor: SupplierSelfActor, memberId: string): Promise<SupplierMemberResponse> {
    const { rows, state } = await this.state(this.database.db, actor.supplierId, true);
    const row = rows.find((candidate) => candidate.id === memberId);
    if (!row) {
      throw notFound("employee");
    }
    return { member: cabinetMember(row, state, actor.memberId), notifications: state.summary };
  }

  /**
   * «Добавить» (S-TEAM-01): by name and number, limited per company
   * (`supplier_members_added_per_supplier_day`). A number already in the
   * company — refused, a removed one too (only an administrator restores
   * it). The supplier never learns whether the number works for another
   * company or is an administrator.
   */
  async addByMember(
    actor: SupplierSelfActor,
    input: AddSupplierMemberBody,
  ): Promise<SupplierMemberAddedResponse> {
    const phone = kzPhone("phone", input.phone);
    const name = normalizeText(input.name);
    const perDay = await this.settings.get("supplier_members_added_per_supplier_day");
    const { memberId, invitation } = await this.database.db.transaction(async (tx) => {
      await tx.execute(companyMembersLock(actor.supplierId));
      const dayAgo = new Date(Date.now() - DAY_MS);
      const recent = await tx
        .select({ createdAt: supplierMember.createdAt })
        .from(supplierMember)
        .where(
          and(
            eq(supplierMember.supplierId, actor.supplierId),
            eq(supplierMember.addedBy, "member"),
            gte(supplierMember.createdAt, dayAgo),
          ),
        )
        .orderBy(asc(supplierMember.createdAt));
      if (recent.length >= perDay) {
        this.logger.warn(`Employee not added: daily limit supplier=${actor.supplierId}`);
        throw rateLimitedException(
          "supplier_members_added_per_supplier",
          (recent[0]!.createdAt.getTime() + DAY_MS - Date.now()) / 1000,
        );
      }
      return this.insert(tx, actor.supplierId, { name, phone }, actor);
    });
    const { rows, state } = await this.state(this.database.db, actor.supplierId, true);
    const row = rows.find((candidate) => candidate.id === memberId)!;
    return {
      member: cabinetMember(row, state, actor.memberId),
      notifications: state.summary,
      invitation,
    };
  }

  /**
   * The name, the notification switch and its language — of a colleague
   * or of oneself (all employees are equal, PRODUCT 12.6). Turning the
   * switch on is refused when `max_notified_members` already have it on.
   */
  async update(
    actor: SupplierSelfActor,
    memberId: string,
    input: UpdateSupplierMemberBody,
  ): Promise<SupplierMemberResponse> {
    const limit = await this.settings.get("max_notified_members");
    await this.database.db.transaction(async (tx) => {
      await tx.execute(companyMembersLock(actor.supplierId));
      const rows = await memberRows(tx, actor.supplierId, { activeOnly: true });
      const row = rows.find((candidate) => candidate.id === memberId);
      if (!row) {
        throw notFound("employee");
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const next: Partial<typeof supplierMember.$inferInsert> = {};
      if (input.displayName !== undefined) {
        const name = normalizeText(input.displayName);
        if (name !== row.displayName) {
          next.displayName = name;
          before.displayName = row.displayName;
          after.displayName = name;
        }
      }
      if (
        input.notificationsEnabled !== undefined &&
        input.notificationsEnabled !== (row.notificationsEnabledAt !== null)
      ) {
        if (input.notificationsEnabled) {
          const enabled = rows.filter((other) => other.notificationsEnabledAt !== null).length;
          if (!canEnableNotifications(enabled, limit)) {
            this.logger.warn(
              `Notifications not turned on: the limit is reached supplier=${actor.supplierId} member=${memberId} limit=${limit}`,
            );
            throw notificationLimit({ limit, enabled });
          }
        }
        next.notificationsEnabledAt = input.notificationsEnabled ? new Date() : null;
        before.notificationsEnabled = !input.notificationsEnabled;
        after.notificationsEnabled = input.notificationsEnabled;
      }
      if (
        input.notificationLanguage !== undefined &&
        input.notificationLanguage !== row.notificationLanguage
      ) {
        next.notificationLanguage = input.notificationLanguage;
        before.notificationLanguage = row.notificationLanguage;
        after.notificationLanguage = input.notificationLanguage;
      }
      if (Object.keys(next).length === 0) {
        return;
      }
      await tx
        .update(supplierMember)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(supplierMember.id, memberId));
      await this.audit.record(
        {
          action: auditActions.supplierMemberChanged,
          actor,
          entityType: auditEntities.supplierMember,
          entityId: memberId,
          before: { supplierId: actor.supplierId, ...before },
          after: { ...after, self: memberId === actor.memberId },
        },
        tx,
      );
    });
    return this.one(actor, memberId);
  }

  /**
   * «Удалить» (S-TEAM-01): the employee and every cabinet session of
   * theirs in this company end in one transaction (I81); their queued
   * invitations are cancelled. The last active employee can't be removed —
   * two employees removing each other at once leave exactly one. Removing
   * oneself is allowed while others remain; the caller's session ends
   * with it.
   */
  async remove(actor: SupplierSelfActor, memberId: string): Promise<SupplierMemberRemovedResponse> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      await tx.execute(companyMembersLock(actor.supplierId));
      const [target] = await tx
        .select({ id: supplierMember.id })
        .from(supplierMember)
        .where(
          and(
            eq(supplierMember.id, memberId),
            eq(supplierMember.supplierId, actor.supplierId),
            eq(supplierMember.status, "active"),
          ),
        );
      if (!target) {
        throw notFound("employee");
      }
      const [counted] = await tx
        .select({ active: sql<number>`count(*)::int` })
        .from(supplierMember)
        .where(
          and(eq(supplierMember.supplierId, actor.supplierId), eq(supplierMember.status, "active")),
        );
      if ((counted?.active ?? 0) <= 1) {
        this.logger.warn(
          `Employee not removed: the last one supplier=${actor.supplierId} member=${memberId}`,
        );
        throw lastMember();
      }
      // The caller removing themselves is recorded as removed by nobody
      // else: `removed_by_member_id` is the caller either way.
      const removed = await this.remover.remove(memberId, actor.memberId, now, tx);
      if (!removed) {
        throw notFound("employee");
      }
      const invitationsCancelled = await this.invitations.cancelQueued(tx, memberId, now);
      await this.audit.record(
        {
          action: auditActions.supplierMemberRemoved,
          actor,
          entityType: auditEntities.supplierMember,
          entityId: memberId,
          before: {
            supplierId: removed.supplierId,
            accountId: removed.accountId,
            status: "active",
          },
          after: {
            status: "removed",
            sessionsEnded: removed.endedSessionIds.length,
            invitationsCancelled,
            self: memberId === actor.memberId,
          },
        },
        tx,
      );
      return removed;
    });
    this.remover.logEnded(result);
    this.logger.log(
      `Employee removed supplier=${actor.supplierId} member=${memberId} by=${actor.memberId} sessionsEnded=${result.endedSessionIds.length}`,
    );
    return {
      memberId,
      sessionsEnded: result.endedSessionIds.length,
      self: memberId === actor.memberId,
    };
  }

  // ------------------------------------------------------------------ admin

  async adminList(supplierId: string): Promise<AdminSupplierMemberListResponse> {
    await this.requireSupplier(this.database.db, supplierId);
    return this.adminView(this.database.db, supplierId);
  }

  /** The members of the admin card (`GET /admin/suppliers/{id}`). */
  async adminView(
    executor: DbExecutor,
    supplierId: string,
  ): Promise<{
    members: AdminSupplierMember[];
    notifications: AdminSupplierMemberListResponse["notifications"];
  }> {
    const { rows, state } = await this.state(executor, supplierId, false);
    const latest = await this.invitations.latestOf(
      executor,
      rows.map((row) => row.id),
    );
    return {
      members: rows.map((row) => {
        const invitation = latest.get(row.id);
        return adminMember(row, state, invitation ? describeInvitation(invitation) : null);
      }),
      notifications: state.summary,
    };
  }

  async addByAdmin(
    supplierId: string,
    input: AddSupplierMemberBody,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierMemberAddedResponse> {
    const phone = kzPhone("phone", input.phone);
    const name = normalizeText(input.name);
    const added = await this.database.db.transaction(async (tx) => {
      await this.requireSupplier(tx, supplierId);
      await tx.execute(companyMembersLock(supplierId));
      return this.insert(tx, supplierId, { name, phone }, actor);
    });
    const member = await this.adminOne(supplierId, added.memberId);
    return {
      ...member,
      invitation: added.invitation,
      accountCreated: added.accountCreated,
      memberOfOtherSuppliers: added.memberOfOtherSuppliers,
      isAdministrator: added.isAdministrator,
    };
  }

  /**
   * «Восстановить доступ» (A-SUP-03): the membership is active again, with
   * the reason; the sessions the removal ended stay ended — the employee
   * signs in anew. Notifications come back on if there is room.
   */
  async restore(
    supplierId: string,
    memberId: string,
    reason: string,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierMemberResponse> {
    const limit = await this.settings.get("max_notified_members");
    const note = normalizeText(reason);
    await this.database.db.transaction(async (tx) => {
      await this.requireSupplier(tx, supplierId);
      await tx.execute(companyMembersLock(supplierId));
      const rows = await memberRows(tx, supplierId);
      const row = rows.find((candidate) => candidate.id === memberId);
      if (!row) {
        throw notFound("employee");
      }
      if (row.status !== "removed") {
        throw memberState("not_removed");
      }
      const enabled = rows.filter((other) => other.notificationsEnabledAt !== null).length;
      const notificationsOn = canEnableNotifications(enabled, limit);
      const now = new Date();
      await tx
        .update(supplierMember)
        .set({
          status: "active",
          removedAt: null,
          // Who removed stays in the action journal; the row describes the current state.
          removedByMemberId: null,
          restoredAt: now,
          restoredByAdminId: actor.role === "admin" ? actor.adminId : null,
          restoreReason: note,
          notificationsEnabledAt: notificationsOn ? now : null,
          updatedAt: now,
        })
        .where(eq(supplierMember.id, memberId));
      await this.audit.record(
        {
          action: auditActions.supplierMemberRestored,
          actor,
          entityType: auditEntities.supplierMember,
          entityId: memberId,
          before: {
            supplierId,
            status: "removed",
            removedAt: row.removedAt?.toISOString() ?? null,
            removedByMemberId: row.removedByMember?.id ?? null,
          },
          after: { status: "active", notificationsEnabled: notificationsOn },
          reason: note,
        },
        tx,
      );
    });
    this.logger.log(`Employee restored supplier=${supplierId} member=${memberId}`);
    return this.adminOne(supplierId, memberId);
  }

  /** «Назначить контактным лицом» — one per company; the previous one stops being it. */
  async setContactPerson(
    supplierId: string,
    memberId: string,
    actor: SupplierAdminActor,
  ): Promise<AdminSupplierMemberResponse> {
    await this.database.db.transaction(async (tx) => {
      await this.requireSupplier(tx, supplierId);
      await tx.execute(companyMembersLock(supplierId));
      const rows = await memberRows(tx, supplierId);
      const row = rows.find((candidate) => candidate.id === memberId);
      if (!row) {
        throw notFound("employee");
      }
      if (row.status !== "active") {
        throw memberState("removed");
      }
      if (row.isContactPerson) {
        return;
      }
      const previous = rows.find((candidate) => candidate.isContactPerson);
      const now = new Date();
      await tx
        .update(supplierMember)
        .set({ isContactPerson: false, updatedAt: now })
        .where(
          and(eq(supplierMember.supplierId, supplierId), eq(supplierMember.isContactPerson, true)),
        );
      await tx
        .update(supplierMember)
        .set({ isContactPerson: true, updatedAt: now })
        .where(eq(supplierMember.id, memberId));
      await this.audit.record(
        {
          action: auditActions.supplierContactPersonChanged,
          actor,
          entityType: auditEntities.supplierMember,
          entityId: memberId,
          before: { supplierId, contactPersonMemberId: previous?.id ?? null },
          after: { contactPersonMemberId: memberId },
        },
        tx,
      );
    });
    return this.adminOne(supplierId, memberId);
  }

  async listSessions(supplierId: string): Promise<AdminSupplierSession[]> {
    await this.requireSupplier(this.database.db, supplierId);
    const rows = await this.sessions.listSupplierSessions(supplierId, new Date());
    return rows.map((row) => ({
      id: row.id,
      member: row.member,
      deviceName: row.deviceName,
      platform: row.clientPlatform,
      clientVersion: row.clientVersion,
      ipHint: ipHint(row.lastIp),
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
  }

  /**
   * Ends cabinet sessions of the supplier's employees: one (another
   * company's session answers like a missing one — 404), those of one
   * employee, or all. The employees keep their membership and sign in
   * again.
   */
  async endSessions(
    supplierId: string,
    selection: { sessionId?: string; memberId?: string },
    actor: SupplierAdminActor,
  ): Promise<number> {
    const now = new Date();
    const ended = await this.database.db.transaction(async (tx) => {
      await this.requireSupplier(tx, supplierId);
      if (selection.memberId) {
        const [member] = await tx
          .select({ id: supplierMember.id })
          .from(supplierMember)
          .where(
            and(
              eq(supplierMember.id, selection.memberId),
              eq(supplierMember.supplierId, supplierId),
            ),
          );
        if (!member) {
          throw notFound("employee");
        }
      }
      const rows = await this.sessions.revokeSupplierSessions(
        supplierId,
        selection,
        "ended_by_admin",
        now,
        tx,
      );
      if (selection.sessionId && rows.length === 0) {
        throw notFound("session");
      }
      const byMember = new Map<string, string[]>();
      for (const row of rows) {
        const key = row.memberId ?? "unknown";
        byMember.set(key, [...(byMember.get(key) ?? []), row.id]);
      }
      for (const [memberId, sessionIds] of byMember) {
        await this.audit.record(
          {
            action: auditActions.supplierMemberSessionsEnded,
            actor,
            entityType: auditEntities.supplierMember,
            entityId: memberId,
            after: { supplierId, sessionIds },
          },
          tx,
        );
      }
      return rows;
    });
    for (const row of ended) {
      this.logger.log(
        `Session ended session=${row.id} account=${row.accountId} reason=ended_by_admin`,
      );
    }
    return ended.length;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Adds an employee in the caller's transaction, which holds the
   * company's lock: the account is created if there is none, the
   * notification switch is on while below the limit, the invitation goes
   * on the queue.
   */
  private async insert(
    tx: DbExecutor,
    supplierId: string,
    input: { name: string; phone: string },
    actor: SupplierSelfActor | SupplierAdminActor,
  ): Promise<{
    memberId: string;
    invitation: SupplierInvitation;
    accountCreated: boolean;
    memberOfOtherSuppliers: number;
    isAdministrator: boolean;
  }> {
    const found = await this.accounts.findOrCreateByPhone(input.phone, tx);
    const [existing] = await tx
      .select({ id: supplierMember.id, status: supplierMember.status })
      .from(supplierMember)
      .where(
        and(eq(supplierMember.accountId, found.id), eq(supplierMember.supplierId, supplierId)),
      );
    if (existing) {
      this.logger.warn(
        `Employee not added: the number already has a membership (${existing.status}) supplier=${supplierId} member=${existing.id}`,
      );
      throw memberExists({ memberId: existing.id, status: existing.status });
    }
    const limit = await this.settings.get("max_notified_members");
    const [enabled] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(supplierMember)
      .where(
        and(
          eq(supplierMember.supplierId, supplierId),
          eq(supplierMember.status, "active"),
          sql`${supplierMember.notificationsEnabledAt} IS NOT NULL`,
        ),
      );
    const others = await this.memberships.listActive(found.id, tx);
    const admin = await this.admins.findActiveByAccount(found.id, tx);
    const now = new Date();
    const [row] = await tx
      .insert(supplierMember)
      .values({
        supplierId,
        accountId: found.id,
        displayName: input.name,
        addedBy: actor.role === "supplier" ? "member" : actor.role,
        addedByMemberId: actor.role === "supplier" ? actor.memberId : null,
        addedByAdminId: actor.role === "admin" ? actor.adminId : null,
        notificationsEnabledAt: canEnableNotifications(enabled?.count ?? 0, limit) ? now : null,
      })
      .returning({ id: supplierMember.id });
    const memberId = row!.id;
    await this.audit.record(
      {
        action: auditActions.supplierMemberAdded,
        actor,
        entityType: auditEntities.supplierMember,
        entityId: memberId,
        after: {
          supplierId,
          accountId: found.id,
          phoneMasked: maskPhone(input.phone),
          restored: false,
        },
      },
      tx,
    );
    const invitation = await this.invitations.enqueue(tx, {
      supplierId,
      memberId,
      actor,
      again: false,
    });
    if (found.created) {
      this.logger.log(`Account created account=${found.id} by=supplier_member_added`);
    }
    this.logger.log(
      `Employee added supplier=${supplierId} member=${memberId} phone=${maskPhone(input.phone)} by=${actor.role}`,
    );
    return {
      memberId,
      invitation: describeInvitation(invitation),
      accountCreated: found.created,
      memberOfOtherSuppliers: others.length,
      isAdministrator: admin !== undefined,
    };
  }

  private async adminOne(
    supplierId: string,
    memberId: string,
  ): Promise<AdminSupplierMemberResponse> {
    const view = await this.adminView(this.database.db, supplierId);
    const member = view.members.find((candidate) => candidate.id === memberId);
    if (!member) {
      throw notFound("employee");
    }
    return { member, notifications: view.notifications };
  }

  private async state(
    executor: DbExecutor,
    supplierId: string,
    activeOnly: boolean,
  ): Promise<{ rows: MemberRow[]; state: NotificationState }> {
    const [rows, limit] = await Promise.all([
      memberRows(executor, supplierId, { activeOnly }),
      this.settings.get("max_notified_members"),
    ]);
    return { rows, state: notificationState(rows, limit) };
  }

  private async requireSupplier(executor: DbExecutor, supplierId: string): Promise<void> {
    const [row] = await executor
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!row) {
      throw notFound("supplier");
    }
  }
}
