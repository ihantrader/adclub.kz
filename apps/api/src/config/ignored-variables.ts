import type { LoggerService } from "@nestjs/common";
import type { AppConfig } from "./env.schema";

/**
 * Tells whoever starts a process that some environment variables no
 * longer do anything: their values are settings now, changed with the
 * operator command or in the admin panel (ARCHITECTURE 4.11), or they
 * belonged to something the project no longer has (`ANTHROPIC_API_KEY`
 * — the direct channel to Anthropic, replaced by OpenRouter, 4.20).
 */
export function warnIgnoredVariables(config: AppConfig, logger: LoggerService): void {
  if (config.ignoredVariables.length === 0) {
    return;
  }
  logger.warn(
    `Ignored environment variables (these are settings now — see "operator settings:list" — or belong to something removed): ${config.ignoredVariables.join(", ")}`,
    "Config",
  );
}
