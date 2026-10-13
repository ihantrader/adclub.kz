import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  complaintStatusSchema,
  type AdminComplaint,
  type AdminComplaintListQuery,
  type AdminComplaintPage,
  type ComplaintResponse,
  type ComplaintStatusValue,
  type CreateComplaintBody,
} from "@adclub/contracts";
import { complaintReasonsFor, complaintTransition, reviewText } from "@adclub/domain";
import { and, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { customerOrder } from "../orders";
import { AppSettings } from "../settings";
import {
  complaintConflict,
  complaintExists,
  complaintNotAllowed,
  complaintNotFound,
  orderNotFound,
  textTooLong,
} from "./review-errors";
import { adminComplaintViews, userComplaintView } from "./review-views";
import type { ReviewAdmin } from "./reviews.service";
import { complaint, type ComplaintRow } from "./schema";

/**
 * Complaints about orders (TASK-049; PRODUCT 13; ARCHITECTURE 5.9, 4.69;
 * SCREENS M-ORD-06, A-REV-02): the user complains about an order the
 * supplier accepted or one that is over («Не получил товар» — one given out,
 * T-ORD-08), one open complaint per order; the administrator takes it in work
 * and resolves it with an internal comment, each time with the version they
 * saw. The user sees «на рассмотрении» / «рассмотрена»; the supplier sees
 * nothing of complaints anywhere. A test order may be complained about — a
 * complaint is not statistics.
 */
@Injectable()
export class ComplaintsService {
  private readonly logger = new Logger("Complaints");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async create(accountId: string, body: CreateComplaintBody): Promise<ComplaintResponse> {
    const text = reviewText(body.text);
    const max = await this.settings.get("complaint_text_max_length");
    if (text !== null && text.length > max) {
      throw textTooLong("text", max);
    }
    const outcome = await this.database.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(customerOrder)
        .where(and(eq(customerOrder.id, body.orderId), eq(customerOrder.userAccountId, accountId)));
      if (!order) {
        throw orderNotFound();
      }
      const same = await this.byKey(tx, accountId, body.idempotencyKey);
      if (same) {
        return this.replay(same, body.orderId);
      }
      const reasons = complaintReasonsFor(order.status);
      if (reasons.length === 0) {
        throw complaintNotAllowed("order_not_accepted");
      }
      if (!reasons.includes(body.reason)) {
        throw complaintNotAllowed("not_received_requires_completed");
      }
      const open = await this.openOf(tx, order.id);
      if (open) {
        throw complaintExists(open.id);
      }
      const [row] = await tx
        .insert(complaint)
        .values({
          orderId: order.id,
          supplierId: order.supplierId,
          userAccountId: accountId,
          reason: body.reason,
          text,
          idempotencyKey: body.idempotencyKey,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        // The same request, or another complaint of the order, won meanwhile.
        const again = await this.byKey(tx, accountId, body.idempotencyKey);
        if (again) {
          return this.replay(again, body.orderId);
        }
        const winner = await this.openOf(tx, order.id);
        throw complaintExists(winner?.id ?? order.id);
      }
      await this.audit.record(
        {
          action: auditActions.complaintCreated,
          actor: { role: "user", accountId },
          entityType: auditEntities.complaint,
          entityId: row.id,
          after: {
            reason: row.reason,
            withText: row.text !== null,
            orderId: row.orderId,
            supplierId: row.supplierId,
            accountId,
          },
        },
        tx,
      );
      return { complaint: userComplaintView(row), created: true };
    });
    if (outcome.created) {
      this.logger.log(`Complaint made complaint=${outcome.complaint.id} reason=${body.reason}`);
    }
    return outcome;
  }

  async adminPage(query: AdminComplaintListQuery): Promise<AdminComplaintPage> {
    const others: SQL[] = [];
    if (query.reason) others.push(eq(complaint.reason, query.reason));
    if (query.supplierId) others.push(eq(complaint.supplierId, query.supplierId));
    if (query.accountId) others.push(eq(complaint.userAccountId, query.accountId));
    if (query.orderId) others.push(eq(complaint.orderId, query.orderId));
    const status =
      query.status === "open"
        ? ne(complaint.status, "resolved")
        : query.status
          ? eq(complaint.status, query.status)
          : undefined;
    const filter = and(...others, status);
    const [rows, [total], byStatus] = await Promise.all([
      this.database.db
        .select()
        .from(complaint)
        .where(filter)
        .orderBy(desc(complaint.createdAt), desc(complaint.id))
        .limit(query.limit + 1)
        .offset(query.offset),
      this.database.db.select({ value: count() }).from(complaint).where(filter),
      this.database.db
        .select({ status: complaint.status, value: count() })
        .from(complaint)
        .where(others.length > 0 ? and(...others) : undefined)
        .groupBy(complaint.status),
    ]);
    const counts = Object.fromEntries(
      complaintStatusSchema.options.map((value) => [
        value,
        byStatus.find((row) => row.status === value)?.value ?? 0,
      ]),
    ) as Record<ComplaintStatusValue, number>;
    return {
      complaints: await adminComplaintViews(this.database.db, rows.slice(0, query.limit)),
      total: total?.value ?? 0,
      counts,
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    };
  }

  async adminOne(complaintId: string): Promise<AdminComplaint> {
    const [row] = await this.database.db
      .select()
      .from(complaint)
      .where(eq(complaint.id, complaintId));
    if (!row) {
      throw complaintNotFound();
    }
    const [view] = await adminComplaintViews(this.database.db, [row]);
    return view!;
  }

  /** «Жалобы · новых N» of the home screen: the same rule as the list. */
  async newCount(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(complaint)
      .where(eq(complaint.status, "new"));
    return row?.value ?? 0;
  }

  /**
   * «Взять в работу» / «Решить» (A-REV-02), with the version the
   * administrator saw — otherwise `COMPLAINT_CONFLICT` with the complaint as
   * it is now. The comment of «Решить» is the reason in the journal.
   */
  async decide(
    complaintId: string,
    expectedVersion: number,
    decision: { action: "take" } | { action: "resolve"; comment: string },
    admin: ReviewAdmin,
  ): Promise<AdminComplaint> {
    const outcome = await this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(complaint)
        .where(eq(complaint.id, complaintId))
        .for("update");
      if (!current) {
        throw complaintNotFound();
      }
      const next = complaintTransition(current.status, decision.action);
      if (next === null || current.version !== expectedVersion) {
        return { conflict: current };
      }
      const [updated] = await tx
        .update(complaint)
        .set({
          status: next,
          ...(decision.action === "take"
            ? { takenAt: sql`now()`, takenByAdminId: admin.adminId }
            : {
                resolvedAt: sql`now()`,
                resolvedByAdminId: admin.adminId,
                comment: decision.comment.trim(),
              }),
          version: sql`${complaint.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(complaint.id, complaintId))
        .returning();
      await this.audit.record(
        {
          action:
            decision.action === "take"
              ? auditActions.complaintTaken
              : auditActions.complaintResolved,
          actor: { role: "admin", accountId: admin.accountId, adminId: admin.adminId },
          entityType: auditEntities.complaint,
          entityId: complaintId,
          before: { status: current.status, version: current.version },
          after: {
            status: next,
            version: updated!.version,
            orderId: current.orderId,
            supplierId: current.supplierId,
            accountId: current.userAccountId,
          },
          reason: decision.action === "resolve" ? decision.comment.trim() : null,
        },
        tx,
      );
      return { updated: updated! };
    });
    if (outcome.conflict) {
      const [view] = await adminComplaintViews(this.database.db, [outcome.conflict]);
      this.logger.warn(
        `Complaint action refused: changed meanwhile complaint=${complaintId} status=${outcome.conflict.status}`,
      );
      throw complaintConflict(view!);
    }
    this.logger.log(
      `Complaint ${decision.action === "take" ? "taken" : "resolved"} complaint=${complaintId} by=admin:${admin.adminId}`,
    );
    const [view] = await adminComplaintViews(this.database.db, [outcome.updated!]);
    return view!;
  }

  /** Every complaint of these orders, the newest first. */
  async ofOrders(executor: DbExecutor, orderIds: readonly string[]): Promise<ComplaintRow[]> {
    if (orderIds.length === 0) {
      return [];
    }
    return executor
      .select()
      .from(complaint)
      .where(inArray(complaint.orderId, [...orderIds]))
      .orderBy(desc(complaint.createdAt), desc(complaint.id));
  }

  private async byKey(tx: DbExecutor, accountId: string, key: string) {
    const [row] = await tx
      .select()
      .from(complaint)
      .where(and(eq(complaint.userAccountId, accountId), eq(complaint.idempotencyKey, key)));
    return row;
  }

  private async openOf(tx: DbExecutor, orderId: string) {
    const [row] = await tx
      .select()
      .from(complaint)
      .where(and(eq(complaint.orderId, orderId), ne(complaint.status, "resolved")));
    return row;
  }

  /** The same request again — the complaint made then; the key of another order — 409. */
  private replay(row: ComplaintRow, orderId: string): ComplaintResponse {
    if (row.orderId !== orderId) {
      throw complaintExists(row.id);
    }
    return { complaint: userComplaintView(row), created: false };
  }
}
