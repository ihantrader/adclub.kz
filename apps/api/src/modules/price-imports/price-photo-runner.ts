import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  agreePricePhotoPages,
  PRICE_PHOTO_FIELDS,
  PRICE_PHOTO_ROLES,
  pricePhotoPage,
} from "@adclub/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { JobQueue, type JobHandler, type JobRunContext } from "../../jobs";
import { AiBudgetExhaustedError, AiGatewayError, AiService, FALLBACK_WORTHY } from "../ai";
import { AppSettings } from "../settings";
import { PriceFileMissing, PriceFileStorage } from "./price-file-storage";
import { PHOTO_CLAIM_STALE_SECONDS, readPricePhotosJob } from "./price-import-jobs";
import { failImport, PriceValuesReader } from "./price-import-runner";
import {
  priceImport,
  priceImportPhotoPage,
  priceImportRow,
  type PriceImportPhotoPageRecord,
  type StoredColumn,
} from "./schema";

/** Rows written in one statement. */
const BATCH = 1000;

/** The pages that gave nothing a person can apply: taken again or left out. */
const RETAKE: readonly PriceImportPhotoPageRecord["status"][] = [
  "no_table",
  "unreadable",
  "failed",
];

/**
 * Reading a photographed price list (`prices.read-photos`; TASK-064;
 * ARCHITECTURE 12.1 step 2, 4.93). Page after page the picture is taken
 * from the storage and read by AI (`AiService.readPricePhoto` — the budget,
 * the models of the settings, the record in `ai_job` with the size only);
 * the answer is checked by `pricePhotoPage` of the domain and kept with the
 * page. A page read stays read: a run that comes back (AI was out of reach,
 * a worker stopped) reads only what is left.
 *
 * When every page is read: a page that gave nothing — the import waits for
 * the supplier (`needs_retake`); otherwise the rows of all pages are written
 * in the order of the pages, in the roles of `PRICE_PHOTO_ROLES`, and their
 * values are read at once by `PriceValuesReader` — the very path of a file
 * with a remembered format: matching, the review and applying follow as for
 * any file.
 */
