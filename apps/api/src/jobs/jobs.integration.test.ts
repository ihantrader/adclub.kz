import { randomUUID } from "node:crypto";
import { Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppModule } from "../app.module";
import { JsonLoggerService } from "../common/logging";
import { ConfigModule, loadConfig, type AppConfig } from "../config";
import { DatabaseModule, DatabaseService, type DbExecutor } from "../database";
import { runMigrate } from "../database/migrate-cli";
import { AuditModule } from "../modules/audit";
import { SettingsModule } from "../modules/settings";
import { ObservabilityModule } from "../observability";
import { captureOutput, rememberSecret } from "../testing/output-capture";
import { TestSettings } from "../testing/settings";
import { TcpProxy } from "../testing/tcp-proxy";
import {
  ALMATY_TIME_ZONE,
  dailyAt,
  defineJob,
  definePeriodicJob,
  defineSweeperJob,
  devAlwaysFailingJob,
  EVERY_MINUTE,
  JobAdmin,
  JobQueue,
  JobRegistry,
  JobRunner,
  JobsModule,
  SweepRunner,
  type EnqueueOptions,
  type JobDefinition,
  type JobsTuning,
  type OnDemandJobDefinition,
  type Sweeper,
} from ".";
import { installedJobQueueSchemaVersion } from "./job-queue-migrations";

/**
 * TASK-008: the job queue on a real PostgreSQL — the schema from the
 * migrations, jobs put on the queue inside a transaction, retries and the
 * dead letter queue, singletons and schedules with two workers, the
 * deadline sweeper, Almaty-time schedules from settings, a worker stopping
 * (or dying) mid-run, and the database going away. Every job's data is
 * registered as a secret: none of it may reach the output.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
  diagnose?: () => Promise<string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}${diagnose ? ` — ${await diagnose()}` : ""}`);
    }
    await sleep(100);
  }
}

/** A marker job data carries; long enough to be searched for as a secret. */
function marker(label: string): string {
  const value = `${label}-${randomUUID()}`;
  rememberSecret(value);
  return value;
}

const NO_RETRY = { limit: 0, delaySeconds: 0, backoff: false };

const recordJob = defineJob({
  name: "test.record",
  payload: z.object({ marker: z.string() }),
  timeoutSeconds: 30,
  retry: NO_RETRY,
  singleton: false,
});
const flakyJob = defineJob({
  name: "test.flaky",
  payload: z.object({ marker: z.string(), failures: z.number().int() }),
  timeoutSeconds: 30,
  retry: { limit: 3, delaySeconds: 2, backoff: false },
  singleton: false,
});
const failingJob = defineJob({
  name: "test.always-fails",
  payload: z.object({ secret: z.string() }),
  timeoutSeconds: 30,
  retry: { limit: 1, delaySeconds: 0, backoff: false },
  singleton: false,
});
const singletonJob = defineJob({
  name: "test.singleton",
  payload: z.object({ marker: z.string() }),
  timeoutSeconds: 30,
  retry: NO_RETRY,
  singleton: true,
});
const blockingJob = defineJob({
  name: "test.blocking",
  payload: z.object({ marker: z.string(), holdMs: z.number().int() }),
  timeoutSeconds: 4,
  retry: { limit: 3, delaySeconds: 0, backoff: false },
  singleton: false,
});
const dailyJob = definePeriodicJob({
  name: "test.daily-at-setting",
  timeoutSeconds: 30,
  retry: NO_RETRY,
  singleton: true,
  schedule: async (setting) => dailyAt(await setting("billing_notify_hour")),
});
const minutelyJob = definePeriodicJob({
  name: "test.every-minute",
  timeoutSeconds: 30,
  retry: NO_RETRY,
  singleton: true,
  schedule: () => EVERY_MINUTE,
});
const sweepJob = defineSweeperJob({ name: "test.sweep", batchSize: 10, timeoutSeconds: 30 });

const CATALOG: JobDefinition[] = [
  recordJob,
  flakyJob,
  failingJob,
  singletonJob,
  blockingJob,
  dailyJob,
  minutelyJob,
  sweepJob,
];

interface Run {
  job: string;
  marker: string;
  worker: string;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
}

/** Everything the test handlers did, across all workers of this process. */
const runs: Run[] = [];
let singletonActive = 0;
let singletonMaxActive = 0;
const runsOf = (job: string, markerValue?: string) =>
  runs.filter(
    (run) => run.job === job && (markerValue === undefined || run.marker === markerValue),
  );

/** Test sweeper over `sweep_item`: marks due rows done; a poison row fails after its update. */
class ItemSweeper implements Sweeper<void> {
  constructor(
    private readonly label: string,
    private readonly delayMs = 0,
    private readonly batch = true,
  ) {}

  async prepare(): Promise<void> {}

