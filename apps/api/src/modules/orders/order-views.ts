import type {
  ActiveOrder,
  ActiveOrderMainDate,
  AdminOrder,
  AdminOrderSummary,
  CatalogLanguage,
  DayHours,
  DisciplineMark,
  LocalizedText,
  OrderActor,
  OrderClosure,
  OrderEvent,
  OrderEventDetails,
  OrderGivenOut,
  OrderItem,
  OrderTerms,
  SupplierOrder,
  SupplierOrderSummary,
  SupplierScanOrder,
  UserHistoryMonth,
  UserOrder,
  UserOrderStep,
  UserOrderSummary,
} from "@adclub/contracts";
import { isActiveOrderStatus, localDateTime, orderAwaitsReceipt } from "@adclub/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { account, supplier, supplierMember } from "../identity";
import { city, supplierClosedDate, supplierLocation } from "../suppliers";
import { qrPayload } from "./order-code";
import { orderEvent, type OrderEventRow, type OrderRow } from "./schema";

/**
 * What each side sees of an order (PRODUCT 10.1, 12.6; D-026; ARCHITECTURE
 * 8.4, 4.31; TASK-021 requirement 5) — the one place of these rules:
 *
 * - **the user** — their own orders: the terms of the snapshot, the
 *   supplier by name (the order was placed with club access, and a later
 *   end of the access doesn't stop its fulfilment — edge case 17.5); the
 *   code and the QR while the order is active; the address, hours and
 *   phone of the pickup point only once the supplier accepted it, while it
 *   is accepted, ready or given out (D-026); the course of the order
 *   without employees' names and without the reason of a decline;
 * - **the supplier** — orders of its own company: no customer data in
 *   lists; in the card the customer's phone only once this order was
 *   accepted (and never read from the database before); the journal with
 *   the employees' names; never the code or the QR;
 * - **the administrator** — any order with the customer, the supplier and
 *   the whole journal; never the code or the QR.
 *
 * A field a side mustn't have is absent from its answer, not empty, and
 * each variant is built field by field here — nothing spreads a row into
 * an answer, so a new column never leaks by itself.
 *
 * TASK-023 adds two more views of the user's own orders, built by the
 * same hand: the saved copy of the active ones (`activeCopyEntries` — the
 * code, the QR and the way to the supplier, and nothing of the catalog)
 * and the history in months (`historyMonths` — the sum, the supplier and
 * what the buttons under a finished order may do, never how it was
 * closed).
 */

// ------------------------------------------------------------------ parts

function localizedName(
  names: OrderRow["offerSnapshot"]["item"]["names"],
  lang: CatalogLanguage,
): LocalizedText {
  const wanted = names[lang];
  if (wanted) {
    return { text: wanted, isFallback: false };
  }
  return { text: names.ru ?? names.kk ?? names.en ?? "", isFallback: true };
}

export function itemOf(row: OrderRow, lang: CatalogLanguage): OrderItem {
  const item = row.offerSnapshot.item;
  return {
    id: item.id,
    type: item.type,
    name: localizedName(item.names, lang),
    article: item.article,
    brand: item.brand,
  };
}

function termsOf(row: OrderRow): OrderTerms {
  const snapshot = row.offerSnapshot;
  return {
    availability: snapshot.availability,
    leadDays: snapshot.leadDays,
    pickup: snapshot.pickup,
    delivery: snapshot.delivery,
    warrantyMonths: snapshot.warrantyMonths,
    warrantyText: snapshot.warrantyText,
  };
}

function iso(date: Date): string {
  return date.toISOString();
}

function baseOf(row: OrderRow, lang: CatalogLanguage) {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    status: row.status,
    isTest: row.isTest,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    total: row.total,
    currency: row.currency,
    fulfillment: row.fulfillment,
    item: itemOf(row, lang),
    respondBy: iso(row.respondBy),
    reserveUntil: row.expiresAt ? iso(row.expiresAt) : null,
    receiptOn: row.receiptOn,
    createdAt: iso(row.createdAt),
  };
}

