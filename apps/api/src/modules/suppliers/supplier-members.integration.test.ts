import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminSupplierMemberAddedResponseSchema,
  adminSupplierMemberListResponseSchema,
  adminSupplierMemberResponseSchema,
  adminSupplierResponseSchema,
  adminSupplierSessionListResponseSchema,
  apiErrorResponseSchema,
  supplierCardResponseSchema,
  supplierCompanyResponseSchema,
  supplierMemberAddedResponseSchema,
  supplierMemberExistsDetailsSchema,
  supplierMemberListResponseSchema,
  supplierMemberRemovedResponseSchema,
  supplierMemberResponseSchema,
  supplierNotificationLimitDetailsSchema,
  supplierOnboardedResponseSchema,
  supplierSessionsEndedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
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
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { InvitationSender, SupplierMessages, type TestSupplierMessages } from ".";

/**
 * TASK-017 end to end on a real PostgreSQL and Redis with a real worker
 * (invitations): employees in the cabinet — the list, adding (and the
 * refusals), removing with the sessions in the same transaction, the last
 * employee under concurrency, removing oneself; the notification limit
 * under concurrency and a lowered setting; «Мои настройки»; the
 * administrator's list, restore, contact person, invitations and
 * sessions; the card by S-COMP-01 and saving without a change;
 * invitations never sent to a removed employee; the access matrix; the
 * action journal and a clean log.
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

const nineToSix: DayHours["intervals"] = [
  { from: "09:00", to: "13:00" },
  { from: "14:00", to: "18:00" },
];
const WEEK: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: day === 7 ? [] : nineToSix,
}));

/** A phone number of the series used here: `+7705` and seven digits. */
const phoneOf = (n: number) => `+7705${String(n).padStart(7, "0")}`;

