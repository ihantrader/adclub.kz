import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { apiErrorResponseSchema, loginCodeVerifiedResponseSchema } from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { JsonLoggerService } from "../common/logging";
import { loadConfig, type AppConfig } from "../config";
import { runMigrate } from "../database/migrate-cli";
import { configureHttpApp } from "../http-app";
import { LoginCodeChannels, SessionService, type TestLoginCodeChannels } from "../modules/identity";
import { captureOutput, rememberCode, rememberSecret } from "../testing/output-capture";
import { ErrorReporter } from "./error-reporter.service";

/**
 * TASK-009 end to end: what leaves the process. Real scenarios of the real
 * application (a sign-in with a phone number, a code, tokens and request
 * bodies, then a failure inside a handler) with error monitoring pointed at
 * a receiver the test owns — and not one personal field in what it
 * receives. Also: a failure of the sanitizer itself sends nothing, a
 * receiver that is down or gone changes nothing for the caller, monitoring
 * switched off leaves the application exactly as it was, and the metrics
 * endpoint answers with the set ARCHITECTURE 15.3 asks for.
 */

const PHONE = "+77011234567";
const MASK = "+7***4567";
const MOBILE = "mobile/1.4.2 (ios)";
const METRICS_TOKEN = "metrics-collector-token-1234567890";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(25);
  }
}

/** Stands in for the error monitoring service: keeps every envelope it is sent. */
class TestReceiver {
  readonly bodies: string[] = [];
  private server: Server | undefined;
  port = 0;
  /** Answers only after this long (a slow receiver). */
  delayMs = 0;

  /** Comes back on the same port, so the configured DSN keeps pointing at it. */
  async start(): Promise<void> {
    this.server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        this.bodies.push(Buffer.concat(chunks).toString("utf8"));
        const answer = () => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
        };
        if (this.delayMs > 0) {
          setTimeout(answer, this.delayMs);
        } else {
          answer();
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  text(): string {
    return this.bodies.join("\n");
  }
}

describe("observability: what leaves the process (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let redisClient: Redis;
  let receiver: TestReceiver;
  let app: INestApplication;
  /** A second application with no receiver configured at all. */
  let silent: INestApplication;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;

  async function boot(monitoring: boolean): Promise<INestApplication> {
    const env: Record<string, string> = {
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
      METRICS_TOKEN,
    };
    if (monitoring) {
      env.MONITORING_DSN = `http://publickey@127.0.0.1:${receiver.port}/7`;
      env.MONITORING_ENVIRONMENT = "integration";
    }
    const config: AppConfig = loadConfig(env);
    const nest = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    redisClient = new Redis(redis.getConnectionUrl());
    receiver = new TestReceiver();
    await receiver.start();
    app = await boot(true);
    silent = await boot(false);
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
  }, 180_000);

