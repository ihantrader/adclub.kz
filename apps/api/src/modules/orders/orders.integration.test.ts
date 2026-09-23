import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminOrderPageSchema,
  adminOrderResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  declineOrderResponseSchema,
  ORDER_QR_PREFIX,
  orderStateConflictDetailsSchema,
  supplierMemberAddedResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderPageSchema,
  supplierOrderResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  userOrderPageSchema,
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
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { JobAdmin, JobRegistry, SweepRunner, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TcpProxy } from "../../testing/tcp-proxy";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { OrderDeadlineSweeper, orderDeadlinesJob } from "./order-deadlines";
import { OrderTransitions } from "./order-transitions";

/**
 * TASK-021 end to end on a real PostgreSQL and Redis (behind TCP proxies,
 * to take them away): creating an order — club access, the showcase, the
 * quantity and its limit, the snapshot and the total, the number, the code
 * and the QR, the limit of creations, one order for a repeated key; the
 * state machine as conditional updates — two employees at once, a cancel
 * against an accept, a deadline at the moment of accepting, final
 * statuses; the deadlines by the sweeper, idempotent, after a worker was
 * down; what each side sees — the phone after accepting, the point after
 * accepting (D-026), the journal with names for the supplier and the
 * administrator only; test orders of employees; the access matrix; and
 * the code and the QR in no answer to the supplier or the administrator,
 * no journal, no log line and no monitoring event.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";

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

/** Around the clock every day: a reserve counts from the moment of accepting. */
const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3_600_000;

/** Stands in for the error monitoring service: keeps every envelope it is sent. */
class TestReceiver {
  readonly bodies: string[] = [];
  private server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        this.bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  text(): string {
    return this.bodies.join("\n");
  }
}

