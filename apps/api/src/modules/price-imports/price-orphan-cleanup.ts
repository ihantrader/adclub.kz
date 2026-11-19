import { Inject, Injectable, Logger } from "@nestjs/common";
import { asc, eq, lt, sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import type { JobRunContext, JobRunOutcome, PeriodicJobHandler } from "../../jobs";
import { AppSettings } from "../settings";
import { PriceFileStorage } from "./price-file-storage";
import { priceFilePending } from "./schema";

const HOUR_MS = 60 * 60 * 1000;

/** How many records one run takes. */
const BATCH = 200;

/**
 * Files of price uploads that never became an import (TASK-064.A;
 * ARCHITECTURE 4.93; `prices.cleanup-orphan-files`, hourly). An upload
 * records its file (`price_file_pending`) before storing it and removes the
 * record in the transaction that writes the import — or the retaken page —
 * so a record older than `price_import_orphan_retention_hours` names a file
 * nobody points at: a request cut off, a process that stopped in between.
 * The file goes (a key ending in «/» — every object under the prefix of a
 * photographed import), then the record. Idempotent: an object already gone
 * is no failure, and a record whose removal failed is taken again next time.
 */
@Injectable()
export class PriceOrphanCleanup implements PeriodicJobHandler {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PriceFileStorage) private readonly storage: PriceFileStorage,
  ) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    const hours = await this.settings.get("price_import_orphan_retention_hours");
    const cutoff = new Date(Date.now() - hours * HOUR_MS);
    let removed = 0;
    for (;;) {
      const records = await this.database.db
        .select({ fileKey: priceFilePending.fileKey })
        .from(priceFilePending)
        .where(lt(priceFilePending.createdAt, cutoff))
        .orderBy(asc(priceFilePending.createdAt))
        .limit(BATCH);
      for (const { fileKey } of records) {
        if (context.signal.aborted) break;
        // Never a file someone points at, whatever the record says.
        const [owned] = await this.database.db
          .execute<{ owned: boolean }>(
            sql`
          SELECT EXISTS (SELECT 1 FROM price_import WHERE file_key = ${fileKey})
            OR EXISTS (SELECT 1 FROM price_import_photo_page WHERE file_key = ${fileKey}) AS owned`,
          )
          .then((result) => result.rows);
        if (!owned?.owned) {
          if (fileKey.endsWith("/")) await this.storage.removePrefix(fileKey);
          else await this.storage.remove(fileKey);
        }
        await this.database.db
          .delete(priceFilePending)
          .where(eq(priceFilePending.fileKey, fileKey));
        removed++;
      }
      if (records.length < BATCH || context.signal.aborted) break;
    }
    if (removed > 0) {
      this.logger.log(`Files of price uploads never written removed files=${String(removed)}`);
    }
    return { worked: removed > 0 };
  }
}
