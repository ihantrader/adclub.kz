import type {
  DisciplineKind,
  OfferSnapshot,
  OrderCloseMethod,
  OrderDeclineReason,
  OrderEventAction,
  OrderFulfillment,
  OrderKind,
  OrderStatusValue,
} from "@adclub/contracts";
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { account, adminUser, supplier, supplierMember } from "../identity";

/**
 * The Drizzle mirror of `customer_order` and `order_event`
 * (`infra/migrations/…_create-orders.sql` — the source of truth, with the
 * checks, the composite keys and the append-only trigger; ARCHITECTURE
 * 5.7, 6.1, 4.31). The table is `customer_order` because ORDER is a
 * reserved word of SQL.
 */
export const customerOrder = pgTable("customer_order", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: bigint("number", { mode: "number" })
    .notNull()
    .default(sql`nextval('customer_order_number_seq')`),
  kind: text("kind").$type<OrderKind>().notNull().default("stock"),
  userAccountId: uuid("user_account_id")
    .notNull()
    .references(() => account.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  locationId: uuid("location_id").notNull(),
  offerId: uuid("offer_id").notNull(),
  itemId: uuid("item_id").notNull(),
  offerSnapshot: jsonb("offer_snapshot").$type<OfferSnapshot>().notNull(),
  unitPrice: integer("unit_price").notNull(),
  quantity: integer("quantity").notNull(),
  total: bigint("total", { mode: "number" }).notNull(),
  currency: text("currency").$type<"KZT">().notNull().default("KZT"),
  fulfillment: text("fulfillment").$type<OrderFulfillment>().notNull(),
  comment: text("comment"),
  status: text("status").$type<OrderStatusValue>().notNull().default("created"),
  isTest: boolean("is_test").notNull().default(false),
  confirmationCode: text("confirmation_code").notNull(),
  qrToken: text("qr_token").notNull(),
  /**
   * The code of this order is its own while this is `null`: the unique
   * index stands on it, so no other order is given the same digits while
   * this one can still be closed (TASK-022).
   */
  codeReleasedAt: timestamp("code_released_at", { withTimezone: true }),
  /** Cleared by the cleanup job once no repeat of the creation can arrive. */
  idempotencyKey: uuid("idempotency_key"),
  respondBy: timestamp("respond_by", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  reserveWarnAt: timestamp("reserve_warn_at", { withTimezone: true }),
  reserveWarnedAt: timestamp("reserve_warned_at", { withTimezone: true }),
  receiptOn: date("receipt_on"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  phoneRevealedAt: timestamp("phone_revealed_at", { withTimezone: true }),
  handledByMemberId: uuid("handled_by_member_id"),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  declineReason: text("decline_reason").$type<OrderDeclineReason>(),
  declineNote: text("decline_note"),
  /** How the order was given out (TASK-022): the code, the QR or the administrator. */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closeMethod: text("close_method").$type<OrderCloseMethod>(),
  closedByMemberId: uuid("closed_by_member_id"),
  closedByAdminId: uuid("closed_by_admin_id").references(() => adminUser.id),
  closedLate: boolean("closed_late").notNull().default(false),
  /** Why the administrator closed it without a code; their view only (D-043). */
  closeReason: text("close_reason"),
  /** Until when an expired pickup reserve may still be given out (PRODUCT 10.7). */
  lateCloseUntil: timestamp("late_close_until", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OrderRow = typeof customerOrder.$inferSelect;

export type OrderEventActorType = "user" | "supplier_member" | "admin" | "system";
export type OrderEventChannel = "app" | "supplier_web" | "admin" | "timer" | "whatsapp";

export const orderEvent = pgTable("order_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => customerOrder.id),
  action: text("action").$type<OrderEventAction>().notNull(),
  fromStatus: text("from_status").$type<OrderStatusValue>(),
  toStatus: text("to_status").$type<OrderStatusValue>(),
  actorType: text("actor_type").$type<OrderEventActorType>().notNull(),
  actorAccountId: uuid("actor_account_id").references(() => account.id),
  actorMemberId: uuid("actor_member_id").references(() => supplierMember.id),
  actorAdminId: uuid("actor_admin_id").references(() => adminUser.id),
  channel: text("channel").$type<OrderEventChannel>().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OrderEventRow = typeof orderEvent.$inferSelect;

/**
 * The club's own discipline statistics of a user (PRODUCT 10.5;
 * ARCHITECTURE 5.7, 4.32; TASK-022): the pickup reserve of an order the
 * supplier had accepted ran out and nobody came. A mark is never deleted —
 * a late close, a close by the administrator or the administrator's own
 * hand mark it as lifted, and A-USR-02 shows those too. The user is shown
 * none of this anywhere and the supplier's rating never feels it.
 */
export const userDisciplineEvent = pgTable("user_discipline_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  userAccountId: uuid("user_account_id")
    .notNull()
    .references(() => account.id),
  orderId: uuid("order_id")
    .notNull()
    .references(() => customerOrder.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  kind: text("kind").$type<DisciplineKind>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedBy: text("revoked_by").$type<"late_close" | "admin_close" | "admin">(),
  revokedNote: text("revoked_note"),
  revokedByAdminId: uuid("revoked_by_admin_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DisciplineRow = typeof userDisciplineEvent.$inferSelect;

/**
 * The SQL twin of `countsInStatistics` (`@adclub/domain`, ARCHITECTURE
 * 4.33): the orders a supplier is judged by. An employee's own order with
 * their company is a test one and counts nowhere (PRODUCT 12.6). Every
 * counter that judges a supplier — the signal of D-043, the rating of
 * TASK-050, the dashboard of TASK-034 — stands on this condition or on
 * the function, never on a rule written again. The counters of the
 * cabinet's tabs are not such a counter: they are the company's own work
 * queue, and a test order still needs an answer.
 */
export function inSupplierStatistics(): SQL {
  return sql`${customerOrder.isTest} = false`;
}

/** Every table this module owns — checked against the migrated database. */
export const orderTables = [customerOrder, orderEvent, userDisciplineEvent];