describe("orders on items in stock (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let pgProxy: TcpProxy;
  let redisProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let receiver: TestReceiver;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let almaty: string;
  let padsId: string;
  let trwId: string;
  let rearPadsId: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let token: string;
  /** Every confirmation code and QR token handed out in this file. */
  const codes = new Set<string>();
  const qrTokens = new Set<string>();

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    redis = new Redis(redisContainer.getConnectionUrl());
    redisProxy = new TcpProxy(redisContainer.getHost(), redisContainer.getPort());
    await redisProxy.start();
    pgProxy = new TcpProxy(postgres.getHost(), postgres.getPort());
    await pgProxy.start();
    receiver = new TestReceiver();
    await receiver.start();
    const through = new URL(postgres.getConnectionUri());
    through.hostname = "127.0.0.1";
    through.port = String(pgProxy.port);
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: through.toString(),
      REDIS_URL: `redis://127.0.0.1:${redisProxy.port}`,
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test-secret",
      S3_BUCKET: "test",
      TRUST_PROXY: "true",
      MONITORING_DSN: `http://publickey@127.0.0.1:${receiver.port}/7`,
      MONITORING_ENVIRONMENT: "integration",
    });
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
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
    await redisProxy?.stop();
    await pgProxy?.stop();
    await receiver?.stop();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await db.query(TRUNCATE_ALL);
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
    });
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
    almaty = await ok(
      asAdmin("post", "/admin/cities", { code: "almaty", names: { ru: "Алматы", kk: "Алматы" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
    const item = async (brandKey: string, article: string) =>
      idOf(
        "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
        [brandKey, normalizeArticle(article)],
      );
    padsId = await item("geely", PADS);
    trwId = await item("trw", "GDB3534");
    rearPadsId = await item("geely", "4050068800");
  }, 120_000);

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
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
    rememberCode(phone);
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
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return body.session.accessToken;
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
    apiErrorResponseSchema.parse(response.body);
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

  /**
   * Checks an answer against its schema and returns it as it came: zod
   * drops keys a schema doesn't name, and «the field is absent for this
   * side» must be checked on what the server actually sent.
   */
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
    as: As;
  }

  interface Company {
    supplierId: string;
    name: string;
    address: string;
    district: string;
    contactPhone: string;
    first: Employee;
    as: As;
  }

  /** A supplier with its point (around the clock unless told) and its first employee signed in. */
  async function company(
    name: string,
    options: { hours?: DayHours[] | null; firstName?: string } = {},
  ): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    const contactPhone = phoneOf(500 + phoneCounter);
    rememberCode(phone, contactPhone);
    const address = `ул. ${name}, ${String(phoneCounter)}`;
    const district = `Район ${name}`;
    const firstName = options.firstName ?? "Айгерим";
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: "goods",
        contactPhone,
        address,
        district,
        firstMember: { name: firstName, phone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    const hours = options.hours === undefined ? ALWAYS : options.hours;
    if (hours) {
      await ok(
        asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
          expectedVersion: created.supplier.version,
          weeklyHours: hours,
          closedDates: [],
        }),
        (body) => adminSupplierResponseSchema.parse(body),
      );
    }
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    const as: As = (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body);
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 AND m.supplier_id = $2",
      [phone, created.supplier.id],
    );
    return {
      supplierId: created.supplier.id,
      name,
      address,
      district,
      contactPhone,
      first: { memberId, name: firstName, as },
      as,
    };
  }

  /** Another employee of the company, added in the cabinet and signed in. */
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
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function put(of: Company, itemId: string, extra: object = {}): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId,
        price: 6_500,
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: true,
        ...extra,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  interface Customer {
    phone: string;
    accountId: string;
    as: As;
  }

  /** A user of the app, with club access unless told otherwise. */
  async function customer(options: { access?: boolean } = {}): Promise<Customer> {
    const phone = `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    if (options.access !== false) {
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
    return {
      phone,
      accountId: await idOf("SELECT id FROM account WHERE phone = $1", [phone]),
      as: (method, path, body) => call(bearer, IOS, method, path, body),
    };
  }

  function note(order: UserOrder): UserOrder {
    if (order.confirmation) {
      codes.add(order.confirmation.code);
      rememberCode(order.confirmation.code);
      const token = order.confirmation.qrPayload.slice(ORDER_QR_PREFIX.length);
      qrTokens.add(token);
      rememberSecret(token);
    }
    return order;
  }

  function orderBody(offer: SupplierOffer, extra: object = {}) {
    return {
      offerId: offer.id,
      quantity: 1,
      fulfillment: "pickup",
      expectedPrice: offer.price,
      idempotencyKey: randomUUID(),
      ...extra,
    };
  }

  async function place(
    who: Customer,
    offer: SupplierOffer,
    extra: object = {},
  ): Promise<UserOrder> {
    return ok(
      who.as("post", "/orders", orderBody(offer, extra)),
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

  async function accept(by: Employee | Company, orderId: string, expectedVersion = 1) {
    return ok(
      by.as("post", `/supplier/orders/${orderId}/accept`, { expectedVersion }),
      (body) => checked(supplierOrderResponseSchema)(body).order,
    );
  }

  /** The deadline sweeper, one run, in this process (the worker's own is tested below). */
  async function sweep() {
    const sweeper = new OrderDeadlineSweeper(
      { sweep: () => undefined } as unknown as JobRegistry,
      app.get(OrderTransitions),
    );
    return new SweepRunner(app.get(DatabaseService)).run(orderDeadlinesJob, sweeper, {
      signal: new AbortController().signal,
    });
  }

  async function events(orderId: string) {
    const { rows } = await db.query<{
      action: string;
      from_status: string | null;
      to_status: string | null;
      actor_type: string;
      actor_member_id: string | null;
      payload: Record<string, unknown>;
    }>(
      "SELECT action, from_status, to_status, actor_type, actor_member_id, payload FROM order_event WHERE order_id = $1 ORDER BY seq",
      [orderId],
    );
    return rows;
  }

  async function row(orderId: string) {
    const { rows } = await db.query<{
      status: string;
      version: number;
      respond_by: Date;
      expires_at: Date | null;
      reserve_warn_at: Date | null;
      reserve_warned_at: Date | null;
      accepted_at: Date | null;
      created_at: Date;
    }>("SELECT * FROM customer_order WHERE id = $1", [orderId]);
    return rows[0]!;
  }

  // ------------------------------------------------------------- creating

  describe("creating an order", () => {
    it("needs a user with club access; creates it with the snapshot, the total, a number, the code and the QR", async () => {
      const shop = await company("Автомаркет");
      const offer = await put(shop, padsId, { price: 6_500, warrantyMonths: 12 });

      // A guest — sign in first; a user without club access — the subscription.
      expectError(
        await http().post("/orders").set("X-Client", IOS).send(orderBody(offer)),
        401,
        "AUTH_REQUIRED",
      );
      const stranger = await customer({ access: false });
      expectError(
        await stranger.as("post", "/orders", orderBody(offer)),
        403,
        "SUBSCRIPTION_REQUIRED",
      );
      expect(await db.query("SELECT 1 FROM customer_order")).toMatchObject({ rowCount: 0 });

      const buyer = await customer();
      const before = Date.now();
      const created = await ok(
        buyer.as(
          "post",
          "/orders",
          orderBody(offer, { quantity: 2, comment: "Позвоните\nпосле 18" }),
        ),
        (body) => checked(createOrderResponseSchema)(body),
        201,
      );
      expect(created.created).toBe(true);
      const order = note(created.order);
      expect(order).toMatchObject({
        status: "created",
        kind: "stock",
        isTest: false,
        quantity: 2,
        unitPrice: 6_500,
        total: 13_000,
        currency: "KZT",
        fulfillment: "pickup",
        comment: "Позвоните\nпосле 18",
        item: { id: padsId, article: PADS, brand: "Geely", name: { isFallback: false } },
        terms: {
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: true,
          warrantyMonths: 12,
        },
        supplier: { name: "Автомаркет", cityName: "Алматы", district: shop.district },
        reserveUntil: null,
        receiptOn: null,
        history: [{ action: "create", status: "created", by: "user" }],
      });
      expect(order.number).toBeGreaterThanOrEqual(1001);
      expect(order.confirmation?.code).toMatch(/^\d{6}$/);
      expect(order.confirmation?.qrPayload).toMatch(
        new RegExp(`^${ORDER_QR_PREFIX}[A-Za-z0-9_-]{22}$`),
      );
      // Until the supplier accepts: no address, no hours, no phone (D-026).
      expect(order).not.toHaveProperty("pickupPoint");
      // The answer is due within the setting (2 hours by default).
      const respondBy = new Date(order.respondBy).getTime();
      expect(respondBy - new Date(order.createdAt).getTime()).toBe(2 * HOUR);
      expect(respondBy).toBeGreaterThanOrEqual(before + 2 * HOUR - 1000);

      // The next order gets the next number and its own code.
      const next = await place(buyer, offer, { allowAnotherActive: true });
      expect(next.number).toBe(order.number + 1);
      expect(next.confirmation?.code).not.toBe(order.confirmation?.code);

      // The journal: the creation by the user, with the details and nothing secret.
      const journal = await events(order.id);
      expect(journal).toEqual([
        {
          action: "create",
          from_status: null,
          to_status: "created",
          actor_type: "user",
          actor_member_id: null,
          payload: { quantity: 2, total: 13_000, fulfillment: "pickup" },
        },
      ]);
    });

    it("takes a quantity from 1 to the setting", async () => {
      const shop = await company("Количество");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      for (const quantity of [0, -1, 1.5, 1000]) {
        expectError(
          await buyer.as("post", "/orders", orderBody(offer, { quantity })),
          400,
          "VALIDATION_ERROR",
        );
      }
      await settings.set({ order_max_quantity: 3 });
      const over = await buyer.as("post", "/orders", orderBody(offer, { quantity: 4 }));
      expectError(over, 400, "VALIDATION_ERROR");
      expect(over.body.details).toEqual([expect.objectContaining({ path: "quantity" })]);
      const { quantity: _left, ...withoutQuantity } = orderBody(offer);
      const single = await ok(
        buyer.as("post", "/orders", withoutQuantity),
        (body) => note(checked(createOrderResponseSchema)(body).order),
        201,
      );
      expect(single).toMatchObject({ quantity: 1, total: offer.price });
      expect((await place(buyer, offer, { quantity: 3, allowAnotherActive: true })).total).toBe(
        3 * offer.price,
      );
    });

    it("orders only from an offer on the showcase, under its terms and the price the user saw", async () => {
      const shop = await company("Витрина");
      const buyer = await customer();

      // Unknown and withdrawn — the same answer.
      const withdrawn = await put(shop, trwId);
      await ok(
        shop.as("post", `/supplier/offers/${withdrawn.id}/withdraw`, { expectedVersion: 1 }),
        (b) => b,
      );
      expectError(
        await buyer.as("post", "/orders", orderBody({ ...withdrawn, id: randomUUID() })),
        409,
        "ORDER_OFFER_UNAVAILABLE",
      );
      expectError(
        await buyer.as("post", "/orders", orderBody(withdrawn)),
        409,
        "ORDER_OFFER_UNAVAILABLE",
      );

      // The supplier paused, the point without hours.
      const paused = await company("Пауза");
      const pausedOffer = await put(paused, padsId);
      const version = (
        await ok(asAdmin("get", `/admin/suppliers/${paused.supplierId}`), (b) =>
          adminSupplierResponseSchema.parse(b),
        )
      ).supplier.version;
      await ok(
        asAdmin("post", `/admin/suppliers/${paused.supplierId}/pause`, {
          expectedVersion: version,
          paused: true,
          reason: "admin",
          note: "Проверка",
        }),
        (b) => b,
      );
      expectError(
        await buyer.as("post", "/orders", orderBody(pausedOffer)),
        409,
        "ORDER_OFFER_UNAVAILABLE",
      );
      const closed = await company("Без часов", { hours: null });
      const closedOffer = await put(closed, padsId);
      expectError(
        await buyer.as("post", "/orders", orderBody(closedOffer)),
        409,
        "ORDER_OFFER_UNAVAILABLE",
      );

      // Under order — EPIC-13; pickup only — no delivery.
      const onOrder = await put(shop, padsId, { availability: "on_order", leadDays: 3 });
      expectError(
        await buyer.as("post", "/orders", orderBody(onOrder)),
        409,
        "ORDER_KIND_NOT_SUPPORTED",
      );
      const pickupOnly = await put(shop, rearPadsId, { delivery: false });
      expectError(
        await buyer.as("post", "/orders", orderBody(pickupOnly, { fulfillment: "delivery" })),
        409,
        "ORDER_FULFILLMENT_UNAVAILABLE",
      );

      // Another price than the one seen.
      const changed = await buyer.as(
        "post",
        "/orders",
        orderBody(pickupOnly, { expectedPrice: 5_000 }),
      );
      expectError(changed, 409, "ORDER_PRICE_CHANGED");
      expect(changed.body.details).toEqual({
        expectedPrice: 5_000,
        currentPrice: pickupOnly.price,
      });
      expect(await db.query("SELECT 1 FROM customer_order")).toMatchObject({ rowCount: 0 });
    });

    it("asks before a second active order on the same offer", async () => {
      const shop = await company("Дубль");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const first = await place(buyer, offer);
      const again = await buyer.as("post", "/orders", orderBody(offer));
      expectError(again, 409, "ORDER_DUPLICATE_ACTIVE");
      expect(again.body.details).toEqual({ existingOrderId: first.id, number: first.number });
      const second = await place(buyer, offer, { allowAnotherActive: true });
      expect(second.id).not.toBe(first.id);
      // A final order doesn't count.
      await ok(buyer.as("post", `/orders/${first.id}/cancel`), (b) => b);
      await ok(buyer.as("post", `/orders/${second.id}/cancel`), (b) => b);
      await place(buyer, offer);
    });

    it("limits creations per user; a repeat and a refused order don't count", async () => {
      await settings.set({
        order_create_per_account: 2,
        order_create_per_account_window_seconds: 600,
      });
      const shop = await company("Лимит");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const body = orderBody(offer);
      await ok(
        buyer.as("post", "/orders", body),
        (b) => note(checked(createOrderResponseSchema)(b).order),
        201,
      );
      // The same key again: the same order, not a new count.
      await ok(
        buyer.as("post", "/orders", body),
        (b) => note(checked(createOrderResponseSchema)(b).order),
        201,
      );
      // Refused (another price) — refunded.
      expectError(
        await buyer.as(
          "post",
          "/orders",
          orderBody(offer, { expectedPrice: 1, allowAnotherActive: true }),
        ),
        409,
        "ORDER_PRICE_CHANGED",
      );
      await place(buyer, offer, { allowAnotherActive: true });
      const limited = await buyer.as(
        "post",
        "/orders",
        orderBody(offer, { allowAnotherActive: true }),
      );
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details).toMatchObject({ limit: "order_create_per_account" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      // Another user has a limit of their own.
      await place(await customer(), offer);
    });

    it("creates the order without Redis; without the database answers 503", async () => {
      const shop = await company("Без Redis");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      await redisProxy.stop();
      try {
        const created = await place(buyer, offer);
        expect(created.status).toBe("created");
      } finally {
        await redisProxy.start();
      }
      await pgProxy.stop();
      try {
        const down = await buyer.as(
          "post",
          "/orders",
          orderBody(offer, { allowAnotherActive: true }),
        );
        expectError(down, 503, "SERVICE_UNAVAILABLE");
        expect(down.body.retryable).toBe(true);
      } finally {
        await pgProxy.start();
      }
      // Back: the database serves again.
      let back: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        back = await buyer.as("post", "/orders", orderBody(offer, { allowAnotherActive: true }));
        if (back.status === 201) {
          break;
        }
        await sleep(200);
      }
      expect(back?.status).toBe(201);
      note(checked(createOrderResponseSchema)(back!.body).order);
    });

    it("keeps its snapshot whatever happens to the offer, the supplier and the item later", async () => {
      const shop = await company("Снимок");
      const offer = await put(shop, padsId, { price: 6_500, warrantyText: "12 месяцев по чеку" });
      const buyer = await customer();
      const order = await place(buyer, offer, { quantity: 2 });

      // The price changes, the offer is withdrawn, the supplier paused, the item archived.
      await ok(
        shop.as("patch", `/supplier/offers/${offer.id}`, { expectedVersion: 1, price: 9_900 }),
        (b) => b,
      );
      await ok(
        shop.as("post", `/supplier/offers/${offer.id}/withdraw`, { expectedVersion: 2 }),
        (b) => b,
      );
      const itemVersion = (
        await ok(
          asAdmin("get", `/admin/catalog/items/${padsId}`),
          (b) => b as { item: { version: number } },
        )
      ).item.version;
      await ok(
        asAdmin("post", `/admin/catalog/items/${padsId}/status`, {
          expectedVersion: itemVersion,
          status: "archived",
        }),
        (b) => b,
      );
      const version = (
        await ok(asAdmin("get", `/admin/suppliers/${shop.supplierId}`), (b) =>
          adminSupplierResponseSchema.parse(b),
        )
      ).supplier.version;
      await ok(
        asAdmin("post", `/admin/suppliers/${shop.supplierId}/pause`, {
          expectedVersion: version,
          paused: true,
          reason: "admin",
          note: "Проверка",
        }),
        (b) => b,
      );

      const seen = await userOrder(buyer, order.id);
      expect(seen).toMatchObject({
        unitPrice: 6_500,
        total: 13_000,
        terms: { warrantyText: "12 месяцев по чеку" },
        item: { id: padsId, article: PADS },
      });
      // The order stays in force (PRODUCT 10.6): the supplier still accepts it.
      const accepted = await accept(shop, order.id);
      expect(accepted).toMatchObject({ status: "accepted", unitPrice: 6_500, total: 13_000 });
      // The user's access ending doesn't stop it either (edge case 17.5).
      await ok(
        asAdmin("post", "/admin/club-access/revoke", { phone: buyer.phone, reason: "Тест" }),
        (b) => b,
      );
      const after = await userOrder(buyer, order.id);
      expect(after.status).toBe("accepted");
      expect(after.pickupPoint?.address).toBe(shop.address);
      expect(after.supplier.name).toBe("Снимок");
    });
  });

  // ----------------------------------------------------------- repeating

  describe("repeating a request", () => {
    it("never creates a second order for the same key, even sent at once", async () => {
      const shop = await company("Двойное нажатие");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const body = orderBody(offer, { quantity: 2 });
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => buyer.as("post", "/orders", body)),
      );
      const parsed = answers.map((answer) => {
        expect(answer.status, JSON.stringify(answer.body)).toBe(201);
        const response = checked(createOrderResponseSchema)(answer.body);
        note(response.order);
        return response;
      });
      expect(new Set(parsed.map((entry) => entry.order.id)).size).toBe(1);
      expect(parsed.filter((entry) => entry.created)).toHaveLength(1);
      expect(new Set(parsed.map((entry) => entry.order.confirmation?.code)).size).toBe(1);
      expect(await db.query("SELECT 1 FROM customer_order")).toMatchObject({ rowCount: 1 });
      expect(await db.query("SELECT 1 FROM order_event")).toMatchObject({ rowCount: 1 });

      // The same key for another order — refused, nothing made.
      expectError(
        await buyer.as("post", "/orders", { ...body, quantity: 3 }),
        409,
        "ORDER_IDEMPOTENCY_MISMATCH",
      );
      // Another user's key space is their own.
      const other = await customer();
      const theirs = await ok(
        other.as("post", "/orders", body),
        (b) => checked(createOrderResponseSchema)(b),
        201,
      );
      note(theirs.order);
      expect(theirs.created).toBe(true);
    });

    it("repeats an action of the same person harmlessly", async () => {
      const shop = await company("Повтор");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const [one, two] = await Promise.all([
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
      ]);
      expect([one.status, two.status]).toEqual([200, 200]);
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 2 }),
        (b) => b,
      );
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 2 }),
        (b) => b,
      );
      await ok(buyer.as("post", `/orders/${order.id}/cancel`), (b) => b);
      const again = await ok(
        buyer.as("post", `/orders/${order.id}/cancel`),
        (b) => checked(userOrderResponseSchema)(b).order,
      );
      expect(again).toMatchObject({ status: "cancelled_by_user", version: 4 });
      expect((await events(order.id)).map((entry) => entry.action)).toEqual([
        "create",
        "accept",
        "mark_ready",
        "cancel",
      ]);
    });
  });

  // ----------------------------------------------------------- the machine

  describe("moves of the state machine", () => {
    it("lets exactly one of two employees win, and tells the other who acted", async () => {
      const shop = await company("Двое", { firstName: "Айгерим" });
      const marat = await colleague(shop, "Марат");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      for (let round = 0; round < 6; round += 1) {
        const order = await place(buyer, offer, { allowAnotherActive: true });
        const [accepting, declining] = round % 2 === 0 ? [shop.first, marat] : [marat, shop.first];
        const [accepted, declined] = await Promise.all([
          accepting.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
          declining.as("post", `/supplier/orders/${order.id}/decline`, {
            expectedVersion: 1,
            reason: "other",
          }),
        ]);
        const statuses = [accepted.status, declined.status].sort();
        expect(statuses, `round ${String(round)}`).toEqual([200, 409]);
        const [winner, loser, loserResponse] =
          accepted.status === 200
            ? [accepting, declining, declined]
            : [declining, accepting, accepted];
        expectError(loserResponse, 409, "ORDER_STATE_CONFLICT");
        const details = orderStateConflictDetailsSchema.parse(loserResponse.body.details);
        expect(details).toMatchObject({
          currentStatus: accepted.status === 200 ? "accepted" : "declined_by_supplier",
          version: 2,
          lastAction: {
            action: accepted.status === 200 ? "accept" : "decline",
            actor: { kind: "member", memberId: winner.memberId, name: winner.name, removed: false },
          },
        });
        const journal = await events(order.id);
        expect(journal.map((entry) => [entry.action, entry.actor_member_id])).toEqual([
          ["create", null],
          [accepted.status === 200 ? "accept" : "decline", winner.memberId],
          ["late_action_ignored", loser.memberId],
        ]);
        expect(journal[2]!.payload).toEqual({
          attemptedAction: accepted.status === 200 ? "decline" : "accept",
        });
        const card = await supplierOrder(marat, order.id);
        expect(card.handledBy).toMatchObject({ memberId: winner.memberId, name: winner.name });
      }
    });

    it("gives a cancel and an accept at once one outcome, never a lost move", async () => {
      const shop = await company("Отмена");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      for (let round = 0; round < 6; round += 1) {
        const order = await place(buyer, offer, { allowAnotherActive: true });
        const [accepted, cancelled] = await Promise.all([
          shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
          buyer.as("post", `/orders/${order.id}/cancel`),
        ]);
        // The user's cancel always wins in the end: before accepting or after it.
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
        const final = await row(order.id);
        expect(final.status).toBe("cancelled_by_user");
        const journal = (await events(order.id)).map((entry) => entry.action);
        if (accepted.status === 200) {
          expect(journal).toEqual(["create", "accept", "cancel"]);
          expect(final.version).toBe(3);
        } else {
          expectError(accepted, 409, "ORDER_STATE_CONFLICT");
          expect(accepted.body.details).toMatchObject({
            currentStatus: "cancelled_by_user",
            lastAction: { action: "cancel", actor: { kind: "user" } },
          });
          expect(journal).toEqual(["create", "cancel", "late_action_ignored"]);
          expect(final.version).toBe(2);
        }
      }
    });

    it("goes created → accepted → ready, declines after accepting, and never moves a final order", async () => {
      const shop = await company("Путь");
      const offer = await put(shop, padsId);
      const buyer = await customer();

      const order = await place(buyer, offer);
      // «Ready» only after accepting.
      expectError(
        await shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 1 }),
        409,
        "ORDER_STATE_CONFLICT",
      );
      await accept(shop, order.id);
      const ready = await ok(
        shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 2 }),
        (b) => checked(supplierOrderResponseSchema)(b).order,
      );
      expect(ready.status).toBe("ready");
      // Out of stock after all: a decline after accepting, with its reason.
      const declined = await ok(
        shop.as("post", `/supplier/orders/${order.id}/decline`, {
          expectedVersion: 3,
          reason: "out_of_stock",
          note: "Нет на складе",
        }),
        (b) => checked(declineOrderResponseSchema)(b),
      );
      expect(declined.order).toMatchObject({
        status: "declined_by_supplier",
        decline: { reason: "out_of_stock", note: "Нет на складе" },
      });
      // «Снять предложение с продажи?» — offered, not done.
      expect(declined.withdrawOffer).toEqual({ offerId: offer.id, version: offer.version });
      expect(
        (
          await ok(shop.as("get", `/supplier/offers/${offer.id}`), (b) =>
            supplierOfferResponseSchema.parse(b),
          )
        ).offer.status,
      ).toBe("active");

      // Final: nothing moves it; the user's refusal names no one.
      const cancel = await buyer.as("post", `/orders/${order.id}/cancel`);
      expectError(cancel, 409, "ORDER_STATE_CONFLICT");
      expect(cancel.body.details).toEqual({ currentStatus: "declined_by_supplier", version: 4 });
      expectError(
        await shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 4 }),
        409,
        "ORDER_STATE_CONFLICT",
      );
      // Another reason: no offer to withdraw.
      const other = await place(buyer, offer);
      const plain = await ok(
        shop.as("post", `/supplier/orders/${other.id}/decline`, { expectedVersion: 1 }),
        (b) => checked(declineOrderResponseSchema)(b),
      );
      expect(plain.withdrawOffer).toBeNull();
      expect(plain.order.decline).toEqual({ reason: null, note: null });
    });

    it("refuses an accept once the answer deadline passed, even before the sweeper came", async () => {
      const shop = await company("Поздно");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 second' WHERE id = $1",
        [order.id],
      );
      const late = await shop.as("post", `/supplier/orders/${order.id}/accept`, {
        expectedVersion: 1,
      });
      expectError(late, 409, "ORDER_STATE_CONFLICT");
      expect(late.body.details).toMatchObject({
        currentStatus: "response_expired",
        lastAction: { action: "expire_no_response", actor: { kind: "system" } },
      });
      expect((await events(order.id)).map((entry) => [entry.action, entry.actor_type])).toEqual([
        ["create", "user"],
        ["expire_no_response", "system"],
        ["late_action_ignored", "supplier_member"],
      ]);
      // The phone never opened.
      expect((await row(order.id)).accepted_at).toBeNull();
      expect((await supplierOrder(shop, order.id)).customer).toEqual({
        kind: "hidden",
        reason: "not_accepted",
      });
    });
  });

  // ------------------------------------------------------------ deadlines

  describe("deadlines", () => {
    it("expires an order without an answer by the setting, once", async () => {
      await settings.set({ supplier_response_hours: 1 });
      const shop = await company("Молчание");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);
      expect(new Date(order.respondBy).getTime() - new Date(order.createdAt).getTime()).toBe(HOUR);
      // A later change of the setting doesn't move a deadline already set (13.4).
      await settings.set({ supplier_response_hours: 5 });
      expect((await row(order.id)).respond_by.toISOString()).toBe(order.respondBy);

      expect((await sweep()).processed).toBe(0);
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      expect((await sweep()).processed).toBe(1);
      expect((await sweep()).processed).toBe(0);
      const expired = await userOrder(buyer, order.id);
      expect(expired).toMatchObject({ status: "response_expired" });
      expect(expired).not.toHaveProperty("confirmation");
      expect(expired.history.map((step) => [step.action, step.by])).toEqual([
        ["create", "user"],
        ["expire_no_response", "system"],
      ]);
      const journal = await events(order.id);
      expect(journal.at(-1)).toMatchObject({
        action: "expire_no_response",
        actor_type: "system",
        payload: { deadline: expect.any(String) },
      });
    });

    it("reserves an accepted pickup order, warns before the end and expires it", async () => {
      await settings.set({ pickup_reserve_hours: 5, reserve_warning_hours: 2 });
      const shop = await company("Резерв");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const accepted = await accept(shop, order.id);
      const acceptedAt = new Date(accepted.handledAt!).getTime();
      expect(new Date(accepted.reserveUntil!).getTime() - acceptedAt).toBe(5 * HOUR);
      const stored = await row(order.id);
      expect(stored.reserve_warn_at!.getTime()).toBe(acceptedAt + 3 * HOUR);

      // The warning: when due, once, without a move.
      await db.query(
        "UPDATE customer_order SET reserve_warn_at = now() - interval '1 second' WHERE id = $1",
        [order.id],
      );
      expect((await sweep()).processed).toBe(1);
      expect((await sweep()).processed).toBe(0);
      expect((await row(order.id)).status).toBe("accepted");
      // The reserve ends.
      await db.query(
        "UPDATE customer_order SET expires_at = now() - interval '1 second' WHERE id = $1",
        [order.id],
      );
      expect((await sweep()).processed).toBe(1);
      const expired = await userOrder(buyer, order.id);
      expect(expired.status).toBe("reserve_expired");
      expect(expired).not.toHaveProperty("pickupPoint");
      const journal = await events(order.id);
      expect(journal.map((entry) => [entry.action, entry.actor_type])).toEqual([
        ["create", "user"],
        ["accept", "supplier_member"],
        ["reserve_expiring", "system"],
        ["expire_reserve", "system"],
      ]);
      // The user's course lists moves only.
      expect(expired.history.map((step) => step.action)).toEqual([
        "create",
        "accept",
        "expire_reserve",
      ]);

      // Delivery has no reserve: it lives until handed over.
      const delivered = await place(buyer, offer, { fulfillment: "delivery" });
      const deliveryAccepted = await accept(shop, delivered.id);
      expect(deliveryAccepted.reserveUntil).toBeNull();
      expect((await row(delivered.id)).reserve_warn_at).toBeNull();
    });

    it("«ready» starts the reserve again, never shorter", async () => {
      await settings.set({ pickup_reserve_hours: 3, reserve_warning_hours: 1 });
      const shop = await company("Готово");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const accepted = await accept(shop, order.id);
      // As if accepted two hours ago: an hour of the reserve left.
      await db.query(
        "UPDATE customer_order SET expires_at = now() + interval '1 hour', reserve_warn_at = now(), reserve_warned_at = now() WHERE id = $1",
        [order.id],
      );
      const ready = await ok(
        shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 2 }),
        (b) => checked(supplierOrderResponseSchema)(b).order,
      );
      const readyAt = Date.now();
      const until = new Date(ready.reserveUntil!).getTime();
      expect(until).toBeGreaterThan(readyAt + 3 * HOUR - 5_000);
      expect(until).toBeLessThanOrEqual(readyAt + 3 * HOUR);
      expect(until).toBeGreaterThan(new Date(accepted.reserveUntil!).getTime() - 3 * HOUR);
      // A new end — a new warning to come.
      expect((await row(order.id)).reserve_warned_at).toBeNull();
      // A longer reserve already promised stays.
      await settings.set({ pickup_reserve_hours: 1 });
      const second = await place(buyer, offer, { allowAnotherActive: true });
      await settings.set({ pickup_reserve_hours: 10 });
      const secondAccepted = await accept(shop, second.id);
      await settings.set({ pickup_reserve_hours: 1 });
      const secondReady = await ok(
        shop.as("post", `/supplier/orders/${second.id}/ready`, { expectedVersion: 2 }),
        (b) => checked(supplierOrderResponseSchema)(b).order,
      );
      expect(secondReady.reserveUntil).toBe(secondAccepted.reserveUntil);
    });

    it("applies everything that fell due while the worker was down, once, in the worker itself", async () => {
      const shop = await company("Простой");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const unanswered = await place(buyer, offer);
      const overdue = await place(buyer, offer, { allowAnotherActive: true });
      const warned = await place(buyer, offer, { allowAnotherActive: true });
      await accept(shop, overdue.id);
      await accept(shop, warned.id);
      // Hours ago, with no worker running.
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '5 hours' WHERE id = $1",
        [unanswered.id],
      );
      await db.query(
        "UPDATE customer_order SET expires_at = now() - interval '3 hours', reserve_warn_at = now() - interval '6 hours' WHERE id = $1",
        [overdue.id],
      );
      await db.query(
        "UPDATE customer_order SET reserve_warn_at = now() - interval '2 hours' WHERE id = $1",
        [warned.id],
      );

      const worker: INestApplicationContext = await NestFactory.createApplicationContext(
        WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 300 }, jobs: FAST }),
        { bufferLogs: true },
      );
      worker.useLogger(worker.get(JsonLoggerService));
      worker.flushLogs();
      try {
        const admin = worker.get(JobAdmin);
        const runOnce = async () => {
          const deadline = Date.now() + 30_000;
          let { jobId } = await admin.runNow(orderDeadlinesJob.name);
          while (jobId === null) {
            if (Date.now() > deadline) {
              throw new Error("The sweeper stayed waiting");
            }
            await sleep(100);
            ({ jobId } = await admin.runNow(orderDeadlinesJob.name));
          }
          for (;;) {
            const { rows } = await db.query<{ state: string }>(
              "SELECT state::text AS state FROM pgboss.job WHERE id = $1",
              [jobId],
            );
            if (rows[0]?.state === "completed") {
              return;
            }
            if (rows[0]?.state === "failed" || Date.now() > deadline) {
              throw new Error(`The sweeper did not complete: ${rows[0]?.state ?? "gone"}`);
            }
            await sleep(100);
          }
        };
        await runOnce();
        await runOnce();
      } finally {
        await worker.close();
      }
      expect((await row(unanswered.id)).status).toBe("response_expired");
      expect((await row(overdue.id)).status).toBe("reserve_expired");
      expect((await row(warned.id)).status).toBe("accepted");
      const actions = async (id: string) => (await events(id)).map((entry) => entry.action);
      expect(await actions(unanswered.id)).toEqual(["create", "expire_no_response"]);
      // A reserve already over isn't warned about first.
      expect(await actions(overdue.id)).toEqual(["create", "accept", "expire_reserve"]);
      expect(await actions(warned.id)).toEqual(["create", "accept", "reserve_expiring"]);
    });
  });

  // ------------------------------------------------------- what each sees

  describe("what each side sees", () => {
    it("opens the customer's phone to the supplier and the point to the user only once accepted (D-026)", async () => {
      const shop = await company("Телефон");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);

      const list = await ok(shop.as("get", "/supplier/orders?tab=new"), (b) =>
        checked(supplierOrderPageSchema)(b),
      );
      expect(list.orders.map((entry) => entry.id)).toEqual([order.id]);
      expect(list.counts).toEqual({ new: 1, inProgress: 0, finished: 0 });
      expect(list.orders[0]).not.toHaveProperty("customer");
      expect(JSON.stringify(list)).not.toContain(buyer.phone);
      const before = await supplierOrder(shop, order.id);
      expect(before.customer).toEqual({ kind: "hidden", reason: "not_accepted" });
      expect(JSON.stringify(before)).not.toContain(buyer.phone);

      const accepted = await accept(shop, order.id);
      expect(accepted.customer).toEqual({ kind: "revealed", phone: buyer.phone });
      const inProgress = await ok(shop.as("get", "/supplier/orders?tab=in_progress"), (b) =>
        checked(supplierOrderPageSchema)(b),
      );
      expect(JSON.stringify(inProgress)).not.toContain(buyer.phone);
      expect(inProgress.counts).toEqual({ new: 0, inProgress: 1, finished: 0 });
      // The disclosure is in the action journal, without the phone.
      const { rows: audit } = await db.query<{
        action: string;
        after: unknown;
        actor_member_id: string;
      }>(
        "SELECT action, after, actor_member_id FROM audit_log WHERE entity_type = 'order' AND entity_id = $1",
        [order.id],
      );
      expect(audit).toEqual([
        {
          action: "order.phone_revealed",
          after: { number: order.number },
          actor_member_id: shop.first.memberId,
        },
      ]);

      const seen = await userOrder(buyer, order.id);
      expect(seen.pickupPoint).toEqual({
        address: shop.address,
        district: shop.district,
        cityName: "Алматы",
        timeZone: "Asia/Almaty",
        weeklyHours: ALWAYS,
        closedDates: [],
        phone: shop.contactPhone,
      });
      expect(seen.receiptOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Cancelled — the place is gone again, the phone stays with the supplier's history.
      await ok(buyer.as("post", `/orders/${order.id}/cancel`), (b) => b);
      expect(await userOrder(buyer, order.id)).not.toHaveProperty("pickupPoint");
      expect((await supplierOrder(shop, order.id)).customer).toEqual({
        kind: "revealed",
        phone: buyer.phone,
      });
    });

    it("names employees to the supplier and the administrator, never to the user; the reason stays with them", async () => {
      const shop = await company("Журнал", { firstName: "Айгерим" });
      const marat = await colleague(shop, "Марат");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await accept(marat, order.id);
      // A late press of a colleague.
      expectError(
        await shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        409,
        "ORDER_STATE_CONFLICT",
      );
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/decline`, {
          expectedVersion: 2,
          reason: "out_of_stock",
          note: "Закончились",
        }),
        (b) => b,
      );

      const bySupplier = await supplierOrder(shop, order.id);
      expect(bySupplier.events.map((entry) => [entry.action, entry.actor])).toEqual([
        ["create", { kind: "user" }],
        ["accept", { kind: "member", memberId: marat.memberId, name: "Марат", removed: false }],
        [
          "late_action_ignored",
          { kind: "member", memberId: shop.first.memberId, name: "Айгерим", removed: false },
        ],
        [
          "decline",
          { kind: "member", memberId: shop.first.memberId, name: "Айгерим", removed: false },
        ],
      ]);
      expect(bySupplier.events.at(-1)?.details).toEqual({
        reason: "out_of_stock",
        note: "Закончились",
      });
      expect(bySupplier.events.map((entry) => entry.channel)).toEqual([
        "app",
        "supplier_web",
        "supplier_web",
        "supplier_web",
      ]);
      const byAdmin = await adminOrder(order.id);
      expect(byAdmin.events).toEqual(bySupplier.events);
      expect(byAdmin).toMatchObject({
        customer: { accountId: buyer.accountId, phone: buyer.phone },
        supplier: { id: shop.supplierId, name: "Журнал" },
        decline: { reason: "out_of_stock", note: "Закончились" },
        handledBy: { memberId: shop.first.memberId, name: "Айгерим" },
      });

      const byUser = await userOrder(buyer, order.id);
      const text = JSON.stringify(byUser);
      for (const hidden of [
        "Марат",
        "Айгерим",
        "out_of_stock",
        "Закончились",
        "late_action_ignored",
        marat.memberId,
      ]) {
        expect(text, hidden).not.toContain(hidden);
      }
      for (const field of ["events", "handledBy", "handledAt", "decline", "customer", "offerId"]) {
        expect(byUser, field).not.toHaveProperty(field);
      }
      expect(byUser.history).toEqual([
        expect.objectContaining({ action: "create", status: "created", by: "user" }),
        expect.objectContaining({ action: "accept", status: "accepted", by: "supplier" }),
        expect.objectContaining({
          action: "decline",
          status: "declined_by_supplier",
          by: "supplier",
        }),
      ]);
      // A removed employee keeps their name in the history, marked.
      await ok(shop.as("delete", `/supplier/members/${marat.memberId}`), (b) => b);
      expect((await supplierOrder(shop, order.id)).events[1]?.actor).toMatchObject({
        name: "Марат",
        removed: true,
      });
    });

    it("marks an employee's order with their own company as a test one, apart for the administrator", async () => {
      const shop = await company("Тест");
      const offer = await put(shop, padsId);
      const other = await company("Чужой");
      const otherOffer = await put(other, padsId);
      // The employee as a user of the app, with club access.
      const phone = (
        await db.query<{ phone: string }>(
          "SELECT a.phone FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE m.id = $1",
          [shop.first.memberId],
        )
      ).rows[0]!.phone;
      const bearer = await sessionToken(phone, IOS);
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          phone,
          validUntil: new Date(Date.now() + 24 * HOUR).toISOString(),
          reason: "Тест",
        }),
        (b) => b,
        201,
      );
      const employee: Customer = {
        phone,
        accountId: await idOf("SELECT id FROM account WHERE phone = $1", [phone]),
        as: (method, path, body) => call(bearer, IOS, method, path, body),
      };
      const own = await place(employee, offer);
      const elsewhere = await place(employee, otherOffer);
      expect(own.isTest).toBe(true);
      expect(elsewhere.isTest).toBe(false);
      expect((await supplierOrder(shop, own.id)).isTest).toBe(true);

      const ids = async (query: string) =>
        (
          await ok(asAdmin("get", `/admin/orders${query}`), (b) => checked(adminOrderPageSchema)(b))
        ).orders.map((entry) => entry.id);
      expect(await ids("")).toEqual([elsewhere.id]);
      expect(await ids("?test=only")).toEqual([own.id]);
      expect((await ids("?test=include")).sort()).toEqual([own.id, elsewhere.id].sort());
    });

    it("keeps each order to its own: the user's, the company's; the administrator sees all", async () => {
      const shop = await company("Своё");
      const offer = await put(shop, padsId);
      const other = await company("Соседи");
      const buyer = await customer();
      const stranger = await customer();
      const order = await place(buyer, offer);

      // Another user, another company — as missing.
      expectError(await stranger.as("get", `/orders/${order.id}`), 404, "NOT_FOUND");
      expectError(await stranger.as("post", `/orders/${order.id}/cancel`), 404, "NOT_FOUND");
      expectError(await other.as("get", `/supplier/orders/${order.id}`), 404, "NOT_FOUND");
      expectError(
        await other.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        404,
        "NOT_FOUND",
      );
      expectError(
        await other.as("post", `/supplier/orders/${order.id}/decline`, { expectedVersion: 1 }),
        404,
        "NOT_FOUND",
      );
      expect(
        (
          await ok(other.as("get", "/supplier/orders?tab=new"), (b) =>
            checked(supplierOrderPageSchema)(b),
          )
        ).orders,
      ).toEqual([]);
      expect(
        (await ok(stranger.as("get", "/orders"), (b) => checked(userOrderPageSchema)(b))).orders,
      ).toEqual([]);
      expectError(await buyer.as("get", `/orders/${randomUUID()}`), 404, "NOT_FOUND");
      expect((await row(order.id)).status).toBe("created");

      // Contexts: a guest — sign in; a session of another side — forbidden.
      expectError(await http().get("/orders").set("X-Client", IOS), 401, "AUTH_REQUIRED");
      expectError(
        await http().get(`/supplier/orders/${order.id}`).set("X-Client", SUPPLIER_WEB),
        401,
        "AUTH_REQUIRED",
      );
      expectError(await buyer.as("get", "/supplier/orders"), 403, "FORBIDDEN");
      expectError(await buyer.as("get", "/admin/orders"), 403, "FORBIDDEN");
      expectError(await shop.as("get", "/orders"), 403, "FORBIDDEN");
      expectError(await shop.as("post", "/orders", orderBody(offer)), 403, "FORBIDDEN");
      expectError(await shop.as("get", `/admin/orders/${order.id}`), 403, "FORBIDDEN");
      expectError(await asAdmin("get", "/orders"), 403, "FORBIDDEN");
      expectError(
        await asAdmin("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        403,
        "FORBIDDEN",
      );

      // The administrator: any order, by filters.
      const second = await place(stranger, await put(other, padsId));
      const all = await ok(asAdmin("get", "/admin/orders"), (b) =>
        checked(adminOrderPageSchema)(b),
      );
      expect(all.total).toBe(2);
      expect(all.orders.map((entry) => entry.id)).toEqual([second.id, order.id]);
      const bySupplier = await ok(
        asAdmin("get", `/admin/orders?supplierId=${shop.supplierId}`),
        (b) => checked(adminOrderPageSchema)(b),
      );
      expect(bySupplier.orders.map((entry) => entry.id)).toEqual([order.id]);
      const byNumber = await ok(
        asAdmin("get", `/admin/orders?number=${String(second.number)}`),
        (b) => checked(adminOrderPageSchema)(b),
      );
      expect(byNumber.orders.map((entry) => entry.id)).toEqual([second.id]);
      await accept(shop, order.id);
      const byStatus = await ok(asAdmin("get", "/admin/orders?status=accepted"), (b) =>
        checked(adminOrderPageSchema)(b),
      );
      expect(byStatus.orders.map((entry) => entry.id)).toEqual([order.id]);
      const future = new Date(Date.now() + HOUR).toISOString();
      const byPeriod = await ok(
        asAdmin("get", `/admin/orders?from=${encodeURIComponent(future)}`),
        (b) => checked(adminOrderPageSchema)(b),
      );
      expect(byPeriod.total).toBe(0);
    });

    it("pages lists without gaps or repeats", async () => {
      const shop = await company("Страницы");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const placed: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        placed.push((await place(buyer, offer, { allowAnotherActive: true })).id);
      }
      const walk = async (
        first: string,
        parse: (body: unknown) => { orders: { id: string }[]; nextCursor: string | null },
        as: As,
      ) => {
        const seen: string[] = [];
        let path: string | null = first;
        while (path) {
          const page: { orders: { id: string }[]; nextCursor: string | null } = await ok(
            as("get", path),
            parse,
          );
          seen.push(...page.orders.map((entry) => entry.id));
          path = page.nextCursor ? `${first}&cursor=${encodeURIComponent(page.nextCursor)}` : null;
        }
        return seen;
      };
      expect(
        await walk("/orders?tab=active&limit=2", (b) => checked(userOrderPageSchema)(b), buyer.as),
      ).toEqual([...placed].reverse());
      // «Новые»: the nearest answer deadline first.
      expect(
        await walk(
          "/supplier/orders?tab=new&limit=2",
          (b) => checked(supplierOrderPageSchema)(b),
          shop.as,
        ),
      ).toEqual(placed);
      expect(
        await walk("/admin/orders?limit=2", (b) => checked(adminOrderPageSchema)(b), asAdmin),
      ).toEqual([...placed].reverse());
      expectError(await buyer.as("get", "/orders?cursor=broken"), 400, "VALIDATION_ERROR");
    });
  });

  // ------------------------------------------------------- the code stays

  describe("the confirmation code", () => {
    it("reaches no answer to the supplier or the administrator, no journal and no log line", async () => {
      const shop = await company("Код", { firstName: "Айгерим" });
      const marat = await colleague(shop, "Марат");
      const offer = await put(shop, padsId);
      const buyer = await customer();

      // Orders in every state this task makes.
      const created = await place(buyer, offer, { allowAnotherActive: true });
      const accepted = await place(buyer, offer, { allowAnotherActive: true });
      const ready = await place(buyer, offer, { allowAnotherActive: true });
      const declined = await place(buyer, offer, { allowAnotherActive: true });
      const cancelled = await place(buyer, offer, { allowAnotherActive: true });
      const expired = await place(buyer, offer, { allowAnotherActive: true });
      const all = [created, accepted, ready, declined, cancelled, expired];
      for (const order of all) {
        expect(order.confirmation?.code).toMatch(/^\d{6}$/);
      }
      const answers: unknown[] = [];
      const keep = async (test: PromiseLike<Response>) => {
        const response = await test;
        answers.push(response.body);
        return response;
      };
      await keep(shop.as("post", `/supplier/orders/${accepted.id}/accept`, { expectedVersion: 1 }));
      await keep(shop.as("post", `/supplier/orders/${ready.id}/accept`, { expectedVersion: 1 }));
      await keep(shop.as("post", `/supplier/orders/${ready.id}/ready`, { expectedVersion: 2 }));
      await keep(
        shop.as("post", `/supplier/orders/${declined.id}/decline`, {
          expectedVersion: 1,
          reason: "out_of_stock",
        }),
      );
      await keep(
        marat.as("post", `/supplier/orders/${declined.id}/accept`, { expectedVersion: 1 }),
      );
      await keep(marat.as("post", `/supplier/orders/${accepted.id}/ready`, { expectedVersion: 1 }));
      await ok(buyer.as("post", `/orders/${cancelled.id}/cancel`), (b) => b);
      await keep(
        marat.as("post", `/supplier/orders/${cancelled.id}/accept`, { expectedVersion: 1 }),
      );
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
        [expired.id],
      );
      await sweep();
      await keep(shop.as("post", `/supplier/orders/${expired.id}/decline`, { expectedVersion: 1 }));
      for (const tab of ["new", "in_progress", "finished"]) {
        await keep(shop.as("get", `/supplier/orders?tab=${tab}`));
      }
      for (const order of all) {
        await keep(shop.as("get", `/supplier/orders/${order.id}`));
        await keep(marat.as("get", `/supplier/orders/${order.id}`));
        await keep(asAdmin("get", `/admin/orders/${order.id}`));
      }
      for (const query of [
        "",
        "?test=include",
        "?status=created",
        `?number=${String(created.number)}`,
      ]) {
        await keep(asAdmin("get", `/admin/orders${query}`));
      }
      await keep(asAdmin("get", "/admin/audit-log?entityType=order"));
      expect(answers.length).toBeGreaterThan(30);

      const secrets = all.map((order) => ({
        code: order.confirmation!.code,
        qr: order.confirmation!.qrPayload.slice(ORDER_QR_PREFIX.length),
      }));
      const supplierAndAdmin = JSON.stringify(answers);
      const { rows: journal } = await db.query<{ text: string }>(
        "SELECT payload::text AS text FROM order_event UNION ALL SELECT concat(before::text, after::text, reason) FROM audit_log",
      );
      const stored = journal.map((entry) => entry.text).join("\n");
      const logged = appLogText(output.text());
      for (const { code, qr } of secrets) {
        const word = new RegExp(`(?<![0-9A-Za-z])${code}(?![0-9A-Za-z])`);
        expect(supplierAndAdmin, "an answer to the supplier or the administrator").not.toMatch(
          word,
        );
        expect(supplierAndAdmin).not.toContain(qr);
        expect(stored, "the journals").not.toMatch(word);
        expect(stored).not.toContain(qr);
        expect(logged, "the log").not.toMatch(word);
        expect(output.text()).not.toContain(qr);
      }
      expect(supplierAndAdmin).not.toContain(ORDER_QR_PREFIX);
      // The user has it, and only while the order is active.
      expect((await userOrder(buyer, accepted.id)).confirmation?.code).toBe(
        accepted.confirmation?.code,
      );
      expect(await userOrder(buyer, cancelled.id)).not.toHaveProperty("confirmation");
      const list = await ok(buyer.as("get", "/orders?tab=active"), (b) =>
        checked(userOrderPageSchema)(b),
      );
      expect(JSON.stringify(list)).not.toContain(ORDER_QR_PREFIX);
    });

    it("stays out of the monitoring and the log when a write fails with the whole row", async () => {
      const shop = await company("Сбой");
      const offer = await put(shop, padsId);
      const buyer = await customer();
      const marker = "leak-probe-7Q";
      // A check the insert breaks: PostgreSQL then puts the whole row —
      // the code and the QR token among it — into the error's detail.
      await db.query(
        `ALTER TABLE customer_order ADD CONSTRAINT leak_probe CHECK (comment IS DISTINCT FROM '${marker}') NOT VALID`,
      );
      receiver.bodies.length = 0;
      try {
        const failed = await buyer.as("post", "/orders", orderBody(offer, { comment: marker }));
        expectError(failed, 500, "INTERNAL_ERROR");
        for (let attempt = 0; attempt < 50 && receiver.bodies.length === 0; attempt += 1) {
          await sleep(100);
        }
      } finally {
        await db.query("ALTER TABLE customer_order DROP CONSTRAINT leak_probe");
      }
      expect(receiver.bodies.length).toBeGreaterThan(0);
      const sent = receiver.text();
      // The failing row went nowhere: not the comment next to the code, not the code.
      expect(sent).toContain("leak_probe");
      expect(sent).not.toContain(marker);
      expect(output.text()).not.toContain(marker);
      expect(sent).not.toMatch(/Failing row contains \([^)]*\d{6}/);
      expect(output.text()).not.toMatch(/Failing row contains \([^)]*\d{6}/);
      expect(await db.query("SELECT 1 FROM customer_order")).toMatchObject({ rowCount: 0 });
      // The failed order didn't use up the limit.
      await place(buyer, offer);
    });
  });
});
