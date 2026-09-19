import { z } from "zod";
import {
  adminAttributeSchema,
  adminCategorySchema,
  catalogEntryStatusSchema,
  catalogTextsSchema,
} from "./catalog";

/**
 * Items of the catalog (PRODUCT 7.1, 7.3–7.5, 11; ARCHITECTURE 5.2, 4.17;
 * TASK-011; SCREENS A-CAT-02…A-CAT-05): brands, items of three types, their
 * attribute values (one by one and in bulk) and analogs. Only the
 * administrator keeps them; clients see items with offers only (EPIC-07,
 * EPIC-10). Enum values here are only ever added (ARCHITECTURE 7.4).
 */

/**
 * - `part` — a spare part: a brand and the manufacturer's article, a
 *   category of goods; one article of one brand is one item;
 * - `generic` — a product described by attributes (engine oil, fluids): a
 *   brand, an optional article, a category of goods;
 * - `service` — no brand, no article, a category of services.
 *
 * The type never changes after creation.
 */
export const catalogItemTypeSchema = z.enum(["part", "generic", "service"]);

export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

/**
 * `draft` — being prepared (or came as a request, later); `active` — in the
 * catalog; `archived` — can't be chosen for new offers, history keeps it.
 * There is no deletion.
 */
export const catalogItemStatusSchema = z.enum(["draft", "active", "archived"]);

export type CatalogItemStatus = z.infer<typeof catalogItemStatusSchema>;

/**
 * `incomplete` — an active attribute of the category that counts for
 * completeness has no value (PRODUCT 7.4). A mark, never a block.
 */
export const itemCompletenessSchema = z.enum(["complete", "incomplete"]);

export type ItemCompleteness = z.infer<typeof itemCompletenessSchema>;

/** Who wrote a value: the administrator; import (EPIC-16) and AI arrive later. */
export const attributeValueSourceSchema = z.enum(["admin", "import", "ai"]);

export type AttributeValueSource = z.infer<typeof attributeValueSourceSchema>;

/** `approved` — shown next to the original; `proposed` — awaiting review (EPIC-07, moderation). */
export const itemAnalogStatusSchema = z.enum(["proposed", "approved"]);

export type ItemAnalogStatus = z.infer<typeof itemAnalogStatusSchema>;

export const BRAND_NAME_MAX_LENGTH = 60;
export const BRAND_ALIASES_MAX = 20;
export const CATALOG_ITEM_NAME_MAX_LENGTH = 200;
export const ARTICLE_MAX_LENGTH = 64;
export const ATTRIBUTE_TEXT_VALUE_MAX_LENGTH = 200;
/** Values one item's request may set at once. */
export const ITEM_VALUES_MAX = 100;
/** Cells one bulk fill request may change at once (ARCHITECTURE 4.17). */
export const CATALOG_FILL_MAX_CELLS = 500;
export const CATALOG_PAGE_MAX_SIZE = 100;
export const CATALOG_PAGE_DEFAULT_SIZE = 50;

const expectedVersionSchema = z.number().int().min(1);

function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(CATALOG_PAGE_MAX_SIZE)
  .default(CATALOG_PAGE_DEFAULT_SIZE);

/** The `nextCursor` of the previous page: the only way to ask for the next one. */
const cursorSchema = z.string().min(1).max(200);

/**
 * The value of one attribute, by its type: `number` — a number; `enum` —
 * the id of one of the attribute's options; `bool` — `true`/`false`;
 * `text` — a text. `null` — empty (no value).
 */
export const attributeValueSchema = z.union([z.number(), z.string(), z.boolean()]).nullable();

export type AttributeValue = z.infer<typeof attributeValueSchema>;

// ------------------------------------------------------------------ brands

export const adminBrandSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Other spellings (`GEELY Auto`), alphabetically. */
  aliases: z.array(z.string()),
  /** The original manufacturer (OEM) rather than an aftermarket brand. */
  isOem: z.boolean(),
  status: catalogEntryStatusSchema,
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminBrand = z.infer<typeof adminBrandSchema>;

export const brandIdPathSchema = z.object({ brandId: z.uuid() });

export type BrandIdPath = z.infer<typeof brandIdPathSchema>;

/**
 * `GET /admin/catalog/brands`: by name, `q` — a part of the name or of any
 * other spelling (case and spaces ignored).
 */
export const brandListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: catalogEntryStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type BrandListQuery = z.infer<typeof brandListQuerySchema>;

export const adminBrandPageSchema = z.object({
  brands: z.array(adminBrandSchema),
  /** Pass as `cursor` for the next page; `null` — this was the last one. */
  nextCursor: z.string().nullable(),
});

export type AdminBrandPage = z.infer<typeof adminBrandPageSchema>;

