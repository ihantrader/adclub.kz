import { z } from "zod";

/**
 * Compatibility of catalog items with cars (PRODUCT 7.5, D-004, D-029;
 * ARCHITECTURE 5.3, 4.25; TASK-015; DESIGN 7.8; SCREENS A-CAT-05, A-MOD).
 *
 * A record of an item names the cars it fits with the precision that is
 * known: a make (required) and, optionally, a model, a generation, a body,
 * an engine, a transmission, a drive and years — an empty level means
 * «any». Only records an administrator approved count; a supplier proposes
 * records, and a proposal changes nothing for users until it is approved.
 *
 * For a car — a whole modification or only the levels that are known —
 * the server answers per item one of four results and, separately, how a
 * client shows the item (D-029), so no client computes the rule itself.
 * Enum values here are only ever added (ARCHITECTURE 7.4).
 */

export const COMPATIBILITY_EVIDENCE_MAX_LENGTH = 1000;
export const COMPATIBILITY_REJECTION_REASON_MAX_LENGTH = 500;
/** Items one check may name. A whole subcategory is checked by `categoryId` instead. */
export const COMPATIBILITY_CHECK_MAX_ITEMS = 500;
export const COMPATIBILITY_PAGE_MAX_SIZE = 100;
export const COMPATIBILITY_PAGE_DEFAULT_SIZE = 50;
/**
 * Items one answer about a whole subcategory holds at most (TASK-016): the
 * rest comes page by page with `cursor` — an open route never answers
 * without a bound.
 */
export const COMPATIBILITY_CHECK_CATEGORY_PAGE_MAX = 500;

const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

const yearSchema = z.number().int().min(YEAR_MIN).max(YEAR_MAX);

const expectedVersionSchema = z.number().int().min(1);

function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

/** Grounds of a record or a proposal: a text, a link to a catalog, or both. */
const evidenceSchema = z
  .string()
  .trim()
  .min(1, { message: "Must not be empty" })
  .max(COMPATIBILITY_EVIDENCE_MAX_LENGTH)
  // Line breaks and tabs are fine, other control characters are not.
  .refine((text) => !/\p{Cc}/u.test(text.replace(/[\t\n\r]/g, "")), {
    message: "Must not contain control characters",
  });

const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(COMPATIBILITY_PAGE_MAX_SIZE)
  .default(COMPATIBILITY_PAGE_DEFAULT_SIZE);

const cursorSchema = z.string().min(1).max(300);

/**
 * The levels of a car, in the order a client asks to fill them in. A level
 * the result is missing is named by these values («уточните двигатель»).
 */
export const compatibilityLevelSchema = z.enum([
  "make",
  "model",
  "generation",
  "body",
  "engine",
  "transmission",
  "drive",
  "year",
]);

export type CompatibilityLevel = z.infer<typeof compatibilityLevelSchema>;

/**
 * The result for an item and a car (DESIGN 7.8):
 * - `fits` — «Подходит»: an approved record all of whose conditions match
 *   the car, the year within its years;
 * - `needs_details` — «Не хватает параметра»: nothing fits, but a record
 *   doesn't contradict the car and needs levels the car doesn't have
 *   (`missing`) — shown, never hidden (PRODUCT 7.5);
 * - `does_not_fit` — «Не подходит»: every approved record contradicts the car;
 * - `not_specified` — «Совместимость не указана»: no approved records.
 */
export const compatibilityResultSchema = z.enum([
  "fits",
  "needs_details",
  "does_not_fit",
  "not_specified",
]);

export type CompatibilityResult = z.infer<typeof compatibilityResultSchema>;

// ------------------------------------------------------------- conditions

/**
 * The cars a record covers. `makeId` is required; any other level left out
 * (or `null`) means «any». A model must be of the make, a generation of
 * the model (the model may be left out — it is taken from the generation),
 * and years, when a generation is named, lie within its years. Archived
 * rows of the vehicle catalog may be named: parts for an old car are still
 * parts for it.
 */
export const compatibilityConditionsInputSchema = z.object({
  makeId: z.uuid(),
  modelId: z.uuid().nullable().optional(),
  generationId: z.uuid().nullable().optional(),
  bodyTypeId: z.uuid().nullable().optional(),
  engineId: z.uuid().nullable().optional(),
  transmissionTypeId: z.uuid().nullable().optional(),
  driveTypeId: z.uuid().nullable().optional(),
  yearFrom: yearSchema.nullable().optional(),
  yearTo: yearSchema.nullable().optional(),
});

export type CompatibilityConditionsInput = z.infer<typeof compatibilityConditionsInputSchema>;

