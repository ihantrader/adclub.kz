import { z } from "zod";
import { hiddenPhoneSchema } from "./account";
import { subscriptionProviderSchema, subscriptionStatusSchema } from "./subscriptions";
import {
  paymentDeclineReasonSchema,
  supplierChargeKindSchema,
  supplierSubscriptionStatusSchema,
} from "./supplier-billing";

/**
 * «Биллинг» of the admin panel (SCREENS 7.8 A-BILL-01…04; PRODUCT 11, 14;
 * TASK-043; ARCHITECTURE 4.78). **Every number of the summary is the
 * `total` of the list its card opens, with the same filters**: the summary
 * and the lists count with the same SQL (I847). The administrator charges
 * nothing and changes no status here; the one thing with money they do is
 * the suppliers' tariff.
 */

export const BILLING_PAGE_DEFAULT_SIZE = 50;
export const BILLING_PAGE_MAX_SIZE = 100;

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(BILLING_PAGE_MAX_SIZE)
  .default(BILLING_PAGE_DEFAULT_SIZE);
const cursorSchema = z.string().min(1).max(300);
const momentSchema = z.iso.datetime({ offset: true });

/** A comma list of values of an enum in the query string: `groups=declined,paused`. */
function commaList<T extends z.ZodEnum<Record<string, string>>>(values: T) {
  return z
    .string()
    .max(200)
    .transform((text) =>
      text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(values).min(1).max(values.options.length));
}

// ------------------------------------------------------------ the summary

/**
 * The period of the summary and of the lists it opens: `from` inclusive,
 * `to` exclusive — the starts of days of Almaty, as «Заявки» take them.
 * Left out — the last 30 days, today included.
 */
export const adminBillingPeriodQuerySchema = z.object({
  from: momentSchema.optional(),
  to: momentSchema.optional(),
});

export type AdminBillingPeriodQuery = z.infer<typeof adminBillingPeriodQuerySchema>;

/**
 * Where a supplier is in its payments — **exactly one of these** (I847):
 *
 * - `paused` — on the billing pause (`billing_paused_at`) or its
 *   subscription is `suspended`;
 * - `declined` — otherwise, the bank refused and the retries go on
 *   (`past_due`);
 * - `awaiting_provider` — otherwise, a charge waits for the payment system
 *   (`unavailable`, `unknown`) — not a failure of the payer;
 * - `paid` — otherwise, the subscription is `active` (or `cancelled`, to
 *   the end of its paid term);
 * - `none` — everything else: no current subscription (none yet, or only an
 *   ended one) — «Без подписки».
 *
 * «Проблема» of A-BILL-01 is `declined` + `awaiting_provider`.
 */
export const supplierBillingGroupSchema = z.enum([
  "paid",
  "declined",
  "awaiting_provider",
  "paused",
  "none",
]);

export type SupplierBillingGroup = z.infer<typeof supplierBillingGroupSchema>;

/** A tariff record as the admin panel shows it (A-BILL-04). */
export const adminPlanSchema = z.object({
  id: z.uuid(),
  audience: z.enum(["user", "supplier"]),
  code: z.string(),
  price: z.number().int(),
  currency: z.literal("KZT"),
  /** The start: 00:00 of a day of Almaty for the records of the admin panel. */
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  announceBeforeDays: z.number().int(),
  /** From when the cabinet (or the app) shows the change: `validFrom − announceBeforeDays`. */
  announceFrom: z.iso.datetime(),
  reason: z.string(),
  createdByRole: z.enum(["operator", "admin"]),
  createdAt: z.iso.datetime(),
  /**
   * - `in_effect` — the one in effect now; `past` — taken over by a later one
   *   (or ended); `announced` — starts later, the notice is shown;
   *   `scheduled` — starts later, not announced yet; `cancelled`.
   */
  state: z.enum(["in_effect", "past", "announced", "scheduled", "cancelled"]),
  cancelled: z
    .object({
      at: z.iso.datetime(),
      byRole: z.enum(["operator", "admin"]),
      reason: z.string(),
    })
    .nullable(),
});

export type AdminPlan = z.infer<typeof adminPlanSchema>;

/** `GET /admin/billing/summary` — A-BILL-01. */
export const adminBillingSummarySchema = z.object({
  period: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  users: z.object({
    /** Subscriptions giving club access now (`subscriptionAccess`), by where they were bought. */
    active: z.object({
      total: z.number().int(),
      ios: z.number().int(),
      android: z.number().int(),
      /** No platform recorded (a provider other than the stores). */
      other: z.number().int(),
    }),
    /** The first `started` of the subscription fell into the period. */
    started: z.number().int(),
    /** The move into `expired` (expiry, refund, revocation, a lapse of time) fell into the period. */
    ended: z.number().int(),
  }),
  suppliers: z.object({
    paid: z.number().int(),
    declined: z.number().int(),
    awaitingProvider: z.number().int(),
    paused: z.number().int(),
    none: z.number().int(),
  }),
  /** Charges of suppliers made in the period. */
  charges: z.object({
    succeeded: z.object({ count: z.number().int(), amount: z.number().int() }),
    declined: z.object({ count: z.number().int() }),
  }),
  /** The suppliers' tariff in effect now and the nearest change (announced or not yet). */
  supplierPlan: z.object({
    inEffect: adminPlanSchema.nullable(),
    next: adminPlanSchema.nullable(),
  }),
  at: z.iso.datetime(),
});

