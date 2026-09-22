import type { PgTable } from "drizzle-orm/pg-core";
import { jobsTables } from "./jobs";
import { aiTables } from "./modules/ai";
import { auditTables } from "./modules/audit";
import { catalogTables } from "./modules/catalog";
import { clubAccessTables } from "./modules/club-access";
import { compatibilityTables } from "./modules/compatibility";
import { identityTables } from "./modules/identity";
import { offerTables } from "./modules/offers";
import { settingsTables } from "./modules/settings";
import { supplierTables } from "./modules/suppliers";
import { vehicleTables } from "./modules/vehicles";

/**
 * Every table the application describes in Drizzle. The schema drift
 * check (`database/schema-drift.integration.test.ts`) compares this list
 * with the database the migrations produce, so a module that adds tables
 * must add them here.
 */
export const ormTables: readonly PgTable[] = [
  ...identityTables,
  ...settingsTables,
  ...auditTables,
  ...aiTables,
  ...catalogTables,
  ...vehicleTables,
  ...compatibilityTables,
  ...supplierTables,
  ...offerTables,
  ...clubAccessTables,
  ...jobsTables,
];
