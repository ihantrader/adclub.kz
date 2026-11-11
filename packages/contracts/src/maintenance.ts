import { z } from "zod";
import {
  catalogLanguageSchema,
  catalogNameText,
  catalogTextsSchema,
  localizedTextSchema,
} from "./catalog";
import { compatibilityVehicleSchema, resolvedCompatibilityVehicleSchema } from "./compatibility";
import {
  showcaseAttributeFilterSchema,
  showcaseVehicleQueryShape,
  SHOWCASE_ATTRIBUTE_FILTER_MAX,
} from "./showcase";

/**
 * Maintenance plans as data (TASK-061; ARCHITECTURE 11.3, 4.84; PRODUCT
 * 8.3): a plan for a make, a model, a generation or an engine lists pieces
 * of work by their intervals, and each points not at an item but at a rule
 * — a subcategory of the catalog with the very filters of its client list
 * (`attributes` of `GET /catalog/categories/{id}/items`), or particular
 * items. What a car is due at a mileage, and what of it the platform sells
 * for this car and city, is answered by `GET /maintenance/plan` — counted by
 * the same code as the client list, so the numbers are the catalog's.
 *
 * Plans are kept by the administrator; a first draft may be made by AI and
 * is confirmed by the administrator element by element (SCREENS 9.3: what
 * AI proposed is marked until a person confirms it). Clients and the
 * assistant see only active plans and active elements.
 */

/** The longest title of an element (kk/ru/en), characters. */
export const MAINTENANCE_TITLE_MAX_LENGTH = 120;
/** The longest service name of a plan («Geely Atlas II, 2.0T»). */
export const MAINTENANCE_PLAN_NAME_MAX_LENGTH = 120;
/** The longest note of an element (for the administrator). */
export const MAINTENANCE_NOTE_MAX_LENGTH = 200;
/** Service codes of one element («ТО-1», «ТО-2», …). */
export const MAINTENANCE_SERVICE_CODES_MAX = 12;
/** Items of a rule by particular items. */
export const MAINTENANCE_TARGET_ITEMS_MAX = 20;
/** Elements of one plan. */
export const MAINTENANCE_PLAN_ITEMS_MAX = 100;

const uuidOrNull = z.uuid().nullable();
const expectedVersionSchema = z.number().int().min(1);

/** `ai_draft` — made by AI from open data; `manual` — by an administrator; `official` — the maker's. */
export const maintenancePlanSourceSchema = z.enum(["ai_draft", "manual", "official"]);
export type MaintenancePlanSource = z.infer<typeof maintenancePlanSourceSchema>;

export const maintenancePlanStatusSchema = z.enum(["draft", "active", "archived"]);
export type MaintenancePlanStatus = z.infer<typeof maintenancePlanStatusSchema>;

/** `proposed` — AI proposed it, a person has not confirmed it yet. */
export const maintenanceItemStatusSchema = z.enum(["proposed", "active", "archived"]);
export type MaintenanceItemStatus = z.infer<typeof maintenanceItemStatusSchema>;

/** `part` — something to change (picked from goods); `service` — work (picked from services). */
export const maintenanceItemKindSchema = z.enum(["part", "service"]);
export type MaintenanceItemKind = z.infer<typeof maintenanceItemKindSchema>;

/** The levels a plan is scoped by. */
export const maintenanceLevelSchema = z.enum(["make", "model", "generation", "engine"]);
export type MaintenanceLevel = z.infer<typeof maintenanceLevelSchema>;

/** The area of a plan: a make and, optionally, finer levels (`null` — any). */
export const maintenanceScopeSchema = z.object({
  makeId: z.uuid(),
  modelId: uuidOrNull,
  generationId: uuidOrNull,
  engineId: uuidOrNull,
});
export type MaintenanceScope = z.infer<typeof maintenanceScopeSchema>;

/** The area as sent: the finer levels may be left out (any). */
export const maintenanceScopeInputSchema = z.object({
  makeId: z.uuid(),
  modelId: uuidOrNull.optional(),
  generationId: uuidOrNull.optional(),
  engineId: uuidOrNull.optional(),
});
export type MaintenanceScopeInput = z.infer<typeof maintenanceScopeInputSchema>;

/** The area in words: names as written, the generation with its years. */
export const maintenanceScopeLabelSchema = z.object({
  make: z.string(),
  model: z.string().nullable(),
  generation: z.string().nullable(),
  engine: z.string().nullable(),
});
export type MaintenanceScopeLabel = z.infer<typeof maintenanceScopeLabelSchema>;

