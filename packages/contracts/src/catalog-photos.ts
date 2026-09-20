import { z } from "zod";
import { catalogTextsSchema } from "./catalog";

/**
 * Photos of catalog items (PRODUCT 7.6, 9.7; ARCHITECTURE 5.2, 4.22;
 * TASK-013; SCREENS A-CAT-05 tab "Фото", M-CAT-02, M-CAT-07).
 *
 * A photo belongs to an item, not to a supplier: one picture serves every
 * supplier of that item. Its source is always known, and only a photo a
 * person approved is shown outside the moderation screens. Generated
 * pictures of goods are forbidden (PRODUCT 7.6, ARCHITECTURE 9.7) — no
 * source type stands for one. Enum values here are only ever added
 * (ARCHITECTURE 7.4).
 */

/**
 * Where the picture came from (PRODUCT 7.6, priority in that order):
 * - `manufacturer` — the manufacturer's own site;
 * - `official_catalog` — the official catalogue of the make;
 * - `multi_store` — the same picture found in several independent shops;
 * - `supplier_photo` — a supplier photographed the real part (EPIC-06);
 * - `admin_upload` — the administrator uploaded the file.
 *
 * The first three come with the page they were taken from (`sourceUrl`).
 */
export const itemPhotoSourceTypeSchema = z.enum([
  "manufacturer",
  "official_catalog",
  "multi_store",
  "supplier_photo",
  "admin_upload",
]);

export type ItemPhotoSourceType = z.infer<typeof itemPhotoSourceTypeSchema>;

/**
 * `proposed` — waiting for a person (a candidate from AI, EPIC-17, or from
 * a supplier, EPIC-06; a file the administrator uploaded starts here too);
 * `approved` — confirmed, the only status clients ever see; `rejected` —
 * refused with a reason; `deleted` — taken out of the catalog. The files
 * of a `rejected` or `deleted` photo are removed by a background job after
 * a retention period, so a mistake can be undone within it.
 */
export const itemPhotoStatusSchema = z.enum(["proposed", "approved", "rejected", "deleted"]);

export type ItemPhotoStatus = z.infer<typeof itemPhotoStatusSchema>;

/** Who put the photo forward. `ai` and `supplier` arrive with EPIC-17 and EPIC-06. */
export const itemPhotoProposedBySchema = z.enum(["admin", "supplier", "ai"]);

export type ItemPhotoProposedBy = z.infer<typeof itemPhotoProposedBySchema>;

/**
 * `copy` — clients get our stored copy through a signed link; `link` —
 * they get the address of the source instead (the careful setting while
 * the copyright question is open, PRODUCT 9.7). The setting is
 * `photo_display_mode` (ARCHITECTURE 14); a photo without a source address
 * is always served as our copy, there is nothing else to point at.
 */
export const photoDisplayModeSchema = z.enum(["copy", "link"]);

export type PhotoDisplayMode = z.infer<typeof photoDisplayModeSchema>;

/** Sizes an uploaded picture is kept in (ARCHITECTURE 4.22). */
export const itemPhotoVariantSchema = z.enum(["original", "card", "thumb"]);

export type ItemPhotoVariant = z.infer<typeof itemPhotoVariantSchema>;

/** The longest side of the card-size variant, in pixels. */
export const PHOTO_CARD_MAX_PX = 1024;
/** The longest side of the thumbnail shown in lists. */
export const PHOTO_THUMB_MAX_PX = 320;
/**
 * Pictures the server takes. Raster only: a vector file (SVG above all)
 * carries scripts and is never accepted, whatever the name says.
 */
export const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/**
 * The hard ceiling of an uploaded body, whatever `photo_max_size_mb` says
 * (that setting can only be lower): what the server is willing to read
 * before looking at the setting.
 */
export const PHOTO_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/**
 * A picture larger than this in pixels is refused before it is decoded:
 * a small file can unpack into gigabytes ("decompression bomb").
 */
