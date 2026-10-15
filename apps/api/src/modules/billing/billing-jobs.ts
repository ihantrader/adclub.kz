import { z } from "zod";
import { defineJob, definePeriodicJob, defineSweeperJob, EVERY_MINUTE } from "../../jobs";

/**
 * Background jobs of subscriptions (TASK-040; ARCHITECTURE 13.2, 4.72).
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
 *   `expired`; a grace or retries over.
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

export const billingJobCatalog = [
  applyBillingEventsJob,
  wakeBillingEventsJob,
  expireSubscriptionsJob,
];
