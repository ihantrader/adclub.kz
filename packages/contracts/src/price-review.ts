import { z } from "zod";
import { adminCatalogItemCardSchema, createCatalogItemBodySchema } from "./catalog-items";
import { supplierCompatibilityProposalSchema } from "./compatibility";
import { offerItemSchema } from "./offers";
import {
  parsedPriceRowSchema,
  priceImportPersonSchema,
  priceImportSchema,
  priceMatchSourceSchema,
  priceRowAvailabilitySchema,
  priceRowErrorSchema,
  priceRowNotAppliedReasonSchema,
} from "./price-imports";

/**
 * The review of a matched price list and its application (TASK-047;
 * ARCHITECTURE 12.1 steps 4–8, 4.67; SCREENS S-PRICE-03, S-PRICE-04 — the
 * screens come with TASK-048), and the requests to add an item the
 * administrator answers (A-MOD-01) and the supplier follows (S-MOD-01).
 *
 * Every change of the review carries the import's `version` it was decided
 * on (`expectedVersion`); another one — a colleague changed it meanwhile —
 * is `PRICE_IMPORT_VERSION_CONFLICT` with who and when, nothing changes.
 */

/** The groups of S-PRICE-03; «Пропали из файла» is not a group of rows (see the missing offers). */
export const priceReviewGroupSchema = z.enum(["confident", "review", "not_found", "errors"]);

export type PriceReviewGroup = z.infer<typeof priceReviewGroupSchema>;

/**
 * The supplier's decision on a row:
 * - `accept` — «Верно»: the item proposed (or one of the candidates, `itemId`);
 * - `other` — «Другая позиция»: an item found by the supplier's search (`itemId`);
 * - `skip` — «Пропустить»: the row is not applied;
 * - `not_in_catalog` — «Нет в справочнике»: like a row not found.
 */
export const priceRowDecisionKindSchema = z.enum(["accept", "other", "skip", "not_in_catalog"]);

export type PriceRowDecisionKind = z.infer<typeof priceRowDecisionKindSchema>;

/**
 * Why a row is where it is, beyond its source: `several_brands` — the
 * article belongs to several items and the brand doesn't decide;
 * `other_brand` — the row's brand has no item with this article;
 * `same_item` — another row of the file (`rowNo`) is matched to the same item.
 */
export const priceRowNoteSchema = z.object({
  code: z.enum(["several_brands", "other_brand", "same_item"]),
  rowNo: z.number().int().nullable(),
});

/** The offer of the company on the row's item now: «было» of «было → стало». */
export const priceRowOfferSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "withdrawn", "suspended"]),
  price: z.number().int(),
  availability: z.enum(["in_stock", "on_order"]),
  leadDays: z.number().int(),
});

/** What happened to a row when the import was applied. */
export const priceRowOutcomeSchema = z.object({
  kind: z.enum([
    "created",
    "updated",
    "unchanged",
    "returned",
    "withdrawn",
    "requested",
    "skipped",
    "not_applied",
  ]),
  reason: priceRowNotAppliedReasonSchema.nullable(),
});

