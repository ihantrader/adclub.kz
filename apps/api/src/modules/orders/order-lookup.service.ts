import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  ORDER_QR_PREFIX,
  type CatalogLanguage,
  type CloseOrderResponse,
  type OrderCredential,
  type OrderLookupResponse,
  type RateLimitName,
} from "@adclub/contracts";
import { orderCloseVerdict, type OrderCloseVerdict } from "@adclub/domain";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  ApiException,
  rateLimitedException,
  serviceUnavailableException,
} from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { Metrics } from "../../observability";
import { RateLimiterService, RateLimiterUnavailableError } from "../../redis";
import { AuditLog } from "../audit";
import { supplier, supplierMember } from "../identity";
import { rateLimitSettingKeys } from "../../rate-limit";
import { AppSettings } from "../settings";
import { readCredential, type OrderCredentialRef } from "./order-code";
import { closureOf, scanOrderView, supplierOrderView } from "./order-views";
import { OrderTransitions, type MoveOutcome, type OrderActorRef } from "./order-transitions";
import { customerOrder, type OrderRow } from "./schema";

/** An employee acting for the company of their session. */
type OrderSupplierActor = Extract<OrderActorRef, { type: "supplier_member" }>;

/**
 * Giving an order out against the code or the QR the customer shows
 * (PRODUCT 10.1, 10.7; SCREENS S-SCAN-01…04; ARCHITECTURE 4.32; TASK-022).
 * This is the only door to «Выдана» for a supplier — an order is never
 * closed by its id from a list, only by the credential the customer holds —
 * and the administrator's close with a reason is the only other one.
 *
 * **Guessing the code has to be impossible in practice.** Six digits are a
 * million values, and the answer «оформлена у другого поставщика» would
 * confirm that a code exists. So every lookup is counted twice: against a
 * plain limit of lookups of one employee, and — far tighter — against a
 * limit of lookups that found nothing or another company's order, per
 * employee and per company. Hitting the second one refuses the whole
 * company for the rest of the window, counts a metric and writes one entry
 * in the action journal, so an administrator sees it. When Redis can't
 * count, looking a code up is refused altogether (503): the one thing that
 * must never be served without a limit is guessing, and an order that
 * couldn't be closed during an outage is closed late afterwards — that
 * window exists for exactly this.
 *
 * No answer here carries the code, the QR token or the customer's phone
 * number, and the case «another company» carries nothing of the order at
 * all: the name of that company only when the employee works there too, so
 * the screen can offer to switch.
 */

/** What the credential points at. */
type Found =
  { kind: "own"; row: OrderRow } | { kind: "other"; supplierId: string } | { kind: "none" };

/** The answers a lookup and a close share word for word. */
type SettledOutcome = Extract<
  OrderLookupResponse,
  { result: "closed" | "refused" | "other_supplier" | "not_found" }
>;

@Injectable()
export class OrderLookup {
  private readonly logger = new Logger("OrderLookup");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(OrderTransitions) private readonly transitions: OrderTransitions,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /** S-SCAN-03: what the employee sees for the credential, without changing anything. */
  async lookup(
    actor: OrderSupplierActor,
    body: OrderCredential,
    lang: CatalogLanguage,
  ): Promise<OrderLookupResponse> {
    const { found } = await this.find(actor, body);
    if (found.kind !== "own") {
      return this.settled(actor, found);
    }
    // A deadline is its time, not the sweeper's delay: the screen must not
    // offer «Выдать» on an order whose reserve has just run out — it offers
    // «Закрыть заявку» instead (TASK-022, debt 5 of TASK-021).
    const row = await this.database.db.transaction((tx) =>
      this.readOwn(tx, actor.supplierId, found.row.id),
    );
    const verdict = orderCloseVerdict(facts(row), await this.now());
    if (verdict.kind === "now") {
      return { result: "ready", order: scanOrderView(row, lang) };
    }
    if (verdict.kind === "late") {
      return {
        result: "late",
        order: scanOrderView(row, lang),
        expiredAt: verdict.expiredAt.toISOString(),
        until: verdict.until.toISOString(),
      };
    }
    return this.refusal(row, verdict);
  }

