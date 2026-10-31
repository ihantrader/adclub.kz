import { z } from "zod";

/**
 * A supplier's card subscription, as the cabinet (S-BILL-01) and the
 * administrator see it (EPIC-14, TASK-042; PRODUCT 14.1, 14.3; ARCHITECTURE
 * 9.4.2, 18.5, 4.77).
 *
 * **The card's number, term and code never pass through our server.** The
 * cabinet sends the person to the payment provider's own page
 * (`POST /supplier/billing/card-bindings` gives the address) and the
 * provider hands us a token; what the cabinet shows of the card is the mask
 * (the last four digits), the brand and the term the provider told. The
 * token itself is a secret kept sealed and is in no answer.
 */

/** Statuses of a supplier's subscription (the machine of `@adclub/domain`). */
export const supplierSubscriptionStatusSchema = z.enum([
  "active",
  "past_due",
  "cancelled",
  "suspended",
  "expired",
]);

export type SupplierSubscriptionStatus = z.infer<typeof supplierSubscriptionStatusSchema>;

/**
 * Why a bank refused a charge, in our words (the provider's own codes are
 * mapped to these in one place, `payment-provider.ts`): the cabinet says it
 * in words, the administrator sees it in the list.
 */
export const paymentDeclineReasonSchema = z.enum([
  "insufficient_funds",
  "card_expired",
  "card_blocked",
  "invalid_card",
  "do_not_honor",
  "declined_other",
]);

export type PaymentDeclineReason = z.infer<typeof paymentDeclineReasonSchema>;

export const paymentCardBrandSchema = z.enum(["visa", "mastercard", "other"]);

export type PaymentCardBrand = z.infer<typeof paymentCardBrandSchema>;

/** The linked card as it is shown: «•••• 4242». */
export const supplierPaymentCardSchema = z.object({
  /** The last four digits. */
  mask: z.string().regex(/^[0-9]{4}$/),
  brand: paymentCardBrandSchema,
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
  /** The term of the card has passed: the next charge will be refused. */
  expired: z.boolean(),
  linkedAt: z.iso.datetime(),
});

export type SupplierPaymentCard = z.infer<typeof supplierPaymentCardSchema>;

/**
 * What a charge was for: `first` — the charge that linked the card;
 * `scheduled` — the end of a term; `retry` — the daily retry after a
 * refusal; `manual` — «Оплатить сейчас».
 */
export const supplierChargeKindSchema = z.enum(["first", "scheduled", "retry", "manual"]);

export type SupplierChargeKind = z.infer<typeof supplierChargeKindSchema>;

/**
 * `in_progress` — the provider hasn't said yet (it was unavailable or its
 * answer was lost): not a failure of the payer, retried in an hour.
 */
export const supplierChargeOutcomeSchema = z.enum(["succeeded", "declined", "in_progress"]);

export type SupplierChargeOutcome = z.infer<typeof supplierChargeOutcomeSchema>;

/** One line of the history of charges (S-BILL-01). */
export const supplierChargeSchema = z.object({
  id: z.uuid(),
  kind: supplierChargeKindSchema,
  outcome: supplierChargeOutcomeSchema,
  /** `declined` only. */
  declineReason: paymentDeclineReasonSchema.nullable(),
  amount: z.number().int(),
  currency: z.literal("KZT"),
  /** The term this charge pays: from where it began to where it ends. */
  periodFrom: z.iso.datetime(),
  periodTo: z.iso.datetime(),
  /** When it was made. */
  at: z.iso.datetime(),
  /** When the answer came; `null` while `in_progress`. */
  resolvedAt: z.iso.datetime().nullable(),
  /** `in_progress`: when it will be tried again. */
  retryAt: z.iso.datetime().nullable(),
});

export type SupplierCharge = z.infer<typeof supplierChargeSchema>;

export const supplierChargesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(200).optional(),
});

export type SupplierChargesQuery = z.infer<typeof supplierChargesQuerySchema>;

export const supplierChargePageSchema = z.object({
  charges: z.array(supplierChargeSchema),
  nextCursor: z.string().nullable(),
});

export type SupplierChargePage = z.infer<typeof supplierChargePageSchema>;

/**
 * The subscription as the cabinet needs it for S-BILL-01.
 *
 * - `nextChargeAt` — when the card will be charged by itself: an active
 *   subscription at the end of its term (at `billing_notify_hour`), a
 *   subscription after a refusal at the next daily run if retries are left;
 *   `null` — nothing is planned (suspended, or the retries are over);
 * - `lastDecline` — the latest refusal of the bank in the current term.
 */
