import type {
  OfferAvailability,
  OfferPriceMode,
  OfferStatusValue,
  OfferWithdrawnReason,
} from "@adclub/contracts";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
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
  itemType: text("item_type").$type<"part" | "generic" | "service">().notNull(),
  /** The lowest of the model prices when `priceMode` is `by_model` (kept so by the database). */
  price: integer("price").notNull(),
  priceMode: text("price_mode").$type<OfferPriceMode>().notNull().default("single"),
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

/**
 * The price of a service for a model of the car (TASK-019, S-OFF-04): one
 * row per model of an offer priced `by_model` (`…_service-offers.sql`).
 */
export const offerModelPrice = pgTable(
  "offer_model_price",
  {
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id),
    vehicleModelId: uuid("vehicle_model_id").notNull(),
    price: integer("price").notNull(),
  },
  (table) => [
    primaryKey({ name: "offer_model_price_pkey", columns: [table.offerId, table.vehicleModelId] }),
  ],
);

export type OfferModelPriceRow = typeof offerModelPrice.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const offerTables = [offer, offerModelPrice];
