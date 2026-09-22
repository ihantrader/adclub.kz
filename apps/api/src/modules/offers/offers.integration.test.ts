import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCatalogItemPageSchema,
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  offerExistsDetailsSchema,
  offerItemSearchResponseSchema,
  offerPageSchema,
  offerReceiptPreviewResponseSchema,
  offerReturnedResponseSchema,
  rateLimitedDetailsSchema,
  supplierMemberAddedResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
} from "@adclub/contracts";
import { kzBinCheckDigit, receiptDate } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { and, inArray } from "drizzle-orm";
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
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { offer, offerShowcase, OfferSnapshots, shownOffers } from ".";

/**
 * TASK-018 end to end on a real PostgreSQL and Redis: the search of an
 * item for an offer (only by a query, visible active goods, pages and the
 * limit of matches, «already yours», the limit per employee); offers —
 * creating with every check, one per item of a point (also under
 * concurrency), changes field by field with versions and the journal,
 * withdrawing and returning; «my offers» — tabs, filters, pages, the
 * showcase sign with its reasons; the showcase rule against pauses,
 * blocks, archived items and hidden categories (and its SQL twin); the
 * receipt date preview; the snapshot; the admin view; the access matrix.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const PADS = "04465-0K090";

type Method = "get" | "post" | "put" | "patch" | "delete";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const WEEK: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day <= 5 ? [{ from: "09:00", to: "18:00" }] : [],
}));

const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;

describe("offers of suppliers (PostgreSQL + Redis)", () => {
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
  let cityId: string;
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
    cityId = await ok(
      asAdmin("post", "/admin/cities", { code: "almaty", names: { ru: "Алматы" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
  }, 60_000);

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

  // ---------------------------------------------------------------- world

  interface Company {
    supplierId: string;
    memberId: string;
    bearer: string;
    as: (method: Method, path: string, body?: object) => Test;
  }

  /** A supplier with its point (with an address unless `address: null`), hours Mon–Fri 9–18, and a signed-in employee. */
  async function company(
    name = "Автомаркет",
    options: { address?: string | null; hours?: DayHours[] | null } = {},
  ): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId,
        type: "goods",
        ...(options.address === null ? {} : { address: options.address ?? "пр. Абая, 10" }),
        district: "Бостандыкский район",
        firstMember: { name: "Айгерим", phone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    const hours = options.hours === undefined ? WEEK : options.hours;
    if (hours) {
      await ok(
        asAdmin("put", `/admin/suppliers/${created.supplier.id}/schedule`, {
          expectedVersion: created.supplier.version,
          weeklyHours: hours,
          closedDates: [],
        }),
        (body) => body,
      );
    }
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: created.supplier.id,
      memberId: created.firstMember.memberId,
      bearer,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function colleague(of: Company): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const added = await ok(
      of.as("post", "/supplier/members", { name: "Марат", phone }),
      (body) => supplierMemberAddedResponseSchema.parse(body),
      201,
    );
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: of.supplierId,
      memberId: added.member.id,
      bearer,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function supplierVersion(supplierId: string): Promise<number> {
    return ok(asAdmin("get", `/admin/suppliers/${supplierId}`), (body) =>
      adminSupplierResponseSchema.parse(body),
    ).then((body) => body.supplier.version);
  }

  /** The admin view of an item found by its article or name. */
  async function itemBy(q: string) {
    const page = await ok(
      asAdmin("get", `/admin/catalog/items?q=${encodeURIComponent(q)}`),
      (body) => adminCatalogItemPageSchema.parse(body),
    );
    expect(page.items.length, q).toBeGreaterThan(0);
    return page.items[0]!;
  }

  const inStock = (itemId: string, extra: object = {}) => ({
    itemId,
    price: 12_500,
    availability: "in_stock",
    leadDays: 0,
    pickup: true,
    delivery: false,
    ...extra,
  });

  async function put(of: Company, itemId: string, extra: object = {}): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", inStock(itemId, extra)),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  async function journal(entityId: string) {
    const { rows } = await db.query<{
      action: string;
      actor_role: string;
      actor_member_id: string | null;
      before: unknown;
      after: unknown;
    }>(
      "SELECT action, actor_role, actor_member_id, before, after FROM audit_log WHERE entity_id = $1 ORDER BY created_at, id",
      [entityId],
    );
    return rows;
  }

  async function search(of: Company, q: string, extra = "") {
    return of.as("get", `/supplier/catalog/items/search?q=${encodeURIComponent(q)}${extra}`);
  }

  // ------------------------------------------------------------- search

  describe("the search of an item (S-OFF-02)", () => {
    it("finds the pads by an article in another spelling, not yet among the company's offers", async () => {
      const own = await company();
      const found = await ok(search(own, "04465 0k090"), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(found.results[0]).toMatchObject({
        item: { article: PADS, brand: { name: "Geely" }, type: "part" },
        offer: null,
      });
      expect(found.results[0]!.item.category.name.text).not.toBe("");
      // A part of the article, and a name in Russian.
      for (const q of ["0446-50k", "колодки"]) {
        const page = await ok(search(own, q), (body) => offerItemSearchResponseSchema.parse(body));
        expect(
          page.results.map((result) => result.item.article),
          q,
        ).toContain(PADS);
      }
      // The exact article comes first.
      const exact = await ok(search(own, "044650K090"), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(exact.results[0]!.item.article).toBe(PADS);
    });

    it("refuses an empty query, one letter and anything past the first 100 matches", async () => {
      const own = await company();
      for (const q of ["", "   ", "a", "0-4", "  a b "]) {
        expectError(await search(own, q), 400, "VALIDATION_ERROR");
      }
      expectError(await own.as("get", "/supplier/catalog/items/search"), 400, "VALIDATION_ERROR");
      expectError(await search(own, "колодки", "&limit=21"), 400, "VALIDATION_ERROR");
      expectError(await search(own, "колодки", "&offset=90&limit=20"), 400, "VALIDATION_ERROR");
      expectError(await search(own, "колодки", "&offset=100&limit=1"), 400, "VALIDATION_ERROR");
      await ok(search(own, "колодки", "&offset=80&limit=20"), (body) => body);
    });

    it("pages by offset and stops at the limit of matches", async () => {
      const own = await company();
      const first = await ok(search(own, "колодки", "&limit=2"), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(first.results).toHaveLength(2);
      expect(first.nextOffset).toBe(2);
      const second = await ok(search(own, "колодки", "&limit=2&offset=2"), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(second.results).toHaveLength(1);
      expect(second.nextOffset).toBeNull();
      expect(first.results.map((result) => result.item.id)).not.toContain(
        second.results[0]!.item.id,
      );
      const beyond = await ok(search(own, "колодки", "&limit=20&offset=80"), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(beyond).toMatchObject({ results: [], nextOffset: null });
    });

    it("shows only active goods of visible subcategories", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      // A service is never found.
      const services = await ok(
        asAdmin("get", "/admin/catalog/items?type=service"),
        (body) => adminCatalogItemPageSchema.parse(body).items,
      );
      const serviceName = services[0]!.names.ru!.text;
      const byService = await ok(search(own, serviceName), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(byService.results.map((result) => result.item.id)).not.toContain(services[0]!.id);
      // Archived — gone.
      await ok(
        asAdmin("post", `/admin/catalog/items/${pads.id}/status`, {
          expectedVersion: pads.version,
          status: "archived",
        }),
        (body) => body,
      );
      const archived = await ok(search(own, PADS), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(archived.results.map((result) => result.item.id)).not.toContain(pads.id);
      // A hidden subcategory hides its items.
      const oils = await itemBy("Shell Helix");
      const tree = await ok(
        asAdmin("get", "/admin/catalog/categories"),
        (body) =>
          body as {
            categories: {
              id: string;
              version: number;
              children: { id: string; version: number }[];
            }[];
          },
      );
      const subcategory = tree.categories
        .flatMap((node) => node.children)
        .find((child) => child.id === oils.categoryId)!;
      await ok(
        asAdmin("post", `/admin/catalog/categories/${subcategory.id}/status`, {
          expectedVersion: subcategory.version,
          status: "hidden",
        }),
        (body) => body,
      );
      const hidden = await ok(search(own, "Shell Helix"), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(hidden.results).toEqual([]);
    });

    it("marks items already among the company's offers, not another company's", async () => {
      const own = await company();
      const other = await company("Детали Юг");
      const pads = await itemBy(PADS);
      const offered = await put(own, pads.id);
      const mine = await ok(search(own, PADS), (body) => offerItemSearchResponseSchema.parse(body));
      expect(mine.results[0]!.offer).toEqual({ id: offered.id, status: "active" });
      const theirs = await ok(search(other, PADS), (body) =>
        offerItemSearchResponseSchema.parse(body),
      );
      expect(theirs.results[0]!.offer).toBeNull();
    });

    it("limits searches per employee (429 with Retry-After), each employee on their own", async () => {
      const own = await company();
      const second = await colleague(own);
      await settings.set({
        offer_item_search_per_member: 3,
        offer_item_search_per_member_window_seconds: 60,
      });
      for (let index = 0; index < 3; index++) {
        await ok(search(own, "колодки"), (body) => body);
      }
      const refused = await search(own, "колодки");
      expectError(refused, 429, "RATE_LIMITED");
      expect(rateLimitedDetailsSchema.parse(refused.body.details).limit).toBe(
        "offer_item_search_per_member",
      );
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      await ok(search(second, "колодки"), (body) => body);
    });
  });

  // ------------------------------------------------------------- offers

  describe("an offer (S-OFF-03)", () => {
    it("is put on an item with a receipt date, visible, journaled with the employee", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id, { warrantyMonths: 6, supplierSku: "GL-0446" });
      expect(created).toMatchObject({
        supplierId: own.supplierId,
        item: { id: pads.id, article: PADS },
        price: 12_500,
        currency: "KZT",
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: false,
        warrantyMonths: 6,
        warrantyText: null,
        supplierSku: "GL-0446",
        status: "active",
        showcase: { visible: true, reasons: [] },
        version: 1,
      });
      expect(created.receipt.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(created.receipt.unavailable).toBeNull();
      const entries = await journal(created.id);
      expect(entries).toEqual([
        expect.objectContaining({
          action: "offer.created",
          actor_role: "supplier",
          actor_member_id: own.memberId,
        }),
      ]);
    });

    it("is one per item of a point: the second is refused with a link to the first", async () => {
      const own = await company();
      const second = await colleague(own);
      const pads = await itemBy(PADS);
      const first = await put(own, pads.id);
      const again = await second.as(
        "post",
        "/supplier/offers",
        inStock(pads.id, { price: 11_000 }),
      );
      expectError(again, 409, "OFFER_EXISTS");
      expect(offerExistsDetailsSchema.parse(again.body.details)).toEqual({
        existingOfferId: first.id,
        status: "active",
      });
      // Another company puts its own.
      const other = await company("Детали Юг");
      await put(other, pads.id);
    });

    it("is one per item under concurrency: one of two simultaneous creations wins", async () => {
      const own = await company();
      const second = await colleague(own);
      const items = await ok(asAdmin("get", "/admin/catalog/items?type=generic"), (body) =>
        adminCatalogItemPageSchema.parse(body).items.filter((item) => item.status === "active"),
      );
      for (const item of items.slice(0, 3)) {
        const [a, b] = await Promise.all([
          own.as("post", "/supplier/offers", inStock(item.id)),
          second.as("post", "/supplier/offers", inStock(item.id, { price: 9_000 })),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body.code).toBe("OFFER_EXISTS");
        const { rows } = await db.query("SELECT id FROM offer WHERE item_id = $1", [item.id]);
        expect(rows).toHaveLength(1);
        expect(loser.body.details.existingOfferId).toBe(rows[0].id);
      }
    });

    it("checks its fields", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const refusals: [object, string][] = [
        [{ availability: "on_order", leadDays: 0 }, "leadDays"],
        [{ pickup: false, delivery: false }, "pickup"],
        [{ warrantyMonths: 12, warrantyText: "1 год" }, "warrantyText"],
        [{ price: 0 }, "price"],
        [{ price: 12.5 }, "price"],
        [{ leadDays: -1 }, "leadDays"],
        [{ warrantyMonths: 121 }, "warrantyMonths"],
      ];
      for (const [change, path] of refusals) {
        const response = await own.as("post", "/supplier/offers", inStock(pads.id, change));
        expectError(response, 400, "VALIDATION_ERROR");
        expect(JSON.stringify(response.body.details), JSON.stringify(change)).toContain(path);
      }
      // The working bounds are settings.
      await settings.set({ offer_price_max_kzt: 10_000, offer_lead_days_max: 5 });
      const expensive = await own.as("post", "/supplier/offers", inStock(pads.id));
      expectError(expensive, 400, "VALIDATION_ERROR");
      expect(JSON.stringify(expensive.body.details)).toContain("price");
      const slow = await own.as(
        "post",
        "/supplier/offers",
        inStock(pads.id, { price: 9_000, availability: "on_order", leadDays: 6 }),
      );
      expectError(slow, 400, "VALIDATION_ERROR");
      expect(JSON.stringify(slow.body.details)).toContain("leadDays");
      expect(await db.query("SELECT 1 FROM offer")).toMatchObject({ rowCount: 0 });
    });

    it("takes pickup only with the point's address; delivery alone works without it", async () => {
      const own = await company("Без адреса", { address: null });
      const pads = await itemBy(PADS);
      expectError(
        await own.as("post", "/supplier/offers", inStock(pads.id)),
        409,
        "OFFER_PICKUP_NEEDS_ADDRESS",
      );
      const delivered = await put(own, pads.id, {
        pickup: false,
        delivery: true,
        availability: "on_order",
        leadDays: 3,
      });
      expectError(
        await own.as("patch", `/supplier/offers/${delivered.id}`, {
          expectedVersion: 1,
          pickup: true,
        }),
        409,
        "OFFER_PICKUP_NEEDS_ADDRESS",
      );
    });

    it("is put only on an active part or product of a visible subcategory", async () => {
      const own = await company();
      const services = await ok(
        asAdmin("get", "/admin/catalog/items?type=service"),
        (body) => adminCatalogItemPageSchema.parse(body).items,
      );
      expectError(
        await own.as("post", "/supplier/offers", inStock(services[0]!.id)),
        409,
        "OFFER_NOT_APPLICABLE",
      );
      expectError(
        await own.as("post", "/supplier/offers", inStock("00000000-0000-4000-8000-000000000000")),
        404,
        "NOT_FOUND",
      );
      const pads = await itemBy(PADS);
      await ok(
        asAdmin("post", `/admin/catalog/items/${pads.id}/status`, {
          expectedVersion: pads.version,
          status: "archived",
        }),
        (body) => body,
      );
      expectError(await own.as("post", "/supplier/offers", inStock(pads.id)), 404, "NOT_FOUND");
    });
  });

  // ------------------------------------------------------------- changes

  describe("changes from the list (S-OFF-01)", () => {
    it("change a field with the version, journaled with the employee; a stale version is refused", async () => {
      const own = await company();
      const second = await colleague(own);
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const changed = await ok(
        second.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 13_000 }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
      );
      expect(changed).toMatchObject({ price: 13_000, version: 2 });
      const entries = await journal(created.id);
      expect(entries.at(-1)).toMatchObject({
        action: "offer.changed",
        actor_role: "supplier",
        actor_member_id: second.memberId,
        before: { price: 12_500 },
        after: { price: 13_000, version: 2 },
      });
      const stale = await own.as("patch", `/supplier/offers/${created.id}`, {
        expectedVersion: 1,
        price: 14_000,
      });
      expectError(stale, 409, "OFFER_VERSION_CONFLICT");
      expect(stale.body.details).toEqual({ currentVersion: 2 });
    });

    it("of two simultaneous price changes with the same version, one wins", async () => {
      const own = await company();
      const second = await colleague(own);
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const [a, b] = await Promise.all([
        own.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 13_000 }),
        second.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 14_000 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const { rows } = await db.query<{ version: number; price: number }>(
        "SELECT version, price FROM offer WHERE id = $1",
        [created.id],
      );
      expect(rows[0]!.version).toBe(2);
      expect([13_000, 14_000]).toContain(rows[0]!.price);
    });

    it("keep the rules for the offer as it becomes; saving the same changes nothing", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const onOrder = await own.as("patch", `/supplier/offers/${created.id}`, {
        expectedVersion: 1,
        availability: "on_order",
      });
      expectError(onOrder, 400, "VALIDATION_ERROR");
      expect(JSON.stringify(onOrder.body.details)).toContain("availability");
      const both = await ok(
        own.as("patch", `/supplier/offers/${created.id}`, {
          expectedVersion: 1,
          availability: "on_order",
          leadDays: 3,
          delivery: true,
          warrantyText: "12 месяцев",
          supplierName: "Колодки перед.",
        }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
      );
      expect(both).toMatchObject({
        availability: "on_order",
        leadDays: 3,
        delivery: true,
        warrantyText: "12 месяцев",
        supplierName: "Колодки перед.",
        version: 2,
      });
      const same = await ok(
        own.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 2, leadDays: 3 }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
      );
      expect(same.version).toBe(2);
      expect((await journal(created.id)).map((entry) => entry.action)).toEqual([
        "offer.created",
        "offer.changed",
      ]);
      for (const field of ["itemId", "status", "supplierId"]) {
        const response = await own.as("patch", `/supplier/offers/${created.id}`, {
          expectedVersion: 2,
          [field]: field === "status" ? "withdrawn" : pads.id,
        });
        expectError(response, 400, "VALIDATION_ERROR");
        expect(JSON.stringify(response.body.details)).toContain(field);
      }
    });

    it("withdraw and return: the tab changes, nothing is deleted, the return asks to check the price", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const withdrawn = await ok(
        own.as("post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 1 }),
        (body) => supplierOfferResponseSchema.parse(body).offer,
      );
      expect(withdrawn).toMatchObject({
        status: "withdrawn",
        withdrawnReason: "manual",
        showcase: { visible: false, reasons: ["offer_withdrawn"] },
        version: 2,
      });
      const onSale = await ok(own.as("get", "/supplier/offers"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(onSale.offers).toEqual([]);
      expect(onSale.counts).toEqual({ onSale: 0, withdrawn: 1 });
      const tab = await ok(own.as("get", "/supplier/offers?tab=withdrawn"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(tab.offers.map((entry) => entry.id)).toEqual([created.id]);
      expectError(
        await own.as("post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 2 }),
        409,
        "OFFER_STATE",
      );
      // Putting a new offer on the item points at the withdrawn one.
      const again = await own.as("post", "/supplier/offers", inStock(pads.id));
      expectError(again, 409, "OFFER_EXISTS");
      expect(again.body.details).toEqual({ existingOfferId: created.id, status: "withdrawn" });
      const returned = await ok(
        own.as("post", `/supplier/offers/${created.id}/return`, { expectedVersion: 2 }),
        (body) => offerReturnedResponseSchema.parse(body),
      );
      expect(returned).toMatchObject({
        checkPrice: true,
        offer: { status: "active", withdrawnAt: null, withdrawnReason: null, version: 3 },
      });
      expectError(
        await own.as("post", `/supplier/offers/${created.id}/return`, { expectedVersion: 3 }),
        409,
        "OFFER_STATE",
      );
      expect((await journal(created.id)).map((entry) => entry.action)).toEqual([
        "offer.created",
        "offer.withdrawn",
        "offer.returned",
      ]);
    });

    it("an offer on an item archived later stays with the supplier, hidden, and can't return to sale", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      await ok(
        own.as("post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 1 }),
        (body) => body,
      );
      await ok(
        asAdmin("post", `/admin/catalog/items/${pads.id}/status`, {
          expectedVersion: pads.version,
          status: "archived",
        }),
        (body) => body,
      );
      const kept = await ok(
        own.as("get", `/supplier/offers/${created.id}`),
        (body) => supplierOfferResponseSchema.parse(body).offer,
      );
      expect(kept.item.status).toBe("archived");
      expect(kept.showcase.reasons).toEqual(["offer_withdrawn", "item_unavailable"]);
      expectError(
        await own.as("post", `/supplier/offers/${created.id}/return`, { expectedVersion: 2 }),
        409,
        "OFFER_ITEM_UNAVAILABLE",
      );
      // Its price can still be changed.
      await ok(
        own.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 2, price: 1_000 }),
        (body) => body,
      );
    });

    it("another company's offer is as missing as one that doesn't exist", async () => {
      const own = await company();
      const other = await company("Детали Юг");
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const attempts = [
        other.as("get", `/supplier/offers/${created.id}`),
        other.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 1 }),
        other.as("post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 1 }),
        other.as("post", `/supplier/offers/${created.id}/return`, { expectedVersion: 1 }),
      ];
      for (const response of await Promise.all(attempts)) {
        expectError(response, 404, "NOT_FOUND");
      }
      const { rows } = await db.query("SELECT price, version, status FROM offer WHERE id = $1", [
        created.id,
      ]);
      expect(rows[0]).toEqual({ price: 12_500, version: 1, status: "active" });
      const theirs = await ok(other.as("get", "/supplier/offers"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(theirs.total).toBe(0);
    });
  });

  // ------------------------------------------------------------- my offers

  describe("my offers", () => {
    it("filter by availability, the query (article, name, own article) and photo; page by cursor", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const rear = await itemBy("4050068800");
      const oil = await itemBy("Shell Helix");
      await put(own, pads.id, { supplierSku: "MY-777" });
      await put(own, rear.id, { availability: "on_order", leadDays: 2 });
      await put(own, oil.id);
      const all = await ok(own.as("get", "/supplier/offers"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(all.total).toBe(3);
      expect(all.offers[0]!.item.id).toBe(oil.id); // newest first
      const onOrder = await ok(own.as("get", "/supplier/offers?availability=on_order"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(onOrder.offers.map((entry) => entry.item.id)).toEqual([rear.id]);
      for (const [q, id] of [
        ["0446 50k", pads.id],
        ["helix", oil.id],
        ["my-777", pads.id],
      ] as const) {
        const found = await ok(
          own.as("get", `/supplier/offers?q=${encodeURIComponent(q)}`),
          (body) => offerPageSchema.parse(body),
        );
        expect(
          found.offers.map((entry) => entry.item.id),
          q,
        ).toEqual([id]);
      }
      // A photo of the pads (a link to its source, as `photo_display_mode = link` shows it).
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO item_photo (item_id, source_type, source_url, status, content_type, byte_size, width, height, checksum, reviewed_at)
         VALUES ($1, 'manufacturer', 'https://example.com/pads.jpg', 'approved', 'image/jpeg', 1, 1, 1, repeat('a', 64), now()) RETURNING id`,
        [pads.id],
      );
      await db.query("UPDATE catalog_item SET primary_photo_id = $1 WHERE id = $2", [
        rows[0]!.id,
        pads.id,
      ]);
      const withoutPhoto = await ok(own.as("get", "/supplier/offers?withoutPhoto=true"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(withoutPhoto.offers.map((entry) => entry.item.id).sort()).toEqual(
        [rear.id, oil.id].sort(),
      );
      const withPhoto = await ok(own.as("get", "/supplier/offers?withoutPhoto=false"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(withPhoto.offers.map((entry) => entry.item.id)).toEqual([pads.id]);
      expect(withPhoto.offers[0]!.item.photo?.thumbUrl).toBe("https://example.com/pads.jpg");
      // Pages without repeats or gaps.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : "";
        const page = await ok(own.as("get", `/supplier/offers?limit=2${query}`), (body) =>
          offerPageSchema.parse(body),
        );
        seen.push(...page.offers.map((entry) => entry.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(3);
      expectError(await own.as("get", "/supplier/offers?cursor=abc"), 400, "VALIDATION_ERROR");
    });

    it("names in the language of the request", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      await put(own, pads.id);
      const kk = await ok(own.as("get", "/supplier/offers").set("Accept-Language", "kk"), (body) =>
        offerPageSchema.parse(body),
      );
      expect(kk.language).toBe("kk");
      expect(kk.offers[0]!.item.name.text).not.toBe("");
    });
  });

  // ------------------------------------------------------------- showcase

  describe("the showcase", () => {
    async function showcaseOf(of: Company, offerId: string) {
      return ok(
        of.as("get", `/supplier/offers/${offerId}`),
        (body) => supplierOfferResponseSchema.parse(body).offer,
      ).then((entry) => entry.showcase);
    }

    it("a pause and a block hide the offers without changing them; lifting shows them again", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const before = await db.query("SELECT status, version, updated_at FROM offer WHERE id = $1", [
        created.id,
      ]);
      await ok(
        asAdmin("post", `/admin/suppliers/${own.supplierId}/pause`, {
          expectedVersion: await supplierVersion(own.supplierId),
          paused: true,
          reason: "admin",
          note: "Проверка документов",
        }),
        (body) => body,
      );
      expect(await showcaseOf(own, created.id)).toEqual({
        visible: false,
        reasons: ["supplier_paused"],
      });
      await ok(
        asAdmin("post", `/admin/suppliers/${own.supplierId}/block`, {
          expectedVersion: await supplierVersion(own.supplierId),
          blocked: true,
          reason: "Жалобы",
        }),
        (body) => body,
      );
      expect(await showcaseOf(own, created.id)).toEqual({
        visible: false,
        reasons: ["supplier_blocked", "supplier_paused"],
      });
      const during = await db.query("SELECT status, version, updated_at FROM offer WHERE id = $1", [
        created.id,
      ]);
      expect(during.rows).toEqual(before.rows);
      // A paused and blocked supplier still keeps its offers.
      await ok(
        own.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 12_000 }),
        (body) => body,
      );
      await ok(
        asAdmin("post", `/admin/suppliers/${own.supplierId}/block`, {
          expectedVersion: await supplierVersion(own.supplierId),
          blocked: false,
          reason: "Разобрались",
        }),
        (body) => body,
      );
      await ok(
        asAdmin("post", `/admin/suppliers/${own.supplierId}/pause`, {
          expectedVersion: await supplierVersion(own.supplierId),
          paused: false,
          note: "Документы в порядке",
        }),
        (body) => body,
      );
      expect(await showcaseOf(own, created.id)).toEqual({ visible: true, reasons: [] });
    });

    it("an archived item and a hidden category hide the offer", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const oil = await itemBy("Shell Helix");
      const padsOffer = await put(own, pads.id);
      const oilOffer = await put(own, oil.id);
      await ok(
        asAdmin("post", `/admin/catalog/items/${pads.id}/status`, {
          expectedVersion: pads.version,
          status: "archived",
        }),
        (body) => body,
      );
      const tree = await ok(
        asAdmin("get", "/admin/catalog/categories"),
        (body) =>
          body as { categories: { id: string; version: number; children: { id: string }[] }[] },
      );
      const node = tree.categories.find((entry) =>
        entry.children.some((child) => child.id === oil.categoryId),
      )!;
      await ok(
        asAdmin("post", `/admin/catalog/categories/${node.id}/status`, {
          expectedVersion: node.version,
          status: "hidden",
        }),
        (body) => body,
      );
      expect(await showcaseOf(own, padsOffer.id)).toEqual({
        visible: false,
        reasons: ["item_unavailable"],
      });
      expect(await showcaseOf(own, oilOffer.id)).toEqual({
        visible: false,
        reasons: ["category_hidden"],
      });
    });

    it("the SQL condition agrees with the rule on every offer", async () => {
      const own = await company();
      const paused = await company("На паузе");
      const items = await ok(asAdmin("get", "/admin/catalog/items?type=generic"), (body) =>
        adminCatalogItemPageSchema.parse(body).items.filter((item) => item.status === "active"),
      );
      const pads = await itemBy(PADS);
      // D-060 (TASK-020): a point without hours, and one whose hours give no working day.
      const noHours = await company("Без часов", { hours: null });
      const closed = await company("Закрыто", {
        hours: WEEK.map((day) => ({ day: day.day, intervals: [] })),
      });
      const offers = [
        await put(own, pads.id),
        await put(own, items[0]!.id),
        await put(own, items[1]!.id),
        await put(paused, pads.id),
        await put(noHours, pads.id),
        await put(closed, pads.id),
      ];
      await ok(
        own.as("post", `/supplier/offers/${offers[1]!.id}/withdraw`, { expectedVersion: 1 }),
        (body) => body,
      );
      await ok(
        asAdmin("post", `/admin/suppliers/${paused.supplierId}/pause`, {
          expectedVersion: await supplierVersion(paused.supplierId),
          paused: true,
          reason: "billing",
          note: "Не оплачено",
        }),
        (body) => body,
      );
      await ok(
        asAdmin("post", `/admin/catalog/items/${items[1]!.id}/status`, {
          expectedVersion: items[1]!.version,
          status: "archived",
        }),
        (body) => body,
      );
      const database = app.get(DatabaseService).db;
      const ids = offers.map((entry) => entry.id);
      const rule = await offerShowcase(database, ids);
      const shown = await database
        .select({ id: offer.id })
        .from(offer)
        .where(and(inArray(offer.id, ids), shownOffers()));
      expect(shown.map((row) => row.id).sort()).toEqual(
        ids.filter((id) => rule.get(id)!.visible).sort(),
      );
      expect(shown.map((row) => row.id)).toEqual([offers[0]!.id]);
      expect(rule.get(offers[4]!.id)).toEqual({ visible: false, reasons: ["hours_not_set"] });
      expect(rule.get(offers[5]!.id)).toEqual({ visible: false, reasons: ["no_working_day"] });
    });
  });

  // ------------------------------------------------------------- receipt date

  describe("the receipt date", () => {
    it("the preview follows the point's schedule; no date without hours", async () => {
      const own = await company();
      const now = new Date();
      const preview = await ok(
        own.as("get", "/supplier/offer-receipt-preview?leadDays=2"),
        (body) => offerReceiptPreviewResponseSchema.parse(body),
      );
      const expected = receiptDate(new Date(preview.receipt.confirmedAt), 2, {
        timeZone: "Asia/Almaty",
        weeklyHours: WEEK,
        closedDates: [],
      });
      expect(expected.ok).toBe(true);
      expect(preview.receipt).toMatchObject({
        timeZone: "Asia/Almaty",
        leadDays: 2,
        date: expected.ok ? expected.date : null,
        unavailable: null,
      });
      expect(
        Math.abs(new Date(preview.receipt.confirmedAt).getTime() - now.getTime()),
      ).toBeLessThan(60_000);
      // A closed date moves it on.
      const version = await supplierVersion(own.supplierId);
      await ok(
        asAdmin("put", `/admin/suppliers/${own.supplierId}/schedule`, {
          expectedVersion: version,
          weeklyHours: WEEK,
          closedDates: [{ date: expected.ok ? expected.date : "", note: "Праздник" }],
        }),
        (body) => body,
      );
      const moved = await ok(own.as("get", "/supplier/offer-receipt-preview?leadDays=2"), (body) =>
        offerReceiptPreviewResponseSchema.parse(body),
      );
      expect(moved.receipt.date! > preview.receipt.date!).toBe(true);
      expectError(
        await own.as("get", "/supplier/offer-receipt-preview?leadDays=366"),
        400,
        "VALIDATION_ERROR",
      );
      await settings.set({ offer_lead_days_max: 5 });
      expectError(
        await own.as("get", "/supplier/offer-receipt-preview?leadDays=6"),
        400,
        "VALIDATION_ERROR",
      );
      const noHours = await company("Без часов", { hours: null });
      const none = await ok(
        noHours.as("get", "/supplier/offer-receipt-preview?leadDays=0"),
        (body) => offerReceiptPreviewResponseSchema.parse(body),
      );
      expect(none.receipt).toMatchObject({ date: null, unavailable: "hours_not_set" });
    });
  });

  // ------------------------------------------------------------- snapshot

  describe("the snapshot", () => {
    it("doesn't change after the offer is changed and withdrawn", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id, { warrantyMonths: 6 });
      const snapshots = app.get(OfferSnapshots);
      const database = app.get(DatabaseService).db;
      const takenAt = new Date();
      const snapshot = await database.transaction((tx) => snapshots.take(tx, created.id, takenAt));
      const copy = structuredClone(snapshot);
      expect(snapshot).toMatchObject({
        offerId: created.id,
        offerVersion: 1,
        takenAt: takenAt.toISOString(),
        supplier: { id: own.supplierId, name: "Автомаркет" },
        location: { cityName: "Алматы", address: "пр. Абая, 10", timeZone: "Asia/Almaty" },
        item: { id: pads.id, article: PADS, brand: "Geely" },
        price: 12_500,
        currency: "KZT",
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: false,
        warrantyMonths: 6,
      });
      expect(snapshot.item.names.ru).toBeTruthy();
      await ok(
        own.as("patch", `/supplier/offers/${created.id}`, {
          expectedVersion: 1,
          price: 15_000,
          delivery: true,
        }),
        (body) => body,
      );
      await ok(
        own.as("post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 2 }),
        (body) => body,
      );
      expect(snapshot).toEqual(copy);
      const later = await database.transaction((tx) => snapshots.take(tx, created.id, new Date()));
      expect(later).toMatchObject({ offerVersion: 3, price: 15_000, delivery: true });
    });

    it("a change of the offer waits for the order's transaction holding the snapshot", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const database = app.get(DatabaseService).db;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let taken!: () => void;
      const takenSignal = new Promise<void>((resolve) => (taken = resolve));
      const order = database.transaction(async (tx) => {
        const snapshot = await app.get(OfferSnapshots).take(tx, created.id, new Date());
        taken();
        await held;
        return snapshot;
      });
      await takenSignal;
      let changedAt = 0;
      const change = own
        .as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 20_000 })
        .then((response) => {
          changedAt = Date.now();
          return response;
        });
      await sleep(300);
      const releasedAt = Date.now();
      release();
      const [snapshot, response] = await Promise.all([order, change]);
      expect(response.status).toBe(200);
      expect(changedAt).toBeGreaterThanOrEqual(releasedAt);
      expect(snapshot.price).toBe(12_500);
    });
  });

  // ------------------------------------------------------------- admin and access

  describe("the administrator and access", () => {
    it("the administrator sees a supplier's offers read only, with the showcase sign", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      await ok(
        own.as("post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 1 }),
        (body) => body,
      );
      const page = await ok(
        asAdmin("get", `/admin/suppliers/${own.supplierId}/offers?tab=withdrawn`),
        (body) => offerPageSchema.parse(body),
      );
      expect(page.offers.map((entry) => entry.id)).toEqual([created.id]);
      expect(page.offers[0]!.showcase.reasons).toEqual(["offer_withdrawn"]);
      expectError(
        await asAdmin("get", "/admin/suppliers/00000000-0000-4000-8000-000000000000/offers"),
        404,
        "NOT_FOUND",
      );
      // The admin session has no cabinet routes: nothing to change an offer with.
      for (const response of await Promise.all([
        asAdmin("patch", `/supplier/offers/${created.id}`, { expectedVersion: 2, price: 1 }),
        asAdmin("post", `/supplier/offers/${created.id}/return`, { expectedVersion: 2 }),
        asAdmin("post", "/supplier/offers", inStock(pads.id)),
        asAdmin("get", "/supplier/offers"),
      ])) {
        expectError(response, 403, "FORBIDDEN");
      }
    });

    it("cabinet routes take only a cabinet session; admin routes only an admin one", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      const mobile = await sessionToken(USER_PHONE, IOS);
      const cabinetRoutes: [Method, string, object?][] = [
        ["get", "/supplier/catalog/items/search?q=колодки"],
        ["get", "/supplier/offers"],
        ["post", "/supplier/offers", inStock(pads.id)],
        ["get", "/supplier/offer-receipt-preview?leadDays=1"],
        ["get", `/supplier/offers/${created.id}`],
        ["patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 1 }],
        ["post", `/supplier/offers/${created.id}/withdraw`, { expectedVersion: 1 }],
        ["post", `/supplier/offers/${created.id}/return`, { expectedVersion: 1 }],
      ];
      for (const [method, path, body] of cabinetRoutes) {
        expectError(await call(mobile, IOS, method, path, body), 403, "FORBIDDEN");
        const anonymous = http()[method](path).set("X-Client", SUPPLIER_WEB);
        expectError(await (body ? anonymous.send(body) : anonymous), 401, "AUTH_REQUIRED");
      }
      for (const bearer of [mobile, own.bearer]) {
        const client = bearer === mobile ? IOS : SUPPLIER_WEB;
        expectError(
          await call(bearer, client, "get", `/admin/suppliers/${own.supplierId}/offers`),
          403,
          "FORBIDDEN",
        );
      }
      const { rows } = await db.query("SELECT price, version FROM offer WHERE id = $1", [
        created.id,
      ]);
      expect(rows[0]).toEqual({ price: 12_500, version: 1 });
    });

    it("the journal and the log hold no phone numbers", async () => {
      const own = await company();
      const pads = await itemBy(PADS);
      const created = await put(own, pads.id);
      await ok(
        own.as("patch", `/supplier/offers/${created.id}`, { expectedVersion: 1, price: 13_000 }),
        (body) => body,
      );
      const { rows } = await db.query<{ text: string }>(
        "SELECT coalesce(before::text, '') || coalesce(after::text, '') AS text FROM audit_log WHERE entity_type = 'offer'",
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.text).join("")).not.toMatch(/\+7\d{10}/);
    });
  });
});
