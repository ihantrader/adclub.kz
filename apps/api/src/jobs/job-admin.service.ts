import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { fromDrizzle, type JobWithMetadata, type PgBoss } from "pg-boss";
import { DatabaseService } from "../database";
import { deadLetterQueueName, type JobDefinition } from "./job-definition";
import { JOB_QUEUE_SCHEMA } from "./job-queue-schema";
import { JobQueue } from "./job-queue.service";
import { PeriodicJobStateStore } from "./periodic-job-state.store";

export interface JobStatus {
  job: string;
  kind: JobDefinition["kind"];
  singleton: boolean;
  schedule: { cron: string; timeZone: string } | null;
  /** Jobs in each state now. */
  waiting: number;
  retrying: number;
  running: number;
  /** Failed for good and still kept (periodic jobs keep them a day). */
  failed: number;
  completedRecently: number;
  /** In the dead letter queue (on-demand jobs only). */
  dead: number | null;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
}

/** A dead job as the operator sees it: never the data itself, only its field names. */
export interface DeadJob {
  id: string;
  job: string;
  deadSince: string;
  firstQueuedAt: string | null;
  attempts: number | null;
  error: string | null;
  dataFields: string[];
}

export class JobAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobAdminError";
  }
}

const toIso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

/**
 * What the operator command does with the queue (ARCHITECTURE 4.12 I117):
 * the state of every declared job, the dead letter queues, retrying and
 * deleting dead jobs, starting a periodic job now.
 */
