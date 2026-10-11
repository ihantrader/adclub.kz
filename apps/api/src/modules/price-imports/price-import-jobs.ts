import { z } from "zod";
import { defineJob, definePeriodicJob, defineSweeperJob, EVERY_MINUTE } from "../../jobs";

/**
 * Background jobs of price list imports (TASK-046; ARCHITECTURE 4.66, 13.2).
 * The API stores the file and answers at once; reading it runs here, so a
 * file of fifty thousand rows never holds a request. Both reading jobs are
 * idempotent: a run starts its phase over from what is stored.
 */

const importPayload = z.object({ importId: z.uuid() });

/**
 * Reads the file into `price_import_row` in batches, finds the header,
 * recognises the columns; with the company's remembered format goes on to
 * read the values at once (S-PRICE-02 is skipped).
 */
export const parsePriceFileJob = defineJob({
  name: "prices.parse",
  payload: importPayload,
  timeoutSeconds: 1800,
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  singleton: false,
  // A long price list of one company leaves room for another's (TASK-046.A).
  concurrency: 2,
});

/** Reads the values of the rows by the confirmed roles: `parsed` and the errors of each row. */
export const readPriceValuesJob = defineJob({
  name: "prices.read-values",
  payload: importPayload,
  timeoutSeconds: 1800,
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  singleton: false,
  concurrency: 2,
});

/**
 * Marks as failed an import read for longer than
 * `price_import_timeout_minutes` (a worker that died with it, a job that
 * kept failing): the supplier sees a state that is true and uploads again.
 */
export const expirePriceImportsJob = definePeriodicJob({
  name: "prices.expire-stalled",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

/**
 * Removes the files of imports older than `price_import_file_retention_days`
 * from the storage; the import and its rows stay as the history.
 */
export const deletePriceFilesJob = defineSweeperJob({ name: "prices.delete-files" });

/**
 * Matches the rows with the catalog without AI (TASK-047; ARCHITECTURE 12.1
 * step 4): the remembered matches, the exact article, the search by name;
 * then hands the rest to `prices.match-ai`, or ends the matching. Resumes
 * where a stopped run left: a decided row is not decided again.
 */
export const matchPricesJob = defineJob({
  name: "prices.match",
  payload: importPayload,
  timeoutSeconds: 1800,
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  singleton: false,
  concurrency: 2,
});

/**
 * Asks AI about the rows the search left undecided, in batches of
 * `price_match_batch_size`. AI can't be reached or the day's budget is
 * spent — the import waits in `matching` and the job is put back for later.
 */
export const matchPricesAiJob = defineJob({
  name: "prices.match-ai",
  payload: importPayload,
  timeoutSeconds: 1800,
  retry: { limit: 2, delaySeconds: 60, backoff: true },
  singleton: false,
});

/**
 * Every minute: an import in matching that nobody works on (a worker that
 * stopped, AI that came back) is put back on the queue.
 */
export const wakePriceMatchingJob = definePeriodicJob({
  name: "prices.match-wake",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

/** Applies the review to the offers in one transaction (`applying` → `applied`). */
export const applyPriceImportJob = defineJob({
  name: "prices.apply",
  payload: importPayload,
  timeoutSeconds: 1800,
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  singleton: false,
});

/**
 * Every minute: a review (or a matching) left longer than
 * `price_import_review_days` expires — nothing of it is applied.
 */
export const expirePriceReviewsJob = definePeriodicJob({
  name: "prices.expire-reviews",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

export const priceImportJobCatalog = [
  parsePriceFileJob,
  readPriceValuesJob,
  expirePriceImportsJob,
  deletePriceFilesJob,
  matchPricesJob,
  matchPricesAiJob,
  wakePriceMatchingJob,
  applyPriceImportJob,
  expirePriceReviewsJob,
];