export const priceReviewRowSchema = z.object({
  rowNo: z.number().int(),
  group: priceReviewGroupSchema,
  /** What the file says. */
  parsed: parsedPriceRowSchema.nullable(),
  /** The reading's errors and the matching's (`errors` group). */
  errors: z.array(priceRowErrorSchema),
  source: priceMatchSourceSchema.nullable(),
  /** Matched by the name, not the article: less reliable (ARCHITECTURE 12.2). */
  byName: z.boolean(),
  /** The item the row is matched to (`confident`) or proposed for (`review`); `null` — none. */
  item: offerItemSchema.nullable(),
  /** Up to three candidates to choose from (`review`). */
  candidates: z.array(offerItemSchema),
  /** The item was proposed by AI («предложено ИИ»): applied only after «Верно». */
  aiProposed: z.boolean(),
  /** AI's confidence 0…1 and its short explanation; `null` — AI didn't look at the row. */
  aiConfidence: z.number().nullable(),
  aiExplanation: z.string().nullable(),
  note: priceRowNoteSchema.nullable(),
  /** The company's offer on the item the row would be applied to; `null` — a new one would be created. */
  offer: priceRowOfferSchema.nullable(),
  /**
   * The new price differs from the offer's by more than
   * `price_change_threshold_percent` (D-039, D-052): applied only with
   * «Подтвердить цену».
   */
  sharpPrice: z.boolean(),
  decision: z
    .object({
      kind: priceRowDecisionKindSchema,
      itemId: z.uuid().nullable(),
      by: priceImportPersonSchema,
      at: z.iso.datetime(),
    })
    .nullable(),
  /** «Подтвердить цену» of a sharp change. */
  priceConfirmed: z.boolean(),
  /**
   * A row not found (or decided «Нет в справочнике») goes to the
   * administrator as a request to add the item — on by default.
   */
  sendRequest: z.boolean(),
  /**
   * The administrator refused a request of this row's key before (TASK-048):
   * the reason the supplier sees, and why «Отправить администратору» comes
   * switched off; `null` — no refusal.
   */
  requestRejectReason: z.string().nullable(),
  /** What applying did; `null` until it is applied. */
  outcome: priceRowOutcomeSchema.nullable(),
});

export type PriceReviewRow = z.infer<typeof priceReviewRowSchema>;

export const priceReviewRowsQuerySchema = z.object({
  group: priceReviewGroupSchema,
  /** `true` — only rows without a decision; `false` — only decided ones. */
  decided: z.enum(["true", "false"]).optional(),
  /**
   * Only the rows of the group applying left «не применено» for this reason
   * (S-PRICE-04, TASK-048): the rows behind a line of the result.
   */
  notApplied: priceRowNotAppliedReasonSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(50).optional(),
});

export type PriceReviewRowsQuery = z.infer<typeof priceReviewRowsQuerySchema>;