export const PHOTO_MAX_PIXELS = 50_000_000;
/** The longest source address stored with a photo. */
export const PHOTO_SOURCE_URL_MAX_LENGTH = 2000;
/** The longest reason of a refusal. */
export const PHOTO_REJECTION_REASON_MAX_LENGTH = 500;
/** Photos one item can hold (approved and waiting together). */
export const ITEM_PHOTOS_MAX = 20;

const expectedVersionSchema = z.number().int().min(1);

/**
 * An `http(s)` address. Other schemes (`javascript:`, `data:`, `file:`)
 * are refused: the address is shown to the administrator as a link.
 */
const sourceUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(PHOTO_SOURCE_URL_MAX_LENGTH)
  .refine((value) => !/[\p{Cc}\s]/u.test(value), {
    message: "Must not contain spaces or control characters",
  });

/**
 * A photo as a client shows it (SCREENS M-CAT-02, M-CAT-07). Only
 * approved photos ever appear here. `mode` says where the picture comes
 * from — our storage or the source — and follows `photo_display_mode`.
 *
 * `url` is never the full-size file: a list shows `thumbUrl` and a card
 * shows `url` (ARCHITECTURE 4.22). Signed links expire (`expiresAt`); a
 * client that kept one past that simply asks for the item again.
 */
export const itemPhotoImageSchema = z.object({
  photoId: z.uuid(),
  mode: photoDisplayModeSchema,
  /** `copy`: a signed link to the card-size picture; `link`: the source address. */
  url: z.string(),
  /** `copy`: a signed link to the thumbnail; `link`: the source address. */
  thumbUrl: z.string(),
  /** Pixel size of `url`'s picture; `null` in `link` mode — the source is not ours. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** When the signed links stop working (ISO 8601); `null` in `link` mode. */
  expiresAt: z.iso.datetime().nullable(),
  sourceType: itemPhotoSourceTypeSchema,
  /** The page the picture was taken from; `null` for a file that has none. */
  sourceUrl: z.string().nullable(),
});

export type ItemPhotoImage = z.infer<typeof itemPhotoImageSchema>;

/**
 * A photo in the admin panel (SCREENS A-CAT-05): its source, status and
 * file facts. `image` and `originalUrl` are always our stored copy,
 * whatever `photo_display_mode` — the administrator moderates the file we
 * keep; both are `null` once the files have been removed.
 */
export const adminItemPhotoSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  status: itemPhotoStatusSchema,
  sourceType: itemPhotoSourceTypeSchema,
  sourceUrl: z.string().nullable(),
  proposedBy: itemPhotoProposedBySchema,
  /** How sure the search was, 0…1; `null` for anything but an AI candidate (EPIC-17). */
  aiScore: z.number().nullable(),
  /** Why it was refused; `null` unless the status is `rejected`. */
  rejectionReason: z.string().nullable(),
  contentType: z.string(),
  byteSize: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  /** SHA-256 of the stored picture: the same picture is not uploaded twice to one item. */
  checksum: z.string(),
  /** The photo shown in lists; at most one per item and always approved. */
  isPrimary: z.boolean(),
  /** Position among the item's approved photos (the primary one is first). */
  sort: z.number().int(),
  uploadedAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  /** When it was rejected or deleted — the moment the file retention counts from. */
  removedAt: z.iso.datetime().nullable(),
  /** When the files were actually removed; after that the photo can't come back. */
  filesDeletedAt: z.iso.datetime().nullable(),
  /** Pass it back as `expectedVersion` when changing the photo. */
  version: z.number().int(),
  image: itemPhotoImageSchema.nullable(),
  /** A signed link to the full-size picture, for moderation only. */
  originalUrl: z.string().nullable(),
});

export type AdminItemPhoto = z.infer<typeof adminItemPhotoSchema>;

/**
 * The answer of every photo route: the item's photos (any status, the
 * approved ones in their order first) and what its card and lists show
 * now — so the caller sees at once which photo became the primary one.
 */