export type AdminBillingSummary = z.infer<typeof adminBillingSummarySchema>;

// --------------------------------------------- users' subscriptions (A-BILL-02)

/**
 * - `active` — «Действующие»: the subscription gives club access now;
 * - `ended` — «Прекращённые»: it gives none (ended, or stopped by the provider);
 * - `all` — both (what «Новые за период» opens).
 */
export const adminUserSubscriptionTabSchema = z.enum(["active", "ended", "all"]);

export type AdminUserSubscriptionTab = z.infer<typeof adminUserSubscriptionTabSchema>;

export const adminUserSubscriptionListQuerySchema = z.object({
  tab: adminUserSubscriptionTabSchema.default("active"),
  status: subscriptionStatusSchema.optional(),
  /** `other` — no platform recorded. */
  platform: z.enum(["ios", "android", "other"]).optional(),
  provider: subscriptionProviderSchema.optional(),
  /** The access ends within N days from now. */
  expiringDays: z.coerce.number().int().min(1).max(366).optional(),
  /** The first `started` within [startedFrom, startedTo). */
  startedFrom: momentSchema.optional(),
  startedTo: momentSchema.optional(),
  /** The move into `expired` within [endedFrom, endedTo). */
  endedFrom: momentSchema.optional(),
  endedTo: momentSchema.optional(),
  /** Digits of the phone (a part of it) or a part of the name. */
  q: z.string().trim().min(1).max(60).optional(),
  accountId: z.uuid().optional(),
  limit: limitSchema,
  cursor: cursorSchema.optional(),
});

export type AdminUserSubscriptionListQuery = z.infer<typeof adminUserSubscriptionListQuerySchema>;

export const adminBillingUserSubscriptionSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  name: z.string().nullable(),
  phone: hiddenPhoneSchema,
  status: subscriptionStatusSchema,
  grantsAccess: z.boolean(),
  platform: z.enum(["ios", "android"]).nullable(),
  provider: subscriptionProviderSchema,
  /** «Оплачено до». */
  periodEnd: z.iso.datetime(),
  /** «Доступ до»; `null` — no access now. */
  accessUntil: z.iso.datetime().nullable(),
  /** The first `started`; `null` — none recorded. */
  startedAt: z.iso.datetime().nullable(),
  /** When it moved into `expired`, and by which event (`expired`, `refunded`, `revoked`, a lapse). */
  ended: z.object({ at: z.iso.datetime(), kind: z.string() }).nullable(),
});

export type AdminBillingUserSubscription = z.infer<typeof adminBillingUserSubscriptionSchema>;

export const adminUserSubscriptionPageSchema = z.object({
  subscriptions: z.array(adminBillingUserSubscriptionSchema),
  total: z.number().int(),
  /** The tabs' counts with the other filters. */
  counts: z.object({ active: z.number().int(), ended: z.number().int(), all: z.number().int() }),
  nextCursor: z.string().nullable(),
});

export type AdminUserSubscriptionPage = z.infer<typeof adminUserSubscriptionPageSchema>;

// -------------------------------------------- suppliers' payments (A-BILL-03)

/** Left out — the three groups of «Неуспешные»: `declined`, `awaiting_provider`, `paused`. */
export const adminBillingSupplierListQuerySchema = z.object({
  groups: commaList(supplierBillingGroupSchema).optional(),
  /** A part of the name, or digits of the BIN. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: limitSchema,
  cursor: cursorSchema.optional(),
});

export type AdminBillingSupplierListQuery = z.input<typeof adminBillingSupplierListQuerySchema>;

export const adminBillingSupplierSchema = z.object({
  supplierId: z.uuid(),
  name: z.string(),
  group: supplierBillingGroupSchema,
  subscriptionStatus: supplierSubscriptionStatusSchema.nullable(),
  /** «Оплачено до» of the current subscription. */
  periodEnd: z.iso.datetime().nullable(),
  /** The linked card: the last four digits. */
  cardMask: z.string().nullable(),
  /** The billing pause: since when. */
  pausedSince: z.iso.datetime().nullable(),
  /** The administrator's own pause is on too (independent of billing). */
  adminPaused: z.boolean(),
  /** The latest refusal of the bank in the unpaid term. */
  lastDecline: z
    .object({ at: z.iso.datetime(), reason: paymentDeclineReasonSchema, amount: z.number().int() })
    .nullable(),
  /** Refusals of the bank in the unpaid term («попытка N»). */
  declines: z.number().int(),
  /** The next automatic try (`pastDueNextRetry`); `null` — «Автоматических попыток больше не будет». */
  nextRetryAt: z.iso.datetime().nullable(),
  /** When the offers leave the showcase (`grace_until`, what W-05a names). */
  pauseAt: z.iso.datetime().nullable(),
  /** Days of Almaty to `pauseAt` (`daysUntilPause`). */
  daysToPause: z.number().int().nullable(),
  /** A charge waiting for the payment system. */
  waiting: z
    .object({
      status: z.enum(["unavailable", "unknown"]),
      since: z.iso.datetime(),
      nextTryAt: z.iso.datetime().nullable(),
      amount: z.number().int(),
    })
    .nullable(),
});

