import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  activeOrdersResponseSchema,
  adminCityResponseSchema,
  adminOrderResponseSchema,
  adminSignalPageSchema,
  adminSupplierResponseSchema,
  closeOrderResponseSchema,
  createOrderResponseSchema,
  declineOrderResponseSchema,
  orderLookupResponseSchema,
  orderStateConflictDetailsSchema,
  ORDER_QR_PREFIX,
  supplierMemberAddedResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderPageSchema,
  supplierOrderResponseSchema,
  supplierOrderTermOptionsSchema,
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
import { completeTestRegistration, TEST_CUSTOMER_NAME } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { MessageChannel, webhookSignatureHeader, type TestMessageChannel } from "../messaging";
import { OrderDeadlineSweeper, orderDeadlinesJob } from "./order-deadlines";
import { OrderTransitions } from "./order-transitions";

/**
 * TASK-037 end to end on a real PostgreSQL and Redis, with the real API and
 * **two** real workers: an order on an offer under order (ARCHITECTURE 6.2)
 * — W-01a with «Подтвердить срок», the confirmation of the agreed term by
 * the button and in the cabinet, another term proposed in the cabinet, the
 * user's «yes» (W-02 to the employee who proposed it, the phone opens), «no»
 * (W-04) and silence (the order expires by the sweeper, once, whichever
 * process gets there), «Готово к выдаче» with its own reserve, the code at
 * the counter, the supply overdue (one note, one signal), the races of the
 * button and the cabinet in rounds, who may do what, and what each side sees.
 * **Nothing here reaches a network**: the channel is the test one.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const HOUR = 3_600_000;
const LEAD_DAYS = 3;

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

/** Around the clock every day: a term of N working days is N calendar days. */
const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The calendar date `days` after `date` (`YYYY-MM-DD`). */
function plusDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Today in Almaty (UTC+5, no daylight saving). */
function almatyToday(): string {
  return new Date(Date.now() + 5 * HOUR).toISOString().slice(0, 10);
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

describe("orders under order: the term, its answers and its deadlines (PostgreSQL + Redis, API and two workers)", () => {
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
    padsId = await idOf(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      ["geely", normalizeArticle(PADS)],
    );
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
    return { supplierId: created.supplier.id, first: { memberId, name: firstName, phone, as }, as };
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

  /** An offer under order: a term of three working days, pickup only. */
  async function putOnOrder(of: Company): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price: 18_400,
        availability: "on_order",
        leadDays: LEAD_DAYS,
        pickup: true,
        delivery: false,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  async function putInStock(of: Company): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
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

  async function place(who: Customer, offer: SupplierOffer, quantity = 1): Promise<UserOrder> {
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

  const propose = (by: Employee | Company, orderId: string, leadDays: number, version = 1) =>
    by.as("post", `/supplier/orders/${orderId}/propose-term`, {
      expectedVersion: version,
      leadDays,
    });

  const answer = (who: Customer, orderId: string, how: "agree" | "reject", version: number) =>
    who.as("post", `/orders/${orderId}/term/${how}`, { expectedVersion: version });

  async function orderRow(orderId: string) {
    const { rows } = await db.query<{
      status: string;
      kind: string;
      version: number;
      expires_at: Date | null;
      receipt_on: string | null;
      term_answer_by: Date | null;
      code_released_at: Date | null;
      unit_price: number;
      phone_revealed_at: Date | null;
      supply_overdue_noted_at: Date | null;
    }>(
      "SELECT *, to_char(receipt_on, 'YYYY-MM-DD') AS receipt_on FROM customer_order WHERE id = $1",
      [orderId],
    );
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
                    button: { payload, text: "Подтвердить срок" },
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

  async function adminSupplier(supplierId: string) {
    return ok(
      asAdmin("get", `/admin/suppliers/${supplierId}`),
      (raw) => adminSupplierResponseSchema.parse(raw).supplier,
    );
  }

  // ============================================================= creation

  describe("an order on an offer under order", () => {
    it("is created with the offer's term and its date; W-01a goes to the company with «Подтвердить срок»", async () => {
      const shop = await company("Автомаркет");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer, 2);
      expect(order.kind).toBe("on_order");
      expect(order.status).toBe("created");
      expect(order.terms).toMatchObject({ availability: "on_order", leadDays: LEAD_DAYS });
      const expectedOn = order.onOrderTerm!.expected.readyOn!;
      expect(order.onOrderTerm).toEqual({
        expected: { leadDays: LEAD_DAYS, readyOn: expectedOn },
        proposed: null,
        confirmed: null,
        overdueSince: null,
      });
      // Around the clock: three working days are three calendar days.
      expect(expectedOn).toBe(plusDays(almatyToday(), LEAD_DAYS));
      // The code is there, dimmed by the app until the term is confirmed.
      expect(order.confirmation?.code).toMatch(/^\d{6}$/);
      expect(order.pickupPoint).toBeUndefined();

      const [notice] = await sent(order.id, "order_new_on_order", 1);
      expect(notice!.phone).toBe(shop.first.phone);
      expect(notice!.variables).toMatchObject({
        number: String(order.number),
        quantity: "2",
      });
      expect(notice!.variables!.term).toMatch(/^\d{1,2} [а-я]+$/);
      expect(notice!.variables!.item).toContain(PADS);
      expect(Object.keys(notice!.button_payloads!).sort()).toEqual(["confirm", "decline"]);
      const sentRequest = channels
        .flatMap((channel) => channel.sent)
        .find((entry) => entry.template === "order_new_on_order")!;
      expect(sentRequest.buttons.map((button) => button.button.titles.ru)).toEqual([
        "Подтвердить срок",
        "Отказать",
        "Открыть",
      ]);
      // No W-01 for an order under order, and nothing of the customer in W-01a.
      expect(await messages("subject_id = $1 AND template = 'order_new'", [order.id])).toEqual([]);
      expect(JSON.stringify(notice)).not.toContain(buyer.phone.slice(1));
      expect(JSON.stringify(notice)).not.toContain(order.confirmation!.code);
    });

    it("keeps the price of the snapshot when the offer's price changes while the term is discussed", async () => {
      const shop = await company("Детали Юг");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(
        shop.as("patch", `/supplier/offers/${offer.id}`, {
          expectedVersion: offer.version,
          price: 21_000,
        }),
        (body) => body,
      );
      await ok(propose(shop, order.id, 5), (body) => body);
      const agreed = await ok(answer(buyer, order.id, "agree", 2), (body) =>
        checked(userOrderResponseSchema)(body),
      );
      expect(agreed.order.unitPrice).toBe(offer.price);
      expect((await supplierOrder(shop, order.id)).currentOfferPrice).toBe(21_000);
    });

    it("goes on when the company is paused after the order was placed (PRODUCT 10.6)", async () => {
      const shop = await company("Пауза");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const current = await adminSupplier(shop.supplierId);
      await ok(
        asAdmin("post", `/admin/suppliers/${shop.supplierId}/pause`, {
          expectedVersion: current.version,
          paused: true,
          reason: "admin",
          note: "Проверка",
        }),
        (raw) => raw,
      );
      await ok(propose(shop, order.id, 4), (body) => body);
      await ok(answer(buyer, order.id, "agree", 2), (body) => body);
      expect((await orderRow(order.id)).status).toBe("accepted");
    });
  });

  // ============================================================= the paths

  describe("the paths of an order under order", () => {
    it("«Подтвердить срок» in WhatsApp → ready with its own reserve → given out by the code", async () => {
      await configure({ on_order_pickup_reserve_hours: 96, pickup_reserve_hours: 24 });
      const shop = await company("Подтверждение");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const [notice] = await sent(order.id, "order_new_on_order", 1);

      expect(await decided(await press(notice!, notice!.button_payloads!.confirm!))).toBe(
        "accepted",
      );
      const accepted = await orderRow(order.id);
      expect(accepted).toMatchObject({ status: "accepted", expires_at: null });
      const accept = (await events(order.id)).find((event) => event.action === "accept")!;
      expect(accept).toMatchObject({ channel: "whatsapp", actor_member_id: shop.first.memberId });
      expect(accept.payload).toMatchObject({ leadDays: LEAD_DAYS });
      // W-02 with the customer's phone, to the one who pressed.
      const [reply] = await sent(order.id, "order_accepted", 1);
      expect(reply!.phone).toBe(shop.first.phone);
      expect(reply!.variables!.customerName).toBe(TEST_CUSTOMER_NAME);

      const mine = await userOrder(buyer, order.id);
      expect(mine.status).toBe("accepted");
      expect(mine.onOrderTerm!.confirmed).toMatchObject({
        leadDays: LEAD_DAYS,
        readyOn: accepted.receipt_on,
      });
      expect(mine.receiptOn).toBe(accepted.receipt_on);
      // «Срок подтверждён»: no reserve yet, the place to go is known.
      expect(mine.reserveUntil).toBeNull();
      expect(mine.pickupPoint).toBeDefined();
      expect((await supplierOrder(shop, order.id)).customer).toEqual({
        kind: "revealed",
        phone: buyer.phone,
        name: TEST_CUSTOMER_NAME,
      });

      // The goods came: «Готово к выдаче» starts the reserve of an order under order.
      const before = Date.now();
      const ready = await ok(
        shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 2 }),
        (body) => checked(supplierOrderResponseSchema)(body).order,
      );
      expect(ready.status).toBe("ready");
      const reserve = Date.parse(ready.reserveUntil!) - before;
      expect(reserve).toBeGreaterThan(95 * HOUR);
      expect(reserve).toBeLessThan(97 * HOUR);

      const found = await lookup(shop, mine.confirmation!.code);
      expect(found).toMatchObject({ result: "ready", order: { id: order.id, status: "ready" } });
      const given = await giveOut(shop, mine.confirmation!.code);
      expect(given).toMatchObject({ result: "given_out", late: false });
      expect((await orderRow(order.id)).status).toBe("completed");
    });

    it("the scanner gives out a «срок подтверждён» order straight away", async () => {
      const shop = await company("Сканер");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (body) => body,
      );
      const code = (await userOrder(buyer, order.id)).confirmation!.code;
      expect(await lookup(shop, code)).toMatchObject({
        result: "ready",
        // TASK-039: the kind, so the scanner says «Срок подтверждён».
        order: { status: "accepted", kind: "on_order" },
      });
      expect(await giveOut(shop, code)).toMatchObject({ result: "given_out" });
    });

    it("another term → the user agrees → W-02 to who proposed it → ready → given out", async () => {
      const shop = await company("Другой срок");
      const marat = await colleague(shop, "Марат");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);

      const proposed = await ok(
        propose(marat, order.id, 5),
        (body) => checked(supplierOrderResponseSchema)(body).order,
      );
      expect(proposed.status).toBe("term_proposed");
      const term = proposed.onOrderTerm!.proposed!;
      expect(term.leadDays).toBe(5);
      expect(term.readyOn).toBe(plusDays(almatyToday(), 5));
      const answerBy = Date.parse(term.answerBy) - Date.parse(term.at);
      expect(answerBy).toBe(24 * HOUR);
      expect(proposed.handledBy).toMatchObject({ kind: "member", name: "Марат" });
      // The customer is still deciding: the phone stays hidden.
      expect(proposed.customer).toEqual({ kind: "hidden", reason: "not_accepted" });
      expect((await orderRow(order.id)).phone_revealed_at).toBeNull();
      // «Ждут ответа клиента» is in work, not new.
      const inProgress = await ok(shop.as("get", "/supplier/orders?tab=in_progress"), (body) =>
        checked(supplierOrderPageSchema)(body),
      );
      expect(inProgress.orders.map((entry) => entry.id)).toContain(order.id);
      expect(inProgress.counts.new).toBe(0);

      // The user sees «Нужен ваш ответ до …» in the card and in the saved copy.
      const mine = await userOrder(buyer, order.id);
      expect(mine.status).toBe("term_proposed");
      expect(mine.onOrderTerm!.proposed).toEqual(term);
      expect(mine.pickupPoint).toBeUndefined();
      expect(JSON.stringify(mine)).not.toContain("Марат");
      const copy = await ok(buyer.as("get", "/active-orders"), (body) =>
        checked(activeOrdersResponseSchema)(body),
      );
      const card = copy.orders.find((entry) => entry.id === order.id)!;
      expect(card).toMatchObject({
        status: "term_proposed",
        needsAnswer: true,
        awaitsReceipt: false,
        mainDate: { kind: "answer_by", at: term.answerBy },
      });
      expect(card.onOrderTerm!.proposed!.readyOn).toBe(term.readyOn);

      const agreed = await ok(answer(buyer, order.id, "agree", proposed.version), (body) =>
        note(checked(userOrderResponseSchema)(body).order),
      );
      expect(agreed.status).toBe("accepted");
      expect(agreed.receiptOn).toBe(term.readyOn);
      expect(agreed.onOrderTerm!.confirmed).toMatchObject({ leadDays: 5, readyOn: term.readyOn });
      expect(agreed.history.map((step) => step.action)).toEqual([
        "create",
        "propose_term",
        "agree_term",
      ]);
      // W-02 to Marat — the one who proposed — with the customer's phone.
      const [reply] = await sent(order.id, "order_accepted", 1);
      expect(reply!.phone).toBe(marat.phone);
      expect(reply!.variables!.customerPhone.replaceAll(" ", "")).toBe(buyer.phone);
      expect((await supplierOrder(shop, order.id)).customer.kind).toBe("revealed");
      // The phone opened by the user's own «yes», in the action journal.
      const { rows: audit } = await db.query<{ actor_role: string }>(
        "SELECT actor_role FROM audit_log WHERE action = 'order.phone_revealed' AND entity_id = $1",
        [order.id],
      );
      expect(audit).toEqual([{ actor_role: "user" }]);

      await ok(
        shop.as("post", `/supplier/orders/${order.id}/ready`, { expectedVersion: 3 }),
        (body) => body,
      );
      expect(await giveOut(shop, agreed.confirmation!.code)).toMatchObject({
        result: "given_out",
      });
    });

    it("another term → the user says no: cancelled by the user, W-04", async () => {
      const shop = await company("Отказ клиента");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await sent(order.id, "order_new_on_order", 1);
      await ok(propose(shop, order.id, 6), (body) => body);
      const rejected = await ok(
        answer(buyer, order.id, "reject", 2),
        (body) => checked(userOrderResponseSchema)(body).order,
      );
      expect(rejected.status).toBe("cancelled_by_user");
      expect(rejected.confirmation).toBeUndefined();
      expect((await orderRow(order.id)).code_released_at).not.toBeNull();
      const [cancel] = await sent(order.id, "order_cancelled_by_user", 1);
      expect(cancel!.phone).toBe(shop.first.phone);
      // A second «no» is no error.
      await ok(answer(buyer, order.id, "reject", 2), (body) => body);
    });

    it("another term → the supplier declines while the user decides (D-072): declined, the user's «yes» is told so", async () => {
      const shop = await company("Отказ при ожидании");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await sent(order.id, "order_new_on_order", 1);
      await ok(propose(shop, order.id, 6), (body) => body);
      const declined = await ok(
        shop.as("post", `/supplier/orders/${order.id}/decline`, {
          expectedVersion: 2,
          reason: "cannot_meet_term",
        }),
        (body) => checked(declineOrderResponseSchema)(body).order,
      );
      expect(declined.status).toBe("declined_by_supplier");
      const row = await orderRow(order.id);
      expect(row.status).toBe("declined_by_supplier");
      expect(row.code_released_at).not.toBeNull();
      expect(row.phone_revealed_at).toBeNull();
      // The user's «yes» comes too late: the order is the supplier's «no».
      const late = await answer(buyer, order.id, "agree", 2);
      expectError(late, 409, "ORDER_STATE_CONFLICT");
      const details = orderStateConflictDetailsSchema.parse(late.body.details);
      expect(details.currentStatus).toBe("declined_by_supplier");
      // The user never learns who acted on the supplier's side.
      expect(details.lastAction).toBeUndefined();
      const seen = await userOrder(buyer, order.id);
      expect(seen.status).toBe("declined_by_supplier");
      expect(seen.confirmation).toBeUndefined();
      // The reason stays the supplier's and the administrator's.
      expect(JSON.stringify(seen)).not.toContain("cannot_meet_term");
      expect((await events(order.id)).map((event) => event.action)).toEqual([
        "create",
        "propose_term",
        "decline",
      ]);
      // No W-04 for the supplier's own decline.
      expect(
        await messages("subject_id = $1 AND template = 'order_cancelled_by_user'", [order.id]),
      ).toHaveLength(0);
    });

    it("another term → the user cancels while deciding: cancelled by the user, W-04", async () => {
      const shop = await company("Отмена при ответе");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await sent(order.id, "order_new_on_order", 1);
      await ok(propose(shop, order.id, 6), (body) => body);
      const cancelled = await ok(
        buyer.as("post", `/orders/${order.id}/cancel`),
        (body) => checked(userOrderResponseSchema)(body).order,
      );
      expect(cancelled.status).toBe("cancelled_by_user");
      await sent(order.id, "order_cancelled_by_user", 1);
    });

    it("another term → silence: the order expires once, by the sweeper or the card, whichever is first", async () => {
      const shop = await company("Молчание");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(propose(shop, order.id, 7), (body) => body);
      await db.query(
        "UPDATE customer_order SET term_answer_by = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      // The sweeper of this process and the two workers' at once.
      await Promise.all([sweep(), sweep()]);
      await waitFor("the order to expire", async () =>
        (await orderRow(order.id)).status === "term_expired" ? true : undefined,
      );
      const journal = await events(order.id);
      expect(journal.filter((event) => event.action === "expire_term")).toEqual([
        expect.objectContaining({
          actor_type: "system",
          channel: "timer",
          to_status: "term_expired",
        }),
      ]);
      expect((await orderRow(order.id)).code_released_at).not.toBeNull();
      // Agreeing after the deadline: a plain answer that the order has expired.
      const late = await answer(buyer, order.id, "agree", 2);
      expectError(late, 409, "ORDER_STATE_CONFLICT");
      const details = orderStateConflictDetailsSchema.parse(late.body.details);
      expect(details.currentStatus).toBe("term_expired");
      expect(details.lastAction).toBeUndefined();
      // The code no longer gives it out, and never late.
      const code = (await userOrder(buyer, order.id)).confirmation;
      expect(code).toBeUndefined();
    });

    it("agreeing at the moment the answer is due expires the order first and says so", async () => {
      const shop = await company("На границе");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const placedCode = order.confirmation!.code;
      await ok(propose(shop, order.id, 4), (body) => body);
      await db.query(
        "UPDATE customer_order SET term_answer_by = now() - interval '1 second' WHERE id = $1",
        [order.id],
      );
      const late = await answer(buyer, order.id, "agree", 2);
      expectError(late, 409, "ORDER_STATE_CONFLICT");
      expect(late.body.details.currentStatus).toBe("term_expired");
      expect((await orderRow(order.id)).phone_revealed_at).toBeNull();
      // The scanner says why: the customer never agreed to the term (never closed late).
      expect(await lookup(shop, placedCode)).toMatchObject({
        result: "refused",
        reason: "term_expired",
      });
    });

    it("the scanner refuses an order whose term waits for the customer", async () => {
      const shop = await company("Ждём ответа");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(propose(shop, order.id, 4), (body) => body);
      expect(await lookup(shop, order.confirmation!.code)).toMatchObject({
        result: "refused",
        reason: "not_accepted",
      });
    });
  });

  // ============================================================ the rules

  describe("another term is a term", () => {
    it("is refused at the field when it is the agreed one, 0 days or above the bound", async () => {
      await configure({ offer_lead_days_max: 20 });
      const shop = await company("Проверка срока");
      const offer = await putOnOrder(shop);
      const order = await place(await customer(), offer);
      for (const leadDays of [LEAD_DAYS, 21]) {
        const response = await propose(shop, order.id, leadDays);
        expectError(response, 400, "VALIDATION_ERROR");
        expect(JSON.stringify(response.body)).toContain("leadDays");
      }
      expectError(await propose(shop, order.id, 0), 400, "VALIDATION_ERROR");
      expect((await orderRow(order.id)).status).toBe("created");
      expect((await events(order.id)).map((event) => event.action)).toEqual(["create"]);
    });

    it("is offered as the working days of the point and proposed by its date (TASK-039)", async () => {
      await configure({ offer_lead_days_max: 10, term_agreement_hours: 24 });
      const shop = await company("Срок датой");
      const offer = await putOnOrder(shop);
      const order = await place(await customer(), offer);
      const options = await ok(
        shop.as("get", `/supplier/orders/${order.id}/term-options`),
        checked(supplierOrderTermOptionsSchema),
      );
      // The point works every day: the N-th working day is today + N.
      expect(options.confirm).toEqual({
        leadDays: LEAD_DAYS,
        readyOn: plusDays(almatyToday(), LEAD_DAYS),
      });
      expect(options.options.map((option) => option.leadDays)).toEqual([
        1, 2, 4, 5, 6, 7, 8, 9, 10,
      ]);
      for (const option of options.options) {
        expect(option.readyOn).toBe(plusDays(almatyToday(), option.leadDays));
      }
      const answerIn = Date.parse(options.answerBy) - Date.now();
      expect(answerIn).toBeGreaterThan(23 * HOUR);
      // The clock of the database, not of this process: a minute either way.
      expect(answerIn).toBeLessThanOrEqual(24 * HOUR + 60_000);
      // Not an option: the agreed date, past the bound — refused at `readyOn`.
      for (const readyOn of [
        plusDays(almatyToday(), LEAD_DAYS),
        plusDays(almatyToday(), 11),
        "2020-01-01",
      ]) {
        const response = await shop.as("post", `/supplier/orders/${order.id}/propose-term`, {
          expectedVersion: 1,
          readyOn,
        });
        expectError(response, 400, "VALIDATION_ERROR");
        expect(JSON.stringify(response.body)).toContain("readyOn");
      }
      // Both or neither — refused by the contract.
      expectError(
        await shop.as("post", `/supplier/orders/${order.id}/propose-term`, { expectedVersion: 1 }),
        400,
        "VALIDATION_ERROR",
      );
      const chosen = options.options.find((option) => option.leadDays === 5)!;
      const proposed = await ok(
        shop.as("post", `/supplier/orders/${order.id}/propose-term`, {
          expectedVersion: 1,
          readyOn: chosen.readyOn,
        }),
        (body) => checked(supplierOrderResponseSchema)(body).order,
      );
      expect(proposed.status).toBe("term_proposed");
      expect(proposed.onOrderTerm!.proposed).toMatchObject({
        leadDays: 5,
        readyOn: chosen.readyOn,
      });
      // Another company's order is missing; an order in stock has no term.
      const other = await company("Чужой срок");
      expectError(
        await other.first.as("get", `/supplier/orders/${order.id}/term-options`),
        404,
        "NOT_FOUND",
      );
      const stock = await place(await customer(), await putInStock(other));
      expectError(
        await other.as("get", `/supplier/orders/${stock.id}/term-options`),
        409,
        "ORDER_KIND_NOT_SUPPORTED",
      );
    });

    it("is not proposed for an order in stock", async () => {
      const shop = await company("В наличии");
      const offer = await putInStock(shop);
      const order = await place(await customer(), offer);
      expect(order.kind).toBe("stock");
      expect(order.onOrderTerm).toBeNull();
      expectError(await propose(shop, order.id, 5), 409, "ORDER_KIND_NOT_SUPPORTED");
    });

    it("an offer on a service is no order of goods: it needs a car and a time (TASK-038)", async () => {
      const shop = await company("Сервис");
      await db.query("UPDATE supplier SET type = 'services' WHERE id = $1", [shop.supplierId]);
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM catalog_item WHERE item_type = 'service' AND status = 'active' LIMIT 1",
      );
      const service = await ok(
        shop.as("post", "/supplier/offers", { itemId: rows[0]!.id, price: 7_000 }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
        201,
      );
      expect(service.showcase.visible).toBe(true);
      const who = await customer();
      // Ordered as goods — without a car and a time — it is refused at the
      // field; the orders on services themselves are service-orders.integration.test.ts.
      const asGoods = await who.as("post", "/orders", {
        offerId: service.id,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: 7_000,
        idempotencyKey: randomUUID(),
      });
      expectError(asGoods, 400, "VALIDATION_ERROR");
      expect(asGoods.body.details).toEqual([expect.objectContaining({ path: "carId" })]);
      const { rows: orders } = await db.query("SELECT count(*)::int AS n FROM customer_order");
      expect(orders[0]).toEqual({ n: 0 });
    });

    it("is not proposed by a blocked company", async () => {
      const shop = await company("Блокировка");
      const offer = await putOnOrder(shop);
      const order = await place(await customer(), offer);
      const current = await adminSupplier(shop.supplierId);
      await ok(
        asAdmin("post", `/admin/suppliers/${shop.supplierId}/block`, {
          expectedVersion: current.version,
          blocked: true,
          reason: "Нарушение правил клуба",
        }),
        (raw) => raw,
      );
      expectError(await propose(shop, order.id, 5), 403, "SUPPLIER_BLOCKED");
      expect((await orderRow(order.id)).status).toBe("created");
    });
  });

  describe("who may do what", () => {
    it("lets only the user of the order answer and only an employee of its company propose", async () => {
      const shop = await company("Своя");
      const other = await company("Чужая");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const stranger = await customer();
      const order = await place(buyer, offer);
      // Another company's employee — like a missing order.
      expectError(await propose(other, order.id, 5), 404, "NOT_FOUND");
      // The user may not propose; an employee may not answer.
      expectError(
        await buyer.as("post", `/supplier/orders/${order.id}/propose-term`, {
          expectedVersion: 1,
          leadDays: 5,
        }),
        403,
        "FORBIDDEN",
      );
      await ok(propose(shop, order.id, 5), (body) => body);
      expectError(
        await shop.as("post", `/orders/${order.id}/term/agree`, { expectedVersion: 2 }),
        403,
        "FORBIDDEN",
      );
      expectError(
        await asAdmin("post", `/orders/${order.id}/term/agree`, { expectedVersion: 2 }),
        403,
        "FORBIDDEN",
      );
      // Another user — like a missing order; a guest — no session.
      expectError(await answer(stranger, order.id, "agree", 2), 404, "NOT_FOUND");
      expectError(await answer(stranger, order.id, "reject", 2), 404, "NOT_FOUND");
      const guest = await http()
        .post(`/orders/${order.id}/term/agree`)
        .set("X-Client", IOS)
        .send({ expectedVersion: 2 });
      expect(guest.status).toBe(401);
      expect((await orderRow(order.id)).status).toBe("term_proposed");
      // Another version than the one seen — a conflict, not a «yes».
      expectError(await answer(buyer, order.id, "agree", 1), 409, "ORDER_STATE_CONFLICT");
      expect((await orderRow(order.id)).status).toBe("term_proposed");
    });

    it("gives the code and the QR to the user only, and the phone only once the term is confirmed", async () => {
      const shop = await company("Видимость");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      const code = order.confirmation!.code;
      const qr = order.confirmation!.qrPayload;
      await ok(propose(shop, order.id, 5), (body) => body);
      const seenBySupplier = await supplierOrder(shop, order.id);
      const seenByAdmin = await adminOrder(order.id);
      for (const seen of [seenBySupplier, seenByAdmin]) {
        expect(JSON.stringify(seen)).not.toContain(code);
        expect(JSON.stringify(seen)).not.toContain(qr);
      }
      expect(JSON.stringify(seenBySupplier)).not.toContain(buyer.phone);
      expect(seenByAdmin.deadlines.termAnswerBy).toBe(
        seenBySupplier.onOrderTerm!.proposed!.answerBy,
      );
      await ok(answer(buyer, order.id, "agree", 2), (body) => body);
      const after = await supplierOrder(shop, order.id);
      expect(after.customer).toMatchObject({ kind: "revealed", phone: buyer.phone });
      expect(JSON.stringify(after)).not.toContain(code);
    });
  });

  // ========================================================= the races

  describe("races", () => {
    it("«Подтвердить срок» in WhatsApp against another term in the cabinet: one outcome, the other is told who (six rounds)", async () => {
      const shop = await company("Гонка");
      const marat = await colleague(shop, "Марат");
      const offer = await putOnOrder(shop);
      for (let round = 0; round < 6; round++) {
        const order = await place(await customer(), offer);
        const notices = await sent(order.id, "order_new_on_order", 2);
        const toFirst = of(notices, shop.first.phone);
        const [incoming, cabinet] = await Promise.all([
          press(toFirst, toFirst.button_payloads!.confirm!),
          propose(marat, order.id, 6),
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
          journal.filter((event) => ["accept", "propose_term"].includes(event.action)),
        ).toHaveLength(1);
        expect(journal.filter((event) => event.action === "late_action_ignored")).toHaveLength(1);
      }
    });
  });

  describe("races of D-072", () => {
    it("the user's «yes» against the supplier's «Отказать»: one outcome, the other is told (six rounds)", async () => {
      const shop = await company("Гонка ответа");
      const offer = await putOnOrder(shop);
      for (let round = 0; round < 6; round++) {
        const buyer = await customer();
        const order = await place(buyer, offer);
        await ok(propose(shop, order.id, 6), (body) => body);
        const [agreed, declined] = await Promise.all([
          answer(buyer, order.id, "agree", 2),
          shop.as("post", `/supplier/orders/${order.id}/decline`, { expectedVersion: 2 }),
        ]);
        const row = await orderRow(order.id);
        if (agreed.status === 200) {
          expectError(declined, 409, "ORDER_STATE_CONFLICT");
          const details = orderStateConflictDetailsSchema.parse(declined.body.details);
          expect(details.currentStatus).toBe("accepted");
          expect(details.lastAction).toMatchObject({
            action: "agree_term",
            actor: { kind: "user" },
          });
          expect(row.status).toBe("accepted");
          expect(row.phone_revealed_at).not.toBeNull();
        } else {
          expect(declined.status, `round ${String(round)}`).toBe(200);
          expectError(agreed, 409, "ORDER_STATE_CONFLICT");
          const details = orderStateConflictDetailsSchema.parse(agreed.body.details);
          expect(details.currentStatus).toBe("declined_by_supplier");
          expect(row.status).toBe("declined_by_supplier");
          expect(row.phone_revealed_at).toBeNull();
        }
        const journal = await events(order.id);
        expect(
          journal.filter((event) => ["agree_term", "decline"].includes(event.action)),
        ).toHaveLength(1);
      }
    });
  });

  // ==================================================== the overdue supply

  describe("an overdue supply", () => {
    it("is noted once and signalled once; the status stays", async () => {
      const shop = await company("Просрочка");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (body) => body,
      );
      await db.query(
        "UPDATE customer_order SET supply_overdue_at = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      await Promise.all([sweep(), sweep()]);
      await sweep();
      await waitFor("the overdue to be noted", async () =>
        (await orderRow(order.id)).supply_overdue_noted_at ? true : undefined,
      );
      const row = await orderRow(order.id);
      expect(row.status).toBe("accepted");
      const notes = (await events(order.id)).filter((event) => event.action === "supply_overdue");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ to_status: null, actor_type: "system", channel: "timer" });
      const signals = await ok(asAdmin("get", "/admin/signals?kind=supply_overdue"), (body) =>
        adminSignalPageSchema.parse(body),
      );
      expect(signals.signals).toHaveLength(1);
      expect(signals.signals[0]).toMatchObject({
        subjectType: "order",
        subjectId: order.id,
        times: 1,
        payload: { orderNumber: order.number, supplierId: shop.supplierId, leadDays: LEAD_DAYS },
      });
      // Everybody sees it in the term; the order is still given out as usual.
      const mine = await userOrder(buyer, order.id);
      expect(mine.onOrderTerm!.overdueSince).not.toBeNull();
      expect((await supplierOrder(shop, order.id)).onOrderTerm!.overdueSince).toBe(
        mine.onOrderTerm!.overdueSince,
      );
      expect(await giveOut(shop, mine.confirmation!.code)).toMatchObject({ result: "given_out" });
    });

    it("of an employee's test order is noted in its journal and signals nobody", async () => {
      const shop = await company("Тестовая");
      const offer = await putOnOrder(shop);
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
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (body) => body,
      );
      await db.query(
        "UPDATE customer_order SET supply_overdue_at = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      await sweep();
      await waitFor("the overdue to be noted", async () =>
        (await orderRow(order.id)).supply_overdue_noted_at ? true : undefined,
      );
      const signals = await ok(asAdmin("get", "/admin/signals?kind=supply_overdue"), (body) =>
        adminSignalPageSchema.parse(body),
      );
      expect(signals.signals).toEqual([]);
    });
  });

  // ======================================================= the administrator

  describe("the administrator", () => {
    it("extends the user's answer to another term with a reason, and cancels such an order", async () => {
      const shop = await company("Продление ответа");
      const offer = await putOnOrder(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await ok(propose(shop, order.id, 5), (body) => body);
      const before = await adminOrder(order.id);
      const extended = await ok(
        asAdmin("post", `/admin/orders/${order.id}/extend-deadline`, {
          expectedVersion: before.version,
          deadline: "term",
          minutes: 60,
          reason: "Клиент не видел предложения",
        }),
        (body) => checked(adminOrderResponseSchema)(body).order,
      );
      expect(Date.parse(extended.deadlines.termAnswerBy!)).toBe(
        Date.parse(before.deadlines.termAnswerBy!) + 60 * 60_000,
      );
      const extension = extended.events.find((event) => event.action === "deadline_extended")!;
      expect(extension.details).toMatchObject({ extendedDeadline: "term", minutes: 60 });
      // A deadline the order does not wait on is not extended.
      expectError(
        await asAdmin("post", `/admin/orders/${order.id}/extend-deadline`, {
          expectedVersion: extended.version,
          deadline: "response",
          minutes: 60,
          reason: "x",
        }),
        409,
        "ORDER_STATE_CONFLICT",
      );
      const cancelled = await ok(
        asAdmin("post", `/admin/orders/${order.id}/cancel`, {
          expectedVersion: extended.version,
          reason: "Поставщик передумал",
        }),
        (body) => checked(adminOrderResponseSchema)(body).order,
      );
      expect(cancelled.status).toBe("cancelled_by_admin");
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
