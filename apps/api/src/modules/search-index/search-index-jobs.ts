import { z } from "zod";
import { dailyAt, defineJob, definePeriodicJob } from "../../jobs";

/**
 * Background jobs of the search index (TASK-045; ARCHITECTURE 10.1, 4.65,
 * 13.2).
 */

/**
 * Applies the outbox to the index. Put on the queue by the worker's
 * watcher within a second of a change (it looks at the outbox every
 * second); a singleton, so one batch at a time across all workers — two
 * would race documents of different ages to the index. A run drains the
 * outbox. The index not answering is not a failure of the job (the rows
 * wait, the next attempt is later), so it is not retried by the queue.
 */
export const searchApplyOutboxJob = defineJob({
  name: "search.apply-outbox",
  payload: z.object({}),
  timeoutSeconds: 600,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
});

/**
 * The nightly check of the index against the database (and the clean-up of
 * applied outbox rows): every night at 04:20 Almaty time, when hardly
 * anyone searches. `operator jobs:run search.reconcile` — now.
 */
export const searchReconcileJob = definePeriodicJob({
  name: "search.reconcile",
  timeoutSeconds: 1800,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => dailyAt(4, 20),
});

export const searchJobCatalog = [searchApplyOutboxJob, searchReconcileJob];
