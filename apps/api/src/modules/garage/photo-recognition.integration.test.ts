import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountCarSchema,
  catalogSearchResponseSchema,
  dashboardResponseSchema,
  garageCarsResponseSchema,
  partPhotoResponseSchema,
  transferGarageResponseSchema,
  type AccountCar,
  type CarLevels,
} from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response } from "supertest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
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
import { DevCatalogSeed } from "../catalog";
import { DevCompatibilitySeed } from "../compatibility";
import { DevVehicleSeed } from "../vehicles";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../identity";
import { OffersService } from "../offers";
import { photoEvalDirectory } from "../photo-eval";
import { DevSupplierSeed } from "../suppliers";
import { AdminUsersService } from "../users";
import { prepareDocumentImage } from "../vehicle-document";

/**
 * TASK-058 end to end on a real PostgreSQL, Redis and MinIO with the test AI
 * provider, which reads the synthetic samples of `ai-eval/dashboard` and
 * `ai-eval/part-photo` by their control strip and calls nothing:
 *
 * - the mileage journal: a reading typed and from a photo, the rule of a
 *   lower one, the range, ownership, two devices at once, the car removed,
 *   the transfer of a guest's reading (once however often), the admin's
 *   view, a supplier's session refused;
 * - the dashboard and a part: the kinds of answer, miles to kilometres, the
 *   article found by the very search of `GET /catalog/search` with the
 *   analogs, the test modes, the attempt given back;
 * - one trial limit of a guest for the three photos;
 * - the photo is nowhere after either recognition: not in any table, not in
 *   the storage, not in what the process wrote.
 */

const IOS = "mobile/1.4.2 (ios)";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";

const dashboardSample = (name: string) =>
  readFileSync(join(photoEvalDirectory("dashboard"), "samples", `${name}.jpg`));
const partSample = (name: string) =>
  readFileSync(join(photoEvalDirectory("part-photo"), "samples", `${name}.jpg`));
const documentSample = (name: string) =>
  readFileSync(
    join(photoEvalDirectory("dashboard"), "..", "vehicle-document", "samples", `${name}.jpg`),
  );

