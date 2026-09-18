import {
  boolean,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AttributeValueType,
  CatalogEntryStatus,
  CategoryKind,
  CategoryStatus,
} from "@adclub/contracts";

/**
 * Drizzle mirrors of the catalog structure tables (`infra/migrations`,
 * `…_create-catalog-structure.sql` — the source of truth, with the checks
 * and foreign keys that hold two levels; ARCHITECTURE 5.2, 5.4, 4.15).
 */

export type TranslationEntityType = "category" | "attribute" | "attribute_option";
export type TranslationField = "name" | "unit";
export type TranslationOrigin = "source" | "manual" | "ai";

export const category = pgTable("category", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  kind: text("kind").$type<CategoryKind>().notNull(),
  level: smallint("level").$type<1 | 2>().notNull(),
  parentId: uuid("parent_id"),
  parentLevel: smallint("parent_level"),
  sort: integer("sort").notNull().default(0),
  status: text("status").$type<CategoryStatus>().notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  icon: text("icon"),
  compatibilityRequired: boolean("compatibility_required").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attribute = pgTable("attribute", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: uuid("category_id").notNull(),
  categoryLevel: smallint("category_level").notNull().default(2),
  code: text("code").notNull(),
  valueType: text("value_type").$type<AttributeValueType>().notNull(),
  numberInteger: boolean("number_integer"),
  numberMin: numeric("number_min"),
  numberMax: numeric("number_max"),
  isFilterable: boolean("is_filterable").notNull().default(false),
  isRequiredForComplete: boolean("is_required_for_complete").notNull().default(false),
  sort: integer("sort").notNull().default(0),
  status: text("status").$type<CatalogEntryStatus>().notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attributeOption = pgTable("attribute_option", {
  id: uuid("id").primaryKey().defaultRandom(),
  attributeId: uuid("attribute_id").notNull(),
  attributeValueType: text("attribute_value_type").notNull().default("enum"),
  code: text("code").notNull(),
  sort: integer("sort").notNull().default(0),
  status: text("status").$type<CatalogEntryStatus>().notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `translation` (ARCHITECTURE 5.4): texts of reference data, the model TASK-012 builds on. */
export const translation = pgTable("translation", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").$type<TranslationEntityType>().notNull(),
  entityId: uuid("entity_id").notNull(),
  field: text("field").$type<TranslationField>().notNull(),
  lang: text("lang").$type<"kk" | "ru" | "en">().notNull(),
  text: text("text").notNull(),
  origin: text("origin").$type<TranslationOrigin>().notNull(),
  isManuallyEdited: boolean("is_manually_edited").notNull(),
  sourceHash: text("source_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CategoryRow = typeof category.$inferSelect;
export type AttributeRow = typeof attribute.$inferSelect;
export type AttributeOptionRow = typeof attributeOption.$inferSelect;
export type TranslationRow = typeof translation.$inferSelect;

export const catalogTables = [category, attribute, attributeOption, translation];
