import { z } from "zod";
import { catalogLanguageSchema, localizedTextSchema } from "./catalog";
import { itemPhotoImageSchema } from "./catalog-photos";

/**
 * Offers of suppliers on catalog goods (PRODUCT 7.1, 9, 9.1, 12.3, 12.4;
 * SCREENS S-OFF-01…03, A-SUP-03; ARCHITECTURE 5.5, 4.28; TASK-018). A
 * supplier doesn't create items: it finds one in the catalog and puts its
 * price, availability, term, pickup and delivery and warranty on it. One
 * item — one offer of a pickup point. An offer taken off sale isn't
 * deleted; it waits on the «withdrawn» tab to be returned. Offers on
 * services — TASK-019.
 */

/** Upper bounds of the contract; the working bounds of the price and the term are settings. */
export const OFFER_PRICE_LIMIT = 2_000_000_000;
export const OFFER_LEAD_DAYS_LIMIT = 365;
export const OFFER_WARRANTY_MONTHS_MAX = 120;
export const OFFER_WARRANTY_TEXT_MAX_LENGTH = 100;
export const OFFER_SUPPLIER_SKU_MAX_LENGTH = 64;
export const OFFER_SUPPLIER_NAME_MAX_LENGTH = 200;
export const OFFER_QUERY_MAX_LENGTH = 100;
export const OFFER_PAGE_MAX_SIZE = 100;
export const OFFER_PAGE_DEFAULT_SIZE = 50;

/**
 * The search of an item for an offer (S-OFF-02) works only by a query:
 * at least this many letters or digits, a page of at most
 * `OFFER_ITEM_SEARCH_PAGE_MAX`, and no further than the first
 * `OFFER_ITEM_SEARCH_MAX_RESULTS` matches of a query — the catalog can't
 * be read out whole.
 */
export const OFFER_ITEM_SEARCH_MIN_LENGTH = 3;
export const OFFER_ITEM_SEARCH_PAGE_MAX = 20;
export const OFFER_ITEM_SEARCH_MAX_RESULTS = 100;

function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

const expectedVersionSchema = z.number().int().min(1);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Must be YYYY-MM-DD" });

/** `in_stock` — in stock; `on_order` — under order, with a term of at least one day. */
export const offerAvailabilitySchema = z.enum(["in_stock", "on_order"]);

export type OfferAvailability = z.infer<typeof offerAvailabilitySchema>;

/**
 * `active` — on sale; `withdrawn` — taken off sale (by the supplier, or
 * later by a price import); `suspended` — reserved for the system
 * (billing, EPIC-14), never set by this task.
 */
export const offerStatusSchema = z.enum(["active", "withdrawn", "suspended"]);

export type OfferStatusValue = z.infer<typeof offerStatusSchema>;

/** `manual` — by an employee; `missing_in_import` — the item was missing from a price import (EPIC-16). */
export const offerWithdrawnReasonSchema = z.enum(["manual", "missing_in_import"]);

export type OfferWithdrawnReason = z.infer<typeof offerWithdrawnReasonSchema>;

/**
 * Why users don't see an offer (several at once, in this order): it is
 * withdrawn or suspended; the supplier is blocked or paused; the item is
 * not active in the catalog (archived by the administrator); its
 * subcategory or node is hidden or archived; the pickup point has no city.
 */
export const offerHiddenReasonSchema = z.enum([
  "offer_withdrawn",
  "offer_suspended",
  "supplier_blocked",
  "supplier_paused",
  "item_unavailable",
  "category_hidden",
  "no_city",
]);

export type OfferHiddenReasonValue = z.infer<typeof offerHiddenReasonSchema>;

/** The one server rule of the showcase (ARCHITECTURE 4.28): TASK-020 shows only `visible`. */
export const offerShowcaseSchema = z.object({
  visible: z.boolean(),
  reasons: z.array(offerHiddenReasonSchema),
});

export type OfferShowcase = z.infer<typeof offerShowcaseSchema>;

/**
 * The date a user gets the item if an order were confirmed at
 * `confirmedAt` (SCREENS S-OFF-03 «Клиент увидит: Самовывоз — завтра,
 * 14 марта»): `date` in the time zone of the pickup point, and the day of
 * the confirmation there (`confirmedOn`) to say «today», «tomorrow». No
 * date when the point's hours aren't given (`hours_not_set`) or no day
 * works within 60 days (`no_working_day`) — the supplier fixes the
 * schedule on the company card.
 */
