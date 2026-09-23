import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  clubAccessGrantPageSchema,
  clubAccessGrantResponseSchema,
  showcaseItemResponseSchema,
  showcaseListResponseSchema,
  offerPageSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
  type ShowcaseItemResponse,
  type ShowcaseListResponse,
  type SupplierOffer,
} from "@adclub/contracts";
import {
  kzBinCheckDigit,
  localDateTime,
  nextDate,
  normalizeArticle,
  RECEIPT_DATE_HORIZON_DAYS,
  receiptDate,
} from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { and, inArray } from "drizzle-orm";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TcpProxy } from "../../testing/tcp-proxy";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import { ClubAccess, ClubAccessGrants } from "../club-access";
import { DevCompatibilitySeed } from "../compatibility";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { offer, offerShowcase, shownOffers } from "../offers";
import { DevVehicleSeed } from "../vehicles";

/**
 * TASK-020 end to end on a real PostgreSQL and Redis: club access given
 * and ended by hand (the admin panel and the operator command, the
 * journal, expiry during a session); the list of a subcategory (only items
 * with offers users see, the city, «only my city», the car by D-029, every
 * filter, three orders, pages without gaps or repeats, the empty states);
 * the card of an item (photos, characteristics, compatibility, offers with
 * receipt dates and orders, analogs, «no offers now»); what each role sees
 * of suppliers — the fields are absent, not empty — on every route of the
 * catalog; caching that never hands one role's answer to another; D-060;
 * the weights of «Рекомендуемые»; the list of thousands of items.
 * TASK-020.A: the warranty text only with club access; the showcase rule,
 * its SQL twin and the catalog's answer agree (closed dates over the
 * horizon included); pages of «Рекомендуемые» when offers and weights
 * change between them; the limits of the catalog by address and by
 * account, and without Redis (behind a TCP proxy, to take it away);
 * services outside the chosen city among analogs.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77471112244";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const PADS = "04465-0K090";

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

/** Around the clock every day: a term of N working days is N calendar days, at any hour. */
const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));
const NEVER: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, intervals: [] }));

const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Closed dates from today in Almaty over the whole horizon of the receipt
 * date — and a day more, so that a midnight passing during the test still
 * leaves every day of the horizon closed (TASK-020.A).
 */
function closedHorizon(): { date: string; note: string }[] {
  const dates: { date: string; note: string }[] = [];
  let date = localDateTime(new Date(), "Asia/Almaty").date;
  for (let day = 0; day <= RECEIPT_DATE_HORIZON_DAYS + 1; day += 1) {
    dates.push({ date, note: "Инвентаризация" });
    date = nextDate(date);
  }
  return dates;
}

