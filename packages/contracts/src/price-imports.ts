import { z } from "zod";

/**
 * Importing a supplier's price list (TASK-046; ARCHITECTURE 12.1 steps 1–3,
 * 5.6, 4.66; SCREENS S-PRICE-01, S-PRICE-02): the upload, the rows the
 * worker reads out of the file, the roles of its columns the supplier
 * confirms, and the values read by them. Matching the rows with the catalog
 * and applying them come with TASK-047; nothing here changes an offer.
 */

/**
 * `Content-Type`s the upload takes. What the file is decides its content,
 * never its name or declared type; the cabinet sends every file as
 * `application/octet-stream`.
 */
export const PRICE_IMPORT_CONTENT_TYPES = [
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/csv",
] as const;

/**
 * The most the server reads of a price file, whatever `import_max_file_mb`
 * says (that setting can only be lower).
 */
export const PRICE_IMPORT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** How many rows of goods the screen of columns shows. */
export const PRICE_IMPORT_PREVIEW_ROWS = 20;

/**
 * Where an import is:
 * - `parsing` — the worker reads the file into rows and recognises the columns;
 * - `columns` — the supplier is to confirm the roles of the columns (S-PRICE-02);
 * - `reading` — the values of the rows are being read by the confirmed roles;
 * - `parsed` — every row is read: the rows with errors are known; matching
 *   with the catalog is the next step (TASK-047);
 * - `failed` — the file could not be read (`failure`).
 */
export const priceImportStatusSchema = z.enum([
  "parsing",
  "columns",
  "reading",
  "parsed",
  "failed",
]);

export type PriceImportStatus = z.infer<typeof priceImportStatusSchema>;

export const priceImportFormatSchema = z.enum(["xlsx", "csv"]);

export type PriceImportFormat = z.infer<typeof priceImportFormatSchema>;

/** The role of a column (S-PRICE-02): Артикул · Бренд · Название · Цена · Наличие · Срок · Не использовать. */
export const priceColumnRoleSchema = z.enum([
  "article",
  "brand",
  "name",
  "price",
  "availability",
  "lead_days",
  "ignore",
]);

export type PriceColumnRoleName = z.infer<typeof priceColumnRoleSchema>;

/**
 * Where the role of a column came from: its header, its cells, the format
 * remembered from an earlier file of the company, or the supplier's choice;
 * `null` — nothing pointed at a role.
 */
export const priceColumnSourceSchema = z.enum(["header", "content", "remembered", "supplier"]);

export type PriceColumnSource = z.infer<typeof priceColumnSourceSchema>;

/**
 * Why a file can't be read (`PRICE_IMPORT_FILE_INVALID` at the upload, or the
 * `failure` of an import whose problem the worker found):
 * - `not_a_table` — a PDF, a picture, a web page, a document, a text that
 *   is no table (`detected`);
 * - `old_excel` — the old `.xls`: save it as `.xlsx`;
 * - `encrypted` — an Excel file under a password;
 * - `broken` — a damaged `.xlsx` (or a CSV with a quote never closed, `line`);
 * - `empty` — nothing in the file;
 * - `too_many_rows` — more rows than `import_max_rows` (`limit`);
 * - `encoding` — a CSV in an encoding that is neither UTF-8 nor Windows-1251.
 */
export const priceImportFileProblemSchema = z.enum([
  "not_a_table",
  "old_excel",
  "encrypted",
  "broken",
  "empty",
  "too_many_rows",
  "encoding",
]);

export type PriceImportFileProblem = z.infer<typeof priceImportFileProblemSchema>;

/** `details` of `PRICE_IMPORT_FILE_INVALID` (400); nothing was stored. */
export const priceImportFileInvalidDetailsSchema = z.object({
  reason: priceImportFileProblemSchema,
  detected: z.string().nullable(),
  limit: z.number().int().nullable(),
  line: z.number().int().nullable(),
});

export type PriceImportFileInvalidDetails = z.infer<typeof priceImportFileInvalidDetailsSchema>;

/**
 * Why an import failed: a problem of the file found by the worker, the file
 * already removed after its retention (`file_missing`), or reading taking
 * longer than `price_import_timeout_minutes` (`timeout`).
 */
export const priceImportFailureSchema = z.object({
  reason: z.enum([...priceImportFileProblemSchema.options, "file_missing", "timeout"]),
  detected: z.string().nullable(),
  limit: z.number().int().nullable(),
  line: z.number().int().nullable(),
});

export type PriceImportFailure = z.infer<typeof priceImportFailureSchema>;

/** `details` of `PRICE_IMPORT_STATE` (409): the import isn't where this can be done. */
export const priceImportStateDetailsSchema = z.object({ status: priceImportStatusSchema });

export type PriceImportStateDetails = z.infer<typeof priceImportStateDetailsSchema>;

