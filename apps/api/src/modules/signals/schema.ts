import type {
  AdminSignalKind,
  AdminSignalPayload,
  AdminSignalStatus,
  AdminSignalSubject,
} from "@adclub/contracts";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The Drizzle mirror of `admin_signal`
 * (`infra/migrations/…_close-orders.sql`, `…_admin-signal-actions.sql` — the
 * source of truth; ARCHITECTURE 5.11, 6.5, 4.32, 4.52). One signal of a kind
 * per subject that is not closed: the same fact coming up again counts up in
 * that row instead of piling up into a list nobody can read.
 */
export const adminSignal = pgTable("admin_signal", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<AdminSignalKind>().notNull(),
  subjectType: text("subject_type").$type<AdminSignalSubject>().notNull(),
  subjectId: uuid("subject_id").notNull(),
  status: text("status").$type<AdminSignalStatus>().notNull().default("open"),
  payload: jsonb("payload").$type<AdminSignalPayload>().notNull().default({}),
  times: integer("times").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** When it was closed (by the server — the fact is over — or by an administrator); `null` — it is not. */
  closedAt: timestamp("closed_at", { withTimezone: true }),
  /** Grows with each move of the status (TASK-034); a repeated fact doesn't touch it. */
  version: integer("version").notNull().default(1),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedByAdminId: uuid("acknowledged_by_admin_id"),
  /** The administrator who closed it; `null` with `closedAt` — the server closed it. */
  closedByAdminId: uuid("closed_by_admin_id"),
  closeComment: text("close_comment"),
});

export type AdminSignalRow = typeof adminSignal.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const signalTables = [adminSignal];