/** Only the known details of an entry, whatever else a payload might hold. */
function detailsOf(payload: Record<string, unknown>): OrderEventDetails {
  const details: Record<string, unknown> = {};
  for (const key of [
    "quantity",
    "total",
    "fulfillment",
    "reason",
    "note",
    "deadline",
    "reserveUntil",
    "receiptOn",
    "attemptedAction",
    "closeMethod",
    "extendedDeadline",
    "previousDeadline",
    "minutes",
    "adminNote",
  ] as const) {
    if (payload[key] !== undefined && payload[key] !== null) {
      details[key] = payload[key];
    }
  }
  return details as OrderEventDetails;
}

interface MemberName {
  name: string;
  removed: boolean;
}

function memberActor(memberId: string, members: Map<string, MemberName>): OrderActor {
  const member = members.get(memberId);
  return {
    kind: "member",
    memberId,
    name: member?.name ?? "",
    removed: member?.removed ?? false,
  };
}

function actorOf(event: OrderEventRow, members: Map<string, MemberName>): OrderActor {
  switch (event.actorType) {
    case "supplier_member":
      return memberActor(event.actorMemberId!, members);
    case "user":
      return { kind: "user" };
    case "admin":
      return { kind: "admin", adminId: event.actorAdminId! };
    case "system":
      return { kind: "system" };
  }
}

/**
 * One entry of the journal. The reason an administrator gave for extending
 * a deadline (`adminNote`, TASK-025) is theirs: the supplier sees that the
 * deadline moved and until when, never the words (as the reason of a close
 * without a code, 4.32 I329).
 */
function eventOf(
  event: OrderEventRow,
  members: Map<string, MemberName>,
  side: "supplier" | "admin",
): OrderEvent {
  const details = detailsOf(event.payload);
  if (side !== "admin") {
    delete details.adminNote;
  }
  return {
    id: event.id,
    action: event.action,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    at: iso(event.createdAt),
    actor: actorOf(event, members),
    channel: event.channel,
    details,
  };
}

/** The user's view of a move: a side, never a name; the moves only, no notes. */
function stepOf(event: OrderEventRow): UserOrderStep | null {
  if (event.toStatus === null) {
    return null;
  }
  const by =
    event.actorType === "supplier_member"
      ? "supplier"
      : event.actorType === "user"
        ? "user"
        : event.actorType === "admin"
          ? "admin"
          : "system";
  return { action: event.action, status: event.toStatus, at: iso(event.createdAt), by };
}

function handledOf(row: OrderRow, members: Map<string, MemberName>) {
  return {
    offerId: row.offerId,
    handledBy: row.handledByMemberId ? memberActor(row.handledByMemberId, members) : null,
    handledAt: row.handledAt ? iso(row.handledAt) : null,
  };
}

/**
 * How the order was given out, for the supplier and the administrator
 * («Закрыта поздно», «Закрыта администратором»); `null` — not given out.
 * The reason of an administrator's close is left out here — only their own
 * view adds it.
 */
function closureFrom(row: OrderRow, members: Map<string, MemberName>): OrderClosure | null {
  if (!row.closedAt || !row.closeMethod) {
    return null;
  }
  const by: OrderActor = row.closedByMemberId
    ? memberActor(row.closedByMemberId, members)
    : row.closedByAdminId
      ? { kind: "admin", adminId: row.closedByAdminId }
      : { kind: "system" };
  return { at: iso(row.closedAt), method: row.closeMethod, by, late: row.closedLate };
}

/** The same, loading the employee's name on its own (the scanner's answers). */
export async function closureOf(executor: DbExecutor, row: OrderRow): Promise<OrderClosure | null> {
  const members = await memberNames(executor, [row.closedByMemberId]);
  return closureFrom(row, members);
}

/** What the user learns about the end of their order (never who or how). */
function givenOutOf(row: OrderRow): OrderGivenOut | null {
  return row.closedAt ? { at: iso(row.closedAt), late: row.closedLate } : null;
}

function declineOf(row: OrderRow) {
  return row.status === "declined_by_supplier"
    ? { reason: row.declineReason, note: row.declineNote }
    : null;
}

