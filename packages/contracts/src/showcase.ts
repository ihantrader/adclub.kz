import { z } from "zod";
import { attributeValueTypeSchema, catalogLanguageSchema, localizedTextSchema } from "./catalog";
import { itemPhotoImageSchema } from "./catalog-photos";
import {
  compatibilityConditionsLabelSchema,
  compatibilityItemResultSchema,
  resolvedCompatibilityVehicleSchema,
} from "./compatibility";
import { offerAvailabilitySchema } from "./offers";

/**
 * The catalog for users (PRODUCT 6.3, 7.5, 7.8, 9, 9.1; SCREENS M-CAT-02,
 * M-CAT-03, M-CAT-07; ARCHITECTURE 4.29; TASK-020): the items of a
 * subcategory and the card of an item with the offers of suppliers.
 * Open to guests; a user's session (optional) decides what the offers
 * say about their suppliers:
 *
 * - without club access (a guest, or a user who has none) an offer has no
 *   supplier's name, id, district or address at all — the fields are
 *   absent, not empty; `supplier.kind` is `hidden` («Поставщик клуба»)
 *   with the reason (`auth_required` for a guest, `subscription_required`
 *   for a user) — D-005, PRODUCT 9;
 * - with club access — the supplier's name and id, and the district and
 *   the address of the pickup point (D-030). The phone and the hours never
 *   (they come after an order is accepted, D-026, EPIC-08).
 *
 * Only offers users may see are ever shown (the showcase rule of TASK-018
 * with the pickup point's hours, D-060); every one has its receipt date.
 * An answer to a guest may be kept by any cache for a minute; an answer to
 * a session only by that client (`Cache-Control: private, no-store`), and
 * every answer `Vary`s on `Authorization` — one role's answer never
 * reaches another.
 */

export const SHOWCASE_PAGE_MAX_SIZE = 50;
export const SHOWCASE_PAGE_DEFAULT_SIZE = 20;
/** Brands a list may be filtered by at once. */
export const SHOWCASE_BRAND_FILTER_MAX = 50;
/** Attributes a list may be filtered by at once. */
export const SHOWCASE_ATTRIBUTE_FILTER_MAX = 20;
/** Options of one list attribute in a filter. */
export const SHOWCASE_OPTION_FILTER_MAX = 50;
/** Key characteristics shown on the card of an item in a list («5W-30 · 4 л»). */
export const SHOWCASE_KEY_ATTRIBUTES = 2;
/** Analogs on the card of an item. */
export const SHOWCASE_ANALOGS_MAX = 20;

const booleanQuery = z.enum(["true", "false"]);
const yearQuery = z.coerce.number().int().min(1900).max(2100);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Must be YYYY-MM-DD" });

/**
 * The car in a query (as the compatibility check takes it, TASK-015): a
 * whole modification or only the known levels. Nothing is stored: a guest's
 * car travels with each request (ARCHITECTURE 8.4).
 */
const vehicleQueryShape = {
  vehicleModificationId: z.uuid().optional(),
  vehicleMakeId: z.uuid().optional(),
  vehicleModelId: z.uuid().optional(),
  vehicleGenerationId: z.uuid().optional(),
  vehicleBodyTypeId: z.uuid().optional(),
  vehicleEngineId: z.uuid().optional(),
  vehicleTransmissionTypeId: z.uuid().optional(),
  vehicleDriveTypeId: z.uuid().optional(),
  vehicleYear: yearQuery.optional(),
};

/**
 * A filter by one characteristic of the subcategory (M-CAT-03), as the
 * description of its filters gives it (`GET /catalog/categories/{id}/attributes`):
 * a list — `optionIds` (any of them); a number — `min` and/or `max`
 * (inclusive); yes/no — `value`. An item without a value of the attribute
 * never passes its filter. An attribute that isn't an active filterable
 * one of the subcategory (archived since, or of another subcategory)
 * filters nothing.
 */
export const showcaseAttributeFilterSchema = z
  .object({
    attributeId: z.uuid(),
    optionIds: z.array(z.uuid()).min(1).max(SHOWCASE_OPTION_FILTER_MAX).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    value: z.boolean().optional(),
  })
  .refine(
    (filter) =>
      [
        filter.optionIds !== undefined,
        filter.min !== undefined || filter.max !== undefined,
        filter.value !== undefined,
      ].filter(Boolean).length === 1,
    { message: "Give exactly one of optionIds, min/max or value" },
  )
  .refine(
    (filter) => filter.min === undefined || filter.max === undefined || filter.min <= filter.max,
    { message: "min must not be above max" },
  );