/** The stored conditions: every level present, `null` — «any». */
export const compatibilityConditionsSchema = z.object({
  makeId: z.uuid(),
  modelId: z.uuid().nullable(),
  generationId: z.uuid().nullable(),
  bodyTypeId: z.uuid().nullable(),
  engineId: z.uuid().nullable(),
  transmissionTypeId: z.uuid().nullable(),
  driveTypeId: z.uuid().nullable(),
  yearFrom: z.number().int().nullable(),
  yearTo: z.number().int().nullable(),
});

export type CompatibilityConditions = z.infer<typeof compatibilityConditionsSchema>;

/**
 * The conditions in words, for the admin panel and the cabinet: names as
 * written (makes, models, generations, engine codes) and the Russian names
 * of the reference lists; `null` — «any».
 */
export const compatibilityConditionsLabelSchema = z.object({
  make: z.string(),
  model: z.string().nullable(),
  generation: z.string().nullable(),
  body: z.string().nullable(),
  engine: z.string().nullable(),
  transmission: z.string().nullable(),
  drive: z.string().nullable(),
  years: z.string().nullable(),
});

export type CompatibilityConditionsLabel = z.infer<typeof compatibilityConditionsLabelSchema>;

// ---------------------------------------------------------------- records

/**
 * `admin` — written by an administrator; `supplier` — a supplier's proposal
 * the administrator approved; `ai` — reserved (stage D); `copy` — copied
 * from an analog (`copiedFromId`).
 */
export const compatibilitySourceSchema = z.enum(["admin", "supplier", "ai", "copy"]);

export type CompatibilitySource = z.infer<typeof compatibilitySourceSchema>;

/** `archived` — removed by an administrator; kept as history, never counted. */
export const compatibilityRecordStatusSchema = z.enum(["approved", "archived"]);

export type CompatibilityRecordStatus = z.infer<typeof compatibilityRecordStatusSchema>;

export const adminCompatibilityRecordSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  conditions: compatibilityConditionsSchema,
  label: compatibilityConditionsLabelSchema,
  status: compatibilityRecordStatusSchema,
  source: compatibilitySourceSchema,
  evidence: z.string(),
  copiedFromId: z.uuid().nullable(),
  /** The proposal it was approved from. */
  proposalId: z.uuid().nullable(),
  reviewedByAdminId: z.uuid().nullable(),
  reviewedAt: z.iso.datetime(),
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminCompatibilityRecord = z.infer<typeof adminCompatibilityRecordSchema>;

export const compatibilityItemPathSchema = z.object({ itemId: z.uuid() });

export type CompatibilityItemPath = z.infer<typeof compatibilityItemPathSchema>;

export const compatibilityRecordPathSchema = z.object({ recordId: z.uuid() });

export type CompatibilityRecordPath = z.infer<typeof compatibilityRecordPathSchema>;

export const itemCompatibilityQuerySchema = z.object({
  /** `true` — also the archived records (history). */
  includeArchived: z.enum(["true", "false"]).optional(),
});

export type ItemCompatibilityQuery = z.infer<typeof itemCompatibilityQuerySchema>;

export const createCompatibilityRecordBodySchema = z.object({
  conditions: compatibilityConditionsInputSchema,
  evidence: evidenceSchema,
});

export type CreateCompatibilityRecordBody = z.infer<typeof createCompatibilityRecordBodySchema>;

/** Conditions, when given, replace the old ones whole. */
export const updateCompatibilityRecordBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  conditions: compatibilityConditionsInputSchema.optional(),
  evidence: evidenceSchema.optional(),
});

export type UpdateCompatibilityRecordBody = z.infer<typeof updateCompatibilityRecordBodySchema>;

export const archiveCompatibilityRecordBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
});

export type ArchiveCompatibilityRecordBody = z.infer<typeof archiveCompatibilityRecordBodySchema>;

export const copyCompatibilityBodySchema = z.object({
  /** An analog of the item whose approved records are copied onto it. */
  fromItemId: z.uuid(),
});

export type CopyCompatibilityBody = z.infer<typeof copyCompatibilityBodySchema>;

export const adminCompatibilityRecordResponseSchema = z.object({
  record: adminCompatibilityRecordSchema,
});

export type AdminCompatibilityRecordResponse = z.infer<
  typeof adminCompatibilityRecordResponseSchema
>;

// -------------------------------------------------------------- proposals

/**
 * `pending` — waits for an administrator; `approved` — a record was made
 * from it (or an equal approved record already existed — `resolution`);
 * `rejected` — with the reason the supplier sees.
 */
