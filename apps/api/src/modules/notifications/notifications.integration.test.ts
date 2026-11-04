import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountCarSchema,
  adminCatalogItemPageSchema,
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  createOrderResponseSchema,
  ORDER_QR_PREFIX,
  supplierMemberAddedResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderResponseSchema,
  supplierOrderTermOptionsSchema,
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
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { JobQueue, SweepRunner, type JobRegistry, type JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { BillingOperator } from "../billing";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { OrderDeadlineSweeper, orderDeadlinesJob, OrderTransitions } from "../orders";
import { DevVehicleSeed } from "../vehicles";
import { DeviceTokenCleanup } from "./device-token-cleanup";
import { Notifications } from "./notifications.service";
import { NotificationsAdmin } from "./notifications-admin";
import { deviceTokenCleanupJob, pushRecoveryJob, sendPushJob } from "./push-jobs";
import { PushProvider } from "./push-provider";
import { InterruptedPushSweep } from "./push-sender";
import { AppSettings } from "../settings";
import type { TestPushProvider } from "./test-push-provider";

/**
 * TASK-051 end to end on a real PostgreSQL and Redis, with the real API and
 * **two** real workers: every event of SCREENS 8.4 sends exactly one push to
 * the user of the order in their language (kk, ru, en), opening the order;
 * the user's own moves send none; a race of two employees sends one; a
 * rolled-back event sends none; a repeated job sends no second copy. The
 * tokens of devices are bound to sessions: two devices both get it, a dead
 * token is taken off and the other goes on, an ended session gets nothing —
 * pushes queued before its end included; sign-in with another number moves
 * the token. The provider's failures, the recovery of an interrupted attempt,
 * the absence of open transactions while the provider is called, the
 * confirmations and what never leaves the process. **Nothing reaches a
 * network**: the provider is the test one.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const OIL_CHANGE = "Замена моторного масла";
const HOUR = 3_600_000;
const MINUTE = 60_000;

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

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function inMinutes(minutes: number): string {
  const at = Date.now() + minutes * MINUTE;
  return new Date(Math.ceil(at / (30 * MINUTE)) * 30 * MINUTE).toISOString();
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

interface NotificationRowOf {
  id: string;
  event_kind: string;
  template_code: string;
  lang: string;
  status: string;
  payload: {
    target: { screen: string; params?: { orderId?: string } };
    variables: Record<string, string>;
  };
  acked_at: Date | null;
  recipient_account_id: string;
}

describe("push to the user (PostgreSQL + Redis, API and two workers)", () => {
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
  let providers: TestPushProvider[];
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let tokenCounter = 0;
  let almaty: string;
  let padsId: string;
  let serviceId: string;
  let models: { geely: string; coolray: string };
  let token: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  /** Every code, QR and phone handed out: none of them may be in a push. */
  const secrets = new Set<string>();

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
    providers = [worker1, worker2].map((context) => context.get(PushProvider) as TestPushProvider);
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
    for (const provider of providers) {
      provider.sent.length = 0;
      provider.mode = "ok";
      provider.delayMs = 5_000;
      provider.deadTokens.clear();
    }
    logins.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await truncateAll(db, [
      "DELETE FROM pgboss.job WHERE name LIKE 'messaging.%' OR name LIKE 'suppliers.%' OR name LIKE 'notifications.%'",
    ]);
    await redis.flushall();
    await settings.reload();
    await configure({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      message_retry_delay_seconds: 1,
      push_retry_delay_seconds: 1,
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
    padsId = await idOf(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      ["geely", normalizeArticle(PADS)],
    );
    serviceId = await ok(
      asAdmin("get", `/admin/catalog/items?q=${encodeURIComponent(OIL_CHANGE)}`),
      (body) => adminCatalogItemPageSchema.parse(body).items[0]!.id,
    );
    const coolray = await idOf("SELECT model_id AS id FROM vehicle_model_spelling WHERE key = $1", [
      "coolray",
    ]);
    models = {
      coolray,
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

  function setMode(mode: TestPushProvider["mode"], delayMs?: number): void {
    for (const provider of providers) {
      provider.mode = mode;
      if (delayMs !== undefined) provider.delayMs = delayMs;
    }
  }

  const sentPushes = () => providers.flatMap((provider) => provider.sent);

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

  async function sessionOf(phone: string, client: string) {
    const response = await signIn(phone, client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string; refreshToken: string } }).session;
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

  async function ok<T>(
    test: PromiseLike<Response>,
    parse: (body: unknown) => T,
    status = 200,
  ): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
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
    as: As;
  }

  interface Company {
    supplierId: string;
    name: string;
    first: Employee;
    as: As;
  }

  async function company(name: string, type: "goods" | "services" = "goods"): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    const contactPhone = phoneOf(500 + phoneCounter);
    rememberCode(phone, contactPhone);
    secrets.add(phone).add(contactPhone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0912340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type,
        contactPhone,
        address: `ул. Тестовая ${name}, ${String(phoneCounter)}`,
        district: `Район ${name}`,
        firstMember: { name: "Айгерим", phone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    await ok(
      asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
        expectedVersion: created.supplier.version,
        weeklyHours: ALWAYS,
        closedDates: [],
      }),
      (body) => adminSupplierResponseSchema.parse(body),
    );
    const bearer = (await sessionOf(phone, SUPPLIER_WEB)).accessToken;
    const as: As = (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body);
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 AND m.supplier_id = $2",
      [phone, created.supplier.id],
    );
    return { supplierId: created.supplier.id, name, first: { memberId, name: "Айгерим", as }, as };
  }

  async function colleague(of: Company, name: string): Promise<Employee> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const added = await ok(
      of.as("post", "/supplier/members", { name, phone }),
      (body) => supplierMemberAddedResponseSchema.parse(body),
      201,
    );
    const bearer = (await sessionOf(phone, SUPPLIER_WEB)).accessToken;
    return {
      memberId: added.member.id,
      name,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function putOffer(
    of: Company,
    availability: "in_stock" | "on_order" = "in_stock",
  ): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price: 12_250,
        availability,
        leadDays: availability === "on_order" ? 3 : 0,
        pickup: true,
        delivery: false,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  async function putService(of: Company): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: serviceId,
        modelPrices: [{ modelId: models.coolray, price: 8_000 }],
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  interface Customer {
    phone: string;
    accountId: string;
    bearer: string;
    refresh: string;
    as: As;
  }

  async function customer(
    options: { lang?: "kk" | "ru" | "en"; clubAccess?: boolean; phone?: string } = {},
  ): Promise<Customer> {
    const phone = options.phone ?? `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    secrets.add(phone);
    const session = await sessionOf(phone, IOS);
    const as: As = (method, path, body) => call(session.accessToken, IOS, method, path, body);
    if (options.clubAccess !== false) {
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          phone,
          validUntil: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
          reason: "Тест",
        }),
        (body) => body,
        201,
      );
    }
    if (options.lang) {
      await ok(as("patch", "/account/profile", { language: options.lang }), (body) => body);
    }
    const accountId = await idOf("SELECT id FROM account WHERE phone = $1", [phone]);
    return { phone, accountId, bearer: session.accessToken, refresh: session.refreshToken, as };
  }

  /** Signs in the same person once more: another device, another session. */
  async function anotherDevice(of: Customer): Promise<Customer> {
    const session = await sessionOf(of.phone, IOS);
    return {
      ...of,
      bearer: session.accessToken,
      refresh: session.refreshToken,
      as: (method, path, body) => call(session.accessToken, IOS, method, path, body),
    };
  }

  function newToken(): string {
    const value = `dev${String(++tokenCounter).padStart(5, "0")}:APA91b${randomUUID().replaceAll("-", "")}${"Q".repeat(100)}`;
    rememberSecret(value);
    return value;
  }

  async function register(
    who: Customer,
    value = newToken(),
    platform: "ios" | "android" = "android",
  ) {
    await ok(
      who.as("put", "/notifications/device-token", { platform, token: value }),
      (body) => body,
    );
    return value;
  }

  function note(order: UserOrder): UserOrder {
    if (order.confirmation) {
      secrets.add(order.confirmation.code);
      secrets.add(order.confirmation.qrPayload.slice(ORDER_QR_PREFIX.length));
      rememberCode(order.confirmation.code);
      rememberSecret(order.confirmation.qrPayload.slice(ORDER_QR_PREFIX.length));
    }
    return order;
  }

  async function place(who: Customer, offer: SupplierOffer): Promise<UserOrder> {
    return ok(
      who.as("post", "/orders", {
        offerId: offer.id,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: offer.price,
        allowAnotherActive: true,
        idempotencyKey: randomUUID(),
      }),
      (body) => note(createOrderResponseSchema.parse(body).order as UserOrder),
      201,
    );
  }

  async function addCar(who: Customer): Promise<string> {
    return ok(
      who.as("post", "/garage/cars", {
        levels: {
          make: { id: models.geely, label: "Geely" },
          model: { id: models.coolray, label: "Coolray" },
          year: 2024,
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

  async function book(who: Customer, offer: SupplierOffer, carId: string): Promise<UserOrder> {
    return ok(
      who.as("post", "/orders", {
        offerId: offer.id,
        expectedPrice: 8_000,
        allowAnotherActive: true,
        idempotencyKey: randomUUID(),
        carId,
        desiredAt: inMinutes(24 * 60),
      }),
      (body) => note(createOrderResponseSchema.parse(body).order as UserOrder),
      201,
    );
  }

  async function userOrder(who: Customer, orderId: string): Promise<UserOrder> {
    return ok(who.as("get", `/orders/${orderId}`), (body) =>
      note(userOrderResponseSchema.parse(body).order as UserOrder),
    );
  }

  async function version(by: Employee | Company, orderId: string): Promise<number> {
    return ok(
      by.as("get", `/supplier/orders/${orderId}`),
      (body) => supplierOrderResponseSchema.parse(body).order.version,
    );
  }

  async function act(by: Employee | Company, orderId: string, path: string, extra: object = {}) {
    const expectedVersion = await version(by, orderId);
    return ok(
      by.as("post", `/supplier/orders/${orderId}/${path}`, { expectedVersion, ...extra }),
      (body) => body,
    );
  }

  async function sweep() {
    const sweeper = new OrderDeadlineSweeper(
      { sweep: () => undefined } as unknown as JobRegistry,
      app.get(OrderTransitions),
    );
    return new SweepRunner(app.get(DatabaseService)).run(orderDeadlinesJob, sweeper, {
      signal: new AbortController().signal,
    });
  }

  async function notificationsOf(where: string, values: unknown[]): Promise<NotificationRowOf[]> {
    const { rows } = await db.query<NotificationRowOf>(
      `SELECT * FROM notification WHERE ${where} ORDER BY created_at`,
      values,
    );
    return rows;
  }

  /** The one notification of this kind about this order, once it is settled. */
  async function pushOf(orderId: string, kind: string): Promise<NotificationRowOf> {
    return waitFor(`push ${kind} of ${orderId}`, async () => {
      const rows = await notificationsOf("subject_id = $1 AND event_kind = $2", [orderId, kind]);
      expect(rows.length).toBeLessThanOrEqual(1);
      const row = rows[0];
      if (!row || row.status === "queued") return undefined;
      // Every device's delivery settled, not only the first that made it «sent».
      const { rows: open } = await db.query(
        "SELECT 1 FROM notification_delivery WHERE notification_id = $1 AND status IN ('queued', 'sending')",
        [row.id],
      );
      return open.length === 0 ? row : undefined;
    });
  }

  async function deliveries(notificationId: string) {
    const { rows } = await db.query<{
      id: string;
      status: string;
      attempts: number;
      failure_kind: string | null;
      device_token_id: string | null;
      token_mask: string;
    }>("SELECT * FROM notification_delivery WHERE notification_id = $1 ORDER BY created_at", [
      notificationId,
    ]);
    return rows;
  }

  // ------------------------------------------------------------- the tests

  it("sends one push for each event of an item in stock, to both devices, in Russian, opening the order", async () => {
    const shop = await company("Автомаркет");
    const offer = await putOffer(shop);
    const buyer = await customer();
    const second = await anotherDevice(buyer);
    const [phone1, phone2] = [await register(buyer), await register(second, newToken(), "ios")];

    const order = await place(buyer, offer);
    await act(shop, order.id, "accept");
    const accepted = await pushOf(order.id, "order_accepted");
    expect(accepted).toMatchObject({
      template_code: "order_accepted",
      lang: "ru",
      status: "sent",
      payload: { target: { screen: "order", params: { orderId: order.id } } },
    });
    await waitFor("both devices", async () =>
      (await deliveries(accepted.id)).every((d) => d.status === "sent"),
    );
    const toDevices = sentPushes().filter((push) => push.data.notificationId === accepted.id);
    expect(toDevices.map((push) => push.token).sort()).toEqual([phone1, phone2].sort());
    expect(toDevices[0]!.body).toMatch(/^Автомаркет принял заявку: .*04465-0K090$/);

    await act(shop, order.id, "ready");
    const ready = await pushOf(order.id, "order_ready");
    expect(ready.template_code).toBe("order_ready");
    expect(sentPushes().find((push) => push.data.notificationId === ready.id)?.body).toMatch(
      /^Можно забирать: .+\. Резерв до \d\d:\d\d, \d+ [а-я]+$/,
    );

    await db.query(
      "UPDATE customer_order SET reserve_warn_at = now() - interval '1 minute' WHERE id = $1",
      [order.id],
    );
    await sweep();
    const warned = await pushOf(order.id, "reserve_expiring");
    expect(sentPushes().find((push) => push.data.notificationId === warned.id)?.body).toMatch(
      /^Резерв заканчивается в \d\d:\d\d: /,
    );

    const code = (await userOrder(buyer, order.id)).confirmation!.code;
    await ok(shop.as("post", "/supplier/orders/close", { code }), (body) => body);
    const closed = await pushOf(order.id, "order_closed");
    expect(sentPushes().find((push) => push.data.notificationId === closed.id)?.body).toMatch(
      /^Заявка закрыта: .+\. Не получали\? Сообщите нам$/,
    );

    // Exactly these four, each to both devices; nothing about the creation.
    const all = await notificationsOf("subject_id = $1", [order.id]);
    expect(all.map((row) => row.event_kind).sort()).toEqual(
      ["order_accepted", "order_closed", "order_ready", "reserve_expiring"].sort(),
    );
    expect(
      sentPushes().filter((push) => all.some((row) => row.id === push.data.notificationId)),
    ).toHaveLength(8);
  }, 120_000);

  it("sends nothing for the user's own moves, and speaks Kazakh and English, «Поставщик» without club access", async () => {
    const shop = await company("Шины Юг");
    const offer = await putOffer(shop);
    const kk = await customer({ lang: "kk" });
    await register(kk);
    const cancelled = await place(kk, offer);
    await ok(kk.as("post", `/orders/${cancelled.id}/cancel`), (body) => body);
    const declined = await place(kk, offer);
    await act(shop, declined.id, "decline", { reason: "out_of_stock" });
    const decline = await pushOf(declined.id, "order_declined");
    expect(decline.lang).toBe("kk");
    expect(sentPushes().find((push) => push.data.notificationId === decline.id)?.body).toMatch(
      /^Жеткізуші өтінім бойынша бас тартты: .+\. Басқа ұсыныстарды қараңыз$/,
    );
    await sleep(1_500);
    expect(await notificationsOf("subject_id = $1", [cancelled.id])).toHaveLength(0);

    const en = await customer({ lang: "en" });
    await register(en);
    const silent = await place(en, offer);
    await db.query(
      "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
      [silent.id],
    );
    await sweep();
    const expired = await pushOf(silent.id, "order_expired_no_response");
    expect(sentPushes().find((push) => push.data.notificationId === expired.id)?.body).toBe(
      "The supplier didn't reply in time — the order is cancelled. See other offers",
    );

    // The club access ends after the order was placed: «Поставщик», by the rule of order-views.
    const lapsed = await customer();
    await register(lapsed);
    const order = await place(lapsed, offer);
    await ok(
      asAdmin("post", "/admin/club-access/revoke", { phone: lapsed.phone, reason: "Тест" }),
      (body) => body,
    );
    await act(shop, order.id, "accept");
    const accepted = await pushOf(order.id, "order_accepted");
    const body = sentPushes().find((push) => push.data.notificationId === accepted.id)!.body;
    expect(body.startsWith("Поставщик принял заявку: ")).toBe(true);
    expect(body).not.toContain("Шины Юг");
    // The order's own screen keeps the name (edge case 17.5).
    expect((await userOrder(lapsed, order.id)).supplier.name).toBe("Шины Юг");
  }, 120_000);

  it("pushes the terms of an order under order and the times of a service, not the user's «yes»", async () => {
    const shop = await company("Под заказ");
    const onOrder = await putOffer(shop, "on_order");
    const buyer = await customer();
    await register(buyer);

    const confirmed = await place(buyer, onOrder);
    await act(shop, confirmed.id, "accept");
    const term = await pushOf(confirmed.id, "order_confirmed");
    expect(term.template_code).toBe("term_confirmed");
    expect(sentPushes().find((push) => push.data.notificationId === term.id)?.body).toMatch(
      /^Поставщик подтвердил срок: до \d+ [а-я]+$/,
    );
    await db.query(
      "UPDATE customer_order SET supply_overdue_at = now() - interval '1 minute' WHERE id = $1",
      [confirmed.id],
    );
    await sweep();
    const overdue = await pushOf(confirmed.id, "supply_overdue");
    expect(sentPushes().find((push) => push.data.notificationId === overdue.id)?.body).toMatch(
      /^Срок поставки прошёл: .+\. Свяжитесь с поставщиком$/,
    );

    const proposed = await place(buyer, onOrder);
    const options = await ok(
      shop.as("get", `/supplier/orders/${proposed.id}/term-options`),
      (body) => supplierOrderTermOptionsSchema.parse(body),
    );
    await act(shop, proposed.id, "propose-term", { readyOn: options.options.at(-1)!.readyOn });
    const offered = await pushOf(proposed.id, "term_proposed");
    expect(sentPushes().find((push) => push.data.notificationId === offered.id)?.body).toMatch(
      /^Поставщик предлагает срок до \d+ [а-я]+\. Ответьте до \d\d:\d\d, \d+ [а-я]+$/,
    );
    const now = await userOrder(buyer, proposed.id);
    await ok(
      buyer.as("post", `/orders/${proposed.id}/term/agree`, { expectedVersion: now.version }),
      (body) => body,
    );
    await sleep(1_500);
    // The user's own «yes» is no push.
    expect(
      (await notificationsOf("subject_id = $1", [proposed.id])).map((row) => row.event_kind),
    ).toEqual(["term_proposed"]);

    const garage = await company("Сервис", "services");
    const service = await putService(garage);
    const carId = await addCar(buyer);
    const visit = await book(buyer, service, carId);
    await act(garage, visit.id, "accept");
    const time = await pushOf(visit.id, "order_confirmed");
    expect(time.template_code).toBe("time_confirmed");
    expect(sentPushes().find((push) => push.data.notificationId === time.id)?.body).toMatch(
      /^Ждём вас \d+ [а-я]+ в \d\d:\d\d, Сервис$/,
    );
    const other = await book(buyer, service, carId);
    const slots = await ok(garage.as("get", `/supplier/orders/${other.id}/time-options`), (body) =>
      supplierOrderTimeOptionsSchema.parse(body),
    );
    const day = slots.days.at(-1)!;
    await act(garage, other.id, "propose-time", {
      visitAt: new Date(`${day.date}T12:00:00+05:00`).toISOString(),
    });
    const timeOffer = await pushOf(other.id, "time_proposed");
    expect(sentPushes().find((push) => push.data.notificationId === timeOffer.id)?.body).toMatch(
      /^Поставщик предлагает \d+ [а-я]+ в 12:00\. Ответьте до /,
    );
  }, 180_000);

  it("pushes a rejected review text and a failed subscription payment", async () => {
    const shop = await company("Отзывы");
    const offer = await putOffer(shop);
    const buyer = await customer({ lang: "en" });
    await register(buyer);
    const order = await place(buyer, offer);
    await act(shop, order.id, "accept");
    const code = (await userOrder(buyer, order.id)).confirmation!.code;
    await ok(shop.as("post", "/supplier/orders/close", { code }), (body) => body);
    const created = await ok(
      buyer.as("post", "/reviews", {
        orderId: order.id,
        score: 2,
        text: "Отзывы топ, звоните +7 705 555 01 01",
        idempotencyKey: randomUUID(),
      }),
      (body) => body as { review: { id: string } },
      201,
    );
    const reviewId = created.review.id;
    const held = await waitFor("held review", async () => {
      const { rows } = await db.query<{ status: string; version: number }>(
        "SELECT status, version FROM review WHERE id = $1",
        [reviewId],
      );
      return rows[0]?.status === "held" ? rows[0] : undefined;
    });
    await ok(
      asAdmin("post", `/admin/reviews/${reviewId}/reject-text`, {
        expectedVersion: held.version,
        reason: "personal_data",
      }),
      (body) => body,
    );
    const rejected = await pushOf(order.id, "review_text_rejected");
    expect(sentPushes().find((push) => push.data.notificationId === rejected.id)?.body).toBe(
      "Review not published: personal data. You can correct it",
    );
    expect(rejected.payload.target).toEqual({ screen: "order", params: { orderId: order.id } });

    const billing = app.get(BillingOperator);
    const started = await billing.testEvent({
      phone: buyer.phone,
      kind: "started",
      periodEnd: new Date(Date.now() + 30 * 24 * HOUR),
    });
    await waitFor("started applied", async () => {
      const { rows } = await db.query<{ outcome: string }>(
        "SELECT outcome FROM billing_event WHERE id = $1",
        [started.eventId],
      );
      return rows[0]?.outcome === "applied";
    });
    await billing.testEvent({
      phone: buyer.phone,
      kind: "grace_started",
      graceUntil: new Date(Date.now() + 3 * 24 * HOUR),
    });
    const failed = await waitFor("payment push", async () => {
      const rows = await notificationsOf(
        "event_kind = 'payment_failed' AND recipient_account_id = $1",
        [buyer.accountId],
      );
      return rows[0] && rows[0].status !== "queued" ? rows : undefined;
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload.target).toEqual({ screen: "subscription" });
    expect(sentPushes().find((push) => push.data.notificationId === failed[0]!.id)?.body).toBe(
      "We couldn't charge your subscription. Update your payment method to keep access",
    );
  }, 120_000);

  it("sends one push for a race of two employees, none for a rolled-back event, no copy for a repeated job", async () => {
    const shop = await company("Гонка");
    const offer = await putOffer(shop);
    const other = await colleague(shop, "Марат");
    const buyer = await customer();
    await register(buyer);
    for (let round = 0; round < 4; round++) {
      const order = await place(buyer, offer);
      const expectedVersion = await version(shop, order.id);
      await Promise.all([
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion }),
        other.as("post", `/supplier/orders/${order.id}/decline`, {
          expectedVersion,
          reason: "out_of_stock",
        }),
      ]);
      await waitFor("the push of the winner", async () => {
        const rows = await notificationsOf("subject_id = $1", [order.id]);
        return rows.length === 1 && rows[0]!.status === "sent";
      });
      await sleep(500);
      expect(await notificationsOf("subject_id = $1", [order.id])).toHaveLength(1);
    }

    // A rolled-back event: the notification goes with it.
    const notifications = app.get(Notifications);
    const database = app.get(DatabaseService);
    await expect(
      database.db.transaction(async (tx) => {
        await notifications.enqueue(tx, {
          kind: "order_closed",
          template: "order_closed",
          recipientAccountId: buyer.accountId,
          lang: "ru",
          variables: { item: "Колодки" },
          target: { screen: "order", params: { orderId: randomUUID() } },
          subject: { type: "order", id: randomUUID() },
          dedupeKey: "rolled-back",
        });
        throw new Error("the event failed");
      }),
    ).rejects.toThrow("the event failed");
    expect(await notificationsOf("dedupe_key = 'rolled-back'", [])).toHaveLength(0);

    // The same event twice (a repeated job, another worker): one notification.
    const twice = async () =>
      database.db.transaction((tx) =>
        notifications.enqueue(tx, {
          kind: "order_closed",
          template: "order_closed",
          recipientAccountId: buyer.accountId,
          lang: "ru",
          variables: { item: "Колодки" },
          target: { screen: "order", params: { orderId: randomUUID() } },
          subject: { type: "order", id: randomUUID() },
          dedupeKey: "same-event",
        }),
      );
    const [a, b] = await Promise.all([twice(), twice()]);
    expect(a.id).toBe(b.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const [row] = await notificationsOf("dedupe_key = 'same-event'", []);
    await waitFor("sent once", async () => (await deliveries(row!.id))[0]?.status === "sent");
    // The job of the delivery run again: nothing is sent a second time.
    const [delivery] = await deliveries(row!.id);
    const before = sentPushes().length;
    await worker1.get(JobQueue).enqueue(sendPushJob, { deliveryId: delivery!.id });
    await sleep(2_000);
    expect(sentPushes().length).toBe(before);
  }, 180_000);

  it("binds tokens to sessions: a dead token goes, an ended session gets nothing, a token moves with the number", async () => {
    const shop = await company("Токены");
    const offer = await putOffer(shop);
    const buyer = await customer();
    const second = await anotherDevice(buyer);
    const dead = await register(buyer);
    const alive = await register(second);
    for (const provider of providers) provider.deadTokens.add(dead);

    const first = await place(buyer, offer);
    await act(shop, first.id, "accept");
    const push = await pushOf(first.id, "order_accepted");
    expect(push.status).toBe("sent");
    const outcome = await deliveries(push.id);
    expect(outcome.map((d) => d.status).sort()).toEqual(["failed", "sent"]);
    expect(outcome.find((d) => d.status === "failed")?.failure_kind).toBe("invalid_token");
    const { rows: tokens } = await db.query<{ token: string; deactivated_reason: string | null }>(
      "SELECT token, deactivated_reason FROM device_token ORDER BY created_at",
    );
    expect(tokens.find((row) => row.token === dead)?.deactivated_reason).toBe("invalid_token");
    expect(tokens.find((row) => row.token === alive)?.deactivated_reason).toBeNull();

    // Queued while the provider is down, then the session ends: nothing goes to it.
    setMode("unavailable");
    const second2 = await place(buyer, offer);
    await act(shop, second2.id, "accept");
    const waiting = await waitFor("queued", async () => {
      const rows = await notificationsOf("subject_id = $1", [second2.id]);
      return rows[0];
    });
    await ok(second.as("post", "/auth/logout"), (body) => body);
    setMode("ok");
    await waitFor(
      "cancelled",
      async () => (await deliveries(waiting.id)).every((d) => d.status === "cancelled"),
      60_000,
    );
    expect(sentPushes().filter((push) => push.data.notificationId === waiting.id)).toHaveLength(0);
    // A new event: the person has no device on push any more.
    const third = await place(buyer, offer);
    await act(shop, third.id, "accept");
    expect((await pushOf(third.id, "order_accepted")).status).toBe("no_device");

    // «Завершить на всех других» and the administrator end sessions the same way.
    const phoneA = await anotherDevice(buyer);
    const phoneB = await anotherDevice(buyer);
    await register(phoneA);
    const tokenB = await register(phoneB);
    await ok(phoneA.as("post", "/auth/sessions/end-others"), (body) => body);
    const fourth = await place(phoneA, offer);
    await act(shop, fourth.id, "accept");
    const pushed = await pushOf(fourth.id, "order_accepted");
    expect(
      sentPushes()
        .filter((p) => p.data.notificationId === pushed.id)
        .map((p) => p.token),
    ).not.toContain(tokenB);
    expect(sentPushes().filter((p) => p.data.notificationId === pushed.id)).toHaveLength(1);

    // The same phone signed in with another number: the token moves to it.
    const shared = newToken();
    await register(phoneA, shared);
    const stranger = await customer();
    await register(stranger, shared);
    const { rows: moved } = await db.query<{ account_id: string }>(
      "SELECT account_id FROM device_token WHERE token = $1",
      [shared],
    );
    expect(moved).toEqual([{ account_id: stranger.accountId }]);
    const fifth = await place(phoneA, offer);
    await act(shop, fifth.id, "accept");
    expect((await pushOf(fifth.id, "order_accepted")).status).toBe("no_device");

    // The cleanup: tokens of ended sessions off push; old ones deleted.
    await configure({ push_token_retention_days: 1 });
    await db.query(
      "UPDATE device_token SET deactivated_at = now() - interval '2 days', deactivated_reason = 'removed' WHERE token = $1",
      [dead],
    );
    await new SweepRunner(app.get(DatabaseService)).run(
      deviceTokenCleanupJob,
      new DeviceTokenCleanup(app.get(AppSettings)),
      { signal: new AbortController().signal },
    );
    const { rows: left } = await db.query<{ token: string; deactivated_reason: string | null }>(
      "SELECT token, deactivated_reason FROM device_token",
    );
    expect(left.map((row) => row.token)).not.toContain(dead);
    expect(left.find((row) => row.token === tokenB)?.deactivated_reason).toBe("session_ended");
  }, 180_000);

  it("retries an unavailable provider and dead-letters, refuses once, leaves «unknown», recovers an interruption", async () => {
    await configure({ push_send_attempts: 2, push_retry_delay_seconds: 1 });
    const shop = await company("Провайдер");
    const offer = await putOffer(shop);
    const buyer = await customer();
    await register(buyer);

    setMode("unavailable");
    const down = await place(buyer, offer);
    await act(shop, down.id, "accept");
    const failed = await pushOf(down.id, "order_accepted");
    await waitFor(
      "failed",
      async () => (await deliveries(failed.id))[0]?.status === "failed",
      60_000,
    );
    const [exhausted] = await deliveries(failed.id);
    expect(exhausted).toMatchObject({ attempts: 2, failure_kind: "unavailable" });
    // The queue moves the failed job to its dead letter queue a moment after.
    const dead = await waitFor("the dead job", async () => {
      const { rows } = await db.query(
        "SELECT id FROM pgboss.job WHERE name = 'notifications.send.dead' AND data->>'deliveryId' = $1",
        [exhausted!.id],
      );
      return rows.length > 0 ? rows : undefined;
    });
    expect(dead).toHaveLength(1);
    setMode("ok");
    await app.get(NotificationsAdmin).retry(failed.id);
    await waitFor(
      "sent after retry",
      async () => (await deliveries(failed.id))[0]?.status === "sent",
    );

    setMode("rejected");
    const refused = await place(buyer, offer);
    await act(shop, refused.id, "accept");
    const once = await pushOf(refused.id, "order_accepted");
    await waitFor("refused", async () => (await deliveries(once.id))[0]?.status === "failed");
    expect((await deliveries(once.id))[0]).toMatchObject({ attempts: 1, failure_kind: "rejected" });

    setMode("unknown");
    const lost = await place(buyer, offer);
    await act(shop, lost.id, "accept");
    const unknown = await pushOf(lost.id, "order_accepted");
    expect(unknown.status).toBe("unknown");
    await sleep(2_500);
    expect((await deliveries(unknown.id))[0]).toMatchObject({ status: "unknown", attempts: 1 });
    setMode("ok");

    // An interrupted attempt: `sending` with its claim run out — recovered, never sent again.
    const [row] = await deliveries(failed.id);
    await db.query(
      "UPDATE notification_delivery SET status = 'sending', settled_at = NULL, claimed_until = now() - interval '5 minutes', provider_message_id = NULL WHERE id = $1",
      [row!.id],
    );
    const before = sentPushes().length;
    await new SweepRunner(app.get(DatabaseService)).run(
      pushRecoveryJob,
      new InterruptedPushSweep(),
      {
        signal: new AbortController().signal,
      },
    );
    expect((await deliveries(failed.id))[0]?.status).toBe("unknown");
    expect(sentPushes().length).toBe(before);
  }, 180_000);

  it("calls the provider with no transaction open and no row locked", async () => {
    const shop = await company("Медленно");
    const offer = await putOffer(shop);
    const buyer = await customer();
    await register(buyer);
    setMode("slow", 3_000);
    const order = await place(buyer, offer);
    await act(shop, order.id, "accept");
    await waitFor("sending", async () => {
      const { rows } = await db.query(
        "SELECT 1 FROM notification_delivery WHERE status = 'sending'",
      );
      return rows.length > 0;
    });
    let fewest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
      );
      fewest = Math.min(fewest, Number(rows[0]!.count));
      await sleep(60);
    }
    expect(fewest).toBe(0);
    // The delivery row can be taken while the provider still thinks.
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SELECT id FROM notification_delivery WHERE status = 'sending' FOR UPDATE");
    await db.query("ROLLBACK");
    await pushOf(order.id, "order_accepted");
  }, 120_000);

  it("confirms only one's own push, and the order's screen confirms its pushes", async () => {
    const shop = await company("Подтверждения");
    const offer = await putOffer(shop);
    const buyer = await customer();
    await register(buyer);
    const stranger = await customer();
    const order = await place(buyer, offer);
    await act(shop, order.id, "accept");
    const push = await pushOf(order.id, "order_accepted");

    expectError(await stranger.as("post", `/notifications/${push.id}/ack`), 404, "NOT_FOUND");
    expectError(await buyer.as("post", `/notifications/${randomUUID()}/ack`), 404, "NOT_FOUND");
    expectError(await shop.as("post", `/notifications/${push.id}/ack`), 403, "FORBIDDEN");
    expectError(await asAdmin("post", `/notifications/${push.id}/ack`), 403, "FORBIDDEN");
    const guest = await http().post(`/notifications/${push.id}/ack`).set("X-Client", IOS);
    expect(guest.status).toBe(401);
    expectError(
      await shop.as("put", "/notifications/device-token", {
        platform: "android",
        token: newToken(),
      }),
      403,
      "FORBIDDEN",
    );

    const first = await ok(
      buyer.as("post", `/notifications/${push.id}/ack`),
      (body) => body as { ackedAt: string },
    );
    const again = await ok(
      buyer.as("post", `/notifications/${push.id}/ack`),
      (body) => body as { ackedAt: string },
    );
    expect(again.ackedAt).toBe(first.ackedAt);

    await act(shop, order.id, "ready");
    const ready = await pushOf(order.id, "order_ready");
    expect(ready.acked_at).toBeNull();
    expectError(
      await stranger.as("post", `/orders/${order.id}/notifications/ack`),
      404,
      "NOT_FOUND",
    );
    expect(
      await ok(buyer.as("post", `/orders/${order.id}/notifications/ack`), (body) => body),
    ).toEqual({ acked: 1 });
    expect((await notificationsOf("id = $1", [ready.id]))[0]!.acked_at).not.toBeNull();

    // The share of pushes nobody confirmed, as a metric.
    const metrics = await http().get("/metrics");
    expect(metrics.text).toMatch(/adclub_push_unacked_ratio \d/);
    expect(metrics.text).toMatch(
      /adclub_push_notifications\{kind="order_accepted",status="sent"\} \d/,
    );
  }, 120_000);

  it("never lets a code, a QR, a phone, an address, an employee's name or a whole token out", async () => {
    const shop = await company("Утечки");
    const offer = await putOffer(shop);
    const buyer = await customer();
    const device = await register(buyer);
    const order = await place(buyer, offer);
    await act(shop, order.id, "accept");
    await act(shop, order.id, "ready");
    await pushOf(order.id, "order_ready");
    const { rows } = await db.query<{ payload: unknown }>("SELECT payload FROM notification");
    const stored =
      JSON.stringify(rows) + JSON.stringify(sentPushes().map((push) => [push.body, push.data]));
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain("Айгерим");
    expect(stored).not.toContain("Тестовая");
    const logged = appLogText(output.text());
    expect(logged).not.toContain(device);
    expect(logged).not.toContain("APA91b");
    expect(JSON.stringify(await app.get(NotificationsAdmin).list({}))).not.toContain(device);
  }, 120_000);
});
