import type { AppConfig } from "./config";
import { devJobCatalog, type JobDefinition } from "./jobs";
import { catalogJobCatalog, photoJobCatalog } from "./modules/catalog";
import { identityJobCatalog } from "./modules/identity";
import { messagingJobCatalog } from "./modules/messaging";
import { orderJobCatalog } from "./modules/orders";
import { supplierJobCatalog } from "./modules/suppliers";
import { vehicleJobCatalog } from "./modules/vehicles";

/**
 * Every background job the application declares (ARCHITECTURE 13.2, 4.12).
 * All processes of one environment use the same list: the API and the
 * operator command put jobs on the queue, the worker runs them and fails
 * to start if one has no implementation. A module that adds jobs adds
 * them here.
 */
export function backgroundJobCatalog(config: Pick<AppConfig, "nodeEnv">): JobDefinition[] {
  return [
    ...identityJobCatalog,
    ...catalogJobCatalog,
    ...photoJobCatalog,
    ...vehicleJobCatalog,
    ...messagingJobCatalog,
    ...supplierJobCatalog,
    ...orderJobCatalog,
    ...(hasDevJobs(config) ? devJobCatalog : []),
  ];
}

/** The always-failing job of `operator dev:jobs:fail` exists in development and tests only. */
export function hasDevJobs(config: Pick<AppConfig, "nodeEnv">): boolean {
  return config.nodeEnv === "development" || config.nodeEnv === "test";
}
