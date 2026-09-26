import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type ActiveOrdersResponse,
  type AdminCloseOrderBody,
  type AdminExtendOrderDeadlineBody,
  type AdminExtendOrdersBody,
  type AdminExtendOrdersResponse,
  type AdminExtensionCandidatesPage,
  type AdminExtensionCandidatesQuery,
  type AdminOrder,
  type AdminOrderListQuery,
  type AdminOrderPage,
  type CatalogLanguage,
  type CreateOrderInput,
  type CreateOrderResponse,
  type DeclineOrderBody,
  type DeclineOrderResponse,
  type OrderStatusValue,
  type RepeatOrderResponse,
  type SupplierOrder,
  type SupplierOrderListQuery,
  type SupplierOrderPage,
  type UserOrder,
  type UserOrderHistoryPage,
  type UserOrderHistoryQuery,
  type UserOrderListQuery,
  type UserOrderPage,
} from "@adclub/contracts";
import { activeOrderStatuses, isActiveOrderStatus } from "@adclub/domain";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  ne,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { rateLimitedException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { ALMATY_TIME_ZONE } from "../../jobs";
import { Metrics } from "../../observability";
import { RateLimiterService, RateLimiterUnavailableError } from "../../redis";
import { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { ClubAccess } from "../club-access";
import { supplier, supplierMember } from "../identity";
import { offer, offerShowcase, OfferSnapshots } from "../offers";
import { AppSettings } from "../settings";
import { newConfirmationCode, newQrToken } from "./order-code";
import {
  duplicateActive,
  fulfillmentUnavailable,
  idempotencyMismatch,
  kindNotSupported,
  notFound,
  offerUnavailable,
  priceChanged,
  stateConflict,
  subscriptionRequired,
  validationError,
} from "./order-errors";
import { Discipline } from "./order-discipline";
import { noticeStatesOf } from "./order-notice-channel";
import { OrderNotices } from "./order-notices";
import { repeatView } from "./order-repeat";
import {
  databaseNow,
  dueDeadline,
  OrderTransitions,
  respondByOf,
  type MoveOutcome,
  type MoveRequest,
  type OrderActorRef,
  type PersonAction,
} from "./order-transitions";
import {
  activeCopyEntries,
  adminOrderView,
  adminSummaries,
  historyMonths,
  lastActionOf,
  supplierOrderView,
  supplierSummaries,
  userOrderView,
  userSummaries,
} from "./order-views";
import { customerOrder, type OrderRow } from "./schema";

/** An employee acting for the company of the session. */
export type OrderSupplierActor = Extract<OrderActorRef, { type: "supplier_member" }>;

/** How often creations served without a working limiter are reported (not every request). */
const UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;
/** Draws of a confirmation code before giving up (a clash among active orders is rare). */
const CODE_ATTEMPTS = 20;

const ACTIVE = [...activeOrderStatuses] as OrderStatusValue[];

/**
 * The deadline of an active order: the end of its pickup reserve once
 * there is one, the supplier's answer deadline while there isn't. The
 * saved copy is cut by it — a user with more active orders than fit gets
 * the ones that run out first (TASK-023 requirement 1).
 */
const DEADLINE_AT = sql`coalesce(${customerOrder.expiresAt}, ${customerOrder.respondBy})`;

/**
 * How many orders above the limit are read for the copy: some of them may
 * turn out to be past their deadline and drop out, and the copy should
 * still be full.
 */
const EXPIRY_HEADROOM = 11;

/**
 * The order of the cards of M-ORD-02: «Нужен ваш ответ» first (EPIC-13
 * brings the orders that ask for one), then «Можно забирать», then by
 * date — the nearest deadline first, the id settling a tie so two
 * refreshes never disagree.
 */
function inCardOrder(rows: readonly OrderRow[]): OrderRow[] {
  const rank = (row: OrderRow) => (row.status === "ready" ? 0 : 1);
  const deadline = (row: OrderRow) => (row.expiresAt ?? row.respondBy).getTime();
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || deadline(a) - deadline(b) || (a.id < b.id ? -1 : 1),
  );
}

/** A time column to the microsecond: the position of a row in a list. */
function positionOf(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function cursorAt(cursor: string | undefined): { position: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  const parsed = decodeCursor(cursor);
  if (!TIME_POSITION.test(parsed.position)) {
    throw validationError("cursor", "Use the nextCursor of the previous page");
  }
  return parsed;
}

/**
 * Orders on items in stock (TASK-021; ARCHITECTURE 4.31; SCREENS
 * M-ORD-01…03, S-ORD-01…03, A-ORD-01…02): a user with club access orders
 * from an offer users see; the order keeps the offer's snapshot, a
 * confirmation code and a QR; the supplier's employees accept, mark ready
 * or decline it; the user cancels it; deadlines expire it
 * (`OrderDeadlines`). Every move goes through `OrderTransitions`; what each
 * side sees is `order-views.ts`.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger("Orders");
  private lastUnavailableWarning = 0;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
    @Inject(OfferSnapshots) private readonly snapshots: OfferSnapshots,
    @Inject(OrderTransitions) private readonly transitions: OrderTransitions,
    @Inject(Discipline) private readonly discipline: Discipline,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(OrderNotices) private readonly notices: OrderNotices,
  ) {}

  // ---------------------------------------------------------------- create

  async create(
    input: CreateOrderInput,
    accountId: string,
    lang: CatalogLanguage,
  ): Promise<CreateOrderResponse> {
    const maxQuantity = await this.settings.get("order_max_quantity");
    if (input.quantity > maxQuantity) {
      throw validationError("quantity", `At most ${String(maxQuantity)} items in one order`);
    }
    // The same order sent again (a double tap, a repeat after a lost
    // answer) finds the first one: no second order, no second count.
    const replay = await this.byKey(this.database.db, accountId, input.idempotencyKey);
    if (replay) {
      return this.replayed(replay, input, lang);
    }
    if (!(await this.clubAccess.has(accountId))) {
      throw subscriptionRequired();
    }
    const limitKey = await this.countCreation(accountId);
    let outcome: { row: OrderRow; created: boolean };
    try {
      outcome = await this.database.db.transaction((tx) => this.insert(tx, input, accountId));
    } catch (error) {
      // A refused order doesn't use up the limit.
      if (limitKey) {
        await this.limiter.refund(limitKey).catch(() => undefined);
      }
      throw error;
    }
    if (!outcome.created) {
      // Sent twice at once: the other request made the order, and this one
      // doesn't count against the limit either.
      if (limitKey) {
        await this.limiter.refund(limitKey).catch(() => undefined);
      }
      return this.replayed(outcome.row, input, lang);
    }
    this.logger.log(
      `Order created order=${outcome.row.id} number=${String(outcome.row.number)} supplier=${outcome.row.supplierId} test=${String(outcome.row.isTest)}`,
    );
    return { order: await userOrderView(this.database.db, outcome.row, lang), created: true };
  }

  private async insert(
    tx: DbExecutor,
    input: CreateOrderInput,
    accountId: string,
  ): Promise<{ row: OrderRow; created: boolean }> {
    // The clock of the database, as every decision about time (TASK-022,
    // debt 6 of TASK-021): the order's own time is compared with deadlines
    // and with other orders' times, and the API's clock may drift from the
    // database's.
    const at = await databaseNow(tx);
    // The same key sent at the same moment: the other request may have
    // made the order since the check before the transaction.
    const made = await this.byKey(tx, accountId, input.idempotencyKey);
    if (made) {
      return { row: made, created: false };
    }
    // Held until the order is written: a change of the offer waits, so the
    // order gets its terms whole, before or after the change (4.28 I279).
    const [current] = await tx
      .select({
        id: offer.id,
        supplierId: offer.supplierId,
        locationId: offer.locationId,
        itemId: offer.itemId,
        price: offer.price,
        availability: offer.availability,
        pickup: offer.pickup,
        delivery: offer.delivery,
      })
      .from(offer)
      .where(eq(offer.id, input.offerId))
      .for("share");
    // Missing or not on the showcase — the same answer: offer ids reveal nothing.
    if (!current || !(await offerShowcase(tx, [current.id], at)).get(current.id)?.visible) {
      throw offerUnavailable();
    }
    if (current.availability !== "in_stock") {
      throw kindNotSupported();
    }
    if (!(input.fulfillment === "pickup" ? current.pickup : current.delivery)) {
      throw fulfillmentUnavailable();
    }
    if (current.price !== input.expectedPrice) {
      throw priceChanged(input.expectedPrice, current.price);
    }
    if (!input.allowAnotherActive) {
      const [active] = await tx
        .select({ id: customerOrder.id, number: customerOrder.number })
        .from(customerOrder)
        .where(
          and(
            eq(customerOrder.userAccountId, accountId),
            eq(customerOrder.offerId, current.id),
            inArray(customerOrder.status, ACTIVE),
            // Not the order this very key made (the request sent twice at once).
            ne(customerOrder.idempotencyKey, input.idempotencyKey),
          ),
        )
        .orderBy(desc(customerOrder.createdAt))
        .limit(1);
      if (active) {
        throw duplicateActive(active.id, active.number);
      }
    }
    const snapshot = await this.snapshots.take(tx, current.id, at);
    // An employee ordering from their own company: a test order (PRODUCT 12.6).
    const [membership] = await tx
      .select({ id: supplierMember.id })
      .from(supplierMember)
      .where(
        and(
          eq(supplierMember.accountId, accountId),
          eq(supplierMember.supplierId, current.supplierId),
          eq(supplierMember.status, "active"),
        ),
      );
    const respondBy = respondByOf(at, await this.settings.get("supplier_response_hours"));
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const [row] = await tx
        .insert(customerOrder)
        .values({
          userAccountId: accountId,
          supplierId: current.supplierId,
          locationId: current.locationId,
          offerId: current.id,
          itemId: current.itemId,
          offerSnapshot: snapshot,
          unitPrice: snapshot.price,
          quantity: input.quantity,
          total: snapshot.price * input.quantity,
          fulfillment: input.fulfillment,
          comment: input.comment ?? null,
          isTest: membership !== undefined,
          confirmationCode: newConfirmationCode(),
          qrToken: newQrToken(),
          idempotencyKey: input.idempotencyKey,
          respondBy,
          createdAt: at,
          updatedAt: at,
        })
        // A clash: the same key sent at the same moment (it waited for the
        // other request and finds its order below), or a code already
        // taken by an active order (drawn again).
        .onConflictDoNothing()
        .returning();
      if (row) {
        await this.transitions.record(
          tx,
          row,
          "create",
          null,
          "created",
          { type: "user", accountId },
          "app",
          at,
          { quantity: row.quantity, total: row.total, fulfillment: row.fulfillment },
        );
        // W-01 to the supplier's employees, in the transaction of the order
        // itself: the notices exist if and only if the order does (TASK-025).
        await this.notices.newOrder(tx, row, at);
        return { row, created: true };
      }
      const same = await this.byKey(tx, accountId, input.idempotencyKey);
      if (same) {
        return { row: same, created: false };
      }
    }
    throw new Error("No free confirmation code after many draws");
  }

  private async byKey(
    executor: DbExecutor,
    accountId: string,
    key: string,
  ): Promise<OrderRow | undefined> {
    const [row] = await executor
      .select()
      .from(customerOrder)
      .where(
        and(eq(customerOrder.userAccountId, accountId), eq(customerOrder.idempotencyKey, key)),
      );
    return row;
  }

  private async replayed(
    row: OrderRow,
    input: CreateOrderInput,
    lang: CatalogLanguage,
  ): Promise<CreateOrderResponse> {
    if (
      row.offerId !== input.offerId ||
      row.quantity !== input.quantity ||
      row.fulfillment !== input.fulfillment
    ) {
      throw idempotencyMismatch();
    }
    return { order: await userOrderView(this.database.db, row, lang), created: false };
  }

  /**
   * One creation of the user against the limit; the key to refund, or
   * `null` when Redis is down — then the order is created anyway (an order
   * isn't lost because of Redis) and the outage is reported once a minute.
   */
  private async countCreation(accountId: string): Promise<string | null> {
    const [max, windowSeconds] = await Promise.all([
      this.settings.get("order_create_per_account"),
      this.settings.get("order_create_per_account_window_seconds"),
    ]);
    const key = `order-create:${accountId}`;
    let hit;
    try {
      hit = await this.limiter.hit(key, { max, windowSeconds });
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) {
        throw error;
      }
      const now = Date.now();
      if (now - this.lastUnavailableWarning >= UNAVAILABLE_WARNING_INTERVAL_MS) {
        this.lastUnavailableWarning = now;
        this.logger.warn(`Order created without the limit: ${error.message}`);
      }
      return null;
    }
    if (!hit.allowed) {
      this.metrics.countRateLimitHit("order_create_per_account");
      this.logger.warn(`Rate limit hit limit=order_create_per_account account=${accountId}`);
      throw rateLimitedException("order_create_per_account", hit.retryAfterSeconds);
    }
    return key;
  }

  // ------------------------------------------------------------------ user

  async userPage(
    accountId: string,
    query: UserOrderListQuery,
    lang: CatalogLanguage,
  ): Promise<UserOrderPage> {
    const statuses =
      query.tab === "active"
        ? inArray(customerOrder.status, ACTIVE)
        : notInArray(customerOrder.status, ACTIVE);
    const { rows, nextCursor } = await this.newestFirst(
      and(eq(customerOrder.userAccountId, accountId), statuses)!,
      query,
    );
    return {
      language: lang,
      orders: await userSummaries(this.database.db, rows, lang),
      nextCursor,
    };
  }

  async userOrder(accountId: string, orderId: string, lang: CatalogLanguage): Promise<UserOrder> {
    const row = await this.fresh(await this.userRow(this.database.db, accountId, orderId));
    return userOrderView(this.database.db, row, lang);
  }

  /**
   * Every active order of the user in one answer, for the copy the app
   * keeps on the device (PRODUCT 6.7; SCREENS «Сохранённая копия»;
   * TASK-023 requirement 1). No cursor and no filter: the answer replaces
   * the copy whole, so it must be of a size that can be predicted —
   * `active_orders_copy_limit` orders at most, and if the user has more,
   * the ones whose deadline is nearest, because those are the ones to be
   * at a counter with.
   *
   * A deadline is its time, not the sweeper's delay (TASK-022, debt 5):
   * an order already past its own is expired here, before the copy is
   * built, so nothing that has run out is saved on a device as active.
   * The clock is the database's (debt 6) — the app shows «Обновлено в
   * {время}» by it, not by the device's.
   */
  async activeCopy(accountId: string, lang: CatalogLanguage): Promise<ActiveOrdersResponse> {
    const limit = await this.settings.get("active_orders_copy_limit");
    const serverTime = await databaseNow(this.database.db);
    const mine = and(
      eq(customerOrder.userAccountId, accountId),
      inArray(customerOrder.status, ACTIVE),
    )!;
    // A few more than the limit are read, so that the orders dropped for
    // having run out don't leave the copy short.
    const candidates = await this.database.db
      .select()
      .from(customerOrder)
      .where(mine)
      .orderBy(asc(DEADLINE_AT), asc(customerOrder.id))
      .limit(limit + EXPIRY_HEADROOM);
    const fresh = await this.freshMany(candidates, serverTime);
    const [counted] = await this.database.db
      .select({ value: count() })
      .from(customerOrder)
      .where(mine);
    const total = counted?.value ?? 0;
    const shown = fresh.slice(0, limit);
    return {
      language: lang,
      serverTime: serverTime.toISOString(),
      orders: await activeCopyEntries(this.database.db, inCardOrder(shown), lang),
      total,
      limit,
      truncated: total > shown.length,
    };
  }

  /**
   * The finished orders of the user in months of the club's time zone
   * (SCREENS M-ORD-02 «История»; TASK-023 requirement 2). The page walks
   * by the moment an order finished, newest first: an order that finishes
   * while the user is paging lands above the cursor, so nothing already
   * shown is lost or shown twice, and the months of the pages follow one
   * another (a month split over two pages is joined by its name).
   */
  async historyPage(
    accountId: string,
    query: UserOrderHistoryQuery,
    lang: CatalogLanguage,
  ): Promise<UserOrderHistoryPage> {
    const mine = and(
      eq(customerOrder.userAccountId, accountId),
      notInArray(customerOrder.status, ACTIVE),
    )!;
    const after = cursorAt(query.cursor);
    const position = positionOf(customerOrder.finishedAt);
    const found = await this.database.db
      .select({ order: customerOrder, position })
      .from(customerOrder)
      .where(
        and(
          mine,
          after
            ? sql`(${customerOrder.finishedAt}, ${customerOrder.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(customerOrder.finishedAt), desc(customerOrder.id))
      .limit(query.limit + 1);
    const { rows, nextCursor } = this.paged(found, query.limit);
    const [counted] = await this.database.db
      .select({ value: count() })
      .from(customerOrder)
      .where(mine);
    return {
      language: lang,
      timeZone: ALMATY_TIME_ZONE,
      months: await historyMonths(this.database.db, rows, lang, ALMATY_TIME_ZONE),
      total: counted?.value ?? 0,
      nextCursor,
    };
  }

  /** «Повторить заказ» (TASK-023 requirement 3): what the button can do now. */
  async repeat(
    accountId: string,
    orderId: string,
    lang: CatalogLanguage,
  ): Promise<RepeatOrderResponse> {
    const row = await this.userRow(this.database.db, accountId, orderId);
    return repeatView(
      this.database.db,
      row,
      await this.clubAccess.has(accountId),
      lang,
      await databaseNow(this.database.db),
    );
  }

  /**
   * The rows of a list with every deadline that has passed applied, as the
   * card of one order does (TASK-022, debt 5): the orders that are no
   * longer active drop out. Only the rows that are actually past a
   * deadline cost a transaction, so an ordinary copy costs none.
   */
  private async freshMany(rows: readonly OrderRow[], at: Date): Promise<OrderRow[]> {
    const result: OrderRow[] = [];
    for (const row of rows) {
      const current = dueDeadline(row, at) === null ? row : await this.fresh(row);
      if (isActiveOrderStatus(current.status)) {
        result.push(current);
      }
    }
    return result;
  }

  /** Cancelling: any time before the order is given out (PRODUCT 10.2), accepted ones too. */
  async cancel(accountId: string, orderId: string, lang: CatalogLanguage): Promise<UserOrder> {
    const row = await this.run({
      scope: (tx) => this.userRow(tx, accountId, orderId),
      request: {
        orderId,
        action: "cancel",
        actor: { type: "user", accountId },
        channel: "app",
      },
      forUser: true,
    });
    return userOrderView(this.database.db, row, lang);
  }

  private async userRow(executor: DbExecutor, accountId: string, orderId: string) {
    const [row] = await executor
      .select()
      .from(customerOrder)
      .where(and(eq(customerOrder.id, orderId), eq(customerOrder.userAccountId, accountId)));
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // -------------------------------------------------------------- supplier

  async supplierPage(
    supplierId: string,
    query: SupplierOrderListQuery,
    lang: CatalogLanguage,
  ): Promise<SupplierOrderPage> {
    const own = eq(customerOrder.supplierId, supplierId);
    let page: { rows: OrderRow[]; nextCursor: string | null };
    if (query.tab === "new") {
      page = await this.soonestAnswerFirst(and(own, eq(customerOrder.status, "created"))!, query);
    } else {
      const statuses =
        query.tab === "in_progress"
          ? inArray(customerOrder.status, ["accepted", "ready"])
          : notInArray(customerOrder.status, ACTIVE);
      page = await this.newestFirst(and(own, statuses)!, query);
    }
    const [counts] = await this.database.db
      .select({
        created: sql<number>`count(*) FILTER (WHERE ${customerOrder.status} = 'created')::int`,
        inProgress: sql<number>`count(*) FILTER (WHERE ${customerOrder.status} IN ('accepted', 'ready'))::int`,
        finished: sql<number>`count(*) FILTER (WHERE ${customerOrder.status} NOT IN ('created', 'accepted', 'ready'))::int`,
      })
      .from(customerOrder)
      .where(own);
    return {
      language: lang,
      orders: await supplierSummaries(this.database.db, page.rows, lang),
      counts: {
        new: counts?.created ?? 0,
        inProgress: counts?.inProgress ?? 0,
        finished: counts?.finished ?? 0,
      },
      nextCursor: page.nextCursor,
    };
  }

  async supplierOrder(
    supplierId: string,
    orderId: string,
    lang: CatalogLanguage,
  ): Promise<SupplierOrder> {
    const row = await this.fresh(await this.supplierRow(this.database.db, supplierId, orderId));
    return supplierOrderView(this.database.db, row, lang);
  }

  /**
   * The card of an order shows its deadline as its time, not as the
   * sweeper's delay: an order past its deadline is expired here and now,
   * exactly as the sweeper would, so nobody presses «Выдать» on an order the
   * server is about to refuse (TASK-022, debt 5 of TASK-021). The cheap
   * check uses this process's clock only to decide whether it is worth a
   * transaction; the decision itself is made by the database's clock inside.
   */
  private async fresh(row: OrderRow): Promise<OrderRow> {
    if (dueDeadline(row, new Date()) === null) {
      return row;
    }
    const outcome = await this.database.db.transaction((tx) =>
      this.transitions.applyDue(tx, row.id),
    );
    if (outcome === null) {
      return row;
    }
    const [updated] = await this.database.db
      .select()
      .from(customerOrder)
      .where(eq(customerOrder.id, row.id));
    return updated ?? row;
  }

  async accept(
    actor: OrderSupplierActor,
    orderId: string,
    expectedVersion: number,
    lang: CatalogLanguage,
  ): Promise<SupplierOrder> {
    return this.supplierMove(actor, orderId, "accept", expectedVersion, lang);
  }

  async markReady(
    actor: OrderSupplierActor,
    orderId: string,
    expectedVersion: number,
    lang: CatalogLanguage,
  ): Promise<SupplierOrder> {
    return this.supplierMove(actor, orderId, "mark_ready", expectedVersion, lang);
  }

  /**
   * Declining, before or after accepting (S-ORD-03). With «Нет в наличии»
   * and the offer still on sale, the answer offers to take it off sale —
   * the employee decides; declining never withdraws the offer by itself.
   */
  async decline(
    actor: OrderSupplierActor,
    orderId: string,
    body: DeclineOrderBody,
    lang: CatalogLanguage,
  ): Promise<DeclineOrderResponse> {
    const row = await this.run({
      scope: (tx) => this.supplierRow(tx, actor.supplierId, orderId),
      request: {
        orderId,
        action: "decline",
        actor,
        channel: "supplier_web",
        expectedVersion: body.expectedVersion,
        decline: { reason: body.reason ?? null, note: body.note ?? null },
      },
      forUser: false,
    });
    let withdrawOffer: DeclineOrderResponse["withdrawOffer"] = null;
    if (row.declineReason === "out_of_stock") {
      const [current] = await this.database.db
        .select({ id: offer.id, version: offer.version, status: offer.status })
        .from(offer)
        .where(and(eq(offer.id, row.offerId), eq(offer.supplierId, actor.supplierId)));
      if (current?.status === "active") {
        withdrawOffer = { offerId: current.id, version: current.version };
      }
    }
    return { order: await supplierOrderView(this.database.db, row, lang), withdrawOffer };
  }

  private async supplierMove(
    actor: OrderSupplierActor,
    orderId: string,
    action: Extract<PersonAction, "accept" | "mark_ready">,
    expectedVersion: number,
    lang: CatalogLanguage,
  ): Promise<SupplierOrder> {
    const row = await this.run({
      scope: (tx) => this.supplierRow(tx, actor.supplierId, orderId),
      request: { orderId, action, actor, channel: "supplier_web", expectedVersion },
      forUser: false,
    });
    return supplierOrderView(this.database.db, row, lang);
  }

  private async supplierRow(executor: DbExecutor, supplierId: string, orderId: string) {
    const [row] = await executor
      .select()
      .from(customerOrder)
      .where(and(eq(customerOrder.id, orderId), eq(customerOrder.supplierId, supplierId)));
    if (!row) {
      throw notFound();
    }
    return row;
  }

  /**
   * One move in its own transaction; a conflict is answered after the
   * transaction is committed — what it did (an expiry reached on the way,
   * the ignored press of an employee) stays.
   */
  private async run(options: {
    scope: (tx: DbExecutor) => Promise<OrderRow>;
    request: MoveRequest;
    forUser: boolean;
  }): Promise<OrderRow> {
    const outcome: MoveOutcome = await this.database.db.transaction(async (tx) => {
      await options.scope(tx);
      return this.transitions.move(tx, options.request);
    });
    if (outcome.kind === "conflict") {
      throw stateConflict({
        currentStatus: outcome.order.status,
        version: outcome.order.version,
        // The user never learns who acted on the supplier's side.
        ...(options.forUser
          ? {}
          : { lastAction: await lastActionOf(this.database.db, outcome.last) }),
      });
    }
    return outcome.order;
  }

  // ----------------------------------------------------------------- admin

  async adminPage(query: AdminOrderListQuery, lang: CatalogLanguage): Promise<AdminOrderPage> {
    const conditions: SQL[] = [];
    if (query.status) {
      conditions.push(eq(customerOrder.status, query.status));
    }
    if (query.supplierId) {
      conditions.push(eq(customerOrder.supplierId, query.supplierId));
    }
    if (query.from) {
      conditions.push(gte(customerOrder.createdAt, new Date(query.from)));
    }
    if (query.to) {
      conditions.push(lt(customerOrder.createdAt, new Date(query.to)));
    }
    if (query.number !== undefined) {
      conditions.push(eq(customerOrder.number, query.number));
    }
    if (query.test !== "include") {
      conditions.push(eq(customerOrder.isTest, query.test === "only"));
    }
    if (query.closedLate) {
      conditions.push(eq(customerOrder.closedLate, query.closedLate === "true"));
    }
    if (query.closedByAdmin) {
      conditions.push(
        query.closedByAdmin === "true"
          ? eq(customerOrder.closeMethod, "admin")
          : sql`${customerOrder.closeMethod} IS DISTINCT FROM 'admin'`,
      );
    }
    const filter = conditions.length > 0 ? and(...conditions)! : sql`true`;
    const [{ rows, nextCursor }, [total]] = await Promise.all([
      this.newestFirst(filter, query),
      this.database.db.select({ value: count() }).from(customerOrder).where(filter),
    ]);
    return {
      language: lang,
      orders: await adminSummaries(this.database.db, rows, lang),
      total: total?.value ?? 0,
      nextCursor,
    };
  }

  async adminOrder(orderId: string, lang: CatalogLanguage): Promise<AdminOrder> {
    const [found] = await this.database.db
      .select()
      .from(customerOrder)
      .where(eq(customerOrder.id, orderId));
    if (!found) {
      throw notFound();
    }
    const row = await this.fresh(found);
    return adminOrderView(this.database.db, row, lang, await this.marksOf(row.id));
  }

  /**
   * A-ORD-02 «Закрыть без кода» (D-043): the administrator settles a
   * dispute. The reason is required by the contract; the close is written
   * in the order's journal and in the action journal, the order is marked
   * «Закрыта администратором» for the supplier and the administrator, and
   * the customer's discipline mark for this order — if there was one — is
   * lifted, because the reason for it has gone.
   */
  async adminClose(
    admin: { accountId: string; adminId: string },
    orderId: string,
    body: AdminCloseOrderBody,
    lang: CatalogLanguage,
  ): Promise<AdminOrder> {
    const row = await this.run({
      scope: async (tx) => {
        const [found] = await tx.select().from(customerOrder).where(eq(customerOrder.id, orderId));
        if (!found) {
          throw notFound();
        }
        return found;
      },
      request: {
        orderId,
        action: "admin_close",
        actor: { type: "admin", ...admin },
        channel: "admin",
        expectedVersion: body.expectedVersion,
        close: { method: "admin", reason: body.reason },
      },
      forUser: false,
    });
    return adminOrderView(this.database.db, row, lang, await this.marksOf(row.id));
  }

  /**
   * A-ORD-02 «Продлить срок ответа» / «Продлить резерв» (TASK-025): one
   * deadline of one order, by minutes, with a reason — through the state
   * machine (`OrderTransitions.extend`). A deadline that passed, an order
   * that no longer waits on it or that changed since the administrator saw
   * it — 409 with what happened to it last.
   */
  async adminExtend(
    admin: { accountId: string; adminId: string },
    orderId: string,
    body: AdminExtendOrderDeadlineBody,
    lang: CatalogLanguage,
  ): Promise<AdminOrder> {
    await this.checkExtension(body.minutes);
    const outcome = await this.database.db.transaction((tx) =>
      this.transitions.extend(tx, {
        orderId,
        deadline: body.deadline,
        minutes: body.minutes,
        reason: body.reason,
        admin,
        expectedVersion: body.expectedVersion,
      }),
    );
    if (outcome.kind === "refused") {
      if (!outcome.order) {
        throw notFound();
      }
      throw stateConflict({
        currentStatus: outcome.order.status,
        version: outcome.order.version,
        lastAction: await lastActionOf(
          this.database.db,
          await this.transitions.lastMove(this.database.db, orderId),
        ),
      });
    }
    return adminOrderView(this.database.db, outcome.order, lang, await this.marksOf(orderId));
  }

  /**
   * A-ORD-03 «Продлить на N минут»: the answer deadline of each order, each
   * in its own transaction, so an order that changed meanwhile (accepted in
   * the cabinet at that very moment) is skipped and the rest go on.
   */
  async adminExtendMany(
    admin: { accountId: string; adminId: string },
    body: AdminExtendOrdersBody,
  ): Promise<AdminExtendOrdersResponse> {
    await this.checkExtension(body.minutes);
    const result: AdminExtendOrdersResponse = { extended: [], skipped: [] };
    for (const entry of body.orders) {
      const outcome = await this.database.db.transaction((tx) =>
        this.transitions.extend(tx, {
          orderId: entry.orderId,
          deadline: "response",
          minutes: body.minutes,
          reason: body.reason,
          admin,
          expectedVersion: entry.expectedVersion,
        }),
      );
      if (outcome.kind === "extended") {
        result.extended.push({
          orderId: outcome.order.id,
          number: outcome.order.number,
          version: outcome.order.version,
          respondBy: outcome.order.respondBy.toISOString(),
        });
      } else {
        result.skipped.push({
          orderId: entry.orderId,
          number: outcome.order?.number ?? null,
          status: outcome.order?.status ?? null,
          reason: outcome.reason,
        });
      }
    }
    this.logger.log(
      `Order deadlines extended by an administrator extended=${String(result.extended.length)} skipped=${String(result.skipped.length)} minutes=${String(body.minutes)}`,
    );
    return result;
  }

  /**
   * A-ORD-03: the orders created in the window that still wait for the
   * supplier's answer (and whose deadline has not passed), the nearest
   * deadline first, with what became of their notices — `unnotified`, when
   * not one of them reached anybody.
   */
  async extensionCandidates(
    query: AdminExtensionCandidatesQuery,
  ): Promise<AdminExtensionCandidatesPage> {
    const now = await databaseNow(this.database.db);
    const from = new Date(query.from);
    const to = query.to ? new Date(query.to) : now;
    const waiting = and(
      eq(customerOrder.status, "created"),
      gte(customerOrder.createdAt, from),
      lt(customerOrder.createdAt, to),
      sql`${customerOrder.respondBy} > ${now.toISOString()}::timestamptz`,
    )!;
    const [rows, [counted]] = await Promise.all([
      this.database.db
        .select({ order: customerOrder, supplierName: supplier.name })
        .from(customerOrder)
        .innerJoin(supplier, eq(supplier.id, customerOrder.supplierId))
        .where(waiting)
        .orderBy(asc(customerOrder.respondBy), asc(customerOrder.id))
        .limit(query.limit),
      this.database.db.select({ value: count() }).from(customerOrder).where(waiting),
    ]);
    const timeout = await this.settings.get("whatsapp_outage_delivery_timeout_minutes");
    const notices = await noticeStatesOf(
      this.database.db,
      rows.map((row) => row.order.id),
      timeout,
    );
    const total = counted?.value ?? 0;
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      orders: rows.map(({ order, supplierName }) => {
        const notice = notices.get(order.id) ?? {
          recipients: 0,
          delivered: 0,
          failed: 0,
          pending: 0,
        };
        return {
          id: order.id,
          number: order.number,
          version: order.version,
          isTest: order.isTest,
          supplier: { id: order.supplierId, name: supplierName },
          createdAt: order.createdAt.toISOString(),
          respondBy: order.respondBy.toISOString(),
          notice,
          unnotified: notice.delivered === 0,
        };
      }),
      total,
      truncated: total > rows.length,
    };
  }

  /** The working bound of one extension: `deadline_extension_max_hours`. */
  private async checkExtension(minutes: number): Promise<void> {
    const hours = await this.settings.get("deadline_extension_max_hours");
    if (minutes > hours * 60) {
      throw validationError(
        "minutes",
        `At most ${String(hours * 60)} minutes at once (deadline_extension_max_hours)`,
      );
    }
  }

  private async marksOf(orderId: string) {
    return (await this.discipline.marksOfOrders(this.database.db, [orderId])).get(orderId) ?? [];
  }

  // ---------------------------------------------------------------- pages

  /** Newest first, to the microsecond, then by id; `cursor` — the last row shown. */
  private async newestFirst(
    filter: SQL,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{ rows: OrderRow[]; nextCursor: string | null }> {
    const after = cursorAt(query.cursor);
    const position = positionOf(customerOrder.createdAt);
    const found = await this.database.db
      .select({ order: customerOrder, position })
      .from(customerOrder)
      .where(
        and(
          filter,
          after
            ? sql`(${customerOrder.createdAt}, ${customerOrder.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(customerOrder.createdAt), desc(customerOrder.id))
      .limit(query.limit + 1);
    return this.paged(found, query.limit);
  }

  /** «Новые» of the cabinet: the nearest answer deadline first. */
  private async soonestAnswerFirst(
    filter: SQL,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{ rows: OrderRow[]; nextCursor: string | null }> {
    const after = cursorAt(query.cursor);
    const position = positionOf(customerOrder.respondBy);
    const found = await this.database.db
      .select({ order: customerOrder, position })
      .from(customerOrder)
      .where(
        and(
          filter,
          after
            ? sql`(${customerOrder.respondBy}, ${customerOrder.id}) > (${after.position}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(customerOrder.respondBy), asc(customerOrder.id))
      .limit(query.limit + 1);
    return this.paged(found, query.limit);
  }

  private paged(
    found: { order: OrderRow; position: string }[],
    limit: number,
  ): { rows: OrderRow[]; nextCursor: string | null } {
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((entry) => entry.order),
      nextCursor: found.length > limit && last ? encodeCursor(last.position, last.order.id) : null,
    };
  }
}