const brandSpellingSchema = plainText(BRAND_NAME_MAX_LENGTH);

/**
 * `POST /admin/catalog/brands`. The name and every other spelling are
 * unique among all brands, archived ones included, ignoring case and
 * spaces: `CATALOG_BRAND_SPELLING_TAKEN`.
 */
export const createBrandBodySchema = z.object({
  name: brandSpellingSchema,
  aliases: z.array(brandSpellingSchema).max(BRAND_ALIASES_MAX).optional(),
  isOem: z.boolean().optional(),
});

export type CreateBrandBody = z.infer<typeof createBrandBodySchema>;

/** `PATCH /admin/catalog/brands/{brandId}`: `aliases` replaces the whole list. */
export const updateBrandBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  name: brandSpellingSchema.optional(),
  aliases: z.array(brandSpellingSchema).max(BRAND_ALIASES_MAX).optional(),
  isOem: z.boolean().optional(),
});

export type UpdateBrandBody = z.infer<typeof updateBrandBodySchema>;

export const adminBrandResponseSchema = z.object({ brand: adminBrandSchema });

export type AdminBrandResponse = z.infer<typeof adminBrandResponseSchema>;

/** `details` of `CATALOG_BRAND_SPELLING_TAKEN`. */
export const catalogBrandSpellingTakenDetailsSchema = z.object({
  /** The spelling asked for. */
  spelling: z.string(),
  /** The brand that already has it. */
  conflictingBrandId: z.uuid(),
});

export type CatalogBrandSpellingTakenDetails = z.infer<
  typeof catalogBrandSpellingTakenDetailsSchema
>;

// ------------------------------------------------------------------- items

export const catalogItemBrandSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isOem: z.boolean(),
  status: catalogEntryStatusSchema,
});

export type CatalogItemBrand = z.infer<typeof catalogItemBrandSchema>;

export const adminCatalogItemSchema = z.object({
  id: z.uuid(),
  type: catalogItemTypeSchema,
  /** A subcategory: of goods for parts and products, of services for services. */
  categoryId: z.uuid(),
  /** `null` for a service. */
  brand: catalogItemBrandSchema.nullable(),
  /** As entered; `null` — none (a service, a product without one). */
  article: z.string().nullable(),
  /** `normalizeArticle(article)`: upper case, letters and digits only. */
  articleNorm: z.string().nullable(),
  names: catalogTextsSchema,
  status: catalogItemStatusSchema,
  completeness: itemCompletenessSchema,
  /** Pass it back as `expectedVersion` when changing the item or its values. */
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminCatalogItem = z.infer<typeof adminCatalogItemSchema>;

export const catalogItemIdPathSchema = z.object({ itemId: z.uuid() });

export type CatalogItemIdPath = z.infer<typeof catalogItemIdPathSchema>;

export const itemAnalogPathSchema = z.object({ itemId: z.uuid(), analogItemId: z.uuid() });

export type ItemAnalogPath = z.infer<typeof itemAnalogPathSchema>;

/** One value to write: `null` empties it. */
export const itemValueInputSchema = z.object({
  attributeId: z.uuid(),
  value: attributeValueSchema,
});

export type ItemValueInput = z.infer<typeof itemValueInputSchema>;

const itemNamesSchema = z.object({
  ru: plainText(CATALOG_ITEM_NAME_MAX_LENGTH),
  kk: plainText(CATALOG_ITEM_NAME_MAX_LENGTH).nullable().optional(),
  en: plainText(CATALOG_ITEM_NAME_MAX_LENGTH).nullable().optional(),
});

const itemNameChangesSchema = z.object({
  ru: plainText(CATALOG_ITEM_NAME_MAX_LENGTH).optional(),
  kk: plainText(CATALOG_ITEM_NAME_MAX_LENGTH).nullable().optional(),
  en: plainText(CATALOG_ITEM_NAME_MAX_LENGTH).nullable().optional(),
});

const articleSchema = plainText(ARTICLE_MAX_LENGTH);

/**
 * `POST /admin/catalog/items`. A part needs a brand and an article; a
 * product (`generic`) a brand, an article is optional; a service has
 * neither. A part with the brand and normalized article of another item, or
 * a product with the brand and every identifying value of another one in
 * its category — `CATALOG_ITEM_DUPLICATE` with the existing item.
 */
export const createCatalogItemBodySchema = z.object({
  type: catalogItemTypeSchema,
  categoryId: z.uuid(),
  brandId: z.uuid().nullable().optional(),
  article: articleSchema.nullable().optional(),
  names: itemNamesSchema,
  /** `active` when left out. */
  status: z.enum(["draft", "active"]).optional(),
  /** Values of the category's attributes, checked like `PUT …/values`. */
  values: z.array(itemValueInputSchema).max(ITEM_VALUES_MAX).optional(),
});

export type CreateCatalogItemBody = z.infer<typeof createCatalogItemBodySchema>;

/**
 * `PATCH /admin/catalog/items/{itemId}`: only the fields sent change.
 * `categoryId` — another subcategory of the same kind (values of the old
 * category's attributes don't carry over and are ignored there). `type` can't
 * change — it is accepted only to refuse a change explicitly.
 */
export const updateCatalogItemBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  categoryId: z.uuid().optional(),
  brandId: z.uuid().nullable().optional(),
  article: articleSchema.nullable().optional(),
  names: itemNameChangesSchema.optional(),
  type: catalogItemTypeSchema.optional(),
});

