import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  reviewStatusSchema,
  type AdminReview,
  type AdminReviewListQuery,
  type AdminReviewPage,
  type CreateReviewBody,
  type ReviewRejectReason,
  type ReviewResponse,
  type ReviewStatusValue,
  type SupplierReviewsQuery,
  type SupplierReviewsResponse,
  type UserOrderReview,
} from "@adclub/contracts";
import {
  initialReviewStatus,
  reviewText,
  reviewTransition,
  type ReviewAction,
} from "@adclub/domain";
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { ALMATY_TIME_ZONE, JobQueue } from "../../jobs";
import { AuditLog } from "../audit";
import { decodeCursor, encodeCursor, escapeLike, TIME_POSITION } from "../catalog";
import { account, supplier } from "../identity";
import { customerOrder, reviewable } from "../orders";
import { AppSettings } from "../settings";
import { describeViewer, supplierShownTo, type Viewer } from "../showcase";
import {
  orderNotFound,
  reviewConflict,
  reviewExists,
  reviewNotAllowed,
  reviewNotFound,
  reviewState,
  textTooLong,
} from "./review-errors";
import { checkReviewJob } from "./review-jobs";
import { adminReviewViews, publicReviewView, userReviewView } from "./review-views";
import { review, type ReviewRow } from "./schema";

/** The administrator acting on a review or a complaint. */
export interface ReviewAdmin {
  adminId: string;
  accountId: string;
}

/** The administrator's decision and what it carries. */
type AdminDecision =
  | { action: "publish" }
  | { action: "reject_text"; reason: ReviewRejectReason }
  | { action: "hide"; reason: string }
  | { action: "restore" };

const DECISION_AUDIT: Record<AdminDecision["action"], string> = {
  publish: auditActions.reviewPublished,
  reject_text: auditActions.reviewTextRejected,
  hide: auditActions.reviewHidden,
  restore: auditActions.reviewRestored,
};

