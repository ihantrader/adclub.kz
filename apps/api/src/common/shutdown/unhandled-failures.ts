import type { LoggerService } from "@nestjs/common";
import type { ErrorReporter } from "../../observability";

/**
 * A failure nobody caught: an unhandled rejection or an exception that
 * escaped every handler. It is logged (sanitized, like every line) and
 * reported to error monitoring, and the process goes on — an API that
 * stays up serving the rest is better than one that dies on a stray
 * rejection (ARCHITECTURE 15.3, TASK-009).
 */
export function reportUnhandledFailures(options: {
  logger: LoggerService;
  reporter: ErrorReporter;
  context: string;
}): void {
  const { logger, reporter, context } = options;
  const report = (kind: "unhandledRejection" | "uncaughtException", error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.error(failure, context);
    reporter.captureException(failure, { transaction: context, tags: { kind } });
  };
  process.on("unhandledRejection", (reason) => report("unhandledRejection", reason));
  process.on("uncaughtException", (error) => report("uncaughtException", error));
}
