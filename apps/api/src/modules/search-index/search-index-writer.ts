import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import {
  SearchIndexMissingError,
  SearchIndexTaskError,
  SearchIndexUnavailableError,
  type MeiliClient,
} from "./meilisearch";
import { searchIndexState, searchOutbox, type SearchOutboxSubjectKind } from "./schema";
import { searchIndexSettings, synonymsHash, type SearchIndexDocument } from "./search-document";
import { SearchDocuments, SEARCH_DOCUMENT_BATCH } from "./search-documents";
import { meiliClient, SEARCH_WRITE_TIMEOUT_MS } from "./search-index.service";

/** Rows of the outbox applied in one go. */
export const OUTBOX_BATCH = 1000;
/** Processed rows are kept this long (a rebuild applies again what changed while it ran). */
const PROCESSED_RETENTION_HOURS = 24;
/** A rebuild that started longer ago than this is taken to have died. */
const REINDEX_STALE_MINUTES = 60;
/** After a failure the worker waits 2^n seconds, at most this many. */
const RETRY_MAX_SECONDS = 300;
/** Documents read back from the index per page (the nightly check). */
const FETCH_PAGE = 1000;
/** A task of the index (a batch of documents, settings, a swap) may take this long. */
const TASK_TIMEOUT_MS = 120_000;

export class SearchReindexBusyError extends Error {
  constructor() {
    super("A rebuild of the search index is already running; try again when it ends");
    this.name = "SearchReindexBusyError";
  }
}

export interface ApplyOutcome {
  /** No index configured, or it failed and the next attempt is not due yet. */
  skipped: "disabled" | "waiting" | null;
  /** The index did not answer: the rows stay, the next attempt is later. */
  failed: boolean;
  rows: number;
  upserted: number;
  deleted: number;
  /** The index did not exist and was built. */
  built: boolean;
}

export interface ReconcileOutcome {
  documents: number;
  missing: number;
  extra: number;
  stale: number;
  /** Documents whose popularity alone changed (not a mismatch). */
  popularity: number;
  mismatches: number;
}