export type ShowcaseAttributeFilter = z.infer<typeof showcaseAttributeFilterSchema>;

/** The attribute filters of a query: a JSON array in one parameter (`attributes=[{…}]`). */
const attributeFiltersQuery = z
  .string()
  .max(8000)
  .transform((text, context) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "Must be a JSON array of attribute filters" });
      return z.NEVER;
    }
  })
  .pipe(z.array(showcaseAttributeFilterSchema).max(SHOWCASE_ATTRIBUTE_FILTER_MAX));

/** Brand ids separated by commas. */
const brandIdsQuery = z
  .string()
  .max(40 * SHOWCASE_BRAND_FILTER_MAX)
  .transform((text) =>
    text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(z.uuid()).min(1).max(SHOWCASE_BRAND_FILTER_MAX));

/**
 * `recommended` — «Рекомендуемые», the default: not the price alone — the
 * price, the receipt date, an offer in the chosen city, a verified partner
 * and (when ratings exist) the rating, by the weights of the setting
 * `catalog_recommended_weights` (ARCHITECTURE 4.29); `cheaper` — the
 * lowest price first; `faster` — the nearest receipt date first.
 */
export const showcaseListSortSchema = z.enum(["recommended", "cheaper", "faster"]);

export type ShowcaseListSort = z.infer<typeof showcaseListSortSchema>;

/** The offers of a card: the list's orders and `rating` (until ratings exist — as `recommended`). */
export const showcaseOfferSortSchema = z.enum(["recommended", "cheaper", "faster", "rating"]);

export type ShowcaseOfferSort = z.infer<typeof showcaseOfferSortSchema>;

export const showcaseCategoryPathSchema = z.object({ categoryId: z.uuid() });

export type ShowcaseCategoryPath = z.infer<typeof showcaseCategoryPathSchema>;

/**
 * `GET /catalog/categories/{categoryId}/items` (M-CAT-02, M-CAT-03).
 * `cityId` — the chosen city; left out — «весь Казахстан». Goods are
 * shown from the whole country, those with an offer in the chosen city
 * first under «Рекомендуемые»; `onlyMyCity=true` keeps only items with an
 * offer there. Services are only ever shown by the chosen city.
 * `availability` and `receiving` filter the offers: an item is listed when
 * at least one of its offers passes every offer filter, and its price,
 * count and date are those of such offers. Pages by `cursor` =
 * `nextCursor` with the same query.
 */
export const showcaseListQuerySchema = z.object({
  cityId: z.uuid().optional(),
  onlyMyCity: booleanQuery.optional(),
  ...vehicleQueryShape,
  availability: offerAvailabilitySchema.optional(),
  receiving: z.enum(["pickup", "delivery"]).optional(),
  brandIds: brandIdsQuery.optional(),
  attributes: attributeFiltersQuery.optional(),
  sort: showcaseListSortSchema.optional(),
  limit: z.coerce.number().int().min(1).max(SHOWCASE_PAGE_MAX_SIZE).optional(),
  cursor: z.string().min(1).max(500).optional(),
});

export type ShowcaseListQuery = z.infer<typeof showcaseListQuerySchema>;

export const showcaseItemPathSchema = z.object({ itemId: z.uuid() });

export type ShowcaseItemPath = z.infer<typeof showcaseItemPathSchema>;

/** `GET /catalog/items/{itemId}` (M-CAT-07): the chosen city, the car, the order of the offers. */
export const showcaseItemQuerySchema = z.object({
  cityId: z.uuid().optional(),
  ...vehicleQueryShape,
  sort: showcaseOfferSortSchema.optional(),
});

export type ShowcaseItemQuery = z.infer<typeof showcaseItemQuerySchema>;

/** Who is asking, as far as the catalog cares (the client decides what «Оформить» leads to). */
export const showcaseViewerSchema = z.object({
  signedIn: z.boolean(),
  clubAccess: z.boolean(),
});

export type ShowcaseViewer = z.infer<typeof showcaseViewerSchema>;

export const showcaseCitySchema = z.object({
  id: z.uuid(),
  name: localizedTextSchema,
});

export type ShowcaseCity = z.infer<typeof showcaseCitySchema>;

export const showcaseBrandSchema = z.object({ id: z.uuid(), name: z.string() });

