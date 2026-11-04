import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminBillingPlansSchema,
  adminBillingSummarySchema,
  adminBillingSupplierPageSchema,
  adminChargePageSchema,
  adminCityResponseSchema,
  adminSignalPageSchema,
  adminSupplierBillingResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  cardBindingResponseSchema,
  createOrderResponseSchema,
  payNowResponseSchema,
  startCardBindingResponseSchema,
  supplierChargePageSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierSubscriptionResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminHome,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
  type UserOrder,
} from "@adclub/contracts";
import {
  bankRetryWindowEnd,
  daysUntilPause,
  earliestPlanStart,
  kzBinCheckDigit,
  nextBankRetry,
  normalizeArticle,
} from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { PAYMENT_WEBHOOK_PATH } from "../../common/http";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { runMigrate, runMigrateAsync } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { JobQueue, SweepRunner, type JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { EXPECTED_MIGRATIONS } from "../../testing/expected/migrations";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { offer as offerTable, offerShowcase, shownOffers } from "../offers";
import { BillingOperator } from "./billing-operator";
import { detachCardJob, expireSubscriptionsJob } from "./billing-jobs";
import {
  ChargeDueHandler,
  DetachCardHandler,
  ExpireBindingsHandler,
  RunAttemptHandler,
  ResolvePaymentsHandler,
  WatchProviderHandler,
} from "./billing-handlers";
import { BillingEventsApply } from "./billing.module";
import { dayText } from "./billing-notices";
import { PaymentCharger } from "./payment-charger";
import { PaymentProvider } from "./payment-provider";
import { PaymentTokenVault, tokenContext } from "./payment-token-vault";
import { Plans } from "./plans.service";
import { SubscriptionExpiry } from "./subscription-events";
import {
  PAYMENT_WEBHOOK_SIGNATURE_HEADER,
  signPaymentWebhook,
  type TestCardCode,
  type TestPaymentProvider,
} from "./test-payment-provider";

/**
 * TASK-042 on a real PostgreSQL and Redis with the API and two workers and the
 * test payment provider: a card linked on the provider's page and the first
 * charge; a refused first charge (no subscription, no card); the daily charge
 * and «not twice for a term» under every repeat and race; a refusal with W-05
 * by the day and the pause on the third; paying lifts the billing pause and
 * only it; the two pauses; a provider that is unavailable or whose answer is
 * lost (no notice, no pause, a signal, a retry after a lookup); the webhook
 * (signature first, a repeat, any order); the tariff in force; who may call
 * what; no token in any answer, log or journal.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const CABINET = "http://localhost:5175";
const PADS = "04465-0K090";
const HOUR = 3_600_000;
/** `down` this many: the fixes of TASK-042.A and whatever came after them (counted, not guessed). */
const MIGRATIONS_DOWN_TO_BELOW_BILLING_FIXES = (() => {
  const at = EXPECTED_MIGRATIONS.indexOf("1791650000000_supplier-billing-fixes");
  if (at < 0) {
    throw new Error("The migration of TASK-042.A is not in EXPECTED_MIGRATIONS");
  }
  return EXPECTED_MIGRATIONS.length - at;
})();
const DAY = 24 * HOUR;

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

describe("a supplier's card subscription (PostgreSQL + Redis + workers)", () => {
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
  let planCounter = 0;
  let almaty: string;
  let padsId: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let token: string;

  /** The test provider of the worker (the jobs queued by the API run there). */
  const provider = () => worker.get(PaymentProvider) as TestPaymentProvider;

  /** A second process of the queue on the same database, for the races that need two. */
  async function withSecondWorker<T>(
    run: (second: INestApplicationContext, secondProvider: TestPaymentProvider) => Promise<T>,
  ): Promise<T> {
    const second = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    try {
      return await run(second, second.get(PaymentProvider) as TestPaymentProvider);
    } finally {
      await second.close();
    }
  }

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
      SUPPLIER_WEB_ORIGINS: CABINET,
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
    await truncateAll(db);
    await redis.flushall();
    provider().reset();
    (app.get(PaymentProvider) as TestPaymentProvider).reset();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      login_code_requests_per_ip: 10_000,
      admin_totp_allowed_drift_steps: 5,
      admin_totp_verify_per_admin: 1000,
      admin_totp_verify_per_ip: 1000,
      order_create_per_account: 1000,
      catalog_read_per_ip: 10_000,
      catalog_read_per_account: 10_000,
      billing_actions_per_member: 1000,
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
    const { rows } = await db.query<{ id: string }>(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      ["geely", normalizeArticle(PADS)],
    );
    padsId = rows[0]!.id;
    planCounter = 0;
  }, 120_000);

  afterEach(() => {
    output?.stop();
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

  async function waitFor<T>(
    what: string,
    read: () => Promise<T | null | undefined | false>,
    ms = 25_000,
  ): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(120);
    }
  }

  // ---------------------------------------------------------------- world

  type As = (method: Method, path: string, body?: object) => Test;

  interface Company {
    supplierId: string;
    memberId: string;
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
      (body) => adminSupplierResponseSchema.parse(body).supplier,
    );
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM supplier_member WHERE supplier_id = $1",
      [created.supplier.id],
    );
    return {
      supplierId: created.supplier.id,
      memberId: rows[0]!.id,
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

  async function addPlan(price: number, startsInMs = -HOUR): Promise<void> {
    await app.get(Plans).add(
      {
        audience: "supplier",
        code: `supplier-plan-${String(++planCounter)}`,
        price,
        validFrom: new Date(Date.now() + startsInMs),
        validTo: null,
        announceBeforeDays: 7,
        reason: "integration test",
      },
      { role: "operator" },
    );
  }

  /** The company walks the whole trip: the page, a card, the return. Returns the binding id. */
  async function bind(of: Company, card: TestCardCode): Promise<string> {
    const started = await ok(
      of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
      (body) => startCardBindingResponseSchema.parse(body),
      201,
    );
    expect(started.redirectUrl).toMatch(/^\/dev\/payment\/card\?ref=tb_/);
    const page = await http().get(started.redirectUrl);
    expect(page.status).toBe(200);
    expect(page.text).toContain("data-card");
    const chosen = await http().get(
      `/dev/payment/card/choose?ref=${new URL(started.redirectUrl, "http://x").searchParams.get("ref")}&card=${card}`,
    );
    expect(chosen.status).toBe(303);
    expect(chosen.headers.location).toBe(`${CABINET}/billing?binding=${started.binding.id}`);
    return started.binding.id;
  }

  async function bindingStatus(of: Company, id: string) {
    return ok(of.as("get", `/supplier/billing/card-bindings/${id}`), (body) =>
      cardBindingResponseSchema.parse(body),
    ).then((parsed) => parsed.binding);
  }

  async function bindAndWait(of: Company, card: TestCardCode) {
    const id = await bind(of, card);
    return waitFor("the binding to finish", async () => {
      const binding = await bindingStatus(of, id);
      return ["completed", "declined", "failed", "abandoned"].includes(binding.status)
        ? binding
        : null;
    });
  }

  interface SubRow {
    id: string;
    status: string;
    current_period_end: Date;
    grace_until: Date | null;
    provider_ref: string;
  }

  async function subOf(of: Company): Promise<SubRow | undefined> {
    const { rows } = await db.query<SubRow>(
      "SELECT id, status, current_period_end, grace_until, provider_ref FROM subscription WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 1",
      [of.supplierId],
    );
    return rows[0];
  }

  async function waitStatus(of: Company, status: string): Promise<SubRow> {
    return waitFor(`the subscription to be ${status}`, async () => {
      const sub = await subOf(of);
      return sub?.status === status ? sub : null;
    });
  }

  /** A paid company with an active subscription on the good card. */
  async function subscribed(name: string): Promise<Company> {
    const of = await company(name);
    const binding = await bindAndWait(of, "ok");
    expect(binding.status).toBe("completed");
    await waitStatus(of, "active");
    return of;
  }

  async function atTermEnd(of: Company): Promise<void> {
    await db.query(
      "UPDATE subscription SET current_period_end = now() - interval '1 hour' WHERE supplier_id = $1 AND status <> 'expired'",
      [of.supplierId],
    );
  }

  /** The days pass: what happened is moved back a day (the attempts, the retries' window). */
  async function aDayPasses(of: Company): Promise<void> {
    // What happened is applied before time moves: an event still waiting would be
    // applied against dates that moved under it.
    await waitFor("the events to be applied", async () => {
      const { rows } = await db.query("SELECT 1 FROM billing_event WHERE outcome = 'pending'");
      return rows.length === 0;
    });
    await db.query(
      "UPDATE payment_attempt SET created_at = created_at - interval '1 day', resolved_at = resolved_at - interval '1 day' WHERE supplier_id = $1",
      [of.supplierId],
    );
    await db.query(
      "UPDATE subscription SET grace_until = grace_until - interval '1 day' WHERE supplier_id = $1 AND grace_until IS NOT NULL",
      [of.supplierId],
    );
    // Yesterday's notices are yesterday's: today's refusal is a new day's message.
    await db.query(
      "UPDATE outbound_message SET dedupe_key = dedupe_key || ':earlier' || gen_random_uuid()::text WHERE template IN ('payment_failed', 'payment_failed_last')",
    );
  }

  /** The hour of the day in Almaty right now: the tests that set the job's hour against it. */
  function almatyHourNow(): number {
    return Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: "Asia/Almaty",
      }).format(new Date()),
    );
  }

  /** The daily job's work for one company, in the worker. */
  async function chargeDay(of: Company, kind: "scheduled" | "retry"): Promise<void> {
    const sub = (await subOf(of))!;
    await worker.get(PaymentCharger).chargeSubscription(sub.id, kind);
  }

  async function attemptsOf(of: Company) {
    const { rows } = await db.query<{
      id: string;
      kind: string;
      status: string;
      attempt_no: number;
      amount: number;
      decline_reason: string | null;
      idempotency_key: string;
      next_try_at: Date | null;
      resolved_at: Date | null;
      period_key: string;
    }>(
      "SELECT id, kind, status, attempt_no, amount, decline_reason, idempotency_key, next_try_at, resolved_at, period_key FROM payment_attempt WHERE supplier_id = $1 ORDER BY created_at, attempt_no",
      [of.supplierId],
    );
    return rows;
  }

  /** The subscription is looked at by the sweeper once. */
  async function expireRun() {
    return new SweepRunner(worker.get(DatabaseService)).run(
      expireSubscriptionsJob,
      worker.get(SubscriptionExpiry),
      { signal: new AbortController().signal },
    );
  }

  /**
   * The minute sweep, run until the subscription reaches `status`: one pass
   * skips a row another transaction holds (`SKIP LOCKED`) — the worker applying
   * an event, say — and the scheduled pass comes only a minute later.
   */
  async function expireUntil(of: Company, status: string): Promise<SubRow> {
    return waitFor(`the subscription to be ${status}`, async () => {
      await expireRun();
      const sub = await subOf(of);
      return sub?.status === status ? sub : null;
    });
  }

  /** The notices of an unpaid subscription, W-05 and W-05a, in the order they were queued. */
  async function messagesOf(of: Company) {
    const { rows } = await db.query<{
      template: string;
      phone: string;
      status: string;
      dedupe_key: string;
      variables: Record<string, string> | null;
    }>(
      "SELECT template, phone, status, dedupe_key, variables FROM outbound_message WHERE template IN ('payment_failed', 'payment_failed_last') AND phone = $1 ORDER BY created_at, id",
      [of.phone],
    );
    return rows;
  }

  async function signalsOf(kind: string, status = "current") {
    const page = await ok(asAdmin("get", `/admin/signals?kind=${kind}&status=${status}`), (body) =>
      adminSignalPageSchema.parse(body),
    );
    return page.signals;
  }

  async function cabinet(of: Company) {
    return ok(of.as("get", "/supplier/subscription"), (body) =>
      supplierSubscriptionResponseSchema.parse(body),
    );
  }

  async function supplierRow(of: Company) {
    const { rows } = await db.query<{
      status: string;
      admin_paused_at: Date | null;
      billing_paused_at: Date | null;
      card_linked_at: Date | null;
      blocked_at: Date | null;
    }>(
      "SELECT status, admin_paused_at, billing_paused_at, card_linked_at, blocked_at FROM supplier WHERE id = $1",
      [of.supplierId],
    );
    return rows[0]!;
  }

  async function shown(offer: SupplierOffer) {
    return (await offerShowcase(app.get(DatabaseService).db, [offer.id])).get(offer.id)!;
  }

  /** The very word of the provider's webhook, signed as the provider signs it. */
  function webhook(body: object, secret = config.payments.webhookSecret!) {
    const text = JSON.stringify(body);
    return http()
      .post(PAYMENT_WEBHOOK_PATH)
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", nextIp())
      .set(PAYMENT_WEBHOOK_SIGNATURE_HEADER, signPaymentWebhook(secret, text))
      .send(text);
  }

  /** The company's card for the next charges, linked through the real trip (a subscription exists: nothing is charged). */
  async function changeCard(of: Company, card: TestCardCode): Promise<void> {
    const binding = await bindAndWait(of, card);
    expect(binding.status).toBe("completed");
  }

  // ------------------------------------------------------------- the card

  describe("the card and the first charge", () => {
    it("links a card on the provider's page, charges the first term and begins the subscription", async () => {
      await addPlan(1_000);
      const of = await company("Привязка");
      const before = await cabinet(of);
      expect(before).toMatchObject({
        cardLinked: false,
        subscription: null,
        card: null,
        pauses: { admin: false, billing: false },
        actions: { canPayNow: false, inProgress: false, canStart: true },
      });
      expect(before.plan).toMatchObject({ price: 1_000 });

      const binding = await bindAndWait(of, "ok");
      expect(binding).toMatchObject({ status: "completed", failure: null });
      expect(binding.card).toMatchObject({ mask: "4242", brand: "visa", expired: false });
      const sub = await waitStatus(of, "active");

      // One term from today, ending at a midnight of Almaty on the same day next month.
      const { rows } = await db.query<{ ends: string; started: string }>(
        `SELECT to_char(s.current_period_end AT TIME ZONE 'Asia/Almaty', 'DD HH24:MI') AS ends,
                to_char(now() AT TIME ZONE 'Asia/Almaty', 'DD') AS started
         FROM subscription s WHERE s.id = $1`,
        [sub.id],
      );
      expect(rows[0]!.ends.endsWith("00:00")).toBe(true);
      const after = await cabinet(of);
      expect(after).toMatchObject({
        cardLinked: true,
        subscription: { status: "active", amount: 1_000, lastDecline: null },
        card: { mask: "4242", brand: "visa" },
        actions: { canPayNow: false, inProgress: false },
      });
      expect(after.subscription!.nextChargeAt).not.toBeNull();

      // Exactly one charge went to the provider, once, with the amount of the tariff.
      expect(provider().charges).toHaveLength(1);
      expect(provider().charges[0]).toMatchObject({ amount: 1_000, currency: "KZT" });
      const history = await ok(of.as("get", "/supplier/billing/charges"), (body) =>
        supplierChargePageSchema.parse(body),
      );
      expect(history.charges).toHaveLength(1);
      expect(history.charges[0]).toMatchObject({
        kind: "first",
        outcome: "succeeded",
        amount: 1_000,
        declineReason: null,
      });
      expect(await supplierRow(of)).toMatchObject({ status: "active" });
      expect((await supplierRow(of)).card_linked_at).not.toBeNull();
    });

    it("keeps no card and no subscription when the bank refuses the first charge, and allows another try at once", async () => {
      await addPlan(1_000);
      const of = await company("Отказ первый");
      const refused = await bindAndWait(of, "insufficient_funds");
      expect(refused).toMatchObject({
        status: "declined",
        failure: "insufficient_funds",
        card: null,
        subscriptionStatus: null,
      });
      expect(await subOf(of)).toBeUndefined();
      expect((await supplierRow(of)).card_linked_at).toBeNull();
      const { rows } = await db.query("SELECT 1 FROM payment_method WHERE supplier_id = $1", [
        of.supplierId,
      ]);
      expect(rows).toHaveLength(0);
      expect(await messagesOf(of)).toHaveLength(0);
      // The refused card is let go at the provider; the binding does not keep its token.
      await waitFor("the token to be dropped", async () => {
        await worker.get(ResolvePaymentsHandler).run({} as never);
        const { rows: held } = await db.query<{ t: string | null }>(
          "SELECT card_token_sealed AS t FROM card_binding WHERE supplier_id = $1",
          [of.supplierId],
        );
        return held.every((row) => row.t === null);
      }).catch(() => undefined);
      // Another try is open at once, and with a good card it works.
      const again = await bindAndWait(of, "ok");
      expect(again.status).toBe("completed");
      await waitStatus(of, "active");
      expect(provider().charges).toHaveLength(2);
    });

    it("asks for a tariff first: without one nothing starts, and the administrator is told", async () => {
      const of = await company("Без тарифа");
      expectError(
        await of.as("post", "/supplier/billing/card-bindings", {
          returnUrl: `${CABINET}/billing`,
        }),
        409,
        "BILLING_NO_PLAN",
      );
      expect(await subOf(of)).toBeUndefined();
      const signals = await signalsOf("billing_plan_missing");
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ subjectType: "channel" });
      // Once a tariff is in force the signal closes by itself.
      await addPlan(1_000);
      await worker.get(WatchProviderHandler).run({} as never);
      expect(await signalsOf("billing_plan_missing")).toHaveLength(0);
    });

    it("changes the card of a subscription without charging, and forgets the old one at the provider", async () => {
      await addPlan(1_000);
      const of = await subscribed("Смена карты");
      const { rows: first } = await db.query<{ id: string }>(
        "SELECT id FROM payment_method WHERE supplier_id = $1 AND status = 'active'",
        [of.supplierId],
      );
      await changeCard(of, "insufficient_funds");
      expect(provider().charges).toHaveLength(1);
      const { rows: methods } = await db.query<{ id: string; status: string; mask: string }>(
        "SELECT id, status, mask FROM payment_method WHERE supplier_id = $1 ORDER BY created_at",
        [of.supplierId],
      );
      expect(methods.map((row) => [row.status, row.mask])).toEqual([
        ["replaced", "4242"],
        ["active", "9995"],
      ]);
      expect(methods[0]!.id).toBe(first[0]!.id);
      await waitFor("the old token to be forgotten", async () => provider().detached.length > 0);
      expect((await cabinet(of)).card).toMatchObject({ mask: "9995" });
      const { rows: journal } = await db.query<{ after: { change?: string; mask?: string } }>(
        "SELECT after FROM audit_log WHERE action = 'supplier.card_changed' AND entity_id = $1 ORDER BY created_at",
        [of.supplierId],
      );
      expect(journal.map((row) => [row.after.change, row.after.mask])).toEqual([
        ["linked", "4242"],
        ["replaced", "9995"],
      ]);
    });

    it("gives the same trip again while one is open, and abandons it when the page is left", async () => {
      await addPlan(1_000);
      const of = await company("Страница");
      const first = await ok(
        of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      const again = await ok(
        of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      expect(again.binding.id).toBe(first.binding.id);
      expect(again.redirectUrl).toBe(first.redirectUrl);
      // The person closes the page without a card.
      const ref = new URL(first.redirectUrl, "http://x").searchParams.get("ref");
      await http().get(`/dev/payment/card/choose?ref=${ref}&card=cancel`).expect(303);
      expect(await bindingStatus(of, first.binding.id)).toMatchObject({
        status: "abandoned",
        failure: "cancelled",
      });
      expect(await subOf(of)).toBeUndefined();
      expect((await cabinet(of)).cardLinked).toBe(false);
      // Nothing is broken: a new trip opens.
      expect((await bindAndWait(of, "ok")).status).toBe("completed");
    });

    it("refuses a return address that is not the cabinet's, and a binding of another company", async () => {
      await addPlan(1_000);
      const of = await company("Адрес");
      const other = await company("Чужая");
      for (const returnUrl of [
        "https://evil.example/billing",
        "http://localhost.evil.example:5175/billing",
        "not a url",
      ]) {
        expectError(
          await of.as("post", "/supplier/billing/card-bindings", { returnUrl }),
          400,
          returnUrl === "not a url" ? "VALIDATION_ERROR" : "BILLING_RETURN_URL_INVALID",
        );
      }
      const started = await ok(
        of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      expectError(
        await other.as("get", `/supplier/billing/card-bindings/${started.binding.id}`),
        404,
        "NOT_FOUND",
      );
    });

    it("says the payment system is unavailable when its page cannot be opened", async () => {
      await addPlan(1_000);
      const of = await company("Недоступна страница");
      // The API process has its own provider instance.
      (app.get(PaymentProvider) as TestPaymentProvider).mode = "unavailable";
      try {
        expectError(
          await of.as("post", "/supplier/billing/card-bindings", {
            returnUrl: `${CABINET}/billing`,
          }),
          503,
          "SERVICE_UNAVAILABLE",
        );
      } finally {
        (app.get(PaymentProvider) as TestPaymentProvider).mode = "ok";
      }
      expect(await subOf(of)).toBeUndefined();
      expect((await bindAndWait(of, "ok")).status).toBe("completed");
    });
  });

  // ------------------------------------------------------ the daily charge

  describe("the charge at the end of a term", () => {
    it("charges the next term from the old date, once, however often it is asked", async () => {
      await addPlan(1_000);
      const of = await subscribed("Плановое");
      const first = (await subOf(of))!;
      await atTermEnd(of);
      const due = (await subOf(of))!.current_period_end;
      // The daily job finds it; asking again and again charges nothing more.
      await worker.get(ChargeDueHandler).run({} as never);
      await waitFor("the renewal to be applied", async () => {
        const sub = await subOf(of);
        return sub!.current_period_end.getTime() > due.getTime() ? sub : null;
      });
      for (let round = 0; round < 3; round++) {
        await worker.get(ChargeDueHandler).run({} as never);
        await chargeDay(of, "scheduled");
        await sleep(150);
      }
      const attempts = await attemptsOf(of);
      expect(attempts.map((row) => [row.kind, row.status])).toEqual([
        ["first", "succeeded"],
        ["scheduled", "succeeded"],
      ]);
      expect(provider().charges).toHaveLength(2);
      const renewed = (await subOf(of))!;
      // The new term is the same day number next month — from the old date, not from today.
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT ($1::timestamptz AT TIME ZONE 'Asia/Almaty')::date + interval '1 month' = ($2::timestamptz AT TIME ZONE 'Asia/Almaty')::date AS ok`,
        [due, renewed.current_period_end],
      );
      expect(rows[0]!.ok).toBe(true);
      expect(renewed.status).toBe("active");
      expect(first.id).toBe(renewed.id);
    });

    it("charges the tariff in force on the day, not the one the subscription began with", async () => {
      await addPlan(1_000, -3 * DAY);
      const of = await subscribed("Тариф");
      await addPlan(3_000, -HOUR);
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      const [, renewal] = await attemptsOf(of);
      expect(renewal).toMatchObject({ amount: 3_000, kind: "scheduled" });
      expect(provider().charges.map((request) => request.amount)).toEqual([1_000, 3_000]);
      // A tariff that has not started yet is not charged and is announced.
      await addPlan(9_000, 5 * DAY);
      const view = await cabinet(of);
      expect(view.plan).toMatchObject({ price: 3_000 });
      expect(view.announcedPlan).toMatchObject({ price: 9_000 });
    });

    it("does not charge twice when two workers and the API race for the same term", async () => {
      await addPlan(1_000);
      const of = await subscribed("Гонка");
      await atTermEnd(of);
      const sub = (await subOf(of))!;
      const firstCalls = provider().charges.length;
      const secondCalls = await withSecondWorker(async (second, secondProvider) => {
        await Promise.all([
          worker.get(PaymentCharger).chargeSubscription(sub.id, "scheduled"),
          second.get(PaymentCharger).chargeSubscription(sub.id, "scheduled"),
          worker.get(PaymentCharger).chargeSubscription(sub.id, "scheduled"),
          second.get(PaymentCharger).chargeSubscription(sub.id, "scheduled"),
          worker.get(ChargeDueHandler).run({} as never),
          second.get(ChargeDueHandler).run({} as never),
        ]);
        await waitFor("the term to be paid", async () => {
          const { rows } = await db.query(
            "SELECT 1 FROM payment_attempt WHERE supplier_id = $1 AND status = 'succeeded'",
            [of.supplierId],
          );
          return rows.length === 2;
        });
        await sleep(500);
        return secondProvider.charges.length;
      });
      // Counted at the providers themselves: one call for the term, not six.
      expect(provider().charges.length - firstCalls + secondCalls).toBe(1);
      const { rows: attempts } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM payment_attempt WHERE supplier_id = $1 AND status IN ('succeeded', 'created', 'unknown', 'unavailable')",
        [of.supplierId],
      );
      expect(attempts[0]!.n).toBe(2);
    });

    it("lets two employees press «Оплатить сейчас» together and gives them the same charge", async () => {
      await addPlan(1_000);
      const of = await subscribed("Двое");
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await changeCard(of, "ok");
      const [a, b, c] = await Promise.all([
        of.as("post", "/supplier/billing/pay"),
        of.as("post", "/supplier/billing/pay"),
        of.as("post", "/supplier/billing/pay"),
      ]);
      const charges = [a, b, c].map((response) => {
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        return payNowResponseSchema.parse(response.body).charge;
      });
      expect(new Set(charges.map((charge) => charge.id)).size).toBe(1);
      await waitStatus(of, "active");
      await waitFor("the charge to be settled", async () => {
        const rows = await attemptsOf(of);
        return rows.at(-1)!.status === "succeeded";
      });
      expect(provider().charges).toHaveLength(2);
      // Nothing more to pay: the term is paid.
      await waitFor("the term moved", async () => {
        const view = await cabinet(of);
        return !view.actions.canPayNow && !view.actions.inProgress;
      });
      expectError(await of.as("post", "/supplier/billing/pay"), 409, "BILLING_NOTHING_TO_PAY");
    });
  });

  // ----------------------------------------- a refusal, the days, the pause

  describe("a refusal of the bank", () => {
    it("tells the payer by the day, retries once a day for three days and pauses on the third, offers hidden, orders kept", async () => {
      // The days of this scenario pass by moving what happened back a day, so the
      // refusal has to come after the daily job's hour, as a scheduled one does:
      // refused before the hour, the window would end a day later than three
      // days (`bankRetryWindowEnd`) and the pause would not come on day 3.
      await settings.set({ billing_notify_hour: almatyHourNow() });
      await new TestSettings(app).reload();
      await addPlan(1_000);
      const of = await subscribed("Отказ");
      const offer = await put(of);
      expect((await shown(offer)).visible).toBe(true);
      // An order taken before the pause.
      const who = await customerWithAccess();
      const order = await placed(who, offer);
      await ok(
        of.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (body) => body,
      );

      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);

      // Day 0: the first refusal.
      await chargeDay(of, "scheduled");
      const pastDue = await waitStatus(of, "past_due");
      // The pause is where the retries' window ends (ARCHITECTURE 4.77 I837): three
      // days after the first refusal, and never earlier than a day after the last
      // retry owed — which is later than three days when the refusal comes before
      // the daily job's hour. The rule itself, not «about three days».
      const firstRefusal = (await attemptsOf(of)).find((row) => row.status === "declined")!;
      expect(pastDue.grace_until!.getTime()).toBe(
        bankRetryWindowEnd({
          firstDeclinedAt: firstRefusal.resolved_at!,
          lastDeclinedAt: firstRefusal.resolved_at!,
          declinedCount: 1,
          retryDays: 3,
          hour: almatyHourNow(),
        }).getTime(),
      );
      expect(pastDue.grace_until!.getTime()).toBeGreaterThan(Date.now() + 2.9 * DAY);
      expect(await messagesOf(of)).toHaveLength(1);
      const signals = await signalsOf("payment_failed");
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        subjectType: "supplier",
        subjectId: of.supplierId,
        payload: { declineReason: "insufficient_funds", declines: 1 },
      });
      const day0 = await cabinet(of);
      expect(day0).toMatchObject({
        subscription: {
          status: "past_due",
          lastDecline: { reason: "insufficient_funds" },
        },
        actions: { canPayNow: true },
        pauses: { billing: false },
      });
      expect(day0.subscription!.nextChargeAt).not.toBeNull();
      // Still on the showcase: nothing is switched off at once.
      expect((await shown(offer)).visible).toBe(true);

      // The same day again changes nothing: one try a day, one message a day.
      await chargeDay(of, "retry");
      expect(await attemptsOf(of)).toHaveLength(2); // the first charge and today's refusal
      expect(await messagesOf(of)).toHaveLength(1);

      // Day 1: a retry and a message that promises the next one.
      await aDayPasses(of);
      await chargeDay(of, "retry");
      await waitFor("the second message", async () => (await messagesOf(of)).length === 2);
      // Day 2: the last try of the window, and the message that says there will be no more.
      await aDayPasses(of);
      await chargeDay(of, "retry");
      await waitFor("the third message", async () => (await messagesOf(of)).length === 3);
      const declined = (await attemptsOf(of)).filter((row) => row.status === "declined");
      expect(declined.map((row) => row.attempt_no)).toEqual([1, 2, 3]);
      const notices = await messagesOf(of);
      expect(new Set(notices.map((row) => row.dedupe_key)).size).toBe(3);
      expect(notices.every((row) => row.phone === of.phone)).toBe(true);
      // «Повторим {дата}» twice, then W-05a with the day the offers leave the showcase.
      expect(notices.map((row) => row.template)).toEqual([
        "payment_failed",
        "payment_failed",
        "payment_failed_last",
      ]);
      const windowEnd = (await subOf(of))!.grace_until!;
      expect(notices[2]!.variables).toMatchObject({ date: dayText(windowEnd, "ru") });
      expect(notices[2]!.variables!.link).toMatch(/\/billing$/);

      // Day 3: the retries are over — no fourth try — and the window ends: paused.
      await aDayPasses(of);
      await chargeDay(of, "retry");
      expect((await attemptsOf(of)).filter((row) => row.status === "declined")).toHaveLength(3);
      await expireUntil(of, "suspended");
      expect(await supplierRow(of)).toMatchObject({ status: "paused", admin_paused_at: null });
      expect((await supplierRow(of)).billing_paused_at).not.toBeNull();
      expect((await shown(offer)).reasons).toContain("supplier_paused");
      expect((await shown(offer)).visible).toBe(false);
      // The offer itself is untouched.
      const { rows: offers } = await db.query<{ status: string }>(
        "SELECT status FROM offer WHERE id = $1",
        [offer.id],
      );
      expect(offers[0]!.status).toBe("active");
      expect(await cabinet(of)).toMatchObject({
        subscription: { status: "suspended", nextChargeAt: null },
        pauses: { admin: false, billing: true },
        actions: { canPayNow: true },
      });
      // The order accepted before is given out all the same.
      await ok(
        of.as("post", "/supplier/orders/close", { code: order.confirmation!.code }),
        (body) => body,
      );
      // The signal stays open for the administrator while the company is paused for it.
      expect(await signalsOf("payment_failed")).toHaveLength(1);
      const { rows: pauseJournal } = await db.query<{ actor_role: string }>(
        "SELECT actor_role FROM audit_log WHERE action = 'supplier.pause_changed' AND entity_id = $1",
        [of.supplierId],
      );
      expect(pauseJournal.map((row) => row.actor_role)).toEqual(["system"]);
    });

    it("pays with a good card on a pause: the pause is lifted, the offers shown, the signal closed", async () => {
      await addPlan(1_000);
      const of = await subscribed("Оплата на паузе");
      const offer = await put(of);
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitStatus(of, "past_due");
      await db.query(
        "UPDATE subscription SET grace_until = now() - interval '1 minute' WHERE supplier_id = $1",
        [of.supplierId],
      );
      await expireUntil(of, "suspended");
      expect((await shown(offer)).visible).toBe(false);

      await changeCard(of, "ok");
      const charge = await ok(
        of.as("post", "/supplier/billing/pay"),
        (body) => payNowResponseSchema.parse(body).charge,
        202,
      );
      expect(charge.kind).toBe("manual");
      await waitStatus(of, "active");
      expect(await supplierRow(of)).toMatchObject({ status: "active", billing_paused_at: null });
      expect((await shown(offer)).visible).toBe(true);
      expect(await signalsOf("payment_failed")).toHaveLength(0);
      expect(await signalsOf("payment_failed", "closed")).toHaveLength(1);
      // The term continues from the old date: paid late, no free days.
      const history = await ok(of.as("get", "/supplier/billing/charges?limit=10"), (body) =>
        supplierChargePageSchema.parse(body),
      );
      expect(history.charges.map((row) => [row.kind, row.outcome])).toEqual([
        ["manual", "succeeded"],
        ["scheduled", "declined"],
        ["first", "succeeded"],
      ]);
    });

    it("sends the notice to the contact person, and to the employees who get orders if there is none", async () => {
      await addPlan(1_000);
      const of = await subscribed("Получатели");
      // A second employee, the contact person; the first receives notices of orders.
      const phone2 = `+7705${String(++phoneCounter).padStart(7, "0")}`;
      rememberCode(phone2);
      await ok(
        asAdmin("post", `/admin/suppliers/${of.supplierId}/members`, {
          name: "Марат",
          phone: phone2,
        }),
        (body) => body,
        201,
      );
      const { rows } = await db.query<{ id: string }>(
        "SELECT sm.id FROM supplier_member sm JOIN account a ON a.id = sm.account_id WHERE a.phone = $1",
        [phone2],
      );
      await db.query(
        "UPDATE supplier_member SET is_contact_person = false WHERE supplier_id = $1",
        [of.supplierId],
      );
      await db.query("UPDATE supplier_member SET is_contact_person = true WHERE id = $1", [
        rows[0]!.id,
      ]);
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitFor("the notice", async () => {
        const { rows: sent } = await db.query<{ phone: string }>(
          "SELECT phone FROM outbound_message WHERE template = 'payment_failed'",
        );
        return sent.length > 0 ? sent : null;
      });
      let { rows: sent } = await db.query<{ phone: string }>(
        "SELECT phone FROM outbound_message WHERE template = 'payment_failed'",
      );
      expect(sent.map((row) => row.phone)).toEqual([phone2]);
      await waitStatus(of, "past_due");
      // The contact person is removed: the notice goes to the others, not to nobody.
      await db.query("DELETE FROM outbound_message");
      await db.query(
        "UPDATE supplier_member SET status = 'removed', removed_at = now(), is_contact_person = false, notifications_enabled_at = NULL WHERE id = $1",
        [rows[0]!.id],
      );
      await aDayPasses(of);
      await chargeDay(of, "retry");
      await waitFor("the notice to the others", async () => {
        const { rows: again } = await db.query<{ phone: string }>(
          "SELECT phone FROM outbound_message WHERE template = 'payment_failed'",
        );
        return again.length > 0 ? again : null;
      });
      ({ rows: sent } = await db.query<{ phone: string }>(
        "SELECT phone FROM outbound_message WHERE template = 'payment_failed'",
      ));
      expect(sent.map((row) => row.phone)).toEqual([of.phone]);
    });
  });

  // ------------------------------------------------------- the two pauses

  describe("the two pauses", () => {
    async function pauseByAdmin(of: Company, paused: boolean) {
      const card = (
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}`), (body) =>
          adminSupplierResponseSchema.parse(body),
        )
      ).supplier;
      return asAdmin("post", `/admin/suppliers/${of.supplierId}/pause`, {
        expectedVersion: card.version,
        paused,
        ...(paused ? { reason: "admin" } : {}),
        note: "Проверка документов",
      });
    }

    async function suspend(of: Company): Promise<void> {
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitStatus(of, "past_due");
      await db.query(
        "UPDATE subscription SET grace_until = now() - interval '1 minute' WHERE supplier_id = $1",
        [of.supplierId],
      );
      await expireUntil(of, "suspended");
    }

    it("keeps the administrator's pause when the payment lifts the billing one, and the billing one when the administrator lifts theirs", async () => {
      await addPlan(1_000);
      const of = await subscribed("Две паузы");
      const offer = await put(of);
      expect((await pauseByAdmin(of, true)).status).toBe(200);
      await suspend(of);
      expect(await supplierRow(of)).toMatchObject({ status: "paused" });
      const both = await supplierRow(of);
      expect(both.admin_paused_at).not.toBeNull();
      expect(both.billing_paused_at).not.toBeNull();
      const card = (
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}`), (body) =>
          adminSupplierResponseSchema.parse(body),
        )
      ).supplier;
      expect(card.pauses.admin).toMatchObject({ note: "Проверка документов" });
      expect(card.pauses.billing).not.toBeNull();
      expect(card.pause?.reason).toBe("admin");

      // The administrator lifts theirs: the company stays paused for billing.
      expect((await pauseByAdmin(of, false)).status).toBe(200);
      expect(await supplierRow(of)).toMatchObject({ status: "paused", admin_paused_at: null });
      expect((await supplierRow(of)).billing_paused_at).not.toBeNull();
      expect((await shown(offer)).visible).toBe(false);
      // Lifting again when only the billing pause holds: nothing of theirs to lift.
      expectError(await pauseByAdmin(of, false), 409, "SUPPLIER_STATE");

      // Back to both; then the payment lifts the billing one and leaves the administrator's.
      expect((await pauseByAdmin(of, true)).status).toBe(200);
      await changeCard(of, "ok");
      await ok(of.as("post", "/supplier/billing/pay"), (body) => body, 202);
      await waitStatus(of, "active");
      const after = await supplierRow(of);
      expect(after).toMatchObject({ status: "paused", billing_paused_at: null });
      expect(after.admin_paused_at).not.toBeNull();
      expect((await shown(offer)).visible).toBe(false);
      const view = await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}/billing`), (body) =>
        adminSupplierBillingResponseSchema.parse(body),
      );
      expect(view.pauses.admin).not.toBeNull();
      expect(view.pauses.billing).toBeNull();
      // Only then does the administrator's lift show the offer again.
      expect((await pauseByAdmin(of, false)).status).toBe(200);
      expect((await shown(offer)).visible).toBe(true);
    });

    it("is read the same by the rule of the showcase and by its SQL twin in every combination of the pauses", async () => {
      await addPlan(1_000);
      const of = await subscribed("Двойник");
      const offer = await put(of);
      for (const admin of [false, true]) {
        for (const billing of [false, true]) {
          for (const blocked of [false, true]) {
            await db.query(
              `UPDATE supplier SET
                 admin_paused_at = CASE WHEN $2::boolean THEN now() END,
                 admin_pause_note = CASE WHEN $2::boolean THEN 'x' END,
                 billing_paused_at = CASE WHEN $3::boolean THEN now() END,
                 block_reason = CASE WHEN $4::boolean THEN 'x' END,
                 blocked_at = CASE WHEN $4::boolean THEN now() END,
                 status = CASE WHEN $4::boolean THEN 'blocked' WHEN $2::boolean OR $3::boolean THEN 'paused' ELSE 'active' END
               WHERE id = $1`,
              [of.supplierId, admin, billing, blocked],
            );
            const rule = (await shown(offer)).visible;
            const twin = (
              await app
                .get(DatabaseService)
                .db.select({ id: offerTable.id })
                .from(offerTable)
                .where(shownOffers())
            ).some((row) => row.id === offer.id);
            const label = `admin=${String(admin)} billing=${String(billing)} blocked=${String(blocked)}`;
            expect(rule, label).toBe(!admin && !billing && !blocked);
            expect(twin, label).toBe(rule);
          }
        }
      }
    });

    it("refuses an administrator's pause for billing: the subscription alone puts and lifts that one", async () => {
      await addPlan(1_000);
      const of = await subscribed("Не вручную");
      const card = (
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}`), (body) =>
          adminSupplierResponseSchema.parse(body),
        )
      ).supplier;
      const response = await asAdmin("post", `/admin/suppliers/${of.supplierId}/pause`, {
        expectedVersion: card.version,
        paused: true,
        reason: "billing",
        note: "Вручную",
      });
      expect(response.status).toBe(400);
      expect(await supplierRow(of)).toMatchObject({ status: "active" });
    });

    it("lets a blocked company pay, and leaves the block where it is", async () => {
      await addPlan(1_000);
      const of = await subscribed("Блок");
      const card = (
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}`), (body) =>
          adminSupplierResponseSchema.parse(body),
        )
      ).supplier;
      await ok(
        asAdmin("post", `/admin/suppliers/${of.supplierId}/block`, {
          expectedVersion: card.version,
          blocked: true,
          reason: "Проверка",
        }),
        (body) => body,
      );
      await atTermEnd(of);
      await ok(of.as("post", "/supplier/billing/pay"), (body) => body, 202);
      await waitFor(
        "the payment",
        async () => (await attemptsOf(of)).at(-1)!.status === "succeeded",
      );
      await waitFor(
        "the term moved",
        async () => (await subOf(of))!.current_period_end.getTime() > Date.now(),
      );
      expect(await supplierRow(of)).toMatchObject({ status: "blocked" });
      expect((await supplierRow(of)).blocked_at).not.toBeNull();
    });
  });

  // -------------------------------------- a provider that does not answer

  describe("a provider that is unavailable or whose answer is lost", () => {
    it("is nobody's fault: no notice, no pause, a retry in an hour, a signal after the threshold, and the charge when it is back", async () => {
      await addPlan(1_000);
      const of = await subscribed("Недоступен");
      await atTermEnd(of);
      provider().mode = "unavailable";
      await chargeDay(of, "scheduled");
      const [, attempt] = await attemptsOf(of);
      expect(attempt).toMatchObject({ status: "unavailable" });
      const minutes = (attempt!.next_try_at!.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(55);
      expect(minutes).toBeLessThan(61);
      expect((await subOf(of))!.status).toBe("active");
      expect(await messagesOf(of)).toHaveLength(0);
      expect(await signalsOf("payment_failed")).toHaveLength(0);
      expect(await supplierRow(of)).toMatchObject({ status: "active" });
      expect((await cabinet(of)).actions.inProgress).toBe(true);

      // Not yet an hour of silence: no signal. Then the threshold passes.
      await worker.get(WatchProviderHandler).run({} as never);
      expect(await signalsOf("payment_system_down")).toHaveLength(0);
      await db.query(
        "UPDATE payment_attempt SET first_failure_at = now() - interval '2 hours' WHERE supplier_id = $1 AND status = 'unavailable'",
        [of.supplierId],
      );
      await worker.get(WatchProviderHandler).run({} as never);
      const down = await signalsOf("payment_system_down");
      expect(down).toHaveLength(1);
      expect(down[0]).toMatchObject({ subjectType: "channel", payload: { failedPayments: 1 } });

      // The hour passes, the provider is back: the charge goes through, the signal closes.
      provider().mode = "ok";
      await db.query(
        "UPDATE payment_attempt SET next_try_at = now() - interval '1 minute' WHERE supplier_id = $1 AND status = 'unavailable'",
        [of.supplierId],
      );
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await waitFor("the retry", async () => (await attemptsOf(of)).at(-1)!.status === "succeeded");
      await worker.get(WatchProviderHandler).run({} as never);
      expect(await signalsOf("payment_system_down")).toHaveLength(0);
      expect(await signalsOf("payment_system_down", "closed")).toHaveLength(1);
      expect(
        provider().charges.filter((request) => request.idempotencyKey === attempt!.idempotency_key),
      ).toHaveLength(2 /* the failed call and the retry: one payment, one key */);
      expect(await messagesOf(of)).toHaveLength(0);
    });

    it("does not let an outage use up the retries: the refusal after it promises a retry that comes, then the last one, then the pause (defect 3)", async () => {
      await addPlan(1_000);
      const of = await subscribed("Не пауза");
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitStatus(of, "past_due");
      // The next day's retry meets a provider that is down.
      await aDayPasses(of);
      provider().mode = "unavailable";
      await chargeDay(of, "retry");
      expect((await attemptsOf(of)).at(-1)).toMatchObject({ status: "unavailable" });
      // The window ends (three days more pass) while the provider still owes its answer: no pause.
      for (let day = 0; day < 3; day++) await aDayPasses(of);
      await expireRun();
      expect((await subOf(of))!.status).toBe("past_due");
      expect(await supplierRow(of)).toMatchObject({ status: "active" });
      // The provider answers: the card is still short of funds — the second refusal of the bank.
      provider().mode = "ok";
      await db.query(
        "UPDATE payment_attempt SET next_try_at = now() - interval '1 minute' WHERE supplier_id = $1 AND status = 'unavailable'",
        [of.supplierId],
      );
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await waitFor("the answer", async () => (await attemptsOf(of)).at(-1)!.status === "declined");
      await waitFor("the event", async () => {
        const { rows } = await db.query("SELECT 1 FROM billing_event WHERE outcome = 'pending'");
        return rows.length === 0;
      });
      // Two refusals of three: W-05 promises tomorrow's retry, and the window is still open for it.
      const second = await waitFor("the second notice", async () => {
        const notices = await messagesOf(of);
        return notices.length === 2 ? notices[1]! : null;
      });
      expect(second.template).toBe("payment_failed");
      expect(second.variables).toMatchObject({ date: dayText(new Date(Date.now() + DAY), "ru") });
      await expireRun();
      expect((await subOf(of))!.status).toBe("past_due");
      expect((await subOf(of))!.grace_until!.getTime()).toBeGreaterThan(Date.now() + DAY);
      expect(await supplierRow(of)).toMatchObject({ status: "active" });
      // The promised retry comes: the third refusal, W-05a, and only then the pause.
      await aDayPasses(of);
      await chargeDay(of, "retry");
      await waitFor("the third notice", async () => (await messagesOf(of)).length === 3);
      expect((await attemptsOf(of)).filter((row) => row.status === "declined")).toHaveLength(3);
      const last = (await messagesOf(of))[2]!;
      expect(last.template).toBe("payment_failed_last");
      await waitFor("the event", async () => {
        const { rows } = await db.query("SELECT 1 FROM billing_event WHERE outcome = 'pending'");
        return rows.length === 0;
      });
      const windowEnd = (await subOf(of))!.grace_until!;
      expect(last.variables).toMatchObject({ date: dayText(windowEnd, "ru") });
      expect(windowEnd.getTime()).toBeGreaterThan(Date.now());
      await expireRun();
      expect((await subOf(of))!.status).toBe("past_due");
      await db.query(
        "UPDATE subscription SET grace_until = now() - interval '1 minute' WHERE supplier_id = $1",
        [of.supplierId],
      );
      await expireUntil(of, "suspended");
    });

    it("looks an unknown outcome up by its key before anything is sent again: the payment went through, so no second charge", async () => {
      await addPlan(1_000);
      const of = await subscribed("Неизвестно");
      await atTermEnd(of);
      provider().mode = "outcome_unknown";
      await chargeDay(of, "scheduled");
      const [, attempt] = await attemptsOf(of);
      expect(attempt).toMatchObject({ status: "unknown" });
      expect(await messagesOf(of)).toHaveLength(0);
      expect((await subOf(of))!.status).toBe("active");
      expect(provider().charges).toHaveLength(2);
      // An hour later the lookup finds the payment; nothing is sent again.
      provider().mode = "ok";
      await db.query(
        "UPDATE payment_attempt SET next_try_at = now() - interval '1 minute' WHERE id = $1",
        [attempt!.id],
      );
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await waitFor(
        "the lookup",
        async () => (await attemptsOf(of)).at(-1)!.status === "succeeded",
      );
      expect(provider().charges).toHaveLength(2);
      await waitFor(
        "the term moved",
        async () => (await subOf(of))!.current_period_end.getTime() > Date.now(),
      );
      expect((await subOf(of))!.status).toBe("active");
      expect(await messagesOf(of)).toHaveLength(0);
    });

    it("sends the unknown payment again when the provider has never seen it", async () => {
      await addPlan(1_000);
      const of = await subscribed("Потерян запрос");
      await atTermEnd(of);
      provider().mode = "unavailable";
      await chargeDay(of, "scheduled");
      provider().mode = "ok";
      // The request did not arrive: no payment under the key.
      await db.query(
        "UPDATE payment_attempt SET status = 'unknown', next_try_at = now() - interval '1 minute' WHERE supplier_id = $1 AND status = 'unavailable'",
        [of.supplierId],
      );
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await waitFor(
        "the payment",
        async () => (await attemptsOf(of)).at(-1)!.status === "succeeded",
      );
      expect(provider().ledger.size).toBe(2);
    });

    it("finds a worker lost between the call and the settlement, and settles by looking the payment up", async () => {
      await addPlan(1_000);
      const of = await subscribed("Потерян воркер");
      await atTermEnd(of);
      // The call went out and the payment was made; the worker died before it wrote the answer.
      provider().mode = "outcome_unknown";
      await chargeDay(of, "scheduled");
      const lost = (await attemptsOf(of)).at(-1)!;
      expect(lost.status).toBe("unknown");
      await db.query(
        "UPDATE payment_attempt SET status = 'created', next_try_at = NULL, tries = 1, claimed_until = now() - interval '1 minute' WHERE id = $1",
        [lost.id],
      );
      provider().mode = "ok";
      const calls = provider().charges.length;
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await waitFor(
        "the settlement",
        async () => (await attemptsOf(of)).at(-1)!.status === "succeeded",
      );
      // Looked up by its key, not sent again.
      expect(provider().charges).toHaveLength(calls);
      expect(await messagesOf(of)).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------- the webhook

  describe("the provider's webhook", () => {
    it("refuses what is not signed, signed by another or changed, and leaves no trace", async () => {
      await addPlan(1_000);
      const body = { id: "evt-1", type: "ping" };
      const text = JSON.stringify(body);
      const unsigned = await http()
        .post(PAYMENT_WEBHOOK_PATH)
        .set("Content-Type", "application/json")
        .send(text);
      expectError(unsigned, 403, "FORBIDDEN");
      expectError(await webhook(body, "another-secret-of-sixteen-chars-or-more"), 403, "FORBIDDEN");
      const changed = await http()
        .post(PAYMENT_WEBHOOK_PATH)
        .set("Content-Type", "application/json")
        .set(
          PAYMENT_WEBHOOK_SIGNATURE_HEADER,
          signPaymentWebhook(config.payments.webhookSecret!, text),
        )
        .send(text.replace("evt-1", "evt-2"));
      expectError(changed, 403, "FORBIDDEN");
      // Not even looked at: an unparseable body without a signature is the same refusal.
      expectError(
        await http()
          .post(PAYMENT_WEBHOOK_PATH)
          .set("Content-Type", "application/json")
          .send("{not json"),
        403,
        "FORBIDDEN",
      );
      const { rows } = await db.query("SELECT 1 FROM payment_webhook_event");
      expect(rows).toHaveLength(0);
      // A signed one that is nothing to apply is answered 200 and kept nowhere.
      expect((await webhook(body)).status).toBe(200);
      expect((await webhook({ nonsense: true })).status).toBe(200);
      expect((await db.query("SELECT 1 FROM payment_webhook_event")).rows).toHaveLength(0);
    });

    it("applies a success that comes before the answer to the charge, once, however often it repeats", async () => {
      await addPlan(1_000);
      const of = await subscribed("Вебхук");
      await atTermEnd(of);
      const due = (await subOf(of))!.current_period_end;
      provider().mode = "outcome_unknown";
      await chargeDay(of, "scheduled");
      const [, attempt] = await attemptsOf(of);
      expect(attempt!.status).toBe("unknown");
      const word = {
        id: "evt-pay-1",
        type: "payment",
        key: attempt!.idempotency_key,
        status: "succeeded",
        paymentId: "tp_webhook",
      };
      expect((await webhook(word)).status).toBe(200);
      expect((await webhook(word)).status).toBe(200);
      await waitFor(
        "the success",
        async () => (await attemptsOf(of)).at(-1)!.status === "succeeded",
      );
      await waitFor(
        "the term moved",
        async () => (await subOf(of))!.current_period_end.getTime() > due.getTime(),
      );
      expect((await db.query("SELECT 1 FROM payment_webhook_event")).rows).toHaveLength(1);
      // A later word with another id about the same payment changes nothing.
      expect((await webhook({ ...word, id: "evt-pay-2" })).status).toBe(200);
      await sleep(600);
      const { rows: events } = await db.query(
        "SELECT 1 FROM billing_event WHERE supplier_id = $1 AND kind = 'renewed'",
        [of.supplierId],
      );
      expect(events).toHaveLength(1);
      expect((await attemptsOf(of)).filter((row) => row.status === "succeeded")).toHaveLength(2);
      // The answer to the charge that came after is a late word and changes nothing either.
      provider().mode = "ok";
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await sleep(400);
      expect((await subOf(of))!.status).toBe("active");
    });

    it("restores a paused company from a success that arrives after the pause", async () => {
      await addPlan(1_000);
      const of = await subscribed("Вебхук пауза");
      const offer = await put(of);
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitStatus(of, "past_due");
      await db.query(
        "UPDATE subscription SET grace_until = now() - interval '1 minute' WHERE supplier_id = $1",
        [of.supplierId],
      );
      await expireUntil(of, "suspended");
      expect((await shown(offer)).visible).toBe(false);
      // The person paid at the bank's own page: a manual attempt is open, and the provider says it succeeded.
      await changeCard(of, "ok");
      provider().mode = "outcome_unknown";
      await ok(of.as("post", "/supplier/billing/pay"), (body) => body, 202);
      await waitFor("the unknown", async () => (await attemptsOf(of)).at(-1)!.status === "unknown");
      const attempt = (await attemptsOf(of)).at(-1)!;
      expect(
        (
          await webhook({
            id: "evt-late",
            type: "payment",
            key: attempt.idempotency_key,
            status: "succeeded",
          })
        ).status,
      ).toBe(200);
      await waitStatus(of, "active");
      expect((await shown(offer)).visible).toBe(true);
      expect(await supplierRow(of)).toMatchObject({ status: "active", billing_paused_at: null });
    });

    it("takes a card named by the webhook, and keeps its token sealed", async () => {
      await addPlan(1_000);
      const of = await company("Карта вебхуком");
      const started = await ok(
        of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      const ref = new URL(started.redirectUrl, "http://x").searchParams.get("ref");
      const secret = "tok_test_ok_webhook1234";
      rememberSecret(secret);
      expect(
        (
          await webhook({
            id: "evt-card",
            type: "card_bound",
            ref,
            card: { token: secret, mask: "4242", brand: "visa", expMonth: 12, expYear: 2099 },
          })
        ).status,
      ).toBe(200);
      await waitFor(
        "the binding",
        async () => (await bindingStatus(of, started.binding.id)).status === "completed",
      );
      await waitStatus(of, "active");
      const { rows } = await db.query<{ text: string }>(
        `SELECT (SELECT string_agg(to_jsonb(e)::text, ' ') FROM payment_webhook_event e)
              || (SELECT string_agg(to_jsonb(b)::text, ' ') FROM card_binding b)
              || (SELECT string_agg(to_jsonb(m)::text, ' ') FROM payment_method m) AS text`,
      );
      expect(rows[0]!.text).not.toContain(secret);
    });
  });

  // ------------------------------------------------- TASK-042.A: the acceptance

  describe("what the acceptance found (TASK-042.A)", () => {
    /** Holds the worker's application of billing events until released: what races them goes first. */
    function holdEvents(): () => void {
      const handler = worker.get(BillingEventsApply);
      const original = handler.run.bind(handler);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      handler.run = async (payload, context) => {
        await gate;
        return original(payload, context);
      };
      return () => {
        open();
        handler.run = original;
      };
    }

    /**
     * What the queue would do with an attempt and a replaced card right now,
     * done here and awaited instead of waited for: whenever the worker takes
     * these jobs, they can do no more than this.
     */
    async function runQueuedJobs(attemptId: string, paymentMethodId: string): Promise<void> {
      await worker.get(RunAttemptHandler).run({ attemptId });
      await worker.get(DetachCardHandler).run({ paymentMethodId });
    }

    async function methodsOf(of: Company) {
      const { rows } = await db.query<{
        id: string;
        status: string;
        detached_at: Date | null;
      }>(
        "SELECT id, status, detached_at FROM payment_method WHERE supplier_id = $1 ORDER BY created_at",
        [of.supplierId],
      );
      return rows;
    }

    async function attemptRows(of: Company) {
      const { rows } = await db.query<{
        id: string;
        status: string;
        kind: string;
        period_key: string;
        payment_method_id: string | null;
        idempotency_key: string;
      }>(
        "SELECT id, status, kind, period_key, payment_method_id, idempotency_key FROM payment_attempt WHERE supplier_id = $1 ORDER BY created_at, attempt_no",
        [of.supplierId],
      );
      return rows;
    }

    async function noticeStatuses(of: Company) {
      const { rows } = await db.query<{ status: string }>(
        "SELECT status FROM outbound_message WHERE template IN ('payment_failed', 'payment_failed_last') AND phone = $1",
        [of.phone],
      );
      return rows.map((row) => row.status);
    }

    it("sends W-05 even when the sender takes it before the refusal's event is applied (defect 1)", async () => {
      await addPlan(1_000);
      const of = await subscribed("Гонка W-05");
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      const release = holdEvents();
      try {
        await chargeDay(of, "scheduled");
        const [decided] = await waitFor("the notice to be decided", async () => {
          const statuses = await noticeStatuses(of);
          return statuses.length === 1 && ["sent", "cancelled", "failed"].includes(statuses[0]!)
            ? statuses
            : null;
        });
        // The sender went first: the subscription did not yet know of the refusal.
        expect((await subOf(of))!.status).toBe("active");
        expect(decided).toBe("sent");
      } finally {
        release();
      }
      await waitStatus(of, "past_due");
      expect(await noticeStatuses(of)).toEqual(["sent"]);
    });

    it("pays a charge the provider could not take with the new card after «Сменить карту», and lets the old one go only then (defect 2)", async () => {
      await addPlan(1_000);
      const of = await subscribed("Смена карты");
      await atTermEnd(of);
      provider().mode = "unavailable";
      await chargeDay(of, "scheduled");
      const stuck = (await attemptRows(of)).at(-1)!;
      expect(stuck.status).toBe("unavailable");
      provider().mode = "ok";
      await changeCard(of, "ok");
      const [old, current] = await methodsOf(of);
      // The jobs had their chance: the hour has not come, so the charge is not
      // sent again, and the card a charge not over stands on is kept.
      await runQueuedJobs(stuck.id, old!.id);
      expect((await attemptRows(of)).find((row) => row.id === stuck.id)!.status).toBe(
        "unavailable",
      );
      expect((await methodsOf(of))[0]!.detached_at).toBeNull();
      expect(old).toMatchObject({ id: stuck.payment_method_id, status: "replaced" });
      expect(current).toMatchObject({ status: "active" });
      // The provider is back and the hour passes.
      await db.query(
        "UPDATE payment_attempt SET next_try_at = now() - interval '1 minute' WHERE id = $1",
        [stuck.id],
      );
      await worker.get(ResolvePaymentsHandler).run({} as never);
      const paid = await waitFor("the payment", async () =>
        (await attemptRows(of)).find(
          (row) => row.period_key === stuck.period_key && row.status === "succeeded",
        ),
      );
      // Paid by the new card, under a new key; the old attempt was never sent to the old card.
      expect(paid.payment_method_id).toBe(current!.id);
      expect(paid.idempotency_key).not.toBe(stuck.idempotency_key);
      expect((await attemptRows(of)).find((row) => row.id === stuck.id)!.status).toBe("cancelled");
      expect(
        provider().charges.filter((request) => request.idempotencyKey === stuck.idempotency_key),
      ).toHaveLength(1 /* the call that found the provider down */);
      await waitFor(
        "the term moved",
        async () => (await subOf(of))!.current_period_end.getTime() > Date.now(),
      );
      expect((await subOf(of))!.status).toBe("active");
      expect(await messagesOf(of)).toHaveLength(0);
      expect(await signalsOf("payment_failed")).toHaveLength(0);
      await waitFor(
        "the old card forgotten",
        async () => (await methodsOf(of))[0]!.detached_at !== null,
      );
    });

    it("forgets a replaced card while another card's detach waits on the queue (I846)", async () => {
      await addPlan(1_000);
      // A detach of some other card waiting its turn, as every detach was put
      // on the queue before I846 (and may still be at the release).
      await worker
        .get(JobQueue)
        .enqueue(
          detachCardJob,
          { paymentMethodId: randomUUID() },
          { startAfter: new Date(Date.now() + 3_600_000) },
        );
      const of = await subscribed("Чужая отвязка");
      await changeCard(of, "ok");
      await waitFor(
        "the replaced card forgotten",
        async () => (await methodsOf(of))[0]!.detached_at !== null,
      );
    });

    it("does not take a charge the provider could not take (or whose answer was lost) to it before its hour, whatever job runs", async () => {
      await addPlan(1_000);
      for (const mode of ["unavailable", "outcome_unknown"] as const) {
        const of = await subscribed(`Рано ${mode}`);
        await atTermEnd(of);
        provider().mode = mode;
        await chargeDay(of, "scheduled");
        provider().mode = "ok";
        const read = async () =>
          (
            await db.query<{ id: string; status: string; tries: number }>(
              "SELECT id, status, tries FROM payment_attempt WHERE supplier_id = $1 AND kind <> 'first'",
              [of.supplierId],
            )
          ).rows;
        const [waiting] = await read();
        expect(waiting!.status).toBe(mode === "unavailable" ? "unavailable" : "unknown");
        const calls = provider().charges.length;
        // The job of the attempt, and the daily retry, before `next_try_at`.
        await worker.get(RunAttemptHandler).run({ attemptId: waiting!.id });
        await worker.get(PaymentCharger).run(waiting!.id);
        await chargeDay(of, "scheduled");
        expect(provider().charges).toHaveLength(calls);
        expect(await read()).toEqual([waiting]);
        // The hour comes: the same job sends it.
        await db.query(
          "UPDATE payment_attempt SET next_try_at = now() - interval '1 minute' WHERE id = $1",
          [waiting!.id],
        );
        await worker.get(RunAttemptHandler).run({ attemptId: waiting!.id });
        // (`billing.resolve-attempts` of the worker may have taken it first: one of the two sends it.)
        const [paid] = await waitFor("the charge", async () => {
          const rows = await read();
          return rows[0]?.status === "succeeded" ? rows : null;
        });
        expect(paid).toMatchObject({ tries: waiting!.tries + 1 });
      }
    });

    it("pays «Оплатить сейчас» after «Сменить карту» with the new card at once", async () => {
      await addPlan(1_000);
      const of = await subscribed("Сменить и оплатить");
      await atTermEnd(of);
      provider().mode = "unavailable";
      await chargeDay(of, "scheduled");
      const stuck = (await attemptRows(of)).at(-1)!;
      expect(stuck.status).toBe("unavailable");
      provider().mode = "ok";
      await changeCard(of, "ok");
      const [old, current] = await methodsOf(of);
      // Before the press nothing is due: the queued jobs leave the old card's charge as it is.
      await runQueuedJobs(stuck.id, old!.id);
      expect(
        provider().charges.filter((c) => c.idempotencyKey === stuck.idempotency_key),
      ).toHaveLength(1);
      const charge = await ok(
        of.as("post", "/supplier/billing/pay"),
        (body) => payNowResponseSchema.parse(body).charge,
        202,
      );
      expect(charge.kind).toBe("manual");
      const paid = await waitFor("the payment", async () =>
        (await attemptRows(of)).find(
          (row) => row.period_key === stuck.period_key && row.status === "succeeded",
        ),
      );
      expect(
        paid.payment_method_id,
        JSON.stringify({ attempts: await attemptRows(of), methods: await methodsOf(of) }),
      ).toBe(current!.id);
      expect(await messagesOf(of)).toHaveLength(0);
    });

    it("only looks up an unknown charge after «Сменить карту», and keeps the old card until it is settled", async () => {
      await addPlan(1_000);
      const of = await subscribed("Неизвестно и карта");
      await atTermEnd(of);
      provider().mode = "outcome_unknown";
      await chargeDay(of, "scheduled");
      const lost = (await attemptRows(of)).at(-1)!;
      expect(lost.status).toBe("unknown");
      provider().mode = "ok";
      await changeCard(of, "ok");
      // The jobs had their chance: the card an open charge stands on is not let go.
      await runQueuedJobs(lost.id, (await methodsOf(of))[0]!.id);
      expect((await methodsOf(of))[0]).toMatchObject({ status: "replaced", detached_at: null });
      expect((await attemptRows(of)).find((row) => row.id === lost.id)!.status).toBe("unknown");
      const calls = provider().charges.length;
      await db.query(
        "UPDATE payment_attempt SET next_try_at = now() - interval '1 minute' WHERE id = $1",
        [lost.id],
      );
      await worker.get(ResolvePaymentsHandler).run({} as never);
      await waitFor(
        "the lookup",
        async () =>
          (await attemptRows(of)).find((row) => row.id === lost.id)!.status === "succeeded",
      );
      // Found by its key: nothing was sent, to either card.
      expect(provider().charges).toHaveLength(calls);
      await waitFor(
        "the old card forgotten",
        async () => (await methodsOf(of))[0]!.detached_at !== null,
      );
      expect(await messagesOf(of)).toHaveLength(0);
    });

    it("charges the first term once when the card is linked again before the subscription begins (defect 4)", async () => {
      await addPlan(1_000);
      const of = await company("Две привязки");
      const release = holdEvents();
      let secondBinding: string;
      try {
        const first = await bindAndWait(of, "ok");
        expect(first.status).toBe("completed");
        expect(await subOf(of)).toBeUndefined();
        const second = await bindAndWait(of, "ok");
        expect(second.status).toBe("completed");
        secondBinding = second.id;
        expect(provider().charges).toHaveLength(1);
        // The database itself takes no second first charge while the subscription is on its way.
        await expect(
          db.query(
            `INSERT INTO payment_attempt (supplier_id, binding_id, kind, period_key, attempt_no, idempotency_key,
               amount, period_from, period_to, anchor_day, status, provider, resolved_at)
             VALUES ($1, $2, 'first', $3, 1, $4, 1000, now(), now() + interval '30 days', 1, 'succeeded', 'test', now())`,
            [of.supplierId, secondBinding, `bind:${secondBinding}`, `k${randomUUID()}`],
          ),
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        release();
      }
      await waitStatus(of, "active");
      expect(provider().charges).toHaveLength(1);
      const { rows: refused } = await db.query(
        "SELECT 1 FROM billing_event WHERE supplier_id = $1 AND outcome = 'refused'",
        [of.supplierId],
      );
      expect(refused).toHaveLength(0);
      // The card of the second trip is the one the subscription is charged to.
      const methods = await methodsOf(of);
      expect(methods.filter((row) => row.status === "active")).toHaveLength(1);
      const { rows: active } = await db.query<{ binding_id: string }>(
        "SELECT binding_id FROM payment_method WHERE supplier_id = $1 AND status = 'active'",
        [of.supplierId],
      );
      expect(active[0]!.binding_id).toBe(secondBinding!);
    });

    it("promises tomorrow, not today, after a refusal of «Оплатить сейчас» before the daily hour (defect 5)", async () => {
      // The daily job runs later today (at 23:xx there is no later hour: the rule is the same).
      await settings.set({ billing_notify_hour: Math.min(almatyHourNow() + 1, 23) });
      await new TestSettings(app).reload();
      await addPlan(1_000);
      const of = await subscribed("Не сегодня");
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await ok(of.as("post", "/supplier/billing/pay"), (body) => body, 202);
      await waitStatus(of, "past_due");
      const [notice] = await waitFor("the notice", async () => {
        const notices = await messagesOf(of);
        return notices.length === 1 ? notices : null;
      });
      const tomorrow = dayText(new Date(Date.now() + DAY), "ru");
      expect(notice!.variables).toMatchObject({ date: tomorrow });
      await sleep(200);
      const view = await cabinet(of);
      expect(dayText(new Date(view.subscription!.nextChargeAt!), "ru")).toBe(tomorrow);
      // And the daily job keeps the promise: no second try today.
      const before = (await attemptRows(of)).length;
      await chargeDay(of, "retry");
      expect(await attemptRows(of)).toHaveLength(before);
    });

    it("forgets at the provider a card named for a trip that is over, and keeps the card of a trip that took it (defect 6)", async () => {
      await addPlan(1_000);
      const of = await company("Поздняя карта");
      const started = await ok(
        of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      const ref = new URL(started.redirectUrl, "http://x").searchParams.get("ref");
      // The page was left: the trip is over.
      await db.query(
        "UPDATE card_binding SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [started.binding.id],
      );
      await worker.get(ExpireBindingsHandler).run({} as never);
      expect((await bindingStatus(of, started.binding.id)).status).toBe("abandoned");
      const late = "tok_test_ok_late00000001";
      rememberSecret(late);
      const card = { mask: "4242", brand: "visa", expMonth: 12, expYear: 2099 };
      expect(
        (
          await webhook({
            id: "evt-late-card",
            type: "card_bound",
            ref,
            card: { ...card, token: late },
          })
        ).status,
      ).toBe(200);
      await waitFor("the late card forgotten", async () => provider().detached.includes(late));
      expect(provider().charges).toHaveLength(0);

      // A trip that took its card: the same card again is nothing; another card is let go.
      const other = await company("Повтор карты");
      const trip = await ok(
        other.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      const tripRef = new URL(trip.redirectUrl, "http://x").searchParams.get("ref");
      const kept = "tok_test_ok_kept00000001";
      const stray = "tok_test_ok_stray0000001";
      rememberSecret(kept);
      rememberSecret(stray);
      await webhook({
        id: "evt-kept-1",
        type: "card_bound",
        ref: tripRef,
        card: { ...card, token: kept },
      });
      await waitStatus(other, "active");
      await webhook({
        id: "evt-kept-2",
        type: "card_bound",
        ref: tripRef,
        card: { ...card, token: kept },
      });
      await webhook({
        id: "evt-stray",
        type: "card_bound",
        ref: tripRef,
        card: { ...card, token: stray },
      });
      await waitFor("the stray card forgotten", async () => provider().detached.includes(stray));
      await sleep(400);
      expect(provider().detached).not.toContain(kept);
      // No token is left behind in the deliveries.
      const { rows } = await db.query<{ text: string }>(
        "SELECT coalesce(string_agg(payload::text, ' '), '') AS text FROM payment_webhook_event",
      );
      expect(rows[0]!.text).not.toContain("tokenSealed");
    });

    it("keeps trying to forget a late card while the provider is away, and keeps only its sealed token meanwhile", async () => {
      await addPlan(1_000);
      const of = await company("Поздняя карта, провайдер ушёл");
      const started = await ok(
        of.as("post", "/supplier/billing/card-bindings", { returnUrl: `${CABINET}/billing` }),
        (body) => startCardBindingResponseSchema.parse(body),
        201,
      );
      const ref = new URL(started.redirectUrl, "http://x").searchParams.get("ref");
      await db.query(
        "UPDATE card_binding SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [started.binding.id],
      );
      await worker.get(ExpireBindingsHandler).run({} as never);
      const late = "tok_test_ok_away00000001";
      rememberSecret(late);
      provider().mode = "unavailable";
      await webhook({
        id: "evt-away-card",
        type: "card_bound",
        ref,
        card: { token: late, mask: "4242", brand: "visa", expMonth: 12, expYear: 2099 },
      });
      await waitFor("the detach to wait", async () => {
        const { rows } = await db.query<{ result: string | null }>(
          "SELECT result FROM payment_webhook_event WHERE provider_event_id = 'evt-away-card'",
        );
        return rows[0]?.result === "detach_pending";
      });
      expect(provider().detached).not.toContain(late);
      // The provider is back: the minute's resolver forgets the card and the token goes.
      provider().mode = "ok";
      await worker.get(ResolvePaymentsHandler).run({} as never);
      expect(provider().detached).toContain(late);
      const { rows } = await db.query<{ result: string; payload: string }>(
        "SELECT result, payload::text AS payload FROM payment_webhook_event WHERE provider_event_id = 'evt-away-card'",
      );
      expect(rows[0]!.result).toBe("card_detached");
      expect(rows[0]!.payload).not.toContain("tokenSealed");
    });

    it("hands a pre-billing «billing» pause of a company without a subscription to the administrator, reversibly (defect 7)", async () => {
      await addPlan(1_000);
      const bare = await company("Старая пауза");
      const paying = await subscribed("Пауза с подпиской");
      // As the migration of TASK-042 left them: a pause for «billing» set by hand before billing existed.
      // Down to just below the fixes of TASK-042.A (the migrations above them are counted, not guessed).
      // Asynchronously: the workers of this process must be able to finish their
      // transactions, or the migration's `DROP TABLE` waits for their locks forever.
      await runMigrateAsync(
        "down",
        postgres.getConnectionUri(),
        MIGRATIONS_DOWN_TO_BELOW_BILLING_FIXES,
      );
      try {
        await db.query(
          "UPDATE supplier SET billing_paused_at = now() - interval '10 days', status = 'paused' WHERE id = ANY($1)",
          [[bare.supplierId, paying.supplierId]],
        );
      } finally {
        await runMigrateAsync("up", postgres.getConnectionUri());
      }
      expect(await supplierRow(bare)).toMatchObject({ status: "paused", billing_paused_at: null });
      expect((await supplierRow(bare)).admin_paused_at).not.toBeNull();
      // The company with a subscription keeps its billing pause: its subscription lifts it.
      expect((await supplierRow(paying)).billing_paused_at).not.toBeNull();
      expect((await supplierRow(paying)).admin_paused_at).toBeNull();
      // Reversible: down gives the pause back to billing, up hands it over again.
      // Down to just below the fixes of TASK-042.A (the migrations above them are counted, not guessed).
      // Asynchronously: the workers of this process must be able to finish their
      // transactions, or the migration's `DROP TABLE` waits for their locks forever.
      await runMigrateAsync(
        "down",
        postgres.getConnectionUri(),
        MIGRATIONS_DOWN_TO_BELOW_BILLING_FIXES,
      );
      try {
        expect((await supplierRow(bare)).billing_paused_at).not.toBeNull();
        expect((await supplierRow(bare)).admin_paused_at).toBeNull();
      } finally {
        await runMigrateAsync("up", postgres.getConnectionUri());
      }
      // Now somebody can lift it: the administrator.
      const card = (
        await ok(asAdmin("get", `/admin/suppliers/${bare.supplierId}`), (body) =>
          adminSupplierResponseSchema.parse(body),
        )
      ).supplier;
      expect(card.pauses.admin).not.toBeNull();
      expect(
        (
          await asAdmin("post", `/admin/suppliers/${bare.supplierId}/pause`, {
            expectedVersion: card.version,
            paused: false,
            note: "Оплата по договору",
          })
        ).status,
      ).toBe(200);
      expect(await supplierRow(bare)).toMatchObject({
        status: "active",
        admin_paused_at: null,
        billing_paused_at: null,
      });
    });
  });

  // ------------------------------------------- who may call, and the secret

  describe("access and secrecy", () => {
    it("opens the cabinet's routes to the cabinet alone and the admin's block to the admin alone", async () => {
      await addPlan(1_000);
      const of = await subscribed("Доступ");
      const user = await customerWithAccess();
      const cabinetRoutes: [Method, string][] = [
        ["get", "/supplier/subscription"],
        ["get", "/supplier/billing/charges"],
        ["post", "/supplier/billing/pay"],
        ["post", "/supplier/billing/card-bindings"],
      ];
      for (const [method, path] of cabinetRoutes) {
        const body = path.endsWith("card-bindings")
          ? { returnUrl: `${CABINET}/billing` }
          : undefined;
        expectError(await call(null, SUPPLIER_WEB, method, path, body), 401, "AUTH_REQUIRED");
        expect((await user.as(method, path, body)).status, `${method} ${path}`).toBe(403);
        expect((await asAdmin(method, path, body)).status, `${method} ${path}`).toBe(403);
      }
      const adminPath = `/admin/suppliers/${of.supplierId}/billing`;
      expectError(await call(null, ADMIN_WEB, "get", adminPath), 401, "AUTH_REQUIRED");
      expect((await of.as("get", adminPath)).status).toBe(403);
      expect((await user.as("get", adminPath)).status).toBe(403);
      expect((await asAdmin("get", adminPath)).status).toBe(200);
      expectError(
        await asAdmin("get", `/admin/suppliers/${randomUUID()}/billing`),
        404,
        "NOT_FOUND",
      );
      // Paying with nothing owed or without a card.
      expectError(await of.as("post", "/supplier/billing/pay"), 409, "BILLING_NOTHING_TO_PAY");
      const bare = await company("Без карты");
      expectError(await bare.as("post", "/supplier/billing/pay"), 409, "BILLING_NOTHING_TO_PAY");
      expect((await of.as("get", "/supplier/billing/charges?cursor=garbage")).status).toBe(400);
    });

    it("keeps the card's token out of every answer, the journal, the events, the signals and the log", async () => {
      await addPlan(1_000);
      const of = await subscribed("Секрет");
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitStatus(of, "past_due");
      const tokens = provider().charges.map((request) => request.token);
      expect(tokens.length).toBeGreaterThanOrEqual(2);
      for (const secret of tokens) {
        rememberSecret(secret);
        expect(secret.startsWith("tok_test_")).toBe(true);
      }
      const answers = JSON.stringify([
        await cabinet(of),
        await ok(of.as("get", "/supplier/billing/charges"), (body) => body),
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}/billing`), (body) => body),
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}`), (body) => body),
        await ok(asAdmin("get", "/admin/audit-log?limit=100"), (body) => body),
        await ok(asAdmin("get", "/admin/signals?status=current"), (body) => body),
      ]);
      const { rows } = await db.query<{ text: string }>(
        `SELECT coalesce((SELECT string_agg(to_jsonb(x)::text, ' ') FROM audit_log x), '')
              || coalesce((SELECT string_agg(to_jsonb(x)::text, ' ') FROM billing_event x), '')
              || coalesce((SELECT string_agg(to_jsonb(x)::text, ' ') FROM admin_signal x), '')
              || coalesce((SELECT string_agg(to_jsonb(x)::text, ' ') FROM outbound_message x), '')
              || coalesce((SELECT string_agg(to_jsonb(x)::text, ' ') FROM payment_attempt x), '')
              || coalesce((SELECT string_agg(token_sealed, ' ') FROM payment_method), '') AS text`,
      );
      for (const secret of tokens) {
        expect(answers).not.toContain(secret);
        expect(rows[0]!.text).not.toContain(secret);
      }
      // The sealed token opens with the key and is bound to its row.
      const { rows: methods } = await db.query<{ id: string; token_sealed: string }>(
        "SELECT id, token_sealed FROM payment_method WHERE status = 'active' AND supplier_id = $1",
        [of.supplierId],
      );
      const vault = worker.get(PaymentTokenVault);
      expect(vault.open(tokenContext.paymentMethod(methods[0]!.id), methods[0]!.token_sealed)).toBe(
        tokens.at(-1),
      );
      expect(() =>
        vault.open(tokenContext.paymentMethod(randomUUID()), methods[0]!.token_sealed),
      ).toThrow();
    });

    it("shows the administrator the card as a mask, the charges and both pauses, and the journal says who did what", async () => {
      await addPlan(1_000);
      const of = await subscribed("Админ видит");
      await changeCard(of, "insufficient_funds");
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      await waitStatus(of, "past_due");
      const view = await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}/billing`), (body) =>
        adminSupplierBillingResponseSchema.parse(body),
      );
      expect(view.subscription).toMatchObject({
        status: "past_due",
        lastDecline: { reason: "insufficient_funds" },
      });
      expect(view.card).toMatchObject({ mask: "9995" });
      expect(view.charges.map((row) => [row.kind, row.outcome])).toEqual([
        ["scheduled", "declined"],
        ["first", "succeeded"],
      ]);
      expect(view.history.map((row) => row.kind)).toEqual(
        expect.arrayContaining(["started", "payment_failed"]),
      );
      const entries = await ok(
        asAdmin("get", `/admin/audit-log?entityType=supplier&entityId=${of.supplierId}&limit=50`),
        (body) => body as { entries: { action: string }[] },
      );
      expect(entries.entries.map((entry) => entry.action)).toContain("supplier.card_changed");
    });
  });

  // ------------------------------------- «Биллинг» of the admin panel (TASK-043)

  describe("«Биллинг» of the admin panel (TASK-043)", () => {
    async function pause(of: Company): Promise<void> {
      const card = (
        await ok(asAdmin("get", `/admin/suppliers/${of.supplierId}`), (body) =>
          adminSupplierResponseSchema.parse(body),
        )
      ).supplier;
      const paused = await asAdmin("post", `/admin/suppliers/${of.supplierId}/pause`, {
        expectedVersion: card.version,
        paused: true,
        reason: "admin",
        note: "Проверка документов",
      });
      expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    }

    /** Every row of a list, page by page, each once. */
    async function walk<T>(
      path: string,
      query: Record<string, string>,
      rowsOf: (body: unknown) => { rows: T[]; total: number; nextCursor: string | null },
    ): Promise<{ rows: T[]; total: number }> {
      const rows: T[] = [];
      let cursor: string | null = null;
      let total: number;
      do {
        const params: URLSearchParams = new URLSearchParams({
          ...query,
          limit: "2",
          ...(cursor ? { cursor } : {}),
        });
        const page: { rows: T[]; total: number; nextCursor: string | null } = await ok(
          asAdmin("get", `${path}?${params.toString()}`),
          rowsOf,
        );
        total = page.total;
        rows.push(...page.rows);
        cursor = page.nextCursor;
      } while (cursor);
      return { rows, total };
    }

    const suppliersOf = (query: Record<string, string>) =>
      walk("/admin/billing/suppliers", query, (body) => {
        const page = adminBillingSupplierPageSchema.parse(body);
        return { rows: page.suppliers, total: page.total, nextCursor: page.nextCursor };
      });
    const chargesOf = (query: Record<string, string>) =>
      walk("/admin/billing/charges", query, (body) => {
        const page = adminChargePageSchema.parse(body);
        return { rows: page.charges, total: page.total, nextCursor: page.nextCursor };
      });

    it("puts every supplier in exactly one group, counts the summary with the lists, and promises what W-05 promised (AC-1, AC-2, AC-3)", async () => {
      await addPlan(1_000);
      const paid = await subscribed("Оплачено");
      // The second day of the retries: two refusals of the bank.
      const declined = await subscribed("Отказ банка");
      await changeCard(declined, "insufficient_funds");
      await atTermEnd(declined);
      await chargeDay(declined, "scheduled");
      await waitStatus(declined, "past_due");
      await aDayPasses(declined);
      await chargeDay(declined, "retry");
      await waitFor("two refusals", async () =>
        (await attemptsOf(declined)).filter((row) => row.status === "declined").length === 2
          ? true
          : null,
      );
      // On the billing pause and on the administrator's at once.
      const paused = await subscribed("Пауза");
      await pause(paused);
      await changeCard(paused, "insufficient_funds");
      await atTermEnd(paused);
      await chargeDay(paused, "scheduled");
      await waitStatus(paused, "past_due");
      await db.query(
        "UPDATE subscription SET grace_until = now() - interval '1 minute' WHERE supplier_id = $1",
        [paused.supplierId],
      );
      await expireUntil(paused, "suspended");
      expect(await supplierRow(paused)).toMatchObject({
        admin_paused_at: expect.any(Date),
        billing_paused_at: expect.any(Date),
      });
      // A charge the payment system could not take: no failure of the payer.
      const waiting = await subscribed("Ждёт платёжную систему");
      await atTermEnd(waiting);
      provider().mode = "unavailable";
      await chargeDay(waiting, "scheduled");
      provider().mode = "ok";
      // No card, no subscription; and the administrator's pause alone is not billing's.
      const none = await company("Без подписки");
      const adminOnly = await company("Пауза администратора");
      await pause(adminOnly);

      const summary = await ok(asAdmin("get", "/admin/billing/summary"), (body) =>
        adminBillingSummarySchema.parse(body),
      );
      expect(summary.suppliers).toEqual({
        paid: 1,
        declined: 1,
        awaitingProvider: 1,
        paused: 1,
        none: 2,
      });
      const groups = {
        paid: [paid],
        declined: [declined],
        awaiting_provider: [waiting],
        paused: [paused],
        none: [none, adminOnly],
      };
      const seen: string[] = [];
      for (const [group, members] of Object.entries(groups)) {
        const list = await suppliersOf({ groups: group });
        const number =
          summary.suppliers[group === "awaiting_provider" ? "awaitingProvider" : (group as "paid")];
        expect({ group, total: list.total, rows: list.rows.length }).toEqual({
          group,
          total: number,
          rows: number,
        });
        expect(new Set(list.rows.map((row) => row.supplierId))).toEqual(
          new Set(members.map((of) => of.supplierId)),
        );
        expect(list.rows.every((row) => row.group === group)).toBe(true);
        seen.push(...list.rows.map((row) => row.supplierId));
      }
      // Exactly one group each: every supplier of the database, none twice.
      const { rows: everyone } = await db.query<{ id: string }>("SELECT id FROM supplier");
      expect(seen.sort()).toEqual(everyone.map((row) => row.id).sort());

      // «Неуспешные»: the refusals, the waiting and the pauses, nearest pause first.
      const failed = await suppliersOf({});
      expect(failed.rows.map((row) => row.supplierId)).toEqual([
        declined.supplierId,
        waiting.supplierId,
        paused.supplierId,
      ]);
      const [refused, slow, stopped] = failed.rows;
      const hour = 10;
      const sub = (await subOf(declined))!;
      expect(refused).toMatchObject({
        declines: 2,
        lastDecline: { reason: "insufficient_funds", amount: 1_000 },
        cardMask: "9995",
        pauseAt: sub.grace_until!.toISOString(),
        waiting: null,
      });
      // The retry and the pause are the cabinet's and W-05's: one rule (I851).
      const shownToCompany = await cabinet(declined);
      expect(refused!.nextRetryAt).toBe(shownToCompany.subscription!.nextChargeAt);
      const promised = nextBankRetry(new Date(refused!.lastDecline!.at), hour).at;
      expect(refused!.nextRetryAt).toBe(
        promised.getTime() < sub.grace_until!.getTime() ? promised.toISOString() : null,
      );
      expect(refused!.daysToPause).toBe(daysUntilPause(sub.grace_until!, new Date()));
      const notice = (await messagesOf(declined)).at(-1)!;
      expect(notice.template).toBe("payment_failed");
      expect(notice.variables?.date).toBe(dayText(promised, "ru"));
      expect(slow).toMatchObject({
        group: "awaiting_provider",
        waiting: { status: "unavailable", amount: 1_000 },
        nextRetryAt: null,
      });
      expect(stopped).toMatchObject({
        group: "paused",
        adminPaused: true,
        pausedSince: expect.any(String),
        nextRetryAt: null,
        daysToPause: null,
        lastDecline: { reason: "insufficient_funds" },
      });

      // The home screen: «Платежи поставщиков не прошли · N» is that list's total.
      const home = await ok(asAdmin("get", "/admin/home"), (body) => body as AdminHome);
      const unpaid = await suppliersOf({ groups: "declined,paused" });
      expect(home.supplierPaymentsFailed).toBe(unpaid.total);
      expect(unpaid.total).toBe(2);

      // «История списаний»: the summary's numbers are the history's totals of the period.
      const period = { from: summary.period.from, to: summary.period.to };
      const succeeded = await chargesOf({ ...period, status: "succeeded" });
      expect(succeeded.total).toBe(summary.charges.succeeded.count);
      expect(succeeded.rows.reduce((sum, row) => sum + row.amount, 0)).toBe(
        summary.charges.succeeded.amount,
      );
      const refusals = await chargesOf({ ...period, status: "declined" });
      expect(refusals.total).toBe(summary.charges.declined.count);
      expect(refusals.total).toBe(3);
      const all = await chargesOf({});
      expect(all.total).toBe(all.rows.length);
      expect(new Set(all.rows.map((row) => row.id)).size).toBe(all.rows.length);
      expect(all.rows.map((row) => row.at)).toEqual(
        [...all.rows.map((row) => row.at)].sort().reverse(),
      );
      const ofDeclined = await chargesOf({ supplierId: declined.supplierId });
      expect(ofDeclined.rows.map((row) => [row.kind, row.status])).toEqual([
        ["retry", "declined"],
        ["scheduled", "declined"],
        ["first", "succeeded"],
      ]);
      expect(ofDeclined.rows[0]).toMatchObject({
        supplier: { id: declined.supplierId, name: "Отказ банка" },
        declineReason: "insufficient_funds",
        cardMask: "9995",
      });
      expect(
        (await chargesOf({ status: "unavailable" })).rows.map((row) => row.supplier.id),
      ).toEqual([waiting.supplierId]);
      expect((await chargesOf({ kind: "first,retry" })).total).toBe(
        all.rows.filter((row) => row.kind === "first" || row.kind === "retry").length,
      );
      // «Оплатить сейчас»: who pressed it.
      await changeCard(declined, "ok");
      await ok(
        declined.as("post", "/supplier/billing/pay"),
        (body) => payNowResponseSchema.parse(body),
        202,
      );
      const manual = await waitFor("the manual charge", async () => {
        const rows = (await chargesOf({ kind: "manual" })).rows;
        return rows.length === 1 ? rows[0]! : null;
      });
      expect(manual.requestedBy).toEqual({ memberId: declined.memberId, name: "Ерлан" });

      // The card's token is nowhere: only the mask goes out.
      const { rows: tokens } = await db.query<{ token_sealed: string }>(
        "SELECT token_sealed FROM payment_method",
      );
      const answers = JSON.stringify([
        await ok(asAdmin("get", "/admin/billing/charges?limit=100"), (body) => body),
        await ok(
          asAdmin(
            "get",
            "/admin/billing/suppliers?groups=paid,declined,awaiting_provider,paused,none&limit=100",
          ),
          (body) => body,
        ),
      ]);
      for (const { token_sealed: sealed } of tokens) {
        expect(answers).not.toContain(sealed);
      }
      expect(answers).not.toMatch(/token/i);
      // The cabinet's employees are not let in.
      for (const path of [
        "/admin/billing/summary",
        "/admin/billing/suppliers",
        "/admin/billing/charges",
      ]) {
        expectError(await paid.as("get", path), 403, "FORBIDDEN");
      }
    });

    it("plans and cancels a tariff by the rules, one record when two administrators race, the operator through the same service (AC-4)", async () => {
      await addPlan(1_000);
      const of = await subscribed("Тариф");
      const plans = async () =>
        ok(asAdmin("get", "/admin/billing/plans"), (body) => adminBillingPlansSchema.parse(body));
      const plan = (body: object) => asAdmin("post", "/admin/billing/plans", body);
      const first = await plans();
      expect(first.supplier.inEffect).toMatchObject({
        price: 1_000,
        state: "in_effect",
        createdByRole: "operator",
      });
      const now = new Date();
      const tomorrow = earliestPlanStart({ now, announceBeforeDays: 0, rise: false });
      expect(first.earliestStart).toBe(tomorrow);

      const fieldOf = (response: Response) =>
        (response.body as { details: { path: string; earliest?: string }[] }).details[0]!;
      // A rise sooner than its notice: refused at the date, with the nearest day allowed.
      const rise = earliestPlanStart({ now, announceBeforeDays: 7, rise: true });
      const early = await plan({
        price: 3_000,
        startsOn: tomorrow,
        announceBeforeDays: 7,
        reason: "Повышение",
        expectedVersion: first.version,
      });
      expectError(early, 400, "VALIDATION_ERROR");
      expect(fieldOf(early)).toMatchObject({ path: "startsOn", earliest: rise });
      // Today and a day gone: refused.
      const today = first.today;
      for (const startsOn of [today, "2020-01-01"]) {
        const refused = await plan({
          price: 900,
          startsOn,
          announceBeforeDays: 3,
          reason: "Понижение",
          expectedVersion: first.version,
        });
        expectError(refused, 400, "VALIDATION_ERROR");
        expect(fieldOf(refused).path).toBe("startsOn");
      }
      // A rise is announced at least a day ahead.
      const silent = await plan({
        price: 3_000,
        startsOn: rise,
        announceBeforeDays: 0,
        reason: "Повышение",
        expectedVersion: first.version,
      });
      expectError(silent, 400, "VALIDATION_ERROR");
      expect(fieldOf(silent).path).toBe("announceBeforeDays");

      // The rise on the earliest day: the cabinet shows it at once (its notice window is open).
      const planned = await ok(
        plan({
          price: 3_000,
          startsOn: rise,
          announceBeforeDays: 7,
          reason: "Повышение",
          expectedVersion: first.version,
        }),
        (body) => adminBillingPlansSchema.parse(body),
      );
      expect(planned.version).toBe(first.version + 1);
      // On the earliest day the notice opens exactly N days ahead — not yet, the cabinet is silent.
      const rising = planned.supplier.records.find((row) => row.reason === "Повышение")!;
      expect(rising).toMatchObject({ price: 3_000, state: "scheduled", createdByRole: "admin" });
      expect(new Date(rising.announceFrom).getTime()).toBeGreaterThanOrEqual(now.getTime());
      expect((await cabinet(of)).announcedPlan).toBeNull();
      // A day passes (the start comes a day nearer): the cabinet shows «С {дата} тариф — {цена}».
      await db.query("UPDATE plan SET valid_from = valid_from - interval '1 day' WHERE id = $1", [
        rising.id,
      ]);
      const announced = (await plans()).supplier.announced!;
      expect(announced).toMatchObject({ id: rising.id, price: 3_000, state: "announced" });
      expect((await cabinet(of)).announcedPlan).toMatchObject({
        price: 3_000,
        validFrom: announced.validFrom,
      });
      // A farther one is planned, not announced yet: the cabinet keeps the nearest.
      const later = new Date(`${rise}T00:00:00Z`);
      later.setUTCDate(later.getUTCDate() + 40);
      const laterDay = later.toISOString().slice(0, 10);
      const second = await ok(
        plan({
          price: 5_000,
          startsOn: laterDay,
          announceBeforeDays: 3,
          reason: "Ещё",
          expectedVersion: planned.version,
        }),
        (body) => adminBillingPlansSchema.parse(body),
      );
      expect(second.supplier.records.find((row) => row.price === 5_000)?.state).toBe("scheduled");
      // The same day twice: refused at the field; a stale version: refused as a conflict.
      const twice = await plan({
        price: 6_000,
        startsOn: laterDay,
        announceBeforeDays: 3,
        reason: "Дубль",
        expectedVersion: second.version,
      });
      expectError(twice, 400, "VALIDATION_ERROR");
      expect(fieldOf(twice).path).toBe("startsOn");
      expectError(
        await plan({
          price: 6_000,
          startsOn: laterDay,
          announceBeforeDays: 3,
          reason: "Устарело",
          expectedVersion: planned.version,
        }),
        409,
        "PLAN_VERSION_CONFLICT",
      );

      // Two administrators at once with the same version: one record.
      const other = new Date(later);
      other.setUTCDate(other.getUTCDate() + 10);
      const raced = await Promise.all(
        [0, 1].map((offset) => {
          const day = new Date(other);
          day.setUTCDate(day.getUTCDate() + offset);
          return plan({
            price: 7_000,
            startsOn: day.toISOString().slice(0, 10),
            announceBeforeDays: 3,
            reason: "Гонка",
            expectedVersion: second.version,
          });
        }),
      );
      expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
      const afterRace = await plans();
      expect(afterRace.supplier.records.filter((row) => row.price === 7_000)).toHaveLength(1);

      // The operator command goes through the same service: the page's version is stale then.
      await addPlan(8_000, 200 * DAY);
      const afterOperator = await plans();
      expect(afterOperator.version).toBe(afterRace.version + 1);
      expectError(
        await asAdmin("post", `/admin/billing/plans/${announced.id}/cancel`, {
          reason: "Отмена",
          expectedVersion: afterRace.version,
        }),
        409,
        "PLAN_VERSION_CONFLICT",
      );

      // Cancelling the announced rise: the record stays, marked; the notice leaves the cabinet.
      const cancelled = await ok(
        asAdmin("post", `/admin/billing/plans/${announced.id}/cancel`, {
          reason: "Передумали",
          expectedVersion: afterOperator.version,
        }),
        (body) => adminBillingPlansSchema.parse(body),
      );
      expect(cancelled.supplier.records.find((row) => row.id === announced.id)).toMatchObject({
        state: "cancelled",
        cancelled: { byRole: "admin", reason: "Передумали" },
      });
      expect(cancelled.supplier.announced).toBeNull();
      expect((await cabinet(of)).announcedPlan).toBeNull();
      // Only what has not started: the tariff in effect and a cancelled one are refused.
      for (const id of [first.supplier.inEffect!.id, announced.id]) {
        expectError(
          await asAdmin("post", `/admin/billing/plans/${id}/cancel`, {
            reason: "Нельзя",
            expectedVersion: cancelled.version,
          }),
          409,
          "PLAN_NOT_CANCELLABLE",
        );
      }
      // The day freed by the cancellation can be planned again.
      const again = await ok(
        plan({
          price: 3_000,
          startsOn: rise,
          announceBeforeDays: 7,
          reason: "Снова",
          expectedVersion: cancelled.version,
        }),
        (body) => adminBillingPlansSchema.parse(body),
      );
      const replanned = again.supplier.records.find((row) => row.reason === "Снова")!;
      expect(replanned.price).toBe(3_000);

      // The journal: who, what and why.
      const { rows: journal } = await db.query<{
        action: string;
        actor_role: string;
        reason: string;
      }>(
        "SELECT action, actor_role, reason FROM audit_log WHERE entity_type = 'plan' ORDER BY created_at, id",
      );
      expect(
        journal.filter((row) => row.actor_role === "admin").map((row) => [row.action, row.reason]),
      ).toEqual([
        ["plan.added", "Повышение"],
        ["plan.added", "Ещё"],
        ["plan.added", "Гонка"],
        ["plan.cancelled", "Передумали"],
        ["plan.added", "Снова"],
      ]);

      // Time passes to the start: the next term is charged by the new price.
      await db.query("UPDATE plan SET valid_from = now() - interval '1 minute' WHERE id = $1", [
        replanned.id,
      ]);
      await atTermEnd(of);
      await chargeDay(of, "scheduled");
      const last = await waitFor("the charge", async () => {
        const row = (await attemptsOf(of)).at(-1)!;
        return row.kind === "scheduled" && row.status === "succeeded" ? row : null;
      });
      expect(last.amount).toBe(3_000);
      expect((await cabinet(of)).plan).toMatchObject({ price: 3_000 });
    });
  });

  // -------------------------------------------------------------- helpers

  interface Customer {
    phone: string;
    accountId: string;
    as: As;
  }

  /** A user of the club: a subscription of the test provider gives the access. */
  async function customerWithAccess(): Promise<Customer> {
    const phone = `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM account WHERE phone = $1", [
      phone,
    ]);
    await app.get(BillingOperator).testEvent({
      phone,
      kind: "started",
      periodEnd: new Date(Date.now() + 30 * DAY),
    });
    await waitFor("the user's access", async () => {
      const { rows: subs } = await db.query("SELECT 1 FROM subscription WHERE account_id = $1", [
        rows[0]!.id,
      ]);
      return subs.length > 0;
    });
    return {
      phone,
      accountId: rows[0]!.id,
      as: (method, path, body) => call(bearer, IOS, method, path, body),
    };
  }

  async function placed(who: Customer, offer: SupplierOffer): Promise<UserOrder> {
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
});