  afterAll(async () => {
    redisClient?.disconnect();
    await silent?.close();
    await app?.close();
    await receiver?.stop();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    receiver.bodies.length = 0;
    receiver.delayMs = 0;
    // Every test signs in again: the limits of the previous one are gone.
    await redisClient.flushall();
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  const http = (target: INestApplication = app) => request(target.getHttpServer());
  const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  /** A real sign-in: a phone number, a code, tokens and bodies all pass through the app. */
  async function signIn(target: INestApplication = app): Promise<string> {
    const sent = await http(target)
      .post("/auth/login-code")
      .set("X-Client", MOBILE)
      .set("X-Forwarded-For", nextIp())
      .send({ phone: PHONE });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const channelsOf = target.get(LoginCodeChannels) as TestLoginCodeChannels;
    const code = channelsOf.sent.at(-1)!.code;
    rememberCode(code);
    const verified = await http(target)
      .post("/auth/login-code/verify")
      .set("X-Client", MOBILE)
      .set("X-Forwarded-For", nextIp())
      .send({ phone: PHONE, code });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    const body = loginCodeVerifiedResponseSchema.parse(verified.body);
    rememberSecret(body.session.accessToken, body.session.refreshToken ?? undefined);
    return body.session.accessToken;
  }

  /**
   * Makes the next `GET /auth/me` of `target` fail the way an unexpected
   * bug does, with personal data all over the failure: the phone number in
   * the message, a login code, a token and a request body in the cause.
   */
  function breakCurrentAccount(target: INestApplication, code: string): () => void {
    const sessions = target.get(SessionService);
    const original = sessions.getCurrent.bind(sessions);
    sessions.getCurrent = () => {
      const cause = Object.assign(new Error(`while handling body for ${PHONE}`), {
        body: { phone: PHONE, code, note: "Айгерим Касымова, ул. Абая 10" },
        params: [PHONE, code],
      });
      return Promise.reject(
        new Error(
          `Unexpected failure for ${PHONE} (code=${code}, mail aigerim@example.kz, ip 203.0.113.42)`,
          { cause },
        ),
      );
    };
    return () => {
      sessions.getCurrent = original;
    };
  }

  function expectNoPersonalData(text: string, code: string, accessToken: string): void {
    expect(text).not.toContain("77011234567");
    expect(text).not.toContain("7011234567");
    expect(text).not.toContain(code);
    expect(text).not.toContain(accessToken);
    expect(text).not.toContain("Айгерим");
    expect(text).not.toContain("Абая");
    expect(text).not.toContain("aigerim@example.kz");
    expect(text).not.toContain("203.0.113.42");
  }

  it("sends an unexpected failure to the receiver with nothing personal in it", async () => {
    const accessToken = await signIn();
    const code = channels.sent.at(-1)!.code;
    const restore = breakCurrentAccount(app, code);

    const failed = await http()
      .get("/auth/me?phone=%2B77011234567")
      .set("X-Client", MOBILE)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Forwarded-For", "203.0.113.42");
    restore();

    expect(failed.status).toBe(500);
    expect(apiErrorResponseSchema.parse(failed.body).code).toBe("INTERNAL_ERROR");
    await waitFor(() => receiver.bodies.length > 0, "the event to reach the receiver");

    const received = receiver.text();
    expectNoPersonalData(received, code, accessToken);
    // What is left is what an investigation needs.
    expect(received).toContain("Unexpected failure for");
    expect(received).toContain(MASK);
    expect(received).toContain('"environment":"integration"');
    expect(received).toContain('"transaction":"GET /auth/me"');
    expect(received).toContain('"kind":"api"');
    expect(received).toContain('"status":"500"');
    expect(received).toContain("request_id");

    // And the same holds for the application log of the whole scenario.
    expectNoPersonalData(output.text(), code, accessToken);
  });

  it("never sends an expected 4xx of business logic", async () => {
    await http()
      .post("/auth/login-code")
      .set("X-Client", MOBILE)
      .set("X-Forwarded-For", nextIp())
      .send({ phone: PHONE });
    const wrong = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", MOBILE)
      .set("X-Forwarded-For", nextIp())
      .send({ phone: PHONE, code: "000000" });
    expect(wrong.status).toBe(400);
    const missing = await http().get("/nothing-here").set("X-Client", MOBILE);
    expect(missing.status).toBe(404);

    await sleep(300);
    expect(receiver.bodies).toHaveLength(0);
  });

  it("sends nothing at all when the sanitizer itself fails, and keeps serving", async () => {
    const before = await metricValue("adclub_sanitizer_failures_total");
    const exploding = {
      get boom(): string {
        throw new Error("property access failed");
      },
    };

    app.get(ErrorReporter).captureException(exploding, { transaction: "test" });

    await sleep(300);
    expect(receiver.bodies).toHaveLength(0);
    expect(await metricValue("adclub_sanitizer_failures_total")).toBe(before + 1);
    const health = await http().get("/health").set("X-Client", MOBILE);
    expect(health.status).toBe(200);
  });

  it("keeps serving when the receiver is slow, and when it is gone altogether", async () => {
    const accessToken = await signIn();
    const code = channels.sent.at(-1)!.code;

    receiver.delayMs = 5000;
    const restore = breakCurrentAccount(app, code);
    const startedAt = Date.now();
    const slow = await http()
      .get("/auth/me")
      .set("X-Client", MOBILE)
      .set("Authorization", `Bearer ${accessToken}`);
    restore();
    expect(slow.status).toBe(500);
    // The request didn't wait for the receiver.
    expect(Date.now() - startedAt).toBeLessThan(3000);
    receiver.delayMs = 0;

    await receiver.stop();
    const restoreAgain = breakCurrentAccount(app, code);
    const afterOutage = await http()
      .get("/auth/me")
      .set("X-Client", MOBILE)
      .set("Authorization", `Bearer ${accessToken}`);
    restoreAgain();
    expect(afterOutage.status).toBe(500);
    // Ordinary requests are served as before, and the process is alive.
    const health = await http().get("/health").set("X-Client", MOBILE);
    expect(health.status).toBe(200);
    const me = await http()
      .get("/auth/me")
      .set("X-Client", MOBILE)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(await metricValue("adclub_monitoring_events_total", 'outcome="failed"')).toBeGreaterThan(
      0,
    );

    await receiver.start();
  });

  it("behaves exactly as before when no receiver is configured", async () => {
    const accessToken = await signIn(silent);
    const channelsOf = silent.get(LoginCodeChannels) as TestLoginCodeChannels;
    const code = channelsOf.sent.at(-1)!.code;
    const restore = breakCurrentAccount(silent, code);

    const failed = await http(silent)
      .get("/auth/me")
      .set("X-Client", MOBILE)
      .set("Authorization", `Bearer ${accessToken}`);
    restore();

    expect(failed.status).toBe(500);
    expect(apiErrorResponseSchema.parse(failed.body)).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      retryable: true,
    });
    const ok = await http(silent)
      .get("/auth/me")
      .set("X-Client", MOBILE)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(ok.status).toBe(200);
    await sleep(300);
    expect(receiver.bodies).toHaveLength(0);
  });

