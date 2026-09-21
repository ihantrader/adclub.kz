import { z } from "zod";
import { catalogLanguageSchema, localizedTextSchema } from "./catalog";

/**
 * The vehicle catalog (PRODUCT 7.5, 7.7; ARCHITECTURE 5.3, 4.24; TASK-014;
 * SCREENS A-CAR-01, A-CAR-02, M-GAR-03): make → model → generation (years)
 * → modification (body, engine, transmission, drive, years, market), the
 * reference lists modifications are made of, engines, and imports of the
 * catalog from a file with a report before anything changes.
 *
 * Only the administrator keeps it; clients read the active part step by
 * step to choose a car (the garage, EPIC-10). Proper names — makes,
 * models, generations, engine codes — are never translated; the reference
 * lists (body, transmission, drive, fuel) have names in kk/ru/en written
 * by hand. Enum values here are only ever added (ARCHITECTURE 7.4).
 */

/** The reference lists: body type, transmission, drive, fuel of an engine. */
export const vehicleOptionKindSchema = z.enum(["body", "transmission", "drive", "fuel"]);

export type VehicleOptionKind = z.infer<typeof vehicleOptionKindSchema>;

/**
 * `archived` — not offered for a new choice; whoever chose it keeps it.
 * Archiving a make, a model or a generation hides what is below it from
 * clients without changing their status. There is no deletion.
 */
export const vehicleEntryStatusSchema = z.enum(["active", "archived"]);

export type VehicleEntryStatus = z.infer<typeof vehicleEntryStatusSchema>;

/**
 * How a record came to be: `manual` — the administrator (or the
 * development seed); `import` — a file (A-CAR-02); `ai` — reserved for the
 * recognition of vehicle documents (stage D), modifications only.
 */
export const vehicleSourceSchema = z.enum(["manual", "import", "ai"]);

export type VehicleSource = z.infer<typeof vehicleSourceSchema>;

/**
 * `kz` — a configuration sold in Kazakhstan (they differ from the global
 * ones, PRODUCT 7.7); `global` — any other.
 */
export const vehicleMarketSchema = z.enum(["kz", "global"]);

export type VehicleMarket = z.infer<typeof vehicleMarketSchema>;

export const VEHICLE_YEAR_MIN = 1900;
export const VEHICLE_YEAR_MAX = 2100;
/** A make, a model, a generation name, a spelling. */
export const VEHICLE_NAME_MAX_LENGTH = 60;
export const VEHICLE_ALIASES_MAX = 20;
/** A name of a reference list option in one language. */
export const VEHICLE_OPTION_NAME_MAX_LENGTH = 40;
export const VEHICLE_ENGINE_CODE_MAX_LENGTH = 40;
export const VEHICLE_PAGE_MAX_SIZE = 100;
export const VEHICLE_PAGE_DEFAULT_SIZE = 50;

const expectedVersionSchema = z.number().int().min(1);

function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

const yearSchema = z.number().int().min(VEHICLE_YEAR_MIN).max(VEHICLE_YEAR_MAX);

const queryYearSchema = z.coerce.number().int().min(VEHICLE_YEAR_MIN).max(VEHICLE_YEAR_MAX);

const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(VEHICLE_PAGE_MAX_SIZE)
  .default(VEHICLE_PAGE_DEFAULT_SIZE);

/** The `nextCursor` of the previous page: the only way to ask for the next one. */
const cursorSchema = z.string().min(1).max(300);

const aliasesSchema = z.array(plainText(VEHICLE_NAME_MAX_LENGTH)).max(VEHICLE_ALIASES_MAX);

/** A reference list option code: stable, never changes when the option is renamed. */
export const vehicleOptionCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{0,62}$/, {
  message: "Must be a snake_case code of 1–63 characters",
});

// ---------------------------------------------------------------- options

/** Names of an option by language; Russian is always there. */
export const vehicleOptionNamesSchema = z.object({
  ru: z.string(),
  kk: z.string().nullable(),
  en: z.string().nullable(),
});

export type VehicleOptionNames = z.infer<typeof vehicleOptionNamesSchema>;