export const adminItemPhotosResponseSchema = z.object({
  itemId: z.uuid(),
  names: catalogTextsSchema,
  photos: z.array(adminItemPhotoSchema),
  /** The item's picture as clients get it; `null` — no approved photo (the client shows a placeholder). */
  photo: itemPhotoImageSchema.nullable(),
  /** `photo_display_mode` in effect for this answer. */
  displayMode: photoDisplayModeSchema,
});

export type AdminItemPhotosResponse = z.infer<typeof adminItemPhotosResponseSchema>;

/**
 * `POST /admin/catalog/items/{itemId}/photos`: the body is the picture
 * itself (`Content-Type: image/jpeg | image/png | image/webp`), so what is
 * known about it travels in the query.
 */
export const uploadItemPhotoQuerySchema = z.object({
  /** Default `admin_upload` — the administrator's own file. */
  sourceType: itemPhotoSourceTypeSchema.default("admin_upload"),
  /** Required for `manufacturer`, `official_catalog` and `multi_store`. */
  sourceUrl: sourceUrlSchema.optional(),
});

export type UploadItemPhotoQuery = z.infer<typeof uploadItemPhotoQuerySchema>;

export const itemPhotoPathSchema = z.object({ itemId: z.uuid(), photoId: z.uuid() });

export type ItemPhotoPath = z.infer<typeof itemPhotoPathSchema>;

/**
 * `POST /admin/catalog/items/{itemId}/photos/{photoId}/status`.
 * `rejected` needs a `reason`. `approved` and `proposed` bring a photo
 * whose files are still there back; once the files are gone
 * (`filesDeletedAt`) nothing brings it back (`CATALOG_PHOTO_FILES_DELETED`).
 */
export const setItemPhotoStatusBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    status: itemPhotoStatusSchema,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(PHOTO_REJECTION_REASON_MAX_LENGTH)
      .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" })
      .optional(),
  })
  .refine((body) => body.status !== "rejected" || body.reason !== undefined, {
    message: "A rejected photo needs a reason",
    path: ["reason"],
  });

export type SetItemPhotoStatusBody = z.infer<typeof setItemPhotoStatusBodySchema>;

/**
 * `PUT /admin/catalog/items/{itemId}/photos/order`: every approved photo
 * of the item exactly once, the primary one first. A photo that isn't
 * approved is refused (`CATALOG_PHOTO_NOT_APPROVED`); a list that doesn't
 * name them all — `CATALOG_ORDER_MISMATCH`.
 */
export const reorderItemPhotosBodySchema = z.object({
  photoIds: z.array(z.uuid()).min(1).max(ITEM_PHOTOS_MAX),
});

export type ReorderItemPhotosBody = z.infer<typeof reorderItemPhotosBodySchema>;

/**
 * `details.reason` of `CATALOG_PHOTO_INVALID`:
 * - `empty` — no body at all;
 * - `not_an_image` — the bytes are not a picture (a name says `.jpg`, the
 *   content says otherwise);
 * - `unsupported_format` — a picture, but not JPEG, PNG or WebP (SVG and
 *   every other vector format land here);
 * - `broken` — a picture of a known format the decoder can't read;
 * - `too_many_pixels` — within the size limit but enormous when unpacked;
 * - `source_url_required` — that source type needs the page it came from;
 * - `too_many_photos` — the item already holds as many photos as it may.
 */
export const catalogPhotoInvalidReasonSchema = z.enum([
  "empty",
  "not_an_image",
  "unsupported_format",
  "broken",
  "too_many_pixels",
  "source_url_required",
  "too_many_photos",
]);

export type CatalogPhotoInvalidReason = z.infer<typeof catalogPhotoInvalidReasonSchema>;

export const catalogPhotoInvalidDetailsSchema = z.object({
  reason: catalogPhotoInvalidReasonSchema,
  /** What the server saw, for `unsupported_format` (e.g. `svg`, `gif`). */
  detected: z.string().optional(),
});

export type CatalogPhotoInvalidDetails = z.infer<typeof catalogPhotoInvalidDetailsSchema>;
