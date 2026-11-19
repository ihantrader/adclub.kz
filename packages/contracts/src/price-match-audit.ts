import { z } from "zod";
import { offerItemSchema } from "./offers";
import { priceImportPersonSchema } from "./price-imports";

/**
 * The administrator's spot check of AI matches of price lists (TASK-065;
 * D-075; SCREENS A-MOD-04, S-MOD-01; ARCHITECTURE 4.94): applied rows where
 * the supplier accepted the item AI chose are put aside — every one below
 * `price_match_audit_always_below`, the share `price_match_audit_share` of
 * the others — and an administrator says «Верно» or «Неверно». «Неверно»
 * removes the company's memory of the row and withdraws the offer on the
 * wrong item (`match_corrected`) unless it was edited by hand since or has
 * active orders; the supplier sees the correction in «Модерация».
 */

export const priceMatchAuditStatusSchema = z.enum(["pending", "correct", "wrong"]);

export type PriceMatchAuditStatus = z.infer<typeof priceMatchAuditStatusSchema>;

/** The confidence buckets of the accuracy: 0,5–0,7 · 0,7–0,85 · 0,85–0,95 · ≥ 0,95. */
export const priceMatchAuditBucketSchema = z.enum(["lt_0_7", "0_7_0_85", "0_85_0_95", "gte_0_95"]);

export type PriceMatchAuditBucketId = z.infer<typeof priceMatchAuditBucketSchema>;

/** Why the row was put aside: below the bound (`below`) or drawn by the share (`share`). */
export const priceMatchAuditReasonSchema = z.enum(["below", "share"]);

/** Why «Неверно» left the offer as it was. */
export const priceMatchAuditKeepReasonSchema = z.enum([
  "no_offer",
  "not_active",
  "edited",
  "active_orders",
]);

export type PriceMatchAuditKeepReason = z.infer<typeof priceMatchAuditKeepReasonSchema>;

/** What «Неверно» did. */
export const priceMatchAuditResultSchema = z.object({
  /** The company's memory of the row's key pointed at the wrong item and was removed. */
  memoryRemoved: z.boolean(),
  offerId: z.uuid().nullable(),
  offerWithdrawn: z.boolean(),
  /** Why the offer stayed; `null` — it was withdrawn. */
  keepReason: priceMatchAuditKeepReasonSchema.nullable(),
  activeOrders: z.number().int(),
});

export type PriceMatchAuditResult = z.infer<typeof priceMatchAuditResultSchema>;

/** The row of the price list as the file said it. */
export const priceMatchAuditRowSchema = z.object({
  article: z.string().nullable(),
  brand: z.string().nullable(),
  name: z.string().nullable(),
  price: z.number().int().nullable(),
  /** A row read off a photo: what the photo said (TASK-064). */
  photoText: z.string().nullable(),
});

export const adminPriceMatchAuditSchema = z.object({
  id: z.uuid(),
  status: priceMatchAuditStatusSchema,
  version: z.number().int(),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  import: z.object({
    id: z.uuid(),
    fileName: z.string().nullable(),
    rowNo: z.number().int(),
    appliedAt: z.iso.datetime().nullable(),
  }),
  row: priceMatchAuditRowSchema,
  /** The item AI chose and the supplier accepted; `null` — it left the catalog. */
  aiItem: offerItemSchema.nullable(),
  aiConfidence: z.number(),
  bucket: priceMatchAuditBucketSchema,
  aiExplanation: z.string().nullable(),
  /** The model that answered; `null` — not known (matched before TASK-065). */
  aiModel: z.string().nullable(),
  reason: priceMatchAuditReasonSchema,
  /** The employee who pressed «Верно», and when. */
  acceptedBy: priceImportPersonSchema.nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  correctItem: offerItemSchema.nullable(),
  notInCatalog: z.boolean(),
  comment: z.string().nullable(),
  result: priceMatchAuditResultSchema.nullable(),
  decidedBy: z.object({ adminId: z.uuid(), name: z.string().nullable() }).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type AdminPriceMatchAudit = z.infer<typeof adminPriceMatchAuditSchema>;

export const priceMatchAuditListQuerySchema = z.object({
  /** Left out — the queue (`pending`). */
  status: priceMatchAuditStatusSchema.default("pending"),
  supplierId: z.uuid().optional(),
  bucket: priceMatchAuditBucketSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

export type PriceMatchAuditListQuery = z.infer<typeof priceMatchAuditListQuerySchema>;

/** The queue is oldest first; decided rows — the latest decision first. */
export const priceMatchAuditPageSchema = z.object({
  audits: z.array(adminPriceMatchAuditSchema),
  /** Rows the filters give in all; the home card «Аудит сопоставлений ждёт · N» is this of the queue. */
  total: z.number().int(),
  /** By status, with the other filters. */
  counts: z.object({
    pending: z.number().int(),
    correct: z.number().int(),
    wrong: z.number().int(),
  }),
  nextCursor: z.string().nullable(),
});

export type PriceMatchAuditPage = z.infer<typeof priceMatchAuditPageSchema>;

export const priceMatchAuditPathSchema = z.object({ auditId: z.uuid() });

export type PriceMatchAuditPath = z.infer<typeof priceMatchAuditPathSchema>;

/** The offer on the wrong item now, and what «Неверно» would do to it. */
export const priceMatchAuditOfferSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "withdrawn", "suspended"]),
  price: z.number().int(),
  activeOrders: z.number().int(),
  editedByHand: z.boolean(),
  willWithdraw: z.boolean(),
  keepReason: priceMatchAuditKeepReasonSchema.nullable(),
});

