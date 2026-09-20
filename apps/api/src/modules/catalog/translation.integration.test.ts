import { randomUUID } from "node:crypto";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCategoryResponseSchema,
  adminCategoryTreeResponseSchema,
  apiErrorResponseSchema,
  auditActions,
  auditLogPageSchema,
  categoryTreeResponseSchema,
  entityTranslationsResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  translationQueuePageSchema,
  type AdminCategory,
  type EntityTranslationsResponse,
  type ErrorCode,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { DatabaseService } from "../../database";
import { configureHttpApp } from "../../http-app";
import { JobAdmin, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
} from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { AiGateway, AiService, TestAiGateway, testTranslation, type TranslateInput } from "../ai";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { TranslationQueue, TranslationRunner, TranslationWake } from ".";

/**
 * TASK-012 end to end on a real PostgreSQL: the queue of automatic
 * translation and the administrator's routes (no worker: tasks just wait),
 * then the worker with the test AI provider — accounting, budget, retries
 * and the dead letter queue, the checks, the protection of manual edits
 * and everything that can happen between asking for a translation and
 * saving it.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77051234000";
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
  stopTimeoutMs: 3000,
};

type Method = "get" | "post" | "put" | "patch";

// A raw control character, written as code so the source stays plain text.
const BELL = String.fromCharCode(7);

/** The models `ai_model_translate_*` name by default (TASK-053, ARCHITECTURE 9.6). */
const DEFAULT_MODEL = "google/gemini-3.8-flash";
const FALLBACK_MODEL = "openai/gpt-5.4-mini";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await sleep(100);
  }
}

/** The hash a translation records of its Russian text, as PostgreSQL computes it. */
const HASH_SQL = "encode(sha256(convert_to($1::text, 'UTF8')), 'hex')";

