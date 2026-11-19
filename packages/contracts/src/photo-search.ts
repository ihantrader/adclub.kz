import { z } from "zod";
import { adminItemPhotosResponseSchema, itemPhotoStatusSchema } from "./catalog-photos";
import { offerItemSchema } from "./offers";

/**
 * Photos of items found by the image search, and photos of suppliers
 * (TASK-068, D-076; PRODUCT 7.6; ARCHITECTURE 4.95, 9.7; SCREENS A-CAT-05
 * «Фото», A-MOD-03, S-OFF-03, S-OFF-05, S-MOD-01).
 *
 * The search proposes only pictures **found** with the page they come from;
 * nothing is generated. Every candidate and every supplier's photo waits for
 * a person in the moderation queue; clients see only approved ones, never
 * marked as found by AI.
 */

/** The most photos a supplier sends with one request to add an item (S-OFF-05). */
export const CATALOG_REQUEST_PHOTOS_MAX = 3;

/**
 * Why a result of the search did not become a candidate:
 * - `other_domain` — the picture is on one shop only, not on the
 *   manufacturer's or an official catalogue's site;
 * - `duplicate` — the same picture as a better-ranked result;
 * - `already_known` — the item has (or had, and it was refused) this picture;
 * - `not_an_image`, `unsupported_format`, `broken`, `too_large`,
 *   `too_many_pixels` — the file did not pass the checks of an upload;
 * - `private_address` — the address leads into a private network (it is
 *   not downloaded at all);
 * - `download_failed` — the site did not give the file (timeout, error,
 *   redirect elsewhere);
 * - `over_limit` — more good results than `photo_search_candidates`.
 */
export const photoSearchSkipReasonSchema = z.enum([
  "other_domain",
  "duplicate",
  "already_known",
  "not_an_image",
  "unsupported_format",
  "broken",
  "too_large",
  "too_many_pixels",
  "private_address",
  "download_failed",
  "over_limit",
]);

export type PhotoSearchSkipReason = z.infer<typeof photoSearchSkipReasonSchema>;

/** What one search did: the results of the provider and where they went. */
export const photoSearchOutcomeSchema = z.object({
  /** Results the provider gave. */
  results: z.number().int(),
  /** New candidates waiting in the moderation queue. */
  candidates: z.number().int(),
  skipped: z.array(z.object({ reason: photoSearchSkipReasonSchema, count: z.number().int() })),
});

export type PhotoSearchOutcome = z.infer<typeof photoSearchOutcomeSchema>;

/** `POST /admin/catalog/items/{itemId}/photos/search`: the photos of the item after the search. */
export const searchItemPhotosResponseSchema = adminItemPhotosResponseSchema.extend({
  search: photoSearchOutcomeSchema,
});

export type SearchItemPhotosResponse = z.infer<typeof searchItemPhotosResponseSchema>;

/**
 * `details` of `PHOTO_SEARCH_UNAVAILABLE` (503): `disabled` — no image
 * search is configured here (production without `SERPAPI_API_KEY`);
 * `provider` — the provider did not answer; `not_applicable` comes as 409
 * `PHOTO_SEARCH_NOT_APPLICABLE` instead (a service, an item in the archive).
 */
export const photoSearchUnavailableDetailsSchema = z.object({
  reason: z.enum(["disabled", "provider"]),
});

export type PhotoSearchUnavailableDetails = z.infer<typeof photoSearchUnavailableDetailsSchema>;

/**
 * A photo the company sent, as its cabinet sees it: the thumbnail of the
 * file we stored (a signed link), its status and the reason of a refusal.
 * «На рассмотрении» / «Фото принято» / «Отклонено: {причина}».
 */
export const supplierItemPhotoSchema = z.object({
  id: z.uuid(),
  status: itemPhotoStatusSchema,
  rejectionReason: z.string().nullable(),
  /** A signed link to the thumbnail; `null` once the files were removed. */
  thumbUrl: z.string().nullable(),
  uploadedAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
});

export type SupplierItemPhoto = z.infer<typeof supplierItemPhotoSchema>;

/**
 * `GET /supplier/offers/{offerId}/photos` — the block S-OFF-03 «У позиции нет
 * фото — сфотографируйте деталь»: whether the item still needs a photo (no
 * approved one, a product and not a service) and the photos the company sent
 * for it.
 */
export const supplierOfferPhotosSchema = z.object({
  needed: z.boolean(),
  photos: z.array(supplierItemPhotoSchema),
});

export type SupplierOfferPhotos = z.infer<typeof supplierOfferPhotosSchema>;

/** The answer of an upload of a supplier: the photo and whether it is new. */
export const supplierPhotoUploadResponseSchema = z.object({
  photo: supplierItemPhotoSchema,
  /** `false` — the same picture was already sent; nothing was stored twice. */
  created: z.boolean(),
});

export type SupplierPhotoUploadResponse = z.infer<typeof supplierPhotoUploadResponseSchema>;

export const catalogRequestIdPathSchema = z.object({ requestId: z.uuid() });

/**
 * A photo of the company in «Модерация» (S-MOD-01): the item it is of, or
 * the request it came with while the request waits.
 */
export const supplierModerationPhotoSchema = z.object({
  photo: supplierItemPhotoSchema,
  /** `null` — a photo of a request whose item doesn't exist yet. */
  item: offerItemSchema.nullable(),
  request: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  isNew: z.boolean(),
});

export type SupplierModerationPhoto = z.infer<typeof supplierModerationPhotoSchema>;

export const supplierModerationPhotoQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(200).optional(),
});

export type SupplierModerationPhotoQuery = z.infer<typeof supplierModerationPhotoQuerySchema>;

export const supplierModerationPhotoPageSchema = z.object({
  entries: z.array(supplierModerationPhotoSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type SupplierModerationPhotoPage = z.infer<typeof supplierModerationPhotoPageSchema>;

/** A photo sent with a request to add an item, as the administrator sees it (A-MOD-01). */
export const catalogRequestPhotoSchema = supplierItemPhotoSchema.extend({
  /** A signed link to the full-size picture, for moderation. */
  originalUrl: z.string().nullable(),
});

export type CatalogRequestPhoto = z.infer<typeof catalogRequestPhotoSchema>;
