import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss, type SendOptions } from "pg-boss";
import { serviceUnavailableException } from "../common/errors";
import { describeError } from "../common/health";
import { APP_CONFIG, type AppConfig } from "../config";
import type { DbExecutor } from "../database";
import {
  deadLetterQueueName,
  type JobDefinition,
  type OnDemandJobDefinition,
} from "./job-definition";
import { JOB_QUEUE_SCHEMA } from "./job-queue-schema";
import { JOBS_OPTIONS, type JobsModuleOptions } from "./jobs.options";

export interface EnqueueOptions {
  /**
   * The caller's open transaction: the job exists if and only if that
   * transaction commits (ARCHITECTURE 13.1).
   */
  tx?: DbExecutor;
  /** Not before this moment (an accelerator, never the only record of a deadline). */
  startAfter?: Date;
  /** Only one waiting job per key (with a singleton job: per key instead of per job). */
  singletonKey?: string;
}

/** Completed jobs stay a day for inspection, then pg-boss deletes them (and their data). */
const COMPLETED_JOB_RETENTION_SECONDS = 24 * 60 * 60;
/** Dead jobs stay until the operator retries or deletes them. */
const DEAD_JOB_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * The job queue (pg-boss on PostgreSQL, ARCHITECTURE 13.1, 4.12) of this
 * process. Every process can put jobs on it; only the worker (`role:
 * "worker"`) supervises it, runs schedules and executes jobs (`JobRunner`).
 *
 * pg-boss starts in the background: an unreachable database neither fails
 * nor delays the start of the process; the start is retried until it
 * succeeds. The schema is never installed from here (`migrate: false`,
 * I112). The queues of every declared job (and their dead letter queues)
 * are created or updated at start.
 */
