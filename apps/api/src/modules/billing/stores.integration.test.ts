import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminSignalPageSchema,
  adminSupplierResponseSchema,
  adminUserSubscriptionResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  mySubscriptionResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
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
import { SweepRunner, type JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { ClubAccess } from "../club-access";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { expireSubscriptionsJob } from "./billing-jobs";
import { BillingOperator } from "./billing-operator";
import { Plans } from "./plans.service";
import { SubscriptionExpiry } from "./subscription-events";
import {
  devAppleJws,
  devGoogleOidcToken,
  devPubsubPush,
  type DevChain,
} from "./stores/dev-store-signing";
import { googleRef } from "./stores/google-play";
import { StoreSubscriptions } from "./stores/store-subscriptions";

/**
 * TASK-041 on a real PostgreSQL and Redis with the API and a worker; App
 * Store and Google Play are a local HTTP server (the App Store Server API,
 * the Play Developer API, Google's token endpoint) and the local chain of
 * `apps/api/fixtures/stores` — nothing leaves the machine.
 *
 * - `sync`: a purchase of one's own (club access, an order passes), of
 *   another account (409, it stays there), the same again (nothing new), a
 *   product outside the tariff, the store unreachable (503, access kept), a
 *   forged and an expired signature, another app, another environment —
 *   for both stores; Google's purchase acknowledged;
 * - notifications: a bad signature and a bad OIDC token leave no trace; the
 *   same delivery twice and at once is applied once; events out of order;
 *   an unknown event kept without effect;
 * - a refund and a revocation end access now; an earlier order keeps its code;
 * - ARCHITECTURE 18.10 for Apple, steps 1–8, and for Google, steps 1, 4–7;
 * - the reconciliation: a lost renewal doesn't end access; the store down —
 *   `expired_unconfirmed`, then `expired`, then renewed backdated;
 * - `store_sync_stale` opens and closes by itself;
 * - P-SUB-01 once per grace, the reminder, the reminder cancelled by a payment;
 * - what leaves the process: no JWS, no purchase token in the log, the
 *   journal, the events or the dev outbox.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ANDROID = "mobile/1.4.2 (android)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const APPLE_PRODUCT = "kz.adclub.club.month";
const GOOGLE_PRODUCT = "club_month";
const AUDIENCE = "https://adclub.test/webhooks/stores/google";
const SENDER = "pubsub@adclub-test.iam.gserviceaccount.com";
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

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) return `${prefix}${digit}`;
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

// ------------------------------------------------------------ the stores

interface AppleState {
  status: 1 | 2 | 3 | 4 | 5;
  account: string | null;
  expires: number;
  grace?: number;
  autoRenew?: 0 | 1;
  revocation?: number;
  product?: string;
  environment?: string;
  bundleId?: string;
}

interface GoogleState {
  state: string;
  account: string | null;
  expiry: number;
  acknowledged?: boolean;
  product?: string;
  linked?: string;
}

/** App Store and Google Play as a local server: what each says is set by the test. */
class FakeStores {
  apple = new Map<string, AppleState>();
  google = new Map<string, GoogleState>();
  acknowledged: string[] = [];
  calls: string[] = [];
  down = false;
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.apple.clear();
    this.google.clear();
    this.acknowledged = [];
    this.calls = [];
    this.down = false;
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for await (const _chunk of req) {
      // drain
    }
    const url = req.url ?? "";
    this.calls.push(`${req.method ?? ""} ${url.split("?")[0]!}`);
    if (this.down) return this.send(res, 503, { error: "down" });
    if (url === "/token")
      return this.send(res, 200, { access_token: "play-access", expires_in: 3600 });
    // Google's keys: none of them signed the tokens of the tests (those are the local key's).
    if (url === "/certs") return this.send(res, 200, { keys: [] });
    const apple = /^\/inApps\/v1\/subscriptions\/([^/?]+)$/.exec(url);
    if (apple) {
      if (!String(req.headers.authorization).startsWith("Bearer ey")) return this.send(res, 401);
      const otid = decodeURIComponent(apple[1]!);
      const state = this.apple.get(otid);
      if (!state) return this.send(res, 404, { errorCode: 4040010 });
      const now = Date.now();
      return this.send(res, 200, {
        environment: "Sandbox",
        bundleId: state.bundleId ?? "kz.adclub.app",
        data: [
          {
            subscriptionGroupIdentifier: "21000001",
            lastTransactions: [
              {
                originalTransactionId: otid,
                status: state.status,
                signedTransactionInfo: appleTransaction(otid, state.account, state.expires, {
                  signedDate: now,
                  ...(state.product && { productId: state.product }),
                  ...(state.revocation && { revocationDate: state.revocation }),
                  ...(state.environment && { environment: state.environment }),
                }),
                signedRenewalInfo: devAppleJws({
                  originalTransactionId: otid,
                  autoRenewStatus: state.autoRenew ?? 1,
                  ...(state.grace && { gracePeriodExpiresDate: state.grace }),
                  signedDate: now,
                  environment: "Sandbox",
                }),
              },
            ],
          },
        ],
      });
    }
    const ack =
      /^\/androidpublisher\/v3\/applications\/kz\.adclub\.app\/purchases\/subscriptions\/([^/]+)\/tokens\/([^/:]+):acknowledge$/.exec(
        url,
      );
    if (ack && req.method === "POST") {
      this.acknowledged.push(decodeURIComponent(ack[2]!));
      const state = this.google.get(decodeURIComponent(ack[2]!));
      if (state) state.acknowledged = true;
      return this.send(res, 200, {});
    }
    const google =
      /^\/androidpublisher\/v3\/applications\/kz\.adclub\.app\/purchases\/subscriptionsv2\/tokens\/([^/]+)$/.exec(
        url,
      );
    if (google) {
      const state = this.google.get(decodeURIComponent(google[1]!));
      if (!state) return this.send(res, 404, { error: { code: 404 } });
      return this.send(res, 200, {
        kind: "androidpublisher#subscriptionPurchaseV2",
        subscriptionState: state.state,
        acknowledgementState: state.acknowledged
          ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
          : "ACKNOWLEDGEMENT_STATE_PENDING",
        ...(state.account && {
          externalAccountIdentifiers: { obfuscatedExternalAccountId: state.account },
        }),
        lineItems: [
          {
            productId: state.product ?? GOOGLE_PRODUCT,
            expiryTime: new Date(state.expiry).toISOString(),
          },
        ],
        testPurchase: {},
        ...(state.linked && { linkedPurchaseToken: state.linked }),
      });
    }
    return this.send(res, 404, {});
  }
}