/**
 * The rule of an element: `category` — the items of a subcategory (of
 * goods for a part, of services for a service) passing `attributes` — the
 * filters of the client list, the same schema; `items` — these items.
 */
export const maintenanceTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("category"),
    categoryId: z.uuid(),
    attributes: z.array(showcaseAttributeFilterSchema).max(SHOWCASE_ATTRIBUTE_FILTER_MAX),
  }),
  z.object({
    kind: z.literal("items"),
    itemIds: z.array(z.uuid()).min(1).max(MAINTENANCE_TARGET_ITEMS_MAX),
  }),
]);
export type MaintenanceTarget = z.infer<typeof maintenanceTargetSchema>;

const serviceCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[^\p{Cc},]*$/u, { message: "Must not contain control characters or commas" });

const intervalKmSchema = z.number().int().min(1_000).max(120_000);
const intervalMonthsSchema = z.number().int().min(1).max(120);

/**
 * Why an element leads nowhere, as the administrator is told:
 * `no_rule` — no rule (AI named a subcategory the catalog has not);
 * `category_unavailable` — the subcategory is hidden or archived (or of
 * the other kind); `attribute_unavailable` — a condition names a
 * characteristic that is no longer an active filter of the subcategory, or a
 * variant that is archived;
 * `item_unavailable` — an item of the rule is archived or gone.
 */
export const maintenanceItemProblemSchema = z.enum([
  "no_rule",
  "category_unavailable",
  "attribute_unavailable",
  "item_unavailable",
]);
export type MaintenanceItemProblem = z.infer<typeof maintenanceItemProblemSchema>;

export const adminMaintenancePersonSchema = z.object({
  adminId: z.uuid(),
  name: z.string().nullable(),
});