export const adminVehicleOptionSchema = z.object({
  id: z.uuid(),
  kind: vehicleOptionKindSchema,
  code: z.string(),
  names: vehicleOptionNamesSchema,
  sort: z.number().int(),
  status: vehicleEntryStatusSchema,
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleOption = z.infer<typeof adminVehicleOptionSchema>;

export const vehicleOptionIdPathSchema = z.object({ optionId: z.uuid() });

export type VehicleOptionIdPath = z.infer<typeof vehicleOptionIdPathSchema>;

export const vehicleOptionListQuerySchema = z.object({
  kind: vehicleOptionKindSchema.optional(),
  status: vehicleEntryStatusSchema.optional(),
});

export type VehicleOptionListQuery = z.infer<typeof vehicleOptionListQuerySchema>;

export const adminVehicleOptionListResponseSchema = z.object({
  /** By kind, then in their order. */
  options: z.array(adminVehicleOptionSchema),
});

export type AdminVehicleOptionListResponse = z.infer<typeof adminVehicleOptionListResponseSchema>;

/**
 * A new option: Russian is required; Kazakh and English are written by
 * hand as well (these lists are never translated automatically) and may
 * be added later. A name is unique within its kind in each language,
 * case ignored — an import file names options by code or by any name.
 */
export const createVehicleOptionBodySchema = z.object({
  kind: vehicleOptionKindSchema,
  code: vehicleOptionCodeSchema,
  names: z.object({
    ru: plainText(VEHICLE_OPTION_NAME_MAX_LENGTH),
    kk: plainText(VEHICLE_OPTION_NAME_MAX_LENGTH).nullable().optional(),
    en: plainText(VEHICLE_OPTION_NAME_MAX_LENGTH).nullable().optional(),
  }),
});

export type CreateVehicleOptionBody = z.infer<typeof createVehicleOptionBodySchema>;

/** Names being changed: a language left out stays; `null` clears Kazakh or English. The code and kind never change. */
export const updateVehicleOptionBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  names: z
    .object({
      ru: plainText(VEHICLE_OPTION_NAME_MAX_LENGTH).optional(),
      kk: plainText(VEHICLE_OPTION_NAME_MAX_LENGTH).nullable().optional(),
      en: plainText(VEHICLE_OPTION_NAME_MAX_LENGTH).nullable().optional(),
    })
    .optional(),
});

export type UpdateVehicleOptionBody = z.infer<typeof updateVehicleOptionBodySchema>;

export const adminVehicleOptionResponseSchema = z.object({ option: adminVehicleOptionSchema });

export type AdminVehicleOptionResponse = z.infer<typeof adminVehicleOptionResponseSchema>;

/** Archive or restore any record of the vehicle catalog. */
export const setVehicleStatusBodySchema = z.object({
  status: vehicleEntryStatusSchema,
  expectedVersion: expectedVersionSchema,
});

export type SetVehicleStatusBody = z.infer<typeof setVehicleStatusBodySchema>;

/** An option as a modification or an engine refers to it. */
export const adminVehicleOptionRefSchema = z.object({
  id: z.uuid(),
  kind: vehicleOptionKindSchema,
  code: z.string(),
  names: vehicleOptionNamesSchema,
  status: vehicleEntryStatusSchema,
});

export type AdminVehicleOptionRef = z.infer<typeof adminVehicleOptionRefSchema>;

// ------------------------------------------------------------------ makes

export const adminVehicleMakeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Other spellings (`GEELY Auto`, `Джили`), alphabetically. */
  aliases: z.array(z.string()),
  source: vehicleSourceSchema,
  status: vehicleEntryStatusSchema,
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleMake = z.infer<typeof adminVehicleMakeSchema>;

export const vehicleMakeIdPathSchema = z.object({ makeId: z.uuid() });

export type VehicleMakeIdPath = z.infer<typeof vehicleMakeIdPathSchema>;

/** By name; `q` — a part of the name or of any other spelling (case and spaces ignored). */
export const vehicleMakeListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: vehicleEntryStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleMakeListQuery = z.infer<typeof vehicleMakeListQuerySchema>;

export const adminVehicleMakePageSchema = z.object({
  makes: z.array(adminVehicleMakeSchema),
  /** How many makes match the filters, on every page. */
  total: z.number().int(),
  /** Pass as `cursor` for the next page; `null` — this was the last one. */
  nextCursor: z.string().nullable(),
});

export type AdminVehicleMakePage = z.infer<typeof adminVehicleMakePageSchema>;

/**
 * The name and every other spelling are unique among all makes, archived
 * ones included, with case and spaces ignored: «Geely» and «GEELY» are one
 * make (409 `VEHICLE_DUPLICATE`).
 */
export const createVehicleMakeBodySchema = z.object({
  name: plainText(VEHICLE_NAME_MAX_LENGTH),
  aliases: aliasesSchema.optional(),
});

export type CreateVehicleMakeBody = z.infer<typeof createVehicleMakeBodySchema>;

/** `aliases` replaces the list as a whole. */
export const updateVehicleMakeBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  name: plainText(VEHICLE_NAME_MAX_LENGTH).optional(),
  aliases: aliasesSchema.optional(),
});

export type UpdateVehicleMakeBody = z.infer<typeof updateVehicleMakeBodySchema>;

export const adminVehicleMakeResponseSchema = z.object({ make: adminVehicleMakeSchema });

export type AdminVehicleMakeResponse = z.infer<typeof adminVehicleMakeResponseSchema>;

/** A parent as a lower level shows it. */
export const vehicleParentRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: vehicleEntryStatusSchema,
});

export type VehicleParentRef = z.infer<typeof vehicleParentRefSchema>;

