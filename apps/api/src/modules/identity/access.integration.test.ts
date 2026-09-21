import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  apiErrorResponseSchema,
  apiRoutes,
  currentAccountResponseSchema,
  loginCodeVerifiedResponseSchema,
  sessionListResponseSchema,
  signInCompletedResponseSchema,
  supplierCompanyResponseSchema,
  supplierSelectionRequiredDetailsSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  totpVerifiedResponseSchema,
  type ErrorCode,
} from "@adclub/contracts";
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
import {
  allOutput,
  appLogText,
  captureOutput,
  rememberCode,
  rememberedCodes,
  rememberedSecrets,
  rememberSecret,
} from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TcpProxy } from "../../testing/tcp-proxy";
import { OperatorCommandError, OperatorService } from "./admin/operator.service";
import { totpCode, totpStep } from "./admin/totp";
import { LoginCodeChannels } from "./login-code/channels/login-code-channels";
import { TestLoginCodeChannels } from "./login-code/channels/test-login-code-channels";

/**
 * TASK-006 end to end over HTTP: the access rule on every protected route,
 * supplier cabinet sign-in with a company choice, switching companies,
 * admin sign-in with the TOTP second factor, backup codes, resets, the
 * operator command, and rights lost the moment the data changes. Real
 * PostgreSQL and Redis (Redis behind a proxy the tests can stop).
 */

const PHONE = "+77011234567";
const MASKED = "+7***4567";
const OTHER_PHONE = "+77471112233";
const THIRD_PHONE = "+77051234000";
const SUPPLIER_ORIGIN = "http://localhost:5175";
const ADMIN_ORIGIN = "http://localhost:5174";
const IOS = "mobile/1.4.2 (ios)";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const ADMIN_WEB = "admin-web/0.1.0";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface WebSession {
  accountId: string;
  sessionId: string;
  accessToken: string;
  /** `name=value` of the refresh cookie. */
  cookie: string;
}

interface Admin extends WebSession {
  adminId: string;
  phone: string;
  secret: string;
  backupCodes: string[];
}

