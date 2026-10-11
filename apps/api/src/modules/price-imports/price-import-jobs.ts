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

export const priceImportJobCatalog = [
  parsePriceFileJob,
  readPriceValuesJob,
  expirePriceImportsJob,
  deletePriceFilesJob,
];