  /** S-SCAN-04: gives the order out, or says why it can't be. */
  async close(
    actor: OrderSupplierActor,
    body: OrderCredential,
    lang: CatalogLanguage,
  ): Promise<CloseOrderResponse> {
    const { found, ref } = await this.find(actor, body);
    if (found.kind !== "own") {
      return this.settled(actor, found);
    }
    const method = ref.kind === "qr" ? "qr" : "code";
    const outcome: MoveOutcome = await this.database.db.transaction(async (tx) => {
      // The deadline of the order is applied first, so «Выдать» never runs
      // into a state the reader didn't see (TASK-022, debt 5 of TASK-021).
      const fresh = await this.readOwn(tx, actor.supplierId, found.row.id);
      const verdict = orderCloseVerdict(facts(fresh), await this.now(tx));
      if (verdict.kind !== "now" && verdict.kind !== "late") {
        return { kind: "conflict", order: fresh, last: null } as MoveOutcome;
      }
      return this.transitions.move(tx, {
        orderId: fresh.id,
        action: "close",
        orElse: "close_late",
        actor,
        channel: "supplier_web",
        close: { method },
      });
    });
    if (outcome.kind === "moved") {
      this.logger.log(
        `Order given out order=${outcome.order.id} method=${method} late=${String(outcome.order.closedLate)} member=${actor.memberId}`,
      );
      return {
        result: "given_out",
        order: await supplierOrderView(this.database.db, outcome.order, lang),
        late: outcome.order.closedLate,
      };
    }
    // Someone else closed, cancelled or expired it in the meantime, or it
    // was never closable: the same answer a lookup would give now.
    const row = outcome.order;
    const verdict = orderCloseVerdict(facts(row), await this.now());
    if (verdict.kind === "now" || verdict.kind === "late") {
      // Extremely unlikely (the move lost its race five times): say it
      // plainly rather than pretend something happened.
      throw new ApiException(
        409,
        "ORDER_STATE_CONFLICT",
        "The order is being changed right now; try again",
        { details: { currentStatus: row.status, version: row.version } },
      );
    }
    return this.refusal(row, verdict);
  }

  // ---------------------------------------------------------------- inside

  /** Counts the lookup, reads the credential and finds what it points at. */
  private async find(
    actor: OrderSupplierActor,
    body: OrderCredential,
  ): Promise<{ found: Found; ref: OrderCredentialRef }> {
    await this.countLookup(actor);
    const ref = readCredential(body);
    if (ref.kind === "not_our_qr") {
      throw new ApiException(400, "ORDER_QR_UNKNOWN", "This is not the QR of a club order", {
        details: { prefix: ORDER_QR_PREFIX },
      });
    }
    if (ref.kind === "not_a_code") {
      throw new ApiException(400, "VALIDATION_ERROR", "A confirmation code is six digits", {
        details: [{ path: "code", message: "Six digits" }],
      });
    }
    const found = await this.locate(actor, ref);
    if (found.kind !== "own") {
      await this.countFailure(actor);
    }
    return { found, ref };
  }

  /**
   * The order the credential points at. A code belongs to one order while
   * that order can still be closed (the unique index on the held codes);
   * once released, the same digits may be drawn again, so a released code
   * is looked for among this company's own orders only — enough for «уже
   * выдана» and «клиент отменил», and it tells nothing about anyone else. A
   * QR token is unique for ever and needs no such care.
   */
  private async locate(actor: OrderSupplierActor, ref: OrderCredentialRef): Promise<Found> {
    if (ref.kind === "qr") {
      const [row] = await this.database.db
        .select()
        .from(customerOrder)
        .where(eq(customerOrder.qrToken, ref.token));
      return this.mine(actor, row);
    }
    if (ref.kind !== "code") {
      return { kind: "none" };
    }
    const [held] = await this.database.db
      .select()
      .from(customerOrder)
      .where(
        and(eq(customerOrder.confirmationCode, ref.code), isNull(customerOrder.codeReleasedAt)),
      );
    if (held) {
      return this.mine(actor, held);
    }
    const [released] = await this.database.db
      .select()
      .from(customerOrder)
      .where(
        and(
          eq(customerOrder.confirmationCode, ref.code),
          eq(customerOrder.supplierId, actor.supplierId),
        ),
      )
      .orderBy(desc(customerOrder.createdAt))
      .limit(1);
    return released ? { kind: "own", row: released } : { kind: "none" };
  }

  private mine(actor: OrderSupplierActor, row: OrderRow | undefined): Found {
    if (!row) {
      return { kind: "none" };
    }
    return row.supplierId === actor.supplierId
      ? { kind: "own", row }
      : { kind: "other", supplierId: row.supplierId };
  }