function appleTransaction(
  otid: string,
  account: string | null,
  expires: number,
  overrides: Record<string, unknown> = {},
  chain: DevChain = "dev",
): string {
  const jws = devAppleJws(
    {
      transactionId: `${otid}${String(expires).slice(-6)}`,
      originalTransactionId: otid,
      bundleId: "kz.adclub.app",
      productId: APPLE_PRODUCT,
      type: "Auto-Renewable Subscription",
      purchaseDate: Date.now(),
      expiresDate: expires,
      signedDate: Date.now(),
      environment: "Sandbox",
      ...(account && { appAccountToken: account }),
      ...overrides,
    },
    chain,
  );
  rememberSecret(jws);
  return jws;
}

const stores = new FakeStores();
const appleKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const playKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("subscriptions through the stores (PostgreSQL + Redis + worker + local stores)", () => {
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
    await stores.start();
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
      APPLE_BUNDLE_ID: "kz.adclub.app",
      APPLE_APP_APPLE_ID: "1234567890",
      APPLE_ENVIRONMENT: "sandbox",
      APPLE_ISSUER_ID: "57246542-96fe-1a63-e053-0824d011072a",
      APPLE_KEY_ID: "2X9R4HXF34",
      APPLE_PRIVATE_KEY: appleKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      APPLE_API_BASE_URL: stores.url,
      GOOGLE_PLAY_PACKAGE_NAME: "kz.adclub.app",
      GOOGLE_PLAY_CLIENT_EMAIL: "play@adclub-test.iam.gserviceaccount.com",
      GOOGLE_PLAY_PRIVATE_KEY: playKey.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      GOOGLE_PUBSUB_AUDIENCE: AUDIENCE,
      GOOGLE_PUBSUB_SERVICE_ACCOUNT: SENDER,
      GOOGLE_PLAY_API_BASE_URL: stores.url,
      GOOGLE_PLAY_TOKEN_URL: `${stores.url}/token`,
      GOOGLE_OIDC_CERTS_URL: `${stores.url}/certs`,
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
    await stores.stop();
  });

  beforeEach(async () => {
    stores.reset();
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await truncateAll(db);
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
      store_sync_per_account: 1000,
    });
    await new TestSettings(app).reload();
    output = captureOutput();
    await app.get(Plans).add(
      {
        audience: "user",
        code: "user-month",
        price: 990,
        validFrom: new Date(Date.now() - DAY),
        validTo: null,
        announceBeforeDays: 7,
        reason: "TASK-041 test",
        storeProductIds: [APPLE_PRODUCT, GOOGLE_PRODUCT],
      },
      { role: "operator" },
    );
  }, 120_000);

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
      if (refresh) rememberSecret(refresh[1]!);
    }
    if (client === IOS || client === ANDROID) {
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
    const step = totpStepRequiredDetailsSchema.parse(start.body.details).signInStep.token;
    const setupResponse = await stepPost("/auth/sign-in/totp/setup", { signInStep: step });
    remember(setupResponse.body);
    const setup = totpSetupResponseSchema.parse(setupResponse.body);
    const confirmed = await stepPost("/auth/sign-in/totp/setup/confirm", {
      signInStep: step,
      totpCode: nextCode(setup.secret),
    });
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

  type As = (method: Method, path: string, body?: object) => Test;

  interface Customer {
    phone: string;
    accountId: string;
    as: As;
    bearer: string;
  }

  async function customer(client = IOS): Promise<Customer> {
    const phone = `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, client);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM account WHERE phone = $1", [
      phone,
    ]);
    return {
      phone,
      accountId: rows[0]!.id,
      bearer,
      as: (method, path, body) => call(bearer, client, method, path, body),
    };
  }

  /** The same person on a second phone (another platform). */
  async function onAndroid(who: Customer): Promise<Customer> {
    const bearer = await sessionToken(who.phone, ANDROID);
    return {
      ...who,
      bearer,
      as: (method, path, body) => call(bearer, ANDROID, method, path, body),
    };
  }

  let offer: SupplierOffer | null = null;

  /** One supplier with one offer on the showcase, made once per test that orders. */
  async function anOffer(): Promise<SupplierOffer> {
    if (offer) return offer;
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
    const phone = `+7705${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name: "Автомаркет",
        bin: validBin(`0812340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: "goods",
        address: "ул. Райымбека, 1",
        district: "Жетысуский",
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
    const supplierBearer = await sessionToken(phone, SUPPLIER_WEB);
    offer = await ok(
      call(supplierBearer, SUPPLIER_WEB, "post", "/supplier/offers", {
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
    return offer;
  }

  beforeEach(() => {
    offer = null;
  });

  function place(who: Customer, of: SupplierOffer) {
    return who.as("post", "/orders", {
      offerId: of.id,
      quantity: 1,
      fulfillment: "pickup",
      expectedPrice: of.price,
      idempotencyKey: randomUUID(),
      allowAnotherActive: true,
    });
  }

  async function placed(who: Customer, of: SupplierOffer): Promise<UserOrder> {
    return ok(
      place(who, of),
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

  async function mine(who: Customer) {
    return ok(who.as("get", "/me/subscription"), (body) =>
      mySubscriptionResponseSchema.parse(body),
    );
  }

  // ------------------------------------------------------------ the stores

  function syncApple(who: Customer, jws: string) {
    return who.as("post", "/billing/store/sync", { platform: "ios", signedTransaction: jws });
  }

  function syncGoogle(who: Customer, purchaseToken: string, productId = GOOGLE_PRODUCT) {
    rememberSecret(purchaseToken);
    return who.as("post", "/billing/store/sync", { platform: "android", purchaseToken, productId });
  }

  let otidCounter = 0;
  const newOtid = () => String(2_000_000_000_000_000 + Date.now() * 10 + otidCounter++);
  const newToken = () => {
    const value = `play-token-${randomUUID()}-${randomUUID()}`;
    rememberSecret(value);
    return value;
  };

  interface Notice {
    type: string;
    subtype?: string;
    otid: string;
    account: string | null;
    expires: number;
    grace?: number;
    uuid?: string;
    signedDate?: number;
    environment?: string;
    bundleId?: string;
    chain?: DevChain;
    autoRenew?: 0 | 1;
    revocation?: number;
  }

  function appleNotice(notice: Notice): { body: string; uuid: string } {
    const uuid = notice.uuid ?? randomUUID();
    const signedDate = notice.signedDate ?? Date.now();
    const environment = notice.environment ?? "Sandbox";
    const signedPayload = devAppleJws(
      {
        notificationType: notice.type,
        ...(notice.subtype && { subtype: notice.subtype }),
        notificationUUID: uuid,
        version: "2.0",
        signedDate,
        data: {
          bundleId: notice.bundleId ?? "kz.adclub.app",
          environment,
          signedTransactionInfo: appleTransaction(notice.otid, notice.account, notice.expires, {
            environment,
            signedDate,
            ...(notice.revocation && { revocationDate: notice.revocation }),
          }),
          signedRenewalInfo: devAppleJws({
            originalTransactionId: notice.otid,
            autoRenewStatus: notice.autoRenew ?? 1,
            ...(notice.grace && { gracePeriodExpiresDate: notice.grace }),
            signedDate,
            environment,
          }),
        },
      },
      notice.chain ?? "dev",
    );
    rememberSecret(signedPayload);
    return { body: JSON.stringify({ signedPayload }), uuid };
  }

  function postApple(body: string) {
    return http()
      .post("/webhooks/stores/apple")
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", nextIp())
      .send(body);
  }

  function oidc(overrides: Record<string, unknown> = {}): string {
    const nowS = Math.floor(Date.now() / 1000);
    const jwt = devGoogleOidcToken({
      iss: "https://accounts.google.com",
      aud: AUDIENCE,
      email: SENDER,
      email_verified: true,
      iat: nowS,
      exp: nowS + 600,
      ...overrides,
    });
    rememberSecret(jwt);
    return jwt;
  }

  function postGoogle(notification: Record<string, unknown>, messageId: string, bearer = oidc()) {
    return http()
      .post("/webhooks/stores/google")
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${bearer}`)
      .set("X-Forwarded-For", nextIp())
      .send(
        JSON.stringify(
          devPubsubPush(
            {
              version: "1.0",
              packageName: "kz.adclub.app",
              eventTimeMillis: String(Date.now()),
              ...notification,
            },
            messageId,
          ),
        ),
      );
  }

  const rtdn = (code: number, purchaseToken: string) => ({
    subscriptionNotification: { version: "1.0", notificationType: code, purchaseToken },
  });

  interface Row {
    id: string;
    status: string;
    current_period_end: Date;
    grace_until: Date | null;
    provider_ref: string;
    purchase_platform: string | null;
  }

  async function subscriptionOf(who: Customer): Promise<Row | undefined> {
    const { rows } = await db.query<Row>(
      "SELECT id, status, current_period_end, grace_until, provider_ref, purchase_platform FROM subscription WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [who.accountId],
    );
    return rows[0];
  }

  async function count(sqlText: string, values: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (${sqlText}) q`,
      values,
    );
    return rows[0]!.n;
  }

  /** Waits until nothing of the stores is pending: the worker applied every event and delivery. */
  async function settled(): Promise<void> {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const pending =
        (await count("SELECT 1 FROM billing_event WHERE outcome = 'pending'")) +
        (await count("SELECT 1 FROM store_notification WHERE processed_at IS NULL"));
      if (pending === 0) return;
      if (Date.now() > deadline) throw new Error("The worker never applied the stores' words");
      await sleep(150);
    }
  }

  async function expireRun() {
    return new SweepRunner(worker.get(DatabaseService)).run(
      expireSubscriptionsJob,
      worker.get(SubscriptionExpiry),
      {
        signal: new AbortController().signal,
      },
    );
  }

  const storesOf = () => worker.get(StoreSubscriptions);

  async function hasAccess(who: Customer): Promise<boolean> {
    return (await app.get(ClubAccess).stateOf(who.accountId)).granted;
  }

  // --------------------------------------------------------------- sync

  describe("POST /billing/store/sync (AC-1)", () => {
    it("Apple: one's own purchase gives club access and an order passes; the same again changes nothing", async () => {
      const of = await anOffer();
      const who = await customer();
      const otid = newOtid();
      const expires = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires });
      const jws = appleTransaction(otid, who.accountId, expires);
      expectError(await place(who, of), 403, "SUBSCRIPTION_REQUIRED");
      const first = await ok(syncApple(who, jws), (body) =>
        mySubscriptionResponseSchema.parse(body),
      );
      expect(first.subscription).toMatchObject({
        status: "active",
        grantsAccess: true,
        provider: "store",
        platform: "ios",
        periodEnd: new Date(expires).toISOString(),
      });
      expect(first.access).toMatchObject({ granted: true, source: "subscription" });
      expect(await hasAccess(who)).toBe(true);
      await placed(who, of);
      const events = await count("SELECT 1 FROM billing_event");
      const again = await ok(syncApple(who, jws), (body) =>
        mySubscriptionResponseSchema.parse(body),
      );
      expect(again.subscription).toEqual(first.subscription);
      expect(await count("SELECT 1 FROM billing_event")).toBe(events);
      expect(await count("SELECT 1 FROM subscription")).toBe(1);
      const { rows } = await db.query<{ environment: string; last_sync_at: Date | null }>(
        "SELECT environment, last_sync_at FROM store_purchase WHERE provider_ref = $1",
        [`apple:${otid}`],
      );
      expect(rows[0]).toMatchObject({ environment: "sandbox" });
      expect(rows[0]!.last_sync_at).not.toBeNull();
    });

    it("Apple: another account's purchase is 409 and stays there", async () => {
      const first = await customer();
      const second = await customer();
      const otid = newOtid();
      const expires = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: first.accountId, expires });
      // The store names the first account: refused before anything is written.
      expectError(
        await syncApple(second, appleTransaction(otid, first.accountId, expires)),
        409,
        "SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT",
      );
      expect(await subscriptionOf(second)).toBeUndefined();
      await ok(syncApple(first, appleTransaction(otid, first.accountId, expires)), (body) => body);
      // A second purchase while the first gives access: «Подписка уже активна».
      const nameless = newOtid();
      stores.apple.set(nameless, { status: 1, account: null, expires });
      expectError(
        await syncApple(first, appleTransaction(nameless, null, expires)),
        409,
        "SUBSCRIPTION_ALREADY_ACTIVE",
      );
      // A purchase that names nobody (restored on another number): it is the one's who brought it first.
      const owner = await customer();
      await ok(syncApple(owner, appleTransaction(nameless, null, expires)), (body) => body);
      const third = await customer();
      expectError(
        await syncApple(third, appleTransaction(nameless, null, expires)),
        409,
        "SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT",
      );
      expect(await subscriptionOf(third)).toBeUndefined();
      expect(await hasAccess(third)).toBe(false);
    });

    it("refuses a product outside the tariff, a forged or expired signature, another app, another environment", async () => {
      const who = await customer();
      const otid = newOtid();
      const expires = Date.now() + 30 * DAY;
      stores.apple.set(otid, {
        status: 1,
        account: who.accountId,
        expires,
        product: "kz.adclub.other",
      });
      expectError(
        await syncApple(
          who,
          appleTransaction(otid, who.accountId, expires, { productId: "kz.adclub.other" }),
        ),
        409,
        "SUBSCRIPTION_PRODUCT_UNKNOWN",
      );
      const reasons: [string, unknown][] = [];
      for (const [jws, reason] of [
        [appleTransaction(otid, who.accountId, expires, {}, "rogue"), "signature"],
        [appleTransaction(otid, who.accountId, expires, {}, "expired"), "signature"],
        [appleTransaction(otid, who.accountId, expires, { bundleId: "com.other.app" }), "bundle"],
        [
          appleTransaction(otid, who.accountId, expires, { environment: "Production" }),
          "environment",
        ],
      ] as const) {
        const response = await syncApple(who, jws);
        expectError(response, 400, "SUBSCRIPTION_PURCHASE_INVALID");
        reasons.push([reason, (response.body as { details: { reason: string } }).details.reason]);
      }
      expect(reasons.map(([want, got]) => [want, got])).toEqual(
        reasons.map(([want]) => [want, want]),
      );
      expect(await count("SELECT 1 FROM subscription")).toBe(0);
      expect(await count("SELECT 1 FROM billing_event")).toBe(0);
      // Not a JSON of a transaction at all.
      expectError(await syncApple(who, "x".repeat(40)), 400, "SUBSCRIPTION_PURCHASE_INVALID");
    });

    it("the store unreachable is 503 retryable and the access stays as it was", async () => {
      const who = await customer();
      const otid = newOtid();
      const expires = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires });
      await ok(syncApple(who, appleTransaction(otid, who.accountId, expires)), (body) => body);
      stores.down = true;
      const response = await syncApple(who, appleTransaction(otid, who.accountId, expires));
      expectError(response, 503, "SERVICE_UNAVAILABLE");
      expect((response.body as { retryable: boolean }).retryable).toBe(true);
      expect((await subscriptionOf(who))!.status).toBe("active");
      expect(await hasAccess(who)).toBe(true);
      const { rows } = await db.query<{ last_failure: string }>(
        "SELECT last_failure FROM store_api_health WHERE platform = 'ios'",
      );
      expect(rows[0]!.last_failure).toBe("http_503");
    });

    it("Google: one's own purchase active and acknowledged; another account's 409; the same again nothing new", async () => {
      const of = await anOffer();
      const who = await customer();
      const other = await customer();
      const purchaseToken = newToken();
      const expiry = Date.now() + 30 * DAY;
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: who.accountId,
        expiry,
      });
      const first = await ok(syncGoogle(who, purchaseToken), (body) =>
        mySubscriptionResponseSchema.parse(body),
      );
      expect(first.subscription).toMatchObject({
        status: "active",
        platform: "android",
        provider: "store",
      });
      expect(stores.acknowledged).toEqual([purchaseToken]);
      await placed(who, of);
      const events = await count("SELECT 1 FROM billing_event");
      await ok(syncGoogle(who, purchaseToken), (body) => body);
      expect(await count("SELECT 1 FROM billing_event")).toBe(events);
      expect(stores.acknowledged).toHaveLength(1);
      expectError(
        await syncGoogle(other, purchaseToken),
        409,
        "SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT",
      );
      expect(await subscriptionOf(other)).toBeUndefined();
      expectError(await syncGoogle(who, newToken()), 400, "SUBSCRIPTION_PURCHASE_INVALID");
      // The token is a reference only by its hash, nowhere as itself.
      expect((await subscriptionOf(who))!.provider_ref).toBe(googleRef(purchaseToken));
      expect(
        await count(
          "SELECT 1 FROM billing_event WHERE provider_ref LIKE $1 OR provider_event_id LIKE $1",
          [`%${purchaseToken}%`],
        ),
      ).toBe(0);
    });
  });

  // ------------------------------------------------------- notifications

  describe("the stores' notifications (AC-2)", () => {
    it("Apple: a forged, foreign or other-environment notification is 403 with no trace", async () => {
      const who = await customer();
      const base = {
        type: "SUBSCRIBED",
        subtype: "INITIAL_BUY",
        otid: newOtid(),
        account: who.accountId,
        expires: Date.now() + 30 * DAY,
      };
      for (const notice of [
        { ...base, chain: "rogue" as const },
        { ...base, chain: "expired" as const },
        { ...base, bundleId: "com.other.app" },
        { ...base, environment: "Production" },
      ]) {
        const response = await postApple(appleNotice(notice).body);
        expect(response.status).toBe(403);
      }
      expect((await postApple("not json")).status).toBe(403);
      expect((await postApple(JSON.stringify({ signedPayload: "a.b.c" }))).status).toBe(403);
      expect(await count("SELECT 1 FROM store_notification")).toBe(0);
      expect(await count("SELECT 1 FROM billing_event")).toBe(0);
    });

    it("Apple: the same delivery twice and at once is one; an older event is stale; an unknown one changes nothing", async () => {
      const who = await customer();
      const otid = newOtid();
      const t0 = Date.now();
      const buy = appleNotice({
        type: "SUBSCRIBED",
        subtype: "INITIAL_BUY",
        otid,
        account: who.accountId,
        expires: t0 + 30 * DAY,
        signedDate: t0,
      });
      const answers = await Promise.all([
        postApple(buy.body),
        postApple(buy.body),
        postApple(buy.body),
      ]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
      await settled();
      expect(await count("SELECT 1 FROM store_notification")).toBe(1);
      expect(await count("SELECT 1 FROM billing_event")).toBe(1);
      expect((await subscriptionOf(who))!.status).toBe("active");
      // The renewal signed later arrives first; the cancellation signed before it comes after.
      await postApple(
        appleNotice({
          type: "DID_RENEW",
          otid,
          account: who.accountId,
          expires: t0 + 60 * DAY,
          signedDate: t0 + 2000,
        }).body,
      );
      await settled();
      await postApple(
        appleNotice({
          type: "DID_CHANGE_RENEWAL_STATUS",
          subtype: "AUTO_RENEW_DISABLED",
          otid,
          account: who.accountId,
          expires: t0 + 30 * DAY,
          signedDate: t0 + 1000,
        }).body,
      );
      await settled();
      const row = (await subscriptionOf(who))!;
      expect(row.status).toBe("active");
      expect(row.current_period_end.getTime()).toBe(t0 + 60 * DAY);
      const { rows } = await db.query<{ outcome: string; detail: string }>(
        "SELECT outcome, detail FROM billing_event WHERE kind = 'cancelled'",
      );
      expect(rows).toEqual([{ outcome: "no_effect", detail: "stale" }]);
      await postApple(
        appleNotice({
          type: "SOMETHING_APPLE_ADDS",
          otid,
          account: who.accountId,
          expires: t0,
          signedDate: t0 + 3000,
        }).body,
      );
      await postApple(
        appleNotice({
          type: "TEST",
          otid,
          account: who.accountId,
          expires: t0,
          signedDate: t0 + 3000,
        }).body,
      );
      const kept = await db.query<{ notification_type: string; result: string }>(
        "SELECT notification_type, result FROM store_notification ORDER BY received_at",
      );
      expect(kept.rows.slice(-2)).toEqual([
        { notification_type: "SOMETHING_APPLE_ADDS", result: "unknown" },
        { notification_type: "TEST", result: "ignored" },
      ]);
      expect(await count("SELECT 1 FROM billing_event")).toBe(3);
    });

    it("Google: a bad OIDC token is 403 with no trace; one delivery is read once, at once or again", async () => {
      const who = await customer();
      const purchaseToken = newToken();
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: who.accountId,
        expiry: Date.now() + 30 * DAY,
      });
      for (const bad of [
        oidc({ aud: "https://someone-else.test" }),
        oidc({ email: "intruder@evil.iam.gserviceaccount.com" }),
        oidc({ exp: Math.floor(Date.now() / 1000) - 3600 }),
        "not-a-token",
      ]) {
        expect((await postGoogle(rtdn(4, purchaseToken), "m-bad", bad)).status).toBe(403);
      }
      const noAuth = await http()
        .post("/webhooks/stores/google")
        .set("Content-Type", "application/json")
        .send("{}");
      expect(noAuth.status).toBe(403);
      expect(await count("SELECT 1 FROM store_notification")).toBe(0);
      const deliveries = await Promise.all([
        postGoogle(rtdn(4, purchaseToken), "m-1"),
        postGoogle(rtdn(4, purchaseToken), "m-1"),
      ]);
      expect(deliveries.map((delivery) => delivery.status)).toEqual([200, 200]);
      await settled();
      expect(await count("SELECT 1 FROM store_notification")).toBe(1);
      expect((await subscriptionOf(who))!.status).toBe("active");
      expect(stores.acknowledged).toEqual([purchaseToken]);
      expect(await count("SELECT 1 FROM store_notification WHERE purchase_token IS NOT NULL")).toBe(
        0,
      );
      // An unknown code and a test notification are kept, nothing more.
      await postGoogle(rtdn(77, purchaseToken), "m-77");
      await postGoogle({ testNotification: { version: "1.0" } }, "m-test");
      const { rows } = await db.query<{ notification_type: string; result: string }>(
        "SELECT notification_type, result FROM store_notification WHERE notification_id IN ('m-77','m-test') ORDER BY notification_id",
      );
      expect(rows).toEqual([
        { notification_type: "unknown:77", result: "unknown" },
        { notification_type: "test", result: "ignored" },
      ]);
    });

    it("a refund (Apple) and a voided purchase (Google) end access now; an earlier order keeps its code", async () => {
      const of = await anOffer();
      const apple = await customer();
      const otid = newOtid();
      const expires = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: apple.accountId, expires });
      await ok(syncApple(apple, appleTransaction(otid, apple.accountId, expires)), (body) => body);
      const order = await placed(apple, of);
      await postApple(
        appleNotice({
          type: "REFUND",
          otid,
          account: apple.accountId,
          expires,
          revocation: Date.now(),
        }).body,
      );
      await settled();
      expect((await subscriptionOf(apple))!.status).toBe("expired");
      expect(await hasAccess(apple)).toBe(false);
      expectError(await place(apple, of), 403, "SUBSCRIPTION_REQUIRED");
      const kept = await ok(
        apple.as("get", `/orders/${order.id}`),
        (body) => userOrderResponseSchema.parse(body).order,
      );
      expect(kept.confirmation?.code).toBe(order.confirmation?.code);

      const google = await customer();
      const purchaseToken = newToken();
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: google.accountId,
        expiry: expires,
      });
      await ok(syncGoogle(google, purchaseToken), (body) => body);
      await postGoogle(
        {
          voidedPurchaseNotification: {
            purchaseToken,
            orderId: "GPA.1234",
            productType: 1,
            refundType: 1,
          },
        },
        "m-void",
      );
      await settled();
      expect((await subscriptionOf(google))!.status).toBe("expired");
      expect(await hasAccess(google)).toBe(false);
      // Google's revocation: the state says expired.
      const revoked = await customer();
      const revokedToken = newToken();
      stores.google.set(revokedToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: revoked.accountId,
        expiry: expires,
      });
      await ok(syncGoogle(revoked, revokedToken), (body) => body);
      stores.google.get(revokedToken)!.state = "SUBSCRIPTION_STATE_EXPIRED";
      await postGoogle(rtdn(12, revokedToken), "m-revoke");
      await settled();
      expect((await subscriptionOf(revoked))!.status).toBe("expired");
    });
  });

  // ------------------------------------------------------ ARCHITECTURE 18.10

  describe("ARCHITECTURE 18.10 (AC-3)", () => {
    it("Apple, steps 1–8: buy on iPhone, the account on Android, grace, its push and reminder, the end, a new purchase on Android", async () => {
      const of = await anOffer();
      await settings.set({ user_billing_reminder_days: 3, store_lag_tolerance_hours: 48 });
      // 1. Bought on the iPhone.
      const iphone = await customer(IOS);
      const otid = newOtid();
      const term = Date.now() + 25 * DAY;
      stores.apple.set(otid, { status: 1, account: iphone.accountId, expires: term });
      const bought = await ok(
        syncApple(iphone, appleTransaction(otid, iphone.accountId, term)),
        (body) => mySubscriptionResponseSchema.parse(body),
      );
      expect(bought.subscription).toMatchObject({ status: "active", platform: "ios" });
      // Apple's SUBSCRIBED comes after: the same purchase, applied without a second subscription.
      await postApple(
        appleNotice({
          type: "SUBSCRIBED",
          subtype: "INITIAL_BUY",
          otid,
          account: iphone.accountId,
          expires: term,
        }).body,
      );
      await settled();
      expect(await count("SELECT 1 FROM subscription")).toBe(1);
      // 2. The same account on Android: the status is the account's.
      const android = await onAndroid(iphone);
      const onSecond = await mine(android);
      expect(onSecond.subscription).toMatchObject({
        status: "active",
        platform: "ios",
        provider: "store",
      });
      expect(stores.calls.filter((line) => line.includes("androidpublisher"))).toEqual([]);
      // 3. An order on Android.
      const early = await placed(android, of);
      // 4. The renewal fails; Apple keeps a grace — its end is Apple's.
      const graceEnd = Date.now() + 16 * DAY;
      await postApple(
        appleNotice({
          type: "DID_FAIL_TO_RENEW",
          subtype: "GRACE_PERIOD",
          otid,
          account: iphone.accountId,
          expires: term,
          grace: graceEnd,
        }).body,
      );
      await settled();
      const inGrace = (await subscriptionOf(iphone))!;
      expect(inGrace.status).toBe("grace");
      expect(inGrace.grace_until!.getTime()).toBe(graceEnd);
      const pushes = await db.query<{ template_code: string; recipient_account_id: string }>(
        "SELECT template_code, recipient_account_id FROM notification WHERE event_kind = 'payment_failed' AND channel = 'push'",
      );
      expect(pushes.rows).toEqual([
        { template_code: "payment_failed", recipient_account_id: iphone.accountId },
      ]);
      // The same notification again: no second push.
      await postApple(
        appleNotice({
          type: "DID_FAIL_TO_RENEW",
          subtype: "GRACE_PERIOD",
          otid,
          account: iphone.accountId,
          expires: term,
          grace: graceEnd,
        }).body,
      );
      await settled();
      expect(
        await count(
          "SELECT 1 FROM notification WHERE event_kind = 'payment_failed' AND channel = 'push'",
        ),
      ).toBe(1);
      // 5. The grace: orders pass; the reminder comes `user_billing_reminder_days` before its end, once.
      await placed(iphone, of);
      expect(await storesOf().remindGrace()).toBe(0);
      await db.query(
        "UPDATE subscription SET grace_until = now() + interval '2 days' WHERE id = $1",
        [inGrace.id],
      );
      expect(await storesOf().remindGrace()).toBe(1);
      expect(await storesOf().remindGrace()).toBe(0);
      expect(
        await count(
          "SELECT 1 FROM notification WHERE event_kind = 'payment_failed' AND channel = 'push'",
        ),
      ).toBe(2);
      // 6. The grace over: Apple stops access (billing retry) — no new orders, the earlier ones keep their codes.
      await postApple(
        appleNotice({
          type: "GRACE_PERIOD_EXPIRED",
          otid,
          account: iphone.accountId,
          expires: term,
        }).body,
      );
      await settled();
      expect((await subscriptionOf(iphone))!.status).toBe("suspended");
      expectError(await place(android, of), 403, "SUBSCRIPTION_REQUIRED");
      const stillThere = await ok(
        android.as("get", `/orders/${early.id}`),
        (body) => userOrderResponseSchema.parse(body).order,
      );
      expect(stillThere.confirmation?.code).toBe(early.confirmation?.code);
      // 7. Bought again later, on Android: a new subscription, the old one ends.
      const purchaseToken = newToken();
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: iphone.accountId,
        expiry: Date.now() + 30 * DAY,
      });
      const again = await ok(syncGoogle(android, purchaseToken), (body) =>
        mySubscriptionResponseSchema.parse(body),
      );
      expect(again.subscription).toMatchObject({ status: "active", platform: "android" });
      const all = await db.query<{ status: string; purchase_platform: string }>(
        "SELECT status, purchase_platform FROM subscription WHERE account_id = $1 ORDER BY created_at",
        [iphone.accountId],
      );
      expect(all.rows).toEqual([
        { status: "expired", purchase_platform: "ios" },
        { status: "active", purchase_platform: "android" },
      ]);
      await placed(android, of);
    });

    it("Apple, step 8: the notifications lost — the reconciliation asks Apple; Apple down — unconfirmed, then ended, then renewed backdated", async () => {
      await settings.set({ store_lag_tolerance_hours: 48 });
      const who = await customer();
      const otid = newOtid();
      const term = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires: term });
      await ok(syncApple(who, appleTransaction(otid, who.accountId, term)), (body) => body);
      const id = (await subscriptionOf(who))!.id;
      // The term passed, no word came; Apple renewed it meanwhile.
      await db.query(
        "UPDATE subscription SET current_period_end = now() - interval '1 hour' WHERE id = $1",
        [id],
      );
      await db.query("UPDATE store_purchase SET last_sync_at = now() - interval '2 hours'");
      const renewedTo = Date.now() + 29 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires: renewedTo });
      expect((await storesOf().reconcile()).asked).toBe(1);
      expect((await subscriptionOf(who))!).toMatchObject({
        status: "active",
        current_period_end: new Date(renewedTo),
      });
      expect(await hasAccess(who)).toBe(true);
      // Again the term passes; this time Apple doesn't answer.
      await db.query(
        "UPDATE subscription SET current_period_end = now() - interval '1 hour' WHERE id = $1",
        [id],
      );
      await db.query("UPDATE store_purchase SET last_sync_at = now() - interval '2 hours'");
      stores.down = true;
      expect((await storesOf().reconcile()).failed).toBe(1);
      await expireRun();
      expect((await subscriptionOf(who))!.status).toBe("expired_unconfirmed");
      expect(await hasAccess(who)).toBe(true);
      await db.query(
        "UPDATE subscription SET unconfirmed_since = now() - interval '49 hours', current_period_end = now() - interval '49 hours' WHERE id = $1",
        [id],
      );
      await expireRun();
      expect((await subscriptionOf(who))!.status).toBe("expired");
      expect(await hasAccess(who)).toBe(false);
      // Apple answers again: it was paid — active backdated.
      stores.down = false;
      await db.query("UPDATE store_purchase SET last_sync_at = now() - interval '2 hours'");
      const paidTo = Date.now() + 28 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires: paidTo });
      expect((await storesOf().reconcile()).asked).toBe(1);
      expect((await subscriptionOf(who))!).toMatchObject({
        status: "active",
        current_period_end: new Date(paidTo),
      });
      expect(await hasAccess(who)).toBe(true);
    });

    it("Google, steps 1, 4–7: bought, the grace and its push, paid before the reminder, on hold, bought again", async () => {
      const of = await anOffer();
      await settings.set({ user_billing_reminder_days: 3 });
      const who = await customer(ANDROID);
      // 1. Bought.
      const purchaseToken = newToken();
      const expiry = Date.now() + 30 * DAY;
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: who.accountId,
        expiry,
      });
      await ok(syncGoogle(who, purchaseToken), (body) => body);
      // 4. In grace: the state says so, its end is Google's.
      const graceEnd = Date.now() + 10 * DAY;
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
        account: who.accountId,
        expiry: graceEnd,
        acknowledged: true,
      });
      await postGoogle(rtdn(6, purchaseToken), "m-grace");
      await settled();
      const inGrace = (await subscriptionOf(who))!;
      expect(inGrace.status).toBe("grace");
      expect(inGrace.grace_until!.getTime()).toBe(graceEnd);
      expect(
        await count(
          "SELECT 1 FROM notification WHERE event_kind = 'payment_failed' AND channel = 'push'",
        ),
      ).toBe(1);
      // 5. Orders pass in the grace; 5a — paid before the reminder: the reminder never comes.
      await placed(who, of);
      const renewed = Date.now() + 40 * DAY;
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: who.accountId,
        expiry: renewed,
        acknowledged: true,
      });
      await postGoogle(rtdn(1, purchaseToken), "m-recovered");
      await settled();
      expect((await subscriptionOf(who))!.status).toBe("active");
      await settings.set({ user_billing_reminder_days: 30 });
      expect(await storesOf().remindGrace()).toBe(0);
      expect(
        await count(
          "SELECT 1 FROM notification WHERE event_kind = 'payment_failed' AND channel = 'push'",
        ),
      ).toBe(1);
      // 6. On hold: access stops.
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ON_HOLD",
        account: who.accountId,
        expiry: renewed,
        acknowledged: true,
      });
      await postGoogle(rtdn(5, purchaseToken), "m-hold");
      await settled();
      expect((await subscriptionOf(who))!.status).toBe("suspended");
      expectError(await place(who, of), 403, "SUBSCRIPTION_REQUIRED");
      // 7. Bought again: a new token naming the old one; the old purchase ends.
      const newer = newToken();
      stores.google.set(newer, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: who.accountId,
        expiry: Date.now() + 30 * DAY,
        linked: purchaseToken,
      });
      const again = await ok(syncGoogle(who, newer), (body) =>
        mySubscriptionResponseSchema.parse(body),
      );
      expect(again.subscription).toMatchObject({ status: "active", platform: "android" });
      const { rows } = await db.query<{ status: string; provider_ref: string }>(
        "SELECT status, provider_ref FROM subscription WHERE account_id = $1 ORDER BY created_at",
        [who.accountId],
      );
      expect(rows).toEqual([
        { status: "expired", provider_ref: googleRef(purchaseToken) },
        { status: "active", provider_ref: googleRef(newer) },
      ]);
    });
  });

  // ---------------------------------------------------------- the signal

  describe("store_sync_stale (AC-4)", () => {
    it("opens when a store hasn't answered for longer than the setting and closes at its first answer", async () => {
      await settings.set({ store_outage_signal_hours: 1 });
      const who = await customer();
      const otid = newOtid();
      const term = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires: term });
      await ok(syncApple(who, appleTransaction(otid, who.accountId, term)), (body) => body);
      expect((await storesOf().watch()).worked).toBe(false);
      await db.query(
        "UPDATE store_api_health SET last_success_at = now() - interval '2 hours' WHERE platform = 'ios'",
      );
      await storesOf().watch();
      await storesOf().watch();
      token = await setUpAdmin(ADMIN_PHONE);
      const open = await ok(
        asAdmin("get", "/admin/signals?kind=store_sync_stale&status=open"),
        (body) => adminSignalPageSchema.parse(body),
      );
      expect(open.signals).toHaveLength(1);
      expect(open.signals[0]).toMatchObject({
        kind: "store_sync_stale",
        subjectType: "channel",
        payload: { storePlatform: "ios", storeSubscriptions: 1, storeMissing: [], windowHours: 1 },
      });
      // Google has no subscriptions: no signal about it.
      await db.query(
        "INSERT INTO store_api_health (platform, last_success_at) VALUES ('android', now() - interval '10 hours')",
      );
      await storesOf().watch();
      expect(await count("SELECT 1 FROM admin_signal WHERE kind = 'store_sync_stale'")).toBe(1);
      // The first successful call closes it.
      await ok(syncApple(who, appleTransaction(otid, who.accountId, term)), (body) => body);
      await storesOf().watch();
      const after = await ok(
        asAdmin("get", "/admin/signals?kind=store_sync_stale&status=closed"),
        (body) => adminSignalPageSchema.parse(body),
      );
      expect(after.signals).toHaveLength(1);
      expect(after.signals[0]!.payload.endedAt).toBeTruthy();
    });
  });

  // ---------------------------------------------------- the dev command

  describe("dev:stores:notify and the admin card (AC-5)", () => {
    it("imitates App Store's grace through the HTTP route: the push is queued; the admin sees the store's word", async () => {
      const who = await customer();
      const otid = newOtid();
      const term = Date.now() + 30 * DAY;
      const operator = app.get(BillingOperator);
      const port = (app.getHttpServer().address() as AddressInfo | null)?.port;
      if (!port) await app.listen(0, "127.0.0.1");
      Object.assign(config, { port: (app.getHttpServer().address() as AddressInfo).port });
      const bought = await operator.storeNotify({
        phone: who.phone,
        store: "apple",
        type: "SUBSCRIBED",
        subtype: "INITIAL_BUY",
        ref: otid,
        until: new Date(term),
        twice: true,
        badSignature: false,
      });
      expect(bought.deliveries.map((delivery) => delivery.status)).toEqual([200, 200]);
      await settled();
      await operator.storeNotify({
        phone: who.phone,
        store: "apple",
        type: "DID_FAIL_TO_RENEW",
        subtype: "GRACE_PERIOD",
        ref: otid,
        until: new Date(term),
        graceUntil: new Date(Date.now() + 16 * DAY),
        twice: false,
        badSignature: false,
      });
      await settled();
      expect((await subscriptionOf(who))!.status).toBe("grace");
      expect(
        await count(
          "SELECT 1 FROM notification WHERE event_kind = 'payment_failed' AND channel = 'push' AND recipient_account_id = $1",
          [who.accountId],
        ),
      ).toBe(1);
      const forged = await operator.storeNotify({
        phone: who.phone,
        store: "apple",
        type: "EXPIRED",
        ref: otid,
        twice: false,
        badSignature: true,
      });
      expect(forged.deliveries[0]!.status).toBe(403);
      token = await setUpAdmin(ADMIN_PHONE);
      const card = await ok(asAdmin("get", `/admin/users/${who.accountId}/subscription`), (body) =>
        adminUserSubscriptionResponseSchema.parse(body),
      );
      expect(card.store).toMatchObject({
        platform: "ios",
        environment: "sandbox",
        productId: APPLE_PRODUCT,
        lastWord: "DID_FAIL_TO_RENEW/GRACE_PERIOD",
      });
    });
  });

  // ------------------------------------------------- what leaves the process

  describe("what leaves the process (AC-6)", () => {
    it("keeps no JWS and no purchase token in the journal, the events or the deliveries", async () => {
      const who = await customer();
      const otid = newOtid();
      const term = Date.now() + 30 * DAY;
      stores.apple.set(otid, { status: 1, account: who.accountId, expires: term });
      const jws = appleTransaction(otid, who.accountId, term);
      await ok(syncApple(who, jws), (body) => body);
      const purchaseToken = newToken();
      const other = await customer();
      stores.google.set(purchaseToken, {
        state: "SUBSCRIPTION_STATE_ACTIVE",
        account: other.accountId,
        expiry: term,
      });
      await ok(syncGoogle(other, purchaseToken), (body) => body);
      await postGoogle(rtdn(2, purchaseToken), "m-leak");
      await postApple(
        appleNotice({ type: "DID_RENEW", otid, account: who.accountId, expires: term + DAY }).body,
      );
      await settled();
      const dump = await db.query<{ text: string }>(
        `SELECT coalesce(json_agg(a)::text, '') AS text FROM audit_log a
         UNION ALL SELECT coalesce(json_agg(e)::text, '') FROM billing_event e
         UNION ALL SELECT coalesce(json_agg(n)::text, '') FROM store_notification n
         UNION ALL SELECT coalesce(json_agg(s)::text, '') FROM subscription s`,
      );
      const text = dump.rows.map((row) => row.text).join("\n");
      expect(text).not.toContain(purchaseToken);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.eyJ/);
      expect(text).toContain(googleRef(purchaseToken));
      // The token lives in one place: the purchase, for the calls of the Play API.
      expect(
        await count("SELECT 1 FROM store_purchase WHERE purchase_token = $1", [purchaseToken]),
      ).toBe(1);
    });
  });
});