export const priceReviewRowsPageSchema = z.object({
  rows: z.array(priceReviewRowSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type PriceReviewRowsPage = z.infer<typeof priceReviewRowsPageSchema>;

/** The choice about the offers missing in the file — one for the whole group, with no default. */
export const priceMissingActionSchema = z.enum(["withdraw", "keep"]);

export type PriceMissingAction = z.infer<typeof priceMissingActionSchema>;

/**
 * S-PRICE-03 at a glance: the groups, the missing offers and the numbers of
 * the button «Применить: обновить N · снять M · отправить на добавление K».
 */
export const priceReviewSummarySchema = z.object({
  import: priceImportSchema,
  groups: z.object({
    confident: z.number().int(),
    review: z.number().int(),
    notFound: z.number().int(),
    errors: z.number().int(),
  }),
  /** Active offers of the company (not services) whose items aren't in the file. */
  missing: z.object({
    offers: z.number().int(),
    /** Of them, with orders still going through («их нужно выполнить»). */
    withActiveOrders: z.number().int(),
    action: priceMissingActionSchema.nullable(),
    decidedBy: priceImportPersonSchema.nullable(),
  }),
  /** Rows with a sharp change of the price, and of them those not confirmed yet. */
  sharpPrice: z.object({ rows: z.number().int(), unconfirmed: z.number().int() }),
  /** What applying would do now. */
  preview: z.object({
    update: z.number().int(),
    create: z.number().int(),
    /** Missing offers withdrawn by the choice, and offers withdrawn by «нет в наличии». */
    withdraw: z.number().int(),
    request: z.number().int(),
    /** «N строк не проверены и не будут применены»: rows of «Нужно проверить» without a decision. */
    unchecked: z.number().int(),
    /** Sharp changes not confirmed: they won't be applied. */
    priceConfirmationRequired: z.number().int(),
  }),
  /** Applying is refused until the missing offers have a choice (when there are any). */
  canApply: z.boolean(),
});

export type PriceReviewSummary = z.infer<typeof priceReviewSummarySchema>;

/**
 * A decision on a row. `decision` sets the decision (`null` — clears it);
 * `itemId` is required with `accept` among several candidates and with
 * `other`; `priceConfirmed` — «Подтвердить цену»; `sendRequest` — «Отправить
 * администратору» / «Не отправлять». At least one of them.
 */
export const decidePriceRowBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    decision: priceRowDecisionKindSchema.nullable().optional(),
    itemId: z.uuid().optional(),
    priceConfirmed: z.boolean().optional(),
    sendRequest: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.decision !== undefined ||
      body.priceConfirmed !== undefined ||
      body.sendRequest !== undefined,
    { message: "Give a decision, a price confirmation or the request choice" },
  );

export type DecidePriceRowBody = z.infer<typeof decidePriceRowBodySchema>;

/** `rowNo` — the number of the row as the file numbers it (path parameters are strings). */
export const priceReviewRowPathSchema = z.object({
  importId: z.uuid(),
  rowNo: z.string().regex(/^[1-9]\d{0,8}$/),
});

export type PriceReviewRowPath = z.infer<typeof priceReviewRowPathSchema>;

export const priceRowDecidedResponseSchema = z.object({
  import: priceImportSchema,
  row: priceReviewRowSchema,
});

export type PriceRowDecidedResponse = z.infer<typeof priceRowDecidedResponseSchema>;

/** `expectedVersion` alone: «Пропустить все оставшиеся», «Применить». */
export const priceImportVersionBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export type PriceImportVersionBody = z.infer<typeof priceImportVersionBodySchema>;

export const priceRowsSkippedResponseSchema = z.object({
  import: priceImportSchema,
  /** Rows of «Нужно проверить» skipped now. */
  skipped: z.number().int(),
});

export type PriceRowsSkippedResponse = z.infer<typeof priceRowsSkippedResponseSchema>;

export const choosePriceMissingBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  action: priceMissingActionSchema,
});

export type ChoosePriceMissingBody = z.infer<typeof choosePriceMissingBodySchema>;

export const priceMissingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(100).optional(),
});

export type PriceMissingQuery = z.infer<typeof priceMissingQuerySchema>;

export const priceMissingOfferSchema = z.object({
  offerId: z.uuid(),
  item: offerItemSchema,
  price: z.number().int(),
  availability: priceRowAvailabilitySchema,
  supplierSku: z.string().nullable(),
  /** Orders on it still going through. */
  activeOrders: z.number().int(),
});

