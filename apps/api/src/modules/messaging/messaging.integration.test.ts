import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request from "supertest";
import tsxPackage from "tsx/package.json";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { WHATSAPP_WEBHOOK_PATH } from "../../common/http";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { JobAdmin, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { WorkerModule } from "../../worker.module";
import { OperatorService } from "../identity";
import { SupplierInvitations, SupplierMembersService } from "../suppliers";
import {
  MessageChannel,
  MessageDeliveryError,
  Messaging,
  MessageSender,
  WebhookEventApplier,
  WebhookEvents,
  WhatsappCloudChannel,
  webhookEventId,
  webhookSignatureHeader,
  type MessageStatus,
  type TestMessageChannel,
} from ".";

/**
 * TASK-024 end to end on a real PostgreSQL and Redis, with the real API and
 * **two** real workers (so "two workers, one message" is what runs all the
 * time, not a special case): the gateway of messages to suppliers — sending
 * through the queue with retries, the dead letter queue and the operator's
 * retry; idempotency under concurrency; no provider call under a lock; the
 * placeholder values leaving the database as soon as they are not needed;
 * the invitation of an employee (W-08) as the first user; the webhook —
 * signature, idempotency, ordering, unknown events, button presses, size and
 * limits; and what leaves the process (log, monitoring, operator output).
 *
 * **Nothing here reaches a network:** the test channel sends nothing, the
 * real channel is given a substituted `fetch`, and the only address anything
 * connects to is this test's own (TASK-024: no real message to a real person).
 */

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const TSX_CLI = resolve(dirname(require.resolve("tsx/package.json")), tsxPackage.bin);
const OPERATOR_ENTRY = resolve(__dirname, "..", "..", "operator.ts");

/** A phone number of the series used here: `+7705` and seven digits. */
const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;

/** Stands in for the error monitoring service: keeps every envelope it is sent. */
class TestReceiver {
  readonly bodies: string[] = [];
  private server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        this.bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  text(): string {
    return this.bodies.join("\n");
  }
}

interface MessageRow {
  id: string;
  dedupe_key: string;
  template: string;
  lang: string;
  phone: string;
  subject_type: string;
  subject_id: string | null;
  variables: Record<string, string> | null;
  status: MessageStatus;
  attempts: number;
  max_attempts: number;
  claimed_until: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  failure_kind: string | null;
  last_error: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  settled_at: Date | null;
}

describe("messages to suppliers (PostgreSQL + Redis, API and two workers)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let receiver: TestReceiver;
  let config: AppConfig;
  let app: INestApplication;
  let worker1: INestApplicationContext;
  let worker2: INestApplicationContext;
  let settings: TestSettings;
  let channels: TestMessageChannel[];
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let apiPort = 0;
  let colleagues = 0;

  const APP_SECRET = () => config.messaging.whatsapp.appSecret!;

  beforeAll(async () => {
    receiver = new TestReceiver();
    await receiver.start();
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    redis = new Redis(redisContainer.getConnectionUrl());
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test-secret",
      S3_BUCKET: "test",
      TRUST_PROXY: "true",
      MONITORING_DSN: `http://publickey@127.0.0.1:${receiver.port}/7`,
    });
    rememberSecret(APP_SECRET(), config.messaging.whatsapp.webhookVerifyToken);
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.listen(0, "127.0.0.1");
    app = nest;
    apiPort = (nest.getHttpServer().address() as AddressInfo).port;
    const start = async (): Promise<INestApplicationContext> => {
      const context = await NestFactory.createApplicationContext(
        WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
        { bufferLogs: true },
      );
      context.useLogger(context.get(JsonLoggerService));
      context.flushLogs();
      return context;
    };
    [worker1, worker2] = await Promise.all([start(), start()]);
    channels = [worker1, worker2].map(
      (context) => context.get(MessageChannel) as TestMessageChannel,
    );
    settings = new TestSettings(app);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([worker1?.close(), worker2?.close()]);
    await app?.close();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await receiver?.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    for (const channel of channels) {
      channel.sent.length = 0;
      channel.mode = "ok";
      channel.delayMs = 5_000;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
        // Jobs of the previous test that are still waiting or dead: the
        // queue is not part of `TRUNCATE_ALL`.
        await db.query(
          "DELETE FROM pgboss.job WHERE name LIKE 'messaging.%' OR name LIKE 'suppliers.%'",
        );
        break;
      } catch (error) {
        if (attempt >= 10) {
          throw error;
        }
        await sleep(200);
      }
    }
    await redis.flushall();
    receiver.bodies.length = 0;
    await settings.reload();
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
  });

  // ------------------------------------------------------------- plumbing

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${String((ipCounter++ % 250) + 1)}`;
  const sentAll = () => channels.flatMap((channel) => channel.sent);
  /**
   * Changes settings and waits until the workers — whose cache of them is 50 ms
   * in tests — have certainly read the change. A message queued by a job in a
   * worker (an invitation) takes its attempts and pauses from what the worker
   * sees, not from what this process was just told.
   */
  const configure = async (values: Parameters<TestSettings["set"]>[0]) => {
    await settings.set(values);
    await sleep(250);
  };
  const setMode = (mode: TestMessageChannel["mode"], delayMs?: number) => {
    for (const channel of channels) {
      channel.mode = mode;
      if (delayMs !== undefined) {
        channel.delayMs = delayMs;
      }
    }
  };
  const runContext = (attempt = 1) => ({
    jobId: "test",
    attempt,
    signal: new AbortController().signal,
  });

  async function waitFor<T>(
    what: string,
    probe: () => Promise<T | undefined | false>,
    // Long enough for a few rounds of the queue's retries on a loaded machine
    // (a passing test never waits this long).
    timeoutMs = 60_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await probe();
      if (found !== undefined && found !== false) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${what}`);
      }
      await sleep(100);
    }
  }

  async function message(id: string): Promise<MessageRow> {
    const { rows } = await db.query<MessageRow>("SELECT * FROM outbound_message WHERE id = $1", [
      id,
    ]);
    return rows[0]!;
  }

  async function messagesOf(subjectId: string): Promise<MessageRow[]> {
    const { rows } = await db.query<MessageRow>(
      "SELECT * FROM outbound_message WHERE subject_id = $1 ORDER BY created_at",
      [subjectId],
    );
    return rows;
  }

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]!.count);
  }

  /** A supplier with its first employee, made the way the development operator command makes them. */
  async function memberOf(
    phone: string,
    options: { name?: string; lang?: "kk" | "ru"; company?: string } = {},
  ) {
    rememberCode(phone, phone.slice(1));
    const operator = app.get(OperatorService);
    const { supplierId } = await operator.createSupplier({
      name: options.company ?? "Автомаркет",
      city: "Алматы",
    });
    const { memberId } = await operator.addMember({
      supplierId,
      phone,
      displayName: options.name ?? "Айгерим",
    });
    if (options.lang) {
      await db.query("UPDATE supplier_member SET notification_language = $1 WHERE id = $2", [
        options.lang,
        memberId,
      ]);
    }
    return { supplierId, memberId };
  }

  /** Asks for an invitation the way the cabinet and the administrator do. */
  async function invite(supplierId: string, memberId: string): Promise<string> {
    const invitations = app.get(SupplierInvitations, { strict: false });
    const row = await app.get(DatabaseService).db.transaction((tx) =>
      invitations.enqueue(tx, {
        supplierId,
        memberId,
        actor: { role: "operator" },
        again: false,
      }),
    );
    return row.id;
  }

  /**
   * The removal of an employee as the cabinet does it: a colleague removes
   * them (the last employee of a company cannot be removed), in one
   * transaction that also cancels the invitations not yet sent. The
   * operator's dev command goes through the remover only.
   */
  async function removeThroughTheCabinet(supplierId: string, memberId: string): Promise<void> {
    const phone = phoneOf(2000 + colleagues++);
    rememberCode(phone, phone.slice(1));
    const colleague = await app
      .get(OperatorService)
      .addMember({ supplierId, phone, displayName: "Коллега" });
    await app.get(SupplierMembersService, { strict: false }).remove(
      {
        role: "supplier",
        accountId: colleague.accountId,
        supplierId,
        memberId: colleague.memberId,
      },
      memberId,
    );
  }

  async function invitation(id: string) {
    const { rows } = await db.query<{
      status: string;
      channel: string | null;
      attempts: number;
      last_error: string | null;
      sent_at: Date | null;
    }>(
      "SELECT status, channel, attempts, last_error, sent_at FROM supplier_invitation WHERE id = $1",
      [id],
    );
    return rows[0]!;
  }

  /** Puts a message on the queue as a module does: in its own transaction. */
  async function queue(
    input: Partial<Parameters<Messaging["enqueue"]>[1]> & { dedupeKey: string },
  ): Promise<{ id: string; created: boolean }> {
    const messaging = app.get(Messaging);
    return app.get(DatabaseService).db.transaction((tx) =>
      messaging.enqueue(tx, {
        template: "admin_message",
        phone: phoneOf(900),
        lang: "ru",
        variables: { text: "Проверка связи" },
        subject: { type: "test_subject", id: null },
        ...input,
      }),
    );
  }

  /** A message row with no job behind it, for the tests that drive the sender by hand. */
  async function insertMessage(
    overrides: Partial<{
      phone: string;
      template: string;
      lang: string;
      variables: Record<string, string> | null;
      status: string;
      claimedUntil: Date | null;
      settledAt: Date | null;
      providerMessageId: string | null;
      sentAt: Date | null;
      subjectType: string;
      subjectId: string | null;
    }> = {},
  ): Promise<string> {
    const phone = overrides.phone ?? phoneOf(910);
    rememberCode(phone, phone.slice(1));
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbound_message
         (dedupe_key, template, lang, phone, subject_type, subject_id, variables, status,
          claimed_until, settled_at, provider_message_id, sent_at, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        `manual:${String(Math.random())}`,
        overrides.template ?? "admin_message",
        overrides.lang ?? "ru",
        phone,
        overrides.subjectType ?? "test_subject",
        overrides.subjectId ?? null,
        overrides.variables === null
          ? null
          : JSON.stringify(overrides.variables ?? { text: "Проверка связи" }),
        overrides.status ?? "queued",
        overrides.claimedUntil ?? null,
        overrides.settledAt ?? null,
        overrides.providerMessageId ?? null,
        overrides.sentAt ?? null,
        overrides.providerMessageId ? "whatsapp_cloud" : null,
      ],
    );
    return rows[0]!.id;
  }

  async function deadJobsOf(messageId: string): Promise<{ id: string }[]> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM pgboss.job WHERE name = 'messaging.send.dead' AND data->>'messageId' = $1",
      [messageId],
    );
    return rows;
  }

  /** How many sessions of the database are inside a transaction they opened and left open. */
  async function openTransactions(): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
    );
    return Number(rows[0]!.count);
  }

  /** How much a counter grew while `action` ran (counters are cumulative over the whole file). */
  async function grownBy(
    name: string,
    labels: Record<string, string>,
    action: () => Promise<unknown>,
  ): Promise<number> {
    const before = (await metric(name, labels)) ?? 0;
    await action();
    return ((await metric(name, labels)) ?? 0) - before;
  }

  /** The fewest open transactions seen over a moment: a real leak is in every sample. */
  async function quietTransactions(): Promise<number> {
    let fewest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      fewest = Math.min(fewest, await openTransactions());
      await sleep(60);
    }
    return fewest;
  }

  /** The value of a metric line of `GET /metrics`, or `undefined` when there is none. */
  async function metric(
    name: string,
    labels: Record<string, string> = {},
  ): Promise<number | undefined> {
    const response = await http().get("/metrics");
    expect(response.status).toBe(200);
    const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
    for (const line of response.text.split("\n")) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) {
        continue;
      }
      if (wanted.every((label) => line.includes(label))) {
        return Number(line.slice(line.lastIndexOf(" ") + 1));
      }
    }
    return undefined;
  }

  // ------------------------------------------------ the webhook's requests

  const raw = (body: unknown) =>
    Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const signatureOf = (body: Buffer, secret = APP_SECRET()) => {
    const header = webhookSignatureHeader(body, secret);
    rememberSecret(header, header.slice("sha256=".length));
    return header;
  };

  function post(body: Buffer, headers: Record<string, string> = {}, ip = nextIp()) {
    return (
      http()
        .post(WHATSAPP_WEBHOOK_PATH)
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", ip)
        .set(headers)
        // A string, not the Buffer: with a JSON content type superagent would
        // serialise a Buffer as {"type":"Buffer","data":[…]} — not the bytes that
        // were signed. Every body here is valid UTF-8, so nothing is lost.
        .send(body.toString("utf8"))
    );
  }

  const signedPost = (body: unknown, ip = nextIp()) => {
    const bytes = raw(body);
    return post(bytes, { "X-Hub-Signature-256": signatureOf(bytes) }, ip);
  };

  /** The real channel's semantics on the worker's channel, over a substituted `fetch`. */
  async function asRealChannel<T>(
    fetch: ConstructorParameters<typeof WhatsappCloudChannel>[3],
    body: () => Promise<T>,
  ): Promise<T> {
    const cloud = new WhatsappCloudChannel(
      "EAAG-not-a-real-token-at-all-0000",
      "1234567890",
      "https://graph.facebook.test/v21.0",
      fetch,
    );
    const originals = channels.map((channel) => ({
      send: channel.send,
      provider: channel.provider,
    }));
    for (const channel of channels) {
      channel.send = (request, signal) => cloud.send(request, signal);
      (channel as { provider: string }).provider = "whatsapp_cloud";
    }
    try {
      return await body();
    } finally {
      channels.forEach((channel, index) => {
        channel.send = originals[index]!.send;
        (channel as { provider: string }).provider = originals[index]!.provider;
      });
    }
  }

  // ---------------------------------------------- sending, and W-08 first

  describe("the invitation of an employee (W-08) through the gateway", () => {
    it("goes out as the template, in the employee's own language, and shows on the development page", async () => {
      const ru = await memberOf(phoneOf(101), { name: "Айгерим", company: "Автомаркет" });
      const invitationId = await invite(ru.supplierId, ru.memberId);
      expect((await invitation(invitationId)).status).toBe("queued");

      const sent = await waitFor("the invitation to be sent", async () => {
        const [row] = await messagesOf(invitationId);
        return row?.status === "sent" ? row : undefined;
      });
      expect(sent).toMatchObject({
        template: "supplier_invitation",
        lang: "ru",
        phone: phoneOf(101),
        subject_type: "supplier_invitation",
        provider: "test",
        attempts: 1,
        failure_kind: null,
      });
      expect(sent.provider_message_id).toMatch(/^wamid\.TEST/);
      expect(sent.sent_at).toBeInstanceOf(Date);
      expect(sentAll()).toHaveLength(1);
      expect(sentAll()[0]).toMatchObject({
        template: "supplier_invitation",
        providerTemplateName: "adclub_supplier_invitation",
        lang: "ru",
        variables: ["Айгерим", "Автомаркет", "http://localhost:5175"],
        text: "Айгерим, вас добавили в кабинет поставщика «Автомаркет». Войти: http://localhost:5175",
      });
      expect(await invitation(invitationId)).toMatchObject({
        status: "sent",
        channel: "test",
        attempts: 1,
        last_error: null,
      });

      const page = await http().get("/dev/messages");
      expect(page.status).toBe(200);
      expect(page.body.messages[0]).toMatchObject({
        template: "supplier_invitation",
        screen: "W-08",
        lang: "ru",
        status: "sent",
        provider: "test",
        text: "Айгерим, вас добавили в кабинет поставщика «Автомаркет». Войти: http://localhost:5175",
      });

      const kk = await memberOf(phoneOf(102), { name: "Асель", lang: "kk", company: "Жүйе" });
      const kkId = await invite(kk.supplierId, kk.memberId);
      await waitFor("the Kazakh invitation", async () =>
        (await messagesOf(kkId))[0]?.status === "sent" ? true : undefined,
      );
      expect(sentAll().find((request) => request.lang === "kk")).toMatchObject({
        lang: "kk",
        text: "Асель, сізді «Жүйе» жеткізушісінің кабинетіне қосты. Кіру: http://localhost:5175",
      });
    });

    it("cancels the message and the invitation when the employee is removed before it goes out", async () => {
      const { supplierId, memberId } = await memberOf(phoneOf(111));
      setMode("unavailable");
      await configure({ message_retry_delay_seconds: 1, message_send_attempts: 5 });
      const invitationId = await invite(supplierId, memberId);
      // The channel is down: the message waits for a retry, unsent.
      await waitFor("a first failed attempt", async () =>
        ((await messagesOf(invitationId))[0]?.attempts ?? 0) > 0 ? true : undefined,
      );
      const removed = await app.get(OperatorService).removeMember(memberId);
      expect(removed.sessionsEnded).toBeGreaterThanOrEqual(0);
      setMode("ok");
      const cancelled = await waitFor("the message to be cancelled", async () => {
        const [row] = await messagesOf(invitationId);
        return row?.status === "cancelled" ? row : undefined;
      });
      expect(cancelled.variables).toBeNull();
      expect(cancelled.settled_at).toBeInstanceOf(Date);
      expect(sentAll()).toEqual([]);
      expect((await invitation(invitationId)).status).toBe("cancelled");
    });

    it("cancels a message whose employee was removed some other way (the invitation is checked itself)", async () => {
      const { supplierId, memberId } = await memberOf(phoneOf(112));
      const invitationId = (
        await db.query<{ id: string }>(
          "INSERT INTO supplier_invitation (supplier_id, member_id) VALUES ($1, $2) RETURNING id",
          [supplierId, memberId],
        )
      ).rows[0]!.id;
      const messageId = await insertMessage({
        template: "supplier_invitation",
        phone: phoneOf(112),
        variables: { memberName: "А", companyName: "Б", link: "http://localhost:5175" },
        subjectType: "supplier_invitation",
        subjectId: invitationId,
      });
      await db.query(
        "UPDATE supplier_member SET status = 'removed', removed_at = now(), notifications_enabled_at = NULL WHERE id = $1",
        [memberId],
      );
      await worker1.get(MessageSender).run({ messageId }, runContext());
      expect((await message(messageId)).status).toBe("cancelled");
      expect(sentAll()).toEqual([]);
    });

    it("does not make the removal of an employee wait for the provider, and holds no lock while it is called", async () => {
      // TASK-017 found the removal waiting for the provider's answer. Here the
      // provider takes four seconds; the removal must not.
      const { supplierId, memberId } = await memberOf(phoneOf(121));
      setMode("slow", 4_000);
      const invitationId = await invite(supplierId, memberId);
      const sending = await waitFor("the message to be handed to the provider", async () => {
        const [row] = await messagesOf(invitationId);
        return row?.status === "sending" ? row : undefined;
      });
      // In the middle of the provider call: no transaction is open anywhere,
      // and neither the message nor the employee is locked.
      expect(await quietTransactions()).toBe(0);
      await db.query("BEGIN");
      try {
        await db.query("SELECT 1 FROM outbound_message WHERE id = $1 FOR UPDATE NOWAIT", [
          sending.id,
        ]);
        await db.query("SELECT 1 FROM supplier_member WHERE id = $1 FOR UPDATE NOWAIT", [memberId]);
        await db.query("SELECT 1 FROM supplier_invitation WHERE id = $1 FOR UPDATE NOWAIT", [
          invitationId,
        ]);
      } finally {
        await db.query("ROLLBACK");
      }
      const started = Date.now();
      await removeThroughTheCabinet(supplierId, memberId);
      expect(Date.now() - started).toBeLessThan(2_000);
      // The provider had the message already: it goes out, and the invitation
      // the removal cancelled stays cancelled.
      await waitFor("the slow send to finish", async () =>
        (await message(sending.id)).status === "sent" ? true : undefined,
      );
      expect((await invitation(invitationId)).status).toBe("cancelled");
    });

    it("never resends: an invitation asked for twice is two messages, the same event twice is one", async () => {
      const { supplierId, memberId } = await memberOf(phoneOf(131));
      const first = await invite(supplierId, memberId);
      const second = await invite(supplierId, memberId);
      await waitFor("both messages", async () =>
        (await messagesOf(first))[0]?.status === "sent" &&
        (await messagesOf(second))[0]?.status === "sent"
          ? true
          : undefined,
      );
      expect(sentAll()).toHaveLength(2);
      // Running the first invitation's job again (a retry after it was done) sends nothing.
      await worker1
        .get(MessageSender)
        .run({ messageId: (await messagesOf(first))[0]!.id }, runContext(2));
      expect(sentAll()).toHaveLength(2);
    });
  });

  // ------------------------------------------------- one event, one message

  describe("idempotency: one event, one recipient, one message", () => {
    it("writes one message and queues one job however many times and however concurrently it is asked", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => queue({ dedupeKey: "event:same-event:member-1" })),
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(await count("outbound_message")).toBe(1);
      const { rows } = await db.query(
        "SELECT id FROM pgboss.job WHERE name = 'messaging.send' AND data->>'messageId' = $1",
        [results[0]!.id],
      );
      expect(rows).toHaveLength(1);
      await waitFor("the message", async () =>
        (await message(results[0]!.id)).status === "sent" ? true : undefined,
      );
      expect(sentAll()).toHaveLength(1);
      // A later repeat of the very same event is still the same message.
      expect((await queue({ dedupeKey: "event:same-event:member-1" })).created).toBe(false);
      await sleep(1_500);
      expect(sentAll()).toHaveLength(1);
    });

    it("sends once when two attempts at the same message run at the same moment (two workers)", async () => {
      setMode("slow", 1_500);
      const messageId = await insertMessage();
      const outcomes = await Promise.allSettled([
        worker1.get(MessageSender).run({ messageId }, runContext()),
        worker2.get(MessageSender).run({ messageId }, runContext()),
      ]);
      expect(sentAll()).toHaveLength(1);
      const row = await message(messageId);
      expect(row).toMatchObject({ status: "sent", attempts: 1 });
      // The attempt that lost did not send a second copy: it was told to come back.
      const refused = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(refused.length).toBeLessThanOrEqual(1);
      for (const outcome of refused) {
        expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(MessageDeliveryError);
        expect((outcome as PromiseRejectedResult).reason.kind).toBe("unavailable");
      }
    });

    it("sends nothing when the job repeats after the message went out", async () => {
      const messageId = await insertMessage();
      await worker1.get(MessageSender).run({ messageId }, runContext());
      await worker2.get(MessageSender).run({ messageId }, runContext(2));
      await worker1.get(MessageSender).run({ messageId }, runContext(3));
      expect(sentAll()).toHaveLength(1);
      expect((await message(messageId)).attempts).toBe(1);
    });

    it("leaves neither a message nor a job when the transaction of the event is rolled back", async () => {
      const messaging = app.get(Messaging);
      await expect(
        app.get(DatabaseService).db.transaction(async (tx) => {
          await messaging.enqueue(tx, {
            template: "admin_message",
            phone: phoneOf(901),
            lang: "ru",
            variables: { text: "Проверка" },
            subject: { type: "test_subject", id: null },
            dedupeKey: "event:rolled-back",
          });
          throw new Error("the event failed after the message was queued");
        }),
      ).rejects.toThrow("the event failed");
      expect(await count("outbound_message")).toBe(0);
      expect(await count("pgboss.job", "name = 'messaging.send'")).toBe(0);
    });

    it("refuses a message it could not render before anything is written, and one that is too long", async () => {
      await expect(queue({ dedupeKey: "event:missing", variables: {} })).rejects.toMatchObject({
        reason: "missing_variable",
      });
      await expect(
        queue({ dedupeKey: "event:multiline", variables: { text: "две\nстроки" } }),
      ).rejects.toMatchObject({ reason: "unsupported_character" });
      await configure({ message_body_max_length: 100 });
      await expect(
        queue({ dedupeKey: "event:long", variables: { text: "я".repeat(200) } }),
      ).rejects.toMatchObject({ reason: "text_too_long" });
      expect(await count("outbound_message")).toBe(0);
    });

    it("sends each recipient of one event its own message, and one refusal does not stop the others", async () => {
      const recipients = [phoneOf(141), phoneOf(142), phoneOf(143)];
      for (const phone of recipients) {
        rememberCode(phone, phone.slice(1));
      }
      const failing = recipients[1]!;
      // One recipient's number is refused by the provider, the others' are not.
      const originals = channels.map((channel) => channel.send.bind(channel));
      channels.forEach((channel, index) => {
        channel.send = (request, signal) =>
          request.phone === failing
            ? Promise.reject(
                new MessageDeliveryError("no_whatsapp", "The number is not on WhatsApp"),
              )
            : originals[index]!(request, signal);
      });
      try {
        const ids = await Promise.all(
          recipients.map((phone, index) =>
            queue({ dedupeKey: `event:order-1:member-${String(index)}`, phone }),
          ),
        );
        expect(new Set(ids.map((entry) => entry.id)).size).toBe(3);
        await waitFor("all three to settle", async () => {
          const { rows } = await db.query<{ status: string }>(
            "SELECT status FROM outbound_message WHERE status IN ('queued', 'sending')",
          );
          return rows.length === 0 ? true : undefined;
        });
        const byPhone = new Map(
          (await db.query<MessageRow>("SELECT * FROM outbound_message")).rows.map((row) => [
            row.phone,
            row,
          ]),
        );
        expect(byPhone.get(recipients[0]!)!.status).toBe("sent");
        expect(byPhone.get(recipients[2]!)!.status).toBe("sent");
        expect(byPhone.get(failing)).toMatchObject({
          status: "failed",
          failure_kind: "no_whatsapp",
        });
        expect(
          sentAll()
            .map((request) => request.phone)
            .sort(),
        ).toEqual([recipients[0]!, recipients[2]!].sort());
      } finally {
        channels.forEach((channel, index) => {
          channel.send = originals[index]!;
        });
      }
    });
  });

  // -------------------------------------------- retries, dead queue, retry

  describe("failures of the provider", () => {
    it("retries a temporary failure by the queue, ends in the dead letter queue, and the operator brings it home", async () => {
      await configure({ message_send_attempts: 3, message_retry_delay_seconds: 1 });
      setMode("unavailable");
      const { id } = await queue({ dedupeKey: "event:down" });
      await waitFor("the dead letter queue", async () =>
        (await deadJobsOf(id)).length === 1 ? true : undefined,
      );
      // Three attempts, as the setting says, and nothing was ever sent. The
      // last one ended the message: it is `failed`, not left waiting with its
      // values for good — the retention clears them like a refused message's.
      const dead = await message(id);
      expect(dead).toMatchObject({
        status: "failed",
        attempts: 3,
        max_attempts: 3,
        failure_kind: "unavailable",
      });
      expect(dead.settled_at).toBeInstanceOf(Date);
      expect(dead.last_error).toContain("attempts exhausted (3)");
      expect(dead.last_error).toContain("unavailable");
      // Kept until the retention: the values are what the operator's retry needs.
      expect(dead.variables).toEqual({ text: "Проверка связи" });
      expect(sentAll()).toEqual([]);
      // The operator sees it: the dead job with its name and attempts, never its data.
      const listed = await worker1.get(JobAdmin).deadJobs("messaging.send");
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ job: "messaging.send", dataFields: ["messageId"] });

      // The provider is back; `jobs:retry` puts the job back and the message goes out.
      setMode("ok");
      await worker1.get(JobAdmin).retryDead(listed[0]!.id);
      const sent = await waitFor("the message after the retry", async () => {
        const row = await message(id);
        return row.status === "sent" ? row : undefined;
      });
      expect(sent.attempts).toBe(4);
      expect(sent.last_error).toBeNull();
      expect(sent.failure_kind).toBeNull();
      // A fresh set of attempts, counted from where the message was.
      expect(sent.max_attempts).toBe(6);
      expect(sentAll()).toHaveLength(1);
      expect(await deadJobsOf(id)).toHaveLength(0);
    });

    it("retries when the provider limits us, exactly as for an unavailable one", async () => {
      await configure({ message_send_attempts: 3, message_retry_delay_seconds: 1 });
      setMode("rate_limited");
      const { id } = await queue({ dedupeKey: "event:limited" });
      await waitFor("a second attempt", async () =>
        (await message(id)).attempts >= 2 ? true : undefined,
      );
      expect((await message(id)).status).toBe("queued");
      setMode("ok");
      await waitFor("the message to go out once the limit passed", async () =>
        (await message(id)).status === "sent" ? true : undefined,
      );
      expect(sentAll()).toHaveLength(1);
    });

    for (const [mode, kind] of [
      ["rejected", "rejected"],
      ["template_not_approved", "template_not_approved"],
      ["no_whatsapp", "no_whatsapp"],
    ] as const) {
      it(`does not retry a final refusal (${mode}): one attempt, the reason on the message, the dead job for the operator`, async () => {
        setMode(mode);
        const { supplierId, memberId } = await memberOf(phoneOf(151));
        const invitationId = await invite(supplierId, memberId);
        const failed = await waitFor("the message to fail", async () => {
          const [row] = await messagesOf(invitationId);
          return row?.status === "failed" ? row : undefined;
        });
        expect(failed).toMatchObject({ attempts: 1, failure_kind: kind, provider: "test" });
        expect(failed.settled_at).toBeInstanceOf(Date);
        // No retry ever comes: wait past the first pause of the queue.
        await sleep(2_500);
        expect((await message(failed.id)).attempts).toBe(1);
        expect(sentAll()).toEqual([]);
        expect(await deadJobsOf(failed.id)).toHaveLength(1);
        // The invitation says why, in a token and not in the provider's words.
        expect(await invitation(invitationId)).toMatchObject({
          status: "failed",
          last_error: kind,
        });
      });
    }

    it("puts a refused message back on the queue for the operator while its values are kept", async () => {
      setMode("template_not_approved");
      const { id } = await queue({ dedupeKey: "event:refused" });
      await waitFor("the refusal", async () =>
        (await message(id)).status === "failed" ? true : undefined,
      );
      setMode("ok");
      const result = await app.get(Messaging).retry(id);
      expect(result).toEqual({ status: "queued", queued: true });
      const sent = await waitFor("the message after the operator's retry", async () => {
        const row = await message(id);
        return row.status === "sent" ? row : undefined;
      });
      expect(sent.failure_kind).toBeNull();
      expect(sent.settled_at).toBeInstanceOf(Date);
      expect(sentAll()).toHaveLength(1);
    });

    it("cannot resurrect a message whose values are gone, and says so", async () => {
      const id = await insertMessage({
        status: "sent",
        variables: null,
        settledAt: new Date(),
        sentAt: new Date(),
        providerMessageId: "wamid.GONE",
      });
      expect(await app.get(Messaging).retry(id)).toEqual({ status: "sent", queued: false });
      expect(sentAll()).toEqual([]);
    });

    it("fails a message it cannot render for good, without calling the provider", async () => {
      const id = await insertMessage({ variables: {} });
      await expect(worker1.get(MessageSender).run({ messageId: id }, runContext())).rejects.toThrow(
        /cannot be rendered/,
      );
      expect(await message(id)).toMatchObject({ status: "failed", failure_kind: "render_failed" });
      expect(sentAll()).toEqual([]);
    });

    it("leaves a message whose attempt was interrupted as unknown, never sending it again by itself", async () => {
      // A worker killed after it took the message and before it heard back:
      // the claim ran out and nobody can say whether the provider got it.
      const id = await insertMessage({
        status: "sending",
        claimedUntil: new Date(Date.now() - 60_000),
      });
      await worker1.get(MessageSender).run({ messageId: id }, runContext(2));
      expect(await message(id)).toMatchObject({
        status: "unknown",
        last_error: "interrupted while sending",
      });
      expect(sentAll()).toEqual([]);
      // Only a person decides: the operator's retry sends it.
      await app.get(Messaging).retry(id);
      await waitFor("the operator's decision to be carried out", async () =>
        (await message(id)).status === "sent" ? true : undefined,
      );
      expect(sentAll()).toHaveLength(1);
    });

    it("does not touch a message another attempt still holds", async () => {
      const id = await insertMessage({
        status: "sending",
        claimedUntil: new Date(Date.now() + 60_000),
      });
      await expect(
        worker1.get(MessageSender).run({ messageId: id }, runContext()),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect((await message(id)).status).toBe("sending");
      expect(sentAll()).toEqual([]);
    });

    it("ends the invitation as failed when the attempts are spent, as it always did, and follows its message home", async () => {
      await configure({ message_send_attempts: 2, message_retry_delay_seconds: 1 });
      setMode("unavailable");
      const { supplierId, memberId } = await memberOf(phoneOf(171));
      const invitationId = await invite(supplierId, memberId);
      // Each failed attempt is on the invitation while it waits...
      await waitFor("a first failed attempt on the invitation", async () => {
        const row = await invitation(invitationId);
        return row.attempts === 1 && row.status === "queued" && row.last_error === "unavailable"
          ? true
          : undefined;
      });
      // ...and when the attempts are spent the invitation says so.
      await waitFor("the invitation to fail", async () =>
        (await invitation(invitationId)).status === "failed" ? true : undefined,
      );
      expect(await invitation(invitationId)).toMatchObject({
        status: "failed",
        attempts: 2,
        last_error: "unavailable",
      });
      // The operator brings the message back: the invitation goes with it,
      // and is not cancelled by a message that is only being retried.
      setMode("ok");
      const [message1] = await messagesOf(invitationId);
      await app.get(Messaging).retry(message1!.id);
      await waitFor("the invitation to be sent after all", async () =>
        (await invitation(invitationId)).status === "sent" ? true : undefined,
      );
      expect(await invitation(invitationId)).toMatchObject({ status: "sent", last_error: null });
      expect(sentAll()).toHaveLength(1);
    });

    it("leaves a message nobody can know the outcome of as unknown — one attempt, no retry — and a person decides", async () => {
      setMode("outcome_unknown");
      const { supplierId, memberId } = await memberOf(phoneOf(181));
      const invitationId = await invite(supplierId, memberId);
      const unknown = await waitFor("the message to be left unknown", async () => {
        const [row] = await messagesOf(invitationId);
        return row?.status === "unknown" ? row : undefined;
      });
      expect(unknown).toMatchObject({ attempts: 1, provider: "test", provider_message_id: null });
      expect(unknown.settled_at).toBeInstanceOf(Date);
      expect(unknown.last_error).toContain("outcome unknown");
      // Kept: a person may decide to send it after all.
      expect(unknown.variables).not.toBeNull();
      // No retry ever comes, and no second copy: wait past the queue's first pause.
      await sleep(2_500);
      expect((await message(unknown.id)).attempts).toBe(1);
      expect(sentAll()).toEqual([]);
      expect(await deadJobsOf(unknown.id)).toHaveLength(1);
      expect(await invitation(invitationId)).toMatchObject({
        status: "failed",
        last_error: "outcome_unknown",
      });

      setMode("ok");
      await app.get(Messaging).retry(unknown.id);
      await waitFor("the message after the person's decision", async () =>
        (await message(unknown.id)).status === "sent" ? true : undefined,
      );
      expect(await invitation(invitationId)).toMatchObject({ status: "sent", last_error: null });
      expect(sentAll()).toHaveLength(1);
    });

    it("does not send again after the provider answered, whatever goes wrong with the bookkeeping", async () => {
      const messageId = await insertMessage();
      const sender = worker1.get(MessageSender) as unknown as {
        settle: (id: string, outcome: unknown) => Promise<void>;
      };
      const settle = sender.settle.bind(sender);
      let tries = 0;
      sender.settle = () => {
        tries += 1;
        return Promise.reject(new Error("the database went away"));
      };
      try {
        await expect(worker1.get(MessageSender).run({ messageId }, runContext())).rejects.toThrow(
          "the database went away",
        );
      } finally {
        sender.settle = settle;
      }
      // Tried in place a few times, and the job then fails — but the message is
      // NOT back on the queue: the provider had it, once.
      expect(tries).toBe(3);
      expect(sentAll()).toHaveLength(1);
      const held = await message(messageId);
      expect(held).toMatchObject({ status: "sending", attempts: 1 });
      // Its id was written down the moment the provider answered.
      expect(held.provider_message_id).toMatch(/^wamid\.TEST/);

      // The queue retries the job: the claim is live, so this attempt waits.
      await expect(
        worker1.get(MessageSender).run({ messageId }, runContext(2)),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect(sentAll()).toHaveLength(1);
      // When the claim runs out, the message is what it is — sent, because its
      // id was recorded — and nothing is sent again.
      await db.query(
        "UPDATE outbound_message SET claimed_until = now() - interval '1 hour' WHERE id = $1",
        [messageId],
      );
      await worker2.get(MessageSender).run({ messageId }, runContext(3));
      expect(await message(messageId)).toMatchObject({
        status: "sent",
        provider_message_id: held.provider_message_id,
      });
      expect(sentAll()).toHaveLength(1);
    });

    it("recovers an interrupted attempt as sent when the provider's id had been recorded", async () => {
      const id = await insertMessage({
        status: "sending",
        claimedUntil: new Date(Date.now() - 60_000),
        providerMessageId: "wamid.RECORDED",
        variables: { text: "Проверка связи" },
      });
      await worker1.get(MessageSender).run({ messageId: id }, runContext(2));
      expect(await message(id)).toMatchObject({
        status: "sent",
        provider_message_id: "wamid.RECORDED",
        variables: null,
      });
      expect(sentAll()).toEqual([]);
    });

    it("recovers interrupted messages nobody's job will come back for, and never sends any of them", async () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
      const took = await insertMessage({
        status: "sending",
        claimedUntil: tenMinutesAgo,
        providerMessageId: "wamid.SWEPT",
      });
      const unsure = await insertMessage({ status: "sending", claimedUntil: tenMinutesAgo });
      // Just expired (inside the grace of the sweeper) and still live: left alone.
      const justNow = await insertMessage({
        status: "sending",
        claimedUntil: new Date(Date.now() - 20_000),
      });
      const live = await insertMessage({
        status: "sending",
        claimedUntil: new Date(Date.now() + 60_000),
      });
      await worker1.get(JobAdmin).runNow("messaging.recover-interrupted");
      await waitFor("the interrupted messages to be recovered", async () =>
        (await message(took)).status !== "sending" && (await message(unsure)).status !== "sending"
          ? true
          : undefined,
      );
      // The provider had its id written down: it took the message.
      expect(await message(took)).toMatchObject({
        status: "sent",
        provider_message_id: "wamid.SWEPT",
        variables: null,
      });
      // Nothing to say either way: a person decides, and the values wait for them.
      const undecided = await message(unsure);
      expect(undecided).toMatchObject({
        status: "unknown",
        last_error: "interrupted while sending",
      });
      expect(undecided.variables).not.toBeNull();
      expect((await message(justNow)).status).toBe("sending");
      expect((await message(live)).status).toBe("sending");
      // Nothing was sent, by anybody.
      expect(sentAll()).toEqual([]);
    });

    it("does not put a message back on the queue that the provider has, or that is being sent", async () => {
      const { id } = await queue({ dedupeKey: "event:retry-guard" });
      await waitFor("the message", async () =>
        (await message(id)).status === "sent" ? true : undefined,
      );
      // The test channel keeps the values of what it "sent" for the development
      // page — a retry must still not send it a second time.
      expect((await message(id)).variables).not.toBeNull();
      expect(await app.get(Messaging).retry(id)).toEqual({ status: "sent", queued: false });
      const sending = await insertMessage({
        status: "sending",
        claimedUntil: new Date(Date.now() + 60_000),
      });
      expect(await app.get(Messaging).retry(sending)).toEqual({ status: "sending", queued: false });
      await sleep(1_500);
      expect(sentAll()).toHaveLength(1);
    });

    describe("with the real channel's reading of a failed request (over a substituted fetch)", () => {
      /** A `fetch` that fails the way undici does: `TypeError: fetch failed` with the system error as its cause. */
      const failingWith = (code: string) => () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error(code), { code }),
          }),
        );

      it("leaves a message unknown when the connection dropped after the request may have been sent", async () => {
        const id = await insertMessage({ template: "admin_message" });
        let calls = 0;
        await asRealChannel(
          () => {
            calls += 1;
            return failingWith("ECONNRESET")();
          },
          async () => {
            await expect(
              worker1.get(MessageSender).run({ messageId: id }, runContext()),
            ).rejects.toThrow(/may have been sent/);
          },
        );
        expect(calls).toBe(1);
        expect(await message(id)).toMatchObject({ status: "unknown", attempts: 1 });
        // Nothing sends it again by itself, however often the job runs.
        await worker2.get(MessageSender).run({ messageId: id }, runContext(2));
        expect(calls).toBe(1);
      });

      it("retries a request that provably never left, and sends it once", async () => {
        const id = await insertMessage({ template: "admin_message" });
        await asRealChannel(failingWith("ECONNREFUSED"), async () => {
          await expect(
            worker1.get(MessageSender).run({ messageId: id }, runContext()),
          ).rejects.toMatchObject({ kind: "unavailable" });
        });
        expect(await message(id)).toMatchObject({ status: "queued", attempts: 1 });
        let calls = 0;
        await asRealChannel(
          () => {
            calls += 1;
            return Promise.resolve(
              new Response(JSON.stringify({ messages: [{ id: "wamid.SECOND" }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          },
          () => worker1.get(MessageSender).run({ messageId: id }, runContext(2)),
        );
        expect(calls).toBe(1);
        expect(await message(id)).toMatchObject({
          status: "sent",
          attempts: 2,
          provider_message_id: "wamid.SECOND",
        });
      });
    });
  });

  // ----------------------------------- what is kept, and for how long

  describe("the values of a message (a customer's name and number)", () => {
    const W02 = {
      number: "1042",
      customerName: "Айгерим Сериккызы",
      customerPhone: "+7 701 123 45 67",
      link: "https://cabinet.adclub.kz/orders/1042",
    };

    it("go the moment the provider took the message, and the provider is called with nothing locked", async () => {
      const id = await insertMessage({ template: "order_accepted", variables: W02, lang: "kk" });
      let calls = 0;
      let openDuringCall = -1;
      let lockedDuringCall = true;
      await asRealChannel(
        async (_url, init) => {
          calls += 1;
          // The provider is being called: nothing may be open or held.
          openDuringCall = await quietTransactions();
          await db.query("BEGIN");
          try {
            await db.query("SELECT 1 FROM outbound_message WHERE id = $1 FOR UPDATE NOWAIT", [id]);
            lockedDuringCall = false;
          } finally {
            await db.query("ROLLBACK");
          }
          expect(String(init.body)).toContain("Айгерим Сериккызы");
          return new Response(JSON.stringify({ messages: [{ id: "wamid.REAL123" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        () => worker1.get(MessageSender).run({ messageId: id }, runContext()),
      );
      expect(calls).toBe(1);
      expect(openDuringCall).toBe(0);
      expect(lockedDuringCall).toBe(false);
      const sent = await message(id);
      expect(sent).toMatchObject({
        status: "sent",
        provider: "whatsapp_cloud",
        provider_message_id: "wamid.REAL123",
        variables: null,
      });
      expect(JSON.stringify(sent)).not.toContain("Сериккызы");
      expect(JSON.stringify(sent)).not.toContain("701 123 45 67");
    });

    it("are kept for a refused message so it can be retried, and cleared after the retention", async () => {
      const id = await insertMessage({ template: "order_accepted", variables: W02 });
      await asRealChannel(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Template name does not exist", code: 132001 } }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
        async () => {
          await expect(
            worker1.get(MessageSender).run({ messageId: id }, runContext()),
          ).rejects.toThrow(/was refused: template_not_approved/);
        },
      );
      const refused = await message(id);
      expect(refused).toMatchObject({
        status: "failed",
        provider: "whatsapp_cloud",
        failure_kind: "template_not_approved",
      });
      expect(refused.variables).toEqual(W02);
      expect(refused.last_error).toContain("132001");
      // The provider's words about the template are kept; a number and a name are not in them.
      expect(refused.last_error).not.toContain("Сериккызы");

      // After `message_variables_retention_days` the sweeper clears them.
      await configure({ message_variables_retention_days: 1 });
      await db.query(
        "UPDATE outbound_message SET settled_at = now() - interval '2 days' WHERE id = $1",
        [id],
      );
      await worker1.get(JobAdmin).runNow("messaging.clear-stale-variables");
      await waitFor("the values to be cleared", async () =>
        (await message(id)).variables === null ? true : undefined,
      );
      const cleared = await message(id);
      // The log of what was sent stays; a name and a number do not.
      expect(cleared).toMatchObject({
        status: "failed",
        template: "order_accepted",
        phone: phoneOf(910),
      });
      expect(await app.get(Messaging).retry(id)).toMatchObject({ queued: false });
    });

    it("are cleared for a message the employee's removal cancelled", async () => {
      const { supplierId, memberId } = await memberOf(phoneOf(161));
      setMode("unavailable");
      await configure({ message_send_attempts: 5, message_retry_delay_seconds: 1 });
      const invitationId = await invite(supplierId, memberId);
      await waitFor("an attempt", async () =>
        ((await messagesOf(invitationId))[0]?.attempts ?? 0) > 0 ? true : undefined,
      );
      expect((await messagesOf(invitationId))[0]!.variables).not.toBeNull();
      await app.get(OperatorService).removeMember(memberId);
      setMode("ok");
      const cancelled = await waitFor("the cancellation", async () => {
        const [row] = await messagesOf(invitationId);
        return row?.status === "cancelled" ? row : undefined;
      });
      expect(cancelled.variables).toBeNull();
    });

    it("cannot outlive the message by any write: the database refuses a settled row that keeps them", async () => {
      const id = await insertMessage({ variables: W02 });
      await expect(
        db.query(
          `UPDATE outbound_message SET status = 'sent', provider = 'whatsapp_cloud',
             provider_message_id = 'wamid.X', sent_at = now(), settled_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/outbound_message_variables_check/);
    });
  });

  // ---------------------------------------------------------------- webhook

  describe("the provider's webhook", () => {
    const statusEvent = (
      wamid: string,
      status: string,
      extra: Record<string, unknown> = {},
      at = Math.floor(Date.now() / 1000) - 5,
    ) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "77000000000", phone_number_id: "1234567890" },
                statuses: [
                  {
                    id: wamid,
                    status,
                    timestamp: String(at),
                    recipient_id: "77055550101",
                    ...extra,
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const buttonEvent = (
      wamid: string,
      payload: string,
      id = `wamid.IN${String(Math.random())}`,
    ) => ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  {
                    id,
                    from: "77055550101",
                    type: "button",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    button: { payload, text: "Подтвердить" },
                    context: { id: wamid, from: "77000000000" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    async function events() {
      const { rows } = await db.query<{
        id: string;
        external_id: string;
        payload: unknown;
        summary: Record<string, number>;
        processed_at: Date | null;
        result: string | null;
        error: string | null;
      }>("SELECT * FROM inbound_webhook_event ORDER BY received_at");
      return rows;
    }

    async function processedEvents(n: number) {
      return waitFor(`${String(n)} processed event(s)`, async () => {
        const all = await events();
        return all.filter((event) => event.result !== null).length >= n ? all : undefined;
      });
    }

    /** A message the provider took, for the events to be about. */
    async function providerMessage(): Promise<{ id: string; wamid: string }> {
      const { id } = await queue({
        dedupeKey: `event:for-webhook:${String(Math.random())}`,
        template: "order_new",
        phone: phoneOf(701),
        variables: {
          number: "1042",
          item: "Колодки",
          quantity: "2",
          total: "24 500",
          fulfillment: "самовывоз",
          respondBy: "18:30",
        },
      });
      const sent = await waitFor("the message to be sent", async () => {
        const row = await message(id);
        return row.status === "sent" ? row : undefined;
      });
      return { id, wamid: sent.provider_message_id! };
    }

    describe("confirming the subscription", () => {
      it("echoes the challenge as plain text when the token is ours", async () => {
        const response = await http()
          .get(WHATSAPP_WEBHOOK_PATH)
          .set("X-Forwarded-For", nextIp())
          .query({
            "hub.mode": "subscribe",
            "hub.verify_token": config.messaging.whatsapp.webhookVerifyToken,
            "hub.challenge": "1158201444",
          });
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/plain");
        expect(response.text).toBe("1158201444");
      });

      it("refuses another token, no token and another mode, and does not say the token", async () => {
        const grown = await grownBy(
          "adclub_webhook_events_total",
          { kind: "subscription_refused" },
          async () => {
            for (const query of [
              {
                "hub.mode": "subscribe",
                "hub.verify_token": "not-our-token",
                "hub.challenge": "1",
              },
              { "hub.mode": "subscribe", "hub.challenge": "1" },
              {
                "hub.mode": "unsubscribe",
                "hub.verify_token": config.messaging.whatsapp.webhookVerifyToken,
                "hub.challenge": "1",
              },
              {},
            ]) {
              const response = await http()
                .get(WHATSAPP_WEBHOOK_PATH)
                .set("X-Forwarded-For", nextIp())
                .query(query);
              expect(response.status).toBe(403);
              expect(response.body.code).toBe("FORBIDDEN");
              expect(response.text).not.toContain(config.messaging.whatsapp.webhookVerifyToken!);
            }
          },
        );
        expect(grown).toBe(4);
      });
    });

    describe("the signature", () => {
      it("refuses a delivery with no signature, a foreign one, a malformed one, and leaves no trace", async () => {
        const body = raw(statusEvent("wamid.NOPE", "delivered"));
        let answers: Awaited<ReturnType<typeof post>>[] = [];
        const grown = await grownBy(
          "adclub_webhook_events_total",
          { kind: "bad_signature" },
          async () => {
            answers = await Promise.all([
              post(body),
              post(body, {
                "X-Hub-Signature-256": signatureOf(body, "another-secret-of-some-other-app"),
              }),
              post(body, { "X-Hub-Signature-256": "sha256=abc" }),
              post(body, { "X-Hub-Signature-256": signatureOf(body).replace("sha256=", "sha1=") }),
              post(body, { "X-Hub-Signature-256": "" }),
            ]);
          },
        );
        for (const answer of answers) {
          expect(answer.status).toBe(403);
          expect(answer.body).toMatchObject({ code: "FORBIDDEN", retryable: false });
        }
        expect(await count("inbound_webhook_event")).toBe(0);
        expect(await count("message_button_press")).toBe(0);
        expect(await count("pgboss.job", "name = 'messaging.apply-webhook-event'")).toBe(0);
        expect(grown).toBe(5);
      });

      it("does not even parse a body it cannot vouch for: garbage with no signature is a 403, not a 400", async () => {
        for (const garbage of ["{not json", "", "\u0000\u0001", '{"entry":'.repeat(50)]) {
          const answer = await post(Buffer.from(garbage, "utf8"));
          expect(answer.status, garbage).toBe(403);
        }
        expect(await count("inbound_webhook_event")).toBe(0);
      });

      it("refuses a body changed after it was signed, and one signed as re-written JSON", async () => {
        const body = raw(statusEvent("wamid.TAMPER", "delivered"));
        const signature = signatureOf(body);
        const tampered = Buffer.from(body.toString("utf8").replace("delivered", "read"), "utf8");
        expect((await post(tampered, { "X-Hub-Signature-256": signature })).status).toBe(403);
        const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
        expect((await post(reformatted, { "X-Hub-Signature-256": signature })).status).toBe(403);
        expect(await count("inbound_webhook_event")).toBe(0);
      });

      it("takes a signed delivery at the address in any case: the body is read as bytes on every spelling", async () => {
        // Express routes case-insensitively. Had this spelling escaped the raw
        // reader, the JSON parser would have taken the body before its signature
        // was looked at — and a valid signature could never hold.
        const bytes = raw(statusEvent("wamid.ANY-CASE", "delivered"));
        const answer = await http()
          .post("/Webhooks/WhatsApp")
          .set("Content-Type", "application/json")
          .set("X-Forwarded-For", nextIp())
          .set("X-Hub-Signature-256", signatureOf(bytes))
          .send(bytes.toString("utf8"));
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({ received: true });
        expect(await count("inbound_webhook_event")).toBe(1);
        // And an unsigned one at the same address is refused like any other.
        const refused = await http()
          .post("/WEBHOOKS/WHATSAPP")
          .set("Content-Type", "application/json")
          .set("X-Forwarded-For", nextIp())
          .send("{not json");
        expect(refused.status).toBe(403);
      });

      it("takes a properly signed delivery at once and leaves the applying to the worker", async () => {
        // The API has nothing that could apply an event: the parsing is not in the request.
        expect(() => app.get(WebhookEventApplier, { strict: false })).toThrow();
        expect(app.get(WebhookEvents, { strict: false })).toBeDefined();
        const { id, wamid } = await providerMessage();
        const answer = await signedPost(statusEvent(wamid, "delivered"));
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({ received: true });
        const [event] = await processedEvents(1);
        expect(event).toMatchObject({ result: "applied", error: null });
        expect((await message(id)).status).toBe("delivered");
      });
    });

    describe("delivery statuses", () => {
      it("moves a message along sent → delivered → read and keeps the times of each", async () => {
        const { id, wamid } = await providerMessage();
        const sentAt = (await message(id)).sent_at!;
        await signedPost(statusEvent(wamid, "delivered", {}, Math.floor(Date.now() / 1000) - 20));
        await processedEvents(1);
        const delivered = await message(id);
        expect(delivered.status).toBe("delivered");
        expect(delivered.delivered_at!.getTime()).toBeLessThan(Date.now() - 10_000);
        await signedPost(statusEvent(wamid, "read", {}, Math.floor(Date.now() / 1000) - 10));
        await processedEvents(2);
        const read = await message(id);
        expect(read.status).toBe("read");
        expect(read.read_at).toBeInstanceOf(Date);
        expect(read.delivered_at).toEqual(delivered.delivered_at);
        expect(read.sent_at).toEqual(sentAt);
      });

      it("takes the same delivery twice — one after the other, and at the same moment — as one", async () => {
        const { id, wamid } = await providerMessage();
        const body = statusEvent(wamid, "delivered");
        const bytes = raw(body);
        const headers = { "X-Hub-Signature-256": signatureOf(bytes) };
        expect((await post(bytes, headers)).status).toBe(200);
        await processedEvents(1);
        const once = await message(id);
        let twice: Awaited<ReturnType<typeof post>>[] = [];
        const repeated = await grownBy(
          "adclub_webhook_events_total",
          { kind: "repeated" },
          async () => {
            twice = await Promise.all(Array.from({ length: 6 }, () => post(bytes, headers)));
          },
        );
        expect(repeated).toBe(6);
        expect(twice.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200]);
        await sleep(1_500);
        // One row, one job, and the message is exactly as it was.
        expect(await count("inbound_webhook_event")).toBe(1);
        expect(await count("pgboss.job", "name = 'messaging.apply-webhook-event'")).toBe(1);
        expect(await message(id)).toEqual(once);
      });

      it("takes concurrent first deliveries of one event as one, not as an error", async () => {
        const { wamid } = await providerMessage();
        const bytes = raw(statusEvent(wamid, "read"));
        const headers = { "X-Hub-Signature-256": signatureOf(bytes) };
        const answers = await Promise.all(Array.from({ length: 8 }, () => post(bytes, headers)));
        expect(answers.map((answer) => answer.status)).toEqual(Array(8).fill(200));
        expect(await count("inbound_webhook_event")).toBe(1);
      });

      it("does not take a message back: events in every order end where the last step of the chain is", async () => {
        const { id, wamid } = await providerMessage();
        for (const status of ["read", "delivered", "sent", "read", "delivered"]) {
          const answer = await signedPost(statusEvent(wamid, status, { nonce: Math.random() }));
          expect(answer.status).toBe(200);
        }
        await processedEvents(5);
        const row = await message(id);
        expect(row.status).toBe("read");
        // `read` arrived first: it was evidently delivered, and `delivered` did not overwrite that.
        expect(row.delivered_at).toBeInstanceOf(Date);
        expect(row.read_at).toBeInstanceOf(Date);
        expect(row.failure_kind).toBeNull();
      });

      it("takes a failure of what the provider had accepted, and does not let one undo a delivery", async () => {
        const failing = await providerMessage();
        await signedPost(
          statusEvent(failing.wamid, "failed", {
            errors: [{ code: 131026, title: "Message undeliverable" }],
          }),
        );
        await processedEvents(1);
        expect(await message(failing.id)).toMatchObject({
          status: "failed",
          failure_kind: "no_whatsapp",
        });
        expect((await message(failing.id)).last_error).toContain("131026");

        const delivered = await providerMessage();
        await signedPost(statusEvent(delivered.wamid, "delivered"));
        await processedEvents(2);
        await signedPost(
          statusEvent(delivered.wamid, "failed", { errors: [{ code: 131026, title: "late" }] }),
        );
        await processedEvents(3);
        expect((await message(delivered.id)).status).toBe("delivered");
        expect((await message(delivered.id)).failure_kind).toBeNull();
      });

      it("takes an event about a message of a removed employee like any other", async () => {
        const { supplierId, memberId } = await memberOf(phoneOf(171));
        const invitationId = await invite(supplierId, memberId);
        const sent = await waitFor("the invitation", async () => {
          const [row] = await messagesOf(invitationId);
          return row?.status === "sent" ? row : undefined;
        });
        await app.get(OperatorService).removeMember(memberId);
        const answer = await signedPost(statusEvent(sent.provider_message_id!, "delivered"));
        expect(answer.status).toBe(200);
        await processedEvents(1);
        expect((await message(sent.id)).status).toBe("delivered");
      });
    });

    describe("an event that beats the record of the message it is about", () => {
      async function plantEvent(wamid: string, ageSeconds = 0): Promise<string> {
        const bytes = raw(statusEvent(wamid, "delivered"));
        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO inbound_webhook_event (provider, external_id, payload, received_at)
           VALUES ('whatsapp', $1, $2, now() - ($3 || ' seconds')::interval) RETURNING id`,
          [webhookEventId(bytes), bytes.toString("utf8"), String(ageSeconds)],
        );
        return rows[0]!.id;
      }

      it("waits for a message that is not on record yet, and applies the event once it is", async () => {
        const wamid = "wamid.NOT-YET-RECORDED";
        const eventId = await plantEvent(wamid);
        const webhookEvents = worker1.get(WebhookEvents);
        expect(await webhookEvents.apply(eventId)).toEqual({ result: "deferred" });
        // Not finalised: not processed, and the body is still there to apply.
        let [event] = await events();
        expect(event).toMatchObject({ result: null, processed_at: null });
        expect(event!.payload).not.toBeNull();
        // The message is recorded a moment later; the same event now applies.
        const id = await insertMessage({
          status: "sent",
          variables: null,
          settledAt: new Date(),
          sentAt: new Date(),
          providerMessageId: wamid,
        });
        expect(await webhookEvents.apply(eventId)).toEqual({ result: "applied" });
        expect((await message(id)).status).toBe("delivered");
        [event] = await events();
        expect(event).toMatchObject({ result: "applied", payload: null });
      });

      it("looks at a deferred event again a little later, as a new job and not as a failure", async () => {
        const eventId = await plantEvent("wamid.STILL-NOT-THERE");
        await worker1.get(WebhookEventApplier).run({ eventId });
        const { rows } = await db.query(
          `SELECT id FROM pgboss.job
           WHERE name = 'messaging.apply-webhook-event' AND data->>'eventId' = $1 AND start_after > now()`,
          [eventId],
        );
        expect(rows).toHaveLength(1);
        expect((await events())[0]).toMatchObject({ result: null, error: null });
      });

      it("waits for the settle of a message whose id is written but whose send is not settled yet", async () => {
        // The provider's id is written the moment it answers, a step before the
        // send is settled: an event can find the message in between. It must not
        // write a delivery over a send that has no time yet — and the settle
        // must not then write `sent` over the delivery.
        const wamid = "wamid.IN-BETWEEN";
        const id = await insertMessage({
          status: "sending",
          claimedUntil: new Date(Date.now() + 60_000),
        });
        await db.query("UPDATE outbound_message SET provider_message_id = $1 WHERE id = $2", [
          wamid,
          id,
        ]);
        const eventId = await plantEvent(wamid);
        const webhookEvents = worker1.get(WebhookEvents);
        expect(await webhookEvents.apply(eventId)).toEqual({ result: "deferred" });
        expect(await message(id)).toMatchObject({ status: "sending", delivered_at: null });
        expect((await events())[0]).toMatchObject({ result: null, processed_at: null });
        // The send is settled; the same event now applies, and only then.
        await db.query(
          `UPDATE outbound_message SET status = 'sent', sent_at = now(), settled_at = now(),
             variables = NULL, claimed_until = NULL, provider = 'whatsapp_cloud' WHERE id = $1`,
          [id],
        );
        expect(await webhookEvents.apply(eventId)).toEqual({ result: "applied" });
        expect(await message(id)).toMatchObject({ status: "delivered" });
      });

      it("gives up on an event about a stranger once it is old enough to be sure", async () => {
        const eventId = await plantEvent("wamid.NEVER-OURS", 120);
        expect(await worker1.get(WebhookEvents).apply(eventId)).toEqual({
          result: "nothing_to_apply",
        });
        const [event] = await events();
        expect(event).toMatchObject({ result: "nothing_to_apply", payload: null });
        expect(event!.summary).toEqual({ "status:unknown_message": 1 });
      });
    });

    describe("what it does not know", () => {
      it("answers 200 to an event about a message we do not have, and records it as nothing to apply", async () => {
        const answer = await signedPost(statusEvent("wamid.NEVER-HEARD-OF", "delivered"));
        expect(answer.status).toBe(200);
        // A young event about an id we do not know is waited on — the record of
        // the message it is about may be a moment behind — and looked at again
        // later, as a new job. Nothing is finalised yet.
        await waitFor("the event to be deferred", async () => {
          const { rows } = await db.query(
            `SELECT 1 FROM pgboss.job
             WHERE name = 'messaging.apply-webhook-event' AND start_after > now()`,
          );
          return rows.length > 0 ? true : undefined;
        });
        expect((await events())[0]).toMatchObject({ result: null, processed_at: null });
        // A minute on, nobody is going to record it: it is not ours.
        await db.query(
          "UPDATE inbound_webhook_event SET received_at = now() - interval '2 minutes'",
        );
        const eventId = (await events())[0]!.id;
        await worker1.get(WebhookEventApplier).run({ eventId });
        const [event] = await processedEvents(1);
        expect(event).toMatchObject({ result: "nothing_to_apply", error: null });
        expect(event!.summary).toEqual({ "status:unknown_message": 1 });
        // The body is gone once it has been looked at.
        expect(event!.payload).toBeNull();
      });

      it("answers 200 to events of kinds nothing acts on, and to shapes nobody expected", async () => {
        const bodies: unknown[] = [
          {
            object: "whatsapp_business_account",
            entry: [
              {
                id: "1",
                changes: [
                  { field: "message_template_status_update", value: { event: "APPROVED" } },
                ],
              },
            ],
          },
          { object: "whatsapp_business_account", entry: [] },
          {
            object: "whatsapp_business_account",
            entry: [
              {
                id: "1",
                changes: [
                  {
                    field: "messages",
                    value: {
                      messaging_product: "whatsapp",
                      messages: [
                        {
                          id: "wamid.TEXT1",
                          from: "77055550101",
                          type: "text",
                          text: { body: "Здравствуйте" },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          {
            object: "whatsapp_business_account",
            entry: [
              {
                id: "1",
                changes: [
                  {
                    field: "messages",
                    value: { statuses: [{ id: "wamid.X", status: "warning" }] },
                  },
                ],
              },
            ],
          },
          { totally: "different" },
          [],
          "just a string",
          { entry: "not an array" },
        ];
        for (const body of bodies) {
          expect((await signedPost(body)).status, JSON.stringify(body)).toBe(200);
        }
        // Even a signed body that is not JSON at all.
        expect((await signedPost("this is signed but not JSON")).status).toBe(200);
        const all = await processedEvents(bodies.length + 1);
        expect(
          all.every((event) => event.result === "nothing_to_apply" && event.error === null),
        ).toBe(true);
        expect(all.every((event) => event.payload === null)).toBe(true);
        // What a person typed is not kept anywhere.
        expect(JSON.stringify(all)).not.toContain("Здравствуйте");
        expect(await count("message_button_press")).toBe(0);
        // The one that was not JSON says so, apart from bodies of an unexpected shape.
        expect(all.map((event) => event.summary)).toContainEqual({ unparsed_body: 1 });
      });

      it("answers 200 to a signed empty body and stores nothing", async () => {
        const empty = Buffer.alloc(0);
        const answer = await post(empty, { "X-Hub-Signature-256": signatureOf(empty) });
        expect(answer.status).toBe(200);
        expect(await count("inbound_webhook_event")).toBe(0);
      });
    });

    describe("a button pressed", () => {
      it("is stored and linked to the message it answers, and nothing is done about an order", async () => {
        const { id, wamid } = await providerMessage();
        const before = await db.query("SELECT * FROM outbound_message ORDER BY id");
        const answer = await signedPost(buttonEvent(wamid, "confirm:order-1042:sig"));
        expect(answer.status).toBe(200);
        await processedEvents(1);
        const { rows } = await db.query<{
          message_id: string | null;
          button_name: string | null;
          payload: string;
          from_phone: string;
          context_provider_message_id: string;
          applied_at: Date | null;
        }>("SELECT * FROM message_button_press");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          message_id: id,
          button_name: "confirm",
          payload: "confirm:order-1042:sig",
          from_phone: "+77055550101",
          context_provider_message_id: wamid,
          // Acting on it is TASK-025: nothing has touched it.
          applied_at: null,
        });
        // The message is as it was: a press is not a delivery status.
        expect((await db.query("SELECT * FROM outbound_message ORDER BY id")).rows).toEqual(
          before.rows,
        );
        expect(await count("customer_order")).toBe(0);
      });

      it("is stored once however often it is delivered, and by whatever body the delivery came", async () => {
        const { wamid } = await providerMessage();
        const press = buttonEvent(wamid, "decline:order-1042:sig", "wamid.IN-FIXED-1");
        await signedPost(press);
        await signedPost(press);
        // The same press inside a differently written delivery: still the same press.
        await signedPost({ ...press, entry: [{ ...press.entry[0], id: "WABA-OTHER" }] });
        await processedEvents(2);
        expect(await count("message_button_press")).toBe(1);
      });

      it("is stored, unlinked, when it answers a message we do not have", async () => {
        await signedPost(buttonEvent("wamid.NOT-OURS", "confirm:x:y"));
        await processedEvents(1);
        const { rows } = await db.query("SELECT message_id, button_name FROM message_button_press");
        expect(rows).toEqual([{ message_id: null, button_name: "confirm" }]);
      });

      it("keeps only the token of the button, not a person's words", async () => {
        const { wamid } = await providerMessage();
        await signedPost(buttonEvent(wamid, "some unreadable payload"));
        await processedEvents(1);
        const { rows } = await db.query<{ button_name: string | null; payload: string }>(
          "SELECT button_name, payload FROM message_button_press",
        );
        expect(rows[0]!.button_name).toBeNull();
        expect(await count("message_button_press", "payload LIKE '%Подтвердить%'")).toBe(0);
      });
    });

    describe("a failure of the applying", () => {
      it("keeps the delivery, reports the failure, and the retry applies it once", async () => {
        const { id, wamid } = await providerMessage();
        // Written straight to the table: no job behind it, so the live workers
        // cannot apply it before the failure is made to happen.
        const bytes = raw(statusEvent(wamid, "delivered"));
        const { rows: made } = await db.query<{ id: string }>(
          "INSERT INTO inbound_webhook_event (provider, external_id, payload) VALUES ('whatsapp', $1, $2) RETURNING id",
          [webhookEventId(bytes), bytes.toString("utf8")],
        );
        const eventId = made[0]!.id;
        const applier = worker1.get(WebhookEventApplier);
        const webhookEvents = worker1.get(WebhookEvents);
        const original = webhookEvents.apply.bind(webhookEvents);
        webhookEvents.apply = () => Promise.reject(new Error("the database hiccuped"));
        try {
          await expect(applier.run({ eventId })).rejects.toThrow("the database hiccuped");
        } finally {
          webhookEvents.apply = original;
        }
        let [event] = await events();
        expect(event).toMatchObject({ result: "failed", error: "the database hiccuped" });
        // The body is still there: a retry has something to work with.
        expect(event!.payload).not.toBeNull();
        expect((await message(id)).status).toBe("sent");
        await applier.run({ eventId });
        // A third run finds it applied already and changes nothing.
        await applier.run({ eventId });
        [event] = await events();
        expect(event).toMatchObject({ result: "applied", error: null, payload: null });
        expect((await message(id)).status).toBe("delivered");
        expect(await count("inbound_webhook_event")).toBe(1);
      });
    });

    describe("size, type and rate", () => {
      it("refuses a body over the ceiling before reading it, even when it is properly signed", async () => {
        const big = Buffer.alloc(300 * 1024, "a");
        const answer = await post(big, { "X-Hub-Signature-256": signatureOf(big) });
        expect(answer.status).toBe(413);
        expect(answer.body.code).toBe("PAYLOAD_TOO_LARGE");
        expect(await count("inbound_webhook_event")).toBe(0);
        // A body just under the ceiling is the provider's business, and taken.
        const nearly = raw({ pad: "a".repeat(200 * 1024) });
        expect((await post(nearly, { "X-Hub-Signature-256": signatureOf(nearly) })).status).toBe(
          200,
        );
      });

      it("takes only JSON", async () => {
        const body = raw(statusEvent("wamid.X", "delivered"));
        const answer = await http()
          .post(WHATSAPP_WEBHOOK_PATH)
          .set("Content-Type", "text/plain")
          .set("X-Forwarded-For", nextIp())
          .set("X-Hub-Signature-256", signatureOf(body))
          .send(body);
        expect(answer.status).toBe(415);
        expect(await count("inbound_webhook_event")).toBe(0);
      });

      it("limits the route by the address of the caller, by the one mechanism of every route", async () => {
        await configure({
          whatsapp_webhook_per_ip: 3,
          whatsapp_webhook_per_ip_window_seconds: 60,
        });
        const attacker = "203.0.113.7";
        const body = raw(statusEvent("wamid.X", "delivered"));
        for (let i = 0; i < 3; i++) {
          expect((await post(body, {}, attacker)).status).toBe(403);
        }
        const limited = await post(body, {}, attacker);
        expect(limited.status).toBe(429);
        expect(limited.body).toMatchObject({
          code: "RATE_LIMITED",
          details: { limit: "whatsapp_webhook_per_ip" },
        });
        expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
        // Another address (TRUST_PROXY: the forwarded one) has its own count.
        expect((await post(body, {}, "203.0.113.8")).status).toBe(403);
        // A properly signed delivery from the limited address is limited as well.
        const signed = await post(body, { "X-Hub-Signature-256": signatureOf(body) }, attacker);
        expect(signed.status).toBe(429);
        expect(await count("inbound_webhook_event")).toBe(0);
      });
    });
  });

  // ------------------------------------------------------ what is observed

  describe("what is observed and what leaves the process", () => {
    it("counts messages by template and status, the queue depth and the webhook, on the metrics endpoint", async () => {
      const first = await queue({ dedupeKey: "event:metrics-1" });
      await waitFor("the message", async () =>
        (await message(first.id)).status === "sent" ? true : undefined,
      );
      setMode("no_whatsapp");
      const second = await queue({ dedupeKey: "event:metrics-2" });
      await waitFor("the refusal", async () =>
        (await message(second.id)).status === "failed" ? true : undefined,
      );
      setMode("ok");
      const bytes = Buffer.from(JSON.stringify({ object: "x", entry: [] }));
      const refused = await grownBy("adclub_webhook_events_total", { kind: "bad_signature" }, () =>
        post(bytes, {}),
      );

      expect(
        await metric("adclub_messages_by_template", { template: "admin_message", status: "sent" }),
      ).toBe(1);
      expect(
        await metric("adclub_messages_by_template", {
          template: "admin_message",
          status: "failed",
        }),
      ).toBe(1);
      expect(await metric("adclub_message_queue_depth", { state: "sent" })).toBe(1);
      expect(await metric("adclub_message_queue_depth", { state: "failed" })).toBe(1);
      expect(await metric("adclub_message_queue_depth", { state: "queued" })).toBe(0);
      expect(refused).toBe(1);
      // The events the worker applied show up too, sampled from what it wrote.
      const { wamid } = await (async () => {
        const { id } = await queue({ dedupeKey: "event:metrics-3" });
        const row = await waitFor("a third message", async () => {
          const found = await message(id);
          return found.status === "sent" ? found : undefined;
        });
        return { wamid: row.provider_message_id! };
      })();
      await signedPostSimple(statusPayload(wamid, "delivered"));
      await waitFor("the event to be applied", async () =>
        (await count("inbound_webhook_event", "result = 'applied'")) === 1 ? true : undefined,
      );
      expect(await metric("adclub_webhook_event_kinds", { kind: "status:delivered" })).toBe(1);

      // No label names a person: only templates, states and kinds.
      const text = (await http().get("/metrics")).text;
      for (const line of text.split("\n").filter((entry) => /message|webhook/.test(entry))) {
        expect(line).not.toMatch(/\+?7705\d{7}/);
        expect(line).not.toContain("wamid");
      }

      function statusPayload(id: string, status: string) {
        return {
          object: "whatsapp_business_account",
          entry: [
            {
              id: "1",
              changes: [
                {
                  field: "messages",
                  value: { statuses: [{ id, status, timestamp: "1700000000" }] },
                },
              ],
            },
          ],
        };
      }
      async function signedPostSimple(body: unknown) {
        const bytes = Buffer.from(JSON.stringify(body));
        return post(bytes, { "X-Hub-Signature-256": webhookSignatureHeader(bytes, APP_SECRET()) });
      }
    });

    it("keeps the number and the message out of the log and out of error monitoring, even for an unexpected failure", async () => {
      const phone = phoneOf(801);
      const name = "Секретов Иван Петрович";
      rememberCode(phone, phone.slice(1));
      rememberSecret(name);
      await configure({ message_send_attempts: 2, message_retry_delay_seconds: 1 });
      // The provider's client blows up with the very things that must not leave.
      const originals = channels.map((channel) => channel.send);
      for (const channel of channels) {
        channel.send = () =>
          Promise.reject(
            new Error(`boom for ${phone} and ${phone.slice(1)}: ${name} and ${APP_SECRET()}`),
          );
      }
      let id: string;
      try {
        ({ id } = await queue({
          dedupeKey: "event:leak-probe",
          template: "order_accepted",
          phone,
          variables: {
            number: "1042",
            customerName: name,
            customerPhone: "+7 777 000 11 22",
            link: "https://cabinet.adclub.kz/orders/1042",
          },
        }));
        await waitFor("the message to end in the dead letter queue", async () =>
          (await deadJobsOf(id)).length === 1 ? true : undefined,
        );
      } finally {
        channels.forEach((channel, index) => {
          channel.send = originals[index]!;
        });
      }
      rememberCode("+7 777 000 11 22", "+77770001122", "77770001122");
      const row = await message(id);
      expect(row.last_error).toBeTruthy();
      expect(row.last_error).not.toContain(phone);
      expect(row.last_error).not.toContain(name);
      await waitFor("monitoring to hear of the failure", async () =>
        receiver.bodies.length > 0 ? true : undefined,
      );
      await sleep(500);
      const seen = receiver.text();
      for (const secret of [
        phone,
        phone.slice(1),
        name,
        APP_SECRET(),
        "777 000 11 22",
        "77770001122",
      ]) {
        expect(seen, secret).not.toContain(secret);
      }
      const logged = appLogText(output.text());
      for (const secret of [
        phone,
        phone.slice(1),
        name,
        APP_SECRET(),
        "777 000 11 22",
        "77770001122",
      ]) {
        expect(logged, secret).not.toContain(secret);
      }
      // What is logged names the message, the template and a masked number.
      expect(logged).toContain(`message=${id}`);
    });

    it("shows the operator messages and their state without the values and without a whole number", async () => {
      const { supplierId, memberId } = await memberOf(phoneOf(811), { name: "Иван Секретов" });
      const invitationId = await invite(supplierId, memberId);
      await waitFor("the invitation", async () =>
        (await messagesOf(invitationId))[0]?.status === "sent" ? true : undefined,
      );
      setMode("no_whatsapp");
      const failed = await queue({ dedupeKey: "event:operator-1", phone: phoneOf(812) });
      await waitFor("the refusal", async () =>
        (await message(failed.id)).status === "failed" ? true : undefined,
      );
      setMode("ok");

      // The real command, in a process of its own, against this database.
      const run = async (...args: string[]) => {
        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, OPERATOR_ENTRY, ...args],
          {
            env: {
              ...process.env,
              NODE_ENV: "test",
              DATABASE_URL: postgres.getConnectionUri(),
              REDIS_URL: redisContainer.getConnectionUrl(),
              S3_ENDPOINT: "http://127.0.0.1:9",
              S3_ACCESS_KEY: "test",
              S3_SECRET_KEY: "test-secret",
              S3_BUCKET: "test",
              PORT: String(apiPort),
              MONITORING_DSN: "",
            },
            timeout: 120_000,
          },
        );
        const resultLine = stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("{") && !line.includes('"context":'))
          .pop()!;
        return { text: stdout, json: JSON.parse(resultLine) as Record<string, unknown> };
      };
      const list = await run("messages:list", "--limit", "10");
      expect(list.text).not.toContain(phoneOf(811));
      expect(list.text).not.toContain(phoneOf(812));
      expect(list.text).not.toContain("Секретов");
      expect(list.text).not.toContain("variables");
      const messages = list.json.messages as {
        template: string;
        status: string;
        phone: string;
        failureKind: string | null;
        canRetry: boolean;
      }[];
      expect(messages).toHaveLength(2);
      expect(messages.find((entry) => entry.status === "failed")).toMatchObject({
        template: "admin_message",
        failureKind: "no_whatsapp",
        // Only the mask.
        phone: expect.stringMatching(/^\+7[0-9*]*\d{4}$/),
        canRetry: true,
      });
      expect(list.json.counts).toEqual({ sent: 1, failed: 1 });
      expect((await run("messages:list", "--status", "failed")).json.messages).toHaveLength(1);

      // The retry goes through the same command.
      const retried = await run("messages:retry", failed.id);
      expect(retried.json).toEqual({ messageId: failed.id, status: "queued" });
      await waitFor("the retried message", async () =>
        (await message(failed.id)).status === "sent" ? true : undefined,
      );

      // A webhook sent by the operator command reaches this API signed, and is applied.
      const sent = await message(failed.id);
      const answer = await run(
        "dev:messages:webhook",
        "--message",
        failed.id,
        "--status",
        "delivered",
        "--twice",
      );
      expect((answer.json.deliveries as { status: number }[]).map((entry) => entry.status)).toEqual(
        [200, 200],
      );
      await waitFor("the delivery to be applied", async () =>
        (await message(sent.id)).status === "delivered" ? true : undefined,
      );
      expect(await count("inbound_webhook_event")).toBe(1);
      const foreign = await run("dev:messages:webhook", "--message", failed.id, "--bad-signature");
      expect((foreign.json.deliveries as { status: number }[])[0]!.status).toBe(403);
      expect(await count("inbound_webhook_event")).toBe(1);
      const webhooks = await run("messages:webhooks");
      expect((webhooks.json.events as unknown[]).length).toBe(1);
    });
  });
});
