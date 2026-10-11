import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  PriceColumnRoleName,
  PriceColumnSource,
  PriceImportFailure,
  PriceImportFormat,
  PriceImportStatus,
  PriceRowKind,
} from "@adclub/contracts";
import type { ParsedPriceRow, PriceCell, PriceRowError } from "@adclub/domain";

/**
 * Drizzle mirrors of the price import tables (`infra/migrations`,
 * `…_price-imports.sql` — the source of truth with its checks;
 * ARCHITECTURE 5.6, 4.66).
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** The role of one column as stored: where it came from and how sure that was. */
export interface StoredColumn {
  role: PriceColumnRoleName;
  source: PriceColumnSource | null;
  confidence: number | null;
}

/** `price_import.stats`: what reading the file and its rows found so far. */
export interface PriceImportStatsRecord {
  /** Non-empty rows stored (the header and service rows included). */
  rows?: number;
  dataRows?: number;
  serviceRows?: number;
  /** Rows of goods read by the roles so far (`reading`). */
  valuesRead?: number;
  parsedRows?: number;
  errorRows?: number;
}

export const priceImport = pgTable("price_import", {
  id: uuid("id").primaryKey(),
  supplierId: uuid("supplier_id").notNull(),
  uploadedByMemberId: uuid("uploaded_by_member_id").notNull(),
  uploadedByAccountId: uuid("uploaded_by_account_id").notNull(),
  status: text("status").$type<PriceImportStatus>().notNull().default("parsing"),
  fileName: text("file_name"),
  fileKind: text("file_kind").$type<PriceImportFormat>().notNull(),
  fileKey: text("file_key").notNull(),
  byteSize: integer("byte_size").notNull(),
  checksum: text("checksum").notNull(),
  sameFileAsImportId: uuid("same_file_as_import_id"),
  sheetName: text("sheet_name"),
  encoding: text("encoding"),
  delimiter: text("delimiter"),
  headerRowNo: integer("header_row_no"),
  columnCount: integer("column_count"),
  headerKey: text("header_key"),
  columnMapping: jsonb("column_mapping").$type<StoredColumn[]>(),
  columnsSource: text("columns_source").$type<"auto" | "remembered" | "supplier">(),
  stats: jsonb("stats").$type<PriceImportStatsRecord>().notNull().default({}),
  failure: jsonb("failure").$type<PriceImportFailure>(),
  phaseStartedAt: timestamp("phase_started_at", { withTimezone: true }).notNull().defaultNow(),
  parsedAt: timestamp("parsed_at", { withTimezone: true }),
  fileDeletedAt: timestamp("file_deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const priceImportRow = pgTable(
  "price_import_row",
  {
    importId: uuid("import_id").notNull(),
    rowNo: integer("row_no").notNull(),
    kind: text("kind").$type<PriceRowKind>().notNull(),
    raw: jsonb("raw").$type<PriceCell[]>().notNull(),
    parsed: jsonb("parsed").$type<ParsedPriceRow>(),
    errors: jsonb("errors").$type<PriceRowError[]>(),
  },
  (table) => [primaryKey({ columns: [table.importId, table.rowNo] })],
);

export const priceImportFormatTable = pgTable(
  "price_import_format",
  {
    supplierId: uuid("supplier_id").notNull(),
    headerKey: text("header_key").notNull(),
    roles: jsonb("roles").$type<PriceColumnRoleName[]>().notNull(),
    rememberedByMemberId: uuid("remembered_by_member_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.supplierId, table.headerKey] })],
);

export type PriceImportRecord = typeof priceImport.$inferSelect;
export type PriceImportRowRecord = typeof priceImportRow.$inferSelect;

export const priceImportTables = [priceImport, priceImportRow, priceImportFormatTable];