export const offerReceiptSchema = z.object({
  confirmedAt: z.iso.datetime(),
  confirmedOn: dateSchema,
  timeZone: z.string(),
  leadDays: z.number().int(),
  date: dateSchema.nullable(),
  unavailable: z.enum(["hours_not_set", "no_working_day"]).nullable(),
});

export type OfferReceipt = z.infer<typeof offerReceiptSchema>;

/** The catalog item of an offer, in the language of the request. */
export const offerItemSchema = z.object({
  id: z.uuid(),
  type: z.enum(["part", "generic"]),
  /** `draft`, `active` or `archived` in the catalog: an archived item keeps its offers, off the showcase. */
  status: z.enum(["draft", "active", "archived"]),
  name: localizedTextSchema,
  article: z.string().nullable(),
  brand: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  category: z.object({
    id: z.uuid(),
    name: localizedTextSchema,
    /** The node above the subcategory. */
    parentName: localizedTextSchema.nullable(),
  }),
  /** The approved primary photo (a thumbnail and a card size, never full-size); `null` — none. */
  photo: itemPhotoImageSchema.nullable(),
});

export type OfferItem = z.infer<typeof offerItemSchema>;

/** An offer as the cabinet and the admin panel see it (S-OFF-01, A-SUP-03). */
export const supplierOfferSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  locationId: z.uuid(),
  item: offerItemSchema,
  /** Whole tenge. */
  price: z.number().int(),
  currency: z.literal("KZT"),
  availability: offerAvailabilitySchema,
  /** Working days from the confirmation of an order; 0 — take it at once. */
  leadDays: z.number().int(),
  pickup: z.boolean(),
  delivery: z.boolean(),
  warrantyMonths: z.number().int().nullable(),
  warrantyText: z.string().nullable(),
  /** The supplier's own article and name of the item (from its price list). */
  supplierSku: z.string().nullable(),
  supplierName: z.string().nullable(),
  status: offerStatusSchema,
  withdrawnAt: z.iso.datetime().nullable(),
  withdrawnReason: offerWithdrawnReasonSchema.nullable(),
  showcase: offerShowcaseSchema,
  /** The receipt date for an order confirmed now. */
  receipt: offerReceiptSchema,
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type SupplierOffer = z.infer<typeof supplierOfferSchema>;

export const offerPathSchema = z.object({ offerId: z.uuid() });

export type OfferPath = z.infer<typeof offerPathSchema>;

export const supplierOffersPathSchema = z.object({ supplierId: z.uuid() });

export type SupplierOffersPath = z.infer<typeof supplierOffersPathSchema>;

const warrantyMonthsSchema = z.number().int().min(1).max(OFFER_WARRANTY_MONTHS_MAX);
const priceSchema = z.number().int().min(1).max(OFFER_PRICE_LIMIT);
const leadDaysSchema = z.number().int().min(0).max(OFFER_LEAD_DAYS_LIMIT);

/**
 * `POST /supplier/offers`: an offer of the company's pickup point on an
 * active part or product. The price must be within the settings
 * `offer_price_min_kzt`…`offer_price_max_kzt`, the term within
 * `offer_lead_days_max`; `on_order` needs a term of at least one day;
 * pickup or delivery (or both); pickup needs the address of the point;
 * the warranty is months or a short text, not both.
 */
export const createOfferBodySchema = z.object({
  itemId: z.uuid(),
  price: priceSchema,
  availability: offerAvailabilitySchema,
  leadDays: leadDaysSchema,
  pickup: z.boolean(),
  delivery: z.boolean(),
  warrantyMonths: warrantyMonthsSchema.nullable().optional(),
  warrantyText: plainText(OFFER_WARRANTY_TEXT_MAX_LENGTH).nullable().optional(),
  supplierSku: plainText(OFFER_SUPPLIER_SKU_MAX_LENGTH).nullable().optional(),
  supplierName: plainText(OFFER_SUPPLIER_NAME_MAX_LENGTH).nullable().optional(),
});

export type CreateOfferBody = z.infer<typeof createOfferBodySchema>;