// ------------------------------------------------------------ loading

async function eventsOf(executor: DbExecutor, orderIds: readonly string[]) {
  const byOrder = new Map<string, OrderEventRow[]>();
  if (orderIds.length === 0) {
    return byOrder;
  }
  const rows = await executor
    .select()
    .from(orderEvent)
    .where(inArray(orderEvent.orderId, [...orderIds]))
    .orderBy(asc(orderEvent.seq));
  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push(row);
    byOrder.set(row.orderId, list);
  }
  return byOrder;
}

async function memberNames(
  executor: DbExecutor,
  memberIds: readonly (string | null)[],
): Promise<Map<string, MemberName>> {
  const ids = [...new Set(memberIds.filter((id): id is string => id !== null))];
  const names = new Map<string, MemberName>();
  if (ids.length === 0) {
    return names;
  }
  const rows = await executor
    .select({
      id: supplierMember.id,
      name: supplierMember.displayName,
      status: supplierMember.status,
    })
    .from(supplierMember)
    .where(inArray(supplierMember.id, ids));
  for (const row of rows) {
    names.set(row.id, { name: row.name, removed: row.status === "removed" });
  }
  return names;
}

async function supplierNames(executor: DbExecutor, supplierIds: readonly string[]) {
  const ids = [...new Set(supplierIds)];
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const rows = await executor
    .select({ id: supplier.id, name: supplier.name })
    .from(supplier)
    .where(inArray(supplier.id, ids));
  for (const row of rows) {
    names.set(row.id, row.name);
  }
  return names;
}

async function phonesOf(executor: DbExecutor, accountIds: readonly string[]) {
  const ids = [...new Set(accountIds)];
  const phones = new Map<string, string>();
  if (ids.length === 0) {
    return phones;
  }
  const rows = await executor
    .select({ id: account.id, phone: account.phone })
    .from(account)
    .where(inArray(account.id, ids));
  for (const row of rows) {
    phones.set(row.id, row.phone);
  }
  return phones;
}

// ------------------------------------------------------------------ user

/** The user sees where to go once the supplier accepted, while that still matters. */
function showsPickupPoint(row: OrderRow): boolean {
  return row.status === "accepted" || row.status === "ready" || row.status === "completed";
}

/**
 * The points of several orders at once (the saved copy asks for all of
 * them): the address, the hours, the closed dates from today on in the
 * point's own time zone, and the phone — the current values, not the
 * snapshot's, because this is where to go today.
 */
async function pickupPointsOf(
  executor: DbExecutor,
  locationIds: readonly string[],
): Promise<Map<string, NonNullable<UserOrder["pickupPoint"]>>> {
  const points = new Map<string, NonNullable<UserOrder["pickupPoint"]>>();
  const ids = [...new Set(locationIds)];
  if (ids.length === 0) {
    return points;
  }
  const rows = await executor
    .select({
      id: supplierLocation.id,
      address: supplierLocation.address,
      district: supplierLocation.district,
      weeklyHours: supplierLocation.weeklyHours,
      cityName: city.nameRu,
      timeZone: supplier.timeZone,
      phone: supplier.contactPhone,
    })
    .from(supplierLocation)
    .innerJoin(supplier, eq(supplier.id, supplierLocation.supplierId))
    .innerJoin(city, eq(city.id, supplierLocation.cityId))
    .where(inArray(supplierLocation.id, ids));
  const closed = await executor
    .select({
      locationId: supplierClosedDate.locationId,
      date: supplierClosedDate.closedOn,
      note: supplierClosedDate.note,
    })
    .from(supplierClosedDate)
    // Two days back covers every time zone; the exact «from today» is cut
    // below, in the zone of each point.
    .where(
      and(
        inArray(supplierClosedDate.locationId, ids),
        sql`${supplierClosedDate.closedOn} >= current_date - 2`,
      ),
    )
    .orderBy(asc(supplierClosedDate.closedOn));
  for (const point of rows) {
    const today = localDateTime(new Date(), point.timeZone).date;
    points.set(point.id, {
      address: point.address,
      district: point.district,
      cityName: point.cityName,
      timeZone: point.timeZone,
      weeklyHours: (point.weeklyHours as DayHours[] | null) ?? null,
      closedDates: closed
        .filter((entry) => entry.locationId === point.id && String(entry.date) >= today)
        .map((entry) => ({ date: String(entry.date), note: entry.note })),
      phone: point.phone,
    });
  }
  return points;
}

