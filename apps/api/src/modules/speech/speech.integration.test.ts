import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { speechTranscriptionSchema, type SpeechTranscription } from "@adclub/contracts";
import { encodeWav } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TestAiGateway } from "../ai";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../identity";
import { DevSupplierSeed } from "../suppliers";
import { speechEvalDirectory } from "./eval/speech-eval-runner";

/**
 * TASK-059 end to end on a real PostgreSQL and Redis with the test AI
 * provider, which hears the synthetic samples of `ai-eval/speech` by the
 * code in their `ICMT` chunk and calls nothing:
 *
 * - a guest and a signed-in person, the language of the interface as a hint;
 * - the limits: a guest's trial voice requests per device for good, the
 *   address, the account, the guests' budget — and none of them shared
 *   with the photos;
 * - the provider down gives the attempt back;
 * - 400 and 413 before the model and before any count;
 * - the recording and the text are nowhere: not in a table (`ai_job` holds
 *   the size and the length), not in what the process wrote;
 * - who may call it.
 */

const IOS = "mobile/1.4.2 (ios)";
const SUPPLIER_WEB = "supplier-web/0.1.0";

const sample = (name: string) =>
  readFileSync(join(speechEvalDirectory(), "samples", `${name}.wav`));

function tone(seconds: number, amplitude = 0.2): Int16Array {
  const out = new Int16Array(Math.round(seconds * 16_000));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Math.round(Math.sin((2 * Math.PI * 300 * index) / 16_000) * amplitude * 32_767);
  }
  return out;
}