/** An element as the admin panel sees it. */
export const adminMaintenanceItemSchema = z.object({
  id: z.uuid(),
  planId: z.uuid(),
  position: z.number().int(),
  kind: maintenanceItemKindSchema,
  /** The title in the three languages with where each came from (automatic translation). */
  title: catalogTextsSchema,
  intervalKm: z.number().int().nullable(),
  intervalMonths: z.number().int().nullable(),
  firstKm: z.number().int().nullable(),
  firstMonths: z.number().int().nullable(),
  serviceCodes: z.array(z.string()),
  target: maintenanceTargetSchema.nullable(),
  /** The rule in words («Моторные масла · Вязкость: 0W-20»); `null` — no rule. */
  targetLabel: z.string().nullable(),
  quantity: z.number().int().nullable(),
  note: z.string().nullable(),
  status: maintenanceItemStatusSchema,
  problems: z.array(maintenanceItemProblemSchema),
  confirmedBy: adminMaintenancePersonSchema.nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminMaintenanceItem = z.infer<typeof adminMaintenanceItemSchema>;

/** A plan as a row of the list. */
export const adminMaintenancePlanSchema = z.object({
  id: z.uuid(),
  scope: maintenanceScopeSchema,
  label: maintenanceScopeLabelSchema,
  name: z.string(),
  source: maintenancePlanSourceSchema,
  status: maintenancePlanStatusSchema,
  /** AI is making this draft right now. */
  generating: z.boolean(),
  /** Elements that are not archived. */
  itemCount: z.number().int(),
  /** Of them, proposed by AI and not confirmed yet. */
  proposedCount: z.number().int(),
  copiedFromId: uuidOrNull,
  createdBy: adminMaintenancePersonSchema.nullable(),
  confirmedBy: adminMaintenancePersonSchema.nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminMaintenancePlan = z.infer<typeof adminMaintenancePlanSchema>;

/** A plan with its elements (archived ones too, last). */
export const adminMaintenancePlanResponseSchema = z.object({
  plan: adminMaintenancePlanSchema,
  items: z.array(adminMaintenanceItemSchema),
  /** The active plan of the same area, if it is another one. */
  activePlanId: uuidOrNull,
});
export type AdminMaintenancePlanResponse = z.infer<typeof adminMaintenancePlanResponseSchema>;

export const maintenancePlanListQuerySchema = z.object({
  makeId: z.uuid().optional(),
  modelId: z.uuid().optional(),
  status: maintenancePlanStatusSchema.optional(),
  source: maintenancePlanSourceSchema.optional(),
  /** Words of the name or the area (the make, the model, the engine code). */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
});
export type MaintenancePlanListQuery = z.infer<typeof maintenancePlanListQuerySchema>;

export const adminMaintenancePlanPageSchema = z.object({
  plans: z.array(adminMaintenancePlanSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});
export type AdminMaintenancePlanPage = z.infer<typeof adminMaintenancePlanPageSchema>;

export const maintenancePlanPathSchema = z.object({ planId: z.uuid() });
export type MaintenancePlanPath = z.infer<typeof maintenancePlanPathSchema>;

export const maintenanceItemPathSchema = z.object({ itemId: z.uuid() });
export type MaintenanceItemPath = z.infer<typeof maintenanceItemPathSchema>;

const planNameSchema = catalogNameText(MAINTENANCE_PLAN_NAME_MAX_LENGTH);

/** `POST /admin/maintenance/plans`: a new manual draft. Without a name — the area in words. */
export const createMaintenancePlanBodySchema = z.object({
  scope: maintenanceScopeInputSchema,
  name: planNameSchema.optional(),
});
export type CreateMaintenancePlanBody = z.infer<typeof createMaintenancePlanBodySchema>;

/** `POST /admin/maintenance/plans/draft`: AI makes a draft for the area. */
export const draftMaintenancePlanBodySchema = createMaintenancePlanBodySchema;
export type DraftMaintenancePlanBody = z.infer<typeof draftMaintenancePlanBodySchema>;

export const updateMaintenancePlanBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  name: planNameSchema.optional(),
  /** Only of a plan that is not active (archive the active one first). */
  scope: maintenanceScopeInputSchema.optional(),
});
export type UpdateMaintenancePlanBody = z.infer<typeof updateMaintenancePlanBodySchema>;

/** `active` — confirm the plan (every element confirmed, every rule valid); `draft` — back from the archive. */
export const setMaintenancePlanStatusBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  status: maintenancePlanStatusSchema,
});
export type SetMaintenancePlanStatusBody = z.infer<typeof setMaintenancePlanStatusBodySchema>;

export const copyMaintenancePlanBodySchema = z.object({
  scope: maintenanceScopeInputSchema,
  name: planNameSchema.optional(),
});
export type CopyMaintenancePlanBody = z.infer<typeof copyMaintenancePlanBodySchema>;

const titleInputSchema = z.object({
  ru: catalogNameText(MAINTENANCE_TITLE_MAX_LENGTH),
  kk: catalogNameText(MAINTENANCE_TITLE_MAX_LENGTH).nullable().optional(),
  en: catalogNameText(MAINTENANCE_TITLE_MAX_LENGTH).nullable().optional(),
});

const titleChangesSchema = z.object({
  ru: catalogNameText(MAINTENANCE_TITLE_MAX_LENGTH).optional(),
  kk: catalogNameText(MAINTENANCE_TITLE_MAX_LENGTH).nullable().optional(),
  en: catalogNameText(MAINTENANCE_TITLE_MAX_LENGTH).nullable().optional(),
});

const itemFields = {
  intervalKm: intervalKmSchema.nullable().optional(),
  intervalMonths: intervalMonthsSchema.nullable().optional(),
  firstKm: z.number().int().min(1).max(120_000).nullable().optional(),
  firstMonths: z.number().int().min(1).max(120).nullable().optional(),
  serviceCodes: z.array(serviceCodeSchema).max(MAINTENANCE_SERVICE_CODES_MAX).optional(),
  quantity: z.number().int().min(1).max(100).nullable().optional(),
  note: z.string().trim().max(MAINTENANCE_NOTE_MAX_LENGTH).nullable().optional(),
};

/** `POST /admin/maintenance/plans/{planId}/items`: an element confirmed as it is written. */
export const createMaintenanceItemBodySchema = z.object({
  kind: maintenanceItemKindSchema,
  title: titleInputSchema,
  target: maintenanceTargetSchema,
  ...itemFields,
});
export type CreateMaintenanceItemBody = z.infer<typeof createMaintenanceItemBodySchema>;

/** A change of an element; a field left out stays as it is. The kind never changes. */
export const updateMaintenanceItemBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  title: titleChangesSchema.optional(),
  target: maintenanceTargetSchema.optional(),
  ...itemFields,
});
export type UpdateMaintenanceItemBody = z.infer<typeof updateMaintenanceItemBodySchema>;

/** `active` — confirm a proposed element (or restore an archived one); `archived` — «Убрать». */
export const setMaintenanceItemStatusBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  status: z.enum(["active", "archived"]),
});
export type SetMaintenanceItemStatusBody = z.infer<typeof setMaintenanceItemStatusBodySchema>;

