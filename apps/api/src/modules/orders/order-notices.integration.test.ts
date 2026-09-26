import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminExtendOrdersResponseSchema,
  adminExtensionCandidatesPageSchema,
  adminOrderResponseSchema,
  adminSignalPageSchema,
  adminSupplierResponseSchema,
  auditLogPageSchema,
  createOrderResponseSchema,
  ORDER_QR_PREFIX,
  supplierMemberAddedResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  userOrderResponseSchema,
  WHATSAPP_CHANNEL_SUBJECT_ID,
  type AdminSignal,
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
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import {
  ButtonPayloads,
  MessageChannel,
  webhookSignatureHeader,
  type TestMessageChannel,
} from "../messaging";
import { NoticeChannelWatch } from "./order-notice-channel";
import { OrderMessages } from "./order-notices";
import { OrderDeadlineSweeper, orderDeadlinesJob } from "./order-deadlines";
import { OrderTransitions } from "./order-transitions";

/**
 * TASK-025 end to end on a real PostgreSQL and Redis, with the real API and
 * **two** real workers: the notices of orders to the supplier's employees
 * (W-01, W-04) by `notificationRecipients` in each one's language, without
 * the code, the QR or the customer's phone; the buttons with payloads the
 * server signed for the order, the action and the employee; a press through
 * the provider's webhook (signed as the provider signs), applied by the state
 * machine through the channel `whatsapp` — once, whatever the provider
 * repeats — or refused when forged, expired, foreign or from another number;
 * the answers W-02 (the customer's phone, after the accept only) and W-03
 * (what the order is now); the races — two presses, a press against the
 * cabinet — in several rounds; the detector of an outage of the channel and
 * its one signal; the administrator's extensions of deadlines, one and many,
 * with a reason, and the notices sent again. **Nothing here reaches a
 * network**: the channel is the test one.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const HOUR = 3_600_000;

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

/** Around the clock every day. */
const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  dedupe_key: string;
  template: string;
  lang: string;
  phone: string;
  subject_type: string;
  subject_id: string | null;
  variables: Record<string, string> | null;
  button_payloads: Record<string, string> | null;
  status: string;
  provider_message_id: string | null;
}

interface PressRow {
  id: string;
  outcome: string | null;
  applied_at: Date | null;
}

