import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminOrderPageSchema,
  adminOrderResponseSchema,
  adminSearchResponseSchema,
  adminSupplierLeadResponseSchema,
  adminSupplierResponseSchema,
  adminUserGarageResponseSchema,
  adminUserPageSchema,
  adminUserResponseSchema,
  adminUserSessionListResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  clubAccessGrantPageSchema,
  clubAccessGrantResponseSchema,
  createOrderResponseSchema,
  orderStateConflictDetailsSchema,
  rateLimitedDetailsSchema,
  revealPhoneResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierOrderPageSchema,
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
import { hidePhone, kzBinCheckDigit, normalizeArticle } from "@adclub/domain";
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
import { completeTestRegistration, TEST_CUSTOMER_NAME } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import { DevVehicleSeed } from "../vehicles";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";

/**
 * TASK-036.B on a real PostgreSQL and Redis: the administrator's cancel of an
 * order — the move `admin_cancel` of the one table, its reason, what the
 * supplier and the user see, an order whose deadline has just passed, the
 * race with a close without a code; the users of the app — the list with its
 * filters, the card, the garage, club access by the account, the sessions
 * ended (the app gets SESSION_ENDED), the access matrix; numbers — partly
 * hidden in every admin answer, in full only by «Показать номер», with a
 * journal entry that never holds the number; the header's search with its
 * limit; and the journal naming objects by their names now.
 */

const ADMIN_PHONE = "+77011234567";
const SECOND_ADMIN_PHONE = "+77012223344";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

/** The digits of a number as a full number would show them, with or without «+». */
const digitsOf = (phone: string) => phone.replace(/\D/g, "");