// ----------------------------------------------------------------- models

export const adminVehicleModelSchema = z.object({
  id: z.uuid(),
  make: vehicleParentRefSchema,
  name: z.string(),
  aliases: z.array(z.string()),
  source: vehicleSourceSchema,
  status: vehicleEntryStatusSchema,
  /** Active, and so is its make: clients see it. */
  visibleToClients: z.boolean(),
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleModel = z.infer<typeof adminVehicleModelSchema>;

export const vehicleModelIdPathSchema = z.object({ modelId: z.uuid() });

export type VehicleModelIdPath = z.infer<typeof vehicleModelIdPathSchema>;

export const vehicleModelListQuerySchema = z.object({
  makeId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  status: vehicleEntryStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleModelListQuery = z.infer<typeof vehicleModelListQuerySchema>;

export const adminVehicleModelPageSchema = z.object({
  models: z.array(adminVehicleModelSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminVehicleModelPage = z.infer<typeof adminVehicleModelPageSchema>;

/** Name and spellings are unique within the make (case and spaces ignored). */
export const createVehicleModelBodySchema = z.object({
  makeId: z.uuid(),
  name: plainText(VEHICLE_NAME_MAX_LENGTH),
  aliases: aliasesSchema.optional(),
});

export type CreateVehicleModelBody = z.infer<typeof createVehicleModelBodySchema>;

/** `makeId` moves the model (with its generations and modifications) to another make. */
export const updateVehicleModelBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  makeId: z.uuid().optional(),
  name: plainText(VEHICLE_NAME_MAX_LENGTH).optional(),
  aliases: aliasesSchema.optional(),
});

export type UpdateVehicleModelBody = z.infer<typeof updateVehicleModelBodySchema>;

export const adminVehicleModelResponseSchema = z.object({ model: adminVehicleModelSchema });

export type AdminVehicleModelResponse = z.infer<typeof adminVehicleModelResponseSchema>;

// ------------------------------------------------------------ generations

export const adminVehicleGenerationSchema = z.object({
  id: z.uuid(),
  make: vehicleParentRefSchema,
  model: vehicleParentRefSchema,
  name: z.string(),
  yearFrom: z.number().int(),
  /** `null` — still made. */
  yearTo: z.number().int().nullable(),
  source: vehicleSourceSchema,
  status: vehicleEntryStatusSchema,
  visibleToClients: z.boolean(),
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleGeneration = z.infer<typeof adminVehicleGenerationSchema>;

export const vehicleGenerationIdPathSchema = z.object({ generationId: z.uuid() });

export type VehicleGenerationIdPath = z.infer<typeof vehicleGenerationIdPathSchema>;

/** `year` — generations whose years include it (an open end counts as still made). */
export const vehicleGenerationListQuerySchema = z.object({
  makeId: z.uuid().optional(),
  modelId: z.uuid().optional(),
  year: queryYearSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  status: vehicleEntryStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleGenerationListQuery = z.infer<typeof vehicleGenerationListQuerySchema>;

export const adminVehicleGenerationPageSchema = z.object({
  generations: z.array(adminVehicleGenerationSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminVehicleGenerationPage = z.infer<typeof adminVehicleGenerationPageSchema>;

/** The name is unique within the model (case ignored); `yearTo` is left out or `null` while still made. */
export const createVehicleGenerationBodySchema = z.object({
  modelId: z.uuid(),
  name: plainText(VEHICLE_NAME_MAX_LENGTH),
  yearFrom: yearSchema,
  yearTo: yearSchema.nullable().optional(),
});

export type CreateVehicleGenerationBody = z.infer<typeof createVehicleGenerationBodySchema>;

/**
 * `modelId` moves the generation (with its modifications) to another
 * model. New years must still cover every modification of the generation.
 */
export const updateVehicleGenerationBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  modelId: z.uuid().optional(),
  name: plainText(VEHICLE_NAME_MAX_LENGTH).optional(),
  yearFrom: yearSchema.optional(),
  yearTo: yearSchema.nullable().optional(),
});

export type UpdateVehicleGenerationBody = z.infer<typeof updateVehicleGenerationBodySchema>;

export const adminVehicleGenerationResponseSchema = z.object({
  generation: adminVehicleGenerationSchema,
});

export type AdminVehicleGenerationResponse = z.infer<typeof adminVehicleGenerationResponseSchema>;

// ---------------------------------------------------------------- engines

export const adminVehicleEngineSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  aliases: z.array(z.string()),
  /** Litres; `null` for an electric motor or when unknown. */
  displacementL: z.number().nullable(),
  fuel: adminVehicleOptionRefSchema,
  powerHp: z.number().int().nullable(),
  source: vehicleSourceSchema,
  status: vehicleEntryStatusSchema,
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleEngine = z.infer<typeof adminVehicleEngineSchema>;

export const vehicleEngineIdPathSchema = z.object({ engineId: z.uuid() });

export type VehicleEngineIdPath = z.infer<typeof vehicleEngineIdPathSchema>;

/** By code; `q` — a part of the code or of any other spelling (case and spaces ignored). */
export const vehicleEngineListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  fuelId: z.uuid().optional(),
  status: vehicleEntryStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleEngineListQuery = z.infer<typeof vehicleEngineListQuerySchema>;

export const adminVehicleEnginePageSchema = z.object({
  engines: z.array(adminVehicleEngineSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminVehicleEnginePage = z.infer<typeof adminVehicleEnginePageSchema>;

const displacementSchema = z.number().min(0.1).max(20);
const powerSchema = z.number().int().min(1).max(3000);

/** Code and spellings are unique among all engines (case and spaces ignored). */
export const createVehicleEngineBodySchema = z.object({
  code: plainText(VEHICLE_ENGINE_CODE_MAX_LENGTH),
  aliases: z.array(plainText(VEHICLE_ENGINE_CODE_MAX_LENGTH)).max(VEHICLE_ALIASES_MAX).optional(),
  displacementL: displacementSchema.nullable().optional(),
  fuelId: z.uuid(),
  powerHp: powerSchema.nullable().optional(),
});

export type CreateVehicleEngineBody = z.infer<typeof createVehicleEngineBodySchema>;

export const updateVehicleEngineBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  code: plainText(VEHICLE_ENGINE_CODE_MAX_LENGTH).optional(),
  aliases: z.array(plainText(VEHICLE_ENGINE_CODE_MAX_LENGTH)).max(VEHICLE_ALIASES_MAX).optional(),
  displacementL: displacementSchema.nullable().optional(),
  fuelId: z.uuid().optional(),
  powerHp: powerSchema.nullable().optional(),
});

export type UpdateVehicleEngineBody = z.infer<typeof updateVehicleEngineBodySchema>;

export const adminVehicleEngineResponseSchema = z.object({ engine: adminVehicleEngineSchema });

export type AdminVehicleEngineResponse = z.infer<typeof adminVehicleEngineResponseSchema>;

// ---------------------------------------------------------- modifications

export const adminVehicleModificationSchema = z.object({
  id: z.uuid(),
  make: vehicleParentRefSchema,
  model: vehicleParentRefSchema,
  generation: vehicleParentRefSchema.extend({
    yearFrom: z.number().int(),
    yearTo: z.number().int().nullable(),
  }),
  bodyType: adminVehicleOptionRefSchema,
  engine: z.object({
    id: z.uuid(),
    code: z.string(),
    displacementL: z.number().nullable(),
    powerHp: z.number().int().nullable(),
    fuel: adminVehicleOptionRefSchema,
    status: vehicleEntryStatusSchema,
  }),
  transmissionType: adminVehicleOptionRefSchema,
  driveType: adminVehicleOptionRefSchema,
  yearFrom: z.number().int(),
  yearTo: z.number().int().nullable(),
  market: vehicleMarketSchema,
  source: vehicleSourceSchema,
  /** The import that created it (`source: import`). */
  importId: z.uuid().nullable(),
  status: vehicleEntryStatusSchema,
  /** Active, and so are its generation, model and make: clients see it. */
  visibleToClients: z.boolean(),
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleModification = z.infer<typeof adminVehicleModificationSchema>;

export const vehicleModificationIdPathSchema = z.object({ modificationId: z.uuid() });

export type VehicleModificationIdPath = z.infer<typeof vehicleModificationIdPathSchema>;

/** Newest first. `year` — modifications whose years include it. */
export const vehicleModificationListQuerySchema = z.object({
  makeId: z.uuid().optional(),
  modelId: z.uuid().optional(),
  generationId: z.uuid().optional(),
  engineId: z.uuid().optional(),
  year: queryYearSchema.optional(),
  market: vehicleMarketSchema.optional(),
  source: vehicleSourceSchema.optional(),
  status: vehicleEntryStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleModificationListQuery = z.infer<typeof vehicleModificationListQuerySchema>;

export const adminVehicleModificationPageSchema = z.object({
  modifications: z.array(adminVehicleModificationSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminVehicleModificationPage = z.infer<typeof adminVehicleModificationPageSchema>;

/**
 * The same generation, body, engine, transmission, drive and years is one
 * modification (409 `VEHICLE_DUPLICATE` with the existing one); the years
 * lie within the generation's (400 `VEHICLE_YEARS_INVALID`).
 */
export const createVehicleModificationBodySchema = z.object({
  generationId: z.uuid(),
  bodyTypeId: z.uuid(),
  engineId: z.uuid(),
  transmissionTypeId: z.uuid(),
  driveTypeId: z.uuid(),
  yearFrom: yearSchema,
  yearTo: yearSchema.nullable().optional(),
  market: vehicleMarketSchema,
});

export type CreateVehicleModificationBody = z.infer<typeof createVehicleModificationBodySchema>;

export const updateVehicleModificationBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  generationId: z.uuid().optional(),
  bodyTypeId: z.uuid().optional(),
  engineId: z.uuid().optional(),
  transmissionTypeId: z.uuid().optional(),
  driveTypeId: z.uuid().optional(),
  yearFrom: yearSchema.optional(),
  yearTo: yearSchema.nullable().optional(),
  market: vehicleMarketSchema.optional(),
});

export type UpdateVehicleModificationBody = z.infer<typeof updateVehicleModificationBodySchema>;

export const adminVehicleModificationResponseSchema = z.object({
  modification: adminVehicleModificationSchema,
});

export type AdminVehicleModificationResponse = z.infer<
  typeof adminVehicleModificationResponseSchema
>;

// ----------------------------------------------------------------- errors

/** `details` of `VEHICLE_VERSION_CONFLICT`. */
export const vehicleVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int(),
});

export type VehicleVersionConflictDetails = z.infer<typeof vehicleVersionConflictDetailsSchema>;

export const vehicleEntitySchema = z.enum([
  "option",
  "make",
  "model",
  "generation",
  "engine",
  "modification",
]);

export type VehicleEntity = z.infer<typeof vehicleEntitySchema>;

/**
 * `details` of `VEHICLE_DUPLICATE`: «Такая запись уже есть» — the record
 * that already has this name, spelling, code or set of values (it may be
 * archived: restore it instead). `spelling` — the text that clashed.
 */
export const vehicleDuplicateDetailsSchema = z.object({
  entity: vehicleEntitySchema,
  existingId: z.uuid(),
  spelling: z.string().nullable(),
});

export type VehicleDuplicateDetails = z.infer<typeof vehicleDuplicateDetailsSchema>;

/** `details` of `VEHICLE_REFERENCE_ARCHIVED`: the field that names an archived record. */
export const vehicleReferenceArchivedDetailsSchema = z.object({
  field: z.string(),
});

export type VehicleReferenceArchivedDetails = z.infer<typeof vehicleReferenceArchivedDetailsSchema>;

/**
 * `details` of `VEHICLE_YEARS_INVALID`: `order` — the end is before the
 * start; `outside_generation` — a modification's years leave its
 * generation's; `modifications_outside` — new years of a generation would
 * leave out some of its modifications (`modificationIds`, up to 20).
 */
export const vehicleYearsInvalidDetailsSchema = z.object({
  reason: z.enum(["order", "outside_generation", "modifications_outside"]),
  generationYears: z.object({ from: z.number().int(), to: z.number().int().nullable() }).nullable(),
  modificationIds: z.array(z.uuid()),
});

export type VehicleYearsInvalidDetails = z.infer<typeof vehicleYearsInvalidDetailsSchema>;

// ----------------------------------------------------------------- import

/**
 * Types the upload takes. What the file is decides its content, not the
 * name or the declared type: a spreadsheet saved as `.xlsx` is recognised
 * and refused with a hint to save it as CSV.
 */
export const VEHICLE_IMPORT_CONTENT_TYPES = [
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
] as const;

/**
 * The most the server reads of an import file, whatever
 * `vehicle_import_max_file_mb` says (that setting can only be lower).
 */
export const VEHICLE_IMPORT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** The longest value of one cell. */
export const VEHICLE_IMPORT_CELL_MAX_LENGTH = 100;

/**
 * Columns of an import file, one row per modification. Required columns
 * must be in the header; optional ones may be left out entirely; any
 * other column is an error (a misspelt header must not be ignored).
 */
export const vehicleImportColumns = [
  "make",
  "model",
  "generation",
  "generation_year_from",
  "generation_year_to",
  "body",
  "engine_code",
  "engine_displacement_l",
  "engine_fuel",
  "engine_power_hp",
  "transmission",
  "drive",
  "year_from",
  "year_to",
  "market",
] as const;

export const vehicleImportColumnSchema = z.enum(vehicleImportColumns);

export type VehicleImportColumn = z.infer<typeof vehicleImportColumnSchema>;

export const vehicleImportRequiredColumns = [
  "make",
  "model",
  "generation",
  "body",
  "engine_code",
  "transmission",
  "drive",
  "year_from",
  "market",
] as const satisfies readonly VehicleImportColumn[];

export const vehicleImportTemplateColumnSchema = z.object({
  name: vehicleImportColumnSchema,
  required: z.boolean(),
  /** What goes there, in Russian — for the administrator. */
  description: z.string(),
  example: z.string(),
});

export type VehicleImportTemplateColumn = z.infer<typeof vehicleImportTemplateColumnSchema>;

/**
 * `GET /admin/vehicles/import-template`: what a file must look like — the
 * columns with a description and an example, and the template itself as
 * CSV text (a header and one example row) for the admin panel to offer as
 * a download (A-CAR-02 «Скачать шаблон»).
 */
export const vehicleImportTemplateResponseSchema = z.object({
  fileName: z.string(),
  contentType: z.literal("text/csv"),
  encoding: z.literal("utf-8"),
  delimiter: z.string(),
  columns: z.array(vehicleImportTemplateColumnSchema),
  /** The reference list values a file may name, by kind: codes and names in any language. */
  options: z.array(
    z.object({
      kind: vehicleOptionKindSchema,
      code: z.string(),
      names: vehicleOptionNamesSchema,
    }),
  ),
  csv: z.string(),
});

export type VehicleImportTemplateResponse = z.infer<typeof vehicleImportTemplateResponseSchema>;

/**
 * - `parsing` — the rows are being checked by a background job;
 * - `ready` — the report waits for the administrator; nothing has changed;
 * - `applying` — confirmed, being applied by a background job;
 * - `applied` — done, `result` says what happened;
 * - `cancelled` — the administrator declined it; nothing has changed;
 * - `failed` — the check or the application broke off (`error` says why).
 */
export const vehicleImportStatusSchema = z.enum([
  "parsing",
  "ready",
  "applying",
  "applied",
  "cancelled",
  "failed",
]);

export type VehicleImportStatus = z.infer<typeof vehicleImportStatusSchema>;

/** What the check planned for a row. */
export const vehicleImportPlanSchema = z.enum(["create", "update", "unchanged", "rejected"]);

export type VehicleImportPlan = z.infer<typeof vehicleImportPlanSchema>;

/** What applying a row did. */
export const vehicleImportOutcomeSchema = z.enum(["created", "updated", "unchanged", "rejected"]);

export type VehicleImportOutcome = z.infer<typeof vehicleImportOutcomeSchema>;

/**
 * Why a row is refused:
 * - `wrong_field_count` — the row has more or fewer cells than the header;
 * - `missing_value` — a required cell is empty;
 * - `too_long` — a cell is longer than `VEHICLE_IMPORT_CELL_MAX_LENGTH`;
 * - `invalid_year`, `invalid_number`, `invalid_market` — not a value of
 *   that kind;
 * - `year_order` — the end is before the start;
 * - `years_outside_generation` — the modification's years leave the
 *   generation's;
 * - `unknown_option` — no body / transmission / drive / fuel by that code
 *   or name (nothing is created from a file for these lists);
 * - `archived_reference` — the make, model, generation, engine or option
 *   named is archived;
 * - `generation_not_found` — no such generation of the model, and the row
 *   gives no generation years to create it;
 * - `generation_years_mismatch` — the generation exists (or an earlier row
 *   creates it) with other years;
 * - `engine_mismatch` — the engine exists with another fuel, displacement
 *   or power;
 * - `engine_fuel_required` — a new engine needs its fuel;
 * - `duplicate_in_file` — an earlier row of the file is the same
 *   modification;
 * - `matches_archived` — the modification exists and is archived: restore
 *   it by hand.
 */
export const vehicleImportReasonCodeSchema = z.enum([
  "wrong_field_count",
  "missing_value",
  "too_long",
  "invalid_year",
  "invalid_number",
  "invalid_market",
  "year_order",
  "years_outside_generation",
  "unknown_option",
  "archived_reference",
  "generation_not_found",
  "generation_years_mismatch",
  "engine_mismatch",
  "engine_fuel_required",
  "duplicate_in_file",
  "matches_archived",
]);

export type VehicleImportReasonCode = z.infer<typeof vehicleImportReasonCodeSchema>;

export const vehicleImportReasonSchema = z.object({
  code: vehicleImportReasonCodeSchema,
  /** The column at fault; `null` — the row as a whole. */
  column: vehicleImportColumnSchema.nullable(),
  message: z.string(),
});

export type VehicleImportReason = z.infer<typeof vehicleImportReasonSchema>;

/** How many rejected rows the report lists itself; the rest are in `GET …/rows`. */
export const VEHICLE_IMPORT_REPORT_REJECTED_MAX = 100;

/**
 * The report before applying (A-CAR-02): «Добавится N, обновится M, без
 * изменений U, ошибок K (строки …)». `update` — the modification exists and
 * its market differs; `unchanged` — it exists exactly as the row says.
 * New makes, models, generations and engines the file would create are
 * listed with the first row that names them, so a misspelt make is seen
 * before it is created.
 */
export const vehicleImportReportSchema = z.object({
  create: z.number().int(),
  update: z.number().int(),
  unchanged: z.number().int(),
  rejected: z.number().int(),
  newMakes: z.array(z.object({ row: z.number().int(), name: z.string() })),
  newModels: z.array(z.object({ row: z.number().int(), make: z.string(), name: z.string() })),
  newGenerations: z.array(
    z.object({
      row: z.number().int(),
      make: z.string(),
      model: z.string(),
      name: z.string(),
      yearFrom: z.number().int(),
      yearTo: z.number().int().nullable(),
    }),
  ),
  newEngines: z.array(z.object({ row: z.number().int(), code: z.string() })),
  /** The first `VEHICLE_IMPORT_REPORT_REJECTED_MAX` rejected rows with their reasons. */
  rejectedRows: z.array(
    z.object({ row: z.number().int(), reasons: z.array(vehicleImportReasonSchema) }),
  ),
});

export type VehicleImportReport = z.infer<typeof vehicleImportReportSchema>;

/**
 * What applying did. Rows are checked again when applied, against the
 * catalog as it is then: a row whose outcome is not what the report
 * planned (the catalog was changed by hand meanwhile) is counted in
 * `differsFromReport`, and its row says why.
 */
export const vehicleImportResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  rejected: z.number().int(),
  differsFromReport: z.number().int(),
});

export type VehicleImportResult = z.infer<typeof vehicleImportResultSchema>;

export const adminVehicleImportSchema = z.object({
  id: z.uuid(),
  status: vehicleImportStatusSchema,
  fileName: z.string().nullable(),
  byteSize: z.number().int(),
  rowCount: z.number().int(),
  delimiter: z.string(),
  /** Present from `ready` on (and kept when cancelled after it). */
  report: vehicleImportReportSchema.nullable(),
  result: vehicleImportResultSchema.nullable(),
  error: z.string().nullable(),
  /** An earlier import of the very same file, if there was one. */
  sameFileAsImportId: z.uuid().nullable(),
  uploadedBy: z.object({ adminId: z.uuid(), accountId: z.uuid() }),
  appliedBy: z.object({ adminId: z.uuid(), accountId: z.uuid() }).nullable(),
  createdAt: z.iso.datetime(),
  analyzedAt: z.iso.datetime().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminVehicleImport = z.infer<typeof adminVehicleImportSchema>;

export const vehicleImportIdPathSchema = z.object({ importId: z.uuid() });

export type VehicleImportIdPath = z.infer<typeof vehicleImportIdPathSchema>;

/** The body is the file itself; its name, for the history, goes here. */
export const uploadVehicleImportQuerySchema = z.object({
  fileName: plainText(200).optional(),
});

export type UploadVehicleImportQuery = z.infer<typeof uploadVehicleImportQuerySchema>;

export const adminVehicleImportResponseSchema = z.object({ import: adminVehicleImportSchema });

export type AdminVehicleImportResponse = z.infer<typeof adminVehicleImportResponseSchema>;

/** The history of imports, newest first. */
export const vehicleImportListQuerySchema = z.object({
  status: vehicleImportStatusSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleImportListQuery = z.infer<typeof vehicleImportListQuerySchema>;

export const adminVehicleImportPageSchema = z.object({
  imports: z.array(adminVehicleImportSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminVehicleImportPage = z.infer<typeof adminVehicleImportPageSchema>;

/** Rows of an import in file order, with the plan or the outcome as a filter. */
export const vehicleImportRowsQuerySchema = z.object({
  planned: vehicleImportPlanSchema.optional(),
  outcome: vehicleImportOutcomeSchema.optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type VehicleImportRowsQuery = z.infer<typeof vehicleImportRowsQuerySchema>;

export const vehicleImportRowSchema = z.object({
  /** As a spreadsheet numbers it: the header is row 1. */
  row: z.number().int(),
  /** The cells as read, by column. */
  values: z.record(z.string(), z.string()),
  planned: vehicleImportPlanSchema.nullable(),
  reasons: z.array(vehicleImportReasonSchema),
  outcome: vehicleImportOutcomeSchema.nullable(),
  outcomeReasons: z.array(vehicleImportReasonSchema),
  /** The modification the row matched or created. */
  modificationId: z.uuid().nullable(),
});

export type VehicleImportRow = z.infer<typeof vehicleImportRowSchema>;

export const vehicleImportRowsPageSchema = z.object({
  rows: z.array(vehicleImportRowSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type VehicleImportRowsPage = z.infer<typeof vehicleImportRowsPageSchema>;

/**
 * `details` of `VEHICLE_IMPORT_FILE_INVALID` (400) — the file as a whole
 * can't be taken; nothing was stored:
 * - `unsupported_format` — not a text table (`detected`: `xlsx`, `xls`,
 *   `pdf`, `image`, `binary`): save the sheet as CSV (UTF-8);
 * - `encoding` — not UTF-8 (`detected`: `utf-16` or `unknown`);
 * - `empty` — nothing in the file; `no_rows` — a header and no rows;
 * - `malformed` — a quote is never closed (`line`);
 * - `missing_columns`, `unknown_columns`, `duplicate_columns` — the header
 *   (`columns`);
 * - `too_many_rows` — more rows than `vehicle_import_max_rows` (`limit`).
 * A file above `vehicle_import_max_file_mb` is `PAYLOAD_TOO_LARGE` (413).
 */
export const vehicleImportFileInvalidDetailsSchema = z.object({
  reason: z.enum([
    "unsupported_format",
    "encoding",
    "empty",
    "no_rows",
    "malformed",
    "missing_columns",
    "unknown_columns",
    "duplicate_columns",
    "too_many_rows",
  ]),
  detected: z.string().nullable(),
  columns: z.array(z.string()),
  line: z.number().int().nullable(),
  limit: z.number().int().nullable(),
});

export type VehicleImportFileInvalidDetails = z.infer<typeof vehicleImportFileInvalidDetailsSchema>;

/** `details` of `VEHICLE_IMPORT_STATE` (409): the import isn't in a state that allows this. */
export const vehicleImportStateDetailsSchema = z.object({
  status: vehicleImportStatusSchema,
});

export type VehicleImportStateDetails = z.infer<typeof vehicleImportStateDetailsSchema>;

// ---------------------------------------------------------------- clients

/**
 * Paths of the client routes take any string: a malformed id is answered
 * like a missing or archived record (404).
 */
export const clientVehicleMakePathSchema = z.object({ makeId: z.string().min(1).max(100) });

export type ClientVehicleMakePath = z.infer<typeof clientVehicleMakePathSchema>;

export const clientVehicleModelPathSchema = z.object({ modelId: z.string().min(1).max(100) });

export type ClientVehicleModelPath = z.infer<typeof clientVehicleModelPathSchema>;

export const clientVehicleGenerationPathSchema = z.object({
  generationId: z.string().min(1).max(100),
});

export type ClientVehicleGenerationPath = z.infer<typeof clientVehicleGenerationPathSchema>;

export const vehicleNamedSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Other spellings, for searching the list on the device (`Джили`). */
  aliases: z.array(z.string()),
});

export type VehicleNamed = z.infer<typeof vehicleNamedSchema>;

export const vehicleGenerationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  yearFrom: z.number().int(),
  /** `null` — still made. */
  yearTo: z.number().int().nullable(),
});

export type VehicleGenerationSummary = z.infer<typeof vehicleGenerationSummarySchema>;

/** `GET /vehicles/makes`: active makes by name (M-GAR-03, step 1). */
export const vehicleMakesResponseSchema = z.object({
  language: catalogLanguageSchema,
  makes: z.array(vehicleNamedSchema),
});

export type VehicleMakesResponse = z.infer<typeof vehicleMakesResponseSchema>;

/** `GET /vehicles/makes/{makeId}/models`: active models of an active make, by name. */
export const vehicleModelsResponseSchema = z.object({
  language: catalogLanguageSchema,
  make: vehicleNamedSchema,
  models: z.array(vehicleNamedSchema),
});

export type VehicleModelsResponse = z.infer<typeof vehicleModelsResponseSchema>;

/** `GET /vehicles/models/{modelId}/generations`: active generations, newest first. */
export const vehicleGenerationsResponseSchema = z.object({
  language: catalogLanguageSchema,
  make: vehicleNamedSchema,
  model: vehicleNamedSchema,
  generations: z.array(vehicleGenerationSummarySchema),
});

export type VehicleGenerationsResponse = z.infer<typeof vehicleGenerationsResponseSchema>;

/** An option in the language of the request (Russian as the fallback). */
export const vehicleOptionViewSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: localizedTextSchema,
});

export type VehicleOptionView = z.infer<typeof vehicleOptionViewSchema>;

export const vehicleModificationViewSchema = z.object({
  id: z.uuid(),
  bodyType: vehicleOptionViewSchema,
  engine: z.object({
    id: z.uuid(),
    /** Not translated. */
    code: z.string(),
    displacementL: z.number().nullable(),
    powerHp: z.number().int().nullable(),
    fuel: vehicleOptionViewSchema,
  }),
  transmissionType: vehicleOptionViewSchema,
  driveType: vehicleOptionViewSchema,
  yearFrom: z.number().int(),
  yearTo: z.number().int().nullable(),
  market: vehicleMarketSchema,
});

export type VehicleModificationView = z.infer<typeof vehicleModificationViewSchema>;

/** `market` — only modifications of this market. */
export const clientVehicleModificationsQuerySchema = z.object({
  market: vehicleMarketSchema.optional(),
});

export type ClientVehicleModificationsQuery = z.infer<typeof clientVehicleModificationsQuerySchema>;

/**
 * `GET /vehicles/generations/{generationId}/modifications`: active
 * modifications of an active generation, Kazakhstan market first, newest
 * first. An empty list is an answer (a generation may have none yet).
 */
export const vehicleModificationsResponseSchema = z.object({
  language: catalogLanguageSchema,
  make: vehicleNamedSchema,
  model: vehicleNamedSchema,
  generation: vehicleGenerationSummarySchema,
  modifications: z.array(vehicleModificationViewSchema),
});

export type VehicleModificationsResponse = z.infer<typeof vehicleModificationsResponseSchema>;
