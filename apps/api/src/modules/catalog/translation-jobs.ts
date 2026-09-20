import { z } from "zod";
import { defineJob, definePeriodicJob } from "../../jobs";

/**
 * Background jobs of automatic translation (TASK-012; ARCHITECTURE 4.19,
 * 13.2). The work itself is rows of `translation_task`; these jobs only
 * wake the worker to take them.
 */

/**
 * Takes pending translation tasks in batches (`translation_batch_size`),
 * translates them through `AiService` and saves what passes the checks.
 * One is put on the queue in the transaction of every change of a Russian
 * text; a run drains every task that is pending by then, so runs that find
 * nothing are cheap and harmless. A temporary failure of the provider is
 * retried (the limit and the pause are settings, passed when it is put on
 * the queue — these are the defaults) and then lands in the dead letter
 * queue; a refusal for good goes there at once. Tasks stay pending either
 * way: the next run, whoever starts it, takes them.
 */
export const translateJob = defineJob({
  name: "catalog.translate",
  payload: z.object({}),
  timeoutSeconds: 300,
  retry: { limit: 3, delaySeconds: 60, backoff: true, maxDelaySeconds: 900 },
  singleton: false,
});

/**
 * A safety net every five minutes: tasks pending for a while that no run
 * has taken (a run that finished just before its task was committed, a
 * budget that was spent and a new day) get a run. It stays away from tasks
 * whose last run failed for a temporary reason — repeating those endlessly
 * would only fill the dead letter queue while the provider is down.
 */
export const translationWakeJob = definePeriodicJob({
  name: "catalog.translation-wake",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => "*/5 * * * *",
});

export const catalogJobCatalog = [translateJob, translationWakeJob];