describe("notices of orders to suppliers, their buttons and the outage of the channel (PostgreSQL + Redis, API and two workers)", () => {
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
  let padsId: string;
  let token: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  /** Every confirmation code and QR token handed out in this file. */
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
    // deadlock to one of them is simply tried again (as in the gateway's own file).
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
    const item = async (brandKey: string, article: string) =>
      idOf(
        "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
        [brandKey, normalizeArticle(article)],
      );
    padsId = await item("geely", PADS);
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

  /** Changes settings and waits until the workers (a 50 ms cache) have read them. */
  async function configure(values: Parameters<TestSettings["set"]>[0]): Promise<void> {
    await settings.set(values);
    await sleep(250);
  }

  function setMode(mode: TestMessageChannel["mode"]): void {
    for (const channel of channels) {
      channel.mode = mode;
    }
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

  async function ok<T>(
    test: PromiseLike<Response>,
    parse: (body: unknown) => T,
    status = 200,
  ): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  /** The answer as it came (zod drops keys a schema doesn't name). */
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
    name: string;
    first: Employee;
    as: As;
  }

  /** A supplier open around the clock, with its first employee signed in to the cabinet. */
  async function company(name: string, firstName = "Айгерим"): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    const contactPhone = phoneOf(500 + phoneCounter);
    rememberCode(phone, contactPhone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: "goods",
        contactPhone,
        address: `ул. ${name}, ${String(phoneCounter)}`,
        district: `Район ${name}`,
        firstMember: { name: firstName, phone },
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
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    const as: As = (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body);
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 AND m.supplier_id = $2",
      [phone, created.supplier.id],
    );
    return {
      supplierId: created.supplier.id,
      name,
      first: { memberId, name: firstName, phone, as },
      as,
    };
  }

  /** Another employee, added in the cabinet (the switch of notices is on for a new one) and signed in. */
  async function colleague(
    of: Company,
    name: string,
    settingsOf: { lang?: "kk" | "ru"; notifications?: boolean } = {},
  ): Promise<Employee> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const added = await ok(
      of.as("post", "/supplier/members", { name, phone }),
      (body) => supplierMemberAddedResponseSchema.parse(body),
      201,
    );
    if (settingsOf.lang !== undefined || settingsOf.notifications !== undefined) {
      const patch = await of.as("patch", `/supplier/members/${added.member.id}`, {
        ...(settingsOf.lang ? { notificationLanguage: settingsOf.lang } : {}),
        ...(settingsOf.notifications === undefined
          ? {}
          : { notificationsEnabled: settingsOf.notifications }),
      });
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    }
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      memberId: added.member.id,
      name,
      phone,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function put(of: Company, itemId = padsId): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId,
        price: 12_250,
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: true,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  interface Customer {
    phone: string;
    as: As;
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
    return { phone, as: (method, path, body) => call(bearer, IOS, method, path, body) };
  }

  function note(order: UserOrder): UserOrder {
    if (order.confirmation) {
      codes.add(order.confirmation.code);
      rememberCode(order.confirmation.code);
      rememberSecret(order.confirmation.qrPayload.slice(ORDER_QR_PREFIX.length));
    }
    return order;
  }

  async function place(who: Customer, offer: SupplierOffer, quantity = 2): Promise<UserOrder> {
    return ok(
      who.as("post", "/orders", {
        offerId: offer.id,
        quantity,
        fulfillment: "pickup",
        expectedPrice: offer.price,
        idempotencyKey: randomUUID(),
      }),
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

  async function orderRow(orderId: string) {
    const { rows } = await db.query<{
      status: string;
      version: number;
      respond_by: Date;
      expires_at: Date | null;
      handled_by_member_id: string | null;
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

  /** The messages of an order of one template, once `n` of them are sent. */
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

  // -------------------------------------------------------------- webhook

  /** A press as Meta delivers it, signed with the app secret as Meta signs it. */
  async function press(
    message: { provider_message_id: string | null; phone: string },
    payload: string,
    options: { from?: string; id?: string } = {},
  ): Promise<string> {
    const id = options.id ?? `wamid.IN${randomUUID().replaceAll("-", "")}`;
    const body = Buffer.from(
      JSON.stringify({
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
                      from: (options.from ?? message.phone).replace(/^\+/, ""),
                      type: "button",
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      button: { payload, text: "Подтвердить" },
                      context: { id: message.provider_message_id },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const response = await http()
      .post(WHATSAPP_WEBHOOK_PATH)
      .set("X-Forwarded-For", nextIp())
      .set("Content-Type", "application/json")
      .set(
        "X-Hub-Signature-256",
        webhookSignatureHeader(body, config.messaging.whatsapp.appSecret!),
      )
      // A string, not the Buffer: superagent would serialise a Buffer with a JSON
      // content type as {"type":"Buffer",…}, not the bytes that were signed.
      .send(body.toString("utf8"));
    expect(response.status).toBe(200);
    return id;
  }

  /** The press of this incoming id, once it has been decided. */
  async function decided(incomingId: string): Promise<PressRow> {
    return waitFor(`the press ${incomingId} to be decided`, async () => {
      const { rows } = await db.query<PressRow>(
        "SELECT id, outcome, applied_at FROM message_button_press WHERE provider_message_id = $1",
        [incomingId],
      );
      return rows[0]?.applied_at ? rows[0] : undefined;
    });
  }

  async function pressAndDecide(
    message: MessageRow,
    button: "confirm" | "decline",
    options: { from?: string; id?: string; payload?: string } = {},
  ): Promise<string> {
    const id = await press(message, options.payload ?? message.button_payloads![button]!, options);
    return (await decided(id)).outcome!;
  }

  /** The detector, one run, in a worker (the scheduled one runs too; the runs take turns). */
  async function watch(): Promise<void> {
    await worker1.get(NoticeChannelWatch).run();
  }

  async function outageSignals(): Promise<AdminSignal[]> {
    return ok(
      asAdmin("get", "/admin/signals?kind=whatsapp_outage"),
      (body) => adminSignalPageSchema.parse(body).signals,
    );
  }

  /** The deadline sweeper, one run, in this process. */
  async function sweep() {
    const sweeper = new OrderDeadlineSweeper(
      { sweep: () => undefined } as unknown as JobRegistry,
      app.get(OrderTransitions),
    );
    return new SweepRunner(app.get(DatabaseService)).run(orderDeadlinesJob, sweeper, {
      signal: new AbortController().signal,
    });
  }

  // ============================================================ the notices

  describe("the notice of a new order (W-01) and of a cancel (W-04)", () => {
    it("goes to every recipient in their own language, with signed buttons and nothing of the customer", async () => {
      const shop = await company("Автомаркет", "Айгерим");
      const marat = await colleague(shop, "Марат", { lang: "kk", notifications: true });
      const silent = await colleague(shop, "Ержан", { notifications: false });
      const offer = await put(shop);
      const buyer = await customer();
      const order = await place(buyer, offer, 2);

      const notices = await sent(order.id, "order_new", 2);
      const ru = of(notices, shop.first.phone);
      const kk = of(notices, marat.phone);
      expect(notices.map((row) => row.phone)).not.toContain(silent.phone);
      expect(ru.lang).toBe("ru");
      expect(kk.lang).toBe("kk");
      expect(ru.variables).toMatchObject({
        number: String(order.number),
        quantity: "2",
        total: "24 500",
        fulfillment: "самовывоз",
      });
      expect(ru.variables!.item).toContain("04465-0K090");
      expect(kk.variables!.fulfillment).toBe("өзі алып кету");
      // The buttons: a payload per quick reply, for this order and this employee.
      expect(
        ru.button_payloads!.confirm!.startsWith(`confirm:${order.id}:${shop.first.memberId}:`),
      ).toBe(true);
      expect(
        kk.button_payloads!.decline!.startsWith(`decline:${order.id}:${marat.memberId}:`),
      ).toBe(true);
      const request = channels
        .flatMap((channel) => channel.sent)
        .find((entry) => entry.template === "order_new" && entry.phone === marat.phone)!;
      expect(request.buttons.map((button) => [button.button.name, button.payload])).toEqual([
        ["confirm", kk.button_payloads!.confirm],
        ["decline", kk.button_payloads!.decline],
        ["open", undefined],
      ]);
      // Neither the code nor the QR nor the customer's phone is in any of it.
      const everything = JSON.stringify(await messages("true"));
      expect(everything).not.toContain(order.confirmation!.code);
      expect(everything).not.toContain(order.confirmation!.qrPayload.slice(ORDER_QR_PREFIX.length));
      expect(everything).not.toContain(buyer.phone.slice(1));
      expect(JSON.stringify(channels.flatMap((channel) => channel.sent))).not.toContain(
        buyer.phone.slice(1),
      );
    });

    it("goes to no more employees than max_notified_members, and a refused one does not stop the others", async () => {
      await configure({ max_notified_members: 2 });
      const shop = await company("Детали Юг");
      const second = await colleague(shop, "Марат");
      const third = await colleague(shop, "Ержан");
      for (const channel of channels) {
        channel.refusedPhones.add(shop.first.phone);
      }
      const offer = await put(shop);
      const order = await place(await customer(), offer);
      const rows = await waitFor("the two notices settled", async () => {
        const found = await messages("subject_id = $1 AND template = 'order_new'", [order.id]);
        return found.length === 2 && found.every((row) => ["sent", "failed"].includes(row.status))
          ? found
          : undefined;
      });
      expect(rows.map((row) => row.phone).sort()).toEqual([shop.first.phone, second.phone].sort());
      expect(of(rows, shop.first.phone).status).toBe("failed");
      expect(of(rows, second.phone).status).toBe("sent");
      expect(rows.map((row) => row.phone)).not.toContain(third.phone);
    });

    it("goes to the employee's own company for a test order too", async () => {
      const shop = await company("Тест-Маркет");
      const offer = await put(shop);
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
      const own: Customer = {
        phone: shop.first.phone,
        as: (method, path, body) => call(bearer, IOS, method, path, body),
      };
      const order = await place(own, offer);
      expect(order.isTest).toBe(true);
      await sent(order.id, "order_new", 1);
    });

    it("tells of a cancel by the customer (W-04) those who were told of the order", async () => {
      const shop = await company("Автодом");
      const marat = await colleague(shop, "Марат", { lang: "kk" });
      const offer = await put(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await sent(order.id, "order_new", 2);
      await ok(buyer.as("post", `/orders/${order.id}/cancel`), (body) => body);
      const cancels = await sent(order.id, "order_cancelled_by_user", 2);
      expect(of(cancels, marat.phone).lang).toBe("kk");
      expect(of(cancels, shop.first.phone).variables).toMatchObject({
        number: String(order.number),
      });
      expect(JSON.stringify(cancels)).not.toContain(buyer.phone.slice(1));
      // One event, one message each: a repeated cancel adds nothing.
      await ok(buyer.as("post", `/orders/${order.id}/cancel`), (body) => body);
      await sleep(500);
      expect(
        await messages("subject_id = $1 AND template = 'order_cancelled_by_user'", [order.id]),
      ).toHaveLength(2);
    });

    it("is not sent about an order that was answered in the cabinet before it went out", async () => {
      setMode("unavailable");
      const shop = await company("Медленный канал");
      const offer = await put(shop);
      const order = await place(await customer(), offer);
      await waitFor("the first attempt to fail", async () => {
        const { rows } = await db.query<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM outbound_message WHERE subject_id = $1",
          [order.id],
        );
        return rows[0]?.status === "queued" && rows[0].attempts >= 1 ? rows[0] : undefined;
      });
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (body) => body,
      );
      setMode("ok");
      const [row] = await waitFor("the notice to be cancelled", async () => {
        const found = await messages("subject_id = $1 AND template = 'order_new'", [order.id]);
        return found[0]?.status === "cancelled" ? found : undefined;
      });
      expect(row!.status).toBe("cancelled");
    });
  });

  // ============================================================ the buttons

  describe("a press of «Подтвердить» or «Отказать»", () => {
    async function world() {
      const shop = await company("Автомаркет", "Айгерим");
      const marat = await colleague(shop, "Марат", { lang: "kk" });
      const offer = await put(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const notices = await sent(order.id, "order_new", 2);
      return {
        shop,
        marat,
        buyer,
        order,
        toFirst: of(notices, shop.first.phone),
        toMarat: of(notices, marat.phone),
      };
    }

    it("«Подтвердить» accepts the order as that employee through WhatsApp and answers W-02 with the customer's phone", async () => {
      const { shop, buyer, order, toFirst } = await world();
      expect(await pressAndDecide(toFirst, "confirm")).toBe("accepted");
      const row = await orderRow(order.id);
      expect(row.status).toBe("accepted");
      expect(row.handled_by_member_id).toBe(shop.first.memberId);
      const accept = (await events(order.id)).find((event) => event.action === "accept")!;
      expect(accept).toMatchObject({
        actor_type: "supplier_member",
        actor_member_id: shop.first.memberId,
        channel: "whatsapp",
      });
      // The journal says «через WhatsApp» to the supplier and the administrator…
      const seen = await supplierOrder(shop, order.id);
      expect(seen.events.find((event) => event.action === "accept")).toMatchObject({
        channel: "whatsapp",
        actor: { kind: "member", name: "Айгерим" },
      });
      expect(seen.customer).toEqual({ kind: "revealed", phone: buyer.phone });
      expect((await adminOrder(order.id)).events.find((e) => e.action === "accept")!.channel).toBe(
        "whatsapp",
      );
      // …and the user sees the move and the point to go to, never a name.
      const mine = await userOrder(buyer, order.id);
      expect(mine.status).toBe("accepted");
      expect(mine.pickupPoint).toBeDefined();
      expect(JSON.stringify(mine)).not.toContain("Айгерим");
      // W-02: to the one who pressed, with the phone opened by the accept.
      const [reply] = await sent(order.id, "order_accepted", 1);
      expect(reply!.phone).toBe(shop.first.phone);
      expect(reply!.variables).toMatchObject({
        number: String(order.number),
        customerName: "имя не указано",
        customerPhone: `+7 ${buyer.phone.slice(2, 5)} ${buyer.phone.slice(5, 8)} ${buyer.phone.slice(8, 10)} ${buyer.phone.slice(10)}`,
      });
      expect(reply!.variables!.link).toMatch(new RegExp(`/orders/${order.id}$`));
    });

    it("is applied once however often the provider delivers it", async () => {
      const { order, toFirst } = await world();
      const incoming = `wamid.IN-ONCE-${randomUUID()}`;
      await Promise.all([
        press(toFirst, toFirst.button_payloads!.confirm!, { id: incoming }),
        press(toFirst, toFirst.button_payloads!.confirm!, { id: incoming }),
      ]);
      await press(toFirst, toFirst.button_payloads!.confirm!, { id: incoming });
      expect((await decided(incoming)).outcome).toBe("accepted");
      await sleep(1000);
      expect((await events(order.id)).filter((event) => event.action === "accept")).toHaveLength(1);
      expect(
        await messages("subject_id = $1 AND template = 'order_accepted'", [order.id]),
      ).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM message_button_press")).rowCount).toBe(1);
    });

    it("«Отказать» declines the order without a reason and asks nothing more", async () => {
      const { order, toMarat, marat } = await world();
      expect(await pressAndDecide(toMarat, "decline")).toBe("declined");
      const row = await orderRow(order.id);
      expect(row.status).toBe("declined_by_supplier");
      expect(row.handled_by_member_id).toBe(marat.memberId);
      const decline = (await events(order.id)).find((event) => event.action === "decline")!;
      expect(decline).toMatchObject({ channel: "whatsapp", actor_member_id: marat.memberId });
      expect(decline.payload.reason).toBeUndefined();
      await sleep(500);
      expect(
        await messages("subject_id = $1 AND template <> 'order_new'", [order.id]),
      ).toHaveLength(0);
    });

    it("on an order a colleague has accepted changes nothing and answers W-03 with who and when — once", async () => {
      const { order, toFirst, toMarat, marat } = await world();
      expect(await pressAndDecide(toFirst, "confirm")).toBe("accepted");
      expect(await pressAndDecide(toMarat, "decline")).toBe("conflict");
      expect(await pressAndDecide(toMarat, "decline")).toBe("conflict");
      expect((await orderRow(order.id)).status).toBe("accepted");
      const ignored = (await events(order.id)).filter(
        (event) => event.action === "late_action_ignored",
      );
      expect(ignored).toHaveLength(1);
      expect(ignored[0]).toMatchObject({ actor_member_id: marat.memberId, channel: "whatsapp" });
      const [reply] = await sent(order.id, "order_already_handled", 1);
      expect(reply!.phone).toBe(marat.phone);
      expect(reply!.lang).toBe("kk");
      expect(reply!.variables!.state).toMatch(
        /^қабылданған: Айгерим, (\d{2}\.\d{2} )?\d{2}:\d{2}$/,
      );
    });

    it("of the same employee again is no second move and no second answer", async () => {
      const { order, toFirst } = await world();
      expect(await pressAndDecide(toFirst, "confirm")).toBe("accepted");
      expect(await pressAndDecide(toFirst, "confirm")).toBe("repeated");
      await sleep(500);
      expect((await events(order.id)).filter((event) => event.action === "accept")).toHaveLength(1);
      expect(
        await messages("subject_id = $1 AND template = 'order_already_handled'", [order.id]),
      ).toHaveLength(0);
    });

    it("on an order the customer cancelled a second ago answers «отменена клиентом»", async () => {
      const { order, buyer, toFirst } = await world();
      await ok(buyer.as("post", `/orders/${order.id}/cancel`), (body) => body);
      expect(await pressAndDecide(toFirst, "confirm")).toBe("conflict");
      expect((await orderRow(order.id)).status).toBe("cancelled_by_user");
      const [reply] = await sent(order.id, "order_already_handled", 1);
      expect(reply!.variables!.state).toBe("отменена клиентом");
    });

    it("an hour after the deadline applies the expiry first and answers «истекла»", async () => {
      const { order, toFirst, shop } = await world();
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 hour' WHERE id = $1",
        [order.id],
      );
      expect(await pressAndDecide(toFirst, "confirm")).toBe("conflict");
      expect((await orderRow(order.id)).status).toBe("response_expired");
      const journal = await events(order.id);
      expect(journal.map((event) => [event.action, event.actor_type])).toEqual([
        ["create", "user"],
        ["expire_no_response", "system"],
        ["late_action_ignored", "supplier_member"],
      ]);
      expect(journal.at(-1)!.actor_member_id).toBe(shop.first.memberId);
      const [reply] = await sent(order.id, "order_already_handled", 1);
      expect(reply!.variables!.state).toBe("истекла");
      // The phone never opened.
      expect((await supplierOrder(shop, order.id)).customer.kind).toBe("hidden");
    });

    it("of an employee removed after the notice changes nothing and says only that the access is closed", async () => {
      const { order, toMarat, marat, shop } = await world();
      const removed = await shop.as("delete", `/supplier/members/${marat.memberId}`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(await pressAndDecide(toMarat, "confirm")).toBe("member_removed");
      expect((await orderRow(order.id)).status).toBe("created");
      expect((await events(order.id)).map((event) => event.action)).toEqual(["create"]);
      const [reply] = await sent(order.id, "order_already_handled", 1);
      expect(reply!.phone).toBe(marat.phone);
      expect(reply!.variables!.state).toBe("қолжетімсіз: кабинетке кіру жабылған");
    });

    it("of an employee who turned the notices off after it counts all the same", async () => {
      const { order, toMarat, marat } = await world();
      const off = await marat.as("patch", "/supplier/me", { notificationsEnabled: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(await pressAndDecide(toMarat, "confirm")).toBe("accepted");
      expect((await orderRow(order.id)).handled_by_member_id).toBe(marat.memberId);
    });

    it("is not applied — and not answered — when forged, expired, foreign or sent from another number", async () => {
      const { order, toFirst, toMarat, shop } = await world();
      const other = await place(await customer(), await put(await company("Другой")));
      const otherNotice = (await sent(other.id, "order_new", 1))[0]!;
      const payloads = app.get(ButtonPayloads);
      const signature = toFirst.button_payloads!.confirm!.split(":");
      const cases: [string, Promise<string>][] = [
        [
          "invalid_payload",
          pressAndDecide(toFirst, "confirm", {
            payload: [...signature.slice(0, 4), "A".repeat(22)].join(":"),
          }),
        ],
        [
          "invalid_payload",
          pressAndDecide(toFirst, "confirm", {
            payload: `confirm:${order.id}:${shop.first.memberId}`,
          }),
        ],
        [
          "expired",
          pressAndDecide(toFirst, "confirm", {
            payload: payloads.sign(
              "confirm",
              [order.id, shop.first.memberId],
              new Date(Date.now() - 1000),
            ),
          }),
        ],
        // Marat's payload pressed by the first employee's number.
        ["phone_mismatch", pressAndDecide(toMarat, "confirm", { from: shop.first.phone })],
        // A payload of this order on the notice of another order.
        [
          "foreign_message",
          pressAndDecide(otherNotice, "confirm", {
            payload: toFirst.button_payloads!.confirm!,
          }),
        ],
      ];
      for (const [expected, outcome] of cases) {
        expect(await outcome).toBe(expected);
      }
      expect((await orderRow(order.id)).status).toBe("created");
      expect((await orderRow(other.id)).status).toBe("created");
      expect((await events(order.id)).map((event) => event.action)).toEqual(["create"]);
      await sleep(500);
      expect(
        await messages("template IN ('order_accepted', 'order_already_handled')"),
      ).toHaveLength(0);
    });
  });

  // ============================================================== the races

  describe("races", () => {
    it("two presses at once: exactly one wins, the other gets W-03, the journal has one ignored press (six rounds)", async () => {
      const shop = await company("Гонка");
      const marat = await colleague(shop, "Марат");
      const offer = await put(shop);
      for (let round = 0; round < 6; round++) {
        const order = await place(await customer(), offer);
        const notices = await sent(order.id, "order_new", 2);
        const [first, second] = [of(notices, shop.first.phone), of(notices, marat.phone)];
        const [a, b] = await Promise.all([
          press(first, first.button_payloads!.confirm!),
          press(second, second.button_payloads![round % 2 === 0 ? "confirm" : "decline"]!),
        ]);
        const outcomes = [(await decided(a)).outcome, (await decided(b)).outcome];
        // Exactly one move and exactly one press that found the order moved on.
        expect(
          outcomes.filter((outcome) => outcome === "conflict"),
          `round ${String(round)}`,
        ).toHaveLength(1);
        expect(
          outcomes.filter((outcome) => outcome === "accepted" || outcome === "declined"),
        ).toHaveLength(1);
        const journal = await events(order.id);
        expect(
          journal.filter((event) => ["accept", "decline"].includes(event.action)),
        ).toHaveLength(1);
        expect(journal.filter((event) => event.action === "late_action_ignored")).toHaveLength(1);
        await sent(order.id, "order_already_handled", 1);
      }
    });

    it("a press against the cabinet at the same moment: one outcome, whichever it is (six rounds)", async () => {
      const shop = await company("Гонка с кабинетом");
      const marat = await colleague(shop, "Марат");
      const offer = await put(shop);
      for (let round = 0; round < 6; round++) {
        const order = await place(await customer(), offer);
        const notices = await sent(order.id, "order_new", 2);
        const toMarat = of(notices, marat.phone);
        const [incoming, cabinet] = await Promise.all([
          press(toMarat, toMarat.button_payloads!.confirm!),
          shop.as("post", `/supplier/orders/${order.id}/decline`, { expectedVersion: 1 }),
        ]);
        const outcome = (await decided(incoming)).outcome;
        const row = await orderRow(order.id);
        if (outcome === "accepted") {
          expect(cabinet.status).toBe(409);
          expect(row.status).toBe("accepted");
        } else {
          expect(outcome, `round ${String(round)}`).toBe("conflict");
          expect(cabinet.status).toBe(200);
          expect(row.status).toBe("declined_by_supplier");
          await sent(order.id, "order_already_handled", 1);
        }
        const journal = await events(order.id);
        expect(
          journal.filter((event) => ["accept", "decline"].includes(event.action)),
        ).toHaveLength(1);
        expect(journal.filter((event) => event.action === "late_action_ignored")).toHaveLength(1);
      }
    });
  });

  // ================================================= the outage of the channel

  describe("the detector of an outage", () => {
    beforeEach(async () => {
      await configure({
        whatsapp_outage_min_failures: 2,
        whatsapp_outage_error_ratio: 0.5,
        whatsapp_outage_window_minutes: 15,
        message_send_attempts: 1,
      });
    });

    async function failedNotices(n: number, mode: TestMessageChannel["mode"] = "unavailable") {
      setMode(mode);
      const shop = await company(`Сбой ${randomUUID().slice(0, 4)}`);
      const offer = await put(shop);
      const orders: UserOrder[] = [];
      for (let i = 0; i < n; i++) {
        orders.push(await place(await customer(), offer));
      }
      await waitFor(`${String(n)} notices settled as failed`, async () => {
        const rows = await messages("template = 'order_new' AND subject_id = ANY($1)", [
          orders.map((order) => order.id),
        ]);
        return rows.length === n && rows.every((row) => ["failed", "unknown"].includes(row.status))
          ? rows
          : undefined;
      });
      return { shop, offer, orders };
    }

    it("raises one signal when the notices stop arriving, and leaves the deadlines alone", async () => {
      const { shop, orders } = await failedNotices(2);
      const deadlines = await Promise.all(orders.map((order) => orderRow(order.id)));
      await watch();
      await watch();
      const [signal, ...more] = await outageSignals();
      expect(more).toHaveLength(0);
      expect(signal).toMatchObject({
        kind: "whatsapp_outage",
        subjectType: "channel",
        subjectId: WHATSAPP_CHANNEL_SUBJECT_ID,
        status: "open",
        times: 1,
        closedAt: null,
        payload: {
          failedMessages: 2,
          affectedOrders: 2,
          supplierIds: [shop.supplierId],
          windowMinutes: 15,
        },
      });
      expect(signal!.payload.failureKinds).toEqual({ unavailable: 2 });
      expect(signal!.payload.since).toBeDefined();
      // PRODUCT 10.4: the timers are not extended by the outage.
      for (const [index, order] of orders.entries()) {
        const row = await orderRow(order.id);
        expect(row.respond_by).toEqual(deadlines[index]!.respond_by);
        expect(row.version).toBe(1);
      }
      // All the notices failed: the order lives and expires by the common rule.
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
        [orders[0]!.id],
      );
      await sweep();
      expect((await orderRow(orders[0]!.id)).status).toBe("response_expired");
    });

    it("counts a notice nobody knows the fate of (unknown) as a failure too", async () => {
      await failedNotices(2, "outcome_unknown");
      await watch();
      const [signal] = await outageSignals();
      expect(signal!.payload.failureKinds).toEqual({ outcome_unknown: 2 });
      expect(signal!.status).toBe("open");
    });

    it("does not take numbers without WhatsApp for an outage of the channel", async () => {
      const shop = await company("Без WhatsApp");
      const second = await colleague(shop, "Марат");
      const third = await colleague(shop, "Ержан");
      for (const channel of channels) {
        for (const phone of [shop.first.phone, second.phone, third.phone]) {
          channel.refusedPhones.add(phone);
        }
      }
      const order = await place(await customer(), await put(shop));
      await waitFor("the three notices refused", async () => {
        const rows = await messages(
          "subject_id = $1 AND template = 'order_new' AND status = 'failed'",
          [order.id],
        );
        return rows.length === 3 ? rows : undefined;
      });
      await watch();
      expect(await outageSignals()).toHaveLength(0);
    });

    it("is not an outage below the thresholds", async () => {
      await failedNotices(1);
      await watch();
      expect(await outageSignals()).toHaveLength(0);
    });

    it("closes the signal by itself when the channel delivers again, and does not count the old failures again", async () => {
      const { offer } = await failedNotices(2);
      await watch();
      expect((await outageSignals())[0]!.status).toBe("open");
      setMode("ok");
      const order = await place(await customer(), offer);
      await sent(order.id, "order_new", 1);
      await watch();
      const [signal] = await outageSignals();
      expect(signal).toMatchObject({ status: "closed" });
      expect(signal!.closedAt).not.toBeNull();
      expect(signal!.payload.endedAt).toBeDefined();
      await watch();
      expect(await outageSignals()).toHaveLength(1);
    });

    it("an outage that began and ended inside one window is one signal, raised and closed", async () => {
      const { offer } = await failedNotices(2);
      setMode("ok");
      const order = await place(await customer(), offer);
      await sent(order.id, "order_new", 1);
      await watch();
      const signals = await outageSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.status).toBe("closed");
    });
  });

  // ============================================== extending deadlines by hand

  describe("the administrator extends deadlines", () => {
    it("of one order, only with a reason: the new deadline, the journal, the action journal, and W-01 again", async () => {
      await configure({ deadline_extension_max_hours: 2 });
      const shop = await company("Продление");
      const offer = await put(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await sent(order.id, "order_new", 1);
      const before = await orderRow(order.id);
      const path = `/admin/orders/${order.id}/extend-deadline`;
      expectError(
        await asAdmin("post", path, { expectedVersion: 1, deadline: "response", minutes: 30 }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", path, {
          expectedVersion: 1,
          deadline: "response",
          minutes: 121,
          reason: "Сбой",
        }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", path, {
          expectedVersion: 1,
          deadline: "reserve",
          minutes: 30,
          reason: "Сбой",
        }),
        409,
        "ORDER_STATE_CONFLICT",
      );
      expectError(
        await shop.as("post", path, {
          expectedVersion: 1,
          deadline: "response",
          minutes: 30,
          reason: "Сбой",
        }),
        403,
        "FORBIDDEN",
      );
      const extended = await ok(
        asAdmin("post", path, {
          expectedVersion: 1,
          deadline: "response",
          minutes: 30,
          reason: "Сбой канала WhatsApp",
        }),
        (body) => checked(adminOrderResponseSchema)(body).order,
      );
      expect(new Date(extended.respondBy).getTime() - before.respond_by.getTime()).toBe(
        30 * 60_000,
      );
      expect(extended.version).toBe(2);
      const note = extended.events.find((event) => event.action === "deadline_extended")!;
      expect(note).toMatchObject({
        actor: { kind: "admin" },
        channel: "admin",
        details: {
          extendedDeadline: "response",
          minutes: 30,
          adminNote: "Сбой канала WhatsApp",
          previousDeadline: before.respond_by.toISOString(),
          deadline: extended.respondBy,
        },
      });
      // The supplier sees the new deadline and the note, never the reason; the user — the deadline.
      const seen = await supplierOrder(shop, order.id);
      expect(seen.respondBy).toBe(extended.respondBy);
      const supplierNote = seen.events.find((event) => event.action === "deadline_extended")!;
      expect(supplierNote.details.minutes).toBe(30);
      expect(JSON.stringify(seen)).not.toContain("Сбой канала WhatsApp");
      const mine = await userOrder(buyer, order.id);
      expect(mine.respondBy).toBe(extended.respondBy);
      expect(mine.history.map((step) => step.action)).toEqual(["create"]);
      const audit = await ok(
        asAdmin("get", `/admin/audit-log?action=order.deadline_extended&entityId=${order.id}`),
        (body) => auditLogPageSchema.parse(body).entries,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.reason).toBe("Сбой канала WhatsApp");
      // The notice again, with the new deadline and new buttons.
      const notices = await sent(order.id, "order_new", 2);
      expect(notices[1]!.dedupe_key).toContain(":v2:");
      // The new deadline, and buttons for the same order and employee.
      expect(notices[1]!.variables!.respondBy).not.toBe(notices[0]!.variables!.respondBy);
      expect(
        notices[1]!.button_payloads!.confirm!.startsWith(
          `confirm:${order.id}:${shop.first.memberId}:`,
        ),
      ).toBe(true);
      // The other version is no longer the one seen.
      expectError(
        await asAdmin("post", path, {
          expectedVersion: 1,
          deadline: "response",
          minutes: 30,
          reason: "Ещё",
        }),
        409,
        "ORDER_STATE_CONFLICT",
      );
    });

    it("extends the reserve of an accepted pickup order and warns of its new end anew", async () => {
      const shop = await company("Резерв");
      const offer = await put(shop);
      const order = await place(await customer(), offer);
      const accepted = await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (body) => checked(supplierOrderResponseSchema)(body).order,
      );
      await db.query("UPDATE customer_order SET reserve_warned_at = now() WHERE id = $1", [
        order.id,
      ]);
      const extended = await ok(
        asAdmin("post", `/admin/orders/${order.id}/extend-deadline`, {
          expectedVersion: accepted.version,
          deadline: "reserve",
          minutes: 120,
          reason: "Клиент попросил подождать",
        }),
        (body) => checked(adminOrderResponseSchema)(body).order,
      );
      expect(
        new Date(extended.reserveUntil!).getTime() - new Date(accepted.reserveUntil!).getTime(),
      ).toBe(120 * 60_000);
      const { rows } = await db.query(
        "SELECT reserve_warned_at FROM customer_order WHERE id = $1",
        [order.id],
      );
      expect(rows[0].reserve_warned_at).toBeNull();
      // No notice for a reserve: W-01 is the notice of a new order.
      expect(await messages("subject_id = $1 AND template = 'order_new'", [order.id])).toHaveLength(
        1,
      );
    });

    it("never extends an order whose deadline has passed: it expires first", async () => {
      const shop = await company("Поздно");
      const offer = await put(shop);
      const order = await place(await customer(), offer);
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      expectError(
        await asAdmin("post", `/admin/orders/${order.id}/extend-deadline`, {
          expectedVersion: 1,
          deadline: "response",
          minutes: 30,
          reason: "Сбой",
        }),
        409,
        "ORDER_STATE_CONFLICT",
      );
      expect((await orderRow(order.id)).status).toBe("response_expired");
    });

    it("massively (A-ORD-03): lists the unanswered orders of the outage, extends them with one reason, skips what changed, and the notices go again once the channel is back", async () => {
      await configure({ whatsapp_outage_min_failures: 2, message_send_attempts: 1 });
      setMode("unavailable");
      const shop = await company("Массовое");
      const offer = await put(shop);
      const orders: UserOrder[] = [];
      for (let i = 0; i < 3; i++) {
        orders.push(await place(await customer(), offer));
      }
      await waitFor("the notices failed", async () => {
        const rows = await messages("template = 'order_new' AND status = 'failed'");
        return rows.length === 3 ? rows : undefined;
      });
      await watch();
      const [signal] = await outageSignals();
      expect(signal!.status).toBe("open");
      const page = await ok(
        asAdmin(
          "get",
          `/admin/order-extension-candidates?from=${encodeURIComponent(signal!.payload.since!)}`,
        ),
        (body) => checked(adminExtensionCandidatesPageSchema)(body),
      );
      expect(page.orders.map((order) => order.id).sort()).toEqual(
        orders.map((order) => order.id).sort(),
      );
      expect(page.orders.every((order) => order.unnotified)).toBe(true);
      expect(page.orders[0]!.notice).toMatchObject({ recipients: 1, delivered: 0, failed: 1 });
      // The notices sent again wait for the channel: attempts to spare.
      await configure({ message_send_attempts: 5 });
      // One of them is accepted in the cabinet at this very moment.
      const [, extendedResponse] = await Promise.all([
        shop.as("post", `/supplier/orders/${orders[0]!.id}/accept`, { expectedVersion: 1 }),
        asAdmin("post", "/admin/order-extensions", {
          orders: page.orders.map((order) => ({
            orderId: order.id,
            expectedVersion: order.version,
          })),
          minutes: 30,
          reason: "Сбой канала WhatsApp",
        }),
      ]);
      const result = checked(adminExtendOrdersResponseSchema)(extendedResponse.body);
      expect(extendedResponse.status).toBe(200);
      const racing = orders[0]!.id;
      const extended = result.extended.map((entry) => entry.orderId);
      const skipped = result.skipped.map((entry) => entry.orderId);
      expect([...extended, ...skipped].sort()).toEqual(orders.map((order) => order.id).sort());
      expect(extended).toEqual(expect.arrayContaining([orders[1]!.id, orders[2]!.id]));
      if (skipped.includes(racing)) {
        expect(result.skipped[0]).toMatchObject({ orderId: racing, status: "accepted" });
        expect(["changed", "not_waiting"]).toContain(result.skipped[0]!.reason);
      }
      for (const entry of result.extended) {
        expect((await orderRow(entry.orderId)).version).toBe(entry.version);
      }
      // No reason, no extension.
      expectError(
        await asAdmin("post", "/admin/order-extensions", {
          orders: [{ orderId: orders[1]!.id, expectedVersion: 2 }],
          minutes: 30,
        }),
        400,
        "VALIDATION_ERROR",
      );
      // The channel is back: the notices of the extended orders go out again, and the signal closes.
      setMode("ok");
      for (const orderId of [orders[1]!.id, orders[2]!.id]) {
        await waitFor("the notice sent again", async () => {
          const rows = await messages(
            "subject_id = $1 AND template = 'order_new' AND status = 'sent'",
            [orderId],
          );
          return rows.length === 1 ? rows : undefined;
        });
      }
      await watch();
      expect((await outageSignals())[0]!.status).toBe("closed");
    });

    it("sends the notice with the new deadline instead of the old one still waiting for the channel", async () => {
      await configure({ message_send_attempts: 20, message_retry_delay_seconds: 1 });
      setMode("unavailable");
      const shop = await company("Старое уведомление");
      const order = await place(await customer(), await put(shop));
      await waitFor("the first notice to be retrying", async () => {
        const { rows } = await db.query<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM outbound_message WHERE subject_id = $1",
          [order.id],
        );
        return rows[0]?.status === "queued" && rows[0].attempts >= 1 ? rows[0] : undefined;
      });
      await ok(
        asAdmin("post", `/admin/orders/${order.id}/extend-deadline`, {
          expectedVersion: 1,
          deadline: "response",
          minutes: 30,
          reason: "Сбой канала",
        }),
        (body) => body,
      );
      setMode("ok");
      const rows = await waitFor("the old notice cancelled and the new one sent", async () => {
        const found = await messages("subject_id = $1 AND template = 'order_new'", [order.id]);
        const settled = found.every((row) => ["sent", "cancelled"].includes(row.status));
        return found.length === 2 && settled ? found : undefined;
      });
      expect(rows.find((row) => row.dedupe_key.includes(":v1:"))!.status).toBe("cancelled");
      expect(rows.find((row) => row.dedupe_key.includes(":v2:"))!.status).toBe("sent");
    });

    it("tells a removed employee nothing but that the access is closed, whatever W-03 was queued for them", async () => {
      const shop = await company("Удалённый");
      const marat = await colleague(shop, "Марат");
      const order = await place(await customer(), await put(shop));
      await sent(order.id, "order_new", 2);
      const removed = await shop.as("delete", `/supplier/members/${marat.memberId}`);
      expect(removed.status).toBe(200);
      const subject = worker1.get(OrderMessages);
      const ask = (template: "order_already_handled" | "order_new", dedupeKey: string) =>
        app
          .get(DatabaseService)
          .db.transaction((tx) =>
            subject.stillSend(tx, order.id, { template, phone: marat.phone, dedupeKey }),
          );
      expect(
        await ask("order_already_handled", `order_state:${order.id}:${marat.memberId}:accept`),
      ).toBe(false);
      expect(
        await ask(
          "order_already_handled",
          `order_state:${order.id}:${marat.memberId}:accept:access_closed`,
        ),
      ).toBe(true);
      expect(await ask("order_new", `order_new:${order.id}:v1:${marat.memberId}`)).toBe(false);
    });

    it("reaches the extension routes from the admin context only", async () => {
      const shop = await company("Доступ");
      const buyer = await customer();
      for (const as of [shop.as, buyer.as]) {
        expectError(
          await as(
            "get",
            `/admin/order-extension-candidates?from=${encodeURIComponent(new Date().toISOString())}`,
          ),
          403,
          "FORBIDDEN",
        );
        expectError(
          await as("post", "/admin/order-extensions", {
            orders: [{ orderId: randomUUID(), expectedVersion: 1 }],
            minutes: 30,
            reason: "x",
          }),
          403,
          "FORBIDDEN",
        );
      }
      const unknown = await ok(
        asAdmin("post", "/admin/order-extensions", {
          orders: [{ orderId: randomUUID(), expectedVersion: 1 }],
          minutes: 30,
          reason: "x",
        }),
        (body) => checked(adminExtendOrdersResponseSchema)(body),
      );
      expect(unknown.skipped[0]).toMatchObject({ reason: "not_found", number: null, status: null });
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
