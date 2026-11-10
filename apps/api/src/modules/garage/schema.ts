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
  /** 17 characters, upper case (TASK-057, D-064). */
  vin: text("vin"),
  /** Compact, `123ABC02` / `A123BCD`. */
  plate: text("plate"),
  /** `shown` / `unconfirmed`; `null` — a car added before TASK-057. */
  documentStatus: text("document_status").$type<"shown" | "unconfirmed">(),
  documentAt: timestamp("document_at", { withTimezone: true }),
  /** The key of the adding that made this car (TASK-029.B); `null` — added without one. */
  idempotencyKey: uuid("idempotency_key"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AccountCarRow = typeof accountCar.$inferSelect;

/**
 * Drizzle mirror of `mileage_log` (`infra/migrations/…_mileage-log.sql` —
 * the source of truth; ARCHITECTURE 5.8, 4.83; TASK-058): the readings a
 * person confirmed, with what the recognition read next to them.
 * `ai_job_id` is a plain uuid here for the same cross-module reason as the
 * vehicle ids above (the migration carries the foreign key).
 */
export const mileageLog = pgTable("mileage_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  carId: uuid("car_id")
    .notNull()
    .references(() => accountCar.id, { onDelete: "cascade" }),
  valueKm: integer("value_km").notNull(),
  source: text("source").$type<"text" | "photo" | "voice" | "prompt">().notNull(),
  recognizedKm: integer("recognized_km"),
  aiJobId: uuid("ai_job_id"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  recordedBy: uuid("recorded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MileageLogRow = typeof mileageLog.$inferSelect;

export const garageTables = [accountCar, mileageLog];
