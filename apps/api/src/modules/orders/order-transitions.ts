import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type OrderAttemptedAction,
  type OrderCloseMethod,
  type OrderDeclineReason,
  type OrderEventAction,
  type OrderEventDetails,
} from "@adclub/contracts";
import {
  acceptedReserveEnd,
  lateCloseUntil,
  orderTransition,
  readyReserveEnd,
  receiptDate,
  reserveWarningAt,
  type OrderAction,
} from "@adclub/domain";
import { and, desc, eq, gte, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { receiptSchedules } from "../offers";
import { AppSettings } from "../settings";
import { AdminSignals } from "../signals";
import { Discipline } from "./order-discipline";
import {
  customerOrder,
  inSupplierStatistics,
  orderEvent,
  type OrderEventChannel,
  type OrderEventRow,
  type OrderRow,
} from "./schema";

/**
 * The server side of the order's state machine (ARCHITECTURE 6.1, 4.31;
 * TASK-021 requirement 2). The table of moves is `orderTransition` of
 * `@adclub/domain`; here each move is applied:
 *
 * - **as a conditional update** — the row changes only if it is still in
 *   the status and version the move was decided from (and its deadline
 *   hasn't passed); otherwise the order is read again and the move decided
 *   anew, so a move is never lost and two people never both win;
 * - with **its entry in the order's journal in the same transaction**
 *   (`order_event`: who — the user, the employee, the system — when,
 *   through which channel, the details);
 * - **deadlines first**: an action on an order whose deadline has passed
 *   but the sweeper hasn't reached yet expires it on the spot, exactly as
 *   the sweeper would — a deadline is its time, not the sweeper's delay;
 * - **a repeat is no error**: the same person asking for the move they
 *   already made (a double tap) gets the order as it is; anyone else gets
 *   a conflict naming the last move — for an employee it is recorded as
 *   `late_action_ignored`. A repeat that asks for something else, though —
 *   a second decline with another reason — is a conflict: the reason of a
 *   decline already made is not changed behind the employee's back
 *   (TASK-022, debt 4 of TASK-021).
 *
 * The deadlines a move sets are fixed on the order from the settings at
 * that moment (ARCHITECTURE 13.4): a later change of a setting never moves
 * them. **Every decision about time is made by the clock of the database**
 * (`now()` of the transaction), not by the clock of this process: the API
 * and the worker both decide deadlines, and their clocks may drift apart
 * (TASK-022, debt 6 of TASK-021).
 */

/** Who makes a move. An employee always acts for the company of the order. */
export type OrderActorRef =
  | { type: "user"; accountId: string }
  | { type: "supplier_member"; accountId: string; supplierId: string; memberId: string }
  | { type: "admin"; accountId: string; adminId: string }
  | { type: "system" };

export type PersonAction = Extract<OrderAttemptedAction, OrderAction>;

export interface MoveRequest {
  orderId: string;
  action: PersonAction;
  actor: Exclude<OrderActorRef, { type: "system" }>;
  channel: Extract<OrderEventChannel, "app" | "supplier_web" | "admin">;
  /** The version the person saw; left out, the move applies to whatever state allows it. */
  expectedVersion?: number;
  /**
   * The move to make instead when `action` isn't possible from the status
   * the order turns out to be in: the code of an order whose reserve has
   * just expired gives it out late (`close` → `close_late`).
   */
  orElse?: PersonAction;
  decline?: { reason: OrderDeclineReason | null; note: string | null };
  /** Giving it out: against the QR, against the code, or by the administrator with a reason. */
  close?: { method: OrderCloseMethod; reason?: string };
}

export type MoveOutcome =
  | { kind: "moved"; order: OrderRow }
  /** The same person already made this move; nothing changed. */
  | { kind: "repeated"; order: OrderRow }
  /** Someone else moved the order first, or it can't make this move any more. */
  | { kind: "conflict"; order: OrderRow; last: OrderEventRow | null };

type DeadlineAction = "expire_no_response" | "expire_reserve";

/** What the sweeper did to one order. */
export type DeadlineOutcome = DeadlineAction | "reserve_warned" | "code_released" | null;

/** How many times a lost race is decided again before giving up with a conflict. */
const MAX_ATTEMPTS = 5;

const HOUR_MS = 60 * 60 * 1000;

function iso(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

/** The deadline an order is past at `at`, if any. */
export function dueDeadline(
  row: OrderRow,
  at: Date,
): DeadlineAction | "warn" | "release_code" | null {
  if (row.status === "created" && row.respondBy <= at) {
    return "expire_no_response";
  }
  if (row.status === "accepted" || row.status === "ready") {
    if (row.expiresAt && row.expiresAt <= at) {
      return "expire_reserve";
    }
    if (row.reserveWarnAt && !row.reserveWarnedAt && row.reserveWarnAt <= at) {
      return "warn";
    }
  }
  // The late close window has passed: the order holds its code no longer,
  // so the digits may be drawn for someone else (TASK-022).
  if (
    row.status === "reserve_expired" &&
    row.codeReleasedAt === null &&
    row.lateCloseUntil !== null &&
    row.lateCloseUntil <= at
  ) {
    return "release_code";
  }
  return null;
}

/**
 * The time every decision about a deadline is made by: the clock of the
 * database, one for the API and every worker (TASK-022, debt 6 of
 * TASK-021). `now()` is the start of the transaction, so one transaction
 * never sees time move under it.
 */
export async function databaseNow(executor: DbExecutor): Promise<Date> {
  const result = await executor.execute<{ at: Date }>(sql`SELECT now() AS at`);
  const at = result.rows[0]?.at;
  if (!at) {
    throw new Error("The database gave no time");
  }
  return at instanceof Date ? at : new Date(String(at));
}

function sameActor(event: OrderEventRow, actor: OrderActorRef): boolean {
  switch (actor.type) {
    case "user":
      return event.actorType === "user" && event.actorAccountId === actor.accountId;
    case "supplier_member":
      return event.actorType === "supplier_member" && event.actorMemberId === actor.memberId;
    case "admin":
      return event.actorType === "admin" && event.actorAdminId === actor.adminId;
    case "system":
      return event.actorType === "system";
  }
}

/**
 * A repeat asks for exactly what was done before. A second decline with
 * another reason or another note does not: the order stays declined with
 * the reason it was declined for, and the employee is told so instead of
 * getting a 200 that quietly drops their words (TASK-022, debt 4 of
 * TASK-021). The same holds for a second close by the administrator with
 * another reason.
 */
function sameParameters(row: OrderRow, request: MoveRequest): boolean {
  if (request.action === "decline") {
    return (
      row.declineReason === (request.decline?.reason ?? null) &&
      row.declineNote === (request.decline?.note ?? null)
    );
  }
  if (request.action === "admin_close") {
    return row.closeReason === (request.close?.reason ?? null);
  }
  return true;
}

@Injectable()
export class OrderTransitions {
  private readonly logger = new Logger("Orders");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(Discipline) private readonly discipline: Discipline,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
  ) {}

  /** A person's move on an order (the caller has checked the order is theirs). */
  async move(tx: DbExecutor, request: MoveRequest): Promise<MoveOutcome> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const at = await databaseNow(tx);
      const row = await this.read(tx, request.orderId);
      const due = dueDeadline(row, at);
      if (due === "expire_no_response" || due === "expire_reserve") {
        await this.apply(tx, row, due, { type: "system" }, "timer", at);
        continue;
      }
      const stale =
        request.expectedVersion !== undefined && row.version !== request.expectedVersion;
      const action = this.wanted(row, request);
      if (stale || orderTransition(row.status, action) === null) {
        return this.refuse(tx, row, request, at);
      }
      const moved = await this.apply(tx, row, action, request.actor, request.channel, at, {
        decline: request.decline,
        close: request.close,
      });
      if (moved) {
        return { kind: "moved", order: moved };
      }
    }
    return this.refuse(tx, await this.read(tx, request.orderId), request, await databaseNow(tx));
  }

  /**
   * The move the request means for the status the order is actually in: the
   * code of an order whose pickup reserve expired while the employee was
   * walking to the counter gives it out late, not «nothing to do here».
   */
  private wanted(row: OrderRow, request: MoveRequest): PersonAction {
    if (orderTransition(row.status, request.action) !== null) {
      return request.action;
    }
    if (request.orElse && orderTransition(row.status, request.orElse) !== null) {
      return request.orElse;
    }
    return request.action;
  }

  /**
   * The sweeper's step for one order (ARCHITECTURE 13.1): the deadline it
   * is past, as a move of the system, or the warning that the reserve ends
   * soon. Idempotent: an order nothing is due on is left as it is. When the
   * reserve itself has already ended (the worker was down), there is no
   * warning — the order expires.
   */
  async applyDue(tx: DbExecutor, orderId: string): Promise<DeadlineOutcome> {
    const at = await databaseNow(tx);
    const row = await this.read(tx, orderId);
    const due = dueDeadline(row, at);
    if (due === "expire_no_response" || due === "expire_reserve") {
      return (await this.apply(tx, row, due, { type: "system" }, "timer", at)) ? due : null;
    }
    if (due === "warn") {
      return (await this.warn(tx, row, at)) ? "reserve_warned" : null;
    }
    if (due === "release_code") {
      return (await this.releaseCode(tx, row, at)) ? "code_released" : null;
    }
    return null;
  }

  /**
   * The last move of an order that closed a transition — never its own
   * creation. A conflict must name what someone *did* to the order («заявку
   * уже принял Марат»); «the customer created it» tells an employee nothing
   * (TASK-022, debt 2 of TASK-021).
   */
  async lastMove(executor: DbExecutor, orderId: string): Promise<OrderEventRow | null> {
    const [event] = await executor
      .select()
      .from(orderEvent)
      .where(
        and(
          eq(orderEvent.orderId, orderId),
          isNotNull(orderEvent.toStatus),
          ne(orderEvent.action, "create"),
        ),
      )
      .orderBy(desc(orderEvent.seq))
      .limit(1);
    return event ?? null;
  }

  // ------------------------------------------------------------ inside

  private async read(tx: DbExecutor, orderId: string): Promise<OrderRow> {
    const [row] = await tx.select().from(customerOrder).where(eq(customerOrder.id, orderId));
    if (!row) {
      throw new Error(`Order ${orderId} vanished`);
    }
    return row;
  }

  private async refuse(
    tx: DbExecutor,
    row: OrderRow,
    request: MoveRequest,
    at: Date,
  ): Promise<MoveOutcome> {
    const last = await this.lastMove(tx, row.id);
    if (
      last &&
      last.action === request.action &&
      last.toStatus === row.status &&
      sameActor(last, request.actor) &&
      sameParameters(row, request)
    ) {
      return { kind: "repeated", order: row };
    }
    if (request.actor.type === "supplier_member") {
      // «Кто первым подтвердил — тот и обработал» (PRODUCT 12.6): the late
      // press is kept against the employee who made it — once per employee
      // and intention, so nobody can blow the journal up by pressing again
      // (TASK-022, debt 1 of TASK-021).
      const already = await this.alreadyIgnored(tx, row.id, request.actor.memberId, request.action);
      if (!already) {
        await this.record(
          tx,
          row,
          "late_action_ignored",
          null,
          null,
          request.actor,
          request.channel,
          at,
          {
            attemptedAction: request.action,
          },
        );
      }
      this.logger.log(
        `Order action ignored order=${row.id} action=${request.action} status=${row.status} member=${request.actor.memberId}`,
      );
    }
    return { kind: "conflict", order: row, last };
  }

  /** This employee's press of this button on this order is already in the journal. */
  private async alreadyIgnored(
    tx: DbExecutor,
    orderId: string,
    memberId: string,
    action: PersonAction,
  ): Promise<boolean> {
    const [found] = await tx
      .select({ id: orderEvent.id })
      .from(orderEvent)
      .where(
        and(
          eq(orderEvent.orderId, orderId),
          eq(orderEvent.action, "late_action_ignored"),
          eq(orderEvent.actorMemberId, memberId),
          sql`${orderEvent.payload} ->> 'attemptedAction' = ${action}`,
        ),
      )
      .limit(1);
    return found !== undefined;
  }

  /** One move as a conditional update, with its journal entry; `null` — the order moved meanwhile. */
  private async apply(
    tx: DbExecutor,
    row: OrderRow,
    action: OrderAction,
    actor: OrderActorRef,
    channel: OrderEventChannel,
    at: Date,
    extra: { decline?: MoveRequest["decline"]; close?: MoveRequest["close"] } = {},
  ): Promise<OrderRow | null> {
    const to = orderTransition(row.status, action);
    if (to === null) {
      return null;
    }
    const set: Partial<typeof customerOrder.$inferInsert> = {
      status: to,
      version: row.version + 1,
      updatedAt: at,
    };
    const details: OrderEventDetails = {};
    switch (action) {
      case "accept": {
        if (actor.type !== "supplier_member") {
          throw new Error("Only an employee accepts an order");
        }
        const schedule = (await receiptSchedules(tx, [row.locationId])).get(row.locationId) ?? null;
        const leadDays = row.offerSnapshot.leadDays;
        const receipt = schedule ? receiptDate(at, leadDays, schedule) : null;
        Object.assign(set, {
          acceptedAt: at,
          phoneRevealedAt: at,
          handledByMemberId: actor.memberId,
          handledAt: at,
          receiptOn: receipt?.ok ? receipt.date : null,
        });
        details.receiptOn = receipt?.ok ? receipt.date : undefined;
        if (row.fulfillment === "pickup") {
          const [reserveHours, warningHours] = await Promise.all([
            this.settings.get("pickup_reserve_hours"),
            this.settings.get("reserve_warning_hours"),
          ]);
          const end = acceptedReserveEnd(at, leadDays, schedule, reserveHours);
          Object.assign(set, {
            expiresAt: end,
            reserveWarnAt: reserveWarningAt(end, warningHours, at),
            reserveWarnedAt: null,
          });
          details.reserveUntil = end.toISOString();
        }
        break;
      }
      case "mark_ready": {
        set.readyAt = at;
        if (row.fulfillment === "pickup") {
          const [reserveHours, warningHours] = await Promise.all([
            this.settings.get("pickup_reserve_hours"),
            this.settings.get("reserve_warning_hours"),
          ]);
          const end = readyReserveEnd(row.expiresAt, at, reserveHours);
          if (end.getTime() !== row.expiresAt?.getTime()) {
            Object.assign(set, {
              expiresAt: end,
              reserveWarnAt: reserveWarningAt(end, warningHours, at),
              reserveWarnedAt: null,
            });
          }
          details.reserveUntil = end.toISOString();
        }
        break;
      }
      case "decline": {
        if (actor.type !== "supplier_member") {
          throw new Error("Only an employee declines an order");
        }
        Object.assign(set, {
          handledByMemberId: actor.memberId,
          handledAt: at,
          declineReason: extra.decline?.reason ?? null,
          declineNote: extra.decline?.note ?? null,
          finishedAt: at,
        });
        details.reason = extra.decline?.reason ?? undefined;
        details.note = extra.decline?.note ?? undefined;
        break;
      }
      case "cancel":
        set.finishedAt = at;
        break;
      case "expire_no_response":
        set.finishedAt = at;
        details.deadline = iso(row.respondBy);
        break;
      case "expire_reserve": {
        // The reserve ran out; the order may still be given out against the
        // code for the window (PRODUCT 10.7), so it keeps its code until
        // then — the deadline is fixed here, as every other one (13.4).
        const windowHours = await this.settings.get("order_late_close_hours");
        Object.assign(set, { finishedAt: at, lateCloseUntil: lateCloseUntil(at, windowHours) });
        details.deadline = iso(row.expiresAt);
        break;
      }
      case "close":
      case "close_late": {
        if (actor.type !== "supplier_member") {
          throw new Error("Only an employee gives an order out against the code");
        }
        const method = extra.close?.method;
        if (method !== "qr" && method !== "code") {
          throw new Error("An order is given out against the QR or the code");
        }
        Object.assign(set, {
          finishedAt: at,
          closedAt: at,
          closeMethod: method,
          closedByMemberId: actor.memberId,
          closedLate: action === "close_late",
          // The code has done its work; the digits may be drawn again.
          codeReleasedAt: at,
        });
        details.closeMethod = method;
        break;
      }
      case "admin_close": {
        if (actor.type !== "admin") {
          throw new Error("Only an administrator closes an order without a code");
        }
        const reason = extra.close?.reason;
        if (!reason) {
          throw new Error("A close without a code always says why (D-043)");
        }
        Object.assign(set, {
          finishedAt: at,
          closedAt: at,
          closeMethod: "admin",
          closedByAdminId: actor.adminId,
          closeReason: reason,
          codeReleasedAt: at,
        });
        details.closeMethod = "admin";
        break;
      }
    }
    if (action === "decline" || action === "cancel" || action === "expire_no_response") {
      // Nothing more will ever be given out on this code.
      set.codeReleasedAt = at;
    }
    const [updated] = await tx
      .update(customerOrder)
      .set(set)
      .where(
        and(
          eq(customerOrder.id, row.id),
          eq(customerOrder.status, row.status),
          eq(customerOrder.version, row.version),
          this.deadlineGuard(action, at),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    await this.record(tx, updated, action, row.status, to, actor, channel, at, details);
    if (action === "expire_reserve") {
      // Nobody came for an item the supplier had put aside: the club's own
      // discipline statistics of the user (PRODUCT 10.5).
      await this.discipline.mark(tx, updated, at);
    }
    if (action === "close_late") {
      // The customer had come in time after all (PRODUCT 10.7).
      await this.discipline.revokeForOrder(tx, updated.id, "late_close", at);
      await this.signalDuplicateAfterLateClose(tx, row, updated, at);
    }
    if (action === "admin_close" && actor.type === "admin") {
      await this.discipline.revokeForOrder(tx, updated.id, "admin_close", at);
      await this.audit.record(
        {
          action: auditActions.orderClosedByAdmin,
          actor: { role: "admin", accountId: actor.accountId, adminId: actor.adminId },
          entityType: auditEntities.order,
          entityId: updated.id,
          before: { status: row.status },
          after: { number: updated.number, status: updated.status },
          reason: extra.close?.reason ?? null,
        },
        tx,
      );
      await this.signalFrequentAdminCloses(tx, updated, at);
    }
    if (action === "accept" && actor.type === "supplier_member") {
      // The customer's phone opened to the supplier (ARCHITECTURE 8.4).
      await this.audit.record(
        {
          action: auditActions.orderPhoneRevealed,
          actor: {
            role: "supplier",
            accountId: actor.accountId,
            supplierId: actor.supplierId,
            memberId: actor.memberId,
          },
          entityType: auditEntities.order,
          entityId: updated.id,
          after: { number: updated.number },
        },
        tx,
      );
    }
    this.logger.log(
      `Order moved order=${updated.id} action=${action} from=${row.status} to=${to} version=${updated.version}`,
    );
    return updated;
  }

  /**
   * The row may move only while its deadline hasn't passed; an expiry — only
   * once it has; a late close — only inside the window and while the code
   * still belongs to this order. Checked in the update itself, so a deadline
   * reached between the read and the write is never jumped over.
   */
  private deadlineGuard(action: OrderAction, at: Date): SQL {
    const now = sql`${at.toISOString()}::timestamptz`;
    if (action === "expire_no_response") {
      return sql`${customerOrder.respondBy} <= ${now}`;
    }
    if (action === "expire_reserve") {
      return sql`(${customerOrder.expiresAt} IS NOT NULL AND ${customerOrder.expiresAt} <= ${now})`;
    }
    if (action === "close_late") {
      return sql`(${customerOrder.lateCloseUntil} IS NOT NULL AND ${customerOrder.lateCloseUntil} > ${now}
        AND ${customerOrder.codeReleasedAt} IS NULL)`;
    }
    // The administrator's close is a decision about the dispute, not about
    // a deadline: an order whose deadline has just passed is still closed
    // (the expiry itself is applied first, and `admin_close` starts from the
    // expired statuses too).
    if (action === "admin_close") {
      return sql`true`;
    }
    return sql`NOT (${customerOrder.status} = 'created' AND ${customerOrder.respondBy} <= ${now})
      AND NOT (${customerOrder.status} IN ('accepted', 'ready')
        AND ${customerOrder.expiresAt} IS NOT NULL AND ${customerOrder.expiresAt} <= ${now})`;
  }

  /**
   * The code of an order whose late close window has passed is let go: the
   * digits may be drawn for another order again (a note, not a move).
   */
  private async releaseCode(tx: DbExecutor, row: OrderRow, at: Date): Promise<boolean> {
    const now = sql`${at.toISOString()}::timestamptz`;
    const [updated] = await tx
      .update(customerOrder)
      .set({ codeReleasedAt: at })
      .where(
        and(
          eq(customerOrder.id, row.id),
          eq(customerOrder.status, "reserve_expired"),
          sql`${customerOrder.codeReleasedAt} IS NULL`,
          sql`${customerOrder.lateCloseUntil} IS NOT NULL AND ${customerOrder.lateCloseUntil} <= ${now}`,
        ),
      )
      .returning({ id: customerOrder.id });
    return updated !== undefined;
  }

  /**
   * PRODUCT 10.7: while the order was expired, the user ordered the same
   * item again. Both orders are valid — and somebody has to look at whether
   * the item was handed over twice.
   */
  private async signalDuplicateAfterLateClose(
    tx: DbExecutor,
    before: OrderRow,
    order: OrderRow,
    at: Date,
  ): Promise<void> {
    const expiredAt = before.finishedAt;
    if (!expiredAt) {
      return;
    }
    const [other] = await tx
      .select({ id: customerOrder.id, number: customerOrder.number })
      .from(customerOrder)
      .where(
        and(
          eq(customerOrder.userAccountId, order.userAccountId),
          eq(customerOrder.itemId, order.itemId),
          ne(customerOrder.id, order.id),
          gte(customerOrder.createdAt, expiredAt),
        ),
      )
      .orderBy(desc(customerOrder.createdAt))
      .limit(1);
    if (!other) {
      return;
    }
    await this.signals.raise(tx, {
      kind: "duplicate_after_late_close",
      subjectType: "order",
      subjectId: order.id,
      payload: {
        orderId: order.id,
        orderNumber: order.number,
        otherOrderId: other.id,
        otherOrderNumber: other.number,
        itemId: order.itemId,
        supplierId: order.supplierId,
      },
      at,
    });
  }

  /** D-043: one supplier's orders are closed without a code too often. */
  private async signalFrequentAdminCloses(
    tx: DbExecutor,
    order: OrderRow,
    at: Date,
  ): Promise<void> {
    const [threshold, days] = await Promise.all([
      this.settings.get("admin_close_signal_count"),
      this.settings.get("admin_close_signal_days"),
    ]);
    const since = new Date(at.getTime() - days * 24 * HOUR_MS);
    const [counted] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(customerOrder)
      .where(
        and(
          eq(customerOrder.supplierId, order.supplierId),
          eq(customerOrder.closeMethod, "admin"),
          gte(customerOrder.closedAt, since),
          // The one place that decides what a supplier is judged by
          // (4.33): a test order of an employee never raises a signal.
          inSupplierStatistics(),
        ),
      );
    const closes = counted?.value ?? 0;
    if (closes < threshold) {
      return;
    }
    await this.signals.raise(tx, {
      kind: "frequent_admin_closes",
      subjectType: "supplier",
      subjectId: order.supplierId,
      payload: { supplierId: order.supplierId, closes, days, threshold },
      at,
    });
  }

  /** The warning «the reserve ends soon» — a note, not a move; once per reserve. */
  private async warn(tx: DbExecutor, row: OrderRow, at: Date): Promise<boolean> {
    const now = sql`${at.toISOString()}::timestamptz`;
    const [updated] = await tx
      .update(customerOrder)
      .set({ reserveWarnedAt: at })
      .where(
        and(
          eq(customerOrder.id, row.id),
          sql`${customerOrder.status} IN ('accepted', 'ready')`,
          sql`${customerOrder.reserveWarnedAt} IS NULL`,
          sql`${customerOrder.reserveWarnAt} <= ${now}`,
          sql`${customerOrder.expiresAt} > ${now}`,
        ),
      )
      .returning();
    if (!updated) {
      return false;
    }
    await this.record(
      tx,
      updated,
      "reserve_expiring",
      null,
      null,
      { type: "system" },
      "timer",
      at,
      {
        deadline: iso(updated.expiresAt),
      },
    );
    this.logger.log(`Order reserve ending order=${updated.id}`);
    return true;
  }

  /** One entry of the order's journal (moves pass here; so does the creation). */
  async record(
    tx: DbExecutor,
    order: OrderRow,
    action: OrderEventAction,
    from: OrderRow["status"] | null,
    to: OrderRow["status"] | null,
    actor: OrderActorRef,
    channel: OrderEventChannel,
    at: Date,
    details: OrderEventDetails,
  ): Promise<void> {
    const payload = Object.fromEntries(
      Object.entries(details).filter(([, value]) => value !== undefined),
    );
    await tx.insert(orderEvent).values({
      orderId: order.id,
      action,
      fromStatus: from,
      toStatus: to,
      actorType: actor.type,
      actorAccountId: actor.type === "system" ? null : actor.accountId,
      actorMemberId: actor.type === "supplier_member" ? actor.memberId : null,
      actorAdminId: actor.type === "admin" ? actor.adminId : null,
      channel,
      payload,
      createdAt: at,
    });
  }
}

/** The respond-by deadline of an order created at `at`. */
export function respondByOf(at: Date, supplierResponseHours: number): Date {
  return new Date(at.getTime() + supplierResponseHours * HOUR_MS);
}
