import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountCarSchema,
  accountProfileSchema,
  adminSupplierResponseSchema,
  adminUserGarageResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  garageReminderCarSchema,
  garageRemindersResponseSchema,
  supplierOfferResponseSchema,
  supplierOrderResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
  type GarageReminderCar,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import { DevCompatibilitySeed } from "../compatibility";
import { DevVehicleSeed } from "../vehicles";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { DevMaintenanceSeed } from "../maintenance";
import { DevSupplierSeed } from "../suppliers";
import { GarageRemind } from ".";

/**
 * TASK-069 end to end on a real PostgreSQL and Redis: the reminders of a
 * signed-in user's garage — the routes and who may call them, the count by
 * the schedule, an order (a service for its car, an item for the only car it
 * fits) and «Уже поменял», «Напомнить позже», the mileage question, the
 * switch of M-PRO-04, and the daily job: one push per element and its
 * replacement, the interval per car, the switch, a removed car.
 */

const ADMIN_PHONE = "+77011230690";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

type Method = "get" | "post" | "put" | "patch" | "delete";
type As = (method: Method, path: string, body?: object) => Test;

describe("reminders about a planned replacement (PostgreSQL + Redis)", () => {
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
  let phoneCounter = 0;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let admin: string;

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
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test-secret",
      S3_BUCKET: "test",
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
    await nest.listen(0, "127.0.0.1");
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    settings = new TestSettings(app);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await truncateAll(db);
    await redis.flushall();
    await settings.reload();
    output = captureOutput();
    admin = await setUpAdmin(ADMIN_PHONE);
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) rememberCode(sent.code);
  });

  // ------------------------------------------------------------- plumbing

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${String((ipCounter++ % 250) + 1)}`;

  function remember(body: unknown): void {
    const text = JSON.stringify(body ?? {});
    for (const match of text.matchAll(
      /"(accessToken|refreshToken|token|secret|otpauthUri)":"([^"]+)"/g,
    )) {
      rememberSecret(match[2]!);
    }
  }

  async function signIn(phone: string, client: string): Promise<Response> {
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
    remember(response.body);
    for (const cookie of ([] as string[]).concat(response.headers["set-cookie"] ?? [])) {
      const step = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(cookie);
      if (step) {
        rememberSecret(step[2]!);
        stepCookies.set(step[1]!, `adclub_sign_in_${step[1]}=${step[2]}`);
      }
      const refresh = /^adclub_(?:admin|supplier)_refresh=([^;]+)/.exec(cookie);
      if (refresh) rememberSecret(refresh[1]!);
    }
    if (client === IOS) {
      await completeTestRegistration((path) => http().post(path), client, response);
    }
    return response;
  }

  function stepPost(path: string, body: { signInStep: string; totpCode?: string }): Test {
    const stepId = /^st1\.([0-9a-f-]{36})\./.exec(body.signInStep)?.[1] ?? "";
    return http()
      .post(path)
      .set("X-Client", ADMIN_WEB)
      .set("X-Forwarded-For", nextIp())
      .set("Cookie", stepCookies.get(stepId) ?? "")
      .send(body);
  }

  function nextCode(secret: string): string {
    const now = authenticatorStep(Date.now());
    const step = Math.max(now, (lastSteps.get(secret) ?? now - 1) + 1);
    lastSteps.set(secret, step);
    const code = authenticatorCode(secret, step);
    rememberCode(code);
    return code;
  }

  async function setUpAdmin(phone: string): Promise<string> {
    await app.get(OperatorService).grantAdmin(phone);
    const start = await signIn(phone, ADMIN_WEB);
    expect(start.status).toBe(403);
    const step = totpStepRequiredDetailsSchema.parse(start.body.details).signInStep.token;
    const setupResponse = await stepPost("/auth/sign-in/totp/setup", { signInStep: step });
    remember(setupResponse.body);
    const setup = totpSetupResponseSchema.parse(setupResponse.body);
    const confirmed = await stepPost("/auth/sign-in/totp/setup/confirm", {
      signInStep: step,
      totpCode: nextCode(setup.secret),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) rememberCode(code, code.replace("-", ""));
    return body.session.accessToken;
  }

  async function sessionToken(phone: string, client: string): Promise<string> {
    const response = await signIn(phone, client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function call(
    bearer: string | null,
    client: string,
    method: Method,
    path: string,
    body?: object,
  ) {
    let test = http()[method](path).set("X-Client", client).set("X-Forwarded-For", nextIp());
    if (bearer) test = test.set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  const asAdmin: As = (method, path, body) => call(admin, ADMIN_WEB, method, path, body);

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  async function ok<T>(test: Test, parse: (body: unknown) => T, status = 200): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  async function idOf(query: string, params: unknown[] = []): Promise<string> {
    const { rows } = await db.query<{ id: string }>(query, params);
    expect(rows[0], query).toBeDefined();
    return rows[0]!.id;
  }

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]!.count);
  }

  // ---------------------------------------------------------------- world

  async function world() {
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    await app.get(DevCompatibilitySeed).run();
    await app.get(DevMaintenanceSeed).run();
    const geely = await idOf("SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely'");
    const model = (key: string) =>
      idOf("SELECT model_id AS id FROM vehicle_model_spelling WHERE key = $1", [key]);
    const engine = await idOf(
      "SELECT engine_id AS id FROM vehicle_engine_spelling WHERE key = 'jlh-3g15td'",
    );
    return {
      geely,
      coolray: await model("coolray"),
      atlas: await model("atlas"),
      engine,
      helix: await idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND lang = 'ru' AND text = 'Shell Helix HX8 5W-30, 4 л'",
      ),
      oilChange: await idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND lang = 'ru' AND text = 'Замена моторного масла'",
      ),
      oils: await idOf("SELECT id FROM category WHERE code = 'engine_oils'"),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** The example supplier open around the clock, selling the oil and the oil change. */
  async function sell(w: World) {
    const seeded = await app.get(DevSupplierSeed).run();
    const supplier = await ok(asAdmin("get", `/admin/suppliers/${seeded.supplierId}`), (body) =>
      adminSupplierResponseSchema.parse(body),
    );
    await ok(
      asAdmin("put", `/admin/suppliers/${seeded.supplierId}/schedule`, {
        expectedVersion: supplier.supplier.version,
        weeklyHours: ALWAYS,
        closedDates: [],
      }),
      (body) => body,
    );
    const member = await sessionToken(seeded.memberPhone, SUPPLIER_WEB);
    const shop: As = (method, path, body) => call(member, SUPPLIER_WEB, method, path, body);
    const offer = async (body: object) =>
      ok(
        shop("post", "/supplier/offers", body),
        (raw) => supplierOfferResponseSchema.parse(raw).offer,
        201,
      );
    const oil = await offer({
      itemId: w.helix,
      price: 9_700,
      availability: "in_stock",
      leadDays: 0,
      pickup: true,
      delivery: false,
    });
    const service = await offer({ itemId: w.oilChange, price: 7_000 });
    return {
      shop,
      oil,
      service,
      cityId: supplier.supplier.city.id,
      memberPhone: seeded.memberPhone,
    };
  }

  interface User {
    phone: string;
    accountId: string;
    as: As;
  }

  async function user(options: { clubAccess?: boolean } = {}): Promise<User> {
    const phone = `+7701000${String(3600 + ++phoneCounter).padStart(4, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    if (options.clubAccess) {
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          phone,
          validUntil: new Date(Date.now() + 30 * DAY).toISOString(),
          reason: "Тест",
        }),
        (body) => body,
        201,
      );
    }
    const accountId = await idOf("SELECT id FROM account WHERE phone = $1", [phone]);
    return { phone, accountId, as: (method, path, body) => call(bearer, IOS, method, path, body) };
  }

  async function addCar(who: User, w: World, modelId = w.coolray): Promise<string> {
    const coolray = modelId === w.coolray;
    return ok(
      who.as("post", "/garage/cars", {
        levels: {
          make: { id: w.geely, label: "Geely" },
          model: { id: modelId, label: coolray ? "Coolray" : "Atlas" },
          year: coolray ? 2024 : 2023,
          generation: null,
          body: null,
          engine: coolray ? { id: w.engine, label: "JLH-3G15TD" } : null,
          transmission: null,
          drive: null,
        },
        color: null,
      }),
      (body) => accountCarSchema.parse(body).id,
      201,
    );
  }

  /** A reading of the journal, recorded `daysAgo` days ago (moved by hand, as time would). */
  async function reading(who: User, carId: string, valueKm: number, daysAgo = 0) {
    await ok(
      who.as("post", `/garage/cars/${carId}/mileage`, {
        valueKm,
        source: "text",
        confirmLower: true,
      }),
      (body) => body,
    );
    if (daysAgo > 0) {
      await db.query(
        "UPDATE mileage_log SET recorded_at = now() - make_interval(days => $2) WHERE car_id = $1 AND value_km = $3",
        [carId, daysAgo, valueKm],
      );
    }
  }

  async function reminders(who: User, carId: string): Promise<GarageReminderCar> {
    const answer = await ok(who.as("get", "/garage/reminders"), (body) =>
      garageRemindersResponseSchema.parse(body),
    );
    const car = answer.cars.find((entry) => entry.carId === carId);
    expect(car).toBeDefined();
    return car!;
  }

  async function oilElement(who: User, carId: string) {
    const car = await reminders(who, carId);
    const oil = car.reminders.find((entry) => entry.title.text === "Моторное масло");
    expect(oil).toBeDefined();
    return { car, oil: oil! };
  }

  const remind = () =>
    app.get(GarageRemind).run({ jobId: "test", attempt: 1, signal: new AbortController().signal });

  async function pushes(accountId: string) {
    const { rows } = await db.query<{
      event_kind: string;
      template_code: string;
      payload: { target: unknown; variables: Record<string, string> };
    }>(
      "SELECT event_kind, template_code, payload FROM notification WHERE recipient_account_id = $1 ORDER BY created_at",
      [accountId],
    );
    return rows;
  }

  /** An order given out: in stock and picked up, or a visit marked done by the code. */
  async function finishedOrder(
    who: User,
    sold: Awaited<ReturnType<typeof sell>>,
    kind: "stock" | "service",
    carId?: string,
  ): Promise<{ id: string; number: number }> {
    const slot = Math.ceil((Date.now() + DAY) / (30 * 60 * 1000)) * 30 * 60 * 1000;
    const created = await ok(
      who.as(
        "post",
        "/orders",
        kind === "stock"
          ? {
              offerId: sold.oil.id,
              quantity: 1,
              fulfillment: "pickup",
              expectedPrice: 9_700,
              idempotencyKey: randomUUID(),
            }
          : {
              offerId: sold.service.id,
              expectedPrice: 7_000,
              idempotencyKey: randomUUID(),
              carId,
              desiredAt: new Date(slot).toISOString(),
            },
      ),
      (body) => createOrderResponseSchema.parse(body).order,
      201,
    );
    const code = created.confirmation!.code;
    rememberCode(code);
    rememberSecret(created.confirmation!.qrPayload);
    const card = await ok(
      sold.shop("get", `/supplier/orders/${created.id}`),
      (body) => supplierOrderResponseSchema.parse(body).order,
    );
    await ok(
      sold.shop("post", `/supplier/orders/${created.id}/accept`, { expectedVersion: card.version }),
      (body) => body,
    );
    if (kind === "service") {
      await db.query(
        "UPDATE customer_order SET visit_at = now() - interval '5 minutes', visit_until = now() + interval '1 hour' WHERE id = $1",
        [created.id],
      );
    }
    await ok(sold.shop("post", "/supplier/orders/close", { code }), (body) => body);
    expect(await count("customer_order", "id = $1 AND status = 'completed'", [created.id])).toBe(1);
    return { id: created.id, number: created.number };
  }

  // ----------------------------------------------------------------- tests

  it("is for a signed-in user's own cars only (401, 403, 404)", async () => {
    const w = await world();
    const owner = await user();
    const carId = await addCar(owner, w);
    const { oil } = await oilElement(owner, carId);
    const other = await user();
    const supplierPhone = (await app.get(DevSupplierSeed).run()).memberPhone;
    const supplier = await sessionToken(supplierPhone, SUPPLIER_WEB);

    expectError(await call(null, IOS, "get", "/garage/reminders"), 401, "AUTH_REQUIRED");
    expectError(await call(supplier, SUPPLIER_WEB, "get", "/garage/reminders"), 403, "FORBIDDEN");
    expectError(await asAdmin("get", "/garage/reminders"), 403, "FORBIDDEN");
    for (const path of [
      `/garage/cars/${carId}/reminders/${oil.planItemId}/done`,
      `/garage/cars/${carId}/reminders/${oil.planItemId}/snooze`,
      `/garage/cars/${carId}/mileage-question/dismiss`,
    ]) {
      expectError(await call(null, IOS, "post", path, {}), 401, "AUTH_REQUIRED");
      expectError(await other.as("post", path, {}), 404, "NOT_FOUND");
    }
    // An element that is not of this car's plan answers like a missing one.
    expectError(
      await owner.as("post", `/garage/cars/${carId}/reminders/${randomUUID()}/snooze`),
      404,
      "NOT_FOUND",
    );
    expect(await count("maintenance_reminder")).toBe(0);
    // The other user sees only their own (empty) garage.
    expect(
      (await ok(other.as("get", "/garage/reminders"), garageRemindersResponseSchema.parse)).cars,
    ).toEqual([]);
  });

  it("counts by the schedule with an estimate of the mileage and opens «Подобрать» by the plan's answer", async () => {
    const w = await world();
    const sold = await sell(w);
    const owner = await user();
    await ok(owner.as("patch", "/account/profile", { cityId: sold.cityId }), (body) => body);
    const carId = await addCar(owner, w);
    // No reading yet: nothing to count by the mileage, and the mileage is asked.
    expect((await reminders(owner, carId)).askMileage).toBe(true);

    await reading(owner, carId, 24_600, 100);
    await reading(owner, carId, 29_000, 20);
    const { car, oil } = await oilElement(owner, carId);
    // 4 400 km in 80 days, 20 days since: about 30 100.
    expect(car).toMatchObject({
      hasPlan: true,
      estimated: true,
      askMileage: false,
      lastMileageKm: 29_000,
    });
    expect(car.currentKm).toBe(30_100);
    expect(oil).toMatchObject({
      state: "due",
      reason: "km",
      dueKm: 30_000,
      elapsedKm: 10_100,
      basis: { source: "schedule", atKm: 20_000 },
    });
    // «Подобрать» — the answer of the maintenance plan for its rule, counted by the client list.
    expect(oil.catalog).toMatchObject({ unavailable: false, categoryId: w.oils });
    expect(oil.catalog!.count).toBeGreaterThanOrEqual(1);
    expect(oil.catalog!.minPrice).toBe(9_700);
    expect(oil.catalog!.filters).toHaveLength(2);
    // The card is the most overdue due element.
    const top = car.reminders.find((entry) => entry.planItemId === car.topPlanItemId)!;
    for (const entry of car.reminders.filter((item) => item.state === "due")) {
      expect(entry.state).toBe("due");
    }
    expect(top.state).toBe("due");
    // What is not due carries no «Подобрать».
    for (const entry of car.reminders.filter((item) => item.state === "waiting")) {
      expect(entry.catalog).toBeNull();
    }
  });

  it("«Уже поменял» marks the replacement at the corrected mileage, once, and lower only with confirmLower", async () => {
    const w = await world();
    const owner = await user();
    const carId = await addCar(owner, w);
    await reading(owner, carId, 24_600, 100);
    await reading(owner, carId, 30_100, 1);
    const { oil } = await oilElement(owner, carId);
    expect(oil.state).toBe("due");
    const path = `/garage/cars/${carId}/reminders/${oil.planItemId}/done`;

    expectError(await owner.as("post", path, { mileageKm: 29_000 }), 409, "GARAGE_MILEAGE_LOWER");
    const done = await ok(owner.as("post", path, { mileageKm: 31_000 }), (body) =>
      garageReminderCarSchema.parse(body),
    );
    const marked = done.reminders.find((entry) => entry.planItemId === oil.planItemId)!;
    expect(marked).toMatchObject({
      state: "waiting",
      dueKm: 41_000,
      elapsedKm: 0,
      basis: { source: "user", atKm: 31_000 },
    });
    expect(await count("mileage_log", "car_id = $1 AND value_km = 31000", [carId])).toBe(1);
    const first = await db.query<{ done_at: Date }>(
      "SELECT done_at FROM maintenance_reminder WHERE car_id = $1 AND plan_item_id = $2",
      [carId, oil.planItemId],
    );
    // Pressed twice: one replacement.
    await ok(owner.as("post", path, {}), (body) => body);
    const again = await db.query<{ done_at: Date; done_km: number }>(
      "SELECT done_at, done_km FROM maintenance_reminder WHERE car_id = $1 AND plan_item_id = $2",
      [carId, oil.planItemId],
    );
    expect(again.rows).toHaveLength(1);
    expect(again.rows[0]!.done_at.toISOString()).toBe(first.rows[0]!.done_at.toISOString());
    expect(again.rows[0]!.done_km).toBe(31_000);
  });

  it("«Напомнить позже» holds a reminder for reminder_snooze_days; «Не сейчас» puts the question off till tomorrow", async () => {
    const w = await world();
    const owner = await user();
    const carId = await addCar(owner, w);
    await reading(owner, carId, 24_600, 100);
    await reading(owner, carId, 30_100, 40);
    const { car, oil } = await oilElement(owner, carId);
    expect(car.askMileage).toBe(true);
    const snoozed = await ok(
      owner.as("post", `/garage/cars/${carId}/reminders/${oil.planItemId}/snooze`),
      (body) => garageReminderCarSchema.parse(body),
    );
    const entry = snoozed.reminders.find((item) => item.planItemId === oil.planItemId)!;
    expect(entry.state).toBe("snoozed");
    expect(entry.catalog).not.toBeNull();
    expect(Date.parse(entry.snoozedUntil!) - Date.now()).toBeGreaterThan(7 * DAY - HOUR);
    expect(Date.parse(entry.snoozedUntil!) - Date.now()).toBeLessThan(7 * DAY + HOUR);
    expect(snoozed.topPlanItemId).not.toBe(oil.planItemId);

    // The same mileage again writes no reading (TASK-058) but answers the question.
    await ok(
      owner.as("post", `/garage/cars/${carId}/mileage`, { valueKm: 30_100, source: "text" }),
      (body) => body,
    );
    expect(await count("mileage_log", "car_id = $1", [carId])).toBe(2);
    expect((await reminders(owner, carId)).askMileage).toBe(false);
    await db.query("UPDATE account_car SET mileage_confirmed_at = NULL WHERE id = $1", [carId]);
    expect((await reminders(owner, carId)).askMileage).toBe(true);

    const dismissed = await ok(
      owner.as("post", `/garage/cars/${carId}/mileage-question/dismiss`),
      (body) => garageReminderCarSchema.parse(body),
    );
    expect(dismissed.askMileage).toBe(false);
    const { rows } = await db.query<{ until: Date }>(
      "SELECT mileage_question_dismissed_until AS until FROM account_car WHERE id = $1",
      [carId],
    );
    const left = rows[0]!.until.getTime() - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(DAY);
    // 00:00 in Almaty is 19:00 UTC.
    expect(rows[0]!.until.toISOString()).toMatch(/T19:00:00\.000Z$/);
  });

  it("an order on a service counts for its car; an item — for the only car it fits", async () => {
    const w = await world();
    const sold = await sell(w);
    const owner = await user({ clubAccess: true });
    const coolray = await addCar(owner, w);
    const atlas = await addCar(owner, w, w.atlas);
    await reading(owner, coolray, 24_600, 100);
    await reading(owner, coolray, 30_100, 1);

    const service = await finishedOrder(owner, sold, "service", coolray);
    const stock = await finishedOrder(owner, sold, "stock");
    const car = await reminders(owner, coolray);
    const change = car.reminders.find((entry) => entry.title.text === "Замена моторного масла")!;
    expect(change.basis).toMatchObject({
      source: "order",
      orderId: service.id,
      orderNumber: service.number,
      atKm: 30_100,
    });
    expect(change.state).toBe("waiting");
    const oil = car.reminders.find((entry) => entry.title.text === "Моторное масло")!;
    // The oil fits the Coolray with its engine and not the Atlas: the Coolray's replacement.
    expect(oil.basis).toMatchObject({
      source: "order",
      orderId: stock.id,
      orderNumber: stock.number,
    });
    // The Atlas has a plan of its make; nothing of the orders is its.
    const other = await reminders(owner, atlas);
    expect(other.reminders.every((entry) => entry.basis.source !== "order")).toBe(true);
  });

  it("an item that fits two cars of the garage marks no replacement", async () => {
    const w = await world();
    const sold = await sell(w);
    const owner = await user({ clubAccess: true });
    const first = await addCar(owner, w);
    const second = await addCar(owner, w);
    await reading(owner, first, 24_600, 100);
    await reading(owner, first, 30_100, 1);
    await finishedOrder(owner, sold, "stock");
    for (const carId of [first, second]) {
      const { oil } = await oilElement(owner, carId);
      expect(oil.basis.source).toBe("schedule");
    }
  });

  it("the daily job: one push per element and replacement, the interval per car, the question once", async () => {
    const w = await world();
    const owner = await user();
    const carId = await addCar(owner, w);
    await reading(owner, carId, 24_600, 100);
    await reading(owner, carId, 30_100, 1);
    await remind();
    let sent = await pushes(owner.accountId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_kind: "maintenance_reminder",
      template_code: "maintenance_reminder",
      payload: {
        target: { screen: "catalog", params: { carId } },
        variables: { car: "Geely Coolray 2024" },
      },
    });
    const pushedItem = await db.query<{ plan_item_id: string }>(
      "SELECT plan_item_id FROM maintenance_reminder WHERE car_id = $1 AND notified_at IS NOT NULL",
      [carId],
    );
    expect(pushedItem.rows).toHaveLength(1);
    // What the count was from is kept for every element (the admin's view).
    expect(
      await count("maintenance_reminder", "car_id = $1 AND last_source = 'schedule'", [carId]),
    ).toBeGreaterThan(1);

    // The same day again: nothing new.
    await remind();
    expect(await pushes(owner.accountId)).toHaveLength(1);

    // After the interval — the next element due, not the one already pushed.
    await db.query(
      "UPDATE maintenance_reminder SET notified_at = notified_at - interval '4 days' WHERE car_id = $1",
      [carId],
    );
    await remind();
    sent = await pushes(owner.accountId);
    expect(sent).toHaveLength(2);
    expect(
      await count("maintenance_reminder", "car_id = $1 AND notified_at IS NOT NULL", [carId]),
    ).toBe(2);
    expect(sent[1]!.payload.variables.what).not.toBe(sent[0]!.payload.variables.what);

    // «Напомнить позже» on the first one: once the snooze is over, a push again.
    await ok(
      owner.as(
        "post",
        `/garage/cars/${carId}/reminders/${pushedItem.rows[0]!.plan_item_id}/snooze`,
      ),
      (body) => garageReminderCarSchema.parse(body),
    );
    await db.query(
      `UPDATE maintenance_reminder SET snoozed_until = now() - interval '1 minute',
         notified_at = notified_at - interval '4 days' WHERE car_id = $1`,
      [carId],
    );
    await remind();
    sent = await pushes(owner.accountId);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.payload.variables.what).toBe(sent[0]!.payload.variables.what);

    // The mileage question: a car without readings, once per mileage_ask_days.
    const second = await addCar(owner, w);
    await remind();
    await remind();
    const questions = (await pushes(owner.accountId)).filter(
      (row) => row.event_kind === "mileage_request",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      template_code: "mileage_request",
      payload: { target: { screen: "catalog", params: { carId: second } } },
    });
  });

  it("the switch of M-PRO-04 turns off the cards and the pushes; a removed car takes its reminders", async () => {
    const w = await world();
    const owner = await user();
    const carId = await addCar(owner, w);
    await reading(owner, carId, 24_600, 100);
    await reading(owner, carId, 30_100, 1);

    const off = await ok(
      owner.as("patch", "/account/profile", { remindersEnabled: false }),
      (body) => accountProfileSchema.parse(body),
    );
    expect(off.remindersEnabled).toBe(false);
    expect(
      await ok(owner.as("get", "/garage/reminders"), garageRemindersResponseSchema.parse),
    ).toEqual({
      enabled: false,
      cars: [],
    });
    await remind();
    expect(await pushes(owner.accountId)).toHaveLength(0);

    await ok(owner.as("patch", "/account/profile", { remindersEnabled: true }), (body) => body);
    const { oil } = await oilElement(owner, carId);
    await ok(
      owner.as("post", `/garage/cars/${carId}/reminders/${oil.planItemId}/snooze`),
      (body) => body,
    );
    expect(await count("maintenance_reminder", "car_id = $1", [carId])).toBe(1);
    await ok(owner.as("delete", `/garage/cars/${carId}`), (body) => body);
    expect(await count("maintenance_reminder", "car_id = $1", [carId])).toBe(0);
    await remind();
    expect(await pushes(owner.accountId)).toHaveLength(0);
  });

  it("the admin panel sees each car's reminders with the source of the last replacement", async () => {
    const w = await world();
    const owner = await user();
    const carId = await addCar(owner, w);
    await reading(owner, carId, 24_600, 100);
    await reading(owner, carId, 30_100, 1);
    const { oil } = await oilElement(owner, carId);
    await ok(
      owner.as("post", `/garage/cars/${carId}/reminders/${oil.planItemId}/done`, {}),
      (body) => body,
    );
    const garage = await ok(asAdmin("get", `/admin/users/${owner.accountId}/garage`), (body) =>
      adminUserGarageResponseSchema.parse(body),
    );
    expect(garage.cars.map((car) => car.id)).toEqual([carId]);
    const seen = garage.reminders[0]!.reminders.find(
      (entry) => entry.planItemId === oil.planItemId,
    )!;
    expect(seen).toMatchObject({ basis: { source: "user" }, catalog: null });
    expect(seen.basis.atKm).toBeGreaterThanOrEqual(30_100);
  });
});
