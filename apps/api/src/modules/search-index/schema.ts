import { sql } from "drizzle-orm";
import { bigserial, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A change of something a document of the search index is made of
 * (TASK-045; ARCHITECTURE 10.1, 4.65). Written only by the trigger function
 * `search_outbox_register` of the migration `…_search-index.sql`, in the
 * transaction of the change itself; the worker applies the rows and marks
 * them processed.
 */
export const searchOutboxSubjectKinds = [
  "item",
  "category",
  "option",
  "brand",
  "supplier",
  "location",
] as const;

export type SearchOutboxSubjectKind = (typeof searchOutboxSubjectKinds)[number];

export const searchOutbox = pgTable("search_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  subjectKind: text("subject_kind").$type<SearchOutboxSubjectKind>().notNull(),
  subjectId: uuid("subject_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/** One row: what the worker knows about the index. */
export const searchIndexState = pgTable("search_index_state", {
  id: smallint("id")
    .primaryKey()
    .default(sql`1`),
  synonymsHash: text("synonyms_hash"),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  lastError: text("last_error"),
  lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }),
  reindexStartedAt: timestamp("reindex_started_at", { withTimezone: true }),
  lastReindexedAt: timestamp("last_reindexed_at", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  lastReconcileDocuments: integer("last_reconcile_documents"),
  lastReconcileMismatches: integer("last_reconcile_mismatches"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const searchIndexTables = [searchOutbox, searchIndexState];
