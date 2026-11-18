import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  apiErrorResponseSchema,
  assistantLimitsSchema,
  assistantMessageResponseSchema,
  rateLimitedDetailsSchema,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response } from "supertest";
import tsxPackage from "tsx/package.json";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { JsonLoggerService } from "../common/logging";
import { loadConfig, type AppConfig } from "../config";
import { runMigrate } from "../database/migrate-cli";
import { configureHttpApp } from "../http-app";
import { DevCatalogSeed } from "../modules/catalog";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../modules/identity";
import { almatyDayOf } from "../modules/offer-views";
import { photoEvalDirectory } from "../modules/photo-eval";
import { speechEvalDirectory } from "../modules/speech";
import { DevVehicleSeed } from "../modules/vehicles";
import { truncateAll } from "../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../testing/output-capture";
import { TestSettings } from "../testing/settings";
import { z } from "zod";

const counts = z.object({ all: z.number(), olderDevices: z.number() });
/** What `guest:status` prints (`GuestStatus`), read strictly: nothing else may be in it. */
const guestStatusSchemaForTest = z.strictObject({
  day: z.string(),
  attestationRequired: z.boolean(),
  budget: z.strictObject({ spentUsd: z.number(), budgetUsd: z.number(), exhausted: z.boolean() }),
  calls: z.array(z.strictObject({ kind: z.string(), status: z.string(), calls: z.number() })),
  requests: z.strictObject({
    photo: counts,
    speech: counts,
    assistant: counts,
    total: counts.extend({ olderDevicesShare: z.number().nullable() }),
  }),
  devices: z.strictObject({ seen: z.number(), new: z.number() }),
  newDeviceSubnets: z.array(z.strictObject({ subnet: z.string(), devices: z.number() })),
});

/**
 * The guest mode of PRODUCT 6.6 end to end (TASK-066), on a real PostgreSQL
 * and Redis with the test AI provider:
 *
 * - the trial attempts of a device — photos, voice, the assistant — each on
 *   its own count; a new device starts afresh; a new `guest_limits` holds
 *   without a restart;
 * - the guests' budget refuses every guest route in its own way, a
 *   signed-in person is served; after signing in the guest's limit is gone;
 * - the ways without AI (text search, the catalog for the guest's car,
 *   `POST /vehicles/match`) with every trial spent;
 * - the switch `guest_attestation_required`: all five routes refuse a guest
 *   before the body, with no `ai_job` and no attempt counted; a signed-in
 *   person is served;
 * - `guest:status` — the signs of the switch, with no phone number and no
 *   whole address in what the command prints.
 */

const IOS = "mobile/1.4.2 (ios)";
const USER_PHONE = "+77010000361";
/** A cache much shorter than the product's 30 s: a change shows up without a restart. */
const CACHE_MS = 200;

const execFileAsync = promisify(execFile);
const TSX_CLI = resolve(dirname(require.resolve("tsx/package.json")), tsxPackage.bin);
const OPERATOR_ENTRY = resolve(__dirname, "..", "operator.ts");