  it("serves the metrics of requirement 4, without personal data, and only with the token", async () => {
    const accessToken = await signIn();
    const code = channels.sent.at(-1)!.code;
    // A refused limit to count (one code per resend interval for a number).
    await http()
      .post("/auth/login-code")
      .set("X-Client", MOBILE)
      .set("X-Forwarded-For", nextIp())
      .send({ phone: PHONE });
    await http().get("/ready").set("X-Client", MOBILE);

    const unauthorized = await http().get("/metrics");
    expect(unauthorized.status).toBe(401);

    const metrics = await scrape();
    // API latency and response codes by route.
    expect(metrics).toContain("adclub_http_request_duration_seconds_bucket");
    expect(metrics).toMatch(/adclub_http_responses_total\{.*route="\/auth\/login-code".*\} \d+/);
    // Sign-in limits and code delivery by channel.
    expect(metrics).toContain('adclub_login_code_rate_limit_hits_total{limit="login_code_resend');
    expect(metrics).toContain(
      'adclub_login_code_deliveries_total{channel="whatsapp",outcome="sent"',
    );
    // The background queue and the dependencies behind /ready.
    expect(metrics).toContain("adclub_job_queue_depth{");
    expect(metrics).toContain('adclub_dependency_up{dependency="postgres"} 1');
    expect(metrics).toContain('adclub_dependency_up{dependency="redis"} 1');
    // Nothing personal: no numbers, codes or tokens anywhere in the body.
    expectNoPersonalData(metrics, code, accessToken);
  });

  it("writes the access log without the query string of a request (TASK-009)", async () => {
    const response = await http()
      .get("/meta/client-policy?phone=%2B77011234567&secret=abc")
      .set("X-Client", MOBILE);
    expect(response.status).toBe(200);

    await waitFor(
      () => output.text().includes("GET /meta/client-policy 200"),
      "the access log line",
    );
    const text = output.text();
    expect(text).not.toContain("77011234567");
    expect(text).not.toContain("phone=");
    expect(text).not.toContain("secret=abc");
  });

  async function scrape(): Promise<string> {
    const response = await http().get("/metrics").set("Authorization", `Bearer ${METRICS_TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    return response.text;
  }

  /** One counter value from the scrape (0 when it isn't there yet). */
  async function metricValue(name: string, labels = ""): Promise<number> {
    const body = await scrape();
    const line = body
      .split("\n")
      .find((row) => row.startsWith(name) && (labels === "" || row.includes(labels)));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
  }
});
