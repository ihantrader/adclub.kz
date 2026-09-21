import type {
  AdminSupplierMember,
  NotificationLanguage,
  SupplierInvitation,
  SupplierMember,
  SupplierMemberAddedBy,
  SupplierNotificationSummary,
} from "@adclub/contracts";
import { notificationRecipients } from "@adclub/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../../database";
import { account, supplierMember, type MembershipStatus } from "../identity";
import { iso } from "./supplier-common";

/** An employee with what the cabinet and the admin panel show about them. */
export interface MemberRow {
  id: string;
  supplierId: string;
  accountId: string;
  displayName: string;
  phone: string;
  status: MembershipStatus;
  notificationsEnabledAt: Date | null;
  notificationLanguage: NotificationLanguage;
  isContactPerson: boolean;
  addedBy: SupplierMemberAddedBy;
  addedByMember: { id: string; displayName: string } | null;
  addedByAdminId: string | null;
  removedAt: Date | null;
  removedByMember: { id: string; displayName: string } | null;
  restoredAt: Date | null;
  restoredByAdminId: string | null;
  restoreReason: string | null;
  createdAt: Date;
}

const addedBy = alias(supplierMember, "added_by_member");
const removedBy = alias(supplierMember, "removed_by_member");

/**
 * The employees of one company: active first, then removed, each by the
 * time they were added. `activeOnly` — the cabinet's list; `memberId` —
 * one employee.
 */
export async function memberRows(
  executor: DbExecutor,
  supplierId: string,
  options: { activeOnly?: boolean; memberId?: string } = {},
): Promise<MemberRow[]> {
  const rows = await executor
    .select({
      id: supplierMember.id,
      supplierId: supplierMember.supplierId,
      accountId: supplierMember.accountId,
      displayName: supplierMember.displayName,
      phone: account.phone,
      status: supplierMember.status,
      notificationsEnabledAt: supplierMember.notificationsEnabledAt,
      notificationLanguage: supplierMember.notificationLanguage,
      isContactPerson: supplierMember.isContactPerson,
      addedBy: supplierMember.addedBy,
      addedByMemberId: addedBy.id,
      addedByMemberName: addedBy.displayName,
      addedByAdminId: supplierMember.addedByAdminId,
      removedAt: supplierMember.removedAt,
      removedByMemberId: removedBy.id,
      removedByMemberName: removedBy.displayName,
      restoredAt: supplierMember.restoredAt,
      restoredByAdminId: supplierMember.restoredByAdminId,
      restoreReason: supplierMember.restoreReason,
      createdAt: supplierMember.createdAt,
    })
    .from(supplierMember)
    .innerJoin(account, eq(account.id, supplierMember.accountId))
    .leftJoin(addedBy, eq(addedBy.id, supplierMember.addedByMemberId))
    .leftJoin(removedBy, eq(removedBy.id, supplierMember.removedByMemberId))
    .where(
      and(
        eq(supplierMember.supplierId, supplierId),
        options.activeOnly ? eq(supplierMember.status, "active") : undefined,
        options.memberId ? eq(supplierMember.id, options.memberId) : undefined,
      ),
    )
    .orderBy(
      sql`${supplierMember.status} = 'active' DESC`,
      asc(supplierMember.createdAt),
      asc(supplierMember.id),
    );
  return rows.map(
    ({ addedByMemberId, addedByMemberName, removedByMemberId, removedByMemberName, ...row }) => ({
      ...row,
      addedByMember:
        addedByMemberId && addedByMemberName
          ? { id: addedByMemberId, displayName: addedByMemberName }
          : null,
      removedByMember:
        removedByMemberId && removedByMemberName
          ? { id: removedByMemberId, displayName: removedByMemberName }
          : null,
    }),
  );
}

/** Who of the active employees receives notifications, and the summary the screens show. */
export interface NotificationState {
  recipients: ReadonlySet<string>;
  summary: SupplierNotificationSummary;
}

export function notificationState(rows: readonly MemberRow[], limit: number): NotificationState {
  const decided = notificationRecipients(
    rows.filter((row) => row.status === "active"),
    limit,
  );
  return {
    recipients: decided.recipients,
    summary: {
      limit,
      enabled: decided.enabled,
      recipients: decided.recipients.size,
      full: decided.full,
    },
  };
}

function notificationFields(row: MemberRow, state: NotificationState) {
  return {
    notificationsEnabled: row.notificationsEnabledAt !== null,
    receivesNotifications: state.recipients.has(row.id),
    notificationLanguage: row.notificationLanguage,
    isContactPerson: row.isContactPerson,
  };
}

export function cabinetMember(
  row: MemberRow,
  state: NotificationState,
  meMemberId: string,
): SupplierMember {
  return {
    id: row.id,
    displayName: row.displayName,
    phone: row.phone,
    ...notificationFields(row, state),
    isMe: row.id === meMemberId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function adminMember(
  row: MemberRow,
  state: NotificationState,
  lastInvitation: SupplierInvitation | null,
): AdminSupplierMember {
  return {
    id: row.id,
    displayName: row.displayName,
    phone: row.phone,
    status: row.status,
    lastInvitation,
    createdAt: row.createdAt.toISOString(),
    ...notificationFields(row, state),
    addedBy: row.addedBy,
    addedByMember: row.addedByMember,
    addedByAdminId: row.addedByAdminId,
    removedAt: iso(row.removedAt),
    removedByMember: row.removedByMember,
    restore:
      row.restoredAt && row.restoreReason
        ? {
            at: row.restoredAt.toISOString(),
            adminId: row.restoredByAdminId,
            reason: row.restoreReason,
          }
        : null,
  };
}
