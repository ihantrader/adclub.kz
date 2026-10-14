import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminReviewResponseSchema,
  adminSignalPageSchema,
  adminSupplierPageSchema,
  adminSupplierRatingResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  reviewResponseSchema,
  showcaseItemResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierProfileResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
  type UserOrder,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle, tallyRatingOrders } from "@adclub/domain";
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
import { SweepRunner, type JobRegistry, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { OrderDeadlineSweeper, orderDeadlinesJob, OrderTransitions } from "../orders";
import { ratingInputs, ratingOrderFacts } from "./rating-facts";
import { SupplierRatings } from "./supplier-ratings.service";

/**
 * TASK-050 on a real PostgreSQL and Redis with the API and a worker: the SQL
 * count of the rating against the domain on the same orders (answered,
 * silent, declined at once and after accepting, given out in time and late,
 * closed by an administrator, cancelled, a supply under order overdue, a
 * test order); the recalculation after events and the nightly
 * reconciliation by one function, two events of one supplier at once, the
 * history; the catalog — the rating and «Новый поставщик» from the
 * snapshot, «по рейтингу» and «Рекомендуемые»; M-CAT-09 by an offer and by
 * an order, what a guest and a member see; the administrator's view, the
 * list's column and filter; the signal «Низкий рейтинг» — raised, closed by
 * itself, not raised again after an administrator closed it until a new
 * fall.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const DAY = 24 * 3_600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

type Method = "get" | "post" | "put" | "patch" | "delete";

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

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

describe("the rating of suppliers (PostgreSQL + Redis + worker)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let almaty: string;
  let padsId: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let token: string;

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
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    settings = new TestSettings(worker);
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
        break;
      } catch (error) {
        if (attempt >= 10) throw error;
        await sleep(200);
      }
    }
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      login_code_requests_per_ip: 10_000,
      admin_totp_allowed_drift_steps: 5,
      admin_totp_verify_per_admin: 1000,
      admin_totp_verify_per_ip: 1000,
      review_create_per_account: 1000,
      order_create_per_account: 1000,
    });
    await new TestSettings(app).reload();
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

  function call(
    bearer: string | null,
    client: string,
    method: Method,
    path: string,
    body?: object,
  ) {
    let test = http()[method](path).set("X-Client", client).set("X-Forwarded-For", nextIp());
    if (bearer) {
      test = test.set("Authorization", `Bearer ${bearer}`);
    }
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

  async function idOf(text: string, values: unknown[]): Promise<string> {
    const { rows } = await db.query<{ id: string }>(text, values);
    expect(rows.length, text).toBeGreaterThan(0);
    return rows[0]!.id;
  }

  // ---------------------------------------------------------------- world

  type As = (method: Method, path: string, body?: object) => Test;

  interface Company {
    supplierId: string;
    phone: string;
    as: As;
  }

  async function company(name: string, verified = false): Promise<Company> {
    const phone = `+7705${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bin = validBin(`0812340${String(binCounter++).padStart(4, "0")}`);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin,
        cityId: almaty,
        type: "goods",
        address: `ул. ${name}, 1`,
        district: `Район ${name}`,
        firstMember: { name: "Ерлан", phone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    const scheduled = await ok(
      asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
        expectedVersion: created.supplier.version,
        weeklyHours: ALWAYS,
        closedDates: [],
      }),
      (body) => adminSupplierResponseSchema.parse(body).supplier,
    );
    if (verified) {
      await ok(
        asAdmin("post", `/admin/suppliers/${created.supplier.id}/verification`, {
          expectedVersion: scheduled.version,
          verified: true,
          contractSignedOn: "2026-09-01",
        }),
        (body) => body,
      );
    }
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: created.supplier.id,
      phone,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function put(
    of: Company,
    terms: { price?: number; availability?: "in_stock" | "on_order"; leadDays?: number } = {},
  ): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price: terms.price ?? 6_500,
        availability: terms.availability ?? "in_stock",
        leadDays: terms.leadDays ?? 0,
        pickup: true,
        delivery: true,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  interface Customer {
    phone: string;
    bearer: string;
    as: As;
  }

  async function customer(options: { phone?: string; access?: boolean } = {}): Promise<Customer> {
    const phone = options.phone ?? `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    if (options.access !== false) {
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
    return { phone, bearer, as: (method, path, body) => call(bearer, IOS, method, path, body) };
  }

  async function place(who: Customer, offer: SupplierOffer): Promise<UserOrder> {
    return ok(
      who.as("post", "/orders", {
        offerId: offer.id,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: offer.price,
        idempotencyKey: randomUUID(),
        allowAnotherActive: true,
      }),
      (body) => {
        const order = createOrderResponseSchema.parse(body).order;
        if (order.confirmation) {
          rememberCode(order.confirmation.code);
          rememberSecret(order.confirmation.qrPayload.split(":").at(-1)!);
        }
        return order;
      },
      201,
    );
  }

  async function accept(of: Company, order: UserOrder): Promise<void> {
    await ok(
      of.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
      (b) => b,
    );
  }

  async function giveOut(of: Company, order: UserOrder): Promise<void> {
    await ok(
      of.as("post", "/supplier/orders/close", { code: order.confirmation!.code }),
      (body) => body,
    );
  }

  async function givenOut(who: Customer, of: Company, offer: SupplierOffer): Promise<UserOrder> {
    const order = await place(who, offer);
    await accept(of, order);
    await giveOut(of, order);
    return order;
  }

  async function versionOf(orderId: string): Promise<number> {
    const { rows } = await db.query<{ version: number }>(
      "SELECT version FROM customer_order WHERE id = $1",
      [orderId],
    );
    return rows[0]!.version;
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

  /** The supplier did not answer in time. */
  async function silent(who: Customer, offer: SupplierOffer): Promise<UserOrder> {
    const order = await place(who, offer);
    await db.query(
      "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
      [order.id],
    );
    await sweep();
    return order;
  }

  async function review(who: Customer, orderId: string, score: number): Promise<string> {
    return ok(
      who.as("post", "/reviews", { orderId, score, idempotencyKey: randomUUID() }),
      (body) => reviewResponseSchema.parse(body).review.id,
      201,
    );
  }

  interface Snapshot {
    score: number | null;
    is_new: boolean;
    reviews_count: number;
    answered_count: number;
    answer_required_count: number;
    kept_count: number;
    judged_count: number;
    computed_at: Date;
  }

  async function snapshot(supplierId: string): Promise<Snapshot | undefined> {
    const { rows } = await db.query<Snapshot & { score: string | null }>(
      "SELECT score, is_new, reviews_count, answered_count, answer_required_count, kept_count, judged_count, computed_at FROM supplier_rating WHERE supplier_id = $1",
      [supplierId],
    );
    const row = rows[0];
    return row ? { ...row, score: row.score === null ? null : Number(row.score) } : undefined;
  }

  /** Waits for the worker's recalculation to show what is expected. */
  async function ratingWhere(
    supplierId: string,
    done: (row: Snapshot) => boolean,
    what: string,
  ): Promise<Snapshot> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const row = await snapshot(supplierId);
      if (row && done(row)) {
        return row;
      }
      if (Date.now() > deadline) {
        throw new Error(`The rating never became: ${what} (now ${JSON.stringify(row)})`);
      }
      await sleep(200);
    }
  }

  /** Waits until no recalculation of a rating is waiting or running. */
  async function ratingsIdle(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'ratings.recompute-supplier' AND state IN ('created', 'retry', 'active')",
      );
      if (rows[0]!.n === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("Recalculations of ratings never finished");
      }
      await sleep(200);
    }
  }

  /** Five published scores of five different buyers on orders given out in time. */
  async function fiveScores(of: Company, offer: SupplierOffer, scores: number[]) {
    const reviewIds: string[] = [];
    for (const score of scores) {
      const buyer = await customer();
      const order = await givenOut(buyer, of, offer);
      reviewIds.push(await review(buyer, order.id, score));
    }
    return reviewIds;
  }

  async function lowSignals(supplierId: string) {
    return ok(
      asAdmin("get", `/admin/signals?kind=low_rating&status=current&subjectId=${supplierId}`),
      (body) => adminSignalPageSchema.parse(body).signals,
    );
  }

  // --------------------------------------------------------- the counts

  describe("the count (AC-1)", () => {
    it("gives in SQL what the domain gives on the same orders", async () => {
      const shop = await company("Счёт");
      const offer = await put(shop);
      const buyer = await customer();

      // Given out in time; silent twice; declined at once; accepted then declined.
      await givenOut(buyer, shop, offer);
      await givenOut(buyer, shop, offer);
      await silent(buyer, offer);
      await silent(buyer, offer);
      const declinedAtOnce = await place(buyer, offer);
      await ok(
        shop.as("post", `/supplier/orders/${declinedAtOnce.id}/decline`, {
          expectedVersion: 1,
          reason: "out_of_stock",
        }),
        (b) => b,
      );
      const failed = await place(buyer, offer);
      await accept(shop, failed);
      await ok(
        shop.as("post", `/supplier/orders/${failed.id}/decline`, {
          expectedVersion: 2,
          reason: "out_of_stock",
        }),
        (b) => b,
      );
      // The reserve expired (the user didn't come), then given out late — neutral.
      const late = await place(buyer, offer);
      await accept(shop, late);
      await db.query(
        "UPDATE customer_order SET expires_at = now() - interval '1 second' WHERE id = $1",
        [late.id],
      );
      await sweep();
      await giveOut(shop, late);
      // The reserve expired and nobody came — neutral.
      const noShow = await place(buyer, offer);
      await accept(shop, noShow);
      await db.query(
        "UPDATE customer_order SET expires_at = now() - interval '1 second' WHERE id = $1",
        [noShow.id],
      );
      await sweep();
      // Closed by an administrator without a code — neutral for the terms.
      const disputed = await place(buyer, offer);
      await accept(shop, disputed);
      await ok(
        asAdmin("post", `/admin/orders/${disputed.id}/close`, {
          expectedVersion: await versionOf(disputed.id),
          reason: "Клиент подтвердил получение",
        }),
        (b) => b,
      );
      // Cancelled by the user while new — nothing.
      const cancelled = await place(buyer, offer);
      await ok(buyer.as("post", `/orders/${cancelled.id}/cancel`), (b) => b);
      // A test order of the company's own employee, silent — nothing.
      const employee = await customer({ phone: shop.phone });
      const test = await silent(employee, offer);
      const { rows: testRows } = await db.query<{ is_test: boolean }>(
        "SELECT is_test FROM customer_order WHERE id = $1",
        [test.id],
      );
      expect(testRows[0]!.is_test).toBe(true);

      const database = app.get(DatabaseService).db;
      const facts = await ratingOrderFacts(database, [shop.supplierId], 180);
      expect(facts).toHaveLength(11);
      const counted = await ratingInputs(database, [shop.supplierId], 180);
      const { answered, answerRequired, kept, judged } = counted.get(shop.supplierId)!;
      expect({ answered, answerRequired, kept, judged }).toEqual(tallyRatingOrders(facts));
      // By hand: answers — 2 given out + 2 declines + late + no-show + disputed (7 of 9:
      // two silent); terms — 2 kept, 1 failed (late, no-show, disputed — neutral).
      expect(counted.get(shop.supplierId)).toMatchObject({
        answered: 7,
        answerRequired: 9,
        kept: 2,
        judged: 3,
      });
    });

    it("counts an overdue supply under order as missed, in SQL as in the domain", async () => {
      const shop = await company("Поставка");
      const offer = await put(shop, { availability: "on_order", leadDays: 3 });
      const buyer = await customer();
      const order = await place(buyer, offer);
      await accept(shop, order);
      await db.query(
        "UPDATE customer_order SET supply_overdue_at = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      await sweep();
      const database = app.get(DatabaseService).db;
      const facts = await ratingOrderFacts(database, [shop.supplierId], 180);
      expect(facts).toEqual([
        expect.objectContaining({ kind: "on_order", supplyOverdue: true, takenOn: true }),
      ]);
      const counted = (await ratingInputs(database, [shop.supplierId], 180)).get(shop.supplierId)!;
      expect(counted).toMatchObject({ answered: 1, answerRequired: 1, kept: 0, judged: 1 });
      expect(tallyRatingOrders(facts)).toMatchObject({ kept: 0, judged: 1 });
      // The event of the overdue supply counted the rating again by itself.
      await ratingWhere(shop.supplierId, (row) => row.judged_count === 1, "one order judged");
    });
  });

  // ------------------------------------------------- events and the night

  describe("the recalculation (AC-2, AC-6)", () => {
    it("shows the rating from five scores, goes back to «new» when one is hidden, keeps the history", async () => {
      const shop = await company("Пять оценок", true);
      const offer = await put(shop);
      const reviewIds = await fiveScores(shop, offer, [5, 5, 4, 4, 3]);
      // Five orders given out, all answered and in time, five scores: 4.2 → 0.6×4.2 + 0.2×5 + 0.2×5.
      const rated = await ratingWhere(
        shop.supplierId,
        (row) => row.reviews_count === 5,
        "5 scores",
      );
      expect(rated).toMatchObject({
        score: 4.5,
        is_new: false,
        answered_count: 5,
        answer_required_count: 5,
        kept_count: 5,
        judged_count: 5,
      });

      // The catalog shows it to a guest, the supplier unnamed.
      const card = await ok(call(null, IOS, "get", `/catalog/items/${padsId}`), (body) =>
        showcaseItemResponseSchema.parse(body),
      );
      expect(card.offers[0]).toMatchObject({
        rating: { value: 4.5, count: 5 },
        newSupplier: false,
        verifiedPartner: true,
        supplier: { kind: "hidden", reason: "auth_required" },
      });

      // The administrator hides one: «Новый поставщик» again.
      const review = await ok(asAdmin("get", `/admin/reviews?limit=100`), (body) =>
        (body as { reviews: { id: string; version: number }[] }).reviews.find(
          (entry) => entry.id === reviewIds[0],
        ),
      );
      await ok(
        asAdmin("post", `/admin/reviews/${reviewIds[0]}/hide`, {
          expectedVersion: review!.version,
          reason: "Проверка",
        }),
        (body) => adminReviewResponseSchema.parse(body),
      );
      const back = await ratingWhere(shop.supplierId, (row) => row.reviews_count === 4, "4 scores");
      expect(back).toMatchObject({ score: null, is_new: true });
      const after = await ok(call(null, IOS, "get", `/catalog/items/${padsId}`), (body) =>
        showcaseItemResponseSchema.parse(body),
      );
      expect(after.offers[0]).toMatchObject({ rating: null, newSupplier: true });

      // The history keeps what was before.
      const view = await ok(
        asAdmin("get", `/admin/suppliers/${shop.supplierId}/rating`),
        (body) => adminSupplierRatingResponseSchema.parse(body).rating,
      );
      expect(view).toMatchObject({
        score: null,
        isNew: true,
        reviews: { count: 4 },
        response: { answered: 5, required: 5, rate: 1 },
        onTime: { kept: 5, judged: 5, rate: 1 },
        formulaVersion: 1,
      });
      expect(view.history[0]).toMatchObject({
        cause: "event",
        before: { score: 4.5, isNew: false, reviewsCount: 5 },
        after: { score: null, isNew: true, reviewsCount: 4 },
      });
    });

    it("loses no event when two of one supplier come at once, and the night finds nothing to correct", async () => {
      const shop = await company("Гонка");
      const offer = await put(shop);
      const pairs: { buyer: Customer; order: UserOrder }[] = [];
      for (let index = 0; index < 6; index += 1) {
        const buyer = await customer();
        pairs.push({ buyer, order: await givenOut(buyer, shop, offer) });
      }
      // Six scores at once: six events of one supplier, their jobs racing.
      await Promise.all(pairs.map(({ buyer, order }) => review(buyer, order.id, 4)));
      await ratingWhere(shop.supplierId, (row) => row.reviews_count === 6, "6 scores");
      await ratingsIdle();
      // Two calculations of one supplier at once — the API's and the worker's instance.
      await Promise.all([
        app.get(SupplierRatings).recompute(shop.supplierId, "event"),
        worker.get(SupplierRatings).recompute(shop.supplierId, "event"),
      ]);
      const reconciled = await worker.get(SupplierRatings).reconcile();
      expect(reconciled.corrected).toBe(0);
      // 0.6 × 4 + 0.2 × 5 + 0.2 × 5 = 4.4.
      expect(await snapshot(shop.supplierId)).toMatchObject({ reviews_count: 6, score: 4.4 });
    });

    it("corrects at night what no event told, and applies new weights there", async () => {
      const shop = await company("Ночь");
      const offer = await put(shop);
      await fiveScores(shop, offer, [5, 5, 5, 5, 5]);
      await ratingWhere(shop.supplierId, (row) => row.reviews_count === 5, "5 scores");
      await ratingsIdle();
      // A change behind the events' back: one review hidden directly in the database.
      await db.query(
        "UPDATE review SET status = 'hidden', hidden_at = now(), hidden_reason = 'тест', hidden_by_admin_id = (SELECT id FROM admin_user LIMIT 1) WHERE id = (SELECT id FROM review WHERE supplier_id = $1 LIMIT 1)",
        [shop.supplierId],
      );
      expect((await snapshot(shop.supplierId))!.reviews_count).toBe(5);
      const night = await worker.get(SupplierRatings).reconcile();
      expect(night.corrected).toBeGreaterThanOrEqual(1);
      expect(await snapshot(shop.supplierId)).toMatchObject({ reviews_count: 4, is_new: true });

      // New weights and threshold: the next night counts by them, the formula keeps its version.
      await settings.set({ rating_min_reviews: 3 });
      await worker.get(SupplierRatings).reconcile();
      const view = await ok(
        asAdmin("get", `/admin/suppliers/${shop.supplierId}/rating`),
        (body) => adminSupplierRatingResponseSchema.parse(body).rating,
      );
      expect(view).toMatchObject({ score: 5, isNew: false, formulaVersion: 1 });
      expect(view.rules.minReviews).toBe(3);
      expect(view.history[0]).toMatchObject({ cause: "reconcile", after: { score: 5 } });
    });

    it("feels nothing of a test order of an employee", async () => {
      const shop = await company("Тест");
      const offer = await put(shop);
      const employee = await customer({ phone: shop.phone });
      await silent(employee, offer);
      await ratingsIdle();
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      expect(await snapshot(shop.supplierId)).toMatchObject({
        answered_count: 0,
        answer_required_count: 0,
      });
    });
  });

  // ------------------------------------------------------------- catalog

  describe("the catalog and M-CAT-09 (AC-3)", () => {
    it("orders by the rating, «new» last, and weighs it in «Рекомендуемые»", async () => {
      const rated = await company("Рейтинг");
      const fresh = await company("Новичок");
      const ratedOffer = await put(rated, { price: 9_000 });
      const freshOffer = await put(fresh, { price: 5_000 });
      await fiveScores(rated, ratedOffer, [5, 5, 5, 4, 4]);
      await ratingWhere(rated.supplierId, (row) => row.reviews_count === 5, "5 scores");

      const byRating = await ok(
        call(null, IOS, "get", `/catalog/items/${padsId}?sort=rating`),
        (body) => showcaseItemResponseSchema.parse(body),
      );
      expect(byRating.offers.map((entry) => entry.id)).toEqual([ratedOffer.id, freshOffer.id]);
      expect(byRating.offers[1]).toMatchObject({ rating: null, newSupplier: true });

      // Only the rating weighs: the dearer rated offer first; only the price — the cheaper.
      await new TestSettings(app).set({
        catalog_recommended_weights: { price: 0, receipt: 0, city: 0, verified: 0, rating: 1 },
      });
      const byWeight = await ok(call(null, IOS, "get", `/catalog/items/${padsId}`), (body) =>
        showcaseItemResponseSchema.parse(body),
      );
      expect(byWeight.offers[0]!.id).toBe(ratedOffer.id);
      await new TestSettings(app).set({
        catalog_recommended_weights: { price: 1, receipt: 0, city: 0, verified: 0, rating: 0 },
      });
      const byPrice = await ok(call(null, IOS, "get", `/catalog/items/${padsId}`), (body) =>
        showcaseItemResponseSchema.parse(body),
      );
      expect(byPrice.offers[0]!.id).toBe(freshOffer.id);
    });

    it("gives the page of a supplier to everybody, the name and the reviews only to a member", async () => {
      const shop = await company("Страница", true);
      const offer = await put(shop);
      const buyer = await customer();
      const order = await givenOut(buyer, shop, offer);
      await silent(buyer, offer);
      await ratingWhere(shop.supplierId, (row) => row.answer_required_count === 2, "2 answers due");

      // A guest: rating, shares, «Проверенный партнёр» — no name, no id.
      const guest = await http()
        .get(`/catalog/offers/${offer.id}/supplier`)
        .set("X-Client", IOS)
        .set("X-Forwarded-For", nextIp());
      expect(guest.status).toBe(200);
      expect(guest.headers["cache-control"]).toBe("public, max-age=60");
      const shownToGuest = supplierProfileResponseSchema.parse(guest.body);
      expect(shownToGuest).toEqual({
        viewer: { signedIn: false, clubAccess: false },
        supplier: { kind: "hidden", reason: "auth_required" },
        verifiedPartner: true,
        rating: null,
        newSupplier: true,
        // Two orders wanted an answer — fewer than `rating_min_orders` (5).
        responsePercent: null,
        onTimePercent: null,
      });
      expect(JSON.stringify(guest.body)).not.toContain(shop.supplierId);
      expect(JSON.stringify(guest.body)).not.toContain("Страница");

      await settings.set({ rating_min_orders: 1 });
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      const member = await ok(buyer.as("get", `/catalog/offers/${offer.id}/supplier`), (body) =>
        supplierProfileResponseSchema.parse(body),
      );
      expect(member).toMatchObject({
        viewer: { signedIn: true, clubAccess: true },
        supplier: { kind: "visible", id: shop.supplierId, name: "Страница" },
        responsePercent: 50,
        onTimePercent: 100,
      });

      // Without club access: hidden, «subscription_required».
      const outsider = await customer({ access: false });
      const hidden = await ok(outsider.as("get", `/catalog/offers/${offer.id}/supplier`), (body) =>
        supplierProfileResponseSchema.parse(body),
      );
      expect(hidden.supplier).toEqual({ kind: "hidden", reason: "subscription_required" });

      // By the user's own order; another user's — 404.
      const byOrder = await ok(buyer.as("get", `/orders/${order.id}/supplier`), (body) =>
        supplierProfileResponseSchema.parse(body),
      );
      expect(byOrder.supplier).toMatchObject({ kind: "visible", id: shop.supplierId });
      expectError(await outsider.as("get", `/orders/${order.id}/supplier`), 404, "NOT_FOUND");

      // A withdrawn offer and an unknown id — the same 404.
      expectError(
        await call(null, IOS, "get", `/catalog/offers/${randomUUID()}/supplier`),
        404,
        "NOT_FOUND",
      );
      await ok(
        shop.as("post", `/supplier/offers/${offer.id}/withdraw`, {
          expectedVersion: offer.version,
        }),
        (b) => b,
      );
      expectError(
        await call(null, IOS, "get", `/catalog/offers/${offer.id}/supplier`),
        404,
        "NOT_FOUND",
      );
    });
  });

  // --------------------------------------------------- the administrator

  describe("the administrator and the signal (AC-5)", () => {
    it("lists the rating with its filter and refuses other sessions", async () => {
      const rated = await company("Список-рейтинг");
      const fresh = await company("Список-новый");
      const offer = await put(rated);
      await fiveScores(rated, offer, [2, 2, 2, 2, 2]);
      await ratingWhere(rated.supplierId, (row) => row.reviews_count === 5, "5 scores");

      const all = await ok(asAdmin("get", "/admin/suppliers?limit=50"), (body) =>
        adminSupplierPageSchema.parse(body),
      );
      const row = all.suppliers.find((entry) => entry.id === rated.supplierId)!;
      expect(row.rating).toMatchObject({ count: 5, low: true });
      expect(all.suppliers.find((entry) => entry.id === fresh.supplierId)!.rating).toBeNull();

      const low = await ok(asAdmin("get", "/admin/suppliers?limit=50&rating=low"), (body) =>
        adminSupplierPageSchema.parse(body),
      );
      expect(low.suppliers.map((entry) => entry.id)).toEqual([rated.supplierId]);
      const fresher = await ok(asAdmin("get", "/admin/suppliers?limit=50&rating=new"), (body) =>
        adminSupplierPageSchema.parse(body),
      );
      expect(fresher.suppliers.map((entry) => entry.id)).toContain(fresh.supplierId);
      expect(fresher.suppliers.map((entry) => entry.id)).not.toContain(rated.supplierId);

      const buyer = await customer();
      expectError(
        await buyer.as("get", `/admin/suppliers/${rated.supplierId}/rating`),
        403,
        "FORBIDDEN",
      );
      expectError(
        await rated.as("get", `/admin/suppliers/${rated.supplierId}/rating`),
        403,
        "FORBIDDEN",
      );
    });

    it("raises «Низкий рейтинг», closes it by itself, and raises it again only at a new fall", async () => {
      const shop = await company("Сигнал");
      const offer = await put(shop);
      await fiveScores(shop, offer, [3, 3, 3, 3, 3]);
      const before = await ratingWhere(
        shop.supplierId,
        (row) => row.reviews_count === 5,
        "5 scores",
      );
      // 0.6 × 3 + 0.2 × 5 + 0.2 × 5 = 3.8 — above 3.5: no signal.
      expect(before.score).toBe(3.8);
      await ratingsIdle();
      expect(await lowSignals(shop.supplierId)).toEqual([]);

      // Four silences: answers 5 of 9 (3.2 ★) — 1.8 + 0.64 + 1 = 3.44 → 3.4, below 3.5.
      const buyer = await customer();
      for (let index = 0; index < 4; index += 1) {
        await silent(buyer, offer);
      }
      const fallen = await ratingWhere(
        shop.supplierId,
        (row) => row.answer_required_count === 9,
        "9 answers due",
      );
      expect(fallen.score).toBe(3.4);
      await ratingsIdle();
      const [raised] = await lowSignals(shop.supplierId);
      expect(raised).toMatchObject({
        status: "open",
        subjectType: "supplier",
        subjectId: shop.supplierId,
        payload: { supplierName: "Сигнал", rating: fallen.score, ratingThreshold: 3.5 },
      });

      // An administrator closes it while the rating stays low: nothing opens again.
      await ok(
        asAdmin("post", `/admin/signals/${raised!.id}/close`, {
          expectedVersion: raised!.version,
          comment: "Позвонили поставщику",
        }),
        (b) => b,
      );
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      expect(await lowSignals(shop.supplierId)).toEqual([]);

      // The rating gone («new» with a higher threshold of scores) and back low — a new fall.
      await settings.set({ rating_min_reviews: 6 });
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      expect(await snapshot(shop.supplierId)).toMatchObject({ score: null });
      expect(await lowSignals(shop.supplierId)).toEqual([]);
      await settings.set({ rating_min_reviews: 5 });
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      const [again] = await lowSignals(shop.supplierId);
      expect(again).toMatchObject({ status: "open", payload: { rating: 3.4 } });
      expect(again!.id).not.toBe(raised!.id);

      // Rises above the threshold — the signal closes by itself.
      await settings.set({ rating_low_signal: 3 });
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      expect(await lowSignals(shop.supplierId)).toEqual([]);
      const { rows } = await db.query<{ status: string; closed_at: Date | null }>(
        "SELECT status, closed_at FROM admin_signal WHERE kind = 'low_rating' AND id = $1",
        [again!.id],
      );
      expect(rows[0]).toMatchObject({ status: "closed" });
      expect(rows[0]!.closed_at).not.toBeNull();

      // The threshold raised above a rating nobody was told about (the last
      // signal closed by itself): the next calculation opens one.
      await settings.set({ rating_low_signal: 4 });
      await worker.get(SupplierRatings).recompute(shop.supplierId, "reconcile");
      const [raisedThreshold] = await lowSignals(shop.supplierId);
      expect(raisedThreshold).toMatchObject({ status: "open", payload: { ratingThreshold: 4 } });
    });
  });
});
