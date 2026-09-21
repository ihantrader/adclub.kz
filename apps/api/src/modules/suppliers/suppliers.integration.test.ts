import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityListResponseSchema,
  adminCityResponseSchema,
  adminSupplierLeadPageSchema,
  adminSupplierLeadResponseSchema,
  adminSupplierPageSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  cityListResponseSchema,
  compatibilityCheckResponseSchema,
  rateLimitedDetailsSchema,
  supplierCardResponseSchema,
  supplierCompanyResponseSchema,
  supplierInvitationResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminSupplierCard,
  type DayHours,
  type ErrorCode,
} from "@adclub/contracts";
import { kzBinCheckDigit } from "@adclub/domain";
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
import type { JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TcpProxy } from "../../testing/tcp-proxy";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import {
  devCities,
  devNewLead,
  devOnboardedLead,
  DevSupplierSeed,
  SupplierMessages,
  type TestSupplierMessages,
} from ".";

/**
 * TASK-016 end to end on a real PostgreSQL, with Redis behind a TCP proxy
 * (to take it away) and a real worker (invitations): the directory of
 * cities and the client list, the public connection request form (checks,
 * the same answer for a known БИН, the trap field, limits, masks in the
 * log), the funnel, creating a supplier from a request in one transaction
 * with its invitation, the card and the schedule, the states, the list,
 * the rate limit of open routes (and the pages of the compatibility
 * check), the access matrix and the development seed.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

const FAST: Partial<JobsTuning> = {
  pollingIntervalSeconds: 0.5,
  monitorIntervalSeconds: 1,
  superviseIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
  cronMonitorIntervalSeconds: 1,
  cronWorkerIntervalSeconds: 1,
  scheduleSyncIntervalMs: 500,
  startRetryMs: 300,
};

type Method = "get" | "post" | "put" | "patch" | "delete";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A valid БИН from its first 11 digits; the few 11 digits no check digit
 * exists for are moved by a million until one does (tests only need
 * distinct valid numbers).
 */
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

/** The same 11 digits with a wrong check digit. */
function wrongBin(first11: string): string {
  const right = kzBinCheckDigit(first11)!;
  return `${first11}${(right + 1) % 10}`;
}

const BIN_A = validBin("07123400011");
const BIN_B = validBin("19114000777");
const BIN_C = validBin("21054000333");

const nineToSix: DayHours["intervals"] = [{ from: "09:00", to: "18:00" }];
const WEEK: DayHours[] = [
  {
    day: 1,
    intervals: [
      { from: "09:00", to: "13:00" },
      { from: "14:00", to: "18:00" },
    ],
  },
  { day: 2, intervals: nineToSix },
  { day: 3, intervals: nineToSix },
  { day: 4, intervals: nineToSix },
  { day: 5, intervals: nineToSix },
  { day: 6, intervals: [{ from: "00:00", to: "24:00" }] },
  { day: 7, intervals: [] },
];

