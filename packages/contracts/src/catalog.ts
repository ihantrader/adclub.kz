import { z } from "zod";

/**
 * The structure of the catalog (PRODUCT 7.1–7.5, 11; ARCHITECTURE 5.2, 5.4,
 * 4.15; TASK-010; SCREENS A-CAT-01, A-CAT-02, M-CAT-01, M-CAT-10, M-CAT-03):
 * two-level categories of goods and services, the attributes of a
 * subcategory (the fields of its forms and its filters) and the options of
 * a list attribute. The administrator keeps them; everyone else reads the
 * active part. Enum values here are only ever added (ARCHITECTURE 7.4).
 */

/** Languages of reference data (the same three as `@adclub/i18n`). */
export const catalogLanguageSchema = z.enum(["kk", "ru", "en"]);

export type CatalogLanguage = z.infer<typeof catalogLanguageSchema>;

/** `goods` — parts and supplies; `services` — the single list of services (PRODUCT 11). */
export const categoryKindSchema = z.enum(["goods", "services"]);

export type CategoryKind = z.infer<typeof categoryKindSchema>;

/**
 * `active` — seen by everyone; `hidden` — kept aside by the administrator
 * for a while; `archived` — no longer used ("delete"). Hidden and archived
 * categories are not shown to clients, and neither are the subcategories of
 * a hidden or archived node.
 */
export const categoryStatusSchema = z.enum(["active", "hidden", "archived"]);

export type CategoryStatus = z.infer<typeof categoryStatusSchema>;

/** An attribute or a list option: archiving hides it from forms and filters, values stay. */
export const catalogEntryStatusSchema = z.enum(["active", "archived"]);

export type CatalogEntryStatus = z.infer<typeof catalogEntryStatusSchema>;

/**
 * - `number` — with a unit, bounds and whether it is whole; a filter is a range;
 * - `enum` — one of the attribute's options (a list); a filter is a choice of options;
 * - `bool` — yes/no; a filter is a switch;
 * - `text` — free text; never a filter.
 *
 * The type never changes after creation: archive the attribute and create
 * another one instead.
 */
export const attributeValueTypeSchema = z.enum(["number", "enum", "bool", "text"]);

export type AttributeValueType = z.infer<typeof attributeValueTypeSchema>;

/**
 * Icons a category may carry: names of the design system's icon set
 * (Tabler Icons, DESIGN.md 7.x), each available in `@tabler/icons-react`
 * and `@tabler/icons-react-native` (`Icon` + the name in PascalCase —
 * checked by a test of the mobile app). New names are only ever added.
 */
export const categoryIcons = [
  "air-conditioning",
  "armchair",
  "battery-automotive",
  "bolt",
  "bucket-droplet",
  "bulb",
  "car",
  "car-door",
  "car-fan",
  "car-garage",
  "car-lifter",
  "car-suspension",
  "car-turbine",
  "category",
  "disc",
  "droplet",
  "engine",
  "filter",
  "flask",
  "gas-station",
  "gauge",
  "key",
  "lamp",
  "manual-gearbox",
  "package",
  "paint",
  "plug",
  "road",
  "settings",
  "shield",
  "snowflake",
  "spray",
  "steering-wheel",
  "tag",
  "temperature",
  "tool",
  "tools",
  "truck",
  "wash",
  "wheel",
  "wiper",
  "wiper-wash",
] as const;

export const categoryIconSchema = z.enum(categoryIcons);

export type CategoryIcon = z.infer<typeof categoryIconSchema>;

/**
 * Longest names, in characters. A category name is the caption of a tile on
 * the catalog's main screen, at most two lines even in Kazakh (M-CAT-01):
 * 40 characters fit two lines of the narrowest tile at the base type size;
 * a client still wraps and ellipsizes, the server only keeps names from
 * growing past it.
 */
export const CATEGORY_NAME_MAX_LENGTH = 40;
export const ATTRIBUTE_NAME_MAX_LENGTH = 60;
export const ATTRIBUTE_OPTION_NAME_MAX_LENGTH = 60;
export const ATTRIBUTE_UNIT_MAX_LENGTH = 12;