/** «Подтвердить все предложенные»: the plan's version as read. */
export const confirmMaintenanceItemsBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
});
export type ConfirmMaintenanceItemsBody = z.infer<typeof confirmMaintenanceItemsBodySchema>;

/** The order of the elements that are not archived, as the client read it and as it should be. */
export const reorderMaintenanceItemsBodySchema = z.object({
  itemIds: z.array(z.uuid()).min(1).max(MAINTENANCE_PLAN_ITEMS_MAX),
  expectedOrder: z.array(z.uuid()).max(MAINTENANCE_PLAN_ITEMS_MAX),
});
export type ReorderMaintenanceItemsBody = z.infer<typeof reorderMaintenanceItemsBodySchema>;

export const confirmMaintenanceItemsResponseSchema = adminMaintenancePlanResponseSchema.extend({
  /** Elements confirmed now. */
  confirmed: z.number().int(),
  /** Proposed elements left as they are: without a rule (`no_rule`) or with a problem. */
  skipped: z.number().int(),
});
export type ConfirmMaintenanceItemsResponse = z.infer<typeof confirmMaintenanceItemsResponseSchema>;

// ------------------------------------------------------------- the answer

/** Why an element is in the answer. */
export const maintenanceDueReasonSchema = z.enum(["by_code", "by_km", "by_months", "first"]);
export type MaintenanceDueReason = z.infer<typeof maintenanceDueReasonSchema>;

/**
 * What the platform sells by the rule of an element for this car and city
 * — the list of the subcategory with the rule's filters, by the same code
 * as `GET /catalog/categories/{categoryId}/items`: `count` is its `total`,
 * `minPrice` the lowest price among them. `categoryId` and `filters` open
 * that list (`attributes` = `filters` as JSON); a rule by items gives
 * `itemIds` (of them, `count` are sold). A service without a city —
 * `count: null`, `cityRequired: true` (services are shown by a city only).
 * A rule that no longer leads to the catalog as it is (a hidden
 * subcategory, a characteristic that is no longer a filter, an archived
 * variant or item — what the administrator sees as `problems`) —
 * `unavailable: true`, `count: 0` and nothing to open: never a wider list
 * than the rule (TASK-061.A).
 */
export const maintenanceCatalogSchema = z.object({
  unavailable: z.boolean(),
  count: z.number().int().nullable(),
  minPrice: z.number().int().nullable(),
  currency: z.literal("KZT"),
  cityRequired: z.boolean(),
  categoryId: uuidOrNull,
  filters: z.array(showcaseAttributeFilterSchema),
  itemIds: z.array(z.uuid()),
});
export type MaintenanceCatalog = z.infer<typeof maintenanceCatalogSchema>;

export const maintenanceDueItemSchema = z.object({
  id: z.uuid(),
  title: localizedTextSchema,
  kind: maintenanceItemKindSchema,
  reason: maintenanceDueReasonSchema,
  /** The mileage it is due at; `null` — by the code or by the age. */
  atKm: z.number().int().nullable(),
  /** The age, months, it is due at by its months; `null` — not by months. */
  atMonths: z.number().int().nullable(),
  intervalKm: z.number().int().nullable(),
  intervalMonths: z.number().int().nullable(),
  quantity: z.number().int().nullable(),
  catalog: maintenanceCatalogSchema,
});
export type MaintenanceDueItem = z.infer<typeof maintenanceDueItemSchema>;

/**
 * `GET /maintenance/plan` — the car by its levels (as the catalog takes
 * it), its mileage, a service code («ТО-2») and the chosen city.
 */
export const maintenancePlanQuerySchema = z.object({
  ...showcaseVehicleQueryShape,
  mileageKm: z.coerce.number().int().min(0).max(2_000_000).optional(),
  serviceCode: serviceCodeSchema.optional(),
  cityId: z.uuid().optional(),
});
export type MaintenancePlanQuery = z.infer<typeof maintenancePlanQuerySchema>;

/**
 * Why there is no plan: `no_plan` — none for this car; `needs_details` —
 * one would apply with the levels in `missing` («уточните двигатель»).
 */
export const maintenanceNoPlanReasonSchema = z.enum(["no_plan", "needs_details"]);

