import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  PRICE_IMPORT_PREVIEW_ROWS,
  type AdminPriceImportPage,
  type ConfirmPriceColumnsBody,
  type PriceImport,
  type PriceImportDetailResponse,
  type PriceImportListQuery,
  type PriceImportPage,
  type PriceImportRowsPage,
  type PriceImportRowsQuery,
  type PriceImportVersionConflictDetails,
  type UploadPriceImportQuery,
} from "@adclub/contracts";
import { priceRolesProblem } from "@adclub/domain";
import { and, asc, count, desc, eq, gt, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { ApiException, rateLimitedException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { supplier, supplierMember } from "../identity";
import { AppSettings } from "../settings";
import { checkPriceFile } from "./file/price-file";
import { PriceFileStorage, priceFileKey } from "./price-file-storage";
import { importState, notFound, PriceFileError, validationError } from "./price-import-errors";
import { parsePriceFileJob, readPriceValuesJob } from "./price-import-jobs";
import {
  describeColumns,
  describeImport,
  describePreviewRow,
  describeRow,
} from "./price-import-views";
import {
  headerHash,
  priceImport,
  priceImportFormatTable,
  priceImportRefusal,
  priceImportRow,
  type PriceImportRecord,
  type StoredColumn,
} from "./schema";

/** The employee of the cabinet who uploads or confirms. */
export interface PriceImportActor {
  supplierId: string;
  memberId: string;
  accountId: string;
}

const HOUR_SECONDS = 3600;

/** States the columns can be confirmed (or corrected) in. */
const CONFIRMABLE: readonly PriceImportRecord["status"][] = [
  "columns",
  "parsed",
  "matching",
  "review",
];

/** A row as it is before matching (TASK-047). */
const UNMATCHED = {
  matchKeyKind: null,
  matchKey: null,
  matchStage: null,
  matchGroup: null,
  matchSource: null,
  itemId: null,
  candidates: null,
  aiProposed: false,
  aiConfidence: null,
  aiExplanation: null,
  matchNote: null,
  matchError: null,
  decision: null,
  decisionItemId: null,
  decidedByMemberId: null,
  decidedAt: null,
  priceConfirmed: false,
  sendRequest: null,
} as const;

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badCursor() {
  return validationError("cursor", "Use the nextCursor of the previous page");
}

/**
 * A cursor of the history exactly as `encodeCursor` writes it: an ISO
 * instant that reads back to itself and a UUID — anything else (a year
 * 275760, «1», 36 dashes) is a 400, never a query the database refuses.
 */
export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
      const instant = new Date(value[0]);
      const year = instant.getUTCFullYear();
      if (
        !Number.isNaN(instant.getTime()) &&
        instant.toISOString() === value[0] &&
        year >= 2000 &&
        year <= 9999 &&
        UUID.test(value[1])
      ) {
        return { createdAt: value[0], id: value[1] };
      }
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw badCursor();
}

/** A cursor of the rows: the number of the last row of the page, as the file numbers them. */
export function decodeRowCursor(cursor: string): number {
  if (!/^\d{1,10}$/.test(cursor)) throw badCursor();
  const rowNo = Number(cursor);
  if (rowNo > 2_147_483_647) throw badCursor();
  return rowNo;
}

/**
 * Price list imports in the cabinet (TASK-046; SCREENS S-PRICE-01,
 * S-PRICE-02; ARCHITECTURE 12.1 steps 1–3, 4.66): the upload (the file is
 * checked by its content, stored privately, and its reading is queued — the
 * answer comes at once), the history, one import with its columns and first
 * rows, the confirmation of the roles and the rows read by them. Only the
 * company's own imports; another company's answers like a missing one.
 *
 * A blocked company (D-070) still uploads and reads its price list: nothing
 * here writes outside the cabinet or changes the showcase. Applying the
 * rows to the offers (TASK-047) is what a block refuses.
 */
@Injectable()
export class PriceImportsService {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(PriceFileStorage) private readonly storage: PriceFileStorage,
  ) {}

  async upload(
    bytes: Buffer,
    query: UploadPriceImportQuery,
    actor: PriceImportActor,
  ): Promise<PriceImport> {
    const values = await this.settings.values();
    // Before the content is looked at: a company over its limit costs nothing.
    await this.assertWithinLimit(
      this.database.db,
      actor.supplierId,
      values.price_import_uploads_per_supplier_hour,
    );
    const maxMb = values.import_max_file_mb;
    if (bytes.length > maxMb * 1024 * 1024) {
      await this.refused(actor, "too_large", bytes.length);
      throw new ApiException(
        413,
        "PAYLOAD_TOO_LARGE",
        `The file is larger than the limit of ${String(maxMb)} MB`,
      );
    }
    // Only cheap checks here (TASK-046.A requirement 1): the first bytes, the
    // ZIP directory, the start of a text. Unpacking and reading through are
    // the worker's.
    let facts;
    try {
      facts = checkPriceFile(bytes, values.import_max_rows);
    } catch (error) {
      if (error instanceof PriceFileError) {
        await this.refused(actor, error.reason, bytes.length);
        throw error.toApiException();
      }
      throw error;
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const importId = randomUUID();
    const fileKey = priceFileKey(actor.supplierId, importId);
    // The file first: a row never points at a file that isn't there.
    await this.storage.put(fileKey, bytes);
    let created: PriceImportRecord;
    try {
      created = await this.database.db.transaction(async (tx) => {
        // One company's uploads one at a time: the limit is counted exactly.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('price_import_uploads'), hashtext(${actor.supplierId}))`,
        );
        await this.assertWithinLimit(
          tx,
          actor.supplierId,
          values.price_import_uploads_per_supplier_hour,
        );
        const [same] = await tx
          .select({ id: priceImport.id })
          .from(priceImport)
          .where(
            and(eq(priceImport.supplierId, actor.supplierId), eq(priceImport.checksum, checksum)),
          )
          .orderBy(desc(priceImport.createdAt), desc(priceImport.id))
          .limit(1);
        const [row] = await tx
          .insert(priceImport)
          .values({
            id: importId,
            supplierId: actor.supplierId,
            uploadedByMemberId: actor.memberId,
            uploadedByAccountId: actor.accountId,
            status: "parsing",
            fileName: query.fileName ?? null,
            fileKind: facts.format,
            fileKey,
            byteSize: bytes.length,
            checksum,
            sameFileAsImportId: same?.id ?? null,
            encoding: facts.encoding,
            delimiter: facts.delimiter,
          })
          .returning();
        await this.queue.enqueue(parsePriceFileJob, { importId }, { tx });
        return row!;
      });
    } catch (error) {
      // Nothing points at the file: it goes, so the storage keeps no stranger.
      await this.storage.remove(fileKey).catch(() => undefined);
      throw error;
    }
    this.logger.log(
      `Price list uploaded import=${created.id} supplier=${actor.supplierId} format=${created.fileKind} bytes=${String(created.byteSize)}`,
    );
    return describeImport(created, await this.memberName(created.uploadedByMemberId));
  }

  /**
   * An upload refused before anything was stored still costs the company an
   * attempt (TASK-046.A requirement 3): without it, a file refused at once
   * could be sent again and again for free.
   */
  private async refused(actor: PriceImportActor, reason: string, byteSize: number): Promise<void> {
    await this.database.db.insert(priceImportRefusal).values({
      id: randomUUID(),
      supplierId: actor.supplierId,
      memberId: actor.memberId,
      reason,
      byteSize,
    });
    this.logger.log(
      `Price list upload refused supplier=${actor.supplierId} reason=${reason} bytes=${String(byteSize)}`,
    );
  }

  /**
   * The uploads of a company in the last hour — stored ones and refused ones
   * alike — against `price_import_uploads_per_supplier_hour`.
   */
  private async assertWithinLimit(
    executor: DbExecutor,
    supplierId: string,
    limit: number,
  ): Promise<void> {
    const result = await executor.execute<{ uploads: number; wait: number | null }>(sql`
      SELECT count(*)::int AS uploads,
        extract(epoch FROM min(created_at) + make_interval(secs => ${HOUR_SECONDS}) - now())::float AS wait
      FROM (
        SELECT created_at FROM price_import
        WHERE supplier_id = ${supplierId}::uuid
          AND created_at > now() - make_interval(secs => ${HOUR_SECONDS})
        UNION ALL
        SELECT created_at FROM price_import_refusal
        WHERE supplier_id = ${supplierId}::uuid
          AND created_at > now() - make_interval(secs => ${HOUR_SECONDS})
      ) attempts
    `);
    const row = result.rows[0];
    if (row && Number(row.uploads) >= limit) {
      // The earliest upload of the window leaves it first.
      throw rateLimitedException(
        "price_import_uploads_per_supplier",
        Number(row.wait ?? HOUR_SECONDS),
      );
    }
  }

  async page(supplierId: string, query: PriceImportListQuery): Promise<PriceImportPage> {
    const values = await this.settings.values();
    const { imports, nextCursor } = await this.list(supplierId, query);
    return {
      imports,
      nextCursor,
      limits: { maxFileMb: values.import_max_file_mb, maxRows: values.import_max_rows },
    };
  }

  /** The administrator's look at a supplier's uploads (A-SUP-03 «Прайс»). */
  async adminPage(supplierId: string, query: PriceImportListQuery): Promise<AdminPriceImportPage> {
    const [found] = await this.database.db
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!found) throw new ApiException(404, "NOT_FOUND", "No such supplier");
    return this.list(supplierId, query);
  }

  private async list(
    supplierId: string,
    query: PriceImportListQuery,
  ): Promise<{ imports: PriceImport[]; nextCursor: string | null }> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.database.db
      .select({ record: priceImport, name: supplierMember.displayName })
      .from(priceImport)
      .leftJoin(supplierMember, eq(supplierMember.id, priceImport.uploadedByMemberId))
      .where(
        and(
          eq(priceImport.supplierId, supplierId),
          after
            ? sql`(${priceImport.createdAt}, ${priceImport.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(priceImport.createdAt), desc(priceImport.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      imports: page.map((row) => describeImport(row.record, row.name)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(last.record.createdAt, last.record.id)
          : null,
    };
  }

  private async own(executor: DbExecutor, supplierId: string, importId: string, lock = false) {
    const select = executor
      .select()
      .from(priceImport)
      .where(and(eq(priceImport.id, importId), eq(priceImport.supplierId, supplierId)));
    const [record] = lock ? await select.for("update") : await select;
    if (!record) throw notFound();
    return record;
  }

  private async memberName(
    memberId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<string | null> {
    const [member] = await executor
      .select({ name: supplierMember.displayName })
      .from(supplierMember)
      .where(eq(supplierMember.id, memberId));
    return member?.name ?? null;
  }

  async detail(supplierId: string, importId: string): Promise<PriceImportDetailResponse> {
    const record = await this.own(this.database.db, supplierId, importId);
    const width = record.columnCount ?? 0;
    const [header] =
      record.headerRowNo !== null
        ? await this.database.db
            .select()
            .from(priceImportRow)
            .where(
              and(
                eq(priceImportRow.importId, importId),
                eq(priceImportRow.rowNo, record.headerRowNo),
              ),
            )
        : [];
    const preview =
      record.status === "parsing"
        ? []
        : await this.database.db
            .select()
            .from(priceImportRow)
            .where(and(eq(priceImportRow.importId, importId), eq(priceImportRow.kind, "data")))
            .orderBy(asc(priceImportRow.rowNo))
            .limit(PRICE_IMPORT_PREVIEW_ROWS);
    return {
      import: await this.described(record),
      columns: record.status === "parsing" ? null : describeColumns(record, header?.raw ?? null),
      header: header && record.status !== "parsing" ? describePreviewRow(header, width) : null,
      preview: preview.map((row) => describePreviewRow(row, width)),
    };
  }

  /**
   * The roles the supplier confirms (S-PRICE-02 «Продолжить»), or corrects
   * after the rows were read. A role the supplier left as it was keeps where
   * it came from; a changed one is the supplier's. `remember` keeps the
   * roles as the company's format for files with the same header; leaving
   * it off forgets a format remembered for that header before.
   */
  async confirmColumns(
    importId: string,
    body: ConfirmPriceColumnsBody,
    actor: PriceImportActor,
  ): Promise<PriceImport> {
    const updated = await this.database.db.transaction(async (tx) => {
      const record = await this.own(tx, actor.supplierId, importId, true);
      // The columns can be corrected until the import is applied (TASK-047):
      // matching and the decisions of the review start over.
      if (!CONFIRMABLE.includes(record.status)) {
        throw importState(
          record.status,
          record.status === "failed"
            ? "The file of this upload could not be read; upload it again"
            : record.status === "applying" || record.status === "applied"
              ? "The price list has been applied already"
              : record.status === "expired"
                ? "The review of this upload has expired; upload the file again"
                : "The file is still being read; wait for it",
        );
      }
      if (body.expectedVersion !== undefined && body.expectedVersion !== record.version) {
        // A colleague confirmed the roles after this page was loaded (TASK-046.A).
        const details: PriceImportVersionConflictDetails = {
          status: record.status,
          version: record.version,
          confirmedBy: record.columnsConfirmedByMemberId
            ? {
                memberId: record.columnsConfirmedByMemberId,
                name: await this.memberName(record.columnsConfirmedByMemberId, tx),
              }
            : null,
          confirmedAt: record.columnsConfirmedAt?.toISOString() ?? null,
          changedBy: record.changedByMemberId
            ? {
                memberId: record.changedByMemberId,
                name: await this.memberName(record.changedByMemberId, tx),
              }
            : null,
          changedAt: record.changedAt?.toISOString() ?? null,
        };
        throw new ApiException(
          409,
          "PRICE_IMPORT_VERSION_CONFLICT",
          "The columns were confirmed by someone else meanwhile; reload the page",
          { details },
        );
      }
      const previous = record.columnMapping ?? [];
      if (body.roles.length !== previous.length) {
        throw validationError(
          "roles",
          `Give a role to each of the ${String(previous.length)} columns, in their order`,
        );
      }
      const problem = priceRolesProblem(body.roles);
      if (problem?.kind === "repeated") {
        throw validationError("roles", `Only one column can be «${problem.role}»`);
      }
      if (problem) {
        throw validationError("roles", "A price, and an article or a name, are required");
      }
      const mapping: StoredColumn[] = body.roles.map((role, index) => {
        const before = previous[index]!;
        return before.role === role ? before : { role, source: "supplier", confidence: null };
      });
      const stats = record.stats;
      const [row] = await tx
        .update(priceImport)
        .set({
          status: "reading",
          columnMapping: mapping,
          columnsSource: "supplier",
          stats: {
            rows: stats.rows,
            dataRows: stats.dataRows,
            serviceRows: stats.serviceRows,
            valuesRead: 0,
          },
          // The phase begins when the worker takes it, not while it waits.
          phaseStartedAt: null,
          parsedAt: null,
          version: record.version + 1,
          columnsConfirmedByMemberId: actor.memberId,
          columnsConfirmedAt: new Date(),
          changedByMemberId: actor.memberId,
          changedAt: new Date(),
          missingAction: null,
          missingDecidedByMemberId: null,
          missingDecidedAt: null,
          matchedAt: null,
          reviewUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(priceImport.id, importId))
        .returning();
      if (record.status !== "columns" && record.status !== "parsed") {
        // Read again by other roles: what matching found and what was decided goes.
        await tx.update(priceImportRow).set(UNMATCHED).where(eq(priceImportRow.importId, importId));
      }
      if (record.headerKey) {
        const hash = headerHash(record.headerKey);
        if (body.remember) {
          await tx
            .insert(priceImportFormatTable)
            .values({
              supplierId: actor.supplierId,
              headerKey: record.headerKey,
              headerHash: hash,
              roles: body.roles,
              rememberedByMemberId: actor.memberId,
            })
            .onConflictDoUpdate({
              target: [priceImportFormatTable.supplierId, priceImportFormatTable.headerHash],
              set: {
                roles: body.roles,
                rememberedByMemberId: actor.memberId,
                updatedAt: new Date(),
              },
            });
        } else {
          await tx
            .delete(priceImportFormatTable)
            .where(
              and(
                eq(priceImportFormatTable.supplierId, actor.supplierId),
                eq(priceImportFormatTable.headerHash, hash),
              ),
            );
        }
      }
      await this.queue.enqueue(readPriceValuesJob, { importId }, { tx });
      return row!;
    });
    return this.described(updated);
  }

  /** An import with the names of who uploaded and who applied it. */
  private async described(record: PriceImportRecord): Promise<PriceImport> {
    return describeImport(
      record,
      await this.memberName(record.uploadedByMemberId),
      record.appliedByMemberId ? await this.memberName(record.appliedByMemberId) : null,
    );
  }

  async rows(
    supplierId: string,
    importId: string,
    query: PriceImportRowsQuery,
  ): Promise<PriceImportRowsPage> {
    const record = await this.own(this.database.db, supplierId, importId);
    const after = query.cursor === undefined ? null : decodeRowCursor(query.cursor);
    const filter: SQL[] = [eq(priceImportRow.importId, importId), eq(priceImportRow.kind, "data")];
    if (query.only === "errors") {
      // The reading's errors and, once matched, the matching's (TASK-047).
      filter.push(or(isNotNull(priceImportRow.errors), isNotNull(priceImportRow.matchError))!);
    }
    const [rows, [total]] = await Promise.all([
      this.database.db
        .select()
        .from(priceImportRow)
        .where(and(...filter, after !== null ? gt(priceImportRow.rowNo, after) : undefined))
        .orderBy(asc(priceImportRow.rowNo))
        .limit(query.limit + 1),
      this.database.db
        .select({ value: count() })
        .from(priceImportRow)
        .where(and(...filter)),
    ]);
    const page = rows.slice(0, query.limit);
    const width = record.columnCount ?? 0;
    return {
      rows: page.map((row) => describeRow(row, width)),
      total: total?.value ?? 0,
      nextCursor: rows.length > query.limit ? String(page.at(-1)!.rowNo) : null,
    };
  }
}