describe("roles and contexts over HTTP (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redisProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let settings: TestSettings;
  let app: INestApplication;
  let channels: TestLoginCodeChannels;
  let operator: OperatorService;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  /** The last time step accepted per TOTP secret (codes are never accepted twice). */
  const lastSteps = new Map<string, number>();
  /**
   * `name=value` of the step cookie each step was bound to, by step id —
   * the browser that passed the code. Step calls send it unless told not to.
   */
  const stepCookies = new Map<string, string>();

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
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
    });

    const nestApp = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nestApp.useLogger(nestApp.get(JsonLoggerService));
    nestApp.flushLogs();
    configureHttpApp(nestApp, config);
    await nestApp.init();
    app = nestApp;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    operator = app.get(OperatorService);
    settings = new TestSettings(app);
    await waitForRedis();
  });

  afterAll(async () => {
    await app?.close();
    await redisProxy?.stop();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    config.nodeEnv = "test";
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    // Every setting back to its default, as the tables are emptied.
    await db.query(TRUNCATE_ALL);
    await settings.reload();
    await settings.set({
      login_code_requests_per_phone: 10_000,
      login_code_requests_per_ip: 10_000,
      login_code_verifications_per_phone: 10_000,
      // Several sign-ins of one administrator per test: later codes are
      // taken from later time steps (a code is never accepted twice).
      admin_totp_allowed_drift_steps: 5,
      admin_totp_verify_per_admin: 1000,
      admin_totp_verify_per_ip: 1000,
    });
    await redis.flushall();
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  function remember(body: unknown): void {
    const text = JSON.stringify(body ?? {});
    for (const match of text.matchAll(
      /"(accessToken|refreshToken|token|secret|otpauthUri)":"([^"]+)"/g,
    )) {
      rememberSecret(match[2]);
    }
  }

  function setCookies(response: Response): string[] {
    const header = response.headers["set-cookie"] as string[] | string | undefined;
    return header === undefined ? [] : Array.isArray(header) ? header : [header];
  }

  function stepIdOf(token: string): string | undefined {
    return /^st1\.([0-9a-f-]{36})\./.exec(token)?.[1];
  }

  /** The step cookie of the browser that got this step (`name=value`). */
  function stepCookie(token: string): string {
    const cookie = stepCookies.get(stepIdOf(token) ?? "");
    if (!cookie) {
      throw new Error("no step cookie for this token");
    }
    return cookie;
  }

  async function sendCode(phone: string): Promise<string> {
    await redis.del(`rl:login-code:resend:${phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status).toBe(200);
    const code = channels.sent.filter((message) => message.phone === phone).at(-1)?.code;
    if (!code) {
      throw new Error("no code was sent");
    }
    return code;
  }

  async function verify(
    phone: string,
    client: string | undefined,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    const code = await sendCode(phone);
    const call = http().post("/auth/login-code/verify").set("X-Forwarded-For", nextIp());
    if (client !== undefined) {
      call.set("X-Client", client);
    }
    const response = await call.send({ phone, code, ...extra });
    remember(response.body);
    for (const cookie of setCookies(response)) {
      const match = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(cookie);
      if (match) {
        rememberSecret(match[2]);
        stepCookies.set(match[1]!, `adclub_sign_in_${match[1]}=${match[2]}`);
      }
    }
    return response;
  }

  /**
   * A call from the browser that passed the code: a step route gets the
   * step cookie of the step in the body. `cookie` overrides it (`null` —
   * another browser, which has none).
   */
  async function post(
    path: string,
    body: object,
    client: string,
    options: { cookie?: string | null } = {},
  ): Promise<Response> {
    const call = http().post(path).set("X-Client", client).set("X-Forwarded-For", nextIp());
    const token = (body as { signInStep?: unknown }).signInStep;
    const cookie =
      options.cookie !== undefined
        ? options.cookie
        : typeof token === "string"
          ? (stepCookies.get(stepIdOf(token) ?? "") ?? null)
          : null;
    if (cookie !== null) {
      call.set("Cookie", cookie);
    }
    const response = await call.send(body);
    remember(response.body);
    return response;
  }

  function bearer(
    method: "get" | "post",
    path: string,
    accessToken: string,
    client = IOS,
    body?: object,
  ): Test {
    const call = http()
      [method](path)
      .set("X-Client", client)
      .set("Authorization", `Bearer ${accessToken}`);
    return body ? call.send(body) : call;
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  function refreshCookie(response: Response, name: string): string {
    const cookie = setCookies(response).find((value) => value.startsWith(`${name}=`));
    if (!cookie) {
      throw new Error(`no ${name} cookie`);
    }
    const pair = cookie.split(";")[0]!;
    rememberSecret(pair.slice(name.length + 1));
    return pair;
  }

  function cookieRefresh(origin: string, cookie: string): Test {
    return http()
      .post("/auth/session/refresh")
      .set("Origin", origin)
      .set("Cookie", cookie)
      .send({});
  }

  /** Resolves once a statement matching `pattern` waits for a row lock. */
  async function waitForLockWait(pattern: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1",
        [pattern],
      );
      if (rows[0]!.n > 0) {
        return;
      }
      await sleep(20);
    }
    throw new Error(`nothing waited for a lock: ${pattern}`);
  }

  /** A second connection that holds row locks until `release`. */
  async function lockRows(
    sql: string,
    params: unknown[],
  ): Promise<{ release: () => Promise<void> }> {
    const locker = new Client({ connectionString: postgres.getConnectionUri() });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query(sql, params);
    return {
      release: async () => {
        await locker.query("COMMIT");
        await locker.end();
      },
    };
  }

  async function tableCount(table: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]!.n;
  }

  async function sessionRow(sessionId: string) {
    const { rows } = await db.query<{ revoked_reason: string | null; supplier_id: string | null }>(
      "SELECT revoked_reason, supplier_id FROM session WHERE id = $1",
      [sessionId],
    );
    return rows[0];
  }

  async function company(name: string, city = "Алматы"): Promise<string> {
    return (await operator.createSupplier({ name, city })).supplierId;
  }

  async function employ(supplierId: string, phone: string, name = "Айгерим"): Promise<string> {
    return (await operator.addMember({ supplierId, phone, displayName: name })).memberId;
  }

  /** Waits for a new 30-second step if the current one is about to end (drift checks). */
  async function freshTotpStep(): Promise<void> {
    const intoStep = (Date.now() / 1000) % 30;
    if (intoStep > 25) {
      await sleep((30 - intoStep) * 1000 + 100);
    }
  }

  /** The next code the app would show that the server hasn't accepted yet. */
  function nextTotp(secret: string): string {
    const now = totpStep(Date.now());
    const step = Math.max(now, (lastSteps.get(secret) ?? now - 1) + 1);
    lastSteps.set(secret, step);
    const code = totpCode(secret, step);
    rememberCode(code);
    return code;
  }

  async function mobileSession(phone: string): Promise<string> {
    const response = await verify(phone, IOS);
    expect(response.status).toBe(200);
    return loginCodeVerifiedResponseSchema.parse(response.body).session.accessToken;
  }

  async function supplierSession(
    phone: string,
    extra: Record<string, unknown> = {},
  ): Promise<WebSession & { supplierId: string }> {
    const response = await verify(phone, SUPPLIER_WEB, extra);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = loginCodeVerifiedResponseSchema.parse(response.body);
    expect(body.access.context).toBe("supplier");
    return {
      accountId: body.accountId,
      sessionId: body.session.sessionId,
      accessToken: body.session.accessToken,
      cookie: refreshCookie(response, "adclub_supplier_refresh"),
      supplierId: body.access.context === "supplier" ? body.access.supplier.id : "",
    };
  }

  /** Signs in to the admin panel up to the second factor step. */
  async function adminStep(phone: string, expected: "TOTP_SETUP_REQUIRED" | "TOTP_REQUIRED") {
    const response = await verify(phone, ADMIN_WEB);
    expectError(response, 403, expected);
    return totpStepRequiredDetailsSchema.parse(response.body.details).signInStep.token;
  }

  /** Appoints the number and completes the first sign-in with the TOTP setup. */
  async function setUpAdmin(phone: string): Promise<Admin> {
    const { adminId } = await operator.grantAdmin(phone);
    const token = await adminStep(phone, "TOTP_SETUP_REQUIRED");
    const setup = totpSetupResponseSchema.parse(
      (await post("/auth/sign-in/totp/setup", { signInStep: token }, ADMIN_WEB)).body,
    );
    const confirmed = await post(
      "/auth/sign-in/totp/setup/confirm",
      { signInStep: token, totpCode: nextTotp(setup.secret) },
      ADMIN_WEB,
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return {
      adminId,
      phone,
      accountId: body.accountId,
      sessionId: body.session.sessionId,
      accessToken: body.session.accessToken,
      cookie: refreshCookie(confirmed, "adclub_admin_refresh"),
      secret: setup.secret,
      backupCodes: body.backupCodes,
    };
  }

  async function adminVerify(token: string, factor: { totpCode?: string; backupCode?: string }) {
    return post("/auth/sign-in/totp", { signInStep: token, ...factor }, ADMIN_WEB);
  }

  async function adminSignIn(admin: Admin): Promise<WebSession> {
    const token = await adminStep(admin.phone, "TOTP_REQUIRED");
    const response = await adminVerify(token, { totpCode: nextTotp(admin.secret) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = totpVerifiedResponseSchema.parse(response.body);
    return {
      accountId: body.accountId,
      sessionId: body.session.sessionId,
      accessToken: body.session.accessToken,
      cookie: refreshCookie(response, "adclub_admin_refresh"),
    };
  }

  async function waitForRedis(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await http()
        .post("/auth/login-code")
        .set("X-Forwarded-For", "192.0.2.250")
        .send({ phone: "+77000000000" });
      if (response.status === 200) {
        await redis.flushall();
        return;
      }
      await sleep(250);
    }
    throw new Error("the API never reached Redis");
  }

  describe("the access rule", () => {
    it("gives each session only its own context, whatever else the account is", async () => {
      // One number: app user, employee of a company, administrator.
      const supplierId = await company("Автомаркет");
      await employ(supplierId, PHONE);
      const admin = await setUpAdmin(PHONE);
      const mobile = await mobileSession(PHONE);
      const cabinet = await supplierSession(PHONE);

      const sessions = [
        { name: "mobile", token: mobile, client: IOS, context: "user" },
        { name: "cabinet", token: cabinet.accessToken, client: SUPPLIER_WEB, context: "supplier" },
        { name: "admin", token: admin.accessToken, client: ADMIN_WEB, context: "admin" },
      ] as const;
      const routes = [
        { path: "/auth/me", contexts: ["user", "supplier", "admin"] },
        { path: "/auth/sessions", contexts: ["user", "supplier", "admin"] },
        { path: "/auth/suppliers", contexts: ["supplier"] },
        { path: "/supplier/company", contexts: ["supplier"] },
        { path: `/supplier/companies/${supplierId}`, contexts: ["supplier"] },
        { path: "/admin/administrators", contexts: ["admin"] },
      ] as const;

      for (const session of sessions) {
        for (const route of routes) {
          const allowed = (route.contexts as readonly string[]).includes(session.context);
          const response = await bearer("get", route.path, session.token, session.client);
          if (allowed) {
            expect(response.status, `${session.name} ${route.path}`).toBe(200);
          } else {
            expectError(response, 403, "FORBIDDEN");
          }
          // Headers never add rights: another client, another origin — same answer.
          for (const headers of [
            { "X-Client": ADMIN_WEB, Origin: ADMIN_ORIGIN },
            { "X-Client": SUPPLIER_WEB, Origin: SUPPLIER_ORIGIN },
            { "X-Client": "" },
          ]) {
            const again = await http()
              .get(route.path)
              .set(headers)
              .set("Authorization", `Bearer ${session.token}`);
            expect(again.status, `${session.name} ${route.path} ${JSON.stringify(headers)}`).toBe(
              response.status,
            );
          }
        }
        const me = currentAccountResponseSchema.parse(
          (await bearer("get", "/auth/me", session.token, session.client)).body,
        );
        expect(me.access.context).toBe(session.context);
      }

      const adminMe = currentAccountResponseSchema.parse(
        (await bearer("get", "/auth/me", admin.accessToken, ADMIN_WEB)).body,
      );
      expect(adminMe.access).toEqual({ context: "admin", admin: { id: admin.adminId } });
      expect(adminMe.session.supplier).toBeNull();
      const cabinetMe = currentAccountResponseSchema.parse(
        (await bearer("get", "/auth/me", cabinet.accessToken, SUPPLIER_WEB)).body,
      );
      expect(cabinetMe.access).toMatchObject({
        context: "supplier",
        supplier: { id: supplierId, name: "Автомаркет", city: "Алматы" },
        member: { displayName: "Айгерим" },
      });
      expect(output.text()).toContain("Access refused: context not allowed");
      expect(output.text()).toContain("context=user route=supplier");
      expect(output.text()).toContain("context=supplier route=admin");
    });

    it("gives a caller without X-Client only a mobile session, even for an employee and an administrator", async () => {
      const supplierId = await company("Автомаркет");
      await employ(supplierId, PHONE);
      await operator.grantAdmin(PHONE);
      const response = await verify(PHONE, undefined);
      expect(response.status).toBe(200);
      const body = loginCodeVerifiedResponseSchema.parse(response.body);
      expect(body.session.kind).toBe("mobile");
      expect(body.access).toEqual({ context: "user" });
      expectError(
        await bearer("get", "/supplier/company", body.session.accessToken, ""),
        403,
        "FORBIDDEN",
      );
      expectError(
        await bearer("get", "/admin/administrators", body.session.accessToken, ""),
        403,
        "FORBIDDEN",
      );
    });

    it("never binds an employee to another company's employee", async () => {
      const a = await company("A");
      const b = await company("B");
      const memberOfB = await employ(b, OTHER_PHONE);
      const { rows } = await db.query<{ id: string }>("SELECT id FROM account WHERE phone = $1", [
        OTHER_PHONE,
      ]);
      await expect(
        db.query(
          "INSERT INTO session (account_id, kind, supplier_id, supplier_member_id, refresh_seed, last_used_at, expires_at) VALUES ($1, 'supplier_web', $2, $3, 's', now(), now() + interval '1 day')",
          [rows[0]!.id, a, memberOfB],
        ),
      ).rejects.toThrow(/session_supplier_member_fkey/);
      await expect(
        db.query(
          "INSERT INTO session (account_id, kind, refresh_seed, last_used_at, expires_at) VALUES ($1, 'supplier_web', 's', now(), now() + interval '1 day')",
          [rows[0]!.id],
        ),
      ).rejects.toThrow(/session_supplier_context_required_check/);
    });
  });

  describe("supplier cabinet sign-in", () => {
    it("refuses a number without an active membership only after spending the code, creating nothing", async () => {
      await mobileSession(OTHER_PHONE); // an app user, not an employee
      const accountsBefore = await tableCount("account");
      const sessionsBefore = await tableCount("session");
      for (const phone of [OTHER_PHONE, PHONE]) {
        const response = await verify(phone, SUPPLIER_WEB);
        expectError(response, 403, "NOT_SUPPLIER_MEMBER");
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect(await tableCount("account")).toBe(accountsBefore);
      expect(await tableCount("session")).toBe(sessionsBefore);
      const { rows } = await db.query("SELECT status FROM otp_challenge WHERE phone = $1", [PHONE]);
      expect(rows).toEqual([{ status: "consumed" }]);
      expect(output.text()).toContain(
        `Supplier sign-in refused: no active membership phone=${MASKED}`,
      );
    });

    it("signs a single-company employee in at once, even one who never signed in before", async () => {
      const supplierId = await company("Шиномонтаж", "Астана");
      const memberId = await employ(supplierId, PHONE, "Ерлан");
      expect(await tableCount("account")).toBe(1); // created when the employee was added

      const response = await verify(PHONE, SUPPLIER_WEB, { deviceName: "Chrome" });
      expect(response.status).toBe(200);
      const body = loginCodeVerifiedResponseSchema.parse(response.body);
      expect(body.session.kind).toBe("supplier_web");
      expect(body.session).not.toHaveProperty("refreshToken");
      expect(body.access).toEqual({
        context: "supplier",
        supplier: { id: supplierId, name: "Шиномонтаж", city: "Астана" },
        member: { id: memberId, displayName: "Ерлан" },
      });
      refreshCookie(response, "adclub_supplier_refresh");
      expect(await tableCount("account")).toBe(1);

      const current = await bearer(
        "get",
        "/supplier/company",
        body.session.accessToken,
        SUPPLIER_WEB,
      );
      const own = supplierCompanyResponseSchema.parse(current.body);
      expect(own.supplier).toEqual({
        id: supplierId,
        name: "Шиномонтаж",
        city: "Астана",
        status: "active",
      });
      // The card of the company (TASK-016).
      expect(own.company).toMatchObject({
        id: supplierId,
        name: "Шиномонтаж",
        state: "active",
      });
      const list = sessionListResponseSchema.parse(
        (await bearer("get", "/auth/sessions", body.session.accessToken, SUPPLIER_WEB)).body,
      );
      expect(list.sessions).toEqual([
        expect.objectContaining({
          kind: "supplier_web",
          deviceName: "Chrome",
          supplier: { id: supplierId, name: "Шиномонтаж", city: "Астана" },
        }),
      ]);
      expect(output.text()).toContain(
        `Supplier sign-in completed account=${body.accountId} supplier=${supplierId} member=${memberId}`,
      );
    });

    it("keeps a paused or blocked company's cabinet open", async () => {
      const supplierId = await company("На паузе");
      await employ(supplierId, PHONE);
      // Pause and blocking are set the way the admin routes set them (TASK-016).
      const states = {
        paused: "pause_reason = 'admin', paused_at = now()",
        blocked: "block_reason = 'test', blocked_at = now()",
      } as const;
      for (const status of ["paused", "blocked"] as const) {
        await db.query(`UPDATE supplier SET ${states[status]}, status = $1 WHERE id = $2`, [
          status,
          supplierId,
        ]);
        const session = await supplierSession(PHONE);
        const response = await bearer(
          "get",
          "/supplier/company",
          session.accessToken,
          SUPPLIER_WEB,
        );
        expect(response.body.supplier.status).toBe(status);
      }
    });

    it("lets an employee of several companies choose one without a new code, once and briefly", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      const outsider = await company("Гамма");
      await employ(a, PHONE);
      const memberB = await employ(b, PHONE);
      await employ(outsider, OTHER_PHONE);

      const response = await verify(PHONE, SUPPLIER_WEB);
      expectError(response, 403, "SUPPLIER_SELECTION_REQUIRED");
      expect(await tableCount("session")).toBe(0);
      const details = supplierSelectionRequiredDetailsSchema.parse(response.body.details);
      expect(details.suppliers).toEqual([
        { id: a, name: "Альфа", city: "Алматы" },
        { id: b, name: "Бета", city: "Алматы" },
      ]);
      const token = details.signInStep.token;
      expect(Date.parse(details.signInStep.expiresAt) - Date.now()).toBeGreaterThan(590_000);

      // Only companies the number works for; the step survives a wrong choice.
      for (const supplierId of [outsider, randomUUID()]) {
        const wrong = await post(
          "/auth/sign-in/supplier",
          { signInStep: token, supplierId },
          SUPPLIER_WEB,
        );
        expectError(wrong, 404, "NOT_FOUND");
      }
      const chosen = await post(
        "/auth/sign-in/supplier",
        { signInStep: token, supplierId: b },
        SUPPLIER_WEB,
      );
      expect(chosen.status).toBe(200);
      const body = signInCompletedResponseSchema.parse(chosen.body);
      expect(body.session).not.toHaveProperty("refreshToken");
      expect(body.access).toMatchObject({ context: "supplier", member: { id: memberB } });
      refreshCookie(chosen, "adclub_supplier_refresh");
      expect(await sessionRow(body.session.sessionId)).toMatchObject({ supplier_id: b });

      // Once only.
      const again = await post(
        "/auth/sign-in/supplier",
        { signInStep: token, supplierId: a },
        SUPPLIER_WEB,
      );
      expectError(again, 401, "SIGN_IN_STEP_INVALID");
      // A forged token or one of another kind of step is refused the same way.
      const forged = `${token.slice(0, -4)}AAAA`;
      expectError(
        await post("/auth/sign-in/supplier", { signInStep: forged, supplierId: a }, SUPPLIER_WEB),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      expectError(
        await post(
          "/auth/sign-in/supplier",
          { signInStep: "st1.garbage", supplierId: a },
          SUPPLIER_WEB,
        ),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      expect(await tableCount("session")).toBe(1);

      // Briefly.
      await settings.set({ sign_in_supplier_selection_ttl_seconds: 1 });
      const late = supplierSelectionRequiredDetailsSchema.parse(
        (await verify(PHONE, SUPPLIER_WEB)).body.details,
      );
      await sleep(1100);
      expectError(
        await post(
          "/auth/sign-in/supplier",
          { signInStep: late.signInStep.token, supplierId: a },
          SUPPLIER_WEB,
        ),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      const log = output.text();
      expect(log).toContain("Supplier sign-in: company choice required");
      expect(log).toContain("Supplier sign-in completed with company choice");
      expect(log).toContain("reason=already_used");
      expect(log).toContain("reason=expired");
    });

    it("lets only the browser that passed the code finish the company choice", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      await employ(a, PHONE);
      await employ(b, PHONE);

      const response = await verify(PHONE, SUPPLIER_WEB);
      expectError(response, 403, "SUPPLIER_SELECTION_REQUIRED");
      const token = supplierSelectionRequiredDetailsSchema.parse(response.body.details).signInStep
        .token;
      const stepId = stepIdOf(token)!;
      const setCookie = setCookies(response).find((cookie) =>
        cookie.startsWith(`adclub_sign_in_${stepId}=`),
      );
      expect(setCookie).toBeDefined();
      expect(setCookie).toMatch(/; HttpOnly/i);
      expect(setCookie).toMatch(/; Secure/i);
      expect(setCookie).toMatch(/; SameSite=Strict/i);
      expect(setCookie).toMatch(/; Path=\/auth\/sign-in(;|$)/);
      expect(setCookie).not.toMatch(/Domain=/i);
      expect(Number(/Max-Age=(\d+)/.exec(setCookie!)?.[1])).toBeGreaterThan(590);
      const binding = stepCookie(token).split("=")[1]!;
      expect(JSON.stringify(response.body)).not.toContain(binding);

      // Another browser holds the token (from a log, a screenshot, an error
      // report) — but not this browser's cookie.
      const otherToken = supplierSelectionRequiredDetailsSchema.parse(
        (await verify(PHONE, SUPPLIER_WEB)).body.details,
      ).signInStep.token;
      const otherBinding = stepCookie(otherToken).split("=")[1]!;
      const name = `adclub_sign_in_${stepId}`;
      for (const cookie of [
        null,
        stepCookie(otherToken),
        `${name}=${otherBinding}`,
        `${name}=${"A".repeat(43)}`,
        `${name}=${token.split(".")[2]}`,
        `${name}=`,
        `${name}=${binding}; ${name}=${binding}`,
      ]) {
        for (const supplierId of [a, randomUUID()]) {
          // Refused before anything else: not even whether the company fits.
          expectError(
            await post("/auth/sign-in/supplier", { signInStep: token, supplierId }, SUPPLIER_WEB, {
              cookie,
            }),
            401,
            "SIGN_IN_STEP_INVALID",
          );
        }
      }
      expect(await tableCount("session")).toBe(0);
      const { rows: steps } = await db.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM sign_in_step WHERE id = $1",
        [stepId],
      );
      expect(steps[0]!.consumed_at).toBeNull();

      // The browser that passed the code still finishes; its cookie is dropped.
      const chosen = await post(
        "/auth/sign-in/supplier",
        { signInStep: token, supplierId: a },
        SUPPLIER_WEB,
      );
      expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
      refreshCookie(chosen, "adclub_supplier_refresh");
      const cleared = setCookies(chosen).find((cookie) => cookie.startsWith(`${name}=`));
      expect(cleared).toMatch(new RegExp(`^${name}=;`));
      expect(cleared).toMatch(/Path=\/auth\/sign-in/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

      // Two sign-ins in two tabs of one browser: the browser sends both
      // cookies, and each step finishes.
      const thirdToken = supplierSelectionRequiredDetailsSchema.parse(
        (await verify(PHONE, SUPPLIER_WEB)).body.details,
      ).signInStep.token;
      const bothCookies = `${stepCookie(otherToken)}; ${stepCookie(thirdToken)}`;
      for (const [tab, supplierId] of [
        [thirdToken, b],
        [otherToken, a],
      ] as const) {
        const finished = await post(
          "/auth/sign-in/supplier",
          { signInStep: tab, supplierId },
          SUPPLIER_WEB,
          { cookie: bothCookies },
        );
        expect(finished.status, JSON.stringify(finished.body)).toBe(200);
        refreshCookie(finished, "adclub_supplier_refresh");
      }
      expect(await tableCount("session")).toBe(3);

      // The mobile app never gets a step, so no step cookie either.
      const mobile = await verify(PHONE, IOS);
      expect(mobile.status).toBe(200);
      expect(setCookies(mobile)).toEqual([]);

      expect(output.text()).toContain(`Sign-in step refused step=${stepId} reason=other_client`);
      for (const value of [binding, otherBinding]) {
        expect(output.text()).not.toContain(value);
      }
    });

    it("follows memberships removed while the choice is open", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      const memberA = await employ(a, PHONE);
      const memberB = await employ(b, PHONE);
      const token = supplierSelectionRequiredDetailsSchema.parse(
        (await verify(PHONE, SUPPLIER_WEB)).body.details,
      ).signInStep.token;

      await operator.removeMember(memberA);
      expectError(
        await post("/auth/sign-in/supplier", { signInStep: token, supplierId: a }, SUPPLIER_WEB),
        404,
        "NOT_FOUND",
      );
      await operator.removeMember(memberB);
      expectError(
        await post("/auth/sign-in/supplier", { signInStep: token, supplierId: b }, SUPPLIER_WEB),
        403,
        "NOT_SUPPLIER_MEMBER",
      );
      // The step is spent by that refusal.
      expectError(
        await post("/auth/sign-in/supplier", { signInStep: token, supplierId: b }, SUPPLIER_WEB),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      expect(await tableCount("session")).toBe(0);
    });

    it("goes straight to the remembered company while the number still works there", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      const c = await company("Цельсий");
      const memberA = await employ(a, PHONE);
      const memberB = await employ(b, PHONE);
      await employ(c, PHONE);
      const direct = await supplierSession(PHONE, { supplierId: b });
      expect(direct.supplierId).toBe(b);

      await operator.removeMember(memberB);
      const choice = await verify(PHONE, SUPPLIER_WEB, { supplierId: b });
      expectError(choice, 403, "SUPPLIER_SELECTION_REQUIRED");
      expect(
        supplierSelectionRequiredDetailsSchema
          .parse(choice.body.details)
          .suppliers.map((item) => item.id),
      ).toEqual([a, c]);
      // One company left: that one, whatever was remembered.
      await operator.removeMember(memberA);
      expect((await supplierSession(PHONE, { supplierId: b })).supplierId).toBe(c);
    });
  });

  describe("switching companies", () => {
    it("moves the session to another active membership; the previous company is gone for it", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      const foreign = await company("Чужая");
      await employ(a, PHONE);
      const memberB = await employ(b, PHONE);
      await employ(foreign, OTHER_PHONE);
      const session = await supplierSession(PHONE, { supplierId: a });
      const call = (method: "get" | "post", path: string, body?: object) =>
        bearer(method, path, session.accessToken, SUPPLIER_WEB, body);

      const mine = await call("get", "/auth/suppliers");
      expect(mine.body.suppliers).toEqual([
        { id: a, name: "Альфа", city: "Алматы", current: true },
        { id: b, name: "Бета", city: "Алматы", current: false },
      ]);
      expect((await call("get", `/supplier/companies/${a}`)).status).toBe(200);

      const switched = await call("post", "/auth/supplier-context", { supplierId: b });
      expect(switched.status).toBe(200);
      expect(currentAccountResponseSchema.parse(switched.body).access).toMatchObject({
        context: "supplier",
        supplier: { id: b },
        member: { id: memberB },
      });
      expect((await call("get", "/supplier/company")).body.supplier.id).toBe(b);
      expect(await sessionRow(session.sessionId)).toMatchObject({ supplier_id: b });

      // The old company, a foreign one and a made-up id all look the same.
      const answers = await Promise.all(
        [a, foreign, randomUUID()].map((id) => call("get", `/supplier/companies/${id}`)),
      );
      for (const answer of answers) {
        expectError(answer, 404, "NOT_FOUND");
        expect(answer.body).toEqual(answers[0]!.body);
      }
      expect((await call("get", `/supplier/companies/${b}`)).status).toBe(200);

      // No switching to a company without an active membership.
      for (const supplierId of [foreign, randomUUID()]) {
        expectError(await call("post", "/auth/supplier-context", { supplierId }), 404, "NOT_FOUND");
      }
      await operator.removeMember(
        (
          await db.query<{ id: string }>("SELECT id FROM supplier_member WHERE supplier_id = $1", [
            a,
          ])
        ).rows[0]!.id,
      );
      expectError(
        await call("post", "/auth/supplier-context", { supplierId: a }),
        404,
        "NOT_FOUND",
      );
      expect((await call("get", "/supplier/company")).body.supplier.id).toBe(b);

      // The refreshed session keeps the new company.
      const renewed = await cookieRefresh(SUPPLIER_ORIGIN, session.cookie);
      expect(renewed.status).toBe(200);
      remember(renewed.body);
      refreshCookie(renewed, "adclub_supplier_refresh");
      const log = output.text();
      expect(log).toContain(
        `Supplier context switched session=${session.sessionId} account=${session.accountId} from=${a} to=${b}`,
      );
      expect(log).toContain("Supplier context switch refused: no active membership");
    });

    it("never leaves a session in a membership removed while switching to it: switch first", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      await employ(a, PHONE);
      const memberB = await employ(b, PHONE);
      const session = await supplierSession(PHONE, { supplierId: a });

      // The switch has read the membership and waits to move the session;
      // the removal starts right then.
      const held = await lockRows("SELECT 1 FROM session WHERE id = $1 FOR UPDATE", [
        session.sessionId,
      ]);
      const switching = bearer(
        "post",
        "/auth/supplier-context",
        session.accessToken,
        SUPPLIER_WEB,
        {
          supplierId: b,
        },
      ).then((response) => response);
      await waitForLockWait('update "session" set "supplier_id"%');
      const removal = operator.removeMember(memberB);
      // The removal waits for the switch (the membership is share-locked by it).
      await waitForLockWait('update "supplier_member" set "status"%');
      await held.release();
      const [switched, removed] = await Promise.all([switching, removal]);

      expect(switched.status).toBe(200);
      expect(removed).toEqual({ sessionsEnded: 1 });
      const { rows } = await db.query<{ supplier_member_id: string; revoked_reason: string }>(
        "SELECT supplier_member_id, revoked_reason FROM session WHERE id = $1",
        [session.sessionId],
      );
      expect(rows[0]).toEqual({ supplier_member_id: memberB, revoked_reason: "access_closed" });
      expectError(
        await bearer("get", "/supplier/company", session.accessToken, SUPPLIER_WEB),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
    });

    it("never leaves a session in a membership removed while switching to it: removal first", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      await employ(a, PHONE);
      const memberB = await employ(b, PHONE);
      const session = await supplierSession(PHONE, { supplierId: a });
      const inB = await supplierSession(PHONE, { supplierId: b });

      // The removal has marked the membership and waits to end its sessions;
      // the switch starts right then.
      const held = await lockRows("SELECT 1 FROM session WHERE id = $1 FOR UPDATE", [
        inB.sessionId,
      ]);
      const removal = operator.removeMember(memberB);
      await waitForLockWait('update "session" set "revoked_at"%');
      const switching = bearer(
        "post",
        "/auth/supplier-context",
        session.accessToken,
        SUPPLIER_WEB,
        {
          supplierId: b,
        },
      ).then((response) => response);
      // The switch waits for the removal to commit, then sees no membership.
      await waitForLockWait('%"supplier_member"%for share%');
      await held.release();
      const [removed, switched] = await Promise.all([removal, switching]);

      expect(removed).toEqual({ sessionsEnded: 1 });
      expectError(switched, 404, "NOT_FOUND");
      expect(await sessionRow(session.sessionId)).toEqual({ revoked_reason: null, supplier_id: a });
      expect(
        (await bearer("get", "/supplier/company", session.accessToken, SUPPLIER_WEB)).body,
      ).toMatchObject({ supplier: { id: a } });
    });

    it("is not available to other contexts", async () => {
      const a = await company("Альфа");
      await employ(a, PHONE);
      const mobile = await mobileSession(PHONE);
      expectError(
        await bearer("post", "/auth/supplier-context", mobile, IOS, { supplierId: a }),
        403,
        "FORBIDDEN",
      );
    });
  });

  describe("losing rights", () => {
    it("ends the cabinet sessions of a removed employee in the removal itself; the person's other sessions go on", async () => {
      const a = await company("Альфа");
      const b = await company("Бета");
      const memberA = await employ(a, PHONE);
      await employ(b, PHONE);
      const inA = await supplierSession(PHONE, { supplierId: a });
      // Another browser, never used again: a forgotten or stolen laptop.
      const inA2 = await supplierSession(PHONE, { supplierId: a });
      const inB = await supplierSession(PHONE, { supplierId: b });
      const mobile = await mobileSession(PHONE);
      await employ(a, OTHER_PHONE, "Ерлан");
      const otherEmployee = await supplierSession(OTHER_PHONE);

      expect(await operator.removeMember(memberA)).toEqual({ sessionsEnded: 2 });

      // Ended in the database before any request of theirs.
      expect(await sessionRow(inA.sessionId)).toMatchObject({ revoked_reason: "access_closed" });
      expect(await sessionRow(inA2.sessionId)).toMatchObject({ revoked_reason: "access_closed" });
      expect(await sessionRow(inB.sessionId)).toMatchObject({ revoked_reason: null });
      expect(await sessionRow(otherEmployee.sessionId)).toMatchObject({ revoked_reason: null });
      const { rows: active } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM session WHERE supplier_member_id = $1 AND revoked_at IS NULL",
        [memberA],
      );
      expect(active[0]!.n).toBe(0);

      const closed = await bearer("get", "/supplier/company", inA.accessToken, SUPPLIER_WEB);
      expectError(closed, 401, "SUPPLIER_ACCESS_CLOSED");
      expect(closed.headers["www-authenticate"]).toContain("Bearer");
      // Keeps saying so, on every route and on refresh (and drops the cookie).
      expectError(
        await bearer("get", "/auth/me", inA.accessToken, SUPPLIER_WEB),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
      const refused = await cookieRefresh(SUPPLIER_ORIGIN, inA.cookie);
      expectError(refused, 401, "SUPPLIER_ACCESS_CLOSED");
      expect(String(refused.headers["set-cookie"])).toMatch(/^adclub_supplier_refresh=;/);

      expect((await bearer("get", "/supplier/company", inB.accessToken, SUPPLIER_WEB)).status).toBe(
        200,
      );
      expect(
        (await bearer("get", "/supplier/company", otherEmployee.accessToken, SUPPLIER_WEB)).status,
      ).toBe(200);
      expect((await bearer("get", "/auth/me", mobile, IOS)).status).toBe(200);

      // Restoring the membership (same row, same id) brings no ended session
      // back — not even one that never called the server in between.
      expect(await employ(a, PHONE)).toBe(memberA);
      expectError(
        await bearer("get", "/supplier/company", inA2.accessToken, SUPPLIER_WEB),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
      expectError(await cookieRefresh(SUPPLIER_ORIGIN, inA2.cookie), 401, "SUPPLIER_ACCESS_CLOSED");
      expectError(
        await bearer("get", "/supplier/company", inA.accessToken, SUPPLIER_WEB),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
      expect(await sessionRow(inA2.sessionId)).toMatchObject({ revoked_reason: "access_closed" });
      // A new sign-in works.
      const again = await supplierSession(PHONE, { supplierId: a });
      expect(again.supplierId).toBe(a);
      expect(
        (await bearer("get", "/supplier/company", again.accessToken, SUPPLIER_WEB)).status,
      ).toBe(200);

      expect(output.text()).toContain(
        `Operator: employee removed supplier=${a} member=${memberA} account=${inA.accountId} sessionsEnded=2`,
      );
      expect(output.text()).toContain(
        `Session ended session=${inA2.sessionId} account=${inA.accountId} reason=access_closed`,
      );
      expect(output.text()).toContain(
        `Operator: employee restored supplier=${a} member=${memberA}`,
      );
      await expect(operator.removeMember(randomUUID())).rejects.toThrow(OperatorCommandError);
    });

    it("still ends a session whose membership was removed behind its back, on its next request", async () => {
      const a = await company("Альфа");
      const memberA = await employ(a, PHONE);
      const inA = await supplierSession(PHONE);
      const inA2 = await supplierSession(PHONE);
      // Not through the removal (a future path that forgets to end sessions).
      await db.query(
        "UPDATE supplier_member SET status = 'removed', removed_at = now() WHERE id = $1",
        [memberA],
      );

      expectError(
        await bearer("get", "/supplier/company", inA.accessToken, SUPPLIER_WEB),
        401,
        "SUPPLIER_ACCESS_CLOSED",
      );
      expect(await sessionRow(inA.sessionId)).toMatchObject({ revoked_reason: "access_closed" });
      expectError(await cookieRefresh(SUPPLIER_ORIGIN, inA2.cookie), 401, "SUPPLIER_ACCESS_CLOSED");
      expect(await sessionRow(inA2.sessionId)).toMatchObject({ revoked_reason: "access_closed" });
      expect(output.text()).toContain(
        `Access refused, context lost, session ended session=${inA.sessionId} account=${inA.accountId} kind=supplier_web reason=membership_removed supplier=${a} member=${memberA}`,
      );
      expect(output.text()).toContain(
        `Session refresh refused, context lost, session ended session=${inA2.sessionId}`,
      );
    });

    it("ends every admin session of a removed administrator at once; the mobile and cabinet sessions go on", async () => {
      const a = await company("Альфа");
      await employ(a, PHONE);
      const admin = await setUpAdmin(PHONE);
      const second = await adminSignIn(admin);
      const mobile = await mobileSession(PHONE);
      const cabinet = await supplierSession(PHONE);

      const removed = await operator.revokeAdmin(PHONE);
      expect(removed).toEqual({ adminId: admin.adminId, sessionsEnded: 2 });
      for (const session of [admin, second]) {
        expectError(
          await bearer("get", "/admin/administrators", session.accessToken, ADMIN_WEB),
          401,
          "SESSION_ENDED",
        );
        expectError(await cookieRefresh(ADMIN_ORIGIN, session.cookie), 401, "SESSION_ENDED");
        expect(await sessionRow(session.sessionId)).toMatchObject({
          revoked_reason: "admin_removed",
        });
      }
      expect((await bearer("get", "/auth/me", mobile, IOS)).status).toBe(200);
      expect(
        (await bearer("get", "/supplier/company", cabinet.accessToken, SUPPLIER_WEB)).status,
      ).toBe(200);
      expectError(await verify(PHONE, ADMIN_WEB), 403, "NOT_ADMIN");
      expect(output.text()).toContain(
        `Operator: administrator removed admin=${admin.adminId} account=${admin.accountId} phone=${MASKED} sessionsEnded=2`,
      );

      // Appointed again: the second factor is set up anew.
      await operator.grantAdmin(PHONE);
      await adminStep(PHONE, "TOTP_SETUP_REQUIRED");
    });

    it("refuses an admin session whose administrator record changed behind its back", async () => {
      const admin = await setUpAdmin(PHONE);
      await db.query("UPDATE admin_user SET status = 'removed', removed_at = now() WHERE id = $1", [
        admin.adminId,
      ]);
      expectError(
        await bearer("get", "/admin/administrators", admin.accessToken, ADMIN_WEB),
        401,
        "SESSION_ENDED",
      );
      expect(await sessionRow(admin.sessionId)).toMatchObject({ revoked_reason: "admin_removed" });
    });
  });

  describe("admin sign-in and the second factor", () => {
    it("refuses a number that isn't an administrator after spending the code, creating nothing", async () => {
      const response = await verify(PHONE, ADMIN_WEB);
      expectError(response, 403, "NOT_ADMIN");
      expect(await tableCount("account")).toBe(0);
      expect(await tableCount("sign_in_step")).toBe(0);
      const { rows } = await db.query("SELECT status FROM otp_challenge");
      expect(rows).toEqual([{ status: "consumed" }]);
      expect(output.text()).toContain(
        `Admin sign-in refused: not an administrator phone=${MASKED}`,
      );
    });

    it("sets up the authenticator on the first sign-in, then opens the session and shows backup codes once", async () => {
      const { adminId, outcome } = await operator.grantAdmin(PHONE);
      expect(outcome).toBe("created");
      const token = await adminStep(PHONE, "TOTP_SETUP_REQUIRED");
      expect(await tableCount("session")).toBe(0);

      // Setup is only reachable with the setup step.
      expectError(await adminVerify(token, { totpCode: "123456" }), 401, "SIGN_IN_STEP_INVALID");
      expectError(
        await post(
          "/auth/sign-in/totp/setup/confirm",
          { signInStep: token, totpCode: "123456" },
          ADMIN_WEB,
        ),
        409,
        "CONFLICT",
      );

      const first = totpSetupResponseSchema.parse(
        (await post("/auth/sign-in/totp/setup", { signInStep: token }, ADMIN_WEB)).body,
      );
      const repeated = totpSetupResponseSchema.parse(
        (await post("/auth/sign-in/totp/setup", { signInStep: token }, ADMIN_WEB)).body,
      );
      expect(repeated).toEqual(first);
      expect(first).toMatchObject({
        issuer: "Asia Drive Club",
        accountName: MASKED,
        digits: 6,
        periodSeconds: 30,
        algorithm: "SHA1",
      });
      expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
      const uri = new URL(first.otpauthUri);
      expect(uri.searchParams.get("secret")).toBe(first.secret);

      const wrong = await post(
        "/auth/sign-in/totp/setup/confirm",
        { signInStep: token, totpCode: totpCode(first.secret, totpStep(Date.now()) + 20) },
        ADMIN_WEB,
      );
      expectError(wrong, 400, "TOTP_INVALID");
      expect(await tableCount("session")).toBe(0);

      const confirmed = await post(
        "/auth/sign-in/totp/setup/confirm",
        { signInStep: token, totpCode: nextTotp(first.secret), deviceName: "Firefox" },
        ADMIN_WEB,
      );
      expect(confirmed.status).toBe(200);
      const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
      expect(body.session.kind).toBe("admin_web");
      expect(body.session).not.toHaveProperty("refreshToken");
      expect(body.access).toEqual({ context: "admin", admin: { id: adminId } });
      expect(body.backupCodes).toHaveLength(10);
      expect(new Set(body.backupCodes).size).toBe(10);
      for (const code of body.backupCodes) {
        rememberCode(code, code.replace("-", ""));
        expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
      }
      const cookie = refreshCookie(confirmed, "adclub_admin_refresh");
      expect(Date.parse(body.session.sessionExpiresAt) - Date.now()).toBeLessThanOrEqual(
        12 * 3600 * 1000,
      );

      const admins = await bearer(
        "get",
        "/admin/administrators",
        body.session.accessToken,
        ADMIN_WEB,
      );
      expect(admins.body.administrators).toEqual([
        expect.objectContaining({
          id: adminId,
          phoneMasked: MASKED,
          totpConfigured: true,
          current: true,
        }),
      ]);
      const renewed = await cookieRefresh(ADMIN_ORIGIN, cookie);
      expect(renewed.status).toBe(200);
      remember(renewed.body);
      refreshCookie(renewed, "adclub_admin_refresh");

      // The step is spent.
      expectError(
        await post(
          "/auth/sign-in/totp/setup/confirm",
          { signInStep: token, totpCode: nextTotp(first.secret) },
          ADMIN_WEB,
        ),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      expectError(
        await post("/auth/sign-in/totp/setup", { signInStep: token }, ADMIN_WEB),
        401,
        "SIGN_IN_STEP_INVALID",
      );

      // Stored only encrypted or hashed.
      const rows: string[] = [];
      for (const table of ["admin_user", "admin_backup_code", "sign_in_step", "session"]) {
        const result = await db.query<{ row: string }>(
          `SELECT row_to_json(t)::text AS row FROM ${table} t`,
        );
        rows.push(...result.rows.map((row) => row.row));
      }
      const everything = rows.join("\n");
      expect(everything).toContain("v1.");
      expect(everything).not.toContain(first.secret);
      expect(everything.toLowerCase()).not.toContain(first.secret.toLowerCase());
      for (const code of body.backupCodes) {
        expect(everything).not.toContain(code);
        expect(everything).not.toContain(code.replace("-", ""));
      }
      expect(everything).not.toContain(token.split(".")[2]!);
      expect(await tableCount("admin_backup_code")).toBe(10);

      const log = output.text();
      expect(log).toContain(`Admin sign-in: second factor setup required admin=${adminId}`);
      expect(log).toContain(`Admin TOTP setup started admin=${adminId}`);
      expect(log).toContain(`Admin TOTP setup failed admin=${adminId}`);
      expect(log).toContain(`Admin TOTP set up admin=${adminId} backupCodes=10`);
    });

    it("lets only the browser that passed the code set up or pass the second factor", async () => {
      await operator.grantAdmin(PHONE);
      const setupToken = await adminStep(PHONE, "TOTP_SETUP_REQUIRED");
      const setupStepId = stepIdOf(setupToken)!;

      // Another browser gets neither the authenticator secret nor a session.
      const stolen = await post("/auth/sign-in/totp/setup", { signInStep: setupToken }, ADMIN_WEB, {
        cookie: null,
      });
      expectError(stolen, 401, "SIGN_IN_STEP_INVALID");
      expect(stolen.body).not.toHaveProperty("secret");
      expect(stolen.body).not.toHaveProperty("otpauthUri");
      const { rows: before } = await db.query<{ totp_secret: string | null }>(
        "SELECT totp_secret FROM sign_in_step WHERE id = $1",
        [setupStepId],
      );
      expect(before[0]!.totp_secret).toBeNull();

      const setup = totpSetupResponseSchema.parse(
        (await post("/auth/sign-in/totp/setup", { signInStep: setupToken }, ADMIN_WEB)).body,
      );
      expectError(
        await post(
          "/auth/sign-in/totp/setup/confirm",
          { signInStep: setupToken, totpCode: nextTotp(setup.secret) },
          ADMIN_WEB,
          { cookie: null },
        ),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      const confirmed = await post(
        "/auth/sign-in/totp/setup/confirm",
        { signInStep: setupToken, totpCode: nextTotp(setup.secret) },
        ADMIN_WEB,
      );
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      refreshCookie(confirmed, "adclub_admin_refresh");
      const { backupCodes } = totpSetupCompletedResponseSchema.parse(confirmed.body);
      for (const code of backupCodes) {
        rememberCode(code, code.replace("-", ""));
      }
      expect(
        setCookies(confirmed).find((cookie) => cookie.startsWith(`adclub_sign_in_${setupStepId}=`)),
      ).toMatch(new RegExp(`^adclub_sign_in_${setupStepId}=;`));

      // Every later sign-in. Refusals of another browser don't count
      // against the administrator's attempt limit and spend nothing.
      // (The setup confirmation above already counted once.)
      await redis.flushall();
      await settings.set({ admin_totp_verify_per_admin: 1 });
      const token = await adminStep(PHONE, "TOTP_REQUIRED");
      const stepId = stepIdOf(token)!;
      const otherTab = await adminStep(PHONE, "TOTP_REQUIRED");
      const code = nextTotp(setup.secret);
      for (const cookie of [
        null,
        stepCookie(otherTab),
        `adclub_sign_in_${stepId}=${stepCookie(otherTab).split("=")[1]}`,
      ]) {
        expectError(
          await post("/auth/sign-in/totp", { signInStep: token, totpCode: code }, ADMIN_WEB, {
            cookie,
          }),
          401,
          "SIGN_IN_STEP_INVALID",
        );
        expectError(
          await post(
            "/auth/sign-in/totp",
            { signInStep: token, backupCode: backupCodes[0] },
            ADMIN_WEB,
            { cookie },
          ),
          401,
          "SIGN_IN_STEP_INVALID",
        );
      }
      const { rows: used } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM admin_backup_code WHERE used_at IS NOT NULL",
      );
      expect(used[0]!.n).toBe(0);

      const verified = await adminVerify(token, { totpCode: code });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      refreshCookie(verified, "adclub_admin_refresh");
      const { rows: sessions } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM session WHERE kind = 'admin_web'",
      );
      expect(sessions[0]!.n).toBe(2);
      expect(output.text()).toContain(
        `Sign-in step refused step=${setupStepId} reason=other_client`,
      );
      expect(output.text()).toContain(`Sign-in step refused step=${stepId} reason=other_client`);
    });

    it("never turns an unfinished second factor step into admin rights", async () => {
      const admin = await setUpAdmin(PHONE);
      const token = await adminStep(PHONE, "TOTP_REQUIRED");
      // The step token is no access token, and no session came out of the code.
      expectError(
        await bearer("get", "/admin/administrators", token, ADMIN_WEB),
        401,
        "AUTH_REQUIRED",
      );
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM session WHERE account_id = $1",
        [admin.accountId],
      );
      expect(rows[0]!.n).toBe(1); // only the one from the setup
      // Briefly usable only.
      await settings.set({ sign_in_admin_totp_ttl_seconds: 1 });
      const late = await adminStep(PHONE, "TOTP_REQUIRED");
      await sleep(1100);
      expectError(
        await adminVerify(late, { totpCode: nextTotp(admin.secret) }),
        401,
        "SIGN_IN_STEP_INVALID",
      );
    });

    it("takes the app's code once, with a step of clock drift, and an unused backup code once", async () => {
      await settings.set({ admin_totp_allowed_drift_steps: 1 });
      const admin = await setUpAdmin(PHONE);
      const setupStep = lastSteps.get(admin.secret)!;

      // The code just used for the setup is not accepted again.
      let token = await adminStep(PHONE, "TOTP_REQUIRED");
      expectError(
        await adminVerify(token, { totpCode: totpCode(admin.secret, setupStep) }),
        400,
        "TOTP_INVALID",
      );
      // Two steps ahead is too far; one step ahead (a fast clock) is fine.
      await freshTotpStep();
      const now = totpStep(Date.now());
      expectError(
        await adminVerify(token, { totpCode: totpCode(admin.secret, now + 2) }),
        400,
        "TOTP_INVALID",
      );
      const ahead = await adminVerify(token, { totpCode: totpCode(admin.secret, now + 1) });
      expect(ahead.status).toBe(200);
      expect(totpVerifiedResponseSchema.parse(ahead.body).backupCodesRemaining).toBe(10);
      refreshCookie(ahead, "adclub_admin_refresh");
      // The same code in its window: refused, also on a new step.
      token = await adminStep(PHONE, "TOTP_REQUIRED");
      expectError(
        await adminVerify(token, { totpCode: totpCode(admin.secret, now + 1) }),
        400,
        "TOTP_INVALID",
      );

      // A backup code, typed loosely, works once.
      const backup = admin.backupCodes[3]!;
      const withBackup = await adminVerify(token, { backupCode: ` ${backup.toUpperCase()} ` });
      expect(withBackup.status).toBe(200);
      expect(totpVerifiedResponseSchema.parse(withBackup.body).backupCodesRemaining).toBe(9);
      refreshCookie(withBackup, "adclub_admin_refresh");
      token = await adminStep(PHONE, "TOTP_REQUIRED");
      expectError(await adminVerify(token, { backupCode: backup }), 400, "TOTP_INVALID");
      expectError(await adminVerify(token, { backupCode: "zzzz-zzzz" }), 400, "TOTP_INVALID");
      expectError(await adminVerify(token, { backupCode: "0000-0000" }), 400, "TOTP_INVALID");
      // Exactly one factor per request.
      const both = await post(
        "/auth/sign-in/totp",
        { signInStep: token, totpCode: "123456", backupCode: backup },
        ADMIN_WEB,
      );
      expectError(both, 400, "VALIDATION_ERROR");

      const log = output.text();
      expect(log).toContain(`Admin second factor failed admin=${admin.adminId} method=totp`);
      expect(log).toContain(`Admin second factor passed admin=${admin.adminId} method=totp`);
      expect(log).toContain(`Admin backup code used admin=${admin.adminId} remaining=9`);
      expect(log).toContain(`Admin second factor failed admin=${admin.adminId} method=backup_code`);
      expect(log).toContain(`Admin sign-in completed admin=${admin.adminId} method=backup_code`);
    });

    it("lets only one of concurrent attempts through: one step, one backup code, two setup tabs", async () => {
      const admin = await setUpAdmin(PHONE);

      // The same step twice at once.
      const token = await adminStep(PHONE, "TOTP_REQUIRED");
      const code = nextTotp(admin.secret);
      const sameStep = await Promise.all([
        adminVerify(token, { totpCode: code }),
        adminVerify(token, { totpCode: code }),
      ]);
      expect(sameStep.map((response) => response.status).sort()).toEqual([200, 401]);

      // One backup code on two steps at once.
      const [first, second] = [
        await adminStep(PHONE, "TOTP_REQUIRED"),
        await adminStep(PHONE, "TOTP_REQUIRED"),
      ];
      const backup = admin.backupCodes[0]!;
      const sameCode = await Promise.all([
        adminVerify(first, { backupCode: backup }),
        adminVerify(second, { backupCode: backup }),
      ]);
      expect(sameCode.map((response) => response.status).sort()).toEqual([200, 400]);

      // Two tabs set up the authenticator of a new administrator at once.
      await operator.grantAdmin(OTHER_PHONE);
      const tabs = [
        await adminStep(OTHER_PHONE, "TOTP_SETUP_REQUIRED"),
        await adminStep(OTHER_PHONE, "TOTP_SETUP_REQUIRED"),
      ];
      const secrets: string[] = [];
      for (const tab of tabs) {
        const setup = totpSetupResponseSchema.parse(
          (await post("/auth/sign-in/totp/setup", { signInStep: tab }, ADMIN_WEB)).body,
        );
        secrets.push(setup.secret);
      }
      expect(secrets[0]).not.toBe(secrets[1]);
      const confirmations = await Promise.all(
        tabs.map((tab, index) =>
          post(
            "/auth/sign-in/totp/setup/confirm",
            { signInStep: tab, totpCode: nextTotp(secrets[index]!) },
            ADMIN_WEB,
          ),
        ),
      );
      expect(confirmations.map((response) => response.status).sort()).toEqual([200, 401]);
      const winner = confirmations.findIndex((response) => response.status === 200);
      // The app that won is the one the server keeps.
      const signedIn = await adminVerify(await adminStep(OTHER_PHONE, "TOTP_REQUIRED"), {
        totpCode: nextTotp(secrets[winner]!),
      });
      expect(signedIn.status).toBe(200);
      expect(output.text()).toContain("reason=totp_already_set_up");
    });

    it("limits second factor attempts, and refuses rather than skips the limit while Redis is down", async () => {
      const admin = await setUpAdmin(PHONE);
      await settings.set({ admin_totp_verify_per_admin: 3 });
      const token = await adminStep(PHONE, "TOTP_REQUIRED");
      // The setup confirmation was the first counted check.
      for (let attempt = 0; attempt < 2; attempt++) {
        expectError(await adminVerify(token, { totpCode: "000000" }), 400, "TOTP_INVALID");
      }
      const limited = await adminVerify(token, { totpCode: "000000" });
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details).toMatchObject({ limit: "admin_totp_per_admin" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      // Even the right code waits now.
      expectError(
        await adminVerify(token, { totpCode: nextTotp(admin.secret) }),
        429,
        "RATE_LIMITED",
      );

      await settings.set({ admin_totp_verify_per_admin: 1000, admin_totp_verify_per_ip: 2 });
      const perIp = await http()
        .post("/auth/sign-in/totp")
        .set("X-Client", ADMIN_WEB)
        .set("X-Forwarded-For", "203.0.113.99")
        .set("Cookie", stepCookie(token))
        .send({ signInStep: token, totpCode: "000000" });
      expectError(perIp, 400, "TOTP_INVALID");
      await http()
        .post("/auth/sign-in/totp")
        .set("X-Forwarded-For", "203.0.113.99")
        .set("Cookie", stepCookie(token))
        .send({ signInStep: token, totpCode: "000000" });
      const ipLimited = await http()
        .post("/auth/sign-in/totp")
        .set("X-Forwarded-For", "203.0.113.99")
        .set("Cookie", stepCookie(token))
        .send({ signInStep: token, totpCode: "000000" });
      expectError(ipLimited, 429, "RATE_LIMITED");
      expect(ipLimited.body.details).toMatchObject({ limit: "admin_totp_per_ip" });
      await settings.set({ admin_totp_verify_per_ip: 1000 });

      await redis.flushall();
      await redisProxy.stop();
      try {
        const code = nextTotp(admin.secret);
        const down = await adminVerify(token, { totpCode: code });
        expectError(down, 503, "SERVICE_UNAVAILABLE");
        expect(down.body.retryable).toBe(true);
        // The session of the administrator still works: access checks don't need Redis.
        expect(
          (await bearer("get", "/admin/administrators", admin.accessToken, ADMIN_WEB)).status,
        ).toBe(200);
      } finally {
        await redisProxy.start();
      }
      await waitForRedis();
      const recovered = await adminVerify(token, { totpCode: nextTotp(admin.secret) });
      expect(recovered.status).toBe(200);
      refreshCookie(recovered, "adclub_admin_refresh");
      const log = output.text();
      expect(log).toContain(
        `Admin second factor rate limit hit limit=admin_totp_per_admin admin=${admin.adminId}`,
      );
      expect(log).toContain("Admin second factor refused: Rate limiter unavailable");
    }, 60_000);

    it("issues a new set of backup codes on the app's code; the previous set stops working", async () => {
      const admin = await setUpAdmin(PHONE);
      const regenerate = (totp: string) =>
        bearer("post", "/admin/totp/backup-codes", admin.accessToken, ADMIN_WEB, {
          totpCode: totp,
        });
      expectError(await regenerate("000000"), 400, "TOTP_INVALID");
      const response = await regenerate(nextTotp(admin.secret));
      expect(response.status).toBe(200);
      const fresh = response.body.backupCodes as string[];
      for (const code of fresh) {
        rememberCode(code, code.replace("-", ""));
      }
      expect(fresh).toHaveLength(10);
      expect(fresh.some((code) => admin.backupCodes.includes(code))).toBe(false);

      const token = await adminStep(PHONE, "TOTP_REQUIRED");
      expectError(
        await adminVerify(token, { backupCode: admin.backupCodes[0]! }),
        400,
        "TOTP_INVALID",
      );
      const withNew = await adminVerify(token, { backupCode: fresh[0]! });
      expect(withNew.status).toBe(200);
      expect(withNew.body.backupCodesRemaining).toBe(9);
      refreshCookie(withNew, "adclub_admin_refresh");
      // Other contexts can't ask for it.
      const mobile = await mobileSession(PHONE);
      expectError(
        await bearer("post", "/admin/totp/backup-codes", mobile, IOS, { totpCode: "123456" }),
        403,
        "FORBIDDEN",
      );
      expect(output.text()).toContain(
        `Admin backup codes regenerated admin=${admin.adminId} count=10`,
      );
    });
  });

  describe("resets and the operator command", () => {
    it("lets another administrator reset the second factor: sessions end, setup is due again", async () => {
      const a = await setUpAdmin(PHONE);
      const b = await setUpAdmin(OTHER_PHONE);
      const bSecond = await adminSignIn(b);
      const bMobile = await mobileSession(OTHER_PHONE);
      const pending = await adminStep(OTHER_PHONE, "TOTP_REQUIRED");

      // Not oneself.
      const self = await bearer(
        "post",
        `/admin/administrators/${a.adminId}/totp-reset`,
        a.accessToken,
        ADMIN_WEB,
      );
      expectError(self, 403, "TOTP_SELF_RESET_FORBIDDEN");
      // Not someone who isn't an administrator.
      expectError(
        await bearer(
          "post",
          `/admin/administrators/${randomUUID()}/totp-reset`,
          a.accessToken,
          ADMIN_WEB,
        ),
        404,
        "NOT_FOUND",
      );
      // Not from another context.
      expectError(
        await bearer("post", `/admin/administrators/${b.adminId}/totp-reset`, bMobile, IOS),
        403,
        "FORBIDDEN",
      );

      const reset = await bearer(
        "post",
        `/admin/administrators/${b.adminId}/totp-reset`,
        a.accessToken,
        ADMIN_WEB,
      );
      expect(reset.status).toBe(200);
      expect(reset.body).toEqual({ sessionsEnded: 2 });
      for (const session of [b, bSecond]) {
        expectError(
          await bearer("get", "/admin/administrators", session.accessToken, ADMIN_WEB),
          401,
          "SESSION_ENDED",
        );
        expectError(await cookieRefresh(ADMIN_ORIGIN, session.cookie), 401, "SESSION_ENDED");
        expect(await sessionRow(session.sessionId)).toMatchObject({ revoked_reason: "totp_reset" });
      }
      // The step begun before the reset is useless; old codes too.
      expectError(
        await adminVerify(pending, { totpCode: nextTotp(b.secret) }),
        401,
        "SIGN_IN_STEP_INVALID",
      );
      await adminStep(OTHER_PHONE, "TOTP_SETUP_REQUIRED");
      const { rows } = await db.query(
        "SELECT totp_secret, (SELECT count(*)::int FROM admin_backup_code WHERE admin_user_id = $1 AND revoked_at IS NULL) AS codes FROM admin_user WHERE id = $1",
        [b.adminId],
      );
      expect(rows).toEqual([{ totp_secret: null, codes: 0 }]);
      // A's own session and B's app session go on.
      expect((await bearer("get", "/admin/administrators", a.accessToken, ADMIN_WEB)).status).toBe(
        200,
      );
      expect((await bearer("get", "/auth/me", bMobile, IOS)).status).toBe(200);
      const list = await bearer("get", "/admin/administrators", a.accessToken, ADMIN_WEB);
      expect(list.body.administrators).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: b.adminId, totpConfigured: false, current: false }),
        ]),
      );

      const log = output.text();
      expect(log).toContain(`Admin TOTP reset refused: own second factor admin=${a.adminId}`);
      expect(log).toContain(
        `Admin TOTP reset admin=${b.adminId} by=admin:${a.adminId} sessionsEnded=2`,
      );
      expect(log).toContain(
        `Session ended session=${b.sessionId} account=${b.accountId} reason=totp_reset`,
      );
    });

    it("resets the only administrator's second factor through the operator command", async () => {
      const only = await setUpAdmin(PHONE);
      const result = await operator.resetAdminTotp("8 701 123 45 67");
      expect(result).toEqual({ adminId: only.adminId, sessionsEnded: 1, onlyAdministrator: true });
      expectError(
        await bearer("get", "/admin/administrators", only.accessToken, ADMIN_WEB),
        401,
        "SESSION_ENDED",
      );
      await adminStep(PHONE, "TOTP_SETUP_REQUIRED");
      expect(output.text()).toContain(
        `Admin TOTP reset admin=${only.adminId} by=operator phone=${MASKED} sessionsEnded=1 onlyAdministrator=true`,
      );
    });

    it("appoints administrators only through the operator command", async () => {
      const admin = await setUpAdmin(PHONE);
      // No route of the contract appoints anyone.
      const operations = Object.values(apiRoutes).filter((route) =>
        route.path.startsWith("/admin"),
      );
      expect(operations.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
        "DELETE /admin/catalog/items/{itemId}/analogs/{analogItemId}",
        "GET /admin/administrators",
        "GET /admin/audit-log",
        "GET /admin/catalog/brands",
        "GET /admin/catalog/categories",
        "GET /admin/catalog/categories/{categoryId}/attributes",
        "GET /admin/catalog/categories/{categoryId}/fill",
        "GET /admin/catalog/items",
        "GET /admin/catalog/items/{itemId}",
        "GET /admin/catalog/items/{itemId}/compatibility",
        "GET /admin/catalog/items/{itemId}/photos",
        "GET /admin/cities",
        "GET /admin/compatibility-proposals",
        "GET /admin/settings",
        "GET /admin/settings/{key}/history",
        "GET /admin/supplier-leads",
        "GET /admin/supplier-leads/{leadId}",
        "GET /admin/suppliers",
        "GET /admin/suppliers/{supplierId}",
        "GET /admin/suppliers/{supplierId}/members",
        "GET /admin/suppliers/{supplierId}/offers",
        "GET /admin/suppliers/{supplierId}/sessions",
        "GET /admin/translations",
        "GET /admin/translations/{entityType}/{entityId}",
        "GET /admin/vehicles/engines",
        "GET /admin/vehicles/generations",
        "GET /admin/vehicles/import-template",
        "GET /admin/vehicles/imports",
        "GET /admin/vehicles/imports/{importId}",
        "GET /admin/vehicles/imports/{importId}/rows",
        "GET /admin/vehicles/makes",
        "GET /admin/vehicles/models",
        "GET /admin/vehicles/modifications",
        "GET /admin/vehicles/options",
        "PATCH /admin/catalog/attribute-options/{optionId}",
        "PATCH /admin/catalog/attributes/{attributeId}",
        "PATCH /admin/catalog/brands/{brandId}",
        "PATCH /admin/catalog/categories/{categoryId}",
        "PATCH /admin/catalog/compatibility/{recordId}",
        "PATCH /admin/catalog/items/{itemId}",
        "PATCH /admin/cities/{cityId}",
        "PATCH /admin/supplier-leads/{leadId}",
        "PATCH /admin/suppliers/{supplierId}",
        "PATCH /admin/vehicles/engines/{engineId}",
        "PATCH /admin/vehicles/generations/{generationId}",
        "PATCH /admin/vehicles/makes/{makeId}",
        "PATCH /admin/vehicles/models/{modelId}",
        "PATCH /admin/vehicles/modifications/{modificationId}",
        "PATCH /admin/vehicles/options/{optionId}",
        "POST /admin/administrators/{adminId}/totp-reset",
        "POST /admin/catalog/attribute-options/{optionId}/status",
        "POST /admin/catalog/attributes/{attributeId}/options",
        "POST /admin/catalog/attributes/{attributeId}/status",
        "POST /admin/catalog/brands",
        "POST /admin/catalog/brands/{brandId}/status",
        "POST /admin/catalog/categories",
        "POST /admin/catalog/categories/{categoryId}/attributes",
        "POST /admin/catalog/categories/{categoryId}/status",
        "POST /admin/catalog/compatibility/{recordId}/archive",
        "POST /admin/catalog/items",
        "POST /admin/catalog/items/{itemId}/analogs",
        "POST /admin/catalog/items/{itemId}/compatibility",
        "POST /admin/catalog/items/{itemId}/compatibility/copy",
        "POST /admin/catalog/items/{itemId}/photos",
        "POST /admin/catalog/items/{itemId}/photos/{photoId}/status",
        "POST /admin/catalog/items/{itemId}/status",
        "POST /admin/cities",
        "POST /admin/cities/{cityId}/status",
        "POST /admin/compatibility-proposals/{proposalId}/approve",
        "POST /admin/compatibility-proposals/{proposalId}/reject",
        "POST /admin/settings/{key}/reset",
        "POST /admin/supplier-leads",
        "POST /admin/supplier-leads/{leadId}/notes",
        "POST /admin/supplier-leads/{leadId}/onboard",
        "POST /admin/supplier-leads/{leadId}/status",
        "POST /admin/suppliers",
        "POST /admin/suppliers/{supplierId}/block",
        "POST /admin/suppliers/{supplierId}/members",
        "POST /admin/suppliers/{supplierId}/members/{memberId}/contact-person",
        "POST /admin/suppliers/{supplierId}/members/{memberId}/invitations",
        "POST /admin/suppliers/{supplierId}/members/{memberId}/restore",
        "POST /admin/suppliers/{supplierId}/pause",
        "POST /admin/suppliers/{supplierId}/sessions/end",
        "POST /admin/suppliers/{supplierId}/sessions/{sessionId}/end",
        "POST /admin/suppliers/{supplierId}/verification",
        "POST /admin/totp/backup-codes",
        "POST /admin/translations/{entityType}/{entityId}/{field}/{lang}/release",
        "POST /admin/translations/{entityType}/{entityId}/{field}/{lang}/retranslate",
        "POST /admin/vehicles/engines",
        "POST /admin/vehicles/engines/{engineId}/status",
        "POST /admin/vehicles/generations",
        "POST /admin/vehicles/generations/{generationId}/status",
        "POST /admin/vehicles/imports",
        "POST /admin/vehicles/imports/{importId}/apply",
        "POST /admin/vehicles/imports/{importId}/cancel",
        "POST /admin/vehicles/makes",
        "POST /admin/vehicles/makes/{makeId}/status",
        "POST /admin/vehicles/models",
        "POST /admin/vehicles/models/{modelId}/status",
        "POST /admin/vehicles/modifications",
        "POST /admin/vehicles/modifications/{modificationId}/status",
        "POST /admin/vehicles/options",
        "POST /admin/vehicles/options/{optionId}/status",
        "PUT /admin/catalog/attributes/{attributeId}/options/order",
        "PUT /admin/catalog/categories/order",
        "PUT /admin/catalog/categories/{categoryId}/attributes/order",
        "PUT /admin/catalog/categories/{categoryId}/fill",
        "PUT /admin/catalog/items/{itemId}/photos/order",
        "PUT /admin/catalog/items/{itemId}/values",
        "PUT /admin/cities/order",
        "PUT /admin/settings/{key}",
        "PUT /admin/suppliers/{supplierId}/schedule",
        "PUT /admin/translations/{entityType}/{entityId}/{field}/{lang}",
      ]);
      // The list only reads (405 names what it takes, TASK-009.A); an
      // administrator by id has no route at all.
      const appoint = await bearer("post", "/admin/administrators", admin.accessToken, ADMIN_WEB, {
        phone: THIRD_PHONE,
      });
      expectError(appoint, 405, "METHOD_NOT_ALLOWED");
      expect(appoint.headers.allow).toBe("GET, HEAD");
      const byId = await bearer(
        "post",
        `/admin/administrators/${admin.adminId}`,
        admin.accessToken,
        ADMIN_WEB,
        { phone: THIRD_PHONE },
      );
      expectError(byId, 404, "NOT_FOUND");
      expect(await tableCount("admin_user")).toBe(1);

      // The command: a number without an account gets one; twice is harmless.
      const granted = await operator.grantAdmin(THIRD_PHONE);
      expect(granted.outcome).toBe("created");
      expect((await operator.grantAdmin(THIRD_PHONE)).outcome).toBe("already_active");
      await expect(operator.revokeAdmin("+77059999999")).rejects.toThrow(OperatorCommandError);
      await expect(operator.grantAdmin("12345")).rejects.toThrow(OperatorCommandError);
      await operator.revokeAdmin(THIRD_PHONE);
      expect((await operator.grantAdmin(THIRD_PHONE)).outcome).toBe("restored");
      const log = output.text();
      expect(log).toContain(`Operator: administrator appointed admin=${granted.adminId}`);
      expect(log).toContain("outcome=created");
      expect(log).toContain(`Account created account=`);
      expect(log).toContain("by=operator");
      expect(log).toContain("Operator: administrator removed");
    });

    it("manages companies and employees only in development and tests", async () => {
      const supplierId = await company("Альфа");
      await employ(supplierId, PHONE);
      config.nodeEnv = "staging";
      try {
        await expect(operator.createSupplier({ name: "X", city: "Y" })).rejects.toThrow(
          /development and tests only/,
        );
        await expect(
          operator.addMember({ supplierId, phone: OTHER_PHONE, displayName: "Z" }),
        ).rejects.toThrow(/development and tests only/);
      } finally {
        config.nodeEnv = "test";
      }
      await expect(
        operator.addMember({ supplierId: randomUUID(), phone: PHONE, displayName: "Z" }),
      ).rejects.toThrow(/No such company/);
      await expect(operator.removeMember(randomUUID())).rejects.toThrow(/No such active employee/);
      expect(output.text()).toContain(`Operator: company created supplier=${supplierId}`);
      expect(output.text()).toContain(`Operator: employee added supplier=${supplierId}`);
    });
  });

  describe("logs", () => {
    it("carry masked numbers only and none of the secrets this suite handled", () => {
      expect(rememberedSecrets().size).toBeGreaterThan(50);
      expect(rememberedCodes().size).toBeGreaterThan(50);
      // Every secret and code: the output capture (testing/output-capture.ts) after this file.
      const logged = appLogText();
      expect(logged).toContain("Admin TOTP set up");
      expect(allOutput()).not.toContain("otpauth://");
      for (const digits of ["77011234567", "7011234567", "77471112233", "77051234000"]) {
        expect(logged).not.toContain(digits);
      }
    });
  });
});
