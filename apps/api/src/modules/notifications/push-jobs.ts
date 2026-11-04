import { z } from "zod";
import { defineJob, defineSweeperJob } from "../../jobs";
import { pushFallbackJob, pushFallbackShareJob } from "./push-fallback";

/**
 * The background jobs of push to the user (ARCHITECTURE 4.12, 4.79). A push
 * is put on the queue inside the transaction of the event that caused it and
 * leaves from the worker, one job per device.
 */

/**
 * Sends one notification to one device. The attempts and the pause come
 * from the settings (`push_send_attempts`, `push_retry_delay_seconds`) and
 * are passed when the job is queued; the handler ends a delivery when its
 * attempts are spent (as `messaging.send`).
 */
export const sendPushJob = defineJob({
  name: "notifications.send",
  payload: z.object({ deliveryId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 19, delaySeconds: 30, backoff: true, maxDelaySeconds: 3600 },
  singleton: false,
});

/**
 * Recovers deliveries whose sending was interrupted and whose job will never
 * come back for them: `sent` if the provider's id had been written down,
 * `unknown` if not. Never sends anything.
 */
export const pushRecoveryJob = defineSweeperJob({ name: "notifications.recover-interrupted" });

/**
 * Takes off push the tokens of sessions that have ended (whatever ended
 * them) and deletes tokens taken off longer ago than
 * `push_token_retention_days`.
 */
export const deviceTokenCleanupJob = defineSweeperJob({
  name: "notifications.cleanup-device-tokens",
});

export const notificationJobCatalog = [
  sendPushJob,
  pushRecoveryJob,
  deviceTokenCleanupJob,
  pushFallbackJob,
  pushFallbackShareJob,
];