const OFFER_EDITABLE_FIELDS = new Set([
  "expectedVersion",
  "price",
  "availability",
  "leadDays",
  "pickup",
  "delivery",
  "warrantyMonths",
  "warrantyText",
  "supplierSku",
  "supplierName",
]);

/**
 * `PATCH /supplier/offers/{offerId}`: one field or several, straight from
 * the list (S-OFF-01), with the version read. The same rules as creating
 * hold for the offer as it becomes. The item and the status aren't
 * changed here (another item is another offer; the status — withdraw and
 * return); any other field is refused on its path.
 */
export const updateOfferBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    price: priceSchema.optional(),
    availability: offerAvailabilitySchema.optional(),
    leadDays: leadDaysSchema.optional(),
    pickup: z.boolean().optional(),
    delivery: z.boolean().optional(),
    warrantyMonths: warrantyMonthsSchema.nullable().optional(),
    warrantyText: plainText(OFFER_WARRANTY_TEXT_MAX_LENGTH).nullable().optional(),
    supplierSku: plainText(OFFER_SUPPLIER_SKU_MAX_LENGTH).nullable().optional(),
    supplierName: plainText(OFFER_SUPPLIER_NAME_MAX_LENGTH).nullable().optional(),
  })
  .loose()
  .superRefine((body, context) => {
    for (const key of Object.keys(body)) {
      if (!OFFER_EDITABLE_FIELDS.has(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            key === "itemId"
              ? "An offer stays on its item: put a new offer on another one"
              : "Not a field of an offer that can be changed",
        });
      }
    }
  });

export type UpdateOfferBody = z.infer<typeof updateOfferBodySchema>;

/** `POST …/withdraw` and `POST …/return`: the version read. */
export const offerStatusBodySchema = z.object({ expectedVersion: expectedVersionSchema });

export type OfferStatusBody = z.infer<typeof offerStatusBodySchema>;

export const supplierOfferResponseSchema = z.object({ offer: supplierOfferSchema });

export type SupplierOfferResponse = z.infer<typeof supplierOfferResponseSchema>;

/**
 * `POST …/return`: the offer is on sale again; `checkPrice` — always
 * true — asks the cabinet to remind «Проверьте цену» (S-OFF-01): the
 * price was set before it was withdrawn.
 */
export const offerReturnedResponseSchema = z.object({
  offer: supplierOfferSchema,
  checkPrice: z.boolean(),
});

export type OfferReturnedResponse = z.infer<typeof offerReturnedResponseSchema>;

/** The tabs of S-OFF-01: «В продаже» (on sale and suspended) and «Снятые». */
export const offerTabSchema = z.enum(["on_sale", "withdrawn"]);

export type OfferTab = z.infer<typeof offerTabSchema>;

/**
 * The own offers of the company (and the admin view of a supplier's):
 * a tab, a search by the item's name (any language), article or the
 * supplier's own article, «in stock / on order», «without a photo»;
 * newest first, page by page (`cursor` — the `nextCursor` of the previous page).
 */
