import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ReminderBasisSource } from "@adclub/contracts";

/**
 * Drizzle mirror of `maintenance_reminder` (`infra/migrations/
 * …_maintenance-reminders.sql` — the source of truth; ARCHITECTURE 5.8,
 * 4.87; TASK-069): what is kept of a reminder of a car's element — the
 * replacement the person marked («Уже поменял»), «Напомнить позже», the push
 * sent for the current replacement, and what the daily job last counted
 * from (for the admin panel). The count itself is made anew every time by
 * `reminderState`. The foreign keys are in the migration (cross-module).
 */
export const maintenanceReminder = pgTable("maintenance_reminder", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  carId: uuid("car_id").notNull(),
  planItemId: uuid("plan_item_id").notNull(),
  doneKm: integer("done_km"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  lastSource: text("last_source").$type<ReminderBasisSource>(),
  lastKm: integer("last_km"),
  lastAt: timestamp("last_at", { withTimezone: true }),
  lastOrderId: uuid("last_order_id"),
  dueKm: integer("due_km"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  notifiedCycle: text("notified_cycle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MaintenanceReminderRow = typeof maintenanceReminder.$inferSelect;

export const reminderTables = [maintenanceReminder];
