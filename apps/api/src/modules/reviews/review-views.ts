import type {
  AdminComplaint,
  AdminReview,
  PublicReview,
  ReviewAdminActor,
  UserOrderComplaint,
  UserOrderReview,
} from "@adclub/contracts";
import {
  complaintUserStatus,
  hidePhone,
  localDateTime,
  reviewAuthorActions,
  reviewAuthorName,
  reviewUserStatus,
} from "@adclub/domain";
import { eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { account, adminUser, supplier } from "../identity";
import { customerOrder } from "../orders";
import type { ComplaintRow, ReviewRow } from "./schema";

/**
 * What each side sees of a review and of a complaint (TASK-049;
 * ARCHITECTURE 4.69) — the one place of these rules, as `order-views` is for
 * an order:
 *
 * - **the author** — their own review: the score, the text, «на проверке»
 *   while the check or the administrator decides (never the reason of a
 *   hold), «опубликован» once published **and after a hide** (a hide is not
 *   told), the reason of a refused text and what they may do about it; their
 *   own complaint: «на рассмотрении» / «рассмотрена», never the comment;
 * - **a viewer of the supplier's page** — published reviews only: the score,
 *   the text, the month and «Имя Ф.»; never the phone, the account or the
 *   order;
 * - **the administrator** — everything: the reasons of a hold with their
 *   source, the decisions and who made them, the author with the number
 *   partly hidden;
 * - **the supplier** — nothing of complaints, nothing of who wrote a review
 *   beyond the public page.
 *
 * Each variant is built field by field — nothing spreads a row into an answer.
 */

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

// ------------------------------------------------------------------ author

export function userReviewView(row: ReviewRow): UserOrderReview {
  const actions = reviewAuthorActions(row.status, { edited: row.edited });
  const status = reviewUserStatus(row.status);
  return {
    id: row.id,
    score: row.score,
    text: row.text,
    status,
    rejection:
      status === "text_rejected" && row.rejectedReason ? { reason: row.rejectedReason } : null,
    canEditText: actions.canEditText,
    canPublishScoreOnly: actions.canPublishScoreOnly,
    createdAt: row.createdAt.toISOString(),
  };
}

export function userComplaintView(row: ComplaintRow): UserOrderComplaint {
  return {
    id: row.id,
    reason: row.reason,
    status: complaintUserStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
  };
}

// ------------------------------------------------------------------ public

/** One published review on the supplier's page (M-CAT-09). */
export function publicReviewView(
  row: Pick<ReviewRow, "id" | "score" | "text" | "publishedAt">,
  authorName: string | null,
  timeZone: string,
): PublicReview {
  const published = row.publishedAt ?? new Date();
  return {
    id: row.id,
    score: row.score,
    text: row.text,
    publishedMonth: localDateTime(published, timeZone).date.slice(0, 7),
    author: reviewAuthorName(authorName),
  };
}

// ------------------------------------------------------------------- admin

interface People {
  orders: Map<string, { number: number; kind: string; status: string; isTest: boolean }>;
  suppliers: Map<string, string>;
  accounts: Map<string, { name: string | null; phone: string }>;
  admins: Map<string, string | null>;
}

async function peopleOf(
  executor: DbExecutor,
  ids: {
    orderIds: string[];
    supplierIds: string[];
    accountIds: string[];
    adminIds: (string | null)[];
  },
): Promise<People> {
  const unique = (list: readonly (string | null)[]) => [
    ...new Set(list.filter((id): id is string => id !== null)),
  ];
  const orderIds = unique(ids.orderIds);
  const supplierIds = unique(ids.supplierIds);
  const accountIds = unique(ids.accountIds);
  const adminIds = unique(ids.adminIds);
  const [orders, suppliers, accounts, admins] = await Promise.all([
    orderIds.length > 0
      ? executor
          .select({
            id: customerOrder.id,
            number: customerOrder.number,
            kind: customerOrder.kind,
            status: customerOrder.status,
            isTest: customerOrder.isTest,
          })
          .from(customerOrder)
          .where(inArray(customerOrder.id, orderIds))
      : [],
    supplierIds.length > 0
      ? executor
          .select({ id: supplier.id, name: supplier.name })
          .from(supplier)
          .where(inArray(supplier.id, supplierIds))
      : [],
    accountIds.length > 0
      ? executor
          .select({ id: account.id, name: account.name, phone: account.phone })
          .from(account)
          .where(inArray(account.id, accountIds))
      : [],
    adminIds.length > 0
      ? executor
          .select({ id: adminUser.id, name: account.name })
          .from(adminUser)
          .innerJoin(account, eq(account.id, adminUser.accountId))
          .where(inArray(adminUser.id, adminIds))
      : [],
  ]);
  return {
    orders: new Map(orders.map((row) => [row.id, row])),
    suppliers: new Map(suppliers.map((row) => [row.id, row.name])),
    accounts: new Map(accounts.map((row) => [row.id, { name: row.name, phone: row.phone }])),
    admins: new Map(admins.map((row) => [row.id, row.name])),
  };
}

function adminActor(adminId: string | null, people: People): ReviewAdminActor | null {
  return adminId ? { adminId, name: people.admins.get(adminId) ?? null } : null;
}

function authorOf(accountId: string, people: People) {
  const person = people.accounts.get(accountId);
  return {
    accountId,
    name: person?.name ?? null,
    // Partly hidden (TASK-036.B): the full number is «Показать номер».
    phone: hidePhone(person?.phone ?? ""),
  };
}

export async function adminReviewViews(
  executor: DbExecutor,
  rows: readonly ReviewRow[],
): Promise<AdminReview[]> {
  const people = await peopleOf(executor, {
    orderIds: rows.map((row) => row.orderId),
    supplierIds: rows.map((row) => row.supplierId),
    accountIds: rows.map((row) => row.userAccountId),
    adminIds: rows.flatMap((row) => [row.rejectedByAdminId, row.hiddenByAdminId]),
  });
  return rows.map((row) => {
    const order = people.orders.get(row.orderId);
    const rejectedBy = adminActor(row.rejectedByAdminId, people);
    const hiddenBy = adminActor(row.hiddenByAdminId, people);
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      score: row.score,
      text: row.text,
      holdReasons: row.holdReasons,
      rejection:
        row.rejectedReason && row.rejectedAt && rejectedBy
          ? { reason: row.rejectedReason, at: row.rejectedAt.toISOString(), by: rejectedBy }
          : null,
      hidden:
        row.hiddenReason && row.hiddenAt && hiddenBy
          ? { reason: row.hiddenReason, at: row.hiddenAt.toISOString(), by: hiddenBy }
          : null,
      edited: row.edited,
      checkingSince: iso(row.checkingSince),
      publishedAt: iso(row.publishedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      order: { id: row.orderId, number: order?.number ?? 0, kind: order?.kind ?? "stock" },
      supplier: { id: row.supplierId, name: people.suppliers.get(row.supplierId) ?? "" },
      author: authorOf(row.userAccountId, people),
    };
  });
}

export async function adminComplaintViews(
  executor: DbExecutor,
  rows: readonly ComplaintRow[],
): Promise<AdminComplaint[]> {
  const people = await peopleOf(executor, {
    orderIds: rows.map((row) => row.orderId),
    supplierIds: rows.map((row) => row.supplierId),
    accountIds: rows.map((row) => row.userAccountId),
    adminIds: rows.flatMap((row) => [row.takenByAdminId, row.resolvedByAdminId]),
  });
  return rows.map((row) => {
    const order = people.orders.get(row.orderId);
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      reason: row.reason,
      text: row.text,
      comment: row.comment,
      order: {
        id: row.orderId,
        number: order?.number ?? 0,
        status: order?.status ?? "",
        isTest: order?.isTest ?? false,
      },
      supplier: { id: row.supplierId, name: people.suppliers.get(row.supplierId) ?? "" },
      user: authorOf(row.userAccountId, people),
      takenBy: adminActor(row.takenByAdminId, people),
      takenAt: iso(row.takenAt),
      resolvedBy: adminActor(row.resolvedByAdminId, people),
      resolvedAt: iso(row.resolvedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}
