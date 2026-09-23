import type {
  OfferSnapshot,
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
import { sql } from "drizzle-orm";
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
  idempotencyKey: uuid("idempotency_key").notNull(),
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

/** Every table this module owns — checked against the migrated database. */
export const orderTables = [customerOrder, orderEvent];