async function pickupPointOf(
  executor: DbExecutor,
  row: OrderRow,
): Promise<UserOrder["pickupPoint"]> {
  return (await pickupPointsOf(executor, [row.locationId])).get(row.locationId);
}

export async function userSummaries(
  executor: DbExecutor,
  rows: readonly OrderRow[],
  lang: CatalogLanguage,
): Promise<UserOrderSummary[]> {
  const names = await supplierNames(
    executor,
    rows.map((row) => row.supplierId),
  );
  return rows.map((row) => ({
    ...baseOf(row, lang),
    supplier: {
      name: names.get(row.supplierId) ?? row.offerSnapshot.supplier.name,
      cityName: row.offerSnapshot.location.cityName,
      district: row.offerSnapshot.location.district,
    },
  }));
}

export async function userOrderView(
  executor: DbExecutor,
  row: OrderRow,
  lang: CatalogLanguage,
): Promise<UserOrder> {
  const [summary] = await userSummaries(executor, [row], lang);
  const events = (await eventsOf(executor, [row.id])).get(row.id) ?? [];
  const pickupPoint = showsPickupPoint(row) ? await pickupPointOf(executor, row) : undefined;
  return {
    ...summary!,
    version: row.version,
    updatedAt: iso(row.updatedAt),
    terms: termsOf(row),
    comment: row.comment,
    ...(pickupPoint ? { pickupPoint } : {}),
    ...(isActiveOrderStatus(row.status)
      ? { confirmation: { code: row.confirmationCode, qrPayload: qrPayload(row.qrToken) } }
      : {}),
    givenOut: givenOutOf(row),
    history: events.map(stepOf).filter((step): step is UserOrderStep => step !== null),
  };
}

// ----------------------------------------- the saved copy (TASK-023)

/**
 * The date the card of an active order leads with (SCREENS M-ORD-02): the
 * end of the pickup reserve once there is one, the supplier's answer
 * deadline while there isn't. Delivery has no reserve at all (PRODUCT
 * 10.4: it lives until it is handed over), so an accepted delivery order
 * leads with nothing.
 */
function mainDateOf(row: OrderRow): ActiveOrderMainDate | null {
  if (row.expiresAt) {
    return { kind: "reserve_until", at: iso(row.expiresAt) };
  }
  return row.status === "created" ? { kind: "respond_by", at: iso(row.respondBy) } : null;
}

/**
 * The user's active orders as the copy on the device holds them (PRODUCT
 * 6.7; SCREENS «Сохранённая копия», M-ORD-02…04): the code and the QR, the
 * item and the sum, the supplier, and — once accepted — where to go
 * (D-026). Nothing of the catalog, no prices of today, no course of the
 * order: the copy must never show a stale price, and offline the user only
 * has to find the supplier and show the code.
 *
 * The pickup points of every order are read in one query, not one per
 * order: the copy is asked for often.
 */
