import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminDisciplineListQuery,
  type AdminDisciplineMark,
  type AdminDisciplinePage,
  type AdminDisciplineUsersPage,
  type AdminDisciplineUsersQuery,
  type DisciplineMark,
} from "@adclub/contracts";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { account, supplier } from "../identity";
import { notFound } from "./order-errors";
import { customerOrder, userDisciplineEvent, type DisciplineRow, type OrderRow } from "./schema";

/**
 * The club's own discipline statistics of users (PRODUCT 10.5, 10.7;
 * SCREENS A-ORD-02, A-USR-02, A-USR-03; ARCHITECTURE 4.32; TASK-022).
 *
 * One mark exists: a pickup reserve the supplier had accepted ran out and
 * nobody came for the item (`pickup_no_show`). It is written by the very
 * transaction that expires the reserve, and it is never written for an
 * order with delivery (there is no reserve), for one the supplier never
 * answered, declined, or the customer cancelled — and never for a test
 * order of an employee.
 *
 * A mark is never deleted. It is lifted, with a time and a reason: the
 * supplier gave the order out late after all (so the customer had come —
 * PRODUCT 10.7), the administrator closed the order, or the administrator
 * lifted the mark by hand, which they may only do with a reason and which
 * goes to the action journal. The user is shown none of this anywhere, and
 * the supplier's rating never feels it.
 */
@Injectable()
export class Discipline {
  private readonly logger = new Logger("OrderDiscipline");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  /** The no-show of an order whose pickup reserve has just run out. */
  async mark(tx: DbExecutor, order: OrderRow, at: Date): Promise<void> {
    if (order.isTest) {
      // An employee's own order is out of every statistic (PRODUCT 12.6).
      return;
    }
    await tx
      .insert(userDisciplineEvent)
      .values({
        userAccountId: order.userAccountId,
        orderId: order.id,
        supplierId: order.supplierId,
        kind: "pickup_no_show",
        occurredAt: at,
      })
      // The sweeper may reach the same order twice; one mark per order.
      .onConflictDoNothing();
    this.logger.log(`Discipline mark order=${order.id} kind=pickup_no_show`);
  }

  /**
   * Lifts every standing mark of an order: the order was given out after
   * all. `late_close` — by the code inside the window, `admin_close` — by
   * the administrator.
   */
  async revokeForOrder(
    tx: DbExecutor,
    orderId: string,
    by: "late_close" | "admin_close",
    at: Date,
  ): Promise<void> {
    const lifted = await tx
      .update(userDisciplineEvent)
      .set({ revokedAt: at, revokedBy: by })
      .where(and(eq(userDisciplineEvent.orderId, orderId), isNull(userDisciplineEvent.revokedAt)))
      .returning({ id: userDisciplineEvent.id });
    if (lifted.length > 0) {
      this.logger.log(`Discipline mark lifted order=${orderId} by=${by}`);
    }
  }

