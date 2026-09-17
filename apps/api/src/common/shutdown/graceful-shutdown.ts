import type { LoggerService } from "@nestjs/common";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type ShutdownSignal = (typeof SIGNALS)[number];

export interface GracefulShutdownOptions {
  logger: LoggerService;
  /** Log context, e.g. `"Bootstrap"` or `"Worker"`. */
  context: string;
  /** Releases the process's resources; the process exits once this settles. */
  close: () => Promise<void>;
  /** Forces a nonzero exit if `close` hasn't settled by then. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Shared SIGINT/SIGTERM handling for the API and worker processes
 * (TASK-005.A, `verify:graceful-shutdown` script): logs
 * `Received <signal>, shutting down` (the exact marker that script checks
 * for), runs `close()`, and exits 0. A second signal — or the same signal
 * again — arriving while shutdown is already in progress is logged and
 * ignored, so `close()` never runs twice. If `close()` hangs or rejects,
 * the process still exits (nonzero, with the reason logged) once
 * `timeoutMs` elapses, instead of hanging forever or dying silently.
 */
export function installGracefulShutdown({
  logger,
  context,
  close,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: GracefulShutdownOptions): void {
  let shuttingDown = false;

  const shutdown = (signal: ShutdownSignal): void => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} while already shutting down, ignoring`, context);
      return;
    }
    shuttingDown = true;
    logger.log(`Received ${signal}, shutting down`, context);

    const forceExit = setTimeout(() => {
      logger.error(`Shutdown did not complete within ${timeoutMs}ms, forcing exit`, context);
      process.exit(1);
    }, timeoutMs);

    close()
      .then(() => {
        clearTimeout(forceExit);
        process.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(forceExit);
        logger.error(
          `Shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
          context,
        );
        process.exit(1);
      });
  };

  for (const signal of SIGNALS) {
    process.on(signal, () => shutdown(signal));
  }
}