export const priceMatchAuditCardSchema = z.object({
  audit: adminPriceMatchAuditSchema,
  /** `null` — the row made no offer, or it is gone. */
  offer: priceMatchAuditOfferSchema.nullable(),
  /** Other candidates of the row (the search and AI saw them). */
  candidates: z.array(offerItemSchema),
});

export type PriceMatchAuditCard = z.infer<typeof priceMatchAuditCardSchema>;

/** «Верно». */
export const priceMatchAuditCorrectBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export type PriceMatchAuditCorrectBody = z.infer<typeof priceMatchAuditCorrectBodySchema>;

/**
 * «Неверно…»: the right item (an active part or product), or «Такой позиции
 * нет в справочнике» — exactly one of them; the comment is not required.
 */
export const priceMatchAuditWrongBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  correctItemId: z.uuid().nullable().default(null),
  notInCatalog: z.boolean().default(false),
  comment: z.string().trim().min(1).max(1000).optional(),
});

export type PriceMatchAuditWrongBody = z.infer<typeof priceMatchAuditWrongBodySchema>;

/**
 * `details` of `PRICE_MATCH_AUDIT_CONFLICT` (409): the row was decided (or
 * changed) after the page was loaded; nothing changed.
 */
export const priceMatchAuditConflictDetailsSchema = z.object({
  status: priceMatchAuditStatusSchema,
  version: z.number().int(),
  decidedBy: z.object({ adminId: z.uuid(), name: z.string().nullable() }).nullable(),
  decidedAt: z.iso.datetime().nullable(),
});

export type PriceMatchAuditConflictDetails = z.infer<typeof priceMatchAuditConflictDetailsSchema>;

export const priceMatchAuditMetricsQuerySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30"),
});

export type PriceMatchAuditMetricsQuery = z.infer<typeof priceMatchAuditMetricsQuerySchema>;

/**
 * The accuracy of AI by the administrators' checks of a period (decided in
 * it), by confidence bucket — the data the threshold
 * `price_match_confidence_threshold` is set by; and of the rows AI proposed
 * in price lists applied in the period, how many the suppliers accepted.
 */
export const priceMatchAuditMetricsSchema = z.object({
  days: z.number().int(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  checked: z.number().int(),
  correct: z.number().int(),
  /** `correct / checked`; `null` — nothing checked. */
  accuracy: z.number().nullable(),
  buckets: z.array(
    z.object({
      bucket: priceMatchAuditBucketSchema,
      from: z.number(),
      /** `null` — no upper bound. */
      to: z.number().nullable(),
      checked: z.number().int(),
      correct: z.number().int(),
      accuracy: z.number().nullable(),
    }),
  ),
  proposals: z.object({
    /** Rows of applied price lists where AI chose an item. */
    proposed: z.number().int(),
    /** Of them, the supplier pressed «Верно» on the item AI chose. */
    accepted: z.number().int(),
    acceptedShare: z.number().nullable(),
  }),
  /** `price_match_confidence_threshold` now. */
  threshold: z.number(),
});

export type PriceMatchAuditMetrics = z.infer<typeof priceMatchAuditMetricsSchema>;

// ------------------------------------------- the supplier's «Модерация» (S-MOD-01)

/** A correction of a match of the company's price list, as «Модерация» lists it. */
export const supplierMatchCorrectionSchema = z.object({
  id: z.uuid(),
  row: priceMatchAuditRowSchema,
  importId: z.uuid(),
  /** The item the row was matched to wrongly; `null` — it left the catalog. */
  wrongItem: offerItemSchema.nullable(),
  /** The right one, if the administrator named it. */
  correctItem: offerItemSchema.nullable(),
  notInCatalog: z.boolean(),
  /** The offer on the wrong item was withdrawn (`match_corrected`). */
  offerWithdrawn: z.boolean(),
  decidedAt: z.iso.datetime(),
  isNew: z.boolean(),
});

export type SupplierMatchCorrection = z.infer<typeof supplierMatchCorrectionSchema>;

export const supplierMatchCorrectionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

export type SupplierMatchCorrectionQuery = z.infer<typeof supplierMatchCorrectionQuerySchema>;

export const supplierMatchCorrectionPageSchema = z.object({
  entries: z.array(supplierMatchCorrectionSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type SupplierMatchCorrectionPage = z.infer<typeof supplierMatchCorrectionPageSchema>;
