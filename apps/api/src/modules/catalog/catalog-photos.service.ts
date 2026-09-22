import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  ITEM_PHOTOS_MAX,
  type AdminItemPhoto,
  type AdminItemPhotosResponse,
  type CatalogPhotoInvalidDetails,
  type ItemPhotoImage,
  type ItemPhotoStatus,
  type PhotoDisplayMode,
  type ReorderItemPhotosBody,
  type SetItemPhotoStatusBody,
  type UploadItemPhotoQuery,
} from "@adclub/contracts";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { AppSettings } from "../settings";
import type { CatalogActor } from "./catalog-admin.service";
import { notFound, orderMismatch, versionConflict } from "./catalog-errors";
import { uniqueViolation } from "./catalog-paging";
import { describeTexts, loadTexts, textsOf } from "./catalog-texts";
import { PhotoRejected, prepareImage } from "./photo-image";
import { photoObjectKey, PhotoStorage } from "./photo-storage";
import {
  catalogItem,
  itemPhoto,
  itemPhotoFile,
  type CatalogItemRow,
  type ItemPhotoFileRow,
  type ItemPhotoRow,
} from "./schema";

/**
 * Photos of catalog items (TASK-013; PRODUCT 7.6; ARCHITECTURE 4.22,
 * 5.2; SCREENS A-CAT-05): the administrator uploads a file or decides on a
 * candidate, every photo carries its source, and only what a person
 * approved reaches clients.
 *
 * What the service holds true:
 * - the content of a file decides what it is (`photo-image.ts`), and what
 *   is stored is a picture written again without the metadata that came
 *   with it;
 * - the same picture is never stored twice for one item (the checksum and
 *   a unique key in the database);
 * - the primary photo — the one lists show — is always an approved photo
 *   of that very item; rejecting or removing it hands the role on;
 * - a photo is removed by status, its files by a background job after
 *   their retention (`photo-cleanup.ts`), so a mistake can be undone;
 * - every decision is one transaction with its entry in the action journal.
 */

/** A file that isn't a picture the catalog takes. */
function photoInvalid(reason: CatalogPhotoInvalidDetails["reason"], detected?: string) {
  const details: CatalogPhotoInvalidDetails = { reason, ...(detected ? { detected } : {}) };
  const messages: Record<CatalogPhotoInvalidDetails["reason"], string> = {
    empty: "The request carried no file",
    not_an_image: "The file is not a picture, whatever its name says",
    unsupported_format: "Only JPEG, PNG and WebP pictures are accepted",
    broken: "The picture can't be read: it is damaged or incomplete",
    too_many_pixels: "The picture is too large in pixels",
    source_url_required: "A picture found on the internet must name the page it came from",
    too_many_photos: `An item holds at most ${String(ITEM_PHOTOS_MAX)} photos`,
  };
  return new ApiException(400, "CATALOG_PHOTO_INVALID", messages[reason], { details });
}

function photoTooLarge(maxBytes: number): ApiException {
  return new ApiException(
    413,
    "PAYLOAD_TOO_LARGE",
    `The picture is larger than the limit of ${String(Math.round(maxBytes / (1024 * 1024)))} MB`,
  );
}

function notApproved(): ApiException {
  return new ApiException(
    409,
    "CATALOG_PHOTO_NOT_APPROVED",
    "Only an approved photo is the primary one or takes a place in the order",
  );
}

function filesDeleted(): ApiException {
  return new ApiException(
    409,
    "CATALOG_PHOTO_FILES_DELETED",
    "The files of this photo were removed after their retention; upload the picture again",
  );
}

/** Source types that stand for "found on the internet" (PRODUCT 7.6). */
const FOUND_ONLINE = new Set(["manufacturer", "official_catalog", "multi_store"]);

const REMOVED: ItemPhotoStatus[] = ["rejected", "deleted"];

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** The account behind the actor; the server operator command has none (D-045). */
function accountOf(actor: CatalogActor): string | null {
  return actor.role === "admin" ? actor.accountId : null;
}

interface PhotoWithFiles {
  photo: ItemPhotoRow;
  files: Map<string, ItemPhotoFileRow>;
}