@Injectable()
export class JobQueue implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("JobQueue");
  private boss: PgBoss | undefined;
  private starting: Promise<PgBoss> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private startFailureLogged = false;
  private readonly readyListeners: ((boss: PgBoss) => void)[] = [];
  private readonly lastErrorLog = new Map<string, { at: number; suppressed: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JOBS_OPTIONS) private readonly options: JobsModuleOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.startOnBoot) {
      void this.startInBackground();
    }
  }

  get isWorker(): boolean {
    return this.options.role === "worker";
  }

  get catalog(): readonly JobDefinition[] {
    return this.options.catalog;
  }

  /** Runs `listener` once the queue has started (at once if it has). */
  onReady(listener: (boss: PgBoss) => void): void {
    if (this.boss) {
      listener(this.boss);
    } else {
      this.readyListeners.push(listener);
    }
  }

  /** The started queue; tries to start it now if it hasn't (503 if it can't). */
  async instance(): Promise<PgBoss> {
    if (this.boss) {
      return this.boss;
    }
    if (this.stopped) {
      throw serviceUnavailableException();
    }
    try {
      return await this.start();
    } catch {
      throw serviceUnavailableException();
    }
  }

  /**
   * Puts a job on the queue. Returns its id, or null when a singleton job
   * (or one with `singletonKey`) is already waiting. The payload is checked
   * against the declaration; invalid data is a programming error.
   */
  async enqueue<Payload>(
    definition: OnDemandJobDefinition<Payload>,
    payload: Payload,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    this.assertDeclared(definition);
    const data = definition.payload.parse(payload) as object;
    const boss = await this.instance();
    const send: SendOptions = {};
    if (options.tx) {
      send.db = fromDrizzle(options.tx, sql);
    }
    if (options.startAfter) {
      send.startAfter = options.startAfter;
    }
    if (options.singletonKey) {
      send.singletonKey = options.singletonKey;
    }
    return boss.send(definition.name, data, send);
  }

  /** Starts a periodic job now, outside its schedule (operator, tests). */
  async runNow(definition: JobDefinition): Promise<string | null> {
    this.assertDeclared(definition);
    if (definition.kind !== "periodic") {
      throw new Error(`Job ${definition.name} is not periodic: enqueue it with its data`);
    }
    const boss = await this.instance();
    return boss.send(definition.name, {});
  }

  definition(name: string): JobDefinition | undefined {
    return this.options.catalog.find((job) => job.name === name);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    await this.starting?.catch(() => undefined);
    const boss = this.boss;
    this.boss = undefined;
    if (boss) {
      // Running jobs get this long to finish; the rest are failed and so
      // retried (by this or another worker). Stays below the process's
      // own shutdown limit (common/shutdown).
      await boss.stop({ graceful: true, timeout: this.options.tuning.stopTimeoutMs });
      this.logger.log("Job queue stopped");
    }
  }

  private assertDeclared(definition: JobDefinition): void {
    if (this.definition(definition.name) !== definition) {
      throw new Error(`Job ${definition.name} is not in the job catalog (background-jobs.ts)`);
    }
  }

  private async startInBackground(): Promise<void> {
    if (this.stopped || this.boss) {
      return;
    }
    try {
      await this.start();
    } catch {
      if (!this.stopped) {
        this.retryTimer = setTimeout(() => {
          void this.startInBackground();
        }, this.options.tuning.startRetryMs);
      }
    }
  }

  private start(): Promise<PgBoss> {
    this.starting ??= this.startOnce().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startOnce(): Promise<PgBoss> {
    const boss = this.create();
    try {
      await boss.start();
      await this.ensureQueues(boss);
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      if (!this.startFailureLogged) {
        this.startFailureLogged = true;
        this.logger.warn(`Job queue could not start, retrying: ${describeError(error)}`);
      }
      throw error;
    }
    if (this.stopped) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      throw new Error("The process is stopping");
    }
    this.boss = boss;
    this.logger.log(
      `Job queue started role=${this.options.role}${this.startFailureLogged ? " (after retries)" : ""}`,
    );
    for (const listener of this.readyListeners.splice(0)) {
      listener(boss);
    }
    return boss;
  }

  private create(): PgBoss {
    const worker = this.isWorker;
    const tuning = this.options.tuning;
    const boss = new PgBoss({
      connectionString: this.config.database.url,
      schema: JOB_QUEUE_SCHEMA,
      application_name: `adclub-${this.options.role}`,
      max: worker ? 10 : 3,
      connectionTimeoutMillis: 5000,
      // The migrations own the schema (I112).
      migrate: false,
      // Only the worker supervises (expired runs, retention) and schedules.
      supervise: worker,
      schedule: worker,
      monitorIntervalSeconds: tuning.monitorIntervalSeconds,
      superviseIntervalSeconds: tuning.superviseIntervalSeconds,
      queueCacheIntervalSeconds: tuning.queueCacheIntervalSeconds,
      cronMonitorIntervalSeconds: tuning.cronMonitorIntervalSeconds,
      cronWorkerIntervalSeconds: tuning.cronWorkerIntervalSeconds,
    });
    boss.on("error", (error) => this.logError(error));
    boss.on("warning", (warning) => {
      const type = (warning.data as { type?: unknown } | undefined)?.type;
      this.logger.warn(`Job queue warning type=${String(type ?? "unknown")}: ${warning.message}`);
    });
    return boss;
  }

  private async ensureQueues(boss: PgBoss): Promise<void> {
    for (const job of this.options.catalog) {
      const deadLetter = job.kind === "on_demand" ? deadLetterQueueName(job.name) : undefined;
      if (deadLetter) {
        await boss.createQueue(deadLetter, { retentionSeconds: DEAD_JOB_RETENTION_SECONDS });
      }
      const settings = {
        retryLimit: job.retry.limit,
        retryDelay: job.retry.delaySeconds,
        retryBackoff: job.retry.backoff,
        expireInSeconds: job.timeoutSeconds,
        deleteAfterSeconds: COMPLETED_JOB_RETENTION_SECONDS,
      };
      const policy = job.singleton ? "stately" : "standard";
      const existing = await boss.getQueue(job.name);
      if (!existing) {
        await boss.createQueue(job.name, {
          ...settings,
          ...(job.retry.maxDelaySeconds === undefined
            ? {}
            : { retryDelayMax: job.retry.maxDelaySeconds }),
          policy,
          ...(deadLetter ? { deadLetter } : {}),
        });
        continue;
      }
      if (existing.policy !== policy) {
        // pg-boss can't change a policy; a renamed job is the way out.
        this.logger.error(
          `Job ${job.name}: queue policy is ${String(existing.policy)}, the declaration needs ${policy}`,
        );
      }
      await boss.updateQueue(job.name, {
        ...settings,
        retryDelayMax: job.retry.maxDelaySeconds ?? null,
        deadLetter: deadLetter ?? null,
      });
    }
  }

  /** pg-boss reports every failed poll; one line a minute per kind is enough. */
  private logError(error: unknown): void {
    const text = errorText(error).slice(0, 300);
    const queue = (error as { queue?: unknown }).queue;
    const key = `${typeof queue === "string" ? queue : ""}|${text}`;
    const now = Date.now();
    const last = this.lastErrorLog.get(key);
    if (last && now - last.at < ERROR_LOG_INTERVAL_MS) {
      last.suppressed += 1;
      return;
    }
    const suppressed = last?.suppressed ? ` (${last.suppressed} more since the last report)` : "";
    this.lastErrorLog.set(key, { at: now, suppressed: 0 });
    this.logger.warn(
      `Job queue error${typeof queue === "string" ? ` queue=${queue}` : ""}: ${text}${suppressed}`,
    );
  }
}

/**
 * pg-boss reports worker errors as plain copies of the error object, with
 * the queue and worker appended to the message. A failed connection on
 * Linux arrives as an `AggregateError` whose own message is empty (the
 * same "Happy Eyeballs" case as 4.3 I21), and a copy of it keeps neither
 * `errors` nor `code` — so say that plainly instead of logging a line that
 * only repeats the queue name.
 */
function errorText(error: unknown): string {
  if (error instanceof Error || typeof error !== "object" || error === null) {
    return describeError(error);
  }
  const { message, code } = error as { message?: unknown; code?: unknown };
  const text =
    typeof message === "string" ? message.replace(/\s*\(Queue:[^)]*\)\s*$/, "").trim() : "";
  if (text.length > 0) {
    return text;
  }
  return typeof code === "string" && code.length > 0 ? code : "connection failed (no message)";
}
