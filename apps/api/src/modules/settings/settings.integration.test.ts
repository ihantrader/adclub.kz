import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  apiErrorResponseSchema,
  clientPolicyResponseSchema,
  loginCodeVerifiedResponseSchema,
  settingChangedResponseSchema,
  settingHistoryResponseSchema,
  settingListResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  totpVerifiedResponseSchema,
  type ErrorCode,
  type Setting,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import tsxPackage from "tsx/package.json";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { ApiException } from "../../common/errors";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { TRUNCATE_ALL } from "../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../testing/output-capture";
import { TcpProxy } from "../../testing/tcp-proxy";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { OperatorService } from "../identity";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../identity";
import { AppSettings, SettingsChangeService } from ".";

/**
 * TASK-007 end to end: settings over the admin API and the operator
 * command, their history, conflicts and checks, the sign-in security
 * settings only the operator changes, changes reaching another process
 * (a worker context) without a restart, the client policy with the admin
 * panel that can't lock itself out, broken stored values, and PostgreSQL
 * going away. Real PostgreSQL (behind a proxy the tests can stop) and Redis.
 */

const ADMIN_PHONE = "+77011234567";
const ADMIN_MASKED = "+7***4567";
const USER_PHONE = "+77471112233";
const SUPPLIER_PHONE = "+77051234000";
const ADMIN_WEB = "admin-web/0.1.0";
const OLD_ADMIN_WEB = "admin-web/0.0.9";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
/** Short cache lifetime so a change made in another process shows up quickly. */
const CACHE_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const TSX_CLI = resolve(dirname(require.resolve("tsx/package.json")), tsxPackage.bin);
const OPERATOR_ENTRY = resolve(__dirname, "..", "..", "operator.ts");

interface Admin {
  adminId: string;
  secret: string;
  accessToken: string;
}

