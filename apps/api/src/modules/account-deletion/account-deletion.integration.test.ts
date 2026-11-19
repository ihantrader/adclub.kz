import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountDeletionPreviewSchema,
  accountProfileSchema,
  adminCityResponseSchema,
  adminOrderResponseSchema,
  adminSupplierResponseSchema,
  adminUserDataExportLinkSchema,
  adminUserPageSchema,
  adminUserResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderResponseSchema,
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
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import {
  DeletedAccountErasure,
  LoginCodeChannels,
  OperatorService,
  type TestLoginCodeChannels,
} from "../identity";
import { DevVehicleSeed } from "../vehicles";

/**
 * TASK-072 (D-036, D-077) on a real PostgreSQL and Redis: deleting the
 * account by the member — the active orders cancelled as the user's own
 * cancellation (W-04 to the supplier), every session ended, the garage
 * with its VINs gone, the reviews and orders left impersonal for the
 * supplier, the public page and the administrator, the journal without
 * the name and the e-mail, the number free for a new account; the last
 * employee and the administrator refused; consents with versions and the
 * gate of orders; the export of a user's data by a one-time link.
 */

const ADMIN_PHONE = "+77010000361";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VIN = "LB37624S8PX123456";
const USER_NAME = "Әлия Удаляемова";
const USER_EMAIL = "aliya.deleted@example.kz";

type Method = "get" | "post" | "put" | "patch" | "delete";

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) return `${prefix}${digit}`;
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

