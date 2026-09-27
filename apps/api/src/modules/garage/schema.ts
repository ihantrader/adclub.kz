import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of `account_car` (`infra/migrations`,
 * `…_account-profile-and-garage.sql` — the source of truth; ARCHITECTURE
 * 4.41, 5.1; TASK-029). The vehicle catalog's ids are plain `uuid()` here,
 * without `.references()`, for the same cross-module reason as
 * `item_compatibility` (`modules/compatibility/schema.ts`) and `supplier`'s
 * `cityId`: this module does not import the vehicles module's schema, even
 * though the migration itself does carry the real foreign keys.
 */
export const accountCar = pgTable("account_car", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  makeId: uuid("make_id").notNull(),
  makeLabel: text("make_label").notNull(),
  modelId: uuid("model_id").notNull(),
  modelLabel: text("model_label").notNull(),
  year: integer("year"),
  generationId: uuid("generation_id"),
  generationLabel: text("generation_label"),
  bodyTypeId: uuid("body_type_id"),
  bodyTypeLabel: text("body_type_label"),
  engineId: uuid("engine_id"),
  engineLabel: text("engine_label"),
  transmissionTypeId: uuid("transmission_type_id"),
  transmissionTypeLabel: text("transmission_type_label"),
  driveTypeId: uuid("drive_type_id"),
  driveTypeLabel: text("drive_type_label"),
  modificationId: uuid("modification_id"),
  color: text("color"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AccountCarRow = typeof accountCar.$inferSelect;

export const garageTables = [accountCar];
