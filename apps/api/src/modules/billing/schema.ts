import type { PaymentDeclineReason } from "@adclub/contracts";
import type {
  SubscriptionAudience,
  SubscriptionEventKind,
  SubscriptionStatus,
} from "@adclub/domain";
import { integer, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { subscription, type SubscriptionProviderName, type SubscriptionRow } from "../club-access";
import { account, supplier } from "../identity";

/**
 * Drizzle mirrors of the subscriptions' tables (`…_subscriptions.sql` — the
 * source of truth with the checks; ARCHITECTURE 5.10, 4.72; TASK-040).
 */

/** `plan`: a tariff with dates; a rise is a new record. */
export const plan = pgTable("plan", {
  id: uuid("id").primaryKey().defaultRandom(),
  audience: text("audience").$type<SubscriptionAudience>().notNull(),
  code: text("code").notNull(),
  price: integer("price").notNull(),
  currency: text("currency").$type<"KZT">().notNull().default("KZT"),
  period: text("period").$type<"month">().notNull().default("month"),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  announceBeforeDays: integer("announce_before_days").notNull(),
  reason: text("reason").notNull(),
  createdByRole: text("created_by_role").$type<"operator" | "admin">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** A planned change cancelled before it started (TASK-043): kept as history, read by nobody else. */
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByRole: text("cancelled_by_role").$type<"operator" | "admin">(),
  cancelReason: text("cancel_reason"),
});

export type PlanRow = typeof plan.$inferSelect;

/**
 * `subscription` is described by the club access module, beside the grants
 * (it is the other source `ClubAccess` reads); this module writes it.
 */
export { subscription };
export type { SubscriptionProviderName, SubscriptionRow };

export type BillingEventSource = "provider" | "operator" | "system";
export type BillingEventOutcome = "pending" | "applied" | "no_effect" | "refused";

/** The event in our general words, as `billing_event.payload` keeps it. */
export interface BillingEventPayload {
  periodEnd?: string;
  graceUntil?: string;
  platform?: "ios" | "android";
}

/** `billing_event`: every event that moves a subscription, and what it did. */
export const billingEvent = pgTable("billing_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").$type<SubscriptionProviderName | "system">().notNull(),
  providerEventId: text("provider_event_id").notNull(),
  source: text("source").$type<BillingEventSource>().notNull(),
  kind: text("kind").$type<SubscriptionEventKind>().notNull(),
  providerRef: text("provider_ref"),
  accountId: uuid("account_id").references(() => account.id),
  supplierId: uuid("supplier_id").references(() => supplier.id),
  subscriptionId: uuid("subscription_id").references(() => subscription.id),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").$type<BillingEventPayload>().notNull().default({}),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  outcome: text("outcome").$type<BillingEventOutcome>().notNull().default("pending"),
  detail: text("detail"),
  fromStatus: text("from_status").$type<SubscriptionStatus>(),
  toStatus: text("to_status").$type<SubscriptionStatus>(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});

export type BillingEventRow = typeof billingEvent.$inferSelect;

/** Which processor a card and its charges belong to. */
export type PaymentProviderName = "card_kz" | "test";

export type CardBrand = "visa" | "mastercard" | "other";

/**
 * `payment_method` (TASK-042, ARCHITECTURE 4.77): the card a company's
 * subscription is charged to. The provider's token is sealed (AES-256-GCM,
 * bound to the row's id); the mask, brand and term are what the provider
 * told us and what the cabinet shows. **This table is the only place a card
 * is linked or taken off**, and `supplier.card_linked_at` follows it.
 */
