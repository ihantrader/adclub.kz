import {
  boolean,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AttributeValueSource,
  AttributeValueType,
  CatalogEntryStatus,
  CatalogItemStatus,
  CatalogItemType,
  CategoryKind,
  CategoryStatus,
  ItemAnalogStatus,
  ItemCompleteness,
} from "@adclub/contracts";

/**
 * Drizzle mirrors of the catalog structure tables (`infra/migrations`,
 * `…_create-catalog-structure.sql` — the source of truth, with the checks
 * and foreign keys that hold two levels; ARCHITECTURE 5.2, 5.4, 4.15).
 */

export type TranslationEntityType = "category" | "attribute" | "attribute_option" | "catalog_item";
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
  /** The model and the call (`ai_job`) of an automatic translation (TASK-012). */
  aiModel: text("ai_model"),
  aiJobId: uuid("ai_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TranslationTaskFailure =
  "empty" | "too_long" | "control_characters" | "wrong_language" | "name_taken";

/**
 * Translations still to be made (`…_create-ai-jobs-and-translation-tasks.sql`;
 * ARCHITECTURE 4.19, TASK-012): one row per entity, field and target language.
 */
export const translationTask = pgTable("translation_task", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityType: text("entity_type").$type<TranslationEntityType>().notNull(),
  entityId: uuid("entity_id").notNull(),
  field: text("field").$type<TranslationField>().notNull(),
  lang: text("lang").$type<"kk" | "en">().notNull(),
  sourceHash: text("source_hash").notNull(),
  status: text("status").$type<"pending" | "failed">().notNull().default("pending"),
  failure: text("failure").$type<TranslationTaskFailure>(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** The administrator who asked for this translation; `null` — nobody in particular (TASK-053). */
  requestedBy: uuid("requested_by"),
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Items of the catalog (`…_create-catalog-items.sql`; ARCHITECTURE 5.2, 4.17; TASK-011). */
export const brand = pgTable("brand", {
  id: uuid("id").primaryKey().defaultRandom(),
  isOem: boolean("is_oem").notNull().default(false),
  status: text("status").$type<CatalogEntryStatus>().notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const brandSpelling = pgTable("brand_spelling", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id").notNull(),
  text: text("text").notNull(),
  key: text("key").notNull(),
  isName: boolean("is_name").notNull(),
});

export const catalogItem = pgTable("catalog_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemType: text("item_type").$type<CatalogItemType>().notNull(),
  categoryId: uuid("category_id").notNull(),
  categoryKind: text("category_kind").$type<CategoryKind>().notNull(),
  categoryLevel: smallint("category_level").notNull().default(2),
  brandId: uuid("brand_id"),
  article: text("article"),
  articleNorm: text("article_norm"),
  status: text("status").$type<CatalogItemStatus>().notNull().default("active"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  completeness: text("completeness").$type<ItemCompleteness>().notNull().default("complete"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const itemAttributeValue = pgTable(
  "item_attribute_value",
  {
    itemId: uuid("item_id").notNull(),
    attributeId: uuid("attribute_id").notNull(),
    attributeValueType: text("attribute_value_type").$type<AttributeValueType>().notNull(),
    valueNum: numeric("value_num"),
    valueOptionId: uuid("value_option_id"),
    valueBool: boolean("value_bool"),
    valueText: text("value_text"),
    source: text("source").$type<AttributeValueSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.attributeId] })],
);

export const itemAnalog = pgTable(
  "item_analog",
  {
    itemId: uuid("item_id").notNull(),
    analogItemId: uuid("analog_item_id").notNull(),
    categoryId: uuid("category_id").notNull(),
    itemType: text("item_type").notNull().default("part"),
    relation: text("relation").notNull().default("analog_of"),
    status: text("status").$type<ItemAnalogStatus>().notNull().default("approved"),
    source: text("source").$type<"admin" | "supplier" | "ai">().notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.analogItemId] })],
);

export type CategoryRow = typeof category.$inferSelect;
export type AttributeRow = typeof attribute.$inferSelect;
export type AttributeOptionRow = typeof attributeOption.$inferSelect;
export type TranslationRow = typeof translation.$inferSelect;
export type TranslationTaskRow = typeof translationTask.$inferSelect;
export type BrandRow = typeof brand.$inferSelect;
export type BrandSpellingRow = typeof brandSpelling.$inferSelect;
export type CatalogItemRow = typeof catalogItem.$inferSelect;
export type ItemAttributeValueRow = typeof itemAttributeValue.$inferSelect;

export const catalogTables = [
  category,
  attribute,
  attributeOption,
  translation,
  translationTask,
  brand,
  brandSpelling,
  catalogItem,
  itemAttributeValue,
  itemAnalog,
];
