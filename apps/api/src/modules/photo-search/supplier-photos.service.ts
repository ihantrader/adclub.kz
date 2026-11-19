import { Inject, Injectable } from "@nestjs/common";
import type {
  CatalogLanguage,
  SupplierModerationPhotoPage,
  SupplierModerationPhotoQuery,
  SupplierOfferPhotos,
} from "@adclub/contracts";
import { and, count, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import {
  CatalogPhotosService,
  decodeCursor,
  encodeCursor,
  itemPhoto,
  TIME_POSITION,
} from "../catalog";
import { describeOfferItems } from "../offers";

export interface SupplierPhotoActor {
  supplierId: string;
  memberId: string;
  accountId: string;
}

/**
 * The position of a photo in «Модерация → Фото»: its upload time to the
 * microsecond (TASK-068.A) — a JS date keeps milliseconds only, and two
 * photos of one millisecond would lose one of them between pages.
 */
const createdPosition = sql<string>`to_char(${itemPhoto.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The cursor of the previous page, or a refusal that says to use it. */
function afterOf(cursor: string): { position: string; id: string } {
  const after = decodeCursor(cursor);
  if (!TIME_POSITION.test(after.position)) {
    throw new ApiException(400, "VALIDATION_ERROR", "Use the nextCursor of the previous page", {
      details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
    });
  }
  return after;
}

/**
 * Photos of suppliers in the cabinet (TASK-068; SCREENS S-OFF-03, S-OFF-05,
 * S-MOD-01): the block of the offer card and «Модерация → Фото». Only the
 * session's company: another company's offer is 404, its photos are never
 * listed. Uploads themselves are `CatalogPhotosService.uploadFromSupplier`.
 */
@Injectable()
export class SupplierPhotosService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  /** S-OFF-03: does the item of the offer still need a photo, and what the company sent. */
  async ofOffer(actor: SupplierPhotoActor, offerId: string): Promise<SupplierOfferPhotos> {
    const db = this.database.db;
    const found = await db.execute<{
      item_id: string;
      item_type: string;
      status: string;
      primary_photo_id: string | null;
    }>(sql`
      SELECT i.id AS item_id, i.item_type, i.status, i.primary_photo_id
      FROM offer o JOIN catalog_item i ON i.id = o.item_id
      WHERE o.id = ${offerId} AND o.supplier_id = ${actor.supplierId}`);
    const item = found.rows[0];
    if (!item) throw new ApiException(404, "NOT_FOUND", "No such offer");
    const rows = await db
      .select()
      .from(itemPhoto)
      .where(and(eq(itemPhoto.itemId, item.item_id), eq(itemPhoto.supplierId, actor.supplierId)))
      .orderBy(desc(itemPhoto.createdAt), desc(itemPhoto.id));
    return {
      needed:
        item.item_type !== "service" && item.status === "active" && item.primary_photo_id === null,
      photos: await this.photos.supplierPhotos(rows),
    };
  }

  /** «Модерация → Фото» (S-MOD-01): the company's photos, newest first, «новое» for this employee. */
  async page(
    actor: SupplierPhotoActor,
    query: SupplierModerationPhotoQuery,
    lang: CatalogLanguage,
  ): Promise<SupplierModerationPhotoPage> {
    const db = this.database.db;
    const after = query.cursor ? afterOf(query.cursor) : null;
    const mine = eq(itemPhoto.supplierId, actor.supplierId);
    const [rows, [total], seen] = await Promise.all([
      db
        .select({ ...getTableColumns(itemPhoto), position: createdPosition })
        .from(itemPhoto)
        .where(
          and(
            mine,
            after
              ? sql`(${itemPhoto.createdAt}, ${itemPhoto.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(itemPhoto.createdAt), desc(itemPhoto.id))
        .limit(query.limit + 1),
      db.select({ value: count() }).from(itemPhoto).where(mine),
      db.execute<{ at: Date | string }>(sql`
        SELECT coalesce(moderation_seen_at, created_at) AS at FROM supplier_member
        WHERE id = ${actor.memberId}`),
    ]);
    const seenAt = new Date(seen.rows[0]?.at ?? 0);
    const page = rows.slice(0, query.limit);
    const requestIds = [
      ...new Set(page.flatMap((row) => (row.catalogRequestId ? [row.catalogRequestId] : []))),
    ];
    const [described, items, requests] = await Promise.all([
      this.photos.supplierPhotos(page),
      describeOfferItems(
        db,
        this.photos,
        page.flatMap((row) => (row.itemId ? [row.itemId] : [])),
        lang,
      ),
      requestIds.length === 0
        ? { rows: [] }
        : db.execute<{ id: string; name: string | null }>(sql`
            SELECT id, payload->>'name' AS name FROM catalog_request
            WHERE id IN (${sql.join(
              requestIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`),
    ]);
    const requestOf = new Map(requests.rows.map((row) => [row.id, row]));
    const last = page.at(-1);
    return {
      entries: page.map((row, index) => ({
        photo: described[index]!,
        item: row.itemId ? (items.get(row.itemId) ?? null) : null,
        request: row.catalogRequestId
          ? {
              id: row.catalogRequestId,
              name: requestOf.get(row.catalogRequestId)?.name ?? null,
            }
          : null,
        isNew: row.status !== "proposed" && row.reviewedAt !== null && row.reviewedAt > seenAt,
      })),
      total: total?.value ?? 0,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }
}
