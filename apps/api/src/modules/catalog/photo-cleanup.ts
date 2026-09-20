import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { DatabaseService } from "../../database";
import type {
  JobRunContext,
  JobRunOutcome,
  PeriodicJobHandler,
  Sweeper,
  SweepResult,
} from "../../jobs";
import { AppSettings } from "../settings";
import { PhotoStorage } from "./photo-storage";
import { itemPhoto, itemPhotoFile } from "./schema";

/**
 * Clearing the storage of photos nobody points at any more (TASK-013
 * requirement 5; ARCHITECTURE 4.22).
 *
 * Two different kinds of rubbish:
 * - files of a photo that was rejected or removed. They stay for
 *   `photo_removed_retention_days` so a mistake can be undone; then they
 *   go and the photo is marked `files_deleted_at` — from that moment the
 *   photo can't come back, and the row itself stays as history;
 * - files no record points at: an upload stores the objects first and
 *   writes the row afterwards, so a request that broke off in between
 *   leaves objects behind. Only objects older than
 *   `photo_orphan_retention_hours` are removed, so an upload in flight is
 *   never mistaken for rubbish.
 *
 * Both are idempotent: removing an object that is already gone is not a
 * failure, and a repeated run finds nothing left to do.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** How many objects one cleanup run looks at. */
const ORPHAN_SCAN_LIMIT = 5000;

@Injectable()
export class PhotoFileDeletion implements Sweeper<Date> {
  private readonly logger = new Logger("CatalogPhotos");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PhotoStorage) private readonly storage: PhotoStorage,
  ) {}

  /** Photos removed before this moment have had their retention. */
  async prepare(): Promise<Date> {
    const days = (await this.settings.values()).photo_removed_retention_days;
    return new Date(Date.now() - days * DAY_MS);
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: itemPhoto.id })
      .from(itemPhoto)
      .where(
        and(
          isNotNull(itemPhoto.removedAt),
          isNull(itemPhoto.filesDeletedAt),
          lt(itemPhoto.removedAt, cutoff),
          batch.excludeIds.length > 0 ? notInArray(itemPhoto.id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(itemPhoto.removedAt))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  /**
   * Removes the objects of one photo and records that they are gone. The
   * objects go before the transaction commits: if it is rolled back after
   * that, the next run simply removes nothing and marks the photo — the
   * storage and the records end up agreeing either way.
   */
  async apply(tx: DbExecutor, cutoff: Date, photoId: string): Promise<void> {
    const files = await tx.select().from(itemPhotoFile).where(eq(itemPhotoFile.photoId, photoId));
    await this.storage.remove(files.map((file) => file.storageKey));
    await tx.delete(itemPhotoFile).where(eq(itemPhotoFile.photoId, photoId));
    await tx
      .update(itemPhoto)
      .set({ filesDeletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(itemPhoto.id, photoId),
          isNotNull(itemPhoto.removedAt),
          lt(itemPhoto.removedAt, cutoff),
        ),
      );
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Files of removed photos deleted photos=${String(result.processed)}`);
    }
  }
}

@Injectable()
export class PhotoOrphanCleanup implements PeriodicJobHandler {
  private readonly logger = new Logger("CatalogPhotos");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PhotoStorage) private readonly storage: PhotoStorage,
  ) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    const hours = (await this.settings.values()).photo_orphan_retention_hours;
    const cutoff = new Date(Date.now() - hours * HOUR_MS);
    const objects = await this.storage.list(ORPHAN_SCAN_LIMIT);
    const older = objects.filter(
      (object) => object.lastModified !== null && object.lastModified < cutoff,
    );
    if (older.length === 0 || context.signal.aborted) {
      return { worked: false };
    }

    const orphans: string[] = [];
    // In batches, so one query never carries thousands of keys.
    for (let from = 0; from < older.length; from += 500) {
      if (context.signal.aborted) {
        break;
      }
      const batch = older.slice(from, from + 500);
      const known = await this.database.db
        .select({ storageKey: itemPhotoFile.storageKey })
        .from(itemPhotoFile)
        .where(
          inArray(
            itemPhotoFile.storageKey,
            batch.map((object) => object.key),
          ),
        );
      const recorded = new Set(known.map((row) => row.storageKey));
      for (const object of batch) {
        if (!recorded.has(object.key)) {
          orphans.push(object.key);
        }
      }
    }
    if (orphans.length === 0) {
      return { worked: false };
    }
    await this.storage.remove(orphans);
    this.logger.log(`Photo files without a record deleted files=${String(orphans.length)}`);
    return { worked: true };
  }
}
