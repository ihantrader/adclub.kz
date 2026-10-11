import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  classifyPriceRow,
  findPriceHeader,
  HEADER_SEARCH_ROWS,
  priceHeaderKey,
  priceRolesProblem,
  readPriceRow,
  recognizePriceColumns,
  type PriceCell,
  type PriceColumnRole,
  type PriceRowKind,
} from "@adclub/domain";
import type { PriceImportFailure } from "@adclub/contracts";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import type {
  JobHandler,
  JobRunContext,
  JobRunOutcome,
  PeriodicJobHandler,
  Sweeper,
  SweepResult,
} from "../../jobs";
import { AppSettings } from "../settings";
import { readPriceFile } from "./file/price-file";
import type { FileRow, RowSink } from "./file/rows";
import { PriceFileMissing, PriceFileStorage } from "./price-file-storage";
import { PriceFileError } from "./price-import-errors";
import { parsePriceFileJob } from "./price-import-jobs";
import {
  priceImport,
  priceImportFormatTable,
  priceImportRow,
  type PriceImportStatsRecord,
  type StoredColumn,
} from "./schema";

/** Rows written (or read by the roles) in one statement. */
const BATCH = 1000;
/** Rows of goods the columns are recognised by. */
const SAMPLE_ROWS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function failureOf(error: PriceFileError): PriceImportFailure {
  return error.failure();
}

/**
 * Collects the rows a reader gives: the first `HEADER_SEARCH_ROWS` wait
 * until the header is found, then every row is classified (above the
 * header — a title; a total, a group, the header again, goods) and written
 * in batches, with the count of rows read in `stats` for the progress.
 */
class RowWriter implements RowSink {
  private queue: FileRow[] = [];
  private decided = false;
  headerIndex: number | null = null;
  header: PriceCell[] | null = null;
  headerRowNo: number | null = null;
  private headerKey: string | null = null;
  private seen = 0;
  rows = 0;
  dataRows = 0;
  serviceRows = 0;
  width = 0;
  readonly samples: PriceCell[][] = [];

  constructor(
    private readonly db: DbExecutor,
    private readonly importId: string,
  ) {}

  row(row: FileRow): void {
    this.queue.push(row);
  }

  async flush(final = false): Promise<void> {
    if (!this.decided) {
      if (!final && this.queue.length < HEADER_SEARCH_ROWS) return;
      this.decide();
    }
    while (this.queue.length >= BATCH || (final && this.queue.length > 0)) {
      await this.write(this.queue.splice(0, BATCH));
    }
  }

  private decide(): void {
    this.decided = true;
    const index = findPriceHeader(this.queue.slice(0, HEADER_SEARCH_ROWS).map((row) => row.cells));
    if (index !== null) {
      this.headerIndex = index;
      this.header = this.queue[index]!.cells;
      this.headerRowNo = this.queue[index]!.rowNo;
      const key = priceHeaderKey(this.header);
      this.headerKey = key === "" ? null : key;
    }
  }

  private kindOf(position: number, cells: PriceCell[]): PriceRowKind {
    if (this.headerIndex !== null) {
      if (position < this.headerIndex) return "title";
      if (position === this.headerIndex) return "header";
    }
    return classifyPriceRow(cells, this.headerKey);
  }

  private async write(batch: FileRow[]): Promise<void> {
    const values = batch.map((row) => {
      const kind = this.kindOf(this.seen++, row.cells);
      this.width = Math.max(this.width, row.cells.length);
      if (kind === "data") {
        this.dataRows++;
        if (this.samples.length < SAMPLE_ROWS) this.samples.push(row.cells);
      } else if (kind !== "header") {
        this.serviceRows++;
      }
      return { importId: this.importId, rowNo: row.rowNo, kind, raw: row.cells };
    });
    await this.db.insert(priceImportRow).values(values);
    this.rows += values.length;
    await this.db
      .update(priceImport)
      .set({ stats: { rows: this.rows }, updatedAt: new Date() })
      .where(and(eq(priceImport.id, this.importId), eq(priceImport.status, "parsing")));
  }
}

/**
 * The remembered roles fitted to a file of `width` columns: a wider file
 * (a row of goods longer than the header) gets «Не использовать» for the
 * rest; a narrower one may only lose columns that were not used. `null` —
 * the format doesn't fit.
 */
export function fitRoles(
  roles: readonly PriceColumnRole[],
  width: number,
): PriceColumnRole[] | null {
  const fitted = Array.from({ length: width }, (_, index) => roles[index] ?? "ignore");
  if (roles.slice(width).some((role) => role !== "ignore")) return null;
  return priceRolesProblem(fitted) === null ? fitted : null;
}

/**
 * Reading the values of the rows by the confirmed roles
 * (`prices.read-values`; TASK-046 requirement 3): `readPriceRow` of
 * `packages/domain` on every row of goods, in batches of a thousand, with
 * the count in `stats` for the progress. The limits of a price and a term
 * are the offer's (`offer_price_*`, `offer_lead_days_max`). Ends with the
 * import `parsed` and the number of rows with errors.
 */