export type UpdateCatalogItemBody = z.infer<typeof updateCatalogItemBodySchema>;

/** `POST /admin/catalog/items/{itemId}/status`. */
export const setCatalogItemStatusBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  status: catalogItemStatusSchema,
});

export type SetCatalogItemStatusBody = z.infer<typeof setCatalogItemStatusBodySchema>;

/** `PUT /admin/catalog/items/{itemId}/values`: all or nothing; errors by value. */
export const setItemValuesBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  values: z.array(itemValueInputSchema).min(1).max(ITEM_VALUES_MAX),
});

export type SetItemValuesBody = z.infer<typeof setItemValuesBodySchema>;

/**
 * `GET /admin/catalog/items`, newest first. `q` finds an item by a part of
 * its normalized article (`04465 0k090` finds `04465-0K090`) or by a part of
 * its name in any language, ignoring case.
 */
export const catalogItemListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  type: catalogItemTypeSchema.optional(),
  status: catalogItemStatusSchema.optional(),
  completeness: itemCompletenessSchema.optional(),
  /**
   * `matching` — only products that are the same as another product of
   * their category and brand by every identifying value; such pairs appear
   * when the attributes that identify a product change (TASK-011.A).
   */
  sameProduct: z.enum(["matching"]).optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type CatalogItemListQuery = z.infer<typeof catalogItemListQuerySchema>;