export const paymentMethod = pgTable("payment_method", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  provider: text("provider").$type<PaymentProviderName>().notNull(),
  tokenSealed: text("token_sealed").notNull(),
  mask: text("mask").notNull(),
  brand: text("brand").$type<CardBrand>().notNull(),
  expMonth: smallint("exp_month").notNull(),
  expYear: smallint("exp_year").notNull(),
  status: text("status").$type<"active" | "replaced" | "removed">().notNull().default("active"),
  bindingId: uuid("binding_id"),
  linkedByMemberId: uuid("linked_by_member_id"),
  detachedAt: timestamp("detached_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  replacedAt: timestamp("replaced_at", { withTimezone: true }),
});

export type PaymentMethodRow = typeof paymentMethod.$inferSelect;

export type CardBindingStatusValue =
  "pending" | "card_received" | "charging" | "completed" | "declined" | "failed" | "abandoned";

/** `card_binding`: a company's trip to the provider's page and back. */
export const cardBinding = pgTable("card_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  provider: text("provider").$type<PaymentProviderName>().notNull(),
  providerRef: text("provider_ref").notNull(),
  returnUrl: text("return_url").notNull(),
  redirectUrl: text("redirect_url"),
  status: text("status").$type<CardBindingStatusValue>().notNull().default("pending"),
  failure: text("failure"),
  startedByMemberId: uuid("started_by_member_id"),
  cardTokenSealed: text("card_token_sealed"),
  cardMask: text("card_mask"),
  cardBrand: text("card_brand").$type<CardBrand>(),
  cardExpMonth: smallint("card_exp_month"),
  cardExpYear: smallint("card_exp_year"),
  paymentMethodId: uuid("payment_method_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CardBindingRow = typeof cardBinding.$inferSelect;

export type PaymentAttemptKind = "first" | "scheduled" | "retry" | "manual";
export type PaymentAttemptStatus =
  "created" | "unavailable" | "unknown" | "succeeded" | "declined" | "cancelled";

/** The attempts that are not over: at most one per period (a unique index). */
export const openAttemptStatuses = ["created", "unavailable", "unknown"] as const;

/**
 * `payment_attempt`: one charge at the provider under one idempotency key.
 * The database keeps «not twice for a period»: one success and one attempt in
 * flight per `period_key`.
 */
export const paymentAttempt = pgTable("payment_attempt", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  subscriptionId: uuid("subscription_id").references(() => subscription.id),
  bindingId: uuid("binding_id").references(() => cardBinding.id),
  paymentMethodId: uuid("payment_method_id").references(() => paymentMethod.id),
  planId: uuid("plan_id").references(() => plan.id),
  kind: text("kind").$type<PaymentAttemptKind>().notNull(),
  periodKey: text("period_key").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").$type<"KZT">().notNull().default("KZT"),
  periodFrom: timestamp("period_from", { withTimezone: true }).notNull(),
  periodTo: timestamp("period_to", { withTimezone: true }).notNull(),
  anchorDay: smallint("anchor_day").notNull(),
  status: text("status").$type<PaymentAttemptStatus>().notNull().default("created"),
  declineReason: text("decline_reason").$type<PaymentDeclineReason>(),
  provider: text("provider").$type<PaymentProviderName>().notNull(),
  providerPaymentId: text("provider_payment_id"),
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  nextTryAt: timestamp("next_try_at", { withTimezone: true }),
  tries: integer("tries").notNull().default(0),
  firstFailureAt: timestamp("first_failure_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  requestedByMemberId: uuid("requested_by_member_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export type PaymentAttemptRow = typeof paymentAttempt.$inferSelect;

/** `payment_webhook_event`: a delivery of the provider, kept once by its id. */
export const paymentWebhookEvent = pgTable("payment_webhook_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").$type<PaymentProviderName>().notNull(),
  providerEventId: text("provider_event_id").notNull(),
  kind: text("kind").$type<"card_bound" | "card_cancelled" | "payment">().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  result: text("result"),
});

export type PaymentWebhookEventRow = typeof paymentWebhookEvent.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const billingTables = [
  plan,
  billingEvent,
  paymentMethod,
  cardBinding,
  paymentAttempt,
  paymentWebhookEvent,
];
