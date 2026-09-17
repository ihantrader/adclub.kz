import type { AppConfig } from "./config";
import { devJobCatalog, type JobDefinition } from "./jobs";

/**
 * Every background job the application declares (ARCHITECTURE 13.2, 4.12).
 * All processes of one environment use the same list: the API and the
 * operator command put jobs on the queue, the worker runs them and fails
 * to start if one has no implementation. A module that adds jobs adds
 * them here.
 */
export function backgroundJobCatalog(config: Pick<AppConfig, "nodeEnv">): JobDefinition[] {
  return [...(hasDevJobs(config) ? devJobCatalog : [])];
}

/** The always-failing job of `operator dev:jobs:fail` exists in development and tests only. */
export function hasDevJobs(config: Pick<AppConfig, "nodeEnv">): boolean {
  return config.nodeEnv === "development" || config.nodeEnv === "test";
}
