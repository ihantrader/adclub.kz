import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminVehicleImport,
  type AdminVehicleImportPage,
  type UploadVehicleImportQuery,
  type VehicleImportListQuery,
  type VehicleImportRowsPage,
  type VehicleImportRowsQuery,
  type VehicleImportTemplateResponse,
} from "@adclub/contracts";
import { and, asc, count, desc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../../common/errors";
import { DatabaseService, type DbExecutor } from "../../../database";
import { JobQueue } from "../../../jobs";
import { AuditLog } from "../../audit";
import { AppSettings } from "../../settings";
import { decodeCursor, encodeCursor, iso, TIME_POSITION } from "../vehicle-common";
import { importState, notFound, validationError } from "../vehicle-errors";
import { optionNames } from "../vehicle-options.service";
import {
  vehicleImport,
  vehicleImportRow,
  vehicleOption,
  type VehicleImportRecord,
} from "../schema";
import { readImportFile } from "./csv";
import { analyzeImportJob, applyImportJob } from "./import-jobs";
import { rowFingerprint } from "./import-plan";
import {
  IMPORT_TEMPLATE_DELIMITER,
  IMPORT_TEMPLATE_FILE_NAME,
  templateColumns,
  templateCsv,
} from "./import-template";

/** The administrator who uploads or confirms an import. */
export interface ImportActor {
  role: "admin";
  adminId: string;
  accountId: string;
}

/** Rows written in one statement at upload. */
const INSERT_CHUNK = 1000;

/** A row that doesn't fit the header keeps its cells as `cell_1`, `cell_2`, … */
export const MALFORMED_CELL_PREFIX = "cell_";

export function isMalformed(values: Record<string, string>): boolean {
  return Object.keys(values).some((key) => key.startsWith(MALFORMED_CELL_PREFIX));
}

const createdPosition = sql<string>`to_char(${vehicleImport.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function describe(row: VehicleImportRecord, sameFileAs: string | null): AdminVehicleImport {
  return {
    id: row.id,
    status: row.status,
    fileName: row.fileName,
    byteSize: row.byteSize,
    rowCount: row.rowCount,
    delimiter: row.delimiter,
    report: row.report,
    result: row.result,
    error: row.error,
    sameFileAsImportId: sameFileAs,
    uploadedBy: { adminId: row.uploadedByAdminId, accountId: row.uploadedByAccountId },
    appliedBy:
      row.appliedByAdminId && row.appliedByAccountId
        ? { adminId: row.appliedByAdminId, accountId: row.appliedByAccountId }
        : null,
    createdAt: row.createdAt.toISOString(),
    analyzedAt: iso(row.analyzedAt),
    appliedAt: iso(row.appliedAt),
    finishedAt: iso(row.finishedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Imports of the vehicle catalog from a file (TASK-014 requirement 3;
 * SCREENS A-CAR-02; ARCHITECTURE 4.24): the template, the upload (the file
 * is read and its rows stored at once; file-level problems are refused
 * here), the report the background check writes, confirmation, cancelling
 * and the history. Nothing in the catalog changes until the administrator
 * confirms a ready report; the application is a background job too.
 */
@Injectable()
export class VehicleImportService {
  private readonly logger = new Logger("VehicleImport");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  async template(): Promise<VehicleImportTemplateResponse> {
    const options = await this.database.db
      .select()
      .from(vehicleOption)
      .where(eq(vehicleOption.status, "active"))
      .orderBy(asc(vehicleOption.kind), asc(vehicleOption.sort), asc(vehicleOption.code));
    return {
      fileName: IMPORT_TEMPLATE_FILE_NAME,
      contentType: "text/csv",
      encoding: "utf-8",
      delimiter: IMPORT_TEMPLATE_DELIMITER,
      columns: templateColumns(),
      options: options.map((option) => ({
        kind: option.kind,
        code: option.code,
        names: optionNames(option),
      })),
      csv: templateCsv(),
    };
  }

  async upload(
    bytes: Buffer,
    query: UploadVehicleImportQuery,
    actor: ImportActor,
  ): Promise<AdminVehicleImport> {
    const [maxMb, maxRows] = await Promise.all([
      this.settings.get("vehicle_import_max_file_mb"),
      this.settings.get("vehicle_import_max_rows"),
    ]);
    if (bytes.length > maxMb * 1024 * 1024) {
      throw new ApiException(
        413,
        "PAYLOAD_TOO_LARGE",
        `The file is larger than the limit of ${String(maxMb)} MB`,
      );
    }
    const file = readImportFile(bytes, maxRows);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const created = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(vehicleImport)
        .values({
          status: "parsing",
          fileName: query.fileName ?? null,
          byteSize: bytes.length,
          checksum,
          delimiter: file.delimiter,
          rowCount: file.rows.length,
          uploadedByAdminId: actor.adminId,
          uploadedByAccountId: actor.accountId,
        })
        .returning();
      const importId = row!.id;
      const values = file.rows.map((entry) => {
        const cells: Record<string, string> =
          entry.values ??
          Object.fromEntries(
            entry.cells.map((cell, index) => [`${MALFORMED_CELL_PREFIX}${index + 1}`, cell]),
          );
        return {
          importId,
          rowNumber: entry.rowNumber,
          values: cells,
          // A row that doesn't fit the header is fingerprinted by its cells as they are.
          fingerprint: entry.values
            ? rowFingerprint(entry.values)
            : createHash("sha256").update(JSON.stringify(entry.cells), "utf8").digest("hex"),
        };
      });
      for (let at = 0; at < values.length; at += INSERT_CHUNK) {
        await tx.insert(vehicleImportRow).values(values.slice(at, at + INSERT_CHUNK));
      }
      await this.audit.record(
        {
          action: auditActions.vehicleImportUploaded,
          actor,
          entityType: auditEntities.vehicleImport,
          entityId: importId,
          after: {
            fileName: row!.fileName,
            byteSize: row!.byteSize,
            checksum,
            rowCount: row!.rowCount,
          },
        },
        tx,
      );
      await this.queue.enqueue(analyzeImportJob, { importId }, { tx });
      return row!;
    });
    this.logger.log(
      `Vehicle import uploaded import=${created.id} rows=${created.rowCount} bytes=${created.byteSize}`,
    );
    return this.describeOne(this.database.db, created);
  }

  async page(query: VehicleImportListQuery): Promise<AdminVehicleImportPage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after && !TIME_POSITION.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous page");
    }
    const filters: (SQL | undefined)[] = [
      query.status ? eq(vehicleImport.status, query.status) : undefined,
    ];
    const [rows, [total]] = await Promise.all([
      executor
        .select({ entry: vehicleImport, position: createdPosition })
        .from(vehicleImport)
        .where(
          and(
            ...filters,
            after
              ? sql`(${vehicleImport.createdAt}, ${vehicleImport.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(vehicleImport.createdAt), desc(vehicleImport.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(vehicleImport)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      imports: await this.describeMany(
        executor,
        page.map((row) => row.entry),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.entry.id) : null,
    };
  }

  async get(importId: string): Promise<AdminVehicleImport> {
    return this.describeOne(this.database.db, await this.find(this.database.db, importId));
  }

  async rows(importId: string, query: VehicleImportRowsQuery): Promise<VehicleImportRowsPage> {
    const executor = this.database.db;
    await this.find(executor, importId);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after && !/^\d{1,9}$/.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous page");
    }
    const filters: (SQL | undefined)[] = [
      eq(vehicleImportRow.importId, importId),
      query.planned ? eq(vehicleImportRow.planned, query.planned) : undefined,
      query.outcome ? eq(vehicleImportRow.outcome, query.outcome) : undefined,
    ];
    const [rows, [total]] = await Promise.all([
      executor
        .select()
        .from(vehicleImportRow)
        .where(
          and(
            ...filters,
            after ? gt(vehicleImportRow.rowNumber, Number(after.position)) : undefined,
          ),
        )
        .orderBy(asc(vehicleImportRow.rowNumber))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(vehicleImportRow)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      rows: page.map((row) => ({
        row: row.rowNumber,
        values: row.values,
        planned: row.planned,
        reasons: row.reasons ?? [],
        outcome: row.outcome,
        outcomeReasons: row.outcomeReasons ?? [],
        modificationId: row.modificationId,
      })),
      total: total?.value ?? 0,
      // The row number is the position; the id part names the import.
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(String(last.rowNumber), importId) : null,
    };
  }

  /**
   * Confirms a ready report: the import is applied by a background job.
   * Only a ready import is applied, and only once — a second confirmation
   * (a double click, another administrator) gets `VEHICLE_IMPORT_STATE`.
   */
  async apply(importId: string, actor: ImportActor): Promise<AdminVehicleImport> {
    const updated = await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, importId);
      if (row.status !== "ready") {
        throw importState(row.status, "Only an import with a ready report can be applied");
      }
      const [changed] = await tx
        .update(vehicleImport)
        .set({
          status: "applying",
          appliedByAdminId: actor.adminId,
          appliedByAccountId: actor.accountId,
          phaseStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(vehicleImport.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleImportApplyStarted,
          actor,
          entityType: auditEntities.vehicleImport,
          entityId: row.id,
          before: { status: row.status },
          after: {
            status: "applying",
            planned: {
              create: row.report?.create ?? 0,
              update: row.report?.update ?? 0,
              unchanged: row.report?.unchanged ?? 0,
              rejected: row.report?.rejected ?? 0,
            },
          },
        },
        tx,
      );
      await this.queue.enqueue(applyImportJob, { importId: row.id }, { tx });
      return changed!;
    });
    this.logger.log(`Vehicle import apply started import=${updated.id}`);
    return this.describeOne(this.database.db, updated);
  }

  /** Declines an import before it is applied; nothing in the catalog changes. */
  async cancel(importId: string, actor: ImportActor): Promise<AdminVehicleImport> {
    const updated = await this.database.db.transaction(async (tx) => {
      const row = await this.lock(tx, importId);
      if (row.status !== "parsing" && row.status !== "ready") {
        throw importState(row.status, "Only an import that isn't applied yet can be cancelled");
      }
      const [changed] = await tx
        .update(vehicleImport)
        .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(vehicleImport.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleImportCancelled,
          actor,
          entityType: auditEntities.vehicleImport,
          entityId: row.id,
          before: { status: row.status },
          after: { status: "cancelled" },
        },
        tx,
      );
      return changed!;
    });
    return this.describeOne(this.database.db, updated);
  }

  private async find(executor: DbExecutor, importId: string): Promise<VehicleImportRecord> {
    const [row] = await executor.select().from(vehicleImport).where(eq(vehicleImport.id, importId));
    if (!row) {
      throw notFound("import");
    }
    return row;
  }

  private async lock(executor: DbExecutor, importId: string): Promise<VehicleImportRecord> {
    const [row] = await executor
      .select()
      .from(vehicleImport)
      .where(eq(vehicleImport.id, importId))
      .for("update");
    if (!row) {
      throw notFound("import");
    }
    return row;
  }

  private async describeOne(
    executor: DbExecutor,
    row: VehicleImportRecord,
  ): Promise<AdminVehicleImport> {
    return (await this.describeMany(executor, [row]))[0]!;
  }

  /** With the earlier import of the very same file, if there was one. */
  private async describeMany(
    executor: DbExecutor,
    rows: readonly VehicleImportRecord[],
  ): Promise<AdminVehicleImport[]> {
    if (rows.length === 0) {
      return [];
    }
    const earlier = await executor
      .select({
        id: vehicleImport.id,
        checksum: vehicleImport.checksum,
        createdAt: vehicleImport.createdAt,
      })
      .from(vehicleImport)
      .where(
        and(
          inArray(vehicleImport.checksum, [...new Set(rows.map((row) => row.checksum))]),
          lt(
            vehicleImport.createdAt,
            new Date(Math.max(...rows.map((row) => row.createdAt.getTime())) + 1),
          ),
        ),
      )
      .orderBy(desc(vehicleImport.createdAt), desc(vehicleImport.id));
    return rows.map((row) => {
      const same = earlier.find(
        (entry) =>
          entry.checksum === row.checksum &&
          entry.id !== row.id &&
          entry.createdAt.getTime() <= row.createdAt.getTime(),
      );
      return describe(row, same?.id ?? null);
    });
  }
}