/**
 * `details` of `PRICE_IMPORT_VERSION_CONFLICT` (409; TASK-046.A): the roles
 * were confirmed by someone after the page asking was loaded; nothing changed.
 */
export const priceImportVersionConflictDetailsSchema = z.object({
  status: priceImportStatusSchema,
  version: z.number().int(),
  /** Who confirmed the columns last, and when; `null` — unknown. */
  confirmedBy: z.object({ memberId: z.uuid(), name: z.string().nullable() }).nullable(),
  confirmedAt: z.iso.datetime().nullable(),
});

export type PriceImportVersionConflictDetails = z.infer<
  typeof priceImportVersionConflictDetailsSchema
>;

export const priceImportProgressSchema = z.object({
  /** Rows done of the phase: read out of the file (`parsing`) or read by the roles (`reading`). */
  done: z.number().int(),
  /** How many there are, when known (`reading`). */
  total: z.number().int().nullable(),
});

export type PriceImportProgress = z.infer<typeof priceImportProgressSchema>;

export const priceImportStatsSchema = z.object({
  /** Non-empty rows of the sheet, the header and service rows included. */
  rows: z.number().int(),
  /** Rows of goods. */
  dataRows: z.number().int(),
  /** Rows above the header, totals, group separators, a repeated header. */
  serviceRows: z.number().int(),
  /** Rows of goods read without an error (after the roles are confirmed). */
  parsedRows: z.number().int().nullable(),
  /** Rows of goods with an error (after the roles are confirmed). */
  errorRows: z.number().int().nullable(),
});

export type PriceImportStats = z.infer<typeof priceImportStatsSchema>;

export const priceImportPersonSchema = z.object({
  memberId: z.uuid(),
  name: z.string().nullable(),
});

export const priceImportSchema = z.object({
  id: z.uuid(),
  status: priceImportStatusSchema,
  /**
   * Grows with each confirmation of the columns (TASK-046.A): sent back as
   * `expectedVersion`, it keeps a page showing an older state from
   * overwriting a colleague's roles.
   */
  version: z.number().int(),
  fileName: z.string().nullable(),
  format: priceImportFormatSchema,
  byteSize: z.number().int(),
  /** The same file (by its content) was uploaded before — the latest such import. */
  sameFileAsImportId: z.uuid().nullable(),
  uploadedBy: priceImportPersonSchema,
  /** The sheet of an Excel file the rows were read from. */
  sheetName: z.string().nullable(),
  /** The encoding (`utf-8`, `windows-1251`, `utf-16le`) and separator of a CSV. */
  encoding: z.string().nullable(),
  delimiter: z.string().nullable(),
  /** The row of the header as the file numbers it; `null` — the file has none. */
  headerRowNo: z.number().int().nullable(),
  /**
   * Where the roles came from: recognised now (`auto`, waiting for the
   * supplier), the company's remembered format (`remembered`, S-PRICE-02 is
   * skipped) or confirmed by the supplier (`supplier`).
   */
  columnsSource: z.enum(["auto", "remembered", "supplier"]).nullable(),
  progress: priceImportProgressSchema.nullable(),
  stats: priceImportStatsSchema.nullable(),
  failure: priceImportFailureSchema.nullable(),
  /** The file is still kept (`price_import_file_retention_days`). */
  fileKept: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  parsedAt: z.iso.datetime().nullable(),
});

export type PriceImport = z.infer<typeof priceImportSchema>;

export const priceImportColumnSchema = z.object({
  /** 0-based: the column «A» is 0. */
  index: z.number().int(),
  /** What the header row says above it; `null` — empty or no header. */
  header: z.string().nullable(),
  role: priceColumnRoleSchema,
  source: priceColumnSourceSchema.nullable(),
  /** 0…1 for a recognised role. */
  confidence: z.number().nullable(),
});

export type PriceImportColumn = z.infer<typeof priceImportColumnSchema>;

/** A cell as the file held it: text, a number (a date as an ISO date), or nothing. */
export const priceCellSchema = z.union([z.string(), z.number()]).nullable();

export const priceRowKindSchema = z.enum([
  "title",
  "header",
  "repeat_header",
  "group",
  "total",
  "data",
]);

export type PriceRowKind = z.infer<typeof priceRowKindSchema>;

export const priceImportPreviewRowSchema = z.object({
  rowNo: z.number().int(),
  kind: priceRowKindSchema,
  cells: z.array(priceCellSchema),
});

export type PriceImportPreviewRow = z.infer<typeof priceImportPreviewRowSchema>;

export const priceImportPathSchema = z.object({ importId: z.uuid() });

export type PriceImportPath = z.infer<typeof priceImportPathSchema>;

export const uploadPriceImportQuerySchema = z.object({
  /** The name of the file as the supplier chose it; only shown in the history. */
  fileName: z.string().trim().min(1).max(255).optional(),
});