/** A stable identifier: never changes when the thing is renamed. */
export const catalogCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, {
  message: "Must be a snake_case code of 2–63 characters starting with a letter",
});

/** A list option code may start with a digit (`5w_30`, `0w_20`). */
export const attributeOptionCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,62}$/, {
  message: "Must be a snake_case code of 1–63 characters",
});

/**
 * A name in one language. The server also brings it to one form (Unicode
 * NFC, runs of spaces as one) before storing and comparing it.
 */
function nameText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

/** Names of a new entry: Russian is required, Kazakh and English may wait (TASK-012 translates). */
function newNamesSchema(max: number) {
  return z.object({
    ru: nameText(max),
    kk: nameText(max).nullable().optional(),
    en: nameText(max).nullable().optional(),
  });
}

/** Names being changed: a language left out stays; `null` clears Kazakh or English. */
function nameChangesSchema(max: number) {
  return z.object({
    ru: nameText(max).optional(),
    kk: nameText(max).nullable().optional(),
    en: nameText(max).nullable().optional(),
  });
}

/**
 * One stored text of an entry in one language, as the admin panel sees it:
 * `origin` `source` — written in the source language (Russian); `manual` —
 * a translation written by the administrator; `ai` — an automatic
 * translation (TASK-012). A manually edited text is never overwritten by
 * automatic translation.
 */
export const catalogTextSchema = z.object({
  text: z.string(),
  origin: z.enum(["source", "manual", "ai"]),
  isManuallyEdited: z.boolean(),
});

export type CatalogText = z.infer<typeof catalogTextSchema>;

/** Texts of one field in the three languages; `null` — not written yet. */
export const catalogTextsSchema = z.object({
  kk: catalogTextSchema.nullable(),
  ru: catalogTextSchema.nullable(),
  en: catalogTextSchema.nullable(),
});

export type CatalogTexts = z.infer<typeof catalogTextsSchema>;

/**
 * A text in the language of the request (`Accept-Language`); without a
 * translation to it — the Russian one, with `isFallback: true` so the
 * interface can show it unobtrusively (ARCHITECTURE 5.4).
 */
export const localizedTextSchema = z.object({
  text: z.string(),
  isFallback: z.boolean(),
});

export type LocalizedText = z.infer<typeof localizedTextSchema>;

const expectedVersionSchema = z.number().int().min(1);

/**
 * The order of the siblings the new order was made from, as the client
 * read it (the ids in the order of the admin tree or list). The same as the
 * stored order — the new one is written; another — someone reordered or
 * changed the siblings meanwhile: 409 `CATALOG_ORDER_CONFLICT`, nothing
 * written (TASK-010.A). Left out, the order is written over whatever is
 * stored, as before it existed; the admin panel always sends it.
 */
const expectedOrderSchema = z.array(z.uuid()).max(500);

// ------------------------------------------------------------ admin panel

export const adminCategorySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  kind: categoryKindSchema,
  /** 1 — a node, 2 — a subcategory. */
  level: z.union([z.literal(1), z.literal(2)]),
  parentId: z.uuid().nullable(),
  names: catalogTextsSchema,
  icon: categoryIconSchema.nullable(),
  /** Place among its siblings, from 0. */
  sort: z.number().int(),
  status: categoryStatusSchema,
  /** Active, and (for a subcategory) its node is active too: what clients see. */
  visibleToClients: z.boolean(),
  /** D-029: items show only for a car they fit (subcategories of goods). */
  compatibilityRequired: z.boolean(),
  /** Pass it back as `expectedVersion` when changing the category. */
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminCategory = z.infer<typeof adminCategorySchema>;

export const adminCategoryNodeSchema = adminCategorySchema.extend({
  /** Subcategories in their order, every status included. */
  children: z.array(adminCategorySchema),
});

export type AdminCategoryNode = z.infer<typeof adminCategoryNodeSchema>;

/** `GET /admin/catalog/categories`: the whole tree with every status, goods first. */
export const adminCategoryTreeResponseSchema = z.object({
  categories: z.array(adminCategoryNodeSchema),
});

export type AdminCategoryTreeResponse = z.infer<typeof adminCategoryTreeResponseSchema>;

