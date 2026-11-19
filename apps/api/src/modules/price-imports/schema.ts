import { createHash } from "node:crypto";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CatalogRequestSource,
  CatalogRequestStatus,
  PriceColumnRoleName,
  PriceColumnSource,
  PriceImportFailure,
  PriceImportFormat,
  PriceImportResult,
  PriceImportStatus,
  PriceMatchSource,
  PriceMissingAction,
  PriceRowDecisionKind,
  PriceRowKind,
  PriceRowNotAppliedReason,
  PricePhotoPageStatus,
} from "@adclub/contracts";
import type {
  ParsedPriceRow,
  PriceCell,
  PricePhotoRow,
  PricePhotoUncertainty,
  PriceRowError,
  PriceRowKey,
  PriceRowKeyKind,
} from "@adclub/domain";

/** The group of a row as stored: the contract's `errors` is `error` here. */
export type PriceRowGroup = "confident" | "review" | "not_found" | "error";

/** What applying did to a row. */
export type PriceRowOutcomeKind =
  | "created"
  | "updated"
  | "unchanged"
  | "returned"
  | "withdrawn"
  | "requested"
  | "skipped"
  | "not_applied";

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
  /** Matching (TASK-047): rows of goods matched so far and the groups. */
  matched?: number;
  confident?: number;
  review?: number;
  notFound?: number;
  /** Rows with an error, the reading's and the matching's. */
  errors?: number;
  bySource?: {
    mapping: number;
    exactArticle: number;
    search: number;
    ai: number;
    remembered: number;
    itemId?: number;
  };
  aiRows?: number;
  aiPending?: number;
  /** Why AI waits: it couldn't be reached, or the day's budget is spent. */
  aiWaiting?: "unavailable" | "budget" | null;
}

/** A matching error of a row (`price_import_row.match_error`). */
export type PriceMatchError =
  | { code: "repeated_row"; value: number }
  | { code: "service_item" }
  | { code: "supplier_type" }
  | { code: "unknown_item_id" };

/** Why a row sits where it does (`price_import_row.match_note`). */
export interface PriceMatchNote {
  code: "several_brands" | "other_brand" | "same_item";
  rowNo: number | null;
}

