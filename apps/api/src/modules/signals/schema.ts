import type { AdminSignalKind, AdminSignalPayload, AdminSignalStatus } from "@adclub/contracts";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The Drizzle mirror of `admin_signal`
 * (`infra/migrations/…_close-orders.sql` — the source of truth;
 * ARCHITECTURE 5.11, 6.5, 4.32). One open signal of a kind per subject:
 * the same fact coming up again counts up in that row instead of piling up
 * into a list nobody can read.
 */
export const adminSignal = pgTable("admin_signal", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<AdminSignalKind>().notNull(),
  subjectType: text("subject_type").$type<"order" | "supplier">().notNull(),
  subjectId: uuid("subject_id").notNull(),
  status: text("status").$type<AdminSignalStatus>().notNull().default("open"),
  payload: jsonb("payload").$type<AdminSignalPayload>().notNull().default({}),
  times: integer("times").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdminSignalRow = typeof adminSignal.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const signalTables = [adminSignal];