export const compatibilityProposalStatusSchema = z.enum(["pending", "approved", "rejected"]);

export type CompatibilityProposalStatus = z.infer<typeof compatibilityProposalStatusSchema>;

/** `supplier`; `ai` — reserved for the check of stage D. */
export const compatibilityProposalSourceSchema = z.enum(["supplier", "ai"]);

export type CompatibilityProposalSource = z.infer<typeof compatibilityProposalSourceSchema>;

/**
 * How an approved proposal ended: `created` — a new record; `already_approved`
 * — the same record was already approved, nothing was duplicated.
 */
export const compatibilityProposalResolutionSchema = z.enum(["created", "already_approved"]);

export type CompatibilityProposalResolution = z.infer<typeof compatibilityProposalResolutionSchema>;

/** A proposal as its supplier sees it. */
export const supplierCompatibilityProposalSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  conditions: compatibilityConditionsSchema,
  label: compatibilityConditionsLabelSchema,
  evidence: z.string(),
  status: compatibilityProposalStatusSchema,
  resolution: compatibilityProposalResolutionSchema.nullable(),
  /** Approved, but with conditions the administrator corrected. */
  approvedWithChanges: z.boolean(),
  rejectionReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
});

export type SupplierCompatibilityProposal = z.infer<typeof supplierCompatibilityProposalSchema>;

/** The item a proposal is about, for the moderation queue. */
export const compatibilityProposalItemSchema = z.object({
  id: z.uuid(),
  type: z.enum(["part", "generic"]),
  brand: z.string().nullable(),
  article: z.string().nullable(),
  /** The Russian name. */
  name: z.string().nullable(),
  status: z.enum(["draft", "active", "archived"]),
});

export type CompatibilityProposalItem = z.infer<typeof compatibilityProposalItemSchema>;

/** A proposal in the administrator's queue (A-MOD). */
export const adminCompatibilityProposalSchema = supplierCompatibilityProposalSchema.extend({
  source: compatibilityProposalSourceSchema,
  item: compatibilityProposalItemSchema,
  supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  supplierMemberId: z.uuid().nullable(),
  /** An approved record of the item with exactly these conditions: approving adds nothing. */
  matchesRecordId: z.uuid().nullable(),
  /** The record it was approved into. */
  recordId: z.uuid().nullable(),
  reviewedByAdminId: z.uuid().nullable(),
});

export type AdminCompatibilityProposal = z.infer<typeof adminCompatibilityProposalSchema>;

export const compatibilityProposalPathSchema = z.object({ proposalId: z.uuid() });

export type CompatibilityProposalPath = z.infer<typeof compatibilityProposalPathSchema>;

export const createCompatibilityProposalBodySchema = z.object({
  conditions: compatibilityConditionsInputSchema,
  evidence: evidenceSchema,
});

export type CreateCompatibilityProposalBody = z.infer<typeof createCompatibilityProposalBodySchema>;

export const supplierCompatibilityProposalResponseSchema = z.object({
  proposal: supplierCompatibilityProposalSchema,
});

export type SupplierCompatibilityProposalResponse = z.infer<
  typeof supplierCompatibilityProposalResponseSchema
>;

