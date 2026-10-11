import { createHash } from "node:crypto";
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
  /** When the worker began the current phase; `null` — waiting for it (TASK-046.A). */
  phaseStartedAt: timestamp("phase_started_at", { withTimezone: true }),
  /** Confirmations of the columns so far, plus one (TASK-046.A). */
  version: integer("version").notNull().default(1),
  columnsConfirmedByMemberId: uuid("columns_confirmed_by_member_id"),
  columnsConfirmedAt: timestamp("columns_confirmed_at", { withTimezone: true }),
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
    /** SHA-256 of `header_key` (hex): the key a format is found by (TASK-046.A). */
    headerHash: text("header_hash").notNull(),
    roles: jsonb("roles").$type<PriceColumnRoleName[]>().notNull(),
    rememberedByMemberId: uuid("remembered_by_member_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.supplierId, table.headerHash] })],
);

/** An upload refused before anything was stored: it counts in the limit (TASK-046.A). */
export const priceImportRefusal = pgTable("price_import_refusal", {
  id: uuid("id").primaryKey(),
  supplierId: uuid("supplier_id").notNull(),
  memberId: uuid("member_id").notNull(),
  reason: text("reason").notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: createdAt(),
});

/** The key a remembered format is found by: SHA-256 of the header's normal form. */
export function headerHash(headerKey: string): string {
  return createHash("sha256").update(headerKey, "utf8").digest("hex");
}

export type PriceImportRecord = typeof priceImport.$inferSelect;
export type PriceImportRowRecord = typeof priceImportRow.$inferSelect;

export const priceImportTables = [
  priceImport,
  priceImportRow,
  priceImportFormatTable,
  priceImportRefusal,
];
