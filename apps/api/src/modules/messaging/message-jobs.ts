import { z } from "zod";
import { defineJob, defineSweeperJob } from "../../jobs";
import { applyButtonPressJob } from "./button-presses";

/**
 * The background jobs of messaging (ARCHITECTURE 4.12, 4.35). Nothing is
 * sent from an HTTP request: a message is put on the queue inside the
 * transaction of the event that caused it and leaves from the worker.
 */

/**
 * Sends one message. The retry limit and pause of a message come from the
 * settings (`message_send_attempts`, `message_retry_delay_seconds`) and are
 * passed when the job is queued (`EnqueueOptions.retry`), so changing them
 * needs no release. The values here are the defaults of the queue — what a
 * job gets when nothing is passed, as when the operator puts a dead job back
 * (`jobs:retry`) — and the limit is the ceiling of the setting
 * (`message_send_attempts` is at most 20): **the handler, not the queue, ends
 * a message when its attempts are spent** (`outbound_message.max_attempts`),
 * so a limit above what the message was given is never reached, and one below
 * it would leave a retried message waiting in the queue's hands.
 */
export const sendMessageJob = defineJob({
  name: "messaging.send",
  payload: z.object({ messageId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 19, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
  singleton: false,
});

/**
 * Applies one webhook delivery of the provider. Out of the request on
 * purpose (TASK-024 requirement 4): the provider gets its 200 at once and
 * does not repeat the delivery because we were slow.
 */
export const applyWebhookEventJob = defineJob({
  name: "messaging.apply-webhook-event",
  payload: z.object({ eventId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 5, delaySeconds: 30, backoff: true },
  singleton: false,
});

/** Deletes processed webhook deliveries older than `webhook_event_retention_days`. */
export const webhookEventCleanupJob = defineSweeperJob({
  name: "messaging.cleanup-webhook-events",
});

/**
 * Clears the values of the placeholders of messages that were settled
 * longer ago than `message_variables_retention_days` — the messages that
 * kept them because they could still have been retried (ARCHITECTURE 4.35).
 */
export const messageVariablesCleanupJob = defineSweeperJob({
  name: "messaging.clear-stale-variables",
});

/**
 * Recovers messages whose sending was interrupted and whose job will never
 * come back for them (ARCHITECTURE 4.35 I358): `sent` if the provider's id had
 * been written down, `unknown` if not. Never sends anything.
 */
export const messageRecoveryJob = defineSweeperJob({ name: "messaging.recover-interrupted" });

export const messagingJobCatalog = [
  sendMessageJob,
  applyWebhookEventJob,
  applyButtonPressJob,
  webhookEventCleanupJob,
  messageVariablesCleanupJob,
  messageRecoveryJob,
];