const documentSample = readFileSync(
  join(photoEvalDirectory("dashboard"), "..", "vehicle-document", "samples", "coolray-clean.jpg"),
);
const dashboardSample = readFileSync(
  join(photoEvalDirectory("dashboard"), "samples", "lcd-45200-clean.jpg"),
);
const partSample = readFileSync(
  join(photoEvalDirectory("part-photo"), "samples", "geely-box-clean.jpg"),
);
const speechSample = readFileSync(join(speechEvalDirectory(), "samples", "ru-pads-atlas.wav"));

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("the guest mode (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;

  beforeAll(async () => {
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
      // Nothing here stores a file: an address nobody serves.
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY: "unused",
      S3_SECRET_KEY: "unused-secret",
      S3_BUCKET: "unused",
      TRUST_PROXY: "true",
      AI_PROVIDER: "test",
    });
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: CACHE_MS } }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    app = nest;
    settings = new TestSettings(app);
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    await truncateAll(db);
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
    });
    output = captureOutput();
  }, 120_000);

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) rememberCode(sent.code);
  });

  // ------------------------------------------------------------- plumbing

  const http = () => request(app.getHttpServer());
  const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

  async function signIn(phone: string): Promise<string> {
    await redis.del(`rl:login-code:resend:${phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const code = channels.sent.filter((message) => message.phone === phone).at(-1)!.code;
    rememberCode(code);
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", nextIp())
      .send({ phone, code });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const session = (response.body as { session: { accessToken: string; refreshToken?: string } })
      .session;
    rememberSecret(session.accessToken, ...(session.refreshToken ? [session.refreshToken] : []));
    return session.accessToken;
  }

  interface Who {
    token?: string;
    deviceId?: string;
    ip?: string;
  }

  function upload(path: string, bytes: Buffer, contentType: string, who: Who, query = {}) {
    const params = new URLSearchParams({
      ...(who.deviceId ? { deviceId: who.deviceId } : {}),
      ...query,
    }).toString();
    const call = http()
      .post(`${path}${params ? `?${params}` : ""}`)
      .set("X-Client", IOS)
      .set("X-Forwarded-For", who.ip ?? nextIp())
      .set("Content-Type", contentType);
    if (who.token) call.set("Authorization", `Bearer ${who.token}`);
    return call.send(bytes);
  }

  const vehicleDocument = (who: Who) =>
    upload("/garage/vehicle-document", documentSample, "image/jpeg", who);
  const dashboard = (who: Who) => upload("/garage/dashboard", dashboardSample, "image/jpeg", who);
  const partPhoto = (who: Who) => upload("/catalog/part-photo", partSample, "image/jpeg", who);
  const speech = (who: Who) => upload("/speech/transcribe", speechSample, "audio/wav", who);

  async function car() {
    const make = await db.query<{ id: string }>(
      "SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely'",
    );
    const model = await db.query<{ id: string }>(
      "SELECT model_id AS id FROM vehicle_model_spelling WHERE key = 'coolray'",
    );
    return { makeId: make.rows[0]!.id, modelId: model.rows[0]!.id, year: 2024 };
  }

  function assistant(who: Who, carLevels: object, text = "Нужно масло") {
    const call = http()
      .post("/assistant/messages")
      .set("X-Client", IOS)
      .set("Accept-Language", "ru")
      .set("X-Forwarded-For", who.ip ?? nextIp());
    if (who.token) call.set("Authorization", `Bearer ${who.token}`);
    return call.send({ text, car: carLevels, ...(who.deviceId ? { deviceId: who.deviceId } : {}) });
  }

  async function seed() {
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    return car();
  }

  function expectError(response: Response, status: number, code: string) {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(apiErrorResponseSchema.parse(response.body).code).toBe(code);
  }

  const limitOf = (response: Response) =>
    rateLimitedDetailsSchema.parse(apiErrorResponseSchema.parse(response.body).details).limit;

  const jobs = async () =>
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_job")).rows[0]!.n;

  async function operatorCommand(...args: string[]) {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [TSX_CLI, OPERATOR_ENTRY, ...args],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            LOG_LEVEL: "warn",
            DATABASE_URL: postgres.getConnectionUri(),
            REDIS_URL: redisContainer.getConnectionUrl(),
            S3_ENDPOINT: "http://127.0.0.1:3",
            S3_ACCESS_KEY: "x",
            S3_SECRET_KEY: "x",
            S3_BUCKET: "x",
            ADMIN_WEB_RELEASE_VERSION: "0.1.0",
            AI_PROVIDER: "test",
          },
          encoding: "utf8",
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  // ---------------------------------------------------------------- tests

  it("counts the trial of a device per kind: one spent leaves the others; a new device starts afresh", async () => {
    const levels = await seed();
    await settings.set({
      guest_limits: { photo_recognitions: 2, voice_requests: 1, assistant_dialogs: 1 },
    });
    const deviceId = randomUUID();

    // The photos are one count: the certificate, the dashboard and a part.
    expect((await vehicleDocument({ deviceId })).status).toBe(200);
    expect((await dashboard({ deviceId })).status).toBe(200);
    const third = await partPhoto({ deviceId });
    expectError(third, 429, "RATE_LIMITED");
    expect(limitOf(third)).toBe("vehicle_document_per_device");

    // Voice and the assistant are untouched by the photos.
    expect((await speech({ deviceId })).status).toBe(200);
    expect((await assistant({ deviceId }, levels)).status).toBe(200);
    const voiceOver = await speech({ deviceId });
    expectError(voiceOver, 429, "RATE_LIMITED");
    expect(limitOf(voiceOver)).toBe("speech_per_device");
    const dialogOver = await assistant({ deviceId }, levels);
    expectError(dialogOver, 429, "RATE_LIMITED");
    expect(limitOf(dialogOver)).toBe("assistant_dialogs_per_device");

    // PRODUCT 6.6: no protection at the start — a new device id has the whole trial.
    const fresh = randomUUID();
    expect((await partPhoto({ deviceId: fresh })).status).toBe(200);
    expect((await speech({ deviceId: fresh })).status).toBe(200);
    expect((await assistant({ deviceId: fresh }, levels)).status).toBe(200);
  });

  it("takes a new guest_limits without a restart, within the settings cache", async () => {
    await settings.set({
      guest_limits: { photo_recognitions: 1, voice_requests: 1, assistant_dialogs: 1 },
    });
    const deviceId = randomUUID();
    expect((await dashboard({ deviceId })).status).toBe(200);
    expectError(await dashboard({ deviceId }), 429, "RATE_LIMITED");

    await settings.set({
      guest_limits: { photo_recognitions: 2, voice_requests: 1, assistant_dialogs: 1 },
    });
    await sleep(CACHE_MS + 50);
    const attempts = await http()
      .get(`/garage/vehicle-document/attempts?deviceId=${deviceId}`)
      .set("X-Client", IOS);
    expect(attempts.body).toEqual({ scope: "guest", remaining: 1, limit: 2 });
    expect((await dashboard({ deviceId })).status).toBe(200);
  });

  it("the guests' budget: every guest route refuses in its own way, a signed-in person is served", async () => {
    const levels = await seed();
    const token = await signIn(USER_PHONE);
    await settings.set({ guest_ai_daily_budget_usd: 0 });
    await sleep(CACHE_MS + 50);
    const deviceId = randomUUID();
    const before = await jobs();

    for (const call of [vehicleDocument, dashboard, partPhoto]) {
      const refused = await call({ deviceId });
      expectError(refused, 503, "VEHICLE_DOCUMENT_UNAVAILABLE");
      expect(apiErrorResponseSchema.parse(refused.body).details).toMatchObject({
        reason: "budget",
      });
    }
    const voice = await speech({ deviceId });
    expectError(voice, 503, "SPEECH_UNAVAILABLE");
    expect(apiErrorResponseSchema.parse(voice.body).details).toMatchObject({
      reason: "budget",
    });
    const asked = await assistant({ deviceId }, levels);
    expect(asked.status).toBe(200);
    expect(assistantMessageResponseSchema.parse(asked.body).message.unavailable).toEqual({
      reason: "guest_budget",
    });
    expect(await jobs()).toBe(before);

    for (const call of [vehicleDocument, dashboard, partPhoto, speech]) {
      expect((await call({ token })).status).toBe(200);
    }
    const signedIn = assistantMessageResponseSchema.parse(
      (await assistant({ token }, levels)).body,
    );
    expect(signedIn.message.unavailable).toBeNull();
  });

  it("after signing in the device's spent trial is no limit; the ways without AI stay open with it spent", async () => {
    const levels = await seed();
    await settings.set({
      guest_limits: { photo_recognitions: 1, voice_requests: 1, assistant_dialogs: 1 },
    });
    const deviceId = randomUUID();
    expect((await partPhoto({ deviceId })).status).toBe(200);
    expect((await speech({ deviceId })).status).toBe(200);
    expect((await assistant({ deviceId }, levels)).status).toBe(200);
    expectError(await partPhoto({ deviceId }), 429, "RATE_LIMITED");
    expectError(await speech({ deviceId }), 429, "RATE_LIMITED");
    expectError(await assistant({ deviceId }, levels), 429, "RATE_LIMITED");

    // Without AI: the text search, the catalog for the guest's car, a car by its name.
    const vehicle = new URLSearchParams({
      vehicleMakeId: levels.makeId,
      vehicleModelId: levels.modelId,
      vehicleYear: String(levels.year),
    }).toString();
    const search = await http()
      .get(`/catalog/search?q=${encodeURIComponent("колодки")}&${vehicle}`)
      .set("X-Client", IOS);
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    const subcategory = await db.query<{ id: string }>(
      "SELECT id FROM category WHERE code = 'engine_oils'",
    );
    const list = await http()
      .get(`/catalog/categories/${subcategory.rows[0]!.id}/items?${vehicle}`)
      .set("X-Client", IOS);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const match = await http()
      .post("/vehicles/match")
      .set("X-Client", IOS)
      .send({ text: "Джили Атлас 2023" });
    expect(match.status, JSON.stringify(match.body)).toBe(200);
    expect(match.body).toMatchObject({ result: "found" });

    // The same device signed in: the account's limits, not the guest's.
    const token = await signIn(USER_PHONE);
    expect((await partPhoto({ token, deviceId })).status).toBe(200);
    expect((await speech({ token, deviceId })).status).toBe(200);
    expect((await assistant({ token }, levels)).status).toBe(200);
  });

  it("the switch: all five routes refuse a guest before the body — no model, no attempt; a signed-in person is served", async () => {
    const levels = await seed();
    const token = await signIn(USER_PHONE);
    await settings.set({ guest_attestation_required: true });
    await sleep(CACHE_MS + 50);
    const deviceId = randomUUID();
    const before = await jobs();

    const refusals = [
      await vehicleDocument({ deviceId }),
      await dashboard({ deviceId }),
      await partPhoto({ deviceId }),
      await speech({ deviceId }),
      await assistant({ deviceId }, levels),
      // Before the body: a body the route would refuse (415, a broken JSON) is not even read.
      await upload("/garage/dashboard", Buffer.from("x"), "text/plain", { deviceId }),
      await http()
        .post("/assistant/messages")
        .set("X-Client", IOS)
        .set("Content-Type", "application/json")
        .send("{not json"),
      // A form body is not read by any parser either (no 415 before the gate).
      await http()
        .post("/assistant/messages")
        .set("X-Client", IOS)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send("text=x"),
      // Without a device id too: the gate does not need one.
      await speech({}),
    ];
    for (const refused of refusals) expectError(refused, 403, "GUEST_SIGN_IN_REQUIRED");
    expect(await jobs()).toBe(before);
    // No trial attempt counted anywhere for the device.
    expect(await redis.keys(`rl:*${deviceId}*`)).toEqual([]);
    const left = assistantLimitsSchema.parse(
      (await http().get(`/assistant/limits?deviceId=${deviceId}`).set("X-Client", IOS)).body,
    );
    expect(left.dialogsLeft).toBe(left.dialogsLimit);
    // The ways without AI are not behind the switch.
    expect(
      (await http().post("/vehicles/match").set("X-Client", IOS).send({ text: "Geely Coolray" }))
        .status,
    ).toBe(200);

    for (const call of [vehicleDocument, dashboard, partPhoto, speech]) {
      expect((await call({ token })).status).toBe(200);
    }
    expect((await assistant({ token }, levels)).status).toBe(200);
    expect(await jobs()).toBeGreaterThan(before);

    // Off again: the guest is served at once (within the cache).
    await settings.set({ guest_attestation_required: false });
    await sleep(CACHE_MS + 50);
    expect((await dashboard({ deviceId })).status).toBe(200);
  });

  it("guest:status shows the signs of the switch, never a phone number or a whole address", async () => {
    const levels = await seed();
    const token = await signIn(USER_PHONE);
    const today = almatyDayOf(new Date());
    // A device first seen before today, still a guest.
    const older = randomUUID();
    await redis.set(`guest:first-seen:${older}`, "2026-01-01");
    const fresh = [randomUUID(), randomUUID(), randomUUID()];
    const addresses = ["198.51.100.17", "198.51.100.203", "2001:db8:aa:bb:1:2:3:4"];

    expect((await dashboard({ deviceId: older, ip: "192.0.2.44" })).status).toBe(200);
    expect((await speech({ deviceId: older, ip: "192.0.2.44" })).status).toBe(200);
    for (const [index, deviceId] of fresh.entries()) {
      const ip = addresses[index]!;
      expect((await partPhoto({ deviceId, ip })).status).toBe(200);
    }
    expect((await assistant({ deviceId: fresh[0], ip: addresses[0] }, levels)).status).toBe(200);
    // Signed in: not a guest, not counted.
    expect((await dashboard({ token, deviceId: randomUUID() })).status).toBe(200);
    // A refused request is not a served one.
    expectError(
      await upload("/garage/dashboard", Buffer.from("x"), "text/plain", { deviceId: randomUUID() }),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    // The counts are written after the answer is sent.
    await sleep(300);

    const result = await operatorCommand("guest:status");
    expect(result.code, result.stderr).toBe(0);
    const status = guestStatusSchemaForTest.parse(JSON.parse(result.stdout.trim()));
    expect(status.day).toBe(today);
    expect(status.attestationRequired).toBe(false);
    expect(status.requests.photo).toEqual({ all: 4, olderDevices: 1 });
    expect(status.requests.speech).toEqual({ all: 1, olderDevices: 1 });
    expect(status.requests.assistant).toEqual({ all: 1, olderDevices: 0 });
    expect(status.requests.total).toEqual({ all: 6, olderDevices: 2, olderDevicesShare: 2 / 6 });
    expect(status.devices).toEqual({ seen: 4, new: 3 });
    expect(status.newDeviceSubnets).toEqual([
      { subnet: "198.51.100.0/24", devices: 2 },
      { subnet: "2001:db8:aa:bb::/64", devices: 1 },
    ]);
    expect(status.budget.budgetUsd).toBe(10);
    const guestKinds = new Set(status.calls.map((call) => call.kind));
    expect(guestKinds).toEqual(
      new Set(["dashboard_ocr", "part_photo", "speech_transcribe", "assistant_turn"]),
    );

    const printed = `${result.stdout}${result.stderr}`;
    for (const address of [...addresses, "192.0.2.44"]) expect(printed).not.toContain(address);
    expect(printed).not.toContain(USER_PHONE);
    expect(printed).not.toContain(USER_PHONE.slice(2));

    const wrong = await operatorCommand("guest:status", "--day", "yesterday");
    expect(wrong.code).not.toBe(0);
    const past = await operatorCommand("guest:status", "--day", "2026-01-01");
    expect(past.code, past.stderr).toBe(0);
    expect(guestStatusSchemaForTest.parse(JSON.parse(past.stdout.trim())).devices).toEqual({
      seen: 0,
      new: 0,
    });
  });
});
