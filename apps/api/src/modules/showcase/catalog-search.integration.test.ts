import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  catalogSearchResponseSchema,
  searchSynonymListSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type CatalogSearchResponse,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
  type SupplierType,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle, searchKey, normalizeSearchText } from "@adclub/domain";
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
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import { DevCompatibilitySeed } from "../compatibility";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { DevVehicleSeed } from "../vehicles";

/**
 * TASK-044 end to end on a real PostgreSQL and Redis: the users' search
 * (`GET /catalog/search`) — the article in any spelling and a supplier's
 * own article, names and synonyms in kk/ru/en, the wrong layout, a Kazakh
 * word typed in the Russian layout, a corrected word (T-CAT-08); only what
 * the catalog shows — the showcase rule, D-029 for the car, a service only
 * in the chosen city at the price for the model, the supplier never named
 * to a guest; the one order and the pages; the limits, the caching, the
 * access; a query never in the output. The search synonyms of the
 * administrator (routes, journal, uniqueness) and the readings of the
 * query in the administrator's and the supplier's searches. The key of the
 * database (`search_key`) is the key of the domain (`searchKey`).
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const PADS = "04465-0K090";
const OIL_CHANGE = "Замена моторного масла";

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

const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;

describe("the search of the catalog (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
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
    as: (method: Method, path: string, body?: object) => Test;
  }

  async function company(
    name: string,
    cityId: string,
    options: { type?: SupplierType } = {},
  ): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const district = `Район ${name}`;
    const address = `ул. ${name}, ${String(phoneCounter)}`;
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId,
        type: options.type ?? "goods",
        contactPhone: phoneOf(500 + phoneCounter),
        address,
        district,
        firstMember: { name: "Айгерим", phone },
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
      name,
      district,
      address,
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
    const item = (brandKey: string, article: string) =>
      idOf(
        "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
        [brandKey, normalizeArticle(article)],
      );
    const named = (name: string) =>
      idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND lang = 'ru' AND text = $1",
        [name],
      );
    return {
      geely,
      atlas,
      coolray,
      atlasII: await idOf(
        "SELECT id FROM vehicle_generation WHERE model_id = $1 AND name_key = 'ii (fx11)'",
        [atlas],
      ),
      brakePads: await idOf("SELECT id FROM category WHERE code = 'brake_pads'", []),
      oilChange: await idOf("SELECT id FROM category WHERE code = 'oil_change'", []),
      frontPads: await item("geely", PADS),
      trwPads: await item("trw", "GDB3534"),
      rearPads: await item("geely", "4050068800"),
      mobilEsp: await named("Mobil 1 ESP 5W-30"),
      helixUltra: await named("Shell Helix Ultra 0W-20, 1 л"),
      oilService: await named(OIL_CHANGE),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  const atlasCar = (w: World) => ({
    vehicleMakeId: w.geely,
    vehicleModelId: w.atlas,
    vehicleGenerationId: w.atlasII,
    vehicleYear: "2023",
  });
  const coolrayCar = (w: World) => ({
    vehicleMakeId: w.geely,
    vehicleModelId: w.coolray,
    vehicleYear: "2024",
  });

  const guest = (path: string): Test => http().get(path).set("X-Client", IOS);

  function searchPath(q: string, query: Record<string, string> = {}): string {
    return `/catalog/search?${new URLSearchParams({ q, ...query }).toString()}`;
  }

  async function search(
    q: string,
    query: Record<string, string> = {},
    bearer?: string,
  ): Promise<CatalogSearchResponse> {
    const path = searchPath(q, query);
    return ok(bearer ? call(bearer, IOS, "get", path) : guest(path), (body) =>
      catalogSearchResponseSchema.parse(body),
    );
  }

  /** The pads of the dev catalog on offer with two suppliers, for Atlas II (D-029). */
  async function padsOnOffer(w: World) {
    const shop = await company("Автомаркет", almaty);
    const other = await company("Деталь Астана", astana);
    await put(shop, w.frontPads, { price: 14_000 });
    await put(other, w.trwPads, { price: 11_000, supplierSku: "TRW-77-AST" });
    await put(shop, w.rearPads, { price: 9_000 });
    return { shop, other };
  }

  // -------------------------------------------------------------- the key

  it("computes in the database the very key the domain computes (search_key = searchKey)", async () => {
    const samples = [
      "Тормозные колодки",
      "ТЕЖЕГІШ ҚАЛЫПТАРЫ",
      "Әйнек тазалағыш щёткалары",
      "Shell Helix HX8 5W-30, 4 л",
      "«Ёлка»—brake‐pads / №5",
      "  Ұлы  Һ  Ү Ө Ң Ғ Қ Ә І  ",
      "Mobil 1 ESP",
    ];
    const { rows } = await db.query<{ text: string; key: string }>(
      "SELECT search_text(s) AS text, search_key(s) AS key FROM unnest($1::text[]) AS s",
      [samples],
    );
    expect(rows.map((row) => row.text)).toEqual(samples.map(normalizeSearchText));
    expect(rows.map((row) => row.key)).toEqual(samples.map(searchKey));
  });

  // ---------------------------------------------------------- the article

  describe("the article", () => {
    it("finds the pads by their article in any spelling, first, as «по артикулу»", async () => {
      const w = await world();
      await padsOnOffer(w);
      for (const q of ["04465 0k090", "044650K090", "04465-0K090", "04465.0k.090"]) {
        const found = await search(q, atlasCar(w));
        expect(found.items[0], q).toMatchObject({ id: w.frontPads, match: "article" });
        expect(found.total, q).toBe(1);
        expect(found.usedQuery, q).toBeNull();
      }
    });

    it("finds an item by its supplier's own article only while that offer is visible", async () => {
      const w = await world();
      const { other } = await padsOnOffer(w);
      const found = await search("trw 77 ast", atlasCar(w));
      expect(found.items[0]).toMatchObject({ id: w.trwPads, match: "article" });
      const offerId = (
        await db.query<{ id: string; version: number }>(
          "SELECT id, version FROM offer WHERE item_id = $1",
          [w.trwPads],
        )
      ).rows[0]!;
      await ok(
        other.as("post", `/supplier/offers/${offerId.id}/withdraw`, {
          expectedVersion: offerId.version,
        }),
        (body) => body,
      );
      expect(await search("trw 77 ast", atlasCar(w))).toMatchObject({ total: 0, items: [] });
    });
  });

  // ------------------------------------------------------------- the text

  describe("the text", () => {
    it("leads «колодки», the wrong layout, «brake pads», Kazakh and transliteration to the same pads", async () => {
      const w = await world();
      await padsOnOffer(w);
      const expected = [w.trwPads, w.frontPads].sort();
      const cases: [string, string | null][] = [
        ["колодки", null],
        ["Колодки", null],
        ["тормозные колодки", null],
        ["brake pads", null],
        ["тежегіш", null],
        ["тежегиш калыптары", null],
        ["rjkjlrb", "колодки"],
        ["лjkjlrb", "колодки"],
        ["kolodki", "колодки"],
        ["тежег3ш", "тежегіш"],
      ];
      for (const [q, usedQuery] of cases) {
        const found = await search(q, atlasCar(w));
        expect(found.items.map((item) => item.id).sort(), q).toEqual(expected);
        expect(found.usedQuery, q).toBe(usedQuery);
        expect(found.query, q).toBe(normalizeSearchText(q));
        for (const item of found.items) {
          expect(item.compatibility.mark, q).toBe("fits");
          expect(item.category).toMatchObject({ id: w.brakePads, kind: "goods" });
        }
      }
      // A category to open, the subcategory of the pads first.
      expect((await search("колодки", atlasCar(w))).categories[0]).toMatchObject({
        id: w.brakePads,
        level: 2,
        kind: "goods",
      });
    });

    it("shows nothing that does not fit the car (D-029): another car — no pads, «vehicle»", async () => {
      const w = await world();
      await padsOnOffer(w);
      const forAtlas = await search("колодки", atlasCar(w));
      expect(forAtlas.items.map((item) => item.id)).not.toContain(w.rearPads);
      expect(await search("колодки", coolrayCar(w))).toMatchObject({
        items: [],
        total: 0,
        empty: "vehicle",
      });
    });

    it("finds nothing for nonsense, and nothing that is not on offer", async () => {
      const w = await world();
      expect(await search("колодки", atlasCar(w))).toMatchObject({ total: 0, empty: "no_items" });
      await padsOnOffer(w);
      expect(await search("xyzxyz", atlasCar(w))).toMatchObject({
        total: 0,
        empty: "no_items",
        usedQuery: null,
        categories: [],
      });
    });

    it("puts both items in, by the order, when a synonym of one is the name of the other", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const other = await company("Масла Астана", astana);
      await put(shop, w.mobilEsp, { price: 20_000 });
      await put(other, w.helixUltra, { price: 9_000 });
      await ok(
        asAdmin("post", `/admin/catalog/items/${w.helixUltra}/synonyms`, {
          term: "Mobil 1 ESP 5W-30",
          lang: "en",
        }),
        (body) => searchSynonymListSchema.parse(body),
      );
      const found = await search("mobil 1 esp 5w-30", { ...atlasCar(w), cityId: almaty });
      // Both exact by their own texts; the one in the chosen city first.
      expect(found.items.map((item) => [item.id, item.match])).toEqual([
        [w.mobilEsp, "exact"],
        [w.helixUltra, "exact"],
      ]);
      const noCity = await search("mobil 1 esp 5w-30", atlasCar(w));
      // No city: the cheaper first.
      expect(noCity.items.map((item) => item.id)).toEqual([w.helixUltra, w.mobilEsp]);
    });

    it("pages by the cursor without gaps or repeats; a broken cursor is 400", async () => {
      const w = await world();
      await padsOnOffer(w);
      const first = await search("колодки", { ...atlasCar(w), limit: "1" });
      expect(first.items).toHaveLength(1);
      expect(first.total).toBe(2);
      const second = await search("колодки", {
        ...atlasCar(w),
        limit: "1",
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([first.items[0]!.id, second.items[0]!.id].sort()).toEqual(
        [w.frontPads, w.trwPads].sort(),
      );
      expectError(
        await guest(searchPath("колодки", { cursor: "nonsense" })),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("takes a query of two characters, refuses one and an overlong one", async () => {
      const w = await world();
      await padsOnOffer(w);
      expectError(await guest(searchPath("к")), 400, "VALIDATION_ERROR");
      expectError(await guest(searchPath(" к ")), 400, "VALIDATION_ERROR");
      expectError(await guest(searchPath("к".repeat(200))), 400, "VALIDATION_ERROR");
      expect((await search("ко", atlasCar(w))).query).toBe("ко");
    });
  });

  // ------------------------------------------------------------- services

  describe("services", () => {
    it("asks for a city without one; in the city — at the price for the model; another city — none", async () => {
      const w = await world();
      const service = await company("Шины Юг", astana, { type: "services" });
      await ok(
        service.as("post", "/supplier/offers", {
          itemId: w.oilService,
          modelPrices: [{ modelId: w.coolray, price: 8_000 }],
        }),
        (body) => supplierOfferResponseSchema.parse(body),
        201,
      );
      expect(await search("замена масла", coolrayCar(w))).toMatchObject({
        items: [],
        total: 0,
        empty: "city_required",
        cityRequired: true,
      });
      const inAstana = await search("замена масла", { ...coolrayCar(w), cityId: astana });
      expect(inAstana.items[0]).toMatchObject({
        id: w.oilService,
        type: "service",
        offers: { minPrice: 8_000, inCity: true },
        category: { id: w.oilChange, kind: "services" },
      });
      expect(inAstana.cityRequired).toBe(false);
      expect(await search("замена масла", { ...coolrayCar(w), cityId: almaty })).toMatchObject({
        total: 0,
        empty: "no_items",
      });
      // A model without a price: none — because of the car.
      expect(await search("замена масла", { ...atlasCar(w), cityId: astana })).toMatchObject({
        total: 0,
        empty: "vehicle",
      });
    });
  });

  // ------------------------------------------------------- who sees what

  describe("who sees what", () => {
    it("never names the supplier: no name, id, district or address in any answer", async () => {
      const w = await world();
      const { shop, other } = await padsOnOffer(w);
      const user = await sessionToken(USER_PHONE, IOS);
      for (const found of [
        await search("колодки", atlasCar(w)),
        await search("колодки", atlasCar(w), user),
        await search("04465 0k090", atlasCar(w)),
      ]) {
        const text = JSON.stringify(found);
        for (const entry of [shop, other]) {
          for (const secret of [entry.supplierId, entry.name, entry.district, entry.address]) {
            expect(text).not.toContain(secret);
          }
        }
      }
    });

    it("caches as the catalog: a guest's answer for a minute, a session's for nobody", async () => {
      const w = await world();
      await padsOnOffer(w);
      const asGuest = await guest(searchPath("колодки", atlasCar(w)));
      expect(asGuest.headers["cache-control"]).toBe("public, max-age=60");
      expect(asGuest.headers.vary).toContain("Authorization");
      const user = await sessionToken(USER_PHONE, IOS);
      const asUser = await call(user, IOS, "get", searchPath("колодки", atlasCar(w)));
      expect(asUser.headers["cache-control"]).toBe("private, no-store");
      expect(catalogSearchResponseSchema.parse(asUser.body).viewer.signedIn).toBe(true);
    });

    it("holds a sent token to the session rules: a broken one 401, another context 403", async () => {
      const w = await world();
      const { shop } = await padsOnOffer(w);
      const path = searchPath("колодки");
      expectError(
        await http().get(path).set("X-Client", IOS).set("Authorization", "Bearer nonsense"),
        401,
        "AUTH_REQUIRED",
      );
      expectError(await shop.as("get", path), 403, "FORBIDDEN");
      expectError(await asAdmin("get", path), 403, "FORBIDDEN");
    });

    it("is limited as the catalog (per address of a guest)", async () => {
      const w = await world();
      await padsOnOffer(w);
      await settings.set({ catalog_read_per_ip: 2 });
      const ip = "203.0.113.7";
      const once = () => guest(searchPath("колодки", atlasCar(w))).set("X-Forwarded-For", ip);
      expect((await once()).status).toBe(200);
      expect((await once()).status).toBe(200);
      const limited = await once();
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details.limit).toBe("catalog_read_per_ip");
    });

    it("never writes the query to the output or the journal: a phone number is searched as text", async () => {
      const w = await world();
      await padsOnOffer(w);
      const before = (await db.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;
      const found = await search("+7 701 555 66 77", atlasCar(w));
      expect(found.total).toBe(0);
      await search("ivan.petrov@example.kz", atlasCar(w));
      expect(output.text()).not.toContain("555 66 77");
      expect(output.text()).not.toContain("7015556677");
      expect(output.text()).not.toContain("ivan.petrov");
      expect((await db.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(before);
    });
  });

  // ------------------------------------------------------------- synonyms

  describe("search synonyms of the administrator", () => {
    it("adds and removes synonyms of an item and a category, with the journal; one reading once", async () => {
      const w = await world();
      await padsOnOffer(w);
      const added = await ok(
        asAdmin("post", `/admin/catalog/items/${w.frontPads}/synonyms`, {
          term: "Колодочки Джили",
          lang: "ru",
        }),
        (body) => searchSynonymListSchema.parse(body),
      );
      expect(added.synonyms).toMatchObject([{ term: "Колодочки Джили", lang: "ru" }]);
      // The same reading: case, ё and signs ignored.
      const duplicate = await asAdmin("post", `/admin/catalog/items/${w.frontPads}/synonyms`, {
        term: "  колодочки-джили ",
      });
      expectError(duplicate, 409, "CATALOG_SYNONYM_EXISTS");
      expect(duplicate.body.details.existingSynonymId).toBe(added.synonyms[0]!.id);
      // Found by it — the item only, its own synonym.
      const found = await search("колодочки джили", atlasCar(w));
      expect(found.items.map((item) => [item.id, item.match])).toEqual([[w.frontPads, "exact"]]);

      const categoryList = await ok(
        asAdmin("get", `/admin/catalog/categories/${w.brakePads}/synonyms`),
        (body) => searchSynonymListSchema.parse(body),
      );
      expect(categoryList.synonyms.map((entry) => entry.term)).toContain("brake pads");
      const custom = await ok(
        asAdmin("post", `/admin/catalog/categories/${w.brakePads}/synonyms`, { term: "абырвалг" }),
        (body) => searchSynonymListSchema.parse(body),
      );
      expect((await search("абырвалг", atlasCar(w))).total).toBe(2);
      const removed = custom.synonyms.find((entry) => entry.term === "абырвалг")!;
      const left = await ok(asAdmin("delete", `/admin/catalog/synonyms/${removed.id}`), (body) =>
        searchSynonymListSchema.parse(body),
      );
      expect(left.synonyms.map((entry) => entry.term)).not.toContain("абырвалг");
      expect((await search("абырвалг", atlasCar(w))).total).toBe(0);
      expectError(
        await asAdmin("delete", `/admin/catalog/synonyms/${removed.id}`),
        404,
        "NOT_FOUND",
      );

      const journal = await ok(
        asAdmin("get", `/admin/audit-log?entityType=catalog_category&entityId=${w.brakePads}`),
        (body) => auditLogPageSchema.parse(body),
      );
      const actions = journal.entries.map((entry) => [entry.action, entry.actor.role]);
      expect(actions).toContainEqual(["catalog_synonym.added", "admin"]);
      expect(actions).toContainEqual(["catalog_synonym.removed", "admin"]);
      const itemJournal = await ok(
        asAdmin("get", `/admin/audit-log?entityType=catalog_item&entityId=${w.frontPads}`),
        (body) => auditLogPageSchema.parse(body),
      );
      expect(itemJournal.entries[0]).toMatchObject({
        action: "catalog_synonym.added",
        after: { term: "Колодочки Джили", lang: "ru" },
      });
    });

    it("refuses a synonym of one letter or of signs, a missing owner; only the administrator", async () => {
      const w = await world();
      const shop = await company("Автомаркет", almaty);
      const user = await sessionToken(USER_PHONE, IOS);
      const path = `/admin/catalog/items/${w.frontPads}/synonyms`;
      expectError(await asAdmin("post", path, { term: "к" }), 400, "VALIDATION_ERROR");
      expectError(await asAdmin("post", path, { term: "--" }), 400, "VALIDATION_ERROR");
      expectError(
        await asAdmin(
          "post",
          "/admin/catalog/items/00000000-0000-4000-8000-000000000000/synonyms",
          {
            term: "колодки",
          },
        ),
        404,
        "NOT_FOUND",
      );
      for (const [method, route] of [
        ["get", path],
        ["post", path],
        ["get", `/admin/catalog/categories/${w.brakePads}/synonyms`],
        ["post", `/admin/catalog/categories/${w.brakePads}/synonyms`],
        ["delete", "/admin/catalog/synonyms/00000000-0000-4000-8000-000000000000"],
      ] as const) {
        expectError(await shop.as(method, route, { term: "колодки" }), 403, "FORBIDDEN");
        expectError(await call(user, IOS, method, route, { term: "колодки" }), 403, "FORBIDDEN");
        expectError(
          await http()[method](route).set("X-Client", ADMIN_WEB).send({ term: "колодки" }),
          401,
          "AUTH_REQUIRED",
        );
      }
    });
  });

  // ------------------------------------- the readings in the other searches

  it("reads the wrong layout and the Kazakh letters in the administrator's and the supplier's searches too", async () => {
    const w = await world();
    const shop = await company("Автомаркет", almaty);
    const admin = await ok(
      asAdmin("get", "/admin/catalog/items?q=rjkjlrb"),
      (body) =>
        body as {
          items: { id: string }[];
        },
    );
    expect(admin.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([w.frontPads, w.trwPads, w.rearPads]),
    );
    const kazakh = await ok(
      asAdmin("get", `/admin/catalog/items?q=${encodeURIComponent("тежегиш")}`),
      (body) =>
        body as {
          items: { id: string }[];
        },
    );
    expect(kazakh.items.map((item) => item.id)).toContain(w.frontPads);
    const supplier = await ok(
      shop.as("get", "/supplier/catalog/items/search?q=rjkjlrb"),
      (body) =>
        body as {
          results: { item: { id: string } }[];
        },
    );
    expect(supplier.results.map((entry) => entry.item.id)).toEqual(
      expect.arrayContaining([w.frontPads, w.trwPads, w.rearPads]),
    );
  });
});