export const categoryIdPathSchema = z.object({ categoryId: z.uuid() });

export type CategoryIdPath = z.infer<typeof categoryIdPathSchema>;

export const attributeIdPathSchema = z.object({ attributeId: z.uuid() });

export type AttributeIdPath = z.infer<typeof attributeIdPathSchema>;

export const attributeOptionIdPathSchema = z.object({ optionId: z.uuid() });

export type AttributeOptionIdPath = z.infer<typeof attributeOptionIdPathSchema>;

/** `POST /admin/catalog/categories`: goes to the end of its siblings. */
export const createCategoryBodySchema = z.object({
  code: catalogCodeSchema,
  kind: categoryKindSchema,
  /** A node of the same kind; left out or `null` — a node itself. */
  parentId: z.uuid().nullable().optional(),
  names: newNamesSchema(CATEGORY_NAME_MAX_LENGTH),
  icon: categoryIconSchema.nullable().optional(),
  compatibilityRequired: z.boolean().optional(),
});

export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

/**
 * `PATCH /admin/catalog/categories/{categoryId}`: only the fields sent
 * change. `parentId` moves a subcategory to another node of the same kind
 * (to the end of its children); a node stays a node. `kind` can't change —
 * it is accepted only to refuse a change explicitly.
 */
export const updateCategoryBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  names: nameChangesSchema(CATEGORY_NAME_MAX_LENGTH).optional(),
  icon: categoryIconSchema.nullable().optional(),
  compatibilityRequired: z.boolean().optional(),
  parentId: z.uuid().nullable().optional(),
  kind: categoryKindSchema.optional(),
});

export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

/**
 * `POST /admin/catalog/categories/{categoryId}/status`: hide, archive, or
 * restore (`active` or `hidden` from the archive).
 */
export const setCategoryStatusBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  status: categoryStatusSchema,
});

export type SetCategoryStatusBody = z.infer<typeof setCategoryStatusBodySchema>;

/**
 * `PUT /admin/catalog/categories/order`: the new order of one set of
 * siblings — the children of `parentId`, or the nodes of `kind` when
 * `parentId` is `null`. Must name every one of them exactly once.
 */
export const reorderCategoriesBodySchema = z.object({
  parentId: z.uuid().nullable(),
  kind: categoryKindSchema,
  categoryIds: z.array(z.uuid()).min(1).max(500),
  expectedOrder: expectedOrderSchema.optional(),
});

export type ReorderCategoriesBody = z.infer<typeof reorderCategoriesBodySchema>;

export const adminCategoryResponseSchema = z.object({ category: adminCategorySchema });

export type AdminCategoryResponse = z.infer<typeof adminCategoryResponseSchema>;

