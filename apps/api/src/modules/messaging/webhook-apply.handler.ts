import { Inject, Injectable, Logger } from "@nestjs/common";
import { describeError } from "../../common/health";
import { JobQueue, type JobHandler } from "../../jobs";
import { applyWebhookEventJob } from "./message-jobs";
import { DEFERRED_RETRY_MS, WebhookEvents } from "./webhook-events.service";

/**
 * Applies one webhook delivery in the worker (TASK-024 requirement 4): the
 * request that took it answered the provider long ago. A failure here is
 * retried by the queue and, once the retries run out, the delivery is in
 * `jobs:dead` with the event's id — the event itself keeps its body until
 * it has been applied, so a retry has something to work with.
 */
@Injectable()
export class WebhookEventApplier implements JobHandler<{ eventId: string }> {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(WebhookEvents) private readonly events: WebhookEvents,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  async run({ eventId }: { eventId: string }): Promise<void> {
    try {
      const { result } = await this.events.apply(eventId);
      if (result === "deferred") {
        // Not a failure, so not a retry of this job: a new one, a little later.
        await this.queue.enqueue(
          applyWebhookEventJob,
          { eventId },
          { startAfter: new Date(Date.now() + DEFERRED_RETRY_MS) },
        );
      }
    } catch (error) {
      const described = describeError(error);
      await this.events.recordFailure(eventId, described);
      this.logger.warn(`Webhook event could not be applied event=${eventId}: ${described}`);
      throw error;
    }
  }
}