export const maintenancePlanAnswerSchema = z.object({
  language: catalogLanguageSchema,
  /** The car as understood; `null` — none given. */
  vehicle: resolvedCompatibilityVehicleSchema.nullable(),
  plan: z
    .object({
      id: z.uuid(),
      scope: maintenanceScopeSchema,
      source: maintenancePlanSourceSchema,
      /** Every service code of the plan, in order («ТО-1», «ТО-2», …). */
      serviceCodes: z.array(z.string()),
    })
    .nullable(),
  /** `null` with a plan. */
  noPlan: maintenanceNoPlanReasonSchema.nullable(),
  /** The levels to give for a plan to apply (`needs_details`). */
  missing: z.array(maintenanceLevelSchema),
  /** `mileage_required` — neither a mileage nor a code: «уточните пробег». */
  reason: z.enum(["mileage_required"]).nullable(),
  items: z.array(maintenanceDueItemSchema),
  /** The service the items are of, km; `null` — not by mileage. */
  serviceKm: z.number().int().nullable(),
  /** The service after it («следующее ТО»); `null` — unknown. */
  nextServiceKm: z.number().int().nullable(),
});
export type MaintenancePlanAnswer = z.infer<typeof maintenancePlanAnswerSchema>;

/** `POST /admin/maintenance/plans/{planId}/check`: a car as the compatibility check takes it. */
export const maintenancePlanCheckBodySchema = z.object({
  vehicle: compatibilityVehicleSchema,
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
  serviceCode: serviceCodeSchema.optional(),
  cityId: z.uuid().optional(),
});
export type MaintenancePlanCheckBody = z.infer<typeof maintenancePlanCheckBodySchema>;

/**
 * The check of one plan, whatever its status, with every element that is
 * not archived (proposed ones too): the answer the car would get, and for
 * each element how many items of the rule the catalog has at all
 * (`catalogTotal`: active items of the subcategory passing the conditions,
 * on offer or not) and its problems — so the administrator sees a rule that
 * leads nowhere before confirming it.
 */
export const maintenancePlanCheckResponseSchema = z.object({
  /** Whether the plan's area is the car's. */
  scope: z.object({
    result: z.enum(["fits", "needs_details", "does_not_fit"]),
    missing: z.array(maintenanceLevelSchema),
  }),
  vehicle: resolvedCompatibilityVehicleSchema,
  reason: z.enum(["mileage_required"]).nullable(),
  items: z.array(
    maintenanceDueItemSchema.extend({
      status: maintenanceItemStatusSchema,
      catalogTotal: z.number().int(),
      problems: z.array(maintenanceItemProblemSchema),
    }),
  ),
  serviceKm: z.number().int().nullable(),
  nextServiceKm: z.number().int().nullable(),
});
export type MaintenancePlanCheckResponse = z.infer<typeof maintenancePlanCheckResponseSchema>;

// ------------------------------------------------------------------ errors

/** `details` of `MAINTENANCE_VERSION_CONFLICT` (409). */
export const maintenanceVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int(),
});

/** `details` of `MAINTENANCE_PLAN_STATE` (409), when the refusal has a reason of its own. */
export const maintenancePlanStateDetailsSchema = z.object({
  reason: z.enum(["last_active_element", "items_limit"]),
});
export type MaintenancePlanStateDetails = z.infer<typeof maintenancePlanStateDetailsSchema>;

/** `details` of `MAINTENANCE_PLAN_ACTIVE_EXISTS` (409): the active plan of the area. */
export const maintenanceActiveExistsDetailsSchema = z.object({
  existingPlanId: z.uuid(),
});

/**
 * `details` of `MAINTENANCE_PLAN_NOT_READY` (409): why the plan can't be
 * activated — no elements, or elements that are proposed or lead nowhere.
 */
export const maintenanceNotReadyDetailsSchema = z.object({
  empty: z.boolean(),
  items: z.array(
    z.object({
      itemId: z.uuid(),
      reasons: z.array(z.union([z.literal("not_confirmed"), maintenanceItemProblemSchema])),
    }),
  ),
});
export type MaintenanceNotReadyDetails = z.infer<typeof maintenanceNotReadyDetailsSchema>;

/**
 * `details` of `MAINTENANCE_TARGET_INVALID` (400): the rule names
 * something the catalog does not have as it should be — `category` (no such
 * subcategory, not active, of the other kind), `attribute` (not an active
 * filter of it, or a condition of the wrong type), `option` (not a variant
 * of the attribute), `item` (no such active item, or of another kind).
 */
export const maintenanceTargetInvalidDetailsSchema = z.object({
  reason: z.enum(["category", "attribute", "option", "item"]),
  field: z.string(),
});

/** `details` of `MAINTENANCE_SCOPE_INVALID` (400). */
export const maintenanceScopeInvalidDetailsSchema = z.object({
  reason: z.enum(["not_found", "model_of_other_make", "generation_of_other_model"]),
  field: z.string(),
});
