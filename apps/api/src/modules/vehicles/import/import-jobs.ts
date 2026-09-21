import { z } from "zod";
import { defineJob, definePeriodicJob, EVERY_MINUTE } from "../../../jobs";

/**
 * Background jobs of the vehicle import (TASK-014 requirement 3;
 * ARCHITECTURE 4.24, 13.2). The file is read at upload; checking its rows
 * and applying them run here, so a file of ten thousand rows never holds
 * a request. Both jobs are idempotent: a check starts from the stored
 * rows every time, an application goes on from the rows without an
 * outcome. How long an import may take is `vehicle_import_timeout_minutes`.
 */

const importPayload = z.object({ importId: z.uuid() });

/** Checks every row of an import against the catalog and writes the report. */
export const analyzeImportJob = defineJob({
  name: "vehicles.analyze-import",
  payload: importPayload,
  timeoutSeconds: 3600,
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  singleton: false,
});

/** Applies a confirmed import in batches (`vehicle_import_batch_size` rows per transaction). */
export const applyImportJob = defineJob({
  name: "vehicles.apply-import",
  payload: importPayload,
  timeoutSeconds: 3600,
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  singleton: false,
});

/**
 * Marks as failed an import that has been checked or applied for longer
 * than `vehicle_import_timeout_minutes` (a worker that died with it, a
 * job that kept failing): the administrator sees a state that is true and
 * can upload the file again. Every minute; finding nothing is cheap.
 */
export const expireImportsJob = definePeriodicJob({
  name: "vehicles.expire-imports",
  timeoutSeconds: 60,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

export const vehicleJobCatalog = [analyzeImportJob, applyImportJob, expireImportsJob];
