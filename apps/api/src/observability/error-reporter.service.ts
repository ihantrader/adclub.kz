import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
// Leaf files, never a module barrel: the logger and the error filter
// import this module, and a cycle through a barrel breaks at load time.
import { getRequestId } from "../common/logging/request-context";
import { Metrics } from "./metrics.service";
import type { MonitoringTarget } from "./monitoring-dsn";
import { sanitizeForTransport, sanitizeText } from "./sanitizer";

/** What is known about the failure besides the error itself. */
export interface ErrorContext {
  /** Where it happened: a route template, a job name, `bootstrap`. */
  transaction?: string;
  /** Short, low-cardinality facts: `kind=api`, `status=500`. */
  tags?: Record<string, string | number>;
  /** Anything else worth having; it goes through the sanitizer like the rest. */
  extra?: Record<string, unknown>;
}

/** How long one event may take to reach the receiver before it is given up on. */
const SEND_TIMEOUT_MS = 3000;
/** At most this many events are in flight; the rest are dropped, never queued. */
const MAX_IN_FLIGHT = 20;
const SDK_NAME = "adclub-observability";

/** An error as the sanitizer returns it (`sanitizeValue`): plain, cleaned fields. */
interface CleanedError {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  cause?: unknown;
}

/** How many causes of an error are sent along with it. */
const MAX_CAUSES = 5;

/**
 * The error and its causes (already cleaned), innermost first as the
 * receiver expects — the cause is often what explains the failure (the
 * PostgreSQL error under a failed Drizzle query, TASK-009.A).
 */
function exceptionValues(
  described: CleanedError | undefined,
): MonitoringEvent["exception"]["values"] {
  const values: MonitoringEvent["exception"]["values"] = [];
  let current: CleanedError | undefined = described;
  while (current && typeof current === "object" && values.length <= MAX_CAUSES) {
    values.unshift({
      type: typeof current.name === "string" ? current.name : "Error",
      value: typeof current.message === "string" ? current.message : "Unknown error",
      ...(values.length === 0 &&
        typeof current.stack === "string" && { stacktrace_raw: current.stack }),
    });
    current = current.cause as CleanedError | undefined;
  }
  return values.length > 0 ? values : [{ type: "Error", value: "Unknown error" }];
}

interface MonitoringEvent {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error";
  environment: string;
  logger: string;
  transaction?: string;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  exception: { values: { type: string; value: string; stacktrace_raw?: string }[] };
}

/**
 * Error monitoring (ARCHITECTURE 15.3, D2): unexpected failures of the API
 * and the worker leave the process already cleaned — every field goes
 * through the sanitizer, and a failure of the sanitizer itself means the
 * event is dropped, never sent as it was. Expected outcomes of business
 * logic (4xx) are not sent at all.
 *
 * Without a configured receiver (`MONITORING_DSN`) reporting is off and the
 * application behaves exactly as before. Sending never blocks the request:
 * the event is posted in the background with a timeout, and a receiver that
 * is down, slow or unreachable only shows up in
 * `adclub_monitoring_events_total`.
 */
@Injectable()
export class ErrorReporter {
  private readonly logger = new Logger("Observability");
  private readonly target: MonitoringTarget | undefined;
  private readonly environment: string;
  private inFlight = 0;
  private readonly sending = new Set<Promise<void>>();

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    this.target = config.monitoring.target;
    this.environment = config.monitoring.environment;
    if (this.target) {
      this.logger.log(
        `Error monitoring on: ${this.target.publicDsn} (environment ${this.environment})`,
      );
    }
  }

  get enabled(): boolean {
    return this.target !== undefined;
  }

  /**
   * Reports one failure. Returns at once — nothing about the request waits
   * for the receiver — and never throws.
   */
  captureException(error: unknown, context: ErrorContext = {}): void {
    if (!this.target) {
      this.metrics.countMonitoringEvent("disabled");
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.metrics.countMonitoringEvent("dropped");
      return;
    }
    const event = this.buildEvent(error, context);
    if (!event) {
      return;
    }
    this.inFlight += 1;
    const sending = this.send(this.target, event).finally(() => {
      this.inFlight -= 1;
      this.sending.delete(sending);
    });
    this.sending.add(sending);
  }

  /**
   * Waits until the events already offered have left (or failed), at most
   * `timeoutMs` — before a process exits on an uncaught exception.
   */
  async flush(timeoutMs: number): Promise<void> {
    if (this.sending.size === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.sending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The event as it will be sent, or nothing if it could not be cleaned. */
  private buildEvent(error: unknown, context: ErrorContext): MonitoringEvent | undefined {
    const cleaned = sanitizeForTransport({
      error,
      tags: context.tags ?? {},
      extra: context.extra ?? {},
    });
    if (!cleaned.ok) {
      // Nothing leaves the process when the sanitizer fails (TASK-009, AC-3).
      this.metrics.countSanitizerFailure();
      this.metrics.countMonitoringEvent("dropped");
      this.logger.warn("An error was not reported: it could not be sanitized");
      return undefined;
    }
    const value = cleaned.value as {
      error: { name?: unknown; message?: unknown; stack?: unknown } | unknown;
      tags: Record<string, unknown>;
      extra: Record<string, unknown>;
    };
    const described = value.error as CleanedError;
    const tags: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.tags)) {
      if (typeof item === "string" || typeof item === "number") {
        tags[key] = String(item);
      }
    }
    const requestId = getRequestId();
    if (requestId) {
      tags.request_id = requestId;
    }
    return {
      event_id: randomUUID().replace(/-/g, ""),
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      environment: this.environment,
      logger: SDK_NAME,
      ...(context.transaction && { transaction: sanitizeText(context.transaction) }),
      tags,
      extra: value.extra,
      exception: { values: exceptionValues(described) },
    };
  }

  private async send(target: MonitoringTarget, event: MonitoringEvent): Promise<void> {
    const envelope = [
      JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    try {
      const response = await fetch(target.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=${SDK_NAME}/0.1.0, sentry_key=${target.publicKey}`,
        },
        body: envelope,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.metrics.countMonitoringEvent("failed");
        return;
      }
      this.metrics.countMonitoringEvent("sent");
    } catch {
      // A receiver that is down or slow must not disturb anything here.
      this.metrics.countMonitoringEvent("failed");
    }
  }
}
