import type { LoggerService } from "@nestjs/common";
import type { ErrorReporter } from "../../observability";

/** How long an uncaught exception waits for its event to leave before the exit. */
const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

export interface UnhandledFailureOptions {
  logger: LoggerService;
  reporter: Pick<ErrorReporter, "captureException" | "flush">;
  /** Log context, e.g. `"Bootstrap"` or `"Worker"`. */
  context: string;
  /**
   * Upper bound for sending the event of an uncaught exception before the
   * process exits; within the shutdown limit (`installGracefulShutdown`).
   */
  exitTimeoutMs?: number;
  /** Ends the process (tests replace it). */
  exit?: (code: number) => void;
}

export interface UnhandledFailureHandlers {
  onRejection: (reason: unknown) => void;
  onException: (error: unknown) => void;
}

/**
 * What happens to a failure nobody caught (ARCHITECTURE 15.3, 4.13):
 *
 * - an unhandled rejection is logged and reported (sanitized, like every
 *   line and event) and the process goes on: a promise nobody awaited
 *   failed, the state of the process itself is intact, and an API that
 *   stays up serving the rest is better than one that dies on it;
 * - an uncaught exception is logged and reported too, but then the process
 *   exits with code 1: the exception escaped in the middle of whatever it
 *   interrupted, and nothing says the process is still sound (Node's own
 *   advice). The event gets up to `exitTimeoutMs` to leave; restarting is
 *   the job of the environment (Docker `restart`, systemd).
 */
export function unhandledFailureHandlers(
  options: UnhandledFailureOptions,
): UnhandledFailureHandlers {
  const {
    logger,
    reporter,
    context,
    exitTimeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
    exit = (code) => process.exit(code),
  } = options;
  let exiting = false;

  const report = (kind: "unhandledRejection" | "uncaughtException", error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.error(failure, context);
    reporter.captureException(failure, { transaction: context, tags: { kind } });
  };

  return {
    onRejection: (reason) => report("unhandledRejection", reason),
    onException: (error) => {
      if (exiting) {
        // Another one while the first is being sent: nothing more to wait for.
        exit(1);
        return;
      }
      exiting = true;
      report("uncaughtException", error);
      logger.error("Uncaught exception: the process is exiting", context);
      void reporter
        .flush(exitTimeoutMs)
        .catch(() => undefined)
        .finally(() => exit(1));
    },
  };
}

/** Installs `unhandledFailureHandlers` on the process (API and worker). */
export function reportUnhandledFailures(options: UnhandledFailureOptions): void {
  const handlers = unhandledFailureHandlers(options);
  process.on("unhandledRejection", handlers.onRejection);
  process.on("uncaughtException", handlers.onException);
}
