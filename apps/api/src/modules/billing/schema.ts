import type {
  SubscriptionAudience,
  SubscriptionEventKind,
  SubscriptionStatus,
} from "@adclub/domain";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

/** Every table this module owns — checked against the migrated database. */
export const billingTables = [plan, billingEvent];
