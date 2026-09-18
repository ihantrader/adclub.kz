import type { AppConfig } from "../../config";
import { ConfigValidationError } from "../../config/env.schema";
import { sanitizeForLog } from "../../observability/sanitizer";
import { JsonLoggerService } from "../logging/json-logger.service";

/**
 * A process that could not start (API or worker) says why — through the
 * sanitizer like every other line (TASK-009.A): the failure may be a
 * query with bound values or a connection string with a password. A
 * configuration error stays a readable list of variables; anything else is
 * a JSON log line with the cleaned message and stack.
 */
export function logStartupFailure(
  what: string,
  context: string,
  error: unknown,
  write: (text: string) => void = (text) => process.stderr.write(`${text}\n`),
): void {
  if (error instanceof ConfigValidationError) {
    write(sanitizeForLog(error.message));
    return;
  }
  // No configuration may have loaded: the logger needs only its level.
  const logger = new JsonLoggerService({ logLevel: "error" } as AppConfig);
  const failure = error instanceof Error ? error : new Error(String(error));
  logger.error(`Failed to start ${what}`, context);
  logger.error(failure, context);
}