export const numberSettingsSchema = z.object({
  /** Whole numbers only. */
  integer: z.boolean(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});

export type NumberSettings = z.infer<typeof numberSettingsSchema>;

export const adminAttributeOptionSchema = z.object({
  id: z.uuid(),
  attributeId: z.uuid(),
  code: z.string(),
  names: catalogTextsSchema,
  sort: z.number().int(),
  status: catalogEntryStatusSchema,
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminAttributeOption = z.infer<typeof adminAttributeOptionSchema>;

export const adminAttributeSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  code: z.string(),
  valueType: attributeValueTypeSchema,
  names: catalogTextsSchema,
  /** `number` only; `null` — none or another type. */
  unit: catalogTextsSchema.nullable(),
  /** `number` only. */
  number: numberSettingsSchema.nullable(),
  isFilterable: z.boolean(),
  /** An empty value makes an item incomplete (PRODUCT 7.4; completeness — TASK-011). */
  isRequiredForComplete: z.boolean(),
  sort: z.number().int(),
  status: catalogEntryStatusSchema,
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  /** `enum` only, every status included, in their order. */
  options: z.array(adminAttributeOptionSchema),
});

export type AdminAttribute = z.infer<typeof adminAttributeSchema>;

/** `GET /admin/catalog/categories/{categoryId}/attributes`: every status, in their order. */
export const adminAttributeListResponseSchema = z.object({
  category: adminCategorySchema,
  attributes: z.array(adminAttributeSchema),
});

export type AdminAttributeListResponse = z.infer<typeof adminAttributeListResponseSchema>;

const unitText = nameText(ATTRIBUTE_UNIT_MAX_LENGTH);

const newOptionSchema = z.object({
  code: attributeOptionCodeSchema,
  names: newNamesSchema(ATTRIBUTE_OPTION_NAME_MAX_LENGTH),
});

/** `POST /admin/catalog/categories/{categoryId}/attributes`: goes to the end. */
export const createAttributeBodySchema = z.object({
  code: catalogCodeSchema,
  valueType: attributeValueTypeSchema,
  names: newNamesSchema(ATTRIBUTE_NAME_MAX_LENGTH),
  /** `number` only: Russian required when given. */
  unit: z
    .object({
      ru: unitText,
      kk: unitText.nullable().optional(),
      en: unitText.nullable().optional(),
    })
    .nullable()
    .optional(),
  /** `number` only; required for it. */
  number: numberSettingsSchema.optional(),
  /** Not for `text`. */
  isFilterable: z.boolean().optional(),
  isRequiredForComplete: z.boolean().optional(),
  /** `enum` only: the first options, in this order (more can be added later). */
  options: z.array(newOptionSchema).max(200).optional(),
});

export type CreateAttributeBody = z.infer<typeof createAttributeBodySchema>;

/**
 * `PATCH /admin/catalog/attributes/{attributeId}`: only the fields sent
 * change. `valueType` can't change — it is accepted only to refuse a
 * change explicitly (`CATALOG_ATTRIBUTE_TYPE_IMMUTABLE`).
 */
export const updateAttributeBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  names: nameChangesSchema(ATTRIBUTE_NAME_MAX_LENGTH).optional(),
  /** `null` — no unit. */
  unit: z
    .object({
      ru: unitText.optional(),
      kk: unitText.nullable().optional(),
      en: unitText.nullable().optional(),
    })
    .nullable()
    .optional(),
  number: numberSettingsSchema.optional(),
  isFilterable: z.boolean().optional(),
  isRequiredForComplete: z.boolean().optional(),
  valueType: attributeValueTypeSchema.optional(),
});

export type UpdateAttributeBody = z.infer<typeof updateAttributeBodySchema>;

/** `POST /admin/catalog/attributes/{attributeId}/status`: archive or restore. */
export const setCatalogEntryStatusBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  status: catalogEntryStatusSchema,
});

export type SetCatalogEntryStatusBody = z.infer<typeof setCatalogEntryStatusBodySchema>;

/** `PUT /admin/catalog/categories/{categoryId}/attributes/order`: every attribute once. */
export const reorderAttributesBodySchema = z.object({
  attributeIds: z.array(z.uuid()).min(1).max(500),
  expectedOrder: expectedOrderSchema.optional(),
});

export type ReorderAttributesBody = z.infer<typeof reorderAttributesBodySchema>;

export const adminAttributeResponseSchema = z.object({ attribute: adminAttributeSchema });

export type AdminAttributeResponse = z.infer<typeof adminAttributeResponseSchema>;

/** `POST /admin/catalog/attributes/{attributeId}/options`: goes to the end. */
export const createAttributeOptionBodySchema = newOptionSchema;

export type CreateAttributeOptionBody = z.infer<typeof createAttributeOptionBodySchema>;

/** `PATCH /admin/catalog/attribute-options/{optionId}`. */
export const updateAttributeOptionBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  names: nameChangesSchema(ATTRIBUTE_OPTION_NAME_MAX_LENGTH).optional(),
});

export type UpdateAttributeOptionBody = z.infer<typeof updateAttributeOptionBodySchema>;

/** `PUT /admin/catalog/attributes/{attributeId}/options/order`: every option once. */
export const reorderAttributeOptionsBodySchema = z.object({
  optionIds: z.array(z.uuid()).min(1).max(500),
  expectedOrder: expectedOrderSchema.optional(),
});

export type ReorderAttributeOptionsBody = z.infer<typeof reorderAttributeOptionsBodySchema>;

export const adminAttributeOptionResponseSchema = z.object({ option: adminAttributeOptionSchema });