@Injectable()
export class PricePhotoReader implements JobHandler<{ importId: string }> {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(PriceFileStorage) private readonly storage: PriceFileStorage,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(PriceValuesReader) private readonly values: PriceValuesReader,
  ) {}

  async run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    const db = this.database.db;
    const [record] = await db.select().from(priceImport).where(eq(priceImport.id, importId));
    if (!record || record.fileKind !== "photo") return;
    if (record.status === "reading" && record.columnsSource === "photo") {
      // A retry of a run that wrote the rows and failed reading their values.
      await this.readValues(importId, context);
      return;
    }
    if (record.status !== "parsing") return;
    // The phase starts now; a wait for AI is over. One run at a time: another
    // run is shown by a phase it refreshed recently (before each call to AI),
    // and a run that stopped gives way once its phase is stale.
    const [claimed] = await db
      .update(priceImport)
      .set({ phaseStartedAt: new Date(), photoAiWaiting: null, updatedAt: new Date() })
      .where(
        and(
          eq(priceImport.id, importId),
          eq(priceImport.status, "parsing"),
          sql`(${priceImport.phaseStartedAt} IS NULL OR ${priceImport.phaseStartedAt} < now() - make_interval(secs => ${PHOTO_CLAIM_STALE_SECONDS}))`,
        ),
      )
      .returning({ id: priceImport.id });
    if (!claimed) return;

    const pages = await this.pages(importId);
    for (const page of pages) {
      if (page.status !== "waiting") continue;
      if (context.signal.aborted) throw new Error("Stopped while reading a photographed price");
      const outcome = await this.readPage(importId, page);
      if (outcome === "stop") return;
    }

    const read = await this.pages(importId);
    if (read.some((page) => page.status === "waiting")) {
      // A page was taken again while this run read the others: its own run reads it.
      return;
    }
    if (read.some((page) => RETAKE.includes(page.status))) {
      await db
        .update(priceImport)
        .set({ status: "needs_retake", phaseStartedAt: null, updatedAt: new Date() })
        .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsing")));
      this.logger.log(
        `Price photos need a retake import=${importId} pages=${read
          .filter((page) => RETAKE.includes(page.status))
          .map((page) => `${String(page.pageNo)}:${page.status}`)
          .join(",")}`,
      );
      return;
    }
    await this.writeRows(importId, read, context);
  }

  private pages(importId: string): Promise<PriceImportPhotoPageRecord[]> {
    return this.database.db
      .select()
      .from(priceImportPhotoPage)
      .where(eq(priceImportPhotoPage.importId, importId))
      .orderBy(asc(priceImportPhotoPage.pageNo));
  }

  /** One page to AI; `stop` — the import waits for AI or failed. */
  private async readPage(
    importId: string,
    page: PriceImportPhotoPageRecord,
  ): Promise<"next" | "stop"> {
    const db = this.database.db;
    let image: Buffer;
    try {
      image = await this.storage.get(page.fileKey);
    } catch (error) {
      if (error instanceof PriceFileMissing) {
        await failImport(db, importId, ["parsing"], {
          reason: "file_missing",
          detected: null,
          limit: null,
          line: null,
        });
        return "stop";
      }
      throw error;
    }
    let status: PriceImportPhotoPageRecord["status"];
    let rows = null;
    let dropped = null;
    let jobId: string | null = null;
    try {
      const read = async (reading: number) => {
        // A sign of life before each call: this run still holds the import.
        await this.heartbeat(importId);
        return this.ai.readPricePhoto(
          { image, contentType: "image/jpeg" },
          {
            initiator: { type: "system" },
            // The size only: the picture itself is never recorded.
            inputRef: {
              importId,
              page: page.pageNo,
              reading,
              bytes: image.length,
              width: page.width,
              height: page.height,
            },
          },
        );
      };
      const answer = await read(1);
      jobId = answer.jobId;
      let verdict = pricePhotoPage(answer.output);
      if (verdict.kind === "rows") {
        // Read twice, kept what both agree on (ARCHITECTURE 4.93): a page the
        // model can't read gives a made-up table, another one each time.
        const again = await read(2);
        verdict = agreePricePhotoPages(verdict, pricePhotoPage(again.output));
      }
      if (verdict.kind === "rows") {
        status = "read";
        rows = verdict.rows;
        dropped = verdict.dropped;
      } else {
        status = verdict.kind;
      }
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) {
        await this.wait(importId, "budget");
        return "stop";
      }
      if (error instanceof AiGatewayError && FALLBACK_WORTHY.includes(error.kind)) {
        await this.wait(importId, "unavailable");
        return "stop";
      }
      if (error instanceof AiGatewayError) {
        // Refused, answered nonsense, no private endpoint: taking the page again is the way on.
        this.logger.warn(
          `AI could not read a price photo import=${importId} page=${String(page.pageNo)} error=${error.kind}`,
        );
        status = "failed";
      } else {
        throw error;
      }
    }
    await db
      .update(priceImportPhotoPage)
      .set({
        status,
        rows,
        rowCount: rows?.length ?? null,
        droppedRows: dropped,
        aiJobId: jobId,
        recognizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(priceImportPhotoPage.importId, importId),
          eq(priceImportPhotoPage.pageNo, page.pageNo),
          // Taken again meanwhile: the new picture is read by its own run.
          eq(priceImportPhotoPage.fileKey, page.fileKey),
        ),
      );
    // A sign of life: the phase isn't stalled while pages are being read.
    await db
      .update(priceImport)
      .set({ phaseStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsing")));
    return "next";
  }

  private async heartbeat(importId: string): Promise<void> {
    await this.database.db
      .update(priceImport)
      .set({ phaseStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsing")));
  }

  /** AI can't answer now: the import says why, and the job comes back later by itself. */
  private async wait(importId: string, reason: "unavailable" | "budget"): Promise<void> {
    const retrySeconds = await this.settings.get("price_match_retry_seconds");
    await this.database.db
      .update(priceImport)
      .set({ photoAiWaiting: reason, phaseStartedAt: null, updatedAt: new Date() })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsing")));
    await this.queue.enqueue(
      readPricePhotosJob,
      { importId },
      { singletonKey: importId, startAfter: new Date(Date.now() + retrySeconds * 1000) },
    );
    this.logger.warn(
      `Price photo recognition waits for AI import=${importId} reason=${reason} retryInSeconds=${String(retrySeconds)}`,
    );
  }

  /** Every page read: the rows go to `price_import_row` and their values are read. */
  private async writeRows(
    importId: string,
    pages: readonly PriceImportPhotoPageRecord[],
    context: JobRunContext,
  ): Promise<void> {
    const db = this.database.db;
    const maxRows = (await this.settings.values()).import_max_rows;
    const rows = pages.flatMap((page) =>
      (page.rows ?? []).map((row) => ({ pageNo: page.pageNo, row })),
    );
    if (rows.length > maxRows) {
      await failImport(db, importId, ["parsing"], {
        reason: "too_many_rows",
        detected: null,
        limit: maxRows,
        line: null,
      });
      return;
    }
    const mapping: StoredColumn[] = PRICE_PHOTO_ROLES.map((role) => ({
      role,
      source: null,
      confidence: null,
    }));
    const written = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: priceImport.status })
        .from(priceImport)
        .where(eq(priceImport.id, importId))
        .for("update");
      if (current?.status !== "parsing") return false;
      await tx.delete(priceImportRow).where(eq(priceImportRow.importId, importId));
      for (let start = 0; start < rows.length; start += BATCH) {
        await tx.insert(priceImportRow).values(
          rows.slice(start, start + BATCH).map(({ pageNo, row }, index) => ({
            importId,
            // The rows of all pages in order, numbered as one list from 1.
            rowNo: start + index + 1,
            kind: "data" as const,
            raw: row.cells,
            photoPage: pageNo,
            photoText: row.text,
            photoUncertain: row.uncertain,
          })),
        );
      }
      await tx
        .update(priceImport)
        .set({
          status: "reading",
          columnMapping: mapping,
          columnsSource: "photo",
          columnCount: PRICE_PHOTO_FIELDS.length,
          headerRowNo: null,
          headerKey: null,
          stats: { rows: rows.length, dataRows: rows.length, serviceRows: 0, valuesRead: 0 },
          photoAiWaiting: null,
          // The values are read by this run now: the phase is taken.
          phaseStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(priceImport.id, importId));
      return true;
    });
    if (!written) return;
    this.logger.log(
      `Price photos read import=${importId} pages=${String(pages.length)} rows=${String(rows.length)} uncertain=${String(rows.filter(({ row }) => row.uncertain.length > 0).length)}`,
    );
    await this.readValues(importId, context);
  }

  /** As a remembered format of a file: a failure is retried with the job, the last one fails. */
  private async readValues(importId: string, context: JobRunContext): Promise<void> {
    try {
      await this.values.read(importId, context);
    } catch (error) {
      if (context.attempt > readPricePhotosJob.retry.limit) {
        this.logger.error(
          `Price photo rows could not be read import=${importId} cause=${error instanceof Error ? error.message : String(error)}`,
        );
        await failImport(this.database.db, importId, ["reading"], {
          reason: "broken",
          detected: null,
          limit: null,
          line: null,
        });
        return;
      }
      throw error;
    }
  }
}
