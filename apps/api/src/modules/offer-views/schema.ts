import type { OfferViewerKind } from "@adclub/contracts";
import { date, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { supplier } from "../identity";
import { offer } from "../offers";

/**
 * The Drizzle mirror of `offer_view_event` and `offer_view_daily`
 * (`infra/migrations/1792400000000_offer-views.sql` — the source of truth,
 * with the checks; ARCHITECTURE 5.8, 4.88).
 *
 * - `offer_view_event` — one row per offer, day of Almaty and viewer, only to
 *   keep a second look of the same viewer that day from counting again. The
 *   key is an HMAC of the viewer with the day: it names nobody and links no
 *   two days of one person. Deleted after `offer_view_retention_days`.
 * - `offer_view_daily` — the totals of an offer a day by kind of viewer; they
 *   stay and are all anybody reads.
 */
export const offerViewEvent = pgTable(
  "offer_view_event",
  {
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    viewerKey: text("viewer_key").notNull(),
    viewerKind: text("viewer_kind").$type<OfferViewerKind>().notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => supplier.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      name: "offer_view_event_pkey",
      columns: [table.offerId, table.day, table.viewerKey],
    }),
  ],
);

export const offerViewDaily = pgTable(
  "offer_view_daily",
  {
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    viewerKind: text("viewer_kind").$type<OfferViewerKind>().notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => supplier.id, { onDelete: "cascade" }),
    views: integer("views").notNull(),
  },
  (table) => [
    primaryKey({
      name: "offer_view_daily_pkey",
      columns: [table.offerId, table.day, table.viewerKind],
    }),
  ],
);

/** Every table this module owns — checked against the migrated database. */
export const offerViewTables = [offerViewEvent, offerViewDaily];
