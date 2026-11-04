import { Logger } from "@nestjs/common";
import { z } from "zod";
import { afterCommit } from "../../database";
import { dailyAt, defineJob, definePeriodicJob, type JobQueue } from "../../jobs";

/**
 * Background jobs of the rating of suppliers (TASK-050; ARCHITECTURE 13.2,
 * 4.71). The orders and the reviews modules put the job on the queue when
 * their own transactions commit (`ratingChanged`), and the ratings module reads
 * their orders — the orders module and this one import each other, so
 * nothing here or in `rating-facts.ts` touches the other at load time.
 *
 * - `ratings.recompute-supplier` — the rating of one supplier, counted again
 *   after an event that changes it (a review published, hidden, restored; an
 *   order answered, silent, given out, failed). A singleton per supplier (the
 *   supplier is the key): one run and one waiting at most, so a burst of
 *   events is one or two calculations; why the job is put on the queue
 *   after the commit, not inside the transaction — `ratingChanged`;
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

const logger = new Logger("RatingJobs");

/**
 * The rating of `supplierId` is to be counted again: the job is put on the
 * queue when the transaction of the event commits, not inside it
 * (ARCHITECTURE 4.79 I865). Inside it, a job already waiting for this
 * supplier (the key) would swallow ours — and a worker may take that
 * waiting job before our transaction commits, so the calculation would
 * miss our event until the night. After the commit a waiting job starts
 * later than our event, and a running one lets a new one wait: none is
 * lost. A rollback puts nothing. Only a process killed between the commit
 * and the queue loses the event — which the night corrects.
 */
export function ratingChanged(queue: JobQueue, supplierId: string): void {
  afterCommit(() => {
    void queue
      .enqueue(recomputeSupplierRatingJob, { supplierId }, { singletonKey: supplierId })
      .catch((error: unknown) => {
        logger.warn(
          `Rating recompute could not be queued supplier=${supplierId}: ${String(error)}`,
        );
      });
  });
}