/** A candidate of a row as stored. */
export interface StoredCandidate {
  itemId: string;
  score: number;
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
  columnsSource: text("columns_source").$type<"auto" | "remembered" | "supplier" | "photo">(),
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
  // TASK-047: the review and the application.
  missingAction: text("missing_action").$type<PriceMissingAction>(),
  missingDecidedByMemberId: uuid("missing_decided_by_member_id"),
  missingDecidedAt: timestamp("missing_decided_at", { withTimezone: true }),
  changedByMemberId: uuid("changed_by_member_id"),
  changedAt: timestamp("changed_at", { withTimezone: true }),
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  reviewUntil: timestamp("review_until", { withTimezone: true }),
  appliedByMemberId: uuid("applied_by_member_id"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  result: jsonb("result").$type<PriceImportResult>(),
  // TASK-065.A: rows AI proposed and of them accepted, counted when applied.
  aiProposedRows: integer("ai_proposed_rows").notNull().default(0),
  aiAcceptedRows: integer("ai_accepted_rows").notNull().default(0),
  // TASK-064: why the recognition of the photographed pages waits for AI.
  photoAiWaiting: text("photo_ai_waiting").$type<"unavailable" | "budget">(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A page of a photographed import (TASK-064; ARCHITECTURE 4.93). */
export const priceImportPhotoPage = pgTable(
  "price_import_photo_page",
  {
    importId: uuid("import_id").notNull(),
    pageNo: integer("page_no").notNull(),
    fileKey: text("file_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status").$type<PricePhotoPageStatus>().notNull().default("waiting"),
    rows: jsonb("rows").$type<PricePhotoRow[]>(),
    rowCount: integer("row_count"),
    droppedRows: integer("dropped_rows"),
    retakes: integer("retakes").notNull().default(0),
    // TASK-064.A: attempts that ran out of time, the first reading kept for
    // the second, the keys of the rows of every reading.
    readAttempts: integer("read_attempts").notNull().default(0),
    firstReading: jsonb("first_reading").$type<{ rows: PricePhotoRow[]; dropped: number }>(),
    seenKeys: jsonb("seen_keys").$type<PriceRowKey[]>(),
    aiJobId: uuid("ai_job_id"),
    recognizedAt: timestamp("recognized_at", { withTimezone: true }),
    fileDeletedAt: timestamp("file_deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.importId, table.pageNo] })],
);

/** A page taken again: counted in the hourly limit of uploads (TASK-064). */
export const priceImportPhotoRetake = pgTable("price_import_photo_retake", {
  id: uuid("id").primaryKey(),
  supplierId: uuid("supplier_id").notNull(),
  importId: uuid("import_id").notNull(),
  memberId: uuid("member_id").notNull(),
  pageNo: integer("page_no").notNull(),
  createdAt: createdAt(),
});

export type PriceImportPhotoPageRecord = typeof priceImportPhotoPage.$inferSelect;

/** What the screens show of a page (`photoPagesOf`): never its rows or readings (TASK-064.A). */
export type PhotoPageSummary = Pick<
  PriceImportPhotoPageRecord,
  "importId" | "pageNo" | "status" | "rowCount" | "byteSize" | "retakes"
>;

/**
 * A file stored for an upload before the upload is written (TASK-064.A): the
 * record goes in the transaction that makes the file an import's (or a
 * page's); one left past `price_import_orphan_retention_hours` names a file
 * nobody points at. A key ending in «/» is the prefix of a photographed import.
 */
export const priceFilePending = pgTable("price_file_pending", {
  fileKey: text("file_key").primaryKey(),
  supplierId: uuid("supplier_id").notNull(),
  createdAt: createdAt(),
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
    // TASK-047: matching, the decision, what applying did.
    matchKeyKind: text("match_key_kind").$type<PriceRowKeyKind>(),
    matchKey: text("match_key"),
    matchStage: text("match_stage").$type<"ai" | "done">(),
    matchGroup: text("match_group").$type<PriceRowGroup>(),
    matchSource: text("match_source").$type<PriceMatchSource>(),
    itemId: uuid("item_id"),
    candidates: jsonb("candidates").$type<StoredCandidate[]>(),
    aiProposed: boolean("ai_proposed").notNull().default(false),
    aiConfidence: numeric("ai_confidence", { precision: 4, scale: 3 }),
    aiExplanation: text("ai_explanation"),
    /** The `ai_job` of the call that matched the row (TASK-065). */
    aiJobId: uuid("ai_job_id"),
    matchNote: jsonb("match_note").$type<PriceMatchNote>(),
    matchError: jsonb("match_error").$type<PriceMatchError>(),
    decision: text("decision").$type<PriceRowDecisionKind>(),
    decisionItemId: uuid("decision_item_id"),
    decidedByMemberId: uuid("decided_by_member_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    priceConfirmed: boolean("price_confirmed").notNull().default(false),
    sendRequest: boolean("send_request"),
    outcome: text("outcome").$type<PriceRowOutcomeKind>(),
    outcomeReason: text("outcome_reason").$type<PriceRowNotAppliedReason>(),
    outcomeOfferId: uuid("outcome_offer_id"),
    // TASK-064: a row read off a photographed page.
    photoPage: integer("photo_page"),
    photoText: text("photo_text"),
    photoUncertain: text("photo_uncertain").array().$type<PricePhotoUncertainty[]>(),
    readConfirmed: boolean("read_confirmed").notNull().default(false),
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

/**
 * What a company's rows were matched to (TASK-047; ARCHITECTURE 5.6, 12.2):
 * the item, or that the supplier skipped the row, or that the catalog has
 * no such item — by the article, or the name without one.
 */
export const supplierSkuMapping = pgTable("supplier_sku_mapping", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id").notNull(),
  keyKind: text("key_kind").$type<PriceRowKeyKind>().notNull(),
  key: text("key").notNull(),
  decision: text("decision").$type<"item" | "skip" | "absent">().notNull(),
  itemId: uuid("item_id"),
  /** `supplier_ai` — the supplier accepted the item AI chose (TASK-065). */
  confirmedBy: text("confirmed_by")
    .$type<"supplier" | "supplier_ai" | "admin" | "auto">()
    .notNull(),
  confirmedByMemberId: uuid("confirmed_by_member_id"),
  confirmedByAdminId: uuid("confirmed_by_admin_id"),
  importId: uuid("import_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** What the row of a price list said, kept with a request. */
export interface CatalogRequestPayload {
  article: string | null;
  articleNorm: string | null;
  brand: string | null;
  name: string | null;
  price: number | null;
  availability: "in_stock" | "out_of_stock" | "on_order" | null;
  leadDays: number | null;
}

/** A request to add an item (TASK-047; A-MOD-01). */
export const catalogRequest = pgTable("catalog_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").$type<"new_item">().notNull().default("new_item"),
  supplierId: uuid("supplier_id").notNull(),
  importId: uuid("import_id"),
  rowNo: integer("row_no"),
  keyKind: text("key_kind").$type<PriceRowKeyKind>().notNull(),
  key: text("key").notNull(),
  payload: jsonb("payload").$type<CatalogRequestPayload>().notNull(),
  status: text("status").$type<CatalogRequestStatus>().notNull().default("new"),
  resultItemId: uuid("result_item_id"),
  rejectReason: text("reject_reason"),
  createdByMemberId: uuid("created_by_member_id"),
  decidedByAdminId: uuid("decided_by_admin_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  // TASK-071: taken by the moderation digest W-06 (`ModerationDigest`).
  digestedAt: timestamp("digested_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  // TASK-048: a request by hand (S-OFF-05).
  source: text("source").$type<CatalogRequestSource>().notNull().default("price_import"),
  categoryId: uuid("category_id"),
  comment: text("comment"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type CatalogRequestRow = typeof catalogRequest.$inferSelect;

/** What «Неверно» did (`price_match_audit.result`). */
export interface PriceMatchAuditResult {
  /** The company's memory of the row's key pointed at the wrong item and was removed. */
  memoryRemoved: boolean;
  offer:
    | { id: string; withdrawn: true }
    | {
        id: string | null;
        withdrawn: false;
        reason: "no_offer" | "not_by_row" | "not_active" | "edited" | "active_orders";
        activeOrders: number;
      };
}

/** An applied AI match put aside for the administrator (TASK-065; A-MOD-04). */
export const priceMatchAudit = pgTable("price_match_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  importId: uuid("import_id").notNull(),
  rowNo: integer("row_no").notNull(),
  supplierId: uuid("supplier_id").notNull(),
  aiItemId: uuid("ai_item_id").notNull(),
  aiConfidence: numeric("ai_confidence", { precision: 4, scale: 3 }).notNull(),
  reason: text("reason").$type<"below" | "share">().notNull(),
  offerId: uuid("offer_id"),
  /** What the row did to the offer when applied (TASK-065.A); `null` — put aside before it was kept. */
  rowOutcome: text("row_outcome").$type<"created" | "updated" | "unchanged" | "returned">(),
  status: text("status").$type<"pending" | "correct" | "wrong">().notNull().default("pending"),
  correctItemId: uuid("correct_item_id"),
  notInCatalog: boolean("not_in_catalog").notNull().default(false),
  comment: text("comment"),
  result: jsonb("result").$type<PriceMatchAuditResult>(),
  decidedByAdminId: uuid("decided_by_admin_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PriceMatchAuditRecord = typeof priceMatchAudit.$inferSelect;
export type SupplierSkuMappingRow = typeof supplierSkuMapping.$inferSelect;

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
  priceImportPhotoPage,
  priceImportPhotoRetake,
  priceFilePending,
  supplierSkuMapping,
  catalogRequest,
  priceMatchAudit,
];