/** `published_at` as a cursor position, microseconds in UTC. */
const PUBLISHED_POSITION = sql<string>`to_char(${review.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Reviews of orders (TASK-049; PRODUCT 13; D-042; ARCHITECTURE 5.9, 4.69;
 * SCREENS M-ORD-05, A-REV-01, M-CAT-09): the author leaves one per order
 * given out (`reviewable` of `order-views` — the one rule of «отзыв
 * возможен»), a text waits for its check (`ReviewChecker`), the
 * administrator decides with the version they saw, and the author corrects a
 * refused text once or publishes the score alone. Every move is one
 * conditional update of the status machine of `@adclub/domain` and an entry
 * of the journal in the same transaction; the text is never written to the
 * journal or a log.
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger("Reviews");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  // ---------------------------------------------------------------- author

  /**
   * `POST /reviews`: the author of an order given out, not a test one, once.
   * The same key again returns the review created then; another review of
   * the same order — `REVIEW_EXISTS` (two at once too: the unique key of the
   * order decides, the loser re-reads).
   */
  async create(accountId: string, body: CreateReviewBody): Promise<ReviewResponse> {
    const text = reviewText(body.text);
    await this.checkLength(text);
    const outcome = await this.database.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(customerOrder)
        .where(and(eq(customerOrder.id, body.orderId), eq(customerOrder.userAccountId, accountId)));
      if (!order) {
        throw orderNotFound();
      }
      const existing = await this.ofOrder(tx, order.id);
      if (existing) {
        return this.replay(existing, accountId, body.idempotencyKey);
      }
      if (order.isTest) {
        throw reviewNotAllowed("test_order");
      }
      if (!reviewable(order, false)) {
        throw reviewNotAllowed("not_completed");
      }
      const status = initialReviewStatus(text);
      const [row] = await tx
        .insert(review)
        .values({
          orderId: order.id,
          supplierId: order.supplierId,
          userAccountId: accountId,
          score: body.score,
          text,
          status,
          checkingSince: status === "checking" ? sql`now()` : null,
          publishedAt: status === "published" ? sql`now()` : null,
          idempotencyKey: body.idempotencyKey,
        })
        .onConflictDoNothing({ target: review.orderId })
        .returning();
      if (!row) {
        // Another request of the same order won at this very moment.
        const winner = await this.ofOrder(tx, order.id);
        if (!winner) {
          throw new Error("A review of the order clashed and is gone");
        }
        return this.replay(winner, accountId, body.idempotencyKey);
      }
      await this.audit.record(
        {
          action: auditActions.reviewCreated,
          actor: { role: "user", accountId },
          entityType: auditEntities.review,
          entityId: row.id,
          after: {
            score: row.score,
            withText: row.text !== null,
            status: row.status,
            orderId: row.orderId,
            supplierId: row.supplierId,
            accountId,
          },
        },
        tx,
      );
      if (status === "checking") {
        await this.queue.enqueue(
          checkReviewJob,
          { reviewId: row.id },
          { tx, singletonKey: row.id },
        );
      }
      return { review: userReviewView(row), created: true };
    });
    if (outcome.created) {
      this.logger.log(
        `Review left review=${outcome.review.id} status=${outcome.review.status} withText=${String(outcome.review.text !== null)}`,
      );
    }
    return outcome;
  }

  /** «Исправить текст» (once): the new text waits for its check again. */
  async editText(accountId: string, reviewId: string, value: string): Promise<UserOrderReview> {
    const text = reviewText(value);
    await this.checkLength(text);
    if (text === null) {
      throw new ApiException(400, "VALIDATION_ERROR", "Must not be empty", {
        details: [{ path: "text", message: "Must not be empty" }],
      });
    }
    return this.database.db.transaction(async (tx) => {
      const row = await this.ownLocked(tx, accountId, reviewId);
      if (row.status !== "text_rejected") {
        throw reviewState("not_rejected");
      }
      if (reviewTransition(row.status, "edit_text", { edited: row.edited }) === null) {
        throw reviewState("edit_used");
      }
      const [updated] = await tx
        .update(review)
        .set({
          text,
          status: "checking",
          edited: true,
          holdReasons: [],
          checkingSince: sql`now()`,
          version: sql`${review.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(review.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.reviewTextEdited,
          actor: { role: "user", accountId },
          entityType: auditEntities.review,
          entityId: row.id,
          before: { status: row.status },
          after: { status: "checking", ...this.subjectOf(row) },
        },
        tx,
      );
      await this.queue.enqueue(checkReviewJob, { reviewId: row.id }, { tx, singletonKey: row.id });
      return userReviewView(updated!);
    });
  }

  /** «Опубликовать только оценку»: the refused text is dropped, the score published. */
  async publishScoreOnly(accountId: string, reviewId: string): Promise<UserOrderReview> {
    return this.database.db.transaction(async (tx) => {
      const row = await this.ownLocked(tx, accountId, reviewId);
      if (reviewTransition(row.status, "publish_score_only", { edited: row.edited }) === null) {
        throw reviewState("not_rejected");
      }
      const [updated] = await tx
        .update(review)
        .set({
          text: null,
          status: "published",
          holdReasons: [],
          publishedAt: sql`now()`,
          version: sql`${review.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(review.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.reviewScoreOnly,
          actor: { role: "user", accountId },
          entityType: auditEntities.review,
          entityId: row.id,
          before: { status: row.status },
          after: { status: "published", ...this.subjectOf(row) },
        },
        tx,
      );
      return userReviewView(updated!);
    });
  }

  // ---------------------------------------------------------- administrator

  async adminPage(query: AdminReviewListQuery): Promise<AdminReviewPage> {
    const others: SQL[] = [];
    if (query.supplierId) others.push(eq(review.supplierId, query.supplierId));
    if (query.accountId) others.push(eq(review.userAccountId, query.accountId));
    if (query.orderId) others.push(eq(review.orderId, query.orderId));
    if (query.q) others.push(sql`${review.text} ILIKE ${`%${escapeLike(query.q)}%`}`);
    const filter = and(...others, query.status ? eq(review.status, query.status) : undefined);
    // «На проверке» is a queue: the oldest first. The rest — the newest first.
    const order =
      query.status === "held"
        ? [asc(review.createdAt), asc(review.id)]
        : [desc(review.createdAt), desc(review.id)];
    const [rows, [total], byStatus] = await Promise.all([
      this.database.db
        .select()
        .from(review)
        .where(filter)
        .orderBy(...order)
        .limit(query.limit + 1)
        .offset(query.offset),
      this.database.db.select({ value: count() }).from(review).where(filter),
      this.database.db
        .select({ status: review.status, value: count() })
        .from(review)
        .where(others.length > 0 ? and(...others) : undefined)
        .groupBy(review.status),
    ]);
    const counts = Object.fromEntries(
      reviewStatusSchema.options.map((status) => [
        status,
        byStatus.find((row) => row.status === status)?.value ?? 0,
      ]),
    ) as Record<ReviewStatusValue, number>;
    return {
      reviews: await adminReviewViews(this.database.db, rows.slice(0, query.limit)),
      total: total?.value ?? 0,
      counts,
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    };
  }

  /** «Отзывы на проверке · N» of the home screen: the same rule as the list. */
  async heldCount(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(review)
      .where(eq(review.status, "held"));
    return row?.value ?? 0;
  }

  /**
   * «Опубликовать», «Отклонить текст», «Скрыть», «Вернуть» (A-REV-01): only
   * from the status the move starts from and with the version the
   * administrator saw — otherwise `REVIEW_CONFLICT` with the review as it is
   * now («уже опубликовал {кто}»). The reason goes to the journal.
   */
  async decide(
    reviewId: string,
    expectedVersion: number,
    decision: AdminDecision,
    admin: ReviewAdmin,
  ): Promise<AdminReview> {
    const outcome = await this.database.db.transaction(async (tx) => {
      const [current] = await tx.select().from(review).where(eq(review.id, reviewId)).for("update");
      if (!current) {
        throw reviewNotFound();
      }
      const next = reviewTransition(current.status, decision.action as ReviewAction, {
        edited: current.edited,
      });
      if (next === null || current.version !== expectedVersion) {
        return { conflict: current };
      }
      const [updated] = await tx
        .update(review)
        .set({
          status: next,
          ...this.decisionFields(decision, admin, current),
          version: sql`${review.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(review.id, reviewId))
        .returning();
      await this.audit.record(
        {
          action: DECISION_AUDIT[decision.action],
          actor: { role: "admin", accountId: admin.accountId, adminId: admin.adminId },
          entityType: auditEntities.review,
          entityId: reviewId,
          before: { status: current.status, version: current.version },
          after: {
            status: next,
            version: updated!.version,
            ...(decision.action === "reject_text" ? { rejectedReason: decision.reason } : {}),
            ...this.subjectOf(current),
          },
          reason:
            decision.action === "hide"
              ? decision.reason
              : decision.action === "reject_text"
                ? decision.reason
                : null,
        },
        tx,
      );
      return { updated: updated! };
    });
    if (outcome.conflict) {
      const [view] = await adminReviewViews(this.database.db, [outcome.conflict]);
      this.logger.warn(
        `Review decision refused: changed meanwhile review=${reviewId} status=${outcome.conflict.status}`,
      );
      throw reviewConflict(view!);
    }
    this.logger.log(
      `Review decided review=${reviewId} action=${decision.action} by=admin:${admin.adminId}`,
    );
    const [view] = await adminReviewViews(this.database.db, [outcome.updated!]);
    return view!;
  }

  // ---------------------------------------------------------------- public

  /**
   * The published reviews of a supplier (M-CAT-09): by the rule of the
   * showcase — hidden without club access (no review is read for such a
   * viewer, the same answer for any id); visible — the newest first, pages
   * by the moment of publication.
   */
  async publicPage(
    supplierId: string,
    query: SupplierReviewsQuery,
    viewer: Viewer,
  ): Promise<SupplierReviewsResponse> {
    const shown = supplierShownTo(viewer);
    if (shown.kind === "hidden") {
      return {
        viewer: describeViewer(viewer),
        supplier: shown,
        reviews: [],
        total: 0,
        nextCursor: null,
      };
    }
    const [company] = await this.database.db
      .select({ id: supplier.id, name: supplier.name })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!company) {
      throw new ApiException(404, "NOT_FOUND", "No such supplier");
    }
    const after = this.cursorAt(query.cursor);
    const mine = and(eq(review.supplierId, supplierId), eq(review.status, "published"));
    const found = await this.database.db
      .select({
        id: review.id,
        score: review.score,
        text: review.text,
        publishedAt: review.publishedAt,
        position: PUBLISHED_POSITION,
        authorName: account.name,
      })
      .from(review)
      .innerJoin(account, eq(account.id, review.userAccountId))
      .where(
        and(
          mine,
          after
            ? sql`(${review.publishedAt}, ${review.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(review.publishedAt), desc(review.id))
      .limit(query.limit + 1);
    const [total] = await this.database.db.select({ value: count() }).from(review).where(mine);
    const page = found.slice(0, query.limit);
    const last = page.at(-1);
    return {
      viewer: describeViewer(viewer),
      supplier: { kind: "visible", id: company.id, name: company.name },
      reviews: page.map((row) => publicReviewView(row, row.authorName, ALMATY_TIME_ZONE)),
      total: total?.value ?? 0,
      nextCursor: found.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }

  // ------------------------------------------------- the views of an order

  /** The review of each of these orders, if there is one. */
  async ofOrders(executor: DbExecutor, orderIds: readonly string[]): Promise<ReviewRow[]> {
    return orderIds.length === 0
      ? []
      : executor
          .select()
          .from(review)
          .where(inArray(review.orderId, [...orderIds]));
  }

  // --------------------------------------------------------------- helpers

  private async ofOrder(executor: DbExecutor, orderId: string): Promise<ReviewRow | undefined> {
    const [row] = await executor.select().from(review).where(eq(review.orderId, orderId));
    return row;
  }

  /** The same request again — the review created then; another one — `REVIEW_EXISTS`. */
  private replay(row: ReviewRow, accountId: string, key: string): ReviewResponse {
    if (row.userAccountId === accountId && row.idempotencyKey === key) {
      return { review: userReviewView(row), created: false };
    }
    throw reviewExists(row.id);
  }

  private async ownLocked(tx: DbExecutor, accountId: string, reviewId: string) {
    const [row] = await tx
      .select()
      .from(review)
      .where(and(eq(review.id, reviewId), eq(review.userAccountId, accountId)))
      .for("update");
    if (!row) {
      throw reviewNotFound();
    }
    return row;
  }

  private async checkLength(text: string | null): Promise<void> {
    const max = await this.settings.get("review_text_max_length");
    if (text !== null && text.length > max) {
      throw textTooLong("text", max);
    }
  }

  /** What the journal's history of a supplier and of a user finds an entry by. */
  private subjectOf(row: ReviewRow) {
    return { orderId: row.orderId, supplierId: row.supplierId, accountId: row.userAccountId };
  }

  private decisionFields(decision: AdminDecision, admin: ReviewAdmin, current: ReviewRow) {
    switch (decision.action) {
      case "publish":
        return { publishedAt: current.publishedAt ?? sql`now()` };
      case "reject_text":
        return {
          rejectedReason: decision.reason,
          rejectedAt: sql`now()`,
          rejectedByAdminId: admin.adminId,
        };
      case "hide":
        return {
          hiddenReason: decision.reason.trim(),
          hiddenAt: sql`now()`,
          hiddenByAdminId: admin.adminId,
        };
      case "restore":
        return { hiddenReason: null, hiddenAt: null, hiddenByAdminId: null };
    }
  }

  private cursorAt(cursor: string | undefined): { position: string; id: string } | null {
    if (!cursor) {
      return null;
    }
    const parsed = decodeCursor(cursor);
    if (!TIME_POSITION.test(parsed.position)) {
      throw new ApiException(400, "VALIDATION_ERROR", "Use the nextCursor of the previous page", {
        details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
      });
    }
    return parsed;
  }
}