  /** A-ORD-02 «Снять дисциплинарную отметку»: by hand, only with a reason. */
  async revokeByAdmin(
    markId: string,
    admin: { accountId: string; adminId: string },
    reason: string,
  ): Promise<AdminDisciplineMark> {
    const row = await this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(userDisciplineEvent)
        .where(eq(userDisciplineEvent.id, markId));
      if (!current) {
        throw notFound();
      }
      if (current.revokedAt) {
        throw new ApiException(
          409,
          "DISCIPLINE_ALREADY_REVOKED",
          "The mark has already been lifted; nothing changed",
        );
      }
      const at = new Date();
      const [updated] = await tx
        .update(userDisciplineEvent)
        .set({
          revokedAt: at,
          revokedBy: "admin",
          revokedNote: reason,
          revokedByAdminId: admin.adminId,
        })
        .where(and(eq(userDisciplineEvent.id, markId), isNull(userDisciplineEvent.revokedAt)))
        .returning();
      if (!updated) {
        throw new ApiException(
          409,
          "DISCIPLINE_ALREADY_REVOKED",
          "The mark has already been lifted; nothing changed",
        );
      }
      await this.audit.record(
        {
          action: auditActions.disciplineRevoked,
          actor: { role: "admin", accountId: admin.accountId, adminId: admin.adminId },
          entityType: auditEntities.disciplineEvent,
          entityId: markId,
          before: { kind: updated.kind, orderId: updated.orderId },
          after: { revoked: true },
          reason,
        },
        tx,
      );
      return updated;
    });
    const [mark] = await this.adminMarks(this.database.db, [row]);
    return mark!;
  }

  /** The marks of these orders, for the administrator's card of an order. */
  async marksOfOrders(
    executor: DbExecutor,
    orderIds: readonly string[],
  ): Promise<Map<string, DisciplineMark[]>> {
    const byOrder = new Map<string, DisciplineMark[]>();
    if (orderIds.length === 0) {
      return byOrder;
    }
    const rows = await executor
      .select()
      .from(userDisciplineEvent)
      .where(inArray(userDisciplineEvent.orderId, [...orderIds]))
      .orderBy(desc(userDisciplineEvent.occurredAt));
    const marks = await this.adminMarks(executor, rows);
    for (const mark of marks) {
      const list = byOrder.get(mark.order.id) ?? [];
      // The administrator's card keeps the mark without the phone number
      // of the customer: the card already has it in its own place.
      const { customer: _customer, ...plain } = mark;
      list.push(plain);
      byOrder.set(mark.order.id, list);
    }
    return byOrder;
  }

  async page(query: AdminDisciplineListQuery): Promise<AdminDisciplinePage> {
    const conditions: SQL[] = [];
    if (query.accountId) {
      conditions.push(eq(userDisciplineEvent.userAccountId, query.accountId));
    }
    if (query.orderId) {
      conditions.push(eq(userDisciplineEvent.orderId, query.orderId));
    }
    if (query.supplierId) {
      conditions.push(eq(userDisciplineEvent.supplierId, query.supplierId));
    }
    if (query.state === "standing") {
      conditions.push(isNull(userDisciplineEvent.revokedAt));
    }
    if (query.state === "revoked") {
      conditions.push(isNotNull(userDisciplineEvent.revokedAt));
    }
    if (query.from) {
      conditions.push(gte(userDisciplineEvent.occurredAt, new Date(query.from)));
    }
    if (query.to) {
      conditions.push(lt(userDisciplineEvent.occurredAt, new Date(query.to)));
    }
    const filter = conditions.length > 0 ? and(...conditions)! : sql`true`;
    const after = decodeMarkCursor(query.cursor);
    const [rows, [total]] = await Promise.all([
      this.database.db
        .select({
          row: userDisciplineEvent,
          position: sql<string>`to_char(${userDisciplineEvent.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(userDisciplineEvent)
        .where(
          and(
            filter,
            after
              ? sql`(${userDisciplineEvent.occurredAt}, ${userDisciplineEvent.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(userDisciplineEvent.occurredAt), desc(userDisciplineEvent.id))
        .limit(query.limit + 1),
      this.database.db.select({ value: count() }).from(userDisciplineEvent).where(filter),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      marks: await this.adminMarks(
        this.database.db,
        page.map((entry) => entry.row),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(`${last.position}|${last.row.id}`, "utf8").toString("base64url")
          : null,
    };
  }

  /** A-USR-03 «Неявки»: who has them, how many and the last one. */
  async users(query: AdminDisciplineUsersQuery): Promise<AdminDisciplineUsersPage> {
    const period: SQL[] = [];
    if (query.from) {
      period.push(gte(userDisciplineEvent.occurredAt, new Date(query.from)));
    }
    if (query.to) {
      period.push(lt(userDisciplineEvent.occurredAt, new Date(query.to)));
    }
    const filter = period.length > 0 ? and(...period)! : sql`true`;
    const standing = sql<number>`count(*) FILTER (WHERE ${userDisciplineEvent.revokedAt} IS NULL)::int`;
    const rows = await this.database.db
      .select({
        accountId: userDisciplineEvent.userAccountId,
        phone: account.phone,
        count: standing,
        revokedCount: sql<number>`count(*) FILTER (WHERE ${userDisciplineEvent.revokedAt} IS NOT NULL)::int`,
        lastAt: sql<Date>`max(${userDisciplineEvent.occurredAt})`,
      })
      .from(userDisciplineEvent)
      .innerJoin(account, eq(account.id, userDisciplineEvent.userAccountId))
      .where(filter)
      .groupBy(userDisciplineEvent.userAccountId, account.phone)
      .having(sql`count(*) FILTER (WHERE ${userDisciplineEvent.revokedAt} IS NULL) > 0`)
      .orderBy(desc(standing), desc(sql`max(${userDisciplineEvent.occurredAt})`))
      .limit(query.limit + 1)
      .offset(query.offset);
    const [total] = await this.database.db.select({ value: sql<number>`count(*)::int` }).from(
      this.database.db
        .select({ accountId: userDisciplineEvent.userAccountId })
        .from(userDisciplineEvent)
        .where(filter)
        .groupBy(userDisciplineEvent.userAccountId)
        .having(sql`count(*) FILTER (WHERE ${userDisciplineEvent.revokedAt} IS NULL) > 0`)
        .as("with_marks"),
    );
    const page = rows.slice(0, query.limit);
    return {
      users: page.map((row) => ({
        accountId: row.accountId,
        phone: row.phone,
        count: row.count,
        revokedCount: row.revokedCount,
        lastAt: new Date(row.lastAt).toISOString(),
      })),
      total: total?.value ?? 0,
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    };
  }

  // ------------------------------------------------------------ inside

  private async adminMarks(
    executor: DbExecutor,
    rows: readonly DisciplineRow[],
  ): Promise<AdminDisciplineMark[]> {
    if (rows.length === 0) {
      return [];
    }
    const [orders, suppliers, phones] = await Promise.all([
      executor
        .select({ id: customerOrder.id, number: customerOrder.number })
        .from(customerOrder)
        .where(inArray(customerOrder.id, [...new Set(rows.map((row) => row.orderId))])),
      executor
        .select({ id: supplier.id, name: supplier.name })
        .from(supplier)
        .where(inArray(supplier.id, [...new Set(rows.map((row) => row.supplierId))])),
      executor
        .select({ id: account.id, phone: account.phone })
        .from(account)
        .where(inArray(account.id, [...new Set(rows.map((row) => row.userAccountId))])),
    ]);
    const numbers = new Map(orders.map((row) => [row.id, row.number]));
    const names = new Map(suppliers.map((row) => [row.id, row.name]));
    const byAccount = new Map(phones.map((row) => [row.id, row.phone]));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      at: row.occurredAt.toISOString(),
      order: { id: row.orderId, number: numbers.get(row.orderId) ?? 0 },
      supplier: { id: row.supplierId, name: names.get(row.supplierId) ?? "" },
      customer: {
        accountId: row.userAccountId,
        phone: byAccount.get(row.userAccountId) ?? "",
      },
      revocation:
        row.revokedAt && row.revokedBy
          ? {
              at: row.revokedAt.toISOString(),
              by: row.revokedBy,
              note: row.revokedNote,
              adminId: row.revokedByAdminId,
            }
          : null,
    }));
  }
}

const MARK_POSITION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const MARK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeMarkCursor(cursor: string | undefined): { position: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  const [position, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!position || !MARK_POSITION.test(position) || !id || !MARK_ID.test(id)) {
    throw new ApiException(400, "VALIDATION_ERROR", "The paging cursor is not one we issued", {
      details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
    });
  }
  return { position, id };
}
