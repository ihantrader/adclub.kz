import { z } from "zod";
import { catalogSearchEmptyReasonSchema, catalogSearchItemSchema } from "./search";
import { showcaseVehicleQueryShape } from "./showcase";
import { vehicleDocumentAttemptsSchema } from "./vehicle-document";

/**
 * Two more photos the app reads (TASK-058, ARCHITECTURE 4.83), built as the
 * registration certificate is (TASK-057, D-064): the photo is the body of
 * one request, made smaller and stripped by the server, read by the AI
 * gateway and gone with the answer — stored nowhere. The three photos share
 * one trial limit of a guest (`guest_limits.photo_recognitions`, PRODUCT
 * 6.6) and one limit per address and per account; `attempts` of every
 * answer and of `GET /garage/vehicle-document/attempts` is that shared
 * count. The refusals are the codes of the certificate:
 * `VEHICLE_DOCUMENT_INVALID` (not a picture), `VEHICLE_DOCUMENT_UNAVAILABLE`
 * (the provider or the day's budget, the attempt given back), 413 and 429.
 *
 * - **The dashboard** (M-GAR-07, M-GAR-05): the total mileage as the
 *   odometer shows it. Nothing is written: the reading is what the person
 *   checks and saves with `POST /garage/cars/{carId}/mileage` (or on the
 *   device as a guest).
 * - **A part** (M-CAT-06): the article on the part or its box, found in the
 *   catalog by the very search `GET /catalog/search` makes of an article.
 *   Nothing to keep: a search changes no data.
 */

/** `deviceId` — a guest's trial recognitions are counted by the device (as the certificate). */
export const dashboardQuerySchema = z.object({
  deviceId: z.uuid().optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/**
 * - `dashboard` — the odometer could be read: `mileageKm` is the total;
 * - `not_dashboard` — the photo is not of a dashboard;
 * - `unreadable` — a dashboard, but the total cannot be read (the ignition
 *   off, a glare over the digits, cut off).
 */
export const dashboardKindSchema = z.enum(["dashboard", "not_dashboard", "unreadable"]);

export type DashboardKind = z.infer<typeof dashboardKindSchema>;

export const dashboardResponseSchema = z.object({
  kind: dashboardKindSchema,
  /** Kilometres — miles on the panel are converted (`unit: "mi"`, rounded); `null` unless `dashboard`. */
  mileageKm: z.number().int().nullable(),
  /** What the panel counts in: «На панели мили — перевели в километры» for `mi`. */
  unit: z.enum(["km", "mi"]).nullable(),
  /** How sure the reading is, 0…1. */
  confidence: z.number().nullable(),
  /** A trip meter was seen next to the total (it was not taken). */
  tripMeterSeen: z.boolean(),
  /**
   * The id of this recognition (the AI call): sent back with the confirmed
   * reading (`recognitionId`), so the journal knows which reading the
   * person checked. `null` when nothing was read.
   */
  recognitionId: z.uuid().nullable(),
  attempts: vehicleDocumentAttemptsSchema,
});

export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

/**
 * The photo of a part (M-CAT-06): the device, and the city and the car the
 * results are for — as `GET /catalog/search` takes them.
 */
export const partPhotoQuerySchema = z.object({
  deviceId: z.uuid().optional(),
  cityId: z.uuid().optional(),
  ...showcaseVehicleQueryShape,
});

export type PartPhotoQuery = z.infer<typeof partPhotoQuerySchema>;

/**
 * - `article_found` — an article was read (`article`; the results may still
 *   be empty: «Артикул не найден в каталоге»);
 * - `no_article` — a part or a box without a readable article: «Не нашли
 *   артикул на фото»;
 * - `unreadable` — nothing could be read off the photo.
 */
export const partPhotoKindSchema = z.enum(["article_found", "no_article", "unreadable"]);

export type PartPhotoKind = z.infer<typeof partPhotoKindSchema>;

/** An article as read: the text, its normal form (`normalizeArticle`), how sure (0…1). */
export const partPhotoArticleSchema = z.object({
  text: z.string(),
  normalized: z.string(),
  confidence: z.number(),
});

export type PartPhotoArticle = z.infer<typeof partPhotoArticleSchema>;

export const partPhotoResponseSchema = z.object({
  kind: partPhotoKindSchema,
  /** The likeliest article — put into the search line; `null` unless `article_found`. */
  article: partPhotoArticleSchema.nullable(),
  /** The other articles read, likeliest first — the chips «Или: …». */
  candidates: z.array(partPhotoArticleSchema),
  /** The brand on the label, if the model saw one (a hint, never a filter). */
  brandHint: z.string().nullable(),
  /**
   * The first page of `GET /catalog/search` for `article`: the same items,
   * order, marks of compatibility and offers; empty — not in the catalog.
   */
  items: z.array(catalogSearchItemSchema),
  total: z.number().int(),
  empty: catalogSearchEmptyReasonSchema.nullable(),
  /**
   * The analogs of the items found (the catalog's analog links), each found
   * by its own article with the same search: «Аналоги» under the results.
   */
  analogs: z.array(catalogSearchItemSchema),
  attempts: vehicleDocumentAttemptsSchema,
});

export type PartPhotoResponse = z.infer<typeof partPhotoResponseSchema>;
