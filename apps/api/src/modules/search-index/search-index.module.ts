import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import {
  JobQueue,
  JobRegistry,
  type JobHandler,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { Metrics } from "../../observability";
import { SearchDocuments } from "./search-documents";
import { searchApplyOutboxJob, searchReconcileJob } from "./search-index-jobs";
import { SearchIndexWriter } from "./search-index-writer";
import { SearchIndex } from "./search-index.service";

/** How often the worker looks at the outbox. */
export const OUTBOX_WATCH_INTERVAL_MS = 1000;

/** `search.apply-outbox`. */
@Injectable()
export class SearchOutboxApplier implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger("SearchIndex");

  constructor(@Inject(SearchIndexWriter) private readonly writer: SearchIndexWriter) {}

  async run(_payload: Record<string, never>, context: JobRunContext): Promise<void> {
    const outcome = await this.writer.applyOutbox(context.signal);
    if (outcome.rows > 0 || outcome.built) {
      this.logger.log(
        `Search index updated: ${outcome.rows} changes, ${outcome.upserted} documents put, ${outcome.deleted} taken out${outcome.built ? " (the index was built)" : ""}`,
      );
    }
  }
}

/** `search.reconcile`. */
@Injectable()
export class SearchReconciler implements PeriodicJobHandler {
  constructor(@Inject(SearchIndexWriter) private readonly writer: SearchIndexWriter) {}

  async run(): Promise<JobRunOutcome> {
    const outcome = await this.writer.reconcile();
    return { worked: outcome !== null };
  }
}

/**
 * The worker's watcher of the outbox: every second, when there are rows to
 * apply and no failure asks to wait, it puts `search.apply-outbox` on the
 * queue (a singleton — while one waits, more are dropped). The first look
 * puts one on the queue regardless, so a missing index is built when the
 * worker starts.
 */
@Injectable()
export class SearchOutboxWatcher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("SearchIndex");
  private timer: NodeJS.Timeout | null = null;
  private first = true;
  private busy = false;

  constructor(
    @Inject(SearchIndexWriter) private readonly writer: SearchIndexWriter,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.writer.enabled) {
      return;
    }
    this.timer = setInterval(() => void this.look(), OUTBOX_WATCH_INTERVAL_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async look(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      if (this.first || (await this.writer.due())) {
        this.first = false;
        await this.queue.enqueue(searchApplyOutboxJob, {});
      }
    } catch (error) {
      // The database is away: the next look tries again.
      this.logger.debug?.(
        `Could not look at the search outbox: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }
}

/** The state of the index for `GET /metrics`, sampled from the database (the worker writes it). */
@Injectable()
export class SearchIndexMetrics implements OnModuleInit {
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectSearch(async () => {
      const rows = await this.database.db.execute<{
        pending: number;
        failures: number;
        mismatches: number | null;
      }>(sql`
        SELECT (SELECT count(*)::int FROM search_outbox WHERE processed_at IS NULL) AS pending,
          s.failures, s.last_reconcile_mismatches AS mismatches
        FROM search_index_state s WHERE s.id = 1
      `);
      const row = rows.rows[0];
      this.metrics.setSearchIndexState({
        outboxPending: Number(row?.pending ?? 0),
        failures: Number(row?.failures ?? 0),
        reconcileMismatches:
          row?.mismatches === null || row?.mismatches === undefined ? null : Number(row.mismatches),
      });
    });
  }
}

/**
 * The search index (TASK-045; ARCHITECTURE 10, 4.65) for the API and the
 * operator command: reading it (`SearchIndex`), the documents
 * (`SearchDocuments`), keeping it (`SearchIndexWriter` — the operator's
 * `search:reindex` and `search:status`).
 */
@Module({
  providers: [SearchIndex, SearchDocuments, SearchIndexWriter],
  exports: [SearchIndex, SearchDocuments, SearchIndexWriter],
})
export class SearchIndexModule {}

/** The metrics of the index, for the process that serves `GET /metrics`. */
@Module({ providers: [SearchIndexMetrics] })
export class SearchIndexMetricsModule {}

/** The search index's background jobs, for the worker process. */
@Module({
  providers: [
    SearchDocuments,
    SearchIndexWriter,
    SearchOutboxApplier,
    SearchReconciler,
    SearchOutboxWatcher,
  ],
})
export class SearchIndexJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(SearchOutboxApplier) private readonly applier: SearchOutboxApplier,
    @Inject(SearchReconciler) private readonly reconciler: SearchReconciler,
  ) {}

  onModuleInit(): void {
    this.registry.handle(searchApplyOutboxJob, this.applier);
    this.registry.handlePeriodic(searchReconcileJob, this.reconciler);
  }
}