export const priceMissingPageSchema = z.object({
  offers: z.array(priceMissingOfferSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type PriceMissingPage = z.infer<typeof priceMissingPageSchema>;

/**
 * `details` of `PRICE_IMPORT_ITEM_UNAVAILABLE` (409): the item chosen for a
 * row can't take it — it is not an active item of a visible subcategory
 * (`unavailable`), it is a service (`service_item`), or the company's type
 * doesn't let it sell it (`supplier_type`).
 */
export const priceImportItemUnavailableDetailsSchema = z.object({
  reason: z.enum(["unavailable", "service_item", "supplier_type"]),
});

export type PriceImportItemUnavailableDetails = z.infer<
  typeof priceImportItemUnavailableDetailsSchema
>;

/**
 * `details` of `PRICE_IMPORT_MISSING_CHOICE` (409): there are offers missing
 * in the file and nobody chose what to do with them.
 */
export const priceImportMissingChoiceDetailsSchema = z.object({
  missing: z.number().int(),
  withActiveOrders: z.number().int(),
});

// ------------------------------------------------------------ requests

/** A request to add an item: waiting, added (or matched to an existing item), refused. */
export const catalogRequestStatusSchema = z.enum(["new", "approved", "rejected"]);

export type CatalogRequestStatus = z.infer<typeof catalogRequestStatusSchema>;

/** What the row of the price list said. */
export const catalogRequestDataSchema = z.object({
  article: z.string().nullable(),
  brand: z.string().nullable(),
  name: z.string().nullable(),
  price: z.number().int().nullable(),
  availability: priceRowAvailabilitySchema.nullable(),
  leadDays: z.number().int().nullable(),
});

/**
 * Where a request came from: a row of a price list (`price_import`), or the
 * form «Нет в справочнике? Отправьте запрос на добавление» (`manual`,
 * S-OFF-05, TASK-048).
 */
export const catalogRequestSourceSchema = z.enum(["price_import", "manual"]);

export type CatalogRequestSource = z.infer<typeof catalogRequestSourceSchema>;

/** The subcategory the supplier suggested for the item (S-OFF-05); the administrator decides. */
export const catalogRequestCategorySchema = z.object({ id: z.uuid(), name: z.string() });

/** The supplier's own request (S-MOD-01, TASK-048). */
export const supplierCatalogRequestSchema = z.object({
  id: z.uuid(),
  status: catalogRequestStatusSchema,
  data: catalogRequestDataSchema,
  importId: z.uuid().nullable(),
  rowNo: z.number().int().nullable(),
  /** The item it became (or was matched to); `null` — not yet, or refused. */
  item: offerItemSchema.nullable(),
  /** Why the administrator refused it: the supplier sees it. */
  rejectReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  // TASK-048.
  source: catalogRequestSourceSchema,
  category: catalogRequestCategorySchema.nullable(),
  comment: z.string().nullable(),
  /**
   * Decided after this employee last opened «Модерация» (S-MOD-01 «новое»):
   * kept for each employee on the server.
   */
  isNew: z.boolean(),
  /** The company's offer on the item it became; `null` — none yet («Выставить»). */
  offer: z
    .object({ id: z.uuid(), status: z.enum(["active", "withdrawn", "suspended"]) })
    .nullable(),
});

export type SupplierCatalogRequest = z.infer<typeof supplierCatalogRequestSchema>;

export const catalogRequestListQuerySchema = z.object({
  status: catalogRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

export type CatalogRequestListQuery = z.infer<typeof catalogRequestListQuerySchema>;

export const supplierCatalogRequestPageSchema = z.object({
  requests: z.array(supplierCatalogRequestSchema),
  nextCursor: z.string().nullable(),
});

export type SupplierCatalogRequestPage = z.infer<typeof supplierCatalogRequestPageSchema>;

/** A request as the administrator sees it (A-MOD-01). */
export const adminCatalogRequestSchema = z.object({
  id: z.uuid(),
  status: catalogRequestStatusSchema,
  version: z.number().int(),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  /** The employee whose price list sent it. */
  createdBy: priceImportPersonSchema.nullable(),
  data: catalogRequestDataSchema,
  /** The brand of the catalog the row's brand is a spelling of; `null` — none known. */
  brand: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  import: z
    .object({
      id: z.uuid(),
      fileName: z.string().nullable(),
      rowNo: z.number().int().nullable(),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  /** The item it became or was matched to. */
  item: offerItemSchema.nullable(),
  rejectReason: z.string().nullable(),
  decidedBy: z.object({ adminId: z.uuid(), name: z.string().nullable() }).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  // TASK-048: «вручную» (S-OFF-05) with what the supplier added.
  source: catalogRequestSourceSchema,
  category: catalogRequestCategorySchema.nullable(),
  comment: z.string().nullable(),
});

export type AdminCatalogRequest = z.infer<typeof adminCatalogRequestSchema>;

export const adminCatalogRequestListQuerySchema = catalogRequestListQuerySchema.extend({
  supplierId: z.uuid().optional(),
  /**
   * TASK-080: a part of the name, the article in any spelling or the brand
   * of the row — 792 requests are searched, not scrolled.
   */
  q: z.string().trim().min(1).max(100).optional(),
  /** TASK-080: the requests of one price list upload. */
  importId: z.uuid().optional(),
  /**
   * TASK-080: only the requests whose article (in any spelling) is already
   * an item of the catalog — «Есть похожая позиция».
   */
  similar: z.literal("true").optional(),
});

export type AdminCatalogRequestListQuery = z.infer<typeof adminCatalogRequestListQuerySchema>;

export const adminCatalogRequestPageSchema = z.object({
  requests: z.array(adminCatalogRequestSchema),
  /** Rows the filters give in all. */
  total: z.number().int(),
  /** By status, with the other filters. */
  counts: z.object({
    new: z.number().int(),
    approved: z.number().int(),
    rejected: z.number().int(),
  }),
  nextCursor: z.string().nullable(),
});

export type AdminCatalogRequestPage = z.infer<typeof adminCatalogRequestPageSchema>;

export const catalogRequestPathSchema = z.object({ requestId: z.uuid() });

export type CatalogRequestPath = z.infer<typeof catalogRequestPathSchema>;

/** A request with the items of the catalog that look like it (the search by its article and name). */
export const adminCatalogRequestResponseSchema = z.object({
  request: adminCatalogRequestSchema,
  similar: z.array(offerItemSchema),
});

export type AdminCatalogRequestResponse = z.infer<typeof adminCatalogRequestResponseSchema>;

/** «Создать позицию»: the item as «Новая позиция» creates it, and the request it answers. */
export const createItemFromRequestBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  item: createCatalogItemBodySchema,
});

export type CreateItemFromRequestBody = z.infer<typeof createItemFromRequestBodySchema>;

export const itemFromRequestResponseSchema = z.object({
  request: adminCatalogRequestSchema,
  item: adminCatalogItemCardSchema,
});

export type ItemFromRequestResponse = z.infer<typeof itemFromRequestResponseSchema>;

/** «Это существующая позиция». */
export const linkCatalogRequestBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  itemId: z.uuid(),
});

export type LinkCatalogRequestBody = z.infer<typeof linkCatalogRequestBodySchema>;

/** «Отклонить»: the reason is required — the supplier sees it. */
export const rejectCatalogRequestBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500),
});

