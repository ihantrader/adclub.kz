import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminComplaintPageSchema,
  adminComplaintResponseSchema,
  adminHomeSchema,
  adminOrderPageSchema,
  adminOrderResponseSchema,
  adminReviewPageSchema,
  adminReviewResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  complaintConflictDetailsSchema,
  complaintResponseSchema,
  createOrderResponseSchema,
  reviewConflictDetailsSchema,
  reviewResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierReviewsResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  userOrderHistoryPageSchema,
  userOrderResponseSchema,
  userReviewResponseSchema,
  type AdminReview,
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
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { SweepRunner, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { TestAiGateway } from "../ai";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { ReviewCheckExpiry } from "./review-check";
import { expireReviewChecksJob } from "./review-jobs";

/**
 * TASK-049 on a real PostgreSQL and Redis with the API and a worker (the test
 * AI provider — nothing leaves the machine): reviews — who may leave one and
 * the refusals, one per order under concurrent requests, the check (the
 * rules without AI, AI holds a violation and publishes criticism, AI out of
 * reach and out of budget — the review waits, and the sweeper holds it past
 * the threshold), the administrator's decisions with versions and the
 * journal, the author's single correction and «только оценка», «Оценить»
 * without the reviewed orders; complaints — the rules, one open per order,
 * «взять в работу» and «решить» with a comment the user never sees, the
 * supplier sees nothing; the admin panel's counters, «Есть жалоба» and the
 * card of an order; the supplier's public page by the rule of the showcase.
 */

const ADMIN_PHONE = "+77011234567";
const SECOND_ADMIN_PHONE = "+77012223344";
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

describe("reviews and complaints (PostgreSQL + Redis + worker)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let ai: TestAiGateway;
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
    ai = worker.get(TestAiGateway);
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
    ai.mode = "ok";
    ai.reviewCheckRequests.length = 0;
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
      review_check_retry_seconds: 1,
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

  async function company(name: string): Promise<Company> {
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
    await ok(
      asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
        expectedVersion: created.supplier.version,
        weeklyHours: ALWAYS,
        closedDates: [],
      }),
      (body) => adminSupplierResponseSchema.parse(body),
    );
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: created.supplier.id,
      phone,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function put(of: Company): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price: 6_500,
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
    accountId: string;
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
    return {
      phone,
      bearer,
      accountId: await idOf("SELECT id FROM account WHERE phone = $1", [phone]),
      as: (method, path, body) => call(bearer, IOS, method, path, body),
    };
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

  /** An order placed, accepted and given out by its code. */
  async function givenOut(who: Customer, of: Company, offer: SupplierOffer): Promise<UserOrder> {
    const order = await place(who, offer);
    await ok(
      of.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
      (b) => b,
    );
    await ok(
      of.as("post", "/supplier/orders/close", { code: order.confirmation!.code }),
      (body) => body,
    );
    return order;
  }

  async function userOrder(who: Customer, orderId: string): Promise<UserOrder> {
    return ok(
      who.as("get", `/orders/${orderId}`),
      (body) => userOrderResponseSchema.parse(body).order,
    );
  }

  async function review(who: Customer, orderId: string, score: number, text?: string) {
    return ok(
      who.as("post", "/reviews", { orderId, score, text, idempotencyKey: randomUUID() }),
      (body) => reviewResponseSchema.parse(body).review,
      201,
    );
  }

  async function adminReview(reviewId: string): Promise<AdminReview> {
    const page = await ok(asAdmin("get", `/admin/reviews?limit=100`), (body) =>
      adminReviewPageSchema.parse(body),
    );
    const found = page.reviews.find((entry) => entry.id === reviewId);
    expect(found, reviewId).toBeDefined();
    return found!;
  }

  /** Waits until the worker settled the check of a review (or the time is up). */
  async function settled(reviewId: string, status = /^(?!checking$)/): Promise<AdminReview> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const current = await adminReview(reviewId);
      if (status.test(current.status) || Date.now() > deadline) {
        return current;
      }
      await sleep(250);
    }
  }

  async function auditOf(query: string) {
    return ok(asAdmin("get", `/admin/audit-log?${query}`), (raw) => auditLogPageSchema.parse(raw));
  }

  // ------------------------------------------------------------- reviews

  describe("leaving a review (M-ORD-05)", () => {
    it("lets only the author of an order given out, not a test one, review it once", async () => {
      const shop = await company("Отзывы");
      const offer = await put(shop);
      const buyer = await customer();
      const stranger = await customer();

      const waiting = await place(buyer, offer);
      expect(waiting.canReview).toBe(false);
      expectError(
        await buyer.as("post", "/reviews", {
          orderId: waiting.id,
          score: 5,
          idempotencyKey: randomUUID(),
        }),
        409,
        "REVIEW_NOT_ALLOWED",
      );

      const order = await givenOut(buyer, shop, offer);
      const card = await userOrder(buyer, order.id);
      expect(card).toMatchObject({ status: "completed", canReview: true, review: null });
      // Another user's order and a missing one answer alike.
      for (const orderId of [order.id, randomUUID()]) {
        expectError(
          await stranger.as("post", "/reviews", {
            orderId,
            score: 5,
            idempotencyKey: randomUUID(),
          }),
          404,
          "NOT_FOUND",
        );
      }
      // A score of 0 or 6 is refused by the contract.
      expectError(
        await buyer.as("post", "/reviews", {
          orderId: order.id,
          score: 6,
          idempotencyKey: randomUUID(),
        }),
        400,
        "VALIDATION_ERROR",
      );

      // A score alone (a blank text is no text) is published at once.
      const key = randomUUID();
      const first = await ok(
        buyer.as("post", "/reviews", {
          orderId: order.id,
          score: 4,
          text: "   ",
          idempotencyKey: key,
        }),
        (body) => reviewResponseSchema.parse(body),
        201,
      );
      expect(first).toMatchObject({ created: true, review: { status: "published", text: null } });
      // The same request again — the same review.
      const again = await ok(
        buyer.as("post", "/reviews", { orderId: order.id, score: 4, idempotencyKey: key }),
        (body) => reviewResponseSchema.parse(body),
        201,
      );
      expect(again).toMatchObject({ created: false, review: { id: first.review.id } });
      expectError(
        await buyer.as("post", "/reviews", {
          orderId: order.id,
          score: 1,
          idempotencyKey: randomUUID(),
        }),
        409,
        "REVIEW_EXISTS",
      );
      expect(ai.reviewCheckRequests).toHaveLength(0);

      const after = await userOrder(buyer, order.id);
      expect(after).toMatchObject({
        canReview: false,
        review: { id: first.review.id, status: "published", score: 4 },
      });
      const history = await ok(buyer.as("get", "/order-history?limit=20"), (body) =>
        userOrderHistoryPageSchema.parse(body),
      );
      expect(
        history.months.flatMap((month) => month.orders).find((o) => o.id === order.id),
      ).toMatchObject({ canReview: false });
    });

    it("refuses a review of a test order of an employee", async () => {
      const shop = await company("Тестовые");
      const offer = await put(shop);
      const employee = await customer({ phone: shop.phone });
      const order = await givenOut(employee, shop, offer);
      expect(order.isTest).toBe(true);
      expect((await userOrder(employee, order.id)).canReview).toBe(false);
      const refused = await employee.as("post", "/reviews", {
        orderId: order.id,
        score: 5,
        idempotencyKey: randomUUID(),
      });
      expectError(refused, 409, "REVIEW_NOT_ALLOWED");
      expect(refused.body.details).toEqual({ reason: "test_order" });
    });

    it("keeps one review per order under concurrent requests", async () => {
      const shop = await company("Гонка");
      const offer = await put(shop);
      const buyer = await customer();
      const one = await givenOut(buyer, shop, offer);
      const key = randomUUID();
      const same = await Promise.all(
        [1, 2, 3].map(() =>
          buyer.as("post", "/reviews", { orderId: one.id, score: 5, idempotencyKey: key }),
        ),
      );
      expect(same.map((response) => response.status)).toEqual([201, 201, 201]);
      expect(new Set(same.map((response) => response.body.review.id)).size).toBe(1);

      const two = await givenOut(buyer, shop, offer);
      const different = await Promise.all(
        [1, 2].map(() =>
          buyer.as("post", "/reviews", { orderId: two.id, score: 3, idempotencyKey: randomUUID() }),
        ),
      );
      expect(different.map((response) => response.status).sort()).toEqual([201, 409]);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM review WHERE order_id = $1", [
        two.id,
      ]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe("the check before publication", () => {
    it("publishes criticism, holds a violation by AI and the rules without asking AI", async () => {
      const shop = await company("Автомаркет");
      const offer = await put(shop);
      const buyer = await customer();

      const criticism = await review(
        buyer,
        (await givenOut(buyer, shop, offer)).id,
        2,
        "долго ждал ответа, цена в итоге выше",
      );
      expect(criticism.status).toBe("checking");
      expect((await settled(criticism.id)).status).toBe("published");
      expect(ai.reviewCheckRequests).toHaveLength(1);

      const named = await review(
        buyer,
        (await givenOut(buyer, shop, offer)).id,
        5,
        "Автомаркет топ, звоните +7 705 555 01 01",
      );
      const held = await settled(named.id);
      expect(held.status).toBe("held");
      expect(held.holdReasons).toEqual([
        { kind: "contacts", source: "rule", explanation: "телефон" },
        { kind: "supplier_name", source: "rule", explanation: null },
      ]);
      // The rules found it: AI was not asked.
      expect(ai.reviewCheckRequests).toHaveLength(1);

      const employee = await review(
        buyer,
        (await givenOut(buyer, shop, offer)).id,
        5,
        "менеджер Ерлан всё объяснил",
      );
      expect((await settled(employee.id)).holdReasons.map((reason) => reason.kind)).toEqual([
        "employee_name",
      ]);

      const rude = await review(
        buyer,
        (await givenOut(buyer, shop, offer)).id,
        1,
        "продавец дурак",
      );
      const byAi = await settled(rude.id);
      expect(byAi).toMatchObject({ status: "held" });
      expect(byAi.holdReasons).toEqual([
        expect.objectContaining({ kind: "profanity", source: "ai" }),
      ]);
      // The author sees «на проверке», never the reason.
      const card = await userOrder(buyer, byAi.order.id);
      expect(card.review).toMatchObject({ status: "checking", rejection: null });
      expect(JSON.stringify(card)).not.toContain("profanity");

      // The journal records the check without the text.
      const journal = await auditOf(`entityType=review&entityId=${rude.id}`);
      expect(journal.entries.map((entry) => entry.action).sort()).toEqual([
        "review.checked",
        "review.created",
      ]);
      expect(JSON.stringify(journal)).not.toContain("дурак");
      // The AI call is recorded without the text.
      const { rows } = await db.query(
        "SELECT input_ref FROM ai_job WHERE kind = 'review_check' ORDER BY created_at",
      );
      expect(rows.length).toBe(2);
      expect(JSON.stringify(rows)).not.toContain("дурак");
    });

    it("waits while AI is out of reach and is checked when it comes back", async () => {
      const shop = await company("Ждём ИИ");
      const offer = await put(shop);
      const buyer = await customer();
      ai.mode = "unavailable";
      const waiting = await review(buyer, (await givenOut(buyer, shop, offer)).id, 3, "нормально");
      await sleep(3_000);
      expect((await adminReview(waiting.id)).status).toBe("checking");
      expect(ai.reviewCheckRequests.length).toBeGreaterThanOrEqual(2);
      ai.mode = "ok";
      expect((await settled(waiting.id)).status).toBe("published");
    });

    it("waits while the day's budget is spent", async () => {
      const shop = await company("Бюджет");
      const offer = await put(shop);
      const buyer = await customer();
      await settings.set({ ai_daily_budget_usd: 0 });
      const waiting = await review(buyer, (await givenOut(buyer, shop, offer)).id, 4, "всё хорошо");
      await sleep(2_500);
      expect((await adminReview(waiting.id)).status).toBe("checking");
      expect(ai.reviewCheckRequests).toHaveLength(0);
      await settings.set({ ai_daily_budget_usd: 100 });
      expect((await settled(waiting.id)).status).toBe("published");
    });

    it("holds a review that waited longer than the threshold («проверка недоступна»)", async () => {
      const shop = await company("Порог");
      const offer = await put(shop);
      const buyer = await customer();
      ai.mode = "unavailable";
      const waiting = await review(buyer, (await givenOut(buyer, shop, offer)).id, 3, "нормально");
      await db.query(
        "UPDATE review SET checking_since = now() - interval '61 minutes' WHERE id = $1",
        [waiting.id],
      );
      const result = await worker
        .get(SweepRunner)
        .run(expireReviewChecksJob, worker.get(ReviewCheckExpiry), {
          signal: new AbortController().signal,
        });
      expect(result.processed).toBe(1);
      const held = await adminReview(waiting.id);
      expect(held).toMatchObject({ status: "held", checkingSince: null });
      expect(held.holdReasons).toEqual([
        expect.objectContaining({ kind: "check_unavailable", source: "system" }),
      ]);
      // AI back later: the job finds the review no longer waiting and leaves it.
      ai.mode = "ok";
      await sleep(2_500);
      expect((await adminReview(waiting.id)).status).toBe("held");
    });
  });

  describe("the administrator's decisions (A-REV-01) and the author's answer", () => {
    it("refuses a text with a reason, lets the author correct it once, then only the score", async () => {
      const shop = await company("Автомаркет");
      const offer = await put(shop);
      const buyer = await customer();
      const order = await givenOut(buyer, shop, offer);
      const first = await review(buyer, order.id, 5, "Автомаркет топ, звоните +7 705 555 01 01");
      const held = await settled(first.id);

      const queue = await ok(asAdmin("get", "/admin/reviews?status=held"), (body) =>
        adminReviewPageSchema.parse(body),
      );
      expect(queue.counts.held).toBe(1);
      expect(queue.reviews[0]).toMatchObject({
        id: first.id,
        order: { id: order.id, number: order.number },
        supplier: { id: shop.supplierId, name: "Автомаркет" },
        author: { name: "Тест Тестов" },
      });
      expect(queue.reviews[0]!.author.phone).not.toContain(buyer.phone.slice(-4, -2));

      // Without a reason from the list — refused by the contract.
      expectError(
        await asAdmin("post", `/admin/reviews/${first.id}/reject-text`, {
          expectedVersion: held.version,
        }),
        400,
        "VALIDATION_ERROR",
      );
      const rejected = await ok(
        asAdmin("post", `/admin/reviews/${first.id}/reject-text`, {
          expectedVersion: held.version,
          reason: "personal_data",
        }),
        (body) => adminReviewResponseSchema.parse(body).review,
      );
      expect(rejected).toMatchObject({
        status: "text_rejected",
        rejection: { reason: "personal_data" },
      });
      // Another administrator with the old version: «уже решил {кто}».
      const second = await setUpAdmin(SECOND_ADMIN_PHONE);
      const late = await call(second, ADMIN_WEB, "post", `/admin/reviews/${first.id}/publish`, {
        expectedVersion: held.version,
      });
      expectError(late, 409, "REVIEW_CONFLICT");
      expect(reviewConflictDetailsSchema.parse(late.body.details).review).toMatchObject({
        status: "text_rejected",
        rejection: { reason: "personal_data" },
      });

      const card = await userOrder(buyer, order.id);
      expect(card.review).toMatchObject({
        status: "text_rejected",
        rejection: { reason: "personal_data" },
        canEditText: true,
        canPublishScoreOnly: true,
      });

      // The corrected text is checked again — held again, refused again.
      const corrected = await ok(
        buyer.as("post", `/reviews/${first.id}/text`, {
          text: "Всё отлично, звоните +7 705 555 01 01",
        }),
        (body) => userReviewResponseSchema.parse(body).review,
      );
      expect(corrected.status).toBe("checking");
      const heldAgain = await settled(first.id);
      expect(heldAgain).toMatchObject({ status: "held", edited: true });
      await ok(
        asAdmin("post", `/admin/reviews/${first.id}/reject-text`, {
          expectedVersion: heldAgain.version,
          reason: "personal_data",
        }),
        (body) => body,
      );
      expect((await userOrder(buyer, order.id)).review).toMatchObject({
        status: "text_rejected",
        canEditText: false,
        canPublishScoreOnly: true,
      });
      const twice = await buyer.as("post", `/reviews/${first.id}/text`, { text: "Другой текст" });
      expectError(twice, 409, "REVIEW_STATE");
      expect(twice.body.details).toEqual({ reason: "edit_used" });

      const scoreOnly = await ok(
        buyer.as("post", `/reviews/${first.id}/score-only`),
        (body) => userReviewResponseSchema.parse(body).review,
      );
      expect(scoreOnly).toMatchObject({ status: "published", text: null, score: 5 });
      // A published review is not edited by its author.
      expectError(
        await buyer.as("post", `/reviews/${first.id}/text`, { text: "Новый текст" }),
        409,
        "REVIEW_STATE",
      );
      // Another user's review answers like a missing one.
      const stranger = await customer();
      expectError(await stranger.as("post", `/reviews/${first.id}/score-only`), 404, "NOT_FOUND");

      const journal = await auditOf(`entityType=review&entityId=${first.id}`);
      expect(journal.entries.map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          "review.created",
          "review.checked",
          "review.text_rejected",
          "review.text_edited",
          "review.score_only",
        ]),
      );
      expect(JSON.stringify(journal)).not.toContain("705 555");
    });

    it("publishes a held review, hides and restores it; the author is not told about a hide", async () => {
      const shop = await company("Скрытие");
      const offer = await put(shop);
      const buyer = await customer();
      const order = await givenOut(buyer, shop, offer);
      const left = await review(buyer, order.id, 1, "продавец дурак");
      const held = await settled(left.id);
      const published = await ok(
        asAdmin("post", `/admin/reviews/${left.id}/publish`, { expectedVersion: held.version }),
        (body) => adminReviewResponseSchema.parse(body).review,
      );
      expect(published.status).toBe("published");
      // Hiding needs a reason.
      expectError(
        await asAdmin("post", `/admin/reviews/${left.id}/hide`, {
          expectedVersion: published.version,
          reason: " ",
        }),
        400,
        "VALIDATION_ERROR",
      );
      const hidden = await ok(
        asAdmin("post", `/admin/reviews/${left.id}/hide`, {
          expectedVersion: published.version,
          reason: "Жалоба поставщика проверена",
        }),
        (body) => adminReviewResponseSchema.parse(body).review,
      );
      expect(hidden).toMatchObject({
        status: "hidden",
        hidden: { reason: "Жалоба поставщика проверена" },
      });
      const card = await userOrder(buyer, order.id);
      expect(card.review).toMatchObject({ status: "published" });
      expect(JSON.stringify(card)).not.toContain("Жалоба поставщика");
      // «Вернуть».
      const restored = await ok(
        asAdmin("post", `/admin/reviews/${left.id}/restore`, { expectedVersion: hidden.version }),
        (body) => adminReviewResponseSchema.parse(body).review,
      );
      expect(restored).toMatchObject({ status: "published", hidden: null });
      // A published review can't be published again.
      expectError(
        await asAdmin("post", `/admin/reviews/${left.id}/publish`, {
          expectedVersion: restored.version,
        }),
        409,
        "REVIEW_CONFLICT",
      );
      const journal = await auditOf(`entityType=review&entityId=${left.id}`);
      expect(journal.entries.find((entry) => entry.action === "review.hidden")?.reason).toBe(
        "Жалоба поставщика проверена",
      );
    });
  });

  // ----------------------------------------------------------- complaints

  describe("complaints (M-ORD-06, A-REV-02)", () => {
    it("takes a complaint about an accepted or a finished order, one open at a time", async () => {
      const shop = await company("Жалобы");
      const offer = await put(shop);
      const buyer = await customer();
      const stranger = await customer();
      const order = await place(buyer, offer);
      const complain = (by: Customer, body: object) =>
        by.as("post", "/complaints", { orderId: order.id, idempotencyKey: randomUUID(), ...body });

      const early = await complain(buyer, { reason: "no_contact" });
      expectError(early, 409, "COMPLAINT_NOT_ALLOWED");
      expect(early.body.details).toEqual({ reason: "order_not_accepted" });
      expect((await userOrder(buyer, order.id)).complaintReasons).toEqual([]);

      await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (b) => b,
      );
      expect((await userOrder(buyer, order.id)).complaintReasons).toEqual([
        "not_as_described",
        "price_higher",
        "no_contact",
        "other",
      ]);
      const notReceived = await complain(buyer, { reason: "not_received" });
      expectError(notReceived, 409, "COMPLAINT_NOT_ALLOWED");
      expect(notReceived.body.details).toEqual({ reason: "not_received_requires_completed" });
      expectError(await complain(buyer, { reason: "other" }), 400, "VALIDATION_ERROR");
      expectError(await complain(stranger, { reason: "price_higher" }), 404, "NOT_FOUND");

      const made = await ok(
        complain(buyer, { reason: "price_higher", text: "Цена на кассе выше" }),
        (body) => complaintResponseSchema.parse(body),
        201,
      );
      expect(made).toMatchObject({ created: true, complaint: { status: "in_review" } });
      expectError(await complain(buyer, { reason: "no_contact" }), 409, "COMPLAINT_EXISTS");
      const card = await userOrder(buyer, order.id);
      expect(card).toMatchObject({
        complaint: { id: made.complaint.id, status: "in_review" },
        complaintReasons: [],
      });
    });

    it("is taken in work and resolved with a comment only the administrator sees", async () => {
      const shop = await company("Решение");
      const offer = await put(shop);
      const buyer = await customer();
      const order = await givenOut(buyer, shop, offer);
      const made = await ok(
        buyer.as("post", "/complaints", {
          orderId: order.id,
          reason: "not_received",
          idempotencyKey: randomUUID(),
        }),
        (body) => complaintResponseSchema.parse(body).complaint,
        201,
      );

      const home = await ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
      expect(home.complaintsNew).toBe(1);
      const list = await ok(asAdmin("get", "/admin/complaints?status=new"), (body) =>
        adminComplaintPageSchema.parse(body),
      );
      expect(list.complaints[0]).toMatchObject({
        id: made.id,
        reason: "not_received",
        status: "new",
        order: { id: order.id, number: order.number },
        supplier: { id: shop.supplierId },
        user: { accountId: buyer.accountId, name: "Тест Тестов" },
      });
      expect(JSON.stringify(list)).not.toContain(buyer.phone);

      const taken = await ok(
        asAdmin("post", `/admin/complaints/${made.id}/take`, { expectedVersion: 1 }),
        (body) => adminComplaintResponseSchema.parse(body).complaint,
      );
      expect(taken).toMatchObject({
        status: "in_progress",
        takenBy: { adminId: expect.any(String) },
      });
      // A second administrator with the version they saw before.
      const second = await setUpAdmin(SECOND_ADMIN_PHONE);
      const stale = await call(second, ADMIN_WEB, "post", `/admin/complaints/${made.id}/take`, {
        expectedVersion: 1,
      });
      expectError(stale, 409, "COMPLAINT_CONFLICT");
      expect(complaintConflictDetailsSchema.parse(stale.body.details).complaint.status).toBe(
        "in_progress",
      );
      expectError(
        await asAdmin("post", `/admin/complaints/${made.id}/resolve`, {
          expectedVersion: taken.version,
        }),
        400,
        "VALIDATION_ERROR",
      );
      const resolved = await ok(
        asAdmin("post", `/admin/complaints/${made.id}/resolve`, {
          expectedVersion: taken.version,
          comment: "Позвонили поставщику, товар выдан повторно",
        }),
        (body) => adminComplaintResponseSchema.parse(body).complaint,
      );
      expect(resolved).toMatchObject({
        status: "resolved",
        comment: "Позвонили поставщику, товар выдан повторно",
      });

      const card = await userOrder(buyer, order.id);
      expect(card.complaint).toMatchObject({ id: made.id, status: "resolved" });
      expect(JSON.stringify(card)).not.toContain("Позвонили");
      // After «решена» — a new complaint may be made.
      expect(card.complaintReasons).toContain("not_received");

      // The supplier sees nothing of complaints nor of reviews.
      const supplierCard = await ok(shop.as("get", `/supplier/orders/${order.id}`), (body) => body);
      const text = JSON.stringify(supplierCard);
      for (const absent of ['"complaint', '"review', "Позвонили", "not_received"]) {
        expect(text).not.toContain(absent);
      }
      const supplierList = await ok(
        shop.as("get", "/supplier/orders?tab=finished"),
        (body) => body,
      );
      expect(JSON.stringify(supplierList)).not.toContain('"complaint');

      const journal = await auditOf(`entityType=complaint&entityId=${made.id}`);
      expect(journal.entries.map((entry) => entry.action).sort()).toEqual([
        "complaint.created",
        "complaint.resolved",
        "complaint.taken",
      ]);
    });

    it("may be made about a test order", async () => {
      const shop = await company("Тест-жалоба");
      const offer = await put(shop);
      const employee = await customer({ phone: shop.phone });
      const order = await givenOut(employee, shop, offer);
      await ok(
        employee.as("post", "/complaints", {
          orderId: order.id,
          reason: "other",
          text: "Проверка",
          idempotencyKey: randomUUID(),
        }),
        (body) => body,
        201,
      );
    });
  });

  // -------------------------------------------------------- admin panel

  describe("the admin panel around reviews and complaints", () => {
    it("counts the queue, filters orders by a complaint and shows both in the order's card", async () => {
      const shop = await company("Карточка");
      const offer = await put(shop);
      const buyer = await customer();
      const reviewed = await givenOut(buyer, shop, offer);
      const plain = await givenOut(buyer, shop, offer);
      const left = await review(buyer, reviewed.id, 1, "продавец дурак");
      await settled(left.id);
      await ok(
        buyer.as("post", "/complaints", {
          orderId: reviewed.id,
          reason: "not_as_described",
          idempotencyKey: randomUUID(),
        }),
        (body) => body,
        201,
      );
      const home = await ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
      expect(home).toMatchObject({ reviewsHeld: 1, complaintsNew: 1 });

      const withComplaint = await ok(asAdmin("get", "/admin/orders?hasComplaint=true"), (body) =>
        adminOrderPageSchema.parse(body),
      );
      expect(withComplaint.orders.map((order) => order.id)).toEqual([reviewed.id]);
      const without = await ok(asAdmin("get", "/admin/orders?hasComplaint=false"), (body) =>
        adminOrderPageSchema.parse(body),
      );
      expect(without.orders.map((order) => order.id)).toEqual([plain.id]);

      const card = await ok(
        asAdmin("get", `/admin/orders/${reviewed.id}`),
        (body) => adminOrderResponseSchema.parse(body).order,
      );
      expect(card.review).toMatchObject({ id: left.id, status: "held" });
      expect(card.complaints).toHaveLength(1);
      expect(
        (
          await ok(
            asAdmin("get", `/admin/orders/${plain.id}`),
            (body) => adminOrderResponseSchema.parse(body).order,
          )
        ).review,
      ).toBeNull();

      const bySupplier = await ok(
        asAdmin("get", `/admin/reviews?supplierId=${shop.supplierId}`),
        (body) => adminReviewPageSchema.parse(body),
      );
      expect(bySupplier.total).toBe(1);
      const byText = await ok(
        asAdmin("get", `/admin/reviews?q=${encodeURIComponent("ДУРАК")}`),
        (body) => adminReviewPageSchema.parse(body),
      );
      expect(byText.total).toBe(1);
      const ofUser = await ok(
        asAdmin("get", `/admin/complaints?accountId=${buyer.accountId}`),
        (body) => adminComplaintPageSchema.parse(body),
      );
      expect(ofUser.total).toBe(1);
    });

    it("refuses the review and complaint routes of the administrator to other sessions", async () => {
      const buyer = await customer();
      expectError(await buyer.as("get", "/admin/reviews"), 403, "FORBIDDEN");
      expectError(await buyer.as("get", "/admin/complaints"), 403, "FORBIDDEN");
      const shop = await company("Доступ");
      expectError(await shop.as("get", "/admin/reviews"), 403, "FORBIDDEN");
      expectError(
        await shop.as("post", "/reviews", {
          orderId: randomUUID(),
          score: 5,
          idempotencyKey: randomUUID(),
        }),
        403,
        "FORBIDDEN",
      );
      expectError(
        await call(null, IOS, "post", "/complaints", {
          orderId: randomUUID(),
          reason: "no_contact",
          idempotencyKey: randomUUID(),
        }),
        401,
        "AUTH_REQUIRED",
      );
    });
  });

  // --------------------------------------------------------- public page

  describe("the supplier's page (M-CAT-09)", () => {
    it("shows published reviews with «Имя Ф.» to club members only", async () => {
      const shop = await company("Страница");
      const offer = await put(shop);
      const buyer = await customer();
      const published = await review(buyer, (await givenOut(buyer, shop, offer)).id, 4);
      const held = await review(
        buyer,
        (await givenOut(buyer, shop, offer)).id,
        1,
        "продавец дурак",
      );
      await settled(held.id);
      const third = await review(
        buyer,
        (await givenOut(buyer, shop, offer)).id,
        5,
        "Отличные колодки",
      );
      expect((await settled(third.id)).status).toBe("published");

      const path = `/suppliers/${shop.supplierId}/reviews?limit=1`;
      const guest = await ok(call(null, IOS, "get", path), (body) =>
        supplierReviewsResponseSchema.parse(body),
      );
      expect(guest).toMatchObject({
        supplier: { kind: "hidden", reason: "auth_required" },
        reviews: [],
        total: 0,
      });
      // The same answer for an id that is no supplier at all.
      const missing = await ok(
        call(null, IOS, "get", `/suppliers/${randomUUID()}/reviews`),
        (body) => supplierReviewsResponseSchema.parse(body),
      );
      expect(missing).toEqual({ ...guest, viewer: guest.viewer });

      const outsider = await customer({ access: false });
      const noAccess = await ok(outsider.as("get", path), (body) =>
        supplierReviewsResponseSchema.parse(body),
      );
      expect(noAccess.supplier).toEqual({ kind: "hidden", reason: "subscription_required" });

      const member = await customer();
      const first = await ok(member.as("get", path), (body) =>
        supplierReviewsResponseSchema.parse(body),
      );
      expect(first).toMatchObject({
        supplier: { kind: "visible", id: shop.supplierId, name: "Страница" },
        total: 2,
      });
      expect(first.reviews).toEqual([
        {
          id: third.id,
          score: 5,
          text: "Отличные колодки",
          publishedMonth: expect.stringMatching(/^\d{4}-\d{2}$/),
          author: "Тест Т.",
        },
      ]);
      const next = await ok(
        member.as("get", `${path}&cursor=${encodeURIComponent(first.nextCursor!)}`),
        (body) => supplierReviewsResponseSchema.parse(body),
      );
      expect(next.reviews.map((entry) => entry.id)).toEqual([published.id]);
      expect(next.nextCursor).toBeNull();
      const all = JSON.stringify([first, next]);
      expect(all).not.toContain(buyer.accountId);
      expect(all).not.toContain(buyer.phone.slice(1));
      expectError(await member.as("get", `/suppliers/${randomUUID()}/reviews`), 404, "NOT_FOUND");
    });
  });
});
