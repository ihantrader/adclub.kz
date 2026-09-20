import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Client } from "pg";
import request from "supertest";
import tsxPackage from "tsx/package.json";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { JsonLoggerService } from "../../../common/logging";
import { loadConfig, type AppConfig } from "../../../config";
import { runMigrate } from "../../../database/migrate-cli";
import { configureHttpApp } from "../../../http-app";
import { JobAdmin, type JobsTuning } from "../../../jobs";
import { TRUNCATE_ALL } from "../../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../../testing/output-capture";
import { TestSettings } from "../../../testing/settings";
import { WorkerModule } from "../../../worker.module";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../index";
import {
  loginCodeCleanupJob,
  sessionCleanupJob,
  signInStepCleanupJob,
} from "./sign-in-data-cleanup";

/**
 * TASK-008 requirement 4 (D-054): the worker deletes login codes, sign-in
 * steps and sessions a while after they stopped being usable, keeps
 * everything still in use and `phone_verification`, follows the retention
 * settings, and never writes a phone number or a count of nothing into the
 * log. Real PostgreSQL and Redis, the real API and worker processes, and
 * the real operator command.
 */

const USER_PHONE = "+77011234567";
const OTHER_PHONE = "+77471112233";
const MOBILE = "mobile/1.4.2 (ios)";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const TSX_CLI = resolve(dirname(require.resolve("tsx/package.json")), tsxPackage.bin);
const OPERATOR_ENTRY = resolve(__dirname, "..", "..", "..", "operator.ts");

const FAST: Partial<JobsTuning> = {
  pollingIntervalSeconds: 0.5,
  monitorIntervalSeconds: 1,
  superviseIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
  cronMonitorIntervalSeconds: 1,
  cronWorkerIntervalSeconds: 1,
  scheduleSyncIntervalMs: 500,
  startRetryMs: 300,
  stopTimeoutMs: 3000,
};

