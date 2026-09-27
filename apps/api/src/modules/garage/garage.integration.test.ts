import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountCarSchema,
  garageCarsResponseSchema,
  loginCodeVerifiedResponseSchema,
  transferGarageResponseSchema,
  type CarLevels,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../identity";

/**
 * The account's own garage (TASK-029, ARCHITECTURE 4.41), on a real
 * PostgreSQL and Redis: ownership (another account's car is a 404, never a
 * 403 or a peek at its data), CRUD and the primary car rule, the size limit,
 * and the merge-without-duplicates transfer — idempotent, keeps an existing
 * primary, and safe when two devices of one account transfer at once.
 */

const IOS = "mobile/1.4.2 (ios)";

function level(id: string, label: string) {
  return { id, label };
}

// Random, but stable for the file (the vehicle catalog's own ids are UUIDs,
// and `carLevelValueSchema.id` is `z.uuid()` — a fixture must be a real one,
// not a look-alike: RFC 4122 also fixes the version and variant nibbles.
const GEELY_ID = randomUUID();
const ATLAS_MODEL_ID = randomUUID();
const ATLAS_GENERATION_ID = randomUUID();
const ATLAS_BODY_ID = randomUUID();
const ATLAS_ENGINE_ID = randomUUID();
const ATLAS_TRANSMISSION_ID = randomUUID();
const ATLAS_DRIVE_ID = randomUUID();
const COOLRAY_MODEL_ID = randomUUID();

const ATLAS: CarLevels = {
  make: level(GEELY_ID, "Geely"),
  model: level(ATLAS_MODEL_ID, "Atlas"),
  year: 2023,
  generation: level(ATLAS_GENERATION_ID, "II"),
  body: level(ATLAS_BODY_ID, "Кроссовер"),
  engine: level(ATLAS_ENGINE_ID, "2.0T"),
  transmission: level(ATLAS_TRANSMISSION_ID, "Автомат"),
  drive: level(ATLAS_DRIVE_ID, "Полный"),
};

const COOLRAY: CarLevels = {
  make: level(GEELY_ID, "Geely"),
  model: level(COOLRAY_MODEL_ID, "Coolray"),
  year: 2022,
  generation: null,
  body: null,
  engine: null,
  transmission: null,
  drive: null,
};

