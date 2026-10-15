import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  adminUserPageSchema,
  adminUserSubscriptionResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  mySubscriptionResponseSchema,
  offerPageSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierSubscriptionResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
  type UserOrder,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { sql } from "drizzle-orm";
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
import { SweepRunner, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { ClubAccess, clubAccessUntil } from "../club-access";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { offer as offerTable, offerShowcase, shownOffers } from "../offers";
import { BillingOperator, type TestEventCommand } from "./billing-operator";
import { expireSubscriptionsJob } from "./billing-jobs";
import { Plans } from "./plans.service";
import { SupplierCards } from "./supplier-cards";
import { SubscriptionEvents, SubscriptionExpiry } from "./subscription-events";
import { TestSubscriptionProvider } from "./subscription-provider";

/**
 * TASK-040 on a real PostgreSQL and Redis with the API and a worker: the
 * events of the test provider through `billing_event` (a duplicate, the
 * order of events, a renewal twice and before the expiry it follows, a
 * refund, a purchase of another account, another subscription in force),
 * time's events (unconfirmed with access for the tolerance, then expired; a
 * late renewal restores), the journal; club access from two sources — the
 * function and its SQL twin on the same data, and every consumer the same
 * for a subscription without a grant (orders, «Повторить», the catalog's
 * supplier, reviews, the supplier's page, the admin list's filter), orders
 * and codes kept after the end; `GET /me/subscription` with the tariff and
 * its announced change, other sessions refused; tariffs by the operator;
 * D-041 — the rule and its SQL twin, the switch off changes nothing, on —
 * hidden without a card, shown with one, the reason in the cabinet and the
 * admin panel; the subscription in the admin card.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const HOUR = 3_600_000;
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

describe("subscriptions (PostgreSQL + Redis + worker)", () => {
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
      order_create_per_account: 1000,
      catalog_read_per_ip: 10_000,
      catalog_read_per_account: 10_000,
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

  // ---------------------------------------------------------------- world

  type As = (method: Method, path: string, body?: object) => Test;

  interface Company {
    supplierId: string;
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
    return {
      supplierId: created.supplier.id,
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
    as: As;
  }

  async function customer(): Promise<Customer> {
    const phone = `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM account WHERE phone = $1", [
      phone,
    ]);
    return {
      phone,
      accountId: rows[0]!.id,
      as: (method, path, body) => call(bearer, IOS, method, path, body),
    };
  }

  function place(who: Customer, offer: SupplierOffer) {
    return who.as("post", "/orders", {
      offerId: offer.id,
      quantity: 1,
      fulfillment: "pickup",
      expectedPrice: offer.price,
      idempotencyKey: randomUUID(),
      allowAnotherActive: true,
    });
  }

  async function placed(who: Customer, offer: SupplierOffer): Promise<UserOrder> {
    return ok(
      place(who, offer),
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

  /** The test provider's event, entered as the operator command does; waits until the worker applied it. */
  async function event(
    who: Customer,
    kind: string,
    extra: Omit<TestEventCommand, "phone" | "kind"> = {},
  ): Promise<{ eventId: string; duplicate: boolean; outcome: string; detail: string | null }> {
    const received = await app.get(BillingOperator).testEvent({ phone: who.phone, kind, ...extra });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await db.query<{ outcome: string; detail: string | null }>(
        "SELECT outcome, detail FROM billing_event WHERE id = $1",
        [received.eventId],
      );
      if (rows[0] && rows[0].outcome !== "pending") {
        return { ...received, outcome: rows[0].outcome, detail: rows[0].detail };
      }
      if (Date.now() > deadline) throw new Error(`Event ${received.eventId} never applied`);
      await sleep(150);
    }
  }

  interface SubscriptionFacts {
    id: string;
    status: string;
    current_period_end: Date;
    unconfirmed_since: Date | null;
    provider_ref: string;
  }

  async function subscriptionOf(who: Customer): Promise<SubscriptionFacts | undefined> {
    const { rows } = await db.query<SubscriptionFacts>(
      "SELECT id, status, current_period_end, unconfirmed_since, provider_ref FROM subscription WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [who.accountId],
    );
    return rows[0];
  }

  /** The sweeper of time's events, one run. */
  async function expireRun() {
    return new SweepRunner(worker.get(DatabaseService)).run(
      expireSubscriptionsJob,
      worker.get(SubscriptionExpiry),
      { signal: new AbortController().signal },
    );
  }

  async function mine(who: Customer) {
    return ok(who.as("get", "/me/subscription"), (body) =>
      mySubscriptionResponseSchema.parse(body),
    );
  }

  // ------------------------------------------------------------- events

  describe("the events of a provider (AC-3)", () => {
    it("applies a purchase once, by its id; a renewal twice and an older event are no effect; a refund ends it now", async () => {
      const who = await customer();
      const started = await event(who, "started", {
        periodEnd: new Date(Date.now() + 30 * DAY),
        eventId: "e-1",
      });
      expect(started).toMatchObject({ duplicate: false, outcome: "applied" });
      const first = await subscriptionOf(who);
      expect(first).toMatchObject({ status: "active" });
      expect((await mine(who)).access).toMatchObject({ granted: true, source: "subscription" });

      // The same id again: no new row, no job, the same subscription.
      const again = await app.get(BillingOperator).testEvent({
        phone: who.phone,
        kind: "started",
        periodEnd: new Date(Date.now() + 90 * DAY),
        eventId: "e-1",
      });
      expect(again).toMatchObject({ duplicate: true, eventId: started.eventId });
      const { rows: count } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM billing_event",
      );
      expect(count[0]!.n).toBe(1);

      // A renewal to +60 days, then the same renewal again: the second changes nothing.
      const end = new Date(Date.now() + 60 * DAY);
      expect(await event(who, "renewed", { periodEnd: end })).toMatchObject({ outcome: "applied" });
      expect(await event(who, "renewed", { periodEnd: end })).toMatchObject({
        outcome: "no_effect",
        detail: "no_change",
      });
      // An expiry that happened before the renewal arrives late: no effect, no rollback.
      expect(await event(who, "expired", { at: new Date(Date.now() - HOUR) })).toMatchObject({
        outcome: "no_effect",
        detail: "stale",
      });
      const renewed = await subscriptionOf(who);
      expect(renewed).toMatchObject({ status: "active", current_period_end: end });

      // A refund ends it at once.
      expect(await event(who, "refunded")).toMatchObject({ outcome: "applied" });
      expect(await subscriptionOf(who)).toMatchObject({ status: "expired" });
      const now = await mine(who);
      expect(now.subscription).toBeNull();
      expect(now.access).toEqual({ granted: false, source: null, validUntil: null });

      // Every change is in the journal, by the operator (the test provider), with whose.
      const { rows: journal } = await db.query<{
        actor_role: string;
        after: Record<string, unknown>;
      }>(
        "SELECT actor_role, after FROM audit_log WHERE action = 'subscription.changed' ORDER BY created_at",
      );
      expect(journal.map((row) => row.after.status)).toEqual(["active", "active", "expired"]);
      for (const row of journal) {
        expect(row.actor_role).toBe("operator");
        expect(row.after).toMatchObject({ changedBy: "operator", accountId: who.accountId });
      }
    });

    it("applies the pending events of one purchase in the order of their time", async () => {
      const who = await customer();
      await event(who, "started", { periodEnd: new Date(Date.now() + 30 * DAY) });
      const ref = (await subscriptionOf(who))!.provider_ref;
      // Two events pending at once, the later one received first (no job: the
      // run below is the one that applies them).
      const later = new Date(Date.now() + 2000);
      const earlier = new Date(Date.now() + 1000);
      const { rows: inserted } = await db.query<{ id: string; kind: string }>(
        `INSERT INTO billing_event (provider, provider_event_id, source, kind, provider_ref, account_id, event_at, received_at)
         VALUES ('test', 'later', 'operator', 'cancel_withdrawn', $1, $2, $3, now() - interval '2 seconds'),
                ('test', 'earlier', 'operator', 'cancelled', $1, $2, $4, now() - interval '1 second')
         RETURNING id, kind`,
        [ref, who.accountId, later, earlier],
      );
      expect(inserted).toHaveLength(2);
      await worker.get(SubscriptionEvents).applyPurchase("test", ref);
      // In the order of their own time: cancelled, then renewal on again — both applied.
      const { rows } = await db.query<{ kind: string; outcome: string; to_status: string }>(
        "SELECT kind, outcome, to_status FROM billing_event WHERE provider_event_id IN ('later', 'earlier') ORDER BY event_at",
      );
      expect(rows).toEqual([
        { kind: "cancelled", outcome: "applied", to_status: "cancelled" },
        { kind: "cancel_withdrawn", outcome: "applied", to_status: "active" },
      ]);
      expect(await subscriptionOf(who)).toMatchObject({ status: "active" });
    });

    it("refuses a purchase of another account and a second subscription while one gives access", async () => {
      const owner = await customer();
      const other = await customer();
      await event(owner, "started", {
        periodEnd: new Date(Date.now() + 30 * DAY),
        ref: "shared-apple-id",
      });
      expect(
        await event(other, "renewed", {
          periodEnd: new Date(Date.now() + 60 * DAY),
          ref: "shared-apple-id",
        }),
      ).toMatchObject({ outcome: "refused", detail: "linked_to_another_account" });
      expect(await subscriptionOf(other)).toBeUndefined();
      expect(
        await event(owner, "started", {
          periodEnd: new Date(Date.now() + 30 * DAY),
          ref: "second-purchase",
        }),
      ).toMatchObject({ outcome: "refused", detail: "already_active" });

      // Suspended — gives no access: a new purchase replaces it.
      await event(owner, "suspended", { ref: "shared-apple-id" });
      expect(
        await event(owner, "started", {
          periodEnd: new Date(Date.now() + 30 * DAY),
          ref: "second-purchase",
        }),
      ).toMatchObject({ outcome: "applied", detail: "replaced_previous" });
      const { rows } = await db.query<{ provider_ref: string; status: string }>(
        "SELECT provider_ref, status FROM subscription WHERE account_id = $1 ORDER BY created_at",
        [owner.accountId],
      );
      expect(rows).toEqual([
        { provider_ref: "shared-apple-id", status: "expired" },
        { provider_ref: "second-purchase", status: "active" },
      ]);
      // The provider's port refuses what isn't an event.
      expect(() => new TestSubscriptionProvider().parseEvent({ kind: "started" })).toThrow();
    });

    it("keeps access to the end of a cancelled term, and ends it then", async () => {
      const who = await customer();
      await event(who, "started", { periodEnd: new Date(Date.now() + 30 * DAY) });
      await event(who, "cancelled");
      const cancelled = await mine(who);
      expect(cancelled.subscription).toMatchObject({ status: "cancelled", grantsAccess: true });
      expect(cancelled.access.validUntil).toBe(cancelled.subscription!.periodEnd);
      await db.query(
        "UPDATE subscription SET current_period_end = now() - interval '1 minute' WHERE account_id = $1",
        [who.accountId],
      );
      expect((await mine(who)).access.granted).toBe(false);
      await expireRun();
      expect(await subscriptionOf(who)).toMatchObject({ status: "expired" });
    });
  });

  describe("time (AC-3, U-5)", () => {
    it("keeps access while unconfirmed for the tolerance, then expires; a late renewal restores", async () => {
      await settings.set({ store_lag_tolerance_hours: 48 });
      const who = await customer();
      await event(who, "started", { periodEnd: new Date(Date.now() + 30 * DAY) });
      await db.query(
        "UPDATE subscription SET current_period_end = now() - interval '1 hour' WHERE account_id = $1",
        [who.accountId],
      );
      // Before the sweeper: access as after it.
      const before = await mine(who);
      expect(before.access.granted).toBe(true);
      // The worker sweeps every minute too: the result counts, not whose run it was.
      await expireRun();
      const unconfirmed = await mine(who);
      expect(unconfirmed.subscription).toMatchObject({
        status: "expired_unconfirmed",
        statusConfirmed: false,
        grantsAccess: true,
      });
      expect(unconfirmed.access).toEqual(before.access);
      // Nothing more is due yet: a second run moves nothing.
      await expireRun();
      expect((await subscriptionOf(who))!.status).toBe("expired_unconfirmed");

      // A renewal within the tolerance: active again, no gap.
      await event(who, "renewed", { periodEnd: new Date(Date.now() + 30 * DAY) });
      expect((await mine(who)).subscription).toMatchObject({
        status: "active",
        statusConfirmed: true,
      });

      // Lapsed again, the tolerance passes: expired, access gone.
      await db.query(
        "UPDATE subscription SET current_period_end = now() - interval '49 hours' WHERE account_id = $1",
        [who.accountId],
      );
      expect((await mine(who)).access.granted).toBe(false);
      // A run takes one move of a subscription: unconfirmed, then — its tolerance
      // long gone — expired on the next run.
      await expireRun();
      await expireRun();
      expect((await subscriptionOf(who))!.status).toBe("expired");
      expect((await mine(who)).subscription).toBeNull();

      // Time's moves are events of the system, once each, and in the journal.
      const { rows } = await db.query<{ kind: string; source: string; to_status: string }>(
        "SELECT kind, source, to_status FROM billing_event WHERE source = 'system' ORDER BY received_at, event_at",
      );
      expect(rows).toEqual([
        { kind: "period_lapsed", source: "system", to_status: "expired_unconfirmed" },
        { kind: "period_lapsed", source: "system", to_status: "expired_unconfirmed" },
        { kind: "tolerance_lapsed", source: "system", to_status: "expired" },
      ]);
      const { rows: journal } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'subscription.changed' AND actor_role = 'system'",
      );
      expect(journal[0]!.n).toBe(3);

      // The store confirms after all: restored retroactively.
      await event(who, "renewed", { periodEnd: new Date(Date.now() + 30 * DAY) });
      expect((await mine(who)).subscription).toMatchObject({ status: "active" });
    });
  });

  // -------------------------------------------------------- club access

  describe("club access from two sources (AC-2)", () => {
    it("gives in SQL what the function gives, on the same data", async () => {
      const tolerance = 48 * HOUR;
      await settings.set({ store_lag_tolerance_hours: 48 });
      const at = new Date();
      const cases: {
        grant?: number;
        status?: string;
        periodEnd?: number;
        grace?: number;
        unconfirmed?: number;
      }[] = [
        {},
        { grant: 10 * DAY },
        { grant: -HOUR },
        { status: "active", periodEnd: 30 * DAY },
        { status: "active", periodEnd: -HOUR },
        { status: "active", periodEnd: -49 * HOUR },
        { status: "grace", periodEnd: -DAY, grace: 5 * DAY },
        { status: "grace", periodEnd: -3 * DAY },
        { status: "cancelled", periodEnd: 3 * DAY },
        { status: "cancelled", periodEnd: -HOUR },
        { status: "expired_unconfirmed", periodEnd: -HOUR, unconfirmed: -HOUR },
        { status: "expired_unconfirmed", periodEnd: -50 * HOUR, unconfirmed: -50 * HOUR },
        { status: "suspended", periodEnd: 10 * DAY },
        { status: "expired", periodEnd: 10 * DAY },
        // A grant until 31.12, a subscription until 15.11 — and the other way round, and a tie.
        { grant: 77 * DAY, status: "active", periodEnd: 31 * DAY },
        { grant: 5 * DAY, status: "active", periodEnd: 31 * DAY },
        { grant: 5 * DAY, status: "cancelled", periodEnd: 5 * DAY },
      ];
      const ids: string[] = [];
      for (const [index, entry] of cases.entries()) {
        const { rows } = await db.query<{ id: string }>(
          "INSERT INTO account (phone) VALUES ($1) RETURNING id",
          [`+7700${String(9_000_000 + index)}`],
        );
        const id = rows[0]!.id;
        ids.push(id);
        if (entry.grant !== undefined) {
          await db.query(
            "INSERT INTO club_access_grant (account_id, valid_until, reason, granted_by_role) VALUES ($1, $2, 'тест', 'operator')",
            [id, new Date(at.getTime() + entry.grant)],
          );
        }
        if (entry.status) {
          const moment = (offset: number | undefined) =>
            offset === undefined ? null : new Date(at.getTime() + offset);
          await db.query(
            "INSERT INTO subscription (audience, account_id, provider, provider_ref, status, current_period_end, grace_until, unconfirmed_since) VALUES ('user', $1, 'test', $2, $3, $4, $5, $6)",
            [
              id,
              `ref-${String(index)}`,
              entry.status,
              moment(entry.periodEnd),
              moment(entry.grace),
              moment(entry.unconfirmed),
            ],
          );
        }
      }
      const clubAccess = app.get(ClubAccess);
      const database = app.get(DatabaseService);
      const many = await clubAccess.statesOf(ids, database.db, at);
      for (const [index, id] of ids.entries()) {
        const one = await clubAccess.stateOf(id, database.db, at);
        expect(many.get(id), `case ${String(index)}`).toEqual(one);
        const twin = await database.db.execute<{ until: string | null }>(
          sql`SELECT ${clubAccessUntil(sql`${id}::uuid`, at, tolerance)} AS until`,
        );
        const until = twin.rows[0]!.until;
        expect(until === null ? null : new Date(until).toISOString(), `case ${String(index)}`).toBe(
          one.validUntil,
        );
      }
      // A grant until 31.12 and a subscription until 15.11: until 31.12, by hand.
      expect(many.get(ids[14]!)).toMatchObject({ granted: true, source: "manual" });
      expect(many.get(ids[15]!)).toMatchObject({ granted: true, source: "subscription" });
      expect(many.get(ids[16]!)).toMatchObject({ granted: true, source: "subscription" });
      expect(many.get(ids[0]!)).toEqual({ granted: false, source: null, validUntil: null });
    });

    it("answers every consumer the same with a subscription and no grant; orders and codes stay after it ends", async () => {
      const shop = await company("Подписка");
      const offer = await put(shop);
      const who = await customer();

      // Without access: the supplier hidden, no order.
      const hiddenItem = await ok(
        who.as("get", `/catalog/items/${padsId}`),
        (body) => body as { offers: { supplier: { kind: string } }[] },
      );
      expect(hiddenItem.offers[0]!.supplier).toMatchObject({
        kind: "hidden",
        reason: "subscription_required",
      });
      expectError(await place(who, offer), 403, "SUBSCRIPTION_REQUIRED");
      expect(
        (
          await ok(
            who.as("get", `/suppliers/${shop.supplierId}/reviews`),
            (b) => b as { supplier: { kind: string } },
          )
        ).supplier.kind,
      ).toBe("hidden");
      expect(
        (
          await ok(
            who.as("get", `/catalog/offers/${offer.id}/supplier`),
            (b) => b as { supplier: { kind: string } },
          )
        ).supplier.kind,
      ).toBe("hidden");

      await event(who, "started", { periodEnd: new Date(Date.now() + 30 * DAY) });

      // The very next request: the supplier named, the order placed, the pages open.
      const item = await ok(
        who.as("get", `/catalog/items/${padsId}`),
        (body) => body as { offers: { supplier: { kind: string; name?: string } }[] },
      );
      expect(item.offers[0]!.supplier).toMatchObject({ kind: "visible", name: "Подписка" });
      expect(
        (
          await ok(
            who.as("get", `/suppliers/${shop.supplierId}/reviews`),
            (b) => b as { supplier: { kind: string } },
          )
        ).supplier.kind,
      ).toBe("visible");
      expect(
        (
          await ok(
            who.as("get", `/catalog/offers/${offer.id}/supplier`),
            (b) => b as { supplier: { kind: string } },
          )
        ).supplier.kind,
      ).toBe("visible");
      const order = await placed(who, offer);
      await ok(
        shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
        (b) => b,
      );
      await ok(
        shop.as("post", "/supplier/orders/close", { code: order.confirmation!.code }),
        (b) => b,
      );
      expect(
        (await ok(who.as("get", `/orders/${order.id}/repeat`), (b) => b as { result: string }))
          .result,
      ).toBe("offer");
      const active = await placed(who, offer);

      // The admin list's filter counts the subscription (the same function's twin).
      const listed = await ok(asAdmin("get", "/admin/users?clubAccess=active&limit=100"), (body) =>
        adminUserPageSchema.parse(body),
      );
      const row = listed.users.find((user) => user.accountId === who.accountId);
      expect(row?.clubAccess).toMatchObject({ granted: true, source: "subscription" });
      const expiring = await ok(
        asAdmin("get", "/admin/users?clubAccess=expiring&expiringDays=60&limit=100"),
        (body) => adminUserPageSchema.parse(body),
      );
      expect(expiring.users.map((user) => user.accountId)).toContain(who.accountId);

      // It ends (refund): a new order refused, the placed one with its code kept, offline copy too.
      await event(who, "refunded");
      expectError(await place(who, offer), 403, "SUBSCRIPTION_REQUIRED");
      expect(
        await ok(
          who.as("get", `/orders/${order.id}/repeat`),
          (b) => b as { result: string; reason?: string },
        ),
      ).toMatchObject({ result: "unavailable", reason: "club_access_required" });
      const card = await ok(
        who.as("get", `/orders/${active.id}`),
        (body) => body as { order: { confirmation: { code: string } | null } },
      );
      expect(card.order.confirmation?.code).toBe(active.confirmation!.code);
      const copy = await ok(
        who.as("get", "/active-orders"),
        (body) => body as { orders: { id: string }[] },
      );
      expect(copy.orders.map((entry) => entry.id)).toContain(active.id);
      const none = await ok(asAdmin("get", "/admin/users?clubAccess=none&limit=100"), (body) =>
        adminUserPageSchema.parse(body),
      );
      expect(none.users.map((user) => user.accountId)).toContain(who.accountId);
    });
  });

  // ------------------------------------------------------ /me/subscription

  describe("GET /me/subscription (AC-4) and tariffs (AC-5)", () => {
    it("tells the status, the access, the tariff and the announced change; other sessions are refused", async () => {
      const who = await customer();
      const empty = await mine(who);
      expect(empty).toMatchObject({
        subscription: null,
        manualGrant: null,
        plan: null,
        announcedPlan: null,
      });

      const plans = app.get(Plans);
      const started = new Date(Date.now() - DAY);
      await plans.add(
        {
          audience: "user",
          code: "user-month",
          price: 490,
          validFrom: started,
          validTo: null,
          announceBeforeDays: 7,
          reason: "Старт",
        },
        { role: "operator" },
      );
      await plans.add(
        {
          audience: "user",
          code: "user-month-2",
          price: 690,
          validFrom: new Date(Date.now() + 7 * DAY - HOUR),
          validTo: null,
          announceBeforeDays: 7,
          reason: "Повышение",
        },
        { role: "operator" },
      );
      await expect(
        plans.add(
          {
            audience: "user",
            code: "dup",
            price: 1,
            validFrom: started,
            validTo: null,
            announceBeforeDays: 7,
            reason: "Дубль",
          },
          { role: "operator" },
        ),
      ).rejects.toThrow();
      const { rows: journal } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'plan.added' AND actor_role = 'operator'",
      );
      expect(journal[0]!.n).toBe(2);

      await event(who, "started", { periodEnd: new Date(Date.now() + 30 * DAY) });
      const body = await ok(who.as("get", "/me/subscription").set("Accept-Language", "kk"), (raw) =>
        mySubscriptionResponseSchema.parse(raw),
      );
      expect(body.subscription).toMatchObject({
        status: "active",
        grantsAccess: true,
        statusConfirmed: true,
        provider: "test",
        graceUntil: null,
      });
      expect(body.plan).toMatchObject({
        code: "user-month",
        price: 490,
        currency: "KZT",
        period: "month",
      });
      expect(body.announcedPlan).toMatchObject({ code: "user-month-2", price: 690 });
      expect(body.announcedPlan!.notice).toMatch(/Жазылым/);
      expect(body.access).toMatchObject({ granted: true, source: "subscription" });

      // The same on another device: the status is the account's.
      const second = await sessionToken(who.phone, "mobile/1.4.2 (android)");
      expect(
        (
          await ok(call(second, "mobile/1.4.2 (android)", "get", "/me/subscription"), (raw) =>
            mySubscriptionResponseSchema.parse(raw),
          )
        ).subscription?.status,
      ).toBe("active");

      expectError(await call(null, IOS, "get", "/me/subscription"), 401, "AUTH_REQUIRED");
      expectError(await asAdmin("get", "/me/subscription"), 403, "FORBIDDEN");
      const shop = await company("Кабинет");
      expectError(await shop.as("get", "/me/subscription"), 403, "FORBIDDEN");
    });
  });

  // ------------------------------------------------------------- D-041

  describe("the showcase after a card is linked (AC-6)", () => {
    it("changes nothing with the switch off, hides without a card with it on, shows with a card", async () => {
      const shop = await company("Без карты");
      const offer = await put(shop);
      const database = app.get(DatabaseService);
      const twin = async () =>
        (
          await database.db
            .select({ id: offerTable.id })
            .from(offerTable)
            .where(sql`${offerTable.id} = ${offer.id} AND ${shownOffers()}`)
        ).length === 1;
      const sign = async () => (await offerShowcase(database.db, [offer.id])).get(offer.id)!;
      const catalogShows = async () => {
        const item = await ok(
          call(null, IOS, "get", `/catalog/items/${padsId}`).set("Cache-Control", "no-cache"),
          (body) => body as { offers: { id: string }[] },
        );
        return item.offers.some((entry) => entry.id === offer.id);
      };

      expect(await sign()).toEqual({ visible: true, reasons: [] });
      expect(await twin()).toBe(true);
      expect(await catalogShows()).toBe(true);
      expect(
        await ok(shop.as("get", "/supplier/subscription"), (b) =>
          supplierSubscriptionResponseSchema.parse(b),
        ),
      ).toMatchObject({ cardLinked: false, cardRequired: false, hiddenWithoutCard: false });

      await settings.set({ supplier_card_required: true });
      await new TestSettings(app).reload();
      expect(await sign()).toEqual({ visible: false, reasons: ["card_not_linked"] });
      expect(await twin()).toBe(false);
      expect(await catalogShows()).toBe(false);
      const mineList = await ok(shop.as("get", "/supplier/offers"), (b) =>
        offerPageSchema.parse(b),
      );
      expect(mineList.offers[0]!.showcase).toEqual({
        visible: false,
        reasons: ["card_not_linked"],
      });
      expect(mineList.offers[0]!.status).toBe("active");
      expect(
        await ok(shop.as("get", "/supplier/subscription"), (b) =>
          supplierSubscriptionResponseSchema.parse(b),
        ),
      ).toMatchObject({ cardRequired: true, hiddenWithoutCard: true });
      const adminView = await ok(
        asAdmin("get", `/admin/suppliers/${shop.supplierId}/offers`),
        (b) => offerPageSchema.parse(b),
      );
      expect(adminView.offers[0]!.showcase.reasons).toEqual(["card_not_linked"]);

      // The other reasons go on beside it; a card brings the offer back at once.
      await app.get(SupplierCards).mark(shop.supplierId, true);
      expect(await sign()).toEqual({ visible: true, reasons: [] });
      expect(await twin()).toBe(true);
      expect(await catalogShows()).toBe(true);
      const { rows } = await db.query<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE action = 'supplier.card_changed'",
      );
      expect(rows).toEqual([{ after: { cardLinked: true } }]);

      // The switch off again: a supplier without a card is shown.
      await app.get(SupplierCards).mark(shop.supplierId, false);
      await settings.set({ supplier_card_required: false });
      expect(await sign()).toEqual({ visible: true, reasons: [] });
      expect(await twin()).toBe(true);
    });
  });

  // ------------------------------------------------------------- admin

  describe("the admin card (AC-7)", () => {
    it("shows the subscription with its history and the grant beside it; other sessions refused", async () => {
      const who = await customer();
      const end = new Date(Date.now() + 30 * DAY);
      await event(who, "started", { periodEnd: end });
      await event(who, "renewed", { periodEnd: end });
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          accountId: who.accountId,
          validUntil: new Date(Date.now() + 10 * DAY).toISOString(),
          reason: "Тест",
        }),
        (b) => b,
        201,
      );
      const card = await ok(asAdmin("get", `/admin/users/${who.accountId}/subscription`), (b) =>
        adminUserSubscriptionResponseSchema.parse(b),
      );
      expect(card.subscription).toMatchObject({ status: "active", provider: "test" });
      expect(card.history.map((entry) => [entry.kind, entry.outcome, entry.by])).toEqual([
        ["renewed", "no_effect", "operator"],
        ["started", "applied", "operator"],
      ]);
      expect(card.manualGrant).not.toBeNull();
      expect(card.access).toMatchObject({ granted: true, source: "subscription" });
      expectError(
        await who.as("get", `/admin/users/${who.accountId}/subscription`),
        403,
        "FORBIDDEN",
      );
      expectError(
        await asAdmin("get", `/admin/users/${randomUUID()}/subscription`),
        404,
        "NOT_FOUND",
      );
    });
  });
});
