import type {
  ComplaintReasonValue,
  ComplaintStatusValue,
  ReviewHoldReason,
  ReviewRejectReason,
  ReviewStatusValue,
} from "@adclub/contracts";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { account, adminUser, supplier } from "../identity";
import { customerOrder } from "../orders";

/**
 * The Drizzle mirror of `review` and `complaint`
 * (`infra/migrations/…_reviews-and-complaints.sql` — the source of truth,
 * with the checks of the statuses and the unique indexes; ARCHITECTURE 5.9,
 * 4.69). The author is a reference to the account: the name is read when a
 * page is read.
 */
export const review = pgTable("review", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => customerOrder.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  userAccountId: uuid("user_account_id")
    .notNull()
    .references(() => account.id),
  score: smallint("score").notNull(),
  text: text("text"),
  status: text("status").$type<ReviewStatusValue>().notNull(),
  /** The reasons of the latest check (`held`); empty — none. */
  holdReasons: jsonb("hold_reasons").$type<ReviewHoldReason[]>().notNull().default([]),
  /** The author corrected a refused text (once). */
  edited: boolean("edited").notNull().default(false),
  /** Since when the text waits for its check (`checking` only). */
  checkingSince: timestamp("checking_since", { withTimezone: true }),
  rejectedReason: text("rejected_reason").$type<ReviewRejectReason>(),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedByAdminId: uuid("rejected_by_admin_id").references(() => adminUser.id),
  hiddenReason: text("hidden_reason"),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  hiddenByAdminId: uuid("hidden_by_admin_id").references(() => adminUser.id),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  idempotencyKey: uuid("idempotency_key").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReviewRow = typeof review.$inferSelect;

export const complaint = pgTable("complaint", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => customerOrder.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  userAccountId: uuid("user_account_id")
    .notNull()
    .references(() => account.id),
  reason: text("reason").$type<ComplaintReasonValue>().notNull(),
  text: text("text"),
  status: text("status").$type<ComplaintStatusValue>().notNull().default("new"),
  /** The administrator's internal comment at «Решить»; never the user's. */
  comment: text("comment"),
  takenAt: timestamp("taken_at", { withTimezone: true }),
  takenByAdminId: uuid("taken_by_admin_id").references(() => adminUser.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByAdminId: uuid("resolved_by_admin_id").references(() => adminUser.id),
  idempotencyKey: uuid("idempotency_key").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ComplaintRow = typeof complaint.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const reviewTables = [review, complaint];