@Injectable()
export class JobAdmin {
  private readonly logger = new Logger("JobAdmin");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PeriodicJobStateStore) private readonly states: PeriodicJobStateStore,
  ) {}

  async status(): Promise<JobStatus[]> {
    const boss = await this.queue.instance();
    const states = new Map((await this.states.all()).map((row) => [row.name, row]));
    const schedules = new Map((await boss.getSchedules()).map((row) => [row.name, row]));
    const result: JobStatus[] = [];
    for (const job of this.queue.catalog) {
      const counts = await this.countByState(boss, job.name);
      const dead =
        job.kind === "on_demand"
          ? (await this.countByState(boss, deadLetterQueueName(job.name))).created
          : null;
      const state = states.get(job.name);
      const schedule = schedules.get(job.name);
      result.push({
        job: job.name,
        kind: job.kind,
        singleton: job.singleton,
        schedule: schedule ? { cron: schedule.cron, timeZone: schedule.timezone } : null,
        waiting: counts.created,
        retrying: counts.retry,
        running: counts.active,
        failed: counts.failed,
        completedRecently: counts.completed,
        dead,
        lastStartedAt: toIso(state?.lastStartedAt),
        lastSucceededAt: toIso(state?.lastSucceededAt),
        lastFailedAt: toIso(state?.lastFailedAt),
        lastError: state?.lastError ?? null,
      });
    }
    return result;
  }

  async deadJobs(jobName?: string): Promise<DeadJob[]> {
    const boss = await this.queue.instance();
    const jobs = this.onDemandJobs(jobName);
    const result: DeadJob[] = [];
    for (const job of jobs) {
      const rows = await boss.findJobs<unknown>(deadLetterQueueName(job.name), { queued: true });
      result.push(...rows.map((row) => describeDead(job.name, row)));
    }
    return result.sort((a, b) => a.deadSince.localeCompare(b.deadSince));
  }

  /**
   * Puts a dead job back on its queue as a new job with fresh retries and
   * removes it from the dead letter queue, in one transaction.
   */
  async retryDead(id: string): Promise<{ id: string; job: string; newJobId: string }> {
    const boss = await this.queue.instance();
    const { job, row } = await this.findDead(boss, id);
    const newJobId = await this.database.db.transaction(async (tx) => {
      const db = fromDrizzle(tx, sql);
      const removed = await boss.deleteJob(deadLetterQueueName(job.name), id, { db });
      if ((removed as { affected?: number }).affected !== 1) {
        throw new JobAdminError(`Dead job ${id} is no longer in the dead letter queue`);
      }
      const created = await boss.send(job.name, (row.data ?? {}) as object, { db });
      if (!created) {
        throw new JobAdminError(
          `Job ${job.name} is a singleton and one is already waiting; retry ${id} later`,
        );
      }
      return created;
    });
    this.logger.log(`Dead job retried by operator job=${job.name} dead=${id} new=${newJobId}`);
    return { id, job: job.name, newJobId };
  }

  async deleteDead(id: string): Promise<{ id: string; job: string; deleted: true }> {
    const boss = await this.queue.instance();
    const { job } = await this.findDead(boss, id);
    const removed = await boss.deleteJob(deadLetterQueueName(job.name), id);
    if ((removed as { affected?: number }).affected !== 1) {
      throw new JobAdminError(`Dead job ${id} is no longer in the dead letter queue`);
    }
    this.logger.log(`Dead job deleted by operator job=${job.name} dead=${id}`);
    return { id, job: job.name, deleted: true };
  }

  async runNow(jobName: string): Promise<{ job: string; jobId: string | null }> {
    const job = this.queue.definition(jobName);
    if (!job) {
      throw new JobAdminError(`Unknown job ${jobName}`);
    }
    if (job.kind !== "periodic") {
      throw new JobAdminError(`Job ${jobName} needs data; only periodic jobs can be started here`);
    }
    const jobId = await this.queue.runNow(job);
    this.logger.log(
      `Job started by operator job=${jobName} id=${jobId ?? "none (one is already waiting)"}`,
    );
    return { job: jobName, jobId };
  }

  private onDemandJobs(jobName?: string): JobDefinition[] {
    const jobs = this.queue.catalog.filter((job) => job.kind === "on_demand");
    if (jobName === undefined) {
      return jobs;
    }
    const job = jobs.find((candidate) => candidate.name === jobName);
    if (!job) {
      throw new JobAdminError(
        `No on-demand job ${jobName} (periodic jobs have no dead letter queue)`,
      );
    }
    return [job];
  }

  private async findDead(
    boss: PgBoss,
    id: string,
  ): Promise<{ job: JobDefinition; row: JobWithMetadata<unknown> }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new JobAdminError(`Not a job id: ${id}`);
    }
    for (const job of this.onDemandJobs()) {
      const [row] = await boss.findJobs<unknown>(deadLetterQueueName(job.name), {
        id,
        queued: true,
      });
      if (row) {
        return { job, row };
      }
    }
    throw new JobAdminError(`No dead job ${id}`);
  }

  private async countByState(
    boss: PgBoss,
    queueName: string,
  ): Promise<
    Record<"created" | "retry" | "active" | "completed" | "cancelled" | "failed", number>
  > {
    const queue = await boss.getQueue(queueName);
    const counts = { created: 0, retry: 0, active: 0, completed: 0, cancelled: 0, failed: 0 };
    if (!queue) {
      return counts;
    }
    const { rows } = await boss
      .getDb()
      .executeSql(
        `SELECT state::text AS state, count(*)::int AS count FROM ${JOB_QUEUE_SCHEMA}."${queue.table.replaceAll('"', "")}" WHERE name = $1 GROUP BY state`,
        [queueName],
      );
    for (const row of rows as { state: keyof typeof counts; count: number }[]) {
      counts[row.state] = row.count;
    }
    return counts;
  }
}

function describeDead(job: string, row: JobWithMetadata<unknown>): DeadJob {
  const output = row.output as { error?: unknown } | null | undefined;
  const data = row.data;
  return {
    id: row.id,
    job,
    deadSince: new Date(row.createdOn).toISOString(),
    firstQueuedAt: toIso(row.sourceCreatedOn),
    attempts: row.sourceRetryCount === null ? null : row.sourceRetryCount + 1,
    error: typeof output?.error === "string" ? output.error : null,
    dataFields:
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? Object.keys(data).sort()
        : [],
  };
}
