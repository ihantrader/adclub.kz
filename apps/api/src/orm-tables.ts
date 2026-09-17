import type { PgTable } from "drizzle-orm/pg-core";
import { jobsTables } from "./jobs";
import { identityTables } from "./modules/identity";
import { settingsTables } from "./modules/settings";

/**
 * Every table the application describes in Drizzle. The schema drift
 * check (`database/schema-drift.integration.test.ts`) compares this list
 * with the database the migrations produce, so a module that adds tables
 * must add them here.
 */
export const ormTables: readonly PgTable[] = [
  ...identityTables,
  ...settingsTables,
  ...jobsTables,
];