describe("account garage (PostgreSQL + Redis)", () => {
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
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
    });
    const nest = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    app = nest;
    settings = new TestSettings(app);
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  /**
   * `account_car` carries real foreign keys to `vehicle_make`, `vehicle_model`,
   * `vehicle_generation` and `vehicle_engine` (not to the option tables of
   * body/transmission/drive — the migration's own note explains why): the
   * fixtures below must name rows that really exist, not just look like
   * UUIDs. `vehicle_option` here is only the fuel `vehicle_engine.fuel_id`
   * itself needs.
   */
  async function seedVehicleCatalog(): Promise<void> {
    await db.query(
      `INSERT INTO vehicle_make (id) VALUES ($1)`,
      [GEELY_ID],
    );
    await db.query(
      `INSERT INTO vehicle_model (id, make_id) VALUES ($1, $2), ($3, $2)`,
      [ATLAS_MODEL_ID, GEELY_ID, COOLRAY_MODEL_ID],
    );
    await db.query(
      `INSERT INTO vehicle_generation (id, model_id, name, name_key, year_from)
       VALUES ($1, $2, 'II', 'ii', 2023)`,
      [ATLAS_GENERATION_ID, ATLAS_MODEL_ID],
    );
    const fuelId = randomUUID();
    await db.query(
      `INSERT INTO vehicle_option (id, kind, code, name_ru) VALUES ($1, 'fuel', 'petrol_test', 'Бензин')`,
      [fuelId],
    );
    await db.query(`INSERT INTO vehicle_engine (id, fuel_id) VALUES ($1, $2)`, [
      ATLAS_ENGINE_ID,
      fuelId,
    ]);
  }

  beforeEach(async () => {
    channels.sent.length = 0;
    await db.query(TRUNCATE_ALL);
    await redis.flushall();
    await settings.reload();
    await seedVehicleCatalog();
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  function remember(body: unknown): void {
    const text = JSON.stringify(body ?? {});
    for (const match of text.matchAll(/"(accessToken|refreshToken|token)":"([^"]+)"/g)) {
      rememberSecret(match[2]!);
    }
  }

  /** A fresh account, signed in as the mobile app; returns its access token. */
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
    remember(response.body);
    return loginCodeVerifiedResponseSchema.parse(response.body).session.accessToken;
  }

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function addCar(token: string, levels: CarLevels, color: string | null = null): Promise<Response> {
    return http()
      .post("/garage/cars")
      .set("X-Client", IOS)
      .set(bearer(token))
      .send({ levels, color });
  }

  it("returns an empty garage for a freshly signed-in account", async () => {
    const token = await signIn("+77011230001");
    const response = await http().get("/garage/cars").set("X-Client", IOS).set(bearer(token));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(garageCarsResponseSchema.parse(response.body)).toEqual({ cars: [] });
  });

  it("makes the first car primary, and the second one not", async () => {
    const token = await signIn("+77011230002");
    const first = await addCar(token, ATLAS, "white");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstCar = accountCarSchema.parse(first.body);
    expect(firstCar.isPrimary).toBe(true);
    expect(firstCar.color).toBe("white");
    expect(firstCar.make).toEqual(ATLAS.make);

    const second = await addCar(token, COOLRAY);
    expect(second.status).toBe(201);
    expect(accountCarSchema.parse(second.body).isPrimary).toBe(false);

    const list = await http().get("/garage/cars").set("X-Client", IOS).set(bearer(token));
    const cars = garageCarsResponseSchema.parse(list.body).cars;
    expect(cars).toHaveLength(2);
  });

  it("replaces the levels and colour of an owned car", async () => {
    const token = await signIn("+77011230003");
    const created = accountCarSchema.parse((await addCar(token, COOLRAY)).body);
    const updated = await http()
      .patch(`/garage/cars/${created.id}`)
      .set("X-Client", IOS)
      .set(bearer(token))
      .send({ levels: ATLAS, color: "red" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const car = accountCarSchema.parse(updated.body);
    expect(car.id).toBe(created.id);
    expect(car.model).toEqual(ATLAS.model);
    expect(car.color).toBe("red");
    // Still the only (and therefore primary) car: replacing levels never
    // touches which car is primary.
    expect(car.isPrimary).toBe(true);
  });

  it("moves primary to the oldest remaining car when the primary one is removed", async () => {
    const token = await signIn("+77011230004");
    const first = accountCarSchema.parse((await addCar(token, ATLAS)).body);
    const second = accountCarSchema.parse((await addCar(token, COOLRAY)).body);
    expect(first.isPrimary).toBe(true);

    const removed = await http()
      .delete(`/garage/cars/${first.id}`)
      .set("X-Client", IOS)
      .set(bearer(token));
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({ removed: true });

    const list = garageCarsResponseSchema.parse(
      (await http().get("/garage/cars").set("X-Client", IOS).set(bearer(token))).body,
    );
    expect(list.cars).toHaveLength(1);
    expect(list.cars[0]!.id).toBe(second.id);
    expect(list.cars[0]!.isPrimary).toBe(true);
  });

  it("lets a car be made primary explicitly", async () => {
    const token = await signIn("+77011230005");
    const first = accountCarSchema.parse((await addCar(token, ATLAS)).body);
    const second = accountCarSchema.parse((await addCar(token, COOLRAY)).body);
    const response = await http()
      .post(`/garage/cars/${second.id}/primary`)
      .set("X-Client", IOS)
      .set(bearer(token));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(accountCarSchema.parse(response.body).isPrimary).toBe(true);

    const list = garageCarsResponseSchema.parse(
      (await http().get("/garage/cars").set("X-Client", IOS).set(bearer(token))).body,
    );
    const byId = new Map(list.cars.map((car) => [car.id, car]));
    expect(byId.get(second.id)!.isPrimary).toBe(true);
    expect(byId.get(first.id)!.isPrimary).toBe(false);
  });

  it("never distinguishes another account's car from one that doesn't exist", async () => {
    const ownerToken = await signIn("+77011230006");
    const strangerToken = await signIn("+77011230007");
    const car = accountCarSchema.parse((await addCar(ownerToken, ATLAS)).body);

    const patch = await http()
      .patch(`/garage/cars/${car.id}`)
      .set("X-Client", IOS)
      .set(bearer(strangerToken))
      .send({ levels: COOLRAY, color: null });
    expect(patch.status).toBe(404);

    const del = await http()
      .delete(`/garage/cars/${car.id}`)
      .set("X-Client", IOS)
      .set(bearer(strangerToken));
    expect(del.status).toBe(404);

    const primary = await http()
      .post(`/garage/cars/${car.id}/primary`)
      .set("X-Client", IOS)
      .set(bearer(strangerToken));
    expect(primary.status).toBe(404);

    // The stranger's own (empty) garage is unaffected.
    const strangerList = garageCarsResponseSchema.parse(
      (await http().get("/garage/cars").set("X-Client", IOS).set(bearer(strangerToken))).body,
    );
    expect(strangerList.cars).toHaveLength(0);

    // A made-up id answers exactly the same way (404, not 403).
    const madeUp = await http()
      .delete(`/garage/cars/${randomUUID()}`)
      .set("X-Client", IOS)
      .set(bearer(ownerToken));
    expect(madeUp.status).toBe(404);
  });

  it("refuses to add a car once the account is at the settings limit", async () => {
    await settings.set({ garage_max_cars: 1 });
    const token = await signIn("+77011230008");
    const first = await addCar(token, ATLAS);
    expect(first.status).toBe(201);
    const second = await addCar(token, COOLRAY);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("GARAGE_LIMIT_REACHED");
  });

  describe("transfer", () => {
    it("merges cars in without duplicates, keeping the device's chosen primary", async () => {
      const token = await signIn("+77011230010");
      const response = await http()
        .post("/garage/transfer")
        .set("X-Client", IOS)
        .set(bearer(token))
        .send({
          cars: [
            { levels: ATLAS, color: "white", isPrimary: true },
            { levels: COOLRAY, color: null, isPrimary: false },
          ],
        });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = transferGarageResponseSchema.parse(response.body);
      expect(result.transferred).toBe(2);
      expect(result.cars).toHaveLength(2);
      const primary = result.cars.find((car) => car.isPrimary);
      expect(primary?.model).toEqual(ATLAS.model);
    });

    it("is idempotent: transferring the same cars again changes nothing", async () => {
      const token = await signIn("+77011230011");
      const body = {
        cars: [
          { levels: ATLAS, color: "white", isPrimary: true },
          { levels: COOLRAY, color: null, isPrimary: false },
        ],
      };
      await http().post("/garage/transfer").set("X-Client", IOS).set(bearer(token)).send(body);
      const again = await http()
        .post("/garage/transfer")
        .set("X-Client", IOS)
        .set(bearer(token))
        .send(body);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const result = transferGarageResponseSchema.parse(again.body);
      expect(result.transferred).toBe(0);
      expect(result.cars).toHaveLength(2);
    });

    it("dedupes against a car already added directly, by levels only (colour ignored)", async () => {
      const token = await signIn("+77011230012");
      await addCar(token, ATLAS, "white");
      const response = await http()
        .post("/garage/transfer")
        .set("X-Client", IOS)
        .set(bearer(token))
        .send({ cars: [{ levels: ATLAS, color: "red", isPrimary: true }] });
      const result = transferGarageResponseSchema.parse(response.body);
      expect(result.transferred).toBe(0);
      expect(result.cars).toHaveLength(1);
      // The existing car's own colour is untouched by the transfer's guess.
      expect(result.cars[0]!.color).toBe("white");
    });

    it("does not move primary to the device's car when the account already has one", async () => {
      const token = await signIn("+77011230013");
      const existing = accountCarSchema.parse((await addCar(token, ATLAS)).body);
      expect(existing.isPrimary).toBe(true);

      const response = await http()
        .post("/garage/transfer")
        .set("X-Client", IOS)
        .set(bearer(token))
        .send({ cars: [{ levels: COOLRAY, color: null, isPrimary: true }] });
      const result = transferGarageResponseSchema.parse(response.body);
      expect(result.transferred).toBe(1);
      const byModel = new Map(result.cars.map((car) => [car.model.id, car]));
      expect(byModel.get(ATLAS.model.id)!.isPrimary).toBe(true);
      expect(byModel.get(COOLRAY.model.id)!.isPrimary).toBe(false);
    });

    it("merges three guest cars against two the account already has, adding only the new one", async () => {
      const token = await signIn("+77011230014");
      const THIRD: CarLevels = { ...COOLRAY, year: 2019 };
      await addCar(token, ATLAS);
      await addCar(token, COOLRAY);
      const response = await http()
        .post("/garage/transfer")
        .set("X-Client", IOS)
        .set(bearer(token))
        .send({
          cars: [
            { levels: ATLAS, color: null, isPrimary: true },
            { levels: COOLRAY, color: null, isPrimary: false },
            { levels: THIRD, color: null, isPrimary: false },
          ],
        });
      const result = transferGarageResponseSchema.parse(response.body);
      expect(result.transferred).toBe(1);
      expect(result.cars).toHaveLength(3);
    });

    it("keeps exactly one car when two devices of one account transfer the same guest garage at once", async () => {
      const token = await signIn("+77011230015");
      const body = { cars: [{ levels: ATLAS, color: "white", isPrimary: true }] };
      const [a, b] = await Promise.all([
        http().post("/garage/transfer").set("X-Client", IOS).set(bearer(token)).send(body),
        http().post("/garage/transfer").set("X-Client", IOS).set(bearer(token)).send(body),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const list = garageCarsResponseSchema.parse(
        (await http().get("/garage/cars").set("X-Client", IOS).set(bearer(token))).body,
      );
      // The account row lock serializes the two transfers: one after the
      // other, never two racing inserts of the same car.
      expect(list.cars).toHaveLength(1);
    });

    it("never fails outright at the size limit — it merges as many as fit", async () => {
      await settings.set({ garage_max_cars: 1 });
      const token = await signIn("+77011230016");
      const response = await http()
        .post("/garage/transfer")
        .set("X-Client", IOS)
        .set(bearer(token))
        .send({
          cars: [
            { levels: ATLAS, color: null, isPrimary: true },
            { levels: COOLRAY, color: null, isPrimary: false },
          ],
        });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = transferGarageResponseSchema.parse(response.body);
      expect(result.transferred).toBe(1);
      expect(result.cars).toHaveLength(1);
    });
  });

  it("refuses every garage route to a session without a token", async () => {
    const response = await http().get("/garage/cars").set("X-Client", IOS);
    expect(response.status).toBe(401);
  });
});