describe("employees of a supplier (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
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
  let binCounter = 0;
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
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
        break;
      } catch (error) {
        if (attempt >= 10) {
          throw error;
        }
        await sleep(200);
      }
    }
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
  });

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

  /** Signs in; the refresh cookie of a web client comes back as `cookie`. */
  async function signIn(
    phone: string,
    client: string,
  ): Promise<{ response: Response; cookie: string | undefined }> {
    // Only whole numbers are looked for in the log.
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
    let cookie: string | undefined;
    for (const header of ([] as string[]).concat(response.headers["set-cookie"] ?? [])) {
      const step = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(header);
      if (step) {
        rememberSecret(step[2]!);
        stepCookies.set(step[1]!, `adclub_sign_in_${step[1]}=${step[2]}`);
      }
      const refresh = /^(adclub_(?:admin|supplier)_refresh)=([^;]+)/.exec(header);
      if (refresh) {
        rememberSecret(refresh[2]!);
        cookie = `${refresh[1]}=${refresh[2]}`;
      }
    }
    return { response, cookie };
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
    const { response: start } = await signIn(phone, ADMIN_WEB);
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

  async function mobileToken(): Promise<string> {
    const { response } = await signIn(USER_PHONE, IOS);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  /** A cabinet session of the number (it must work for exactly one company). */
  async function cabinet(phone: string): Promise<{ token: string; cookie: string }> {
    const { response, cookie } = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      token: (response.body as { session: { accessToken: string } }).session.accessToken,
      cookie: cookie!,
    };
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

  function refreshWith(cookie: string): Test {
    return http()
      .post("/auth/session/refresh")
      .set("X-Client", SUPPLIER_WEB)
      .set("Origin", config.http.webOrigins.supplierWeb[0]!)
      .set("Cookie", cookie)
      .send({});
  }

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

  /** A supplier with its first employee (the contact person, notifications on). */
  async function supplierWith(firstPhone: string, name = "Автомаркет") {
    rememberCode(firstPhone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId,
        type: "goods",
        address: "пр. Абая, 10",
        district: "Бостандыкский район",
        firstMember: { name: "Айгерим", phone: firstPhone },
      }),
      (body) => supplierOnboardedResponseSchema.parse(body),
      201,
    );
    return { supplierId: created.supplier.id, memberId: created.firstMember.memberId };
  }

  async function addColleague(bearer: string, phone: string, name: string) {
    rememberCode(phone);
    return ok(
      asSupplier(bearer, "post", "/supplier/members", { name, phone }),
      (body) => supplierMemberAddedResponseSchema.parse(body),
      201,
    );
  }

  async function journal(entityId: string) {
    const { rows } = await db.query<{
      action: string;
      actor_role: string;
      actor_member_id: string | null;
      reason: string | null;
    }>(
      "SELECT action, actor_role, actor_member_id, reason FROM audit_log WHERE entity_id = $1 ORDER BY created_at, id",
      [entityId],
    );
    return rows;
  }

  async function activeMembers(supplierId: string): Promise<number> {
    return count("supplier_member", "supplier_id = $1 AND status = 'active'", [supplierId]);
  }

  // ------------------------------------------------------------ the cabinet

  describe("employees in the cabinet", () => {
    it("adds a colleague who gets the invitation and signs in to the same company", async () => {
      const first = phoneOf(1);
      const { supplierId, memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const listed = await ok(asSupplier(me.token, "get", "/supplier/members"), (body) =>
        supplierMemberListResponseSchema.parse(body),
      );
      expect(listed.members).toEqual([
        expect.objectContaining({
          id: memberId,
          phone: first,
          isMe: true,
          isContactPerson: true,
          notificationsEnabled: true,
          receivesNotifications: true,
          notificationLanguage: "ru",
        }),
      ]);

      const colleague = phoneOf(2);
      const added = await addColleague(me.token, "+7 705 000 00 02", "Марат");
      expect(added.member).toMatchObject({
        phone: colleague,
        displayName: "Марат",
        isMe: false,
        isContactPerson: false,
        notificationsEnabled: true,
      });
      expect(added.invitation.status).toBe("queued");
      const sent = await waitFor("the invitation", () =>
        Promise.resolve(messages.sent.find((message) => message.phone === colleague)),
      );
      expect(sent.text).toContain("Марат, вас добавили в кабинет поставщика «Автомаркет»");

      const theirs = await cabinet(colleague);
      const company = await ok(asSupplier(theirs.token, "get", "/supplier/company"), (body) =>
        supplierCompanyResponseSchema.parse(body),
      );
      expect(company.company.id).toBe(supplierId);

      const entries = await journal(added.member.id);
      expect(entries[0]).toMatchObject({
        action: "supplier_member.added",
        actor_role: "supplier",
        actor_member_id: memberId,
      });
      const { rows } = await db.query<{ added_by: string; added_by_member_id: string }>(
        "SELECT added_by, added_by_member_id FROM supplier_member WHERE id = $1",
        [added.member.id],
      );
      expect(rows[0]).toEqual({ added_by: "member", added_by_member_id: memberId });
    });

    it("refuses a number already in the company and a removed one; takes one of another company or an administrator", async () => {
      const first = phoneOf(11);
      const { supplierId } = await supplierWith(first);
      const me = await cabinet(first);
      const same = await asSupplier(me.token, "post", "/supplier/members", {
        name: "Снова я",
        phone: first,
      });
      expectError(same, 409, "SUPPLIER_MEMBER_EXISTS");
      expect(supplierMemberExistsDetailsSchema.parse(same.body.details).status).toBe("active");

      const leaving = await addColleague(me.token, phoneOf(12), "Ушедший");
      await ok(asSupplier(me.token, "delete", `/supplier/members/${leaving.member.id}`), (body) =>
        supplierMemberRemovedResponseSchema.parse(body),
      );
      const again = await asSupplier(me.token, "post", "/supplier/members", {
        name: "Ушедший",
        phone: phoneOf(12),
      });
      expectError(again, 409, "SUPPLIER_MEMBER_EXISTS");
      expect(supplierMemberExistsDetailsSchema.parse(again.body.details)).toEqual({
        memberId: leaving.member.id,
        status: "removed",
      });
      expect(again.body.message).toContain("only an administrator");

      // A number working for another company, an administrator's number: both
      // are simply added — and the answer tells the supplier nothing about it.
      const other = phoneOf(13);
      await supplierWith(other, "Шиномонтаж 24");
      const fromOther = await addColleague(me.token, other, "Из другой компании");
      expect(Object.keys(fromOther)).toEqual(["member", "notifications", "invitation"]);
      await addColleague(me.token, ADMIN_PHONE, "Администратор клуба");
      expect(await activeMembers(supplierId)).toBe(3);
      // Neither an invalid number nor an empty name.
      expectError(
        await asSupplier(me.token, "post", "/supplier/members", { name: "Х", phone: "+7 495 1" }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asSupplier(me.token, "post", "/supplier/members", { name: " ", phone: phoneOf(19) }),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("limits how many employees one company adds a day", async () => {
      await settings.set({ supplier_members_added_per_supplier_day: 2 });
      const first = phoneOf(21);
      await supplierWith(first);
      const me = await cabinet(first);
      await addColleague(me.token, phoneOf(22), "Один");
      await addColleague(me.token, phoneOf(23), "Два");
      rememberCode(phoneOf(24));
      const refused = await asSupplier(me.token, "post", "/supplier/members", {
        name: "Три",
        phone: phoneOf(24),
      });
      expectError(refused, 429, "RATE_LIMITED");
      expect(refused.body.details.limit).toBe("supplier_members_added_per_supplier");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(80_000);
      // The administrator isn't limited.
      await ok(
        asAdmin("post", `/admin/suppliers/${await companyOf(first)}/members`, {
          name: "Три",
          phone: phoneOf(24),
        }),
        (body) => adminSupplierMemberAddedResponseSchema.parse(body),
        201,
      );
    });

    it("removes a colleague: every session of theirs ends in the same transaction, refresh too", async () => {
      const first = phoneOf(31);
      const { supplierId } = await supplierWith(first);
      const me = await cabinet(first);
      const colleague = phoneOf(32);
      const added = await addColleague(me.token, colleague, "Марат");
      // Their cabinet is open in two browsers, and they use the phone app too.
      const browserA = await cabinet(colleague);
      const browserB = await cabinet(colleague);
      const { response: mobile } = await signIn(colleague, IOS);
      const mobileAccess = (mobile.body as { session: { accessToken: string } }).session
        .accessToken;
      expect((await asSupplier(browserA.token, "get", "/supplier/company")).status).toBe(200);

      const removed = await ok(
        asSupplier(me.token, "delete", `/supplier/members/${added.member.id}`),
        (body) => supplierMemberRemovedResponseSchema.parse(body),
      );
      expect(removed).toEqual({ memberId: added.member.id, sessionsEnded: 2, self: false });
      expect(
        await count("session", "supplier_member_id = $1 AND revoked_reason = 'access_closed'", [
          added.member.id,
        ]),
      ).toBe(2);
      for (const browser of [browserA, browserB]) {
        expectError(
          await asSupplier(browser.token, "get", "/supplier/company"),
          401,
          "SUPPLIER_ACCESS_CLOSED",
        );
        expectError(await refreshWith(browser.cookie), 401, "SUPPLIER_ACCESS_CLOSED");
      }
      // The phone app is another role of the same person: untouched.
      expect((await call(mobileAccess, IOS, "get", "/auth/me")).status).toBe(200);
      const listed = await ok(asSupplier(me.token, "get", "/supplier/members"), (body) =>
        supplierMemberListResponseSchema.parse(body),
      );
      expect(listed.members.map((member) => member.phone)).toEqual([first]);
      expect(await activeMembers(supplierId)).toBe(1);
      const entries = await journal(added.member.id);
      expect(entries.at(-1)).toMatchObject({
        action: "supplier_member.removed",
        actor_role: "supplier",
      });
    });

    it("never removes the last employee; removing oneself ends one's own session", async () => {
      const first = phoneOf(41);
      const { memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const alone = await asSupplier(me.token, "delete", `/supplier/members/${memberId}`);
      expectError(alone, 409, "SUPPLIER_LAST_MEMBER");
      expect(
        await count("session", "supplier_member_id = $1 AND revoked_at IS NULL", [memberId]),
      ).toBe(1);

      const colleague = phoneOf(42);
      const added = await addColleague(me.token, colleague, "Марат");
      const theirs = await cabinet(colleague);
      const self = await ok(
        asSupplier(me.token, "delete", `/supplier/members/${memberId}`),
        (body) => supplierMemberRemovedResponseSchema.parse(body),
      );
      expect(self).toEqual({ memberId, sessionsEnded: 1, self: true });
      expectError(
        await asSupplier(me.token, "get", "/supplier/members"),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
      // Now the colleague is the last one.
      expectError(
        await asSupplier(theirs.token, "delete", `/supplier/members/${added.member.id}`),
        409,
        "SUPPLIER_LAST_MEMBER",
      );
    });

    it("leaves exactly one employee when the last two remove each other at once", async () => {
      for (let round = 0; round < 4; round++) {
        const firstPhone = phoneOf(500 + round * 2);
        const secondPhone = phoneOf(501 + round * 2);
        const { supplierId, memberId: firstId } = await supplierWith(
          firstPhone,
          `Компания ${round}`,
        );
        const first = await cabinet(firstPhone);
        const added = await addColleague(first.token, secondPhone, "Второй");
        const second = await cabinet(secondPhone);
        const [a, b] = await Promise.all([
          asSupplier(first.token, "delete", `/supplier/members/${added.member.id}`),
          asSupplier(second.token, "delete", `/supplier/members/${firstId}`),
        ]);
        const statuses = [a.status, b.status].sort();
        // One removal wins; the other is refused as the last one — or, when
        // the winner removed the caller, the caller's session is already over.
        expect(statuses[0]).toBe(200);
        expect([401, 409]).toContain(statuses[1]);
        expect(await activeMembers(supplierId)).toBe(1);
      }
    });

    it("sees and changes only its own company's employees", async () => {
      const first = phoneOf(61);
      await supplierWith(first);
      const me = await cabinet(first);
      const other = await supplierWith(phoneOf(62), "Чужая компания");
      expectError(
        await asSupplier(me.token, "patch", `/supplier/members/${other.memberId}`, {
          displayName: "Взлом",
        }),
        404,
        "NOT_FOUND",
      );
      expectError(
        await asSupplier(me.token, "delete", `/supplier/members/${other.memberId}`),
        404,
        "NOT_FOUND",
      );
      const { rows } = await db.query<{ display_name: string; status: string }>(
        "SELECT display_name, status FROM supplier_member WHERE id = $1",
        [other.memberId],
      );
      expect(rows[0]).toEqual({ display_name: "Айгерим", status: "active" });
    });
  });

  async function companyOf(phone: string): Promise<string> {
    const { rows } = await db.query<{ supplier_id: string }>(
      "SELECT m.supplier_id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 ORDER BY m.created_at LIMIT 1",
      [phone],
    );
    return rows[0]!.supplier_id;
  }

  // ---------------------------------------------------------- notifications

  describe("the notification limit", () => {
    it("lets no more than max_notified_members turn notifications on", async () => {
      const first = phoneOf(71);
      await supplierWith(first);
      const me = await cabinet(first);
      // The first employee has them on; four more fit the default limit of five.
      const colleagues: Awaited<ReturnType<typeof addColleague>>[] = [];
      for (let n = 2; n <= 6; n++) {
        colleagues.push(await addColleague(me.token, phoneOf(70 + n), `Сотрудник ${n}`));
      }
      expect(colleagues.slice(0, 4).every((c) => c.member.notificationsEnabled)).toBe(true);
      const sixth = colleagues[4]!;
      expect(sixth.member.notificationsEnabled).toBe(false);
      expect(sixth.notifications).toEqual({ limit: 5, enabled: 5, recipients: 5, full: true });
      const refused = await asSupplier(me.token, "patch", `/supplier/members/${sixth.member.id}`, {
        notificationsEnabled: true,
      });
      expectError(refused, 409, "SUPPLIER_NOTIFICATION_LIMIT");
      expect(supplierNotificationLimitDetailsSchema.parse(refused.body.details)).toEqual({
        limit: 5,
        enabled: 5,
      });
      expect(refused.body.message).toContain("5");
      // Someone turns theirs off — the sixth may turn it on.
      await ok(
        asSupplier(me.token, "patch", `/supplier/members/${colleagues[0]!.member.id}`, {
          notificationsEnabled: false,
        }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      const on = await ok(
        asSupplier(me.token, "patch", `/supplier/members/${sixth.member.id}`, {
          notificationsEnabled: true,
          notificationLanguage: "kk",
        }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      expect(on.member).toMatchObject({
        notificationsEnabled: true,
        receivesNotifications: true,
        notificationLanguage: "kk",
      });
      const entries = await journal(sixth.member.id);
      expect(entries.at(-1)).toMatchObject({
        action: "supplier_member.changed",
        actor_role: "supplier",
      });
    });

    it("gives the last place to exactly one of two employees turning it on at once", async () => {
      await settings.set({ max_notified_members: 2 });
      const first = phoneOf(81);
      const { supplierId } = await supplierWith(first);
      const me = await cabinet(first);
      const a = await addColleague(me.token, phoneOf(82), "А");
      await ok(
        asSupplier(me.token, "patch", `/supplier/members/${a.member.id}`, {
          notificationsEnabled: false,
        }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      const b = await addColleague(me.token, phoneOf(83), "Б");
      expect(b.member.notificationsEnabled).toBe(true);
      await ok(
        asSupplier(me.token, "patch", `/supplier/members/${b.member.id}`, {
          notificationsEnabled: false,
        }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      // One place left, two sessions take it at once.
      const theirsA = await cabinet(phoneOf(82));
      const theirsB = await cabinet(phoneOf(83));
      const results = await Promise.all([
        asSupplier(theirsA.token, "patch", "/supplier/me", { notificationsEnabled: true }),
        asSupplier(theirsB.token, "patch", "/supplier/me", { notificationsEnabled: true }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await count(
          "supplier_member",
          "supplier_id = $1 AND status = 'active' AND notifications_enabled_at IS NOT NULL",
          [supplierId],
        ),
      ).toBe(2);
    });

    it("keeps the earliest to turn it on as recipients when the limit is lowered, turning no switch off", async () => {
      const first = phoneOf(91);
      const { supplierId, memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const added: Awaited<ReturnType<typeof addColleague>>[] = [];
      for (let n = 2; n <= 4; n++) {
        added.push(await addColleague(me.token, phoneOf(90 + n), `Сотрудник ${n}`));
        await sleep(5);
      }
      await settings.set({ max_notified_members: 2 });
      const listed = await ok(asSupplier(me.token, "get", "/supplier/members"), (body) =>
        supplierMemberListResponseSchema.parse(body),
      );
      expect(listed.notifications).toEqual({ limit: 2, enabled: 4, recipients: 2, full: true });
      const byId = new Map(listed.members.map((member) => [member.id, member]));
      expect(byId.get(memberId)).toMatchObject({
        notificationsEnabled: true,
        receivesNotifications: true,
      });
      expect(byId.get(added[0]!.member.id)).toMatchObject({ receivesNotifications: true });
      for (const late of added.slice(1)) {
        expect(byId.get(late.member.id)).toMatchObject({
          notificationsEnabled: true,
          receivesNotifications: false,
        });
      }
      // The same in the admin panel.
      const admin = await ok(asAdmin("get", `/admin/suppliers/${supplierId}/members`), (body) =>
        adminSupplierMemberListResponseSchema.parse(body),
      );
      expect(admin.members.filter((member) => member.receivesNotifications)).toHaveLength(2);
      // An earlier recipient turning theirs off makes room for the next in line.
      await ok(
        asSupplier(me.token, "patch", "/supplier/me", { notificationsEnabled: false }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      const after = await ok(asSupplier(me.token, "get", "/supplier/members"), (body) =>
        supplierMemberListResponseSchema.parse(body),
      );
      expect(after.members.find((m) => m.id === added[1]!.member.id)!.receivesNotifications).toBe(
        true,
      );
      // Turning on again is refused while three have it on and the limit is two.
      expectError(
        await asSupplier(me.token, "patch", "/supplier/me", { notificationsEnabled: true }),
        409,
        "SUPPLIER_NOTIFICATION_LIMIT",
      );
    });
  });

  // ------------------------------------------------------------ my settings

  describe("«Мои настройки»", () => {
    it("shows and changes one's own name, notifications and their language", async () => {
      const first = phoneOf(101);
      const { memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const mine = await ok(asSupplier(me.token, "get", "/supplier/me"), (body) =>
        supplierMemberResponseSchema.parse(body),
      );
      expect(mine.member).toMatchObject({
        id: memberId,
        phone: first,
        isMe: true,
        notificationLanguage: "ru",
      });
      const changed = await ok(
        asSupplier(me.token, "patch", "/supplier/me", {
          displayName: "  Айгерим Н. ",
          notificationLanguage: "kk",
          notificationsEnabled: false,
        }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      expect(changed.member).toMatchObject({
        displayName: "Айгерим Н.",
        notificationLanguage: "kk",
        notificationsEnabled: false,
        receivesNotifications: false,
      });
      expectError(await asSupplier(me.token, "patch", "/supplier/me", {}), 400, "VALIDATION_ERROR");
      expectError(
        await asSupplier(me.token, "patch", "/supplier/me", { notificationLanguage: "en" }),
        400,
        "VALIDATION_ERROR",
      );
      // A colleague may rename me too — all employees are equal.
      const colleague = phoneOf(102);
      await addColleague(me.token, colleague, "Марат");
      const theirs = await cabinet(colleague);
      await ok(
        asSupplier(theirs.token, "patch", `/supplier/members/${memberId}`, {
          displayName: "Айгерим",
        }),
        (body) => supplierMemberResponseSchema.parse(body),
      );
      const entries = await journal(memberId);
      expect(entries.filter((e) => e.action === "supplier_member.changed")).toHaveLength(2);
      // Saving the same again writes nothing.
      await ok(asSupplier(me.token, "patch", "/supplier/me", { displayName: "Айгерим" }), (body) =>
        supplierMemberResponseSchema.parse(body),
      );
      expect(
        (await journal(memberId)).filter((e) => e.action === "supplier_member.changed"),
      ).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------- administrator

  describe("the administrator", () => {
    it("lists current and removed employees and restores one with the reason; old sessions stay ended", async () => {
      const first = phoneOf(111);
      const { supplierId, memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const colleague = phoneOf(112);
      const added = await addColleague(me.token, colleague, "Марат");
      const old = await cabinet(colleague);
      await ok(asSupplier(me.token, "delete", `/supplier/members/${added.member.id}`), (body) =>
        supplierMemberRemovedResponseSchema.parse(body),
      );
      const listed = await ok(asAdmin("get", `/admin/suppliers/${supplierId}/members`), (body) =>
        adminSupplierMemberListResponseSchema.parse(body),
      );
      expect(listed.members.map((m) => [m.id, m.status])).toEqual([
        [memberId, "active"],
        [added.member.id, "removed"],
      ]);
      const removed = listed.members[1]!;
      expect(removed).toMatchObject({
        addedBy: "member",
        addedByMember: { id: memberId, displayName: "Айгерим" },
        removedByMember: { id: memberId, displayName: "Айгерим" },
        notificationsEnabled: false,
        restore: null,
      });
      expect(removed.removedAt).not.toBeNull();
      expect(listed.members[0]).toMatchObject({ addedBy: "admin", isContactPerson: true });
      // The admin card lists the same.
      const card = await ok(asAdmin("get", `/admin/suppliers/${supplierId}`), (body) =>
        adminSupplierResponseSchema.parse(body),
      );
      expect(card.supplier.members.map((m) => m.status)).toEqual(["active", "removed"]);

      expectError(
        await asAdmin(
          "post",
          `/admin/suppliers/${supplierId}/members/${added.member.id}/restore`,
          {},
        ),
        400,
        "VALIDATION_ERROR",
      );
      const restored = await ok(
        asAdmin("post", `/admin/suppliers/${supplierId}/members/${added.member.id}/restore`, {
          reason: "Удалён по ошибке, обращение директора",
        }),
        (body) => adminSupplierMemberResponseSchema.parse(body),
      );
      expect(restored.member).toMatchObject({
        status: "active",
        removedAt: null,
        notificationsEnabled: true,
        restore: { reason: "Удалён по ошибке, обращение директора" },
      });
      expectError(
        await asAdmin("post", `/admin/suppliers/${supplierId}/members/${added.member.id}/restore`, {
          reason: "Ещё раз",
        }),
        409,
        "SUPPLIER_MEMBER_STATE",
      );
      // The old session doesn't come back; a new sign-in works.
      expectError(
        await asSupplier(old.token, "get", "/supplier/company"),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
      expectError(await refreshWith(old.cookie), 401, "SUPPLIER_ACCESS_CLOSED");
      const fresh = await cabinet(colleague);
      expect((await asSupplier(fresh.token, "get", "/supplier/company")).status).toBe(200);
      const entries = await journal(added.member.id);
      expect(entries.find((e) => e.action === "supplier_member.restored")).toMatchObject({
        actor_role: "admin",
        reason: "Удалён по ошибке, обращение директора",
      });
      // Resending the invitation to the restored employee (after the interval):
      // the new one goes out.
      await db.query(
        "UPDATE supplier_invitation SET created_at = created_at - interval '10 minutes' WHERE member_id = $1",
        [added.member.id],
      );
      messages.sent.length = 0;
      const resent = await asAdmin(
        "post",
        `/admin/suppliers/${supplierId}/members/${added.member.id}/invitations`,
      );
      expect(resent.status, JSON.stringify(resent.body)).toBe(202);
      await waitFor("the new invitation", () =>
        Promise.resolve(messages.sent.find((message) => message.phone === colleague)),
      );
    });

    it("adds an employee, appoints the contact person (one per company)", async () => {
      const first = phoneOf(121);
      const { supplierId, memberId } = await supplierWith(first);
      const second = phoneOf(122);
      rememberCode(second);
      const added = await ok(
        asAdmin("post", `/admin/suppliers/${supplierId}/members`, { name: "Марат", phone: second }),
        (body) => adminSupplierMemberAddedResponseSchema.parse(body),
        201,
      );
      expect(added).toMatchObject({
        accountCreated: true,
        memberOfOtherSuppliers: 0,
        isAdministrator: false,
        member: { addedBy: "admin", isContactPerson: false },
      });
      expectError(
        await asAdmin("post", `/admin/suppliers/${supplierId}/members`, {
          name: "Марат",
          phone: second,
        }),
        409,
        "SUPPLIER_MEMBER_EXISTS",
      );
      const appointed = await ok(
        asAdmin("post", `/admin/suppliers/${supplierId}/members/${added.member.id}/contact-person`),
        (body) => adminSupplierMemberResponseSchema.parse(body),
      );
      expect(appointed.member.isContactPerson).toBe(true);
      const listed = await ok(asAdmin("get", `/admin/suppliers/${supplierId}/members`), (body) =>
        adminSupplierMemberListResponseSchema.parse(body),
      );
      expect(listed.members.filter((m) => m.isContactPerson).map((m) => m.id)).toEqual([
        added.member.id,
      ]);
      expect((await journal(added.member.id)).map((e) => e.action)).toContain(
        "supplier_member.contact_person_changed",
      );
      // A removed employee can't be appointed; removing the contact person leaves none.
      const me = await cabinet(first);
      await ok(asSupplier(me.token, "delete", `/supplier/members/${added.member.id}`), (body) =>
        supplierMemberRemovedResponseSchema.parse(body),
      );
      expectError(
        await asAdmin(
          "post",
          `/admin/suppliers/${supplierId}/members/${added.member.id}/contact-person`,
        ),
        409,
        "SUPPLIER_MEMBER_STATE",
      );
      expect(
        await count("supplier_member", "supplier_id = $1 AND is_contact_person", [supplierId]),
      ).toBe(0);
      await ok(
        asAdmin("post", `/admin/suppliers/${supplierId}/members/${memberId}/contact-person`),
        (body) => adminSupplierMemberResponseSchema.parse(body),
      );
      expectError(
        await asAdmin("post", `/admin/suppliers/00000000-0000-4000-8000-000000000000/members`, {
          name: "Х",
          phone: phoneOf(129),
        }),
        404,
        "NOT_FOUND",
      );
    });

    it("sees the employees' cabinet sessions without tokens and ends one or all", async () => {
      const first = phoneOf(131);
      const { supplierId, memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const colleague = phoneOf(132);
      const added = await addColleague(me.token, colleague, "Марат");
      const theirsA = await cabinet(colleague);
      const theirsB = await cabinet(colleague);
      const response = await asAdmin("get", `/admin/suppliers/${supplierId}/sessions`);
      const listed = adminSupplierSessionListResponseSchema.parse(response.body);
      expect(listed.sessions).toHaveLength(3);
      expect(JSON.stringify(response.body)).not.toMatch(/token|seed|refresh/i);
      expect(listed.sessions.filter((s) => s.member.id === added.member.id)).toHaveLength(2);

      // End one.
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM session WHERE supplier_member_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1",
        [added.member.id],
      );
      const ended = await ok(
        asAdmin("post", `/admin/suppliers/${supplierId}/sessions/${rows[0]!.id}/end`),
        (body) => supplierSessionsEndedResponseSchema.parse(body),
      );
      expect(ended.ended).toBe(1);
      expectError(
        await asSupplier(theirsA.token, "get", "/supplier/company"),
        401,
        "SESSION_ENDED",
      );
      expect((await asSupplier(theirsB.token, "get", "/supplier/company")).status).toBe(200);
      // Again — nothing to end: 404; another company's session — 404 too.
      expectError(
        await asAdmin("post", `/admin/suppliers/${supplierId}/sessions/${rows[0]!.id}/end`),
        404,
        "NOT_FOUND",
      );
      const other = await supplierWith(phoneOf(133), "Чужая компания");
      const otherSession = await cabinet(phoneOf(133));
      const { rows: otherRows } = await db.query<{ id: string }>(
        "SELECT id FROM session WHERE supplier_member_id = $1",
        [other.memberId],
      );
      expectError(
        await asAdmin("post", `/admin/suppliers/${supplierId}/sessions/${otherRows[0]!.id}/end`),
        404,
        "NOT_FOUND",
      );
      expect((await asSupplier(otherSession.token, "get", "/supplier/company")).status).toBe(200);

      // All of one employee, then all of the company.
      await ok(
        asAdmin("post", `/admin/suppliers/${supplierId}/sessions/end`, {
          memberId: added.member.id,
        }),
        (body) => expect(supplierSessionsEndedResponseSchema.parse(body).ended).toBe(1),
      );
      expectError(
        await asSupplier(theirsB.token, "get", "/supplier/company"),
        401,
        "SESSION_ENDED",
      );
      expect((await asSupplier(me.token, "get", "/supplier/company")).status).toBe(200);
      await ok(asAdmin("post", `/admin/suppliers/${supplierId}/sessions/end`, {}), (body) =>
        expect(supplierSessionsEndedResponseSchema.parse(body).ended).toBe(1),
      );
      expectError(await asSupplier(me.token, "get", "/supplier/company"), 401, "SESSION_ENDED");
      // The membership stays: a new sign-in works.
      expect(
        (await asSupplier((await cabinet(first)).token, "get", "/supplier/members")).status,
      ).toBe(200);
      const entries = await journal(memberId);
      expect(entries.find((e) => e.action === "supplier_member.sessions_ended")).toMatchObject({
        actor_role: "admin",
      });
    });
  });

  // ------------------------------------------------------------- the card

  describe("the card in the cabinet (S-COMP-01)", () => {
    it("changes the address, district and phone; not the name, БИН or city; saving the same changes nothing", async () => {
      const first = phoneOf(141);
      const { supplierId } = await supplierWith(first);
      const me = await cabinet(first);
      const before = await ok(
        asSupplier(me.token, "get", "/supplier/company"),
        (body) => supplierCompanyResponseSchema.parse(body).company,
      );
      rememberCode("+77059998877");
      const changed = await ok(
        asSupplier(me.token, "patch", "/supplier/company", {
          expectedVersion: before.version,
          address: "ул. Райымбека, 200",
          district: "Жетысуский район",
          contactPhone: "+7 705 999 88 77",
        }),
        (body) => supplierCardResponseSchema.parse(body).company,
      );
      expect(changed).toMatchObject({
        version: before.version + 1,
        contactPhone: "+77059998877",
        location: { address: "ул. Райымбека, 200", district: "Жетысуский район" },
      });
      const { rows } = await db.query<{ actor_role: string; after: Record<string, unknown> }>(
        "SELECT actor_role, after FROM audit_log WHERE entity_id = $1 AND action = 'supplier.changed'",
        [supplierId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_role).toBe("supplier");
      expect(JSON.stringify(rows[0]!.after)).not.toContain("+77059998877");

      for (const field of [
        { name: "Другое название" },
        { bin: "080740000128" },
        { cityId },
        { type: "services" },
      ]) {
        const refused = await asSupplier(me.token, "patch", "/supplier/company", {
          expectedVersion: changed.version,
          ...field,
        });
        expectError(refused, 400, "VALIDATION_ERROR");
        expect(refused.body.details[0].path).toBe(Object.keys(field)[0]);
      }
      // The same values again: no new version, no journal entry.
      const same = await ok(
        asSupplier(me.token, "patch", "/supplier/company", {
          expectedVersion: changed.version,
          address: "ул. Райымбека, 200",
          contactPhone: "+77059998877",
        }),
        (body) => supplierCardResponseSchema.parse(body).company,
      );
      expect(same.version).toBe(changed.version);
      expect(
        await count("audit_log", "entity_id = $1 AND action = 'supplier.changed'", [supplierId]),
      ).toBe(1);
      expectError(
        await asSupplier(me.token, "patch", "/supplier/company", {
          expectedVersion: before.version,
          address: "Старый взгляд",
        }),
        409,
        "SUPPLIER_VERSION_CONFLICT",
      );
    });

    it("saving the same hours twice raises no version and gives the next editor no conflict", async () => {
      const first = phoneOf(151);
      const { supplierId } = await supplierWith(first);
      const me = await cabinet(first);
      const start = await ok(
        asSupplier(me.token, "get", "/supplier/company"),
        (body) => supplierCompanyResponseSchema.parse(body).company,
      );
      const set = await ok(
        asSupplier(me.token, "put", "/supplier/company/schedule", {
          expectedVersion: start.version,
          weeklyHours: WEEK,
          closedDates: [],
        }),
        (body) => supplierCardResponseSchema.parse(body).company,
      );
      expect(set.version).toBe(start.version + 1);
      // Two editors both loaded version `set.version` and save the same hours.
      for (const editor of ["supplier", "admin"] as const) {
        const response =
          editor === "supplier"
            ? await asSupplier(me.token, "put", "/supplier/company/schedule", {
                expectedVersion: set.version,
                weeklyHours: WEEK,
                closedDates: [],
              })
            : await asAdmin("put", `/admin/suppliers/${supplierId}/schedule`, {
                expectedVersion: set.version,
                weeklyHours: WEEK,
                closedDates: [],
              });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM supplier WHERE id = $1",
        [supplierId],
      );
      expect(rows[0]!.version).toBe(set.version);
      expect(
        await count("audit_log", "entity_id = $1 AND action = 'supplier.schedule_changed'", [
          supplierId,
        ]),
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------ invitations

  describe("invitations", () => {
    it("never sends an invitation to an employee removed before it went out", async () => {
      const first = phoneOf(161);
      const { supplierId } = await supplierWith(first);
      await waitFor("the first invitation", () =>
        Promise.resolve(messages.sent.find((message) => message.phone === first)),
      );
      const me = await cabinet(first);
      // The channel fails: the invitation stays queued, waiting for a retry.
      messages.failing = true;
      const colleague = phoneOf(162);
      const added = await addColleague(me.token, colleague, "Марат");
      await waitFor("a failed attempt", async () =>
        (await count("supplier_invitation", "member_id = $1 AND attempts > 0", [added.member.id])) >
        0
          ? true
          : undefined,
      );
      await ok(asSupplier(me.token, "delete", `/supplier/members/${added.member.id}`), (body) =>
        supplierMemberRemovedResponseSchema.parse(body),
      );
      const { rows } = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM supplier_invitation WHERE member_id = $1",
        [added.member.id],
      );
      expect(rows.map((row) => row.status)).toEqual(["cancelled"]);
      // The retry comes: nothing is sent.
      messages.failing = false;
      await worker
        .get(InvitationSender)
        .run(
          { invitationId: rows[0]!.id },
          { jobId: "test", attempt: 2, signal: new AbortController().signal },
        );
      expect(messages.sent.filter((message) => message.phone === colleague)).toEqual([]);

      // An invitation still queued when the employee is removed some other
      // way (the sender checks the employee itself).
      const second = await addColleague(me.token, phoneOf(163), "Второй");
      await waitFor("the second invitation", () =>
        Promise.resolve(messages.sent.find((message) => message.phone === phoneOf(163))),
      );
      await db.query(
        "UPDATE supplier_member SET status = 'removed', removed_at = now(), notifications_enabled_at = NULL WHERE id = $1",
        [second.member.id],
      );
      const { rows: queued } = await db.query<{ id: string }>(
        "INSERT INTO supplier_invitation (supplier_id, member_id) VALUES ($1, $2) RETURNING id",
        [supplierId, second.member.id],
      );
      messages.sent.length = 0;
      await worker
        .get(InvitationSender)
        .run(
          { invitationId: queued[0]!.id },
          { jobId: "test", attempt: 1, signal: new AbortController().signal },
        );
      expect(messages.sent).toEqual([]);
      expect(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM supplier_invitation WHERE id = $1",
            [queued[0]!.id],
          )
        ).rows[0]!.status,
      ).toBe("cancelled");
    });
  });

  // ----------------------------------------------------------------- access

  describe("access", () => {
    it("serves the cabinet routes to the supplier context only and the admin routes to the admin only", async () => {
      const first = phoneOf(171);
      const { supplierId, memberId } = await supplierWith(first);
      const me = await cabinet(first);
      const mobile = await mobileToken();
      const cabinetRoutes: [Method, string, object?][] = [
        ["get", "/supplier/members"],
        ["post", "/supplier/members", { name: "Х", phone: phoneOf(179) }],
        ["patch", `/supplier/members/${memberId}`, { displayName: "Х" }],
        ["delete", `/supplier/members/${memberId}`],
        ["get", "/supplier/me"],
        ["patch", "/supplier/me", { displayName: "Х" }],
        ["patch", "/supplier/company", { expectedVersion: 1, address: "Х" }],
      ];
      for (const [method, path, body] of cabinetRoutes) {
        expectError(await call(token, ADMIN_WEB, method, path, body), 403, "FORBIDDEN");
        expectError(await call(mobile, IOS, method, path, body), 403, "FORBIDDEN");
        const guest = http()[method](path).set("X-Client", SUPPLIER_WEB);
        expect((await (body ? guest.send(body) : guest)).status).toBe(401);
      }
      const adminRoutes: [Method, string, object?][] = [
        ["get", `/admin/suppliers/${supplierId}/members`],
        ["post", `/admin/suppliers/${supplierId}/members`, { name: "Х", phone: phoneOf(178) }],
        [
          "post",
          `/admin/suppliers/${supplierId}/members/${memberId}/restore`,
          { reason: "Причина" },
        ],
        ["post", `/admin/suppliers/${supplierId}/members/${memberId}/contact-person`],
        ["get", `/admin/suppliers/${supplierId}/sessions`],
        ["post", `/admin/suppliers/${supplierId}/sessions/end`, {}],
        [
          "post",
          `/admin/suppliers/${supplierId}/sessions/00000000-0000-4000-8000-000000000000/end`,
        ],
      ];
      for (const [method, path, body] of adminRoutes) {
        expectError(await call(me.token, SUPPLIER_WEB, method, path, body), 403, "FORBIDDEN");
        expectError(await call(mobile, IOS, method, path, body), 403, "FORBIDDEN");
      }
      // Nothing changed on the way.
      expect(await activeMembers(supplierId)).toBe(1);
      expect((await asSupplier(me.token, "get", "/supplier/me")).status).toBe(200);
    });
  });

  it("logs the employees' numbers only masked (the file's capture checks every registered one)", async () => {
    const first = phoneOf(181);
    await supplierWith(first);
    const me = await cabinet(first);
    const added = await addColleague(me.token, phoneOf(182), "Марат");
    await ok(asSupplier(me.token, "delete", `/supplier/members/${added.member.id}`), (body) =>
      supplierMemberRemovedResponseSchema.parse(body),
    );
    const text = output.text();
    expect(text).toContain("Employee added");
    expect(text).toContain("Employee removed");
    expect(text).not.toContain(phoneOf(182));
    expect(text).not.toContain(phoneOf(181));
  });
});