describe("translation of the catalog (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext | undefined;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let token: string;
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
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 200 }, jobs: FAST }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.listen(0, "127.0.0.1");
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
  }, 180_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await db.query("DELETE FROM pgboss.job WHERE name LIKE 'catalog.%'");
    await db.query(TRUNCATE_ALL);
    await redis.flushall();
    await new TestSettings(app).reload();
    output = captureOutput();
    token = await setUpAdmin();
  });

  afterEach(async () => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
    await stopWorker();
  });

  // ------------------------------------------------------------- helpers

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

  function stepPost(path: string, body: { signInStep: string }): Test {
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

  async function setUpAdmin(): Promise<string> {
    await app.get(OperatorService).grantAdmin(ADMIN_PHONE);
    const start = await signIn(ADMIN_PHONE, ADMIN_WEB);
    expect(start.status).toBe(403);
    const step = totpStepRequiredDetailsSchema.parse(start.body.details).signInStep.token;
    const setupResponse = await stepPost("/auth/sign-in/totp/setup", { signInStep: step });
    remember(setupResponse.body);
    const setup = totpSetupResponseSchema.parse(setupResponse.body);
    const confirmed = await stepPost("/auth/sign-in/totp/setup/confirm", {
      signInStep: step,
      totpCode: nextCode(setup.secret),
    } as { signInStep: string });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return body.session.accessToken;
  }

  async function mobileToken(): Promise<string> {
    const response = await signIn(USER_PHONE, IOS);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  async function cabinetToken(): Promise<string> {
    const operator = app.get(OperatorService);
    const { supplierId } = await operator.createSupplier({ name: "Автомаркет", city: "Алматы" });
    await operator.addMember({ supplierId, phone: MEMBER_PHONE, displayName: "Айгерим" });
    const response = await signIn(MEMBER_PHONE, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function asAdmin(method: Method, path: string, body?: object): Test {
    const call = http()
      [method](path)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${token}`);
    return body ? call.send(body) : call;
  }

  function asGuest(path: string, lang?: string): Test {
    const call = http().get(path).set("X-Client", IOS);
    return lang === undefined ? call : call.set("Accept-Language", lang);
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  async function createCategory(
    names: object,
    code = `cat_${randomUUID().slice(0, 8)}`,
    extra: object = {},
  ) {
    const response = await asAdmin("post", "/admin/catalog/categories", {
      code,
      kind: "goods",
      names,
      ...extra,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return adminCategoryResponseSchema.parse(response.body).category;
  }

  async function patchCategory(category: AdminCategory, body: object): Promise<AdminCategory> {
    const response = await asAdmin("patch", `/admin/catalog/categories/${category.id}`, {
      expectedVersion: category.version,
      ...body,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return adminCategoryResponseSchema.parse(response.body).category;
  }

  /** The category as the administrator's tree shows it now (its version included). */
  async function currentCategory(id: string): Promise<AdminCategory> {
    const tree = adminCategoryTreeResponseSchema.parse(
      (await asAdmin("get", "/admin/catalog/categories")).body,
    );
    return tree.categories.flatMap((node) => [node, ...node.children]).find((c) => c.id === id)!;
  }

  /** An automatic translation as the worker leaves it, made for the Russian text `russian`. */
  async function insertAi(entityId: string, lang: string, text: string, russian: string) {
    await db.query(
      `INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited,
                                source_hash, ai_model)
       VALUES ('category', $1, 'name', $2, $3, 'ai', false,
               encode(sha256(convert_to($4::text, 'UTF8')), 'hex'), $5)`,
      [entityId, lang, text, russian, DEFAULT_MODEL],
    );
  }

  async function translationsOf(
    entityType: string,
    entityId: string,
  ): Promise<EntityTranslationsResponse> {
    const response = await asAdmin("get", `/admin/translations/${entityType}/${entityId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return entityTranslationsResponseSchema.parse(response.body);
  }

  /** The `name` field of a category as the tab "Переводы" shows it. */
  async function names(entityId: string, entityType = "category") {
    return (await translationsOf(entityType, entityId)).fields.find((f) => f.field === "name")!
      .texts;
  }

  interface TaskRow {
    lang: string;
    status: string;
    failure: string | null;
    attempts: number;
    last_error: string | null;
  }

  async function tasksOf(entityId: string): Promise<TaskRow[]> {
    const { rows } = await db.query<TaskRow>(
      "SELECT lang, status, failure, attempts, last_error FROM translation_task WHERE entity_id = $1 ORDER BY lang",
      [entityId],
    );
    return rows;
  }

  async function count(table: string, where = "true"): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    );
    return Number(rows[0]!.count);
  }

  async function journalActions(): Promise<string[]> {
    const response = await asAdmin("get", "/admin/audit-log?limit=100");
    expect(response.status).toBe(200);
    return auditLogPageSchema
      .parse(response.body)
      .entries.map((entry) => entry.action)
      .reverse();
  }

  async function startWorker(options: { aiTimeoutMs?: number } = {}): Promise<TestAiGateway> {
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, {
        settingsCache: { maxAgeMs: 200 },
        jobs: FAST,
        ...(options.aiTimeoutMs ? { ai: { timeoutMs: options.aiTimeoutMs } } : {}),
      }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    await new TestSettings(worker).reload();
    return worker.get(AiGateway) as TestAiGateway;
  }

  async function stopWorker(): Promise<void> {
    const running = worker;
    worker = undefined;
    await running?.close();
  }

  async function setSettings(values: Record<string, unknown>): Promise<void> {
    await new TestSettings(app).set(values as never);
    if (worker) {
      await new TestSettings(worker).reload();
    }
    await new TestSettings(app).reload();
    await sleep(300);
  }

  /** Waits until nothing is left to translate (no task rows). */
  const drained = () =>
    waitFor(async () => (await count("translation_task")) === 0, "the queue to drain");

  // ================================================== the queue and the API

  describe("the queue (no worker: tasks wait)", () => {
    it("puts the change of a Russian text and its task in one transaction (AC-3)", async () => {
      const jobs = () => count("pgboss.job", "name = 'catalog.translate'");
      // Rolled back: no text, no task, no job.
      const database = app.get(DatabaseService);
      const entityId = randomUUID();
      await expect(
        database.db.transaction(async (tx) => {
          await app
            .get(TranslationQueue)
            .writeTexts(tx, "category", entityId, "name", {}, { ru: "Откат", kk: null, en: null });
          expect(await count("translation_task")).toBe(0); // not visible outside yet
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect({
        texts: await count("translation", `entity_id = '${entityId}'`),
        tasks: await count("translation_task"),
        jobs: await jobs(),
      }).toEqual({ texts: 0, tasks: 0, jobs: 0 });

      // Committed through the API: the text, a task for each language and a job — together.
      const category = await createCategory({ ru: "Тормоза" });
      expect(await tasksOf(category.id)).toMatchObject([
        { lang: "en", status: "pending" },
        { lang: "kk", status: "pending" },
      ]);
      expect(await jobs()).toBe(1);
      // A refused change (a name already taken) leaves neither a text, nor a task, nor a job.
      const refused = await asAdmin("post", "/admin/catalog/categories", {
        code: "duplicate",
        kind: "goods",
        names: { ru: "тормоза" },
      });
      expectError(refused, 409, "CATALOG_NAME_TAKEN");
      expect({ tasks: await count("translation_task"), jobs: await jobs() }).toEqual({
        tasks: 2,
        jobs: 1,
      });
    });

    it("asks for no translation of a language written by hand, and withdraws one that waits (AC-4)", async () => {
      const category = await createCategory({ ru: "Диски" });
      expect((await tasksOf(category.id)).map((task) => task.lang)).toEqual(["en", "kk"]);
      // Written by hand while its task waits: the task goes, the text is manual.
      const withKk = await patchCategory(category, { names: { kk: "Дискілер" } });
      expect((await tasksOf(category.id)).map((task) => task.lang)).toEqual(["en"]);
      const shown = await names(category.id);
      expect(shown.kk.translation).toMatchObject({
        text: "Дискілер",
        origin: "manual",
        isManuallyEdited: true,
        isSourceChanged: false,
        aiModel: null,
      });
      expect(shown.kk.task).toBeNull();
      expect(shown.en.task).toMatchObject({ state: "queued", failure: null });
      // A language cleared by hand stays cleared: no task is made for it by that change.
      const withEn = await patchCategory(withKk, { names: { en: "Discs" } });
      await patchCategory(withEn, { names: { en: null } });
      expect(await tasksOf(category.id)).toEqual([]);
      expect((await names(category.id)).en).toEqual({ translation: null, task: null });
    });

    it("keeps a manual text when the Russian one changes, flags it, and replaces an automatic one (AC-4, AC-5)", async () => {
      const category = await createCategory({ ru: "Тормоза", kk: "Тежегіштер" });
      // A translation the worker made earlier.
      await db.query("DELETE FROM translation_task WHERE entity_id = $1", [category.id]);
      await insertAi(category.id, "en", "Brakes", "Тормоза");
      expect((await names(category.id)).en.translation).toMatchObject({
        origin: "ai",
        isSourceChanged: false,
        aiModel: DEFAULT_MODEL,
      });
      await patchCategory(category, { names: { ru: "Тормозная система" } });
      const shown = await names(category.id);
      // The manual Kazakh text is untouched, flagged, and no task rewrites it.
      expect(shown.kk.translation).toMatchObject({
        text: "Тежегіштер",
        origin: "manual",
        isSourceChanged: true,
      });
      expect(shown.kk.task).toBeNull();
      // The automatic English one is to be replaced: still there, stale, queued.
      expect(shown.en.translation).toMatchObject({
        text: "Brakes",
        origin: "ai",
        isSourceChanged: true,
      });
      expect(shown.en.task).toMatchObject({ state: "queued" });
      expect(shown.ru.translation).toMatchObject({ text: "Тормозная система", origin: "source" });
      // Two quick changes leave one task, for the last text.
      await patchCategory(await currentCategory(category.id), {
        names: { ru: "Тормоза и колодки" },
      });
      const { rows } = await db.query<{ lang: string; source_hash: string }>(
        "SELECT lang, source_hash FROM translation_task WHERE entity_id = $1",
        [category.id],
      );
      const hash = (await db.query<{ h: string }>(`SELECT ${HASH_SQL} AS h`, ["Тормоза и колодки"]))
        .rows[0]!.h;
      expect(rows).toEqual([{ lang: "en", source_hash: hash }]);
    });

    it("writes a translation by hand, checked like any name, and journals it (AC-9)", async () => {
      const first = await createCategory({ ru: "Колодки" });
      const second = await createCategory({ ru: "Диски", en: "Discs" });
      const put = (id: string, lang: string, text: unknown, field = "name") =>
        asAdmin("put", `/admin/translations/category/${id}/${field}/${lang}`, { text });

      const edited = await put(first.id, "kk", "  Қалыптар  ");
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const view = entityTranslationsResponseSchema.parse(edited.body);
      expect(view.fields[0]!.texts.kk.translation).toMatchObject({
        text: "Қалыптар",
        origin: "manual",
        isManuallyEdited: true,
      });
      expect(view.fields[0]!.texts.kk.task).toBeNull();
      // The same text again changes nothing and is not journaled twice.
      await put(first.id, "kk", "Қалыптар");
      // Too long for a category (40), control characters, a neighbour's name, a field it hasn't.
      expectError(await put(first.id, "en", "x".repeat(41)), 400, "VALIDATION_ERROR");
      expectError(await put(first.id, "en", `Brake${BELL}pads`), 400, "VALIDATION_ERROR");
      expectError(await put(first.id, "en", ""), 400, "VALIDATION_ERROR");
      expectError(await put(first.id, "en", "discs"), 409, "CATALOG_NAME_TAKEN");
      expectError(await put(first.id, "en", "Pads", "unit"), 400, "VALIDATION_ERROR");
      expectError(await put(first.id, "ru", "Колодки"), 400, "VALIDATION_ERROR");
      expectError(await put(randomUUID(), "kk", "Қалыптар"), 404, "NOT_FOUND");
      expectError(
        await asAdmin("put", "/admin/translations/nothing/" + first.id + "/name/kk", { text: "x" }),
        400,
        "VALIDATION_ERROR",
      );
      // Confirming a manual text against the changed Russian one clears the flag.
      const changed = await patchCategory(first, { names: { ru: "Колодки тормозные" } });
      expect((await names(first.id)).kk.translation!.isSourceChanged).toBe(true);
      await put(changed.id, "kk", "Қалыптар");
      expect((await names(first.id)).kk.translation!.isSourceChanged).toBe(false);
      expect(await journalActions()).toEqual(
        expect.arrayContaining([
          auditActions.catalogTranslationEdited,
          auditActions.catalogCategoryCreated,
        ]),
      );
      const edits = (await journalActions()).filter(
        (action) => action === auditActions.catalogTranslationEdited,
      );
      expect(edits).toHaveLength(2);
      expect(second.id).toBeTruthy();
    });

    it("releases a manual edit and asks again only for automatic texts (AC-5, AC-9)", async () => {
      const category = await createCategory({ ru: "Амортизаторы", kk: "Амортизаторлар" });
      await db.query("DELETE FROM translation_task WHERE entity_id = $1", [category.id]);
      const base = `/admin/translations/category/${category.id}/name`;
      // A manual text is never translated again…
      expectError(
        await asAdmin("post", `${base}/kk/retranslate`),
        409,
        "TRANSLATION_MANUALLY_EDITED",
      );
      // …a missing one can be asked for; asking twice leaves one task.
      const asked = await asAdmin("post", `${base}/en/retranslate`);
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      await asAdmin("post", `${base}/en/retranslate`).expect(200);
      expect(await tasksOf(category.id)).toMatchObject([{ lang: "en", status: "pending" }]);
      const requeued = (await journalActions()).filter(
        (action) => action === auditActions.catalogTranslationRequeued,
      );
      expect(requeued).toHaveLength(2);
      // An automatic text is not a manual edit to release.
      await insertAi(category.id, "en", "Shock absorbers", "Амортизаторы");
      expectError(await asAdmin("post", `${base}/en/release`), 409, "TRANSLATION_NOT_MANUAL");
    });

    it("releases a manual text: it stays visible and the language is queued again (AC-5)", async () => {
      const category = await createCategory({ ru: "Рычаги", kk: "Иінтіректер" });
      await db.query("DELETE FROM translation_task WHERE entity_id = $1", [category.id]);
      const released = await asAdmin(
        "post",
        `/admin/translations/category/${category.id}/name/kk/release`,
      );
      expect(released.status, JSON.stringify(released.body)).toBe(200);
      const kk = entityTranslationsResponseSchema.parse(released.body).fields[0]!.texts.kk;
      expect(kk.translation).toMatchObject({
        text: "Иінтіректер",
        origin: "ai",
        isManuallyEdited: false,
        aiModel: null,
      });
      expect(kk.task).toMatchObject({ state: "queued" });
      expectError(
        await asAdmin("post", `/admin/translations/category/${category.id}/name/en/release`),
        404,
        "NOT_FOUND",
      );
      expect(await journalActions()).toContain(auditActions.catalogTranslationReleased);
      // Nothing to release / retranslate for a language that isn't a target, or a field it hasn't.
      expectError(
        await asAdmin("post", `/admin/translations/category/${category.id}/unit/kk/retranslate`),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("lists what waits or is out of date, with the volume by state, filters and pages (AC-9)", async () => {
      await createCategory({ ru: "Один" });
      const outdated = await createCategory({ ru: "Два", kk: "Екі" });
      await patchCategory(outdated, { names: { ru: "Два и два" } });
      const cleared = await createCategory({ ru: "Три" });
      await db.query("DELETE FROM translation_task WHERE entity_id = $1 AND lang = 'kk'", [
        cleared.id,
      ]);
      const failed = await createCategory({ ru: "Четыре" });
      await db.query(
        "UPDATE translation_task SET status = 'failed', failure = 'wrong_language' WHERE entity_id = $1 AND lang = 'en'",
        [failed.id],
      );

      const list = async (query = "") => {
        const response = await asAdmin("get", `/admin/translations${query}`);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return translationQueuePageSchema.parse(response.body);
      };
      const all = await list();
      expect(all.total).toBe(8);
      expect(all.counts).toEqual({ missing: 1, queued: 5, failed: 1, outdated: 1 });
      const byKey = new Map(all.items.map((item) => [`${item.sourceText}/${item.lang}`, item]));
      expect(byKey.get("Один/kk")).toMatchObject({ state: "queued", currentText: null });
      expect(byKey.get("Два и два/kk")).toMatchObject({
        state: "outdated",
        currentText: "Екі",
        currentOrigin: "manual",
        isSourceChanged: true,
      });
      expect(byKey.get("Три/kk")).toMatchObject({ state: "missing" });
      expect(byKey.get("Четыре/en")).toMatchObject({ state: "failed", failure: "wrong_language" });

      const failedOnly = await list("?state=failed");
      expect(failedOnly.items.map((item) => item.sourceText)).toEqual(["Четыре"]);
      expect(failedOnly.total).toBe(1);
      expect(failedOnly.counts).toEqual(all.counts);
      const kk = await list("?lang=kk");
      expect(kk.total).toBe(4);
      expect(kk.counts).toEqual({ missing: 1, queued: 2, failed: 0, outdated: 1 });
      expect((await list("?entityType=attribute")).total).toBe(0);
      // Pages by cursor, without gaps or repeats.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const next: Awaited<ReturnType<typeof list>> = await list(
          `?limit=3${cursor ? `&cursor=${cursor}` : ""}`,
        );
        seen.push(...next.items.map((item) => `${item.entityId}/${item.field}/${item.lang}`));
        cursor = next.nextCursor;
        if (!cursor) {
          break;
        }
      }
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
      expectError(
        await asAdmin("get", "/admin/translations?cursor=garbage"),
        400,
        "VALIDATION_ERROR",
      );
    });

    it("is for the admin context only (AC-9)", async () => {
      const category = await createCategory({ ru: "Шины" });
      const routes: [Method, string, object | undefined][] = [
        ["get", "/admin/translations", undefined],
        ["get", `/admin/translations/category/${category.id}`, undefined],
        ["put", `/admin/translations/category/${category.id}/name/kk`, { text: "Шиналар" }],
        ["post", `/admin/translations/category/${category.id}/name/kk/release`, undefined],
        ["post", `/admin/translations/category/${category.id}/name/kk/retranslate`, undefined],
      ];
      const mobile = await mobileToken();
      const cabinet = await cabinetToken();
      for (const [method, path, body] of routes) {
        for (const [bearer, client] of [
          [mobile, IOS],
          [cabinet, SUPPLIER_WEB],
        ] as const) {
          const call = http()
            [method](path)
            .set("X-Client", client)
            .set("Authorization", `Bearer ${bearer}`);
          expectError(await (body ? call.send(body) : call), 403, "FORBIDDEN");
        }
        const anonymous = http()[method](path).set("X-Client", IOS);
        expectError(await (body ? anonymous.send(body) : anonymous), 401, "AUTH_REQUIRED");
      }
      expect(await count("translation", "origin <> 'source'")).toBe(0);
    });
  });

  // ============================================================ the worker

  describe("the worker with the test AI provider", () => {
    it("translates what has no translation, records every call and shows the text to clients (AC-1, AC-2, AC-10, AC-11)", async () => {
      const marker = `Маркер${randomUUID().slice(0, 6)}`;
      rememberSecret(marker);
      const category = await createCategory({ ru: marker });
      const gateway = await startWorker();
      await drained();

      const shown = await names(category.id);
      expect(shown.kk.translation).toMatchObject({
        text: testTranslation(marker, "kk", 40),
        origin: "ai",
        isManuallyEdited: false,
        isSourceChanged: false,
        aiModel: DEFAULT_MODEL,
      });
      expect(shown.en.translation).toMatchObject({
        text: testTranslation(marker, "en", 40),
        origin: "ai",
      });
      // One call for the batch, recorded with usage, cost and no content.
      expect(gateway.requests).toHaveLength(1);
      const { rows: jobs } = await db.query(
        "SELECT * FROM ai_job WHERE kind = 'translate' ORDER BY created_at",
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        kind: "translate",
        provider: "test",
        model: DEFAULT_MODEL,
        initiator_type: "system",
        initiator_id: null,
        status: "succeeded",
        error_kind: null,
        error: null,
        output: null,
        input_ref: { tasks: 2, items: 1 },
      });
      expect(new Set(jobs[0]!.input_ref.languages)).toEqual(new Set(["kk", "en"]));
      expect(jobs[0]!.tokens_in).toBeGreaterThan(0);
      expect(jobs[0]!.tokens_out).toBeGreaterThan(0);
      expect(Number(jobs[0]!.cost_usd)).toBeGreaterThan(0);
      expect(jobs[0]!.latency_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(jobs[0])).not.toContain(marker);
      const { rows: linked } = await db.query(
        "SELECT ai_job_id FROM translation WHERE entity_id = $1 AND origin = 'ai'",
        [category.id],
      );
      expect(linked.map((row) => row.ai_job_id)).toEqual([jobs[0]!.id, jobs[0]!.id]);
      // Clients see the translation on their language, and Russian for one that has none.
      const kk = categoryTreeResponseSchema.parse(
        (await asGuest("/catalog/categories", "kk")).body,
      );
      expect(kk.categories.find((entry) => entry.id === category.id)!.name).toEqual({
        text: testTranslation(marker, "kk", 40),
        isFallback: false,
      });
      const ru = categoryTreeResponseSchema.parse(
        (await asGuest("/catalog/categories", "ru")).body,
      );
      expect(ru.categories.find((entry) => entry.id === category.id)!.name.text).toBe(marker);
      // Nothing of the texts, and no key, reached the log.
      expect(appLogText(output.text())).not.toContain(marker);
    });

    it("translates every kind of text: categories, attributes, units, options and items; brands are names and stay as they are (requirement 2)", async () => {
      const node = await createCategory({ ru: "Тормоза" });
      const pads = await createCategory({ ru: "Колодки" }, "pads", { parentId: node.id });
      const attribute = async (body: object) => {
        const response = await asAdmin(
          "post",
          `/admin/catalog/categories/${pads.id}/attributes`,
          body,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        return (response.body as { attribute: { id: string; options: { id: string }[] } })
          .attribute;
      };
      const thickness = await attribute({
        code: "thickness",
        valueType: "number",
        names: { ru: "Толщина" },
        unit: { ru: "мм" },
        number: { integer: false, min: 1, max: 30 },
      });
      const axle = await attribute({
        code: "axle",
        valueType: "enum",
        names: { ru: "Ось" },
        options: [{ code: "front", names: { ru: "Передняя" } }],
      });
      const brand = await asAdmin("post", "/admin/catalog/brands", {
        name: "Geely",
        aliases: [],
        isOem: true,
      });
      expect(brand.status, JSON.stringify(brand.body)).toBe(201);
      const item = await asAdmin("post", "/admin/catalog/items", {
        type: "part",
        categoryId: pads.id,
        brandId: (brand.body as { brand: { id: string } }).brand.id,
        article: "A-1",
        names: { ru: "Колодка передняя" },
      });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      const itemId = (item.body as { item: { id: string } }).item.id;

      const gateway = await startWorker();
      await drained();
      const expected: [string, string, string, string][] = [
        ["category", node.id, "name", "Тормоза"],
        ["category", pads.id, "name", "Колодки"],
        ["attribute", thickness.id, "name", "Толщина"],
        ["attribute", thickness.id, "unit", "мм"],
        ["attribute", axle.id, "name", "Ось"],
        ["attribute_option", axle.options[0]!.id, "name", "Передняя"],
        ["catalog_item", itemId, "name", "Колодка передняя"],
      ];
      for (const [entityType, entityId, field, russian] of expected) {
        const view = (await translationsOf(entityType, entityId)).fields.find(
          (f) => f.field === field,
        )!;
        expect(view.texts.ru.translation!.text, `${entityType} ${field}`).toBe(russian);
        for (const lang of ["kk", "en"] as const) {
          expect(view.texts[lang].translation, `${entityType} ${field} ${lang}`).toMatchObject({
            origin: "ai",
            isManuallyEdited: false,
            isSourceChanged: false,
          });
        }
      }
      // A unit is told from a name to the provider, and a name of a brand is not sent at all.
      const sent = gateway.requests.flatMap((entry) => entry.input.items);
      expect(sent.find((entry) => entry.text === "мм")!.context).toContain("unit of measure");
      expect(sent.find((entry) => entry.text === "мм")!.maxLength).toBe(12);
      expect(sent.find((entry) => entry.text === "Тормоза")!.maxLength).toBe(40);
      expect(sent.find((entry) => entry.text === "Колодка передняя")!.maxLength).toBe(200);
      expect(
        await count(
          "translation",
          "entity_type NOT IN ('category', 'attribute', 'attribute_option', 'catalog_item')",
        ),
      ).toBe(0);
    });

    it("records a call whose answer does not match its schema as failed, with its cost, and refuses the answer (AC-1, AC-2)", async () => {
      const gateway = await startWorker();
      const ai = worker!.get(AiService);
      const secret = `Текст${randomUUID().slice(0, 6)}`;
      rememberSecret(secret);
      // A valid answer of the provider, judged by an operation that expects another shape.
      const operation = {
        kind: "translate" as const,
        models: {
          primary: "ai_model_translate_primary",
          fallback: "ai_model_translate_fallback",
        } as const,
        outputSchema: z.object({ verdict: z.string() }),
        invoke: (g: AiGateway, input: TranslateInput, model: string, signal: AbortSignal) =>
          g.translate(input, model, signal),
      };
      const request = {
        items: [
          { id: "0", text: secret, context: "a name", maxLength: 40, languages: ["kk"] as const },
        ],
      };
      await expect(
        ai.call(operation, request, { initiator: { type: "system" }, inputRef: { items: 1 } }),
      ).rejects.toMatchObject({ kind: "invalid_output" });
      const { rows } = await db.query(
        "SELECT status, error_kind, error, tokens_in, tokens_out, cost_usd, output FROM ai_job",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "failed",
        error_kind: "invalid_output",
        output: null,
      });
      expect(rows[0]!.error).toContain("verdict");
      // The money was spent: it counts against the day's budget.
      expect(rows[0]!.tokens_in).toBeGreaterThan(0);
      expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
      expect((await ai.budget()).spentUsd).toBeCloseTo(Number(rows[0]!.cost_usd), 6);
      expect(JSON.stringify(rows[0])).not.toContain(secret);
      expect(appLogText(output.text())).not.toContain(secret);
      expect(gateway.requests).toHaveLength(1);
    });

    it("translates in batches of the size the setting says (requirement 3)", async () => {
      await setSettings({ translation_batch_size: 3 });
      for (const name of ["Раз", "Два", "Три", "Четыре", "Пять"]) {
        await createCategory({ ru: name });
      }
      const gateway = await startWorker();
      await drained();
      // 10 tasks, 3 at a time: no request carries more than 3 tasks.
      const perRequest = gateway.requests.map((entry) =>
        entry.input.items.reduce((sum, item) => sum + item.languages.length, 0),
      );
      expect(perRequest.reduce((a, b) => a + b, 0)).toBe(10);
      expect(Math.max(...perRequest)).toBeLessThanOrEqual(3);
      expect(perRequest.length).toBeGreaterThanOrEqual(4);
      expect(await count("ai_job", "status = 'succeeded'")).toBe(perRequest.length);
    });

    it("replaces an automatic translation when the source changes; a manual one stays and is flagged (AC-5)", async () => {
      const category = await createCategory({ ru: "Свечи", kk: "Шамдар" });
      const gateway = await startWorker();
      await drained();
      expect((await names(category.id)).en.translation!.text).toBe(
        testTranslation("Свечи", "en", 40),
      );

      await patchCategory(await currentCategory(category.id), {
        names: { ru: "Свечи зажигания" },
      });
      await drained();
      const shown = await names(category.id);
      expect(shown.en.translation).toMatchObject({
        text: testTranslation("Свечи зажигания", "en", 40),
        origin: "ai",
        isSourceChanged: false,
      });
      expect(shown.kk.translation).toMatchObject({
        text: "Шамдар",
        origin: "manual",
        isSourceChanged: true,
      });
      // Only the English was translated again.
      expect(gateway.requests.at(-1)!.input.items[0]).toMatchObject({ languages: ["en"] });

      // "Translate again": for the automatic text it works, for the manual one it is refused.
      const before = gateway.requests.length;
      await asAdmin(
        "post",
        `/admin/translations/category/${category.id}/name/en/retranslate`,
      ).expect(200);
      await drained();
      expect(gateway.requests.length).toBe(before + 1);
      expectError(
        await asAdmin("post", `/admin/translations/category/${category.id}/name/kk/retranslate`),
        409,
        "TRANSLATION_MANUALLY_EDITED",
      );
      // Released: the Kazakh text is translated again and is the worker's now.
      await asAdmin("post", `/admin/translations/category/${category.id}/name/kk/release`).expect(
        200,
      );
      await drained();
      expect((await names(category.id)).kk.translation).toMatchObject({
        text: testTranslation("Свечи зажигания", "kk", 40),
        origin: "ai",
        isManuallyEdited: false,
        isSourceChanged: false,
      });
    });

    it("does not save a translation that fails the checks, shows it, and does not try again (AC-6)", async () => {
      const gateway = await startWorker();
      const cases = [
        ["empty", "empty"],
        ["too_long", "too_long"],
        ["control_characters", "control_characters"],
        ["wrong_language", "wrong_language"],
      ] as const;
      for (const [mode, failure] of cases) {
        gateway.mode = mode;
        const category = await createCategory({ ru: `Название ${mode}`.slice(0, 40) });
        await waitFor(
          async () => (await tasksOf(category.id)).every((t) => t.status === "failed"),
          `failed ${mode}`,
        );
        expect(await tasksOf(category.id), mode).toMatchObject([
          { lang: "en", status: "failed", failure },
          { lang: "kk", status: "failed", failure },
        ]);
        // Not saved: the client gets Russian.
        expect(await count("translation", `entity_id = '${category.id}' AND lang <> 'ru'`)).toBe(0);
        const tree = categoryTreeResponseSchema.parse(
          (await asGuest("/catalog/categories", "kk")).body,
        );
        expect(tree.categories.find((entry) => entry.id === category.id)!.name.isFallback).toBe(
          true,
        );
      }
      // The operator sees it; nobody tries again by itself.
      const status = await app.get(TranslationQueue).status();
      expect(status.failed).toHaveLength(8);
      expect(status.failedByReason).toMatchObject({
        empty: 2,
        too_long: 2,
        control_characters: 2,
        wrong_language: 2,
      });
      expect(appLogText(output.text())).toContain("Translation refused, not saved");
      gateway.mode = "ok";
      const requests = gateway.requests.length;
      await app.get(TranslationQueue).wake();
      await sleep(2500);
      expect(gateway.requests.length).toBe(requests);
      expect(await count("translation_task", "status = 'failed'")).toBe(8);
      expect(await count("translation", "origin = 'ai'")).toBe(0);
      // An administrator asks again, and now it works.
      const failedTask = status.failed[0]!;
      await asAdmin(
        "post",
        `/admin/translations/${failedTask.entityType}/${failedTask.entityId}/${failedTask.field}/${failedTask.lang}/retranslate`,
      ).expect(200);
      await waitFor(
        async () => (await count("translation", "origin = 'ai'")) === 1,
        "a retranslation",
      );
      // The operator can put them all back.
      expect((await app.get(TranslationQueue).retryFailed()).requeued).toBe(7);
      await waitFor(async () => (await count("translation_task")) === 0, "all retried");
      expect(await count("translation", "origin = 'ai'")).toBe(8);
    });

    it("does not save a translation that a neighbour already has as its name (AC-6)", async () => {
      const gateway = await startWorker();
      const brakes = await createCategory({ ru: "Тормоза", en: "Brakes" });
      await drained();
      // The provider comes up with the neighbour's English name for another category.
      gateway.override = (item, lang) =>
        item.text === "Диски" && lang === "en" ? "brakes" : undefined;
      const discs = await createCategory({ ru: "Диски" });
      // The other task of the category is done and this one refused: all that is left of the run.
      await waitFor(async () => {
        const left = await tasksOf(discs.id);
        return left.length === 1 && left[0]!.status === "failed";
      }, "name taken");
      expect(await tasksOf(discs.id)).toMatchObject([
        { lang: "en", status: "failed", failure: "name_taken" },
      ]);
      expect((await names(discs.id)).en.translation).toBeNull();
      expect((await names(discs.id)).kk.translation).toMatchObject({ origin: "ai" });
      expect((await names(brakes.id)).en.translation).toMatchObject({
        text: "Brakes",
        origin: "manual",
      });
    });

    it("keeps the change and the task when the provider is unavailable, retries, then dead-letters it; a later run finishes (AC-7)", async () => {
      await setSettings({ translation_retry_limit: 1, translation_retry_delay_seconds: 1 });
      const gateway = await startWorker();
      gateway.mode = "unavailable";
      const category = await createCategory({ ru: "Радиаторы" });
      // The change is saved and readable as before.
      expect((await names(category.id)).ru.translation!.text).toBe("Радиаторы");
      const jobs = app.get(JobAdmin);
      await waitFor(
        async () => (await jobs.deadJobs("catalog.translate")).length === 1,
        "the dead letter queue",
        30_000,
      );
      // Two attempts (first run and one retry), both recorded as failed calls —
      // and each asked both models of the operation, the primary and the fallback
      // (TASK-053: an unreachable provider is what a fallback model is for).
      expect(gateway.requests).toHaveLength(4);
      expect(gateway.requests.map((request) => request.model)).toEqual([
        DEFAULT_MODEL,
        FALLBACK_MODEL,
        DEFAULT_MODEL,
        FALLBACK_MODEL,
      ]);
      expect(await count("ai_job", "status = 'failed' AND error_kind = 'unavailable'")).toBe(2);
      expect(await count("ai_job", "is_fallback")).toBe(2);
      // The tasks wait, marked with a temporary failure; no text was lost or invented.
      expect(await tasksOf(category.id)).toMatchObject([
        { lang: "en", status: "pending", last_error: "unavailable" },
        { lang: "kk", status: "pending", last_error: "unavailable" },
      ]);
      expect((await tasksOf(category.id))[0]!.attempts).toBeGreaterThanOrEqual(2);
      expect((await names(category.id)).kk.translation).toBeNull();
      const [dead] = await jobs.deadJobs("catalog.translate");
      expect(dead!.error).toContain("unavailable");
      // The safety net leaves tasks that failed for a temporary reason alone.
      await db.query("UPDATE translation_task SET updated_at = now() - interval '1 hour'");
      expect(await worker!.get(TranslationWake).run()).toEqual({ worked: false });
      // The provider is back; the operator puts the dead job back.
      gateway.mode = "ok";
      await jobs.retryDead(dead!.id);
      await drained();
      expect((await names(category.id)).kk.translation).toMatchObject({ origin: "ai" });
      expect(await jobs.deadJobs("catalog.translate")).toHaveLength(0);
    });

    it("sends a refusal for good straight to the dead letter queue, and a slow provider counts as unavailable (AC-1, AC-7)", async () => {
      await setSettings({ translation_retry_limit: 0 });
      const gateway = await startWorker({ aiTimeoutMs: 400 });
      gateway.mode = "rejected";
      const first = await createCategory({ ru: "Фильтры" });
      const jobs = app.get(JobAdmin);
      await waitFor(
        async () => (await jobs.deadJobs("catalog.translate")).length === 1,
        "a refusal in the dead letter queue",
      );
      expect(await count("ai_job", "error_kind = 'rejected'")).toBe(1);
      expect(await tasksOf(first.id)).toHaveLength(2);

      // Slow: cut after 400 ms, recorded as unavailable.
      gateway.mode = "slow";
      gateway.delayMs = 5000;
      await createCategory({ ru: "Ремни" });
      await waitFor(
        async () => (await count("ai_job", "error_kind = 'unavailable'")) === 1,
        "a cut call",
      );
      const { rows } = await db.query<{ error: string; latency_ms: number }>(
        "SELECT error, latency_ms FROM ai_job WHERE error_kind = 'unavailable'",
      );
      expect(rows[0]!.error).toContain("took longer than 400 ms");
      expect(rows[0]!.latency_ms).toBeGreaterThanOrEqual(350);
      expect(rows[0]!.latency_ms).toBeLessThan(4000);
    });

    it("stops sending when the day's budget is spent, between batches, and goes on when it allows (AC-7)", async () => {
      await setSettings({ translation_batch_size: 2, ai_daily_budget_usd: 0 });
      const first = await createCategory({ ru: "Первая" });
      await createCategory({ ru: "Вторая" });
      await createCategory({ ru: "Третья" });
      const gateway = await startWorker();
      await waitFor(
        () => appLogText(output.text()).includes("AI daily budget exhausted"),
        "the budget event",
      );
      await sleep(500);
      // Nothing was sent or recorded, no job died, every change is intact, the tasks wait.
      expect(gateway.requests).toHaveLength(0);
      expect(await count("ai_job")).toBe(0);
      expect(await count("translation_task", "status = 'pending' AND attempts = 0")).toBe(6);
      expect(await app.get(JobAdmin).deadJobs("catalog.translate")).toHaveLength(0);
      expect((await names(first.id)).ru.translation!.text).toBe("Первая");
      const ai = await worker!.get(AiService).status();
      expect(ai).toMatchObject({ exhausted: true, budgetUsd: 0, provider: "test" });

      // A budget that lets the first batch through and is spent by it: the second is not sent.
      await setSettings({ ai_daily_budget_usd: 0.000001 });
      await app.get(TranslationQueue).wake();
      await waitFor(async () => (await count("ai_job", "status = 'succeeded'")) === 1, "one batch");
      await sleep(1500);
      expect(gateway.requests).toHaveLength(1);
      expect(await count("translation_task")).toBe(4);
      expect(await count("translation", "origin = 'ai'")).toBe(2);

      // The safety net doesn't wake a spent budget; a raised one lets the rest through.
      await db.query("UPDATE translation_task SET updated_at = now() - interval '1 hour'");
      expect(await worker!.get(TranslationWake).run()).toEqual({ worked: false });
      await setSettings({ ai_daily_budget_usd: 100 });
      expect(await worker!.get(TranslationWake).run()).toEqual({ worked: true });
      await drained();
      expect(await count("translation", "origin = 'ai'")).toBe(6);
    });

    it("saves the translation of the last text when the source changes during the call (edge cases)", async () => {
      const gateway = await startWorker();
      gateway.mode = "slow";
      gateway.delayMs = 1500;
      const category = await createCategory({ ru: "Старое" });
      await waitFor(() => gateway.requests.length === 1, "the first call");
      const changed = await patchCategory(category, { names: { ru: "Новое" } });
      expect(changed.names.ru!.text).toBe("Новое");
      gateway.mode = "ok";
      await drained();
      const shown = await names(category.id);
      expect(shown.kk.translation).toMatchObject({
        text: testTranslation("Новое", "kk", 40),
        isSourceChanged: false,
      });
      expect(shown.en.translation).toMatchObject({ text: testTranslation("Новое", "en", 40) });
      // The first answer was for the old text: paid for, recorded, and not saved.
      expect(await count("ai_job", "status = 'succeeded'")).toBe(2);
      expect(appLogText(output.text())).toContain("superseded=");
    });

    it("never overwrites a text written by hand while its translation is being made (AC-4)", async () => {
      const gateway = await startWorker();
      gateway.mode = "slow";
      gateway.delayMs = 1500;
      const category = await createCategory({ ru: "Сцепление" });
      await waitFor(() => gateway.requests.length === 1, "the call in flight");
      await asAdmin("put", `/admin/translations/category/${category.id}/name/kk`, {
        text: "Ілінісу",
      }).expect(200);
      gateway.mode = "ok";
      await drained();
      const shown = await names(category.id);
      expect(shown.kk.translation).toMatchObject({ text: "Ілінісу", origin: "manual" });
      expect(shown.en.translation).toMatchObject({ origin: "ai" });
    });

    it("drops the task of a text that is gone, and never translates a task twice (AC-8)", async () => {
      await setSettings({ ai_daily_budget_usd: 0 });
      const kept = await createCategory({ ru: "Остаётся" });
      const gone = await createCategory({ ru: "Исчезает" });
      const gateway = await startWorker();
      await sleep(1000);
      await db.query("DELETE FROM translation WHERE entity_id = $1", [gone.id]);
      await setSettings({ ai_daily_budget_usd: 100 });
      // Several runs at once, more than there is work for.
      for (let index = 0; index < 5; index += 1) {
        await app.get(TranslationQueue).wake();
      }
      await drained();
      const requested = gateway.requests.flatMap((entry) => entry.input.items);
      expect(requested.map((item) => item.text)).toEqual(["Остаётся"]);
      expect([...requested[0]!.languages].sort()).toEqual(["en", "kk"]);
      expect(await count("translation", `entity_id = '${kept.id}' AND origin = 'ai'`)).toBe(2);
      expect(await count("translation", `entity_id = '${gone.id}'`)).toBe(0);
    });

    it("translates each task once with two workers at once, and the same run repeated changes nothing (AC-8)", async () => {
      await setSettings({ translation_batch_size: 2 });
      for (let index = 0; index < 8; index += 1) {
        await createCategory({ ru: `Категория ${index}` });
      }
      const first = await startWorker();
      const second = await NestFactory.createApplicationContext(
        WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 200 }, jobs: FAST }),
        { bufferLogs: true },
      );
      try {
        second.useLogger(second.get(JsonLoggerService));
        await drained();
        const asked = [...first.requests, ...(second.get(AiGateway) as TestAiGateway).requests]
          .flatMap((entry) => entry.input.items)
          .flatMap((item) => item.languages.map((lang) => `${item.text}/${lang}`));
        expect(asked).toHaveLength(16);
        expect(new Set(asked).size).toBe(16);
        expect(await count("translation", "origin = 'ai'")).toBe(16);
        // Running the job again finds nothing to do.
        const before = await count("ai_job");
        await second
          .get(TranslationRunner)
          .run({}, { jobId: "again", attempt: 1, signal: new AbortController().signal });
        expect(await count("ai_job")).toBe(before);
        expect(await count("translation", "origin = 'ai'")).toBe(16);
      } finally {
        await second.close();
      }
    });

    it("queues what was never translated on the operator's request only (requirement 7)", async () => {
      const category = await createCategory({ ru: "Наследие" });
      await db.query("DELETE FROM translation_task WHERE entity_id = $1", [category.id]);
      expect((await names(category.id)).kk.translation).toBeNull();
      expect(await app.get(TranslationQueue).queueMissing()).toEqual({ queued: 2 });
      expect(await app.get(TranslationQueue).queueMissing()).toEqual({ queued: 0 });
      await startWorker();
      await drained();
      expect((await names(category.id)).kk.translation).toMatchObject({ origin: "ai" });
      expect(await app.get(TranslationQueue).queueMissing()).toEqual({ queued: 0 });
    });

    it("publishes the AI spend and the queue as metrics", async () => {
      await createCategory({ ru: "Метрики" });
      await startWorker();
      await drained();
      const text = (await http().get("/metrics")).text;
      expect(text).toMatch(/adclub_ai_spend_today_usd [0-9.]+/);
      expect(text).toContain("adclub_ai_daily_budget_usd 100");
      expect(text).toContain('adclub_ai_calls_today{kind="translate",status="succeeded"} 1');
      expect(text).toContain('adclub_translation_tasks{state="pending"} 0');
      expect(text).toContain('adclub_translation_tasks{state="failed"} 0');
    });
  });

  // ============================================ TASK-053: the gateway itself

  describe("the gateway through OpenRouter (the test provider stands in for it)", () => {
    /** The `ai_job` rows of the day, newest last. */
    async function calls(): Promise<
      {
        model: string;
        status: string;
        error_kind: string | null;
        cost_usd: string | null;
        cost_is_estimate: boolean;
        is_fallback: boolean;
        initiator_type: string;
        initiator_id: string | null;
      }[]
    > {
      const { rows } = await db.query(
        `SELECT model, status, error_kind, cost_usd, cost_is_estimate, is_fallback,
                initiator_type, initiator_id
         FROM ai_job ORDER BY created_at`,
      );
      return rows as never;
    }

    it("takes the model of the setting, and a new setting changes it without a restart (AC-2)", async () => {
      await setSettings({ ai_model_translate_primary: "google/gemini-3.8-flash" });
      const gateway = await startWorker();
      await createCategory({ ru: "Первая" });
      await drained();
      expect(gateway.requests.at(-1)!.model).toBe("google/gemini-3.8-flash");

      // The worker keeps running; only the setting changes.
      await setSettings({ ai_model_translate_primary: "openai/gpt-5.4-mini" });
      await createCategory({ ru: "Вторая" });
      await drained();
      expect(gateway.requests.at(-1)!.model).toBe("openai/gpt-5.4-mini");
      expect((await calls()).map((call) => call.model)).toEqual([
        "google/gemini-3.8-flash",
        "openai/gpt-5.4-mini",
      ]);
    });

    it("uses the fallback model when the first one cannot answer, and records that it did (AC-2)", async () => {
      await setSettings({
        ai_model_translate_primary: "missing/not-a-model",
        ai_model_translate_fallback: "openai/gpt-5.4-mini",
      });
      const gateway = await startWorker();
      const category = await createCategory({ ru: "Запаска" });
      await drained();
      // Both models were asked, in order; the translation is the fallback's.
      expect(gateway.requests.map((request) => request.model)).toEqual([
        "missing/not-a-model",
        "openai/gpt-5.4-mini",
      ]);
      const done = await calls();
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({
        status: "succeeded",
        model: "openai/gpt-5.4-mini",
        is_fallback: true,
      });
      expect((await names(category.id)).kk.translation).toMatchObject({
        origin: "ai",
        aiModel: "openai/gpt-5.4-mini",
      });
      // The trouble with the primary model is in the log, not silent.
      expect(appLogText(output.text())).toContain("missing/not-a-model");
    });

    it("says plainly when no model of the setting can answer, and loses no translation (AC-2)", async () => {
      await setSettings({
        ai_model_translate_primary: "missing/one",
        ai_model_translate_fallback: "missing/two",
        translation_retry_limit: 0,
      });
      await startWorker();
      const category = await createCategory({ ru: "Ничей" });
      // The call is recorded failed a moment before the tasks are given back:
      // wait for the tasks, which is what the assertions below are about.
      await waitFor(
        async () => (await count("translation_task", "last_error IS NOT NULL")) === 2,
        "the tasks given back",
      );
      const [call] = await calls();
      expect(call).toMatchObject({ status: "failed", error_kind: "model_unavailable" });
      // The work is not lost: the tasks are still pending, with the reason of the last try.
      expect(await tasksOf(category.id)).toMatchObject([
        { lang: "en", status: "pending", last_error: "model_unavailable" },
        { lang: "kk", status: "pending", last_error: "model_unavailable" },
      ]);
      const status = await worker!.get(AiService).status();
      expect(status.recentFailures[0]).toMatchObject({ errorKind: "model_unavailable" });
    });

    it("does not send anything when no provider of the model keeps requests unstored (AC-5)", async () => {
      await setSettings({ translation_retry_limit: 0 });
      const gateway = await startWorker();
      gateway.mode = "no_private_provider";
      const category = await createCategory({ ru: "Приватность" });
      await waitFor(
        async () => (await count("translation_task", "last_error IS NOT NULL")) === 2,
        "the tasks given back",
      );
      expect((await calls())[0]).toMatchObject({
        status: "failed",
        error_kind: "no_private_provider",
      });
      // Nothing was translated and nothing was thrown away.
      expect((await names(category.id)).kk.translation).toBeNull();
      expect(await tasksOf(category.id)).toHaveLength(2);
      // The operator sees it.
      const status = await worker!.get(AiService).status();
      expect(status.recentFailures[0]).toMatchObject({ errorKind: "no_private_provider" });
      // The fallback model is not tried: the request was never made, another model would not help.
      expect(gateway.requests.map((request) => request.model)).toEqual([
        (await new TestSettings(app).values()).ai_model_translate_primary,
      ]);
    });

    it("counts what the provider says the call cost, and an unknown cost as the reservation (AC-3)", async () => {
      await setSettings({ ai_call_reservation_usd: 0.07 });
      const gateway = await startWorker();
      await createCategory({ ru: "Стоимость" });
      await drained();
      const [reported] = await calls();
      const answered = gateway.requests.length;
      expect(answered).toBe(1);
      expect(reported).toMatchObject({ cost_is_estimate: false });
      // The provider's own figure, not a price list of ours, and not the reservation.
      expect(Number(reported!.cost_usd)).toBeGreaterThan(0);
      expect(Number(reported!.cost_usd)).not.toBeCloseTo(0.07, 6);

      gateway.mode = "no_cost";
      await createCategory({ ru: "Безмолвие" });
      await drained();
      const silent = (await calls()).at(-1)!;
      expect(silent).toMatchObject({ status: "succeeded", cost_is_estimate: true });
      // Not free: the reservation stays as the cost of the call.
      expect(Number(silent.cost_usd)).toBeCloseTo(0.07, 6);
      const status = await worker!.get(AiService).status();
      expect(status.estimatedCostCalls).toBe(1);
      expect(status.spentUsd).toBeCloseTo(Number(reported!.cost_usd) + 0.07, 6);
    });

    it("lets no two calls at once past the daily budget (AC-3)", async () => {
      // Room for two calls of the reservation, asked for by four at the same time.
      await setSettings({ ai_call_reservation_usd: 0.5, ai_daily_budget_usd: 1 });
      const gateway = await startWorker();
      gateway.mode = "slow";
      gateway.delayMs = 1000;
      const ai = worker!.get(AiService);
      const one = (index: number) =>
        ai.translate(
          {
            items: [
              {
                id: "0",
                text: `Параллель ${index}`,
                context: "a name",
                maxLength: 40,
                languages: ["kk"] as const,
              },
            ],
          },
          { initiator: { type: "system" }, inputRef: { items: 1 } },
        );
      const outcomes = await Promise.allSettled([one(1), one(2), one(3), one(4)]);
      const refused = outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" &&
          (outcome.reason as Error).name === "AiBudgetExhaustedError",
      );
      // Two got in (0.5 + 0.5 = the budget), the others were told the budget is spent
      // before anything was sent — they never reached the provider.
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
      expect(refused).toHaveLength(2);
      expect(gateway.requests).toHaveLength(2);
      expect(await count("ai_job")).toBe(2);
      const spent = (await calls()).reduce((sum, call) => sum + Number(call.cost_usd), 0);
      expect(spent).toBeLessThanOrEqual(1);
    });

    it("asks again for a part of the batch the provider left out, instead of calling it empty (AC-4)", async () => {
      await setSettings({ translation_batch_size: 10, translation_retry_limit: 1 });
      const gateway = await startWorker();
      gateway.mode = "incomplete";
      const category = await createCategory({ ru: "Неполный" });
      // The last text of every answer is missing: its task stays pending with a
      // temporary reason, and never becomes a refusal for good.
      await waitFor(
        async () => (await count("translation_task", "last_error = 'incomplete_answer'")) > 0,
        "a task asked again",
      );
      const tasks = await tasksOf(category.id);
      expect(tasks.every((task) => task.status === "pending")).toBe(true);
      expect(tasks.some((task) => task.failure !== null)).toBe(false);
      expect(await count("translation_task", "failure = 'empty'")).toBe(0);
      // And the run stopped instead of asking the same provider again at once:
      // a tight loop here would be paid calls, one after another.
      await sleep(1000);
      expect(await count("ai_job")).toBeLessThan(5);

      // When the provider answers in full again, the missing text is translated.
      gateway.mode = "ok";
      await app.get(TranslationQueue).wake();
      await drained();
      expect((await names(category.id)).kk.translation).toMatchObject({ origin: "ai" });
      expect((await names(category.id)).en.translation).toMatchObject({ origin: "ai" });
    });

    it("records the administrator who asked for a translation, not the system (AC-4)", async () => {
      const category = await createCategory({ ru: "Инициатор" });
      const gateway = await startWorker();
      await drained();
      // The first translation was nobody's in particular: a Russian text was written.
      expect((await calls())[0]).toMatchObject({ initiator_type: "system", initiator_id: null });

      // "Translate again", pressed by an administrator.
      await asAdmin(
        "post",
        `/admin/translations/category/${category.id}/name/kk/retranslate`,
      ).expect(200);
      await drained();
      const { rows } = await db.query<{ account_id: string }>(
        "SELECT account_id FROM admin_user LIMIT 1",
      );
      const last = (await calls()).at(-1)!;
      expect(last).toMatchObject({ initiator_type: "account", initiator_id: rows[0]!.account_id });
      expect(gateway.requests.at(-1)!.input.items[0]!.text).toBe("Инициатор");
    });

    it("shows the operator the failures of this day only (AC-4)", async () => {
      await setSettings({ translation_retry_limit: 0 });
      const gateway = await startWorker();
      gateway.mode = "unavailable";
      await createCategory({ ru: "Сегодня" });
      await waitFor(async () => (await count("ai_job", "status = 'failed'")) > 0, "a failed call");
      // A failure of an earlier day, written as the worker would have written it.
      await db.query(
        `INSERT INTO ai_job (kind, provider, model, initiator_type, status, error_kind, error,
                             created_at, finished_at)
         VALUES ('translate', 'test', 'google/gemini-3.8-flash', 'system', 'failed', 'unavailable',
                 'yesterday', now() - interval '2 days', now() - interval '2 days')`,
      );
      const status = await worker!.get(AiService).status();
      expect(status.recentFailures).toHaveLength(1);
      expect(status.recentFailures[0]!.error).not.toContain("yesterday");
      // The spend of the day does not count the older call either.
      expect(status.today.every((row) => row.kind === "translate")).toBe(true);
    });

    it("saves a translation without stopping the administrator's work on the catalog (AC-6)", async () => {
      const first = await createCategory({ ru: "Соседка" });
      const other = await createCategory({ ru: "Далёкая" });
      const gateway = await startWorker();
      await drained();

      // A transaction holding the catalog the way a write of an item does.
      const database = app.get(DatabaseService);
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('catalog_structure'))");
        // With the exclusive structure lock of TASK-012 this save would wait for
        // that transaction; now it only needs the names of its own neighbours.
        const runner = worker!.get(TranslationRunner);
        const saved = await Promise.race([
          runner.save(
            {
              id: randomUUID(),
              entityType: "category",
              entityId: other.id,
              field: "name",
              lang: "kk",
              requestedBy: null,
            },
            {
              id: "0",
              entityType: "category",
              entityId: other.id,
              field: "name",
              source: "Далёкая",
              hash: "x",
              tasks: [],
            },
            "Алыс",
            { jobId: randomUUID(), model: "google/gemini-3.8-flash" },
          ),
          sleep(5000).then(() => "waited" as const),
        ]);
        // The task is gone (it was translated already), so the save is a no-op —
        // but it got there and back without waiting for the other transaction.
        expect(saved).toBe("skipped");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect((await names(first.id)).kk.translation).toMatchObject({ origin: "ai" });
      expect(gateway.requests.length).toBeGreaterThan(0);
    });
  });
});
