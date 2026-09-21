import type {
  CatalogLanguage,
  CitySource,
  CityStatus,
  DayHours,
  SupplierInvitationStatus,
  SupplierLeadSource,
  SupplierLeadStatusValue,
  SupplierType,
} from "@adclub/contracts";
import {
  boolean,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUser, supplier, supplierMember } from "../identity";

/**
 * Drizzle mirrors of the tables of `…_create-suppliers.sql` (ARCHITECTURE
 * 5.5, 4.26; TASK-016) — the migration is the source of truth; the schema
 * drift check keeps them equal. `supplier` itself is described in the
 * identity schema (memberships and sessions point at it).
 */

/** `city`: the directory of cities; names in kk/ru/en written by hand. */
export const city = pgTable("city", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  nameRu: text("name_ru").notNull(),
  nameKk: text("name_kk"),
  nameEn: text("name_en"),
  timeZone: text("time_zone").notNull().default("Asia/Almaty"),
  sort: integer("sort").notNull().default(0),
  status: text("status").$type<CityStatus>().notNull().default("active"),
  source: text("source").$type<CitySource>().notNull().default("manual"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CityRow = typeof city.$inferSelect;

/** `supplier_location`: the pickup point, exactly one per supplier in the MVP. */
export const supplierLocation = pgTable("supplier_location", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  cityId: uuid("city_id")
    .notNull()
    .references(() => city.id),
  address: text("address"),
  district: text("district"),
  isDefault: boolean("is_default").notNull().default(true),
  /** Seven days, Monday first; `null` — not given yet. */
  weeklyHours: jsonb("weekly_hours").$type<DayHours[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupplierLocationRow = typeof supplierLocation.$inferSelect;

/** `supplier_closed_date`: a date the pickup point doesn't work. */
export const supplierClosedDate = pgTable("supplier_closed_date", {
  id: uuid("id").primaryKey().defaultRandom(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => supplierLocation.id),
  closedOn: date("closed_on").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `supplier_lead`: a connection request (the funnel, A-SUP-01). */
export const supplierLead = pgTable("supplier_lead", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyName: text("company_name").notNull(),
  bin: text("bin").notNull(),
  cityId: uuid("city_id")
    .notNull()
    .references(() => city.id),
  type: text("type").$type<SupplierType>().notNull(),
  contactName: text("contact_name").notNull(),
  phone: text("phone").notNull(),
  source: text("source").$type<SupplierLeadSource>().notNull(),
  status: text("status").$type<SupplierLeadStatusValue>().notNull().default("new"),
  rejectReason: text("reject_reason"),
  language: text("language").$type<CatalogLanguage>(),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  consentVersion: text("consent_version"),
  supplierId: uuid("supplier_id").references(() => supplier.id),
  createdByAdminId: uuid("created_by_admin_id").references(() => adminUser.id),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupplierLeadRow = typeof supplierLead.$inferSelect;

/** `supplier_lead_note`: what the administrator wrote about a request. */
export const supplierLeadNote = pgTable("supplier_lead_note", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => supplierLead.id),
  text: text("text").notNull(),
  authorAdminId: uuid("author_admin_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `supplier_invitation`: one sending of the invitation to an employee (W-08). */
export const supplierInvitation = pgTable(
  "supplier_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => supplier.id),
    memberId: uuid("member_id").notNull(),
    status: text("status").$type<SupplierInvitationStatus>().notNull().default("queued"),
    channel: text("channel").$type<"test" | "whatsapp" | "sms">(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    requestedByAdminId: uuid("requested_by_admin_id").references(() => adminUser.id),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The employee belongs to that supplier.
    foreignKey({
      columns: [table.memberId, table.supplierId],
      foreignColumns: [supplierMember.id, supplierMember.supplierId],
      name: "supplier_invitation_member_fkey",
    }),
  ],
);

export type SupplierInvitationRow = typeof supplierInvitation.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const supplierTables = [
  city,
  supplierLocation,
  supplierClosedDate,
  supplierLead,
  supplierLeadNote,
  supplierInvitation,
];