@Injectable()
export class PriceValuesReader implements JobHandler<{ importId: string }> {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    return this.read(importId, context);
  }

  async read(importId: string, context: JobRunContext): Promise<void> {
    const db = this.database.db;
    const [record] = await db.select().from(priceImport).where(eq(priceImport.id, importId));
    if (!record || record.status !== "reading" || !record.columnMapping) return;
    const startedAt = Date.now();
    const values = await this.settings.values();
    const limits = {
      priceMin: values.offer_price_min_kzt,
      priceMax: values.offer_price_max_kzt,
      leadDaysMax: values.offer_lead_days_max,
    };
    const roles = record.columnMapping.map((column) => column.role);
    const stats = record.stats;
    let after = -1;
    let read = 0;
    for (;;) {
      if (context.signal.aborted) throw new Error("Stopped while reading the rows of a price list");
      const batch = await db
        .select({ rowNo: priceImportRow.rowNo, raw: priceImportRow.raw })
        .from(priceImportRow)
        .where(
          and(
            eq(priceImportRow.importId, importId),
            eq(priceImportRow.kind, "data"),
            gt(priceImportRow.rowNo, after),
          ),
        )
        .orderBy(asc(priceImportRow.rowNo))
        .limit(BATCH);
      if (batch.length === 0) break;
      const payload = batch.map((row) => {
        const reading = readPriceRow(row.raw, roles, limits);
        return {
          row_no: row.rowNo,
          parsed: reading.parsed,
          errors: reading.errors.length > 0 ? reading.errors : null,
        };
      });
      await db.execute(sql`
        UPDATE price_import_row r
        SET parsed = x.parsed, errors = x.errors
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS x(row_no int, parsed jsonb, errors jsonb)
        WHERE r.import_id = ${importId} AND r.row_no = x.row_no`);
      read += batch.length;
      after = batch.at(-1)!.rowNo;
      const [still] = await db
        .update(priceImport)
        .set({ stats: { ...stats, valuesRead: read }, updatedAt: new Date() })
        .where(and(eq(priceImport.id, importId), eq(priceImport.status, "reading")))
        .returning({ id: priceImport.id });
      // Confirmed again or failed meanwhile: this run is no longer the one.
      if (!still) return;
    }
    const [errors] = await db
      .select({ value: count() })
      .from(priceImportRow)
      .where(
        and(
          eq(priceImportRow.importId, importId),
          eq(priceImportRow.kind, "data"),
          isNotNull(priceImportRow.errors),
        ),
      );
    const errorRows = errors?.value ?? 0;
    await db
      .update(priceImport)
      .set({
        status: "parsed",
        stats: {
          rows: stats.rows,
          dataRows: stats.dataRows,
          serviceRows: stats.serviceRows,
          parsedRows: read - errorRows,
          errorRows,
        },
        parsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "reading")));
    this.logger.log(
      `Price rows read import=${importId} rows=${String(read)} errors=${String(errorRows)} durationMs=${String(Date.now() - startedAt)}`,
    );
  }
}

/**
 * Reading a price file (`prices.parse`; TASK-046 requirement 2;
 * ARCHITECTURE 4.66). The file is taken from the storage, read into rows
 * as a stream and written in batches; then the columns are recognised.
 * With the company's remembered format for this header the rows are read
 * by it at once and S-PRICE-02 is skipped; otherwise the import waits for
 * the supplier (`columns`). A problem of the file fails the import with
 * its reason; anything else is retried, and the last attempt that still
 * fails says the file could not be read.
 */