describe("admin panel: orders, users, numbers, search, journal (PostgreSQL + Redis)", () => {
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
    await db.query(TRUNCATE_ALL);
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

  async function signIn(
    phone: string,
    client: string,
    options: { registered?: boolean } = {},
  ): Promise<Response> {
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
    if (client === IOS && options.registered !== false) {
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

  async function sessionToken(
    phone: string,
    client: string,
    options: { registered?: boolean } = {},
  ): Promise<string> {
    const response = await signIn(phone, client, options);
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
    bin: string;
    phone: string;
    memberId: string;
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
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1",
      [phone],
    );
    return {
      supplierId: created.supplier.id,
      name,
      bin,
      phone,
      memberId,
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

  async function customer(
    options: { access?: boolean; registered?: boolean; until?: Date } = {},
  ): Promise<Customer> {
    const phone = `+7747${String(++phoneCounter).padStart(7, "0")}`;
    rememberCode(phone);
    const bearer = await sessionToken(phone, IOS, { registered: options.registered });
    if (options.access !== false) {
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          phone,
          validUntil: (options.until ?? new Date(Date.now() + 30 * DAY)).toISOString(),
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

  async function adminOrder(orderId: string) {
    return ok(asAdmin("get", `/admin/orders/${orderId}`), (body) => {
      adminOrderResponseSchema.parse(body);
      return (body as { order: ReturnType<typeof adminOrderResponseSchema.parse>["order"] }).order;
    });
  }

  async function accept(of: Company, orderId: string, expectedVersion = 1) {
    return ok(of.as("post", `/supplier/orders/${orderId}/accept`, { expectedVersion }), (body) =>
      supplierOrderResponseSchema.parse(body),
    );
  }

  async function auditOf(query: string) {
    return ok(asAdmin("get", `/admin/audit-log?${query}`), (raw) => auditLogPageSchema.parse(raw));
  }

  /** Lets an accepted order's reserve run out; the card applies the passed deadline itself. */
  async function noShow(orderId: string): Promise<void> {
    await db.query(
      "UPDATE customer_order SET expires_at = now() - interval '1 minute', reserve_warn_at = now() - interval '2 minutes' WHERE id = $1",
      [orderId],
    );
    expect((await adminOrder(orderId)).status).toBe("reserve_expired");
  }

  // ----------------------------------------------- cancel by the administrator

  describe("cancelling an order by the administrator (A-ORD-02)", () => {
    it("cancels a new and an accepted order only with a reason, through the one table of moves", async () => {
      const shop = await company("Отмена");
      const offer = await put(shop);
      const buyer = await customer();
      const fresh = await place(buyer, offer);

      // Without a reason — refused by the contract, nothing moves.
      expectError(
        await asAdmin("post", `/admin/orders/${fresh.id}/cancel`, { expectedVersion: 1 }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", `/admin/orders/${fresh.id}/cancel`, {
          expectedVersion: 1,
          reason: "   ",
        }),
        400,
        "VALIDATION_ERROR",
      );

      const cancelled = await ok(
        asAdmin("post", `/admin/orders/${fresh.id}/cancel`, {
          expectedVersion: 1,
          reason: "Клиент попросил по телефону",
        }),
        (body) => adminOrderResponseSchema.parse(body).order,
      );
      expect(cancelled).toMatchObject({
        status: "cancelled_by_admin",
        version: 2,
        cancellation: { reason: "Клиент попросил по телефону" },
      });
      expect(cancelled.events.at(-1)).toMatchObject({
        action: "admin_cancel",
        fromStatus: "created",
        toStatus: "cancelled_by_admin",
        actor: { kind: "admin" },
        channel: "admin",
        details: { adminNote: "Клиент попросил по телефону" },
      });
      // The code is free again; the database keeps who and why.
      const { rows } = await db.query<{
        code_released_at: Date | null;
        cancel_reason: string | null;
        cancelled_by_admin_id: string | null;
      }>(
        "SELECT code_released_at, cancel_reason, cancelled_by_admin_id FROM customer_order WHERE id = $1",
        [fresh.id],
      );
      expect(rows[0]!.code_released_at).not.toBeNull();
      expect(rows[0]!.cancel_reason).toBe("Клиент попросил по телефону");
      expect(rows[0]!.cancelled_by_admin_id).not.toBeNull();

      // The supplier sees the cancel in the cabinet — never the words.
      const bySupplier = await ok(shop.as("get", `/supplier/orders/${fresh.id}`), (body) =>
        supplierOrderResponseSchema.parse(body),
      );
      expect(bySupplier.order.status).toBe("cancelled_by_admin");
      expect(JSON.stringify(bySupplier)).not.toContain("Клиент попросил");
      const finished = await ok(
        shop.as("get", "/supplier/orders?tab=finished&status=cancelled_by_admin"),
        (body) => supplierOrderPageSchema.parse(body),
      );
      expect(finished.orders.map((order) => order.id)).toEqual([fresh.id]);
      // The user sees it in the app, with the side, never the words.
      const byUser = await ok(buyer.as("get", `/orders/${fresh.id}`), (body) =>
        userOrderResponseSchema.parse(body),
      );
      expect(byUser.order.status).toBe("cancelled_by_admin");
      expect(byUser.order.confirmation ?? null).toBeNull();
      expect(JSON.stringify(byUser)).not.toContain("Клиент попросил");
      // No WhatsApp message «Клиент отменил» goes out for it.
      const notices = await db.query(
        "SELECT 1 FROM outbound_message WHERE template = 'order_cancelled_by_user' AND subject_id = $1",
        [fresh.id],
      );
      expect(notices.rowCount).toBe(0);
      // The journal of actions keeps the reason.
      const journal = await auditOf(`action=order.cancelled_by_admin&entityId=${fresh.id}`);
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]).toMatchObject({
        reason: "Клиент попросил по телефону",
        entityName: `№ ${String(fresh.number)}`,
      });

      // An accepted order too; a repeat of the same cancel is no error.
      const second = await place(buyer, offer);
      await accept(shop, second.id);
      const again = await ok(
        asAdmin("post", `/admin/orders/${second.id}/cancel`, {
          expectedVersion: 2,
          reason: "Поставщик закрылся",
        }),
        (body) => adminOrderResponseSchema.parse(body).order,
      );
      expect(again.status).toBe("cancelled_by_admin");
      expect(
        (
          await asAdmin("post", `/admin/orders/${second.id}/cancel`, {
            expectedVersion: 2,
            reason: "Поставщик закрылся",
          })
        ).status,
      ).toBe(200);
      // A final order is not cancelled.
      const reCancel = await asAdmin("post", `/admin/orders/${second.id}/cancel`, {
        expectedVersion: 3,
        reason: "Другая причина",
      });
      expectError(reCancel, 409, "ORDER_STATE_CONFLICT");
    });

    it("answers clearly when the deadline has just passed: the order expired first", async () => {
      const shop = await company("Истекла");
      const buyer = await customer();
      const order = await place(buyer, await put(shop));
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
        [order.id],
      );
      const refused = await asAdmin("post", `/admin/orders/${order.id}/cancel`, {
        expectedVersion: 1,
        reason: "Хотели отменить",
      });
      expectError(refused, 409, "ORDER_STATE_CONFLICT");
      const details = orderStateConflictDetailsSchema.parse(refused.body.details);
      expect(details.currentStatus).toBe("response_expired");
      expect(details.lastAction).toMatchObject({
        action: "expire_no_response",
        actor: { kind: "system" },
      });
    });

    it("lets exactly one of two administrators win: a cancel against a close without a code", async () => {
      const other = await setUpAdmin(SECOND_ADMIN_PHONE);
      const shop = await company("Гонка");
      const offer = await put(shop);
      const buyer = await customer();
      for (let round = 0; round < 4; round += 1) {
        const order = await place(buyer, offer);
        await accept(shop, order.id);
        const [cancel, close] = await Promise.all([
          asAdmin("post", `/admin/orders/${order.id}/cancel`, {
            expectedVersion: 2,
            reason: "Отмена в гонке",
          }),
          call(other, ADMIN_WEB, "post", `/admin/orders/${order.id}/close`, {
            expectedVersion: 2,
            reason: "Закрытие в гонке",
          }),
        ]);
        const statuses = [cancel.status, close.status].sort();
        expect(statuses, `round ${String(round)}`).toEqual([200, 409]);
        const loser = cancel.status === 409 ? cancel : close;
        const details = orderStateConflictDetailsSchema.parse(loser.body.details);
        expect(details.lastAction?.actor.kind).toBe("admin");
        expect(details.lastAction?.action).toBe(
          cancel.status === 409 ? "admin_close" : "admin_cancel",
        );
        const final = await adminOrder(order.id);
        expect(final.status).toBe(cancel.status === 200 ? "cancelled_by_admin" : "completed");
        const moves = final.events.filter(
          (event) => event.action === "admin_cancel" || event.action === "admin_close",
        );
        expect(moves).toHaveLength(1);
      }
    });
  });

  // ----------------------------------------------------------------- users

  describe("users of the app (A-USR-01…03)", () => {
    it("lists users with their search and filters, and only users of the app", async () => {
      const shop = await company("Только кабинет");
      const member = await customer({ until: new Date(Date.now() + 3 * DAY) });
      const plain = await customer({ access: false, registered: false });
      const page = await ok(asAdmin("get", "/admin/users"), (body) =>
        adminUserPageSchema.parse(body),
      );
      const ids = page.users.map((user) => user.accountId);
      expect(ids).toContain(member.accountId);
      expect(ids).toContain(plain.accountId);
      // A cabinet employee who never used the app, and the administrator, are not users.
      const shopAccount = await idOf("SELECT id FROM account WHERE phone = $1", [shop.phone]);
      const adminAccount = await idOf("SELECT id FROM account WHERE phone = $1", [ADMIN_PHONE]);
      expect(ids).not.toContain(shopAccount);
      expect(ids).not.toContain(adminAccount);
      expect(page.total).toBe(2);
      // The user without a name is in the list, by the number partly hidden.
      const unnamed = page.users.find((user) => user.accountId === plain.accountId)!;
      expect(unnamed).toMatchObject({
        name: null,
        phone: hidePhone(plain.phone),
        registrationCompleted: false,
        clubAccess: { granted: false },
      });
      expect(page.users.find((user) => user.accountId === member.accountId)).toMatchObject({
        name: TEST_CUSTOMER_NAME,
        clubAccess: { granted: true },
        noShows: 0,
        supplierMember: false,
      });

      const by = async (query: string) =>
        (
          await ok(asAdmin("get", `/admin/users?${query}`), (body) =>
            adminUserPageSchema.parse(body),
          )
        ).users.map((user) => user.accountId);
      // A part of the number in any spelling; a part of the name.
      expect(await by(`q=${digitsOf(member.phone).slice(-4)}`)).toEqual([member.accountId]);
      const spelled = `8 ${digitsOf(member.phone).slice(1, 4)} ${digitsOf(member.phone).slice(4)}`;
      expect(await by(`q=${encodeURIComponent(spelled)}`)).toEqual([member.accountId]);
      expect(await by(`q=${encodeURIComponent("тест")}`)).toEqual([member.accountId]);
      expect(await by("clubAccess=active")).toEqual([member.accountId]);
      expect(await by("clubAccess=none")).toEqual([plain.accountId]);
      expect(await by("clubAccess=expiring&expiringDays=7")).toEqual([member.accountId]);
      expect(await by("clubAccess=expiring&expiringDays=1")).toEqual([]);
      expect(await by("noShows=true")).toEqual([]);

      // A no-show puts the user under «есть неявки».
      const order = await place(member, await put(shop));
      await accept(shop, order.id);
      await noShow(order.id);
      expect(await by("noShows=true")).toEqual([member.accountId]);
    });

    it("shows the card, the garage and the employments, and gives and takes club access by the account", async () => {
      const shop = await company("Работа");
      const employee = shop.phone;
      // The employee uses the app too.
      const employeeBearer = await sessionToken(employee, IOS);
      const accountId = await idOf("SELECT id FROM account WHERE phone = $1", [employee]);
      await app.get(DevVehicleSeed).run();
      const { rows: vehicle } = await db.query<{ make_id: string; model_id: string }>(
        "SELECT make_id, id AS model_id FROM vehicle_model LIMIT 1",
      );
      const added = await call(employeeBearer, IOS, "post", "/garage/cars", {
        levels: {
          make: { id: vehicle[0]!.make_id, label: "Geely" },
          model: { id: vehicle[0]!.model_id, label: "Atlas" },
          year: 2023,
          generation: null,
          body: null,
          engine: null,
          transmission: null,
          drive: null,
        },
        color: null,
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const card = await ok(
        asAdmin("get", `/admin/users/${accountId}`),
        (body) => adminUserResponseSchema.parse(body).user,
      );
      expect(card).toMatchObject({
        accountId,
        name: TEST_CUSTOMER_NAME,
        phone: hidePhone(employee),
        registrationCompleted: true,
        phoneShareConsent: { version: "test" },
        clubAccess: { granted: false, validUntil: null },
        memberships: [{ supplierId: shop.supplierId, supplierName: "Работа", status: "active" }],
        counts: { orders: 0, sessions: 1, cars: 1 },
      });
      const garage = await ok(asAdmin("get", `/admin/users/${accountId}/garage`), (body) =>
        adminUserGarageResponseSchema.parse(body),
      );
      expect(garage.cars).toHaveLength(1);
      expect(garage.cars[0]).toMatchObject({ year: 2023, isPrimary: true });

      // Give access by the account (the card has no full number), then again — replaced.
      const until = new Date(Date.now() + 60 * DAY).toISOString();
      const granted = await ok(
        asAdmin("post", "/admin/club-access/grants", {
          accountId,
          validUntil: until,
          reason: "Альфа",
        }),
        (body) => clubAccessGrantResponseSchema.parse(body),
        201,
      );
      expect(granted.access.granted).toBe(true);
      await ok(
        asAdmin("post", "/admin/club-access/grants", {
          accountId,
          validUntil: new Date(Date.now() + 90 * DAY).toISOString(),
          reason: "Продление",
        }),
        (body) => clubAccessGrantResponseSchema.parse(body),
        201,
      );
      const grants = await ok(
        asAdmin("get", `/admin/club-access/grants?status=all&accountId=${accountId}`),
        (body) => clubAccessGrantPageSchema.parse(body),
      );
      expect(grants.grants.map((grant) => grant.status)).toEqual(["active", "replaced"]);
      // Both a phone and an account, or neither — refused.
      expectError(
        await asAdmin("post", "/admin/club-access/grants", { validUntil: until, reason: "x" }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", "/admin/club-access/grants", {
          accountId: randomUUID(),
          validUntil: until,
          reason: "Нет такого",
        }),
        400,
        "VALIDATION_ERROR",
      );
      const revoked = await ok(
        asAdmin("post", "/admin/club-access/revoke", { accountId, reason: "Конец альфы" }),
        (body) => clubAccessGrantResponseSchema.parse(body),
      );
      expect(revoked.access.granted).toBe(false);
      expectError(
        await asAdmin("post", "/admin/club-access/revoke", { accountId, reason: "Ещё раз" }),
        409,
        "CLUB_ACCESS_NOT_GRANTED",
      );
      expectError(await asAdmin("get", `/admin/users/${randomUUID()}`), 404, "NOT_FOUND");
    });

    it("ends the sessions of the app: the app gets SESSION_ENDED, the cabinet session stays", async () => {
      const shop = await company("Сессии");
      const appBearer = await sessionToken(shop.phone, IOS);
      const accountId = await idOf("SELECT id FROM account WHERE phone = $1", [shop.phone]);
      const sessions = await ok(asAdmin("get", `/admin/users/${accountId}/sessions`), (body) =>
        adminUserSessionListResponseSchema.parse(body),
      );
      expect(sessions.sessions).toHaveLength(1);
      expect(JSON.stringify(sessions)).not.toContain(appBearer);
      expectError(
        await asAdmin("post", `/admin/users/${accountId}/sessions/${randomUUID()}/end`),
        404,
        "NOT_FOUND",
      );
      const ended = await ok(
        asAdmin("post", `/admin/users/${accountId}/sessions/end`),
        (body) => body as { ended: number },
      );
      expect(ended.ended).toBe(1);
      expectError(await call(appBearer, IOS, "get", "/auth/me"), 401, "SESSION_ENDED");
      // The cabinet is another role of the same person: untouched.
      expect((await shop.as("get", "/supplier/company")).status).toBe(200);
      const journal = await auditOf(`action=account.sessions_ended&entityId=${accountId}`);
      expect(journal.entries[0]).toMatchObject({ after: { ended: 1 } });
      // The user's history finds it.
      const history = await auditOf(`accountId=${accountId}`);
      expect(history.entries.map((entry) => entry.action)).toContain("account.sessions_ended");
    });

    it("lists no-shows with the sort, the name and the number partly hidden (A-USR-03)", async () => {
      const shop = await company("Неявки");
      const offer = await put(shop);
      const often = await customer();
      const once = await customer();
      for (const who of [often, often, once]) {
        const order = await place(who, offer);
        await accept(shop, order.id);
        await noShow(order.id);
      }
      const byCount = await ok(
        asAdmin("get", "/admin/discipline/users"),
        (body) =>
          body as {
            users: { accountId: string; count: number; name: string | null; phone: string }[];
          },
      );
      expect(byCount.users.map((user) => user.accountId)).toEqual([
        often.accountId,
        once.accountId,
      ]);
      expect(byCount.users[0]).toMatchObject({
        count: 2,
        name: TEST_CUSTOMER_NAME,
        phone: hidePhone(often.phone),
      });
      const byLast = await ok(
        asAdmin("get", "/admin/discipline/users?sort=last"),
        (body) =>
          body as {
            users: { accountId: string }[];
          },
      );
      expect(byLast.users.map((user) => user.accountId)).toEqual([once.accountId, often.accountId]);
    });

    it("keeps every new route of the admin panel to the admin context", async () => {
      const shop = await company("Матрица");
      const buyer = await customer();
      const order = await place(buyer, await put(shop));
      const routes: [Method, string, object?][] = [
        ["get", "/admin/users"],
        ["get", `/admin/users/${buyer.accountId}`],
        ["get", `/admin/users/${buyer.accountId}/garage`],
        ["get", `/admin/users/${buyer.accountId}/sessions`],
        ["post", `/admin/users/${buyer.accountId}/sessions/end`],
        ["post", `/admin/users/${buyer.accountId}/sessions/${randomUUID()}/end`],
        ["post", "/admin/phone-reveals", { subject: "account", id: buyer.accountId }],
        ["get", "/admin/search?q=1028"],
        ["post", `/admin/orders/${order.id}/cancel`, { expectedVersion: 1, reason: "Матрица" }],
      ];
      for (const [method, path, body] of routes) {
        expectError(await call(buyer.bearer, IOS, method, path, body), 403, "FORBIDDEN");
        expectError(await shop.as(method, path, body), 403, "FORBIDDEN");
        const guest = http()[method](path).set("X-Client", ADMIN_WEB);
        expectError(await (body ? guest.send(body) : guest), 401, "AUTH_REQUIRED");
      }
      // Nothing moved.
      expect((await adminOrder(order.id)).status).toBe("created");
    });
  });

  // --------------------------------------------------------------- numbers

  describe("numbers: partly hidden everywhere, in full only by «Показать номер»", () => {
    it("never answers a person's full number on any admin route, and opens it with a journal entry without the number", async () => {
      const shop = await company("Номера");
      const offer = await put(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      await accept(shop, order.id);
      const missed = await place(buyer, offer);
      await accept(shop, missed.id);
      await noShow(missed.id);
      const leadPhone = "+77051230099";
      rememberCode(leadPhone);
      const lead = await ok(
        asAdmin("post", "/admin/supplier-leads", {
          companyName: "Звонок",
          bin: validBin("08123499000"),
          cityId: almaty,
          type: "goods",
          contactName: "Руслан",
          phone: leadPhone,
        }),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
        201,
      );
      const people = [buyer.phone, shop.phone, leadPhone];

      const paths = [
        "/admin/orders",
        `/admin/orders?q=${digitsOf(buyer.phone).slice(-5)}`,
        `/admin/orders/${order.id}`,
        `/admin/discipline?accountId=${buyer.accountId}`,
        "/admin/discipline/users",
        "/admin/users",
        `/admin/users/${buyer.accountId}`,
        `/admin/users/${buyer.accountId}/sessions`,
        `/admin/suppliers/${shop.supplierId}`,
        `/admin/suppliers/${shop.supplierId}/members`,
        "/admin/suppliers",
        "/admin/supplier-leads",
        `/admin/supplier-leads/${lead.lead.id}`,
        "/admin/club-access/grants?status=all",
        "/admin/audit-log?limit=100",
        `/admin/search?q=${digitsOf(buyer.phone).slice(-7)}`,
        `/admin/search?q=${digitsOf(shop.phone).slice(-7)}`,
        "/admin/signals",
        "/admin/home",
      ];
      for (const path of paths) {
        const response = await asAdmin("get", path);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
        const text = JSON.stringify(response.body);
        for (const phone of people) {
          expect(text, `${path} holds ${phone}`).not.toContain(digitsOf(phone));
          expect(text, `${path} holds ${phone}`).not.toContain(digitsOf(phone).slice(1));
        }
      }
      // The hidden forms are what the screens show.
      expect((await adminOrder(order.id)).customer.phone).toBe(hidePhone(buyer.phone));
      expect(lead.lead.phone).toBe(hidePhone(leadPhone));

      // «Показать номер» on each kind of object: the number in full, an entry in the journal.
      const reveals: [string, string, string, string][] = [
        ["account", buyer.accountId, buyer.phone, "account"],
        ["order", order.id, buyer.phone, "order"],
        ["supplier_member", shop.memberId, shop.phone, "supplier_member"],
        ["supplier_lead", lead.lead.id, leadPhone, "supplier_lead"],
      ];
      for (const [subject, id, phone, entityType] of reveals) {
        const opened = await ok(asAdmin("post", "/admin/phone-reveals", { subject, id }), (body) =>
          revealPhoneResponseSchema.parse(body),
        );
        expect(opened.phone).toBe(phone);
        const journal = await auditOf(
          `action=phone.revealed&entityType=${entityType}&entityId=${id}`,
        );
        expect(journal.entries).toHaveLength(1);
        expect(journal.entries[0]).toMatchObject({ actor: { role: "admin" }, after: { subject } });
      }
      const all = await auditOf("action=phone.revealed");
      for (const phone of people) {
        expect(JSON.stringify(all)).not.toContain(digitsOf(phone).slice(1));
      }
      // The user's and the company's histories both find an opening about them.
      expect(
        (await auditOf(`accountId=${buyer.accountId}&action=phone.revealed`)).entries,
      ).toHaveLength(2);
      expect(
        (await auditOf(`supplierId=${shop.supplierId}&action=phone.revealed`)).entries,
      ).toHaveLength(1);
      expectError(
        await asAdmin("post", "/admin/phone-reveals", { subject: "account", id: randomUUID() }),
        404,
        "NOT_FOUND",
      );
      // The limit per administrator.
      await settings.set({ phone_reveal_per_account: 4 });
      const limited = await asAdmin("post", "/admin/phone-reveals", {
        subject: "account",
        id: buyer.accountId,
      });
      expectError(limited, 429, "RATE_LIMITED");
      expect(rateLimitedDetailsSchema.parse(limited.body.details).limit).toBe(
        "phone_reveal_per_account",
      );
    });

    it("finds orders by number, «№ number» and a part of the customer's phone (A-ORD-01)", async () => {
      const shop = await company("Поиск заявок");
      const buyer = await customer();
      const order = await place(buyer, await put(shop));
      const by = async (q: string) =>
        (
          await ok(asAdmin("get", `/admin/orders?q=${encodeURIComponent(q)}`), (body) =>
            adminOrderPageSchema.parse(body),
          )
        ).orders.map((row) => row.id);
      expect(await by(String(order.number))).toEqual([order.id]);
      expect(await by(`№ ${String(order.number)}`)).toEqual([order.id]);
      expect(await by(digitsOf(buyer.phone).slice(-6))).toEqual([order.id]);
      expect(await by("9999999")).toEqual([]);
      const byUser = await ok(
        asAdmin("get", `/admin/orders?accountId=${buyer.accountId}`),
        (body) => adminOrderPageSchema.parse(body),
      );
      expect(byUser.total).toBe(1);
      const byCity = await ok(asAdmin("get", `/admin/orders?cityId=${almaty}`), (body) =>
        adminOrderPageSchema.parse(body),
      );
      expect(byCity.total).toBe(1);
      const otherCity = await ok(asAdmin("get", `/admin/orders?cityId=${randomUUID()}`), (body) =>
        adminOrderPageSchema.parse(body),
      );
      expect(otherCity.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------- search

  describe("the header's search (A-SEARCH)", () => {
    it("reads a number, a phone, a БИН, an article and a text, in groups, with its limit", async () => {
      const shop = await company("Автомаркет Поиск");
      const buyer = await customer();
      const order = await place(buyer, await put(shop));
      await ok(
        asAdmin("post", "/admin/supplier-leads", {
          companyName: "Тот же БИН",
          bin: shop.bin,
          cityId: almaty,
          type: "goods",
          contactName: "Марат",
          phone: "+77059990011",
        }),
        (body) => body,
        201,
      );
      const search = async (q: string) =>
        ok(asAdmin("get", `/admin/search?q=${encodeURIComponent(q)}`), (body) =>
          adminSearchResponseSchema.parse(body),
        );

      const byNumber = await search(String(order.number));
      expect(byNumber.reading.orderNumber).toBe(order.number);
      expect(byNumber.orders[0]).toMatchObject({ id: order.id, supplierName: shop.name });
      expect((await search(`№ ${String(order.number)}`)).orders.map((row) => row.id)).toEqual([
        order.id,
      ]);

      const byPhone = await search(digitsOf(buyer.phone).slice(-7));
      expect(byPhone.users).toEqual([
        { accountId: buyer.accountId, name: TEST_CUSTOMER_NAME, phone: hidePhone(buyer.phone) },
      ]);
      expect(byPhone.orders.map((row) => row.id)).toEqual([order.id]);
      const byEmployee = await search(digitsOf(shop.phone).slice(-7));
      expect(byEmployee.members).toEqual([
        expect.objectContaining({
          memberId: shop.memberId,
          supplierName: shop.name,
          phone: hidePhone(shop.phone),
        }),
      ]);

      const byBin = await search(shop.bin);
      expect(byBin.reading.bin).toBe(shop.bin);
      expect(byBin.suppliers.map((row) => row.id)).toEqual([shop.supplierId]);
      expect(byBin.leads.map((row) => row.companyName)).toEqual(["Тот же БИН"]);

      const byArticle = await search("04465 0k090");
      expect(byArticle.reading.article).toBe("044650K090");
      expect(byArticle.items.map((row) => row.id)).toContain(padsId);

      const byText = await search("автомаркет");
      expect(byText.suppliers.map((row) => row.id)).toEqual([shop.supplierId]);
      expect((await search("Тест")).users.map((row) => row.accountId)).toContain(buyer.accountId);

      const nothing = await search("Нетакогоничего");
      expect([
        nothing.orders,
        nothing.users,
        nothing.members,
        nothing.suppliers,
        nothing.leads,
        nothing.items,
      ]).toEqual([[], [], [], [], [], []]);

      await settings.set({ admin_search_per_account: 2 });
      await redis.flushall();
      await search("один");
      await search("два");
      const limited = await asAdmin("get", "/admin/search?q=three");
      expectError(limited, 429, "RATE_LIMITED");
      expect(rateLimitedDetailsSchema.parse(limited.body.details).limit).toBe(
        "admin_search_per_account",
      );
    });
  });

  // --------------------------------------------------------------- journal

  describe("the journal names objects by their names now (A-AUD)", () => {
    it("names a company, an employee, a request, an order, an item and the ids its entries refer to", async () => {
      const shop = await company("Старое имя");
      const card = await ok(
        asAdmin("get", `/admin/suppliers/${shop.supplierId}`),
        (body) => adminSupplierResponseSchema.parse(body).supplier,
      );
      await ok(
        asAdmin("patch", `/admin/suppliers/${shop.supplierId}`, {
          expectedVersion: card.version,
          name: "Новое имя",
        }),
        (body) => body,
      );
      const history = await auditOf(`supplierId=${shop.supplierId}`);
      const created = history.entries.find((entry) => entry.action === "supplier.created")!;
      // The company by its name now, the city it refers to — by name.
      expect(created.entityName).toBe("Новое имя");
      expect(created.names[almaty]).toBe("Алматы");
      const member = history.entries.find((entry) => entry.action === "supplier_member.added")!;
      expect(member.entityName).toBe("Айгерим");

      const lead = await ok(
        asAdmin("post", "/admin/supplier-leads", {
          companyName: "Заявка с именем",
          bin: validBin("08123477000"),
          cityId: almaty,
          type: "goods",
          contactName: "Руслан",
          phone: "+77051230088",
        }),
        (body) => adminSupplierLeadResponseSchema.parse(body).lead,
        201,
      );
      const leadEntries = await auditOf(`entityType=supplier_lead&entityId=${lead.lead.id}`);
      expect(leadEntries.entries[0]!.entityName).toBe("Заявка с именем");

      const buyer = await customer();
      const order = await place(buyer, await put(shop));
      await ok(
        asAdmin("post", `/admin/orders/${order.id}/cancel`, {
          expectedVersion: 1,
          reason: "Для журнала",
        }),
        (body) => body,
      );
      const orderEntries = await auditOf(`entityType=order&entityId=${order.id}`);
      expect(orderEntries.entries[0]!.entityName).toBe(`№ ${String(order.number)}`);

      const item = await ok(
        asAdmin("get", `/admin/catalog/items/${padsId}`),
        (body) =>
          body as {
            item: { version: number; names: { ru: { text: string } | null } };
          },
      );
      await ok(
        asAdmin("patch", `/admin/catalog/items/${padsId}`, {
          expectedVersion: item.item.version,
          names: { ru: "Колодки для журнала" },
        }),
        (body) => body,
      );
      const itemEntries = await auditOf(`itemId=${padsId}`);
      expect(itemEntries.entries[0]!.entityName).toBe("Колодки для журнала");

      // An object the journal can't find any more is not named — and nothing breaks.
      await db.query(
        `INSERT INTO audit_log (action, actor_role, entity_type, entity_id, after)
         VALUES ('supplier.changed', 'operator', 'supplier', $1, '{"cityId":"${randomUUID()}"}')`,
        [randomUUID()],
      );
      const gone = await auditOf("entityType=supplier&action=supplier.changed&limit=1");
      expect(gone.entries[0]).toMatchObject({ entityName: null, names: {} });
    });
  });
});
