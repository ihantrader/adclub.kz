import { z } from "zod";
import { dailyAt, defineJob, definePeriodicJob, defineSweeperJob, EVERY_MINUTE } from "../../jobs";

/**
 * Background jobs of subscriptions (TASK-040, TASK-042; ARCHITECTURE 13.2,
 * 4.72, 4.77).
 *
 * The events of providers and of time (TASK-040):
 *
 * - `billing.apply-events` — the pending events of one purchase, in the order
 *   of their own time: put on the queue in the transaction that received an
 *   event; a singleton per purchase, so two events of one purchase are never
 *   applied at once, and the waiting run picks up everything received
 *   meanwhile;
 * - `billing.wake-events` — every minute: a purchase whose event has waited
 *   longer than a minute (its job lost or dead) is put on the queue again;
 * - `billing.expire-subscriptions` — every minute, time's events: a term
 *   passed without a word — `expired_unconfirmed`; its tolerance
 *   (`store_lag_tolerance_hours`) passed — `expired`; a cancelled term over —
 *   `expired`; a grace or retries over (a supplier's pause).
 *
 * A supplier's card (TASK-042):
 *
 * - `billing.charge-due` — **daily at `billing_notify_hour`** (Almaty): every
 *   subscription whose term has ended is charged, and every one in its
 *   retries gets its next try; each goes to its own job;
 * - `billing.charge-subscription` — one subscription's charge: opens the
 *   attempt of the term (the database lets one succeed and one be in flight),
 *   then runs it; a singleton per subscription;
 * - `billing.run-attempt` — one attempt at the provider: claim, call (no
 *   transaction open), settle; a singleton per attempt, so two workers never
 *   send one attempt at once;
 * - `billing.resolve-attempts` — every minute: attempts the provider could not
 *   take (an hour ago) or whose worker was lost, and webhooks nobody applied;
 * - `billing.finish-binding` — the card the provider named: link it, or make
 *   the first charge;
 * - `billing.apply-payment-webhook` — one delivery of the provider;
 * - `billing.detach-card` — forget a replaced card at the provider;
 * - `billing.expire-bindings` — every minute: pages nobody came back from,
 *   and the tokens of bindings that ended without a card;
 * - `billing.watch-provider` — every minute: the provider silent for longer
 *   than `payment_outage_signal_minutes`, and the missing tariff.
 */
export const applyBillingEventsJob = defineJob({
  name: "billing.apply-events",
  payload: z.object({ provider: z.string().min(1), providerRef: z.string().min(1) }),
  timeoutSeconds: 120,
  retry: { limit: 5, delaySeconds: 10, backoff: true },
  singleton: true,
  concurrency: 2,
});

export const wakeBillingEventsJob = definePeriodicJob({
  name: "billing.wake-events",
  timeoutSeconds: 60,
  // The next minute is the retry.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

export const expireSubscriptionsJob = defineSweeperJob({ name: "billing.expire-subscriptions" });

/** The daily run: at the hour of the setting, in Almaty time, following it while the worker runs. */
export const chargeDueJob = definePeriodicJob({
  name: "billing.charge-due",
  timeoutSeconds: 300,
  // Tomorrow's run is the retry; an hourly resolver picks up what this one dropped.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: async (setting) => dailyAt(await setting("billing_notify_hour")),
});

export const chargeSubscriptionJob = defineJob({
  name: "billing.charge-subscription",
  payload: z.object({
    subscriptionId: z.uuid(),
    kind: z.enum(["scheduled", "retry"]),
  }),
  timeoutSeconds: 120,
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  singleton: true,
  concurrency: 4,
});

export const runPaymentAttemptJob = defineJob({
  name: "billing.run-attempt",
  payload: z.object({ attemptId: z.uuid() }),
  timeoutSeconds: 120,
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  singleton: true,
  concurrency: 4,
});

export const resolvePaymentsJob = definePeriodicJob({
  name: "billing.resolve-attempts",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

export const finishCardBindingJob = defineJob({
  name: "billing.finish-binding",
  payload: z.object({ bindingId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 5, delaySeconds: 10, backoff: true },
  singleton: true,
  concurrency: 2,
});

export const applyPaymentWebhookJob = defineJob({
  name: "billing.apply-payment-webhook",
  payload: z.object({ eventId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 5, delaySeconds: 10, backoff: true },
  singleton: true,
  concurrency: 2,
});

export const detachCardJob = defineJob({
  name: "billing.detach-card",
  payload: z.object({ paymentMethodId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 8, delaySeconds: 60, backoff: true },
  singleton: true,
  concurrency: 2,
});

export const expireCardBindingsJob = definePeriodicJob({
  name: "billing.expire-bindings",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

export const watchPaymentProviderJob = definePeriodicJob({
  name: "billing.watch-provider",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

export const billingJobCatalog = [
  applyBillingEventsJob,
  wakeBillingEventsJob,
  expireSubscriptionsJob,
  chargeDueJob,
  chargeSubscriptionJob,
  runPaymentAttemptJob,
  resolvePaymentsJob,
  finishCardBindingJob,
  applyPaymentWebhookJob,
  detachCardJob,
  expireCardBindingsJob,
  watchPaymentProviderJob,
];