export interface SearchIndexStatus {
  enabled: boolean;
  index: string;
  reachable: boolean;
  documents: number | null;
  isIndexing: boolean | null;
  outbox: { pending: number; oldestPendingSeconds: number | null };
  failures: number;
  retryAfter: string | null;
  lastError: string | null;
  lastAppliedAt: string | null;
  reindexing: boolean;
  lastReindexedAt: string | null;
  lastReconcile: { at: string; documents: number | null; mismatches: number | null } | null;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Keeps the search index in step with PostgreSQL (TASK-045; ARCHITECTURE
 * 10.1, 4.65). Three ways, one source — `SearchDocuments`:
 *
 * - `applyOutbox` — the rows of `search_outbox` (written by the trigger
 *   function in the transaction of each change): the items they touch are
 *   worked out anew and put in the index or taken out of it; the rows are
 *   marked processed. Run by the singleton job `search.apply-outbox`, so
 *   two batches never race to the index with documents of different ages.
 *   The index not answering is not an error of the job: the rows stay, the
 *   failure is written down, and the next attempt waits 2^n seconds (at
 *   most five minutes) — the outbox grows and is applied once it answers.
 * - `rebuild` — a new index built whole beside the live one and swapped
 *   into it (`swap-indexes`): searching never stops. What changed while it
 *   was built is applied again afterwards (the outbox rows since its start
 *   are marked unprocessed).
 * - `reconcile` — the nightly check: every document the database gives
 *   against what the index holds; missing, extra and stale ones are fixed
 *   and counted (the metric, the log, `search:status`); popularity is
 *   brought up to date without counting as a mismatch.
 */
@Injectable()
export class SearchIndexWriter {
  private readonly logger = new Logger("SearchIndex");
  private readonly client: MeiliClient | null;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SearchDocuments) private readonly documents: SearchDocuments,
  ) {
    this.client = meiliClient(config, SEARCH_WRITE_TIMEOUT_MS);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  private get index(): string {
    return this.config.search.index;
  }

  // ------------------------------------------------------------- outbox

  /** Whether there is something for `applyOutbox` to do now (the watcher asks every second). */
  async due(): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    const rows = await this.database.db.execute<{ due: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM search_outbox WHERE processed_at IS NULL)
        AND coalesce((SELECT retry_after <= now() FROM search_index_state WHERE id = 1), true) AS due
    `);
    return rows.rows[0]?.due === true;
  }

  async applyOutbox(signal?: AbortSignal): Promise<ApplyOutcome> {
    const outcome: ApplyOutcome = {
      skipped: null,
      failed: false,
      rows: 0,
      upserted: 0,
      deleted: 0,
      built: false,
    };
    const client = this.client;
    if (!client) {
      return { ...outcome, skipped: "disabled" };
    }
    await this.ensureState();
    const [state] = await this.database.db
      .select({ retryAfter: searchIndexState.retryAfter })
      .from(searchIndexState)
      .where(eq(searchIndexState.id, 1));
    if (state?.retryAfter && state.retryAfter.getTime() > Date.now()) {
      return { ...outcome, skipped: "waiting" };
    }
    try {
      if (!(await client.indexExists(this.index))) {
        await this.rebuild();
        outcome.built = true;
      }
      await this.syncSynonyms(client, this.index);
      for (;;) {
        if (signal?.aborted) {
          break;
        }
        const rows = await this.database.db
          .select({
            id: searchOutbox.id,
            kind: searchOutbox.subjectKind,
            subject: searchOutbox.subjectId,
          })
          .from(searchOutbox)
          .where(sql`${searchOutbox.processedAt} IS NULL`)
          .orderBy(searchOutbox.id)
          .limit(OUTBOX_BATCH);
        if (rows.length === 0) {
          break;
        }
        const itemIds = await this.documents.itemsOf(
          rows.map((row) => ({ kind: row.kind, id: row.subject })),
        );
        const written = await this.write(client, this.index, itemIds);
        outcome.upserted += written.upserted;
        outcome.deleted += written.deleted;
        outcome.rows += rows.length;
        await this.database.db.execute(sql`
          UPDATE search_outbox SET processed_at = now()
          WHERE id = ANY(${`{${rows.map((row) => row.id).join(",")}}`}::bigint[])
        `);
      }
      await this.database.db.execute(sql`
        UPDATE search_index_state
        SET failures = 0, retry_after = NULL, last_error = NULL,
            last_applied_at = CASE WHEN ${outcome.rows} > 0 THEN now() ELSE last_applied_at END,
            updated_at = now()
        WHERE id = 1
      `);
      return outcome;
    } catch (error) {
      if (error instanceof SearchReindexBusyError) {
        // The operator's rebuild makes the index; its end applies the rows.
        return { ...outcome, skipped: "waiting" };
      }
      if (!(
        error instanceof SearchIndexUnavailableError || error instanceof SearchIndexTaskError
      )) {
        throw error;
      }
      await this.recordFailure(error);
      return { ...outcome, failed: true };
    }
  }

  /** Puts the documents of these items in the index, or takes out those that are not to be there. */
  private async write(
    client: MeiliClient,
    index: string,
    itemIds: readonly string[],
  ): Promise<{ upserted: number; deleted: number }> {
    let upserted = 0;
    let deleted = 0;
    for (let start = 0; start < itemIds.length; start += SEARCH_DOCUMENT_BATCH) {
      const built = await this.documents.build(itemIds.slice(start, start + SEARCH_DOCUMENT_BATCH));
      const put: SearchIndexDocument[] = [];
      const gone: string[] = [];
      for (const [id, document] of built) {
        if (document) {
          put.push(document);
        } else {
          gone.push(id);
        }
      }
      if (put.length > 0) {
        await client.waitForTask(await client.addDocuments(index, put), TASK_TIMEOUT_MS);
      }
      if (gone.length > 0) {
        await client.waitForTask(await client.deleteDocuments(index, gone), TASK_TIMEOUT_MS);
      }
      upserted += put.length;
      deleted += gone.length;
    }
    return { upserted, deleted };
  }

  private async recordFailure(error: Error): Promise<void> {
    const message = error.message.slice(0, 500);
    const rows = await this.database.db.execute<{ failures: number; retry_after: Date }>(sql`
      UPDATE search_index_state
      SET failures = failures + 1,
          retry_after = now() + make_interval(secs => least(${RETRY_MAX_SECONDS}, power(2, failures + 1)::int)),
          last_error = ${message},
          updated_at = now()
      WHERE id = 1
      RETURNING failures, retry_after
    `);
    const state = rows.rows[0];
    this.logger.warn(
      `The search index did not take the changes (attempt ${state?.failures ?? "?"}); they wait in the outbox until ${
        state ? new Date(state.retry_after).toISOString() : "later"
      }: ${message}`,
    );
  }

  /** Puts the synonyms of the database in the index's settings when they changed. */
  private async syncSynonyms(client: MeiliClient, index: string): Promise<void> {
    const synonyms = await this.documents.synonyms();
    const hash = synonymsHash(synonyms);
    const [state] = await this.database.db
      .select({ hash: searchIndexState.synonymsHash })
      .from(searchIndexState)
      .where(eq(searchIndexState.id, 1));
    if (state?.hash === hash) {
      return;
    }
    await client.waitForTask(await client.updateSynonyms(index, synonyms), TASK_TIMEOUT_MS);
    await this.database.db
      .update(searchIndexState)
      .set({ synonymsHash: hash, updatedAt: new Date() })
      .where(eq(searchIndexState.id, 1));
  }

  // ------------------------------------------------------------ rebuild

  /**
   * A full rebuild without downtime: a new index is filled from the
   * database beside the live one and swapped into it. One at a time
   * (`SearchReindexBusyError`).
   */
  async rebuild(): Promise<{ documents: number; index: string; seconds: number }> {
    const client = this.requireClient();
    const started = Date.now();
    await this.ensureState();
    const claimed = await this.database.db.execute(sql`
      UPDATE search_index_state SET reindex_started_at = now(), updated_at = now()
      WHERE id = 1 AND (
        reindex_started_at IS NULL
        OR reindex_started_at < now() - make_interval(mins => ${REINDEX_STALE_MINUTES})
      )
      RETURNING id
    `);
    if (claimed.rows.length === 0) {
      throw new SearchReindexBusyError();
    }
    const next = `${this.index}__next`;
    try {
      const [{ last } = { last: 0 }] = (
        await this.database.db.execute<{ last: string | number }>(
          sql`SELECT coalesce(max(id), 0) AS last FROM search_outbox`,
        )
      ).rows.map((row) => ({ last: Number(row.last) }));
      if (await client.indexExists(next)) {
        await client.waitForTask(await client.deleteIndex(next), TASK_TIMEOUT_MS);
      }
      await client.waitForTask(await client.createIndex(next), TASK_TIMEOUT_MS);
      const synonyms = await this.documents.synonyms();
      await client.waitForTask(
        await client.updateSettings(next, searchIndexSettings(synonyms)),
        TASK_TIMEOUT_MS,
      );
      const ids = await this.documents.indexableItemIds();
      const written = await this.write(client, next, ids);
      if (!(await client.indexExists(this.index))) {
        await client.waitForTask(await client.createIndex(this.index), TASK_TIMEOUT_MS);
      }
      await client.waitForTask(await client.swapIndexes(this.index, next), TASK_TIMEOUT_MS);
      await client.waitForTask(await client.deleteIndex(next), TASK_TIMEOUT_MS);
      // What changed since the start may be missing from the new index (or
      // was applied to the old one): apply it again.
      await this.database.db.execute(sql`
        UPDATE search_outbox SET processed_at = NULL WHERE id > ${last} AND processed_at IS NOT NULL
      `);
      await this.database.db
        .update(searchIndexState)
        .set({
          synonymsHash: synonymsHash(synonyms),
          lastReindexedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(searchIndexState.id, 1));
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      this.logger.log(
        `Search index ${this.index} rebuilt: ${written.upserted} documents in ${seconds} s`,
      );
      return { documents: written.upserted, index: this.index, seconds };
    } finally {
      await this.database.db
        .update(searchIndexState)
        .set({ reindexStartedAt: null, updatedAt: new Date() })
        .where(eq(searchIndexState.id, 1));
    }
  }

  // ---------------------------------------------------------- reconcile

  /**
   * The nightly check: the documents of the database against the index.
   * Also clears processed outbox rows older than a day — with or without an
   * index, so the outbox of an environment without one does not grow.
   */
  async reconcile(): Promise<ReconcileOutcome | null> {
    await this.database.db.execute(sql`
      DELETE FROM search_outbox
      WHERE processed_at < now() - make_interval(hours => ${PROCESSED_RETENTION_HOURS})
        OR (${this.client === null} AND created_at < now() - make_interval(hours => ${PROCESSED_RETENTION_HOURS}))
    `);
    const client = this.client;
    if (!client) {
      return null;
    }
    await this.ensureState();
    if (!(await client.indexExists(this.index))) {
      const built = await this.rebuild();
      const outcome: ReconcileOutcome = {
        documents: built.documents,
        missing: built.documents,
        extra: 0,
        stale: 0,
        popularity: 0,
        mismatches: built.documents,
      };
      await this.recordReconcile(outcome);
      return outcome;
    }
    const [{ last } = { last: 0 }] = (
      await this.database.db.execute<{ last: string | number }>(
        sql`SELECT coalesce(max(id), 0) AS last FROM search_outbox`,
      )
    ).rows.map((row) => ({ last: Number(row.last) }));
    await this.syncSynonyms(client, this.index);
    const expected = new Map<string, SearchIndexDocument>();
    for (const [id, document] of await this.documents.build(
      await this.documents.indexableItemIds(),
    )) {
      if (document) {
        expected.set(id, document);
      }
    }
    const actual = new Map<string, { hash: unknown; popularity: unknown }>();
    for (let offset = 0; ; offset += FETCH_PAGE) {
      const page = await client.fetchDocuments(this.index, {
        offset,
        limit: FETCH_PAGE,
        fields: ["id", "hash", "popularity"],
      });
      for (const document of page.results) {
        actual.set(String(document.id), {
          hash: document.hash,
          popularity: document.popularity,
        });
      }
      if (page.results.length < FETCH_PAGE) {
        break;
      }
    }
    const put: SearchIndexDocument[] = [];
    const outcome: ReconcileOutcome = {
      documents: expected.size,
      missing: 0,
      extra: 0,
      stale: 0,
      popularity: 0,
      mismatches: 0,
    };
    for (const [id, document] of expected) {
      const held = actual.get(id);
      if (!held) {
        outcome.missing += 1;
        put.push(document);
      } else if (held.hash !== document.hash) {
        outcome.stale += 1;
        put.push(document);
      } else if (held.popularity !== document.popularity) {
        outcome.popularity += 1;
        put.push(document);
      }
    }
    const extra = [...actual.keys()].filter((id) => !expected.has(id));
    outcome.extra = extra.length;
    outcome.mismatches = outcome.missing + outcome.extra + outcome.stale;
    for (let start = 0; start < put.length; start += SEARCH_DOCUMENT_BATCH) {
      await client.waitForTask(
        await client.addDocuments(this.index, put.slice(start, start + SEARCH_DOCUMENT_BATCH)),
        TASK_TIMEOUT_MS,
      );
    }
    if (extra.length > 0) {
      await client.waitForTask(await client.deleteDocuments(this.index, extra), TASK_TIMEOUT_MS);
    }
    // A change applied while the check ran may have been overwritten by its
    // older document: apply it again.
    await this.database.db.execute(sql`
      UPDATE search_outbox SET processed_at = NULL WHERE id > ${last} AND processed_at IS NOT NULL
    `);
    await this.recordReconcile(outcome);
    return outcome;
  }

  private async recordReconcile(outcome: ReconcileOutcome): Promise<void> {
    await this.database.db
      .update(searchIndexState)
      .set({
        lastReconciledAt: new Date(),
        lastReconcileDocuments: outcome.documents,
        lastReconcileMismatches: outcome.mismatches,
        updatedAt: new Date(),
      })
      .where(eq(searchIndexState.id, 1));
    const line = `Search index check: ${outcome.documents} documents, ${outcome.mismatches} mismatches fixed (missing ${outcome.missing}, extra ${outcome.extra}, stale ${outcome.stale}), popularity updated ${outcome.popularity}`;
    if (outcome.mismatches > 0) {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }

  // -------------------------------------------------------------- status

  async status(): Promise<SearchIndexStatus> {
    const [stateRows, outboxRows] = await Promise.all([
      this.database.db.select().from(searchIndexState).where(eq(searchIndexState.id, 1)),
      this.database.db.execute<{ pending: number; oldest: number | null }>(sql`
        SELECT count(*)::int AS pending,
          extract(epoch FROM now() - min(created_at))::int AS oldest
        FROM search_outbox WHERE processed_at IS NULL
      `),
    ]);
    const state = stateRows[0];
    const outbox = outboxRows.rows[0];
    let reachable = false;
    let documents: number | null = null;
    let isIndexing: boolean | null = null;
    if (this.client) {
      try {
        const stats = await this.client.stats(this.index);
        reachable = true;
        documents = stats.numberOfDocuments;
        isIndexing = stats.isIndexing;
      } catch (error) {
        reachable = error instanceof SearchIndexMissingError ? await this.client.health() : false;
      }
    }
    return {
      enabled: this.client !== null,
      index: this.index,
      reachable,
      documents,
      isIndexing,
      outbox: {
        pending: Number(outbox?.pending ?? 0),
        oldestPendingSeconds:
          outbox?.oldest === null || outbox?.oldest === undefined ? null : Number(outbox.oldest),
      },
      failures: state?.failures ?? 0,
      retryAfter: iso(state?.retryAfter ?? null),
      lastError: state?.lastError ?? null,
      lastAppliedAt: iso(state?.lastAppliedAt ?? null),
      reindexing: state?.reindexStartedAt != null,
      lastReindexedAt: iso(state?.lastReindexedAt ?? null),
      lastReconcile: state?.lastReconciledAt
        ? {
            at: state.lastReconciledAt.toISOString(),
            documents: state.lastReconcileDocuments,
            mismatches: state.lastReconcileMismatches,
          }
        : null,
    };
  }

  /** The one row of the state (the migration puts it; an emptied database may have lost it). */
  private async ensureState(): Promise<void> {
    await this.database.db.execute(
      sql`INSERT INTO search_index_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    );
  }

  private requireClient(): MeiliClient {
    if (!this.client) {
      throw new SearchIndexUnavailableError(
        "No search index is configured (MEILISEARCH_URL is not set)",
      );
    }
    return this.client;
  }
}

export type { SearchOutboxSubjectKind };
