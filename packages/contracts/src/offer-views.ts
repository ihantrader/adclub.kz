import { z } from "zod";

/**
 * Views of offers (TASK-070; PRODUCT 12.5, 13, 16; ARCHITECTURE 5.8, 4.88).
 * The server counts a view itself when it shows an offer — on the card of an
 * item (`GET /catalog/items/{id}`, every offer of the answer) and on M-CAT-09
 * from an offer (`GET /catalog/offers/{offerId}/supplier`). There is no route
 * «I looked»: nobody can inflate a supplier's views.
 *
 * One view — one offer, one viewer, one day of Almaty. The kind of the
 * viewer: `guest`; `user` — signed in without club access; `club` — with it
 * (`ClubAccess`). Who looked is never shown anywhere — only the numbers.
 */
export const offerViewerKindSchema = z.enum(["guest", "user", "club"]);

export type OfferViewerKind = z.infer<typeof offerViewerKindSchema>;

/** A day of Almaty, `YYYY-MM-DD`. */
export const almatyDaySchema = z.iso.date();

/** The longest period of `GET /admin/suppliers/{id}/views`, in days. */
export const ADMIN_SUPPLIER_VIEWS_MAX_DAYS = 366;

/**
 * The period: days of Almaty, both ends included. Left out — the last 30
 * days, today included; `from` alone — up to today; `to` alone — 30 days up
 * to it. Longer than 366 days, or `from` after `to` — 400.
 */
export const adminSupplierViewsQuerySchema = z.object({
  from: almatyDaySchema.optional(),
  to: almatyDaySchema.optional(),
});

export type AdminSupplierViewsQuery = z.infer<typeof adminSupplierViewsQuerySchema>;

/** What one day (or the whole period) had. */
export const offerViewFiguresSchema = z.object({
  /** Views by members of the club — what the signal counts. */
  club: z.number().int(),
  /** Views by signed-in users without club access. */
  user: z.number().int(),
  /** Views by guests (part of them are cached and never reach the server). */
  guest: z.number().int(),
  /** All views. */
  total: z.number().int(),
  /** Orders placed that day that count in statistics (no test orders). */
  orders: z.number().int(),
  /** orders ÷ club views; `null` — no club views. */
  conversion: z.number().nullable(),
});

export type OfferViewFigures = z.infer<typeof offerViewFiguresSchema>;

export const adminSupplierViewsSchema = z.object({
  from: almatyDaySchema,
  to: almatyDaySchema,
  /** Every day of the period, oldest first, zeros too. */
  days: z.array(offerViewFiguresSchema.extend({ day: almatyDaySchema })),
  total: offerViewFiguresSchema,
  /** The rule of the signal «Просмотров много, заявок мало» now (the settings). */
  signal: z.object({
    windowDays: z.number().int(),
    minViews: z.number().int(),
    minSuppliers: z.number().int(),
    ratio: z.number(),
  }),
});

export type AdminSupplierViews = z.infer<typeof adminSupplierViewsSchema>;

export const adminSupplierViewsResponseSchema = z.object({ views: adminSupplierViewsSchema });

export type AdminSupplierViewsResponse = z.infer<typeof adminSupplierViewsResponseSchema>;
