import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  apiErrorResponseSchema,
  loginCodeSentResponseSchema,
  type RateLimitName,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../../app.module";
import { JsonLoggerService } from "../../../common/logging";
import { loadConfig, type AppConfig, type LoginCodeSettings } from "../../../config";
import { runMigrate } from "../../../database/migrate-cli";
import { configureHttpApp } from "../../../http-app";
import { TcpProxy } from "../../../testing/tcp-proxy";
import { LoginCodeChannels } from "./channels/login-code-channels";
import { TestLoginCodeChannels } from "./channels/test-login-code-channels";
import { LoginCodeStore } from "./login-code.store";

/**
 * TASK-004 end to end over HTTP, on a real PostgreSQL (migrations applied)
 * and a real Redis. Redis sits behind a TCP proxy the tests can stop and
 * start, to simulate an outage without changing its address.
 */

const PHONE = "+77011234567";
const MASKED = "+7***4567";
const OTHER_PHONE = "+77471112233";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("login codes over HTTP (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redisProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let defaults: LoginCodeSettings;
  let app: INestApplication;
  let channels: TestLoginCodeChannels;
  /** Everything the app logged, and every code it sent, during the whole suite. */
  const allLogs: string[] = [];
  const allCodes = new Set<string>();
  let logs: string[] = [];

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    redis = new Redis(redisContainer.getConnectionUrl());
    redisProxy = new TcpProxy(redisContainer.getHost(), redisContainer.getPort());
    await redisProxy.start();

    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: `redis://127.0.0.1:${redisProxy.port}`,
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
    });
    defaults = structuredClone(config.loginCode.settings);

    const nestApp = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nestApp.useLogger(nestApp.get(JsonLoggerService));
    // `listen()` would flush buffered logs; these tests only `init()`.
    nestApp.flushLogs();
    configureHttpApp(nestApp, config);
    await nestApp.init();
    app = nestApp;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    await waitForRedis();
  });

  afterAll(async () => {
    await app?.close();
    await redisProxy?.stop();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    Object.assign(config.loginCode.settings, structuredClone(defaults));
    config.clientPolicy.minSupportedVersions.ios = "0.0.0";
    channels.failing.clear();
    channels.sent.length = 0;
    await db.query("TRUNCATE session, otp_challenge, phone_verification, account");
    await redis.flushall();
    logs = [];
    const capture = (chunk: unknown) => {
      logs.push(String(chunk));
      allLogs.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const sent of channels.sent) {
      allCodes.add(sent.code);
    }
  });

  const settings = () => config.loginCode.settings;

  function requestCode(body: unknown, ip = "198.51.100.10"): Promise<Response> {
    return request(app.getHttpServer())
      .post("/auth/login-code")
      .set("X-Forwarded-For", ip)
      .send(body as object);
  }

  function verifyCode(body: unknown): Promise<Response> {
    return request(app.getHttpServer())
      .post("/auth/login-code/verify")
      .send(body as object);
  }

  function lastCode(phone = PHONE): string {
    const message = channels.sent.filter((sent) => sent.phone === phone).at(-1);
    if (!message) {
      throw new Error(`no code was sent to ${phone}`);
    }
    return message.code;
  }

  function wrongCode(phone = PHONE): string {
    return lastCode(phone) === "000000" ? "111111" : "000000";
  }

  async function challengeStatuses(phone = PHONE): Promise<string[]> {
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM otp_challenge WHERE phone = $1 ORDER BY created_at",
      [phone],
    );
    return rows.map((row) => row.status);
  }

  function expectRateLimited(response: Response, limit: RateLimitName): void {
    expect(response.status).toBe(429);
    expect(apiErrorResponseSchema.parse(response.body)).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      details: { limit, retryAfterSeconds: expect.any(Number) },
    });
    expect(response.body.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.headers["retry-after"]).toBe(String(response.body.details.retryAfterSeconds));
  }

  async function waitForRedis(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await requestCode({ phone: "+77000000000" }, "192.0.2.250");
      if (response.status !== 503) {
        await redis.flushall();
        return;
      }
      await sleep(250);
    }
    throw new Error("the API never reached Redis");
  }

  describe("ordinary sign-in", () => {
    it("sends a code for one spelling of a number and accepts it for another, once", async () => {
      const sent = await requestCode({ phone: "8 (701) 123-45-67" });
      expect(sent.status).toBe(200);
      const body = loginCodeSentResponseSchema.parse(sent.body);
      expect(body).toMatchObject({ phone: PHONE, channel: "whatsapp", codeLength: 6 });
      const expiresInSeconds = (Date.parse(body.expiresAt) - Date.now()) / 1000;
      expect(expiresInSeconds).toBeGreaterThan(290);
      expect(expiresInSeconds).toBeLessThanOrEqual(300);
      expect(JSON.stringify(sent.body)).not.toContain(lastCode());

      // The development way to see the code.
      const outbox = await request(app.getHttpServer()).get("/dev/login-codes");
      expect(outbox.status).toBe(200);
      expect(outbox.body.messages[0]).toMatchObject({
        phone: PHONE,
        channel: "whatsapp",
        code: lastCode(),
      });

      const verified = await verifyCode({ phone: "+7701 1234567", code: lastCode() });
      expect(verified.status).toBe(200);
      // The fields TASK-004 defined are unchanged; the session came with TASK-005.
      expect(verified.body).toMatchObject({ status: "verified", phone: PHONE });
      expect(verified.body.session.kind).toBe("mobile");

      const again = await verifyCode({ phone: PHONE, code: lastCode() });
      expect(again.status).toBe(400);
      expect(again.body).toMatchObject({ code: "LOGIN_CODE_EXPIRED", retryable: false });
      expect(await challengeStatuses()).toEqual(["consumed"]);
    });

    it("remembers the channel the confirmed code came through", async () => {
      settings().resendIntervalSeconds = 1;
      await requestCode({ phone: PHONE, channel: "sms" });
      await verifyCode({ phone: PHONE, code: lastCode() });
      const { rows } = await db.query("SELECT phone, channel FROM phone_verification");
      expect(rows).toEqual([{ phone: PHONE, channel: "sms" }]);

      // A later confirmation through WhatsApp replaces it.
      await sleep(1100);
      expect((await requestCode({ phone: PHONE })).body.channel).toBe("whatsapp");
      await verifyCode({ phone: PHONE, code: lastCode() });
      const after = await db.query("SELECT channel FROM phone_verification WHERE phone = $1", [
        PHONE,
      ]);
      expect(after.rows).toEqual([{ channel: "whatsapp" }]);
    });

    it("answers the same way whether or not an account exists for the number", async () => {
      await db.query("INSERT INTO account (phone) VALUES ($1)", [PHONE]);
      const existing = await requestCode({ phone: PHONE });
      const unknown = await requestCode({ phone: OTHER_PHONE }, "198.51.100.11");
      expect(existing.status).toBe(unknown.status);
      const shape = (body: Record<string, unknown>) => ({
        ...body,
        phone: "<phone>",
        expiresAt: "<time>",
        resendAvailableAt: "<time>",
      });
      expect(shape(existing.body)).toEqual(shape(unknown.body));
      expect(Object.keys(existing.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
    });

    it("lets a person through who mistypes twice and asks for a resend", async () => {
      settings().resendIntervalSeconds = 1;
      await requestCode({ phone: PHONE });
      for (const attemptsRemaining of [4, 3]) {
        const wrong = await verifyCode({ phone: PHONE, code: wrongCode() });
        expect(wrong.status).toBe(400);
        expect(wrong.body).toMatchObject({
          code: "LOGIN_CODE_INVALID",
          details: { attemptsRemaining },
        });
      }
      await sleep(1100);
      expect((await requestCode({ phone: PHONE, channel: "sms" })).status).toBe(200);
      const verified = await verifyCode({ phone: PHONE, code: lastCode() });
      expect(verified.status).toBe(200);
    });
  });

  describe("validation", () => {
    it.each([
      ["a Russian number", { phone: "+7 916 123 45 67" }],
      ["an Almaty landline", { phone: "+7 727 212 34 56" }],
      ["another country", { phone: "+998 90 123 45 67" }],
      ["letters", { phone: "call me maybe" }],
      ["an empty string", { phone: "" }],
      ["a very long string", { phone: "7".repeat(10_000) }],
      ["a number instead of a string", { phone: 77011234567 }],
      ["no phone", {}],
      ["an unknown channel", { phone: PHONE, channel: "telegram" }],
    ])("rejects %s without sending anything", async (_label, body) => {
      const response = await requestCode(body);
      expect(response.status).toBe(400);
      expect(apiErrorResponseSchema.parse(response.body).code).toBe("VALIDATION_ERROR");
      expect(channels.sent).toHaveLength(0);
    });

    it.each([
      ["letters", "12ab56"],
      ["an empty code", ""],
      ["a very long code", "1".repeat(5000)],
      ["a number instead of a string", 123456],
    ])("rejects a code with %s", async (_label, code) => {
      const response = await verifyCode({ phone: PHONE, code });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("rejects malformed JSON without a server error", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login-code")
        .set("Content-Type", "application/json")
        .send('{"phone": ');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an outdated client like any ordinary route", async () => {
      config.clientPolicy.minSupportedVersions.ios = "2.0.0";
      const response = await request(app.getHttpServer())
        .post("/auth/login-code")
        .set("X-Client", "mobile/1.0.0 (ios)")
        .send({ phone: PHONE });
      expect(response.status).toBe(426);
      expect(response.body.code).toBe("CLIENT_UPDATE_REQUIRED");
      expect(channels.sent).toHaveLength(0);
    });
  });

  describe("which code is accepted", () => {
    it("does not accept a code for another number", async () => {
      await requestCode({ phone: PHONE });
      await requestCode({ phone: OTHER_PHONE });
      const foreignCode = lastCode(PHONE);
      const response = await verifyCode({ phone: OTHER_PHONE, code: foreignCode });
      if (foreignCode === lastCode(OTHER_PHONE)) {
        // One-in-a-million coincidence: both numbers got the same code.
        expect(response.status).toBe(200);
        return;
      }
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("LOGIN_CODE_INVALID");
    });

    it("does not accept anything for a number that has no code", async () => {
      const response = await verifyCode({ phone: PHONE, code: "123456" });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("LOGIN_CODE_EXPIRED");
    });

    it("accepts only the latest code once a new one is sent", async () => {
      settings().resendIntervalSeconds = 1;
      await requestCode({ phone: PHONE });
      const first = lastCode();
      await sleep(1100);
      await requestCode({ phone: PHONE, channel: "sms" });
      const second = lastCode();
      expect(await challengeStatuses()).toEqual(["superseded", "active"]);

      if (first !== second) {
        const old = await verifyCode({ phone: PHONE, code: first });
        expect(old.body.code).toBe("LOGIN_CODE_INVALID");
      }
      expect((await verifyCode({ phone: PHONE, code: second })).status).toBe(200);
    });

    it("does not accept an expired code, even the right one", async () => {
      settings().ttlSeconds = 1;
      await requestCode({ phone: PHONE });
      await sleep(1200);
      const response = await verifyCode({ phone: PHONE, code: lastCode() });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("LOGIN_CODE_EXPIRED");
      expect(await challengeStatuses()).toEqual(["expired"]);
    });

    it("invalidates a code after the last allowed wrong entry; a new code works", async () => {
      settings().verifyFreeFailures = 10;
      settings().resendIntervalSeconds = 1;
      await requestCode({ phone: PHONE });
      const remaining: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await verifyCode({ phone: PHONE, code: wrongCode() });
        expect(response.body.code).toBe("LOGIN_CODE_INVALID");
        remaining.push(response.body.details.attemptsRemaining);
      }
      expect(remaining).toEqual([4, 3, 2, 1, 0]);

      const right = await verifyCode({ phone: PHONE, code: lastCode() });
      expect(right.status).toBe(400);
      expect(right.body.code).toBe("LOGIN_CODE_EXPIRED");
      expect(await challengeStatuses()).toEqual(["exhausted"]);

      await sleep(1100);
      expect((await requestCode({ phone: PHONE })).status).toBe(200);
      expect((await verifyCode({ phone: PHONE, code: lastCode() })).status).toBe(200);
    });

    it("slows down entries after repeated mistakes without spending attempts", async () => {
      settings().verifyDelayBaseSeconds = 1;
      await requestCode({ phone: PHONE });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await verifyCode({ phone: PHONE, code: wrongCode() })).status).toBe(400);
      }
      // Third mistake → wait 1 s, even with the right code.
      const tooEarly = await verifyCode({ phone: PHONE, code: lastCode() });
      expectRateLimited(tooEarly, "login_code_verify_delay");
      const { rows } = await db.query("SELECT attempts FROM otp_challenge WHERE phone = $1", [
        PHONE,
      ]);
      expect(rows).toEqual([{ attempts: 3 }]);

      await sleep(1100);
      expect((await verifyCode({ phone: PHONE, code: lastCode() })).status).toBe(200);
    });
  });

  describe("concurrency", () => {
    it("accepts the right code exactly once when it's entered concurrently", async () => {
      await requestCode({ phone: PHONE });
      const code = lastCode();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => verifyCode({ phone: PHONE, code })),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      for (const response of responses.filter((response) => response.status !== 200)) {
        expect(response.body.code).toBe("LOGIN_CODE_EXPIRED");
      }
      const { rows } = await db.query("SELECT count(*)::int AS n FROM phone_verification");
      expect(rows).toEqual([{ n: 1 }]);
    });

    it("leaves one code for simultaneous requests and counts both", async () => {
      const responses = await Promise.all([
        requestCode({ phone: PHONE }),
        requestCode({ phone: "8 701 123 45 67" }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
      expectRateLimited(
        responses.find((response) => response.status === 429)!,
        "login_code_resend_interval",
      );
      expect(await challengeStatuses()).toEqual(["active"]);
      expect(await redis.get(`rl:login-code:requests:phone:${PHONE}`)).toBe("2");
    });

    it("keeps exactly one active code when deliveries finish concurrently", async () => {
      const store = app.get(LoginCodeStore);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
      for (const id of ids) {
        await store.createPending({ id, phone: PHONE, codeHash: "00", maxAttempts: 5, expiresAt });
      }
      await Promise.all(ids.map((id) => store.activate(id, PHONE, "whatsapp", now, expiresAt)));
      const statuses = await challengeStatuses();
      expect(statuses.filter((status) => status === "active")).toHaveLength(1);
      expect(statuses.filter((status) => status === "superseded")).toHaveLength(5);
    });
  });

  describe("channels", () => {
    it("falls back to SMS when WhatsApp can't deliver, and logs it safely", async () => {
      channels.failing.add("whatsapp");
      const response = await requestCode({ phone: "87011234567" });
      expect(response.status).toBe(200);
      expect(response.body.channel).toBe("sms");
      expect(channels.sent.map((sent) => sent.channel)).toEqual(["sms"]);

      const output = logs.join("");
      expect(output).toContain(
        `Login code delivery failed phone=${MASKED} channel=whatsapp reason=test_channel_configured_to_fail`,
      );
      expect(output).toContain(`Login code falling back to sms phone=${MASKED}`);
      expect(output).toContain(`Login code delivered phone=${MASKED} channel=sms`);
      expect(output).not.toContain(lastCode());

      expect((await verifyCode({ phone: PHONE, code: lastCode() })).status).toBe(200);
      const { rows } = await db.query("SELECT channel FROM phone_verification");
      expect(rows).toEqual([{ channel: "sms" }]);
    });

    it("sends by SMS right away when the person chooses SMS", async () => {
      const response = await requestCode({ phone: PHONE, channel: "sms" });
      expect(response.body.channel).toBe("sms");
      expect(channels.sent.map((sent) => sent.channel)).toEqual(["sms"]);
    });

    it("refuses an SMS resend before the interval and allows it after", async () => {
      settings().resendIntervalSeconds = 2;
      const first = await requestCode({ phone: PHONE });
      expect(Date.parse(first.body.resendAvailableAt) - Date.now()).toBeGreaterThan(1000);

      const early = await requestCode({ phone: PHONE, channel: "sms" });
      expectRateLimited(early, "login_code_resend_interval");
      expect(early.body.details.retryAfterSeconds).toBeLessThanOrEqual(2);
      expect(channels.sent).toHaveLength(1);
      expect(await challengeStatuses()).toEqual(["active"]);

      await sleep(2100);
      const late = await requestCode({ phone: PHONE, channel: "sms" });
      expect(late.status).toBe(200);
      expect(late.body.channel).toBe("sms");
    });

    it("reports a retryable failure when no channel delivers, without blocking the person", async () => {
      channels.failing.add("whatsapp");
      channels.failing.add("sms");
      const failed = await requestCode({ phone: PHONE });
      expect(failed.status).toBe(503);
      expect(apiErrorResponseSchema.parse(failed.body)).toMatchObject({
        code: "LOGIN_CODE_DELIVERY_FAILED",
        retryable: true,
      });
      expect(await challengeStatuses()).toEqual(["failed"]);

      // Right away, no resend wait, and the failed attempt isn't counted.
      channels.failing.clear();
      const retried = await requestCode({ phone: PHONE });
      expect(retried.status).toBe(200);
      expect(await redis.get(`rl:login-code:requests:phone:${PHONE}`)).toBe("1");
      expect(await challengeStatuses()).toEqual(["failed", "active"]);
    });
  });

  describe("rate limits", () => {
    it("limits code requests per number, until the window passes", async () => {
      Object.assign(settings(), {
        resendIntervalSeconds: 1,
        requestsPerPhone: { max: 2, windowSeconds: 3 },
      });
      expect((await requestCode({ phone: PHONE })).status).toBe(200);
      await sleep(1100);
      expect((await requestCode({ phone: PHONE }, "198.51.100.20")).status).toBe(200);
      await sleep(1100);
      const limited = await requestCode({ phone: PHONE }, "198.51.100.21");
      expectRateLimited(limited, "login_code_requests_per_phone");
      expect(channels.sent).toHaveLength(2);

      await sleep(limited.body.details.retryAfterSeconds * 1000 + 100);
      expect((await requestCode({ phone: PHONE }, "198.51.100.22")).status).toBe(200);
    });

    it("limits code requests per IP address", async () => {
      settings().requestsPerIp = { max: 2, windowSeconds: 3600 };
      expect((await requestCode({ phone: "+77010000001" }, "203.0.113.5")).status).toBe(200);
      expect((await requestCode({ phone: "+77010000002" }, "203.0.113.5")).status).toBe(200);
      expectRateLimited(
        await requestCode({ phone: "+77010000003" }, "203.0.113.5"),
        "login_code_requests_per_ip",
      );
      expect((await requestCode({ phone: "+77010000003" }, "203.0.113.6")).status).toBe(200);
    });

    it("treats one IPv6 /64 network as one address", async () => {
      settings().requestsPerIp = { max: 1, windowSeconds: 3600 };
      expect((await requestCode({ phone: "+77010000001" }, "2001:db8:1:2::10")).status).toBe(200);
      expectRateLimited(
        await requestCode({ phone: "+77010000002" }, "2001:db8:1:2::11"),
        "login_code_requests_per_ip",
      );
    });

    it("limits SMS per number per day, but not WhatsApp", async () => {
      Object.assign(settings(), {
        resendIntervalSeconds: 1,
        smsPerPhoneDaily: { max: 1, windowSeconds: 86_400 },
      });
      expect((await requestCode({ phone: PHONE, channel: "sms" })).status).toBe(200);
      await sleep(1100);
      const limited = await requestCode({ phone: PHONE, channel: "sms" });
      expectRateLimited(limited, "login_code_sms_per_phone_daily");
      expect(limited.body.details.retryAfterSeconds).toBeGreaterThan(86_000);

      // The rejected SMS didn't start a resend wait; WhatsApp still works.
      const whatsapp = await requestCode({ phone: PHONE });
      expect(whatsapp.status).toBe(200);
      expect(whatsapp.body.channel).toBe("whatsapp");
    });

    it("applies the daily SMS limit to the WhatsApp fallback too", async () => {
      settings().smsPerPhoneDaily = { max: 1, windowSeconds: 86_400 };
      settings().resendIntervalSeconds = 1;
      channels.failing.add("whatsapp");
      expect((await requestCode({ phone: PHONE })).body.channel).toBe("sms");
      await sleep(1100);
      expectRateLimited(await requestCode({ phone: PHONE }), "login_code_sms_per_phone_daily");
      expect(await challengeStatuses()).toEqual(["active", "failed"]);
    });

    it("limits SMS per IP address per day", async () => {
      settings().smsPerIpDaily = { max: 1, windowSeconds: 86_400 };
      expect((await requestCode({ phone: PHONE, channel: "sms" }, "203.0.113.9")).status).toBe(200);
      expectRateLimited(
        await requestCode({ phone: OTHER_PHONE, channel: "sms" }, "203.0.113.9"),
        "login_code_sms_per_ip_daily",
      );
    });

    it("limits code checks per number, so new codes don't allow endless guessing", async () => {
      settings().verificationsPerPhone = { max: 3, windowSeconds: 3600 };
      await requestCode({ phone: PHONE });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await verifyCode({ phone: PHONE, code: wrongCode() })).status).toBe(400);
      }
      expect((await verifyCode({ phone: "8 701 123 45 67", code: wrongCode() })).status).toBe(400);
      expectRateLimited(
        await verifyCode({ phone: PHONE, code: lastCode() }),
        "login_code_verifications_per_phone",
      );
    });

    it("does not block the usual flow with the default limits", async () => {
      expect(settings()).toEqual(defaults);
      expect((await requestCode({ phone: PHONE })).status).toBe(200);
      expect((await verifyCode({ phone: PHONE, code: wrongCode() })).status).toBe(400);
      expect((await verifyCode({ phone: PHONE, code: wrongCode() })).status).toBe(400);
      expect((await verifyCode({ phone: PHONE, code: lastCode() })).status).toBe(200);
    });
  });

  describe("Redis outage", () => {
    it("refuses codes while Redis is down and recovers without a restart", async () => {
      await redisProxy.stop();
      try {
        const refused = await requestCode({ phone: PHONE });
        expect(refused.status).toBe(503);
        expect(apiErrorResponseSchema.parse(refused.body)).toMatchObject({
          code: "SERVICE_UNAVAILABLE",
          retryable: true,
        });
        expect(channels.sent).toHaveLength(0);

        const verify = await verifyCode({ phone: PHONE, code: "123456" });
        expect(verify.status).toBe(503);
        expect(verify.body.code).toBe("SERVICE_UNAVAILABLE");

        expect((await request(app.getHttpServer()).get("/health")).status).toBe(200);
        const ready = await request(app.getHttpServer()).get("/ready");
        expect(ready.status).toBe(503);
        expect(ready.body.checks.redis.status).toBe("error");
      } finally {
        await redisProxy.start();
      }
      await waitForRedis();
      expect((await requestCode({ phone: PHONE })).status).toBe(200);
    }, 60_000);
  });

  describe("logs", () => {
    it("record every step with a masked number and never the code", async () => {
      settings().verifyFreeFailures = 0;
      settings().verifyDelayBaseSeconds = 1;
      channels.failing.add("whatsapp");
      await requestCode({ phone: "8 701 123 45 67" });
      await verifyCode({ phone: PHONE, code: wrongCode() });
      expectRateLimited(
        await verifyCode({ phone: PHONE, code: lastCode() }),
        "login_code_verify_delay",
      );
      await sleep(1100);
      await verifyCode({ phone: PHONE, code: lastCode() });

      const output = logs.join("");
      for (const event of [
        `Login code requested phone=${MASKED} channel=auto`,
        `Login code delivery failed phone=${MASKED} channel=whatsapp`,
        `Login code falling back to sms phone=${MASKED}`,
        `Login code delivered phone=${MASKED} channel=sms`,
        `Login code verification failed phone=${MASKED} reason=wrong_code attemptsRemaining=4`,
        `Login code rate limit hit limit=login_code_verify_delay phone=${MASKED}`,
        `Login code verified phone=${MASKED} channel=sms`,
      ]) {
        expect(output).toContain(event);
      }
    });

    it("never contained a code or a full phone number during this whole suite", () => {
      // Only what the app wrote (`message`, `stack`), not the random request
      // ids, which can contain any run of digits.
      const output = allLogs
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => {
          const entry = JSON.parse(line) as { message?: string; stack?: string };
          return `${entry.message ?? ""} ${entry.stack ?? ""}`;
        })
        .join("\n");
      expect(output).toContain("Login code requested");
      expect(allCodes.size).toBeGreaterThan(20);
      for (const code of allCodes) {
        expect(output).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
      }
      for (const digits of ["77011234567", "87011234567", "7011234567", "77471112233"]) {
        expect(output).not.toContain(digits);
      }
      expect(output).not.toMatch(/701\D?123\D?45\D?67/);
    });
  });
});
