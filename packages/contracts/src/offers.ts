import { z } from "zod";
import { catalogLanguageSchema, localizedTextSchema } from "./catalog";
import { itemPhotoImageSchema } from "./catalog-photos";
import { supplierTypeSchema } from "./suppliers";

/**
 * Offers of suppliers on catalog goods and services (PRODUCT 7.1, 9, 9.1,
 * 11, 12.3, 12.4; SCREENS S-OFF-01…04, A-SUP-03; ARCHITECTURE 5.5, 4.28,
 * 4.61; TASK-018, TASK-019). A supplier doesn't create items: it finds one
 * in the catalog and puts its price, availability, term, pickup and
 * delivery and warranty on it. One item — one offer of a pickup point. An
 * offer taken off sale isn't deleted; it waits on the «withdrawn» tab to be
 * returned. A service (TASK-019) is done at the point — no availability,
 * term, pickup or delivery — and its price is one for all models of the car
 * or a price per model.
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
/** Rows of a service's table of prices by model (S-OFF-04). */
export const OFFER_MODEL_PRICES_MAX = 200;

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
 * The price of an offer (TASK-019, S-OFF-04): `single` — one for every
 * model (a product's is always so); `by_model` — a service's price per
 * model of the car: a client whose model has no price doesn't see the offer.
 */
export const offerPriceModeSchema = z.enum(["single", "by_model"]);

export type OfferPriceMode = z.infer<typeof offerPriceModeSchema>;

/**
 * Why users don't see an offer (several at once, in this order): it is
 * withdrawn or suspended; the supplier is blocked or paused; the item is
 * not active in the catalog (archived by the administrator); its
 * subcategory or node is hidden or archived; the pickup point has no city;
 * the point's hours aren't given or have no working day (D-060: without a
 * receipt date the offer isn't shown — fill the hours in on the company
 * card).
 */
export const offerHiddenReasonSchema = z.enum([
  "offer_withdrawn",
  "offer_suspended",
  "supplier_blocked",
  "supplier_paused",
  // TASK-019: the company's type no longer lets it offer the item (a
  // service of a company made «только товары», or goods of «только услуги»).
  "supplier_type_mismatch",
  "item_unavailable",
  "category_hidden",
  "no_city",
  // D-060 (TASK-020): no receipt date can be calculated — the point's
  // hours aren't given, or give no working day at all.
  "hours_not_set",
  "no_working_day",
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
  /** `service` — an offer on a service (TASK-019). */
  type: z.enum(["part", "generic", "service"]),
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

/** A row of a service's prices by model, with the names of the make and the model. */
export const offerModelPriceSchema = z.object({
  make: z.object({ id: z.uuid(), name: z.string() }),
  model: z.object({ id: z.uuid(), name: z.string() }),
  price: z.number().int(),
  /**
   * Clients can choose this model (it and its make are active). A model in
   * the archive keeps its price, but nobody sees it — no client has it to
   * choose any more.
   */
  available: z.boolean(),
});

export type OfferModelPrice = z.infer<typeof offerModelPriceSchema>;

/** How an offer is priced; `models` — only of `by_model`, by make and model name. */
export const offerPricingSchema = z.object({
  mode: offerPriceModeSchema,
  models: z.array(offerModelPriceSchema),
});

export type OfferPricing = z.infer<typeof offerPricingSchema>;

/** An offer as the cabinet and the admin panel see it (S-OFF-01, A-SUP-03). */
export const supplierOfferSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  locationId: z.uuid(),
  item: offerItemSchema,
  /**
   * Whole tenge. Priced by model (a service, TASK-019) — the lowest of the
   * model prices («от N ₸»).
   */
  price: z.number().int(),
  /** One price, or prices by model (a service; TASK-019). */
  pricing: offerPricingSchema,
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
  /**
   * «Активные заявки: N» (S-OFF-01; TASK-032): the company's orders on
   * this offer that are still going through — the statuses of the tabs
   * «Новые» and «В работе» of the supplier's orders. They keep the price of
   * their snapshot whatever happens to the offer, and must still be
   * fulfilled after it is withdrawn.
   */
  activeOrders: z.number().int(),
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

/** A row of a service's prices by model as the cabinet sends it: a model of the vehicle catalog. */
export const offerModelPriceInputSchema = z.object({
  modelId: z.uuid(),
  price: priceSchema,
});

export type OfferModelPriceInput = z.infer<typeof offerModelPriceInputSchema>;

/**
 * The whole table of a service's prices by model (S-OFF-04): at least one
 * row, one row per model — a repeated model is refused at its row.
 */
export const offerModelPricesSchema = z
  .array(offerModelPriceInputSchema)
  .min(1)
  .max(OFFER_MODEL_PRICES_MAX)
  .superRefine((rows, context) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.modelId)) {
        context.addIssue({
          code: "custom",
          path: [index, "modelId"],
          message: "This model already has a price in the table",
        });
      }
      seen.add(row.modelId);
    });
  });