  /** The cases the lookup and the close answer the same way. */
  private async settled(actor: OrderSupplierActor, found: Found): Promise<SettledOutcome> {
    if (found.kind === "other") {
      // The name of the other company only if the employee works there too
      // («…у {компания}. Переключиться?»); otherwise nothing at all.
      const [also] = await this.database.db
        .select({ id: supplier.id, name: supplier.name })
        .from(supplierMember)
        .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
        .where(
          and(
            eq(supplierMember.accountId, actor.accountId),
            eq(supplierMember.supplierId, found.supplierId),
            eq(supplierMember.status, "active"),
          ),
        );
      return { result: "other_supplier", supplier: also ?? null };
    }
    return { result: "not_found" };
  }

  private async refusal(row: OrderRow, verdict: OrderCloseVerdict): Promise<SettledOutcome> {
    if (verdict.kind === "closed") {
      const closure = await closureOf(this.database.db, row);
      return {
        result: "closed",
        at: closure?.at ?? row.updatedAt.toISOString(),
        by: closure?.by ?? { kind: "system" },
        late: closure?.late ?? false,
      };
    }
    if (verdict.kind === "refused") {
      return {
        result: "refused",
        reason: verdict.reason,
        at: verdict.at ? verdict.at.toISOString() : null,
        ...(verdict.reason === "late_window_passed"
          ? { lateCloseHours: await this.settings.get("order_late_close_hours") }
          : {}),
      };
    }
    throw new Error("A refusal was asked for a verdict that allows the close");
  }

  private async readOwn(tx: DbExecutor, supplierId: string, orderId: string): Promise<OrderRow> {
    await this.transitions.applyDue(tx, orderId);
    const [row] = await tx
      .select()
      .from(customerOrder)
      .where(and(eq(customerOrder.id, orderId), eq(customerOrder.supplierId, supplierId)));
    if (!row) {
      throw new ApiException(404, "NOT_FOUND", "No such order");
    }
    return row;
  }

  private async now(executor?: DbExecutor): Promise<Date> {
    const result = await (executor ?? this.database.db).execute<{ at: Date }>(
      sql`SELECT now() AS at`,
    );
    const at = result.rows[0]?.at;
    return at instanceof Date ? at : new Date(String(at));
  }

  // ----------------------------------------------------------------- limits

  private async countLookup(actor: OrderSupplierActor): Promise<void> {
    await this.count("order_lookup_per_member", `order-lookup:${actor.memberId}`, actor);
  }

  /** Nothing found, or another company's order: the guessing counter. */
  private async countFailure(actor: OrderSupplierActor): Promise<void> {
    await this.count(
      "order_lookup_failures_per_member",
      `order-lookup-fail:${actor.memberId}`,
      actor,
    );
    await this.count(
      "order_lookup_failures_per_supplier",
      `order-lookup-fail-supplier:${actor.supplierId}`,
      actor,
    );
  }

  private async count(limit: RateLimitName, key: string, actor: OrderSupplierActor): Promise<void> {
    const [maxKey, windowKey] = rateLimitSettingKeys(limit);
    const [max, windowSeconds] = (await Promise.all([
      this.settings.get(maxKey),
      this.settings.get(windowKey),
    ])) as [number, number];
    let hit;
    try {
      hit = await this.limiter.hit(key, { max, windowSeconds });
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) {
        throw error;
      }
      // A limit against guessing is never skipped (as the sign-in limits,
      // 4.5): the scanner waits, and the order is given out late later.
      this.logger.warn(`Lookup refused without the limit limit=${limit}: ${error.message}`);
      throw serviceUnavailableException();
    }
    if (hit.allowed) {
      return;
    }
    this.metrics.countRateLimitHit(limit);
    this.logger.warn(
      `Rate limit hit limit=${limit} member=${actor.memberId} supplier=${actor.supplierId}`,
    );
    if (limit !== "order_lookup_per_member" && hit.count === max + 1) {
      // The first refusal of this window goes to the action journal, so an
      // administrator sees that somebody was trying codes.
      await this.audit.record(
        {
          action: auditActions.orderLookupBlocked,
          actor: {
            role: "supplier",
            accountId: actor.accountId,
            supplierId: actor.supplierId,
            memberId: actor.memberId,
          },
          entityType: auditEntities.supplier,
          entityId: actor.supplierId,
          after: { limit, failures: hit.count, windowSeconds },
        },
        this.database.db,
      );
    }
    throw rateLimitedException(limit, hit.retryAfterSeconds);
  }
}

function facts(row: OrderRow) {
  return { status: row.status, finishedAt: row.finishedAt, lateCloseUntil: row.lateCloseUntil };
}
