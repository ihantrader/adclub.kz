import { integer, pgTable, date, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { supplier } from "../identity";

/**
 * The Drizzle mirror of `supplier_moderation_digest`
 * (`infra/migrations/1792450000000_moderation-digest.sql` — the source of
 * truth, with the checks; TASK-071, ARCHITECTURE 4.89): one W-06 per company
 * and day of Almaty, with the numbers it said.
 */
export const supplierModerationDigest = pgTable(
  "supplier_moderation_digest",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => supplier.id),
    day: date("day", { mode: "string" }).notNull(),
    added: integer("added").notNull(),
    rejected: integer("rejected").notNull(),
    recipients: integer("recipients").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("supplier_moderation_digest_day_key").on(table.supplierId, table.day)],
);

export type SupplierModerationDigestRow = typeof supplierModerationDigest.$inferSelect;

export const moderationTables = [supplierModerationDigest];