export const supplierCompatibilityProposalQuerySchema = z.object({
  status: compatibilityProposalStatusSchema.optional(),
  itemId: z.uuid().optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type SupplierCompatibilityProposalQuery = z.infer<
  typeof supplierCompatibilityProposalQuerySchema
>;

export const supplierCompatibilityProposalPageSchema = z.object({
  proposals: z.array(supplierCompatibilityProposalSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type SupplierCompatibilityProposalPage = z.infer<
  typeof supplierCompatibilityProposalPageSchema
>;

export const adminCompatibilityProposalQuerySchema = z.object({
  /** `pending` when left out: the queue. */
  status: compatibilityProposalStatusSchema.default("pending"),
  itemId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type AdminCompatibilityProposalQuery = z.infer<typeof adminCompatibilityProposalQuerySchema>;

export const adminCompatibilityProposalPageSchema = z.object({
  proposals: z.array(adminCompatibilityProposalSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminCompatibilityProposalPage = z.infer<typeof adminCompatibilityProposalPageSchema>;

/**
 * Approve as proposed, or with corrected conditions (they replace the
 * proposed ones whole) and grounds.
 */
export const approveCompatibilityProposalBodySchema = z.object({
  conditions: compatibilityConditionsInputSchema.optional(),
  evidence: evidenceSchema.optional(),
});

export type ApproveCompatibilityProposalBody = z.infer<
  typeof approveCompatibilityProposalBodySchema
>;

export const rejectCompatibilityProposalBodySchema = z.object({
  reason: plainText(COMPATIBILITY_REJECTION_REASON_MAX_LENGTH),
});

export type RejectCompatibilityProposalBody = z.infer<typeof rejectCompatibilityProposalBodySchema>;

export const adminCompatibilityProposalResponseSchema = z.object({
  proposal: adminCompatibilityProposalSchema,
  /** The record the approval made or found; `null` after a rejection. */
  record: adminCompatibilityRecordSchema.nullable(),
});

export type AdminCompatibilityProposalResponse = z.infer<
  typeof adminCompatibilityProposalResponseSchema
>;

/** The compatibility card of an item (A-CAT-05, tab «Совместимость»). */
export const adminItemCompatibilityResponseSchema = z.object({
  itemId: z.uuid(),
  /** `false` for a service: compatibility isn't kept for services. */
  applicable: z.boolean(),
  records: z.array(adminCompatibilityRecordSchema),
  /** Proposals waiting for review. */
  proposals: z.array(adminCompatibilityProposalSchema),
});

export type AdminItemCompatibilityResponse = z.infer<typeof adminItemCompatibilityResponseSchema>;

export const copyCompatibilityResponseSchema = z.object({
  /** Records copied onto the item. */
  created: z.number().int(),
  /** Records of the analog the item already had. */
  alreadyPresent: z.number().int(),
  records: z.array(adminCompatibilityRecordSchema),
});

export type CopyCompatibilityResponse = z.infer<typeof copyCompatibilityResponseSchema>;

// ------------------------------------------------------------------ check

/**
 * A car as the client knows it: a whole modification, or only the levels
 * that are known — the rest left out. Levels above a known one are taken
 * from the vehicle catalog (a generation gives its model and make, a
 * modification everything); a level given together with one that implies
 * it must agree with it. `year` is the car's year; without it the years of
 * the modification or the generation, if known, are used.
 */
export const compatibilityVehicleSchema = z.object({
  modificationId: z.uuid().optional(),
  makeId: z.uuid().optional(),
  modelId: z.uuid().optional(),
  generationId: z.uuid().optional(),
  bodyTypeId: z.uuid().optional(),
  engineId: z.uuid().optional(),
  transmissionTypeId: z.uuid().optional(),
  driveTypeId: z.uuid().optional(),
  year: yearSchema.optional(),
});

export type CompatibilityVehicle = z.infer<typeof compatibilityVehicleSchema>;

/**
 * Items to check: `itemIds` (up to `COMPATIBILITY_CHECK_MAX_ITEMS`) or a
 * whole subcategory by `categoryId` — exactly one of them. Without
 * `vehicle` — no car is chosen (D-029: everything is shown).
 *
 * A subcategory is answered page by page, newest items first (TASK-016):
 * `limit` items at most (default and maximum
 * `COMPATIBILITY_CHECK_CATEGORY_PAGE_MAX`), the next page with `cursor` =
 * `nextCursor` of the previous answer and the same car. Both are refused
 * with `itemIds`.
 */
export const compatibilityCheckBodySchema = z.object({
  vehicle: compatibilityVehicleSchema.nullable().optional(),
  itemIds: z.array(z.uuid()).min(1).max(COMPATIBILITY_CHECK_MAX_ITEMS).optional(),
  categoryId: z.uuid().optional(),
  limit: z.number().int().min(1).max(COMPATIBILITY_CHECK_CATEGORY_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(300).optional(),
});

export type CompatibilityCheckBody = z.infer<typeof compatibilityCheckBodySchema>;

/** The car as the server understood it: known levels, `null` — unknown. */
export const resolvedCompatibilityVehicleSchema = z.object({
  modificationId: z.uuid().nullable(),
  makeId: z.uuid(),
  modelId: z.uuid().nullable(),
  generationId: z.uuid().nullable(),
  bodyTypeId: z.uuid().nullable(),
  engineId: z.uuid().nullable(),
  transmissionTypeId: z.uuid().nullable(),
  driveTypeId: z.uuid().nullable(),
  year: z.number().int().nullable(),
  /** The years the car can be of: its year, else the modification's or the generation's. */
  yearFrom: z.number().int().nullable(),
  /** `null` with `yearFrom` — still made. */
  yearTo: z.number().int().nullable(),
});

export type ResolvedCompatibilityVehicle = z.infer<typeof resolvedCompatibilityVehicleSchema>;

export const compatibilityItemResultSchema = z.object({
  itemId: z.uuid(),
  categoryId: z.uuid(),
  /** D-029: the subcategory demands compatibility. */
  compatibilityRequired: z.boolean(),
  /** Whether the item has approved records at all. */
  hasCompatibility: z.boolean(),
  /**
   * The result for the car; `null` only when no car was given and the item
   * has records (there is nothing to compare them with).
   */
  result: compatibilityResultSchema.nullable(),
  /** With `needs_details`: the levels to fill in, in `compatibilityLevel` order. */
  missing: z.array(compatibilityLevelSchema),
  /**
   * The mark to show next to the item (DESIGN 7.8); `null` — no mark (a
   * universal subcategory without records, or no car chosen).
   */
  mark: compatibilityResultSchema.nullable(),
  /** Whether a list shows the item (D-029). An item opened directly is always shown. */
  listed: z.boolean(),
  /**
   * Opened directly, the item is shown with a clear warning, and a request
   * for it needs the user's confirmation that they understand it doesn't
   * fit (PRODUCT 7.5; the confirmation itself is the requests' task).
   */
  requiresConfirmation: z.boolean(),
});

export type CompatibilityItemResult = z.infer<typeof compatibilityItemResultSchema>;

export const compatibilityCheckResponseSchema = z.object({
  vehicle: resolvedCompatibilityVehicleSchema.nullable(),
  items: z.array(compatibilityItemResultSchema),
  /**
   * Named items a client can't see — missing, draft, archived, or in a
   * hidden subcategory — alike.
   */
  notFound: z.array(z.uuid()),
  /**
   * A subcategory with more items: pass as `cursor` for the next page.
   * `null` — the last page, and always for `itemIds`.
   */
  nextCursor: z.string().nullable(),
});

export type CompatibilityCheckResponse = z.infer<typeof compatibilityCheckResponseSchema>;

// ----------------------------------------------------------------- errors

/**
 * `details` of `COMPATIBILITY_CONDITIONS_INVALID` (400): `field` — the
 * level at fault. `not_found` — no such make, model, generation, engine or
 * option of this list; `model_of_other_make`, `generation_of_other_model`;
 * `years_order` — `yearTo` before `yearFrom`; `years_outside_generation`.
 */
export const compatibilityConditionsInvalidReasonSchema = z.enum([
  "not_found",
  "model_of_other_make",
  "generation_of_other_model",
  "years_order",
  "years_outside_generation",
]);

export const compatibilityConditionsInvalidDetailsSchema = z.object({
  reason: compatibilityConditionsInvalidReasonSchema,
  field: z.string(),
});

export type CompatibilityConditionsInvalidDetails = z.infer<
  typeof compatibilityConditionsInvalidDetailsSchema
>;

/**
 * `details` of `COMPATIBILITY_VEHICLE_INVALID` (400): the car in the
 * request doesn't hold together. `not_found` — no such row (`field`);
 * `make_required` — nothing gives the make; `model_of_other_make`,
 * `generation_of_other_model`; `modification_mismatch` — a level differs
 * from the modification's; `year_outside` — the year is outside the years
 * of the generation or the modification.
 */
export const compatibilityVehicleInvalidReasonSchema = z.enum([
  "not_found",
  "make_required",
  "model_of_other_make",
  "generation_of_other_model",
  "modification_mismatch",
  "year_outside",
]);

export const compatibilityVehicleInvalidDetailsSchema = z.object({
  reason: compatibilityVehicleInvalidReasonSchema,
  field: z.string(),
});

export type CompatibilityVehicleInvalidDetails = z.infer<
  typeof compatibilityVehicleInvalidDetailsSchema
>;

/** `details` of `COMPATIBILITY_VERSION_CONFLICT` (409). */
export const compatibilityVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int(),
});

export type CompatibilityVersionConflictDetails = z.infer<
  typeof compatibilityVersionConflictDetailsSchema
>;

/** `details` of `COMPATIBILITY_DUPLICATE` (409): the approved record with these conditions. */
export const compatibilityDuplicateDetailsSchema = z.object({
  existingId: z.uuid(),
});

export type CompatibilityDuplicateDetails = z.infer<typeof compatibilityDuplicateDetailsSchema>;

/** `details` of `COMPATIBILITY_PROPOSAL_STATE` (409): the proposal was already reviewed. */
export const compatibilityProposalStateDetailsSchema = z.object({
  status: compatibilityProposalStatusSchema,
});

export type CompatibilityProposalStateDetails = z.infer<
  typeof compatibilityProposalStateDetailsSchema
>;