/** A date `days` from today in Almaty (`YYYY-MM-DD`). */
function almatyDate(days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

describe("cities and suppliers (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redisProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let messages: TestSupplierMessages;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
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
    redisProxy = new TcpProxy(redisContainer.getHost(), redisContainer.getPort());
    await redisProxy.start();
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: `redis://127.0.0.1:${redisProxy.port}`,
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test-secret",
      S3_BUCKET: "test",
      TRUST_PROXY: "true",
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
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    messages = worker.get(SupplierMessages) as TestSupplierMessages;
    settings = new TestSettings(app);
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await redisProxy?.stop();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    messages.sent.length = 0;
    messages.failing = false;
    lastSteps.clear();
    stepCookies.clear();
    await truncateAll();
    await redis.flushall();
    await settings.reload();
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  // ------------------------------------------------------------- plumbing

  async function truncateAll(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
        return;
      } catch (error) {
        if (attempt >= 10) {
          throw error;
        }
        await sleep(200);
      }
    }
  }

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
    for (const cookie of ([] as string[]).concat(response.headers["set-cookie"] ?? [])) {
      const step = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(cookie);
      if (step) {
        rememberSecret(step[2]!);
        stepCookies.set(step[1]!, `adclub_sign_in_${step[1]}=${step[2]}`);
      }
      const refresh = /^adclub_(?:admin|supplier)_refresh=([^;]+)/.exec(cookie);
      if (refresh) {
        rememberSecret(refresh[1]!);
      }
    }
    return response;
  }

  function stepPost(path: string, body: { signInStep: string }): Test {
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
    } as { signInStep: string });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return body.session.accessToken;
  }

  async function mobileToken(): Promise<string> {
    const response = await signIn(USER_PHONE, IOS);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  async function cabinetToken(phone: string): Promise<string> {
    const response = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function call(bearer: string, client: string, method: Method, path: string, body?: object) {
    const test = http()
      [method](path)
      .set("X-Client", client)
      .set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  const asAdmin = (method: Method, path: string, body?: object): Test =>
    call(token, ADMIN_WEB, method, path, body);

  const asSupplier = (bearer: string, method: Method, path: string, body?: object): Test =>
    call(bearer, SUPPLIER_WEB, method, path, body);

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

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]!.count);
  }

  async function auditOf(entityId: string): Promise<{ action: string; reason: string | null }[]> {
    const { rows } = await db.query<{ action: string; reason: string | null }>(
      "SELECT action, reason FROM audit_log WHERE entity_id = $1 ORDER BY created_at, id",
      [entityId],
    );
    return rows;
  }

  async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  // ---------------------------------------------------------------- world

  async function cities(): Promise<Map<string, string>> {
    await app.get(DevSupplierSeed).run();
    const { rows } = await db.query<{ id: string; code: string }>("SELECT id, code FROM city");
    return new Map(rows.map((row) => [row.code, row.id]));
  }

  interface FormInput {
    companyName?: string;
    bin?: string;
    cityId: string;
    type?: string;
    contactName?: string;
    phone?: string;
    consent?: unknown;
    website?: string;
    language?: string;
  }

  function form(input: FormInput, ip = nextIp()): Test {
    const body = {
      companyName: input.companyName ?? "Автосервис Плюс",
      bin: input.bin ?? BIN_B,
      cityId: input.cityId,
      type: input.type ?? "both",
      contactName: input.contactName ?? "Айгерим",
      phone: input.phone ?? "+7 701 555 66 77",
      consent: input.consent === undefined ? true : input.consent,
      ...(input.website === undefined ? {} : { website: input.website }),
      ...(input.language === undefined ? {} : { language: input.language }),
    };
    // Only whole numbers are looked for in the log (short fragments could match anything).
    if (/^\d{12}$/.test(body.bin)) {
      rememberCode(body.bin);
    }
    if (/^\+7\d{10}$/.test(body.phone.replace(/\s/g, ""))) {
      rememberCode(body.phone.replace(/\s/g, ""));
    }
    return http()
      .post("/supplier-leads")
      .set("X-Client", "supplier-web/0.1.0")
      .set("X-Forwarded-For", ip)
      .send(body);
  }

  async function leadIdByBin(bin: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM supplier_lead WHERE bin = $1 ORDER BY created_at DESC LIMIT 1",
      [bin],
    );
    return rows[0]!.id;
  }

  async function leadVersion(leadId: string): Promise<number> {
    const { rows } = await db.query<{ version: number }>(
      "SELECT version FROM supplier_lead WHERE id = $1",
      [leadId],
    );
    return rows[0]!.version;
  }

  async function moveLead(leadId: string, status: string, reason?: string): Promise<Response> {
    return asAdmin("post", `/admin/supplier-leads/${leadId}/status`, {
      expectedVersion: await leadVersion(leadId),
      status,
      ...(reason ? { reason } : {}),
    });
  }

  /** A request from the form worked through to a signed contract. */
  async function signedLead(cityId: string, bin: string, phone: string): Promise<string> {
    expect((await form({ cityId, bin, phone })).status).toBe(202);
    const leadId = await leadIdByBin(bin);
    for (const status of ["contacted", "meeting", "contract_signed"]) {
      expect((await moveLead(leadId, status)).status).toBe(200);
    }
    return leadId;
  }

  async function onboard(leadId: string, extra: object = {}) {
    return ok(
      asAdmin("post", `/admin/supplier-leads/${leadId}/onboard`, {
        expectedVersion: await leadVersion(leadId),
        address: "пр. Абая, 10",
        district: "Бостандыкский район",
        ...extra,
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
  }

  async function card(supplierId: string): Promise<AdminSupplierCard> {
    return ok(asAdmin("get", `/admin/suppliers/${supplierId}`), (body) =>
      adminSupplierResponseSchema.parse(body),
    ).then((body) => body.supplier);
  }

  // ---------------------------------------------------------------- cities

  describe("cities", () => {
    it("lists active cities for guests and every session, in the language asked, cacheable", async () => {
      const ids = await cities();
      // One city without a Kazakh name: Russian, marked as a fallback.
      await ok(
        asAdmin("post", "/admin/cities", { code: "zhezkazgan", names: { ru: "Жезказган" } }),
        (body) => adminCityResponseSchema.parse(body),
        201,
      );
      const guest = await http().get("/cities").set("Accept-Language", "kk");
      expect(guest.status).toBe(200);
      expect(guest.headers["cache-control"]).toBe("public, max-age=60");
      const list = cityListResponseSchema.parse(guest.body);
      expect(list.language).toBe("kk");
      expect(list.cities).toHaveLength(devCities.length + 1);
      expect(list.cities.find((c) => c.code === "ust-kamenogorsk")!.name).toEqual({
        text: "Өскемен",
        isFallback: false,
      });
      expect(list.cities.find((c) => c.code === "zhezkazgan")!.name).toEqual({
        text: "Жезказган",
        isFallback: true,
      });
      // `default_city` is Almaty by default.
      expect(list.defaultCityId).toBe(ids.get("almaty"));
      const user = await mobileToken();
      const asUser = await call(user, IOS, "get", "/cities");
      expect(cityListResponseSchema.parse(asUser.body).cities).toHaveLength(devCities.length + 1);
      expect(
        cityListResponseSchema.parse(
          (await asAdmin("get", "/cities").set("Accept-Language", "en")).body,
        ).cities[0]!.name.text,
      ).toBe("Almaty");
    });

    it("is kept by the administrator: names unique in every language, versions, archive, order, journal", async () => {
      const ids = await cities();
      const created = await ok(
        asAdmin("post", "/admin/cities", {
          code: "ekibastuz",
          names: { ru: "Экибастуз", kk: "Екібастұз", en: "Ekibastuz" },
        }),
        (body) => adminCityResponseSchema.parse(body).city,
        201,
      );
      expect(created).toMatchObject({ timeZone: "Asia/Almaty", version: 1, source: "manual" });
      expectError(
        await asAdmin("post", "/admin/cities", { code: "ekibastuz", names: { ru: "Другой" } }),
        409,
        "CITY_DUPLICATE",
      );
      // A name of another city in another language, case ignored.
      const clash = await asAdmin("post", "/admin/cities", {
        code: "oral-2",
        names: { ru: "ОРАЛ" },
      });
      expectError(clash, 409, "CITY_DUPLICATE");
      expect(clash.body.details).toEqual({
        existingId: ids.get("uralsk"),
        field: "name",
        value: "ОРАЛ",
      });
      expectError(
        await asAdmin("post", "/admin/cities", {
          code: "mars",
          names: { ru: "Марс" },
          timeZone: "Mars/Olympus",
        }),
        400,
        "VALIDATION_ERROR",
      );
      const renamed = await ok(
        asAdmin("patch", `/admin/cities/${created.id}`, {
          expectedVersion: 1,
          names: { en: null },
          timeZone: "Asia/Aqtobe",
        }),
        (body) => adminCityResponseSchema.parse(body).city,
      );
      expect(renamed).toMatchObject({ version: 2, timeZone: "Asia/Aqtobe", names: { en: null } });
      expectError(
        await asAdmin("patch", `/admin/cities/${created.id}`, {
          expectedVersion: 1,
          names: { ru: "Экибастуз-2" },
        }),
        409,
        "CITY_VERSION_CONFLICT",
      );
      const archived = await ok(
        asAdmin("post", `/admin/cities/${created.id}/status`, {
          status: "archived",
          expectedVersion: 2,
        }),
        (body) => adminCityResponseSchema.parse(body).city,
      );
      expect(archived.archivedAt).not.toBeNull();
      const clientList = cityListResponseSchema.parse((await http().get("/cities")).body);
      expect(clientList.cities.map((c) => c.id)).not.toContain(created.id);
      const admin = adminCityListResponseSchema.parse((await asAdmin("get", "/admin/cities")).body);
      expect(admin.cities.map((c) => c.id)).toContain(created.id);

      // Order: every city once; anything else is refused.
      const order = admin.cities.map((c) => c.id).reverse();
      expectError(
        await asAdmin("put", "/admin/cities/order", { cityIds: order.slice(1) }),
        409,
        "CITY_ORDER_MISMATCH",
      );
      const reordered = adminCityListResponseSchema.parse(
        (await asAdmin("put", "/admin/cities/order", { cityIds: order })).body,
      );
      expect(reordered.cities.map((c) => c.id)).toEqual(order);
      expect((await auditOf(created.id)).map((entry) => entry.action)).toEqual([
        "city.created",
        "city.changed",
        "city.status_changed",
      ]);
      expect(await count("audit_log", "action = 'city.reordered'")).toBe(1);
    });

    it("points the setting default_city at a city of the directory, by code or (as before) by name", async () => {
      const ids = await cities();
      await settings.set({ default_city: "astana" });
      expect(cityListResponseSchema.parse((await http().get("/cities")).body).defaultCityId).toBe(
        ids.get("astana"),
      );
      // A value written before the directory: a name.
      await settings.set({ default_city: "Шымкент" });
      expect(cityListResponseSchema.parse((await http().get("/cities")).body).defaultCityId).toBe(
        ids.get("shymkent"),
      );
      const refused = await asAdmin("put", "/admin/settings/default_city", {
        value: "atlantis",
        expectedVersion: 2,
        reason: "проверка",
      });
      expectError(refused, 400, "VALIDATION_ERROR");
      expect(refused.body.details[0].message).toMatch(/No active city/);
      // An archived default: the first active city in the order.
      const astana = adminCityListResponseSchema
        .parse((await asAdmin("get", "/admin/cities")).body)
        .cities.find((c) => c.code === "shymkent")!;
      await asAdmin("post", `/admin/cities/${astana.id}/status`, {
        status: "archived",
        expectedVersion: astana.version,
      });
      expect(cityListResponseSchema.parse((await http().get("/cities")).body).defaultCityId).toBe(
        ids.get("almaty"),
      );
    });
  });

  // ----------------------------------------------------------- public form

  describe("the public connection request form", () => {
    it("takes a request without signing in and answers the same whether the БИН is known or not", async () => {
      const ids = await cities();
      const almaty = ids.get("almaty")!;
      const first = await form({ cityId: almaty, bin: BIN_A, language: "kk" });
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ status: "received" });
      const { rows } = await db.query(
        "SELECT source, status, language, consent_version, consent_at IS NOT NULL AS consented, phone FROM supplier_lead WHERE bin = $1",
        [BIN_A],
      );
      expect(rows).toEqual([
        {
          source: "public_form",
          status: "new",
          language: "kk",
          consent_version: "1",
          consented: true,
          phone: "+77015556677",
        },
      ]);
      // The same БИН again (another person, later): a new request, the same answer.
      await settings.set({ supplier_lead_consent_version: "2026-09" });
      const again = await form({ cityId: almaty, bin: BIN_A, phone: "+77075550000" });
      expect(again.status).toBe(first.status);
      expect(again.body).toEqual(first.body);
      expect(await count("supplier_lead", "bin = $1", [BIN_A])).toBe(2);
      expect(await count("supplier_lead", "consent_version = '2026-09'")).toBe(1);
      // The БИН of a supplier that exists (the dev seed's): the same answer again.
      const known = await form({
        cityId: almaty,
        bin: devOnboardedLead.bin,
        phone: "+77070001122",
      });
      expect({ status: known.status, body: known.body }).toEqual({
        status: first.status,
        body: first.body,
      });
    });

    it("checks the БИН with its check digit, the number, the consent and the city", async () => {
      const ids = await cities();
      const almaty = ids.get("almaty")!;
      for (const [bin, message] of [
        ["12345", /12 digits/],
        [wrongBin("08074000012"), /check digit/],
        ["0807400001ab", /12 digits/],
      ] as const) {
        const refused = await form({ cityId: almaty, bin });
        expectError(refused, 400, "VALIDATION_ERROR");
        expect(refused.body.details).toEqual([
          { path: "bin", message: expect.stringMatching(message) },
        ]);
      }
      // A landline of Almaty is not a mobile number.
      const landline = await form({ cityId: almaty, phone: "+7 727 250 00 00" });
      expectError(landline, 400, "VALIDATION_ERROR");
      expect(landline.body.details[0].path).toBe("phone");
      expectError(
        await form({ cityId: almaty, phone: "+1 202 555 0100" }),
        400,
        "VALIDATION_ERROR",
      );
      const noConsent = await form({ cityId: almaty, consent: false });
      expectError(noConsent, 400, "VALIDATION_ERROR");
      expect(noConsent.body.details[0].path).toBe("consent");
      expectError(
        await form({ cityId: almaty, companyName: "x".repeat(201) }),
        400,
        "VALIDATION_ERROR",
      );
      // An archived and an unknown city look the same.
      const karaganda = adminCityListResponseSchema
        .parse((await asAdmin("get", "/admin/cities")).body)
        .cities.find((c) => c.code === "karaganda")!;
      await asAdmin("post", `/admin/cities/${karaganda.id}/status`, {
        status: "archived",
        expectedVersion: karaganda.version,
      });
      const archived = await form({ cityId: karaganda.id });
      const unknown = await form({ cityId: "00000000-0000-4000-8000-000000000000" });
      expectError(archived, 400, "VALIDATION_ERROR");
      expect(unknown.body).toEqual(archived.body);
      expect(await count("supplier_lead", "bin = $1", [BIN_B])).toBe(0);
    });

    it("drops a request with the trap field filled, answering as usual", async () => {
      const ids = await cities();
      const trapped = await form({
        cityId: ids.get("almaty")!,
        bin: BIN_C,
        website: "http://spam.example",
      });
      expect(trapped.status).toBe(202);
      expect(trapped.body).toEqual({ status: "received" });
      // Even with a broken БИН: the sender learns nothing.
      const brokenTrapped = await form({
        cityId: ids.get("almaty")!,
        bin: "123",
        website: "x",
      });
      expect(brokenTrapped.status).toBe(202);
      expect(await count("supplier_lead", "bin = $1", [BIN_C])).toBe(0);
      expect(output.text()).toContain("Supplier lead dropped: the trap field was filled");
    });

    it("keeps one request for the same form sent twice in a row", async () => {
      const ids = await cities();
      const almaty = ids.get("almaty")!;
      const [one, two] = await Promise.all([
        form({ cityId: almaty, bin: BIN_C }),
        form({ cityId: almaty, bin: BIN_C }),
      ]);
      expect([one.status, two.status]).toEqual([202, 202]);
      expect(await count("supplier_lead", "bin = $1", [BIN_C])).toBe(1);
      // Outside the window it is a new request.
      await db.query("UPDATE supplier_lead SET created_at = now() - interval '11 minutes'");
      expect((await form({ cityId: almaty, bin: BIN_C })).status).toBe(202);
      expect(await count("supplier_lead", "bin = $1", [BIN_C])).toBe(2);
    });

    it("limits requests per address (an IPv6 network as a whole) and per number, with Retry-After", async () => {
      const ids = await cities();
      const almaty = ids.get("almaty")!;
      await settings.set({ supplier_lead_per_ip: 3 });
      const ip = "2001:db8:5:6::1";
      for (let n = 0; n < 3; n++) {
        const phone = `+7701000000${n}`;
        expect(
          (await form({ cityId: almaty, bin: validBin(`1234000000${n}`), phone }, ip)).status,
        ).toBe(202);
      }
      // Another address of the same /64 is the same subscriber.
      const refused = await form({ cityId: almaty, phone: "+77010000009" }, "2001:db8:5:6::ffff");
      expectError(refused, 429, "RATE_LIMITED");
      expect(rateLimitedDetailsSchema.parse(refused.body.details).limit).toBe(
        "supplier_lead_per_ip",
      );
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      // Even a malformed request is counted (the guard runs before the body is read).
      expectError(
        await http().post("/supplier-leads").set("X-Forwarded-For", ip).send({}),
        429,
        "RATE_LIMITED",
      );
      expect(
        (await form({ cityId: almaty, phone: "+77010000008" }, "2001:db8:5:7::1")).status,
      ).toBe(202);

      // Per number and БИН, from different addresses (TASK-017: new requests
      // only — with the repeat window off every request is new here).
      await settings.set({
        supplier_lead_per_ip: 100,
        supplier_lead_per_phone: 2,
        supplier_lead_duplicate_window_minutes: 0,
      });
      const phone = "+77019998877";
      const companyBin = validBin("30000000001");
      expect((await form({ cityId: almaty, bin: companyBin, phone })).status).toBe(202);
      expect((await form({ cityId: almaty, bin: companyBin, phone })).status).toBe(202);
      const perPhone = await form({ cityId: almaty, bin: companyBin, phone });
      expectError(perPhone, 429, "RATE_LIMITED");
      expect(perPhone.body.details.limit).toBe("supplier_lead_per_phone");
      expect(perPhone.headers["retry-after"]).toBeDefined();
      // Someone sending with this number and other БИН doesn't use up the
      // company's own limit (and gets the same answer as anyone).
      const stranger = "+77019998866";
      for (const n of [2, 3, 4]) {
        expect(
          (await form({ cityId: almaty, bin: validBin(`3000000000${n}`), phone: stranger })).status,
        ).toBe(202);
      }
      expect((await form({ cityId: almaty, bin: companyBin, phone: stranger })).status).toBe(202);
    });

    it("doesn't spend the number's limit on a repeat of the same request (TASK-017)", async () => {
      const ids = await cities();
      const almaty = ids.get("almaty")!;
      await settings.set({ supplier_lead_per_phone: 2 });
      const phone = "+77019998855";
      const [one, two] = await Promise.all([
        form({ cityId: almaty, bin: BIN_C, phone }),
        form({ cityId: almaty, bin: BIN_C, phone }),
      ]);
      expect([one.status, two.status]).toEqual([202, 202]);
      expect((await form({ cityId: almaty, bin: BIN_C, phone })).status).toBe(202);
      expect(await count("supplier_lead", "bin = $1", [BIN_C])).toBe(1);
      // Out of the repeat window: the second new request still fits the limit
      // of two — the three presses above spent one.
      await db.query("UPDATE supplier_lead SET created_at = now() - interval '11 minutes'");
      expect((await form({ cityId: almaty, bin: BIN_C, phone })).status).toBe(202);
      expect(await count("supplier_lead", "bin = $1", [BIN_C])).toBe(2);
      await db.query("UPDATE supplier_lead SET created_at = now() - interval '11 minutes'");
      expectError(await form({ cityId: almaty, bin: BIN_C, phone }), 429, "RATE_LIMITED");
    });

    it("hundreds of requests from one address are stopped at the limit", async () => {
      const ids = await cities();
      const ip = "203.0.113.77";
      const statuses: number[] = [];
      for (let n = 0; n < 100; n++) {
        statuses.push(
          (
            await form(
              {
                cityId: ids.get("almaty")!,
                bin: validBin(`4${String(n).padStart(10, "0")}`),
                phone: `+7702${String(n).padStart(7, "0")}`,
              },
              ip,
            )
          ).status,
        );
      }
      expect(statuses.filter((status) => status === 202)).toHaveLength(10);
      expect(statuses.filter((status) => status === 429)).toHaveLength(90);
      // And the two of the development seed.
      expect(await count("supplier_lead")).toBe(12);
    });

    it("logs the number and the БИН only masked", async () => {
      const ids = await cities();
      const bin = validBin("99084000123");
      expect((await form({ cityId: ids.get("almaty")!, bin, phone: "+77017654321" })).status).toBe(
        202,
      );
      const text = output.text();
      expect(text).toContain(`bin=********${bin.slice(-4)}`);
      expect(text).toContain("phone=+7***4321");
      expect(text).not.toContain(bin);
      expect(text).not.toContain("77017654321");
      // The action journal names neither.
      const { rows } = await db.query(
        "SELECT after::text AS after FROM audit_log WHERE action = 'supplier_lead.created'",
      );
      expect(rows[0].after).not.toContain(bin);
      expect(rows[0].after).not.toContain("7654321");
    });
  });

  // ---------------------------------------------------------------- funnel

  describe("the funnel", () => {
    it("moves along the funnel on the server: onboarded only by onboarding, reasons to reject and return", async () => {
      const ids = await cities();
      expect((await form({ cityId: ids.get("almaty")!, bin: BIN_B })).status).toBe(202);
      const leadId = await leadIdByBin(BIN_B);
      const onboarded = await moveLead(leadId, "onboarded");
      expectError(onboarded, 409, "SUPPLIER_LEAD_STATE");
      expect(onboarded.body.details).toEqual({
        status: "new",
        refusal: "onboarded_only_by_onboarding",
      });
      expectError(await moveLead(leadId, "new"), 409, "SUPPLIER_LEAD_STATE");
      // Straight to a meeting after a call.
      expect((await moveLead(leadId, "meeting")).status).toBe(200);
      const noReason = await moveLead(leadId, "rejected");
      expectError(noReason, 400, "VALIDATION_ERROR");
      expect(noReason.body.details[0].path).toBe("reason");
      const rejected = await ok(
        moveLead(leadId, "rejected", "Не работает с клубами"),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
      );
      expect(rejected.lead).toMatchObject({
        status: "rejected",
        rejectReason: "Не работает с клубами",
      });
      // Onboarding a rejected request: refused.
      const fromRejected = await asAdmin("post", `/admin/supplier-leads/${leadId}/onboard`, {
        expectedVersion: rejected.lead.version,
      });
      expectError(fromRejected, 409, "SUPPLIER_LEAD_STATE");
      expect(fromRejected.body.details.refusal).toBe("contract_not_signed");
      expectError(await moveLead(leadId, "contacted"), 400, "VALIDATION_ERROR");
      const back = await ok(
        moveLead(leadId, "contacted", "Перезвонили сами"),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
      );
      expect(back.lead).toMatchObject({ status: "contacted", rejectReason: null });
      // A stale version.
      expectError(
        await asAdmin("post", `/admin/supplier-leads/${leadId}/status`, {
          expectedVersion: 1,
          status: "meeting",
        }),
        409,
        "SUPPLIER_VERSION_CONFLICT",
      );
      const journal = await auditOf(leadId);
      expect(journal.map((entry) => entry.action)).toEqual([
        "supplier_lead.created",
        "supplier_lead.status_changed",
        "supplier_lead.status_changed",
        "supplier_lead.status_changed",
      ]);
      expect(journal.map((entry) => entry.reason)).toEqual([
        null,
        null,
        "Не работает с клубами",
        "Перезвонили сами",
      ]);
    });

    it("adds a request by hand, keeps notes and links requests with one БИН", async () => {
      const ids = await cities();
      const manual = await ok(
        asAdmin("post", "/admin/supplier-leads", {
          companyName: "Масла и фильтры",
          bin: BIN_B,
          cityId: ids.get("astana"),
          type: "goods",
          contactName: "Руслан",
          phone: "8 (705) 111-22-33",
          note: "Звонил сам, просит перезвонить утром",
        }),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
        201,
      );
      expect(manual.lead).toMatchObject({
        source: "admin",
        status: "new",
        phone: "+77051112233",
        consentAt: null,
        language: null,
      });
      expect(manual.notes.map((note) => note.text)).toEqual([
        "Звонил сам, просит перезвонить утром",
      ]);
      expect((await form({ cityId: ids.get("almaty")!, bin: BIN_B })).status).toBe(202);
      const withNote = await ok(
        asAdmin("post", `/admin/supplier-leads/${manual.lead.id}/notes`, {
          text: "Договорились о встрече",
        }),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
        201,
      );
      expect(withNote.notes.map((note) => note.text)).toEqual([
        "Договорились о встрече",
        "Звонил сам, просит перезвонить утром",
      ]);
      expect(withNote.related).toHaveLength(1);
      expect(withNote.related[0]).toMatchObject({ source: "public_form", status: "new" });
      expect(withNote.lead.sameBinLeads).toBe(1);
      // Correcting the data.
      const corrected = await ok(
        asAdmin("patch", `/admin/supplier-leads/${manual.lead.id}`, {
          expectedVersion: withNote.lead.version,
          companyName: "Масла и фильтры KZ",
          type: "both",
        }),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
      );
      expect(corrected.lead).toMatchObject({ companyName: "Масла и фильтры KZ", type: "both" });
      // The request and its first note share a transaction (and a time).
      expect((await auditOf(manual.lead.id)).map((entry) => entry.action).sort()).toEqual([
        "supplier_lead.changed",
        "supplier_lead.created",
        "supplier_lead.note_added",
        "supplier_lead.note_added",
      ]);
    });

    it("lists requests newest first with filters, counts per status and pages", async () => {
      const ids = await cities();
      const almaty = ids.get("almaty")!;
      const astana = ids.get("astana")!;
      for (let n = 0; n < 5; n++) {
        expect(
          (
            await form({
              cityId: n % 2 === 0 ? almaty : astana,
              bin: validBin(`5000000000${n}`),
              phone: `+7703000000${n}`,
              type: n === 4 ? "services" : "goods",
            })
          ).status,
        ).toBe(202);
      }
      const lead0 = await leadIdByBin(validBin("50000000000"));
      await moveLead(lead0, "contacted");
      const page = adminSupplierLeadPageSchema.parse(
        (await asAdmin("get", "/admin/supplier-leads?limit=2")).body,
      );
      // Five from the form and the two of the development seed (one onboarded).
      expect(page.total).toBe(7);
      expect(page.leads).toHaveLength(2);
      expect(page.counts).toMatchObject({ new: 5, contacted: 1, onboarded: 1 });
      const all = [...page.leads];
      let cursor = page.nextCursor;
      while (cursor) {
        const next = adminSupplierLeadPageSchema.parse(
          (await asAdmin("get", `/admin/supplier-leads?limit=2&cursor=${cursor}`)).body,
        );
        all.push(...next.leads);
        cursor = next.nextCursor;
      }
      expect(new Set(all.map((lead) => lead.id)).size).toBe(7);
      const sorted = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      expect(all.map((lead) => lead.createdAt)).toEqual(sorted.map((lead) => lead.createdAt));
      const byFilters = adminSupplierLeadPageSchema.parse(
        (
          await asAdmin(
            "get",
            `/admin/supplier-leads?cityId=${almaty}&type=goods&source=public_form&status=new`,
          )
        ).body,
      );
      // Almaty, goods, the form: requests 0 (now contacted) and 2.
      expect(byFilters.total).toBe(1);
      expect(byFilters.counts).toMatchObject({ new: 1, contacted: 1 });
      const byBin = adminSupplierLeadPageSchema.parse(
        (await asAdmin("get", `/admin/supplier-leads?bin=${validBin("50000000003")}`)).body,
      );
      expect(byBin.leads.map((lead) => lead.companyName)).toEqual(["Автосервис Плюс"]);
      const future = new Date(Date.now() + 3600_000).toISOString();
      expect(
        adminSupplierLeadPageSchema.parse(
          (await asAdmin("get", `/admin/supplier-leads?from=${encodeURIComponent(future)}`)).body,
        ).total,
      ).toBe(0);
      expectError(
        await asAdmin("get", "/admin/supplier-leads?cursor=nonsense"),
        400,
        "VALIDATION_ERROR",
      );
    });
  });

  // ------------------------------------------------------------ onboarding

  describe("creating a supplier", () => {
    it("creates the supplier, its point, the first employee and the invitation in one step; the request is onboarded", async () => {
      const ids = await cities();
      const phone = "+77076660011";
      const leadId = await signedLead(ids.get("astana")!, BIN_B, phone);
      const created = await onboard(leadId);
      expect(created.lead).toMatchObject({ status: "onboarded", supplierId: created.supplier.id });
      expect(created.supplier).toMatchObject({
        name: "Автосервис Плюс",
        bin: BIN_B,
        type: "both",
        contactName: "Айгерим",
        contactPhone: phone,
        state: "active",
        visibleOnShowcase: true,
        verification: null,
        leadId,
        location: { address: "пр. Абая, 10", district: "Бостандыкский район" },
      });
      expect(created.supplier.city.code).toBe("astana");
      expect(created.supplier.location.city.code).toBe("astana");
      expect(created.firstMember).toMatchObject({
        accountCreated: true,
        memberOfOtherSuppliers: 0,
        isAdministrator: false,
      });
      expect(created.supplier.members).toEqual([
        expect.objectContaining({ displayName: "Айгерим", phone, status: "active" }),
      ]);
      expect(created.invitation.status).toBe("queued");

      // The worker sends it through the test channel.
      const sent = await waitFor("the invitation", async () => {
        const { rows } = await db.query<{ status: string; channel: string }>(
          "SELECT status, channel FROM supplier_invitation WHERE id = $1",
          [created.invitation.id],
        );
        return rows[0]?.status === "sent" ? rows[0] : undefined;
      });
      expect(sent.channel).toBe("test");
      // (The worker also sends the invitation of the development seed.)
      expect(messages.sent.filter((message) => message.phone === phone)).toEqual([
        {
          phone,
          text: "Айгерим, вас добавили в кабинет поставщика «Автосервис Плюс». Войти: http://localhost:5175",
        },
      ]);
      const outbox = await http().get("/dev/supplier-invitations");
      expect(outbox.body.messages[0]).toMatchObject({ phone, status: "sent", channel: "test" });
      expect(outbox.body.messages[0].text).toContain("Автосервис Плюс");

      // The employee signs in to the cabinet with a code and sees the card.
      const cabinet = await cabinetToken(phone);
      const company = await ok(asSupplier(cabinet, "get", "/supplier/company"), (body) =>
        supplierCompanyResponseSchema.parse(body),
      );
      expect(company.supplier).toMatchObject({
        name: "Автосервис Плюс",
        city: "Астана",
        status: "active",
      });
      expect(company.company.location.district).toBe("Бостандыкский район");

      // One transaction: the journal has every part.
      expect((await auditOf(created.supplier.id)).map((entry) => entry.action)).toEqual([
        "supplier.created",
      ]);
      const ofSupplier = "after->>'supplierId' = $1";
      expect(
        await count("audit_log", `action = 'supplier_member.added' AND ${ofSupplier}`, [
          created.supplier.id,
        ]),
      ).toBe(1);
      expect(
        await count("audit_log", `action = 'supplier_invitation.requested' AND ${ofSupplier}`, [
          created.supplier.id,
        ]),
      ).toBe(1);
    });

    it("never creates a second supplier with one БИН, and leaves nothing behind", async () => {
      const ids = await cities();
      const existing = (
        await db.query<{ id: string }>("SELECT id FROM supplier WHERE bin = $1", [
          devOnboardedLead.bin,
        ])
      ).rows[0]!.id;
      const leadId = await signedLead(ids.get("almaty")!, devOnboardedLead.bin, "+77078889900");
      const accountsBefore = await count("account");
      const refused = await asAdmin("post", `/admin/supplier-leads/${leadId}/onboard`, {
        expectedVersion: await leadVersion(leadId),
      });
      expectError(refused, 409, "SUPPLIER_BIN_TAKEN");
      expect(refused.body.details).toEqual({ existingSupplierId: existing });
      expect(await count("supplier", "bin = $1", [devOnboardedLead.bin])).toBe(1);
      expect(await count("account")).toBe(accountsBefore);
      expect(await count("supplier_invitation")).toBe(1);
      const { rows } = await db.query("SELECT status FROM supplier_lead WHERE id = $1", [leadId]);
      expect(rows[0]).toEqual({ status: "contract_signed" });
      // Also without a request.
      expectError(
        await asAdmin("post", "/admin/suppliers", {
          name: "Дубль",
          bin: devOnboardedLead.bin,
          cityId: ids.get("almaty"),
          type: "goods",
          firstMember: { name: "Кто-то", phone: "+77079990000" },
        }),
        409,
        "SUPPLIER_BIN_TAKEN",
      );
      // Two at once: one wins.
      const bin = validBin("60000000001");
      const create = (n: number) =>
        asAdmin("post", "/admin/suppliers", {
          name: `Гонка ${n}`,
          bin,
          cityId: ids.get("almaty"),
          type: "goods",
          firstMember: { name: "Сотрудник", phone: `+7707123450${n}` },
        });
      const results = await Promise.all([create(1), create(2)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await count("supplier", "bin = $1", [bin])).toBe(1);
    });

    it("adds a first employee who works for another company or is an administrator", async () => {
      const ids = await cities();
      // The dev seed's employee already works for «Автомаркет».
      const leadId = await signedLead(ids.get("almaty")!, BIN_C, devOnboardedLead.phone);
      const created = await onboard(leadId);
      expect(created.firstMember).toMatchObject({
        accountCreated: false,
        memberOfOtherSuppliers: 1,
        isAdministrator: false,
      });
      const byHand = await ok(
        asAdmin("post", "/admin/suppliers", {
          name: "Админская лавка",
          bin: BIN_A,
          cityId: ids.get("astana"),
          type: "services",
          firstMember: { name: "Администратор", phone: ADMIN_PHONE },
        }),
        (body) => supplierOnboardedResponseSchema.parse(body),
        201,
      );
      expect(byHand.lead).toBeNull();
      expect(byHand.firstMember).toMatchObject({ accountCreated: false, isAdministrator: true });
      expect(byHand.supplier.leadId).toBeNull();
    });

    it("sends the invitation again only after the interval and within the daily limit", async () => {
      const ids = await cities();
      const leadId = await signedLead(ids.get("almaty")!, BIN_B, "+77076660022");
      const created = await onboard(leadId);
      const member = created.firstMember.memberId;
      const path = `/admin/suppliers/${created.supplier.id}/members/${member}/invitations`;
      const tooSoon = await asAdmin("post", path);
      expectError(tooSoon, 429, "RATE_LIMITED");
      expect(tooSoon.body.details.limit).toBe("supplier_invitation_resend");
      expect(Number(tooSoon.headers["retry-after"])).toBeGreaterThan(200);
      await db.query("UPDATE supplier_invitation SET created_at = now() - interval '6 minutes'");
      const again = await ok(
        asAdmin("post", path),
        (body) => supplierInvitationResponseSchema.parse(body),
        202,
      );
      expect(again.invitation.status).toBe("queued");
      await settings.set({ supplier_invitations_per_member_day: 2 });
      await db.query(
        "UPDATE supplier_invitation SET created_at = created_at - interval '10 minutes'",
      );
      const daily = await asAdmin("post", path);
      expectError(daily, 429, "RATE_LIMITED");
      expect(Number(daily.headers["retry-after"])).toBeGreaterThan(20 * 3600);
      expectError(
        await asAdmin(
          "post",
          `/admin/suppliers/${created.supplier.id}/members/00000000-0000-4000-8000-000000000000/invitations`,
        ),
        404,
        "NOT_FOUND",
      );
      const latest = await card(created.supplier.id);
      expect(latest.members[0]!.lastInvitation?.id).toBe(again.invitation.id);
    });
  });

  // ------------------------------------------------------------------ card

  describe("the card of a supplier", () => {
    it("is changed by the administrator with versions and the journal; the city moves the point", async () => {
      const ids = await cities();
      const created = await onboard(await signedLead(ids.get("almaty")!, BIN_B, "+77076660033"));
      const id = created.supplier.id;
      const changed = await ok(
        asAdmin("patch", `/admin/suppliers/${id}`, {
          expectedVersion: created.supplier.version,
          name: "Автосервис Плюс Центр",
          cityId: ids.get("karaganda"),
          address: "ул. Бухар-Жырау, 5",
          district: null,
          contactPhone: "+7 747 000 11 22",
        }),
        (body) => adminSupplierResponseSchema.parse(body).supplier,
      );
      expect(changed).toMatchObject({
        name: "Автосервис Плюс Центр",
        contactPhone: "+77470001122",
        version: created.supplier.version + 1,
        location: { address: "ул. Бухар-Жырау, 5", district: null },
      });
      expect(changed.city.code).toBe("karaganda");
      expect(changed.location.city.code).toBe("karaganda");
      expectError(
        await asAdmin("patch", `/admin/suppliers/${id}`, { expectedVersion: 1, name: "X" }),
        409,
        "SUPPLIER_VERSION_CONFLICT",
      );
      expectError(
        await asAdmin("patch", `/admin/suppliers/${id}`, {
          expectedVersion: changed.version,
          bin: devOnboardedLead.bin,
        }),
        409,
        "SUPPLIER_BIN_TAKEN",
      );
      expectError(
        await asAdmin("patch", `/admin/suppliers/${id}`, {
          expectedVersion: changed.version,
          timeZone: "Nowhere/City",
        }),
        400,
        "VALIDATION_ERROR",
      );
      expect((await auditOf(id)).map((entry) => entry.action)).toEqual([
        "supplier.created",
        "supplier.changed",
      ]);
    });

    it("keeps hours by day of the week and days off; the supplier changes those and nothing else", async () => {
      const ids = await cities();
      const phone = "+77076660044";
      const created = await onboard(await signedLead(ids.get("almaty")!, BIN_B, phone));
      const id = created.supplier.id;
      expect(created.supplier.schedule).toEqual({ weeklyHours: null, closedDates: [] });
      const byAdmin = await ok(
        asAdmin("put", `/admin/suppliers/${id}/schedule`, {
          expectedVersion: created.supplier.version,
          weeklyHours: WEEK,
          closedDates: [{ date: almatyDate(10), note: "Наурыз" }],
        }),
        (body) => adminSupplierResponseSchema.parse(body).supplier,
      );
      expect(byAdmin.schedule).toEqual({
        weeklyHours: WEEK,
        closedDates: [{ date: almatyDate(10), note: "Наурыз" }],
      });

      const cabinet = await cabinetToken(phone);
      const past = await asSupplier(cabinet, "put", "/supplier/company/schedule", {
        expectedVersion: byAdmin.version,
        weeklyHours: WEEK,
        closedDates: [{ date: almatyDate(-1), note: null }],
      });
      expectError(past, 400, "VALIDATION_ERROR");
      expect(past.body.details[0].path).toBe("closedDates.0.date");
      expectError(
        await asSupplier(cabinet, "put", "/supplier/company/schedule", {
          expectedVersion: byAdmin.version,
          weeklyHours: WEEK,
          closedDates: [
            { date: almatyDate(3), note: null },
            { date: almatyDate(3), note: null },
          ],
        }),
        400,
        "VALIDATION_ERROR",
      );
      const lunch = WEEK.map((day) =>
        day.day === 6 ? { day: 6, intervals: [{ from: "10:00", to: "15:00" }] } : day,
      );
      const own = await ok(
        asSupplier(cabinet, "put", "/supplier/company/schedule", {
          expectedVersion: byAdmin.version,
          weeklyHours: lunch,
          closedDates: [
            { date: almatyDate(0), note: "Инвентаризация" },
            { date: almatyDate(30), note: null },
          ],
        }),
        (body) => supplierCardResponseSchema.parse(body).company,
      );
      expect(own.schedule.weeklyHours).toEqual(lunch);
      expect(own.schedule.closedDates.map((d) => d.date)).toEqual([almatyDate(0), almatyDate(30)]);
      // A day off that passed is kept as history, not shown.
      await db.query(
        "UPDATE supplier_closed_date SET closed_on = closed_on - 40 WHERE closed_on = $1",
        [almatyDate(30)],
      );
      expect((await card(id)).schedule.closedDates.map((d) => d.date)).toEqual([almatyDate(0)]);
      expect(await count("supplier_closed_date")).toBe(2);

      // Anything else of the card is the administrator's.
      expectError(
        await asSupplier(cabinet, "patch", `/admin/suppliers/${id}`, {
          expectedVersion: own.version,
          address: "Другой адрес",
        }),
        403,
        "FORBIDDEN",
      );
      expect((await card(id)).location.address).toBe("пр. Абая, 10");
      const journal = await db.query<{ action: string; actor_role: string }>(
        "SELECT action, actor_role FROM audit_log WHERE entity_id = $1 AND action = 'supplier.schedule_changed' ORDER BY created_at",
        [id],
      );
      expect(journal.rows.map((row) => row.actor_role)).toEqual(["admin", "supplier"]);
    });
  });

  // ---------------------------------------------------------------- states

  describe("the states of a supplier", () => {
    it("verified partner with the contract date, pause and blocking with reasons; the cabinet stays open", async () => {
      const ids = await cities();
      const phone = "+77076660055";
      const created = await onboard(await signedLead(ids.get("almaty")!, BIN_B, phone));
      const id = created.supplier.id;
      const cabinet = await cabinetToken(phone);
      let version = created.supplier.version;
      const post = async (path: string, body: object) => {
        const response = await asAdmin("post", `/admin/suppliers/${id}/${path}`, {
          expectedVersion: version,
          ...body,
        });
        if (response.status === 200) {
          version = adminSupplierResponseSchema.parse(response.body).supplier.version;
        }
        return response;
      };
      expectError(await post("verification", { verified: true }), 400, "VALIDATION_ERROR");
      expectError(
        await post("verification", { verified: true, contractSignedOn: almatyDate(5) }),
        400,
        "VALIDATION_ERROR",
      );
      const verified = adminSupplierResponseSchema.parse(
        (await post("verification", { verified: true, contractSignedOn: almatyDate(-3) })).body,
      ).supplier;
      expect(verified.verification?.contractSignedOn).toBe(almatyDate(-3));
      expect(verified.visibleOnShowcase).toBe(true);

      const paused = adminSupplierResponseSchema.parse(
        (await post("pause", { paused: true, reason: "billing", note: "Не прошла оплата" })).body,
      ).supplier;
      expect(paused).toMatchObject({
        state: "paused",
        visibleOnShowcase: false,
        pause: { reason: "billing", note: "Не прошла оплата" },
      });
      // The employee keeps working in the cabinet: the session and a new sign-in.
      expect((await asSupplier(cabinet, "get", "/supplier/company")).body.company.state).toBe(
        "paused",
      );
      const again = await cabinetToken(phone);
      expect((await asSupplier(again, "get", "/supplier/company")).status).toBe(200);

      const blocked = adminSupplierResponseSchema.parse(
        (await post("block", { blocked: true, reason: "Жалобы клиентов" })).body,
      ).supplier;
      expect(blocked).toMatchObject({
        state: "blocked",
        visibleOnShowcase: false,
        block: { reason: "Жалобы клиентов" },
      });
      expectError(await post("block", { blocked: true, reason: "Ещё раз" }), 409, "SUPPLIER_STATE");
      expect((await asSupplier(cabinet, "get", "/supplier/company")).body.company.state).toBe(
        "blocked",
      );
      expect((await signIn(phone, SUPPLIER_WEB)).status).toBe(200);

      // Lifting the pause leaves the blocking.
      const unpaused = adminSupplierResponseSchema.parse(
        (await post("pause", { paused: false, note: "Оплата прошла" })).body,
      ).supplier;
      expect(unpaused).toMatchObject({ state: "blocked", pause: null, visibleOnShowcase: false });
      expectError(await post("pause", { paused: false, note: "Ещё раз" }), 409, "SUPPLIER_STATE");
      const unblocked = adminSupplierResponseSchema.parse(
        (await post("block", { blocked: false, reason: "Разобрались" })).body,
      ).supplier;
      expect(unblocked).toMatchObject({ state: "active", visibleOnShowcase: true, block: null });
      expectError(await post("verification", { verified: false }), 400, "VALIDATION_ERROR");
      const unverified = adminSupplierResponseSchema.parse(
        (await post("verification", { verified: false, reason: "Договор расторгнут" })).body,
      ).supplier;
      expect(unverified.verification).toBeNull();
      expectError(
        await post("verification", { verified: false, reason: "Ещё раз" }),
        409,
        "SUPPLIER_STATE",
      );

      const { rows } = await db.query<{ action: string; reason: string | null }>(
        "SELECT action, reason FROM audit_log WHERE entity_id = $1 AND action <> 'supplier.created' ORDER BY created_at, id",
        [id],
      );
      expect(rows).toEqual([
        { action: "supplier.verification_changed", reason: null },
        { action: "supplier.pause_changed", reason: "Не прошла оплата" },
        { action: "supplier.block_changed", reason: "Жалобы клиентов" },
        { action: "supplier.pause_changed", reason: "Оплата прошла" },
        { action: "supplier.block_changed", reason: "Разобрались" },
        { action: "supplier.verification_changed", reason: "Договор расторгнут" },
      ]);
      // The database keeps `status` in step with the pause and the blocking.
      await expect(
        db.query("UPDATE supplier SET status = 'paused' WHERE id = $1", [id]),
      ).rejects.toThrow(/supplier_status_check/);
    });

    it("lists suppliers by state, city and type, and finds them by name or БИН", async () => {
      const ids = await cities();
      const a = await onboard(await signedLead(ids.get("astana")!, BIN_B, "+77076660066"));
      const b = await onboard(await signedLead(ids.get("astana")!, BIN_C, "+77076660077"), {
        name: "Шины Астаны",
        type: "goods",
      });
      await asAdmin("post", `/admin/suppliers/${b.supplier.id}/pause`, {
        expectedVersion: b.supplier.version,
        paused: true,
        reason: "admin",
        note: "По решению администратора",
      });
      const list = (query: string) =>
        ok(asAdmin("get", `/admin/suppliers${query}`), (body) =>
          adminSupplierPageSchema.parse(body),
        );
      expect((await list("")).total).toBe(3);
      expect((await list("?state=paused")).suppliers.map((s) => s.id)).toEqual([b.supplier.id]);
      expect((await list("?state=active")).total).toBe(2);
      expect((await list("?state=verified")).suppliers.map((s) => s.name)).toEqual(["Автомаркет"]);
      expect((await list(`?cityId=${ids.get("astana")}`)).total).toBe(2);
      expect((await list("?type=goods")).suppliers.map((s) => s.id)).toEqual([b.supplier.id]);
      expect((await list(`?q=${encodeURIComponent("шины")}`)).suppliers.map((s) => s.id)).toEqual([
        b.supplier.id,
      ]);
      expect((await list(`?q=${BIN_B.slice(2, 9)}`)).suppliers.map((s) => s.id)).toEqual([
        a.supplier.id,
      ]);
      const first = await list("?limit=2");
      expect(first.suppliers.map((s) => s.name)).toEqual(["Автомаркет", "Автосервис Плюс"]);
      const second = await list(`?limit=2&cursor=${first.nextCursor}`);
      expect(second.suppliers.map((s) => s.name)).toEqual(["Шины Астаны"]);
      expect(second.nextCursor).toBeNull();
    });
  });

  // ------------------------------------------------------ open route limits

  describe("the rate limit of open routes", () => {
    it("limits the compatibility check per address with Retry-After, and bounds a subcategory by pages", async () => {
      await app.get(DevCatalogSeed).run();
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM category WHERE code = 'engine_oils'",
      );
      const categoryId = rows[0]!.id;
      const check = (body: object, ip = "192.0.2.10") =>
        http().post("/catalog/compatibility/check").set("X-Forwarded-For", ip).send(body);
      const first = compatibilityCheckResponseSchema.parse(
        (await check({ categoryId, limit: 2 })).body,
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = compatibilityCheckResponseSchema.parse(
        (await check({ categoryId, limit: 2, cursor: first.nextCursor })).body,
      );
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((item) => item.itemId)).size).toBe(4);
      const whole = compatibilityCheckResponseSchema.parse((await check({ categoryId })).body);
      expect(whole.items.map((i) => i.itemId)).toEqual(
        [...first.items, ...second.items].map((i) => i.itemId),
      );
      expect(whole.nextCursor).toBeNull();
      expectError(
        await check({ itemIds: [first.items[0]!.itemId], limit: 1 }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(await check({ categoryId, cursor: "junk" }), 400, "VALIDATION_ERROR");
      expectError(await check({ categoryId, limit: 501 }), 400, "VALIDATION_ERROR");

      await settings.set({ compatibility_check_per_ip: 3 });
      const ip = "192.0.2.99";
      for (let n = 0; n < 3; n++) {
        expect((await check({ categoryId }, ip)).status).toBe(200);
      }
      const limited = await check({ categoryId }, ip);
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details.limit).toBe("compatibility_check_per_ip");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect((await check({ categoryId }, "192.0.2.100")).status).toBe(200);
    });

    it("without Redis: refuses the request form, keeps serving the reads", async () => {
      const ids = await cities();
      await app.get(DevCatalogSeed).run();
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM category WHERE code = 'engine_oils'",
      );
      await redisProxy.stop();
      try {
        const refused = await form({ cityId: ids.get("almaty")!, bin: BIN_C });
        expectError(refused, 503, "SERVICE_UNAVAILABLE");
        expect(refused.body.retryable).toBe(true);
        expect(await count("supplier_lead", "bin = $1", [BIN_C])).toBe(0);
        const checked = await http()
          .post("/catalog/compatibility/check")
          .send({ categoryId: rows[0]!.id });
        expect(checked.status).toBe(200);
        expect((await http().get("/cities")).status).toBe(200);
        expect((await http().get("/catalog/categories")).status).toBe(200);
      } finally {
        await redisProxy.start();
      }
      const deadline = Date.now() + 20_000;
      let status = 0;
      while (Date.now() < deadline) {
        status = (await form({ cityId: ids.get("almaty")!, bin: BIN_C })).status;
        if (status === 202) {
          break;
        }
        await sleep(250);
      }
      expect(status).toBe(202);
      expect(output.text()).toContain("Served without the limit limit=compatibility_check_per_ip");
    });
  });

  // ----------------------------------------------------------------- access

  describe("access", () => {
    it("serves the admin routes to the admin context only, the own card to the supplier only, the form and cities to anyone", async () => {
      const ids = await cities();
      const phone = "+77076660088";
      const created = await onboard(await signedLead(ids.get("almaty")!, BIN_B, phone));
      const supplierId = created.supplier.id;
      const leadId = created.lead!.id;
      const user = await mobileToken();
      const cabinet = await cabinetToken(phone);
      const adminRoutes: [Method, string][] = [
        ["get", "/admin/cities"],
        ["post", "/admin/cities"],
        ["patch", `/admin/cities/${ids.get("almaty")}`],
        ["post", `/admin/cities/${ids.get("almaty")}/status`],
        ["put", "/admin/cities/order"],
        ["get", "/admin/supplier-leads"],
        ["post", "/admin/supplier-leads"],
        ["get", `/admin/supplier-leads/${leadId}`],
        ["patch", `/admin/supplier-leads/${leadId}`],
        ["post", `/admin/supplier-leads/${leadId}/status`],
        ["post", `/admin/supplier-leads/${leadId}/notes`],
        ["post", `/admin/supplier-leads/${leadId}/onboard`],
        ["get", "/admin/suppliers"],
        ["post", "/admin/suppliers"],
        ["get", `/admin/suppliers/${supplierId}`],
        ["patch", `/admin/suppliers/${supplierId}`],
        ["put", `/admin/suppliers/${supplierId}/schedule`],
        ["post", `/admin/suppliers/${supplierId}/verification`],
        ["post", `/admin/suppliers/${supplierId}/pause`],
        ["post", `/admin/suppliers/${supplierId}/block`],
        [
          "post",
          `/admin/suppliers/${supplierId}/members/${created.firstMember.memberId}/invitations`,
        ],
      ];
      for (const [method, path] of adminRoutes) {
        expectError(await call(user, IOS, method, path, {}), 403, "FORBIDDEN");
        expectError(await asSupplier(cabinet, method, path, {}), 403, "FORBIDDEN");
        expectError(await http()[method](path).send({}), 401, "AUTH_REQUIRED");
      }
      const supplierRoutes: [Method, string][] = [
        ["get", "/supplier/company"],
        ["get", `/supplier/companies/${supplierId}`],
        ["put", "/supplier/company/schedule"],
      ];
      for (const [method, path] of supplierRoutes) {
        expectError(await call(user, IOS, method, path, {}), 403, "FORBIDDEN");
        expectError(await asAdmin(method, path, {}), 403, "FORBIDDEN");
        expectError(await http()[method](path).send({}), 401, "AUTH_REQUIRED");
      }
      // Another company's card looks like a missing one.
      const other = (
        await db.query<{ id: string }>("SELECT id FROM supplier WHERE bin = $1", [
          devOnboardedLead.bin,
        ])
      ).rows[0]!.id;
      expectError(
        await asSupplier(cabinet, "get", `/supplier/companies/${other}`),
        404,
        "NOT_FOUND",
      );
      // Open ones, for guests and every session.
      for (const bearer of [undefined, user, cabinet, token]) {
        const test = http().get("/cities");
        expect((await (bearer ? test.set("Authorization", `Bearer ${bearer}`) : test)).status).toBe(
          200,
        );
      }
      expect((await form({ cityId: ids.get("astana")!, bin: BIN_C })).status).toBe(202);
    });
  });

  // ------------------------------------------------------------------- seed

  describe("the development seed", () => {
    it("fills cities and the example supplier once; a second run creates nothing", async () => {
      const seed = app.get(DevSupplierSeed);
      const first = await seed.run();
      expect(first.created).toEqual({ cities: devCities.length, suppliers: 1, leads: 2 });
      const second = await seed.run();
      expect(second.created).toEqual({ cities: 0, suppliers: 0, leads: 0 });
      expect(second.existing).toEqual({ cities: devCities.length, suppliers: 1, leads: 2 });
      expect(second.supplierId).toBe(first.supplierId);
      const example = await card(first.supplierId);
      expect(example).toMatchObject({
        name: devOnboardedLead.companyName,
        state: "active",
        location: { district: "Алмалинский район" },
      });
      expect(example.verification).not.toBeNull();
      expect(example.schedule.weeklyHours).toHaveLength(7);
      const leads = adminSupplierLeadPageSchema.parse(
        (await asAdmin("get", "/admin/supplier-leads")).body,
      );
      expect(leads.counts).toMatchObject({ new: 1, onboarded: 1 });
      expect(leads.leads.map((lead) => lead.bin).sort()).toEqual(
        [devNewLead.bin, devOnboardedLead.bin].sort(),
      );
    });
  });
});