export type AdminAttributeOptionResponse = z.infer<typeof adminAttributeOptionResponseSchema>;

/** `details` of `CATALOG_VERSION_CONFLICT`. */
export const catalogVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int(),
});

export type CatalogVersionConflictDetails = z.infer<typeof catalogVersionConflictDetailsSchema>;

/** `details` of `CATALOG_ORDER_CONFLICT`: the order stored now, to show and decide again. */
export const catalogOrderConflictDetailsSchema = z.object({
  currentOrder: z.array(z.uuid()),
});

export type CatalogOrderConflictDetails = z.infer<typeof catalogOrderConflictDetailsSchema>;

/** `details` of `CATALOG_NAME_TAKEN`: the language whose name a sibling already has. */
export const catalogNameTakenDetailsSchema = z.object({
  lang: catalogLanguageSchema,
  /** The sibling that has it. */
  conflictingId: z.uuid(),
});

export type CatalogNameTakenDetails = z.infer<typeof catalogNameTakenDetailsSchema>;

// ------------------------------------------------------------ clients

/**
 * How long a client or a proxy may reuse a catalog answer, in seconds
 * (`Cache-Control: public, max-age=…`, `Vary: Accept-Language`): a change
 * of the administrator reaches every client within this time
 * (ARCHITECTURE 4.15). The server itself reads the database on every request.
 */
export const CATALOG_CLIENT_CACHE_SECONDS = 60;

export const categorySubcategorySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  kind: categoryKindSchema,
  name: localizedTextSchema,
  icon: categoryIconSchema.nullable(),
  sort: z.number().int(),
  compatibilityRequired: z.boolean(),
});

export type CategorySubcategory = z.infer<typeof categorySubcategorySchema>;

export const categoryNodeSchema = categorySubcategorySchema.extend({
  /** Active subcategories in their order. */
  children: z.array(categorySubcategorySchema),
});

export type CategoryNode = z.infer<typeof categoryNodeSchema>;

/**
 * `GET /catalog/categories`: the active tree — goods first, then services,
 * each in the administrator's order — in the language of the request.
 */
export const categoryTreeResponseSchema = z.object({
  /** The language the texts were asked in (`Accept-Language`, Russian by default). */
  language: catalogLanguageSchema,
  categories: z.array(categoryNodeSchema),
});

export type CategoryTreeResponse = z.infer<typeof categoryTreeResponseSchema>;

/**
 * Path of `GET /catalog/categories/{categoryId}/attributes`. Any string:
 * a malformed id is answered like a missing category (404).
 */
export const catalogCategoryPathSchema = z.object({ categoryId: z.string().min(1).max(100) });

export type CatalogCategoryPath = z.infer<typeof catalogCategoryPathSchema>;

export const attributeOptionSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: localizedTextSchema,
});

export type AttributeOption = z.infer<typeof attributeOptionSchema>;

export const categoryAttributeSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: localizedTextSchema,
  valueType: attributeValueTypeSchema,
  /** `number` only. */
  unit: localizedTextSchema.nullable(),
  /** `number` only. */
  number: numberSettingsSchema.nullable(),
  /** `enum` only: active options in their order (a list attribute without any isn't listed). */
  options: z.array(attributeOptionSchema),
  /** Shown among the filters of the category (M-CAT-03). */
  isFilterable: z.boolean(),
  /** An empty value makes an item incomplete (PRODUCT 7.4). */
  isRequiredForComplete: z.boolean(),
  sort: z.number().int(),
});

export type CategoryAttribute = z.infer<typeof categoryAttributeSchema>;

/**
 * `GET /catalog/categories/{categoryId}/attributes`: what the forms and
 * filters of a category are made of — its active attributes in their order.
 * A node has none (only subcategories carry attributes).
 */
export const categoryAttributesResponseSchema = z.object({
  language: catalogLanguageSchema,
  category: categorySubcategorySchema.extend({
    level: z.union([z.literal(1), z.literal(2)]),
    parentId: z.uuid().nullable(),
  }),
  attributes: z.array(categoryAttributeSchema),
});

export type CategoryAttributesResponse = z.infer<typeof categoryAttributesResponseSchema>;
