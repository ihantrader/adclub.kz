import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { PRICE_PHOTO_MAX_SIDE_PX, type PriceImport } from "@adclub/contracts";
import { and, count, eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { AppSettings } from "../settings";
import { DocumentImageRejected, prepareDocumentImage } from "../vehicle-document";
import { PriceFileStorage, priceFileKey } from "./price-file-storage";
import { photoFormPages } from "./photo-form";
import { filesDeleted, importState, notFound, photoInvalid } from "./price-import-errors";
import { readPricePhotosJob } from "./price-import-jobs";
import { PriceImportsService, type PriceImportActor } from "./price-imports.service";
import {
  priceFilePending,
  priceImport,
  priceImportPhotoPage,
  priceImportPhotoRetake,
  type PriceImportRecord,
} from "./schema";

/** The key of a photographed page: under the import's prefix, new for each take. */
export function pricePhotoKey(importPrefix: string, pageNo: number, take: number | string): string {
  return `${importPrefix}page-${String(pageNo)}-${String(take)}`;
}

/** A page made ready to keep: smaller, upright, without metadata. */
interface PreparedPage {
  bytes: Buffer;
  width: number;
  height: number;
  checksum: string;
}

/**
 * A photographed price list in the cabinet (TASK-064; ARCHITECTURE 12.1
 * step 2, 4.93; SCREENS S-PRICE-01): the upload of its pages, a page taken
 * again («Переснять») or left out. Each page is checked by its content
 * exactly as the photos of the catalog and the certificate are
 * (`prepareDocumentImage`: JPEG, PNG or WebP, decoded, upright, written
 * again as JPEG without its metadata) and kept privately like a price file;
 * the worker reads them (`prices.read-photos`). One upload counts once in
 * `price_import_uploads_per_supplier_hour`, however many pages; a refused
 * one counts too; a page taken again counts as an upload.
 */
@Injectable()
export class PricePhotosService {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(PriceFileStorage) private readonly storage: PriceFileStorage,
    @Inject(PriceImportsService) private readonly imports: PriceImportsService,
  ) {}

  /** One page checked and prepared; a refusal names the page. */
  private async prepare(bytes: Buffer, pageNo: number, maxMb: number): Promise<PreparedPage> {
    if (bytes.length === 0) throw photoInvalid(pageNo, "not_an_image");
    if (bytes.length > maxMb * 1024 * 1024) throw photoInvalid(pageNo, "too_large", maxMb);
    try {
      const image = await prepareDocumentImage(bytes, PRICE_PHOTO_MAX_SIDE_PX);
      return {
        ...image,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (error instanceof DocumentImageRejected) throw photoInvalid(pageNo, error.reason);
      throw error;
    }
  }

  /** A refusal of the upload: recorded (it counts in the limit), then thrown. */
  private async refuse(actor: PriceImportActor, error: unknown, bytes: number): Promise<never> {
    if (error instanceof ApiException && error.code === "PRICE_IMPORT_PHOTO_INVALID") {
      const details = error.options.details as { reason?: string } | undefined;
      await this.imports.refused(
        actor,
        `photo_${details?.reason ?? "invalid"}`,
        Math.max(1, bytes),
      );
    }
    throw error;
  }

  async upload(contentType: string, body: Buffer, actor: PriceImportActor): Promise<PriceImport> {
    const values = await this.settings.values();
    const limit = values.price_import_uploads_per_supplier_hour;
    // Before the pages are looked at: a company over its limit costs nothing.
    await this.imports.assertWithinLimit(this.database.db, actor.supplierId, limit);
    const prepared: PreparedPage[] = [];
    try {
      // Bounded by the limits while it is walked: no part past them is taken (TASK-064.A).
      const pages = photoFormPages(contentType, body, {
        maxPages: values.price_photo_max_pages,
        maxPageMb: values.price_photo_max_size_mb,
      });
      if (pages.length === 0) throw photoInvalid(null, "no_pages");
      for (const [index, bytes] of pages.entries()) {
        prepared.push(await this.prepare(bytes, index + 1, values.price_photo_max_size_mb));
      }
    } catch (error) {
      return this.refuse(actor, error, body.length);
    }
    const importId = randomUUID();
    // The import's key is the prefix of its pages: the sweeper of files removes them all.
    const prefix = `${priceFileKey(actor.supplierId, importId)}/`;
    const keys = prepared.map((_, index) => pricePhotoKey(prefix, index + 1, 0));
    const checksum = createHash("sha256")
      .update(prepared.map((page) => page.checksum).join(":"))
      .digest("hex");
    const stored: string[] = [];
    let created: PriceImportRecord;
    try {
      // Recorded before anything is stored: an upload that never comes leaves
      // a record the cleanup of orphans finds (`prices.cleanup-orphan-files`).
      await this.database.db
        .insert(priceFilePending)
        .values({ fileKey: prefix, supplierId: actor.supplierId });
      // The pages first: a row never points at a picture that isn't there.
      for (const [index, page] of prepared.entries()) {
        await this.storage.put(keys[index]!, page.bytes);
        stored.push(keys[index]!);
      }
      created = await this.database.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('price_import_uploads'), hashtext(${actor.supplierId}))`,
        );
        await this.imports.assertWithinLimit(tx, actor.supplierId, limit);
        const [same] = await tx
          .select({ id: priceImport.id })
          .from(priceImport)
          .where(
            and(eq(priceImport.supplierId, actor.supplierId), eq(priceImport.checksum, checksum)),
          )
          .orderBy(sql`${priceImport.createdAt} DESC, ${priceImport.id} DESC`)
          .limit(1);
        const [row] = await tx
          .insert(priceImport)
          .values({
            id: importId,
            supplierId: actor.supplierId,
            uploadedByMemberId: actor.memberId,
            uploadedByAccountId: actor.accountId,
            status: "parsing",
            fileName: null,
            fileKind: "photo",
            fileKey: prefix,
            byteSize: prepared.reduce((sum, page) => sum + page.bytes.length, 0),
            checksum,
            sameFileAsImportId: same?.id ?? null,
          })
          .returning();
        await tx.insert(priceImportPhotoPage).values(
          prepared.map((page, index) => ({
            importId,
            pageNo: index + 1,
            fileKey: keys[index]!,
            byteSize: page.bytes.length,
            width: page.width,
            height: page.height,
            checksum: page.checksum,
          })),
        );
        await this.queue.enqueue(readPricePhotosJob, { importId }, { tx, singletonKey: importId });
        // The pages are the import's now.
        await tx.delete(priceFilePending).where(eq(priceFilePending.fileKey, prefix));
        return row!;
      });
    } catch (error) {
      // Nothing points at the pages: they go, so the storage keeps no stranger.
      await Promise.all(stored.map((key) => this.storage.remove(key).catch(() => undefined)));
      await this.database.db
        .delete(priceFilePending)
        .where(eq(priceFilePending.fileKey, prefix))
        .catch(() => undefined);
      throw error;
    }
    this.logger.log(
      `Price photos uploaded import=${created.id} supplier=${actor.supplierId} pages=${String(prepared.length)} bytes=${String(created.byteSize)}`,
    );
    return this.imports.described(created);
  }

  /** The page of an import waiting to be taken again, locked with the import. */
  private async retakable(
    tx: DbExecutor,
    actor: PriceImportActor,
    importId: string,
    pageNo: number,
  ) {
    const record = await this.imports.own(tx, actor.supplierId, importId, true);
    if (record.fileKind !== "photo") throw notFound();
    if (record.status !== "needs_retake") {
      throw importState(
        record.status,
        "Pages can be taken again or left out only while the upload waits for it",
      );
    }
    if (record.fileDeletedAt !== null) throw filesDeleted();
    const [page] = await tx
      .select()
      .from(priceImportPhotoPage)
      .where(
        and(eq(priceImportPhotoPage.importId, importId), eq(priceImportPhotoPage.pageNo, pageNo)),
      )
      .for("update");
    if (!page) throw new ApiException(404, "NOT_FOUND", "No such page of the upload");
    return { record, page };
  }

  /** «Переснять»: the page is replaced and read again; the others keep what they gave. */
  async retake(
    importId: string,
    pageNo: number,
    bytes: Buffer,
    actor: PriceImportActor,
  ): Promise<PriceImport> {
    const values = await this.settings.values();
    const limit = values.price_import_uploads_per_supplier_hour;
    await this.imports.assertWithinLimit(this.database.db, actor.supplierId, limit);
    // The import first: a stranger's id answers 404 before anything is counted.
    const current = await this.imports.own(this.database.db, actor.supplierId, importId);
    if (current.fileKind !== "photo") throw notFound();
    // Checked again under the lock below; here, so nothing is stored for nothing.
    if (current.fileDeletedAt !== null) throw filesDeleted();
    let prepared: PreparedPage;
    try {
      prepared = await this.prepare(bytes, pageNo, values.price_photo_max_size_mb);
    } catch (error) {
      return this.refuse(actor, error, bytes.length);
    }
    const [existing] = await this.database.db
      .select({ retakes: priceImportPhotoPage.retakes })
      .from(priceImportPhotoPage)
      .where(
        and(eq(priceImportPhotoPage.importId, importId), eq(priceImportPhotoPage.pageNo, pageNo)),
      );
    if (!existing) throw new ApiException(404, "NOT_FOUND", "No such page of the upload");
    // A new object for each take, never one another retake could share (two taps at once).
    const key = pricePhotoKey(
      current.fileKey,
      pageNo,
      `${String(existing.retakes + 1)}-${randomUUID()}`,
    );
    // Recorded first: a retake cut off before its transaction leaves no stranger (TASK-064.A).
    await this.database.db
      .insert(priceFilePending)
      .values({ fileKey: key, supplierId: actor.supplierId });
    await this.storage.put(key, prepared.bytes);
    let previousKey: string;
    let updated: PriceImportRecord;
    try {
      ({ previousKey, updated } = await this.database.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('price_import_uploads'), hashtext(${actor.supplierId}))`,
        );
        const { page } = await this.retakable(tx, actor, importId, pageNo);
        await this.imports.assertWithinLimit(tx, actor.supplierId, limit);
        await tx.insert(priceImportPhotoRetake).values({
          id: randomUUID(),
          supplierId: actor.supplierId,
          importId,
          memberId: actor.memberId,
          pageNo,
        });
        await tx
          .update(priceImportPhotoPage)
          .set({
            fileKey: key,
            byteSize: prepared.bytes.length,
            width: prepared.width,
            height: prepared.height,
            checksum: prepared.checksum,
            status: "waiting",
            rows: null,
            rowCount: null,
            droppedRows: null,
            aiJobId: null,
            recognizedAt: null,
            retakes: page.retakes + 1,
            // A new picture starts over: its attempts, readings and keys (TASK-064.A).
            readAttempts: 0,
            firstReading: null,
            seenKeys: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(priceImportPhotoPage.importId, importId),
              eq(priceImportPhotoPage.pageNo, pageNo),
            ),
          );
        const row = await this.resume(tx, importId);
        await tx.delete(priceFilePending).where(eq(priceFilePending.fileKey, key));
        return { previousKey: page.fileKey, updated: row };
      }));
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      await this.database.db
        .delete(priceFilePending)
        .where(eq(priceFilePending.fileKey, key))
        .catch(() => undefined);
      throw error;
    }
    await this.storage.remove(previousKey).catch(() => undefined);
    this.logger.log(`Price photo taken again import=${importId} page=${String(pageNo)}`);
    return this.imports.described(updated);
  }

  /** «Убрать страницу»: the import goes on with the other pages; the last one stays. */
  async remove(importId: string, pageNo: number, actor: PriceImportActor): Promise<PriceImport> {
    const { removedKey, updated } = await this.database.db.transaction(async (tx) => {
      const { page } = await this.retakable(tx, actor, importId, pageNo);
      const [pages] = await tx
        .select({ value: count() })
        .from(priceImportPhotoPage)
        .where(eq(priceImportPhotoPage.importId, importId));
      if ((pages?.value ?? 0) <= 1) {
        throw importState("needs_retake", "The only page of the upload can't be left out");
      }
      await tx
        .delete(priceImportPhotoPage)
        .where(
          and(eq(priceImportPhotoPage.importId, importId), eq(priceImportPhotoPage.pageNo, pageNo)),
        );
      const row = await this.resume(tx, importId);
      return { removedKey: page.fileKey, updated: row };
    });
    await this.storage.remove(removedKey).catch(() => undefined);
    this.logger.log(`Price photo left out import=${importId} page=${String(pageNo)}`);
    return this.imports.described(updated);
  }

  /** Back to recognition: the worker reads what is left to read, then writes the rows. */
  private async resume(tx: DbExecutor, importId: string): Promise<PriceImportRecord> {
    const [row] = await tx
      .update(priceImport)
      .set({
        status: "parsing",
        photoAiWaiting: null,
        phaseStartedAt: null,
        failure: null,
        updatedAt: new Date(),
      })
      .where(eq(priceImport.id, importId))
      .returning();
    await this.queue.enqueue(readPricePhotosJob, { importId }, { tx, singletonKey: importId });
    return row!;
  }
}
