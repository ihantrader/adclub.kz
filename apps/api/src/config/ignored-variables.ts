import type { LoggerService } from "@nestjs/common";
import type { AppConfig } from "./env.schema";

/**
 * Tells whoever starts a process that some environment variables no
 * longer do anything: their values are settings now, changed with the
 * operator command or in the admin panel (ARCHITECTURE 4.11).
 */
export function warnIgnoredVariables(config: AppConfig, logger: LoggerService): void {
  if (config.ignoredVariables.length === 0) {
    return;
  }
  logger.warn(
    `Ignored environment variables (these values are settings now — see "operator settings:list"): ${config.ignoredVariables.join(", ")}`,
    "Config",
  );
}
