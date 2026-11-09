import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { JsonLoggerService } from "../common/logging";
import { loadConfig } from "../config";
import { runMigrate } from "../database/migrate-cli";
import { configureHttpApp } from "../http-app";
import { TestSettings } from "../testing/settings";

/**
 * `TRUST_PROXY` on a deployed environment (TASK-055; ARCHITECTURE 4.5,
 * 4.82): exactly one trusted hop — the reverse proxy, by its address. The
 * client address every per-IP limit counts by is taken from
 * `X-Forwarded-For` only when the request comes from that proxy; a forged
 * header sent to the API by anybody else changes nothing.
 *
 * Two API processes over one database and Redis, as staging would run
 * them: one that trusts the address these requests come from (the requests
 * play the proxy), one that trusts only another address (the requests
 * play a client that reached the API around the proxy). The limit is
 * `compatibility_check_per_ip` at 1 — a second request from the same
 * client address is refused with 429.
 */

const MOBILE = "mobile/1.0.0 (ios)";

describe("TRUST_PROXY: one trusted hop (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let behindProxy: INestApplication;
  let aroundProxy: INestApplication;

  async function start(trustProxy: string): Promise<INestApplication> {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: trustProxy,
    });
    const nest = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.listen(0, "127.0.0.1");
    return nest;
  }

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    redis = new Redis(redisContainer.getConnectionUrl());
    // The proxy is on this machine: the requests below come from loopback.
    behindProxy = await start("loopback");
    // The proxy is elsewhere (the address staging gives it), so a request
    // from loopback is a client that went around it.
    aroundProxy = await start("10.255.0.10");
    await new TestSettings(behindProxy).set({ compatibility_check_per_ip: 1 });
    await new TestSettings(aroundProxy).reload();
  }, 180_000);

  afterAll(async () => {
    await behindProxy?.close();
    await aroundProxy?.close();
    redis?.disconnect();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const check = (app: INestApplication, forwardedFor?: string) => {
    const call = request(app.getHttpServer())
      .post("/catalog/compatibility/check")
      .set("X-Client", MOBILE)
      .send({ itemIds: [randomUUID()] });
    return forwardedFor === undefined ? call : call.set("X-Forwarded-For", forwardedFor);
  };

  it("from the proxy, counts each client by the address the proxy names", async () => {
    expect((await check(behindProxy, "198.51.100.1")).status).toBe(200);
    // Another client behind the same proxy has a budget of its own…
    expect((await check(behindProxy, "198.51.100.2")).status).toBe(200);
    // …and the first one is now over its limit.
    const limited = await check(behindProxy, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(limited.body.details?.limit).toBe("compatibility_check_per_ip");
  });

  it("from the proxy, believes only the hop the proxy added, not what the client wrote before it", async () => {
    expect((await check(behindProxy, "198.51.100.7")).status).toBe(200);
    // The client forges «198.51.100.9» in front; the proxy appends the real
    // address. Only one hop is trusted, so the client is the real one…
    expect((await check(behindProxy, "198.51.100.9, 198.51.100.7")).status).toBe(429);
    // …and forging the address of somebody else does not spend their budget.
    expect((await check(behindProxy, "198.51.100.8")).status).toBe(200);
  });

  it("around the proxy, ignores a forged X-Forwarded-For: the socket address is the client", async () => {
    expect((await check(aroundProxy, "198.51.100.1")).status).toBe(200);
    // A new forged address every time does not buy a new budget.
    const forged = await check(aroundProxy, "198.51.100.2");
    expect(forged.status).toBe(429);
    expect((await check(aroundProxy)).status).toBe(429);
  });
});