/**
 * `POST /supplier/offers`: an offer of the company's pickup point on an
 * active item its type lets it offer (`OFFER_NOT_APPLICABLE` otherwise).
 *
 * - **A part or a product**: `price`, `availability`, `leadDays`, `pickup`
 *   and `delivery` are required (400 at the missing field). The price must
 *   be within the settings `offer_price_min_kzt`…`offer_price_max_kzt`, the
 *   term within `offer_lead_days_max`; `on_order` needs a term of at least
 *   one day; pickup or delivery (or both); pickup needs the address of the
 *   point. `modelPrices` — 400.
 * - **A service** (TASK-019): `price` — one for all models, or
 *   `modelPrices` — a price per model; exactly one of the two (400 at the
 *   other). Each price within the same settings (400 at
 *   `modelPrices.<i>.price`); a model of the table must be one clients can
 *   choose (400 at `modelPrices.<i>.modelId`). No availability, term,
 *   pickup or delivery — 400 at the field given.
 *
 * The warranty is months or a short text, not both.
 */
export const createOfferBodySchema = z.object({
  itemId: z.uuid(),
  price: priceSchema.optional(),
  availability: offerAvailabilitySchema.optional(),
  leadDays: leadDaysSchema.optional(),
  pickup: z.boolean().optional(),
  delivery: z.boolean().optional(),
  modelPrices: offerModelPricesSchema.optional(),
  warrantyMonths: warrantyMonthsSchema.nullable().optional(),
  warrantyText: plainText(OFFER_WARRANTY_TEXT_MAX_LENGTH).nullable().optional(),
  supplierSku: plainText(OFFER_SUPPLIER_SKU_MAX_LENGTH).nullable().optional(),
  supplierName: plainText(OFFER_SUPPLIER_NAME_MAX_LENGTH).nullable().optional(),
});

export type CreateOfferBody = z.infer<typeof createOfferBodySchema>;

const OFFER_EDITABLE_FIELDS = new Set([
  "expectedVersion",
  "price",
  "modelPrices",
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
 *
 * A service (TASK-019): `price` makes it one price for all models,
 * `modelPrices` replaces the whole table of prices by model (and makes it
 * priced by model) — not both at once; the fields a service doesn't have
 * (availability, term, pickup, delivery) — 400. A product: `modelPrices` — 400.
 */
export const updateOfferBodySchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    price: priceSchema.optional(),
    modelPrices: offerModelPricesSchema.optional(),
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
  /** «Услуги» (TASK-019): only offers on services (`services`) or only on goods (`goods`). */
  kind: z.enum(["goods", "services"]).optional(),
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

/** Path of `GET /admin/catalog/items/{itemId}/offers`. */
export const adminItemOffersPathSchema = z.object({ itemId: z.uuid() });

export type AdminItemOffersPath = z.infer<typeof adminItemOffersPathSchema>;

/** An offer of the item as the admin panel shows it: the offer and whose it is. */
export const adminItemOfferSchema = supplierOfferSchema.extend({
  supplier: z.object({ id: z.uuid(), name: z.string() }),
});

export type AdminItemOffer = z.infer<typeof adminItemOfferSchema>;

/**
 * `GET /admin/catalog/items/{itemId}/offers` (SCREENS A-CAT-05 «Предложения»,
 * read only; TASK-035): every offer of the item — on sale first, newest
 * first — with whether the showcase shows it and why not, and the counts
 * the archiving of the item warns about («У позиции N предложений и M
 * активных заявок»).
 */
export const adminItemOffersResponseSchema = z.object({
  itemId: z.uuid(),
  language: catalogLanguageSchema,
  offers: z.array(adminItemOfferSchema),
  /** Offers on sale (active or suspended). */
  onSale: z.number().int(),
  /** Orders still going through over all offers of the item (`activeOrderStatuses`). */
  activeOrders: z.number().int(),
});

export type AdminItemOffersResponse = z.infer<typeof adminItemOffersResponseSchema>;

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

/**
 * `details` of `OFFER_WARRANTY_CONTACTS` (TASK-020.A): what the warranty
 * text gives away — a phone, a link (a site, a handle) or an e-mail. The
 * cabinet explains the rule: the company's name and contacts don't go in
 * the warranty, a user sees them once the order is accepted.
 */
export const offerWarrantyContactsDetailsSchema = z.object({
  found: z.array(z.enum(["phone", "link", "email"])).min(1),
});

export type OfferWarrantyContactsDetails = z.infer<typeof offerWarrantyContactsDetailsSchema>;

/**
 * `details` of `OFFER_NOT_APPLICABLE` (TASK-019): the company's type and the
 * type of the item it can't offer — «Ваша компания выставляет только товары».
 */
export const offerNotApplicableDetailsSchema = z.object({
  supplierType: supplierTypeSchema,
  itemType: z.enum(["part", "generic", "service"]),
});

export type OfferNotApplicableDetails = z.infer<typeof offerNotApplicableDetailsSchema>;

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
    type: z.enum(["part", "generic", "service"]),
    names: z.object({
      kk: z.string().nullable(),
      ru: z.string().nullable(),
      en: z.string().nullable(),
    }),
    article: z.string().nullable(),
    brand: z.string().nullable(),
  }),
  /**
   * The price the order is made at: a service priced by model — the price
   * for the model of the car (`servicePriceForCar`, TASK-019), the model in
   * `vehicleModelId`.
   */
  price: z.number().int(),
  vehicleModelId: z.uuid().nullable().optional(),
  currency: z.literal("KZT"),
  availability: offerAvailabilitySchema,
  leadDays: z.number().int(),
  pickup: z.boolean(),
  delivery: z.boolean(),
  warrantyMonths: z.number().int().nullable(),
  warrantyText: z.string().nullable(),
});

export type OfferSnapshot = z.infer<typeof offerSnapshotSchema>;