/**
 * The date a user gets the item if the order is confirmed now (the one
 * `receiptDate` of TASK-018): `date` in the time zone of the pickup point,
 * `confirmedOn` — today there (for «сегодня», «завтра»). The same date
 * holds for pickup («Самовывоз: завтра, 14 марта») and delivery
 * («Доставка: до 14 марта»): an offer has one term.
 */
export const showcaseReceiptSchema = z.object({
  date: dateSchema,
  confirmedOn: dateSchema,
  timeZone: z.string(),
});

export type ShowcaseReceipt = z.infer<typeof showcaseReceiptSchema>;

/** A characteristic in words: the option's name, the number with its unit, yes/no, the text. */
export const showcaseAttributeValueSchema = z.object({
  attributeId: z.uuid(),
  code: z.string(),
  name: localizedTextSchema,
  valueType: attributeValueTypeSchema,
  /** The value as shown («5W-30», «4 л», «Да»). */
  display: localizedTextSchema,
});

export type ShowcaseAttributeValue = z.infer<typeof showcaseAttributeValueSchema>;

/** What the visible offers of an item add up to (for a list card and an analog). */
export const showcaseOfferSummarySchema = z.object({
  /** Visible offers that pass the offer filters. */
  count: z.number().int(),
  /** Whole tenge: the lowest price of those offers («от 12 500 ₸»). */
  minPrice: z.number().int(),
  currency: z.literal("KZT"),
  /** The nearest receipt date among them («Завтра»). */
  nearestReceipt: showcaseReceiptSchema,
  /** At least one of them is in the chosen city («Есть в {город}»); `false` without a city. */
  inCity: z.boolean(),
  /** At least one of them is in stock. */
  inStock: z.boolean(),
});

export type ShowcaseOfferSummary = z.infer<typeof showcaseOfferSummarySchema>;

/** An item of a list (M-CAT-02). */
export const showcaseListItemSchema = z.object({
  id: z.uuid(),
  type: z.enum(["part", "generic", "service"]),
  name: localizedTextSchema,
  brand: showcaseBrandSchema.nullable(),
  article: z.string().nullable(),
  /** The approved primary photo (thumbnail and card size); `null` — show the placeholder. */
  photo: itemPhotoImageSchema.nullable(),
  /**
   * At most two characteristics, in the subcategory's order: its active
   * filterable attributes the item has a value of («5W-30 · API SP»).
   */
  keyAttributes: z.array(showcaseAttributeValueSchema).max(SHOWCASE_KEY_ATTRIBUTES),
  /** The compatibility with the car, and the mark to show (TASK-015; without a car — per D-029). */
  compatibility: compatibilityItemResultSchema,
  offers: showcaseOfferSummarySchema,
});

export type ShowcaseListItem = z.infer<typeof showcaseListItemSchema>;

/**
 * Why a list is empty: `vehicle` — nothing for this car («Для {автомобиль}
 * здесь пока ничего нет»; without the car there would be); `filters` —
 * the filters leave nothing («Сбросить фильтры»); `city_required` — a
 * service subcategory is shown by the chosen city only; `no_items` —
 * nothing of the subcategory is on offer at all.
 */
export const showcaseEmptyReasonSchema = z.enum([
  "vehicle",
  "filters",
  "city_required",
  "no_items",
]);

export type ShowcaseEmptyReason = z.infer<typeof showcaseEmptyReasonSchema>;

export const showcaseListResponseSchema = z.object({
  language: catalogLanguageSchema,
  category: z.object({
    id: z.uuid(),
    kind: z.enum(["goods", "services"]),
    name: localizedTextSchema,
    compatibilityRequired: z.boolean(),
  }),
  /** The chosen city; `null` — «весь Казахстан». */
  city: showcaseCitySchema.nullable(),
  /** The car as understood; `null` — none chosen. */
  vehicle: resolvedCompatibilityVehicleSchema.nullable(),
  viewer: showcaseViewerSchema,
  items: z.array(showcaseListItemSchema),
  /** Every item the query finds, over all pages («Показать N позиций»). */
  total: z.number().int(),
  /** `null` unless `total` is 0. */
  empty: showcaseEmptyReasonSchema.nullable(),
  /**
   * The brands of the items shown for this city and car before the other
   * filters, with how many items each — the brand section of M-CAT-03.
   */
  brands: z.array(showcaseBrandSchema.extend({ count: z.number().int() })),
  nextCursor: z.string().nullable(),
});

export type ShowcaseListResponse = z.infer<typeof showcaseListResponseSchema>;

