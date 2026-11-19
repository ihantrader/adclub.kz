import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  CATALOG_REQUEST_PHOTOS_MAX,
  ITEM_PHOTOS_MAX,
  type AdminItemPhoto,
  type AdminItemPhotosResponse,
  type CatalogPhotoInvalidDetails,
  type CatalogRequestPhoto,
  type ItemPhotoImage,
  type ItemPhotoSearchState,
  type ItemPhotoSourceType,
  type ItemPhotoStatus,
  type PhotoDisplayMode,
  type ReorderItemPhotosBody,
  type SetItemPhotoStatusBody,
  type SupplierItemPhoto,
  type UploadItemPhotoQuery,
} from "@adclub/contracts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiException, rateLimitedException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import { AppSettings } from "../settings";
import type { CatalogActor } from "./catalog-admin.service";
import { notFound, orderMismatch, versionConflict } from "./catalog-errors";
import { uniqueViolation } from "./catalog-paging";
import { describeTexts, loadTexts, textsOf } from "./catalog-texts";
import { PhotoRejected, prepareImage, type PreparedImage } from "./photo-image";
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

/** A supplier's photo isn't taken here (TASK-068): the item has one, or the request is decided. */
function photoNotNeeded(message: string): ApiException {
  return new ApiException(409, "CATALOG_PHOTO_NOT_NEEDED", message);
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ----------------------------------------------------------------- read

  async list(itemId: string): Promise<AdminItemPhotosResponse> {
    const executor = this.database.db;
    const item = await this.findItem(executor, itemId);
    return this.describe(executor, item);
  }

  /**
   * `imagesFor` by the ids of items (the item of an order, TASK-030.A): the
   * item's primary photo as it is in the catalog now — an order's snapshot
   * keeps no photo, so one removed since gives no picture. Unknown ids are
   * simply absent.
   */
  async imagesForItemIds(
    executor: DbExecutor,
    itemIds: readonly string[],
  ): Promise<Map<string, ItemPhotoImage>> {
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const items = await executor
      .select({ id: catalogItem.id, primaryPhotoId: catalogItem.primaryPhotoId })
      .from(catalogItem)
      .where(inArray(catalogItem.id, ids));
    return this.imagesFor(executor, items);
  }

  /**
   * The picture of each of these items as clients get it: the approved
   * primary photo, in the mode `photo_display_mode` asks for, and never
   * the full-size file. Items with no approved photo are absent from the
   * result — the client shows a placeholder.
   */
  async imagesFor(
    executor: DbExecutor,
    items: readonly Pick<CatalogItemRow, "id" | "primaryPhotoId">[],
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
    await this.assertSize(body);
    const executor = this.database.db;
    const item = await this.findItem(executor, itemId);
    const prepared = await this.prepare(body);
    const { created } = await this.store({ itemId }, prepared, {
      sourceType: query.sourceType,
      sourceUrl: query.sourceUrl ?? null,
      proposedBy: "admin",
      uploadedBy: accountOf(actor),
      audit: { action: auditActions.catalogItemPhotoUploaded, actor },
    });
    return { response: await this.describe(executor, item), created };
  }

  /**
   * A candidate of the image search (TASK-068): a picture already checked
   * by `prepare`, with the page it was found on. Nothing is stored twice;
   * the item's limit of photos holds.
   */
  async addFoundCandidate(
    itemId: string,
    prepared: PreparedImage,
    found: {
      sourceType: "manufacturer" | "official_catalog" | "multi_store";
      sourceUrl: string;
      score: number;
      evidence: Record<string, unknown>;
    },
    actor: AuditActorRecord,
  ): Promise<{ created: boolean; photoId: string | null }> {
    return this.store({ itemId }, prepared, {
      sourceType: found.sourceType,
      sourceUrl: found.sourceUrl,
      proposedBy: "ai",
      aiScore: found.score,
      evidence: found.evidence,
      uploadedBy: actor.role === "admin" ? actor.accountId : null,
      audit: {
        action: auditActions.catalogItemPhotoFound,
        actor,
        extra: { score: found.score },
      },
    });
  }

  /** Checksums of every photo the item has or had: a refused picture isn't proposed again. */
  async knownChecksums(itemId: string): Promise<Set<string>> {
    const rows = await this.database.db
      .select({ checksum: itemPhoto.checksum })
      .from(itemPhoto)
      .where(eq(itemPhoto.itemId, itemId));
    return new Set(rows.map((row) => row.checksum));
  }

  /** Photos the item holds now (approved and waiting): the limit `ITEM_PHOTOS_MAX`. */
  async activeCount(itemId: string): Promise<number> {
    const rows = await this.photosOfItem(this.database.db, itemId);
    return rows.filter((row) => !row.removedAt).length;
  }

  /**
   * A supplier's photo (TASK-068; S-OFF-03, S-OFF-05): of the item of the
   * company's offer that has no approved photo, or of the company's request
   * to add an item while it waits. Another company's offer or request — 404,
   * as if there were none. `supplier_photos_per_supplier_day` for the whole
   * company. The picture is checked and stored like the administrator's,
   * without its metadata (camera, coordinates).
   */
  async uploadFromSupplier(
    target: { offerId: string } | { requestId: string },
    body: Buffer,
    actor: { supplierId: string; memberId: string; accountId: string },
  ): Promise<{ photo: SupplierItemPhoto; created: boolean }> {
    await this.assertSize(body);
    const executor = this.database.db;
    let owner: { itemId: string } | { requestId: string };
    if ("offerId" in target) {
      const found = await executor.execute<{
        item_id: string;
        item_type: string;
        status: string;
        primary_photo_id: string | null;
      }>(sql`
        SELECT i.id AS item_id, i.item_type, i.status, i.primary_photo_id
        FROM offer o JOIN catalog_item i ON i.id = o.item_id
        WHERE o.id = ${target.offerId} AND o.supplier_id = ${actor.supplierId}`);
      const row = found.rows[0];
      if (!row) throw notFound("offer");
      if (row.item_type === "service" || row.status !== "active" || row.primary_photo_id) {
        throw photoNotNeeded("The item already has a photo, or is a service");
      }
      owner = { itemId: row.item_id };
    } else {
      const found = await executor.execute<{ status: string }>(sql`
        SELECT status FROM catalog_request
        WHERE id = ${target.requestId} AND supplier_id = ${actor.supplierId}`);
      const row = found.rows[0];
      if (!row) throw notFound("request");
      if (row.status !== "new") {
        throw photoNotNeeded("The request has been decided already");
      }
      owner = { requestId: target.requestId };
    }
    const limit = await this.settings.get("supplier_photos_per_supplier_day");
    await this.assertSupplierDay(executor, actor.supplierId, limit);
    const prepared = await this.prepare(body);
    const { photoId } = await this.store(owner, prepared, {
      sourceType: "supplier_photo",
      sourceUrl: null,
      proposedBy: "supplier",
      uploadedBy: actor.accountId,
      supplier: { supplierId: actor.supplierId, memberId: actor.memberId, dayLimit: limit },
      audit: {
        action: auditActions.catalogItemPhotoUploaded,
        actor: { role: "supplier", ...actor },
      },
    });
    const [row] = photoId
      ? await executor.select().from(itemPhoto).where(eq(itemPhoto.id, photoId))
      : [];
    const existing =
      row ??
      ("itemId" in owner
        ? await this.findByChecksum(executor, owner.itemId, prepared.checksum)
        : await this.findRequestPhotoByChecksum(executor, owner.requestId, prepared.checksum));
    if (!existing) throw notFound("photo");
    const [photo] = await this.supplierPhotos([existing]);
    return { photo: photo!, created: row !== undefined && photoId !== null };
  }

  /** Photos as a supplier's cabinet sees them: status, reason, a signed thumbnail. */
  async supplierPhotos(rows: readonly ItemPhotoRow[]): Promise<SupplierItemPhoto[]> {
    if (rows.length === 0) return [];
    const { ttlSeconds } = await this.delivery();
    const loaded = await this.loadPhotos(
      this.database.db,
      rows.map((row) => row.id),
    );
    const described: SupplierItemPhoto[] = [];
    for (const row of rows) {
      const thumb = loaded.get(row.id)?.files.get("thumb");
      described.push({
        id: row.id,
        status: row.status,
        rejectionReason: row.rejectionReason,
        thumbUrl:
          thumb && !row.filesDeletedAt
            ? await this.storage.signedUrl(thumb.storageKey, ttlSeconds)
            : null,
        uploadedAt: row.createdAt.toISOString(),
        reviewedAt: iso(row.reviewedAt),
      });
    }
    return described;
  }

  /** The photos sent with requests to add an item, oldest first, by request. */
  async requestPhotos(
    executor: DbExecutor,
    requestIds: readonly string[],
  ): Promise<Map<string, ItemPhotoRow[]>> {
    const byRequest = new Map<string, ItemPhotoRow[]>();
    if (requestIds.length === 0) return byRequest;
    const rows = await executor
      .select()
      .from(itemPhoto)
      .where(inArray(itemPhoto.catalogRequestId, [...new Set(requestIds)]))
      .orderBy(asc(itemPhoto.createdAt), asc(itemPhoto.id));
    for (const row of rows) {
      const list = byRequest.get(row.catalogRequestId!) ?? [];
      list.push(row);
      byRequest.set(row.catalogRequestId!, list);
    }
    return byRequest;
  }

  /** Photos of requests for the administrator (A-MOD-01): with the full-size link. */
  async requestPhotosForAdmin(rows: readonly ItemPhotoRow[]): Promise<CatalogRequestPhoto[]> {
    const described = await this.supplierPhotos(rows);
    const { ttlSeconds } = await this.delivery();
    const loaded = await this.loadPhotos(
      this.database.db,
      rows.map((row) => row.id),
    );
    return Promise.all(
      described.map(async (photo, index) => {
        const original = loaded.get(rows[index]!.id)?.files.get("original");
        return {
          ...photo,
          originalUrl:
            original && !rows[index]!.filesDeletedAt
              ? await this.storage.signedUrl(original.storageKey, ttlSeconds)
              : null,
        };
      }),
    );
  }

  /**
   * The item of a request was made (or found): the photos of the request
   * become its candidates in this very transaction (TASK-068). A picture the
   * item already holds is not moved twice — it is taken out of the request.
   */
  async adoptRequestPhotos(
    tx: DbExecutor,
    requestId: string,
    itemId: string,
    actor: AuditActorRecord,
  ): Promise<number> {
    const rows = await tx
      .select()
      .from(itemPhoto)
      .where(
        and(
          eq(itemPhoto.catalogRequestId, requestId),
          isNull(itemPhoto.itemId),
          isNull(itemPhoto.removedAt),
        ),
      )
      .for("update");
    let moved = 0;
    for (const row of rows) {
      const already = await this.findByChecksum(tx, itemId, row.checksum);
      if (already) {
        await tx
          .update(itemPhoto)
          .set({
            status: "deleted",
            removedAt: new Date(),
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(itemPhoto.id, row.id));
        continue;
      }
      await tx
        .update(itemPhoto)
        .set({ itemId, version: row.version + 1, updatedAt: new Date() })
        .where(eq(itemPhoto.id, row.id));
      await this.audit.record(
        {
          action: auditActions.catalogItemPhotoFromRequest,
          actor,
          entityType: auditEntities.catalogItemPhoto,
          entityId: row.id,
          after: { itemId, catalogRequestId: requestId, status: row.status },
        },
        tx,
      );
      moved += 1;
    }
    return moved;
  }

  /** The request was refused: its photos go with it, with the same reason. */
  async dropRequestPhotos(tx: DbExecutor, requestId: string, reason: string): Promise<void> {
    await tx
      .update(itemPhoto)
      .set({
        status: "rejected",
        rejectionReason: reason,
        removedAt: new Date(),
        reviewedAt: new Date(),
        version: sql`${itemPhoto.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(itemPhoto.catalogRequestId, requestId),
          isNull(itemPhoto.itemId),
          isNull(itemPhoto.removedAt),
        ),
      );
  }

  /** The state of the image search for the item card (TASK-068). */
  photoSearchState(item: CatalogItemRow): ItemPhotoSearchState {
    return {
      enabled: this.config.imageSearch.provider !== "disabled",
      applicable: item.status === "active" && item.itemType !== "service",
      lastSearchedAt: iso(item.photoSearchAt),
      searches: item.photoSearchCount,
    };
  }

  // ------------------------------------------------------------ storing

  /** The size limit of a photo, before anything else is done with the body. */
  private async assertSize(body: Buffer): Promise<void> {
    const maxBytes = (await this.settings.values()).photo_max_size_mb * 1024 * 1024;
    if (body.byteLength > maxBytes) {
      throw photoTooLarge(maxBytes);
    }
  }

  /** The bytes decide what the file is; a refusal says why (`CATALOG_PHOTO_INVALID`). */
  private async prepare(body: Buffer): Promise<PreparedImage> {
    try {
      return await prepareImage(body);
    } catch (error) {
      if (error instanceof PhotoRejected) {
        throw photoInvalid(error.reason, error.detected);
      }
      throw error;
    }
  }

  /** Photos of the company in the last 24 hours against its limit (a refusal with the wait). */
  private async assertSupplierDay(
    executor: DbExecutor,
    supplierId: string,
    limit: number,
  ): Promise<void> {
    const day = await executor.execute<{ sent: number; wait: number | null }>(sql`
      SELECT count(*)::int AS sent,
        extract(epoch FROM min(created_at) + interval '1 day' - now())::float AS wait
      FROM item_photo
      WHERE supplier_id = ${supplierId} AND created_at > now() - interval '1 day'`);
    const counted = day.rows[0];
    if (counted && counted.sent >= limit) {
      throw rateLimitedException(
        "supplier_photos_per_supplier",
        Math.max(1, Math.ceil(Number(counted.wait ?? 86_400))),
      );
    }
  }

  /**
   * Stores a checked picture of an item or of a request as a candidate: the
   * files first, then the row and its journal entry in one transaction — a
   * row never points at a file that isn't there, and files of an upload that
   * broke off have no row (the cleanup job removes them). The same picture
   * already there — nothing is written (`photoId: null`).
   */
  private async store(
    owner: { itemId: string } | { requestId: string },
    prepared: PreparedImage,
    meta: {
      sourceType: ItemPhotoSourceType;
      sourceUrl: string | null;
      proposedBy: "admin" | "supplier" | "ai";
      uploadedBy: string | null;
      aiScore?: number;
      evidence?: Record<string, unknown>;
      supplier?: { supplierId: string; memberId: string; dayLimit: number };
      audit: { action: string; actor: AuditActorRecord; extra?: Record<string, unknown> };
    },
  ): Promise<{ created: boolean; photoId: string | null }> {
    const executor = this.database.db;
    const itemId = "itemId" in owner ? owner.itemId : null;
    const requestId = "requestId" in owner ? owner.requestId : null;
    // The same picture already there: nothing is uploaded and nothing is
    // written (TASK-013 requirement 1).
    const existing = itemId
      ? await this.findByChecksum(executor, itemId, prepared.checksum)
      : await this.findRequestPhotoByChecksum(executor, requestId!, prepared.checksum);
    if (existing) {
      return { created: false, photoId: null };
    }
    const held = await executor
      .select({ id: itemPhoto.id })
      .from(itemPhoto)
      .where(
        and(
          itemId ? eq(itemPhoto.itemId, itemId) : eq(itemPhoto.catalogRequestId, requestId!),
          itemId ? undefined : isNull(itemPhoto.itemId),
          isNull(itemPhoto.removedAt),
        ),
      );
    if (held.length >= (itemId ? ITEM_PHOTOS_MAX : CATALOG_REQUEST_PHOTOS_MAX)) {
      throw photoInvalid("too_many_photos");
    }

    // The id is decided here so the objects carry it.
    const photoId = randomUUID();
    const folder = itemId ?? `requests/${requestId!}`;
    const stored = prepared.variants.map((variant) => ({
      ...variant,
      key: photoObjectKey(folder, photoId, variant.variant, variant.contentType),
    }));
    for (const variant of stored) {
      await this.storage.put(variant.key, variant.bytes, variant.contentType);
    }

    try {
      await executor.transaction(async (tx) => {
        if (meta.supplier) {
          // One company at a time: the count of the day holds under its lock.
          await tx.execute(
            sql`SELECT id FROM supplier WHERE id = ${meta.supplier.supplierId} FOR UPDATE`,
          );
          await this.assertSupplierDay(tx, meta.supplier.supplierId, meta.supplier.dayLimit);
        }
        await tx.insert(itemPhoto).values({
          id: photoId,
          itemId,
          catalogRequestId: requestId,
          supplierId: meta.supplier?.supplierId ?? null,
          supplierMemberId: meta.supplier?.memberId ?? null,
          sourceType: meta.sourceType,
          sourceUrl: meta.sourceUrl,
          sourceEvidence: meta.evidence ?? null,
          status: "proposed",
          proposedBy: meta.proposedBy,
          aiScore: meta.aiScore === undefined ? null : String(meta.aiScore),
          contentType: prepared.contentType,
          byteSize: prepared.byteSize,
          width: prepared.width,
          height: prepared.height,
          checksum: prepared.checksum,
          uploadedBy: meta.uploadedBy,
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
            action: meta.audit.action,
            actor: meta.audit.actor,
            entityType: auditEntities.catalogItemPhoto,
            entityId: photoId,
            after: {
              itemId,
              ...(requestId ? { catalogRequestId: requestId } : {}),
              sourceType: meta.sourceType,
              sourceUrl: meta.sourceUrl,
              status: "proposed",
              contentType: prepared.contentType,
              byteSize: prepared.byteSize,
              width: prepared.width,
              height: prepared.height,
              checksum: prepared.checksum,
              ...meta.audit.extra,
            },
          },
          tx,
        );
      });
    } catch (error) {
      // Refused after the files were stored: they go, nothing points at them.
      await this.storage.remove(stored.map((variant) => variant.key)).catch(() => undefined);
      if (
        uniqueViolation(error, "item_photo_item_checksum_key") ||
        uniqueViolation(error, "item_photo_request_checksum_key")
      ) {
        // Two uploads of the same picture at the same moment: the other one won.
        return { created: false, photoId: null };
      }
      throw error;
    }
    return { created: true, photoId };
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

  private async findRequestPhotoByChecksum(
    executor: DbExecutor,
    requestId: string,
    checksum: string,
  ): Promise<ItemPhotoRow | undefined> {
    const [row] = await executor
      .select()
      .from(itemPhoto)
      .where(
        and(
          eq(itemPhoto.catalogRequestId, requestId),
          isNull(itemPhoto.itemId),
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
    const supplierIds = [
      ...new Set(rows.flatMap((row) => (row.supplierId ? [row.supplierId] : []))),
    ];
    const suppliers = new Map<string, string>();
    if (supplierIds.length > 0) {
      const found = await this.database.db.execute<{ id: string; name: string }>(
        sql`SELECT id, name FROM supplier WHERE ${inArray(sql`id`, supplierIds)}`,
      );
      for (const supplier of found.rows) suppliers.set(supplier.id, supplier.name);
    }
    const described: AdminItemPhoto[] = [];
    for (const row of rows) {
      const entry = loaded.get(row.id) ?? {
        photo: row,
        files: new Map<string, ItemPhotoFileRow>(),
      };
      const original = entry.files.get("original");
      described.push({
        id: row.id,
        // Admin lists are of an item's photos: a photo of a request has none yet.
        itemId: row.itemId!,
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
        supplier: row.supplierId
          ? { id: row.supplierId, name: suppliers.get(row.supplierId) ?? "—" }
          : null,
        catalogRequestId: row.catalogRequestId,
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
      photoSearch: this.photoSearchState(item),
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