export async function activeCopyEntries(
  executor: DbExecutor,
  rows: readonly OrderRow[],
  lang: CatalogLanguage,
): Promise<ActiveOrder[]> {
  const names = await supplierNames(
    executor,
    rows.map((row) => row.supplierId),
  );
  const points = await pickupPointsOf(
    executor,
    rows.filter(showsPickupPoint).map((row) => row.locationId),
  );
  return rows.map((row) => {
    const point = showsPickupPoint(row) ? points.get(row.locationId) : undefined;
    return {
      id: row.id,
      number: row.number,
      kind: row.kind,
      status: row.status,
      fulfillment: row.fulfillment,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      total: row.total,
      currency: row.currency,
      item: itemOf(row, lang),
      supplier: {
        name: names.get(row.supplierId) ?? row.offerSnapshot.supplier.name,
        cityName: row.offerSnapshot.location.cityName,
        district: row.offerSnapshot.location.district,
      },
      ...(point ? { pickupPoint: point } : {}),
      confirmation: { code: row.confirmationCode, qrPayload: qrPayload(row.qrToken) },
      mainDate: mainDateOf(row),
      awaitsReceipt: orderAwaitsReceipt(row.status),
      // An order in stock never waits for the user's word; EPIC-13 (another
      // term, another time for a service) does.
      needsAnswer: false,
      respondBy: iso(row.respondBy),
      reserveUntil: row.expiresAt ? iso(row.expiresAt) : null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  });
}

// -------------------------------------------- the history (TASK-023)

/** Whether «Оценить» belongs under a finished order (the review itself — TASK-049). */
function reviewable(row: OrderRow): boolean {
  // A test order of an employee is never reviewed (M-ORD-05); TASK-049
  // will also take away the orders that already have one.
  return row.status === "completed" && !row.isTest;
}

/**
 * The finished orders of the user in months of the club's time zone
 * (SCREENS M-ORD-02 «История»). The rows come newest first by the moment
 * they finished, so the months follow one another and a month split over
 * two pages is joined by its name on the client.
 */
export async function historyMonths(
  executor: DbExecutor,
  rows: readonly OrderRow[],
  lang: CatalogLanguage,
  timeZone: string,
): Promise<UserHistoryMonth[]> {
  const names = await supplierNames(
    executor,
    rows.map((row) => row.supplierId),
  );
  const months: UserHistoryMonth[] = [];
  for (const row of rows) {
    // Every finished order has the moment it finished (the database keeps
    // `finished_at` ⇔ a final status); `updatedAt` only guards the type.
    const finishedAt = row.finishedAt ?? row.updatedAt;
    const month = localDateTime(finishedAt, timeZone).date.slice(0, 7);
    if (months.at(-1)?.month !== month) {
      months.push({ month, orders: [] });
    }
    months.at(-1)!.orders.push({
      id: row.id,
      number: row.number,
      kind: row.kind,
      status: row.status,
      fulfillment: row.fulfillment,
      isTest: row.isTest,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      total: row.total,
      currency: row.currency,
      item: itemOf(row, lang),
      supplier: {
        name: names.get(row.supplierId) ?? row.offerSnapshot.supplier.name,
        cityName: row.offerSnapshot.location.cityName,
        district: row.offerSnapshot.location.district,
      },
      finishedAt: iso(finishedAt),
      // «Получено {дата}» and nothing else: how it was given out — in
      // time, late or by the administrator — is not the user's business
      // (SCREENS M-ORD-03 «Правила», D-043).
      givenOut: givenOutOf(row),
      // Whether the same offer can be had right now is `GET /orders/{id}/repeat`.
      canRepeat: row.kind === "stock",
      canReview: reviewable(row),
      createdAt: iso(row.createdAt),
    });
  }
  return months;
}

// -------------------------------------------------------------- supplier

export async function supplierSummaries(
  executor: DbExecutor,
  rows: readonly OrderRow[],
  lang: CatalogLanguage,
): Promise<SupplierOrderSummary[]> {
  const members = await memberNames(executor, [
    ...rows.map((row) => row.handledByMemberId),
    ...rows.map((row) => row.closedByMemberId),
  ]);
  return rows.map((row) => ({
    ...baseOf(row, lang),
    ...handledOf(row, members),
    closure: closureFrom(row, members),
  }));
}

export async function supplierOrderView(
  executor: DbExecutor,
  row: OrderRow,
  lang: CatalogLanguage,
): Promise<SupplierOrder> {
  const events = (await eventsOf(executor, [row.id])).get(row.id) ?? [];
  const members = await memberNames(executor, [
    row.handledByMemberId,
    row.closedByMemberId,
    ...events.map((event) => event.actorMemberId),
  ]);
  // The phone is read only for an order this supplier accepted.
  const phone =
    row.phoneRevealedAt !== null
      ? (await phonesOf(executor, [row.userAccountId])).get(row.userAccountId)
      : undefined;
  return {
    ...baseOf(row, lang),
    ...handledOf(row, members),
    closure: closureFrom(row, members),
    version: row.version,
    updatedAt: iso(row.updatedAt),
    terms: termsOf(row),
    comment: row.comment,
    customer:
      phone !== undefined
        ? { kind: "revealed", phone }
        : { kind: "hidden", reason: "not_accepted" },
    decline: declineOf(row),
    events: events.map((event) => eventOf(event, members, "supplier")),
  };
}

// ----------------------------------------------------------------- admin

export async function adminSummaries(
  executor: DbExecutor,
  rows: readonly OrderRow[],
  lang: CatalogLanguage,
): Promise<AdminOrderSummary[]> {
  const [members, names, phones] = await Promise.all([
    memberNames(executor, [
      ...rows.map((row) => row.handledByMemberId),
      ...rows.map((row) => row.closedByMemberId),
    ]),
    supplierNames(
      executor,
      rows.map((row) => row.supplierId),
    ),
    phonesOf(
      executor,
      rows.map((row) => row.userAccountId),
    ),
  ]);
  return rows.map((row) => {
    const closure = closureFrom(row, members);
    return {
      ...baseOf(row, lang),
      ...handledOf(row, members),
      supplier: { id: row.supplierId, name: names.get(row.supplierId) ?? "" },
      customer: { accountId: row.userAccountId, phone: phones.get(row.userAccountId) ?? "" },
      // Only the administrator sees why an order was closed without a code.
      closure: closure ? { ...closure, reason: row.closeReason } : null,
    };
  });
}

export async function adminOrderView(
  executor: DbExecutor,
  row: OrderRow,
  lang: CatalogLanguage,
  discipline: DisciplineMark[] = [],
): Promise<AdminOrder> {
  const [summary] = await adminSummaries(executor, [row], lang);
  const events = (await eventsOf(executor, [row.id])).get(row.id) ?? [];
  const members = await memberNames(executor, [
    row.handledByMemberId,
    row.closedByMemberId,
    ...events.map((event) => event.actorMemberId),
  ]);
  const [cityRow] = await executor
    .select({ name: city.nameRu })
    .from(supplierLocation)
    .innerJoin(city, eq(city.id, supplierLocation.cityId))
    .where(eq(supplierLocation.id, row.locationId));
  return {
    ...summary!,
    version: row.version,
    updatedAt: iso(row.updatedAt),
    terms: termsOf(row),
    comment: row.comment,
    cityName: cityRow?.name ?? row.offerSnapshot.location.cityName,
    phoneRevealedAt: row.phoneRevealedAt ? iso(row.phoneRevealedAt) : null,
    decline: declineOf(row),
    discipline,
    events: events.map((event) => eventOf(event, members, "admin")),
  };
}

/**
 * The order on the scanner's screen (S-SCAN-03): the item, the quantity and
 * the sum — never the code, the QR or the customer's phone number. The
 * phone belongs to the card of an accepted order, not to a screen anyone
 * reaches by typing six digits.
 */
export function scanOrderView(row: OrderRow, lang: CatalogLanguage): SupplierScanOrder {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    version: row.version,
    isTest: row.isTest,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    total: row.total,
    currency: row.currency,
    fulfillment: row.fulfillment,
    item: itemOf(row, lang),
    receiptOn: row.receiptOn,
    createdAt: iso(row.createdAt),
  };
}

/** The conflict's «who moved it last», for the supplier and the administrator. */
export async function lastActionOf(
  executor: DbExecutor,
  last: OrderEventRow | null,
): Promise<{ action: OrderEventRow["action"]; at: string; actor: OrderActor } | undefined> {
  if (!last) {
    return undefined;
  }
  const members = await memberNames(executor, [last.actorMemberId]);
  return { action: last.action, at: iso(last.createdAt), actor: actorOf(last, members) };
}
