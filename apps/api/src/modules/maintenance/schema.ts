import { integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  MaintenanceItemKind,
  MaintenanceItemStatus,
  MaintenancePlanSource,
  MaintenancePlanStatus,
  ShowcaseAttributeFilter,
} from "@adclub/contracts";

/**
 * Drizzle mirrors of the maintenance plan tables (`infra/migrations`,
 * `…_maintenance-plans.sql` — the source of truth, with the checks and the
 * unique indexes that hold the rules; ARCHITECTURE 5, 11.3, 4.84).
 */

export const maintenancePlan = pgTable("maintenance_plan", {
  id: uuid("id").primaryKey().defaultRandom(),
  makeId: uuid("make_id").notNull(),
  modelId: uuid("model_id"),
  generationId: uuid("generation_id"),
  engineId: uuid("engine_id"),
  name: text("name").notNull(),
  source: text("source").$type<MaintenancePlanSource>().notNull(),
  status: text("status").$type<MaintenancePlanStatus>().notNull().default("draft"),
  generatingSince: timestamp("generating_since", { withTimezone: true }),
  aiJobId: uuid("ai_job_id"),
  copiedFromId: uuid("copied_from_id"),
  createdByAdminId: uuid("created_by_admin_id"),
  confirmedByAdminId: uuid("confirmed_by_admin_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const maintenancePlanItem = pgTable("maintenance_plan_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull(),
  position: integer("position").notNull().default(0),
  kind: text("kind").$type<MaintenanceItemKind>().notNull(),
  intervalKm: integer("interval_km"),
  intervalMonths: smallint("interval_months"),
  firstKm: integer("first_km"),
  firstMonths: smallint("first_months"),
  serviceCodes: text("service_codes").array().notNull().default([]),
  targetKind: text("target_kind").$type<"category" | "items">(),
  targetCategoryId: uuid("target_category_id"),
  targetCategoryKind: text("target_category_kind").$type<"goods" | "services">(),
  targetCategoryLevel: smallint("target_category_level").notNull().default(2),
  targetAttributes: jsonb("target_attributes")
    .$type<ShowcaseAttributeFilter[]>()
    .notNull()
    .default([]),
  targetItemIds: uuid("target_item_ids").array().notNull().default([]),
  quantity: smallint("quantity"),
  note: text("note"),
  status: text("status").$type<MaintenanceItemStatus>().notNull().default("active"),
  confirmedByAdminId: uuid("confirmed_by_admin_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MaintenancePlanRow = typeof maintenancePlan.$inferSelect;
export type MaintenancePlanItemRow = typeof maintenancePlanItem.$inferSelect;

export const maintenanceTables = [maintenancePlan, maintenancePlanItem];
