import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminHomeSchema,
  adminModerationPageSchema,
  adminSupplierResponseSchema,
  adminVehicleMakeResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  supplierCatalogRequestResponseSchema,
  supplierCompatibilityProposalResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierStatsResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminModerationEntry,
  type DayHours,
  type ErrorCode,
  type SupplierOffer,
  type SupplierStats,
  type UserOrder,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle, ratingPercent } from "@adclub/domain";
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
import { SweepRunner, type JobRegistry, type JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { OrderDeadlineSweeper, orderDeadlinesJob, OrderTransitions } from "../orders";
import { ratingInputs } from "../ratings";
import { ModerationDigest } from "./moderation-digest";

/**
 * TASK-071 on a real PostgreSQL and Redis with the API and a worker:
 *
 * - the admin's queue «Модерация» — both kinds, the filters, the pages
 *   under changes, and the home card equal to its «Всего»;
 * - the digest W-06 — one a day with the right numbers in each recipient's
 *   language by the company's rule of recipients, none without decisions, a
 *   decision made while the job runs not lost, two runs at once not doubled;
 * - the statistics of a supplier — no test order, only the session's
 *   company, the shares equal to the rating's count over the same period,
 *   the admin's card the same numbers;
 * - who may read the new routes.
 */

const ADMIN_PHONE = "+77011234567";
const IOS = "mobile/1.4.2 (ios)";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const PADS = "04465-0K090";
const DAY = 24 * 3_600_000;

const FAST: Partial<JobsTuning> = {
  pollingIntervalSeconds: 0.5,
  monitorIntervalSeconds: 1,
  superviseIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
  cronMonitorIntervalSeconds: 1,
  cronWorkerIntervalSeconds: 1,
  scheduleSyncIntervalMs: 500,
  startRetryMs: 300,
  stopTimeoutMs: 3000,
};

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

describe("moderation in one place, the digest W-06 and a supplier's statistics (PostgreSQL + Redis + worker)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let fitCounter = 0;
  let almaty: string;
  let padsId: string;
  let makeId: string;
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
      AI_PROVIDER: "test",
    });
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.init();
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    settings = new TestSettings(worker);
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
      order_create_per_account: 1000,
      catalog_requests_per_supplier_day: 1000,
      compatibility_proposals_per_supplier_day: 1000,
      rating_min_orders: 2,
    });
    await new TestSettings(app).reload();
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
    makeId = await ok(
      asAdmin("post", "/admin/vehicles/makes", { name: "Geely", aliases: [] }),
      (body) => adminVehicleMakeResponseSchema.parse(body).make.id,
      201,
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
    if (client === IOS) {
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

  async function sessionToken(phone: string, client: string): Promise<string> {
    const response = await signIn(phone, client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function call(
    bearer: string | null,
    client: string,
    method: Method,
    path: string,
    body?: object,
  ) {
    let test = http()[method](path).set("X-Client", client).set("X-Forwarded-For", nextIp());
    if (bearer) {
      test = test.set("Authorization", `Bearer ${bearer}`);
    }
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
    phone: string;
    name: string;
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
        firstMember: { name: "Ерлан", phone },
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
      (body) => adminSupplierResponseSchema.parse(body).supplier,
    );
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: created.supplier.id,
      phone,
      name,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  /** A request to add an item by hand (S-OFF-05). */
  async function askItem(of: Company, name: string): Promise<string> {
    return ok(
      of.as("post", "/supplier/catalog-requests", { name, brand: "Bosch", article: name }),
      (body) => supplierCatalogRequestResponseSchema.parse(body).request.id,
      201,
    );
  }

  async function proposeFit(of: Company, evidence: string): Promise<string> {
    return ok(
      of.as("post", `/supplier/catalog/items/${padsId}/compatibility-proposals`, {
        conditions: { makeId, yearFrom: 2000 + (fitCounter++ % 26) },
        evidence,
      }),
      (body) => supplierCompatibilityProposalResponseSchema.parse(body).proposal.id,
      201,
    );
  }

  async function requestVersion(id: string): Promise<number> {
    const { rows } = await db.query<{ version: number }>(
      "SELECT version FROM catalog_request WHERE id = $1",
      [id],
    );
    return rows[0]!.version;
  }

  async function rejectRequest(id: string): Promise<void> {
    await ok(
      asAdmin("post", `/admin/catalog-requests/${id}/reject`, {
        expectedVersion: await requestVersion(id),
        reason: "Нет такой детали",
      }),
      (body) => body,
    );
  }

  async function linkRequest(id: string): Promise<void> {
    await ok(
      asAdmin("post", `/admin/catalog-requests/${id}/link`, {
        expectedVersion: await requestVersion(id),
        itemId: padsId,
      }),
      (body) => body,
    );
  }

  async function approveFit(id: string): Promise<void> {
    await ok(asAdmin("post", `/admin/compatibility-proposals/${id}/approve`, {}), (b) => b);
  }

  async function rejectFit(id: string): Promise<void> {
    await ok(
      asAdmin("post", `/admin/compatibility-proposals/${id}/reject`, { reason: "Не подходит" }),
      (b) => b,
    );
  }

  async function queue(query = ""): Promise<ReturnType<typeof adminModerationPageSchema.parse>> {
    return ok(asAdmin("get", `/admin/moderation${query}`), (body) =>
      adminModerationPageSchema.parse(body),
    );
  }

  async function home() {
    return ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
  }

  const digest = () =>
    worker.get(ModerationDigest).run({ signal: new AbortController().signal } as never);

  interface Sent {
    phone: string;
    lang: string;
    variables: Record<string, string>;
    dedupe_key: string;
  }

  async function digests(): Promise<Sent[]> {
    const { rows } = await db.query<Sent>(
      "SELECT phone, lang, variables, dedupe_key FROM outbound_message WHERE template = 'moderation_digest' ORDER BY created_at, phone",
    );
    return rows;
  }

  /** «The next day»: today's digest and the keys of its messages move to yesterday. */
  async function nextDay(): Promise<void> {
    await db.query("UPDATE supplier_moderation_digest SET day = day - 1");
    await db.query(
      "UPDATE outbound_message SET dedupe_key = dedupe_key || ':yesterday' WHERE template = 'moderation_digest'",
    );
  }

  // ---------------------------------------------------------------- the queue

  describe("the queue «Модерация» (requirement 1)", () => {
    it("lists both kinds oldest first, filters them, and the home card is its «Всего»", async () => {
      const [north, south] = [await company("Север"), await company("Юг")];
      const first = await askItem(north, "N-1");
      const fit = await proposeFit(south, "Каталог производителя");
      const second = await askItem(south, "S-1");
      // A decided request and a decided proposal are no longer in the queue.
      const decided = await askItem(north, "N-2");
      await rejectRequest(decided);
      const approved = await proposeFit(north, "Сайт");
      await approveFit(approved);

      const all = await queue();
      expect(all.total).toBe(3);
      expect(all.entries.map((entry) => entry.id)).toEqual([first, fit, second]);
      const [request, proposal] = all.entries as [AdminModerationEntry, AdminModerationEntry];
      expect(request).toMatchObject({
        kind: "item_request",
        supplier: { id: north.supplierId, name: "Север" },
        source: "manual",
        proposed: { name: "N-1", brand: "Bosch", article: "N-1" },
        item: null,
      });
      expect(proposal).toMatchObject({
        kind: "compatibility",
        supplier: { id: south.supplierId, name: "Юг" },
        source: "cabinet",
        proposed: null,
        item: { id: padsId, article: PADS },
      });
      expect(proposal.vehicle).toMatch(/^Geely/);

      expect((await home()).moderationWaiting).toBe(all.total);
      expect((await queue("?kind=compatibility")).entries.map((entry) => entry.id)).toEqual([fit]);
      expect((await queue("?kind=item_request")).total).toBe(2);
      const ofSouth = await queue(`?supplierId=${south.supplierId}`);
      expect(ofSouth.entries.map((entry) => entry.id)).toEqual([fit, second]);
      expect((await queue(`?supplierId=${south.supplierId}&kind=item_request`)).total).toBe(1);

      // A decision moves the card and the «Всего» together.
      await rejectFit(fit);
      expect((await queue()).total).toBe(2);
      expect((await home()).moderationWaiting).toBe(2);
    });

    it("pages without a gap or a repeat while the queue changes between pages", async () => {
      const shop = await company("Страницы");
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        ids.push(await askItem(shop, `P-${String(index)}`));
      }
      const page1 = await queue("?limit=3");
      expect(page1.entries.map((entry) => entry.id)).toEqual(ids.slice(0, 3));
      expect(page1.nextCursor).not.toBeNull();
      // Between the pages: one already shown and one not yet shown are decided, a new one comes.
      await rejectRequest(ids[1]!);
      await rejectRequest(ids[4]!);
      const late = await askItem(shop, "P-late");
      const seen: string[] = page1.entries.map((entry) => entry.id);
      let cursor = page1.nextCursor;
      while (cursor) {
        const page = await queue(`?limit=3&cursor=${encodeURIComponent(cursor)}`);
        seen.push(...page.entries.map((entry) => entry.id));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual([...ids.slice(0, 3), ids[3], ids[5], ids[6], late]);
      expect(new Set(seen).size).toBe(seen.length);
      expectError(await asAdmin("get", "/admin/moderation?cursor=bogus"), 400, "VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------- the digest

  describe("the digest W-06 (requirement 2)", () => {
    it("goes once a day to the contact person with the day's numbers, in their language", async () => {
      const shop = await company("Сводка");
      // A colleague with the notices on: the contact person still is the one who gets it.
      await ok(
        shop.as("post", "/supplier/members", { name: "Марат", phone: "+77059990001" }),
        (b) => b,
        201,
      );
      rememberCode("+77059990001");
      await db.query(
        "UPDATE supplier_member SET notification_language = 'kk', notifications_enabled_at = NULL WHERE supplier_id = $1 AND is_contact_person",
        [shop.supplierId],
      );
      // Twenty decisions in a day by two administrators' worth of clicks.
      const requests: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        requests.push(await askItem(shop, `D-${String(index)}`));
      }
      const fits: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        fits.push(await proposeFit(shop, `Источник ${String(index)}`));
      }
      for (const id of requests.slice(0, 7)) await linkRequest(id);
      for (const id of requests.slice(7)) await rejectRequest(id);
      for (const id of fits.slice(0, 6)) await approveFit(id);
      for (const id of fits.slice(6)) await rejectFit(id);

      expect(await digest()).toEqual({ worked: true });
      const sent = await digests();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        phone: shop.phone,
        lang: "kk",
        variables: { added: "13", rejected: "7" },
      });
      expect(sent[0]!.variables.link).toMatch(/\/moderation$/);
      // The same day: a retry, a second run, a manual `jobs:run` — nothing more.
      expect(await digest()).toEqual({ worked: false });
      const more = await askItem(shop, "D-after");
      await rejectRequest(more);
      expect(await digest()).toEqual({ worked: false });
      expect(await digests()).toHaveLength(1);
      // Tomorrow: only what was decided after the first digest.
      await nextDay();
      expect(await digest()).toEqual({ worked: true });
      const all = await digests();
      expect(all).toHaveLength(2);
      expect(all[1]!.variables).toMatchObject({ added: "0", rejected: "1" });
      // No decisions — no message.
      await nextDay();
      expect(await digest()).toEqual({ worked: false });
      expect(await digests()).toHaveLength(2);
    });

    it("falls back to the receivers of notices, then to the first three, by the company's rule", async () => {
      const shop = await company("Без контакта");
      const phones = ["+77059990011", "+77059990012", "+77059990013", "+77059990014"];
      for (const [index, phone] of phones.entries()) {
        rememberCode(phone);
        await ok(
          shop.as("post", "/supplier/members", { name: `Сотрудник ${String(index)}`, phone }),
          (b) => b,
          201,
        );
      }
      await db.query(
        "UPDATE supplier_member SET is_contact_person = false, notifications_enabled_at = NULL WHERE supplier_id = $1",
        [shop.supplierId],
      );
      await rejectRequest(await askItem(shop, "F-1"));
      await digest();
      // Nobody is the contact person and nobody takes notices: the first three employees.
      expect((await digests()).map((message) => message.phone).sort()).toEqual(
        [shop.phone, phones[0]!, phones[1]!].sort(),
      );
    });

    it("leaves a decision committed while the job runs to the next digest", async () => {
      const shop = await company("Гонка");
      await rejectRequest(await askItem(shop, "R-1"));
      const racing = await askItem(shop, "R-2");
      const adminId = await idOf("SELECT id FROM admin_user LIMIT 1", []);
      // An administrator's decision, not yet committed when the digest runs.
      const other = new Client({ connectionString: postgres.getConnectionUri() });
      await other.connect();
      try {
        await other.query("BEGIN");
        await other.query(
          "UPDATE catalog_request SET status = 'rejected', reject_reason = 'x', decided_at = now(), decided_by_admin_id = $2 WHERE id = $1",
          [racing, adminId],
        );
        expect(await digest()).toEqual({ worked: true });
        await other.query("COMMIT");
      } finally {
        await other.end();
      }
      expect((await digests())[0]!.variables).toMatchObject({ added: "0", rejected: "1" });
      const { rows } = await db.query<{ digested_at: Date | null }>(
        "SELECT digested_at FROM catalog_request WHERE id = $1",
        [racing],
      );
      expect(rows[0]!.digested_at).toBeNull();
      await nextDay();
      await digest();
      expect((await digests())[1]!.variables).toMatchObject({ added: "0", rejected: "1" });
    });

    it("gives one digest when two runs go at once", async () => {
      const shops = [await company("Двое А"), await company("Двое Б"), await company("Двое В")];
      for (const shop of shops) {
        await approveFit(await proposeFit(shop, "Каталог"));
        await rejectRequest(await askItem(shop, `${shop.name}-1`));
      }
      // Two workers: two transactions of the same handler, side by side.
      const other = await NestFactory.createApplicationContext(
        WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
        { bufferLogs: true },
      );
      try {
        await Promise.all([
          digest(),
          other.get(ModerationDigest).run({ signal: new AbortController().signal } as never),
          digest(),
        ]);
      } finally {
        await other.close();
      }
      const sent = await digests();
      expect(sent).toHaveLength(3);
      expect(sent.every((message) => message.variables.added === "1")).toBe(true);
      expect(sent.every((message) => message.variables.rejected === "1")).toBe(true);
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM supplier_moderation_digest",
      );
      expect(rows[0]!.n).toBe(3);
    });
  });

  // ---------------------------------------------------------------- statistics

  async function put(
    of: Company,
    terms: { availability?: "in_stock" | "on_order"; leadDays?: number } = {},
  ): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId: padsId,
        price: 6_500,
        availability: terms.availability ?? "in_stock",
        leadDays: terms.leadDays ?? 0,
        pickup: true,
        delivery: true,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  interface Customer {
    phone: string;
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
    return { phone: number, as: (method, path, body) => call(bearer, IOS, method, path, body) };
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

  async function sweep() {
    const sweeper = new OrderDeadlineSweeper(
      { sweep: () => undefined } as unknown as JobRegistry,
      app.get(OrderTransitions),
    );
    return new SweepRunner(app.get(DatabaseService)).run(orderDeadlinesJob, sweeper, {
      signal: new AbortController().signal,
    });
  }

  async function stats(of: Company, period = "30"): Promise<SupplierStats> {
    return ok(of.as("get", `/supplier/stats?period=${period}`), (body) =>
      supplierStatsResponseSchema.parse(body),
    ).then((body) => body.stats);
  }

  describe("the statistics S-STAT-01 (requirement 3)", () => {
    it("counts the period's orders without test ones, with the shares of the rating", async () => {
      const shop = await company("Статистика");
      const offer = await put(shop);
      const buyer = await customer();
      // Given out in time, twice.
      for (let index = 0; index < 2; index += 1) {
        const order = await place(buyer, offer);
        await ok(
          shop.as("post", `/supplier/orders/${order.id}/accept`, { expectedVersion: 1 }),
          (b) => b,
        );
        await ok(
          shop.as("post", "/supplier/orders/close", { code: order.confirmation!.code }),
          (b) => b,
        );
      }
      // Declined at once; cancelled by the user; silent.
      const declined = await place(buyer, offer);
      await ok(
        shop.as("post", `/supplier/orders/${declined.id}/decline`, {
          expectedVersion: 1,
          reason: "out_of_stock",
        }),
        (b) => b,
      );
      const cancelled = await place(buyer, offer);
      await ok(buyer.as("post", `/orders/${cancelled.id}/cancel`), (b) => b);
      const silent = await place(buyer, offer);
      await db.query(
        "UPDATE customer_order SET respond_by = now() - interval '1 minute' WHERE id = $1",
        [silent.id],
      );
      await sweep();
      // An order placed 40 days ago: in 90, not in 30.
      const old = await place(buyer, offer);
      await db.query(
        "UPDATE customer_order SET created_at = now() - interval '40 days' WHERE id = $1",
        [old.id],
      );
      // A test order of the company's own employee, given out — in no number.
      const employee = await customer(shop.phone);
      const test = await place(employee, offer);
      await ok(
        shop.as("post", `/supplier/orders/${test.id}/accept`, { expectedVersion: 1 }),
        (b) => b,
      );
      await ok(
        shop.as("post", "/supplier/orders/close", { code: test.confirmation!.code }),
        (b) => b,
      );
      const { rows } = await db.query<{ is_test: boolean }>(
        "SELECT is_test FROM customer_order WHERE id = $1",
        [test.id],
      );
      expect(rows[0]!.is_test).toBe(true);
      // Views of its offer: two by members of the club, one by a guest, yesterday.
      await db.query(
        `INSERT INTO offer_view_daily (offer_id, day, viewer_kind, supplier_id, views)
         VALUES ($1, (now() AT TIME ZONE 'Asia/Almaty')::date - 1, 'club', $2, 2),
                ($1, (now() AT TIME ZONE 'Asia/Almaty')::date - 1, 'guest', $2, 1),
                ($1, (now() AT TIME ZONE 'Asia/Almaty')::date - 60, 'club', $2, 5)`,
        [offer.id, shop.supplierId],
      );

      const month = await stats(shop, "30");
      expect(month.orders).toEqual({
        total: 5,
        completed: 2,
        completedServices: 0,
        cancelledByUser: 1,
        declinedBySupplier: 1,
        expiredNoResponse: 1,
      });
      expect(month.views).toEqual({ total: 3, club: 2 });
      // Answers: 2 given out + the decline of 4 (one silent); terms: 2 kept of 2.
      expect(month.shares).toMatchObject({
        answered: 3,
        answerRequired: 4,
        responsePercent: ratingPercent(3 / 4),
        kept: 2,
        judged: 2,
        onTimePercent: 100,
        minOrders: 2,
      });
      expect(month.rating).toMatchObject({ score: null, isNew: true, windowDays: 180 });

      // The shares are the rating's count over the very same period.
      const counted = (
        await ratingInputs(app.get(DatabaseService).db, [shop.supplierId], {
          from: month.from,
          to: month.to,
        })
      ).get(shop.supplierId)!;
      expect(month.shares).toMatchObject({
        answered: counted.answered,
        answerRequired: counted.answerRequired,
        kept: counted.kept,
        judged: counted.judged,
      });

      const quarter = await stats(shop, "90");
      expect(quarter.orders.total).toBe(6);
      expect(quarter.views).toEqual({ total: 8, club: 7 });
      const week = await stats(shop, "7");
      expect(week.orders.total).toBe(5);
      // Too few orders behind a share: «Мало заявок для оценки».
      await settings.set({ rating_min_orders: 5 });
      await new TestSettings(app).reload();
      expect((await stats(shop, "7")).shares).toMatchObject({
        responsePercent: null,
        onTimePercent: null,
      });

      // The admin's card: the same count for the same period.
      const admin = await ok(
        asAdmin("get", `/admin/suppliers/${shop.supplierId}/stats?period=7`),
        (body) => supplierStatsResponseSchema.parse(body).stats,
      );
      expect(admin).toEqual(await stats(shop, "7"));
    });

    it("counts a day of Almaty: an order at 23:30 Almaty is in its day", async () => {
      const shop = await company("Граница");
      const offer = await put(shop);
      const buyer = await customer();
      const order = await place(buyer, offer);
      // 23:30 Almaty six days before today — the first day of the week.
      await db.query(
        `UPDATE customer_order SET created_at =
           (((now() AT TIME ZONE 'Asia/Almaty')::date - 6) + time '23:30') AT TIME ZONE 'Asia/Almaty'
         WHERE id = $1`,
        [order.id],
      );
      expect((await stats(shop, "7")).orders.total).toBe(1);
      // 23:30 Almaty seven days before — the day before the week.
      await db.query(
        `UPDATE customer_order SET created_at =
           (((now() AT TIME ZONE 'Asia/Almaty')::date - 7) + time '23:30') AT TIME ZONE 'Asia/Almaty'
         WHERE id = $1`,
        [order.id],
      );
      expect((await stats(shop, "7")).orders.total).toBe(0);
      expect((await stats(shop, "30")).orders.total).toBe(1);
    });

    it("shows only the session's company, another one after switching", async () => {
      const [north, south] = [await company("Свои"), await company("Чужие")];
      const offer = await put(south);
      const buyer = await customer();
      await place(buyer, offer);
      expect((await stats(north)).orders.total).toBe(0);
      expect((await stats(south)).orders.total).toBe(1);
      // There is no way to name another company in the query: it is ignored.
      const asked = await ok(
        north.as("get", `/supplier/stats?period=30&supplierId=${south.supplierId}`),
        (body) => supplierStatsResponseSchema.parse(body).stats,
      );
      expect(asked.orders.total).toBe(0);
      // The employee of the north joins the south too and switches to it: the south's numbers.
      await ok(
        south.as("post", "/supplier/members", { name: "Ерлан", phone: north.phone }),
        (b) => b,
        201,
      );
      await ok(
        north.as("post", "/auth/supplier-context", { supplierId: south.supplierId }),
        (b) => b,
      );
      expect((await stats(north)).orders.total).toBe(1);
    });
  });

  // ---------------------------------------------------------------- access

  describe("who may read the new routes", () => {
    it("gives the queue and a supplier's statistics to administrators, the own statistics to the cabinet", async () => {
      const shop = await company("Доступ");
      const buyer = await customer();
      for (const path of ["/admin/moderation", `/admin/suppliers/${shop.supplierId}/stats`]) {
        expectError(await call(null, ADMIN_WEB, "get", path), 401, "AUTH_REQUIRED");
        expectError(await buyer.as("get", path), 403, "FORBIDDEN");
        expectError(await shop.as("get", path), 403, "FORBIDDEN");
        await ok(asAdmin("get", path), (b) => b);
      }
      expectError(await call(null, SUPPLIER_WEB, "get", "/supplier/stats"), 401, "AUTH_REQUIRED");
      expectError(await buyer.as("get", "/supplier/stats"), 403, "FORBIDDEN");
      expectError(await asAdmin("get", "/supplier/stats"), 403, "FORBIDDEN");
      await ok(shop.as("get", "/supplier/stats"), (b) => b);
      expectError(await asAdmin("get", `/admin/suppliers/${randomUUID()}/stats`), 404, "NOT_FOUND");
      expectError(await shop.as("get", "/supplier/stats?period=14"), 400, "VALIDATION_ERROR");
    });
  });
});
