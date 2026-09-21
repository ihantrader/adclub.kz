import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  VehicleEntryStatus,
  VehicleImportOutcome,
  VehicleImportPlan,
  VehicleImportReason,
  VehicleImportReport,
  VehicleImportResult,
  VehicleImportStatus,
  VehicleMarket,
  VehicleOptionKind,
  VehicleSource,
} from "@adclub/contracts";

/**
 * Drizzle mirrors of the vehicle catalog tables (`infra/migrations`,
 * `…_create-vehicles.sql` — the source of truth, with the checks, unique
 * keys and triggers that hold the rules; ARCHITECTURE 5.3, 4.24).
 */

const status = () => text("status").$type<VehicleEntryStatus>().notNull().default("active");
const archivedAt = () => timestamp("archived_at", { withTimezone: true });
const version = () => integer("version").notNull().default(1);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const vehicleOption = pgTable("vehicle_option", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<VehicleOptionKind>().notNull(),
  code: text("code").notNull(),
  nameRu: text("name_ru").notNull(),
  nameKk: text("name_kk"),
  nameEn: text("name_en"),
  sort: integer("sort").notNull().default(0),
  status: status(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

type RecordSource = Exclude<VehicleSource, "ai">;

export const vehicleMake = pgTable("vehicle_make", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").$type<RecordSource>().notNull().default("manual"),
  status: status(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicleMakeSpelling = pgTable("vehicle_make_spelling", {
  id: uuid("id").primaryKey().defaultRandom(),
  makeId: uuid("make_id").notNull(),
  text: text("text").notNull(),
  key: text("key").notNull(),
  isName: boolean("is_name").notNull(),
});

export const vehicleModel = pgTable("vehicle_model", {
  id: uuid("id").primaryKey().defaultRandom(),
  makeId: uuid("make_id").notNull(),
  source: text("source").$type<RecordSource>().notNull().default("manual"),
  status: status(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicleModelSpelling = pgTable("vehicle_model_spelling", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelId: uuid("model_id").notNull(),
  makeId: uuid("make_id").notNull(),
  text: text("text").notNull(),
  key: text("key").notNull(),
  isName: boolean("is_name").notNull(),
});

export const vehicleGeneration = pgTable("vehicle_generation", {
  id: uuid("id").primaryKey().defaultRandom(),
  modelId: uuid("model_id").notNull(),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  yearFrom: smallint("year_from").notNull(),
  yearTo: smallint("year_to"),
  source: text("source").$type<RecordSource>().notNull().default("manual"),
  status: status(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicleEngine = pgTable("vehicle_engine", {
  id: uuid("id").primaryKey().defaultRandom(),
  displacementL: numeric("displacement_l", { precision: 4, scale: 2 }),
  fuelId: uuid("fuel_id").notNull(),
  fuelKind: text("fuel_kind").notNull().default("fuel"),
  powerHp: integer("power_hp"),
  source: text("source").$type<RecordSource>().notNull().default("manual"),
  status: status(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicleEngineSpelling = pgTable("vehicle_engine_spelling", {
  id: uuid("id").primaryKey().defaultRandom(),
  engineId: uuid("engine_id").notNull(),
  text: text("text").notNull(),
  key: text("key").notNull(),
  isCode: boolean("is_code").notNull(),
});

export const vehicleModification = pgTable("vehicle_modification", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull(),
  bodyTypeId: uuid("body_type_id").notNull(),
  bodyTypeKind: text("body_type_kind").notNull().default("body"),
  engineId: uuid("engine_id").notNull(),
  transmissionTypeId: uuid("transmission_type_id").notNull(),
  transmissionTypeKind: text("transmission_type_kind").notNull().default("transmission"),
  driveTypeId: uuid("drive_type_id").notNull(),
  driveTypeKind: text("drive_type_kind").notNull().default("drive"),
  yearFrom: smallint("year_from").notNull(),
  yearTo: smallint("year_to"),
  market: text("market").$type<VehicleMarket>().notNull(),
  source: text("source").$type<VehicleSource>().notNull().default("manual"),
  importId: uuid("import_id"),
  status: status(),
  archivedAt: archivedAt(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicleImport = pgTable("vehicle_import", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").$type<VehicleImportStatus>().notNull().default("parsing"),
  fileName: text("file_name"),
  byteSize: integer("byte_size").notNull(),
  checksum: text("checksum").notNull(),
  delimiter: text("delimiter").notNull(),
  rowCount: integer("row_count").notNull(),
  report: jsonb("report").$type<VehicleImportReport>(),
  result: jsonb("result").$type<VehicleImportResult>(),
  error: text("error"),
  uploadedByAdminId: uuid("uploaded_by_admin_id").notNull(),
  uploadedByAccountId: uuid("uploaded_by_account_id").notNull(),
  appliedByAdminId: uuid("applied_by_admin_id"),
  appliedByAccountId: uuid("applied_by_account_id"),
  phaseStartedAt: timestamp("phase_started_at", { withTimezone: true }).notNull().defaultNow(),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicleImportRow = pgTable(
  "vehicle_import_row",
  {
    importId: uuid("import_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    values: jsonb("values").$type<Record<string, string>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    planned: text("planned").$type<VehicleImportPlan>(),
    reasons: jsonb("reasons").$type<VehicleImportReason[]>(),
    outcome: text("outcome").$type<VehicleImportOutcome>(),
    outcomeReasons: jsonb("outcome_reasons").$type<VehicleImportReason[]>(),
    modificationId: uuid("modification_id"),
  },
  (table) => [primaryKey({ columns: [table.importId, table.rowNumber] })],
);

export type VehicleOptionRow = typeof vehicleOption.$inferSelect;
export type VehicleMakeRow = typeof vehicleMake.$inferSelect;
export type VehicleModelRow = typeof vehicleModel.$inferSelect;
export type VehicleGenerationRow = typeof vehicleGeneration.$inferSelect;
export type VehicleEngineRow = typeof vehicleEngine.$inferSelect;
export type VehicleModificationRow = typeof vehicleModification.$inferSelect;
export type VehicleImportRecord = typeof vehicleImport.$inferSelect;
export type VehicleImportRowRecord = typeof vehicleImportRow.$inferSelect;

export const vehicleTables = [
  vehicleOption,
  vehicleMake,
  vehicleMakeSpelling,
  vehicleModel,
  vehicleModelSpelling,
  vehicleGeneration,
  vehicleEngine,
  vehicleEngineSpelling,
  vehicleModification,
  vehicleImport,
  vehicleImportRow,
];
