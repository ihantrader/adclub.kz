import { z } from "zod";
import { showcaseViewerSchema } from "./showcase";

/**
 * The rating of a supplier (TASK-050; PRODUCT 13; ARCHITECTURE 5.9, 4.71;
 * SCREENS M-CAT-07, M-CAT-09, A-SUP-02, A-SUP-03). The server counts it —
 * the scores, the share of orders answered in time and the share kept in
 * time — and every client only shows what it says.
 */

/** «★ 4,8 (23)»: the rating to one decimal and the published scores behind it. */
export const supplierRatingValueSchema = z.object({
  value: z.number(),
  count: z.number().int(),
});

export type SupplierRatingValue = z.infer<typeof supplierRatingValueSchema>;

// ------------------------------------------------ the supplier's page (M-CAT-09)

export const offerSupplierPathSchema = z.object({ offerId: z.uuid() });

export type OfferSupplierPath = z.infer<typeof offerSupplierPathSchema>;

export const orderSupplierPathSchema = z.object({ orderId: z.uuid() });

export type OrderSupplierPath = z.infer<typeof orderSupplierPathSchema>;

/**
 * M-CAT-09 «Поставщик: рейтинг и отзывы» without the reviews themselves:
 *
 * - `supplier` — by the rule of the showcase: hidden (with why) to a guest and
 *   to a user without club access — no name and no id; visible — the id
 *   (for `GET /suppliers/{supplierId}/reviews`) and the name;
 * - `verifiedPartner`, `rating` / `newSupplier`, the two shares — to every
 *   viewer, as the offer shows them: they name nobody;
 * - `responsePercent` — «Отвечает на N% заявок», `onTimePercent` — «Соблюдает
 *   сроки в N% случаев»: whole percents (rounded down); `null` — «Мало заявок
 *   для оценки».
 */
export const supplierProfileResponseSchema = z.object({
  viewer: showcaseViewerSchema,
  supplier: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("hidden"),
      reason: z.enum(["auth_required", "subscription_required"]),
    }),
    z.object({ kind: z.literal("visible"), id: z.uuid(), name: z.string() }),
  ]),
  verifiedPartner: z.boolean(),
  rating: supplierRatingValueSchema.nullable(),
  newSupplier: z.boolean(),
  responsePercent: z.number().int().min(0).max(100).nullable(),
  onTimePercent: z.number().int().min(0).max(100).nullable(),
});

export type SupplierProfileResponse = z.infer<typeof supplierProfileResponseSchema>;

// ------------------------------------------------------------- administrator

/** What the rating was counted by: the settings at that moment and the formula's version. */
export const supplierRatingRulesSchema = z.object({
  weights: z.object({
    reviews: z.number(),
    response_rate: z.number(),
    deadline_rate: z.number(),
  }),
  minReviews: z.number().int(),
  minOrders: z.number().int(),
  windowDays: z.number().int(),
});

export type SupplierRatingRules = z.infer<typeof supplierRatingRulesSchema>;

/** The rating as one snapshot of the history shows it. */
export const supplierRatingFiguresSchema = z.object({
  score: z.number().nullable(),
  isNew: z.boolean(),
  reviewsCount: z.number().int(),
  responseRate: z.number().nullable(),
  onTimeRate: z.number().nullable(),
});

export type SupplierRatingFigures = z.infer<typeof supplierRatingFiguresSchema>;

export const supplierRatingHistoryEntrySchema = z.object({
  id: z.uuid(),
  /** `event` — after an order or a review; `reconcile` — the nightly reconciliation. */
  cause: z.enum(["event", "reconcile"]),
  at: z.iso.datetime(),
  before: supplierRatingFiguresSchema,
  after: supplierRatingFiguresSchema,
});

export type SupplierRatingHistoryEntry = z.infer<typeof supplierRatingHistoryEntrySchema>;

/**
 * A-SUP-03 «Рейтинг и отзывы»: the rating and its three parts with the
 * numbers behind them («ответил на 45 из 50»), the formula and its version,
 * when it was counted, and the latest changes. `computedAt: null` — not
 * counted yet (the numbers are zero).
 */
export const adminSupplierRatingSchema = z.object({
  score: z.number().nullable(),
  isNew: z.boolean(),
  reviews: z.object({ count: z.number().int(), average: z.number().nullable() }),
  response: z.object({
    answered: z.number().int(),
    required: z.number().int(),
    rate: z.number().nullable(),
  }),
  onTime: z.object({
    kept: z.number().int(),
    judged: z.number().int(),
    rate: z.number().nullable(),
  }),
  rules: supplierRatingRulesSchema,
  formulaVersion: z.number().int(),
  computedAt: z.iso.datetime().nullable(),
  /** `rating_low_signal` now, and whether this rating is below it. */
  lowThreshold: z.number(),
  low: z.boolean(),
  history: z.array(supplierRatingHistoryEntrySchema),
});

export type AdminSupplierRating = z.infer<typeof adminSupplierRatingSchema>;

export const adminSupplierRatingResponseSchema = z.object({ rating: adminSupplierRatingSchema });

export type AdminSupplierRatingResponse = z.infer<typeof adminSupplierRatingResponseSchema>;
