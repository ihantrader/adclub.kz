import type {
  PriceImport,
  PriceImportColumn,
  PriceImportMatch,
  PriceImportPreviewRow,
  PriceImportRow,
  PriceRowErrorValue,
} from "@adclub/contracts";
import type { PriceCell, PriceRowError } from "@adclub/domain";
import type { PriceImportRecord, PriceImportRowRecord, PriceMatchError } from "./schema";

/**
 * What the cabinet and the admin panel are shown of an import (TASK-046):
 * the one place an import, its columns and its rows turn into the contract.
 * Never the file's key: the file is not handed out.
 */

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** States from which the import has been matched (or is being matched). */
const MATCHED: readonly PriceImportRecord["status"][] = [
  "matching",
  "review",
  "applying",
  "applied",
  "expired",
];

function describeMatch(record: PriceImportRecord): PriceImportMatch | null {
  if (!MATCHED.includes(record.status)) return null;
  const stats = record.stats;
  return {
    done: stats.matched ?? 0,
    total: stats.dataRows ?? 0,
    confident: stats.confident ?? 0,
    review: stats.review ?? 0,
    notFound: stats.notFound ?? 0,
    errors: stats.errors ?? 0,
    bySource: stats.bySource ?? { mapping: 0, exactArticle: 0, search: 0, ai: 0, remembered: 0 },
    aiRows: stats.aiRows ?? 0,
    aiPending: stats.aiPending ?? 0,
    aiWaiting: record.status === "matching" ? (stats.aiWaiting ?? null) : null,
  };
}

export function describeImport(
  record: PriceImportRecord,
  uploaderName: string | null,
  appliedByName: string | null = null,
): PriceImport {
  const stats = record.stats;
  const progress =
    record.status === "parsing"
      ? { done: stats.rows ?? 0, total: null }
      : record.status === "reading"
        ? { done: stats.valuesRead ?? 0, total: stats.dataRows ?? null }
        : record.status === "matching"
          ? { done: stats.matched ?? 0, total: stats.dataRows ?? null }
          : null;
  const known = record.status !== "parsing" && stats.rows !== undefined;
  const valuesKnown = record.status === "parsed" || MATCHED.includes(record.status);
  return {
    id: record.id,
    status: record.status,
    version: record.version,
    fileName: record.fileName,
    format: record.fileKind,
    byteSize: record.byteSize,
    sameFileAsImportId: record.sameFileAsImportId,
    uploadedBy: { memberId: record.uploadedByMemberId, name: uploaderName },
    sheetName: record.sheetName,
    encoding: record.encoding,
    delimiter: record.delimiter,
    headerRowNo: record.headerRowNo,
    columnsSource: record.columnsSource,
    progress,
    stats: known
      ? {
          rows: stats.rows ?? 0,
          dataRows: stats.dataRows ?? 0,
          serviceRows: stats.serviceRows ?? 0,
          parsedRows: valuesKnown ? (stats.parsedRows ?? 0) : null,
          errorRows: valuesKnown ? (stats.errorRows ?? 0) : null,
        }
      : null,
    failure: record.failure,
    fileKept: record.fileDeletedAt === null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    parsedAt: iso(record.parsedAt),
    match: describeMatch(record),
    reviewUntil: record.status === "review" ? iso(record.reviewUntil) : null,
    appliedBy: record.appliedByMemberId
      ? { memberId: record.appliedByMemberId, name: appliedByName }
      : null,
    appliedAt: iso(record.appliedAt),
    result: record.status === "applied" ? record.result : null,
  };
}

/** A matching error of a row in the words of the contract's row errors. */
export function describeMatchError(error: PriceMatchError): PriceRowErrorValue {
  return {
    code: error.code,
    text: null,
    value: error.code === "repeated_row" ? error.value : null,
    min: null,
    max: null,
  };
}

function headerText(cell: PriceCell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell).trim();
  return text === "" ? null : text;
}

/** The columns of an import with their roles; `null` until the file is read. */
export function describeColumns(
  record: PriceImportRecord,
  header: readonly PriceCell[] | null,
): PriceImportColumn[] | null {
  if (!record.columnMapping || record.columnCount === null) return null;
  return record.columnMapping.map((column, index) => ({
    index,
    header: headerText(header?.[index]),
    role: column.role,
    source: column.source,
    confidence: column.confidence,
  }));
}

/** Cells padded (or cut) to the columns of the import, so every row of a table lines up. */
export function widthOf(cells: readonly PriceCell[], width: number): PriceCell[] {
  return Array.from({ length: width }, (_, index) => cells[index] ?? null);
}

export function describePreviewRow(
  row: PriceImportRowRecord,
  width: number,
): PriceImportPreviewRow {
  return { rowNo: row.rowNo, kind: row.kind, cells: widthOf(row.raw, width) };
}

function describeError(error: PriceRowError): PriceRowErrorValue {
  return {
    code: error.code,
    text: "text" in error ? error.text : null,
    value: "value" in error ? error.value : null,
    min: "min" in error ? error.min : null,
    max: "max" in error ? error.max : null,
  };
}

/** Every error of a row: the reading's and the matching's. */
export function rowErrors(row: Pick<PriceImportRowRecord, "errors" | "matchError">) {
  return [
    ...(row.errors ?? []).map(describeError),
    ...(row.matchError ? [describeMatchError(row.matchError)] : []),
  ];
}

export function describeRow(row: PriceImportRowRecord, width: number): PriceImportRow {
  return {
    rowNo: row.rowNo,
    cells: widthOf(row.raw, width),
    parsed: row.parsed,
    errors: rowErrors(row),
  };
}