export const adminCatalogItemPageSchema = z.object({
  items: z.array(adminCatalogItemSchema),
  /** How many items match the filters, over all pages. */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminCatalogItemPage = z.infer<typeof adminCatalogItemPageSchema>;

/** A value of the item card: every active attribute of the category, empty ones as `null`. */
export const itemAttributeValueSchema = z.object({
  attributeId: z.uuid(),
  value: attributeValueSchema,
  /** `null` — empty. */
  source: attributeValueSourceSchema.nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export type ItemAttributeValue = z.infer<typeof itemAttributeValueSchema>;

export const itemAnalogSchema = z.object({
  item: adminCatalogItemSchema,
  status: itemAnalogStatusSchema,
  source: z.enum(["admin", "supplier", "ai"]),
});

export type ItemAnalog = z.infer<typeof itemAnalogSchema>;

/**
 * The item card (SCREENS A-CAT-05): the item, its category, the active
 * attributes of the category with the item's values, which of them leave it
 * incomplete, and its analogs.
 */
export const adminCatalogItemCardSchema = z.object({
  item: adminCatalogItemSchema,
  category: adminCategorySchema,
  /** Active attributes of the category, in their order. */
  attributes: z.array(adminAttributeSchema),
  /** One per attribute above, in the same order. */
  values: z.array(itemAttributeValueSchema),
  /** Attributes that count for completeness and are empty. */
  missingAttributeIds: z.array(z.uuid()),
  /** Analogs of any status, newest link first. */
  analogs: z.array(itemAnalogSchema),
});

export type AdminCatalogItemCard = z.infer<typeof adminCatalogItemCardSchema>;

/** `POST /admin/catalog/items/{itemId}/analogs`. */
export const linkItemAnalogBodySchema = z.object({ analogItemId: z.uuid() });

export type LinkItemAnalogBody = z.infer<typeof linkItemAnalogBodySchema>;

/** `details` of `CATALOG_ITEM_DUPLICATE`: the item that already is this one. */
export const catalogItemDuplicateDetailsSchema = z.object({ existingItemId: z.uuid() });

export type CatalogItemDuplicateDetails = z.infer<typeof catalogItemDuplicateDetailsSchema>;

/**
 * `details.reason` of `CATALOG_ANALOG_INVALID`: `self` — an item isn't its
 * own analog; `not_part` — both must be parts; `other_category` — both must
 * be in one subcategory; `archived` — an archived item takes no new links.
 */
export const catalogAnalogInvalidDetailsSchema = z.object({
  reason: z.enum(["self", "not_part", "other_category", "archived"]),
});

export type CatalogAnalogInvalidDetails = z.infer<typeof catalogAnalogInvalidDetailsSchema>;

// -------------------------------------------------------- values in bulk

/**
 * Why one value of a request was refused:
 * - `conflict` — someone changed the cell since it was read (`currentValue`);
 * - `item_not_found` — no such item (in this category, for a fill);
 * - `attribute_not_found` — not an attribute of the item's category;
 * - `attribute_archived` — an archived attribute takes no new value;
 * - `wrong_type` — the value isn't of the attribute's type;
 * - `option_invalid` — not an active option of this attribute;
 * - `out_of_range`, `not_integer` — outside the bounds, or a fraction for a
 *   whole-number attribute;
 * - `too_long`, `empty_text` — a text over the limit, or only spaces;
 * - `repeated` — the same cell twice in one request;
 * - `duplicate_item` — with these values the product would be the same as
 *   another one (`existingItemId`).
 */
export const catalogValueRejectionReasonSchema = z.enum([
  "conflict",
  "item_not_found",
  "attribute_not_found",
  "attribute_archived",
  "wrong_type",
  "option_invalid",
  "out_of_range",
  "not_integer",
  "too_long",
  "empty_text",
  "repeated",
  "duplicate_item",
]);

export type CatalogValueRejectionReason = z.infer<typeof catalogValueRejectionReasonSchema>;

export const catalogValueRejectionSchema = z.object({
  /** The position of the value (or cell) in the request. */
  index: z.number().int(),
  itemId: z.uuid(),
  attributeId: z.string(),
  reason: catalogValueRejectionReasonSchema,
  message: z.string(),
  /** `conflict`: the value stored now. */
  currentValue: attributeValueSchema.optional(),
  /** `duplicate_item`: the item it would repeat. */
  existingItemId: z.uuid().optional(),
});

export type CatalogValueRejection = z.infer<typeof catalogValueRejectionSchema>;

/** `details` of `CATALOG_VALUES_REJECTED`: every refused value; nothing was written. */
export const catalogValuesRejectedDetailsSchema = z.object({
  rejections: z.array(catalogValueRejectionSchema),
});

export type CatalogValuesRejectedDetails = z.infer<typeof catalogValuesRejectedDetailsSchema>;

/**
 * `GET /admin/catalog/categories/{categoryId}/fill` (SCREENS A-CAT-03): the
 * items of a subcategory × its active attributes, newest first.
 * `emptyAttributeId` — only items where that attribute is empty.
 */
export const categoryFillQuerySchema = z.object({
  emptyAttributeId: z.uuid().optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type CategoryFillQuery = z.infer<typeof categoryFillQuerySchema>;

export const categoryFillValueSchema = z.object({
  attributeId: z.uuid(),
  value: attributeValueSchema,
});

export type CategoryFillValue = z.infer<typeof categoryFillValueSchema>;

export const categoryFillRowSchema = z.object({
  item: adminCatalogItemSchema,
  /** One per attribute of the page, in its order. */
  values: z.array(categoryFillValueSchema),
});

export type CategoryFillRow = z.infer<typeof categoryFillRowSchema>;

export const categoryFillPageSchema = z.object({
  category: adminCategorySchema,
  /** Active attributes of the category, in their order: the columns. */
  attributes: z.array(adminAttributeSchema),
  rows: z.array(categoryFillRowSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type CategoryFillPage = z.infer<typeof categoryFillPageSchema>;

/**
 * One cell to change: `previous` — the value as it was read (`null` —
 * empty); if it is another now, the cell is a `conflict` and nothing is
 * written.
 */
export const categoryFillCellSchema = z.object({
  itemId: z.uuid(),
  attributeId: z.uuid(),
  previous: attributeValueSchema,
  value: attributeValueSchema,
});

export type CategoryFillCell = z.infer<typeof categoryFillCellSchema>;

/**
 * `PUT /admin/catalog/categories/{categoryId}/fill`: all cells or none
 * (`CATALOG_VALUES_REJECTED` lists every refused one).
 */
export const fillCategoryBodySchema = z.object({
  cells: z.array(categoryFillCellSchema).min(1).max(CATALOG_FILL_MAX_CELLS),
});

export type FillCategoryBody = z.infer<typeof fillCategoryBodySchema>;

export const fillCategoryResponseSchema = z.object({
  /** Cells whose value changed (a cell set to the value it had doesn't count). */
  changedCells: z.number().int(),
  /** The items touched, as rows of the table, in the order of the request. */
  rows: z.array(categoryFillRowSchema),
});

export type FillCategoryResponse = z.infer<typeof fillCategoryResponseSchema>;
