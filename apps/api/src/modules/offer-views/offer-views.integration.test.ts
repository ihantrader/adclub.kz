import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminHomeSchema,
  adminSignalPageSchema,
  adminSupplierResponseSchema,
  adminSupplierViewsResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  showcaseItemResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminSignal,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
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
import type { JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { almatyDayOf, OfferViews } from "./offer-views";
import { OfferViewsService, shiftDay } from "./offer-views.service";

/**
 * TASK-070 on a real PostgreSQL and Redis with the API and a worker: the
 * card of an item and M-CAT-09 count a view of every offer shown, with the
 * kind of the viewer; a second look the same day counts nothing, two
 * recorders (two replicas) don't count one twice, an employee looking at
 * their own company is left out, a paused supplier's offer is not shown and
 * so not viewed; the answer never waits for the write and a refused write
 * never breaks it; test orders don't count; the daily job opens the signal,
 * closes it by itself, doesn't open it again after an administrator closed
 * it until a lower conversion or a window later; the raw views go by their
 * term; who may read the admin route.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const DAY = 24 * 3_600_000;

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

describe("views of offers and the signal of a gap (PostgreSQL + Redis + worker)", () => {
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
    // Whatever a previous test left waiting is written before the tables are emptied.
    await recorder().flush();
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
  const recorder = () => app.get(OfferViews);

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
    ip = nextIp(),
  ) {
    let test = http()[method](path).set("X-Client", client).set("X-Forwarded-For", ip);
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
    name: string;
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
      phone,
      name,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function put(of: Company, price = 6_500): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price,
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
    bearer: string;
    as: As;
  }

  async function grantAccess(phone: string): Promise<void> {
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

  async function customer(options: { phone?: string; access?: boolean } = {}): Promise<Customer> {
    const phone = options.phone ?? `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS);
    if (options.access !== false) {
      await grantAccess(phone);
    }
    return { phone, bearer, as: (method, path, body) => call(bearer, IOS, method, path, body) };
  }

  async function place(who: Customer, offer: SupplierOffer): Promise<string> {
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
        return order.id;
      },
      201,
    );
  }

  /** The card of the pads, as a guest (`bearer` null) from `ip`, or a session. */
  function card(bearer: string | null, ip = nextIp()): Test {
    return call(bearer, IOS, "get", `/catalog/items/${padsId}?cityId=${almaty}`, undefined, ip);
  }

  async function daily(): Promise<{ offer_id: string; viewer_kind: string; views: number }[]> {
    const { rows } = await db.query<{ offer_id: string; viewer_kind: string; views: number }>(
      "SELECT offer_id, viewer_kind, views FROM offer_view_daily ORDER BY offer_id, viewer_kind",
    );
    return rows;
  }

  async function views(supplierId: string, query = "") {
    return ok(asAdmin("get", `/admin/suppliers/${supplierId}/views${query}`), (body) =>
      adminSupplierViewsResponseSchema.parse(body),
    ).then((body) => body.views);
  }

  // ---------------------------------------------------------------- views

  describe("counting a view", () => {
    it("counts every offer of the card and M-CAT-09 by kind of viewer, once a day", async () => {
      const [north, south] = [await company("Север"), await company("Юг")];
      const [first, second] = [await put(north, 6_000), await put(south, 7_000)];
      const member = await customer();
      const plain = await customer({ access: false });

      // A guest from one address, twice — one view of each offer.
      const shown = await ok(card(null, "203.0.113.7"), (body) =>
        showcaseItemResponseSchema.parse(body),
      );
      expect(shown.offers.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
      await ok(card(null, "203.0.113.7"), (body) => body);
      // A user without club access, a member — twice each, from any address.
      for (let look = 0; look < 2; look += 1) {
        await ok(card(plain.bearer), (body) => body);
        await ok(card(member.bearer), (body) => body);
      }
      // M-CAT-09 from the first offer: the member again (same day — nothing), and another member.
      await ok(member.as("get", `/catalog/offers/${first.id}/supplier`), (body) => body);
      const another = await customer();
      await ok(another.as("get", `/catalog/offers/${first.id}/supplier`), (body) => body);
      await recorder().flush();

      const byOffer = (offerId: string) =>
        Object.fromEntries(
          rows.filter((row) => row.offer_id === offerId).map((row) => [row.viewer_kind, row.views]),
        );
      const rows = await daily();
      expect(byOffer(first.id)).toEqual({ guest: 1, user: 1, club: 2 });
      expect(byOffer(second.id)).toEqual({ guest: 1, user: 1, club: 1 });

      // The raw views name nobody: a key, a kind, the day.
      const raw = await db.query<{ viewer_key: string; day: string }>(
        "SELECT viewer_key, day::text AS day FROM offer_view_event",
      );
      expect(raw.rowCount).toBe(7);
      for (const row of raw.rows) {
        expect(row.viewer_key).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(row.viewer_key).not.toContain(member.phone);
        expect(row.day).toBe(almatyDayOf(new Date()));
      }

      // The admin's view: today's numbers.
      const shownToAdmin = await views(north.supplierId);
      expect(shownToAdmin.days).toHaveLength(30);
      expect(shownToAdmin.days.at(-1)).toEqual({
        day: almatyDayOf(new Date()),
        club: 2,
        user: 1,
        guest: 1,
        total: 4,
        orders: 0,
        conversion: 0,
      });
      expect(shownToAdmin.total).toMatchObject({ club: 2, total: 4, orders: 0 });
    });

    it("leaves out an employee looking at their own company, not at another", async () => {
      const [own, other] = [await company("Свой"), await company("Чужой")];
      const [ownOffer, otherOffer] = [await put(own, 6_000), await put(other, 7_000)];
      // The employee of «Свой» signs in to the app with club access.
      const employee = await customer({ phone: own.phone });
      await ok(card(employee.bearer), (body) => body);
      await recorder().flush();
      const rows = await daily();
      expect(rows.filter((row) => row.offer_id === ownOffer.id)).toEqual([]);
      expect(rows.filter((row) => row.offer_id === otherOffer.id)).toEqual([
        { offer_id: otherOffer.id, viewer_kind: "club", views: 1 },
      ]);
    });

    it("counts no view of an offer not shown (a paused supplier); the past ones stay", async () => {
      const shop = await company("Пауза");
      const offer = await put(shop);
      const member = await customer();
      await ok(card(member.bearer), (body) => body);
      await recorder().flush();
      expect(await daily()).toEqual([{ offer_id: offer.id, viewer_kind: "club", views: 1 }]);

      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM supplier WHERE id = $1",
        [shop.supplierId],
      );
      await ok(
        asAdmin("post", `/admin/suppliers/${shop.supplierId}/pause`, {
          expectedVersion: rows[0]!.version,
          paused: true,
          reason: "admin",
          note: "Проверка",
        }),
        (body) => body,
      );
      const another = await customer();
      const shown = await ok(card(another.bearer), (body) =>
        showcaseItemResponseSchema.parse(body),
      );
      expect(shown.offers).toEqual([]);
      expectError(
        await another.as("get", `/catalog/offers/${offer.id}/supplier`),
        404,
        "NOT_FOUND",
      );
      await recorder().flush();
      expect(await daily()).toEqual([{ offer_id: offer.id, viewer_kind: "club", views: 1 }]);
    });

    it("does not count one view twice from two replicas at once", async () => {
      const shop = await company("Реплики");
      const offer = await put(shop);
      const member = await customer();
      const accountId = await idOf("SELECT id FROM account WHERE phone = $1", [member.phone]);
      // Two recorders — two processes of the API — saw the same member the same day.
      const replicas = [0, 1].map(() => new OfferViews(app.get(DatabaseService), config));
      for (const replica of replicas) {
        replica.seen({ accountId, clubAccess: true }, [offer.id, offer.id], "203.0.113.9");
      }
      await Promise.all(replicas.map((replica) => replica.flush()));
      await Promise.all(replicas.map((replica) => replica.flush()));
      expect(await daily()).toEqual([{ offer_id: offer.id, viewer_kind: "club", views: 1 }]);
    });

    it("answers the card without waiting for the write, and a refused write breaks nothing", async () => {
      const shop = await company("Сбой");
      const offer = await put(shop);
      const member = await customer();

      // The raw views are locked by somebody else: the card answers at once anyway.
      const locker = new Client({ connectionString: postgres.getConnectionUri() });
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE offer_view_event IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await ok(card(member.bearer), (body) => body);
      expect(Date.now() - started).toBeLessThan(2_000);
      await locker.query("ROLLBACK");
      await locker.end();
      await recorder().flush();
      expect(await daily()).toEqual([{ offer_id: offer.id, viewer_kind: "club", views: 1 }]);

      // The table is gone: 200 still, the write fails, the view waits for the next try.
      await db.query("ALTER TABLE offer_view_event RENAME TO offer_view_event_away");
      try {
        const another = await customer();
        const shown = await card(another.bearer);
        expect(shown.status).toBe(200);
        // The process's own timer may try first; this try comes after it, and fails too.
        const refused = await recorder().flush();
        expect(refused).toMatchObject({ written: 0, failed: 1 });
      } finally {
        await db.query("ALTER TABLE offer_view_event_away RENAME TO offer_view_event");
      }
      await recorder().flush();
      expect(recorder().waiting).toBe(0);
      expect(await daily()).toEqual([{ offer_id: offer.id, viewer_kind: "club", views: 2 }]);
    });
  });

  // -------------------------------------------------------- orders, period

  describe("the numbers of the admin panel", () => {
    it("counts the orders that count in statistics, not test orders of an employee", async () => {
      const [shop, other] = [await company("Магазин"), await company("Другой")];
      const offer = await put(shop);
      await put(other, 7_000);
      const member = await customer();
      await place(member, offer);
      // The employee of «Магазин» orders at their own company — a test order.
      const employee = await customer({ phone: shop.phone });
      const testOrder = await place(employee, offer);
      const { rows } = await db.query<{ is_test: boolean }>(
        "SELECT is_test FROM customer_order WHERE id = $1",
        [testOrder],
      );
      expect(rows[0]!.is_test).toBe(true);
      const shown = await views(shop.supplierId);
      expect(shown.total.orders).toBe(1);
      expect(shown.days.at(-1)!.orders).toBe(1);
    });

    it("takes a period of days and refuses a wrong one", async () => {
      const shop = await company("Период");
      const today = almatyDayOf(new Date());
      const week = await views(shop.supplierId, `?from=${shiftDay(today, -6)}&to=${today}`);
      expect(week.days.map((entry) => entry.day)).toEqual(
        [6, 5, 4, 3, 2, 1, 0].map((back) => shiftDay(today, -back)),
      );
      expect(week.signal).toEqual({ windowDays: 30, minViews: 200, minSuppliers: 5, ratio: 0.3 });
      expectError(
        await asAdmin(
          "get",
          `/admin/suppliers/${shop.supplierId}/views?from=${today}&to=${shiftDay(today, -1)}`,
        ),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin(
          "get",
          `/admin/suppliers/${shop.supplierId}/views?from=${shiftDay(today, -400)}`,
        ),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("get", `/admin/suppliers/${shop.supplierId}/views?from=15.11.2026`),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("lets only an administrator read it", async () => {
      const shop = await company("Доступ");
      const path = `/admin/suppliers/${shop.supplierId}/views`;
      expectError(await call(null, ADMIN_WEB, "get", path), 401, "AUTH_REQUIRED");
      const member = await customer();
      expectError(await member.as("get", path), 403, "FORBIDDEN");
      expectError(await shop.as("get", path), 403, "FORBIDDEN");
      expectError(await asAdmin("get", `/admin/suppliers/${randomUUID()}/views`), 404, "NOT_FOUND");
      await ok(asAdmin("get", path), (body) => adminSupplierViewsResponseSchema.parse(body));
    });
  });

  // -------------------------------------------------------------- signal

  describe("the signal «Просмотров много, заявок мало»", () => {
    const yesterday = () => shiftDay(almatyDayOf(new Date()), -1);

    /** `club` views of an offer on a day, written as the recorder would have. */
    async function viewed(
      offer: SupplierOffer,
      supplierId: string,
      count: number,
      day = yesterday(),
    ) {
      await db.query(
        `INSERT INTO offer_view_daily (offer_id, day, viewer_kind, supplier_id, views)
         VALUES ($1, $2, 'club', $3, $4)
         ON CONFLICT (offer_id, day, viewer_kind) DO UPDATE SET views = EXCLUDED.views`,
        [offer.id, day, supplierId, count],
      );
    }

    /** `count` orders placed yesterday. */
    async function ordered(who: Customer, offer: SupplierOffer, count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        ids.push(await place(who, offer));
      }
      await db.query(
        "UPDATE customer_order SET created_at = now() - interval '1 day' WHERE id = ANY($1)",
        [ids],
      );
      return ids;
    }

    async function signals(supplierId: string): Promise<AdminSignal[]> {
      return ok(
        asAdmin(
          "get",
          `/admin/signals?kind=views_orders_gap&status=current&subjectId=${supplierId}`,
        ),
        (body) => adminSignalPageSchema.parse(body).signals,
      );
    }

    const run = () => worker.get(OfferViewsService).run();

    it("opens, refreshes once a day, closes by itself, holds back after an administrator", async () => {
      await settings.set({ views_signal_min: 10, views_signal_min_suppliers: 3 });
      const member = await customer();
      const shops = [await company("А"), await company("Б"), await company("В")];
      const offers = [await put(shops[0]!), await put(shops[1]!), await put(shops[2]!)];
      // Conversions 30 %, 20 %, 20 % over 10 views each.
      for (const [index, orders] of [3, 2, 2].entries()) {
        await viewed(offers[index]!, shops[index]!.supplierId, 10);
        await ordered(member, offers[index]!, orders);
      }
      // «Г»: 1 order of 20 views — 5 %, below the median (20 %) × 0.3 = 6 %.
      const gap = await company("Г");
      const gapOffer = await put(gap);
      await viewed(gapOffer, gap.supplierId, 20);
      await ordered(member, gapOffer, 1);
      // A test order of an employee counts nothing (it would lift «Г» to 10 %).
      const employee = await customer({ phone: gap.phone });
      const test = await place(employee, gapOffer);
      await db.query(
        "UPDATE customer_order SET created_at = now() - interval '1 day' WHERE id = $1",
        [test],
      );

      await run();
      const [raised] = await signals(gap.supplierId);
      expect(raised).toMatchObject({
        status: "open",
        times: 1,
        subjectType: "supplier",
        payload: {
          supplierId: gap.supplierId,
          supplierName: "Г",
          views: 20,
          orders: 1,
          conversion: 0.05,
          medianConversion: 0.2,
          suppliersInMedian: 4,
          windowDays: 30,
          periodFrom: shiftDay(almatyDayOf(new Date()), -30),
          periodTo: yesterday(),
        },
      });
      expect(raised!.payload.conversionThreshold).toBeCloseTo(0.06, 12);
      for (const shop of shops) {
        expect(await signals(shop.supplierId)).toEqual([]);
      }
      // On the home screen and in «Сигналы».
      const home = await ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
      expect(home.signals.find((entry) => entry.kind === "views_orders_gap")).toEqual({
        kind: "views_orders_gap",
        open: 1,
        acknowledged: 0,
      });

      // The same day again — one signal, nothing new.
      await run();
      expect((await signals(gap.supplierId)).map((entry) => entry.times)).toEqual([1]);

      // «Г» gets orders: 5 of 20 = 25 % — the gap is gone, the signal closes by itself.
      const lifted = await ordered(member, gapOffer, 4);
      await run();
      expect(await signals(gap.supplierId)).toEqual([]);
      const closedBySelf = await db.query<{ closed_by_admin_id: string | null; payload: unknown }>(
        "SELECT closed_by_admin_id, payload FROM admin_signal WHERE kind = 'views_orders_gap' AND status = 'closed'",
      );
      expect(closedBySelf.rows).toHaveLength(1);
      expect(closedBySelf.rows[0]!.closed_by_admin_id).toBeNull();

      // The orders gone from the window: the gap again — a server's close holds nothing back.
      await db.query(
        "UPDATE customer_order SET created_at = now() - interval '60 days' WHERE id = ANY($1)",
        [lifted],
      );
      await run();
      const [again] = await signals(gap.supplierId);
      expect(again).toMatchObject({ status: "open", payload: { conversion: 0.05 } });

      // An administrator closes it while the gap stays: not opened again…
      await ok(
        asAdmin("post", `/admin/signals/${again!.id}/close`, {
          expectedVersion: again!.version,
          comment: "Позвонили поставщику",
        }),
        (body) => body,
      );
      await run();
      expect(await signals(gap.supplierId)).toEqual([]);

      // …until the conversion falls lower: 1 of 40 = 2,5 %.
      await viewed(gapOffer, gap.supplierId, 40);
      await run();
      const [lower] = await signals(gap.supplierId);
      expect(lower).toMatchObject({ status: "open", payload: { views: 40, conversion: 0.025 } });

      // Closed again by an administrator, and a whole window passes: opened again.
      await ok(
        asAdmin("post", `/admin/signals/${lower!.id}/close`, {
          expectedVersion: lower!.version,
          comment: "Проверили",
        }),
        (body) => body,
      );
      await run();
      expect(await signals(gap.supplierId)).toEqual([]);
      await db.query(
        "UPDATE admin_signal SET closed_at = closed_at - interval '30 days' WHERE kind = 'views_orders_gap'",
      );
      await run();
      expect(await signals(gap.supplierId)).toHaveLength(1);
    });

    it("raises nothing with too few suppliers to compare", async () => {
      await settings.set({ views_signal_min: 10 });
      const member = await customer();
      const shops = [await company("Один"), await company("Два")];
      const offers = [await put(shops[0]!), await put(shops[1]!)];
      await viewed(offers[0]!, shops[0]!.supplierId, 100);
      await ordered(member, offers[0]!, 5);
      await viewed(offers[1]!, shops[1]!.supplierId, 100);
      const outcome = await run();
      expect(outcome).toMatchObject({ judged: 2, raised: 0 });
      expect(await signals(shops[1]!.supplierId)).toEqual([]);
    });

    it("deletes the raw views past their term and keeps the daily totals", async () => {
      const shop = await company("Срок");
      const offer = await put(shop);
      const today = almatyDayOf(new Date());
      for (const back of [91, 89]) {
        await db.query(
          `INSERT INTO offer_view_event (offer_id, day, viewer_key, viewer_kind, supplier_id)
           VALUES ($1, $2, $3, 'club', $4)`,
          [offer.id, shiftDay(today, -back), `key-of-test-${String(back)}-abcdef`, shop.supplierId],
        );
        await viewed(offer, shop.supplierId, 1, shiftDay(today, -back));
      }
      const outcome = await run();
      expect(outcome.removed).toBe(1);
      const left = await db.query<{ day: string }>("SELECT day::text AS day FROM offer_view_event");
      expect(left.rows.map((row) => row.day)).toEqual([shiftDay(today, -89)]);
      expect((await daily()).length).toBe(2);

      // A shorter term — by the setting.
      await settings.set({ offer_view_retention_days: 30 });
      expect((await run()).removed).toBe(1);
      expect((await db.query("SELECT 1 FROM offer_view_event")).rowCount).toBe(0);
    });
  });
});
