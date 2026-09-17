import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { JobResult, JobWithMetadata, PgBoss } from "pg-boss";
import { describeError } from "../common/health";
import { withoutQueryParameters } from "../database";
import { ErrorReporter } from "../observability";
import { ALMATY_TIME_ZONE, type JobDefinition, type PeriodicJobDefinition } from "./job-definition";
import { PermanentJobError } from "./job-handler";
import { JobQueue } from "./job-queue.service";
import { JobRegistry, type RegisteredJob } from "./job-registry";
import { JobSettingsReader } from "./job-settings";
import { JOBS_OPTIONS, type JobsModuleOptions } from "./jobs.options";
import { PeriodicJobStateStore } from "./periodic-job-state.store";

/** What a failure leaves on the job and in `periodic_job_state`: never the job's data. */
function failureText(error: unknown): string {
  const safe = withoutQueryParameters(error);
  const name = safe instanceof Error ? safe.name : "Error";
  return `${name}: ${describeError(safe)}`.slice(0, 500);
}

/**
 * The worker side of the queue (ARCHITECTURE 4.12): consumes every
 * declared job with its registered implementation, logs each run (name,
 * id, attempt — never the data), records periodic runs, and keeps the
 * pg-boss schedules equal to what the settings say (Almaty time, a run
 * missed while no worker was up is made up once).
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("Jobs");
  private syncTimer: NodeJS.Timeout | undefined;
  private syncing: Promise<void> | undefined;
  private stopped = false;
  /** Runs of periodic jobs that had nothing to do, until the next summary. */
  private readonly quietRuns = new Map<string, number>();
  private summaryTimer: NodeJS.Timeout | undefined;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(ErrorReporter) private readonly reporter: ErrorReporter,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(PeriodicJobStateStore) private readonly states: PeriodicJobStateStore,
    @Inject(JobSettingsReader) private readonly settings: JobSettingsReader,
    @Inject(JOBS_OPTIONS) private readonly options: JobsModuleOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.checkRegistrations();
    this.queue.onReady((boss) => {
      void this.consume(boss);
    });
  }

  beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.syncTimer);
    clearTimeout(this.summaryTimer);
    this.writeQuietSummary();
    return this.syncing ?? Promise.resolve();
  }

  /** Recomputes the schedules from settings now (tests; otherwise on a timer). */
  async syncSchedules(): Promise<void> {
    const boss = await this.queue.instance();
    this.syncing ??= this.syncSchedulesWith(boss).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private checkRegistrations(): void {
    const declared = new Set(this.options.catalog.map((job) => job.name));
    const registered = new Set(this.registry.all().map((job) => job.definition.name));
    const missing = [...declared].filter((name) => !registered.has(name));
    const undeclared = [...registered].filter((name) => !declared.has(name));
    if (missing.length > 0 || undeclared.length > 0) {
      throw new Error(
        `Job catalog and implementations differ: without implementation [${missing.join(", ")}], not in the catalog [${undeclared.join(", ")}]`,
      );
    }
    for (const job of this.registry.all()) {
      if (this.queue.definition(job.definition.name) !== job.definition) {
        throw new Error(
          `Job ${job.definition.name}: the implementation is registered for another declaration`,
        );
      }
    }
  }

  private async consume(boss: PgBoss): Promise<void> {
    try {
      for (const job of this.registry.all()) {
        await boss.work(
          job.definition.name,
          {
            batchSize: 1,
            includeMetadata: true,
            perJobResults: true,
            pollingIntervalSeconds: this.options.tuning.pollingIntervalSeconds,
          },
          (jobs) => this.runBatch(job, jobs),
        );
      }
      this.logger.log(`Worker consumes ${this.registry.all().length} job queues`);
    } catch (error) {
      // Only a stopping queue refuses work(); nothing to consume then.
      if (!this.stopped) {
        this.logger.error(`Could not start consuming jobs: ${describeError(error)}`);
      }
      return;
    }
    await this.syncSchedules().catch(() => undefined);
    this.scheduleSync();
    this.scheduleSummary();
  }

  /**
   * A periodic job with nothing to do writes no line about its success
   * (TASK-008 note: three sweepers every minute wrote ~8600 lines a day
   * with no work at all). That it ran at all is still visible — once per
   * interval, all quiet runs in one line, and in the metrics.
   */
  private scheduleSummary(): void {
    if (this.stopped) {
      return;
    }
    this.summaryTimer = setTimeout(() => {
      this.writeQuietSummary();
      this.scheduleSummary();
    }, this.options.tuning.quietSummaryIntervalMs);
  }

  private writeQuietSummary(): void {
    if (this.quietRuns.size === 0) {
      return;
    }
    const counts = [...this.quietRuns.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([job, runs]) => `${job}=${String(runs)}`)
      .join(" ");
    this.quietRuns.clear();
    this.logger.log(`Periodic jobs ran with nothing to do: ${counts}`);
  }

  private scheduleSync(): void {
    if (this.stopped) {
      return;
    }
    this.syncTimer = setTimeout(() => {
      void this.syncSchedules()
        .catch(() => undefined)
        .finally(() => this.scheduleSync());
    }, this.options.tuning.scheduleSyncIntervalMs);
  }

  private async syncSchedulesWith(boss: PgBoss): Promise<void> {
    const periodic = this.options.catalog.filter(
      (job): job is PeriodicJobDefinition => job.kind === "periodic",
    );
    try {
      const existing = new Map((await boss.getSchedules()).map((row) => [row.name, row]));
      for (const job of periodic) {
        let cron: string;
        try {
          cron = await job.schedule((key) => this.settings.get(key));
        } catch (error) {
          this.logger.error(
            `Schedule of ${job.name} could not be computed: ${describeError(error)}`,
          );
          continue;
        }
        const current = existing.get(job.name);
        existing.delete(job.name);
        if (current && current.cron === cron && current.timezone === ALMATY_TIME_ZONE) {
          continue;
        }
        await boss.schedule(job.name, cron, null, { tz: ALMATY_TIME_ZONE, missed: "once" });
        this.logger.log(
          `Job schedule ${current ? "changed" : "set"} job=${job.name} cron="${cron}" tz=${ALMATY_TIME_ZONE}${current ? ` was="${current.cron}"` : ""}`,
        );
      }
      for (const name of existing.keys()) {
        await boss.unschedule(name);
        this.logger.log(`Job schedule removed job=${name} (no longer declared)`);
      }
    } catch (error) {
      this.logger.warn(`Job schedules could not be synchronized: ${describeError(error)}`);
    }
  }

  private async runBatch(
    job: RegisteredJob,
    jobs: JobWithMetadata<unknown>[],
  ): Promise<JobResult[]> {
    const results: JobResult[] = [];
    for (const item of jobs) {
      results.push(await this.runOne(job, item));
    }
    return results;
  }

  private async runOne(job: RegisteredJob, item: JobWithMetadata<unknown>): Promise<JobResult> {
    const { definition } = job;
    const attempt = item.retryCount + 1;
    const attempts = item.retryLimit + 1;
    const about = `job=${definition.name} id=${item.id} attempt=${attempt}/${attempts}`;
    const startedAt = new Date();
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        this.logger.warn(`Job interrupted (timed out or worker stopping) ${about}`);
      }
    };
    item.signal.addEventListener("abort", onAbort, { once: true });
    const periodic = definition.kind === "periodic";
    if (!periodic) {
      this.logger.log(`Job started ${about}`);
    }
    await this.recordPeriodic(definition, (store) => store.started(definition.name, startedAt));
    try {
      const payload = this.payloadOf(definition, item.data);
      const outcome = await job.run(payload, { jobId: item.id, attempt, signal: item.signal });
      settled = true;
      const worked = !periodic || outcome?.worked !== false;
      if (worked) {
        this.logger.log(`Job completed ${about} durationMs=${Date.now() - startedAt.getTime()}`);
      } else {
        this.quietRuns.set(definition.name, (this.quietRuns.get(definition.name) ?? 0) + 1);
      }
      await this.recordPeriodic(definition, (store) =>
        store.succeeded(definition.name, new Date()),
      );
      return { id: item.id, status: "completed" };
    } catch (error) {
      settled = true;
      const text = failureText(error);
      const permanent = error instanceof PermanentJobError;
      const final = permanent || attempt >= attempts;
      const outcome = !final
        ? "Job failed, will retry"
        : definition.kind === "on_demand"
          ? "Job failed permanently, moved to the dead letter queue"
          : "Job failed, no retries left (the next scheduled run tries again)";
      this.logger[final ? "error" : "warn"](`${outcome} ${about} error=${text}`);
      if (final) {
        // A job nobody will retry is an unexpected failure like any other.
        this.reporter.captureException(error, {
          transaction: definition.name,
          tags: { kind: "job", job: definition.name, attempt },
        });
      }
      await this.recordPeriodic(definition, (store) =>
        store.failed(definition.name, new Date(), text),
      );
      return {
        id: item.id,
        status: permanent ? "deadletter" : "failed",
        output: { error: text },
      };
    } finally {
      item.signal.removeEventListener("abort", onAbort);
    }
  }

  private payloadOf(definition: JobDefinition, data: unknown): unknown {
    if (definition.kind !== "on_demand") {
      return undefined;
    }
    const parsed = definition.payload.safeParse(data);
    if (!parsed.success) {
      // The issues name paths and rules, never the values.
      const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
      throw new PermanentJobError(`Job data does not match the declaration at ${paths.join(", ")}`);
    }
    return parsed.data;
  }

  private async recordPeriodic(
    definition: JobDefinition,
    record: (store: PeriodicJobStateStore) => Promise<void>,
  ): Promise<void> {
    if (definition.kind !== "periodic") {
      return;
    }
    try {
      await record(this.states);
    } catch (error) {
      this.logger.warn(
        `Periodic job state not recorded job=${definition.name}: ${describeError(withoutQueryParameters(error))}`,
      );
    }
  }
}