describe("voice input (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let gateway: TestAiGateway;
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
      // The storage is never touched by voice input: an address nobody serves.
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY: "unused",
      S3_SECRET_KEY: "unused-secret",
      S3_BUCKET: "unused",
      TRUST_PROXY: "true",
      AI_PROVIDER: "test",
    });
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 } }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    app = nest;
    settings = new TestSettings(app);
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    gateway = app.get(TestAiGateway);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    gateway.mode = "ok";
    gateway.speechRequests.length = 0;
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

  const http = () => request(app.getHttpServer());
  const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

  async function signIn(phone: string, client = IOS): Promise<string> {
    await redis.del(`rl:login-code:resend:${phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const code = channels.sent.filter((message) => message.phone === phone).at(-1)!.code;
    rememberCode(code);
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .send({ phone, code });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const session = (response.body as { session: { accessToken: string; refreshToken?: string } })
      .session;
    rememberSecret(session.accessToken, ...(session.refreshToken ? [session.refreshToken] : []));
    return session.accessToken;
  }

  function speak(
    bytes: Uint8Array,
    who: { token?: string; deviceId?: string; ip?: string; client?: string },
    options: { contentType?: string; language?: string } = {},
  ) {
    const call = http()
      .post(`/speech/transcribe${who.deviceId ? `?deviceId=${who.deviceId}` : ""}`)
      .set("X-Client", who.client ?? IOS)
      .set("X-Forwarded-For", who.ip ?? nextIp())
      .set("Content-Type", options.contentType ?? "audio/wav");
    if (options.language) call.set("Accept-Language", options.language);
    if (who.token) call.set("Authorization", `Bearer ${who.token}`);
    return call.send(Buffer.from(bytes));
  }

  async function heard(
    bytes: Uint8Array,
    who: { token?: string; deviceId?: string; ip?: string },
    options: { language?: string } = {},
  ): Promise<SpeechTranscription> {
    const response = await speak(bytes, who, options);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return speechTranscriptionSchema.parse(response.body);
  }

  const jobs = async () =>
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_job")).rows[0]!.n;

  // ---------------------------------------------------------- recognition

  it("hears a guest and a signed-in person; the language of the interface goes as a hint", async () => {
    const deviceId = randomUUID();
    const guest = await heard(sample("ru-pads-atlas"), { deviceId }, { language: "kk" });
    // The model's full stop is gone: the text is what the search line takes.
    expect(guest).toEqual({
      text: "Колодки на атлас",
      heard: true,
      cut: false,
      attempts: { scope: "guest", remaining: 4, limit: 5 },
    });
    expect(gateway.speechRequests.at(-1)).toMatchObject({
      language: "kk",
      model: expect.any(String),
    });
    expect((await heard(sample("ru-article-geely"), { deviceId })).text).toBe("04465 0K090");
    // A service mark of the model is gone.
    expect((await heard(sample("ru-pads-atlas-noise"), { deviceId })).text).toBe(
      "колодки на атлас",
    );

    const token = await signIn("+77010000361");
    const person = await heard(sample("en-brake-pads"), { token, deviceId }, { language: "en" });
    expect(person).toMatchObject({
      text: "Brake pads for Geely Atlas",
      attempts: { scope: "account", remaining: 59, limit: 60 },
    });
    expect(gateway.speechRequests.at(-1)).toMatchObject({ language: "en" });
  });

  it("says nothing was heard for silence and noise — the attempt reached the model and is spent", async () => {
    const deviceId = randomUUID();
    expect(await heard(sample("silence"), { deviceId })).toEqual({
      text: "",
      heard: false,
      cut: false,
      attempts: { scope: "guest", remaining: 4, limit: 5 },
    });
    expect(await heard(sample("car-noise"), { deviceId })).toMatchObject({
      text: "",
      heard: false,
      attempts: { remaining: 3 },
    });
    gateway.mode = "unreadable";
    expect(await heard(sample("ru-pads-atlas"), { deviceId })).toMatchObject({ heard: false });
  });

  // ---------------------------------------------------------- the limits

  it("holds a guest's trial voice requests per device for good, apart from the photos", async () => {
    await settings.set({
      guest_limits: { photo_recognitions: 3, voice_requests: 2, assistant_dialogs: 3 },
    });
    const deviceId = randomUUID();
    await heard(sample("ru-oil-change"), { deviceId });
    expect((await heard(sample("ru-oil-change"), { deviceId })).attempts.remaining).toBe(0);
    const calls = await jobs();
    const third = await speak(sample("ru-oil-change"), { deviceId });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({
      code: "RATE_LIMITED",
      details: { limit: "speech_per_device" },
    });
    expect(third.headers["retry-after"]).toBeDefined();
    expect(await jobs()).toBe(calls);
    // The photos of the device have their own count.
    const photos = await http()
      .get(`/garage/vehicle-document/attempts?deviceId=${deviceId}`)
      .set("X-Client", IOS);
    expect(photos.body).toMatchObject({ scope: "guest", remaining: 3, limit: 3 });

    // The same device signed in is counted by the account.
    const token = await signIn("+77010000362");
    expect((await heard(sample("ru-oil-change"), { token, deviceId })).attempts.scope).toBe(
      "account",
    );
  });

  it("limits guests per address and a person per account", async () => {
    await settings.set({ speech_per_ip: 1, speech_per_account: 1 });
    const ip = "198.51.100.59";
    await heard(sample("ru-shock"), { deviceId: randomUUID(), ip });
    const byAddress = await speak(sample("ru-shock"), { deviceId: randomUUID(), ip });
    expect(byAddress.status).toBe(429);
    expect(byAddress.body).toMatchObject({ details: { limit: "speech_per_ip" } });

    const token = await signIn("+77010000363");
    await heard(sample("ru-shock"), { token });
    const byAccount = await speak(sample("ru-shock"), { token });
    expect(byAccount.status).toBe(429);
    expect(byAccount.body).toMatchObject({ details: { limit: "speech_per_account" } });
  });

  it("stops a flood of refused bodies from one address before reading them, sparing the guest's attempts (TASK-059.A)", async () => {
    await settings.set({ speech_requests_per_ip: 10, speech_requests_per_ip_window_seconds: 600 });
    const ip = "198.51.100.77";
    const deviceId = randomUUID();
    const junk = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70);
    const statuses: number[] = [];
    // Each kind of refusal counts: not a sound (400), not a sound type (415), too long (413).
    await settings.set({ speech_max_seconds: 3 });
    for (let index = 0; index < 10; index += 1) {
      const response =
        index % 3 === 0
          ? await speak(junk, { deviceId, ip })
          : index % 3 === 1
            ? await speak(sample("ru-pads-atlas"), { deviceId, ip }, { contentType: "image/jpeg" })
            : await speak(encodeWav(tone(5), 16_000), { deviceId, ip });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([400, 415, 413, 400, 415, 413, 400, 415, 413, 400]);
    // The eleventh — whatever it is, even a real recording — is refused before its body.
    for (const body of [junk, sample("ru-pads-atlas")]) {
      const flooded = await speak(body, { deviceId, ip });
      expect(flooded.status).toBe(429);
      expect(flooded.body).toMatchObject({
        code: "RATE_LIMITED",
        details: { limit: "speech_requests_per_ip" },
      });
      expect(flooded.headers["retry-after"]).toBeDefined();
    }
    // A signed-in person from that address is held too: the address is counted before the session.
    const token = await signIn("+77010000365");
    const signedIn = await speak(sample("ru-pads-atlas"), { token, ip });
    expect(signedIn.status).toBe(429);
    expect(signedIn.body).toMatchObject({ details: { limit: "speech_requests_per_ip" } });
    expect(gateway.speechRequests).toHaveLength(0);
    expect(await jobs()).toBe(0);

    // The guest's trial attempts were never touched: the first one from another address is spent now.
    await settings.set({ speech_max_seconds: 15 });
    const recognised = await heard(sample("ru-pads-atlas"), { deviceId });
    expect(recognised.attempts).toEqual({ scope: "guest", remaining: 4, limit: 5 });
  });

  it("holds guests to the guests' day budget; gives the attempt back", async () => {
    await settings.set({ guest_ai_daily_budget_usd: 0 });
    const deviceId = randomUUID();
    const spent = await speak(sample("ru-pads-atlas"), { deviceId });
    expect(spent.status).toBe(503);
    expect(spent.body).toMatchObject({
      code: "SPEECH_UNAVAILABLE",
      retryable: true,
      details: { reason: "budget", attempts: { scope: "guest", remaining: 5, limit: 5 } },
    });
    expect(await jobs()).toBe(0);
    // A signed-in person is not held by the guests' budget.
    const token = await signIn("+77010000364");
    expect((await heard(sample("ru-pads-atlas"), { token })).heard).toBe(true);
    // The guest's attempt was given back.
    await settings.set({ guest_ai_daily_budget_usd: 10 });
    expect((await heard(sample("ru-pads-atlas"), { deviceId })).attempts.remaining).toBe(4);
  });

  it("gives the attempt back when the provider is down, and records the failed call", async () => {
    const deviceId = randomUUID();
    gateway.mode = "unavailable";
    const down = await speak(sample("ru-pads-atlas"), { deviceId });
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({
      code: "SPEECH_UNAVAILABLE",
      details: { reason: "provider", attempts: { remaining: 5 } },
    });
    const failed = await db.query<{ status: string; kind: string }>(
      "SELECT status, kind FROM ai_job",
    );
    expect(failed.rows).toEqual([{ status: "failed", kind: "speech_transcribe" }]);
    gateway.mode = "ok";
    expect((await heard(sample("ru-pads-atlas"), { deviceId })).attempts.remaining).toBe(4);
  });

  // ------------------------------------------------- refused before the model

  it("refuses what is not a recording, too long or too large — before the model and before a count", async () => {
    const deviceId = randomUUID();
    const refused = async (
      bytes: Uint8Array,
      status: number,
      body: Record<string, unknown>,
      contentType?: string,
    ) => {
      const response = await speak(bytes, { deviceId }, contentType ? { contentType } : {});
      expect(response.status, JSON.stringify(response.body)).toBe(status);
      expect(response.body).toMatchObject(body);
    };
    // A JPEG sent as a WAV.
    await refused(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70), 400, {
      code: "SPEECH_INVALID",
      details: { reason: "not_audio" },
    });
    // An Opus recording of a browser.
    const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 1)]);
    await refused(ogg, 400, { details: { reason: "unsupported_format", detected: "ogg" } });
    const float = encodeWav(tone(1), 16_000);
    new DataView(float.buffer).setUint16(20, 3, true);
    await refused(float, 400, { details: { reason: "unsupported_encoding" } });
    await refused(encodeWav(tone(1), 16_000).subarray(0, 2000), 400, {
      details: { reason: "broken" },
    });
    await refused(encodeWav(new Int16Array(0), 16_000), 400, { details: { reason: "empty" } });
    // A declared type that is not sound at all: the upload is refused at the door.
    await refused(sample("ru-pads-atlas"), 415, {}, "image/jpeg");

    await settings.set({ speech_max_seconds: 3 });
    await refused(encodeWav(tone(5), 16_000), 413, {
      code: "PAYLOAD_TOO_LARGE",
      details: { reason: "duration", maxSeconds: 3 },
    });
    await settings.set({ speech_max_seconds: 15, speech_max_size_kb: 64 });
    await refused(encodeWav(tone(3), 16_000), 413, {
      code: "PAYLOAD_TOO_LARGE",
      details: { reason: "size", maxBytes: 64 * 1024 },
    });

    expect(gateway.speechRequests).toHaveLength(0);
    expect(await jobs()).toBe(0);
    await settings.set({ speech_max_size_kb: 1024 });
    expect((await heard(sample("ru-pads-atlas"), { deviceId })).attempts.remaining).toBe(4);
  });

  // ---------------------------------------------------------- who may call

  it("takes a guest with a device and a person of the app; refuses a guest without one and the cabinet", async () => {
    const noDevice = await speak(sample("ru-pads-atlas"), {});
    expect(noDevice.status).toBe(400);
    expect(noDevice.body).toMatchObject({ code: "VALIDATION_ERROR" });
    const badDevice = await http()
      .post("/speech/transcribe?deviceId=not-a-uuid")
      .set("X-Client", IOS)
      .set("Content-Type", "audio/wav")
      .send(sample("ru-pads-atlas"));
    expect(badDevice.status).toBe(400);

    const { memberPhone } = await app.get(DevSupplierSeed).run();
    const cabinet = await signIn(memberPhone, SUPPLIER_WEB);
    const supplier = await speak(sample("ru-pads-atlas"), { token: cabinet, client: SUPPLIER_WEB });
    expect(supplier.status).toBe(403);
    expect(gateway.speechRequests).toHaveLength(0);

    const broken = await speak(sample("ru-pads-atlas"), {
      token: "not-a-token",
      deviceId: randomUUID(),
    });
    expect(broken.status).toBe(401);
  });

  // ----------------------------------------------------- stored nowhere

  it("leaves no byte of the recording and no word of the text in any table or in the output", async () => {
    const bytes = sample("ru-brake-pads-geely");
    const pieces: string[] = [];
    for (const at of [
      Math.floor(bytes.length / 3 / 3) * 3,
      Math.floor((bytes.length * 2) / 3 / 3) * 3,
    ]) {
      pieces.push(bytes.subarray(at, at + 30).toString("hex"));
      pieces.push(bytes.toString("base64").slice((at / 3) * 4, (at / 3) * 4 + 40));
    }
    const text = (await heard(bytes, { deviceId: randomUUID() })).text;
    expect(text).toBe("Тормозные колодки для Geely Atlas");
    const forbidden = [...pieces, text, "Тормозные колодки", "Geely Atlas"];

    const tables = await db.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    for (const { table_schema: schema, table_name: table } of tables.rows) {
      const rows = await db.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t`,
      );
      const all = rows.rows.map((row) => row.row).join("\n");
      for (const value of forbidden) {
        expect(all.includes(value), `${schema}.${table} holds ${value.slice(0, 12)}…`).toBe(false);
      }
    }
    const recorded = await db.query<{ kind: string; input_ref: unknown; output: unknown }>(
      "SELECT kind, input_ref, output FROM ai_job",
    );
    expect(recorded.rows).toEqual([
      {
        kind: "speech_transcribe",
        output: null,
        input_ref: { bytes: bytes.length, seconds: expect.any(Number), sampleRate: 16_000 },
      },
    ]);

    const written = output.text();
    expect(written).toContain("Speech transcribed heard=true");
    for (const value of forbidden) {
      expect(written.includes(value), `the output holds ${value.slice(0, 12)}…`).toBe(false);
    }
  });
});