@Injectable()
export class CatalogPhotosService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PhotoStorage) private readonly storage: PhotoStorage,
  ) {}

  // ----------------------------------------------------------------- read

  async list(itemId: string): Promise<AdminItemPhotosResponse> {
    const executor = this.database.db;
    const item = await this.findItem(executor, itemId);
    return this.describe(executor, item);
  }

  /**
   * The picture of each of these items as clients get it: the approved
   * primary photo, in the mode `photo_display_mode` asks for, and never
   * the full-size file. Items with no approved photo are absent from the
   * result — the client shows a placeholder.
   */
  async imagesFor(
    executor: DbExecutor,
    items: readonly CatalogItemRow[],
  ): Promise<Map<string, ItemPhotoImage>> {
    const photoIds = items.flatMap((item) => (item.primaryPhotoId ? [item.primaryPhotoId] : []));
    const images = new Map<string, ItemPhotoImage>();
    if (photoIds.length === 0) {
      return images;
    }
    const [{ mode, ttlSeconds }, loaded] = await Promise.all([
      this.delivery(),
      this.loadPhotos(executor, photoIds),
    ]);
    for (const item of items) {
      const entry = item.primaryPhotoId ? loaded.get(item.primaryPhotoId) : undefined;
      if (!entry || entry.photo.status !== "approved") {
        continue;
      }
      const image = await this.imageOf(entry, mode, ttlSeconds);
      if (image) {
        images.set(item.id, image);
      }
    }
    return images;
  }

  /**
   * Every approved photo of an item as clients get them (the card of an
   * item, M-CAT-07; TASK-020): in their order, the primary first, in the
   * mode `photo_display_mode` asks for, never the full-size file.
   */
  async clientPhotosOf(executor: DbExecutor, item: CatalogItemRow): Promise<ItemPhotoImage[]> {
    const approved = (await this.photosOfItem(executor, item.id)).filter(
      (row) => row.status === "approved",
    );
    if (approved.length === 0) {
      return [];
    }
    const [{ mode, ttlSeconds }, loaded] = await Promise.all([
      this.delivery(),
      this.loadPhotos(
        executor,
        approved.map((row) => row.id),
      ),
    ]);
    const ordered = [
      ...approved.filter((row) => row.id === item.primaryPhotoId),
      ...approved.filter((row) => row.id !== item.primaryPhotoId),
    ];
    const images: ItemPhotoImage[] = [];
    for (const row of ordered) {
      const entry = loaded.get(row.id);
      const image = entry ? await this.imageOf(entry, mode, ttlSeconds) : null;
      if (image) {
        images.push(image);
      }
    }
    return images;
  }

  /** Every photo of an item for the admin card, approved ones in their order first. */
  async adminPhotosFor(executor: DbExecutor, itemId: string): Promise<AdminItemPhoto[]> {
    const rows = await this.photosOfItem(executor, itemId);
    const [item] = await executor
      .select({ primaryPhotoId: catalogItem.primaryPhotoId })
      .from(catalogItem)
      .where(eq(catalogItem.id, itemId));
    return this.describePhotos(rows, item?.primaryPhotoId ?? null);
  }

  // -------------------------------------------------------------- changes

  /**
   * Stores an uploaded picture as a candidate. The declared type was
   * already checked by the route; here the bytes themselves decide. A
   * picture the item already has comes back as it is — nothing is stored
   * twice (`created: false`).
   */
  async upload(
    itemId: string,
    body: Buffer,
    query: UploadItemPhotoQuery,
    actor: CatalogActor,
  ): Promise<{ response: AdminItemPhotosResponse; created: boolean }> {
    if (FOUND_ONLINE.has(query.sourceType) && !query.sourceUrl) {
      throw photoInvalid("source_url_required");
    }
    const maxBytes = (await this.settings.values()).photo_max_size_mb * 1024 * 1024;
    if (body.byteLength > maxBytes) {
      throw photoTooLarge(maxBytes);
    }

    const executor = this.database.db;
    const item = await this.findItem(executor, itemId);

    let prepared;
    try {
      prepared = await prepareImage(body);
    } catch (error) {
      if (error instanceof PhotoRejected) {
        throw photoInvalid(error.reason, error.detected);
      }
      throw error;
    }

    // The same picture already on this item: nothing is uploaded and
    // nothing is written (TASK-013 requirement 1).
    const existing = await this.findByChecksum(executor, itemId, prepared.checksum);
    if (existing) {
      return { response: await this.describe(executor, item), created: false };
    }
    if (
      (await this.photosOfItem(executor, itemId)).filter((row) => !row.removedAt).length >=
      ITEM_PHOTOS_MAX
    ) {
      throw photoInvalid("too_many_photos");
    }

    // The id is decided here so the objects carry it: the files are put in
    // place first and the row is written afterwards, so a row never points
    // at a file that isn't there. Files of an upload that failed halfway
    // have no row and the cleanup job removes them.
    const photoId = randomUUID();
    const stored = prepared.variants.map((variant) => ({
      ...variant,
      key: photoObjectKey(itemId, photoId, variant.variant, variant.contentType),
    }));
    for (const variant of stored) {
      await this.storage.put(variant.key, variant.bytes, variant.contentType);
    }

    try {
      await executor.transaction(async (tx) => {
        await tx.insert(itemPhoto).values({
          id: photoId,
          itemId,
          sourceType: query.sourceType,
          sourceUrl: query.sourceUrl ?? null,
          status: "proposed",
          proposedBy: "admin",
          contentType: prepared.contentType,
          byteSize: prepared.byteSize,
          width: prepared.width,
          height: prepared.height,
          checksum: prepared.checksum,
          uploadedBy: accountOf(actor),
        });
        await tx.insert(itemPhotoFile).values(
          stored.map((variant) => ({
            photoId,
            variant: variant.variant,
            storageKey: variant.key,
            contentType: variant.contentType,
            byteSize: variant.bytes.byteLength,
            width: variant.width,
            height: variant.height,
          })),
        );
        await this.audit.record(
          {
            action: auditActions.catalogItemPhotoUploaded,
            actor,
            entityType: auditEntities.catalogItemPhoto,
            entityId: photoId,
            after: {
              itemId,
              sourceType: query.sourceType,
              sourceUrl: query.sourceUrl ?? null,
              status: "proposed",
              contentType: prepared.contentType,
              byteSize: prepared.byteSize,
              width: prepared.width,
              height: prepared.height,
              checksum: prepared.checksum,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (uniqueViolation(error, "item_photo_item_checksum_key")) {
        // Two uploads of the same picture at the same moment: the other
        // one won, its files are the ones that stay.
        await this.storage.remove(stored.map((variant) => variant.key)).catch(() => undefined);
        return { response: await this.describe(executor, item), created: false };
      }
      throw error;
    }
    return { response: await this.describe(executor, item), created: true };
  }

  /**
   * Approves, refuses or removes a photo. Refusing or removing the primary
   * photo hands the role to the next approved one, or leaves the item
   * without a picture (TASK-013 requirement 3).
   */
  async setStatus(
    itemId: string,
    photoId: string,
    body: SetItemPhotoStatusBody,
    actor: CatalogActor,
  ): Promise<AdminItemPhotosResponse> {
    const item = await this.database.db.transaction(async (tx) => {
      const locked = await this.lockItem(tx, itemId);
      const [row] = await tx
        .select()
        .from(itemPhoto)
        .where(and(eq(itemPhoto.id, photoId), eq(itemPhoto.itemId, itemId)));
      if (!row) {
        throw notFound("photo");
      }
      if (row.version !== body.expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.filesDeletedAt && body.status !== row.status) {
        throw filesDeleted();
      }
      const becomesRemoved = REMOVED.includes(body.status);
      const wasRemoved = row.removedAt !== null;
      await tx
        .update(itemPhoto)
        .set({
          status: body.status,
          rejectionReason: body.status === "rejected" ? (body.reason ?? null) : null,
          reviewedBy: accountOf(actor),
          reviewedAt: new Date(),
          removedAt: becomesRemoved ? (wasRemoved ? row.removedAt : new Date()) : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(itemPhoto.id, photoId));

      const primaryBefore = locked.primaryPhotoId;
      const primaryAfter = await this.resequence(tx, itemId, primaryBefore);
      await this.audit.record(
        {
          action: auditActions.catalogItemPhotoStatusChanged,
          actor,
          entityType: auditEntities.catalogItemPhoto,
          entityId: photoId,
          before: { itemId, status: row.status, primaryPhotoId: primaryBefore },
          after: {
            itemId,
            status: body.status,
            rejectionReason: body.status === "rejected" ? (body.reason ?? null) : null,
            primaryPhotoId: primaryAfter,
          },
          reason: body.reason ?? null,
        },
        tx,
      );
      return this.findItem(tx, itemId);
    });
    return this.describe(this.database.db, item);
  }

  /**
   * Puts the approved photos of an item in order; the first one becomes
   * the photo lists show.
   */
  async reorder(
    itemId: string,
    body: ReorderItemPhotosBody,
    actor: CatalogActor,
  ): Promise<AdminItemPhotosResponse> {
    const item = await this.database.db.transaction(async (tx) => {
      const locked = await this.lockItem(tx, itemId);
      const rows = await this.photosOfItem(tx, itemId);
      const approved = rows.filter((row) => row.status === "approved");
      const asked = new Set(body.photoIds);
      if (asked.size !== body.photoIds.length) {
        throw orderMismatch();
      }
      if (body.photoIds.some((id) => !rows.some((row) => row.id === id))) {
        throw notFound("photo");
      }
      if (body.photoIds.some((id) => !approved.some((row) => row.id === id))) {
        throw notApproved();
      }
      if (asked.size !== approved.length) {
        throw orderMismatch();
      }
      const before = [...approved]
        .sort((a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => row.id);
      await this.writeOrder(tx, body.photoIds);
      await tx
        .update(catalogItem)
        .set({ primaryPhotoId: body.photoIds[0] ?? null })
        .where(eq(catalogItem.id, itemId));
      await this.audit.record(
        {
          action: auditActions.catalogItemPhotosReordered,
          actor,
          entityType: auditEntities.catalogItem,
          entityId: itemId,
          before: { photoIds: before, primaryPhotoId: locked.primaryPhotoId },
          after: { photoIds: body.photoIds, primaryPhotoId: body.photoIds[0] ?? null },
        },
        tx,
      );
      return this.findItem(tx, itemId);
    });
    return this.describe(this.database.db, item);
  }

  // ---------------------------------------------------------------- inner

  /** The item, locked for this transaction: order and the primary photo change under it. */
  private async lockItem(tx: DbExecutor, itemId: string): Promise<CatalogItemRow> {
    const [row] = await tx
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.id, itemId))
      .for("update");
    if (!row) {
      throw notFound("item");
    }
    return row;
  }

  private async findItem(executor: DbExecutor, itemId: string): Promise<CatalogItemRow> {
    const [row] = await executor.select().from(catalogItem).where(eq(catalogItem.id, itemId));
    if (!row) {
      throw notFound("item");
    }
    return row;
  }

  private photosOfItem(executor: DbExecutor, itemId: string): Promise<ItemPhotoRow[]> {
    return executor
      .select()
      .from(itemPhoto)
      .where(eq(itemPhoto.itemId, itemId))
      .orderBy(asc(itemPhoto.sort), asc(itemPhoto.createdAt));
  }

  private async findByChecksum(
    executor: DbExecutor,
    itemId: string,
    checksum: string,
  ): Promise<ItemPhotoRow | undefined> {
    const [row] = await executor
      .select()
      .from(itemPhoto)
      .where(
        and(
          eq(itemPhoto.itemId, itemId),
          eq(itemPhoto.checksum, checksum),
          isNull(itemPhoto.removedAt),
        ),
      );
    return row;
  }

  /**
   * Puts the approved photos of the item in a gapless order and makes sure
   * the primary photo is one of them: the one it was, if it still is
   * approved, otherwise the first one — or none at all.
   */
  private async resequence(
    tx: DbExecutor,
    itemId: string,
    primaryBefore: string | null,
  ): Promise<string | null> {
    const rows = await this.photosOfItem(tx, itemId);
    const approved = rows.filter((row) => row.status === "approved");
    const kept = approved.some((row) => row.id === primaryBefore) ? primaryBefore : null;
    const order = [
      ...(kept ? [kept] : []),
      ...approved.filter((row) => row.id !== kept).map((row) => row.id),
    ];
    await this.writeOrder(tx, order);
    // A photo that is no longer approved leaves the order.
    const removedIds = rows.filter((row) => row.status !== "approved").map((row) => row.id);
    if (removedIds.length > 0) {
      await tx.update(itemPhoto).set({ sort: 0 }).where(inArray(itemPhoto.id, removedIds));
    }
    const primaryAfter = order[0] ?? null;
    if (primaryAfter !== primaryBefore) {
      await tx
        .update(catalogItem)
        .set({ primaryPhotoId: primaryAfter })
        .where(eq(catalogItem.id, itemId));
    }
    return primaryAfter;
  }

  private async writeOrder(tx: DbExecutor, photoIds: readonly string[]): Promise<void> {
    for (const [index, id] of photoIds.entries()) {
      await tx.update(itemPhoto).set({ sort: index }).where(eq(itemPhoto.id, id));
    }
  }

  private async loadPhotos(
    executor: DbExecutor,
    photoIds: readonly string[],
  ): Promise<Map<string, PhotoWithFiles>> {
    const loaded = new Map<string, PhotoWithFiles>();
    if (photoIds.length === 0) {
      return loaded;
    }
    const [photos, files] = await Promise.all([
      executor
        .select()
        .from(itemPhoto)
        .where(inArray(itemPhoto.id, [...photoIds])),
      executor
        .select()
        .from(itemPhotoFile)
        .where(inArray(itemPhotoFile.photoId, [...photoIds])),
    ]);
    for (const photo of photos) {
      loaded.set(photo.id, { photo, files: new Map() });
    }
    for (const file of files) {
      loaded.get(file.photoId)?.files.set(file.variant, file);
    }
    return loaded;
  }

  /** `photo_display_mode` and the life of a signed link, as set now. */
  private async delivery(): Promise<{ mode: PhotoDisplayMode; ttlSeconds: number }> {
    const values = await this.settings.values();
    return {
      mode: values.photo_display_mode,
      ttlSeconds: values.photo_link_ttl_minutes * 60,
    };
  }

  /**
   * The photo as a client gets it. In `copy` mode both links are ours and
   * expire; in `link` mode the client is sent to the source instead — and
   * a photo that has no source address is still served as our copy, there
   * being nothing else to point at.
   */
  private async imageOf(
    entry: PhotoWithFiles,
    mode: PhotoDisplayMode,
    ttlSeconds: number,
  ): Promise<ItemPhotoImage | null> {
    const { photo, files } = entry;
    if (mode === "link" && photo.sourceUrl) {
      return {
        photoId: photo.id,
        mode: "link",
        url: photo.sourceUrl,
        thumbUrl: photo.sourceUrl,
        width: null,
        height: null,
        expiresAt: null,
        sourceType: photo.sourceType,
        sourceUrl: photo.sourceUrl,
      };
    }
    const card = files.get("card");
    const thumb = files.get("thumb");
    if (!card || !thumb) {
      return null;
    }
    const [url, thumbUrl] = await Promise.all([
      this.storage.signedUrl(card.storageKey, ttlSeconds),
      this.storage.signedUrl(thumb.storageKey, ttlSeconds),
    ]);
    return {
      photoId: photo.id,
      mode: "copy",
      url,
      thumbUrl,
      width: card.width,
      height: card.height,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      sourceType: photo.sourceType,
      sourceUrl: photo.sourceUrl,
    };
  }

  private async describePhotos(
    rows: readonly ItemPhotoRow[],
    primaryPhotoId: string | null,
  ): Promise<AdminItemPhoto[]> {
    if (rows.length === 0) {
      return [];
    }
    const { ttlSeconds } = await this.delivery();
    const loaded = await this.loadPhotos(
      this.database.db,
      rows.map((row) => row.id),
    );
    const described: AdminItemPhoto[] = [];
    for (const row of rows) {
      const entry = loaded.get(row.id) ?? {
        photo: row,
        files: new Map<string, ItemPhotoFileRow>(),
      };
      const original = entry.files.get("original");
      described.push({
        id: row.id,
        itemId: row.itemId,
        status: row.status,
        sourceType: row.sourceType,
        sourceUrl: row.sourceUrl,
        proposedBy: row.proposedBy,
        aiScore: row.aiScore === null ? null : Number(row.aiScore),
        rejectionReason: row.rejectionReason,
        contentType: row.contentType,
        byteSize: row.byteSize,
        width: row.width,
        height: row.height,
        checksum: row.checksum,
        isPrimary: row.id === primaryPhotoId,
        sort: row.sort,
        uploadedAt: row.createdAt.toISOString(),
        reviewedAt: iso(row.reviewedAt),
        removedAt: iso(row.removedAt),
        filesDeletedAt: iso(row.filesDeletedAt),
        version: row.version,
        // The administrator moderates the file we stored, whatever
        // `photo_display_mode` says clients should see.
        image: await this.imageOf(entry, "copy", ttlSeconds),
        originalUrl: original
          ? await this.storage.signedUrl(original.storageKey, ttlSeconds)
          : null,
      });
    }
    // Approved photos first, in their order; then what waits and what was
    // refused, newest first.
    return described.sort((a, b) => rank(a) - rank(b) || compare(a, b));
  }

  private async describe(
    executor: DbExecutor,
    item: CatalogItemRow,
  ): Promise<AdminItemPhotosResponse> {
    const [rows, texts, images, { mode }] = await Promise.all([
      this.photosOfItem(executor, item.id),
      loadTexts(executor, "catalog_item", [item.id]),
      this.imagesFor(executor, [item]),
      this.delivery(),
    ]);
    return {
      itemId: item.id,
      names: describeTexts(textsOf(texts, item.id, "name")),
      photos: await this.describePhotos(rows, item.primaryPhotoId),
      photo: images.get(item.id) ?? null,
      displayMode: mode,
    };
  }
}

/** Approved photos first, then candidates, then what was refused or removed. */
function rank(photo: AdminItemPhoto): number {
  if (photo.status === "approved") {
    return 0;
  }
  return photo.status === "proposed" ? 1 : 2;
}

function compare(a: AdminItemPhoto, b: AdminItemPhoto): number {
  return a.status === "approved"
    ? a.sort - b.sort
    : b.uploadedAt.localeCompare(a.uploadedAt) || a.id.localeCompare(b.id);
}
