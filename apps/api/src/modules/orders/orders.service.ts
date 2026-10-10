import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type ActiveOrdersResponse,
  type AdminCancelOrderBody,
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
  type OfferSnapshot,
  type OrderStatusValue,
  type ProposeOrderTermBody,
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
import {
  activeOrderStatuses,
  isActiveOrderStatus,
  isRegistrationComplete,
  orderNeedsAnswer,
  proposedTermProblem,
  readAdminQuery,
  receiptDate,
  type OrderKind,
} from "@adclub/domain";
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
import { CatalogPhotosService, decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { ClubAccess } from "../club-access";
import { AccountStore, supplier, supplierMember } from "../identity";
import { offer, offerShowcase, OfferSnapshots, receiptSchedules } from "../offers";
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
  registrationIncomplete,
  stateConflict,
  subscriptionRequired,
  supplierBlocked,
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
import { activeOrderStatusList, customerOrder, type OrderRow } from "./schema";

/** An employee acting for the company of the session. */
export type OrderSupplierActor = Extract<OrderActorRef, { type: "supplier_member" }>;

/** How often creations served without a working limiter are reported (not every request). */
const UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;
/** Draws of a confirmation code before giving up (a clash among active orders is rare). */
const CODE_ATTEMPTS = 20;

const ACTIVE = [...activeOrderStatuses] as OrderStatusValue[];

/** The kind of order an offer makes (TASK-037); `null` — none the server can make yet. */
function orderKindOf(availability: string): OrderKind | null {
  if (availability === "in_stock") {
    return "stock";
  }
  return availability === "on_order" ? "on_order" : null;
}

/**
 * The deadline of an active order: the end of its pickup reserve once
 * there is one, the user's answer to another term while it is due
 * (TASK-037), the supplier's answer deadline otherwise. The saved copy is
 * cut by it — a user with more active orders than fit gets the ones that
 * run out first (TASK-023 requirement 1).
 */
const DEADLINE_AT = sql`CASE WHEN ${customerOrder.status} = 'term_proposed'
  THEN ${customerOrder.termAnswerBy}
  ELSE coalesce(${customerOrder.expiresAt}, ${customerOrder.respondBy}) END`;

/**
 * How many orders above the limit are read for the copy: some of them may
 * turn out to be past their deadline and drop out, and the copy should
 * still be full.
 */
const EXPIRY_HEADROOM = 11;

/**
 * The order of the cards of M-ORD-02: «Нужен ваш ответ» first (another
 * term of an order under order, TASK-037), then «Можно забирать», then by
 * date — the nearest deadline first, the id settling a tie so two
 * refreshes never disagree.
 */
function inCardOrder(rows: readonly OrderRow[]): OrderRow[] {
  const rank = (row: OrderRow) =>
    orderNeedsAnswer(row.status) ? 0 : row.status === "ready" ? 1 : 2;
  const deadline = (row: OrderRow) =>
    (row.status === "term_proposed" && row.termAnswerBy
      ? row.termAnswerBy
      : (row.expiresAt ?? row.respondBy)
    ).getTime();
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || deadline(a) - deadline(b) || (a.id < b.id ? -1 : 1),
  );
}

/** A time column to the microsecond: the position of a row in a list. */
function positionOf(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * A-ORD-01 «поиск по номеру и телефону» (TASK-036.B): the line read the
 * way the header's search reads it (`readAdminQuery`) — the number of the
 * order, a part of the customer's phone (matched against the full stored
 * number; the answer hides it all the same) or, with letters, the
 * customer's name. A line that is none of these finds nothing.
 */
function adminOrderSearch(q: string): SQL {
  const reading = readAdminQuery(q);
  const found: SQL[] = [];
  if (reading.orderNumber !== null) {
    found.push(eq(customerOrder.number, reading.orderNumber));
  }
  for (const digits of reading.phoneDigits ?? []) {
    found.push(
      sql`EXISTS (SELECT 1 FROM account AS customer WHERE customer.id = ${customerOrder.userAccountId} AND customer.phone LIKE ${`%${digits}%`})`,
    );
  }
  if (reading.text !== null) {
    found.push(
      sql`EXISTS (SELECT 1 FROM account AS customer WHERE customer.id = ${customerOrder.userAccountId} AND customer.name ILIKE ${`%${likeEscaped(reading.text)}%`})`,
    );
  }
  return found.length > 0 ? sql`(${sql.join(found, sql` OR `)})` : sql`false`;
}