export type UploadPriceImportQuery = z.infer<typeof uploadPriceImportQuerySchema>;

export const priceImportResponseSchema = z.object({ import: priceImportSchema });

export type PriceImportResponse = z.infer<typeof priceImportResponseSchema>;

/** An import with its columns and first rows of goods (S-PRICE-02). */
export const priceImportDetailResponseSchema = z.object({
  import: priceImportSchema,
  /** `null` until the file is read. */
  columns: z.array(priceImportColumnSchema).nullable(),
  /** The header row (as the file holds it), `null` — none. */
  header: priceImportPreviewRowSchema.nullable(),
  /** The first `PRICE_IMPORT_PREVIEW_ROWS` rows of goods. */
  preview: z.array(priceImportPreviewRowSchema),
});

export type PriceImportDetailResponse = z.infer<typeof priceImportDetailResponseSchema>;

export const priceImportListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(200).optional(),
});

export type PriceImportListQuery = z.infer<typeof priceImportListQuerySchema>;

export const priceImportLimitsSchema = z.object({
  maxFileMb: z.number().int(),
  maxRows: z.number().int(),
});

export const priceImportPageSchema = z.object({
  imports: z.array(priceImportSchema),
  nextCursor: z.string().nullable(),
  /** The limits of a file now (settings), for the upload zone to say. */
  limits: priceImportLimitsSchema,
});

export type PriceImportPage = z.infer<typeof priceImportPageSchema>;

/**
 * The roles the supplier confirms (S-PRICE-02): one per column, in the
 * order of the columns; each role but `ignore` at most once; a price and
 * an article or a name required. `remember` — the company's format for the
 * next files with the same header («Запомнить для следующих загрузок»).
 */
export const confirmPriceColumnsBodySchema = z.object({
  roles: z.array(priceColumnRoleSchema).min(1).max(200),
  remember: z.boolean(),
  /**
   * The `version` of the import the page shows (TASK-046.A): another one —
   * a colleague confirmed the columns meanwhile — is
   * `PRICE_IMPORT_VERSION_CONFLICT`, nothing changes. Without it the roles
   * are taken as they are.
   */
  expectedVersion: z.number().int().min(1).optional(),
});

export type ConfirmPriceColumnsBody = z.infer<typeof confirmPriceColumnsBodySchema>;

export const priceImportRowsQuerySchema = z.object({
  /** `errors` — only rows of goods with an error; `data` — every row of goods. */
  only: z.enum(["errors", "data"]).default("errors"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(50).optional(),
});

export type PriceImportRowsQuery = z.infer<typeof priceImportRowsQuerySchema>;

export const priceRowAvailabilitySchema = z.enum(["in_stock", "out_of_stock", "on_order"]);

export const parsedPriceRowSchema = z.object({
  article: z.string().nullable(),
  articleNorm: z.string().nullable(),
  brand: z.string().nullable(),
  name: z.string().nullable(),
  /** Whole tenge. */
  price: z.number().int().nullable(),
  availability: priceRowAvailabilitySchema.nullable(),
  quantity: z.number().int().nullable(),
  /** Working days. */
  leadDays: z.number().int().nullable(),
});

export type ParsedPriceRowValue = z.infer<typeof parsedPriceRowSchema>;

/**
 * A problem of a row (S-PRICE-03 «Ошибки в строках»): no price, a price
 * that is not a number (`text`) or outside `min`…`max` (`value`), neither an
 * article nor a name, a lead time beyond `max` (`value`).
 */
export const priceRowErrorSchema = z.object({
  code: z.enum([
    "price_missing",
    "price_not_number",
    "price_out_of_range",
    "no_article_or_name",
    "lead_days_out_of_range",
  ]),
  text: z.string().nullable(),
  value: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});

export type PriceRowErrorValue = z.infer<typeof priceRowErrorSchema>;

export const priceImportRowSchema = z.object({
  rowNo: z.number().int(),
  cells: z.array(priceCellSchema),
  parsed: parsedPriceRowSchema.nullable(),
  errors: z.array(priceRowErrorSchema),
});

export type PriceImportRow = z.infer<typeof priceImportRowSchema>;

export const priceImportRowsPageSchema = z.object({
  rows: z.array(priceImportRowSchema),
  /** How many rows the filter gives in all. */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type PriceImportRowsPage = z.infer<typeof priceImportRowsPageSchema>;

export const adminSupplierPriceImportsPathSchema = z.object({ supplierId: z.uuid() });

export type AdminSupplierPriceImportsPath = z.infer<typeof adminSupplierPriceImportsPathSchema>;

/** A supplier's imports for the administrator — only to look at (A-SUP-03 «Прайс»). */
export const adminPriceImportPageSchema = z.object({
  imports: z.array(priceImportSchema),
  nextCursor: z.string().nullable(),
});

export type AdminPriceImportPage = z.infer<typeof adminPriceImportPageSchema>;
