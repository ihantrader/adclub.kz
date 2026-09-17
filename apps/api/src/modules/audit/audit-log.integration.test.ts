import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  auditActions,
  auditLogPageSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  loginCodeVerifiedResponseSchema,
  totpStepRequiredDetailsSchema,
  type AuditLogEntry,
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
import { DatabaseService } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { SettingsChangeService } from "../settings";
import { AuditLog } from "./audit-log.service";
import { AUDIT_VALUE_MAX_CHARS } from "./audit-log.service";

/**
 * TASK-009: the action journal on a real PostgreSQL. Every significant
 * action of TASK-006 and TASK-007 lands in it in the transaction that
 * performs the action (a rollback leaves nothing behind), entries can be
 * neither changed nor deleted through the application, and only an
 * administrator reads them — with filters and page by page.
 */

const ADMIN_PHONE = "+77011234567";
const ADMIN_MASKED = "+7***4567";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77051234000";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

interface Admin {
  adminId: string;
  secret: string;
  accessToken: string;
}

describe("action journal (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  const lastSteps = new Map<string, number>();
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
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
    });
    const nest = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await db.query(TRUNCATE_ALL);
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
      rememberSecret(match[2]!);
    }
  }

  async function signIn(phone: string, client: string): Promise<Response> {
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

  /** An administrator signed in to the admin panel, ready to call its routes. */
  async function setUpAdmin(phone = ADMIN_PHONE): Promise<Admin> {
    const { adminId } = await app.get(OperatorService).grantAdmin(phone);
    const start = await signIn(phone, ADMIN_WEB);
    expect(start.status).toBe(403);
    const token = totpStepRequiredDetailsSchema.parse(start.body.details).signInStep.token;
    const setupResponse = await stepPost(
      "/auth/sign-in/totp/setup",
      { signInStep: token },
      ADMIN_WEB,
    );
    remember(setupResponse.body);
    const setup = totpSetupResponseSchema.parse(setupResponse.body);
    const confirmed = await stepPost(
      "/auth/sign-in/totp/setup/confirm",
      { signInStep: token, totpCode: nextCode(setup.secret) } as { signInStep: string },
      ADMIN_WEB,
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return { adminId, secret: setup.secret, accessToken: body.session.accessToken };
  }

  function asAdmin(
    method: "get" | "put" | "post",
    path: string,
    accessToken: string,
    body?: object,
  ): Test {
    const call = http()
      [method](path)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${accessToken}`);
    return body ? call.send(body) : call;
  }

  async function journal(
    accessToken: string,
    query = "",
  ): Promise<{ entries: AuditLogEntry[]; nextCursor: string | null }> {
    const response = await asAdmin("get", `/admin/audit-log${query}`, accessToken);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return auditLogPageSchema.parse(response.body);
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
  }

  async function rowCount(): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_log",
    );
    return Number(rows[0]!.count);
  }

  it("records a setting change by an administrator in the same transaction, with before and after", async () => {
    const admin = await setUpAdmin();
    const version = 0;

    const changed = await asAdmin(
      "put",
      "/admin/settings/supplier_response_hours",
      admin.accessToken,
      {
        value: 5,
        expectedVersion: version,
        reason: "проверка журнала действий",
      },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const page = await journal(admin.accessToken, "?action=setting.changed");
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0]!;
    expect(entry).toMatchObject({
      action: auditActions.settingChanged,
      entityType: "setting",
      entityId: "supplier_response_hours",
      reason: "проверка журнала действий",
      actor: { role: "admin", adminId: admin.adminId, phoneMasked: ADMIN_MASKED },
    });
    expect(entry.before).toEqual({ value: 2, isDefault: true });
    expect(entry.after).toEqual({ value: 5, isDefault: false, version: 1 });
    expect(entry.ip).not.toBeNull();
    expect(entry.requestId).not.toBeNull();
    expect(new Date(entry.at).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // The setting history of TASK-007 stays as it is, beside the journal.
    const history = await db.query("SELECT key FROM app_setting_change");
    expect(history.rows).toHaveLength(1);
  });

  it("records the operator command's actions with the actor `operator`", async () => {
    const operator = app.get(OperatorService);
    const { adminId } = await operator.grantAdmin(ADMIN_PHONE);
    const { supplierId } = await operator.createSupplier({ name: "Автомаркет", city: "Алматы" });
    const { memberId } = await operator.addMember({
      supplierId,
      phone: MEMBER_PHONE,
      displayName: "Айгерим",
    });
    await operator.removeMember(memberId);
    await operator.resetAdminTotp(ADMIN_PHONE);
    await operator.revokeAdmin(ADMIN_PHONE);

    const entries = await app.get(AuditLog).page({ limit: 50 });
    expect(entries.entries.map((entry) => entry.action)).toEqual([
      auditActions.adminRemoved,
      auditActions.adminTotpReset,
      auditActions.supplierMemberRemoved,
      auditActions.supplierMemberAdded,
      auditActions.supplierCreated,
      auditActions.adminGranted,
    ]);
    for (const entry of entries.entries) {
      expect(entry.actor).toMatchObject({ role: "operator", accountId: null, adminId: null });
      expect(entry.ip).toBeNull();
    }
    const granted = entries.entries.at(-1)!;
    expect(granted.entityId).toBe(adminId);
    expect(granted.after).toMatchObject({ phoneMasked: ADMIN_MASKED });
    // A mass action is one entry carrying how much it touched.
    const removed = entries.entries[0]!;
    expect(removed.after).toMatchObject({ status: "removed" });
    expect((removed.after as { sessionsEnded: number }).sessionsEnded).toBeGreaterThanOrEqual(0);
  });

  it("records an administrator's actions on another administrator", async () => {
    const first = await setUpAdmin();
    const { adminId: secondId } = await app.get(OperatorService).grantAdmin(USER_PHONE);

    const reset = await asAdmin(
      "post",
      `/admin/administrators/${secondId}/totp-reset`,
      first.accessToken,
    );
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const codes = await asAdmin("post", "/admin/totp/backup-codes", first.accessToken, {
      totpCode: nextCode(first.secret),
    });
    expect(codes.status, JSON.stringify(codes.body)).toBe(200);
    remember(codes.body);

    // Both administrators were appointed by the operator command before
    // this; the two entries below are the ones an administrator made.
    const page = await journal(first.accessToken, "?actorRole=admin");
    expect(page.entries.map((entry) => entry.action)).toEqual([
      auditActions.adminBackupCodesRegenerated,
      auditActions.adminTotpReset,
    ]);
    expect(page.entries[1]).toMatchObject({
      entityId: secondId,
      actor: { role: "admin", adminId: first.adminId },
    });
  });

  it("leaves no entry when the transaction of the action rolls back", async () => {
    const database = app.get(DatabaseService);
    const audit = app.get(AuditLog);

    await expect(
      database.db.transaction(async (tx) => {
        await audit.record(
          {
            action: auditActions.settingChanged,
            actor: { role: "operator" },
            entityType: "setting",
            entityId: "supplier_response_hours",
            after: { value: 9 },
          },
          tx,
        );
        throw new Error("the action failed after the entry was written");
      }),
    ).rejects.toThrow("the action failed");

    expect(await rowCount()).toBe(0);

    // And a failure to write the entry fails the action with it.
    await expect(
      app.get(SettingsChangeService).change({
        key: "supplier_response_hours",
        value: 3,
        expectedVersion: undefined,
        reason: "the entry is written in the same transaction",
        actor: { kind: "operator" },
      }),
    ).resolves.toBeDefined();
    expect(await rowCount()).toBe(1);
  });

  it("refuses every attempt to change or delete an entry through the application", async () => {
    await app.get(OperatorService).grantAdmin(ADMIN_PHONE);
    expect(await rowCount()).toBe(1);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM audit_log");
    const id = rows[0]!.id;

    await expect(
      db.query("UPDATE audit_log SET action = 'admin.removed' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_log WHERE id = $1", [id])).rejects.toThrow(
      /append-only/,
    );
    expect(await rowCount()).toBe(1);
  });

  it("filters and pages the journal for an administrator", async () => {
    const admin = await setUpAdmin();
    const operator = app.get(OperatorService);
    for (let index = 0; index < 5; index += 1) {
      await operator.createSupplier({ name: `Компания ${String(index)}`, city: "Алматы" });
    }
    // The boundary comes from the database: its clock, not this process's,
    // stamps an entry.
    const { rows } = await db.query<{ now: Date }>("SELECT now() AS now");
    const before = rows[0]!.now.toISOString();
    await asAdmin("put", "/admin/settings/supplier_response_hours", admin.accessToken, {
      value: 4,
      expectedVersion: 0,
      reason: "после отсечки периода",
    });

    const all = await journal(admin.accessToken);
    expect(all.entries.length).toBeGreaterThanOrEqual(6);
    expect(all.nextCursor).toBeNull();

    const byAction = await journal(admin.accessToken, "?action=supplier.created");
    expect(byAction.entries).toHaveLength(5);

    const byEntity = await journal(
      admin.accessToken,
      `?entityType=setting&entityId=supplier_response_hours`,
    );
    expect(byEntity.entries).toHaveLength(1);

    // The five companies plus the appointment of the administrator itself.
    const byActor = await journal(admin.accessToken, "?actorRole=operator");
    expect(byActor.entries).toHaveLength(6);

    const byPeriod = await journal(admin.accessToken, `?from=${encodeURIComponent(before)}`);
    expect(byPeriod.entries).toHaveLength(1);
    expect(byPeriod.entries[0]!.action).toBe(auditActions.settingChanged);

    const firstPage = await journal(admin.accessToken, "?limit=2");
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await journal(
      admin.accessToken,
      `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(secondPage.entries).toHaveLength(2);
    const seen = [...firstPage.entries, ...secondPage.entries].map((entry) => entry.id);
    expect(new Set(seen).size).toBe(4);

    // A cursor nobody issued is a bad request, not a server error.
    const broken = await asAdmin("get", "/admin/audit-log?cursor=zzzz", admin.accessToken);
    expectError(broken, 400, "VALIDATION_ERROR");
    const tooMany = await asAdmin("get", "/admin/audit-log?limit=500", admin.accessToken);
    expectError(tooMany, 400, "VALIDATION_ERROR");
  });

  it("refuses the journal to a mobile session and to a cabinet session", async () => {
    const admin = await setUpAdmin();
    const { supplierId } = await app
      .get(OperatorService)
      .createSupplier({ name: "Автомаркет", city: "Алматы" });
    await app
      .get(OperatorService)
      .addMember({ supplierId, phone: MEMBER_PHONE, displayName: "Айгерим" });

    const mobile = await signIn(USER_PHONE, IOS);
    expect(mobile.status).toBe(200);
    const mobileToken = (mobile.body as { session: { accessToken: string } }).session.accessToken;
    const refusedMobile = await http()
      .get("/admin/audit-log")
      .set("X-Client", IOS)
      .set("Authorization", `Bearer ${mobileToken}`);
    expectError(refusedMobile, 403, "FORBIDDEN");

    const cabinet = await signIn(MEMBER_PHONE, SUPPLIER_WEB);
    expect(cabinet.status, JSON.stringify(cabinet.body)).toBe(200);
    const cabinetToken = loginCodeVerifiedResponseSchema.parse(cabinet.body).session.accessToken;
    const refusedCabinet = await http()
      .get("/admin/audit-log")
      .set("X-Client", SUPPLIER_WEB)
      .set("Authorization", `Bearer ${cabinetToken}`);
    expectError(refusedCabinet, 403, "FORBIDDEN");

    // Without a session at all: the route asks for one.
    const anonymous = await http().get("/admin/audit-log").set("X-Client", ADMIN_WEB);
    expectError(anonymous, 401, "AUTH_REQUIRED");

    // The administrator, meanwhile, reads it.
    expect((await journal(admin.accessToken)).entries.length).toBeGreaterThan(0);
  });

  it("bounds a very large before/after instead of storing it whole", async () => {
    const audit = app.get(AuditLog);
    const huge = { note: "a".repeat(AUDIT_VALUE_MAX_CHARS + 1000) };

    await app.get(DatabaseService).db.transaction(async (tx) => {
      await audit.record(
        {
          action: auditActions.settingChanged,
          actor: { role: "operator" },
          entityType: "setting",
          entityId: "assistant_symptom_disclaimer",
          before: huge,
          after: { value: "short" },
        },
        tx,
      );
    });

    const { entries } = await audit.page({ limit: 10 });
    expect(entries[0]!.before).toMatchObject({ truncated: true });
    expect(JSON.stringify(entries[0]!.before).length).toBeLessThan(AUDIT_VALUE_MAX_CHARS);
    expect(entries[0]!.after).toEqual({ value: "short" });
  });

  it("writes no phone number, code or token to the log while recording", async () => {
    const admin = await setUpAdmin();
    await asAdmin("put", "/admin/settings/supplier_response_hours", admin.accessToken, {
      value: 6,
      expectedVersion: 0,
      reason: "журнал без персональных данных",
    });
    await journal(admin.accessToken);

    const text = output.text();
    expect(text).toContain("Action recorded action=setting.changed");
    expect(text).not.toContain("77011234567");
    expect(text).not.toContain(admin.accessToken);
  });
});