export type AdminBillingSupplier = z.infer<typeof adminBillingSupplierSchema>;

export const adminBillingSupplierPageSchema = z.object({
  suppliers: z.array(adminBillingSupplierSchema),
  total: z.number().int(),
  /** Every group's count with the search (not with `groups`). */
  counts: z.object({
    paid: z.number().int(),
    declined: z.number().int(),
    awaitingProvider: z.number().int(),
    paused: z.number().int(),
    none: z.number().int(),
  }),
  nextCursor: z.string().nullable(),
});

export type AdminBillingSupplierPage = z.infer<typeof adminBillingSupplierPageSchema>;

/** The statuses of a charge in the history: `created` — being made right now. */
export const adminChargeStatusSchema = z.enum([
  "succeeded",
  "declined",
  "unavailable",
  "unknown",
  "created",
]);

export type AdminChargeStatus = z.infer<typeof adminChargeStatusSchema>;

/** «История списаний»: `from` inclusive, `to` exclusive — by when the charge was made. */
export const adminChargeListQuerySchema = z.object({
  from: momentSchema.optional(),
  to: momentSchema.optional(),
  supplierId: z.uuid().optional(),
  status: commaList(adminChargeStatusSchema).optional(),
  kind: commaList(supplierChargeKindSchema).optional(),
  limit: limitSchema,
  cursor: cursorSchema.optional(),
});

export type AdminChargeListQuery = z.input<typeof adminChargeListQuerySchema>;

export const adminChargeSchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  kind: supplierChargeKindSchema,
  status: adminChargeStatusSchema,
  declineReason: paymentDeclineReasonSchema.nullable(),
  amount: z.number().int(),
  currency: z.literal("KZT"),
  periodFrom: z.iso.datetime(),
  periodTo: z.iso.datetime(),
  /** The card charged: the last four digits. */
  cardMask: z.string().nullable(),
  /** «Оплатить сейчас»: the employee who pressed it. */
  requestedBy: z.object({ memberId: z.uuid(), name: z.string().nullable() }).nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  /** Waiting for the payment system: when it is asked again. */
  nextTryAt: z.iso.datetime().nullable(),
});

export type AdminCharge = z.infer<typeof adminChargeSchema>;

export const adminChargePageSchema = z.object({
  charges: z.array(adminChargeSchema),
  total: z.number().int(),
  /** The sum of the charges matching the filters (every page). */
  totalAmount: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminChargePage = z.infer<typeof adminChargePageSchema>;

// ------------------------------------------------------- tariffs (A-BILL-04)

/** The bounds the server checks a new tariff of the admin panel against (I850). */
export const PLAN_PRICE_MAX = 1_000_000;
export const PLAN_ANNOUNCE_DAYS_MAX = 365;

export const adminBillingPlansSchema = z.object({
  /** Grows with every record added or cancelled; a change sends the one it saw. */
  version: z.number().int(),
  supplier: z.object({
    inEffect: adminPlanSchema.nullable(),
    announced: adminPlanSchema.nullable(),
    /** Every record, the latest start first, cancelled ones too. */
    records: z.array(adminPlanSchema),
  }),
  /** Users' prices are the stores' (only to look at). */
  user: z.object({
    inEffect: adminPlanSchema.nullable(),
    announced: adminPlanSchema.nullable(),
    records: z.array(adminPlanSchema),
  }),
  /**
   * The earliest day a new tariff may start (`YYYY-MM-DD` of Almaty): a
   * lowering — tomorrow; a rise — no earlier than its notice allows (the
   * form checks it as the days are typed; the server decides).
   */
  earliestStart: z.string(),
  /** Today of Almaty. */
  today: z.string(),
});

export type AdminBillingPlans = z.infer<typeof adminBillingPlansSchema>;

export const addAdminPlanBodySchema = z.object({
  price: z.number().int().min(1).max(PLAN_PRICE_MAX),
  /** The day of Almaty the tariff starts on (00:00). */
  startsOn: z.iso.date(),
  announceBeforeDays: z.number().int().min(0).max(PLAN_ANNOUNCE_DAYS_MAX),
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().min(0),
});

export type AddAdminPlanBody = z.infer<typeof addAdminPlanBodySchema>;

export const adminPlanPathSchema = z.object({ planId: z.uuid() });

export type AdminPlanPath = z.infer<typeof adminPlanPathSchema>;

export const cancelAdminPlanBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().min(0),
});

export type CancelAdminPlanBody = z.infer<typeof cancelAdminPlanBodySchema>;

/** `details` of `PLAN_VERSION_CONFLICT`: the tariffs as they are now. */
export const planVersionConflictDetailsSchema = z.object({ currentVersion: z.number().int() });

export type PlanVersionConflictDetails = z.infer<typeof planVersionConflictDetailsSchema>;