  async claim(
    tx: DbExecutor,
    _context: void,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const excluded =
      batch.excludeIds.length > 0
        ? sql`AND id NOT IN (${sql.join(
            batch.excludeIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
    const result = await tx.execute<{ id: string }>(
      sql`SELECT id FROM sweep_item WHERE NOT done AND due_at <= now() ${excluded} ORDER BY due_at, id LIMIT ${batch.limit} FOR UPDATE SKIP LOCKED`,
    );
    return result.rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, _context: void, id: string): Promise<void> {
    await this.mark(tx, [id]);
  }

  get applyBatch(): Sweeper<void>["applyBatch"] {
    return this.batch ? (tx, _context, ids) => this.mark(tx, ids) : undefined;
  }

  private async mark(tx: DbExecutor, ids: string[]): Promise<void> {
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }
    const result = await tx.execute<{ poison: boolean }>(
      sql`UPDATE sweep_item SET done = true, processed_count = processed_count + 1, processed_by = array_append(processed_by, ${this.label}) WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) AND NOT done RETURNING poison`,
    );
    if (result.rows.some((row) => row.poison)) {
      throw new Error("poison row");
    }
  }
}

function register(registry: JobRegistry, worker: string): void {
  const record = (job: string, markerValue: string, attempt: number): Run => {
    const run: Run = { job, marker: markerValue, worker, attempt, startedAt: Date.now() };
    runs.push(run);
    return run;
  };
  registry.handle(recordJob, {
    run: (payload, context) => {
      record(recordJob.name, payload.marker, context.attempt).finishedAt = Date.now();
      return Promise.resolve();
    },
  });
  registry.handle(flakyJob, {
    run: (payload, context) => {
      const run = record(flakyJob.name, payload.marker, context.attempt);
      if (context.attempt <= payload.failures) {
        return Promise.reject(new Error(`planned failure ${context.attempt}`));
      }
      run.finishedAt = Date.now();
      return Promise.resolve();
    },
  });
  registry.handle(failingJob, {
    run: (payload, context) => {
      record(failingJob.name, payload.secret, context.attempt);
      return Promise.reject(new Error("this job always fails"));
    },
  });
  registry.handle(singletonJob, {
    run: async (payload, context) => {
      const run = record(singletonJob.name, payload.marker, context.attempt);
      singletonActive += 1;
      singletonMaxActive = Math.max(singletonMaxActive, singletonActive);
      await sleep(400);
      singletonActive -= 1;
      run.finishedAt = Date.now();
    },
  });
  registry.handle(blockingJob, {
    // The first attempt holds on (ignoring the abort signal, like a slow
    // handler would); later attempts finish at once.
    run: async (payload, context) => {
      const run = record(blockingJob.name, payload.marker, context.attempt);
      if (context.attempt === 1) {
        await sleep(payload.holdMs);
      }
      run.finishedAt = Date.now();
    },
  });
  registry.handlePeriodic(dailyJob, {
    run: (context) => {
      record(dailyJob.name, "", context.attempt).finishedAt = Date.now();
      return Promise.resolve();
    },
  });
  registry.handlePeriodic(minutelyJob, {
    run: (context) => {
      record(minutelyJob.name, "", context.attempt).finishedAt = Date.now();
      return Promise.resolve();
    },
  });
  registry.sweep(sweepJob, new ItemSweeper(worker));
}

const REGISTERED = Symbol("REGISTERED");

@Module({})
class TestJobsHost {
  static forRoot(
    config: AppConfig,
    role: "producer" | "worker",
    name: string,
    tuning: Partial<JobsTuning>,
  ): DynamicModule {
    return {
      module: TestJobsHost,
      imports: [
        ConfigModule.forRoot(config),
        ObservabilityModule.forRoot(config, { http: false }),
        DatabaseModule,
        // Settings record their changes in the action journal (TASK-009).
        AuditModule.forRoot({ http: false }),
        SettingsModule.forRoot({ http: false, cache: { maxAgeMs: 300 } }),
        JobsModule.forRoot({ role, catalog: CATALOG, tuning }),
      ],
      providers: [
        JsonLoggerService,
        {
          provide: REGISTERED,
          useFactory: (registry: JobRegistry) => {
            if (role === "worker") {
              register(registry, name);
            }
            return true;
          },
          inject: [JobRegistry],
        },
      ],
    };
  }
}

const FAST: Partial<JobsTuning> = {
  pollingIntervalSeconds: 0.5,
  monitorIntervalSeconds: 1,
  superviseIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
  cronMonitorIntervalSeconds: 1,
  cronWorkerIntervalSeconds: 1,
  scheduleSyncIntervalMs: 300,
  quietSummaryIntervalMs: 1000,
  startRetryMs: 300,
  stopTimeoutMs: 3000,
};

describe("background jobs (PostgreSQL)", () => {
  let postgres: StartedPostgreSqlContainer;
  let proxy: TcpProxy;
  let db: Client;
  let config: AppConfig;
  let proxiedConfig: AppConfig;
  let producer: INestApplicationContext;
  const open = new Set<INestApplicationContext>();

  async function start(
    name: string,
    options: { role?: "producer" | "worker"; tuning?: Partial<JobsTuning>; proxied?: boolean } = {},
  ): Promise<INestApplicationContext> {
    const app = await NestFactory.createApplicationContext(
      TestJobsHost.forRoot(
        options.proxied ? proxiedConfig : config,
        options.role ?? "worker",
        name,
        { ...FAST, ...options.tuning },
      ),
      { bufferLogs: true },
    );
    app.useLogger(app.get(JsonLoggerService));
    app.flushLogs();
    open.add(app);
    return app;
  }

  async function stop(app: INestApplicationContext): Promise<number> {
    const startedAt = Date.now();
    await app.close();
    open.delete(app);
    return Date.now() - startedAt;
  }

  async function ready(app: INestApplicationContext): Promise<PgBoss> {
    let boss: PgBoss | undefined;
    app.get(JobQueue).onReady((started) => {
      boss = started;
    });
    await waitFor(() => boss !== undefined, "the job queue to start");
    return boss!;
  }

  async function jobRows(
    name: string,
  ): Promise<{ id: string; state: string; retry_count: number }[]> {
    const { rows } = await db.query<{ id: string; state: string; retry_count: number }>(
      "SELECT id, state::text AS state, retry_count FROM pgboss.job WHERE name = $1 ORDER BY created_on",
      [name],
    );
    return rows;
  }

  async function jobState(id: string): Promise<string | undefined> {
    const { rows } = await db.query<{ state: string }>(
      "SELECT state::text AS state FROM pgboss.job WHERE id = $1",
      [id],
    );
    return rows[0]?.state;
  }

  function enqueue<Payload>(
    definition: OnDemandJobDefinition<Payload>,
    payload: Payload,
    options?: EnqueueOptions,
  ): Promise<string | null> {
    return producer.get(JobQueue).enqueue(definition, payload, options);
  }

  /** The Almaty hour an hour ago. */
  function almatyHourAgo(): number {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: ALMATY_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(Date.now() - 60 * 60 * 1000));
    return Number(hour);
  }

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16").start();
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    db.on("error", () => undefined);
    await db.connect();
    await db.query(
      `CREATE TABLE sweep_item (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         due_at TIMESTAMPTZ NOT NULL,
         poison BOOLEAN NOT NULL DEFAULT false,
         done BOOLEAN NOT NULL DEFAULT false,
         processed_count INTEGER NOT NULL DEFAULT 0,
         processed_by TEXT[] NOT NULL DEFAULT '{}'
       )`,
    );
    proxy = new TcpProxy(postgres.getHost(), postgres.getPort());
    await proxy.start();
    const base = {
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      REDIS_URL: "redis://127.0.0.1:2",
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
    };
    config = loadConfig({ ...base, DATABASE_URL: postgres.getConnectionUri() });
    const proxied = new URL(postgres.getConnectionUri());
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    proxiedConfig = loadConfig({ ...base, DATABASE_URL: proxied.toString() });
    producer = await start("producer", { role: "producer" });
    await ready(producer);
  });

  afterAll(async () => {
    for (const app of open) {
      await app.close().catch(() => undefined);
    }
    await proxy?.stop();
    await db?.end().catch(() => undefined);
    await postgres?.stop();
  });

  describe("schema", () => {
    it("is created by the migrations, at the version the installed pg-boss needs, without drift", async () => {
      const { rows } = await db.query<{ version: number }>("SELECT version FROM pgboss.version");
      expect(rows).toEqual([{ version: installedJobQueueSchemaVersion() }]);
      const boss = await ready(producer);
      expect(await boss.schemaVersion()).toBe(installedJobQueueSchemaVersion());
      const drift = await boss.detectSchemaDrift();
      expect(drift.ok, JSON.stringify(drift)).toBe(true);
    });

    it("is never installed by pg-boss itself: without the migration the queue refuses to start", async () => {
      const boss = new PgBoss({
        connectionString: postgres.getConnectionUri(),
        schema: "pgboss_missing",
        migrate: false,
        supervise: false,
        schedule: false,
      });
      boss.on("error", () => undefined);
      await expect(boss.start()).rejects.toThrow(/not installed/);
      await boss.stop({ graceful: false }).catch(() => undefined);
      const { rows } = await db.query(
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss_missing'",
      );
      expect(rows).toHaveLength(0);
    });

    it("creates the queue of every declared job, with a dead letter queue for on-demand jobs only", async () => {
      const boss = await ready(producer);
      const queues = new Map((await boss.getQueues()).map((queue) => [queue.name, queue]));
      expect(queues.get("test.always-fails")).toMatchObject({
        policy: "standard",
        retryLimit: 1,
        deadLetter: "test.always-fails.dead",
      });
      expect(queues.get("test.singleton")).toMatchObject({ policy: "stately" });
      expect(queues.get("test.sweep")).toMatchObject({ policy: "stately", deadLetter: null });
      expect(queues.has("test.always-fails.dead")).toBe(true);
      expect(queues.has("test.sweep.dead")).toBe(false);
    });
  });

  describe("with two workers", () => {
    let first: INestApplicationContext;
    let second: INestApplicationContext;
    let twoWorkersSince = 0;

    afterAll(async () => {
      await Promise.all([first, second].filter(Boolean).map((app) => stop(app)));
    });

    it("makes up a periodic run missed while no worker was up once, at its Almaty time", async () => {
      // An hour ago in Almaty: missed if the schedule is read in Almaty
      // time, four hours ahead (not missed) if it were read as UTC.
      const hourAgo = almatyHourAgo();
      await new TestSettings(producer).set({ billing_notify_hour: hourAgo });
      const once = await start("schedules");
      await waitFor(
        async () => (await (await ready(once)).getSchedules()).length === 3,
        "the schedules to be set",
      );
      await stop(once);
      runs.length = 0;

      // The schedules have been there for two hours and no worker ran a
      // schedule pass in that time (pg-boss only makes up occurrences a
      // schedule already existed for).
      await db.query("UPDATE pgboss.version SET cron_on = now() - interval '2 hours'");
      await db.query("UPDATE pgboss.schedule SET created_on = now() - interval '2 hours'");
      [first, second] = await Promise.all([start("first"), start("second")]);
      twoWorkersSince = Date.now();

      await waitFor(() => runsOf(dailyJob.name).length > 0, "the missed daily run");
      await waitFor(() => runsOf(minutelyJob.name).length > 0, "the missed minutely run");
      await sleep(3000);
      // One missed daily occurrence: one run. 120 missed minutes: one run
      // made up (plus, at most, the occurrence of the current minute).
      expect(runsOf(dailyJob.name)).toHaveLength(1);
      expect(
        runsOf(minutelyJob.name).filter((run) => run.startedAt < nextMinute(twoWorkersSince))
          .length,
      ).toBeLessThanOrEqual(2);
      const state = (await first.get(JobAdmin).status()).find((row) => row.job === dailyJob.name);
      expect(state).toMatchObject({
        kind: "periodic",
        schedule: { cron: dailyAt(hourAgo), timeZone: ALMATY_TIME_ZONE },
      });
      expect(state?.lastSucceededAt).not.toBeNull();
    });

    it("reads the Almaty time from the setting at every sync, without a restart", async () => {
      const boss = await ready(first);
      const hour = (almatyHourAgo() + 5) % 24;
      await new TestSettings(producer).set({ billing_notify_hour: hour });
      await waitFor(
        async () => (await boss.getSchedule(dailyJob.name))?.cron === dailyAt(hour),
        "the schedule to follow the setting",
      );
      const schedule = await boss.getSchedule(dailyJob.name);
      expect(schedule).toMatchObject({ timezone: ALMATY_TIME_ZONE });
      expect(schedule?.options).toMatchObject({ tz: ALMATY_TIME_ZONE, missed: "once" });
      // 10:00 in Almaty is 05:00 UTC (UTC+5 since March 2024, ARCHITECTURE 13.3).
      expect(
        boss.previewSchedule(dailyAt(10), {
          tz: ALMATY_TIME_ZONE,
          from: new Date("2026-09-17T00:00:00Z"),
          count: 2,
        }),
      ).toEqual([new Date("2026-09-17T05:00:00Z"), new Date("2026-09-18T05:00:00Z")]);
      // Any worker's sync gives the same schedule; nothing flips back.
      await second.get(JobRunner).syncSchedules();
      expect((await boss.getSchedule(dailyJob.name))?.cron).toBe(dailyAt(hour));
    });

    it("never runs a singleton job twice at a time, whichever worker takes it", async () => {
      singletonMaxActive = 0;
      const accepted: string[] = [];
      let refused = 0;
      const workersSeen = () => new Set(runsOf(singletonJob.name).map((run) => run.worker));
      // Which worker's poll lands first once the queue frees is a race, so
      // the run goes on until both have taken a job (bounded): the point of
      // the test is that a singleton is never run twice at a time, whoever
      // takes it — not which of them happens to be quicker.
      const until = Date.now() + 3000;
      const deadline = Date.now() + 40_000;
      while (Date.now() < until || (workersSeen().size < 2 && Date.now() < deadline)) {
        const value = marker("singleton");
        const id = await enqueue(singletonJob, { marker: value });
        if (id) {
          accepted.push(value);
        } else {
          refused += 1;
        }
        await sleep(50);
      }
      await waitFor(
        () =>
          accepted.every((value) => runsOf(singletonJob.name, value).some((run) => run.finishedAt)),
        "every accepted singleton job to run",
        // A loaded machine (the whole integration suite at once) runs these
        // one after another, each taking its handler's 400 ms plus a poll.
        60_000,
        async () => {
          const missing = accepted.filter(
            (value) => !runsOf(singletonJob.name, value).some((run) => run.finishedAt),
          );
          const { rows } = await db.query(
            "SELECT id, state::text AS state, start_after FROM pgboss.job WHERE name = 'test.singleton' AND state < 'completed'",
          );
          return `accepted=${accepted.length} missing=${missing.length} pending=${JSON.stringify(rows)}`;
        },
      );
      expect(singletonMaxActive).toBe(1);
      expect(refused).toBeGreaterThan(0);
      for (const value of accepted) {
        expect(runsOf(singletonJob.name, value)).toHaveLength(1);
      }
      expect(new Set(runsOf(singletonJob.name).map((run) => run.worker))).toEqual(
        new Set(["first", "second"]),
      );
    });

    it("puts a job on the queue only if the transaction commits", async () => {
      const database = producer.get(DatabaseService);
      const rolledBack = marker("rolled-back");
      await expect(
        database.db.transaction(async (tx) => {
          await tx.execute(sql`INSERT INTO sweep_item (due_at) VALUES (now() + interval '1 year')`);
          await enqueue(recordJob, { marker: rolledBack }, { tx });
          throw new Error("business rule refused the change");
        }),
      ).rejects.toThrow("business rule refused");
      const committed = marker("committed");
      let committedId: string | null = null;
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO sweep_item (due_at) VALUES (now() + interval '2 years')`);
        committedId = await enqueue(recordJob, { marker: committed }, { tx });
      });
      await waitFor(() => runsOf(recordJob.name, committed).length === 1, "the committed job");
      await sleep(1500);
      expect(runsOf(recordJob.name, rolledBack)).toHaveLength(0);
      expect(runsOf(recordJob.name, committed)).toHaveLength(1);
      const { rows } = await db.query(
        "SELECT due_at > now() + interval '18 months' AS later FROM sweep_item WHERE due_at > now() + interval '6 months'",
      );
      expect(rows).toEqual([{ later: true }]);
      const { rows: queued } = await db.query(
        "SELECT id FROM pgboss.job WHERE name = 'test.record' AND data->>'marker' = $1",
        [rolledBack],
      );
      expect(queued).toHaveLength(0);
      expect(await jobState(committedId!)).toBe("completed");
      await db.query("DELETE FROM sweep_item");
    });

    it("the API process puts jobs on the queue in its transactions (the real AppModule)", async () => {
      const api = await NestFactory.createApplicationContext(
        AppModule.forRoot(config, { jobs: FAST }),
        { bufferLogs: true },
      );
      api.useLogger(api.get(JsonLoggerService));
      api.flushLogs();
      open.add(api);
      try {
        const note = marker("api-note");
        let id: string | null = null;
        await api.get(DatabaseService).db.transaction(async (tx) => {
          id = await api.get(JobQueue).enqueue(devAlwaysFailingJob, { note }, { tx });
        });
        expect(id).not.toBeNull();
        const { rows } = await db.query<{ name: string }>(
          "SELECT name FROM pgboss.job WHERE id = $1",
          [id],
        );
        expect(rows).toEqual([{ name: "dev.always-fails" }]);
        // Not declared in this catalog: refused before anything is written.
        await expect(api.get(JobQueue).enqueue(recordJob, { marker: "x" })).rejects.toThrow(
          /not in the job catalog/,
        );
      } finally {
        await stop(api);
      }
    });

    it("retries a failing job by its rules until it succeeds", async () => {
      const output = captureOutput();
      const value = marker("flaky");
      const id = await enqueue(flakyJob, { marker: value, failures: 2 });
      await waitFor(() => runsOf(flakyJob.name, value).some((run) => run.finishedAt), "success");
      output.stop();
      const attempts = runsOf(flakyJob.name, value);
      expect(attempts.map((run) => run.attempt)).toEqual([1, 2, 3]);
      // retry.delaySeconds = 2 between attempts (the container's clock may
      // differ from this process's by a fraction of a second).
      expect(attempts[1]!.startedAt - attempts[0]!.startedAt).toBeGreaterThanOrEqual(1500);
      expect(attempts[2]!.startedAt - attempts[1]!.startedAt).toBeGreaterThanOrEqual(1500);
      expect(await jobState(id!)).toBe("completed");
      const text = output.text();
      expect(text).toContain(`Job failed, will retry job=test.flaky id=${id} attempt=1/4`);
      expect(text).toContain(`Job failed, will retry job=test.flaky id=${id} attempt=2/4`);
      expect(text).toContain(`Job completed job=test.flaky id=${id} attempt=3/4`);
    });

    it("moves a job that keeps failing to the dead letter queue; the operator sees, retries and deletes it", async () => {
      const output = captureOutput();
      const admin = first.get(JobAdmin);
      const secret = marker("dead-letter-secret");
      const id = await enqueue(failingJob, { secret });
      const deadCount = async () =>
        (await admin.status()).find((row) => row.job === failingJob.name)?.dead ?? 0;
      await waitFor(async () => (await deadCount()) === 1, "the dead job");
      expect(runsOf(failingJob.name, secret).map((run) => run.attempt)).toEqual([1, 2]);
      expect(output.text()).toContain(
        `Job failed permanently, moved to the dead letter queue job=test.always-fails id=${id} attempt=2/2 error=Error: this job always fails`,
      );

      const [dead] = await admin.deadJobs(failingJob.name);
      expect(dead).toMatchObject({
        job: failingJob.name,
        attempts: 2,
        error: "Error: this job always fails",
        dataFields: ["secret"],
      });
      expect(JSON.stringify(await admin.deadJobs())).not.toContain(secret);
      const status = (await admin.status()).find((row) => row.job === failingJob.name);
      expect(status).toMatchObject({ kind: "on_demand", dead: 1, failed: 1, waiting: 0 });

      // Retried after the fix: a new job with fresh retries (it still fails here).
      const retried = await admin.retryDead(dead!.id);
      expect(retried).toMatchObject({ id: dead!.id, job: failingJob.name });
      await expect(admin.retryDead(dead!.id)).rejects.toThrow(/No dead job/);
      await waitFor(() => runsOf(failingJob.name, secret).length === 4, "the retried job");
      await waitFor(async () => (await admin.deadJobs(failingJob.name)).length === 1, "dead again");
      const [again] = await admin.deadJobs(failingJob.name);
      expect(again!.id).not.toBe(dead!.id);

      const deleted = await admin.deleteDead(again!.id);
      expect(deleted).toEqual({ id: again!.id, job: failingJob.name, deleted: true });
      expect(await admin.deadJobs()).toEqual([]);
      expect(await deadCount()).toBe(0);
      await expect(admin.deleteDead(again!.id)).rejects.toThrow(/No dead job/);
      output.stop();
      expect(output.text()).not.toContain(secret);
    });

    it("sweeps due rows in bounded batches; a failing row doesn't stop the others", async () => {
      const output = captureOutput();
      await db.query(
        "INSERT INTO sweep_item (due_at, poison) SELECT now() - interval '1 minute' * g, g = 7 FROM generate_series(1, 25) g",
      );
      await db.query("INSERT INTO sweep_item (due_at) VALUES (now() + interval '1 hour')");
      const sweeps = first.get(SweepRunner);
      const signal = new AbortController().signal;
      const result = await sweeps.run(sweepJob, new ItemSweeper("direct"), { signal });
      expect(result).toEqual({ processed: 24, failed: 1, batches: 3, complete: true });
      const { rows } = await db.query<{ done: boolean; poison: boolean; count: number }>(
        "SELECT done, poison, count(*)::int AS count FROM sweep_item GROUP BY done, poison ORDER BY done, poison",
      );
      expect(rows).toEqual([
        // The row not yet due, and the poison row — rolled back to its savepoint.
        { done: false, poison: false, count: 1 },
        { done: false, poison: true, count: 1 },
        { done: true, poison: false, count: 24 },
      ]);
      const { rows: poison } = await db.query<{ id: string; processed_count: number }>(
        "SELECT id, processed_count FROM sweep_item WHERE poison",
      );
      expect(poison[0]!.processed_count).toBe(0);
      expect(output.text()).toContain(
        `Sweep row failed job=test.sweep row=${poison[0]!.id} error=poison row`,
      );

      // Row by row only: batches still bounded by batchSize.
      await db.query("DELETE FROM sweep_item");
      await db.query(
        "INSERT INTO sweep_item (due_at) SELECT now() - interval '1 second' * g FROM generate_series(1, 12) g",
      );
      const rowByRow = await sweeps.run(sweepJob, new ItemSweeper("rows", 0, false), { signal });
      expect(rowByRow).toEqual({ processed: 12, failed: 0, batches: 2, complete: true });

      // The time budget ends a run early; the next run goes on.
      await db.query("DELETE FROM sweep_item");
      await db.query(
        "INSERT INTO sweep_item (due_at) SELECT now() - interval '1 second' * g FROM generate_series(1, 30) g",
      );
      // One batch of ten rows at 100 ms a row spends the whole budget.
      const slow = new ItemSweeper("slow", 100, false);
      const partial = await sweeps.run(
        sweepJob,
        slow,
        { signal },
        { batchSize: 10, maxRunSeconds: 1 },
      );
      expect(partial).toMatchObject({ processed: 10, complete: false });
      const rest = await sweeps.run(
        sweepJob,
        slow,
        { signal },
        { batchSize: 10, maxRunSeconds: 20 },
      );
      expect(partial.processed + rest.processed).toBe(30);
      output.stop();
    });

    it("never handles one row in two parallel sweeps", async () => {
      await db.query("DELETE FROM sweep_item");
      await db.query(
        "INSERT INTO sweep_item (due_at) SELECT now() - interval '1 second' * g FROM generate_series(1, 60) g",
      );
      const signal = new AbortController().signal;
      const [a, b] = await Promise.all([
        first.get(SweepRunner).run(sweepJob, new ItemSweeper("a", 30, false), { signal }),
        second.get(SweepRunner).run(sweepJob, new ItemSweeper("b", 30, false), { signal }),
      ]);
      expect(a.processed + b.processed).toBe(60);
      expect(a.processed).toBeGreaterThan(0);
      expect(b.processed).toBeGreaterThan(0);
      const { rows } = await db.query<{ processed_count: number; count: number }>(
        "SELECT processed_count, count(*)::int AS count FROM sweep_item GROUP BY processed_count",
      );
      expect(rows).toEqual([{ processed_count: 1, count: 60 }]);
    });

    it("says nothing about a periodic run that had nothing to do, and sums them up (TASK-009)", async () => {
      await db.query("DELETE FROM sweep_item");
      const output = captureOutput();
      // Two runs with no due rows at all, then one with work to do.
      for (let run = 0; run < 2; run += 1) {
        const { jobId } = await first.get(JobAdmin).runNow(sweepJob.name);
        await waitFor(async () => (await jobState(jobId!)) === "completed", "an idle sweep");
      }
      const quiet = output.text();
      expect(quiet).not.toContain(`Job completed job=${sweepJob.name}`);
      expect(quiet).not.toContain(`Job started job=${sweepJob.name}`);

      await db.query("INSERT INTO sweep_item (due_at) VALUES (now() - interval '1 second')");
      const { jobId } = await first.get(JobAdmin).runNow(sweepJob.name);
      await waitFor(async () => (await jobState(jobId!)) === "completed", "a working sweep");
      await waitFor(
        () => output.text().includes(`Job completed job=${sweepJob.name}`),
        "the line about the run that worked",
      );

      // The quiet runs are still visible, summed up rather than one by one
      // (a summary may cover one run or both, depending on when it fell).
      await waitFor(
        () =>
          [
            ...output
              .text()
              .matchAll(new RegExp(`${sweepJob.name.replace(".", "\\.")}=(\\d+)`, "g")),
          ].reduce((total, match) => total + Number(match[1]), 0) === 2,
        "the quiet runs to be summed up",
      );
      expect(output.text()).toContain("Periodic jobs ran with nothing to do:");
      output.stop();
    });

    it("runs a sweeper as a periodic job and records the run", async () => {
      await db.query("DELETE FROM sweep_item");
      await db.query(
        "INSERT INTO sweep_item (due_at) SELECT now() - interval '1 second' * g FROM generate_series(1, 15) g",
      );
      const { jobId } = await first.get(JobAdmin).runNow(sweepJob.name);
      expect(jobId).not.toBeNull();
      await waitFor(async () => (await jobState(jobId!)) === "completed", "the sweep job");
      const { rows } = await db.query("SELECT 1 FROM sweep_item WHERE NOT done");
      expect(rows).toHaveLength(0);
      const status = (await first.get(JobAdmin).status()).find((row) => row.job === sweepJob.name);
      expect(status).toMatchObject({ kind: "periodic", singleton: true, dead: null });
      expect(status?.lastSucceededAt).not.toBeNull();
      await expect(first.get(JobAdmin).runNow(recordJob.name)).rejects.toThrow(/needs data/);
      await expect(first.get(JobAdmin).runNow("test.unknown")).rejects.toThrow(/Unknown job/);
    });

    it("runs each scheduled occurrence once with two workers", async () => {
      const firstBoundary = nextMinute(twoWorkersSince);
      // At least one whole minute with both workers up.
      await waitFor(
        () => Date.now() > firstBoundary + 60_000 + 10_000,
        "a whole minute with two workers",
        150_000,
      );
      const steady = runsOf(minutelyJob.name).filter((run) => run.startedAt >= firstBoundary);
      const perMinute = new Map<number, number>();
      for (const run of steady) {
        const minute = Math.floor(run.startedAt / 60_000);
        perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
      }
      const minutes = Math.floor((Date.now() - 10_000 - firstBoundary) / 60_000);
      expect(minutes).toBeGreaterThanOrEqual(1);
      expect(steady.length).toBeGreaterThanOrEqual(minutes);
      expect([...perMinute.values()].every((count) => count === 1)).toBe(true);
    }, 180_000);
  });

  describe("one worker at a time", () => {
    it("runs a job committed while no worker was up once a worker starts", async () => {
      const value = marker("before-worker");
      await producer.get(DatabaseService).db.transaction(async (tx) => {
        await enqueue(recordJob, { marker: value }, { tx });
      });
      await sleep(1000);
      expect(runsOf(recordJob.name, value)).toHaveLength(0);
      const worker = await start("late");
      await waitFor(() => runsOf(recordJob.name, value).length === 1, "the waiting job");
      await stop(worker);
      expect(runsOf(recordJob.name, value)).toHaveLength(1);
    });

    it("lets a running job finish when the worker stops within the limit", async () => {
      const worker = await start("graceful", { tuning: { stopTimeoutMs: 3000 } });
      const value = marker("graceful");
      const id = await enqueue(blockingJob, { marker: value, holdMs: 800 });
      await waitFor(() => runsOf(blockingJob.name, value).length === 1, "the job to start");
      const took = await stop(worker);
      expect(took).toBeLessThan(3000);
      expect(runsOf(blockingJob.name, value)[0]?.finishedAt).toBeDefined();
      expect(await jobState(id!)).toBe("completed");
      const next = await start("after-graceful");
      await sleep(1500);
      await stop(next);
      expect(runsOf(blockingJob.name, value)).toHaveLength(1);
    });

    it("gives a job that outlives the stop limit back to the queue; it runs again elsewhere", async () => {
      const output = captureOutput();
      const worker = await start("impatient", { tuning: { stopTimeoutMs: 500 } });
      const value = marker("outlives");
      const id = await enqueue(blockingJob, { marker: value, holdMs: 3000 });
      await waitFor(() => runsOf(blockingJob.name, value).length === 1, "the job to start");
      const took = await stop(worker);
      // The process's own limit is 10 s (common/shutdown).
      expect(took).toBeLessThan(2500);
      expect(await jobState(id!)).toBe("retry");
      expect(output.text()).toContain(
        `Job interrupted (timed out or worker stopping) job=test.blocking id=${id} attempt=1/4`,
      );
      const next = await start("takes-over");
      await waitFor(async () => (await jobState(id!)) === "completed", "the job to run again");
      await stop(next);
      expect(runsOf(blockingJob.name, value).map((run) => [run.worker, run.attempt])).toEqual([
        ["impatient", 1],
        ["takes-over", 2],
      ]);
      output.stop();
    });

    it("gives the job of a worker that died mid-run back to the queue after its time limit", async () => {
      const value = marker("orphaned");
      const id = await enqueue(
        blockingJob,
        { marker: value, holdMs: 0 },
        {
          startAfter: new Date(Date.now() + 60_000),
        },
      );
      // A process that takes the job and dies without a word.
      const dying = new PgBoss({
        connectionString: postgres.getConnectionUri(),
        schema: "pgboss",
        migrate: false,
        supervise: false,
        schedule: false,
      });
      dying.on("error", () => undefined);
      await dying.start();
      const [taken] = await dying.fetch(blockingJob.name, { ignoreStartAfter: true });
      expect(taken?.id).toBe(id);
      await dying.stop({ graceful: false });
      expect(await jobState(id!)).toBe("active");

      const worker = await start("supervisor");
      // timeoutSeconds = 4: then the supervisor fails it into a retry.
      await waitFor(async () => (await jobState(id!)) === "completed", "the orphaned job", 30_000);
      await stop(worker);
      expect(runsOf(blockingJob.name, value).map((run) => run.attempt)).toEqual([2]);
      expect((await jobRows(blockingJob.name)).find((row) => row.id === id)?.retry_count).toBe(1);
    });

    it("keeps a worker alive while PostgreSQL is away and goes on once it is back", async () => {
      const worker = await start("through-outage", { proxied: true });
      await ready(worker);
      const before = marker("before-outage");
      await enqueue(recordJob, { marker: before });
      await waitFor(() => runsOf(recordJob.name, before).length === 1, "a job before the outage");

      await proxy.stop();
      const during = marker("during-outage");
      // Put on the queue while the worker can't see the database.
      await enqueue(recordJob, { marker: during });
      await sleep(4000);
      expect(runsOf(recordJob.name, during)).toHaveLength(0);

      await proxy.start();
      await waitFor(
        () => runsOf(recordJob.name, during).length === 1,
        "the job after the outage",
        30_000,
      );
      const after = marker("after-outage");
      await enqueue(recordJob, { marker: after });
      await waitFor(() => runsOf(recordJob.name, after).length === 1, "a new job after the outage");
      expect(runsOf(recordJob.name, during)[0]?.worker).toBe("through-outage");
      await stop(worker);
    });

    it("starts while PostgreSQL is away and begins working once it is back", async () => {
      await proxy.stop();
      const output = captureOutput();
      const worker = await start("started-in-outage", { proxied: true });
      const value = marker("started-in-outage");
      await enqueue(recordJob, { marker: value });
      await sleep(1500);
      expect(runsOf(recordJob.name, value)).toHaveLength(0);
      expect(output.text()).toContain("Job queue could not start, retrying");
      await proxy.start();
      await waitFor(() => runsOf(recordJob.name, value).length === 1, "the job", 30_000);
      expect(output.text()).toContain("Job queue started role=worker (after retries)");
      output.stop();
      await stop(worker);
    });
  });
});

function nextMinute(time: number): number {
  return Math.ceil(time / 60_000) * 60_000;
}
