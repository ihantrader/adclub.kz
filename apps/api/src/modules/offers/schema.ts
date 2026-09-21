import type { OfferAvailability, OfferStatusValue, OfferWithdrawnReason } from "@adclub/contracts";
import { boolean, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { supplier } from "../identity";

/**
 * The Drizzle mirror of `offer` (`infra/migrations/…_create-offers.sql` —
 * the source of truth, with the checks and keys that hold the rules;
 * ARCHITECTURE 5.5, 4.28). The composite foreign keys (the point and the
 * employees of the same supplier, the item with its type) are in the
 * database; the drift check doesn't compare them.
 */
export const offer = pgTable("offer", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  locationId: uuid("location_id").notNull(),
  itemId: uuid("item_id").notNull(),
  itemType: text("item_type").$type<"part" | "generic">().notNull(),
  price: integer("price").notNull(),
  currency: text("currency").$type<"KZT">().notNull().default("KZT"),
  availability: text("availability").$type<OfferAvailability>().notNull(),
  leadDays: smallint("lead_days").notNull().default(0),
  pickup: boolean("pickup").notNull(),
  delivery: boolean("delivery").notNull(),
  warrantyMonths: smallint("warranty_months"),
  warrantyText: text("warranty_text"),
  supplierSku: text("supplier_sku"),
  supplierRawName: text("supplier_raw_name"),
  status: text("status").$type<OfferStatusValue>().notNull().default("active"),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnReason: text("withdrawn_reason").$type<OfferWithdrawnReason>(),
  lastImportId: uuid("last_import_id"),
  lastSeenInImportAt: timestamp("last_seen_in_import_at", { withTimezone: true }),
  createdByMemberId: uuid("created_by_member_id"),
  updatedByMemberId: uuid("updated_by_member_id"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OfferRow = typeof offer.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const offerTables = [offer];