export type RejectCatalogRequestBody = z.infer<typeof rejectCatalogRequestBodySchema>;

export const catalogRequestDecidedResponseSchema = z.object({
  request: adminCatalogRequestSchema,
});

export type CatalogRequestDecidedResponse = z.infer<typeof catalogRequestDecidedResponseSchema>;

/**
 * `details` of `CATALOG_REQUEST_VERSION_CONFLICT` (409): the request was
 * decided (or changed) after the page was loaded; nothing changed.
 */
export const catalogRequestConflictDetailsSchema = z.object({
  status: catalogRequestStatusSchema,
  version: z.number().int(),
  decidedBy: z.object({ adminId: z.uuid(), name: z.string().nullable() }).nullable(),
  decidedAt: z.iso.datetime().nullable(),
});

export type CatalogRequestConflictDetails = z.infer<typeof catalogRequestConflictDetailsSchema>;

// ------------------------------------------- the supplier's own request (S-OFF-05)

/**
 * «Нет в справочнике? Отправьте запрос на добавление» (S-OFF-05, TASK-048):
 * the name is required; the brand (a spelling the suggestions offered, or
 * any text), the article or characteristics, the subcategory the supplier
 * thinks of and a comment are not. Photos — EPIC-26.
 */
export const createCatalogRequestBodySchema = z.object({
  name: z.string().trim().min(2).max(300),
  brand: z.string().trim().min(1).max(100).optional(),
  article: z.string().trim().min(1).max(100).optional(),
  categoryId: z.uuid().optional(),
  comment: z.string().trim().min(1).max(1000).optional(),
});

export type CreateCatalogRequestBody = z.infer<typeof createCatalogRequestBodySchema>;

