import { z } from "zod";
import { defineJob, defineSweeperJob } from "../../jobs";

/**
 * Background jobs of reviews (TASK-049; ARCHITECTURE 4.69, 13.2).
 *
 * - `reviews.check` — the check of one review's text: the deterministic rules,
 *   then AI; AI out of reach or the day's budget spent — the job puts itself
 *   back for `review_check_retry_seconds` and the review keeps waiting;
 * - `reviews.expire-checks` — a review waiting longer than
 *   `review_check_max_wait_minutes` goes to the administrator (`held`,
 *   «проверка недоступна»).
 */
export const checkReviewJob = defineJob({
  name: "reviews.check",
  payload: z.object({ reviewId: z.uuid() }),
  // Two models of AI, a minute each at most (`AiService`), and the writes.
  timeoutSeconds: 300,
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  singleton: false,
  concurrency: 2,
});

export const expireReviewChecksJob = defineSweeperJob({ name: "reviews.expire-checks" });

export const reviewJobCatalog = [checkReviewJob, expireReviewChecksJob];