export const offerListQuerySchema = z.object({
  tab: offerTabSchema.default("on_sale"),
  q: plainText(OFFER_QUERY_MAX_LENGTH).optional(),
  availability: offerAvailabilitySchema.optional(),
  withoutPhoto: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(OFFER_PAGE_MAX_SIZE).default(OFFER_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type OfferListQuery = z.infer<typeof offerListQuerySchema>;

export const offerPageSchema = z.object({
  language: catalogLanguageSchema,
  offers: z.array(supplierOfferSchema),
  /** Offers matching the query on this tab. */
  total: z.number().int(),
  /** How many offers each tab holds (without the other filters) — the tab counters. */
  counts: z.object({ onSale: z.number().int(), withdrawn: z.number().int() }),
  nextCursor: z.string().nullable(),
});

export type OfferPage = z.infer<typeof offerPageSchema>;

/**
 * `GET /supplier/catalog/items/search` (S-OFF-02): only by a query of at
 * least `OFFER_ITEM_SEARCH_MIN_LENGTH` letters or digits — a part of the
 * article in any spelling (spaces, hyphens and case ignored) or a part of
 * the name in any language. `offset` + `limit` never go past
 * `OFFER_ITEM_SEARCH_MAX_RESULTS`: refine the query instead.
 */
export const offerItemSearchQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(OFFER_QUERY_MAX_LENGTH)
      .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" })
      .refine(
        (value) => (value.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= OFFER_ITEM_SEARCH_MIN_LENGTH,
        { message: `Type at least ${OFFER_ITEM_SEARCH_MIN_LENGTH} letters or digits` },
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(OFFER_ITEM_SEARCH_PAGE_MAX)
      .default(OFFER_ITEM_SEARCH_PAGE_MAX),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(OFFER_ITEM_SEARCH_MAX_RESULTS - 1)
      .default(0),
  })
  .superRefine((query, context) => {
    if (query.offset + query.limit > OFFER_ITEM_SEARCH_MAX_RESULTS) {
      context.addIssue({
        code: "custom",
        path: ["offset"],
        message: `Only the first ${OFFER_ITEM_SEARCH_MAX_RESULTS} matches are shown: refine the query`,
      });
    }
  });

export type OfferItemSearchQuery = z.infer<typeof offerItemSearchQuerySchema>;

/** A found item and the company's offer on it, if any («Уже в ваших предложениях»). */
export const offerItemSearchResultSchema = z.object({
  item: offerItemSchema,
  offer: z.object({ id: z.uuid(), status: offerStatusSchema }).nullable(),
});

export type OfferItemSearchResult = z.infer<typeof offerItemSearchResultSchema>;

export const offerItemSearchResponseSchema = z.object({
  language: catalogLanguageSchema,
  results: z.array(offerItemSearchResultSchema),
  /** The `offset` of the next page; `null` — no more, or the limit of matches is reached. */
  nextOffset: z.number().int().nullable(),
});

export type OfferItemSearchResponse = z.infer<typeof offerItemSearchResponseSchema>;

/** `GET /supplier/offers/receipt-preview?leadDays=…` — the preview of an unsaved form (S-OFF-03). */
export const offerReceiptPreviewQuerySchema = z.object({
  leadDays: z.coerce.number().int().min(0).max(OFFER_LEAD_DAYS_LIMIT),
});

export type OfferReceiptPreviewQuery = z.infer<typeof offerReceiptPreviewQuerySchema>;

export const offerReceiptPreviewResponseSchema = z.object({ receipt: offerReceiptSchema });

export type OfferReceiptPreviewResponse = z.infer<typeof offerReceiptPreviewResponseSchema>;

// ------------------------------------------------------------------ errors

/** `details` of `OFFER_EXISTS`: the offer already there (return it if it is withdrawn). */
export const offerExistsDetailsSchema = z.object({
  existingOfferId: z.uuid(),
  status: offerStatusSchema,
});

export type OfferExistsDetails = z.infer<typeof offerExistsDetailsSchema>;

export const offerVersionConflictDetailsSchema = z.object({ currentVersion: z.number().int() });

export type OfferVersionConflictDetails = z.infer<typeof offerVersionConflictDetailsSchema>;

export const offerStateDetailsSchema = z.object({ status: offerStatusSchema });

export type OfferStateDetails = z.infer<typeof offerStateDetailsSchema>;

// ---------------------------------------------------------------- snapshot

/**
 * What an offer was when an order was created (TASK-018 requirement 5;
 * ARCHITECTURE 4.28): an order (EPIC-08) keeps this copy, so later
 * changes of the price, the terms or withdrawing the offer never change
 * it. Names are copied in all three languages, the city in Russian.
 */
export const offerSnapshotSchema = z.object({
  offerId: z.uuid(),
  offerVersion: z.number().int(),
  takenAt: z.iso.datetime(),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  location: z.object({
    id: z.uuid(),
    cityId: z.uuid(),
    cityName: z.string(),
    address: z.string().nullable(),
    district: z.string().nullable(),
    timeZone: z.string(),
  }),
  item: z.object({
    id: z.uuid(),
    type: z.enum(["part", "generic"]),
    names: z.object({
      kk: z.string().nullable(),
      ru: z.string().nullable(),
      en: z.string().nullable(),
    }),
    article: z.string().nullable(),
    brand: z.string().nullable(),
  }),
  price: z.number().int(),
  currency: z.literal("KZT"),
  availability: offerAvailabilitySchema,
  leadDays: z.number().int(),
  pickup: z.boolean(),
  delivery: z.boolean(),
  warrantyMonths: z.number().int().nullable(),
  warrantyText: z.string().nullable(),
});

export type OfferSnapshot = z.infer<typeof offerSnapshotSchema>;