describe("cleanup of stale sign-in data (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let channels: TestLoginCodeChannels;
  let settings: TestSettings;
  let output: ReturnType<typeof captureOutput>;

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
    });
    const nestApp = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 300 }, jobs: FAST }),
      { bufferLogs: true },
    );
    nestApp.useLogger(nestApp.get(JsonLoggerService));
    nestApp.flushLogs();
    configureHttpApp(nestApp, config);
    await nestApp.init();
    app = nestApp;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 300 }, jobs: FAST }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    settings = new TestSettings(worker);
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    await db.query(TRUNCATE_ALL);
    await Promise.all([settings.reload(), new TestSettings(app).reload()]);
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
    rememberCode(USER_PHONE, OTHER_PHONE);
  });

  const http = () => request(app.getHttpServer());

  /** Signs in for real: the code, its verification, and a live session. */
  async function signIn(phone: string): Promise<{ accessToken: string; refreshToken: string }> {
    await http().post("/auth/login-code").send({ phone }).expect(200);
    const code = channels.sent.at(-1)!.code;
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", MOBILE)
      .send({ phone, code })
      .expect(200);
    const session = (response.body as { session: { accessToken: string; refreshToken: string } })
      .session;
    rememberSecret(session.accessToken, session.refreshToken);
    return session;
  }

  /**
   * Runs a cleanup job now and waits for it to finish. The job is a
   * singleton that also runs every minute: when a scheduled run is already
   * waiting, `runNow` puts none and says so (`jobId: null`) — then it asks
   * again once that one has been taken, so the run waited for is one of its
   * own, started after the data of the test was in place (TASK-010.A: the
   * test used to look up the job `null` and report it "gone").
   */
  async function runCleanup(name: string): Promise<void> {
    const admin = worker.get(JobAdmin);
    const deadline = Date.now() + 30_000;
    let { jobId } = await admin.runNow(name);
    while (jobId === null) {
      if (Date.now() > deadline) {
        throw new Error(`Cleanup ${name} could not be started: a run stayed waiting`);
      }
      await sleep(100);
      ({ jobId } = await admin.runNow(name));
    }
    for (;;) {
      const { rows } = await db.query<{ state: string }>(
        "SELECT state::text AS state FROM pgboss.job WHERE id = $1",
        [jobId],
      );
      if (rows[0]?.state === "completed") {
        return;
      }
      if (rows[0]?.state === "failed" || Date.now() > deadline) {
        throw new Error(`Cleanup ${name} did not complete: ${rows[0]?.state ?? "gone"}`);
      }
      await sleep(100);
    }
  }

  const count = async (table: string): Promise<number> => {
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    return rows[0]!.count;
  };

  const ids = async (table: string): Promise<string[]> => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM ${table} ORDER BY id`,
    );
    return rows.map((row) => row.id);
  };

  /** A login code that ended `days` ago, in the given state. */
  async function staleCode(phone: string, days: number, status: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO otp_challenge (phone, status, channel, code_hash, max_attempts, expires_at, consumed_at, created_at)
       SELECT $1, $2, 'whatsapp', 'hash', 5, now() - ($3 || ' days')::interval,
              CASE WHEN $2 = 'consumed' THEN now() - ($3 || ' days')::interval END,
              now() - ($3 || ' days')::interval
       RETURNING id::text AS id`,
      [phone, status, String(days)],
    );
    return rows[0]!.id;
  }

  it("deletes codes, steps and sessions past their retention and keeps everything still in use", async () => {
    const live = await signIn(USER_PHONE);
    const { rows: accounts } = await db.query<{ id: string }>("SELECT id FROM account LIMIT 1");
    const accountId = accounts[0]!.id;

    const staleConsumed = await staleCode(OTHER_PHONE, 10, "consumed");
    const staleExpired = await staleCode(OTHER_PHONE, 8, "expired");
    const staleSuperseded = await staleCode(OTHER_PHONE, 30, "superseded");
    // Ended six days ago: inside the seven-day retention.
    const recentlyEnded = await staleCode(OTHER_PHONE, 6, "consumed");
    // A code someone can still enter right now.
    const { rows: liveCode } = await db.query<{ id: string }>(
      `INSERT INTO otp_challenge (phone, status, channel, code_hash, max_attempts, expires_at)
       VALUES ($1, 'active', 'sms', 'hash', 5, now() + interval '5 minutes') RETURNING id::text AS id`,
      [OTHER_PHONE],
    );

    const step = async (consumedDaysAgo: number | null, expiresDaysAgo: number) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO sign_in_step (kind, account_id, token_hash, expires_at, consumed_at)
         VALUES ('supplier_selection', $1, 'hash', now() - ($2 || ' days')::interval,
                 CASE WHEN $3::text IS NULL THEN NULL ELSE now() - ($3 || ' days')::interval END)
         RETURNING id::text AS id`,
        [
          accountId,
          String(expiresDaysAgo),
          consumedDaysAgo === null ? null : String(consumedDaysAgo),
        ],
      );
      return rows[0]!.id;
    };
    const staleStep = await step(null, 3);
    const staleConsumedStep = await step(2, 2);
    const { rows: liveStep } = await db.query<{ id: string }>(
      `INSERT INTO sign_in_step (kind, account_id, token_hash, expires_at)
       VALUES ('supplier_selection', $1, 'hash', now() + interval '10 minutes') RETURNING id::text AS id`,
      [accountId],
    );

    const staleSession = async (
      revokedDaysAgo: number | null,
      expiresDaysAgo: number,
    ): Promise<string> => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO session (account_id, kind, refresh_seed, last_used_at, expires_at, revoked_at, revoked_reason)
         VALUES ($1, 'mobile', 'seed', now() - interval '1 day', now() - ($2 || ' days')::interval,
                 CASE WHEN $3::text IS NULL THEN NULL ELSE now() - ($3 || ' days')::interval END,
                 CASE WHEN $3::text IS NULL THEN NULL ELSE 'logout' END)
         RETURNING id::text AS id`,
        [
          accountId,
          String(expiresDaysAgo),
          revokedDaysAgo === null ? null : String(revokedDaysAgo),
        ],
      );
      return rows[0]!.id;
    };
    // Logged out 40 days ago, expired 40 days ago, and one that ended 20 days ago.
    const loggedOutLongAgo = await staleSession(40, -60);
    const expiredLongAgo = await staleSession(null, 40);
    const endedRecently = await staleSession(20, -10);

    await runCleanup(loginCodeCleanupJob.name);
    await runCleanup(signInStepCleanupJob.name);
    await runCleanup(sessionCleanupJob.name);

    const codesLeft = await ids("otp_challenge");
    expect(codesLeft).toContain(liveCode[0]!.id);
    expect(codesLeft).toContain(recentlyEnded);
    expect(codesLeft).not.toContain(staleConsumed);
    expect(codesLeft).not.toContain(staleExpired);
    expect(codesLeft).not.toContain(staleSuperseded);
    // The live one, the one that ended six days ago, and the one the
    // sign-in above consumed a moment ago.
    expect(codesLeft).toHaveLength(3);

    expect(await ids("sign_in_step")).toEqual([liveStep[0]!.id]);
    expect([staleStep, staleConsumedStep].every((id) => id.length > 0)).toBe(true);

    const sessionsLeft = await ids("session");
    expect(sessionsLeft).toContain(endedRecently);
    expect(sessionsLeft).not.toContain(loggedOutLongAgo);
    expect(sessionsLeft).not.toContain(expiredLongAgo);
    // The one the sign-in above created, and the one that ended 20 days ago.
    expect(sessionsLeft).toHaveLength(2);
    // The channel of the last confirmation is never cleaned.
    expect(await count("phone_verification")).toBe(1);

    // The live session goes on working, and a new sign-in still works.
    await http()
      .get("/auth/me")
      .set("Authorization", `Bearer ${live.accessToken}`)
      .set("X-Client", MOBILE)
      .expect(200);
    const again = await signIn(OTHER_PHONE);
    expect(again.accessToken).toBeTruthy();

    const logged = appLogText(output.text());
    expect(logged).toContain("Stale sign-in data deleted table=otp_challenge rows=3");
    expect(logged).toContain("Stale sign-in data deleted table=sign_in_step rows=2");
    expect(logged).toContain("Stale sign-in data deleted table=session rows=2");
    expect(logged).not.toContain(USER_PHONE);
    expect(logged).not.toContain(OTHER_PHONE);
  });

  it("follows the retention settings, which the administrator changes without a restart", async () => {
    await staleCode(OTHER_PHONE, 3, "consumed");
    await runCleanup(loginCodeCleanupJob.name);
    // Three days old, seven days of retention: kept.
    expect(await count("otp_challenge")).toBe(1);

    await settings.set({ cleanup_login_code_retention_days: 2 });
    await runCleanup(loginCodeCleanupJob.name);
    expect(await count("otp_challenge")).toBe(0);

    const { rows } = await db.query<{ key: string; value: string }>(
      "SELECT key, value::text AS value FROM app_setting WHERE key = 'cleanup_login_code_retention_days'",
    );
    expect(rows).toEqual([{ key: "cleanup_login_code_retention_days", value: "2" }]);
  });

  it("deletes more rows than fit in one batch, in batches", async () => {
    await db.query(
      `INSERT INTO otp_challenge (phone, status, channel, code_hash, max_attempts, expires_at)
       SELECT $1, 'expired', 'whatsapp', 'hash', 5, now() - interval '30 days' FROM generate_series(1, 600)`,
      [OTHER_PHONE],
    );
    await runCleanup(loginCodeCleanupJob.name);
    expect(await count("otp_challenge")).toBe(0);
    const logged = appLogText(output.text());
    expect(logged).toContain("Stale sign-in data deleted table=otp_challenge rows=600");
    expect(logged).toMatch(
      /Sweep finished job=identity\.cleanup-login-codes processed=600 failed=0 batches=2/,
    );
  });

  it("runs by its schedule every minute, once per occurrence", async () => {
    const { rows } = await db.query<{ name: string; cron: string; timezone: string }>(
      "SELECT name, cron, timezone FROM pgboss.schedule ORDER BY name",
    );
    expect(rows).toEqual([
      // Files of photos no record points at (TASK-013): hourly.
      { name: "catalog.cleanup-photo-files", cron: "17 * * * *", timezone: "Asia/Almaty" },
      // Files of removed photos, once their retention has passed (TASK-013).
      { name: "catalog.delete-photo-files", cron: "* * * * *", timezone: "Asia/Almaty" },
      // Safety net of automatic translation (TASK-012): every five minutes.
      { name: "catalog.translation-wake", cron: "*/5 * * * *", timezone: "Asia/Almaty" },
      // Development and tests only: daily at `billing_notify_hour` (10 by default).
      { name: "dev.daily-at-setting", cron: "0 10 * * *", timezone: "Asia/Almaty" },
      { name: "identity.cleanup-login-codes", cron: "* * * * *", timezone: "Asia/Almaty" },
      { name: "identity.cleanup-sessions", cron: "* * * * *", timezone: "Asia/Almaty" },
      { name: "identity.cleanup-sign-in-steps", cron: "* * * * *", timezone: "Asia/Almaty" },
    ]);
    await staleCode(OTHER_PHONE, 30, "expired");
    // No runNow here: the schedule alone has to clean this up.
    const deadline = Date.now() + 90_000;
    while ((await count("otp_challenge")) > 0) {
      if (Date.now() > deadline) {
        throw new Error("The scheduled cleanup did not run");
      }
      await sleep(500);
    }
    expect(await count("otp_challenge")).toBe(0);
  }, 120_000);

  it("shows the operator the queue, a dead job without its data, and lets them retry and delete it", async () => {
    const operator = async (...args: string[]) => {
      const { stdout } = await execFileAsync(process.execPath, [TSX_CLI, OPERATOR_ENTRY, ...args], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          LOG_LEVEL: "error",
          DATABASE_URL: postgres.getConnectionUri(),
          REDIS_URL: redisContainer.getConnectionUrl(),
          S3_ENDPOINT: "http://127.0.0.1:3",
          S3_ACCESS_KEY: "x",
          S3_SECRET_KEY: "x",
          S3_BUCKET: "x",
        },
      });
      const line = stdout.trim().split("\n").at(-1)!;
      return JSON.parse(line) as unknown;
    };

    await runCleanup(sessionCleanupJob.name);
    const status = (await operator("jobs:status")) as {
      job: string;
      kind: string;
      schedule: { cron: string; timeZone: string } | null;
      dead: number | null;
      lastSucceededAt: string | null;
    }[];
    expect(status.map((row) => row.job)).toEqual([
      "identity.cleanup-login-codes",
      "identity.cleanup-sign-in-steps",
      "identity.cleanup-sessions",
      "catalog.translate",
      "catalog.translation-wake",
      "catalog.delete-photo-files",
      "catalog.cleanup-photo-files",
      "dev.always-fails",
      "dev.daily-at-setting",
    ]);
    expect(status.find((row) => row.job === "identity.cleanup-sessions")).toMatchObject({
      kind: "periodic",
      schedule: { cron: "* * * * *", timeZone: "Asia/Almaty" },
      dead: null,
    });
    expect(
      status.find((row) => row.job === "identity.cleanup-sessions")?.lastSucceededAt,
    ).not.toBeNull();

    // A job that always fails ends up in the dead letter queue (development and tests only).
    const note = `operator-note-${Date.now()}`;
    rememberSecret(note);
    await operator("dev:jobs:fail", "--note", note);
    const deadline = Date.now() + 40_000;
    let dead: { id: string; job: string; attempts: number; error: string; dataFields: string[] }[] =
      [];
    for (;;) {
      dead = (await operator("jobs:dead")) as typeof dead;
      if (dead.length > 0 || Date.now() > deadline) {
        break;
      }
      await sleep(500);
    }
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      job: "dev.always-fails",
      attempts: 3,
      error: "Error: This development job always fails",
      dataFields: ["note"],
    });
    expect(JSON.stringify(dead)).not.toContain(note);

    const retried = (await operator("jobs:retry", dead[0]!.id)) as { newJobId: string };
    expect(retried.newJobId).toBeTruthy();
    let again: typeof dead;
    for (;;) {
      again = (await operator("jobs:dead")) as typeof dead;
      if (again.length > 0 || Date.now() > deadline + 40_000) {
        break;
      }
      await sleep(500);
    }
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(dead[0]!.id);
    expect(await operator("jobs:delete", again[0]!.id)).toMatchObject({ deleted: true });
    expect(await operator("jobs:dead")).toEqual([]);
  }, 150_000);
});