export const supplierCatalogRequestResponseSchema = z.object({
  request: supplierCatalogRequestSchema,
});

export type SupplierCatalogRequestResponse = z.infer<typeof supplierCatalogRequestResponseSchema>;

/**
 * `details` of `CATALOG_REQUEST_EXISTS` (409): the company already has a
 * request on this article (or this name, without an article) waiting for
 * the administrator; no second one is made.
 */
export const catalogRequestExistsDetailsSchema = z.object({ requestId: z.uuid() });

export type CatalogRequestExistsDetails = z.infer<typeof catalogRequestExistsDetailsSchema>;

// ------------------------------------------------- «Модерация» (S-MOD-01)

/**
 * What the employee hasn't seen of «Модерация» yet (TASK-048): the
 * decisions of the administrator on the company's requests and
 * compatibility proposals made after the employee last opened the section.
 * `serverTime` — what `seenUntil` the screen sends back when it has shown
 * them («просмотрено» is kept on the server, for each employee).
 */
export const supplierModerationSummarySchema = z.object({
  unseen: z.object({
    requests: z.number().int(),
    compatibility: z.number().int(),
    total: z.number().int(),
  }),
  seenAt: z.iso.datetime(),
  serverTime: z.iso.datetime(),
});

export type SupplierModerationSummary = z.infer<typeof supplierModerationSummarySchema>;

/** The decisions shown up to this moment (the `serverTime` of the summary) are seen now. */
export const markModerationSeenBodySchema = z.object({ seenUntil: z.iso.datetime() });

export type MarkModerationSeenBody = z.infer<typeof markModerationSeenBodySchema>;

/** A compatibility proposal of the company with its item, as «Модерация» lists it. */
export const supplierModerationProposalSchema = z.object({
  proposal: supplierCompatibilityProposalSchema,
  /** `null` — the item has left the catalog since. */
  item: offerItemSchema.nullable(),
  isNew: z.boolean(),
});

export type SupplierModerationProposal = z.infer<typeof supplierModerationProposalSchema>;

export const supplierModerationProposalPageSchema = z.object({
  entries: z.array(supplierModerationProposalSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type SupplierModerationProposalPage = z.infer<typeof supplierModerationProposalPageSchema>;

// ------------------------------------------------ brands of the catalog

export const supplierBrandSuggestionsQuerySchema = z.object({
  /** The beginning of any spelling of the brand. */
  q: z.string().trim().min(1).max(100),
});

export type SupplierBrandSuggestionsQuery = z.infer<typeof supplierBrandSuggestionsQuerySchema>;

/** Brands of the catalog by any of their spellings (S-OFF-05 «бренд — подсказки»). */
export const supplierBrandSuggestionsSchema = z.object({
  brands: z.array(z.object({ id: z.uuid(), name: z.string(), matched: z.string() })),
});

export type SupplierBrandSuggestions = z.infer<typeof supplierBrandSuggestionsSchema>;

// --------------------------------------------- «Скачать мой прайс» (S-PRICE-01)

/**
 * Which offers go into the export: those on sale (the default), or the
 * withdrawn ones too. Services never do — their prices are by model.
 */
export const createPriceExportBodySchema = z.object({
  include: z.enum(["on_sale", "all"]).default("on_sale"),
});

export type CreatePriceExportBody = z.infer<typeof createPriceExportBodySchema>;

/**
 * A link to download the export (TASK-048; ARCHITECTURE 12.4): the file is
 * written while it is downloaded, straight from the offers; the link is the
 * employee's and works for a short while (`expiresAt`).
 */
export const priceExportLinkSchema = z.object({
  /** The address of the API to open (relative to it), with a signed token in the query. */
  url: z.string(),
  fileName: z.string(),
  expiresAt: z.iso.datetime(),
  /** How many offers the file holds. */
  offers: z.number().int(),
});

export type PriceExportLink = z.infer<typeof priceExportLinkSchema>;
