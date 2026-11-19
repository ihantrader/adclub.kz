import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminHomeSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  createOrderResponseSchema,
  priceImportDetailResponseSchema,
  priceImportResponseSchema,
  priceMatchAuditCardSchema,
  priceMatchAuditConflictDetailsSchema,
  priceMatchAuditMetricsSchema,
  priceMatchAuditPageSchema,
  priceReviewRowsPageSchema,
  priceRowDecidedResponseSchema,
  supplierMatchCorrectionPageSchema,
  supplierModerationSummarySchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
  type PriceImport,
  type PriceImportStatus,
  type PriceMatchAuditCard,
  type PriceReviewGroup,
  type PriceReviewRow,
} from "@adclub/contracts";
import { kzBinCheckDigit, priceAuditBucket, priceAuditReason } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import type { JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { TestAiGateway } from "../ai";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";

/**
 * TASK-065 end to end on a real PostgreSQL, Redis and object storage with a
 * real worker and the test AI gateway (no outside calls): applying a price
 * list puts aside exactly the rows of the rule (the share, «below the bound
 * always», only AI's item accepted, only applied ones; never the memory,
 * the exact article or «Другая позиция»); the memory tells AI's accepted
 * match apart; «Неверно» removes the memory (the same file again goes to
 * AI and to «Нужно проверить»), withdraws the untouched offer and keeps the
 * one with an active order or a hand edit, says so and journals it; two
 * administrators at once — one wins; the accuracy by bucket against an
 * independent count; the home card against the queue; «Модерация» of the
 * supplier with «новое».
 */

const ADMIN_PHONE = "+77010000371";
const SECOND_ADMIN_PHONE = "+77010000372";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const ADMIN_WEB = "admin-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";
const HEADER = "Артикул;Бренд;Наименование;Цена;Наличие;Срок";
const ROLES = ["article", "brand", "name", "price", "availability", "lead_days"] as const;
/** Items made for the test, one per word: rows of these go to AI. */
const WORDS = ["Alfa", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"] as const;

type Method = "get" | "post" | "put" | "patch" | "delete";
type As = (method: Method, path: string, body?: object) => Test;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) return `${prefix}${digit}`;
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

function csv(rows: readonly string[]): Buffer {
  return Buffer.from(`${[HEADER, ...rows].join("\r\n")}\r\n`, "utf8");
}

/** A row of the price list for the item of `word`: no article, a word the item hasn't — AI decides. */
const aiRow = (word: string, price = 5000) => `;;Колодки Testa ${word} керамика;${price};есть;`;

describe("the administrator's check of AI matches of price lists (PostgreSQL + Redis + MinIO)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minio: StartedTestContainer;
  let redis: Redis;
  let db: Client;
  let s3: S3Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let ai: TestAiGateway;
  let output: ReturnType<typeof captureOutput>;
  let token: string;
  let almaty: string;
  let ipCounter = 0;
  let phoneCounter = 0;
  let binCounter = 0;
  /** The confidence AI gives the item of each word. */
  let confidence: Record<string, number>;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();

  beforeAll(async () => {
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
      // See catalog-photos.integration.test.ts for why this image (ARCHITECTURE 4.34 I351).
      new GenericContainer("bitnamilegacy/minio:2025.7.23-debian-12-r5")
        .withEnvironment({
          MINIO_ROOT_USER: MINIO_USER,
          MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
          MINIO_SKIP_CLIENT: "yes",
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp("/minio/health/cluster", 9000))
        .start(),
    ]);
    const endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`;
    runMigrate("up", postgres.getConnectionUri());
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    redis = new Redis(redisContainer.getConnectionUrl());
    s3 = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
    });
    await createBucket();
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY: MINIO_USER,
      S3_SECRET_KEY: MINIO_PASSWORD,
      S3_BUCKET: BUCKET,
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
    await nest.listen(0, "127.0.0.1");
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 50 }, jobs: FAST }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    settings = new TestSettings(worker);
    ai = worker.get(TestAiGateway);
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    s3?.destroy();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    ai.mode = "ok";
    ai.priceMatchRequests.length = 0;
    confidence = {};
    // AI picks the item of the row's word, with the confidence the test set.
    ai.matchOverride = (entry) => {
      const word = WORDS.find((candidate) => (entry.name ?? "").includes(` ${candidate} `));
      if (!word) return undefined;
      const item = entry.candidates.find((candidate) => candidate.name.endsWith(` ${word}`));
      return item ? { itemId: item.id, confidence: confidence[word] ?? 0.95 } : undefined;
    };
    await truncateAll(db);
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      price_match_retry_seconds: 1,
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
  }, 120_000);

  afterEach(() => {
    output?.stop();
    for (const sent of channels.sent) rememberCode(sent.code);
  });

  // ------------------------------------------------------------- plumbing

  async function createBucket(): Promise<void> {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const probe = "storage-ready-check/probe.bin";
    let last: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await s3
          .send(new CreateBucketCommand({ Bucket: BUCKET }))
          .catch((error: { name?: string }) => {
            if (error.name !== "BucketAlreadyOwnedByYou") throw error;
          });
        await s3.send(
          new PutObjectCommand({ Bucket: BUCKET, Key: probe, Body: Buffer.from("ok") }),
        );
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: probe }));
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: probe }));
        return;
      } catch (error) {
        last = error;
        await sleep(300);
      }
    }
    throw new Error(`The storage did not take an object: ${String((last as Error)?.message)}`);
  }

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
      if (refresh) rememberSecret(refresh[1]!);
    }
    if (client === IOS)
      await completeTestRegistration((path) => http().post(path), client, response);
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

  function call(bearer: string, client: string, method: Method, path: string, body?: object) {
    const test = http()
      [method](path)
      .set("X-Client", client)
      .set("X-Forwarded-For", nextIp())
      .set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  const asAdmin: As = (method, path, body) => call(token, ADMIN_WEB, method, path, body);

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  async function ok<T>(test: PromiseLike<Response>, parse: (body: unknown) => T, status = 200) {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  async function idOf(query: string, values: unknown[]): Promise<string> {
    const result = await db.query<{ id: string }>(query, values);
    expect(result.rows, query).toHaveLength(1);
    return result.rows[0]!.id;
  }

  interface Company {
    supplierId: string;
    memberId: string;
    as: As;
  }

  async function company(name: string): Promise<Company> {
    const phone = `+77050${String(200000 + ++phoneCounter)}`;
    rememberCode(phone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712350${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: "goods",
        contactPhone: `+77051${String(200000 + phoneCounter)}`,
        address: `ул. ${name}, 1`,
        district: "Алмалинский",
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
      (body) => adminSupplierResponseSchema.parse(body),
    );
    const response = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const bearer = (response.body as { session: { accessToken: string } }).session.accessToken;
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 AND m.supplier_id = $2",
      [phone, created.supplier.id],
    );
    return {
      supplierId: created.supplier.id,
      memberId,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  /** The items of the words: parts of «Тормозные колодки» named «Колодки Testa <word>». */
  async function items(): Promise<Record<string, string>> {
    const pads = await idOf("SELECT id FROM category WHERE code = 'brake_pads'", []);
    const brand = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'trw'", []);
    const ids: Record<string, string> = {};
    for (const [index, word] of WORDS.entries()) {
      ids[word] = await ok(
        asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: pads,
          brandId: brand,
          article: `TST-${String(100 + index)}`,
          names: { ru: `Колодки Testa ${word}` },
        }),
        (response) => (response as { item: { id: string } }).item.id,
        201,
      );
    }
    return ids;
  }

  async function detail(of: Company, importId: string) {
    return ok(of.as("get", `/supplier/price-imports/${importId}`), (body) =>
      priceImportDetailResponseSchema.parse(body),
    );
  }

  async function settled(
    of: Company,
    importId: string,
    statuses: PriceImportStatus[],
  ): Promise<PriceImport> {
    const until = Date.now() + 60_000;
    for (;;) {
      const found = (await detail(of, importId)).import;
      if (statuses.includes(found.status)) return found;
      if (Date.now() > until) throw new Error(`The import is still ${found.status}`);
      await sleep(200);
    }
  }

  async function imported(of: Company, bytes: Buffer): Promise<PriceImport> {
    const uploaded = await ok(
      of
        .as("post", "/supplier/price-imports?fileName=price.csv")
        .set("Content-Type", "application/octet-stream")
        .send(bytes),
      (body) => priceImportResponseSchema.parse(body).import,
      201,
    );
    const first = await settled(of, uploaded.id, ["columns", "review", "failed"]);
    if (first.status === "columns") {
      await ok(
        of.as("put", `/supplier/price-imports/${uploaded.id}/columns`, {
          roles: ROLES,
          remember: true,
        }),
        (body) => body,
      );
      return settled(of, uploaded.id, ["review"]);
    }
    expect(first.status).not.toBe("failed");
    return first;
  }

  async function rows(of: Company, importId: string, group: PriceReviewGroup) {
    return ok(
      of.as("get", `/supplier/price-imports/${importId}/review/rows?group=${group}&limit=200`),
      (body) => priceReviewRowsPageSchema.parse(body).rows,
    );
  }

  async function aiRowOf(of: Company, importId: string, word: string): Promise<PriceReviewRow> {
    const found = (await rows(of, importId, "review")).find(
      (entry) => entry.parsed?.name?.includes(` ${word} `) === true,
    );
    expect(found, word).toBeDefined();
    expect(found!.aiProposed, word).toBe(true);
    return found!;
  }

  async function decide(of: Company, importId: string, rowNo: number, body: object) {
    const version = (await detail(of, importId)).import.version;
    return ok(
      of.as("put", `/supplier/price-imports/${importId}/review/rows/${String(rowNo)}`, {
        expectedVersion: version,
        ...body,
      }),
      (response) => priceRowDecidedResponseSchema.parse(response),
    );
  }

  async function applied(of: Company, importId: string): Promise<PriceImport> {
    const version = (await detail(of, importId)).import.version;
    await ok(
      of.as("post", `/supplier/price-imports/${importId}/apply`, { expectedVersion: version }),
      (body) => priceImportResponseSchema.parse(body).import,
      202,
    );
    const done = await settled(of, importId, ["applied", "review"]);
    expect(done.status).toBe("applied");
    return done;
  }

  /** Accepts AI's item («Верно») of every word's row, and applies. */
  async function acceptAll(of: Company, importId: string, words: readonly string[]) {
    const byWord: Record<string, PriceReviewRow> = {};
    for (const word of words) {
      const row = await aiRowOf(of, importId, word);
      byWord[word] = row;
      await decide(of, importId, row.rowNo, {
        decision: "accept",
        itemId: row.candidates[0]!.id,
      });
    }
    await applied(of, importId);
    return byWord;
  }

  async function auditRows(importId: string) {
    const result = await db.query<{
      id: string;
      row_no: number;
      reason: string;
      ai_item_id: string;
      offer_id: string | null;
    }>(
      "SELECT id, row_no, reason, ai_item_id, offer_id FROM price_match_audit WHERE import_id = $1 ORDER BY row_no",
      [importId],
    );
    return result.rows;
  }

  async function card(auditId: string): Promise<PriceMatchAuditCard> {
    return ok(asAdmin("get", `/admin/price-match-audit/${auditId}`), (body) =>
      priceMatchAuditCardSchema.parse(body),
    );
  }

  async function customerOrder(offerId: string, price: number): Promise<void> {
    const phone = `+77470${String(200000 + ++phoneCounter)}`;
    rememberCode(phone);
    const response = await signIn(phone, IOS);
    const bearer = (response.body as { session: { accessToken: string } }).session.accessToken;
    await ok(
      asAdmin("post", "/admin/club-access/grants", {
        phone,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        reason: "Тест",
      }),
      (body) => body,
      201,
    );
    const placed = await ok(
      call(bearer, IOS, "post", "/orders", {
        offerId,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: price,
        idempotencyKey: randomUUID(),
      }),
      (body) => createOrderResponseSchema.parse(body).order,
      201,
    );
    rememberCode(placed.confirmation!.code);
  }

  // ---------------------------------------------------------------- tests

  it("puts aside exactly the rows of the rule, and marks AI's accepted match in the memory", async () => {
    const ids = await items();
    await settings.set({ price_match_audit_share: 0.5, price_match_audit_always_below: 0.8 });
    // Alfa, Bravo below the bound (0.6 below the threshold — no proposed item);
    // the others above it, drawn by the share.
    confidence = {
      Alfa: 0.6,
      Bravo: 0.79,
      Charlie: 0.8,
      Delta: 0.9,
      Echo: 0.95,
      Foxtrot: 0.97,
      Golf: 0.99,
      Hotel: 0.6,
    };
    const shop = await company("Автомир");
    const entry = await imported(
      shop,
      csv([
        ...WORDS.map((word) => aiRow(word)),
        // By the exact article and brand: never in the audit.
        "04465-0K090;Geely;Колодки передние;12000;есть;",
      ]),
    );
    const accepted = ["Alfa", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"] as const;
    const byWord: Record<string, PriceReviewRow> = {};
    for (const word of accepted) {
      const row = await aiRowOf(shop, entry.id, word);
      byWord[word] = row;
      await decide(shop, entry.id, row.rowNo, {
        decision: "accept",
        itemId: row.candidates[0]!.id,
      });
    }
    // «Другая позиция» on Golf (to Hotel's item, applied); Hotel's own row skipped.
    const golf = await aiRowOf(shop, entry.id, "Golf");
    await decide(shop, entry.id, golf.rowNo, { decision: "other", itemId: ids.Hotel! });
    const hotel = await aiRowOf(shop, entry.id, "Hotel");
    await decide(shop, entry.id, hotel.rowNo, { decision: "skip" });
    await applied(shop, entry.id);
    const golfOutcome = await db.query<{ outcome: string }>(
      "SELECT outcome FROM price_import_row WHERE import_id = $1 AND row_no = $2",
      [entry.id, golf.rowNo],
    );
    expect(golfOutcome.rows[0]!.outcome).toBe("created");

    const expected = accepted.flatMap((word) => {
      const reason = priceAuditReason(
        {
          id: `${entry.id}:${String(byWord[word]!.rowNo)}`,
          aiProposed: true,
          decision: "accept",
          decisionItemId: ids[word]!,
          aiItemId: ids[word]!,
          aiConfidence: confidence[word]!,
          outcome: "created",
        },
        { share: 0.5, alwaysBelow: 0.8 },
      );
      return reason ? [{ rowNo: byWord[word]!.rowNo, reason, itemId: ids[word]! }] : [];
    });
    const stored = await auditRows(entry.id);
    expect(
      stored.map((row) => ({ rowNo: row.row_no, reason: row.reason, itemId: row.ai_item_id })),
    ).toEqual(expected.sort((a, b) => a.rowNo - b.rowNo));
    // Both rows below the bound are there, whatever the draw says.
    expect(
      stored
        .filter((row) => row.reason === "below")
        .map((row) => row.ai_item_id)
        .sort(),
    ).toEqual([ids.Alfa!, ids.Bravo!].sort());
    for (const row of stored) expect(row.offer_id).not.toBeNull();

    // The memory tells AI's accepted match from the supplier's own choice.
    const memory = await db.query<{ item_id: string; confirmed_by: string }>(
      "SELECT item_id, confirmed_by FROM supplier_sku_mapping WHERE supplier_id = $1 AND decision = 'item'",
      [shop.supplierId],
    );
    const by = new Map(memory.rows.map((row) => [row.item_id, row.confirmed_by]));
    for (const word of accepted) expect(by.get(ids[word]!), word).toBe("supplier_ai");
    expect(by.get(ids.Hotel!)).toBe("supplier");

    // The same file again: everything by the memory — nothing new is put aside.
    await settings.set({ price_match_audit_share: 1, price_match_audit_always_below: 1 });
    const again = await imported(
      shop,
      csv([...WORDS.map((word) => aiRow(word)), "04465-0K090;Geely;Колодки передние;12000;есть;"]),
    );
    for (const row of await rows(shop, again.id, "review")) {
      if (row.aiProposed) await decide(shop, again.id, row.rowNo, { decision: "skip" });
    }
    await applied(shop, again.id);
    expect(await auditRows(again.id)).toEqual([]);

    // An AI row the supplier accepted that wasn't applied (no price confirmation…) — not here.
    // Rows of AI's item at share 1: all of them.
    const other = await company("Шины Юг");
    const third = await imported(other, csv(WORDS.slice(0, 3).map((word) => aiRow(word))));
    await acceptAll(other, third.id, WORDS.slice(0, 3));
    expect((await auditRows(third.id)).length).toBe(3);
  });

  it("«Неверно» removes the memory and withdraws only the untouched offer; «Верно» closes; one of two admins wins", async () => {
    const ids = await items();
    await settings.set({ price_match_audit_share: 1, price_match_audit_always_below: 0.9 });
    confidence = { Alfa: 0.95, Bravo: 0.88, Charlie: 0.72, Delta: 0.99, Echo: 0.6 };
    const shop = await company("Автомир");
    const words = ["Alfa", "Bravo", "Charlie", "Delta", "Echo"] as const;
    const file = csv(words.map((word) => aiRow(word)));
    const entry = await imported(shop, file);
    await acceptAll(shop, entry.id, words);
    const stored = await auditRows(entry.id);
    expect(stored).toHaveLength(5);
    const auditOf = (word: string) => stored.find((row) => row.ai_item_id === ids[word])!;

    // Bravo's offer gets an active order; Charlie's is edited by hand.
    const bravo = auditOf("Bravo");
    await customerOrder(bravo.offer_id!, 5000);
    const charlie = auditOf("Charlie");
    const charlieVersion = (
      await db.query<{ version: number }>("SELECT version FROM offer WHERE id = $1", [
        charlie.offer_id,
      ])
    ).rows[0]!.version;
    await ok(
      shop.as("patch", `/supplier/offers/${charlie.offer_id!}`, {
        expectedVersion: charlieVersion,
        price: 5500,
      }),
      (body) => supplierOfferResponseSchema.parse(body),
    );

    // The home card is the total of the queue.
    const queue = await ok(asAdmin("get", "/admin/price-match-audit"), (body) =>
      priceMatchAuditPageSchema.parse(body),
    );
    const home = await ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
    expect(queue.total).toBe(5);
    expect(home.priceMatchAuditWaiting).toBe(queue.total);
    // Oldest first: the order of the rows put aside.
    expect(queue.counts).toEqual({ pending: 5, correct: 0, wrong: 0 });
    // Pages of two: all five rows once (they share one moment of the application).
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const pageOf: ReturnType<typeof priceMatchAuditPageSchema.parse> = await ok(
        asAdmin(
          "get",
          `/admin/price-match-audit?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
        (body) => priceMatchAuditPageSchema.parse(body),
      );
      walked.push(...pageOf.audits.map((audit) => audit.id));
      cursor = pageOf.nextCursor;
    } while (cursor);
    expect(walked).toHaveLength(5);
    expect(new Set(walked)).toEqual(new Set(stored.map((row) => row.id)));

    // The card: the row, AI's item, its confidence and model, who accepted, what «Неверно» would do.
    const alfa = auditOf("Alfa");
    const alfaCard = await card(alfa.id);
    expect(alfaCard.audit).toMatchObject({
      status: "pending",
      row: { name: "Колодки Testa Alfa керамика", price: 5000 },
      aiConfidence: 0.95,
      bucket: "gte_0_95",
      reason: "share",
      acceptedBy: { memberId: shop.memberId },
    });
    expect(alfaCard.audit.aiItem?.id).toBe(ids.Alfa);
    expect(alfaCard.audit.aiModel).toEqual(expect.any(String));
    expect(alfaCard.offer).toMatchObject({
      status: "active",
      willWithdraw: true,
      keepReason: null,
    });
    expect((await card(bravo.id)).offer).toMatchObject({
      activeOrders: 1,
      willWithdraw: false,
      keepReason: "active_orders",
    });
    expect((await card(charlie.id)).offer).toMatchObject({
      editedByHand: true,
      willWithdraw: false,
      keepReason: "edited",
    });

    // Both or neither — 400.
    expectError(
      await asAdmin("post", `/admin/price-match-audit/${alfa.id}/wrong`, {
        expectedVersion: 1,
        correctItemId: ids.Golf,
        notInCatalog: true,
      }),
      400,
      "VALIDATION_ERROR",
    );
    expectError(
      await asAdmin("post", `/admin/price-match-audit/${alfa.id}/wrong`, { expectedVersion: 1 }),
      400,
      "VALIDATION_ERROR",
    );

    // «Неверно» with the right item.
    const wrongAlfa = await ok(
      asAdmin("post", `/admin/price-match-audit/${alfa.id}/wrong`, {
        expectedVersion: 1,
        correctItemId: ids.Golf,
        comment: "Это Golf",
      }),
      (body) => priceMatchAuditCardSchema.parse(body),
    );
    expect(wrongAlfa.audit).toMatchObject({
      status: "wrong",
      notInCatalog: false,
      result: { memoryRemoved: true, offerWithdrawn: true, keepReason: null },
    });
    expect(wrongAlfa.audit.correctItem?.id).toBe(ids.Golf);
    const alfaOffer = await db.query<{ status: string; withdrawn_reason: string }>(
      "SELECT status, withdrawn_reason FROM offer WHERE id = $1",
      [alfa.offer_id],
    );
    expect(alfaOffer.rows[0]).toEqual({ status: "withdrawn", withdrawn_reason: "match_corrected" });

    // «Неверно», no such item: the offers with an order and a hand edit stay, and the result says so.
    const wrongBravo = await ok(
      asAdmin("post", `/admin/price-match-audit/${bravo.id}/wrong`, {
        expectedVersion: 1,
        notInCatalog: true,
      }),
      (body) => priceMatchAuditCardSchema.parse(body),
    );
    expect(wrongBravo.audit.result).toEqual({
      memoryRemoved: true,
      offerId: bravo.offer_id,
      offerWithdrawn: false,
      keepReason: "active_orders",
      activeOrders: 1,
    });
    const wrongCharlie = await ok(
      asAdmin("post", `/admin/price-match-audit/${charlie.id}/wrong`, {
        expectedVersion: 1,
        notInCatalog: true,
      }),
      (body) => priceMatchAuditCardSchema.parse(body),
    );
    expect(wrongCharlie.audit.result).toMatchObject({
      offerWithdrawn: false,
      keepReason: "edited",
    });
    const kept = await db.query<{ status: string }>(
      "SELECT status FROM offer WHERE id = ANY($1::uuid[])",
      [[bravo.offer_id, charlie.offer_id]],
    );
    expect(kept.rows.map((row) => row.status)).toEqual(["active", "active"]);

    // Two administrators at once on Delta: one 200, the other 409 with who decided.
    const second = await setUpAdmin(SECOND_ADMIN_PHONE);
    const delta = auditOf("Delta");
    const [one, two] = await Promise.all([
      asAdmin("post", `/admin/price-match-audit/${delta.id}/correct`, { expectedVersion: 1 }),
      call(second, ADMIN_WEB, "post", `/admin/price-match-audit/${delta.id}/wrong`, {
        expectedVersion: 1,
        notInCatalog: true,
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const lost = one.status === 409 ? one : two;
    expectError(lost, 409, "PRICE_MATCH_AUDIT_CONFLICT");
    expect(priceMatchAuditConflictDetailsSchema.parse(lost.body.details)).toMatchObject({
      version: 2,
      decidedBy: { adminId: expect.any(String) },
      decidedAt: expect.any(String),
    });
    // «Верно» on Echo.
    await ok(
      asAdmin("post", `/admin/price-match-audit/${auditOf("Echo").id}/correct`, {
        expectedVersion: 1,
      }),
      (body) => priceMatchAuditCardSchema.parse(body),
    );

    // The journal.
    const journal = await db.query<{ action: string; entity_id: string }>(
      "SELECT action, entity_id FROM audit_log WHERE action LIKE 'price_match_audit.%' OR (action = 'offer.withdrawn' AND after->>'reason' = 'match_corrected') ORDER BY created_at",
    );
    // Alfa, Bravo, Charlie — and Delta when the second administrator's «Неверно» won.
    expect(journal.rows.filter((row) => row.action === "price_match_audit.wrong").length).toBe(
      two.status === 200 ? 4 : 3,
    );
    expect(journal.rows.filter((row) => row.action === "price_match_audit.correct").length).toBe(
      one.status === 200 ? 2 : 1,
    );
    // Alfa's offer — and Delta's untouched one when the second administrator's «Неверно» won.
    expect(journal.rows.filter((row) => row.action === "offer.withdrawn")).toEqual([
      { action: "offer.withdrawn", entity_id: alfa.offer_id },
      ...(two.status === 200 ? [{ action: "offer.withdrawn", entity_id: delta.offer_id }] : []),
    ]);

    // The accuracy against an independent count.
    const metrics = await ok(asAdmin("get", "/admin/price-match-audit/metrics?days=7"), (body) =>
      priceMatchAuditMetricsSchema.parse(body),
    );
    const decided = await db.query<{ ai_confidence: string; status: string }>(
      "SELECT ai_confidence, status FROM price_match_audit WHERE status <> 'pending'",
    );
    const independent = new Map<string, { checked: number; correct: number }>();
    for (const row of decided.rows) {
      const bucket = priceAuditBucket(Number(row.ai_confidence));
      const entryOf = independent.get(bucket) ?? { checked: 0, correct: 0 };
      entryOf.checked += 1;
      if (row.status === "correct") entryOf.correct += 1;
      independent.set(bucket, entryOf);
    }
    expect(metrics.checked).toBe(5);
    expect(metrics.correct).toBe(decided.rows.filter((row) => row.status === "correct").length);
    for (const bucket of metrics.buckets) {
      expect({ bucket: bucket.bucket, checked: bucket.checked, correct: bucket.correct }).toEqual({
        bucket: bucket.bucket,
        ...(independent.get(bucket.bucket) ?? { checked: 0, correct: 0 }),
      });
    }
    expect(metrics.proposals).toEqual({ proposed: 5, accepted: 5, acceptedShare: 1 });
    const page = await ok(asAdmin("get", "/admin/price-match-audit?status=wrong"), (body) =>
      priceMatchAuditPageSchema.parse(body),
    );
    expect(page.total).toBe(page.counts.wrong);
    const decidedWalk: string[] = [];
    let decidedCursor: string | null = null;
    do {
      const pageOf: ReturnType<typeof priceMatchAuditPageSchema.parse> = await ok(
        asAdmin(
          "get",
          `/admin/price-match-audit?status=wrong&limit=1${decidedCursor ? `&cursor=${encodeURIComponent(decidedCursor)}` : ""}`,
        ),
        (body) => priceMatchAuditPageSchema.parse(body),
      );
      decidedWalk.push(...pageOf.audits.map((audit) => audit.id));
      decidedCursor = pageOf.nextCursor;
    } while (decidedCursor);
    expect(new Set(decidedWalk).size).toBe(page.total);
    expect(decidedWalk).toHaveLength(page.total);
    const home2 = await ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
    expect(home2.priceMatchAuditWaiting).toBe(0);

    // The supplier's «Модерация»: the corrections, «новое», then seen.
    const summary = await ok(shop.as("get", "/supplier/moderation/summary"), (body) =>
      supplierModerationSummarySchema.parse(body),
    );
    const wrongCount = page.total;
    expect(summary.unseen.corrections).toBe(wrongCount);
    const corrections = await ok(shop.as("get", "/supplier/moderation/match-corrections"), (body) =>
      supplierMatchCorrectionPageSchema.parse(body),
    );
    expect(corrections.total).toBe(wrongCount);
    expect(corrections.entries.every((entryOf) => entryOf.isNew)).toBe(true);
    const alfaCorrection = corrections.entries.find((entryOf) => entryOf.id === alfa.id)!;
    expect(alfaCorrection).toMatchObject({
      row: { name: "Колодки Testa Alfa керамика" },
      offerWithdrawn: true,
      notInCatalog: false,
    });
    expect(alfaCorrection.wrongItem?.id).toBe(ids.Alfa);
    expect(alfaCorrection.correctItem?.id).toBe(ids.Golf);
    await ok(
      shop.as("post", "/supplier/moderation/seen", { seenUntil: summary.serverTime }),
      (body) => supplierModerationSummarySchema.parse(body),
    );
    const seen = await ok(shop.as("get", "/supplier/moderation/match-corrections"), (body) =>
      supplierMatchCorrectionPageSchema.parse(body),
    );
    expect(seen.entries.some((entryOf) => entryOf.isNew)).toBe(false);
    // Another company sees none of them.
    const stranger = await company("Шины Юг");
    expect(
      (
        await ok(stranger.as("get", "/supplier/moderation/match-corrections"), (body) =>
          supplierMatchCorrectionPageSchema.parse(body),
        )
      ).total,
    ).toBe(0);

    // The same file again: the corrected rows go to AI and to «Нужно проверить»; the others by memory.
    ai.priceMatchRequests.length = 0;
    const again = await imported(shop, file);
    expect(ai.priceMatchRequests.length).toBeGreaterThan(0);
    const review = await rows(shop, again.id, "review");
    const reviewed = review.map((row) => row.parsed?.name);
    for (const word of ["Alfa", "Bravo", "Charlie"]) {
      expect(reviewed, word).toContain(`Колодки Testa ${word} керамика`);
      expect(review.find((row) => row.parsed?.name?.includes(` ${word} `))?.source).toBe("ai");
    }
    const confident = await rows(shop, again.id, "confident");
    expect(confident.map((row) => row.parsed?.name)).toContain("Колодки Testa Echo керамика");
  });

  // ------------------------------------------------- TASK-065.A: after acceptance

  async function offerRow(itemId: string, supplierId: string) {
    const found = await db.query<{
      id: string;
      status: string;
      withdrawn_reason: string | null;
      created_import_id: string | null;
    }>(
      "SELECT id, status, withdrawn_reason, created_import_id FROM offer WHERE item_id = $1 AND supplier_id = $2",
      [itemId, supplierId],
    );
    expect(found.rows).toHaveLength(1);
    return found.rows[0]!;
  }

  async function rowOutcome(importId: string, word: string) {
    const found = await db.query<{ outcome: string; outcome_reason: string | null }>(
      "SELECT outcome, outcome_reason FROM price_import_row WHERE import_id = $1 AND parsed->>'name' LIKE $2",
      [importId, `% ${word} %`],
    );
    expect(found.rows, word).toHaveLength(1);
    return found.rows[0]!;
  }

  /** «Поставщики нажали «Верно»» counted by every row of the period, independently. */
  async function independentProposals() {
    const counted = await db.query<{ proposed: number; accepted: number }>(`
      SELECT count(*)::int AS proposed,
        count(*) FILTER (
          WHERE r.decision = 'accept' AND r.decision_item_id = (r.candidates->0->>'itemId')::uuid
        )::int AS accepted
      FROM price_import i JOIN price_import_row r ON r.import_id = i.id
      WHERE i.status = 'applied' AND r.ai_proposed`);
    return counted.rows[0]!;
  }

  async function metricsOf(days: 7 | 30 | 90) {
    return ok(asAdmin("get", `/admin/price-match-audit/metrics?days=${String(days)}`), (body) =>
      priceMatchAuditMetricsSchema.parse(body),
    );
  }

  it("a price list reviewed before «Неверно» does not bring the corrected match back; an explicit choice does (TASK-065.A)", async () => {
    const ids = await items();
    await settings.set({ price_match_audit_share: 1, price_match_audit_always_below: 0.9 });
    confidence = { Alfa: 0.95, Bravo: 0.95 };
    const shop = await company("Автомир");
    const file = csv([aiRow("Alfa"), aiRow("Bravo")]);
    const first = await imported(shop, file);
    await acceptAll(shop, first.id, ["Alfa", "Bravo"]);
    const audits = await auditRows(first.id);
    expect(audits).toHaveLength(2);

    // Two price lists matched by the memory, waiting in their reviews.
    const waiting = await imported(shop, file);
    const chosen = await imported(shop, file);
    for (const entry of [waiting, chosen]) {
      const confident = await rows(shop, entry.id, "confident");
      expect(confident.map((row) => row.source)).toEqual(["mapping", "mapping"]);
    }

    // The administrator finds both matches wrong: memory gone, offers withdrawn.
    for (const audit of audits) {
      await ok(
        asAdmin("post", `/admin/price-match-audit/${audit.id}/wrong`, {
          expectedVersion: 1,
          notInCatalog: true,
        }),
        (body) => priceMatchAuditCardSchema.parse(body),
      );
    }
    for (const word of ["Alfa", "Bravo"]) {
      expect(await offerRow(ids[word]!, shop.supplierId)).toMatchObject({
        status: "withdrawn",
        withdrawn_reason: "match_corrected",
      });
    }

    // Applied as reviewed: neither row applies, the offers stay withdrawn, the memory isn't written again.
    const done = await applied(shop, waiting.id);
    expect(done.result!.notApplied).toEqual([{ reason: "match_corrected", rows: 2 }]);
    expect(done.result!.returned).toBe(0);
    for (const word of ["Alfa", "Bravo"]) {
      expect(await rowOutcome(waiting.id, word)).toEqual({
        outcome: "not_applied",
        outcome_reason: "match_corrected",
      });
      expect((await offerRow(ids[word]!, shop.supplierId)).status).toBe("withdrawn");
    }
    const memory = await db.query(
      "SELECT 1 FROM supplier_sku_mapping WHERE supplier_id = $1 AND decision = 'item'",
      [shop.supplierId],
    );
    expect(memory.rows).toHaveLength(0);

    // «Другая позиция» → Alfa in the other review, after the correction: back on sale.
    const alfaRow = (await rows(shop, chosen.id, "confident")).find((row) =>
      row.parsed?.name?.includes(" Alfa "),
    )!;
    await decide(shop, chosen.id, alfaRow.rowNo, { decision: "other", itemId: ids.Alfa });
    const back = await applied(shop, chosen.id);
    expect(back.result).toMatchObject({
      returned: 1,
      notApplied: [{ reason: "match_corrected", rows: 1 }],
    });
    expect(await offerRow(ids.Alfa!, shop.supplierId)).toMatchObject({
      status: "active",
      withdrawn_reason: null,
    });
    expect((await offerRow(ids.Bravo!, shop.supplierId)).status).toBe("withdrawn");

    // A new price list: Bravo goes to AI again; «Верно» after the correction returns
    // the offer, writes `supplier_ai` again, and the row is put aside as a new check.
    const fresh = await imported(shop, file);
    const bravo = await aiRowOf(shop, fresh.id, "Bravo");
    await decide(shop, fresh.id, bravo.rowNo, {
      decision: "accept",
      itemId: bravo.candidates[0]!.id,
    });
    const third = await applied(shop, fresh.id);
    expect(third.result!.returned).toBe(1);
    expect((await offerRow(ids.Bravo!, shop.supplierId)).status).toBe("active");
    const again = await auditRows(fresh.id);
    expect(again.map((row) => row.ai_item_id)).toEqual([ids.Bravo]);
    const stored = await db.query<{ status: string; row_outcome: string }>(
      "SELECT status, row_outcome FROM price_match_audit WHERE import_id = $1",
      [fresh.id],
    );
    expect(stored.rows).toEqual([{ status: "pending", row_outcome: "returned" }]);
    const by = await db.query<{ confirmed_by: string }>(
      "SELECT confirmed_by FROM supplier_sku_mapping WHERE supplier_id = $1 AND item_id = $2",
      [shop.supplierId, ids.Bravo],
    );
    expect(by.rows).toEqual([{ confirmed_by: "supplier_ai" }]);
  });

  it("«Неверно» withdraws only the offer the row made (TASK-065.A)", async () => {
    const ids = await items();
    await settings.set({ price_match_audit_share: 1, price_match_audit_always_below: 0.9 });
    confidence = { Alfa: 0.95, Bravo: 0.95, Charlie: 0.95, Delta: 0.95 };
    const shop = await company("Автомир");
    // Delta's offer is made by a price list first (its row is put aside too).
    const earlier = await imported(shop, csv([aiRow("Delta")]));
    await acceptAll(shop, earlier.id, ["Delta"]);
    expect((await offerRow(ids.Delta!, shop.supplierId)).created_import_id).toBe(earlier.id);
    // Alfa's and Bravo's — by hand: Alfa just as the file says it, Bravo at another price.
    for (const [word, price] of [
      ["Alfa", 5000],
      ["Bravo", 4000],
    ] as const) {
      await ok(
        shop.as("post", "/supplier/offers", {
          itemId: ids[word],
          price,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
          supplierName: `Колодки Testa ${word} керамика`,
        }),
        (body) => supplierOfferResponseSchema.parse(body),
        201,
      );
    }
    expect((await offerRow(ids.Alfa!, shop.supplierId)).created_import_id).toBeNull();
    const entry = await imported(
      shop,
      csv([
        aiRow("Alfa"),
        aiRow("Bravo"),
        aiRow("Charlie"),
        // Another spelling of Delta: AI again, and the price list changes the offer it made.
        ";;Колодки Testa Delta керамика новые;6000;есть;",
      ]),
    );
    await acceptAll(shop, entry.id, ["Alfa", "Bravo", "Charlie", "Delta"]);
    const audits = await db.query<{ id: string; ai_item_id: string; row_outcome: string }>(
      "SELECT id, ai_item_id, row_outcome FROM price_match_audit WHERE import_id = $1",
      [entry.id],
    );
    const of = (word: string) => audits.rows.find((row) => row.ai_item_id === ids[word])!;
    expect(
      Object.fromEntries(
        ["Alfa", "Bravo", "Charlie", "Delta"].map((word) => [word, of(word).row_outcome]),
      ),
    ).toEqual({ Alfa: "unchanged", Bravo: "updated", Charlie: "created", Delta: "updated" });
    // What «Неверно» would do, said before.
    expect((await card(of("Alfa").id)).offer).toMatchObject({
      willWithdraw: false,
      keepReason: "not_by_row",
    });
    expect((await card(of("Delta").id)).offer).toMatchObject({ willWithdraw: true });

    const results: Record<string, unknown> = {};
    for (const word of ["Alfa", "Bravo", "Charlie", "Delta"]) {
      results[word] = await ok(
        asAdmin("post", `/admin/price-match-audit/${of(word).id}/wrong`, {
          expectedVersion: 1,
          notInCatalog: true,
        }),
        (body) => priceMatchAuditCardSchema.parse(body).audit.result,
      );
    }
    expect(results).toMatchObject({
      Alfa: { offerWithdrawn: false, keepReason: "not_by_row" },
      Bravo: { offerWithdrawn: false, keepReason: "not_by_row" },
      Charlie: { offerWithdrawn: true, keepReason: null },
      Delta: { offerWithdrawn: true, keepReason: null },
    });
    expect(
      Object.fromEntries(
        await Promise.all(
          ["Alfa", "Bravo", "Charlie", "Delta"].map(async (word) => [
            word,
            (await offerRow(ids[word]!, shop.supplierId)).status,
          ]),
        ),
      ),
    ).toEqual({ Alfa: "active", Bravo: "active", Charlie: "withdrawn", Delta: "withdrawn" });

    // The supplier sees why the offer stayed.
    const corrections = await ok(shop.as("get", "/supplier/moderation/match-corrections"), (body) =>
      supplierMatchCorrectionPageSchema.parse(body),
    );
    const byId = new Map(corrections.entries.map((entryOf) => [entryOf.id, entryOf]));
    expect(byId.get(of("Alfa").id)).toMatchObject({
      offerWithdrawn: false,
      keepReason: "not_by_row",
    });
    expect(byId.get(of("Charlie").id)).toMatchObject({ offerWithdrawn: true, keepReason: null });
  });

  it("counts «Верно» of suppliers per import when applied, and the old imports by the migration's portions (TASK-065.A)", async () => {
    await items();
    await settings.set({ price_match_audit_share: 0, price_match_audit_always_below: 0 });
    confidence = { Alfa: 0.95, Bravo: 0.95, Charlie: 0.95, Delta: 0.95 };
    const shop = await company("Автомир");
    const entry = await imported(
      shop,
      csv(["Alfa", "Bravo", "Charlie", "Delta"].map((word) => aiRow(word))),
    );
    // Two accepted, one «Другая позиция», one skipped: four proposals, two accepted.
    const alfa = await aiRowOf(shop, entry.id, "Alfa");
    await decide(shop, entry.id, alfa.rowNo, {
      decision: "accept",
      itemId: alfa.candidates[0]!.id,
    });
    const bravo = await aiRowOf(shop, entry.id, "Bravo");
    await decide(shop, entry.id, bravo.rowNo, {
      decision: "accept",
      itemId: bravo.candidates[0]!.id,
    });
    const charlie = await aiRowOf(shop, entry.id, "Charlie");
    await decide(shop, entry.id, charlie.rowNo, {
      decision: "other",
      itemId: alfa.candidates[0]!.id,
    });
    const delta = await aiRowOf(shop, entry.id, "Delta");
    await decide(shop, entry.id, delta.rowNo, { decision: "skip" });
    await applied(shop, entry.id);
    const other = await company("Шины Юг");
    const second = await imported(other, csv(["Echo", "Foxtrot"].map((word) => aiRow(word))));
    await acceptAll(other, second.id, ["Echo"]);

    const independent = await independentProposals();
    expect(independent).toEqual({ proposed: 6, accepted: 3 });
    const stored = await db.query<{ proposed: number; accepted: number }>(
      "SELECT sum(ai_proposed_rows)::int AS proposed, sum(ai_accepted_rows)::int AS accepted FROM price_import WHERE status = 'applied'",
    );
    expect(stored.rows[0]).toEqual(independent);
    for (const days of [7, 30, 90] as const) {
      expect((await metricsOf(days)).proposals).toEqual({ ...independent, acceptedShare: 0.5 });
    }

    // Imports applied before the counters: the migration counts them, import by import.
    await db.query("UPDATE price_import SET ai_proposed_rows = 0, ai_accepted_rows = 0");
    expect((await metricsOf(90)).proposals.proposed).toBe(0);
    const migration = readFileSync(
      join(
        __dirname,
        "../../../../../infra/migrations/1792720000000_price-match-audit-hardening.sql",
      ),
      "utf8",
    );
    const backfill = /DO \$\$[\s\S]*?END \$\$;/.exec(migration)?.[0];
    expect(backfill).toBeDefined();
    await db.query(backfill!);
    expect((await metricsOf(90)).proposals).toEqual({ ...independent, acceptedShare: 0.5 });
  });

  it("«Неверно» while the supplier applies a price list: 409 to retry, nothing changes (TASK-065.A)", async () => {
    await items();
    await settings.set({ price_match_audit_share: 1, price_match_audit_always_below: 0.9 });
    confidence = { Alfa: 0.95 };
    const shop = await company("Автомир");
    const entry = await imported(shop, csv([aiRow("Alfa")]));
    await acceptAll(shop, entry.id, ["Alfa"]);
    const [audit] = await auditRows(entry.id);
    // An application holds the company's offers for update while it runs.
    const applying = new Client({ connectionString: postgres.getConnectionUri() });
    await applying.connect();
    try {
      await applying.query("BEGIN");
      await applying.query("SELECT id FROM offer WHERE id = $1 FOR UPDATE", [audit!.offer_id]);
      const started = Date.now();
      const busy = await asAdmin("post", `/admin/price-match-audit/${audit!.id}/wrong`, {
        expectedVersion: 1,
        notInCatalog: true,
      });
      expectError(busy, 409, "PRICE_MATCH_AUDIT_BUSY");
      expect(busy.body.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await applying.query("ROLLBACK");
      await applying.end();
    }
    const after = await db.query<{ status: string; version: number }>(
      "SELECT status, version FROM price_match_audit WHERE id = $1",
      [audit!.id],
    );
    expect(after.rows[0]).toEqual({ status: "pending", version: 1 });
    expect(
      (
        await db.query("SELECT 1 FROM supplier_sku_mapping WHERE supplier_id = $1", [
          shop.supplierId,
        ])
      ).rows.length,
    ).toBe(1);
    // The application is over: «Неверно» goes through.
    await ok(
      asAdmin("post", `/admin/price-match-audit/${audit!.id}/wrong`, {
        expectedVersion: 1,
        notInCatalog: true,
      }),
      (body) => priceMatchAuditCardSchema.parse(body),
    );
  });

  it("refuses other sessions and unknown rows", async () => {
    const shop = await company("Автомир");
    expectError(await shop.as("get", "/admin/price-match-audit"), 403, "FORBIDDEN");
    expectError(await asAdmin("get", `/admin/price-match-audit/${randomUUID()}`), 404, "NOT_FOUND");
    expectError(await asAdmin("get", "/supplier/moderation/match-corrections"), 403, "FORBIDDEN");
  });
});