/** A text inside a LIKE pattern: its own `%`, `_` and `\` mean themselves. */
function likeEscaped(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
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
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
    @Inject(OfferSnapshots) private readonly snapshots: OfferSnapshots,
    @Inject(OrderTransitions) private readonly transitions: OrderTransitions,
    @Inject(Discipline) private readonly discipline: Discipline,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(OrderNotices) private readonly notices: OrderNotices,
    // The thumbnail of the item in the card of an order (TASK-030.A).
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
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
    // TASK-029 requirement 1: a name is more fundamental than a
    // subscription — checked first, so an unfinished registration never
    // shows "no subscription" when the real reason is "not a member yet".
    const registration = await this.accounts.registrationFacts(accountId);
    if (!registration || !isRegistrationComplete(registration)) {
      throw registrationIncomplete();
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
    return {
      order: await userOrderView(this.database.db, outcome.row, lang, this.photos),
      created: true,
    };
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
    // TASK-037: an offer under order makes an order under order — the same
    // order with a term (ARCHITECTURE 6.2). A kind the server can't order yet
    // (services, TASK-038) would still be refused here.
    const kind = orderKindOf(current.availability);
    if (kind === null) {
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
    // The user agrees to the offer's term by ordering (PRODUCT 10.3); the
    // date it gives now is what «Поставщик привезёт до {дата}» showed.
    const expectedReadyOn = kind === "on_order" ? await this.readyOn(tx, snapshot, at) : null;
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const [row] = await tx
        .insert(customerOrder)
        .values({
          kind,
          expectedReadyOn,
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

  /**
   * The date a term of the offer gives when confirmed at `at`, by the
   * point's working days — `receiptDate`, the one rule (TASK-018); `null` —
   * the point has no working day to count by.
   */
  private async readyOn(
    tx: DbExecutor,
    snapshot: OfferSnapshot,
    at: Date,
    leadDays: number = snapshot.leadDays,
  ): Promise<string | null> {
    const schedule = (await receiptSchedules(tx, [snapshot.location.id])).get(snapshot.location.id);
    const receipt = schedule ? receiptDate(at, leadDays, schedule) : null;
    return receipt?.ok ? receipt.date : null;
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
    return { order: await userOrderView(this.database.db, row, lang, this.photos), created: false };
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
    return userOrderView(this.database.db, row, lang, this.photos);
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
      orders: await activeCopyEntries(this.database.db, inCardOrder(shown), lang, this.photos),
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
      months: await historyMonths(this.database.db, rows, lang, ALMATY_TIME_ZONE, this.photos),
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
    return userOrderView(this.database.db, row, lang, this.photos);
  }

  /**
   * The user's answer to another term of an order under order (TASK-037;
   * SCREENS M-ORD-03 «Согласиться» / «Отказаться»): `agree_term` takes the
   * order on with that term, `reject_term` cancels it. Only the user of the
   * order (another user's order — 404); the answer deadline passed — the
   * order has expired first and the answer is 409 with `term_expired`.
   */
  async answerTerm(
    accountId: string,
    orderId: string,
    answer: "agree_term" | "reject_term",
    expectedVersion: number,
    lang: CatalogLanguage,
  ): Promise<UserOrder> {
    const row = await this.run({
      scope: (tx) => this.userRow(tx, accountId, orderId),
      request: {
        orderId,
        action: answer,
        actor: { type: "user", accountId },
        channel: "app",
        expectedVersion,
      },
      forUser: true,
    });
    return userOrderView(this.database.db, row, lang, this.photos);
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
    const at = await databaseNow(this.database.db);
    // «В работе» holds what still asks for the employee (TASK-033): the
    // accepted and ready orders, and an expired pickup whose late close
    // window is still open («Срок истёк — можно закрыть до …», PRODUCT
    // 10.7) — the same window `orderCloseVerdict` and `close_late` use.
    const lateWindowOpen = sql`(${customerOrder.status} = 'reserve_expired'
      AND ${customerOrder.lateCloseUntil} IS NOT NULL
      AND ${customerOrder.lateCloseUntil} > ${at.toISOString()}::timestamptz
      AND ${customerOrder.codeReleasedAt} IS NULL)`;
    // TASK-037: an order under order whose other term waits for the customer
    // is in work too — «Ждут ответа клиента» (S-ORD-01).
    const inProgress = sql`(${customerOrder.status} IN ('accepted', 'ready', 'term_proposed') OR ${lateWindowOpen})`;
    let page: { rows: OrderRow[]; nextCursor: string | null };
    if (query.tab === "new") {
      page = await this.soonestAnswerFirst(and(own, eq(customerOrder.status, "created"))!, query);
    } else if (query.tab === "in_progress") {
      page = await this.newestFirst(and(own, inProgress)!, query);
    } else {
      page = await this.newestFirst(
        and(
          own,
          notInArray(customerOrder.status, ACTIVE),
          sql`NOT ${lateWindowOpen}`,
          query.status ? eq(customerOrder.status, query.status) : undefined,
          query.from ? gte(customerOrder.createdAt, new Date(query.from)) : undefined,
          query.to ? lt(customerOrder.createdAt, new Date(query.to)) : undefined,
        )!,
        query,
      );
    }
    const [counts] = await this.database.db
      .select({
        created: sql<number>`count(*) FILTER (WHERE ${customerOrder.status} = 'created')::int`,
        inProgress: sql<number>`count(*) FILTER (WHERE ${inProgress})::int`,
        finished: sql<number>`count(*) FILTER (WHERE ${customerOrder.status} NOT IN (${activeOrderStatusList()}) AND NOT ${lateWindowOpen})::int`,
      })
      .from(customerOrder)
      .where(own);
    return {
      language: lang,
      orders: await supplierSummaries(this.database.db, page.rows, lang, at),
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
    return supplierOrderView(this.database.db, row, lang, this.photos);
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
    return {
      order: await supplierOrderView(this.database.db, row, lang, this.photos),
      withdrawOffer,
    };
  }

  /**
   * «Предложить другой срок» (TASK-037; SCREENS S-ORD-04; ARCHITECTURE 6.2):
   * a new order under order gets another term in working days of the
   * company. The term is checked here, in the transaction of the move — not
   * the term already agreed, from 1 to `offer_lead_days_max` — and so is the
   * date it gives by the point's schedule (`receiptDate` with the clock of
   * this transaction, the same the move then counts by). The user is asked;
   * a colleague who acted first — 409 naming them.
   */
  async proposeTerm(
    actor: OrderSupplierActor,
    orderId: string,
    body: ProposeOrderTermBody,
    lang: CatalogLanguage,
  ): Promise<SupplierOrder> {
    const maxLeadDays = await this.settings.get("offer_lead_days_max");
    const row = await this.run({
      scope: async (tx) => {
        const found = await this.supplierRow(tx, actor.supplierId, orderId);
        if (found.kind !== "on_order") {
          // An order in stock has no term to talk about.
          throw kindNotSupported();
        }
        const problem = proposedTermProblem(
          body.leadDays,
          found.offerSnapshot.leadDays,
          maxLeadDays,
        );
        if (problem === "same_term") {
          throw validationError(
            "leadDays",
            "This is the term the customer already agreed to: confirm it instead",
          );
        }
        if (problem === "out_of_range") {
          throw validationError(
            "leadDays",
            `From 1 to ${String(maxLeadDays)} working days (offer_lead_days_max)`,
          );
        }
        const at = await databaseNow(tx);
        if ((await this.readyOn(tx, found.offerSnapshot, at, body.leadDays)) === null) {
          throw validationError(
            "leadDays",
            "The pickup point has no working day to count this term by: set its hours",
          );
        }
        return found;
      },
      request: {
        orderId,
        action: "propose_term",
        actor,
        channel: "supplier_web",
        expectedVersion: body.expectedVersion,
        term: { leadDays: body.leadDays },
      },
      forUser: false,
    });
    return supplierOrderView(this.database.db, row, lang, this.photos);
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
    return supplierOrderView(this.database.db, row, lang, this.photos);
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
    if (outcome.kind === "refused") {
      // The cabinet has every move of an employee: only the state of the company refuses one.
      throw outcome.reason === "supplier_blocked"
        ? supplierBlocked()
        : new Error(`Move ${options.request.action} refused: ${outcome.reason}`);
    }
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
    if (query.accountId) {
      conditions.push(eq(customerOrder.userAccountId, query.accountId));
    }
    if (query.cityId) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM supplier_location AS point WHERE point.id = ${customerOrder.locationId} AND point.city_id = ${query.cityId}::uuid)`,
      );
    }
    if (query.q) {
      conditions.push(adminOrderSearch(query.q));
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
    return adminOrderView(this.database.db, row, lang, this.photos, await this.marksOf(row.id));
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
    return adminOrderView(this.database.db, row, lang, this.photos, await this.marksOf(row.id));
  }

  /**
   * A-ORD-02 «Отменить заявку» (TASK-036.B): an order still going on is
   * cancelled by the administrator, with a reason — the move `admin_cancel`
   * of the one table of moves, applied by `OrderTransitions` like every
   * other. Another administrator (or the supplier) acted first, or the
   * deadline has just passed — 409 naming what happened.
   */
  async adminCancel(
    admin: { accountId: string; adminId: string },
    orderId: string,
    body: AdminCancelOrderBody,
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
        action: "admin_cancel",
        actor: { type: "admin", ...admin },
        channel: "admin",
        expectedVersion: body.expectedVersion,
        cancel: { reason: body.reason },
      },
      forUser: false,
    });
    return adminOrderView(this.database.db, row, lang, this.photos, await this.marksOf(row.id));
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
    return adminOrderView(
      this.database.db,
      outcome.order,
      lang,
      this.photos,
      await this.marksOf(orderId),
    );
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
