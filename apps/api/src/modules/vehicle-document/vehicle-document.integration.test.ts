import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountCarSchema,
  garageCarsResponseSchema,
  loginCodeVerifiedResponseSchema,
  transferGarageResponseSchema,
  vehicleDocumentAttemptsSchema,
  vehicleDocumentResponseSchema,
  type CarLevels,
  type VehicleDocumentResponse,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import sharp from "sharp";
import request, { type Response } from "supertest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TestAiGateway } from "../ai";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../identity";
import { AdminUsersService } from "../users";
import { DevVehicleSeed } from "../vehicles";
import { prepareDocumentImage } from "./document-image";
import { DocumentProofs } from "./document-proofs";
import { vehicleDocumentEvalDirectory } from "./eval/document-eval-data";

/**
 * A car read off a photographed registration certificate (TASK-057, D-064;
 * ARCHITECTURE 4.58) on a real PostgreSQL, Redis and MinIO with the test AI
 * provider, which reads the synthetic samples of `ai-eval/vehicle-document`
 * by their control strip and calls nothing:
 *
 * - the route: the kinds of document, the fields, the place in the vehicle
 *   catalog, the attempts of a guest and of an account, the provider down
 *   and the budget spent (the attempt given back), a file that is no picture;
 * - the photo, the VIN, the plate and the owner of the sample are nowhere
 *   after a recognition: not in any table of any schema, not in the
 *   storage, not in what the process wrote;
 * - the garage: VIN, plate and the mark of the document — the proof the
 *   recognition signed, a forged one, «не подтверждён», one VIN one car,
 *   «Подтвердить техпаспортом», the transfer of a guest's cars;
 * - the admin list of users: «Есть автомобиль без подтверждённого документа».
 */

const IOS = "mobile/1.4.2 (ios)";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";

const SAMPLES = vehicleDocumentEvalDirectory();
const sample = (name: string) => readFileSync(join(SAMPLES, "samples", `${name}.jpg`));

/** What the Coolray sample says — and what must not be found anywhere after reading it. */
const COOLRAY = {
  vin: "L6T7844Z0RN001234",
  plate: "777ABC02",
  plateSpaced: "777 ABC 02",
  owner: "ТЕСТОВ ТЕСТ ТЕСТОВИЧ",
  address: "ВЫМЫШЛЕННАЯ",
  series: "00012345",
};