/**
 * The supplier of an offer as the viewer may see it. `hidden` — without
 * club access: «Поставщик клуба»; there is nothing else in it, by design
 * (D-005). `visible` — with club access: the name and the pickup point's
 * district and address (D-030); never the phone or the hours.
 */
export const showcaseOfferSupplierSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hidden"),
    /** `auth_required` — a guest (sign in); `subscription_required` — a user without club access. */
    reason: z.enum(["auth_required", "subscription_required"]),
  }),
  z.object({
    kind: z.literal("visible"),
    id: z.uuid(),
    name: z.string(),
    district: z.string().nullable(),
    address: z.string().nullable(),
  }),
]);

export type ShowcaseOfferSupplier = z.infer<typeof showcaseOfferSupplierSchema>;

/** An offer on the card of an item (M-CAT-07). */
export const showcaseOfferSchema = z.object({
  /** The offer (what an order will name, EPIC-08); tells nothing about the supplier. */
  id: z.uuid(),
  price: z.number().int(),
  currency: z.literal("KZT"),
  availability: offerAvailabilitySchema,
  /** Working days from the confirmation. The user is shown `receipt.date`, not this. */
  leadDays: z.number().int(),
  pickup: z.boolean(),
  delivery: z.boolean(),
  receipt: showcaseReceiptSchema,
  /** The warranty in months, for every viewer. */
  warrantyMonths: z.number().int().nullable(),
  /**
   * The supplier's own words on the warranty — only with club access, as
   * the supplier's name (TASK-020.A, D-005): a free text could name the
   * supplier to anyone else. Without club access the field is absent;
   * with it, `null` — no text.
   */
  warrantyText: z.string().nullable().optional(),
  /** The city of the pickup point. */
  city: showcaseCitySchema,
  /** The offer is in the chosen city («В вашем городе»). */
  inCity: z.boolean(),
  /** «Проверенный партнёр». */
  verifiedPartner: z.boolean(),
  /** The supplier's rating; `null` until ratings exist (EPIC-19). */
  rating: z.object({ value: z.number(), count: z.number().int() }).nullable(),
  /** «Новый поставщик» — no rating to show yet. */
  newSupplier: z.boolean(),
  supplier: showcaseOfferSupplierSchema,
});

export type ShowcaseOffer = z.infer<typeof showcaseOfferSchema>;

/** An analog on the card, as a link (only analogs with visible offers). */
export const showcaseAnalogSchema = z.object({
  id: z.uuid(),
  name: localizedTextSchema,
  brand: showcaseBrandSchema.nullable(),
  article: z.string().nullable(),
  photo: itemPhotoImageSchema.nullable(),
  compatibility: compatibilityItemResultSchema,
  offers: showcaseOfferSummarySchema,
});

export type ShowcaseAnalog = z.infer<typeof showcaseAnalogSchema>;

export const showcaseItemResponseSchema = z.object({
  language: catalogLanguageSchema,
  city: showcaseCitySchema.nullable(),
  vehicle: resolvedCompatibilityVehicleSchema.nullable(),
  viewer: showcaseViewerSchema,
  item: z.object({
    id: z.uuid(),
    type: z.enum(["part", "generic", "service"]),
    name: localizedTextSchema,
    brand: showcaseBrandSchema.nullable(),
    article: z.string().nullable(),
    category: z.object({
      id: z.uuid(),
      name: localizedTextSchema,
      parentName: localizedTextSchema.nullable(),
      compatibilityRequired: z.boolean(),
    }),
    /** Approved photos in their order, the primary first; empty — the placeholder. */
    photos: z.array(itemPhotoImageSchema),
    /** Characteristics that have a value, in the subcategory's order (empty ones are left out). */
    attributes: z.array(showcaseAttributeValueSchema),
  }),
  /**
   * The result for the car and how to show it (TASK-015): opened directly,
   * an item that doesn't fit is still shown, `requiresConfirmation: true`.
   */
  compatibility: compatibilityItemResultSchema,
  /** «Подходит для»: the approved records in words. */
  fitsFor: z.array(compatibilityConditionsLabelSchema),
  offers: z.array(showcaseOfferSchema),
  /** «Сейчас нет предложений» (D-031): opened by a link or from history. */
  noOffers: z.boolean(),
  analogs: z.array(showcaseAnalogSchema).max(SHOWCASE_ANALOGS_MAX),
});

export type ShowcaseItemResponse = z.infer<typeof showcaseItemResponseSchema>;