@Injectable()
export class PriceFileParser implements JobHandler<{ importId: string }> {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PriceFileStorage) private readonly storage: PriceFileStorage,
    @Inject(PriceValuesReader) private readonly values: PriceValuesReader,
  ) {}

  async run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    const db = this.database.db;
    const [record] = await db.select().from(priceImport).where(eq(priceImport.id, importId));
    if (!record || record.status !== "parsing") return;
    const startedAt = Date.now();
    const maxRows = (await this.settings.values()).import_max_rows;
    // A retry starts over.
    await db.delete(priceImportRow).where(eq(priceImportRow.importId, importId));
    const writer = new RowWriter(db, importId);
    let facts;
    try {
      const bytes = await this.storage.get(record.fileKey);
      facts = await readPriceFile(bytes, record.fileKind, maxRows, writer);
      await writer.flush(true);
    } catch (error) {
      if (error instanceof PriceFileError) {
        await this.fail(importId, failureOf(error));
        return;
      }
      if (error instanceof PriceFileMissing) {
        await this.fail(importId, {
          reason: "file_missing",
          detected: null,
          limit: null,
          line: null,
        });
        return;
      }
      const retries = parsePriceFileJob.retry.limit;
      if (context.attempt > retries) {
        this.logger.error(
          `Price file could not be read import=${importId} cause=${error instanceof Error ? error.message : String(error)}`,
        );
        await this.fail(importId, { reason: "broken", detected: null, limit: null, line: null });
        return;
      }
      throw error;
    }
    if (writer.dataRows === 0) {
      await this.fail(importId, { reason: "empty", detected: null, limit: null, line: null });
      return;
    }

    const width = writer.width;
    const guesses = recognizePriceColumns(writer.header, writer.samples, width);
    let mapping: StoredColumn[] = guesses.map((guess) => ({
      role: guess.role,
      source: guess.source,
      confidence: guess.source ? Number(guess.confidence.toFixed(2)) : null,
    }));
    const headerKey = writer.header ? priceHeaderKey(writer.header) || null : null;
    let remembered = false;
    if (headerKey) {
      const [format] = await db
        .select()
        .from(priceImportFormatTable)
        .where(
          and(
            eq(priceImportFormatTable.supplierId, record.supplierId),
            eq(priceImportFormatTable.headerKey, headerKey),
          ),
        );
      const roles = format ? fitRoles(format.roles, width) : null;
      if (roles) {
        remembered = true;
        mapping = roles.map((role) => ({ role, source: "remembered", confidence: null }));
      }
    }
    const stats: PriceImportStatsRecord = {
      rows: writer.rows,
      dataRows: writer.dataRows,
      serviceRows: writer.serviceRows,
      ...(remembered ? { valuesRead: 0 } : {}),
    };
    const [done] = await db
      .update(priceImport)
      .set({
        status: remembered ? "reading" : "columns",
        sheetName: facts.sheetName,
        encoding: facts.encoding,
        delimiter: facts.delimiter,
        headerRowNo: writer.headerRowNo,
        columnCount: width,
        headerKey,
        columnMapping: mapping,
        columnsSource: remembered ? "remembered" : "auto",
        stats,
        phaseStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsing")))
      .returning({ id: priceImport.id });
    this.logger.log(
      `Price file read import=${importId} rows=${String(writer.rows)} dataRows=${String(writer.dataRows)} remembered=${String(remembered)} durationMs=${String(Date.now() - startedAt)}`,
    );
    // The company's format: the rows are read by it now, in this very run.
    if (done && remembered) await this.values.read(importId, context);
  }

  private async fail(importId: string, failure: PriceImportFailure): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [failed] = await tx
        .update(priceImport)
        .set({ status: "failed", failure, stats: {}, updatedAt: new Date() })
        .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsing")))
        .returning({ id: priceImport.id });
      if (failed) await tx.delete(priceImportRow).where(eq(priceImportRow.importId, importId));
    });
    this.logger.log(`Price file refused import=${importId} reason=${failure.reason}`);
  }
}

/** Fails imports read for longer than `price_import_timeout_minutes` (`prices.expire-stalled`). */
@Injectable()
export class PriceImportExpiry implements PeriodicJobHandler {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async run(): Promise<JobRunOutcome> {
    const minutes = (await this.settings.values()).price_import_timeout_minutes;
    const cutoff = new Date(Date.now() - minutes * 60_000);
    const failure: PriceImportFailure = {
      reason: "timeout",
      detected: null,
      limit: null,
      line: null,
    };
    const expired = await this.database.db
      .update(priceImport)
      .set({ status: "failed", failure, updatedAt: new Date() })
      .where(
        and(
          inArray(priceImport.status, ["parsing", "reading"]),
          lt(priceImport.phaseStartedAt, cutoff),
        ),
      )
      .returning({ id: priceImport.id });
    if (expired.length === 0) return { worked: false };
    this.logger.warn(`Price imports read too long failed imports=${String(expired.length)}`);
    return { worked: true };
  }
}

/**
 * Removes the files of imports older than `price_import_file_retention_days`
 * (`prices.delete-files`; a sweeper). The object goes before the
 * transaction commits: if it is rolled back, the next run removes nothing
 * and marks the import — the storage and the records agree either way.
 */
@Injectable()
export class PriceFileDeletion implements Sweeper<Date> {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PriceFileStorage) private readonly storage: PriceFileStorage,
  ) {}

  async prepare(): Promise<Date> {
    const days = (await this.settings.values()).price_import_file_retention_days;
    return new Date(Date.now() - days * DAY_MS);
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: priceImport.id })
      .from(priceImport)
      .where(
        and(
          isNull(priceImport.fileDeletedAt),
          lt(priceImport.createdAt, cutoff),
          batch.excludeIds.length > 0 ? notInArray(priceImport.id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(priceImport.createdAt))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, importId: string): Promise<void> {
    const [record] = await tx
      .select({ fileKey: priceImport.fileKey })
      .from(priceImport)
      .where(and(eq(priceImport.id, importId), isNull(priceImport.fileDeletedAt)));
    if (!record) return;
    await this.storage.remove(record.fileKey);
    await tx
      .update(priceImport)
      .set({ fileDeletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(priceImport.id, importId), lt(priceImport.createdAt, cutoff)));
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(
        `Price files past their retention deleted imports=${String(result.processed)}`,
      );
    }
  }
}
