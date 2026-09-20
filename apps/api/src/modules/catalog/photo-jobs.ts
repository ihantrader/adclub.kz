import { definePeriodicJob, defineSweeperJob } from "../../jobs";

/**
 * Background jobs of item photos (TASK-013 requirement 5; ARCHITECTURE
 * 4.22, 13.2). Removing a photo never removes its files at once: the
 * status changes, and these jobs clear the storage later, so a mistake can
 * be undone within the retention.
 */

/**
 * Removes the files of photos rejected or removed longer ago than
 * `photo_removed_retention_days`, then marks the photo as one whose files
 * are gone. A sweeper: every minute, one run at a time, in batches
 * (ARCHITECTURE 13.1). Repeating a run is safe — removing an object that
 * is already gone is not a failure.
 */
export const photoFileDeletionJob = defineSweeperJob({ name: "catalog.delete-photo-files" });

/**
 * Removes objects under the photo prefix that no record points at — files
 * of an upload that broke off after the first object was stored and before
 * the row was written. Only objects older than
 * `photo_orphan_retention_hours` are touched, so an upload in flight is
 * never taken for rubbish. Hourly: there is nothing to find most of the
 * time, and listing a bucket is not free.
 */
export const photoOrphanCleanupJob = definePeriodicJob({
  name: "catalog.cleanup-photo-files",
  timeoutSeconds: 300,
  retry: { limit: 2, delaySeconds: 300, backoff: true },
  singleton: true,
  schedule: () => "17 * * * *",
});

export const photoJobCatalog = [photoFileDeletionJob, photoOrphanCleanupJob];