describe("settings (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let postgresProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let databaseUrl: string;
  let app: INestApplication;
  /** Another process: the worker, with its own settings cache. */
  let worker: INestApplicationContext;
  let channels: TestLoginCodeChannels;
  let ipCounter = 0;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let output: ReturnType<typeof captureOutput>;

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
    ]);
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    redis = new Redis(redisContainer.getConnectionUrl());
    postgresProxy = new TcpProxy(postgres.getHost(), postgres.getPort());
    await postgresProxy.start();
    const proxied = new URL(postgres.getConnectionUri());
    proxied.hostname = "127.0.0.1";
    proxied.port = String(postgresProxy.port);
    databaseUrl = proxied.toString();

    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
      ADMIN_WEB_RELEASE_VERSION: "0.1.0",
    });
    const cache = { maxAgeMs: CACHE_MS, retryAfterFailureMs: 200 };
    const nestApp = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: cache }),
      { bufferLogs: true },
    );
    nestApp.useLogger(nestApp.get(JsonLoggerService));
    nestApp.flushLogs();
    configureHttpApp(nestApp, config);
    await nestApp.init();
    app = nestApp;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;

    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: cache }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    await postgresProxy?.stop();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await db.query(TRUNCATE_ALL);
    await Promise.all([app.get(AppSettings).refresh(), worker.get(AppSettings).refresh()]);
    await operatorSet({
      login_code_requests_per_phone: 10_000,
      login_code_requests_per_ip: 10_000,
      login_code_verifications_per_phone: 10_000,
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

  /** A change by the operator command's path in the API process (applies here at once). */
  async function operatorSet(values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await app.get(SettingsChangeService).change({
        key,
        value,
        expectedVersion: undefined,
        reason: "integration test",
        actor: { kind: "operator" },
      });
    }
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

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
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .send({ phone, code });
    remember(response.body);
    const cookies = ([] as string[]).concat(response.headers["set-cookie"] ?? []);
    for (const cookie of cookies) {
      const match = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(cookie);
      if (match) {
        rememberSecret(match[2]!);
        stepCookies.set(match[1]!, `adclub_sign_in_${match[1]}=${match[2]}`);
      }
      const refresh = /^adclub_(?:admin|supplier)_refresh=([^;]+)/.exec(cookie);
      if (refresh) {
        rememberSecret(refresh[1]!);
      }
    }
    return response;
  }

  function stepPost(path: string, body: { signInStep: string }, client: string): Test {
    const stepId = /^st1\.([0-9a-f-]{36})\./.exec(body.signInStep)?.[1] ?? "";
    return http()
      .post(path)
      .set("X-Client", client)
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

  async function adminStep(client: string, expected: ErrorCode): Promise<string> {
    const response = await signIn(ADMIN_PHONE, client);
    expectError(response, 403, expected);
    return totpStepRequiredDetailsSchema.parse(response.body.details).signInStep.token;
  }

  async function setUpAdmin(client = ADMIN_WEB): Promise<Admin> {
    const { adminId } = await app.get(OperatorService).grantAdmin(ADMIN_PHONE);
    const token = await adminStep(client, "TOTP_SETUP_REQUIRED");
    const setupResponse = await stepPost("/auth/sign-in/totp/setup", { signInStep: token }, client);
    remember(setupResponse.body);
    const setup = totpSetupResponseSchema.parse(setupResponse.body);
    const confirmed = await stepPost(
      "/auth/sign-in/totp/setup/confirm",
      { signInStep: token, totpCode: nextCode(setup.secret) } as { signInStep: string },
      client,
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return { adminId, secret: setup.secret, accessToken: body.session.accessToken };
  }

  async function adminSignIn(admin: Admin, client: string): Promise<string> {
    const token = await adminStep(client, "TOTP_REQUIRED");
    const response = await stepPost(
      "/auth/sign-in/totp",
      { signInStep: token, totpCode: nextCode(admin.secret) } as { signInStep: string },
      client,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    remember(response.body);
    return totpVerifiedResponseSchema.parse(response.body).session.accessToken;
  }

  function asAdmin(
    method: "get" | "put" | "post",
    path: string,
    accessToken: string,
    body?: object,
    client = ADMIN_WEB,
  ): Test {
    const call = http()
      [method](path)
      .set("X-Client", client)
      .set("Authorization", `Bearer ${accessToken}`);
    return body ? call.send(body) : call;
  }

  async function listed(accessToken: string, key: string): Promise<Setting> {
    const response = await asAdmin("get", "/admin/settings", accessToken);
    expect(response.status).toBe(200);
    const setting = settingListResponseSchema
      .parse(response.body)
      .groups.flatMap((group) => group.settings)
      .find((candidate) => candidate.key === key);
    if (!setting) {
      throw new Error(`${key} is not listed`);
    }
    return setting;
  }

  async function storedKeys(): Promise<string[]> {
    const { rows } = await db.query<{ key: string }>("SELECT key FROM app_setting ORDER BY key");
    return rows.map((row) => row.key);
  }

  async function historyCount(key: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app_setting_change WHERE key = $1",
      [key],
    );
    return rows[0]!.n;
  }

  /** Runs the real operator command (`pnpm --filter api operator …`) against the test database. */
  async function operatorCommand(
    ...args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [TSX_CLI, OPERATOR_ENTRY, ...args],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            LOG_LEVEL: "warn",
            DATABASE_URL: postgres.getConnectionUri(),
            REDIS_URL: redisContainer.getConnectionUrl(),
            S3_ENDPOINT: "http://127.0.0.1:3",
            S3_ACCESS_KEY: "x",
            S3_SECRET_KEY: "x",
            S3_BUCKET: "x",
            ADMIN_WEB_RELEASE_VERSION: "0.1.0",
          },
          encoding: "utf8",
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  describe("admin API", () => {
    it("lists every setting by group with what the admin panel needs to show", async () => {
      const admin = await setUpAdmin();
      const response = await asAdmin("get", "/admin/settings", admin.accessToken);
      expect(response.status).toBe(200);
      const { groups } = settingListResponseSchema.parse(response.body);
      expect(groups.map((group) => group.id)).toEqual([
        "orders",
        "notifications",
        "guest_assistant",
        "rating",
        "pricelist",
        "reviews",
        "photos",
        "billing",
        "clients",
        "cleanup",
        "login_code",
        "session",
        "sign_in",
      ]);
      const all = groups.flatMap((group) => group.settings);
      expect(all.length).toBeGreaterThan(80);
      expect(all.find((setting) => setting.key === "supplier_response_hours")).toEqual({
        key: "supplier_response_hours",
        group: "orders",
        type: "duration",
        unit: "hours",
        description: expect.stringContaining("поставщик"),
        constraints: { min: 1, max: 48 },
        defaultValue: 2,
        value: 2,
        isDefault: true,
        storedValueInvalid: false,
        version: 0,
        editableBy: "admin",
        lastChange: null,
      });
      expect(all.find((setting) => setting.key === "client_min_version_admin_web")).toMatchObject({
        type: "app_version",
        constraints: { maxVersion: "0.1.0" },
      });
      expect(
        all.find((setting) => setting.key === "guest_limits")?.constraints.schema,
      ).toMatchObject({ type: "object", additionalProperties: false });
      // Set in beforeEach through the operator path.
      expect(all.find((setting) => setting.key === "login_code_requests_per_phone")).toMatchObject({
        editableBy: "operator",
        value: 10_000,
        isDefault: false,
        version: 1,
        lastChange: { action: "set", by: { kind: "operator" } },
      });
    });

    it("changes a threshold with a reason: was → now, who and when, history, reset", async () => {
      const admin = await setUpAdmin();
      const before = await listed(admin.accessToken, "assistant_daily_dialogs_per_user");
      expect(before).toMatchObject({ value: 20, isDefault: true, version: 0 });

      const changed = await asAdmin(
        "put",
        "/admin/settings/assistant_daily_dialogs_per_user",
        admin.accessToken,
        { value: 5, expectedVersion: 0, reason: "  Бюджет ИИ на неделю  " },
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      const body = settingChangedResponseSchema.parse(changed.body);
      const by = { kind: "admin", adminId: admin.adminId, phoneMasked: ADMIN_MASKED };
      expect(body.change).toMatchObject({
        key: "assistant_daily_dialogs_per_user",
        version: 1,
        action: "set",
        previousValue: 20,
        previousIsDefault: true,
        newValue: 5,
        newIsDefault: false,
        reason: "Бюджет ИИ на неделю",
        by,
      });
      expect(Date.now() - Date.parse(body.change.at)).toBeLessThan(10_000);
      expect(body.setting).toMatchObject({ value: 5, isDefault: false, version: 1 });

      const now = await listed(admin.accessToken, "assistant_daily_dialogs_per_user");
      expect(now).toMatchObject({
        value: 5,
        version: 1,
        lastChange: { action: "set", by, at: body.change.at },
      });
      // This process applies it at once.
      expect(await app.get(AppSettings).get("assistant_daily_dialogs_per_user")).toBe(5);

      const reset = await asAdmin(
        "post",
        "/admin/settings/assistant_daily_dialogs_per_user/reset",
        admin.accessToken,
        { expectedVersion: 1, reason: "Вернули как было" },
      );
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(settingChangedResponseSchema.parse(reset.body)).toMatchObject({
        setting: { value: 20, isDefault: true, version: 2 },
        change: {
          action: "reset",
          previousValue: 5,
          previousIsDefault: false,
          newValue: 20,
          newIsDefault: true,
        },
      });
      expect(await storedKeys()).not.toContain("assistant_daily_dialogs_per_user");

      const history = await asAdmin(
        "get",
        "/admin/settings/assistant_daily_dialogs_per_user/history",
        admin.accessToken,
      );
      expect(history.status).toBe(200);
      const { changes } = settingHistoryResponseSchema.parse(history.body);
      expect(changes.map((change) => [change.version, change.action, change.reason])).toEqual([
        [2, "reset", "Вернули как было"],
        [1, "set", "Бюджет ИИ на неделю"],
      ]);
      expect(changes.every((change) => change.by.kind === "admin")).toBe(true);

      const log = output.text();
      expect(log).toContain(
        `Setting changed key=assistant_daily_dialogs_per_user version=1 by=admin:${admin.adminId} from=20 to=5`,
      );
      expect(log).toContain(
        `Setting reset key=assistant_daily_dialogs_per_user version=2 by=admin:${admin.adminId} from=5 to=20`,
      );
    });

    it("refuses a wrong type, an out-of-range value, an unknown key or no reason, recording nothing", async () => {
      const admin = await setUpAdmin();
      const put = (key: string, body: object) =>
        asAdmin("put", `/admin/settings/${key}`, admin.accessToken, body);
      const reason = "Проверка";

      const wrongType = await put("assistant_daily_dialogs_per_user", {
        value: "5",
        expectedVersion: 0,
        reason,
      });
      expectError(wrongType, 400, "VALIDATION_ERROR");
      expect(wrongType.body.details).toEqual([
        { path: "value", message: expect.stringContaining("number") },
      ]);
      const tooBig = await put("assistant_daily_dialogs_per_user", {
        value: 1001,
        expectedVersion: 0,
        reason,
      });
      expectError(tooBig, 400, "VALIDATION_ERROR");
      expect(tooBig.body.details[0].message).toContain("1000");
      expectError(
        await put("guest_limits", {
          value: { photo_recognitions: 1, voice_requests: 1 },
          expectedVersion: 0,
          reason,
        }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await put("guest_limits", {
          value: { photo_recognitions: 1, voice_requests: 1, assistant_dialogs: 1, extra: 1 },
          expectedVersion: 0,
          reason,
        }),
        400,
        "VALIDATION_ERROR",
      );
      const emptyLanguage = await put("client_update_message", {
        value: { kk: "", ru: "Обновите", en: "Update" },
        expectedVersion: 0,
        reason,
      });
      expectError(emptyLanguage, 400, "VALIDATION_ERROR");
      expect(emptyLanguage.body.details[0].path).toBe("value.kk");
      expectError(
        await put("assistant_daily_dialogs_per_user", { expectedVersion: 0, reason }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await put("assistant_daily_dialogs_per_user", {
          value: 5,
          expectedVersion: 0,
          reason: " ",
        }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await put("assistant_daily_dialogs_per_user", { value: 5, reason }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await put("no_such_setting", { value: 5, expectedVersion: 0, reason }),
        404,
        "NOT_FOUND",
      );
      expectError(
        await put("Bad-Key", { value: 5, expectedVersion: 0, reason }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("get", "/admin/settings/no_such_setting/history", admin.accessToken),
        404,
        "NOT_FOUND",
      );

      for (const key of [
        "assistant_daily_dialogs_per_user",
        "guest_limits",
        "client_update_message",
      ]) {
        expect(await historyCount(key)).toBe(0);
      }
      expect(await storedKeys()).not.toContain("assistant_daily_dialogs_per_user");
      expect(output.text()).toContain(
        "Setting change refused key=assistant_daily_dialogs_per_user",
      );
    });

    it("gives one of two changes made from the same version, the other a conflict", async () => {
      const admin = await setUpAdmin();
      const responses = await Promise.all(
        [3, 4].map((value) =>
          asAdmin("put", "/admin/settings/rating_min_reviews", admin.accessToken, {
            value,
            expectedVersion: 0,
            reason: `Поставить ${value}`,
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const loser = responses.find((response) => response.status === 409)!;
      const winner = responses.find((response) => response.status === 200)!;
      expectError(loser, 409, "SETTING_VERSION_CONFLICT");
      expect(loser.body.details).toEqual({ currentVersion: 1 });
      const value = settingChangedResponseSchema.parse(winner.body).change.newValue;
      expect((await listed(admin.accessToken, "rating_min_reviews")).value).toBe(value);
      expect(await historyCount("rating_min_reviews")).toBe(1);

      // A reset from a stale version is refused too.
      expectError(
        await asAdmin("post", "/admin/settings/rating_min_reviews/reset", admin.accessToken, {
          expectedVersion: 0,
          reason: "Сброс",
        }),
        409,
        "SETTING_VERSION_CONFLICT",
      );
      expect((await listed(admin.accessToken, "rating_min_reviews")).value).toBe(value);
      expect(output.text()).toContain("reason=version_conflict expectedVersion=0 currentVersion=1");
    });

    it("keeps the history append-only and offers no route to edit it", async () => {
      await operatorSet({ rating_min_reviews: 7 });
      await expect(db.query("UPDATE app_setting_change SET reason = 'x'")).rejects.toThrow(
        /append-only/,
      );
      await expect(db.query("DELETE FROM app_setting_change")).rejects.toThrow(/append-only/);
      const admin = await setUpAdmin();
      for (const method of ["put", "post"] as const) {
        const response = await asAdmin(
          method,
          "/admin/settings/rating_min_reviews/history",
          admin.accessToken,
          {},
        );
        expectError(response, 404, "NOT_FOUND");
      }
      expect(await historyCount("rating_min_reviews")).toBe(1);
    });

    it("is closed to mobile and cabinet sessions and to callers without a session", async () => {
      const mobile = loginCodeVerifiedResponseSchema.parse((await signIn(USER_PHONE, IOS)).body);
      const operator = app.get(OperatorService);
      const { supplierId } = await operator.createSupplier({ name: "Альфа", city: "Алматы" });
      await operator.addMember({ supplierId, phone: SUPPLIER_PHONE, displayName: "Айгерим" });
      const cabinetResponse = await signIn(SUPPLIER_PHONE, SUPPLIER_WEB);
      expect(cabinetResponse.status).toBe(200);
      const cabinet = loginCodeVerifiedResponseSchema.parse(cabinetResponse.body);

      const calls: [method: "get" | "put" | "post", path: string, body?: object][] = [
        ["get", "/admin/settings"],
        [
          "put",
          "/admin/settings/rating_min_reviews",
          { value: 1, expectedVersion: 0, reason: "Попытка" },
        ],
        [
          "post",
          "/admin/settings/rating_min_reviews/reset",
          { expectedVersion: 0, reason: "Попытка" },
        ],
        ["get", "/admin/settings/rating_min_reviews/history"],
      ];
      for (const [method, path, body] of calls) {
        for (const [token, client] of [
          [mobile.session.accessToken, IOS],
          [cabinet.session.accessToken, SUPPLIER_WEB],
        ] as const) {
          expectError(await asAdmin(method, path, token, body, client), 403, "FORBIDDEN");
        }
        const anonymous = http()[method](path).set("X-Client", ADMIN_WEB);
        expectError(await (body ? anonymous.send(body) : anonymous), 401, "AUTH_REQUIRED");
      }
      expect(await storedKeys()).not.toContain("rating_min_reviews");
      expect(output.text()).toContain("Access refused: context not allowed");
    });
  });

  describe("sign-in security settings (D-053)", () => {
    it("are refused through the API, changed by the operator, and apply without a restart", async () => {
      const admin = await setUpAdmin();
      for (const key of [
        "login_code_requests_per_phone",
        "session_admin_web_ttl_seconds",
        "sign_in_admin_totp_ttl_seconds",
        "admin_totp_allowed_drift_steps",
        "admin_backup_code_count",
      ]) {
        const setting = await listed(admin.accessToken, key);
        expect(setting.editableBy, key).toBe("operator");
        const changed = await asAdmin("put", `/admin/settings/${key}`, admin.accessToken, {
          value: 1,
          expectedVersion: setting.version,
          reason: "Попытка",
        });
        expectError(changed, 403, "SETTING_OPERATOR_ONLY");
        expectError(
          await asAdmin("post", `/admin/settings/${key}/reset`, admin.accessToken, {
            expectedVersion: setting.version,
            reason: "Попытка",
          }),
          403,
          "SETTING_OPERATOR_ONLY",
        );
        // History is still readable.
        expect(
          (await asAdmin("get", `/admin/settings/${key}/history`, admin.accessToken)).status,
        ).toBe(200);
      }
      expect(await historyCount("session_admin_web_ttl_seconds")).toBe(0);
      expect(output.text()).toContain(
        `Setting change refused key=login_code_requests_per_phone by=admin:${admin.adminId} reason=operator_only`,
      );

      // The operator, from another process (its own settings cache):
      const requestCode = (phone: string) =>
        http().post("/auth/login-code").set("X-Forwarded-For", nextIp()).send({ phone });
      await worker.get(SettingsChangeService).change({
        key: "login_code_resend_interval_seconds",
        value: 1,
        expectedVersion: undefined,
        reason: "Проверка лимита",
        actor: { kind: "operator" },
      });
      await sleep(CACHE_MS + 100);
      expect((await requestCode(USER_PHONE)).status).toBe(200);

      await worker.get(SettingsChangeService).change({
        key: "login_code_requests_per_phone",
        value: 1,
        expectedVersion: 1,
        reason: "Один код в час",
        actor: { kind: "operator" },
      });
      await sleep(CACHE_MS + 100);
      const limited = await requestCode(USER_PHONE);
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details).toMatchObject({ limit: "login_code_requests_per_phone" });

      const history = settingHistoryResponseSchema.parse(
        (
          await asAdmin(
            "get",
            "/admin/settings/login_code_requests_per_phone/history",
            admin.accessToken,
          )
        ).body,
      );
      expect(history.changes[0]).toMatchObject({
        version: 2,
        previousValue: 10_000,
        newValue: 1,
        reason: "Один код в час",
        by: { kind: "operator" },
      });
    });

    it("never apply a stored value beyond the hard limits", async () => {
      await db.query(
        `INSERT INTO app_setting (key, value, version, updated_by_kind) VALUES
          ('session_admin_web_ttl_seconds', '86400', 1, 'operator'),
          ('sign_in_admin_totp_ttl_seconds', '7200', 1, 'operator')`,
      );
      await app.get(AppSettings).refresh();
      const admin = await setUpAdmin();
      const token = await adminStep(ADMIN_WEB, "TOTP_REQUIRED");
      const response = await stepPost(
        "/auth/sign-in/totp",
        { signInStep: token, totpCode: nextCode(admin.secret) } as { signInStep: string },
        ADMIN_WEB,
      );
      remember(response.body);
      const session = totpVerifiedResponseSchema.parse(response.body).session;
      expect(Date.parse(session.sessionExpiresAt) - Date.now()).toBeLessThanOrEqual(
        12 * 3600 * 1000,
      );
      const { rows } = await db.query<{ ttl: number }>(
        "SELECT extract(epoch FROM expires_at - created_at)::int AS ttl FROM sign_in_step ORDER BY created_at DESC LIMIT 1",
      );
      expect(rows[0]!.ttl).toBeLessThanOrEqual(600);
      // The operator can't store them either.
      await expect(operatorSet({ session_admin_web_ttl_seconds: 43_201 })).rejects.toThrow(
        ApiException,
      );
    });
  });

  describe("client policy", () => {
    it("changes without a restart; the admin panel minimum can't pass the current release", async () => {
      const admin = await setUpAdmin();
      const android = (client: string) => http().get("/ready").set("X-Client", client);
      expect((await android("mobile/1.5.0 (android)")).status).not.toBe(426);

      const raised = await asAdmin(
        "put",
        "/admin/settings/client_min_version_android",
        admin.accessToken,
        { value: "2.0.0", expectedVersion: 0, reason: "Старый Android не поддерживаем" },
      );
      expect(raised.status, JSON.stringify(raised.body)).toBe(200);
      const outdated = await android("mobile/1.5.0 (android)");
      expectError(outdated, 426, "CLIENT_UPDATE_REQUIRED");
      expect(outdated.body.details).toEqual({
        platform: "android",
        clientVersion: "1.5.0",
        minSupportedVersion: "2.0.0",
      });
      expect((await android("mobile/1.5.0 (ios)")).status).not.toBe(426);
      const policy = clientPolicyResponseSchema.parse(
        (await http().get("/meta/client-policy").set("X-Client", "mobile/1.5.0 (android)")).body,
      );
      expect(policy.platforms.android.minSupportedVersion).toBe("2.0.0");

      // The update text too, per language.
      const text = { kk: "Жаңартыңыз!", ru: "Обновитесь!", en: "Update!" };
      expect(
        (
          await asAdmin("put", "/admin/settings/client_update_message", admin.accessToken, {
            value: text,
            expectedVersion: 0,
            reason: "Новый текст",
          })
        ).status,
      ).toBe(200);
      const localized = await http()
        .get("/ready")
        .set("X-Client", "mobile/1.5.0 (android)")
        .set("Accept-Language", "kk");
      expect(localized.body.message).toBe(text.kk);

      expect(
        (
          await asAdmin(
            "post",
            "/admin/settings/client_min_version_android/reset",
            admin.accessToken,
            {
              expectedVersion: 1,
              reason: "Вернули",
            },
          )
        ).status,
      ).toBe(200);
      expect((await android("mobile/1.5.0 (android)")).status).not.toBe(426);

      const tooHigh = await asAdmin(
        "put",
        "/admin/settings/client_min_version_admin_web",
        admin.accessToken,
        { value: "0.1.1", expectedVersion: 0, reason: "Выше текущей" },
      );
      expectError(tooHigh, 400, "VALIDATION_ERROR");
      expect(tooHigh.body.details).toEqual([
        { path: "value", message: "Can't be above the current admin panel version 0.1.0" },
      ]);
      for (const garbage of ["latest", "1.0", "0.1.0-beta", 1]) {
        expectError(
          await asAdmin("put", "/admin/settings/client_min_version_ios", admin.accessToken, {
            value: garbage,
            expectedVersion: 0,
            reason: "Мусор",
          }),
          400,
          "VALIDATION_ERROR",
        );
      }
      await expect(operatorSet({ client_min_version_admin_web: "0.2.0" })).rejects.toThrow(
        ApiException,
      );
      expect(await historyCount("client_min_version_admin_web")).toBe(0);
      expect(await historyCount("client_min_version_ios")).toBe(0);
    });

    it("lets an administrator with an old admin panel tab sign in and fix the policy", async () => {
      const admin = await setUpAdmin(OLD_ADMIN_WEB);
      // Minimums raised as high as they go (the operator, another process).
      for (const [key, value] of [
        ["client_min_version_admin_web", "0.1.0"],
        ["client_min_version_ios", "9.0.0"],
        ["client_min_version_android", "9.0.0"],
        ["client_min_version_supplier_web", "9.0.0"],
      ] as const) {
        await worker.get(SettingsChangeService).change({
          key,
          value,
          expectedVersion: undefined,
          reason: "Повысили минимум",
          actor: { kind: "operator" },
        });
      }
      await app.get(AppSettings).refresh();

      // The old tab is outdated for everything else…
      expectError(
        await asAdmin("get", "/admin/administrators", admin.accessToken, undefined, OLD_ADMIN_WEB),
        426,
        "CLIENT_UPDATE_REQUIRED",
      );
      expectError(
        await http().get("/ready").set("X-Client", OLD_ADMIN_WEB),
        426,
        "CLIENT_UPDATE_REQUIRED",
      );
      // …but its session, a new sign-in and the settings still work.
      expect(
        (await asAdmin("get", "/auth/me", admin.accessToken, undefined, OLD_ADMIN_WEB)).status,
      ).toBe(200);
      const fresh = await adminSignIn(admin, OLD_ADMIN_WEB);
      const current = await listed(fresh, "client_min_version_admin_web");
      expect(current.value).toBe("0.1.0");
      const fixed = await asAdmin(
        "put",
        "/admin/settings/client_min_version_admin_web",
        fresh,
        { value: "0.0.0", expectedVersion: current.version, reason: "Отрезали старые вкладки" },
        OLD_ADMIN_WEB,
      );
      expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
      expect((await http().get("/ready").set("X-Client", OLD_ADMIN_WEB)).status).not.toBe(426);
      expect(
        (await asAdmin("get", "/admin/administrators", fresh, undefined, OLD_ADMIN_WEB)).status,
      ).toBe(200);
      // Other outdated clients still get 426 on sign-in routes.
      expectError(
        await http()
          .post("/auth/login-code")
          .set("X-Client", "mobile/1.0.0 (ios)")
          .send({ phone: USER_PHONE }),
        426,
        "CLIENT_UPDATE_REQUIRED",
      );
    });
  });

  describe("stored values and the database", () => {
    it("ignores a broken or unknown stored value, logs it and shows it in the list", async () => {
      await db.query(
        `INSERT INTO app_setting (key, value, version, updated_by_kind) VALUES
          ('rating_min_reviews', '"five"', 3, 'operator'),
          ('client_min_version_admin_web', '"9.9.9"', 1, 'operator'),
          ('guest_limits', '{"photo_recognitions": 1}', 1, 'operator'),
          ('removed_long_ago', '1', 1, 'operator')`,
      );
      await app.get(AppSettings).refresh();
      const values = await app.get(AppSettings).values();
      expect(values.rating_min_reviews).toBe(5);
      expect(values.client_min_version_admin_web).toBe("0.0.0");
      expect(values.guest_limits).toEqual({
        photo_recognitions: 3,
        voice_requests: 5,
        assistant_dialogs: 3,
      });
      const log = output.text();
      expect(log).toContain(
        "Stored setting ignored, the default applies key=rating_min_reviews version=3 reason=invalid_value",
      );
      expect(log).toContain("key=client_min_version_admin_web");
      expect(log).toContain("Stored setting ignored key=removed_long_ago reason=unknown_key");
      // The admin panel's own minimum from the broken row doesn't lock anyone out.
      expect((await http().get("/ready").set("X-Client", "admin-web/0.0.1")).status).not.toBe(426);

      const admin = await setUpAdmin();
      expect(await listed(admin.accessToken, "rating_min_reviews")).toMatchObject({
        value: 5,
        isDefault: true,
        storedValueInvalid: true,
      });
      // A proper change replaces the broken value.
      const fixed = await asAdmin("put", "/admin/settings/rating_min_reviews", admin.accessToken, {
        value: 6,
        expectedVersion: 0,
        reason: "Починили значение",
      });
      expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
      expect(settingChangedResponseSchema.parse(fixed.body).change).toMatchObject({
        previousValue: 5,
        previousIsDefault: true,
        newValue: 6,
      });
      expect(await app.get(AppSettings).get("rating_min_reviews")).toBe(6);
    });

    it("reaches another process within the cache lifetime, with no restart", async () => {
      const admin = await setUpAdmin();
      await worker.get(AppSettings).values();
      const changed = await asAdmin(
        "put",
        "/admin/settings/guest_ip_rate_limit_per_hour",
        admin.accessToken,
        { value: 3, expectedVersion: 0, reason: "Гости злоупотребляют" },
      );
      expect(changed.status).toBe(200);
      const deadline = Date.now() + CACHE_MS + 1000;
      while ((await worker.get(AppSettings).get("guest_ip_rate_limit_per_hour")) !== 3) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(50);
      }
    });

    it("keeps the last values while PostgreSQL is down, never silently the defaults, and recovers", async () => {
      await operatorSet({ client_min_version_android: "2.0.0" });
      const policy = () => http().get("/meta/client-policy");
      expect((await policy()).body.platforms.android.minSupportedVersion).toBe("2.0.0");

      await postgresProxy.stop();
      try {
        await sleep(CACHE_MS + 100);
        const during = await policy();
        expect(during.status).toBe(200);
        expect(during.body.platforms.android.minSupportedVersion).toBe("2.0.0");
        // The version check still uses them (a route that needs nothing else).
        expectError(
          await http().get("/no-such-route").set("X-Client", "mobile/1.9.9 (android)"),
          426,
          "CLIENT_UPDATE_REQUIRED",
        );
        await expect(app.get(AppSettings).refresh()).rejects.toThrow();
        expect(output.text()).toContain("Settings could not be read, keeping the values read at");
      } finally {
        await postgresProxy.start();
      }
      const deadline = Date.now() + 30_000;
      while (!output.text().includes("Settings read again after a failure")) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(250);
        await policy();
      }
      expect((await policy()).body.platforms.android.minSupportedVersion).toBe("2.0.0");
    }, 60_000);

    it("fails like any database request in a process that never read them, then recovers", async () => {
      await postgresProxy.stop();
      let fresh: INestApplicationContext | undefined;
      try {
        fresh = await NestFactory.createApplicationContext(
          WorkerModule.forRoot(config, {
            settingsCache: { maxAgeMs: CACHE_MS, retryAfterFailureMs: 200 },
          }),
          { bufferLogs: true },
        );
        fresh.useLogger(fresh.get(JsonLoggerService));
        fresh.flushLogs();
        const refused = await fresh
          .get(AppSettings)
          .values()
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ApiException);
        expect(refused).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
        expect(output.text()).toContain("Settings could not be read, no values were read yet");
      } finally {
        await postgresProxy.start();
      }
      const deadline = Date.now() + 30_000;
      for (;;) {
        await sleep(300);
        try {
          expect(await fresh.get(AppSettings).get("login_code_requests_per_phone")).toBe(10_000);
          break;
        } catch (error) {
          if (Date.now() > deadline) {
            throw error;
          }
        }
      }
      await fresh.close();
    }, 60_000);
  });

  describe("operator command", () => {
    it("shows, changes, resets and lists the history of any setting", async () => {
      const text = { kk: "Жаңартыңыз", ru: "Обновите приложение", en: "Please update" };
      const set = await operatorCommand(
        "settings:set",
        "client_update_message",
        JSON.stringify(text),
        "--reason",
        "Новый текст обновления",
      );
      expect(set.code, set.stderr).toBe(0);
      expect(settingChangedResponseSchema.parse(JSON.parse(set.stdout))).toMatchObject({
        change: { newValue: text, by: { kind: "operator" }, version: 1 },
      });

      // A sign-in security setting, not JSON-looking values taken as text.
      const length = await operatorCommand(
        "settings:set",
        "login_code_length",
        "4",
        "--reason",
        "Короче код",
        "--expected-version",
        "0",
      );
      expect(length.code, length.stderr).toBe(0);
      const version = await operatorCommand(
        "settings:set",
        "client_min_version_ios",
        "1.4.0",
        "--reason",
        "Минимум iOS",
      );
      expect(version.code, version.stderr).toBe(0);

      const got = await operatorCommand("settings:get", "login_code_length");
      expect(JSON.parse(got.stdout)).toMatchObject({
        value: 4,
        version: 1,
        editableBy: "operator",
      });

      const conflict = await operatorCommand(
        "settings:set",
        "login_code_length",
        "5",
        "--reason",
        "Устаревшая версия",
        "--expected-version",
        "0",
      );
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain("SETTING_VERSION_CONFLICT");

      const invalid = await operatorCommand(
        "settings:set",
        "login_code_length",
        "12",
        "--reason",
        "Слишком длинный",
      );
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("VALIDATION_ERROR");
      const noReason = await operatorCommand("settings:set", "login_code_length", "5");
      expect(noReason.code).toBe(1);
      expect(noReason.stderr).toContain("--reason");

      const reset = await operatorCommand(
        "settings:reset",
        "login_code_length",
        "--reason",
        "Вернули 6 цифр",
      );
      expect(reset.code, reset.stderr).toBe(0);
      const history = settingHistoryResponseSchema.parse(
        JSON.parse((await operatorCommand("settings:history", "login_code_length")).stdout),
      );
      expect(history.changes.map((change) => [change.action, change.newValue])).toEqual([
        ["reset", 6],
        ["set", 4],
      ]);

      const list = JSON.parse((await operatorCommand("settings:list")).stdout) as {
        key: string;
        value: unknown;
      }[];
      expect(list.find((item) => item.key === "client_min_version_ios")?.value).toBe("1.4.0");

      // The running API picks the change up within its cache lifetime.
      await sleep(CACHE_MS + 100);
      expectError(
        await http()
          .get("/ready")
          .set("X-Client", "mobile/1.3.9 (ios)")
          .set("Accept-Language", "en"),
        426,
        "CLIENT_UPDATE_REQUIRED",
      );
      expect(
        (
          await http()
            .get("/ready")
            .set("X-Client", "mobile/1.3.9 (ios)")
            .set("Accept-Language", "en")
        ).body.message,
      ).toBe(text.en);
    }, 120_000);
  });

  describe("logs", () => {
    it("never contained a token, secret or code during this whole suite", () => {
      // The file-wide check runs in output-capture; this proves the suite logged.
      expect(appLogText()).toContain("Setting changed");
    });
  });
});
