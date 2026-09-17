/** What a run knows about itself. */
export interface JobRunContext {
  jobId: string;
  /** 1 for the first run, 2 for the first retry, … */
  attempt: number;
  /** Aborted when the run timed out or the worker is stopping: finish or stop soon. */
  signal: AbortSignal;
}

/** Implementation of an on-demand job. Idempotent (ARCHITECTURE 4.12 I114). */
export interface JobHandler<Payload> {
  run(payload: Payload, context: JobRunContext): Promise<void>;
}

/** Implementation of a periodic job. Idempotent. */
export interface PeriodicJobHandler {
  run(context: JobRunContext): Promise<void>;
}

/**
 * Thrown by a handler for a job that can never succeed (e.g. its data no
 * longer makes sense): no retries, straight to the dead letter queue.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}
