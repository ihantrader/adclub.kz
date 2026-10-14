import { z } from "zod";
import { dailyAt, defineJob, definePeriodicJob, type JobQueue } from "../../jobs";
import type { DbExecutor } from "../../database";

/**
 * Background jobs of the rating of suppliers (TASK-050; ARCHITECTURE 13.2,
 * 4.71). The orders and the reviews modules put the job on the queue from
 * their own transactions (`ratingChanged`), and the ratings module reads
 * their orders — the orders module and this one import each other, so
 * nothing here or in `rating-facts.ts` touches the other at load time.
 *
 * - `ratings.recompute-supplier` — the rating of one supplier, counted again
 *   after an event that changes it (a review published, hidden, restored; an
 *   order answered, silent, given out, failed). A singleton per supplier (the
 *   supplier is the key): one run and one waiting at most, so a burst of
 *   events is one or two calculations, and the waiting one always starts
 *   after the latest event committed — none is lost;
 * - `ratings.reconcile` — every night at 04:40 Almaty time (after the search
 *   index at 04:20), every supplier counted again by the very same function;
 *   it corrects and counts what the events missed, applies new settings
 *   (weights, thresholds, the window) and moves the window. `operator
 *   jobs:run ratings.reconcile` — now.
 */
export const recomputeSupplierRatingJob = defineJob({
  name: "ratings.recompute-supplier",
  payload: z.object({ supplierId: z.uuid() }),
  timeoutSeconds: 120,
  retry: { limit: 3, delaySeconds: 10, backoff: true },
  singleton: true,
  concurrency: 2,
});

export const reconcileRatingsJob = definePeriodicJob({
  name: "ratings.reconcile",
  timeoutSeconds: 1800,
  // The next night is the retry; `jobs:run` — at once.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => dailyAt(4, 40),
});

export const ratingJobCatalog = [recomputeSupplierRatingJob, reconcileRatingsJob];

/**
 * The rating of `supplierId` is to be counted again: put on the queue inside
 * the transaction of the event (the job becomes visible with it, and runs
 * after it committed).
 */
export async function ratingChanged(
  queue: JobQueue,
  tx: DbExecutor,
  supplierId: string,
): Promise<void> {
  await queue.enqueue(recomputeSupplierRatingJob, { supplierId }, { tx, singletonKey: supplierId });
}
