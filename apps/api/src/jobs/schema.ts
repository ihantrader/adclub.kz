import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `periodic_job_state` (migration `create-periodic-job-state`): the last
 * start, success and failure of each periodic job. The pg-boss tables
 * (schema `pgboss`) belong to the library and are not described here
 * (ARCHITECTURE 4.12 I112).
 */
export const periodicJobState = pgTable("periodic_job_state", {
  name: text("name").primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobsTables = [periodicJobState];