describe("vehicle registration certificate (PostgreSQL + Redis + MinIO)", () => {
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
    await db.query(TRUNCATE_ALL);
    await redis.flushall();
    await settings.reload();
    await app.get(DevVehicleSeed).run();
    output = captureOutput();
  }, 60_000);

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) rememberCode(sent.code);
  });

  const http = () => request(app.getHttpServer());
  const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

  async function signIn(phone: string): Promise<string> {
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
    const session = loginCodeVerifiedResponseSchema.parse(response.body).session;
    rememberSecret(session.accessToken, session.refreshToken);
    return session.accessToken;
  }

  function recognize(
    bytes: Buffer,
    who: { token?: string; deviceId?: string; ip?: string },
    contentType = "image/jpeg",
  ) {
    const call = http()
      .post(`/garage/vehicle-document${who.deviceId ? `?deviceId=${who.deviceId}` : ""}`)
      .set("X-Client", IOS)
      .set("X-Forwarded-For", who.ip ?? nextIp())
      .set("Content-Type", contentType);
    if (who.token) call.set("Authorization", `Bearer ${who.token}`);
    return call.send(bytes);
  }

  async function recognized(
    name: string,
    who: { token?: string; deviceId?: string; ip?: string },
  ): Promise<VehicleDocumentResponse> {
    const response = await recognize(sample(name), who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return vehicleDocumentResponseSchema.parse(response.body);
  }

  /** Levels of a car as the steps would save it, from a recognised certificate. */
  function levelsFrom(answer: VehicleDocumentResponse): CarLevels {
    return {
      make: answer.match.make.value!,
      model: answer.match.model.value!,
      year: answer.fields.year,
      generation: answer.match.generation.value,
      body: null,
      engine: answer.match.engine.candidates[0] ?? null,
      transmission: null,
      drive: null,
    };
  }

  function addCar(token: string, body: Record<string, unknown>): Promise<Response> {
    return http()
      .post("/garage/cars")
      .set("X-Client", IOS)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  describe("recognition", () => {
    it("reads a new-form certificate and places it in the vehicle catalog", async () => {
      const deviceId = randomUUID();
      const answer = await recognized("coolray-clean", { deviceId });
      expect(answer.result).toBe("kz_registration");
      expect(answer.fields).toEqual({
        make: "GEELY",
        model: "COOLRAY",
        year: 2024,
        vin: COOLRAY.vin,
        plate: COOLRAY.plate,
        engineVolumeCc: 1477,
        color: "СЕРЫЙ",
      });
      expect(answer.match.make).toMatchObject({ status: "exact", value: { label: "Geely" } });
      expect(answer.match.model).toMatchObject({ status: "exact", value: { label: "Coolray" } });
      expect(answer.match.generation).toMatchObject({
        status: "exact",
        value: { label: "I (SX11)" },
      });
      // The certificate has no engine code: the 1.5 l engines of the year, to choose among.
      expect(answer.match.engine.status).toBe("candidates");
      expect(answer.match.engine.candidates.map((engine) => engine.label)).toContain("JLH-3G15TD");
      expect(answer.match.color).toEqual({ status: "exact", value: "gray" });
      expect(answer.documentProof).toMatch(/^vd1\./);
      expect(answer.attempts).toEqual({ scope: "guest", remaining: 2, limit: 3 });
      // What the provider added beyond the fields never reaches the client.
      expect(JSON.stringify(answer)).not.toContain(COOLRAY.owner);
    });

    it("reads the old form and leaves a make the catalog lacks for «Распознали „…“»", async () => {
      const old = await recognized("atlas-old-clean", { deviceId: randomUUID() });
      expect(old.result).toBe("kz_registration");
      expect(old.fields.plate).toBe("B456KLM");
      expect(old.match.generation).toMatchObject({ status: "exact", value: { label: "I (NL-3)" } });

      const camry = await recognized("camry-clean", { deviceId: randomUUID() });
      expect(camry.result).toBe("kz_registration");
      expect(camry.fields.make).toBe("TOYOTA");
      expect(camry.match.make.status).toBe("not_found");
      expect(camry.match.model.status).toBe("not_found");
      expect(camry.fields.vin).toBe("JTNB11HK403045678");
    });

    it("says «another document» for a driving licence and a Russian certificate, «unreadable» for a photo without one", async () => {
      for (const name of ["kz_license-clean", "ru_sts-clean", "not_document-clean"]) {
        const answer = await recognized(name, { deviceId: randomUUID() });
        expect(answer.result).toBe("other_document");
        expect(answer.documentProof).toBeNull();
        expect(Object.values(answer.fields).every((value) => value === null)).toBe(true);
      }
      const plain = await sharp({
        create: { width: 900, height: 600, channels: 3, background: "#808080" },
      })
        .jpeg()
        .toBuffer();
      const response = await recognize(plain, { deviceId: randomUUID() });
      expect(vehicleDocumentResponseSchema.parse(response.body).result).toBe("unreadable");
    });

    it("answers the test modes: unreadable, another document", async () => {
      gateway.mode = "unreadable";
      expect((await recognized("coolray-clean", { deviceId: randomUUID() })).result).toBe(
        "unreadable",
      );
      gateway.mode = "other_document";
      expect((await recognized("coolray-clean", { deviceId: randomUUID() })).result).toBe(
        "other_document",
      );
    });

    it("gives the attempt back when the provider is down or the budget is spent", async () => {
      const deviceId = randomUUID();
      gateway.mode = "unavailable";
      const down = await recognize(sample("coolray-clean"), { deviceId });
      expect(down.status).toBe(503);
      expect(down.body).toMatchObject({
        code: "VEHICLE_DOCUMENT_UNAVAILABLE",
        details: { reason: "provider", attempts: { remaining: 3, limit: 3 } },
      });
      gateway.mode = "ok";
      await settings.set({ ai_daily_budget_usd: 0 });
      const spent = await recognize(sample("coolray-clean"), { deviceId });
      expect(spent.status).toBe(503);
      expect(spent.body).toMatchObject({ details: { reason: "budget" } });
      await settings.set({ ai_daily_budget_usd: 100, guest_ai_daily_budget_usd: 0 });
      const guests = await recognize(sample("coolray-clean"), { deviceId });
      expect(guests.body).toMatchObject({ details: { reason: "budget" } });
      const attempts = await http()
        .get(`/garage/vehicle-document/attempts?deviceId=${deviceId}`)
        .set("X-Client", IOS);
      expect(vehicleDocumentAttemptsSchema.parse(attempts.body)).toEqual({
        scope: "guest",
        remaining: 3,
        limit: 3,
      });
    });

    it("counts a guest's trial attempts per device, then refuses with Retry-After", async () => {
      await settings.set({
        guest_limits: { photo_recognitions: 2, voice_requests: 5, assistant_dialogs: 3 },
      });
      const deviceId = randomUUID();
      expect((await recognized("coolray-clean", { deviceId })).attempts.remaining).toBe(1);
      expect((await recognized("kz_license-clean", { deviceId })).attempts.remaining).toBe(0);
      const over = await recognize(sample("coolray-clean"), { deviceId });
      expect(over.status).toBe(429);
      expect(over.body).toMatchObject({
        code: "RATE_LIMITED",
        details: { limit: "vehicle_document_per_device" },
      });
      expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
      // Another device of the same person is a fresh trial: the address limit is the wall.
      expect(
        (await recognized("coolray-clean", { deviceId: randomUUID() })).attempts.remaining,
      ).toBe(1);
    });

    it("counts guests per address against devices made anew", async () => {
      await settings.set({ vehicle_document_per_ip: 2 });
      const ip = "198.51.100.77";
      await recognized("coolray-clean", { deviceId: randomUUID(), ip });
      await recognized("coolray-clean", { deviceId: randomUUID(), ip });
      const over = await recognize(sample("coolray-clean"), { deviceId: randomUUID(), ip });
      expect(over.status).toBe(429);
      expect(over.body).toMatchObject({ details: { limit: "vehicle_document_per_ip" } });
    });

    it("counts a signed-in person per account, whatever the device", async () => {
      await settings.set({ vehicle_document_per_account: 2 });
      const token = await signIn("+77011570001");
      const first = await recognized("coolray-clean", { token, deviceId: randomUUID() });
      expect(first.attempts).toEqual({ scope: "account", remaining: 1, limit: 2 });
      await recognized("coolray-clean", { token });
      const over = await recognize(sample("coolray-clean"), { token, deviceId: randomUUID() });
      expect(over.body).toMatchObject({ details: { limit: "vehicle_document_per_account" } });
    });

    it("refuses a guest without a device, a file that is no picture, a wrong type and a body over the limit", async () => {
      const noDevice = await recognize(sample("coolray-clean"), {});
      expect(noDevice.status).toBe(400);
      expect(noDevice.body).toMatchObject({ code: "VALIDATION_ERROR" });

      const deviceId = randomUUID();
      const text = await recognize(Buffer.from("not a picture at all"), { deviceId });
      expect(text.status).toBe(400);
      expect(text.body).toMatchObject({
        code: "VEHICLE_DOCUMENT_INVALID",
        details: { reason: "not_an_image" },
      });
      const svg = await recognize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), {
        deviceId,
      });
      expect(svg.body).toMatchObject({ details: { reason: "unsupported_format" } });

      const wrongType = await recognize(sample("coolray-clean"), { deviceId }, "image/svg+xml");
      expect(wrongType.status).toBe(415);

      await settings.set({ vehicle_document_max_size_mb: 1 });
      const big = await sharp({
        create: {
          width: 2600,
          height: 2600,
          channels: 3,
          background: "#808080",
          noise: { type: "gaussian", mean: 128, sigma: 60 },
        },
      })
        .png()
        .toBuffer();
      expect(big.byteLength).toBeGreaterThan(1024 * 1024);
      expect((await recognize(big, { deviceId }, "image/png")).status).toBe(413);

      // None of the refused files cost an attempt.
      const attempts = await http()
        .get(`/garage/vehicle-document/attempts?deviceId=${deviceId}`)
        .set("X-Client", IOS);
      expect(attempts.body).toMatchObject({ remaining: 3 });
    });
  });

  describe("the photo is stored nowhere", () => {
    it("leaves no byte of the photo, no VIN, plate or owner in any table, the storage or the output", async () => {
      const original = sample("coolray-clean");
      const prepared = (await prepareDocumentImage(original)).bytes;
      const answer = await recognized("coolray-clean", { deviceId: randomUUID() });
      expect(answer.fields.vin).toBe(COOLRAY.vin);
      expect(gateway.documentRequests.at(-1)?.bytes).toBe(prepared.byteLength);

      // Pieces of the picture as it came and as it went to the model, in the
      // forms a database or a log would hold them: hex (bytea), base64.
      const pieces: string[] = [];
      for (const bytes of [original, prepared]) {
        const at = Math.floor(bytes.length / 2 / 3) * 3;
        pieces.push(bytes.subarray(at, at + 30).toString("hex"));
        pieces.push(bytes.toString("base64").slice((at / 3) * 4, (at / 3) * 4 + 40));
      }
      const forbidden = [
        COOLRAY.vin,
        COOLRAY.plate,
        COOLRAY.plateSpaced,
        COOLRAY.owner,
        COOLRAY.address,
        COOLRAY.series,
        ...pieces,
      ];

      const tables = await db.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      );
      expect(tables.rows.length).toBeGreaterThan(20);
      for (const { table_schema: schema, table_name: table } of tables.rows) {
        const rows = await db.query<{ row: string }>(
          `SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t`,
        );
        const text = rows.rows.map((row) => row.row).join("\n");
        for (const value of forbidden) {
          expect(text.includes(value), `${schema}.${table} holds ${value.slice(0, 12)}…`).toBe(
            false,
          );
        }
      }

      // `ai_job` has the call — its size, never its content.
      const jobs = await db.query<{
        kind: string;
        input_ref: unknown;
        output: unknown;
        status: string;
      }>(`SELECT kind, input_ref, output, status FROM ai_job`);
      expect(jobs.rows).toEqual([
        {
          kind: "passport_ocr",
          status: "succeeded",
          output: null,
          input_ref: {
            bytes: prepared.byteLength,
            width: expect.any(Number),
            height: expect.any(Number),
          },
        },
      ]);

      const objects = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
      expect(objects.KeyCount ?? 0).toBe(0);

      const written = output.text();
      expect(written).toContain("Vehicle document read result=kz_registration");
      for (const value of forbidden) {
        expect(written.includes(value), `the output holds ${value.slice(0, 12)}…`).toBe(false);
      }
    });
  });

  describe("garage", () => {
    it("marks a car saved with the recognition's proof «документ показан» at the moment of the proof", async () => {
      const token = await signIn("+77011570010");
      const answer = await recognized("coolray-clean", { token });
      const added = await addCar(token, {
        levels: levelsFrom(answer),
        color: answer.match.color.value,
        vin: answer.fields.vin,
        plate: "777 abc 02",
        document: { status: "shown", proof: answer.documentProof },
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const car = accountCarSchema.parse(added.body);
      expect(car).toMatchObject({
        vin: COOLRAY.vin,
        plate: COOLRAY.plate,
        document: { status: "shown" },
      });
      const proofAt = app.get(DocumentProofs).read(answer.documentProof!)!;
      expect(car.document!.at).toBe(proofAt.toISOString());
    });

    it("refuses a proof it never signed, a VIN with O or of the wrong length, and a foreign plate", async () => {
      const token = await signIn("+77011570011");
      const answer = await recognized("coolray-clean", { token });
      const levels = levelsFrom(answer);
      const forged = await addCar(token, {
        levels,
        color: null,
        document: { status: "shown", proof: "vd1.1.abcdefgh.abcdefghijklmnopqrstuv" },
      });
      expect(forged.status).toBe(400);
      expect(forged.body).toMatchObject({ details: [{ path: "document.proof" }] });
      const vinO = await addCar(token, { levels, color: null, vin: "L6T7844Z0RNO01234" });
      expect(vinO.body).toMatchObject({ code: "VALIDATION_ERROR", details: [{ path: "vin" }] });
      const short = await addCar(token, { levels, color: null, vin: "L6T7844Z0RN00123" });
      expect(short.body).toMatchObject({ details: [{ path: "vin" }] });
      const plate = await addCar(token, { levels, color: null, plate: "А123ВС77" });
      expect(plate.body).toMatchObject({ details: [{ path: "plate" }] });
      const cars = garageCarsResponseSchema.parse(
        (
          await http()
            .get("/garage/cars")
            .set("X-Client", IOS)
            .set("Authorization", `Bearer ${token}`)
        ).body,
      );
      expect(cars.cars).toEqual([]);
    });

    it("marks a car chosen from the list «не подтверждён», and an old app's car not at all", async () => {
      const token = await signIn("+77011570012");
      const answer = await recognized("atlas-clean", { token });
      const unconfirmed = accountCarSchema.parse(
        (
          await addCar(token, {
            levels: levelsFrom(answer),
            color: null,
            document: { status: "unconfirmed" },
          })
        ).body,
      );
      expect(unconfirmed.document?.status).toBe("unconfirmed");
      const coolray = await recognized("coolray-clean", { token });
      const old = accountCarSchema.parse(
        (await addCar(token, { levels: levelsFrom(coolray), color: null })).body,
      );
      expect(old.document).toBeNull();
      expect(old.vin).toBeNull();
    });

    it("keeps one VIN to one car of a garage", async () => {
      const token = await signIn("+77011570013");
      const coolray = await recognized("coolray-clean", { token });
      const atlas = await recognized("atlas-clean", { token });
      const first = accountCarSchema.parse(
        (await addCar(token, { levels: levelsFrom(coolray), color: null, vin: COOLRAY.vin })).body,
      );
      const twice = await addCar(token, {
        levels: levelsFrom(atlas),
        color: null,
        vin: COOLRAY.vin,
      });
      expect(twice.status).toBe(409);
      expect(twice.body).toMatchObject({ code: "GARAGE_VIN_TAKEN", details: { carId: first.id } });
      const second = accountCarSchema.parse(
        (await addCar(token, { levels: levelsFrom(atlas), color: null })).body,
      );
      const taken = await http()
        .patch(`/garage/cars/${second.id}`)
        .set("X-Client", IOS)
        .set("Authorization", `Bearer ${token}`)
        .send({ levels: levelsFrom(atlas), color: null, vin: COOLRAY.vin });
      expect(taken.body).toMatchObject({ code: "GARAGE_VIN_TAKEN" });
      // Another account may have the same VIN (a car sold, a shared car).
      const other = await signIn("+77011570014");
      expect(
        (await addCar(other, { levels: levelsFrom(coolray), color: null, vin: COOLRAY.vin }))
          .status,
      ).toBe(201);
    });

    it("confirms a car later («Подтвердить техпаспортом») and keeps VIN and plate an old app does not send", async () => {
      const token = await signIn("+77011570015");
      const answer = await recognized("coolray-clean", { token });
      const car = accountCarSchema.parse(
        (
          await addCar(token, {
            levels: levelsFrom(answer),
            color: null,
            vin: COOLRAY.vin,
            plate: COOLRAY.plate,
            document: { status: "unconfirmed" },
          })
        ).body,
      );
      const patch = (body: Record<string, unknown>) =>
        http()
          .patch(`/garage/cars/${car.id}`)
          .set("X-Client", IOS)
          .set("Authorization", `Bearer ${token}`)
          .send(body);
      // An app from before TASK-057 changes the colour: VIN, plate and mark stay.
      const recolored = accountCarSchema.parse(
        (await patch({ levels: levelsFrom(answer), color: "red" })).body,
      );
      expect(recolored).toMatchObject({
        color: "red",
        vin: COOLRAY.vin,
        plate: COOLRAY.plate,
        document: { status: "unconfirmed" },
      });
      // «не подтверждён» sent again never lowers or changes anything.
      const confirmed = accountCarSchema.parse(
        (
          await patch({
            levels: levelsFrom(answer),
            color: "red",
            document: { status: "shown", proof: answer.documentProof },
          })
        ).body,
      );
      expect(confirmed.document?.status).toBe("shown");
      const kept = accountCarSchema.parse(
        (
          await patch({
            levels: levelsFrom(answer),
            color: "red",
            document: { status: "unconfirmed" },
            plate: null,
          })
        ).body,
      );
      expect(kept.document?.status).toBe("shown");
      expect(kept.plate).toBeNull();
    });

    it("transfers a guest's cars with VIN, plate and mark, merging by VIN and never failing on a bad proof", async () => {
      const deviceId = randomUUID();
      const coolray = await recognized("coolray-clean", { deviceId });
      const atlas = await recognized("atlas-clean", { deviceId });
      const token = await signIn("+77011570016");
      // The account already has the Coolray with the same VIN, chosen from the list.
      await addCar(token, {
        levels: { ...levelsFrom(coolray), engine: null },
        color: null,
        vin: COOLRAY.vin,
        document: { status: "unconfirmed" },
      });
      const body = {
        cars: [
          {
            levels: levelsFrom(coolray),
            color: "gray",
            vin: COOLRAY.vin,
            plate: COOLRAY.plate,
            document: { status: "shown", proof: coolray.documentProof },
            isPrimary: true,
          },
          {
            levels: levelsFrom(atlas),
            color: null,
            vin: "L6T79P4E5PE004567",
            plate: "123 KZA 01",
            document: { status: "shown", proof: "forged" },
            isPrimary: false,
          },
          {
            levels: levelsFrom(atlas),
            color: null,
            vin: "not a vin",
            plate: "nonsense",
            document: null,
            isPrimary: false,
          },
        ],
      };
      const transfer = () =>
        http()
          .post("/garage/transfer")
          .set("X-Client", IOS)
          .set("Authorization", `Bearer ${token}`)
          .send(body);
      const first = transferGarageResponseSchema.parse((await transfer()).body);
      // The Coolray merged by VIN (the account's had no engine — other levels).
      // The two Atlases: the second has no usable VIN, so it is the first by levels.
      expect(first.transferred).toBe(1);
      const merged = first.cars.find((car) => car.vin === COOLRAY.vin)!;
      expect(merged).toMatchObject({ plate: COOLRAY.plate, document: { status: "shown" } });
      const atlasCar = first.cars.find((car) => car.vin === "L6T79P4E5PE004567")!;
      expect(atlasCar).toMatchObject({ plate: "123KZA01", document: { status: "unconfirmed" } });
      // Idempotent.
      const again = transferGarageResponseSchema.parse((await transfer()).body);
      expect(again.transferred).toBe(0);
      expect(again.cars).toHaveLength(2);
    });

    it("lists for the admin the users with a car without a shown document", async () => {
      const shown = await signIn("+77011570020");
      const answer = await recognized("coolray-clean", { token: shown });
      await addCar(shown, {
        levels: levelsFrom(answer),
        color: null,
        document: { status: "shown", proof: answer.documentProof },
      });
      const unconfirmed = await signIn("+77011570021");
      await addCar(unconfirmed, {
        levels: levelsFrom(answer),
        color: null,
        document: { status: "unconfirmed" },
      });
      const old = await signIn("+77011570022");
      await addCar(old, { levels: levelsFrom(answer), color: null });

      const users = app.get(AdminUsersService);
      const page = await users.list({ unconfirmedCar: "true", expiringDays: 7, limit: 50 });
      const phones = page.users.map((user) => user.phone);
      expect(phones).toHaveLength(2);
      expect(phones.every((phone) => phone.endsWith("21") || phone.endsWith("22"))).toBe(true);
      const all = await users.list({ expiringDays: 7, limit: 50 });
      expect(all.users).toHaveLength(3);
      const garage = await users.garageOf(
        all.users.find((user) => user.phone.endsWith("20"))!.accountId,
      );
      expect(garage.cars[0]).toMatchObject({ document: { status: "shown" } });
    });
  });
});