describe("the catalog for users (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redisProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let almaty: string;
  let astana: string;
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
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 } }),
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
    astana = await ok(
      asAdmin("post", "/admin/cities", { code: "astana", names: { ru: "Астана", kk: "Астана" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    await app.get(DevCompatibilitySeed).run();
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

  async function idOf(text: string, values: unknown[]): Promise<string> {
    const { rows } = await db.query<{ id: string }>(text, values);
    expect(rows.length, text).toBeGreaterThan(0);
    return rows[0]!.id;
  }

  // ---------------------------------------------------------------- world

  interface Company {
    supplierId: string;
    name: string;
    district: string;
    address: string;
    contactPhone: string;
    as: (method: Method, path: string, body?: object) => Test;
  }

  /** A supplier with its point in a city, hours around the clock (unless given), and a signed-in employee. */
  async function company(
    name: string,
    cityId: string,
    options: { hours?: DayHours[] | null; verified?: boolean } = {},
  ): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    const contactPhone = phoneOf(500 + phoneCounter);
    rememberCode(phone);
    const district = `Район ${name}`;
    const address = `ул. ${name}, ${String(phoneCounter)}`;
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId,
        type: "goods",
        contactPhone,
        address,
        district,
        firstMember: { name: "Айгерим", phone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    let version = created.supplier.version;
    const hours = options.hours === undefined ? ALWAYS : options.hours;
    if (hours) {
      version = await ok(
        asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
          expectedVersion: version,
          weeklyHours: hours,
          closedDates: [],
        }),
        (body) => adminSupplierResponseSchema.parse(body).supplier.version,
      );
    }
    if (options.verified) {
      await ok(
        asAdmin("post", `/admin/suppliers/${created.supplier.id}/verification`, {
          expectedVersion: version,
          verified: true,
          contractSignedOn: "2026-09-01",
        }),
        (body) => body,
      );
    }
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: created.supplier.id,
      name,
      district,
      address,
      contactPhone,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function put(of: Company, itemId: string, extra: object = {}): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId,
        price: 12_500,
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: false,
        ...extra,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  async function supplierVersion(supplierId: string): Promise<number> {
    return ok(asAdmin("get", `/admin/suppliers/${supplierId}`), (body) =>
      adminSupplierResponseSchema.parse(body),
    ).then((body) => body.supplier.version);
  }

  async function pause(of: Company, paused: boolean): Promise<void> {
    await ok(
      asAdmin("post", `/admin/suppliers/${of.supplierId}/pause`, {
        expectedVersion: await supplierVersion(of.supplierId),
        paused,
        reason: "admin",
        note: "Проверка",
      }),
      (body) => body,
    );
  }

  async function world() {
    const make = (key: string) =>
      idOf("SELECT make_id AS id FROM vehicle_make_spelling WHERE key = $1", [key]);
    const geely = await make("geely");
    const model = (key: string) =>
      idOf("SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = $1 AND key = $2", [
        geely,
        key,
      ]);
    const atlas = await model("atlas");
    const coolray = await model("coolray");
    const generation = (modelId: string, name: string) =>
      idOf("SELECT id FROM vehicle_generation WHERE model_id = $1 AND name_key = $2", [
        modelId,
        name,
      ]);
    const category = (code: string) => idOf("SELECT id FROM category WHERE code = $1", [code]);
    const item = (brandKey: string, article: string) =>
      idOf(
        "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
        [brandKey, normalizeArticle(article)],
      );
    const oil = (name: string) =>
      idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND lang = 'ru' AND text = $1",
        [name],
      );
    const attribute = (code: string) =>
      idOf(
        "SELECT a.id FROM attribute a JOIN category c ON c.id = a.category_id WHERE c.code = 'engine_oils' AND a.code = $1",
        [code],
      );
    const option = (attributeId: string, code: string) =>
      idOf("SELECT id FROM attribute_option WHERE attribute_id = $1 AND code = $2", [
        attributeId,
        code,
      ]);
    const viscosity = await attribute("viscosity");
    return {
      geely,
      atlas,
      coolray,
      atlasII: await generation(atlas, "ii (fx11)"),
      atlasI: await generation(atlas, "i (nl-3)"),
      coolrayI: await generation(coolray, "i (sx11)"),
      e3G15: await idOf("SELECT engine_id AS id FROM vehicle_engine_spelling WHERE key = $1", [
        "jlh-3g15td",
      ]),
      brakePads: await category("brake_pads"),
      engineOils: await category("engine_oils"),
      oilChange: await category("oil_change"),
      frontPads: await item("geely", PADS),
      trwPads: await item("trw", "GDB3534"),
      rearPads: await item("geely", "4050068800"),
      helixHx8: await oil("Shell Helix HX8 5W-30, 4 л"),
      mobilSuper: await oil("Mobil Super 3000 5W-40, 4 л"),
      helixUltra: await oil("Shell Helix Ultra 0W-20, 1 л"),
      mobilEsp: await oil("Mobil 1 ESP 5W-30"),
      viscosity,
      approval: await attribute("approval"),
      volume: await attribute("volume"),
      fiveW30: await option(viscosity, "5w_30"),
      fiveW40: await option(viscosity, "5w_40"),
    };
  }

  const guest = (path: string): Test => http().get(path).set("X-Client", IOS);
  const as = (bearer: string, path: string): Test => call(bearer, IOS, "get", path);

  async function list(
    categoryId: string,
    query: Record<string, string> = {},
    bearer?: string,
  ): Promise<ShowcaseListResponse> {
    const path = `/catalog/categories/${categoryId}/items?${new URLSearchParams(query).toString()}`;
    return ok(bearer ? as(bearer, path) : guest(path), (body) =>
      showcaseListResponseSchema.parse(body),
    );
  }

  async function card(
    itemId: string,
    query: Record<string, string> = {},
    bearer?: string,
  ): Promise<ShowcaseItemResponse> {
    const path = `/catalog/items/${itemId}?${new URLSearchParams(query).toString()}`;
    return ok(bearer ? as(bearer, path) : guest(path), (body) =>
      showcaseItemResponseSchema.parse(body),
    );
  }

  async function grant(
    phone: string,
    until = new Date(Date.now() + 30 * 86_400_000),
    reason = "Внутренняя альфа",
  ) {
    return ok(
      asAdmin("post", "/admin/club-access/grants", {
        phone,
        validUntil: until.toISOString(),
        reason,
      }),
      (body) => clubAccessGrantResponseSchema.parse(body),
      201,
    );
  }

  /** Every string of an answer, keys included — to look for what must not be there. */
  function strings(value: unknown): string[] {
    return JSON.stringify(value).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  }

  function expectNothingOf(body: unknown, suppliers: readonly Company[]): void {
    const text = JSON.stringify(body);
    for (const entry of suppliers) {
      for (const secret of [
        entry.supplierId,
        entry.name,
        entry.district,
        entry.address,
        entry.contactPhone,
      ]) {
        expect(text, `«${secret}» must not be in the answer`).not.toContain(secret);
      }
    }
    for (const key of [
      "supplierId",
      "district",
      "address",
      "phone",
      "contactPhone",
      "weeklyHours",
    ]) {
      expect(
        strings(body).some((entry) => entry === `"${key}"`),
        key,
      ).toBe(false);
    }
  }

  // ---------------------------------------------------------- club access

  describe("club access (D-059)", () => {
    it("is given and ended by the administrator, with the journal, and read by one function", async () => {
      const user = await sessionToken(USER_PHONE, IOS);
      const access = app.get(ClubAccess);
      const accountId = await idOf("SELECT id FROM account WHERE phone = $1", [USER_PHONE]);
      expect(await access.stateOf(null)).toEqual({
        granted: false,
        source: null,
        validUntil: null,
      });
      expect((await access.stateOf(accountId)).granted).toBe(false);

      const until = new Date(Date.now() + 10 * 86_400_000);
      const given = await grant("+7 747 111 22 33", until);
      expect(given.grant).toMatchObject({
        accountId,
        status: "active",
        source: "manual",
        reason: "Внутренняя альфа",
        grantedBy: { role: "admin" },
        revokedAt: null,
      });
      expect(given.grant.phoneMasked).not.toContain("1112233");
      expect(given.access).toEqual({
        granted: true,
        source: "manual",
        validUntil: until.toISOString(),
      });
      expect((await access.stateOf(accountId)).granted).toBe(true);
      const active = await ok(asAdmin("get", "/admin/club-access/grants"), (body) =>
        clubAccessGrantPageSchema.parse(body),
      );
      expect(active.grants.map((entry) => entry.id)).toEqual([given.grant.id]);

      // A second grant replaces the first; the first ends with the
      // replacement as its reason, not with the reason of the second
      // (TASK-020.A).
      const longer = await grant(
        USER_PHONE,
        new Date(Date.now() + 20 * 86_400_000),
        "Продление альфы",
      );
      const all = await ok(
        asAdmin("get", `/admin/club-access/grants?status=all&accountId=${accountId}`),
        (body) => clubAccessGrantPageSchema.parse(body),
      );
      expect(all.grants.map((entry) => [entry.id, entry.status])).toEqual([
        [longer.grant.id, "active"],
        [given.grant.id, "replaced"],
      ]);
      expect(all.grants[0]).toMatchObject({ reason: "Продление альфы", revokeReason: null });
      expect(all.grants[1]).toMatchObject({
        reason: "Внутренняя альфа",
        revokedBy: { role: "admin" },
        revokeReason: `Заменена новой выдачей ${longer.grant.id}`,
      });

      const revoked = await ok(
        asAdmin("post", "/admin/club-access/revoke", {
          phone: USER_PHONE,
          reason: "Альфа закончилась",
        }),
        (body) => clubAccessGrantResponseSchema.parse(body),
      );
      expect(revoked.grant).toMatchObject({
        id: longer.grant.id,
        status: "revoked",
        revokedBy: { role: "admin" },
        revokeReason: "Альфа закончилась",
      });
      expect(revoked.access.granted).toBe(false);
      expect((await access.stateOf(accountId)).granted).toBe(false);
      expectError(
        await asAdmin("post", "/admin/club-access/revoke", {
          phone: USER_PHONE,
          reason: "Ещё раз",
        }),
        409,
        "CLUB_ACCESS_NOT_GRANTED",
      );

      const { rows } = await db.query<{
        action: string;
        actor_role: string;
        reason: string | null;
        after: Record<string, unknown>;
      }>(
        "SELECT action, actor_role, reason, after FROM audit_log WHERE entity_type = 'club_access_grant' ORDER BY created_at, id",
      );
      expect(rows.map((row) => [row.action, row.actor_role, row.reason])).toEqual([
        ["club_access.granted", "admin", "Внутренняя альфа"],
        ["club_access.granted", "admin", "Продление альфы"],
        ["club_access.revoked", "admin", "Альфа закончилась"],
      ]);
      expect(JSON.stringify(rows)).not.toContain("1112233");
      expect(user).toBeTruthy();
    });

    it("is given and ended by the operator command, recorded as the operator", async () => {
      const grants = app.get(ClubAccessGrants);
      const given = await grants.grant(
        {
          phone: MEMBER_PHONE,
          validUntil: new Date(Date.now() + 86_400_000),
          reason: "Сотрудник клуба",
        },
        { role: "operator" },
      );
      expect(given.grant.grantedBy).toEqual({ role: "operator", adminId: null });
      expect(given.access.granted).toBe(true);
      const status = await grants.statusOf(MEMBER_PHONE);
      expect(status.access.granted).toBe(true);
      expect(status.grants).toHaveLength(1);
      const ended = await grants.revoke(
        { phone: MEMBER_PHONE, reason: "Уволился" },
        { role: "operator" },
      );
      expect(ended.grant.revokedBy).toEqual({ role: "operator", adminId: null });
      const { rows } = await db.query<{ action: string; actor_role: string }>(
        "SELECT action, actor_role FROM audit_log WHERE entity_type = 'club_access_grant' ORDER BY created_at, id",
      );
      expect(rows).toEqual([
        { action: "club_access.granted", actor_role: "operator" },
        { action: "club_access.revoked", actor_role: "operator" },
      ]);
    });

    it("refuses a past or too distant end, a wrong number, and every other role", async () => {
      for (const [validUntil, path] of [
        [new Date(Date.now() - 1000).toISOString(), "validUntil"],
        [new Date(Date.now() + 800 * 86_400_000).toISOString(), "validUntil"],
      ] as const) {
        const refused = await asAdmin("post", "/admin/club-access/grants", {
          phone: USER_PHONE,
          validUntil,
          reason: "x",
        });
        expectError(refused, 400, "VALIDATION_ERROR");
        expect(JSON.stringify(refused.body.details)).toContain(path);
      }
      expectError(
        await asAdmin("post", "/admin/club-access/grants", {
          phone: "+7 123",
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          reason: "x",
        }),
        400,
        "VALIDATION_ERROR",
      );
      const user = await sessionToken(USER_PHONE, IOS);
      const shop = await company("Автомаркет", almaty);
      for (const [method, path, body] of [
        ["get", "/admin/club-access/grants", undefined],
        [
          "post",
          "/admin/club-access/grants",
          {
            phone: USER_PHONE,
            validUntil: new Date(Date.now() + 86_400_000).toISOString(),
            reason: "x",
          },
        ],
        ["post", "/admin/club-access/revoke", { phone: USER_PHONE, reason: "x" }],
      ] as const) {
        const anonymous = http()[method](path).set("X-Client", IOS);
        expectError(await (body ? anonymous.send(body) : anonymous), 401, "AUTH_REQUIRED");
        expectError(await call(user, IOS, method, path, body), 403, "FORBIDDEN");
        expectError(await shop.as(method, path, body), 403, "FORBIDDEN");
      }
      expect(await db.query("SELECT 1 FROM club_access_grant")).toMatchObject({ rowCount: 0 });
    });
  });

  // ------------------------------------------------------------- the list

  describe("the list of a subcategory (M-CAT-02, M-CAT-03)", () => {
    it("shows only items with visible offers, the chosen city first, without the suppliers", async () => {
      const w = await world();
      const inAlmaty = await company("Автомаркет", almaty);
      const inAstana = await company("Деталь Астана", astana);
      await put(inAlmaty, w.frontPads, { price: 11_000, leadDays: 2, availability: "on_order" });
      await put(inAstana, w.frontPads, { price: 12_500 });

      const page = await list(w.brakePads, { cityId: astana });
      // Only the item with offers: the TRW pads and the rear pads have none (D-031).
      expect(page.items.map((entry) => entry.id)).toEqual([w.frontPads]);
      expect(page.total).toBe(1);
      expect(page.empty).toBeNull();
      expect(page.city).toMatchObject({ id: astana, name: { text: "Астана" } });
      expect(page.viewer).toEqual({ signedIn: false, clubAccess: false });
      const [pads] = page.items;
      expect(pads).toMatchObject({
        name: { text: "Колодки тормозные передние", isFallback: false },
        brand: { name: "Geely" },
        article: PADS,
        photo: null,
        keyAttributes: [{ code: "axle", display: { text: "Передняя" } }],
        compatibility: { hasCompatibility: true, listed: true, mark: null },
        offers: { count: 2, minPrice: 11_000, currency: "KZT", inCity: true, inStock: true },
      });
      expect(pads!.offers.nearestReceipt.date).toBe(pads!.offers.nearestReceipt.confirmedOn);
      expectNothingOf(page, [inAlmaty, inAstana]);

      // «Весь Казахстан»: still listed, nothing is «in the city».
      const nationwide = await list(w.brakePads);
      expect(nationwide.city).toBeNull();
      expect(nationwide.items[0]!.offers).toMatchObject({ count: 2, inCity: false });

      // The card: the offer of the chosen city is first by «Рекомендуемые».
      const opened = await card(w.frontPads, { cityId: astana });
      expect(opened.offers.map((entry) => [entry.price, entry.inCity])).toEqual([
        [12_500, true],
        [11_000, false],
      ]);
      expect(opened.offers.map((entry) => entry.city.name.text)).toEqual(["Астана", "Алматы"]);
      for (const entry of opened.offers) {
        expect(entry.supplier).toEqual({ kind: "hidden", reason: "auth_required" });
      }
      expectNothingOf(opened, [inAlmaty, inAstana]);
    });

    it("follows the showcase: a paused supplier hides its offer, a point without hours too (D-060)", async () => {
      const w = await world();
      const first = await company("Автомаркет", almaty);
      const second = await company("Деталь Астана", astana);
      await put(first, w.frontPads, { price: 11_000 });
      const secondOffer = await put(second, w.frontPads, { price: 12_500 });
      expect((await list(w.brakePads)).items[0]!.offers.count).toBe(2);

      await pause(first, true);
      const paused = await list(w.brakePads);
      expect(paused.items[0]!.offers).toMatchObject({ count: 1, minPrice: 12_500 });
      expect((await card(w.frontPads)).offers.map((entry) => entry.id)).toEqual([secondOffer.id]);

      // The second point loses its hours: no date can be calculated — the
      // offer isn't shown, the item leaves the list, the supplier sees why.
      await db.query("UPDATE supplier_location SET weekly_hours = NULL WHERE supplier_id = $1", [
        second.supplierId,
      ]);
      const gone = await list(w.brakePads);
      expect(gone.items).toEqual([]);
      expect(gone.empty).toBe("no_items");
      const opened = await card(w.frontPads);
      expect(opened.noOffers).toBe(true);
      expect(opened.offers).toEqual([]);
      const own = await ok(second.as("get", `/supplier/offers/${secondOffer.id}`), (body) =>
        supplierOfferResponseSchema.parse(body),
      );
      expect(own.offer.showcase).toEqual({ visible: false, reasons: ["hours_not_set"] });
      expect(own.offer.receipt).toMatchObject({ date: null, unavailable: "hours_not_set" });

      // Hours with no working day at all hide it just as well.
      await ok(
        asAdmin("put", `/admin/suppliers/${second.supplierId}/schedule`, {
          expectedVersion: await supplierVersion(second.supplierId),
          weeklyHours: NEVER,
          closedDates: [],
        }),
        (body) => body,
      );
      const never = await ok(second.as("get", `/supplier/offers/${secondOffer.id}`), (body) =>
        supplierOfferResponseSchema.parse(body),
      );
      expect(never.offer.showcase).toEqual({ visible: false, reasons: ["no_working_day"] });
      expect((await list(w.brakePads)).items).toEqual([]);

      await pause(first, false);
      expect((await list(w.brakePads)).items[0]!.offers).toMatchObject({
        count: 1,
        minPrice: 11_000,
      });
    });

    it("filters by «only my city», availability, receiving, brand and characteristics", async () => {
      const w = await world();
      const inAlmaty = await company("Автомаркет", almaty);
      const inAstana = await company("Деталь Астана", astana);
      await put(inAlmaty, w.helixHx8, { price: 9_000 });
      await put(inAlmaty, w.mobilSuper, { price: 8_000, availability: "on_order", leadDays: 3 });
      await put(inAstana, w.helixUltra, { price: 5_000, pickup: false, delivery: true });
      await put(inAstana, w.mobilEsp, { price: 7_000 });
      const ids = (page: ShowcaseListResponse) => page.items.map((entry) => entry.id).sort();

      const everything = await list(w.engineOils, { cityId: almaty });
      expect(everything.total).toBe(4);
      expect(everything.brands.map((entry) => [entry.name, entry.count])).toEqual([
        ["Mobil", 2],
        ["Shell", 2],
      ]);
      const mine = await list(w.engineOils, { cityId: almaty, onlyMyCity: "true" });
      expect(ids(mine)).toEqual([w.helixHx8, w.mobilSuper].sort());
      expect(mine.total).toBe(2);
      expect(
        (await list(w.engineOils, { availability: "on_order" })).items.map((entry) => entry.id),
      ).toEqual([w.mobilSuper]);
      expect(
        (await list(w.engineOils, { receiving: "delivery" })).items.map((entry) => entry.id),
      ).toEqual([w.helixUltra]);
      const shellId = everything.brands.find((entry) => entry.name === "Shell")!.id;
      expect(ids(await list(w.engineOils, { brandIds: shellId }))).toEqual(
        [w.helixHx8, w.helixUltra].sort(),
      );

      // A list attribute: any of the options.
      const byViscosity = await list(w.engineOils, {
        attributes: JSON.stringify([{ attributeId: w.viscosity, optionIds: [w.fiveW30] }]),
      });
      expect(ids(byViscosity)).toEqual([w.helixHx8, w.mobilEsp].sort());
      // A number: the range; the item without a volume never passes.
      const byVolume = await list(w.engineOils, {
        attributes: JSON.stringify([{ attributeId: w.volume, min: 2, max: 5 }]),
      });
      expect(ids(byVolume)).toEqual([w.helixHx8, w.mobilSuper].sort());
      expect(byVolume.total).toBe(2);
      // Together with «only my city»: the count changes again.
      expect(
        (
          await list(w.engineOils, {
            cityId: almaty,
            onlyMyCity: "true",
            attributes: JSON.stringify([
              { attributeId: w.viscosity, optionIds: [w.fiveW30, w.fiveW40] },
              { attributeId: w.volume, min: 4 },
            ]),
          })
        ).total,
      ).toBe(2);
      // An archived attribute filters nothing.
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM attribute WHERE id = $1",
        [w.volume],
      );
      await ok(
        asAdmin("post", `/admin/catalog/attributes/${w.volume}/status`, {
          status: "archived",
          expectedVersion: rows[0]!.version,
        }),
        (body) => body,
      );
      const archived = await list(w.engineOils, {
        attributes: JSON.stringify([{ attributeId: w.volume, min: 2, max: 5 }]),
      });
      expect(archived.total).toBe(4);
      // The key characteristics: the first two filterable ones with a value.
      const hx8 = archived.items.find((entry) => entry.id === w.helixHx8)!;
      expect(hx8.keyAttributes.map((entry) => entry.display.text)).toEqual(["5W-30", "API SP"]);

      // Empty because of the filters.
      const none = await list(w.engineOils, { availability: "on_order", receiving: "delivery" });
      expect(none).toMatchObject({ items: [], total: 0, empty: "filters", nextCursor: null });
      // A filter of the wrong kind for its attribute, and broken JSON, are refused.
      expectError(
        await guest(
          `/catalog/categories/${w.engineOils}/items?attributes=${encodeURIComponent(JSON.stringify([{ attributeId: w.viscosity, min: 1 }]))}`,
        ),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await guest(`/catalog/categories/${w.engineOils}/items?attributes=%5Bnope`),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("applies the car by D-029: an item that doesn't fit leaves the list, one that needs details stays", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.frontPads);
      await put(shop, w.helixHx8);

      // The pads fit Atlas II.
      const atlasII = await list(w.brakePads, { vehicleGenerationId: w.atlasII });
      expect(atlasII.items[0]!.compatibility).toMatchObject({ result: "fits", mark: "fits" });
      // Not Coolray: out of the list, «nothing for this car».
      const coolray = await list(w.brakePads, { vehicleGenerationId: w.coolrayI });
      expect(coolray).toMatchObject({ items: [], total: 0, empty: "vehicle" });
      expect(coolray.vehicle).toMatchObject({ generationId: w.coolrayI, modelId: w.coolray });
      // Opened directly: shown with the warning.
      const direct = await card(w.frontPads, { vehicleGenerationId: w.coolrayI });
      expect(direct.compatibility).toMatchObject({
        result: "does_not_fit",
        listed: false,
        requiresConfirmation: true,
      });
      expect(direct.offers).toHaveLength(1);
      expect(direct.fitsFor).toEqual([expect.objectContaining({ make: "Geely", model: "Atlas" })]);

      // The oil's record names the engine: a Coolray without it — «уточните параметр».
      const oils = await list(w.engineOils, { vehicleModelId: w.coolray });
      expect(oils.items.find((entry) => entry.id === w.helixHx8)!.compatibility).toMatchObject({
        result: "needs_details",
        missing: expect.arrayContaining(["engine"]),
        listed: true,
      });
      const withEngine = await list(w.engineOils, {
        vehicleModelId: w.coolray,
        vehicleEngineId: w.e3G15,
      });
      expect(withEngine.items[0]!.compatibility.result).toBe("fits");
      // An inconsistent car is refused as the compatibility check refuses it.
      expectError(
        await guest(
          `/catalog/categories/${w.brakePads}/items?vehicleModelId=${w.atlas}&vehicleGenerationId=${w.coolrayI}`,
        ),
        400,
        "COMPATIBILITY_VEHICLE_INVALID",
      );
    });

    it("orders by price, by date and by «Рекомендуемые» with its weights, and pages without gaps", async () => {
      const w = await world();
      const inAlmaty = await company("Автомаркет", almaty);
      const inAstana = await company("Деталь Астана", astana, { verified: true });
      // Hx8: cheap but in three days, in Almaty. Mobil Super: dear, today, in Astana.
      await put(inAlmaty, w.helixHx8, { price: 6_000, availability: "on_order", leadDays: 3 });
      await put(inAstana, w.mobilSuper, { price: 9_000 });
      const order = async (query: Record<string, string>) =>
        (await list(w.engineOils, query)).items.map((entry) => entry.id);

      expect(await order({ sort: "cheaper" })).toEqual([w.helixHx8, w.mobilSuper]);
      expect(await order({ sort: "faster" })).toEqual([w.mobilSuper, w.helixHx8]);
      // Recommended in Almaty: the city outweighs the rest by default.
      expect(await order({ cityId: almaty })).toEqual([w.helixHx8, w.mobilSuper]);
      expect(await order({ cityId: astana })).toEqual([w.mobilSuper, w.helixHx8]);
      // The weights are a setting: only the price — the cheaper one first anywhere.
      await settings.set({
        catalog_recommended_weights: { price: 1, receipt: 0, city: 0, verified: 0, rating: 0 },
      });
      expect(await order({ cityId: astana })).toEqual([w.helixHx8, w.mobilSuper]);
      // Only the date — the sooner one first anywhere.
      await settings.set({
        catalog_recommended_weights: { price: 0, receipt: 1, city: 0, verified: 0, rating: 0 },
      });
      expect(await order({ cityId: almaty })).toEqual([w.mobilSuper, w.helixHx8]);
      // Only «verified partner».
      await settings.set({
        catalog_recommended_weights: { price: 0, receipt: 0, city: 0, verified: 1, rating: 0 },
      });
      expect(await order({ cityId: almaty })).toEqual([w.mobilSuper, w.helixHx8]);
    });

    it("pages every order without skipping or repeating, equal prices included", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const other = await company("Деталь Астана", astana);
      const brand = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'shell'", []);
      // 23 more oils, most of them at one price.
      const created: string[] = [];
      for (let n = 0; n < 23; n++) {
        const item = await ok(
          asAdmin("post", "/admin/catalog/items", {
            type: "generic",
            categoryId: w.engineOils,
            brandId: brand,
            names: { ru: `Масло тестовое ${String(n)}` },
            values: [{ attributeId: w.volume, value: n + 1 }],
          }),
          (body) => (body as { item: { id: string } }).item.id,
          201,
        );
        created.push(item);
        await put(n % 2 === 0 ? shop : other, item, {
          price: n % 5 === 0 ? 7_000 : 5_000,
          leadDays: n % 3,
          availability: n % 3 === 0 ? "in_stock" : "on_order",
        });
      }
      for (const sort of ["recommended", "cheaper", "faster"] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page: ShowcaseListResponse = await list(w.engineOils, {
            sort,
            cityId: almaty,
            limit: "4",
            ...(cursor ? { cursor } : {}),
          });
          expect(page.total).toBe(23);
          seen.push(...page.items.map((entry) => entry.id));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor);
        expect(pages, sort).toBe(6);
        expect(seen.length, sort).toBe(23);
        expect(new Set(seen), sort).toEqual(new Set(created));
        const whole = (await list(w.engineOils, { sort, cityId: almaty, limit: "50" })).items.map(
          (entry) => entry.id,
        );
        expect(seen, sort).toEqual(whole);
      }
      const cheaper = (await list(w.engineOils, { sort: "cheaper", limit: "50" })).items;
      const prices = cheaper.map((entry) => entry.offers.minPrice);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      // Equal prices keep one order: by the date, then by the id.
      const equal = cheaper.filter((entry) => entry.offers.minPrice === 5_000);
      const keys = equal.map((entry) => `${entry.offers.nearestReceipt.date}|${entry.id}`);
      expect(keys).toEqual([...keys].sort());

      // A cursor of another order, or made up, is refused.
      const first = await list(w.engineOils, { sort: "cheaper", limit: "4" });
      expectError(
        await guest(
          `/catalog/categories/${w.engineOils}/items?sort=faster&cursor=${first.nextCursor!}`,
        ),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await guest(`/catalog/categories/${w.engineOils}/items?cursor=bm9wZQ`),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("tells the empty states apart, shows services by city only, and hides hidden subcategories", async () => {
      const w = await world();
      expect(await list(w.brakePads)).toMatchObject({ items: [], total: 0, empty: "no_items" });
      expect(await list(w.oilChange)).toMatchObject({ items: [], empty: "city_required" });
      expect(await list(w.oilChange, { cityId: almaty })).toMatchObject({
        items: [],
        empty: "no_items",
      });
      expectError(
        await guest(`/catalog/categories/${w.brakePads}/items?cityId=${w.geely}`),
        400,
        "VALIDATION_ERROR",
      );
      const node = await idOf("SELECT parent_id AS id FROM category WHERE id = $1", [w.brakePads]);
      // A node isn't a list of items.
      expectError(await guest(`/catalog/categories/${node}/items`), 404, "NOT_FOUND");
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM category WHERE id = $1",
        [w.brakePads],
      );
      await ok(
        asAdmin("post", `/admin/catalog/categories/${w.brakePads}/status`, {
          status: "hidden",
          expectedVersion: rows[0]!.version,
        }),
        (body) => body,
      );
      expectError(await guest(`/catalog/categories/${w.brakePads}/items`), 404, "NOT_FOUND");
      expectError(await guest(`/catalog/items/${w.frontPads}`), 404, "NOT_FOUND");
    });
  });

  // ------------------------------------------------------------- the card

  describe("the card of an item (M-CAT-07)", () => {
    it("gives photos, characteristics, compatibility, offers with dates and orders, analogs", async () => {
      const w = await world();
      const inAlmaty = await company("Автомаркет", almaty);
      const inAstana = await company("Деталь Астана", astana, { verified: true });
      const cheap = await put(inAlmaty, w.helixHx8, {
        price: 7_000,
        availability: "on_order",
        leadDays: 4,
        delivery: true,
        warrantyMonths: 12,
      });
      const fast = await put(inAstana, w.helixHx8, { price: 9_000, warrantyText: "Обмен 14 дней" });
      // Two approved photos in `link` mode (the default) — served without the storage.
      await db.query(
        `INSERT INTO item_photo (id, item_id, source_type, source_url, status, content_type, byte_size, width, height, checksum, sort, reviewed_at)
         VALUES ('11111111-1111-4111-8111-111111111111', $1, 'manufacturer', 'https://example.com/a.jpg', 'approved', 'image/jpeg', 10, 800, 600, repeat('a', 64), 1, now()),
                ('22222222-2222-4222-8222-222222222222', $1, 'manufacturer', 'https://example.com/b.jpg', 'approved', 'image/jpeg', 10, 800, 600, repeat('b', 64), 0, now()),
                ('33333333-3333-4333-8333-333333333333', $1, 'manufacturer', 'https://example.com/c.jpg', 'proposed', 'image/jpeg', 10, 800, 600, repeat('c', 64), 0, now())`,
        [w.helixHx8],
      );
      await db.query(
        "UPDATE catalog_item SET primary_photo_id = '11111111-1111-4111-8111-111111111111' WHERE id = $1",
        [w.helixHx8],
      );

      const opened = await card(w.helixHx8, { cityId: almaty }, undefined);
      expect(opened.item).toMatchObject({
        id: w.helixHx8,
        type: "generic",
        name: { text: "Shell Helix HX8 5W-30, 4 л" },
        brand: { name: "Shell" },
        category: { id: w.engineOils, compatibilityRequired: false },
      });
      expect(opened.item.photos.map((photo) => photo.url)).toEqual([
        "https://example.com/a.jpg",
        "https://example.com/b.jpg",
      ]);
      expect(opened.item.attributes.map((entry) => [entry.code, entry.display.text])).toEqual([
        ["viscosity", "5W-30"],
        ["approval", "API SP"],
        ["volume", "4 л"],
      ]);
      // Without a car: the item has records, nothing to compare them with.
      expect(opened.compatibility).toMatchObject({
        result: null,
        listed: true,
        hasCompatibility: true,
      });
      expect(opened.fitsFor).toEqual([
        expect.objectContaining({ make: "Geely", model: "Coolray", engine: "JLH-3G15TD" }),
      ]);
      expect(opened.noOffers).toBe(false);
      // Recommended in Almaty: its own offer first.
      expect(opened.offers.map((entry) => entry.id)).toEqual([cheap.id, fast.id]);
      const [first, second] = opened.offers;
      expect(first).toMatchObject({
        price: 7_000,
        availability: "on_order",
        leadDays: 4,
        pickup: true,
        delivery: true,
        warrantyMonths: 12,
        inCity: true,
        verifiedPartner: false,
        rating: null,
        newSupplier: true,
        city: { id: almaty },
      });
      expect(second).toMatchObject({
        verifiedPartner: true,
        warrantyMonths: null,
        inCity: false,
      });
      // The warranty text only with club access (TASK-020.A): a guest has no such field.
      expect(opened.offers.some((entry) => "warrantyText" in entry)).toBe(false);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await grant(MEMBER_PHONE);
      expect(
        (await card(w.helixHx8, { cityId: almaty }, member)).offers.map(
          (entry) => entry.warrantyText,
        ),
      ).toEqual([null, "Обмен 14 дней"]);
      // The dates are those of `receiptDate` for a confirmation now.
      const expected = receiptDate(new Date(), 4, {
        timeZone: "Asia/Almaty",
        weeklyHours: ALWAYS,
        closedDates: [],
      });
      expect(expected.ok && first!.receipt.date).toBe(expected.ok ? expected.date : false);
      expect(first!.receipt.timeZone).toBe("Asia/Almaty");
      expect(second!.receipt.date).toBe(second!.receipt.confirmedOn);

      const orderOf = async (sort: string) =>
        (await card(w.helixHx8, { cityId: almaty, sort })).offers.map((entry) => entry.id);
      expect(await orderOf("cheaper")).toEqual([cheap.id, fast.id]);
      expect(await orderOf("faster")).toEqual([fast.id, cheap.id]);
      // No ratings yet: «Рейтинг» keeps the recommended order.
      expect(await orderOf("rating")).toEqual([cheap.id, fast.id]);
      expect((await card(w.helixHx8, { cityId: astana })).offers.map((entry) => entry.id)).toEqual([
        fast.id,
        cheap.id,
      ]);
    });

    it("opened by a link without offers: «no offers now» with the analog that has them (D-031)", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.trwPads, { price: 8_500 });
      const opened = await card(w.frontPads);
      expect(opened).toMatchObject({ noOffers: true, offers: [] });
      expect(opened.analogs).toEqual([
        expect.objectContaining({
          id: w.trwPads,
          article: "GDB3534",
          offers: expect.objectContaining({ count: 1, minPrice: 8_500 }),
        }),
      ]);
      // With a car the analog doesn't fit, it isn't offered as an analog.
      expect((await card(w.frontPads, { vehicleGenerationId: w.coolrayI })).analogs).toEqual([]);
      // Archived and unknown items — 404.
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM catalog_item WHERE id = $1",
        [w.rearPads],
      );
      await ok(
        asAdmin("post", `/admin/catalog/items/${w.rearPads}/status`, {
          expectedVersion: rows[0]!.version,
          status: "archived",
        }),
        (body) => body,
      );
      expectError(await guest(`/catalog/items/${w.rearPads}`), 404, "NOT_FOUND");
      expectError(
        await guest("/catalog/items/9b2c7c1e-0000-4000-8000-000000000000"),
        404,
        "NOT_FOUND",
      );
      expectError(await guest("/catalog/items/not-a-uuid"), 400, "VALIDATION_ERROR");
    });

    it("keeps a very long Kazakh name whole", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.frontPads);
      const long = "Алдыңғы тежегіш қалыптарының жиынтығы ".repeat(8).trim();
      await db.query(
        "UPDATE translation SET text = $2 WHERE entity_type = 'catalog_item' AND entity_id = $1 AND lang = 'kk'",
        [w.frontPads, long],
      );
      const page = await ok(
        guest(`/catalog/categories/${w.brakePads}/items`).set("Accept-Language", "kk"),
        (body) => showcaseListResponseSchema.parse(body),
      );
      expect(page.items[0]!.name).toEqual({ text: long, isFallback: false });
      expect(page.language).toBe("kk");
    });
  });

  // ------------------------------------------------------- what roles see

  describe("what each role sees of suppliers (D-005, D-030)", () => {
    it("hides the name, id, district and address without club access; shows them with it; never the phone or hours", async () => {
      const w = await world();
      const inAlmaty = await company("Автомаркет", almaty);
      const inAstana = await company("Деталь Астана", astana);
      const offerA = await put(inAlmaty, w.frontPads, { price: 11_000 });
      await put(inAstana, w.frontPads, { price: 12_500 });
      const user = await sessionToken(USER_PHONE, IOS);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await grant(MEMBER_PHONE);
      const routes = [
        `/catalog/categories/${w.brakePads}/items?cityId=${almaty}`,
        `/catalog/items/${w.frontPads}?cityId=${almaty}`,
        `/catalog/items/${w.trwPads}`,
        "/catalog/categories",
        `/catalog/categories/${w.brakePads}/attributes`,
      ];
      for (const path of routes) {
        for (const [who, response] of [
          ["guest", await guest(path)],
          ["user", await as(user, path)],
        ] as const) {
          expect(response.status, `${who} ${path}`).toBe(200);
          expectNothingOf(response.body, [inAlmaty, inAstana]);
        }
        const club = await as(member, path);
        expect(club.status).toBe(200);
        // The phone and the hours are for nobody before an order is accepted.
        expect(JSON.stringify(club.body)).not.toContain(inAlmaty.contactPhone);
        expect(JSON.stringify(club.body)).not.toContain("weeklyHours");
      }
      const compat = await http()
        .post("/catalog/compatibility/check")
        .set("X-Client", IOS)
        .send({ itemIds: [w.frontPads] });
      expectNothingOf(compat.body, [inAlmaty, inAstana]);

      // Field by field, on the card: absent, not empty.
      const asGuest = await card(w.frontPads, { cityId: almaty });
      const asUser = await card(w.frontPads, { cityId: almaty }, user);
      const asMember = await card(w.frontPads, { cityId: almaty }, member);
      expect(asGuest.viewer).toEqual({ signedIn: false, clubAccess: false });
      expect(asUser.viewer).toEqual({ signedIn: true, clubAccess: false });
      expect(asMember.viewer).toEqual({ signedIn: true, clubAccess: true });
      for (const entry of asGuest.offers) {
        expect(Object.keys(entry.supplier).sort()).toEqual(["kind", "reason"]);
        expect(entry.supplier).toEqual({ kind: "hidden", reason: "auth_required" });
      }
      for (const entry of asUser.offers) {
        expect(Object.keys(entry.supplier).sort()).toEqual(["kind", "reason"]);
        expect(entry.supplier).toEqual({ kind: "hidden", reason: "subscription_required" });
      }
      const offerKeys = Object.keys(asGuest.offers[0]!).sort();
      expect(offerKeys).not.toContain("supplierId");
      expect(offerKeys).not.toContain("warrantyText");
      expect(Object.keys(asUser.offers[0]!).sort()).toEqual(offerKeys);
      // Club access adds the warranty text (TASK-020.A) and nothing else.
      expect(Object.keys(asMember.offers[0]!).sort()).toEqual(
        [...offerKeys, "warrantyText"].sort(),
      );
      expect(asMember.offers.map((entry) => entry.supplier)).toEqual([
        {
          kind: "visible",
          id: inAlmaty.supplierId,
          name: "Автомаркет",
          district: inAlmaty.district,
          address: inAlmaty.address,
        },
        {
          kind: "visible",
          id: inAstana.supplierId,
          name: "Деталь Астана",
          district: inAstana.district,
          address: inAstana.address,
        },
      ]);
      // The list carries nothing of suppliers for anyone.
      expectNothingOf(await list(w.brakePads, {}, member), [inAlmaty, inAstana]);

      // The id of an offer leads nowhere without the supplier's own session.
      expectError(
        await http().get(`/supplier/offers/${offerA.id}`).set("X-Client", IOS),
        401,
        "AUTH_REQUIRED",
      );
      expectError(await as(user, `/supplier/offers/${offerA.id}`), 403, "FORBIDDEN");
      expectError(await as(member, `/supplier/offers/${offerA.id}`), 403, "FORBIDDEN");
      expectError(
        await as(member, `/admin/suppliers/${inAlmaty.supplierId}/offers`),
        403,
        "FORBIDDEN",
      );
      expectError(await inAstana.as("get", `/supplier/offers/${offerA.id}`), 404, "NOT_FOUND");

      // Revoked — the names are gone on the next request.
      await ok(
        asAdmin("post", "/admin/club-access/revoke", {
          phone: MEMBER_PHONE,
          reason: "Конец альфы",
        }),
        (body) => body,
      );
      const after = await card(w.frontPads, { cityId: almaty }, member);
      expect(after.offers.map((entry) => entry.supplier.kind)).toEqual(["hidden", "hidden"]);
      expectNothingOf(after, [inAlmaty, inAstana]);
    });

    it("ends club access that expires during a session, on the very next request", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.frontPads);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await grant(MEMBER_PHONE);
      expect((await card(w.frontPads, {}, member)).offers[0]!.supplier.kind).toBe("visible");
      await db.query("UPDATE club_access_grant SET valid_until = now() - interval '1 hour'");
      const expired = await card(w.frontPads, {}, member);
      expect(expired.viewer.clubAccess).toBe(false);
      expect(expired.offers[0]!.supplier).toEqual({
        kind: "hidden",
        reason: "subscription_required",
      });
    });

    it("holds a sent token to the session rules: a broken one is 401, another context 403", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const path = `/catalog/items/${w.frontPads}`;
      expectError(
        await http().get(path).set("X-Client", IOS).set("Authorization", "Bearer nonsense"),
        401,
        "AUTH_REQUIRED",
      );
      expectError(await shop.as("get", path), 403, "FORBIDDEN");
      expectError(await asAdmin("get", path), 403, "FORBIDDEN");
    });
  });

  describe("TASK-020.A", () => {
    it("gives the warranty text only with club access; the months to everyone", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const other = await company("Деталь Астана", astana);
      await put(shop, w.frontPads, { price: 11_000, warrantyText: "12 месяцев по чеку" });
      await put(other, w.frontPads, { price: 12_500, warrantyMonths: 6 });
      const user = await sessionToken(USER_PHONE, IOS);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await grant(MEMBER_PHONE);
      const sorted = { cityId: almaty, sort: "cheaper" };
      for (const answer of [
        await card(w.frontPads, sorted),
        await card(w.frontPads, sorted, user),
      ]) {
        expect(answer.offers.map((entry) => entry.warrantyMonths)).toEqual([null, 6]);
        for (const entry of answer.offers) {
          expect(Object.keys(entry)).not.toContain("warrantyText");
        }
        expect(JSON.stringify(answer)).not.toContain("по чеку");
      }
      const club = await card(w.frontPads, sorted, member);
      expect(club.offers.map((entry) => [entry.warrantyMonths, entry.warrantyText])).toEqual([
        [null, "12 месяцев по чеку"],
        [6, null],
      ]);
      // The list never carries it.
      expect(JSON.stringify(await list(w.brakePads, {}, member))).not.toContain("по чеку");
    });

    it("one showcase rule: the rule, its SQL twin and the catalog agree, closed dates over the horizon included", async () => {
      const w = await world();
      const shown = await company("Автомаркет", almaty);
      const inventory = await company("Инвентаризация", almaty);
      const noHours = await company("Без часов", almaty, { hours: null });
      const never = await company("Без рабочих дней", almaty, { hours: NEVER });
      const offers = [
        await put(shown, w.frontPads, { price: 11_000 }),
        await put(inventory, w.frontPads, { price: 10_000 }),
        await put(inventory, w.trwPads, { price: 9_000, availability: "on_order", leadDays: 5 }),
        await put(noHours, w.frontPads, { price: 9_500 }),
        await put(never, w.frontPads, { price: 9_700 }),
      ];
      const ids = offers.map((entry) => entry.id);
      const database = app.get(DatabaseService).db;
      const schedule = async (of: Company, closedDates: { date: string; note: string }[]) =>
        ok(
          asAdmin("put", `/admin/suppliers/${of.supplierId}/schedule`, {
            expectedVersion: await supplierVersion(of.supplierId),
            weeklyHours: ALWAYS,
            closedDates,
          }),
          (body) => body,
        );
      /** What the three places say: the rule, the SQL twin, the catalog (list and cards). */
      const threePlaces = async () => {
        const now = new Date();
        const rule = await offerShowcase(database, ids, now);
        const twin = await database
          .select({ id: offer.id })
          .from(offer)
          .where(and(inArray(offer.id, ids), shownOffers(now)));
        const cards = [...(await card(w.frontPads)).offers, ...(await card(w.trwPads)).offers].map(
          (entry) => entry.id,
        );
        const listed = (await list(w.brakePads, { limit: "50" })).items;
        return {
          rule: ids.filter((id) => rule.get(id)!.visible).sort(),
          twin: twin.map((row) => row.id).sort(),
          catalog: cards.sort(),
          listedCounts: Object.fromEntries(listed.map((entry) => [entry.id, entry.offers.count])),
          reasons: ids.map((id) => rule.get(id)!.reasons),
        };
      };

      // Closed dates over the whole horizon: hidden everywhere, with the reason.
      await schedule(inventory, closedHorizon());
      const closed = await threePlaces();
      expect(closed.twin).toEqual(closed.rule);
      expect(closed.catalog).toEqual(closed.rule);
      expect(closed.rule).toEqual([offers[0]!.id]);
      expect(closed.listedCounts).toEqual({ [w.frontPads]: 1 });
      expect(closed.reasons).toEqual([
        [],
        ["no_working_day"],
        ["no_working_day"],
        ["hours_not_set"],
        ["no_working_day"],
      ]);
      // The supplier sees the reason in «Мои предложения».
      const mine = await ok(inventory.as("get", "/supplier/offers"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(mine.offers.map((entry) => entry.showcase)).toEqual([
        { visible: false, reasons: ["no_working_day"] },
        { visible: false, reasons: ["no_working_day"] },
      ]);

      // One day of the horizon opened again: shown everywhere, the date is that day.
      const horizon = closedHorizon();
      await schedule(
        inventory,
        horizon.filter((_, index) => index !== 21),
      );
      const reopened = await threePlaces();
      expect(reopened.twin).toEqual(reopened.rule);
      expect(reopened.catalog).toEqual(reopened.rule);
      expect(reopened.rule).toEqual([offers[0]!.id, offers[1]!.id, offers[2]!.id].sort());
      expect(reopened.listedCounts).toEqual({ [w.frontPads]: 2, [w.trwPads]: 1 });
      const inventoryOffer = (await card(w.frontPads)).offers.find(
        (entry) => entry.id === offers[1]!.id,
      );
      expect(inventoryOffer?.receipt.date).toBe(horizon[21]!.date);
      // A long term runs past the rest of the closure: still a date.
      const onOrder = (await card(w.trwPads)).offers[0]!;
      expect(onOrder.receipt.date > horizon.at(-1)!.date).toBe(true);

      // All dates opened: every place agrees again.
      await schedule(inventory, []);
      const open = await threePlaces();
      expect(open.twin).toEqual(open.rule);
      expect(open.catalog).toEqual(open.rule);
    });

    it("pages «Рекомендуемые» without skipping or repeating when offers and weights change between pages", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const brand = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'shell'", []);
      const item = async (n: number) =>
        ok(
          asAdmin("post", "/admin/catalog/items", {
            type: "generic",
            categoryId: w.engineOils,
            brandId: brand,
            names: { ru: `Масло страницы ${String(n)}` },
            values: [{ attributeId: w.volume, value: n + 1 }],
          }),
          (body) => (body as { item: { id: string } }).item.id,
          201,
        );
      // The price part is measured against the cheapest offer: with it at
      // 1 000 a dear item received today ranks before a cheaper one in
      // three days; measured against 5 000 (the cheapest gone), after it.
      await settings.set({
        catalog_recommended_weights: { price: 1, receipt: 0.1, city: 0, verified: 0, rating: 0 },
      });
      const cheapest = await put(shop, w.helixHx8, { price: 1_000 });
      await put(shop, w.mobilSuper, { price: 6_000 });
      await put(shop, w.helixUltra, { price: 5_000, availability: "on_order", leadDays: 3 });
      await put(shop, w.mobilEsp, { price: 5_200, availability: "on_order", leadDays: 3 });
      const fillers: string[] = [];
      for (let n = 0; n < 6; n++) {
        const id = await item(n);
        fillers.push(id);
        await put(shop, id, { price: 20_000 + n * 1_000 });
      }
      const everything = [w.helixHx8, w.mobilSuper, w.helixUltra, w.mobilEsp, ...fillers];

      const pageThrough = async (between: (page: number) => Promise<void>) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let page = 0;
        do {
          const answer: ShowcaseListResponse = await list(w.engineOils, {
            limit: "2",
            ...(cursor ? { cursor } : {}),
          });
          seen.push(...answer.items.map((entry) => entry.id));
          cursor = answer.nextCursor;
          page += 1;
          if (cursor) {
            await between(page);
          }
        } while (cursor);
        return seen;
      };

      const first = (await list(w.engineOils, { limit: "2" })).items.map((entry) => entry.id);
      expect(first).toEqual([w.helixHx8, w.mobilSuper]);

      // The cheapest offer is withdrawn after the first page.
      const withdrawn = await pageThrough(async (page) => {
        if (page === 1) {
          await ok(
            shop.as("post", `/supplier/offers/${cheapest.id}/withdraw`, { expectedVersion: 1 }),
            (body) => body,
          );
        }
      });
      expect(withdrawn.length).toBe(new Set(withdrawn).size);
      expect(new Set(withdrawn)).toEqual(new Set(everything));
      // A new list is measured afresh: the cheaper one in three days now leads.
      const fresh = (await list(w.engineOils, { limit: "3" })).items.map((entry) => entry.id);
      expect(fresh).toEqual([w.helixUltra, w.mobilEsp, w.mobilSuper]);

      // The weights change after the first page, and an offer appears on a new item.
      await ok(
        shop.as("post", `/supplier/offers/${cheapest.id}/return`, { expectedVersion: 2 }),
        (body) => body,
      );
      const late = await item(99);
      const changed = await pageThrough(async (page) => {
        if (page === 1) {
          await settings.set({
            catalog_recommended_weights: { price: 0, receipt: 1, city: 0, verified: 0, rating: 0 },
          });
          await put(shop, late, { price: 500 });
        }
      });
      expect(changed.length).toBe(new Set(changed).size);
      for (const id of everything) {
        expect(
          changed.filter((entry) => entry === id),
          id,
        ).toHaveLength(1);
      }

      // A cursor with a made-up frame is refused; one of another order carries none.
      const bad = Buffer.from(
        JSON.stringify({ s: "recommended", k: [-1, 1, "2026-01-01", w.helixHx8], f: { p: -1 } }),
      ).toString("base64url");
      expectError(
        await guest(`/catalog/categories/${w.engineOils}/items?cursor=${bad}`),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("limits the catalog: a guest by address (IPv6 by /64), a session by its account; served without Redis", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.frontPads);
      const user = await sessionToken(USER_PHONE, IOS);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await settings.set({ catalog_read_per_ip: 4, catalog_read_per_account: 3 });
      const listPath = `/catalog/categories/${w.brakePads}/items`;
      const cardPath = `/catalog/items/${w.frontPads}`;
      const from = (ip: string, path: string, bearer?: string) => {
        const test = http().get(path).set("X-Client", IOS).set("X-Forwarded-For", ip);
        return bearer ? test.set("Authorization", `Bearer ${bearer}`) : test;
      };

      // Guests share the address: the list and the card count together.
      const ip = "203.0.113.50";
      for (const path of [listPath, cardPath, listPath, cardPath]) {
        expect((await from(ip, path)).status).toBe(200);
      }
      const limited = await from(ip, cardPath);
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details.limit).toBe("catalog_read_per_ip");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect((await from("203.0.113.51", listPath)).status).toBe(200);

      // Sessions behind the very same address are counted by account.
      for (let n = 0; n < 3; n++) {
        expect((await from(ip, listPath, user)).status).toBe(200);
      }
      const userLimited = await from(ip, cardPath, user);
      expectError(userLimited, 429, "RATE_LIMITED");
      expect(userLimited.body.details.limit).toBe("catalog_read_per_account");
      // …from any address.
      expectError(await from("198.51.100.200", listPath, user), 429, "RATE_LIMITED");
      // Another person behind the same address isn't affected.
      expect((await from(ip, listPath, member)).status).toBe(200);

      // IPv6: one /64 network is one guest bucket, another network its own.
      const net = "2001:db8:abcd:12";
      for (let n = 0; n < 4; n++) {
        expect((await from(`${net}::${String(n + 1)}`, listPath)).status).toBe(200);
      }
      expectError(await from(`${net}:ffff::9`, listPath), 429, "RATE_LIMITED");
      expect((await from("2001:db8:abcd:13::1", listPath)).status).toBe(200);

      // Ordinary browsing never reaches the default limits.
      await settings.set({ catalog_read_per_ip: 300, catalog_read_per_account: 120 });
      await redis.flushall();
      for (let n = 0; n < 40; n++) {
        expect((await from("203.0.113.60", n % 2 ? cardPath : listPath)).status).toBe(200);
        expect((await from("203.0.113.60", n % 2 ? cardPath : listPath, member)).status).toBe(200);
      }

      // Without Redis the catalog is read by guests and sessions alike.
      await settings.set({ catalog_read_per_ip: 1, catalog_read_per_account: 1 });
      await redisProxy.stop();
      try {
        for (let n = 0; n < 3; n++) {
          expect((await from(ip, listPath)).status).toBe(200);
          expect((await from(ip, cardPath, user)).status).toBe(200);
        }
      } finally {
        await redisProxy.start();
      }
      const deadline = Date.now() + 20_000;
      let status = 0;
      while (Date.now() < deadline) {
        status = (await from("203.0.113.70", listPath)).status;
        if (status === 200 && (await from("203.0.113.70", listPath)).status === 429) {
          status = 429;
          break;
        }
        await redis.flushall();
        await sleep(250);
      }
      expect(status).toBe(429);
      expect(output.text()).toContain("Served without the limit limit=catalog_read_per_ip");
      expect(output.text()).toContain("Served without the limit limit=catalog_read_per_account");
    });

    it("keeps services outside the chosen city out of the analogs, as the list and the card", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const seeded = await put(shop, w.frontPads);
      const service = async (name: string) =>
        ok(
          asAdmin("post", "/admin/catalog/items", {
            type: "service",
            categoryId: w.oilChange,
            names: { ru: name },
          }),
          (body) => (body as { item: { id: string } }).item.id,
          201,
        );
      const main = await service("Замена масла с фильтром");
      const analog = await service("Замена масла экспресс");
      // Services have no offers and no analogs until TASK-019: the checks
      // that say so are lifted for this test only, to see the rule the
      // analogs share with the list and the card.
      await db.query("ALTER TABLE offer DROP CONSTRAINT offer_item_type_check");
      await db.query("ALTER TABLE item_analog DROP CONSTRAINT item_analog_type_check");
      try {
        for (const itemId of [main, analog]) {
          await db.query(
            `INSERT INTO offer (supplier_id, location_id, item_id, item_type, price, availability,
               lead_days, pickup, delivery, created_by_member_id, updated_by_member_id)
             SELECT supplier_id, location_id, $2, 'service', 3000, 'in_stock', 0, true, false,
               created_by_member_id, updated_by_member_id
             FROM offer WHERE id = $1`,
            [seeded.id, itemId],
          );
        }
        const [low, high] = [main, analog].sort();
        await db.query(
          "INSERT INTO item_analog (item_id, analog_item_id, category_id, item_type) VALUES ($1, $2, $3, 'service')",
          [low, high, w.oilChange],
        );
        const inAlmaty = await card(main, { cityId: almaty });
        expect(inAlmaty.offers).toHaveLength(1);
        expect(inAlmaty.analogs.map((entry) => entry.id)).toEqual([analog]);
        for (const query of [{ cityId: astana }, {}] as Record<string, string>[]) {
          const elsewhere = await card(main, query);
          expect(elsewhere.offers).toEqual([]);
          expect(elsewhere.analogs).toEqual([]);
        }
        expect((await list(w.oilChange, { cityId: astana })).items).toEqual([]);
        expect((await list(w.oilChange, { cityId: almaty })).total).toBe(2);
      } finally {
        await db.query("DELETE FROM item_analog WHERE item_type = 'service'");
        await db.query("DELETE FROM offer WHERE item_type = 'service'");
        await db.query(
          "ALTER TABLE offer ADD CONSTRAINT offer_item_type_check CHECK (item_type IN ('part', 'generic'))",
        );
        await db.query(
          "ALTER TABLE item_analog ADD CONSTRAINT item_analog_type_check CHECK (item_type = 'part')",
        );
      }
    });
  });

  // ------------------------------------------------------------- caching

  describe("caching (TASK-020 requirement 4)", () => {
    it("lets caches keep a guest's answer only, and varies every answer on Authorization", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.frontPads);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await grant(MEMBER_PHONE);
      for (const path of [
        `/catalog/items/${w.frontPads}`,
        `/catalog/categories/${w.brakePads}/items`,
      ]) {
        const asGuest = await guest(path);
        expect(asGuest.headers["cache-control"]).toBe("public, max-age=60");
        expect(asGuest.headers.vary).toMatch(/Authorization/);
        expect(asGuest.headers.vary).toMatch(/Accept-Language/);
        const asMember = await as(member, path);
        expect(asMember.headers["cache-control"]).toBe("private, no-store");
        expect(asMember.headers.vary).toMatch(/Authorization/);
        // A guest sending the member's validator gets the guest's answer, not a 304.
        const conditional = await guest(path).set("If-None-Match", asMember.headers.etag as string);
        expect(conditional.status).toBe(200);
        expect(conditional.body).toEqual(asGuest.body);
      }
    });

    it("never hands the member's card to a guest through a shared cache, in either order", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      await put(shop, w.frontPads);
      const member = await sessionToken(MEMBER_PHONE, IOS);
      await grant(MEMBER_PHONE);
      const { server, url, stored } = await sharedCache(app.getHttpServer() as Server);
      try {
        const path = `/catalog/items/${w.frontPads}`;
        const memberFirst = await viaCache(url, path, { authorization: `Bearer ${member}` });
        expect((memberFirst.body as ShowcaseItemResponse).offers[0]!.supplier.kind).toBe("visible");
        const guestNext = await viaCache(url, path, {});
        expect(guestNext.cached).toBe(false);
        expectNothingOf(guestNext.body, [shop]);
        const guestAgain = await viaCache(url, path, {});
        expect(guestAgain.cached).toBe(true);
        expectNothingOf(guestAgain.body, [shop]);
        const memberAgain = await viaCache(url, path, { authorization: `Bearer ${member}` });
        expect(memberAgain.cached).toBe(false);
        expect((memberAgain.body as ShowcaseItemResponse).offers[0]!.supplier.kind).toBe("visible");
        // Nothing but the guest's answer was ever stored.
        expect(stored()).toEqual([`GET ${path} authorization=`]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  /**
   * A shared cache as RFC 9111 describes it, just enough for the question:
   * it stores an answer only when `Cache-Control` lets a shared cache
   * (neither `private` nor `no-store`, and `public`), keyed by the request
   * headers the answer `Vary`s on; it serves a fresh stored answer.
   */
  async function sharedCache(origin: Server) {
    const store = new Map<string, { status: number; body: string }>();
    const originUrl = `http://127.0.0.1:${String((origin.address() as AddressInfo).port)}`;
    const server = createServer((incoming, outgoing) => {
      const path = incoming.url ?? "/";
      const lookup = [...store.entries()].find(([key]) => {
        const [method, stored, ...vary] = key.split(" ");
        if (`${method} ${stored}` !== `${incoming.method} ${path}`) {
          return false;
        }
        return vary.every((pair) => {
          const [name, value] = pair.split("=");
          return (incoming.headers[name!] ?? "") === value;
        });
      });
      if (lookup) {
        outgoing.writeHead(lookup[1].status, {
          "content-type": "application/json",
          "x-cache": "hit",
        });
        outgoing.end(lookup[1].body);
        return;
      }
      const forwarded = httpRequest(
        `${originUrl}${path}`,
        { method: incoming.method, headers: incoming.headers },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const control = String(answer.headers["cache-control"] ?? "");
            if (/\bpublic\b/.test(control) && !/\b(private|no-store)\b/.test(control)) {
              const vary = String(answer.headers.vary ?? "")
                .split(",")
                .map((name) => name.trim().toLowerCase())
                .filter((name) => name === "authorization");
              const key = [
                `${incoming.method ?? "GET"} ${path}`,
                ...vary.map((name) => `${name}=${String(incoming.headers[name] ?? "")}`),
              ].join(" ");
              store.set(key, { status: answer.statusCode ?? 200, body });
            }
            outgoing.writeHead(answer.statusCode ?? 200, {
              "content-type": "application/json",
              "x-cache": "miss",
            });
            outgoing.end(body);
          });
        },
      );
      incoming.pipe(forwarded);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      server,
      url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      stored: () => [...store.keys()],
    };
  }

  function viaCache(
    url: string,
    path: string,
    headers: IncomingHttpHeaders,
  ): Promise<{ body: unknown; cached: boolean }> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        `${url}${path}`,
        { method: "GET", headers: { "x-client": IOS, ...headers } },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", () =>
            resolve({
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
              cached: answer.headers["x-cache"] === "hit",
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  // --------------------------------------------------------- performance

  describe("performance (TASK-020 requirement 5)", () => {
    it("lists a subcategory of thousands of items and offers in a fixed number of statements", async () => {
      const w = await world();
      const shops = [
        await company("Автомаркет", almaty),
        await company("Деталь Астана", astana),
        await company("Шины и масла", almaty, { verified: true }),
      ];
      const ITEMS = 3000;
      const brand = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'trw'", []);
      await db.query(
        `INSERT INTO catalog_item (item_type, category_id, category_kind, category_level, brand_id, article, article_norm)
         SELECT 'part', $1, 'goods', 2, $2, 'PERF-' || n, 'PERF' || n FROM generate_series(1, $3) AS n`,
        [w.brakePads, brand, ITEMS],
      );
      await db.query(
        `INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited)
         SELECT 'catalog_item', id, 'name', 'ru', 'Колодки ' || article, 'source', false
         FROM catalog_item WHERE article LIKE 'PERF-%'`,
      );
      const axle = await idOf("SELECT id FROM attribute WHERE category_id = $1 AND code = 'axle'", [
        w.brakePads,
      ]);
      const front = await idOf(
        "SELECT id FROM attribute_option WHERE attribute_id = $1 AND code = 'front'",
        [axle],
      );
      const rear = await idOf(
        "SELECT id FROM attribute_option WHERE attribute_id = $1 AND code = 'rear'",
        [axle],
      );
      await db.query(
        `INSERT INTO item_attribute_value (item_id, attribute_id, attribute_value_type, value_option_id, source)
         SELECT id, $1, 'enum', CASE WHEN right(article, 1) IN ('1','3','5','7','9') THEN $2::uuid ELSE $3::uuid END, 'admin'
         FROM catalog_item WHERE article LIKE 'PERF-%'`,
        [axle, front, rear],
      );
      // Half fit Atlas II, half Coolray.
      await db.query(
        `INSERT INTO item_compatibility (item_id, item_type, make_id, model_id, generation_id, source, evidence)
         SELECT id, 'part', $1, CASE WHEN right(article, 1) IN ('0','2','4','6','8') THEN $2::uuid ELSE $3::uuid END,
           CASE WHEN right(article, 1) IN ('0','2','4','6','8') THEN $4::uuid END, 'admin', 'perf'
         FROM catalog_item WHERE article LIKE 'PERF-%'`,
        [w.geely, w.atlas, w.coolray, w.atlasII],
      );
      // Two offers per item from different suppliers: 6 000 offers.
      for (const [index, shop] of shops.entries()) {
        await db.query(
          `INSERT INTO offer (supplier_id, location_id, item_id, item_type, price, availability, lead_days, pickup, delivery)
           SELECT $1, l.id, i.id, 'part', 5000 + (hashtext(i.id::text || $3) & 4095), 'in_stock', (hashtext(i.id::text) & 3), true, false
           FROM catalog_item i CROSS JOIN supplier_location l
           WHERE i.article LIKE 'PERF-%' AND l.supplier_id = $1
             AND (hashtext(i.id::text) & 3) <> $2`,
          [shop.supplierId, index, String(index)],
        );
      }
      await db.query(
        "ANALYZE offer; ANALYZE catalog_item; ANALYZE item_compatibility; ANALYZE item_attribute_value",
      );
      const { rows } = await db.query<{ count: string }>("SELECT count(*) FROM offer");
      const offers = Number(rows[0]!.count);
      expect(offers).toBeGreaterThan(ITEMS * 2 - 100);

      const pool = app.get(DatabaseService).pool;
      const original = pool.query.bind(pool);
      let statements = 0;
      (pool as unknown as { query: typeof pool.query }).query = ((
        ...args: Parameters<typeof pool.query>
      ) => {
        statements += 1;
        return (original as (...inner: unknown[]) => unknown)(...args);
      }) as typeof pool.query;
      const query = {
        cityId: almaty,
        vehicleGenerationId: w.atlasII,
        attributes: JSON.stringify([{ attributeId: axle, optionIds: [rear] }]),
        availability: "in_stock",
      };
      const timings: number[] = [];
      const counts: number[] = [];
      let page: ShowcaseListResponse | null = null;
      try {
        for (let run = 0; run < 5; run++) {
          statements = 0;
          const started = performance.now();
          page = await list(w.brakePads, run % 2 === 0 ? query : { ...query, sort: "cheaper" });
          timings.push(performance.now() - started);
          counts.push(statements);
        }
      } finally {
        (pool as unknown as { query: typeof pool.query }).query = original;
      }
      // Half fit Atlas II (article ends even), all of those rear.
      expect(page!.total).toBe(ITEMS / 2);
      expect(page!.items).toHaveLength(20);
      // Not a statement per item: the same handful for 1 500 items as for one.
      expect(Math.max(...counts)).toBeLessThan(40);
      const sorted = [...timings].sort((a, b) => a - b);
      process.stdout.write(
        `SHOWCASE PERF items=${String(ITEMS)} offers=${String(offers)} listed=${String(page!.total)} statements=${counts.join(",")} list_ms=${timings.map((t) => t.toFixed(1)).join(",")} median_ms=${sorted[2]!.toFixed(1)}\n`,
      );
      expect(sorted[2]!).toBeLessThan(3000);
    }, 180_000);
  });
});