describe("mileage and photos of TASK-058 (PostgreSQL + Redis + MinIO)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minio: StartedTestContainer;
  let redis: Redis;
  let db: Client;
  let s3: S3Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let gateway: TestAiGateway;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;

  beforeAll(async () => {
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
      // The image and its settings: see catalog-photos.integration.test.ts.
      new GenericContainer("bitnamilegacy/minio:2025.7.23-debian-12-r5")
        .withEnvironment({
          MINIO_ROOT_USER: MINIO_USER,
          MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
          MINIO_SKIP_CLIENT: "yes",
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp("/minio/health/cluster", 9000))
        .start(),
    ]);
    const endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`;
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    redis = new Redis(redisContainer.getConnectionUrl());
    s3 = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
    });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await s3
          .send(new CreateBucketCommand({ Bucket: BUCKET }))
          .catch((error: { name?: string }) => {
            if (error.name !== "BucketAlreadyOwnedByYou") throw error;
          });
        await s3.send(
          new PutObjectCommand({ Bucket: BUCKET, Key: "probe", Body: Buffer.from("x") }),
        );
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "probe" }));
        break;
      } catch (error) {
        if (attempt > 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY: MINIO_USER,
      S3_SECRET_KEY: MINIO_PASSWORD,
      S3_BUCKET: BUCKET,
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
    s3?.destroy();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    gateway.mode = "ok";
    await truncateAll(db);
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
    });
    // The catalog, the cars and their compatibility of the development data.
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    await app.get(DevCompatibilitySeed).run();
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

  async function id(text: string, values: unknown[] = []): Promise<string> {
    const { rows } = await db.query<{ id: string }>(text, values);
    expect(rows.length, text).toBeGreaterThan(0);
    return rows[0]!.id;
  }

  async function atlasLevels(): Promise<CarLevels> {
    const make = await id("SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely'");
    const model = await id(
      "SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = $1 AND key = 'atlas'",
      [make],
    );
    const generation = await id(
      "SELECT id FROM vehicle_generation WHERE model_id = $1 AND name_key = 'ii (fx11)'",
      [model],
    );
    return {
      make: { id: make, label: "Geely" },
      model: { id: model, label: "Atlas" },
      year: 2023,
      generation: { id: generation, label: "II (FX11)" },
      body: null,
      engine: null,
      transmission: null,
      drive: null,
    };
  }

  async function addCar(token: string): Promise<AccountCar> {
    const response = await http()
      .post("/garage/cars")
      .set("X-Client", IOS)
      .set("Authorization", `Bearer ${token}`)
      .send({ levels: await atlasLevels(), color: null });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return accountCarSchema.parse(response.body);
  }

  function record(token: string, carId: string, body: Record<string, unknown>): Promise<Response> {
    return http()
      .post(`/garage/cars/${carId}/mileage`)
      .set("X-Client", IOS)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  function photo(
    path: string,
    bytes: Buffer,
    who: { token?: string; deviceId?: string; ip?: string },
    query: Record<string, string> = {},
  ) {
    const params = new URLSearchParams({
      ...(who.deviceId ? { deviceId: who.deviceId } : {}),
      ...query,
    }).toString();
    const call = http()
      .post(`${path}${params ? `?${params}` : ""}`)
      .set("X-Client", IOS)
      .set("X-Forwarded-For", who.ip ?? nextIp())
      .set("Content-Type", "image/jpeg");
    if (who.token) call.set("Authorization", `Bearer ${who.token}`);
    return call.send(bytes);
  }

  async function dashboard(name: string, who: { token?: string; deviceId?: string }) {
    const response = await photo("/garage/dashboard", dashboardSample(name), who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return dashboardResponseSchema.parse(response.body);
  }

  async function part(
    name: string,
    who: { token?: string; deviceId?: string },
    query: Record<string, string> = {},
  ) {
    const response = await photo("/catalog/part-photo", partSample(name), who, query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return partPhotoResponseSchema.parse(response.body);
  }

  /** The pads of the development catalog on offer at «Автомаркет», with hours (D-060). */
  async function padsOnOffer(): Promise<{ supplierPhone: string }> {
    const seeded = await app.get(DevSupplierSeed).run();
    const member = await db.query<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM supplier_member WHERE supplier_id = $1 LIMIT 1",
      [seeded.supplierId],
    );
    const actor = {
      role: "supplier" as const,
      accountId: member.rows[0]!.account_id,
      supplierId: seeded.supplierId,
      memberId: member.rows[0]!.id,
    };
    for (const article of ["04465-0K090", "GDB3534"]) {
      const itemId = await id("SELECT id FROM catalog_item WHERE article_norm = $1", [
        normalizeArticle(article),
      ]);
      await app.get(OffersService).create(
        {
          itemId,
          price: article === "GDB3534" ? 11_000 : 14_000,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        },
        actor,
        "ru",
      );
    }
    return { supplierPhone: seeded.memberPhone };
  }

  // ------------------------------------------------------------ mileage

  describe("the mileage journal", () => {
    it("records a typed reading, asks about a lower one, writes nothing for the same one", async () => {
      const token = await signIn("+77011580001");
      const car = await addCar(token);
      expect(car.mileage).toBeNull();

      const first = await record(token, car.id, { valueKm: 45_200, source: "text" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(accountCarSchema.parse(first.body).mileage).toMatchObject({
        valueKm: 45_200,
        source: "text",
      });

      const same = await record(token, car.id, { valueKm: 45_200, source: "text" });
      expect(same.status).toBe(200);
      const lower = await record(token, car.id, { valueKm: 30_000, source: "text" });
      expect(lower.status).toBe(409);
      expect(lower.body).toMatchObject({
        code: "GARAGE_MILEAGE_LOWER",
        details: { lastKm: 45_200 },
      });
      const confirmed = await record(token, car.id, {
        valueKm: 30_000,
        source: "text",
        confirmLower: true,
      });
      expect(accountCarSchema.parse(confirmed.body).mileage?.valueKm).toBe(30_000);

      const rows = await db.query("SELECT value_km FROM mileage_log ORDER BY recorded_at");
      expect(rows.rows.map((row) => row.value_km)).toEqual([45_200, 30_000]);

      const listed = garageCarsResponseSchema.parse(
        (
          await http()
            .get("/garage/cars")
            .set("X-Client", IOS)
            .set("Authorization", `Bearer ${token}`)
        ).body,
      );
      expect(listed.cars[0]!.mileage?.valueKm).toBe(30_000);
    });

    it("refuses a reading out of range and another account's car as one that does not exist", async () => {
      const token = await signIn("+77011580002");
      const other = await signIn("+77011580003");
      const car = await addCar(token);
      for (const valueKm of [-1, 2_000_001, 12.5]) {
        const response = await record(token, car.id, { valueKm, source: "text" });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: "VALIDATION_ERROR" });
      }
      const foreign = await record(other, car.id, { valueKm: 1, source: "text" });
      const missing = await record(other, randomUUID(), { valueKm: 1, source: "text" });
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      const count = await db.query("SELECT count(*)::int AS n FROM mileage_log");
      expect(count.rows[0]!.n).toBe(0);
    });

    it("keeps what the photo read next to the confirmed value, linking only the account's own reading", async () => {
      const token = await signIn("+77011580004");
      const stranger = await signIn("+77011580005");
      const car = await addCar(token);
      const read = await dashboard("lcd-45200-clean", { token });
      expect(read).toMatchObject({ kind: "dashboard", mileageKm: 45_200, unit: "km" });
      const theirs = await dashboard("white-128450-clean", { token: stranger });

      const saved = await record(token, car.id, {
        valueKm: 45_250,
        source: "photo",
        recognizedKm: read.mileageKm,
        recognitionId: read.recognitionId,
      });
      expect(accountCarSchema.parse(saved.body).mileage).toMatchObject({
        valueKm: 45_250,
        source: "photo",
      });
      await record(token, car.id, {
        valueKm: 128_450,
        source: "photo",
        recognizedKm: 128_450,
        recognitionId: theirs.recognitionId,
      });
      // A typed reading carries nothing recognised, whatever the body says.
      await record(token, car.id, { valueKm: 130_000, source: "text", recognizedKm: 5 });
      const rows = await db.query<{
        value_km: number;
        source: string;
        recognized_km: number | null;
        ai_job_id: string | null;
      }>("SELECT value_km, source, recognized_km, ai_job_id FROM mileage_log ORDER BY recorded_at");
      expect(rows.rows).toEqual([
        { value_km: 45_250, source: "photo", recognized_km: 45_200, ai_job_id: read.recognitionId },
        { value_km: 128_450, source: "photo", recognized_km: 128_450, ai_job_id: null },
        { value_km: 130_000, source: "text", recognized_km: null, ai_job_id: null },
      ]);
    });

    it("takes two devices writing at once as two readings, the later one current", async () => {
      const token = await signIn("+77011580006");
      const car = await addCar(token);
      const [a, b] = await Promise.all([
        record(token, car.id, { valueKm: 50_000, source: "text" }),
        record(token, car.id, { valueKm: 50_100, source: "text" }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const rows = await db.query<{ value_km: number }>(
        "SELECT value_km FROM mileage_log ORDER BY recorded_at DESC",
      );
      expect(rows.rows).toHaveLength(2);
      const listed = garageCarsResponseSchema.parse(
        (
          await http()
            .get("/garage/cars")
            .set("X-Client", IOS)
            .set("Authorization", `Bearer ${token}`)
        ).body,
      );
      expect(listed.cars[0]!.mileage?.valueKm).toBe(rows.rows[0]!.value_km);
    });

    it("removes the journal with the car", async () => {
      const token = await signIn("+77011580007");
      const car = await addCar(token);
      await record(token, car.id, { valueKm: 10_000, source: "text" });
      const removed = await http()
        .delete(`/garage/cars/${car.id}`)
        .set("X-Client", IOS)
        .set("Authorization", `Bearer ${token}`);
      expect(removed.status).toBe(200);
      const count = await db.query("SELECT count(*)::int AS n FROM mileage_log");
      expect(count.rows[0]!.n).toBe(0);
    });

    it("transfers a guest's reading once, however often the transfer is sent", async () => {
      const token = await signIn("+77011580008");
      const body = {
        cars: [
          {
            levels: await atlasLevels(),
            color: null,
            isPrimary: true,
            mileage: {
              valueKm: 45_200,
              source: "photo",
              recordedAt: "2026-11-01T08:00:00.000Z",
              recognizedKm: 45_200,
            },
          },
          {
            levels: { ...(await atlasLevels()), year: 2024, generation: null },
            color: null,
            isPrimary: false,
            // Out of range: left out, the sign-in does not fail over it.
            mileage: { valueKm: 9_000_000, source: "text", recordedAt: "2026-11-01T08:00:00Z" },
          },
        ],
      };
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const response = await http()
          .post("/garage/transfer")
          .set("X-Client", IOS)
          .set("Authorization", `Bearer ${token}`)
          .send(body);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const cars = transferGarageResponseSchema.parse(response.body).cars;
        const atlas = cars.find((car) => car.year === 2023)!;
        expect(atlas.mileage).toEqual({
          valueKm: 45_200,
          source: "photo",
          recordedAt: "2026-11-01T08:00:00.000Z",
        });
        expect(cars.find((car) => car.year === 2024)!.mileage).toBeNull();
      }
      const rows = await db.query("SELECT value_km, recognized_km FROM mileage_log");
      expect(rows.rows).toEqual([{ value_km: 45_200, recognized_km: 45_200 }]);

      // The admin sees it in the user's garage (A-USR-02).
      const accountId = await id("SELECT id FROM account WHERE phone = '+77011580008'");
      const garage = await app.get(AdminUsersService).garageOf(accountId);
      expect(garage.cars.find((car) => car.year === 2023)!.mileage?.source).toBe("photo");
    });

    it("takes from a transfer neither a later lower reading nor a repeat from a clock running ahead", async () => {
      const token = await signIn("+77011580011");
      const car = await addCar(token);
      await record(token, car.id, { valueKm: 50_000, source: "text" });
      const levels = await atlasLevels();
      // The guest's car is the account's same car: its reading goes to that journal.
      const transfer = (mileage: Record<string, unknown>) =>
        http()
          .post("/garage/transfer")
          .set("X-Client", IOS)
          .set("Authorization", `Bearer ${token}`)
          .send({ cars: [{ levels, color: null, isPrimary: true, mileage }] });
      // Later than the account's reading and lower: nobody answered «Меньше…».
      const later = new Date(Date.now() + 1000).toISOString();
      expect((await transfer({ valueKm: 45_000, source: "text", recordedAt: later })).status).toBe(
        200,
      );
      // Older and lower: history, the current reading stays.
      expect(
        (await transfer({ valueKm: 40_000, source: "text", recordedAt: "2026-01-01T00:00:00Z" }))
          .status,
      ).toBe(200);
      // A device whose clock runs a day ahead, sent twice: one entry.
      const ahead = new Date(Date.now() + 86_400_000).toISOString();
      await transfer({ valueKm: 52_000, source: "photo", recordedAt: ahead, recognizedKm: 52_000 });
      await transfer({ valueKm: 52_000, source: "photo", recordedAt: ahead, recognizedKm: 52_000 });
      const rows = await db.query<{ value_km: number }>(
        "SELECT value_km FROM mileage_log ORDER BY recorded_at",
      );
      expect(rows.rows.map((row) => row.value_km)).toEqual([40_000, 50_000, 52_000]);
    });

    it("refuses a supplier's session: only a member's own garage", async () => {
      const { supplierPhone } = await padsOnOffer();
      const token = await signIn("+77011580009");
      const car = await addCar(token);
      const cabinet = await signIn(supplierPhone, SUPPLIER_WEB);
      const response = await http()
        .post(`/garage/cars/${car.id}/mileage`)
        .set("X-Client", SUPPLIER_WEB)
        .set("Authorization", `Bearer ${cabinet}`)
        .send({ valueKm: 1, source: "text" });
      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------- dashboard

  describe("the dashboard", () => {
    it("reads kilometres, miles, a trip meter next to the total; refuses what is not a dashboard", async () => {
      const deviceId = randomUUID();
      await settings.set({
        guest_limits: { photo_recognitions: 10, voice_requests: 5, assistant_dialogs: 3 },
      });
      const km = await dashboard("lcd-45200-clean", { deviceId });
      expect(km).toMatchObject({
        kind: "dashboard",
        mileageKm: 45_200,
        unit: "km",
        tripMeterSeen: false,
        attempts: { scope: "guest", remaining: 9, limit: 10 },
      });
      expect(km.recognitionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await dashboard("white-28087mi-clean", { deviceId })).toMatchObject({
        mileageKm: 45_202,
        unit: "mi",
      });
      expect(await dashboard("white-89400-trip-big", { deviceId })).toMatchObject({
        mileageKm: 89_400,
        tripMeterSeen: true,
      });
      expect(await dashboard("not-dashboard-phone-note", { deviceId })).toMatchObject({
        kind: "not_dashboard",
        mileageKm: null,
        recognitionId: null,
      });
      expect((await dashboard("white-ignition-off", { deviceId })).kind).toBe("unreadable");
      // Nothing is written by a recognition.
      expect((await db.query("SELECT count(*)::int AS n FROM mileage_log")).rows[0]!.n).toBe(0);
    });

    it("answers the test modes and gives the attempt back when the provider is down", async () => {
      const deviceId = randomUUID();
      gateway.mode = "not_dashboard";
      expect((await dashboard("lcd-45200-clean", { deviceId })).kind).toBe("not_dashboard");
      gateway.mode = "unreadable";
      expect((await dashboard("lcd-45200-clean", { deviceId })).kind).toBe("unreadable");
      gateway.mode = "unavailable";
      const down = await photo("/garage/dashboard", dashboardSample("lcd-45200-clean"), {
        deviceId,
      });
      expect(down.status).toBe(503);
      expect(down.body).toMatchObject({
        code: "VEHICLE_DOCUMENT_UNAVAILABLE",
        details: { reason: "provider", attempts: { remaining: 1, limit: 3 } },
      });
    });
  });

  // --------------------------------------------------------------- part

  describe("a part by its photo", () => {
    it("finds the article by the very search of GET /catalog/search, with the analog", async () => {
      await padsOnOffer();
      const levels = await atlasLevels();
      const car = {
        vehicleMakeId: levels.make.id,
        vehicleModelId: levels.model.id,
        vehicleGenerationId: levels.generation!.id,
        vehicleYear: "2023",
      };
      const answer = await part("geely-box-clean", { deviceId: randomUUID() }, car);
      expect(answer.kind).toBe("article_found");
      expect(answer.article).toMatchObject({ text: "04465-0K090", normalized: "044650K090" });
      expect(answer.brandHint).toBe("GEELY");
      expect(answer.items.map((item) => item.article)).toEqual(["04465-0K090"]);
      expect(answer.items[0]!.compatibility).toMatchObject({ result: "fits" });

      const searched = catalogSearchResponseSchema.parse(
        (
          await http()
            .get(`/catalog/search?${new URLSearchParams({ q: "04465-0K090", ...car }).toString()}`)
            .set("X-Client", IOS)
        ).body,
      );
      expect(answer.items).toEqual(searched.items);
      expect(answer.total).toBe(searched.total);
      // The analog of the dev catalog, found by its own article.
      expect(answer.analogs.map((item) => item.article)).toEqual(["GDB3534"]);
    });

    it("gives the other articles of a label as candidates and says when the catalog lacks it", async () => {
      await padsOnOffer();
      const two = await part("trw-label-two-articles", { deviceId: randomUUID() });
      expect(two.article?.normalized).toBe("GDB3534");
      expect(two.candidates.map((candidate) => candidate.normalized)).toEqual(["044650K090"]);
      const febi = await part("febi-barcode-batch-date", { deviceId: randomUUID() });
      expect(febi).toMatchObject({ kind: "article_found", total: 0, empty: "no_items" });
      expect(febi.article?.normalized).toBe("FEB35074");
    });

    it("refuses a car the directory does not know before an attempt is counted or the model paid", async () => {
      const deviceId = randomUUID();
      const response = await photo(
        "/catalog/part-photo",
        partSample("geely-box-clean"),
        { deviceId },
        {
          vehicleMakeId: randomUUID(),
        },
      );
      expect(response.status).toBe(400);
      expect((await db.query("SELECT count(*)::int AS n FROM ai_job")).rows[0]!.n).toBe(0);
      const attempts = await http()
        .get(`/garage/vehicle-document/attempts?deviceId=${deviceId}`)
        .set("X-Client", IOS);
      expect(attempts.body).toMatchObject({ remaining: 3 });
    });

    it("says «no article» and «unreadable»; answers the test modes", async () => {
      expect((await part("no-article-oil-can", { deviceId: randomUUID() })).kind).toBe(
        "no_article",
      );
      expect((await part("not-a-part", { deviceId: randomUUID() })).kind).toBe("unreadable");
      gateway.mode = "no_article";
      expect((await part("geely-box-clean", { deviceId: randomUUID() })).kind).toBe("no_article");
    });
  });

  // ------------------------------------------------------- one trial limit

  it("counts a guest's certificate, dashboard and part on one trial limit; the fourth calls nothing", async () => {
    const deviceId = randomUUID();
    const certificate = await photo("/garage/vehicle-document", documentSample("coolray-clean"), {
      deviceId,
    });
    expect(certificate.status).toBe(200);
    expect((await dashboard("lcd-45200-clean", { deviceId })).attempts.remaining).toBe(1);
    expect((await part("geely-box-clean", { deviceId })).attempts.remaining).toBe(0);
    const calls = await db.query("SELECT count(*)::int AS n FROM ai_job");
    const fourth = await photo("/catalog/part-photo", partSample("trw-label-clean"), { deviceId });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({
      code: "RATE_LIMITED",
      details: { limit: "vehicle_document_per_device" },
    });
    expect((await db.query("SELECT count(*)::int AS n FROM ai_job")).rows[0]!.n).toBe(
      calls.rows[0]!.n,
    );
    const attempts = await http()
      .get(`/garage/vehicle-document/attempts?deviceId=${deviceId}`)
      .set("X-Client", IOS);
    expect(attempts.body).toMatchObject({ scope: "guest", remaining: 0, limit: 3 });

    // A signed-in person is counted by the account, not the guest's trial.
    await settings.set({ vehicle_document_per_account: 2 });
    const token = await signIn("+77011580010");
    expect((await dashboard("lcd-45200-clean", { token, deviceId })).attempts).toEqual({
      scope: "account",
      remaining: 1,
      limit: 2,
    });
    await part("geely-box-clean", { token });
    const over = await photo("/garage/dashboard", dashboardSample("lcd-45200-clean"), { token });
    expect(over.body).toMatchObject({ details: { limit: "vehicle_document_per_account" } });
  });

  it("holds guests to the day's guest budget and to the limit per address", async () => {
    await settings.set({ guest_ai_daily_budget_usd: 0 });
    const spent = await photo("/garage/dashboard", dashboardSample("lcd-45200-clean"), {
      deviceId: randomUUID(),
    });
    expect(spent.status).toBe(503);
    expect(spent.body).toMatchObject({ details: { reason: "budget" } });
    await settings.set({ guest_ai_daily_budget_usd: 10, vehicle_document_per_ip: 1 });
    const ip = "198.51.100.58";
    await photo("/garage/dashboard", dashboardSample("lcd-45200-clean"), {
      deviceId: randomUUID(),
      ip,
    });
    const over = await photo("/catalog/part-photo", partSample("geely-box-clean"), {
      deviceId: randomUUID(),
      ip,
    });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ details: { limit: "vehicle_document_per_ip" } });
  });

  // ----------------------------------------------------- stored nowhere

  it("leaves no byte of either photo and no reading in any table, the storage or the output", async () => {
    const pieces: string[] = [];
    for (const original of [dashboardSample("lcd-45200-clean"), partSample("geely-box-clean")]) {
      const prepared = (await prepareDocumentImage(original)).bytes;
      for (const bytes of [original, prepared]) {
        const at = Math.floor(bytes.length / 2 / 3) * 3;
        pieces.push(bytes.subarray(at, at + 30).toString("hex"));
        pieces.push(bytes.toString("base64").slice((at / 3) * 4, (at / 3) * 4 + 40));
      }
    }
    const read = await dashboard("lcd-45200-clean", { deviceId: randomUUID() });
    expect(read.mileageKm).toBe(45_200);
    const found = await part("geely-box-clean", { deviceId: randomUUID() });
    expect(found.article?.normalized).toBe("044650K090");
    // What the label said beyond the article («Qty 1 SET» — the test provider passes it on).
    const forbidden = [...pieces, "Qty 1 SET"];

    const tables = await db.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    for (const { table_schema: schema, table_name: table } of tables.rows) {
      const rows = await db.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t`,
      );
      const text = rows.rows.map((row) => row.row).join("\n");
      for (const value of forbidden) {
        expect(text.includes(value), `${schema}.${table} holds ${value.slice(0, 12)}…`).toBe(false);
      }
    }

    const jobs = await db.query<{ kind: string; input_ref: unknown; output: unknown }>(
      "SELECT kind, input_ref, output FROM ai_job ORDER BY created_at",
    );
    expect(jobs.rows).toEqual([
      {
        kind: "dashboard_ocr",
        output: null,
        input_ref: {
          bytes: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        },
      },
      {
        kind: "part_photo",
        output: null,
        input_ref: {
          bytes: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        },
      },
    ]);

    const objects = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    expect(objects.KeyCount ?? 0).toBe(0);

    const written = output.text();
    expect(written).toContain("Dashboard read result=dashboard");
    expect(written).toContain("Part photo read result=article_found");
    for (const value of [...forbidden, "04465-0K090", "044650K090"]) {
      expect(written.includes(value), `the output holds ${value.slice(0, 12)}…`).toBe(false);
    }
  });
});