export const supplierSubscriptionSummarySchema = z.object({
  status: supplierSubscriptionStatusSchema,
  periodEnd: z.iso.datetime(),
  /** The end of the retries (`past_due`); `null` otherwise. */
  graceUntil: z.iso.datetime().nullable(),
  /** What the next term costs: the tariff in effect at the end of this one. */
  amount: z.number().int().nullable(),
  nextChargeAt: z.iso.datetime().nullable(),
  lastDecline: z.object({ at: z.iso.datetime(), reason: paymentDeclineReasonSchema }).nullable(),
});

export type SupplierSubscriptionSummary = z.infer<typeof supplierSubscriptionSummarySchema>;

/** How a trip to the provider's page stands. */
export const cardBindingStatusSchema = z.enum([
  "pending",
  "card_received",
  "charging",
  "completed",
  "declined",
  "failed",
  "abandoned",
]);

export type CardBindingStatus = z.infer<typeof cardBindingStatusSchema>;

/** Why a binding ended without a card: a refusal of the bank, or one of ours. */
export const cardBindingFailureSchema = z.union([
  paymentDeclineReasonSchema,
  z.enum(["provider_unavailable", "cancelled", "expired"]),
]);

export type CardBindingFailure = z.infer<typeof cardBindingFailureSchema>;

export const supplierCardBindingSchema = z.object({
  id: z.uuid(),
  status: cardBindingStatusSchema,
  /** `declined`, `failed`, `abandoned`: why. */
  failure: cardBindingFailureSchema.nullable(),
  /** `completed`: the card now linked. */
  card: supplierPaymentCardSchema.nullable(),
  /** The company has a subscription this card pays for, as of now. */
  subscriptionStatus: supplierSubscriptionStatusSchema.nullable(),
  startedAt: z.iso.datetime(),
  /** The page is no use after this. */
  expiresAt: z.iso.datetime(),
});

export type SupplierCardBinding = z.infer<typeof supplierCardBindingSchema>;

/**
 * `POST /supplier/billing/card-bindings` — «Привязать карту» / «Сменить
 * карту». `returnUrl` is where the provider sends the browser back to; it
 * must be an address of the cabinet itself (`SUPPLIER_WEB_ORIGINS`).
 */
export const startCardBindingBodySchema = z.object({
  returnUrl: z.url().max(500),
});

export type StartCardBindingBody = z.infer<typeof startCardBindingBodySchema>;

export const startCardBindingResponseSchema = z.object({
  binding: supplierCardBindingSchema,
  /** The provider's page: the cabinet navigates the browser there. */
  redirectUrl: z.string(),
});

export type StartCardBindingResponse = z.infer<typeof startCardBindingResponseSchema>;

export const cardBindingPathSchema = z.object({ bindingId: z.uuid() });

export type CardBindingPath = z.infer<typeof cardBindingPathSchema>;

export const cardBindingResponseSchema = z.object({ binding: supplierCardBindingSchema });

export type CardBindingResponse = z.infer<typeof cardBindingResponseSchema>;

/**
 * `POST /supplier/billing/pay` — «Оплатить сейчас». No body: what is paid
 * is the term the subscription owes. Two employees pressing it at once get
 * the same charge back.
 */
export const payNowResponseSchema = z.object({ charge: supplierChargeSchema });

export type PayNowResponse = z.infer<typeof payNowResponseSchema>;

/** The two pauses of a company (the card of a supplier shows the same). */
export const supplierPausesFlagsSchema = z.object({
  admin: z.boolean(),
  billing: z.boolean(),
});

export type SupplierPausesFlags = z.infer<typeof supplierPausesFlagsSchema>;

/**
 * What the cabinet can do about the money now.
 *
 * - `canPayNow` — a card is linked and the subscription owes a term;
 * - `inProgress` — a charge is waiting for the provider;
 * - `canStart` — there is a tariff to start a subscription with (without one
 *   «Привязать карту» is refused — the administrator has been told).
 */
export const supplierPaymentActionsSchema = z.object({
  canPayNow: z.boolean(),
  inProgress: z.boolean(),
  canStart: z.boolean(),
});

export type SupplierPaymentActions = z.infer<typeof supplierPaymentActionsSchema>;

/** `GET /admin/suppliers/{id}/billing` (A-SUP-03): the card, the charges, both pauses. */
export const adminSupplierPausesSchema = z.object({
  admin: z.object({ note: z.string().nullable(), since: z.iso.datetime() }).nullable(),
  billing: z.object({ since: z.iso.datetime() }).nullable(),
});

export type AdminSupplierPauses = z.infer<typeof adminSupplierPausesSchema>;