describe("deleting the account, consents, the export of data (PostgreSQL + Redis)", () => {
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
      SUPPLIER_WEB_ORIGINS: "http://localhost:5175",
    });
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 } }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
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
    });
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
    almaty = await ok(
      asAdmin("post", "/admin/cities", { code: "almaty", names: { ru: "Алматы", kk: "Алматы" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    padsId = await idOf(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      ["geely", normalizeArticle(PADS)],
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

  async function signIn(phone: string, client: string, registered = true): Promise<Response> {
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
    if (client === IOS && registered) {
      await completeTestRegistration((path) => http().post(path), client, response, USER_NAME);
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
    for (const code of body.backupCodes) rememberCode(code, code.replace("-", ""));
    return body.session.accessToken;
  }

  async function sessionToken(phone: string, client: string, registered = true): Promise<string> {
    const response = await signIn(phone, client, registered);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function call(bearer: string, client: string, method: Method, path: string, body?: object) {
    const test = http()
      [method](path)
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
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

  type As = (method: Method, path: string, body?: object) => Test;

  interface Company {
    supplierId: string;
    name: string;
    phone: string;
    bearer: string;
    as: As;
  }

  async function company(name: string, firstMemberPhone?: string): Promise<Company> {
    const phone = firstMemberPhone ?? `+7705${String(++phoneCounter).padStart(7, "0")}`;
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
      phone,
      bearer,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function offer(of: Company, onOrder = false): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price: 6_500,
        availability: onOrder ? "on_order" : "in_stock",
        leadDays: onOrder ? 3 : 0,
        pickup: true,
        delivery: false,
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

  async function customer(phone?: string): Promise<Customer> {
    const number = phone ?? `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(number);
    const bearer = await sessionToken(number, IOS);
    await ok(
      asAdmin("post", "/admin/club-access/grants", {
        phone: number,
        validUntil: new Date(Date.now() + 30 * DAY).toISOString(),
        reason: "Тест",
      }),
      (body) => body,
      201,
    );
    return {
      phone: number,
      bearer,
      accountId: await idOf("SELECT id FROM account WHERE phone = $1", [number]),
      as: (method, path, body) => call(bearer, IOS, method, path, body),
    };
  }

  async function place(who: Customer, of: SupplierOffer): Promise<UserOrder> {
    return ok(
      who.as("post", "/orders", {
        offerId: of.id,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: of.price,
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

  async function giveOut(shop: Company, who: Customer, orderId: string): Promise<void> {
    await ok(shop.as("post", `/supplier/orders/${orderId}/accept`, { expectedVersion: 1 }), (b) =>
      supplierOrderResponseSchema.parse(b),
    );
    const order = await ok(who.as("get", `/orders/${orderId}`), (b) =>
      userOrderResponseSchema.parse(b),
    );
    const code = order.order.confirmation!.code;
    rememberCode(code);
    const closed = await shop.as("post", "/supplier/orders/close", { code });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }

  async function geelyLevels() {
    const make = await idOf(
      "SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely' AND is_name",
      [],
    );
    const model = await idOf("SELECT id FROM vehicle_model WHERE make_id = $1 LIMIT 1", [make]);
    return {
      make: { id: make, label: "Geely" },
      model: { id: model, label: "Atlas" },
      year: 2023,
      generation: null,
      body: null,
      engine: null,
      transmission: null,
      drive: null,
    };
  }

  async function profileOf(who: Customer) {
    return ok(who.as("get", "/account/profile"), (body) => accountProfileSchema.parse(body));
  }

  // ------------------------------------------------------------------ deletion

  it("deletes the account: orders cancelled, sessions ended, garage gone, the rest impersonal", async () => {
    const shop = await company("Автомаркет");
    const inStock = await offer(shop);
    const user = await customer();
    // A second session of the app and a device on push.
    const second = await sessionToken(user.phone, IOS);
    await ok(
      user.as("put", "/notifications/device-token", {
        platform: "android",
        token: `fcm-${randomUUID()}-device`,
      }),
      (body) => body,
    );
    await ok(user.as("patch", "/account/profile", { email: USER_EMAIL }), (b) => b);
    await ok(
      user.as("post", "/garage/cars", { levels: await geelyLevels(), color: null, vin: VIN }),
      (body) => body,
      201,
    );

    // A finished order with a review and a complaint.
    const done = await place(user, inStock);
    await giveOut(shop, user, done.id);
    await ok(
      user.as("post", "/reviews", { orderId: done.id, score: 4, idempotencyKey: randomUUID() }),
      (body) => body,
      201,
    );
    await ok(
      user.as("post", "/complaints", {
        orderId: done.id,
        reason: "other",
        text: "Долго искали товар",
        idempotencyKey: randomUUID(),
      }),
      (body) => body,
      201,
    );

    // Two active orders: one new, one under order with another term proposed.
    const open = await place(user, inStock);
    const shop2 = await company("Под заказ");
    const onOrder = await offer(shop2, true);
    const waiting = await place(user, onOrder);
    await ok(
      shop2.as("post", `/supplier/orders/${waiting.id}/propose-term`, {
        expectedVersion: 1,
        leadDays: 5,
      }),
      (body) => body,
    );

    const preview = await ok(user.as("get", "/account/deletion"), (body) =>
      accountDeletionPreviewSchema.parse(body),
    );
    expect(preview).toMatchObject({ activeOrders: 2, blockers: [], supplierMemberships: [] });

    // The confirmation is required.
    expectError(await user.as("post", "/account/delete", {}), 400, "VALIDATION_ERROR");
    const deleted = await ok(user.as("post", "/account/delete", { confirm: true }), (b) => b);
    expect(deleted).toEqual({ deleted: true, cancelledOrders: 2 });

    // Every session ended — both of the app.
    expectError(await user.as("get", "/account/profile"), 401, "SESSION_ENDED");
    expectError(await call(second, IOS, "get", "/account/profile"), 401, "SESSION_ENDED");

    // The orders: cancelled as the user's own cancellation, W-04 to the suppliers.
    for (const id of [open.id, waiting.id]) {
      const order = await ok(asAdmin("get", `/admin/orders/${id}`), (b) =>
        adminOrderResponseSchema.parse(b),
      );
      expect(order.order.status).toBe("cancelled_by_user");
      expect(order.order.customer.name).toBeNull();
      expect(order.order.customer.phone).toBe("***");
    }
    const w04 = await db.query<{ count: string }>(
      "SELECT count(*) FROM outbound_message WHERE template = 'order_cancelled_by_user'",
    );
    expect(Number(w04.rows[0]!.count)).toBe(2);

    // The supplier: the finished order without the name and the number.
    const forSupplier = await ok(shop.as("get", `/supplier/orders/${done.id}`), (b) =>
      supplierOrderResponseSchema.parse(b),
    );
    expect(forSupplier.order.customer).toEqual({ kind: "revealed", phone: "", name: null });
    expect(JSON.stringify(forSupplier)).not.toContain(user.phone);

    // The garage, the mileage and the devices are gone; the account is impersonal.
    const left = await db.query(
      "SELECT phone, name, email, city_id, status, deleted_at FROM account WHERE id = $1",
      [user.accountId],
    );
    expect(left.rows[0]).toMatchObject({ name: null, email: null, status: "deleted" });
    expect(String(left.rows[0].phone)).toMatch(/^deleted:[a-p]+$/);
    expect(
      (await db.query("SELECT 1 FROM account_car WHERE account_id = $1", [user.accountId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query("SELECT 1 FROM device_token WHERE account_id = $1", [user.accountId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT 1 FROM club_access_grant WHERE account_id = $1 AND ended_at IS NULL",
          [user.accountId],
        )
      ).rowCount,
    ).toBe(0);

    // The review stays on the public page, without a name.
    const viewer = await customer();
    const page = await ok(viewer.as("get", `/suppliers/${shop.supplierId}/reviews`), (b) => b);
    const text = JSON.stringify(page);
    expect(text).toContain('"score":4');
    expect(text).not.toContain("Әлия");

    // The administrator: «Удалён», no data, the orders and the journal in place.
    const card = await ok(asAdmin("get", `/admin/users/${user.accountId}`), (b) =>
      adminUserResponseSchema.parse(b),
    );
    expect(card.user).toMatchObject({ name: null, email: null, phone: "***" });
    expect(card.user.deletedAt).not.toBeNull();
    expect(card.user.counts.orders).toBe(3);
    const listed = await ok(asAdmin("get", "/admin/users"), (b) => adminUserPageSchema.parse(b));
    expect(listed.users.map((entry) => entry.accountId)).not.toContain(user.accountId);
    const deletedOnes = await ok(asAdmin("get", "/admin/users?deleted=true"), (b) =>
      adminUserPageSchema.parse(b),
    );
    expect(deletedOnes.users.map((entry) => entry.accountId)).toEqual([user.accountId]);
    const found = await ok(
      asAdmin("get", `/admin/search?q=${encodeURIComponent(user.phone.slice(-7))}`),
      (b) => b as { users: { accountId: string }[] },
    );
    expect(found.users.map((entry) => entry.accountId)).not.toContain(user.accountId);
    expectError(
      await asAdmin("post", "/admin/phone-reveals", { subject: "account", id: user.accountId }),
      404,
      "NOT_FOUND",
    );

    // The journal: what was done, never the name or the e-mail.
    const journal = await db.query<{ action: string; body: string }>(
      "SELECT action, coalesce(before::text, '') || coalesce(after::text, '') AS body FROM audit_log",
    );
    for (const entry of journal.rows) {
      expect(entry.body, entry.action).not.toContain("Әлия");
      expect(entry.body, entry.action).not.toContain(USER_EMAIL);
      expect(entry.body, entry.action).not.toContain(user.phone);
    }
    expect(journal.rows.map((entry) => entry.action)).toContain("account.deleted");
    // The gateway's history keeps no message to the number.
    expect(
      (await db.query("SELECT 1 FROM outbound_message WHERE phone = $1", [user.phone])).rowCount,
    ).toBe(0);

    // The same number signs in again: a new, empty account.
    const again = await signIn(user.phone, IOS, false);
    expect(again.status).toBe(200);
    const fresh = await idOf("SELECT id FROM account WHERE phone = $1", [user.phone]);
    expect(fresh).not.toBe(user.accountId);
    const bearer = (again.body as { session: { accessToken: string } }).session.accessToken;
    const profile = await ok(call(bearer, IOS, "get", "/account/profile"), (b) =>
      accountProfileSchema.parse(b),
    );
    expect(profile).toMatchObject({ name: null, email: null, registrationCompleted: false });
    expect(
      await ok(call(bearer, IOS, "get", "/garage/cars"), (b) => b as { cars: unknown[] }),
    ).toMatchObject({ cars: [] });

    // After the retention: the hash and the consents are gone too.
    expect(
      (await db.query("SELECT 1 FROM account_consent WHERE account_id = $1", [user.accountId]))
        .rowCount,
    ).toBeGreaterThan(0);
    const erasure = new DeletedAccountErasure(() => Promise.resolve(0));
    const database = app.get(DatabaseService);
    const cutoff = new Date(Date.now() + 1000);
    await database.db.transaction(async (tx) => {
      const ids = await erasure.claim(tx, cutoff, { limit: 10, excludeIds: [] });
      expect(ids).toEqual([user.accountId]);
      await erasure.applyBatch(tx, cutoff, ids);
    });
    const erased = await db.query("SELECT phone, erased_at FROM account WHERE id = $1", [
      user.accountId,
    ]);
    expect(erased.rows[0].erased_at).not.toBeNull();
    expect(erased.rows[0].phone).not.toBe(left.rows[0].phone);
    expect(
      (await db.query("SELECT 1 FROM account_consent WHERE account_id = $1", [user.accountId]))
        .rowCount,
    ).toBe(0);
  });

  it("refuses the last employee and an administrator; a member who is not the last leaves", async () => {
    // The last employee of a company — refused, nothing changes.
    const memberPhone = "+77010000362";
    const shop = await company("Единственный", memberPhone);
    const asUser = await customer(memberPhone);
    const preview = await ok(asUser.as("get", "/account/deletion"), (body) =>
      accountDeletionPreviewSchema.parse(body),
    );
    expect(preview.blockers).toEqual([
      { kind: "last_member", supplierId: shop.supplierId, supplierName: "Единственный" },
    ]);
    const refused = await asUser.as("post", "/account/delete", { confirm: true });
    expectError(refused, 409, "ACCOUNT_DELETION_REFUSED");
    expect(refused.body.message).toContain("Вы единственный сотрудник «Единственный»");
    expect((await shop.as("get", "/supplier/company")).status).toBe(200);
    expect((await profileOf(asUser)).name).not.toBeNull();

    // With a colleague — the membership goes as a colleague's removal, the cabinet session ends.
    await ok(
      shop.as("post", "/supplier/members", { name: "Марат", phone: "+77010000363" }),
      (b) => b,
      201,
    );
    const left = await ok(asUser.as("post", "/account/delete", { confirm: true }), (b) => b);
    expect(left).toMatchObject({ deleted: true });
    expectError(await shop.as("get", "/supplier/company"), 401, "SUPPLIER_ACCESS_CLOSED");
    const member = await db.query<{ id: string; status: string; display_name: string }>(
      "SELECT m.id, m.status, m.display_name FROM supplier_member m WHERE m.account_id = $1",
      [asUser.accountId],
    );
    expect(member.rows[0]).toMatchObject({
      status: "removed",
      display_name: "Удалённый сотрудник",
    });
    // The administrator cannot bring back an employee whose account is deleted.
    expectError(
      await asAdmin(
        "post",
        `/admin/suppliers/${shop.supplierId}/members/${member.rows[0]!.id}/restore`,
        { reason: "По ошибке" },
      ),
      409,
      "SUPPLIER_MEMBER_STATE",
    );
    // No message is left addressed to the number, the company's invitation included.
    expect(
      (await db.query("SELECT 1 FROM outbound_message WHERE phone = $1", [memberPhone])).rowCount,
    ).toBe(0);

    // An administrator — refused.
    const adminAsUser = await customer(ADMIN_PHONE);
    expectError(
      await adminAsUser.as("post", "/account/delete", { confirm: true }),
      409,
      "ACCOUNT_DELETION_REFUSED",
    );
    expect((await asAdmin("get", "/admin/users")).status).toBe(200);
  });

  // ------------------------------------------------------------------ consents

  it("records the server's versions, asks again after a new one and gates the orders", async () => {
    const shop = await company("Согласия");
    const of = await offer(shop);
    const user = await customer();

    const profile = await profileOf(user);
    expect(profile.consentsOutdated).toBe(false);
    expect(profile.phoneShareConsent?.version).toBe("2026-09-mvp");
    expect(profile.consents.map((entry) => [entry.kind, entry.version])).toEqual(
      expect.arrayContaining([
        ["phone_share", "2026-09-mvp"],
        ["terms", "2026-11-mvp"],
      ]),
    );

    // A VIN saved — the consent to keep it.
    await ok(
      user.as("post", "/garage/cars", { levels: await geelyLevels(), color: null, vin: VIN }),
      (b) => b,
      201,
    );
    expect((await profileOf(user)).consents.map((entry) => entry.kind)).toContain(
      "vehicle_document",
    );

    await settings.set({ consent_terms_version: "2027-01-new" });
    const outdated = await profileOf(user);
    expect(outdated).toMatchObject({ consentsOutdated: true, outdatedConsents: ["terms"] });
    const gated = await user.as("post", "/orders", {
      offerId: of.id,
      quantity: 1,
      fulfillment: "pickup",
      expectedPrice: of.price,
      idempotencyKey: randomUUID(),
    });
    expectError(gated, 403, "CONSENT_REQUIRED");
    expect(gated.body.details).toEqual({ kinds: ["terms"] });

    const accepted = await ok(user.as("post", "/account/consents", {}), (b) =>
      accountProfileSchema.parse(b),
    );
    expect(accepted.consentsOutdated).toBe(false);
    expect(accepted.consents[0]).toMatchObject({
      kind: "terms",
      version: "2027-01-new",
      current: true,
    });
    await place(user, of);

    // The administrator sees the same journal.
    const card = await ok(asAdmin("get", `/admin/users/${user.accountId}`), (b) =>
      adminUserResponseSchema.parse(b),
    );
    expect(card.user.consents.map((entry) => entry.version)).toContain("2027-01-new");
    const platforms = await db.query<{ client: string; platform: string | null }>(
      "SELECT client, platform FROM account_consent WHERE account_id = $1",
      [user.accountId],
    );
    expect(platforms.rows.every((row) => row.client === "mobile")).toBe(true);
    expect(platforms.rows.some((row) => row.platform === "ios")).toBe(true);
  });

  // ------------------------------------------------------------------ export

  it("exports a user's data once, by a link, with a journal entry and no tokens", async () => {
    const shop = await company("Выгрузка");
    const of = await offer(shop);
    const user = await customer();
    const other = await customer();
    await ok(
      user.as("post", "/garage/cars", { levels: await geelyLevels(), color: null, vin: VIN }),
      (b) => b,
      201,
    );
    const order = await place(user, of);
    await place(other, of);

    expectError(
      await asAdmin("post", `/admin/users/${user.accountId}/data-exports`, { reason: " " }),
      400,
      "VALIDATION_ERROR",
    );
    const link = await ok(
      asAdmin("post", `/admin/users/${user.accountId}/data-exports`, {
        reason: "Запрос пользователя по почте",
      }),
      (b) => adminUserDataExportLinkSchema.parse(b),
    );
    const file = await http().get(link.url);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/json");
    const text = file.text;
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining([
        "account",
        "consents",
        "garage",
        "orders",
        "reviews",
        "complaints",
        "subscriptions",
        "clubAccessGrants",
        "sessions",
        "pushDevices",
      ]),
    );
    expect(text).toContain(VIN);
    expect(text).toContain(user.phone);
    expect(text).toContain(String(order.number));
    expect(text).not.toContain(other.phone);
    expect(text).not.toContain(user.bearer);
    expect(text).not.toMatch(/refresh|accessToken|confirmation_code|qr_token|token"/i);

    // Once only.
    expect((await http().get(link.url)).status).toBe(410);
    expect((await http().get(`${link.url}x`)).status).toBe(410);

    const journal = await db.query<{ reason: string; after: unknown }>(
      "SELECT reason, after FROM audit_log WHERE action = 'account.data_exported'",
    );
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0]!.reason).toBe("Запрос пользователя по почте");
    expect(JSON.stringify(journal.rows[0]!.after)).not.toContain(VIN);

    // A deleted account is exported with what is left of it.
    await ok(user.as("post", "/account/delete", { confirm: true }), (b) => b);
    const after = await ok(
      asAdmin("post", `/admin/users/${user.accountId}/data-exports`, { reason: "Повторно" }),
      (b) => adminUserDataExportLinkSchema.parse(b),
    );
    const leftover = JSON.parse((await http().get(after.url)).text) as {
      account: { phone: string | null; name: string | null; deletedAt: string | null };
      garage: unknown[];
      orders: unknown[];
    };
    expect(leftover.account).toMatchObject({ phone: null, name: null });
    expect(leftover.account.deletedAt).not.toBeNull();
    expect(leftover.garage).toEqual([]);
    expect(leftover.orders).toHaveLength(1);
  });
  // ------------------------------------------------------------------ TASK-072.A

  /** Waits until `count` backends of the test database wait for a lock. */
  async function lockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 1_500;
    for (;;) {
      const { rows } = await db.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
      );
      if (Number(rows[0]!.count) >= count) return;
      if (Date.now() > deadline) throw new Error(`lock waiters: ${rows[0]!.count} of ${count}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("a sign-in racing the deletion gets a new account, never a session of the deleted one", async () => {
    const user = await customer();
    rememberCode(user.phone);
    await redis.del(`rl:login-code:resend:${user.phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", nextIp())
      .send({ phone: user.phone });
    expect(sent.status).toBe(200);
    const code = channels.sent.filter((message) => message.phone === user.phone).at(-1)!.code;
    rememberCode(code);

    // The deletion takes the account row first (a holder keeps it a moment,
    // so both requests are surely in flight); the second device's sign-in
    // arrives while the deletion holds it.
    const holder = new Client({ connectionString: postgres.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM account WHERE id = $1 FOR UPDATE", [user.accountId]);
      const deleting = user.as("post", "/account/delete", { confirm: true }).then((r) => r);
      await lockWaiters(1);
      const signingIn = http()
        .post("/auth/login-code/verify")
        .set("X-Client", IOS)
        .set("X-Forwarded-For", nextIp())
        .send({ phone: user.phone, code })
        .then((r) => r);
      await lockWaiters(2);
      await holder.query("COMMIT");
      const [deleted, signedIn] = await Promise.all([deleting, signingIn]);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
      remember(signedIn.body);

      // The new session is of a new, empty account.
      const bearer = (signedIn.body as { session: { accessToken: string } }).session.accessToken;
      const profile = await ok(call(bearer, IOS, "get", "/account/profile"), (b) =>
        accountProfileSchema.parse(b),
      );
      const fresh = await idOf("SELECT id FROM account WHERE phone = $1", [user.phone]);
      expect(fresh).not.toBe(user.accountId);
      expect(profile.phone).toBe(user.phone);
      expect(profile.registrationCompleted).toBe(false);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
    const alive = await db.query(
      "SELECT id FROM session WHERE account_id = $1 AND revoked_at IS NULL",
      [user.accountId],
    );
    expect(alive.rowCount).toBe(0);
  });

  it("the guard, the token exchange and the sign-in refuse a deleted account", async () => {
    const user = await customer();
    const signedIn = await signIn(user.phone, IOS, false);
    const { accessToken, refreshToken } = (
      signedIn.body as { session: { accessToken: string; refreshToken: string } }
    ).session;
    await ok(user.as("post", "/account/delete", { confirm: true }), (b) => b);

    // A session of the deleted account that is somehow still open (as one
    // opened while the deletion ran would have been) opens nothing.
    const reopen = async () =>
      db.query(
        "UPDATE session SET revoked_at = NULL, revoked_reason = NULL WHERE account_id = $1",
        [user.accountId],
      );
    await reopen();
    expectError(await call(accessToken, IOS, "get", "/auth/me"), 401, "SESSION_ENDED");
    const ended = await db.query<{ revoked_reason: string }>(
      "SELECT DISTINCT revoked_reason FROM session WHERE account_id = $1 AND revoked_at IS NOT NULL",
      [user.accountId],
    );
    expect(ended.rows.map((row) => row.revoked_reason)).toContain("account_deleted");

    await reopen();
    const exchanged = await http()
      .post("/auth/session/refresh")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", nextIp())
      .send({ refreshToken });
    expectError(exchanged, 401, "SESSION_ENDED");
    // The exchange ended the session it was asked about.
    const latest = await db.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM session WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.accountId],
    );
    expect(latest.rows[0]!.revoked_reason).toBe("account_deleted");
  });

  it("the redaction flag only takes keys out of a journal entry", async () => {
    const { rows } = await db.query<{ id: string; after: Record<string, unknown> }>(
      "SELECT id, after FROM audit_log WHERE jsonb_typeof(after) = 'object' AND after <> '{}'::jsonb LIMIT 1",
    );
    const entry = rows[0]!;
    const key = Object.keys(entry.after)[0]!;
    const attempt = async (setClause: string, values: unknown[]): Promise<string | null> => {
      await db.query("BEGIN");
      try {
        await db.query("SELECT set_config('adclub.audit_redaction', 'on', true)");
        await db.query(`UPDATE audit_log SET ${setClause} WHERE id = $1`, [entry.id, ...values]);
        await db.query("ROLLBACK");
        return null;
      } catch (error) {
        await db.query("ROLLBACK");
        return (error as Error).message;
      }
    };
    // Rewriting a value, adding a key, replacing the object, clearing it — refused.
    expect(await attempt("after = jsonb_set(after, ARRAY[$2], '\"forged\"')", [key])).toMatch(
      /append-only/,
    );
    expect(await attempt(`after = after || '{"forged":1}'::jsonb`, [])).toMatch(/append-only/);
    expect(await attempt(`after = '[]'::jsonb`, [])).toMatch(/append-only/);
    expect(await attempt("after = NULL", [])).toMatch(/append-only/);
    expect(await attempt("reason = 'forged'", [])).toMatch(/append-only/);
    // Taking a key out passes, and so does leaving the entry as it is.
    expect(await attempt("after = after - $2::text", [key])).toBeNull();
    expect(await attempt("after = after", [])).toBeNull();
    // Without the flag nothing passes.
    await db.query("BEGIN");
    await expect(
      db.query("UPDATE audit_log SET after = after - $2::text WHERE id = $1", [entry.id, key]),
    ).rejects.toThrow(/append-only/);
    await db.query("ROLLBACK");
  });

  it("a message being sent and the channel of the number keep no number after the deletion", async () => {
    const user = await customer();
    expect(
      (await db.query("SELECT 1 FROM phone_verification WHERE phone = $1", [user.phone])).rowCount,
    ).toBe(1);
    const insert = async (key: string) =>
      idOf(
        `INSERT INTO outbound_message (dedupe_key, template, lang, phone, subject_type, variables, status, attempts, claimed_until)
         VALUES ($1, 'supplier_invitation', 'ru', $2, 'test', '{"name":"Әлия"}'::jsonb, 'sending', 1, now() + interval '1 minute')
         RETURNING id`,
        [key, user.phone],
      );
    const sentOne = await insert(`sending:${randomUUID()}`);
    const retried = await insert(`sending:${randomUUID()}`);

    await ok(user.as("post", "/account/delete", { confirm: true }), (b) => b);
    expect(
      (await db.query("SELECT 1 FROM phone_verification WHERE phone = $1", [user.phone])).rowCount,
    ).toBe(0);
    // The attempt is still out: the row waits with its mark.
    const marked = await db.query<{ erase_phone: boolean }>(
      "SELECT erase_phone FROM outbound_message WHERE id = ANY($1)",
      [[sentOne, retried]],
    );
    expect(marked.rows.map((row) => row.erase_phone)).toEqual([true, true]);

    // The attempt settles it — the number and the values go in the same update.
    await db.query(
      `UPDATE outbound_message SET status = 'sent', provider = 'test', provider_message_id = 'wamid.t072a',
         sent_at = now(), settled_at = now(), claimed_until = NULL WHERE id = $1`,
      [sentOne],
    );
    // The attempt failed and gives it back for a retry — it is cancelled instead.
    await db.query(
      "UPDATE outbound_message SET status = 'queued', claimed_until = NULL WHERE id = $1",
      [retried],
    );
    const settled = await db.query<{
      id: string;
      phone: string;
      variables: unknown;
      status: string;
      erase_phone: boolean;
    }>(
      "SELECT id, phone, variables, status, erase_phone FROM outbound_message WHERE id = ANY($1) ORDER BY id = $2 DESC",
      [[sentOne, retried], sentOne],
    );
    expect(settled.rows).toEqual([
      { id: sentOne, phone: "+70000000000", variables: null, status: "sent", erase_phone: false },
      {
        id: retried,
        phone: "+70000000000",
        variables: null,
        status: "cancelled",
        erase_phone: false,
      },
    ]);
    expect(
      (await db.query("SELECT 1 FROM outbound_message WHERE phone = $1", [user.phone])).rowCount,
    ).toBe(0);
  });

  it("deletes within the statement limit on a journal and a gateway of 500 000 rows each", async () => {
    const user = await customer();
    await ok(user.as("patch", "/account/profile", { email: USER_EMAIL }), (b) => b);
    const ROWS = 500_000;
    // The worst case for the partial indexes: every entry names some account.
    await db.query(
      `INSERT INTO audit_log (action, actor_role, entity_type, entity_id, before, after)
       SELECT 'order.changed', 'system', 'customer_order', g::text,
         jsonb_build_object('accountId', gen_random_uuid()::text, 'status', 'new'),
         jsonb_build_object('accountId', gen_random_uuid()::text, 'name', 'Кто-то')
       FROM generate_series(1, $1::int) AS g`,
      [ROWS],
    );
    await db.query(
      `INSERT INTO audit_log (action, actor_role, actor_account_id, entity_type, entity_id, after)
       SELECT 'account.profile_updated', 'user', $1::uuid, 'account', $1::text,
         jsonb_build_object('accountId', $1::text, 'name', $2::text, 'email', $3::text)
       FROM generate_series(1, 50)`,
      [user.accountId, USER_NAME, USER_EMAIL],
    );
    await db.query(
      `INSERT INTO outbound_message (dedupe_key, template, lang, phone, subject_type, status, settled_at)
       SELECT 'bulk:' || g, 'supplier_invitation', 'ru', '+7700' || lpad(g::text, 7, '0'), 'test',
         'cancelled', now()
       FROM generate_series(1, $1::int) AS g`,
      [ROWS],
    );
    await db.query(
      `INSERT INTO outbound_message (dedupe_key, template, lang, phone, subject_type, status, settled_at)
       SELECT 'mine:' || g, 'supplier_invitation', 'ru', $1, 'test', 'cancelled', now()
       FROM generate_series(1, 20) AS g`,
      [user.phone],
    );
    const event = await idOf(
      "INSERT INTO inbound_webhook_event (provider, external_id) VALUES ('whatsapp', $1) RETURNING id",
      [randomUUID()],
    );
    await db.query(
      `INSERT INTO message_button_press (event_id, provider_message_id, from_phone)
       SELECT $1, 'wamid.bulk.' || g, '+7700' || lpad(g::text, 7, '0')
       FROM generate_series(1, $2::int) AS g`,
      [event, ROWS],
    );
    await db.query(
      `INSERT INTO message_button_press (event_id, provider_message_id, from_phone)
       SELECT $1, 'wamid.mine.' || g, $2 FROM generate_series(1, 5) AS g`,
      [event, user.phone],
    );
    await db.query("ANALYZE audit_log; ANALYZE outbound_message; ANALYZE message_button_press");

    // The statements of the deletion that look into the big tables find
    // their rows through indexes — none reads a table through.
    const plans: [string, unknown[]][] = [
      [
        `SELECT id FROM audit_log WHERE (entity_type = 'account' AND entity_id = $1)
           OR before ->> 'accountId' = $1 OR after ->> 'accountId' = $1
           OR (actor_account_id = $1::uuid AND actor_role = 'user')`,
        [user.accountId],
      ],
      ["SELECT id FROM outbound_message WHERE phone = $1 AND status <> 'sending'", [user.phone]],
      ["SELECT id FROM message_button_press WHERE from_phone = $1", [user.phone]],
    ];
    for (const [text, values] of plans) {
      const { rows } = await db.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON) ${text}`,
        values,
      );
      expect(JSON.stringify(rows[0]!["QUERY PLAN"]), text).not.toContain("Seq Scan");
    }

    const deleteStarted = Date.now();
    await ok(user.as("post", "/account/delete", { confirm: true }), (b) => b);
    // Measured: 123–532 ms (TASK-072.A report); the limit of one statement is 2 s.
    expect(Date.now() - deleteStarted).toBeLessThan(2_000);

    const journal = await db.query(
      "SELECT 1 FROM audit_log WHERE (after ->> 'accountId' = $1) AND (after ? 'name' OR after ? 'email')",
      [user.accountId],
    );
    expect(journal.rowCount).toBe(0);
    expect(
      (await db.query("SELECT 1 FROM outbound_message WHERE phone = $1", [user.phone])).rowCount,
    ).toBe(0);
    expect(
      (await db.query("SELECT 1 FROM message_button_press WHERE from_phone = $1", [user.phone]))
        .rowCount,
    ).toBe(0);
  }, 300_000);
});
