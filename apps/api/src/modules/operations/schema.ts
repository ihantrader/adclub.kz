import { bigserial, boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * What the operations scripts did (TASK-055; ARCHITECTURE 4.82, 15.4): the
 * daily dump of the database, the daily copy of the files bucket and the
 * weekly restore check. Written by `infra/docker/ops` with `psql` (one row a
 * run); the application only reads it, for its metrics.
 */
export const opsRunKinds = ["db_backup", "files_backup", "restore_check"] as const;
export type OpsRunKind = (typeof opsRunKinds)[number];

export const opsRun = pgTable("ops_run", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").$type<OpsRunKind>().notNull(),
  ok: boolean("ok").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
});

export const operationsTables = [opsRun] as const;
