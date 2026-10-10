import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountCarSchema,
  activeOrdersResponseSchema,
  adminCatalogItemPageSchema,
  adminCityResponseSchema,
  adminOrderPageSchema,
  adminOrderResponseSchema,
  adminSignalPageSchema,
  adminSupplierResponseSchema,
  closeOrderResponseSchema,
  createOrderResponseSchema,
  offerVisitOptionsSchema,
  orderLookupResponseSchema,
  orderStateConflictDetailsSchema,
  ORDER_QR_PREFIX,
  supplierMemberAddedResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderPageSchema,
  supplierOrderResponseSchema,
  supplierOrderTimeOptionsSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  userOrderResponseSchema,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
  type UserOrder,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import type { z } from "zod";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { WHATSAPP_WEBHOOK_PATH } from "../../common/http";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { SweepRunner, type JobRegistry, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import {
  allOutput,
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { MessageChannel, webhookSignatureHeader, type TestMessageChannel } from "../messaging";
import { DevVehicleSeed } from "../vehicles";
import { OrderDeadlineSweeper, orderDeadlinesJob } from "./order-deadlines";
import { OrderTransitions } from "./order-transitions";

/**
 * TASK-038 end to end on a real PostgreSQL and Redis, with the real API and
 * **two** real workers: an order on a service (ARCHITECTURE 6.3) — a car of
 * the garage and the time asked for, W-01b with «Подтвердить время», the
 * confirmation by the button and in the cabinet, another time proposed in
 * the cabinet, the user's «yes» (W-02 to the employee who proposed it, the
 * phone opens), «no» (W-04) and silence (expired once, whichever process gets
 * there), the visit closed by the code, a no-show with its discipline mark,
 * a visit nobody resolved (one expiry, one signal, a late close), the races
 * of the button and the cabinet in rounds, the time judged by the point's
 * hours, who may do what, and what each side sees. **Nothing here reaches a
 * network**: the channel is the test one.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const OIL_CHANGE = "Замена моторного масла";
const PADS = "04465-0K090";
const HOUR = 3_600_000;
const MINUTE = 60_000;
const COOLRAY_PRICE = 8_000;
const ATLAS_PRICE = 10_000;

type Method = "get" | "post" | "put" | "patch" | "delete";

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

/** Around the clock every day: any later whole minute is a time of a visit. */
const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

/** 09:00–18:00 from Monday to Saturday, Sunday off. */
const DAYTIME: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day === 7 ? [] : [{ from: "09:00", to: "18:00" }],
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A whole minute `minutes` from now, as the app sends a time. */
function inMinutes(minutes: number): string {
  const at = Date.now() + minutes * MINUTE;
  return new Date(Math.ceil(at / MINUTE) * MINUTE).toISOString();
}

/** The calendar date in Almaty (UTC+5) `days` after today. */
function almatyDate(days: number): string {
  return new Date(Date.now() + 5 * HOUR + days * 24 * HOUR).toISOString().slice(0, 10);
}

/** A local time of Almaty on a date, as an instant. */
function almatyAt(date: string, time: string): string {
  return new Date(`${date}T${time}:00+05:00`).toISOString();
}

/** «15:00» of an instant in Almaty. */
function almatyClock(iso: string): string {
  return new Date(Date.parse(iso) + 5 * HOUR).toISOString().slice(11, 16);
}

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) {
      return `${prefix}${digit}`;
    }
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

interface MessageRow {
  id: string;
  template: string;
  lang: string;
  phone: string;
  variables: Record<string, string> | null;
  button_payloads: Record<string, string> | null;
  status: string;
  provider_message_id: string | null;
}

describe("orders on services: the time, its answers, the visit and its deadlines (PostgreSQL + Redis, API and two workers)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker1: INestApplicationContext;
  let worker2: INestApplicationContext;
  let settings: TestSettings;
  let logins: TestLoginCodeChannels;
  let channels: TestMessageChannel[];
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let almaty: string;
  let serviceId: string;
  let padsId: string;
  let models: { geely: string; coolray: string; atlas: string; monjaro: string };
  let token: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  /** Every confirmation code handed out in this file. */
  const codes = new Set<string>();

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
    });
    rememberSecret(config.messaging.whatsapp.appSecret, config.session.tokenSecret);
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.listen(0, "127.0.0.1");
    app = nest;
    logins = app.get(LoginCodeChannels) as TestLoginCodeChannels;
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
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    for (const channel of channels) {
      channel.sent.length = 0;
      channel.mode = "ok";
      channel.refusedPhones.clear();
    }
    logins.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    // The workers are live and poll the tables; an emptying that loses a
    // deadlock to one of them is simply tried again.
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
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
    await settings.reload();
    await configure({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      message_retry_delay_seconds: 1,
    });
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
    almaty = await ok(
      asAdmin("post", "/admin/cities", { code: "almaty", names: { ru: "Алматы", kk: "Алматы" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    serviceId = await ok(
      asAdmin("get", `/admin/catalog/items?q=${encodeURIComponent(OIL_CHANGE)}`),
      (body) => adminCatalogItemPageSchema.parse(body).items[0]!.id,
    );
    padsId = await idOf(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      ["geely", normalizeArticle(PADS)],
    );
    const model = (key: string) =>
      idOf("SELECT model_id AS id FROM vehicle_model_spelling WHERE key = $1", [key]);
    const coolray = await model("coolray");
    models = {
      coolray,
      atlas: await model("atlas"),
      monjaro: await model("monjaro"),
      geely: await idOf("SELECT make_id AS id FROM vehicle_model WHERE id = $1", [coolray]),
    };
  }, 120_000);

  afterEach(() => {
    output.stop();
    for (const sent of logins.sent) {
      rememberCode(sent.code);
    }
  });

  // ------------------------------------------------------------- plumbing

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${String((ipCounter++ % 250) + 1)}`;
  const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;

  async function configure(values: Parameters<TestSettings["set"]>[0]): Promise<void> {
    await settings.set(values);
    await sleep(250);
  }

  async function waitFor<T>(
    what: string,
    probe: () => Promise<T | undefined | false>,
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

  function remember(body: unknown): void {
    const text = JSON.stringify(body ?? {});
    for (const match of text.matchAll(
      /"(accessToken|refreshToken|token|secret|otpauthUri)":"([^"]+)"/g,
    )) {
      rememberSecret(match[2]!);
    }
  }

  async function signIn(phone: string, client: string): Promise<Response> {
    rememberCode(phone);
    await redis.del(`rl:login-code:resend:${phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const code = logins.sent.filter((message) => message.phone === phone).at(-1)!.code;
    rememberCode(code);
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .send({ phone, code });
    remember(response.body);
    for (const header of ([] as string[]).concat(response.headers["set-cookie"] ?? [])) {
      const step = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(header);
      if (step) {
        rememberSecret(step[2]!);
        stepCookies.set(step[1]!, `adclub_sign_in_${step[1]}=${step[2]}`);
      }
      const refresh = /^adclub_(?:admin|supplier)_refresh=([^;]+)/.exec(header);
      if (refresh) {
        rememberSecret(refresh[1]!);
      }
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
    return totpSetupCompletedResponseSchema.parse(confirmed.body).session.accessToken;
  }

  async function sessionToken(phone: string, client: string): Promise<string> {
    const response = await signIn(phone, client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function call(bearer: string, client: string, method: Method, path: string, body?: object) {
    const test = http()
      [method](path)
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  const asAdmin = (method: Method, path: string, body?: object): Test =>
    call(token, ADMIN_WEB, method, path, body);

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
  }

  function expectFieldError(response: Response, path: string): void {
    expectError(response, 400, "VALIDATION_ERROR");
    expect(
      (response.body as { details: { path: string }[] }).details.map((entry) => entry.path),
    ).toContain(path);
  }

  async function ok<T>(
    test: PromiseLike<Response>,
    parse: (body: unknown) => T,
    status = 200,
  ): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  /** The answer as it came, validated by the schema (zod drops keys a schema doesn't name). */
  function checked<S extends z.ZodType>(schema: S) {
    return (body: unknown): z.output<S> => {
      schema.parse(body);
      return body as z.output<S>;
    };
  }

  async function idOf(text: string, values: unknown[]): Promise<string> {
    const { rows } = await db.query<{ id: string }>(text, values);
    expect(rows.length, text).toBeGreaterThan(0);
    return rows[0]!.id;
  }

  // ---------------------------------------------------------------- world

  type As = (method: Method, path: string, body?: object) => Test;

  interface Employee {
    memberId: string;
    name: string;
    phone: string;
    as: As;
  }

  interface Company {
    supplierId: string;
    first: Employee;
    as: As;
  }

  async function company(
    name: string,
    options: { type?: "services" | "both"; hours?: DayHours[]; closedDates?: string[] } = {},
  ): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    const contactPhone = phoneOf(500 + phoneCounter);
    rememberCode(phone, contactPhone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0812340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: options.type ?? "services",
        contactPhone,
        address: `ул. ${name}, ${String(phoneCounter)}`,
        district: `Район ${name}`,
        firstMember: { name: "Айгерим", phone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    await ok(
      asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
        expectedVersion: created.supplier.version,
        weeklyHours: options.hours ?? ALWAYS,
        closedDates: (options.closedDates ?? []).map((date) => ({ date, note: null })),
      }),
      (body) => adminSupplierResponseSchema.parse(body),
    );
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    const as: As = (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body);
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 AND m.supplier_id = $2",
      [phone, created.supplier.id],
    );
    return { supplierId: created.supplier.id, first: { memberId, name: "Айгерим", phone, as }, as };
  }

  async function colleague(of: Company, name: string): Promise<Employee> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const added = await ok(
      of.as("post", "/supplier/members", { name, phone }),
      (body) => supplierMemberAddedResponseSchema.parse(body),
      201,
    );
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      memberId: added.member.id,
      name,
      phone,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  /** Замена масла: 8 000 ₸ for a Coolray, 10 000 ₸ for an Atlas, no price for a Monjaro. */
  async function putService(of: Company): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: serviceId,
        modelPrices: [
          { modelId: models.coolray, price: COOLRAY_PRICE },
          { modelId: models.atlas, price: ATLAS_PRICE },
        ],
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  interface Customer {
    phone: string;
    as: As;
    /** The Coolray of the garage. */
    carId: string;
  }

  async function addCar(who: { as: As }, modelId: string, year = 2024): Promise<string> {
    const label = modelId === models.coolray ? "Coolray" : modelId === models.atlas ? "Atlas" : "M";
    return ok(
      who.as("post", "/garage/cars", {
        levels: {
          make: { id: models.geely, label: "Geely" },
          model: { id: modelId, label },
          year,
          generation: null,
          body: null,
          engine: null,
          transmission: null,
          drive: null,
        },
        color: null,
      }),
      (body) => accountCarSchema.parse(body).id,
      201,
    );
  }

  async function customer(): Promise<Customer> {
    const phone = `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    await ok(
      asAdmin("post", "/admin/club-access/grants", {
        phone,
        validUntil: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
        reason: "Тест",
      }),
      (body) => body,
      201,
    );
    const as: As = (method, path, body) => call(bearer, IOS, method, path, body);
    return { phone, as, carId: await addCar({ as }, models.coolray) };
  }

  function note(order: UserOrder): UserOrder {
    if (order.confirmation) {
      codes.add(order.confirmation.code);
      rememberCode(order.confirmation.code);
      rememberSecret(order.confirmation.qrPayload.slice(ORDER_QR_PREFIX.length));
    }
    return order;
  }

  const book = (who: Customer, offer: SupplierOffer, desiredAt: string, extra: object = {}) =>
    who.as("post", "/orders", {
      offerId: offer.id,
      expectedPrice: COOLRAY_PRICE,
      idempotencyKey: randomUUID(),
      carId: who.carId,
      desiredAt,
      ...extra,
    });

  async function place(
    who: Customer,
    offer: SupplierOffer,
    desiredAt = inMinutes(24 * 60),
  ): Promise<UserOrder> {
    return ok(
      book(who, offer, desiredAt),
      (body) => note(checked(createOrderResponseSchema)(body).order),
      201,
    );
  }

  async function userOrder(who: Customer, orderId: string): Promise<UserOrder> {
    return ok(who.as("get", `/orders/${orderId}`), (body) =>
      note(checked(userOrderResponseSchema)(body).order),
    );
  }

  async function supplierOrder(by: Employee | Company, orderId: string) {
    return ok(
      by.as("get", `/supplier/orders/${orderId}`),
      (body) => checked(supplierOrderResponseSchema)(body).order,
    );
  }

  async function adminOrder(orderId: string) {
    return ok(
      asAdmin("get", `/admin/orders/${orderId}`),
      (body) => checked(adminOrderResponseSchema)(body).order,
    );
  }

  const proposeTime = (by: Employee | Company, orderId: string, visitAt: string, version = 1) =>
    by.as("post", `/supplier/orders/${orderId}/propose-time`, {
      expectedVersion: version,
      visitAt,
    });

  const answer = (who: Customer, orderId: string, how: "agree" | "reject", version: number) =>
    who.as("post", `/orders/${orderId}/term/${how}`, { expectedVersion: version });

  const confirm = (by: Employee | Company, orderId: string, version = 1) =>
    by.as("post", `/supplier/orders/${orderId}/accept`, { expectedVersion: version });

  const noShow = (by: Employee | Company, orderId: string, version: number) =>
    by.as("post", `/supplier/orders/${orderId}/no-show`, { expectedVersion: version });

  async function orderRow(orderId: string) {
    const { rows } = await db.query<{
      status: string;
      kind: string;
      version: number;
      quantity: number;
      fulfillment: string;
      unit_price: number;
      respond_by: Date;
      desired_at: Date | null;
      proposed_at: Date | null;
      visit_at: Date | null;
      visit_until: Date | null;
      term_answer_by: Date | null;
      car_id: string | null;
      car_snapshot: unknown;
      code_released_at: Date | null;
      late_close_until: Date | null;
      phone_revealed_at: Date | null;
    }>("SELECT * FROM customer_order WHERE id = $1", [orderId]);
    return rows[0]!;
  }

  async function events(orderId: string) {
    const { rows } = await db.query<{
      action: string;
      to_status: string | null;
      actor_type: string;
      actor_member_id: string | null;
      channel: string;
      payload: Record<string, unknown>;
    }>(
      "SELECT action, to_status, actor_type, actor_member_id, channel, payload FROM order_event WHERE order_id = $1 ORDER BY seq",
      [orderId],
    );
    return rows;
  }

  async function messages(where: string, values: unknown[] = []): Promise<MessageRow[]> {
    const { rows } = await db.query<MessageRow>(
      `SELECT * FROM outbound_message WHERE ${where} ORDER BY created_at, id`,
      values,
    );
    return rows;
  }

  async function sent(orderId: string, template: string, n: number): Promise<MessageRow[]> {
    return waitFor(`${String(n)} ${template} of the order sent`, async () => {
      const rows = await messages("subject_id = $1 AND template = $2", [orderId, template]);
      return rows.length === n && rows.every((row) => row.status === "sent") ? rows : undefined;
    });
  }

  function of(rows: MessageRow[], phone: string): MessageRow {
    const found = rows.find((row) => row.phone === phone);
    expect(found, `a message to ${phone}`).toBeDefined();
    return found!;
  }

  /** A press as Meta delivers it, signed with the app secret as Meta signs it. */
  async function press(message: MessageRow, payload: string): Promise<string> {
    const id = `wamid.IN${randomUUID().replaceAll("-", "")}`;
    const body = JSON.stringify({
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
                    from: message.phone.replace(/^\+/, ""),
                    type: "button",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    button: { payload, text: "Подтвердить время" },
                    context: { id: message.provider_message_id },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const response = await http()
      .post(WHATSAPP_WEBHOOK_PATH)
      .set("X-Forwarded-For", nextIp())
      .set("Content-Type", "application/json")
      .set(
        "X-Hub-Signature-256",
        webhookSignatureHeader(Buffer.from(body, "utf8"), config.messaging.whatsapp.appSecret!),
      )
      .send(body);
    expect(response.status).toBe(200);
    return id;
  }

  async function decided(incomingId: string): Promise<string> {
    return waitFor(`the press ${incomingId} to be decided`, async () => {
      const { rows } = await db.query<{ outcome: string | null; applied_at: Date | null }>(
        "SELECT outcome, applied_at FROM message_button_press WHERE provider_message_id = $1",
        [incomingId],
      );
      return rows[0]?.applied_at ? (rows[0].outcome ?? "") : undefined;
    });
  }

  /** The deadline sweeper, one run, in this process (the workers run theirs too). */
  async function sweep() {
    const sweeper = new OrderDeadlineSweeper(
      { sweep: () => undefined } as unknown as JobRegistry,
      app.get(OrderTransitions),
    );
    return new SweepRunner(app.get(DatabaseService)).run(orderDeadlinesJob, sweeper, {
      signal: new AbortController().signal,
    });
  }

  async function lookup(by: Employee | Company, code: string) {
    return ok(by.as("post", "/supplier/orders/lookup", { code }), (raw) =>
      checked(orderLookupResponseSchema)(raw),
    );
  }

  async function giveOut(by: Employee | Company, code: string) {
    return ok(by.as("post", "/supplier/orders/close", { code }), (raw) =>
      checked(closeOrderResponseSchema)(raw),
    );
  }

  /** The visit's time has come, its window still open — moved by hand, as the clock would. */
  async function visitStarted(orderId: string): Promise<void> {
    await db.query(
      "UPDATE customer_order SET visit_at = now() - interval '5 minutes', visit_until = now() + interval '1 hour' WHERE id = $1",
      [orderId],
    );
  }

  // ============================================================= creation

  describe("an order on a service", () => {
    it("is a visit for a car of the garage at the time asked for, at the price for its model; W-01b goes with «Подтвердить время»", async () => {
      const shop = await company("Шины Юг");
      const marat = await colleague(shop, "Марат");
      const offer = await putService(shop);
      const buyer = await customer();
      const desiredAt = inMinutes(26 * 60);
      const order = await place(buyer, offer, desiredAt);
      expect(order).toMatchObject({
        kind: "service",
        status: "created",
        quantity: 1,
        unitPrice: COOLRAY_PRICE,
        total: COOLRAY_PRICE,
        item: { type: "service" },
        serviceVisit: {
          car: {
            make: { label: "Geely" },
            model: { id: models.coolray, label: "Coolray" },
            year: 2024,
          },
          desiredAt,
          proposed: null,
          confirmed: null,
        },
      });
      // ARCHITECTURE 6.3: the answer is due by the setting (2 h) — the visit is later.
      expect(Date.parse(order.respondBy) - Date.parse(order.createdAt)).toBeCloseTo(2 * HOUR, -4);
      expect(order.confirmation?.code).toMatch(/^\d{6}$/);
      const row = await orderRow(order.id);
      expect(row).toMatchObject({ kind: "service", fulfillment: "pickup", car_id: buyer.carId });
      const notices = await sent(order.id, "order_new_service", 2);
      const toFirst = of(notices, shop.first.phone);
      expect(toFirst.variables).toMatchObject({
        number: String(order.number),
        service: OIL_CHANGE,
        model: "Geely Coolray 2024",
        time: almatyClock(desiredAt),
      });
      expect(Object.keys(toFirst.button_payloads ?? {}).sort()).toEqual(["confirm", "decline"]);
      expect(of(notices, marat.phone).template).toBe("order_new_service");
      // The supplier sees the car and the time, not the customer.
      const card = await supplierOrder(shop, order.id);
      expect(card.customer).toEqual({ kind: "hidden", reason: "not_accepted" });
      expect(card.serviceVisit?.desiredAt).toBe(desiredAt);
      // «Записи на услуги»: the administrator finds it by kind.
      const listed = await ok(asAdmin("get", "/admin/orders?kind=service&test=include"), (body) =>
        checked(adminOrderPageSchema)(body),
      );
      expect(listed.orders.map((entry) => entry.id)).toEqual([order.id]);
      const stock = await ok(asAdmin("get", "/admin/orders?kind=stock&test=include"), (body) =>
        checked(adminOrderPageSchema)(body),
      );
      expect(stock.orders).toEqual([]);
    });

    it("asked for in 30 minutes, is answered by then — not after the setting (ARCHITECTURE 6.3)", async () => {
      const shop = await company("Срочно");
      const offer = await putService(shop);
      const desiredAt = inMinutes(30);
      const order = await place(await customer(), offer, desiredAt);
      expect(order.respondBy).toBe(desiredAt);
    });

    it("refuses what a service isn't: no car, another's car, delivery, a quantity, a changed price, a model without a price", async () => {
      const shop = await company("Отказы", { type: "both" });
      const offer = await putService(shop);
      const buyer = await customer();
      const other = await customer();
      const at = inMinutes(24 * 60);
      expectFieldError(await book(buyer, offer, at, { carId: undefined }), "carId");
      expectFieldError(await book(buyer, offer, at, { carId: other.carId }), "carId");
      expectFieldError(await book(buyer, offer, at, { fulfillment: "delivery" }), "fulfillment");
      expectFieldError(await book(buyer, offer, at, { quantity: 2 }), "quantity");
      const changed = await book(buyer, offer, at, { expectedPrice: ATLAS_PRICE });
      expectError(changed, 409, "ORDER_PRICE_CHANGED");
      expect(changed.body.details).toMatchObject({
        expectedPrice: ATLAS_PRICE,
        currentPrice: COOLRAY_PRICE,
      });
      // The Atlas has its own price: the same offer, another car.
      const atlas = await addCar(buyer, models.atlas, 2023);
      const forAtlas = await ok(
        book(buyer, offer, at, { carId: atlas, expectedPrice: ATLAS_PRICE }),
        (body) => note(checked(createOrderResponseSchema)(body).order),
        201,
      );
      expect(forAtlas.unitPrice).toBe(ATLAS_PRICE);
      // A Monjaro has no price: the offer is not for it.
      const monjaro = await addCar(buyer, models.monjaro);
      expectError(
        await book(buyer, offer, at, { carId: monjaro, allowAnotherActive: true }),
        409,
        "ORDER_OFFER_UNAVAILABLE",
      );
      // Goods are ordered without a car.
      const pads = await ok(
        shop.as("post", "/supplier/offers", {
          itemId: padsId,
          price: 12_250,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
        201,
      );
      expectFieldError(
        await buyer.as("post", "/orders", {
          offerId: pads.id,
          fulfillment: "pickup",
          expectedPrice: pads.price,
          idempotencyKey: randomUUID(),
          carId: buyer.carId,
          desiredAt: at,
        }),
        "carId",
      );
      expectFieldError(
        await buyer.as("post", "/orders", {
          offerId: pads.id,
          expectedPrice: pads.price,
          idempotencyKey: randomUUID(),
        }),
        "fulfillment",
      );
    });

    it("keeps its car after the car leaves the garage, and the same key finds the same order", async () => {
      const shop = await company("Снимок");
      const offer = await putService(shop);
      const buyer = await customer();
      const key = randomUUID();
      const at = inMinutes(24 * 60);
      const body = {
        offerId: offer.id,
        expectedPrice: COOLRAY_PRICE,
        idempotencyKey: key,
        carId: buyer.carId,
        desiredAt: at,
      };
      const order = await ok(
        buyer.as("post", "/orders", body),
        (raw) => note(checked(createOrderResponseSchema)(raw).order),
        201,
      );
      const again = await ok(
        buyer.as("post", "/orders", body),
        (raw) => checked(createOrderResponseSchema)(raw),
        201,
      );
      expect(again).toMatchObject({ created: false, order: { id: order.id } });
      expectError(
        await buyer.as("post", "/orders", { ...body, desiredAt: inMinutes(25 * 60) }),
        409,
        "ORDER_IDEMPOTENCY_MISMATCH",
      );
      await ok(buyer.as("delete", `/garage/cars/${buyer.carId}`), (raw) => raw);
      const kept = await userOrder(buyer, order.id);
      expect(kept.serviceVisit?.car.model.label).toBe("Coolray");
      expect((await orderRow(order.id)).car_id).toBeNull();
      // The repeat after the car left still finds the order.
      expect(
        await ok(
          buyer.as("post", "/orders", body),
          (raw) => checked(createOrderResponseSchema)(raw),
          201,
        ),
      ).toMatchObject({ created: false, order: { id: order.id } });
    });
  });

  // ================================================================ time

  describe("the time of a visit", () => {
    it("is judged by the point's hours and closed dates, in its time zone, never in the past or beyond the horizon", async () => {
      const closed = almatyDate(3);
      const shop = await company("Часы", { hours: DAYTIME, closedDates: [closed] });
      const offer = await putService(shop);
      const buyer = await customer();
      const options = await ok(
        buyer.as("get", `/order-visit-options?offerId=${offer.id}`),
        (body) => checked(offerVisitOptionsSchema)(body),
      );
      expect(options.timeZone).toBe("Asia/Almaty");
      expect(options.days.map((day) => day.date)).not.toContain(closed);
      expect(options.days.every((day) => day.intervals.every((i) => i.to <= "18:00"))).toBe(true);
      // Night, a closed date, the past, beyond the horizon (30 days), seconds.
      for (const desiredAt of [
        almatyAt(almatyDate(1), "03:00"),
        almatyAt(closed, "10:00"),
        new Date(Date.now() - HOUR).toISOString(),
        almatyAt(almatyDate(40), "10:00"),
        new Date(Date.parse(inMinutes(24 * 60)) + 30_000).toISOString(),
      ]) {
        expectFieldError(await book(buyer, offer, desiredAt), "desiredAt");
      }
      // A working day's hour of the options passes.
      const day = options.days.find((entry) => entry.date > almatyDate(0))!;
      const order = await place(buyer, offer, almatyAt(day.date, day.intervals[0]!.from));
      expect(order.status).toBe("created");
      // Another time is judged the same way, and is not the time asked for.
      expectFieldError(
        await proposeTime(shop, order.id, almatyAt(almatyDate(1), "21:00")),
        "visitAt",
      );
      expectFieldError(await proposeTime(shop, order.id, order.serviceVisit!.desiredAt), "visitAt");
      const times = await ok(shop.as("get", `/supplier/orders/${order.id}/time-options`), (body) =>
        checked(supplierOrderTimeOptionsSchema)(body),
      );
      expect(times.desiredAt).toBe(order.serviceVisit!.desiredAt);
      expect(times.days.map((entry) => entry.date)).not.toContain(closed);
    });
  });

  // ============================================================== the paths

  describe("the paths of a visit", () => {
    it("confirmed by the button → the visit → done by the code; W-02 with the phone, the code only to the user", async () => {
      const shop = await company("Подтвердил");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const notices = await sent(order.id, "order_new_service", 1);
      const incoming = await press(notices[0]!, notices[0]!.button_payloads!.confirm!);
      expect(await decided(incoming)).toBe("accepted");
      const row = await orderRow(order.id);
      expect(row.status).toBe("accepted");
      expect(row.visit_at?.toISOString()).toBe(order.serviceVisit!.desiredAt);
      // The window is `service_grace_hours` (2) after the visit.
      expect(row.visit_until!.getTime() - row.visit_at!.getTime()).toBe(2 * HOUR);
      const [accepted] = await sent(order.id, "order_accepted", 1);
      expect(accepted!.phone).toBe(shop.first.phone);
      const card = await supplierOrder(shop, order.id);
      expect(card.customer).toMatchObject({ kind: "revealed", phone: buyer.phone });
      expect(card.serviceVisit?.confirmed?.visitAt).toBe(order.serviceVisit!.desiredAt);
      const mine = await userOrder(buyer, order.id);
      expect(mine.status).toBe("accepted");
      expect(mine.pickupPoint).toBeDefined();
      // The saved copy leads with the time of the visit.
      const copy = await ok(buyer.as("get", "/active-orders"), (body) =>
        checked(activeOrdersResponseSchema)(body),
      );
      expect(copy.orders[0]).toMatchObject({
        id: order.id,
        mainDate: { kind: "visit_at", at: order.serviceVisit!.desiredAt },
        awaitsReceipt: true,
        needsAnswer: false,
      });
      // Nothing but the user's own answers carries the code.
      const code = mine.confirmation!.code;
      const admin = await adminOrder(order.id);
      expect(admin.deadlines.visitUntil).toBe(row.visit_until!.toISOString());
      for (const seen of [card, admin, await lookup(shop, code)]) {
        expect(JSON.stringify(seen)).not.toContain(code);
      }
      const found = await lookup(shop, code);
      expect(found).toMatchObject({
        result: "ready",
        order: {
          kind: "service",
          status: "accepted",
          serviceVisit: { car: { model: { label: "Coolray" } } },
        },
      });
      const done = await giveOut(shop, code);
      expect(done).toMatchObject({ result: "given_out", late: false });
      expect((await userOrder(buyer, order.id)).status).toBe("completed");
    });

    it("another time proposed → agreed → W-02 to who proposed it → done; the phone only after the «yes»", async () => {
      const shop = await company("Другое время");
      const marat = await colleague(shop, "Марат");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const visitAt = inMinutes(30 * 60);
      const proposed = await ok(
        proposeTime(marat, order.id, visitAt),
        (body) => checked(supplierOrderResponseSchema)(body).order,
      );
      expect(proposed).toMatchObject({
        status: "term_proposed",
        customer: { kind: "hidden" },
        serviceVisit: { proposed: { visitAt } },
      });
      // The answer is due by `time_agreement_hours` (24), never after the time itself.
      expect(Date.parse(proposed.serviceVisit!.proposed!.answerBy)).toBeLessThanOrEqual(
        Date.parse(visitAt),
      );
      const copy = await ok(buyer.as("get", "/active-orders"), (body) =>
        checked(activeOrdersResponseSchema)(body),
      );
      expect(copy.orders[0]).toMatchObject({
        needsAnswer: true,
        mainDate: { kind: "answer_by" },
        serviceVisit: { proposed: { visitAt } },
      });
      const agreed = await ok(answer(buyer, order.id, "agree", 2), (body) =>
        note(checked(userOrderResponseSchema)(body).order),
      );
      expect(agreed).toMatchObject({
        status: "accepted",
        serviceVisit: { confirmed: { visitAt } },
      });
      const [w02] = await sent(order.id, "order_accepted", 1);
      expect(w02!.phone).toBe(marat.phone);
      expect((await supplierOrder(marat, order.id)).customer).toMatchObject({
        kind: "revealed",
        phone: buyer.phone,
      });
      expect((await orderRow(order.id)).visit_at?.toISOString()).toBe(visitAt);
      expect(await giveOut(shop, agreed.confirmation!.code)).toMatchObject({ result: "given_out" });
      expect((await events(order.id)).map((event) => event.action)).toEqual([
        "create",
        "propose_time",
        "agree_term",
        "close",
      ]);
    });

    it("another time proposed → refused: the user's cancel, W-04", async () => {
      const shop = await company("Отказался");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await sent(order.id, "order_new_service", 1);
      await ok(proposeTime(shop, order.id, inMinutes(30 * 60)), (body) => body);
      const refused = await ok(
        answer(buyer, order.id, "reject", 2),
        (body) => checked(userOrderResponseSchema)(body).order,
      );
      expect(refused.status).toBe("cancelled_by_user");
      expect(refused.confirmation).toBeUndefined();
      await sent(order.id, "order_cancelled_by_user", 1);
    });

    it("another time proposed → silence: expired once whichever sweeper gets there; the late «yes» is told", async () => {
      const shop = await company("Молчание");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(proposeTime(shop, order.id, inMinutes(30 * 60)), (body) => body);
      await db.query(
        "UPDATE customer_order SET term_answer_by = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      await Promise.all([sweep(), sweep()]);
      await waitFor("the silence to expire it", async () =>
        (await orderRow(order.id)).status === "term_expired" ? true : undefined,
      );
      expect(
        (await events(order.id)).filter((event) => event.action === "expire_term"),
      ).toHaveLength(1);
      const late = await answer(buyer, order.id, "agree", 2);
      expectError(late, 409, "ORDER_STATE_CONFLICT");
      expect(orderStateConflictDetailsSchema.parse(late.body.details).currentStatus).toBe(
        "term_expired",
      );
      // It expired without the user's word: closed by no code.
      const code = (await userOrder(buyer, order.id)).confirmation;
      expect(code).toBeUndefined();
    });

    it("the supplier declines while the user thinks the time over (D-072), and the late «yes» says so", async () => {
      const shop = await company("Передумал");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(proposeTime(shop, order.id, inMinutes(30 * 60)), (body) => body);
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/decline`, { expectedVersion: 2 }),
        (body) => body,
      );
      const late = await answer(buyer, order.id, "agree", 2);
      expectError(late, 409, "ORDER_STATE_CONFLICT");
      expect(orderStateConflictDetailsSchema.parse(late.body.details).currentStatus).toBe(
        "declined_by_supplier",
      );
      expect((await orderRow(order.id)).phone_revealed_at).toBeNull();
    });

    it("a confirmed visit cancelled shortly before it: W-04 and a note of a late cancel, no mark of discipline", async () => {
      const shop = await company("Поздно");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer, inMinutes(60));
      await sent(order.id, "order_new_service", 1);
      await ok(confirm(shop, order.id), (body) => body);
      const cancelled = await ok(
        buyer.as("post", `/orders/${order.id}/cancel`),
        (body) => checked(userOrderResponseSchema)(body).order,
      );
      expect(cancelled.status).toBe("cancelled_by_user");
      const journal = await events(order.id);
      expect(journal.map((event) => event.action)).toEqual([
        "create",
        "accept",
        "cancel",
        "late_cancel",
      ]);
      expect(journal.at(-1)).toMatchObject({ to_status: null, actor_type: "user" });
      await sent(order.id, "order_cancelled_by_user", 1);
      const { rows } = await db.query("SELECT * FROM user_discipline_event WHERE order_id = $1", [
        order.id,
      ]);
      expect(rows).toEqual([]);
      // A cancel long before the visit is no late one.
      const early = await place(buyer, offer, inMinutes(24 * 60));
      await ok(confirm(shop, early.id), (body) => body);
      await ok(buyer.as("post", `/orders/${early.id}/cancel`), (body) => body);
      expect((await events(early.id)).map((event) => event.action)).not.toContain("late_cancel");
    });
  });

  // ============================================================== the visit

  describe("a no-show", () => {
    it("is marked only from the visit's time, writes the discipline mark, and is refused after the window", async () => {
      const shop = await company("Неявка");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(confirm(shop, order.id), (body) => body);
      const early = await noShow(shop, order.id, 2);
      expectError(early, 409, "ORDER_NO_SHOW_TOO_EARLY");
      expect((await orderRow(order.id)).status).toBe("accepted");
      await visitStarted(order.id);
      const marked = await ok(
        noShow(shop, order.id, 2),
        (body) => checked(supplierOrderResponseSchema)(body).order,
      );
      expect(marked.status).toBe("no_show");
      const { rows } = await db.query<{ kind: string; revoked_at: Date | null }>(
        "SELECT kind, revoked_at FROM user_discipline_event WHERE order_id = $1",
        [order.id],
      );
      expect(rows).toEqual([{ kind: "service_no_show", revoked_at: null }]);
      const mine = await userOrder(buyer, order.id);
      expect(mine.status).toBe("no_show");
      expect(mine.confirmation).toBeUndefined();
      expect((await orderRow(order.id)).code_released_at).not.toBeNull();
      // The administrator may still close it without a code (D-043): the mark is lifted.
      const admin = await adminOrder(order.id);
      expect(admin.discipline.map((mark) => mark.kind)).toEqual(["service_no_show"]);
      await ok(
        asAdmin("post", `/admin/orders/${order.id}/close`, {
          expectedVersion: admin.version,
          reason: "Клиент был",
        }),
        (body) => body,
      );
      const lifted = await db.query<{ revoked_by: string }>(
        "SELECT revoked_by FROM user_discipline_event WHERE order_id = $1",
        [order.id],
      );
      expect(lifted.rows[0]!.revoked_by).toBe("admin_close");

      // After the window the visit has expired unresolved — no no-show any more.
      const later = await place(buyer, offer);
      await ok(confirm(shop, later.id), (body) => body);
      await db.query(
        "UPDATE customer_order SET visit_at = now() - interval '3 hours', visit_until = now() - interval '1 minute' WHERE id = $1",
        [later.id],
      );
      const tooLate = await noShow(shop, later.id, 2);
      expectError(tooLate, 409, "ORDER_STATE_CONFLICT");
      expect(orderStateConflictDetailsSchema.parse(tooLate.body.details).currentStatus).toBe(
        "visit_unresolved",
      );
    });

    it("of an employee's own test order writes no mark", async () => {
      const shop = await company("Своя");
      const offer = await putService(shop);
      const bearer = await sessionToken(shop.first.phone, IOS);
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          phone: shop.first.phone,
          validUntil: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
          reason: "Тест",
        }),
        (body) => body,
        201,
      );
      const as: As = (method, path, body) => call(bearer, IOS, method, path, body);
      const own: Customer = {
        phone: shop.first.phone,
        as,
        carId: await addCar({ as }, models.coolray),
      };
      const order = await place(own, offer);
      expect(order.isTest).toBe(true);
      await ok(confirm(shop, order.id), (body) => body);
      await visitStarted(order.id);
      await ok(noShow(shop, order.id, 2), (body) => body);
      const { rows } = await db.query("SELECT * FROM user_discipline_event WHERE order_id = $1", [
        order.id,
      ]);
      expect(rows).toEqual([]);
    });
  });

  describe("a confirmed visit nobody resolved", () => {
    it("expires once with one signal, however many sweepers; the code still closes it late", async () => {
      const shop = await company("Без разбора");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const code = order.confirmation!.code;
      await ok(confirm(shop, order.id), (body) => body);
      await db.query(
        "UPDATE customer_order SET visit_at = now() - interval '3 hours', visit_until = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      await Promise.all([sweep(), sweep(), sweep()]);
      await waitFor("the visit to expire", async () =>
        (await orderRow(order.id)).status === "visit_unresolved" ? true : undefined,
      );
      await sweep();
      expect(
        (await events(order.id)).filter((event) => event.action === "expire_visit"),
      ).toHaveLength(1);
      const signals = await ok(asAdmin("get", "/admin/signals?kind=visit_unresolved"), (body) =>
        adminSignalPageSchema.parse(body),
      );
      expect(signals.signals).toHaveLength(1);
      expect(signals.signals[0]).toMatchObject({
        subjectType: "order",
        subjectId: order.id,
        times: 1,
        payload: { orderNumber: order.number, supplierId: shop.supplierId },
      });
      // No mark of discipline: nobody knows who failed whom.
      const { rows } = await db.query("SELECT * FROM user_discipline_event WHERE order_id = $1", [
        order.id,
      ]);
      expect(rows).toEqual([]);
      expect((await supplierOrder(shop, order.id)).lateCloseUntil).not.toBeNull();
      expect(await lookup(shop, code)).toMatchObject({ result: "late" });
      expect(await giveOut(shop, code)).toMatchObject({ result: "given_out", late: true });
    });
  });

  // ============================================================ the races

  describe("races", () => {
    it("«Подтвердить время» in WhatsApp against another time in the cabinet: one outcome, the other is told who (four rounds)", async () => {
      const shop = await company("Гонка");
      const marat = await colleague(shop, "Марат");
      const offer = await putService(shop);
      for (let round = 0; round < 4; round++) {
        const order = await place(await customer(), offer);
        const notices = await sent(order.id, "order_new_service", 2);
        const toFirst = of(notices, shop.first.phone);
        const [incoming, cabinet] = await Promise.all([
          press(toFirst, toFirst.button_payloads!.confirm!),
          proposeTime(marat, order.id, inMinutes(40 * 60)),
        ]);
        const outcome = await decided(incoming);
        const row = await orderRow(order.id);
        if (outcome === "accepted") {
          expectError(cabinet, 409, "ORDER_STATE_CONFLICT");
          const details = orderStateConflictDetailsSchema.parse(cabinet.body.details);
          expect(details.lastAction).toMatchObject({
            action: "accept",
            actor: { kind: "member", name: "Айгерим" },
          });
          expect(row.status).toBe("accepted");
        } else {
          expect(outcome, `round ${String(round)}`).toBe("conflict");
          expect(cabinet.status).toBe(200);
          expect(row.status).toBe("term_proposed");
          const [reply] = await sent(order.id, "order_already_handled", 1);
          expect(reply!.variables!.state).toContain("Марат");
        }
        const journal = await events(order.id);
        expect(
          journal.filter((event) => ["accept", "propose_time"].includes(event.action)),
        ).toHaveLength(1);
      }
    });
  });

  // ======================================================= who may do what

  describe("who may do what", () => {
    it("answers another company and another user like nothing, other contexts with 403, a guest with 401", async () => {
      const shop = await company("Своя компания");
      const stranger = await company("Чужая компания");
      const offer = await putService(shop);
      const buyer = await customer();
      const other = await customer();
      const order = await place(buyer, offer);
      const visitAt = inMinutes(30 * 60);
      expectError(await proposeTime(stranger, order.id, visitAt), 404, "NOT_FOUND");
      expectError(await noShow(stranger, order.id, 1), 404, "NOT_FOUND");
      expectError(
        await stranger.as("get", `/supplier/orders/${order.id}/time-options`),
        404,
        "NOT_FOUND",
      );
      expectError(
        await buyer.as("post", `/supplier/orders/${order.id}/propose-time`, {
          expectedVersion: 1,
          visitAt,
        }),
        403,
        "FORBIDDEN",
      );
      expectError(
        await shop.as("get", `/order-visit-options?offerId=${offer.id}`),
        403,
        "FORBIDDEN",
      );
      expectError(
        await http()
          .get(`/order-visit-options?offerId=${offer.id}`)
          .set("X-Client", IOS)
          .set("X-Forwarded-For", nextIp()),
        401,
        "AUTH_REQUIRED",
      );
      await ok(proposeTime(shop, order.id, visitAt), (body) => body);
      expectError(await answer(other, order.id, "agree", 2), 404, "NOT_FOUND");
      // A stale version is a conflict.
      expectError(await answer(buyer, order.id, "agree", 1), 409, "ORDER_STATE_CONFLICT");
    });

    it("keeps the moves of a service to a service: another time, a no-show and their options refuse goods", async () => {
      const shop = await company("Товары и услуги", { type: "both" });
      const pads = await ok(
        shop.as("post", "/supplier/offers", {
          itemId: padsId,
          price: 12_250,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
        201,
      );
      const buyer = await customer();
      const goods = await ok(
        buyer.as("post", "/orders", {
          offerId: pads.id,
          fulfillment: "pickup",
          expectedPrice: pads.price,
          idempotencyKey: randomUUID(),
        }),
        (body) => note(checked(createOrderResponseSchema)(body).order),
        201,
      );
      expect(goods.serviceVisit).toBeNull();
      expectError(
        await proposeTime(shop, goods.id, inMinutes(30 * 60)),
        409,
        "ORDER_KIND_NOT_SUPPORTED",
      );
      expectError(await noShow(shop, goods.id, 1), 409, "ORDER_KIND_NOT_SUPPORTED");
      expectError(
        await shop.as("get", `/supplier/orders/${goods.id}/time-options`),
        409,
        "ORDER_KIND_NOT_SUPPORTED",
      );
      expectError(
        await buyer.as("get", `/order-visit-options?offerId=${pads.id}`),
        409,
        "ORDER_KIND_NOT_SUPPORTED",
      );
      // A service is no term to talk about either.
      const service = await putService(shop);
      const visit = await place(buyer, service);
      expectError(
        await shop.as("post", `/supplier/orders/${visit.id}/propose-term`, {
          expectedVersion: 1,
          leadDays: 2,
        }),
        409,
        "ORDER_KIND_NOT_SUPPORTED",
      );
    });

    it("lets the administrator extend the user's answer to another time, and the list of the cabinet group it", async () => {
      const shop = await company("Продление");
      const offer = await putService(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(proposeTime(shop, order.id, inMinutes(48 * 60)), (body) => body);
      const before = await adminOrder(order.id);
      expect(before.deadlines.termAnswerBy).not.toBeNull();
      const extended = await ok(
        asAdmin("post", `/admin/orders/${order.id}/extend-deadline`, {
          expectedVersion: before.version,
          deadline: "term",
          minutes: 60,
          reason: "Клиент в дороге",
        }),
        (body) => checked(adminOrderResponseSchema)(body).order,
      );
      expect(
        Date.parse(extended.deadlines.termAnswerBy!) - Date.parse(before.deadlines.termAnswerBy!),
      ).toBe(HOUR);
      const page = await ok(shop.as("get", "/supplier/orders?tab=in_progress"), (body) =>
        checked(supplierOrderPageSchema)(body),
      );
      expect(page.orders.map((entry) => [entry.id, entry.kind, entry.status])).toEqual([
        [order.id, "service", "term_proposed"],
      ]);
    });
  });

  it("leaves no confirmation code in the application log of any process", () => {
    const text = appLogText(allOutput());
    expect(codes.size).toBeGreaterThan(0);
    for (const code of codes) {
      expect(text).not.toMatch(new RegExp(`\\b${code}\\b`));
    }
  });
});
