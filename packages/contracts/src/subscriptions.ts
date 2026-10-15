import { z } from "zod";
import { clubAccessStateSchema } from "./club-access";

/**
 * Subscriptions (EPIC-14, TASK-040; PRODUCT 14; ARCHITECTURE 5.10, 9.4.1,
 * 9.4.2, 4.72). The server alone decides a subscription's status — from the
 * events of its provider and from time; a client never says «active». A
 * user's subscription is one of the two sources of club access (D-059: the
 * other is a grant by hand); the callers of club access don't know which.
 */

/**
 * - `active` — paid; `grace` — a store's grace after a failed charge (access
 *   stays); `cancelled` — renewal off, access to the end of the paid term;
 * - `expired_unconfirmed` — the term passed and the store hasn't confirmed
 *   either way yet: access stays `store_lag_tolerance_hours` (U-5), then
 *   `expired`; «Проверяем статус подписки»;
 * - `suspended` — the provider stopped access and may restore it;
 * - `expired` — over;
 * - `past_due` — a supplier's charge failed, retries go on (TASK-042).
 */
export const subscriptionStatusSchema = z.enum([
  "active",
  "grace",
  "past_due",
  "cancelled",
  "expired_unconfirmed",
  "suspended",
  "expired",
]);

export type SubscriptionStatusValue = z.infer<typeof subscriptionStatusSchema>;

/** `store` — App Store / Google Play (TASK-041); `card_kz` — a card processor (TASK-042); `test` — the test provider of development and tests. */
export const subscriptionProviderSchema = z.enum(["store", "card_kz", "test"]);

export type SubscriptionProviderValue = z.infer<typeof subscriptionProviderSchema>;

/** A tariff: the price in tenge per period (one month for now). */
export const subscriptionPlanSchema = z.object({
  code: z.string(),
  price: z.number().int(),
  currency: z.literal("KZT"),
  period: z.literal("month"),
  /** From when it is in effect. */
  validFrom: z.iso.datetime(),
});

export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

/** A change of the tariff announced ahead (S-BILL-01, M-SUB-02 «С {дата} цена подписки — {цена}»). */
export const announcedPlanSchema = subscriptionPlanSchema.extend({
  /** The text of the notice (`price_increase_notice_text`) in the interface language. */
  notice: z.string(),
});

export type AnnouncedPlan = z.infer<typeof announcedPlanSchema>;

/** The current subscription of an account, as its owner sees it. */
export const mySubscriptionSchema = z.object({
  status: subscriptionStatusSchema,
  /** The status gives club access now (the one rule of 9.4.1, 4.72). */
  grantsAccess: z.boolean(),
  /** `false` — «статус не подтверждён» (`expired_unconfirmed`): «Проверяем статус подписки». */
  statusConfirmed: z.boolean(),
  /** The end of the paid term («следующее списание {дата}»). */
  periodEnd: z.iso.datetime(),
  /** When the access ends without a new word from the store; `null` without access. */
  accessUntil: z.iso.datetime().nullable(),
  /** The end of the store's grace (`grace`); `null` otherwise. */
  graceUntil: z.iso.datetime().nullable(),
  provider: subscriptionProviderSchema,
  /** Where it was bought (`ios`/`android`) — a store's only; `null` otherwise. */
  platform: z.enum(["ios", "android"]).nullable(),
});

export type MySubscription = z.infer<typeof mySubscriptionSchema>;

/**
 * `GET /me/subscription` — the subscription of the signed-in account on any
 * device (9.4.1 rule 2: the status is the account's, not the phone's).
 */
export const mySubscriptionResponseSchema = z.object({
  /** The current subscription; `null` — none (or only an expired one is left). */
  subscription: mySubscriptionSchema.nullable(),
  /** Club access now, from both sources (D-059). */
  access: clubAccessStateSchema,
  /** A grant by hand in force now; `null` — none. */
  manualGrant: z.object({ validUntil: z.iso.datetime() }).nullable(),
  /** The users' tariff in effect now; `null` — none recorded yet. */
  plan: subscriptionPlanSchema.nullable(),
  /** A change of the tariff announced ahead; `null` — none. */
  announcedPlan: announcedPlanSchema.nullable(),
});

export type MySubscriptionResponse = z.infer<typeof mySubscriptionResponseSchema>;

/**
 * `GET /supplier/subscription` — the company's side of D-041 and its
 * tariff (the screen S-BILL-01 comes with TASK-042).
 */
export const supplierSubscriptionResponseSchema = z.object({
  /** The company has linked a card. */
  cardLinked: z.boolean(),
  /** The switch D-041 (`supplier_card_required`) is on. */
  cardRequired: z.boolean(),
  /** `cardRequired` and no card: no offer of the company is on the showcase (T-SUP-02). */
  hiddenWithoutCard: z.boolean(),
  /** The suppliers' tariff in effect now; `null` — none recorded yet. */
  plan: subscriptionPlanSchema.nullable(),
  /** A change of the tariff announced ahead; `null` — none. */
  announcedPlan: announcedPlanSchema.nullable(),
});

export type SupplierSubscriptionResponse = z.infer<typeof supplierSubscriptionResponseSchema>;

/**
 * One line of a subscription's history (A-USR-02 «Клубный доступ»): an
 * event of its provider, or of time.
 *
 * - `by` — `provider` (an event the provider sent), `operator` (the test
 *   provider's event entered by the operator command), `system` (time);
 * - `outcome` — `applied` (the status or its moments changed), `no_effect`
 *   (understood, nothing to change: a duplicate renewal, an event older than
 *   the last one applied), `refused` (the purchase belongs to another
 *   account, another subscription is in force, an event this audience
 *   doesn't have), `pending` (received, not applied yet).
 */
export const subscriptionHistoryEntrySchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  by: z.enum(["provider", "operator", "system"]),
  /** When it happened at the provider (or the moment of time it marks). */
  eventAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  outcome: z.enum(["pending", "applied", "no_effect", "refused"]),
  /** Why `no_effect` or `refused`, a code (`stale`, `duplicate`, `linked_to_another_account`…). */
  detail: z.string().nullable(),
  fromStatus: subscriptionStatusSchema.nullable(),
  toStatus: subscriptionStatusSchema.nullable(),
  /** The end of the paid term the event carried; `null` — none. */
  periodEnd: z.iso.datetime().nullable(),
});

export type SubscriptionHistoryEntry = z.infer<typeof subscriptionHistoryEntrySchema>;

export const adminUserSubscriptionSchema = mySubscriptionSchema.extend({
  id: z.uuid(),
  /** The purchase at the provider (an original transaction id, a token). */
  providerRef: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminUserSubscription = z.infer<typeof adminUserSubscriptionSchema>;

/**
 * `GET /admin/users/{accountId}/subscription` — A-USR-02 «Клубный доступ»:
 * the subscription (the current one, or the last), its history, newest
 * first, and the grant by hand beside it.
 */
export const adminUserSubscriptionResponseSchema = z.object({
  /** The current subscription, or the last expired one; `null` — never had one. */
  subscription: adminUserSubscriptionSchema.nullable(),
  /** Up to the last 100 events of the account's subscriptions. */
  history: z.array(subscriptionHistoryEntrySchema),
  access: clubAccessStateSchema,
  manualGrant: z.object({ validUntil: z.iso.datetime() }).nullable(),
});

export type AdminUserSubscriptionResponse = z.infer<typeof adminUserSubscriptionResponseSchema>;
