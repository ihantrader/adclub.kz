import type { SupplierRatingFigures, SupplierRatingRules } from "@adclub/contracts";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { supplier } from "../identity";

/**
 * The Drizzle mirror of `supplier_rating` and `supplier_rating_history`
 * (`infra/migrations/…_supplier-ratings.sql` — the source of truth, with the
 * checks; ARCHITECTURE 5.9, 4.71). The numeric columns come back as numbers
 * (`mode: "number"`): a rating has one decimal, a share four.
 */
export const supplierRating = pgTable("supplier_rating", {
  supplierId: uuid("supplier_id")
    .primaryKey()
    .references(() => supplier.id),
  score: numeric("score", { precision: 2, scale: 1, mode: "number" }),
  isNew: boolean("is_new").notNull(),
  reviewsCount: integer("reviews_count").notNull(),
  reviewsAverage: numeric("reviews_average", { precision: 3, scale: 2, mode: "number" }),
  answeredCount: integer("answered_count").notNull(),
  answerRequiredCount: integer("answer_required_count").notNull(),
  keptCount: integer("kept_count").notNull(),
  judgedCount: integer("judged_count").notNull(),
  responseRate: numeric("response_rate", { precision: 5, scale: 4, mode: "number" }),
  onTimeRate: numeric("on_time_rate", { precision: 5, scale: 4, mode: "number" }),
  formulaVersion: integer("formula_version").notNull(),
  rules: jsonb("rules").$type<SupplierRatingRules>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
});

export type SupplierRatingRow = typeof supplierRating.$inferSelect;

export const supplierRatingHistory = pgTable("supplier_rating_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  cause: text("cause").$type<"event" | "reconcile">().notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  before: jsonb("before").$type<SupplierRatingFigures>().notNull(),
  after: jsonb("after").$type<SupplierRatingFigures>().notNull(),
});

export type SupplierRatingHistoryRow = typeof supplierRatingHistory.$inferSelect;

export const ratingTables = [supplierRating, supplierRatingHistory];
