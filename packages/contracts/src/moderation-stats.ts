import { z } from "zod";
import { itemPhotoProposedBySchema, itemPhotoSourceTypeSchema } from "./catalog-photos";
import { almatyDaySchema } from "./offer-views";

/**
 * The moderation queue of the admin panel and the statistics of a supplier
 * (TASK-071; PRODUCT 12.2, 12.6, 13; SCREENS A-HOME, A-MOD-01, A-MOD-02,
 * S-STAT-01; ARCHITECTURE 4.89).
 */

// ------------------------------------------------ the moderation queue

/** `item_request` — a request to add an item (A-MOD-01); `compatibility` — a compatibility proposal (A-MOD-02). */
export const adminModerationKindSchema = z.enum(["item_request", "compatibility", "photo"]);

export type AdminModerationKind = z.infer<typeof adminModerationKindSchema>;

/**
 * Where it came from: a price list, the form «Запрос на добавление» by hand,
 * the offer of the cabinet; `search` — a candidate of the image search
 * (TASK-068, [AI] on the screen).
 */
export const adminModerationSourceSchema = z.enum(["price_import", "manual", "cabinet", "search"]);

export type AdminModerationSource = z.infer<typeof adminModerationSourceSchema>;

/** The largest page of `GET /admin/moderation`. */
export const ADMIN_MODERATION_MAX_LIMIT = 100;

/**
 * Only what waits: requests in `new`, proposals of suppliers in `pending`.
 * Oldest first; pages by `cursor` (the `nextCursor` of the previous page) —
 * an entry decided between pages simply leaves, a new one comes at the end,
 * nothing is skipped or shown twice.
 */
export const adminModerationQuerySchema = z.object({
  kind: adminModerationKindSchema.optional(),
  supplierId: z.uuid().optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_MODERATION_MAX_LIMIT).default(50),
});

export type AdminModerationQuery = z.infer<typeof adminModerationQuerySchema>;

export const adminModerationEntrySchema = z.object({
  kind: adminModerationKindSchema,
  /** The request's or the proposal's id: its own card opens by it. */
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  source: adminModerationSourceSchema,
  /** A request to add an item: what the supplier sent (the row of the price list or the form). */
  proposed: z
    .object({
      name: z.string().nullable(),
      brand: z.string().nullable(),
      article: z.string().nullable(),
    })
    .nullable(),
  /** A compatibility proposal: the item of the catalog it is about. */
  item: z
    .object({
      id: z.uuid(),
      name: z.string().nullable(),
      brand: z.string().nullable(),
      article: z.string().nullable(),
    })
    .nullable(),
  /** A compatibility proposal: the cars, in words («Geely Atlas · II (FX11) · 2023–»). */
  vehicle: z.string().nullable(),
  /**
   * A photo (A-MOD-03, TASK-068): the picture we stored, where it was found
   * and who put it forward. «Подтвердить» / «Отклонить» are the same
   * decisions as in «Фото» of the item (`setItemPhotoStatus`, with `version`).
   * `null` for the other kinds.
   */
  photo: z
    .object({
      id: z.uuid(),
      itemId: z.uuid(),
      version: z.number().int(),
      thumbUrl: z.string().nullable(),
      originalUrl: z.string().nullable(),
      sourceType: itemPhotoSourceTypeSchema,
      sourceUrl: z.string().nullable(),
      proposedBy: itemPhotoProposedBySchema,
      aiScore: z.number().nullable(),
      width: z.number().int(),
      height: z.number().int(),
    })
    .nullable(),
});

export type AdminModerationEntry = z.infer<typeof adminModerationEntrySchema>;

export const adminModerationPageSchema = z.object({
  entries: z.array(adminModerationEntrySchema),
  /** «Всего N» with the filters; with none — the number of the home card «Модерация ждёт». */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminModerationPage = z.infer<typeof adminModerationPageSchema>;

// ------------------------------------------------ the statistics of a supplier

/** S-STAT-01: the last 7, 30 or 90 days of Almaty, today included. */
export const supplierStatsPeriodSchema = z.enum(["7", "30", "90"]);

export type SupplierStatsPeriod = z.infer<typeof supplierStatsPeriodSchema>;

export const supplierStatsQuerySchema = z.object({
  period: supplierStatsPeriodSchema.default("30"),
});

export type SupplierStatsQuery = z.infer<typeof supplierStatsQuerySchema>;

/**
 * The statistics of a supplier for a period (S-STAT-01). The numbers are
 * of the orders **placed** in the period (days of Almaty) that count in
 * statistics — an employee's test order is in none of them (PRODUCT 12.6).
 * The shares are those of the rating (`ratingOrderOutcome`) over the same
 * orders; fewer than `minOrders` behind a share — `null`, «Мало заявок для
 * оценки». The rating is the one shown now, over its own window.
 */
export const supplierStatsSchema = z.object({
  period: supplierStatsPeriodSchema,
  from: almatyDaySchema,
  to: almatyDaySchema,
  orders: z.object({
    /** Every order placed in the period. */
    total: z.number().int(),
    /** Given out (a service — done). */
    completed: z.number().int(),
    /** Of `completed` — services done. */
    completedServices: z.number().int(),
    cancelledByUser: z.number().int(),
    declinedBySupplier: z.number().int(),
    /** The deadline of the answer passed with none. */
    expiredNoResponse: z.number().int(),
  }),
  views: z.object({
    /** Views of the supplier's offers, every kind of viewer. */
    total: z.number().int(),
    /** Of them — by members of the club. */
    club: z.number().int(),
  }),
  shares: z.object({
    /** 0–1; `null` — too few orders wanted an answer. */
    responseRate: z.number().nullable(),
    /** A whole percent, rounded down; `null` — as above. */
    responsePercent: z.number().int().nullable(),
    /** Answered in time / wanted an answer. */
    answered: z.number().int(),
    answerRequired: z.number().int(),
    /** 0–1; `null` — too few orders reached a verdict. */
    onTimeRate: z.number().nullable(),
    onTimePercent: z.number().int().nullable(),
    kept: z.number().int(),
    judged: z.number().int(),
    /** `rating_min_orders`. */
    minOrders: z.number().int(),
  }),
  rating: z.object({
    /** 1–5 to one decimal; `null` — «Новый поставщик». */
    score: z.number().nullable(),
    isNew: z.boolean(),
    reviewsCount: z.number().int(),
    /** `rating_window_days`: the rating's own window. */
    windowDays: z.number().int(),
    /** `rating_min_reviews`: the scores a rating needs. */
    minReviews: z.number().int(),
  }),
});

export type SupplierStats = z.infer<typeof supplierStatsSchema>;

export const supplierStatsResponseSchema = z.object({ stats: supplierStatsSchema });

export type SupplierStatsResponse = z.infer<typeof supplierStatsResponseSchema>;
