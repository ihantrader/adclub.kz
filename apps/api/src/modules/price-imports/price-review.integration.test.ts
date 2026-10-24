import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCatalogRequestPageSchema,
  adminCatalogRequestResponseSchema,
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  catalogRequestConflictDetailsSchema,
  catalogRequestDecidedResponseSchema,
  createOrderResponseSchema,
  itemFromRequestResponseSchema,
  priceImportDetailResponseSchema,
  priceImportResponseSchema,
  priceImportStateDetailsSchema,
  priceImportVersionConflictDetailsSchema,
  priceMissingPageSchema,
  priceReviewRowsPageSchema,
  priceReviewSummarySchema,
  priceRowDecidedResponseSchema,
  priceRowsSkippedResponseSchema,
  supplierCatalogRequestPageSchema,
  priceExportLinkSchema,
  supplierBrandSuggestionsSchema,
  supplierCatalogRequestResponseSchema,
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
  type PriceReviewGroup,
  type PriceReviewRow,
  type SupplierOffer,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle } from "@adclub/domain";
import { strFromU8, unzipSync } from "fflate";
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
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { completeTestRegistration } from "../../testing/registration";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { TestAiGateway } from "../ai";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { readPriceFile } from "./file/price-file";
import { writeXlsx } from "./testing/xlsx-writer";

/**
 * TASK-047 end to end on a real PostgreSQL, Redis and object storage with a
 * real worker and the test AI gateway (no outside calls): matching a price
 * list by the remembered match, the exact article and the brand by any
 * spelling, the search by name and AI (sure, below the threshold, «нет»);
 * AI out of reach or out of budget — the import waits and goes on by
 * itself; the groups of the review, «было → стало», a sharp price, the
 * missing offers with their active orders; decisions with the version,
 * the only bulk action, the choice about the missing ones required, the
 * preview; applying in one transaction once (two employees at once), the
 * rules of an offer, new and changed offers, «нет в наличии», the return
 * of a withdrawn one, the missing ones withdrawn by choice, the memory of
 * matches, requests without duplicates, a blocked company, an item gone
 * meanwhile, a price changed by a colleague; the same file again without AI
 * and without a review; requests to add an item in the admin panel and the
 * next price list applying the created item by itself; a company of
 * services; and fifty thousand rows.
 */

const ADMIN_PHONE = "+77010000369";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const ADMIN_WEB = "admin-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";
const HEADER = "Артикул;Бренд;Наименование;Цена;Наличие;Срок";
const ROLES = ["article", "brand", "name", "price", "availability", "lead_days"] as const;

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

/** A price list as a CSV of «Артикул;Бренд;Наименование;Цена;Наличие;Срок». */
function csv(rows: readonly string[]): Buffer {
  return Buffer.from(`${[HEADER, ...rows].join("\r\n")}\r\n`, "utf8");
}

describe("price list matching, review and application (PostgreSQL + Redis + MinIO)", () => {
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
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  const timings: string[] = [];

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
    if (process.env.PRICE_IMPORT_TIMINGS && timings.length > 0) {
      appendFileSync(process.env.PRICE_IMPORT_TIMINGS, `${timings.join("\n")}\n`);
    }
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
    ai.matchOverride = undefined;
    ai.priceMatchRequests.length = 0;
    await truncateAll();
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      price_match_retry_seconds: 1,
    });
    await new TestSettings(app).reload();
    output = captureOutput();
    token = await setUpAdmin();
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

  async function truncateAll(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
        return;
      } catch (error) {
        if (attempt >= 10) throw error;
        await sleep(200);
      }
    }
  }

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

  const itemByArticle = (brandKey: string, article: string) =>
    idOf(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      [brandKey, normalizeArticle(article)],
    );
  const itemByName = (name: string) =>
    idOf(
      "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND field = 'name' AND lang = 'ru' AND text = $1",
      [name],
    );

  interface Company {
    supplierId: string;
    memberId: string;
    name: string;
    as: As;
  }

  /** A company with an address and a schedule around the clock, its employee signed in. */
  async function company(
    name: string,
    options: { type?: "goods" | "services" | "both"; phone?: string } = {},
  ): Promise<Company> {
    const phone = options.phone ?? `+77050${String(100000 + ++phoneCounter)}`;
    rememberCode(phone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: options.type ?? "goods",
        contactPhone: `+77051${String(100000 + phoneCounter)}`,
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
    return member(created.supplier.id, phone, name);
  }

  async function member(supplierId: string, phone: string, name: string): Promise<Company> {
    const response = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const bearer = (response.body as { session: { accessToken: string } }).session.accessToken;
    const memberId = await idOf(
      "SELECT m.id FROM supplier_member m JOIN account a ON a.id = m.account_id WHERE a.phone = $1 AND m.supplier_id = $2",
      [phone, supplierId],
    );
    return {
      supplierId,
      memberId,
      name,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  /** A colleague added in the cabinet and signed in. */
  async function colleague(of: Company, name: string): Promise<Company> {
    const phone = `+77050${String(100000 + ++phoneCounter)}`;
    rememberCode(phone);
    await ok(of.as("post", "/supplier/members", { name, phone }), (body) => body, 201);
    return member(of.supplierId, phone, name);
  }

  async function offer(of: Company, itemId: string, extra: object = {}): Promise<SupplierOffer> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId,
        price: 10_000,
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: false,
        ...extra,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  async function offerNow(offerId: string) {
    const result = await db.query<{
      price: number;
      availability: string;
      lead_days: number;
      status: string;
      withdrawn_reason: string | null;
      version: number;
      supplier_sku: string | null;
      last_import_id: string | null;
    }>(
      "SELECT price, availability, lead_days, status, withdrawn_reason, version, supplier_sku, last_import_id FROM offer WHERE id = $1",
      [offerId],
    );
    return result.rows[0]!;
  }

  async function detail(of: Company, importId: string) {
    return ok(of.as("get", `/supplier/price-imports/${importId}`), (body) =>
      priceImportDetailResponseSchema.parse(body),
    );
  }

  /** Waits until the import is in one of `statuses`. */
  async function settled(
    of: Company,
    importId: string,
    statuses: PriceImportStatus[],
    timeoutMs = 60_000,
    also: (entry: PriceImport) => boolean = () => true,
  ): Promise<PriceImport> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = (await detail(of, importId)).import;
      if (statuses.includes(found.status) && also(found)) return found;
      if (Date.now() > until) throw new Error(`The import is still ${found.status}`);
      await sleep(200);
    }
  }

  /** Uploads a price list; confirms the columns when asked; waits for the review. */
  async function imported(
    of: Company,
    bytes: Buffer,
    until: PriceImportStatus[] = ["review"],
    timeoutMs = 60_000,
  ): Promise<PriceImport> {
    const uploaded = await ok(
      of
        .as("post", "/supplier/price-imports?fileName=price.csv")
        .set("Content-Type", "application/octet-stream")
        .send(bytes),
      (body) => priceImportResponseSchema.parse(body).import,
      201,
    );
    const first = await settled(of, uploaded.id, ["columns", ...until, "failed"], timeoutMs);
    if (first.status === "columns") {
      await ok(
        of.as("put", `/supplier/price-imports/${uploaded.id}/columns`, {
          roles: ROLES,
          remember: true,
        }),
        (body) => body,
      );
      return settled(of, uploaded.id, until, timeoutMs);
    }
    expect(first.status).not.toBe("failed");
    return first;
  }

  async function summary(of: Company, importId: string) {
    return ok(of.as("get", `/supplier/price-imports/${importId}/review`), (body) =>
      priceReviewSummarySchema.parse(body),
    );
  }

  async function rows(
    of: Company,
    importId: string,
    group: PriceReviewGroup,
  ): Promise<PriceReviewRow[]> {
    return ok(
      of.as("get", `/supplier/price-imports/${importId}/review/rows?group=${group}&limit=200`),
      (body) => priceReviewRowsPageSchema.parse(body).rows,
    );
  }

  async function row(of: Company, importId: string, rowNo: number): Promise<PriceReviewRow> {
    for (const group of ["confident", "review", "not_found", "errors"] as const) {
      const found = (await rows(of, importId, group)).find((entry) => entry.rowNo === rowNo);
      if (found) return found;
    }
    throw new Error(`No row ${String(rowNo)}`);
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

  async function chooseMissing(of: Company, importId: string, action: "withdraw" | "keep") {
    const version = (await detail(of, importId)).import.version;
    return ok(
      of.as("put", `/supplier/price-imports/${importId}/review/missing`, {
        expectedVersion: version,
        action,
      }),
      (body) => priceImportResponseSchema.parse(body).import,
    );
  }

  async function applied(of: Company, importId: string, timeoutMs = 60_000): Promise<PriceImport> {
    const version = (await detail(of, importId)).import.version;
    await ok(
      of.as("post", `/supplier/price-imports/${importId}/apply`, { expectedVersion: version }),
      (body) => priceImportResponseSchema.parse(body).import,
      202,
    );
    return settled(of, importId, ["applied", "review"], timeoutMs);
  }

  /** The answers of /health while `work` runs: the slowest and how many. */
  async function healthDuring(work: () => Promise<void>): Promise<{ max: number; count: number }> {
    const health: number[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const started = performance.now();
        const answer = await http().get("/health");
        health.push(performance.now() - started);
        expect(answer.status).toBe(200);
        await sleep(100);
      }
    })();
    try {
      await work();
    } finally {
      polling = false;
      await poller;
    }
    return { max: Math.max(...health), count: health.length };
  }

  async function customerOrder(onOffer: SupplierOffer): Promise<string> {
    const phone = `+77470${String(100000 + ++phoneCounter)}`;
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
        offerId: onOffer.id,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: onOffer.price,
        idempotencyKey: randomUUID(),
      }),
      (body) => createOrderResponseSchema.parse(body).order,
      201,
    );
    rememberCode(placed.confirmation!.code);
    return placed.id;
  }

  async function createItem(body: object): Promise<string> {
    return ok(
      asAdmin("post", "/admin/catalog/items", body),
      (response) => (response as { item: { id: string } }).item.id,
      201,
    );
  }

  const categoryByCode = (code: string) => idOf("SELECT id FROM category WHERE code = $1", [code]);
  const brandByKey = (key: string) =>
    idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = $1", [key]);

  /** Rows of AI: «Mobil Super» sure, «Ultra» below the threshold, «ESP … для дизеля» — none. */
  function decideAi(): void {
    ai.matchOverride = (entry) => {
      const name = entry.name ?? "";
      const pick = (word: string) =>
        entry.candidates.find((candidate) => candidate.name.includes(word))!.id;
      if (name.includes("Super")) return { itemId: pick("Super"), confidence: 0.95 };
      if (name.includes("Ultra")) return { itemId: pick("Ultra"), confidence: 0.6 };
      if (name.includes("дизеля")) return { itemId: null, confidence: 0.9 };
      return undefined;
    };
  }

  // ---------------------------------------------------------------- tests

  it("matches rows by the exact article and brand in any spelling, by the name and by AI", async () => {
    const pads = await categoryByCode("brake_pads");
    const [geely, trw] = await Promise.all([brandByKey("geely"), brandByKey("trw")]);
    // One article at two brands: without a brand the supplier chooses.
    const twinGeely = await createItem({
      type: "part",
      categoryId: pads,
      brandId: geely,
      article: "X-777",
      names: { ru: "Колодки X Geely" },
    });
    const twinTrw = await createItem({
      type: "part",
      categoryId: pads,
      brandId: trw,
      article: "X777",
      names: { ru: "Колодки X TRW" },
    });
    const shop = await company("Автомир");
    decideAi();
    const entry = await imported(
      shop,
      csv([
        "04465-0K090;Джили;Колодки передние;12000;есть;",
        "gdb3534;trw;Колодки TRW;9000;5;",
        "X-777;;Колодки X;5000;есть;",
        ";Shell;Масло моторное Shell Helix HX8 5W-30 4л;8000;есть;",
        ";;Масло Mobil Super 3000 5W-40 4 литра;7000;есть;",
        ";;Масло Shell Helix Ultra 0W-20 1л синтетика;6000;есть;",
        ";;Масло Mobil 1 ESP 5W-30 для дизеля;6500;есть;",
        "ZZZ-404;;Шампанское полусладкое;3000;есть;",
        "04465 0K090;Geely;Повтор колодок;12000;есть;",
        "ABC-1;;Колодки;по запросу;есть;",
      ]),
    );
    expect(entry.match).toMatchObject({
      total: 10,
      done: 10,
      confident: 3,
      review: 3,
      notFound: 2,
      errors: 2,
      bySource: { mapping: 0, exactArticle: 3, search: 1, ai: 3, remembered: 0 },
      aiRows: 3,
      aiPending: 0,
      aiWaiting: null,
    });
    // One batch of the three rows the search left open; nothing else asked.
    expect(ai.priceMatchRequests).toEqual([{ rows: 3, model: expect.any(String) }]);

    const confident = await rows(shop, entry.id, "confident");
    expect(confident.map((r) => [r.rowNo, r.source, r.item?.id])).toEqual([
      [2, "exact_article", await itemByArticle("geely", "04465-0K090")],
      [3, "exact_article", await itemByArticle("trw", "GDB3534")],
      [5, "search", await itemByName("Shell Helix HX8 5W-30, 4 л")],
    ]);
    const review = await rows(shop, entry.id, "review");
    expect(review.map((r) => r.rowNo)).toEqual([4, 6, 7]);
    const several = review.find((r) => r.rowNo === 4)!;
    expect(several).toMatchObject({ source: "exact_article", item: null, aiProposed: false });
    expect(several.note).toEqual({ code: "several_brands", rowNo: null });
    expect(several.candidates.map((c) => c.id).sort()).toEqual([twinGeely, twinTrw].sort());
    const sure = review.find((r) => r.rowNo === 6)!;
    expect(sure).toMatchObject({ source: "ai", aiProposed: true, aiConfidence: 0.95 });
    expect(sure.item?.id).toBe(await itemByName("Mobil Super 3000 5W-40, 4 л"));
    const unsure = review.find((r) => r.rowNo === 7)!;
    // Below the threshold: AI's choice is the first candidate, not a proposal.
    expect(unsure).toMatchObject({ source: "ai", aiProposed: true, aiConfidence: 0.6, item: null });
    expect(unsure.candidates[0]!.id).toBe(await itemByName("Shell Helix Ultra 0W-20, 1 л"));
    const notFound = await rows(shop, entry.id, "not_found");
    expect(notFound.map((r) => [r.rowNo, r.source, r.sendRequest])).toEqual([
      [8, "ai", true],
      [9, null, true],
    ]);
    const errors = await rows(shop, entry.id, "errors");
    expect(errors.map((r) => [r.rowNo, r.errors.map((e) => [e.code, e.value])])).toEqual([
      [10, [["repeated_row", 2]]],
      [11, [["price_not_number", null]]],
    ]);
  });

  it("sends two different rows sure of one item both to the review, each naming the other", async () => {
    const filter = await createItem({
      type: "part",
      categoryId: await categoryByCode("brake_pads"),
      brandId: await brandByKey("geely"),
      article: "F-100",
      names: { ru: "Фильтр масляный Testa F1" },
    });
    const shop = await company("Автомир");
    const entry = await imported(
      shop,
      csv(["F-100;Geely;Фильтр;1000;есть;", ";Geely;Фильтр масляный Testa F1;1100;есть;"]),
    );
    expect(entry.match).toMatchObject({ total: 2, confident: 0, review: 2, aiRows: 0 });
    const review = await rows(shop, entry.id, "review");
    expect(review.map((r) => [r.rowNo, r.source, r.item?.id, r.note])).toEqual([
      [2, "exact_article", filter, { code: "same_item", rowNo: 3 }],
      [3, "search", filter, { code: "same_item", rowNo: 2 }],
    ]);
  });

  it("waits while AI can't be reached or the day's budget is spent, and goes on by itself", async () => {
    const shop = await company("Автомир");
    decideAi();
    ai.mode = "unavailable";
    const waiting = await imported(
      shop,
      csv([
        "04465-0K090;Geely;Колодки;12000;есть;",
        ";;Масло Mobil Super 3000 5W-40 4 литра;7000;есть;",
      ]),
      ["matching"],
    );
    const stalled = await settled(
      shop,
      waiting.id,
      ["matching"],
      30_000,
      (found) => found.match?.aiWaiting === "unavailable",
    );
    // The known row is decided already; the other one waits for AI.
    expect(stalled.match).toMatchObject({ confident: 1, aiPending: 1, aiWaiting: "unavailable" });
    expect((await rows(shop, waiting.id, "confident")).map((r) => r.rowNo)).toEqual([2]);
    ai.mode = "ok";
    const done = await settled(shop, waiting.id, ["review"], 30_000);
    expect(done.match).toMatchObject({ confident: 1, review: 1, aiPending: 0 });

    await settings.set({ ai_daily_budget_usd: 0 });
    const second = await imported(
      shop,
      csv([";;Масло Mobil Super 3000 5W-40 канистра 4л;7000;есть;"]),
      ["matching"],
    );
    await settled(
      shop,
      second.id,
      ["matching"],
      30_000,
      (found) => found.match?.aiWaiting === "budget",
    );
    await settings.set({ ai_daily_budget_usd: 10 });
    const resumed = await settled(shop, second.id, ["review"], 30_000);
    expect(resumed.match).toMatchObject({ review: 1, aiPending: 0, aiWaiting: null });
  });

  it("shows was → became, a sharp price, the missing offers with their orders; decisions carry the version", async () => {
    const shop = await company("Автомир");
    const padsId = await itemByArticle("geely", "04465-0K090");
    const trwId = await itemByArticle("trw", "GDB3534");
    const rearId = await itemByArticle("geely", "4050068800");
    const ultraId = await itemByName("Shell Helix Ultra 0W-20, 1 л");
    const serviceId = await itemByName("Замена моторного масла");
    const pads = await offer(shop, padsId, { price: 10_000 });
    await offer(shop, trwId, { price: 10_000 });
    await offer(shop, rearId, { price: 5_000 });
    const ultra = await offer(shop, ultraId, { price: 9_000 });
    await customerOrder(ultra);
    decideAi();
    const entry = await imported(
      shop,
      csv([
        "04465-0K090;Geely;Колодки;10500;есть;",
        "GDB3534;TRW;Колодки TRW;20000;есть;",
        ";;Масло Mobil Super 3000 5W-40 4 литра;7000;есть;",
        "X-1;;Неизвестная деталь Ромашка;3000;есть;",
      ]),
    );
    const confident = await rows(shop, entry.id, "confident");
    expect(confident.map((r) => [r.rowNo, r.offer?.price, r.parsed?.price, r.sharpPrice])).toEqual([
      [2, 10_000, 10_500, false],
      [3, 10_000, 20_000, true],
    ]);
    expect(confident[0]!.offer?.id).toBe(pads.id);
    const first = await summary(shop, entry.id);
    expect(first.groups).toEqual({ confident: 2, review: 1, notFound: 1, errors: 0 });
    expect(first.missing).toMatchObject({ offers: 2, withActiveOrders: 1, action: null });
    expect(first.sharpPrice).toEqual({ rows: 1, unconfirmed: 1 });
    expect(first.preview).toEqual({
      update: 1,
      create: 0,
      withdraw: 0,
      request: 1,
      unchecked: 1,
      priceConfirmationRequired: 1,
    });
    expect(first.canApply).toBe(false);
    const missing = await ok(
      shop.as("get", `/supplier/price-imports/${entry.id}/review/missing`),
      (body) => priceMissingPageSchema.parse(body),
    );
    expect(missing.offers.map((m) => [m.item.id, m.activeOrders]).sort()).toEqual(
      [
        [rearId, 0],
        [ultraId, 1],
      ].sort(),
    );

    // A colleague decides; this page's version is stale now.
    const other = await colleague(shop, "Марат");
    const stale = entry.version;
    await decide(other, entry.id, 3, { priceConfirmed: true });
    const conflict = await shop.as("put", `/supplier/price-imports/${entry.id}/review/rows/2`, {
      expectedVersion: stale,
      decision: "skip",
    });
    expectError(conflict, 409, "PRICE_IMPORT_VERSION_CONFLICT");
    expect(priceImportVersionConflictDetailsSchema.parse(conflict.body.details).changedBy).toEqual({
      memberId: other.memberId,
      name: "Марат",
    });
    // A service is never a row of a price list; nor a row with an error.
    const service = await shop.as("put", `/supplier/price-imports/${entry.id}/review/rows/4`, {
      expectedVersion: (await detail(shop, entry.id)).import.version,
      decision: "other",
      itemId: serviceId,
    });
    expectError(service, 409, "PRICE_IMPORT_ITEM_UNAVAILABLE");
    expect(service.body.details).toEqual({ reason: "service_item" });

    // «Пропустить все оставшиеся» skips only undecided rows of «Нужно проверить».
    const skipped = await ok(
      shop.as("post", `/supplier/price-imports/${entry.id}/review/skip-remaining`, {
        expectedVersion: (await detail(shop, entry.id)).import.version,
      }),
      (body) => priceRowsSkippedResponseSchema.parse(body),
    );
    expect(skipped.skipped).toBe(1);
    expect((await row(shop, entry.id, 4)).decision?.kind).toBe("skip");
    expect((await row(shop, entry.id, 2)).decision).toBeNull();
    const second = await summary(shop, entry.id);
    expect(second.preview).toMatchObject({ update: 2, unchecked: 0, priceConfirmationRequired: 0 });
    expect(second.sharpPrice).toEqual({ rows: 1, unconfirmed: 0 });

    // The missing ones need a choice before applying.
    const refused = await shop.as("post", `/supplier/price-imports/${entry.id}/apply`, {
      expectedVersion: (await detail(shop, entry.id)).import.version,
    });
    expectError(refused, 409, "PRICE_IMPORT_MISSING_CHOICE");
    expect(refused.body.details).toEqual({ missing: 2, withActiveOrders: 1 });
    await chooseMissing(shop, entry.id, "keep");
    expect((await summary(shop, entry.id)).canApply).toBe(true);
  });

  it("applies in one transaction once: new, changed, withdrawn, returned, missing; memory and requests", async () => {
    const shop = await company("Автомир");
    const padsId = await itemByArticle("geely", "04465-0K090");
    const trwId = await itemByArticle("trw", "GDB3534");
    const rearId = await itemByArticle("geely", "4050068800");
    const hx8Id = await itemByName("Shell Helix HX8 5W-30, 4 л");
    const ultraId = await itemByName("Shell Helix Ultra 0W-20, 1 л");
    const espId = await itemByName("Mobil 1 ESP 5W-30");
    const pads = await offer(shop, padsId, { price: 10_000 });
    const trw = await offer(shop, trwId, { price: 10_000 });
    const rear = await offer(shop, rearId, { price: 5_000 });
    await ok(
      shop.as("post", `/supplier/offers/${rear.id}/withdraw`, { expectedVersion: rear.version }),
      (body) => body,
    );
    const ultra = await offer(shop, ultraId, { price: 9_000 });
    const orderId = await customerOrder(ultra);
    const orderBefore = await db.query(
      "SELECT offer_snapshot, unit_price, status FROM customer_order WHERE id = $1",
      [orderId],
    );
    decideAi();
    const entry = await imported(
      shop,
      csv([
        "04465-0K090;Geely;Колодки передние;11000;есть;",
        "GDB3534;TRW;Колодки TRW;9500;нет;",
        "4050068800;Geely;Колодки задние;5200;есть;",
        ";Shell;Масло моторное Shell Helix HX8 5W-30 4л;8800;под заказ;3",
        ";;Масло Mobil Super 3000 5W-40 4 литра;7000;под заказ;",
        "QQ-1;;Шампанское полусладкое;3000;есть;",
        "QQ-2;;Мармелад жевательный;2000;есть;",
      ]),
    );
    await decide(shop, entry.id, 6, { decision: "accept" });
    await decide(shop, entry.id, 8, { sendRequest: false });
    await chooseMissing(shop, entry.id, "withdraw");

    // Two employees apply at once: one application; the other learns who.
    const other = await colleague(shop, "Марат");
    const version = (await detail(shop, entry.id)).import.version;
    const [a, b] = await Promise.all([
      shop.as("post", `/supplier/price-imports/${entry.id}/apply`, { expectedVersion: version }),
      other.as("post", `/supplier/price-imports/${entry.id}/apply`, { expectedVersion: version }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 202 ? shop : other;
    expect(["PRICE_IMPORT_STATE", "PRICE_IMPORT_VERSION_CONFLICT"]).toContain(loser.body.code);
    if (loser.body.code === "PRICE_IMPORT_STATE") {
      expect(priceImportStateDetailsSchema.parse(loser.body.details).appliedBy?.memberId).toBe(
        winner.memberId,
      );
    }
    const done = await settled(shop, entry.id, ["applied"]);
    expect(done.appliedBy?.memberId).toBe(winner.memberId);
    expect(done.result).toEqual({
      updated: 1,
      created: 1,
      unchanged: 0,
      returned: 1,
      withdrawnOutOfStock: 1,
      withdrawnMissing: 1,
      requested: 1,
      notApplied: [{ reason: "on_order_needs_lead_days", rows: 1 }],
      skipped: 1,
    });
    expect(await offerNow(pads.id)).toMatchObject({
      price: 11_000,
      status: "active",
      last_import_id: entry.id,
    });
    expect(await offerNow(trw.id)).toMatchObject({
      price: 9_500,
      status: "withdrawn",
      withdrawn_reason: "out_of_stock_in_import",
    });
    expect(await offerNow(rear.id)).toMatchObject({
      price: 5_200,
      status: "active",
      withdrawn_reason: null,
    });
    expect(await offerNow(ultra.id)).toMatchObject({
      status: "withdrawn",
      withdrawn_reason: "missing_in_import",
    });
    const created = await db.query<{
      id: string;
      availability: string;
      lead_days: number;
      pickup: boolean;
      delivery: boolean;
      created_by_member_id: string;
    }>(
      "SELECT id, availability, lead_days, pickup, delivery, created_by_member_id FROM offer WHERE supplier_id = $1 AND item_id = $2",
      [shop.supplierId, hx8Id],
    );
    expect(created.rows[0]).toMatchObject({
      availability: "on_order",
      lead_days: 3,
      pickup: true,
      delivery: false,
      created_by_member_id: winner.memberId,
    });
    // The order keeps its snapshot; nothing of it changed.
    expect(
      (
        await db.query(
          "SELECT offer_snapshot, unit_price, status FROM customer_order WHERE id = $1",
          [orderId],
        )
      ).rows,
    ).toEqual(orderBefore.rows);
    // A guest sees the new offer and the new price on the item's card.
    const card = await http().get(`/catalog/items/${hx8Id}?cityId=${almaty}`).set("X-Client", IOS);
    expect(card.status).toBe(200);
    expect((card.body as { offers: { price: number }[] }).offers.map((o) => o.price)).toEqual([
      8_800,
    ]);
    const padsCard = await http()
      .get(`/catalog/items/${padsId}?cityId=${almaty}`)
      .set("X-Client", IOS);
    expect((padsCard.body as { offers: { price: number }[] }).offers.map((o) => o.price)).toEqual([
      11_000,
    ]);
    // The company's memory and the request.
    const memory = await db.query<{
      key: string;
      decision: string;
      item_id: string | null;
      confirmed_by: string;
    }>(
      "SELECT key, decision, item_id, confirmed_by FROM supplier_sku_mapping WHERE supplier_id = $1 ORDER BY key",
      [shop.supplierId],
    );
    expect(memory.rows).toEqual(
      expect.arrayContaining([
        { key: "044650K090", decision: "item", item_id: padsId, confirmed_by: "auto" },
        { key: "GDB3534", decision: "item", item_id: trwId, confirmed_by: "auto" },
        {
          key: "масло mobil super 3000 5w40 4 литра",
          decision: "item",
          item_id: await itemByName("Mobil Super 3000 5W-40, 4 л"),
          confirmed_by: "supplier",
        },
      ]),
    );
    expect(memory.rows.find((m) => m.item_id === espId)).toBeUndefined();
    const requests = await db.query<{ key: string; status: string }>(
      "SELECT key, status FROM catalog_request WHERE supplier_id = $1",
      [shop.supplierId],
    );
    expect(requests.rows).toEqual([{ key: "QQ1", status: "new" }]);
    // Every offer's change is the employee's, «из прайса»; and one entry of the import.
    const journal = await db.query<{ action: string; actor_member_id: string }>(
      "SELECT action, actor_member_id FROM audit_log WHERE action LIKE 'offer.%' AND after->>'source' = 'price_import' AND after->>'importId' = $1",
      [entry.id],
    );
    expect(journal.rows.every((entryRow) => entryRow.actor_member_id === winner.memberId)).toBe(
      true,
    );
    expect(journal.rows.map((r) => r.action).sort()).toEqual(
      [
        "offer.changed",
        "offer.changed",
        "offer.changed",
        "offer.created",
        "offer.returned",
        "offer.withdrawn",
        "offer.withdrawn",
      ].sort(),
    );
    const appliedEntries = await db.query(
      "SELECT 1 FROM audit_log WHERE action = 'price_import.applied' AND entity_id = $1",
      [entry.id],
    );
    expect(appliedEntries.rowCount).toBe(1);
    // The rows say what happened to them.
    expect((await row(shop, entry.id, 6)).outcome).toEqual({
      kind: "not_applied",
      reason: "on_order_needs_lead_days",
    });
    // Applying again does nothing.
    expectError(
      await shop.as("post", `/supplier/price-imports/${entry.id}/apply`, {
        expectedVersion: (await detail(shop, entry.id)).import.version,
      }),
      409,
      "PRICE_IMPORT_STATE",
    );
  });

  it("brings the same price list back without AI and without a review, and sends no second request", async () => {
    const shop = await company("Автомир");
    const padsId = await itemByArticle("geely", "04465-0K090");
    await offer(shop, padsId, { price: 10_000 });
    decideAi();
    const lines = (price: number) => [
      `04465-0K090;Джили;Колодки передние;${String(price)};есть;`,
      ";;Масло Mobil Super 3000 5W-40 4 литра;7000;есть;",
      ";;Масло Shell Helix Ultra 0W-20 1л синтетика;6000;есть;",
      ";;Масло Mobil 1 ESP 5W-30 для дизеля;6500;есть;",
      "QQ-1;;Шампанское полусладкое;3000;есть;",
    ];
    const first = await imported(shop, csv(lines(10_500)));
    expect(ai.priceMatchRequests).toHaveLength(1);
    await decide(shop, first.id, 3, { decision: "accept" });
    await decide(shop, first.id, 4, { decision: "skip" });
    await applied(shop, first.id);

    const again = await imported(shop, csv(lines(11_000)));
    expect(ai.priceMatchRequests).toHaveLength(1);
    expect(again.match).toMatchObject({
      confident: 2,
      review: 0,
      notFound: 3,
      bySource: { mapping: 2, remembered: 3, ai: 0 },
    });
    const notFound = await rows(shop, again.id, "not_found");
    expect(notFound.map((r) => [r.rowNo, r.source, r.sendRequest])).toEqual([
      [4, "remembered_skip", false],
      [5, "remembered_absent", true],
      [6, "remembered_absent", true],
    ]);
    const result = (await applied(shop, again.id)).result!;
    expect(result).toMatchObject({ updated: 1, created: 0, unchanged: 1, requested: 0 });
    // «Mobil 1 ESP … для дизеля» (AI said no) and «Шампанское»: one open request each, still.
    const requests = await db.query("SELECT 1 FROM catalog_request WHERE supplier_id = $1", [
      shop.supplierId,
    ]);
    expect(requests.rowCount).toBe(2);
  });

  it("lets the administrator create the item of a request, link one, refuse one; the next price list applies it", async () => {
    const shop = await company("Автомир");
    const lines = [
      "BOSCH-0451;Bosch;Фильтр масляный Bosch 0451;2500;есть;",
      "QQ-1;;Шампанское полусладкое;3000;есть;",
      "QQ-2;;Мармелад жевательный;2000;есть;",
    ];
    const entry = await imported(shop, csv(lines));
    await applied(shop, entry.id);
    const page = await ok(asAdmin("get", "/admin/catalog-requests?status=new"), (body) =>
      adminCatalogRequestPageSchema.parse(body),
    );
    expect(page.total).toBe(3);
    expect(page.counts).toEqual({ new: 3, approved: 0, rejected: 0 });
    const home = await ok(
      asAdmin("get", "/admin/home"),
      (body) => body as { catalogRequests: number },
    );
    expect(home.catalogRequests).toBe(3);
    // TASK-080: 792 requests are searched, not scrolled — a text, an article, an upload.
    const found = async (query: string) =>
      ok(asAdmin("get", `/admin/catalog-requests?${query}`), (body) =>
        adminCatalogRequestPageSchema.parse(body),
      );
    const byText = await found(`q=${encodeURIComponent("ампанск")}`);
    expect(byText.requests.map((r) => r.data.article)).toEqual(["QQ-1"]);
    expect(byText.counts).toEqual({ new: 1, approved: 0, rejected: 0 });
    const byArticle = await found(`q=${encodeURIComponent("bosch 0451")}`);
    expect(byArticle.requests.map((r) => r.data.article)).toEqual(["BOSCH-0451"]);
    expect((await found(`importId=${entry.id}`)).total).toBe(3);
    expect((await found(`importId=${randomUUID()}`)).total).toBe(0);
    expect((await found("similar=true")).total).toBe(0);
    const filter = page.requests.find((r) => r.data.article === "BOSCH-0451")!;
    expect(filter).toMatchObject({
      supplier: { id: shop.supplierId, name: "Автомир" },
      createdBy: { name: "Ерлан" },
      data: { brand: "Bosch", name: "Фильтр масляный Bosch 0451", price: 2500 },
      import: { id: entry.id, rowNo: 2 },
    });
    const card = await ok(asAdmin("get", `/admin/catalog-requests/${filter.id}`), (body) =>
      adminCatalogRequestResponseSchema.parse(body),
    );
    expect(card.request.id).toBe(filter.id);

    // «Создать позицию»: the item as «Новая позиция» makes it, the request answered with it.
    const geely = await brandByKey("geely");
    const filters = await categoryByCode("oil_filters");
    const created = await ok(
      asAdmin("post", `/admin/catalog-requests/${filter.id}/create-item`, {
        expectedVersion: filter.version,
        item: {
          type: "part",
          categoryId: filters,
          brandId: geely,
          article: "BOSCH-0451",
          names: { ru: "Фильтр масляный 0451" },
        },
      }),
      (body) => itemFromRequestResponseSchema.parse(body),
      201,
    );
    expect(created.request).toMatchObject({
      status: "approved",
      item: { id: created.item.item.id },
    });
    // A second answer from a stale page is refused with who answered.
    const again = await asAdmin("post", `/admin/catalog-requests/${filter.id}/reject`, {
      expectedVersion: filter.version,
      reason: "Дубль",
    });
    expectError(again, 409, "CATALOG_REQUEST_VERSION_CONFLICT");
    expect(catalogRequestConflictDetailsSchema.parse(again.body.details).status).toBe("approved");

    const champagne = page.requests.find((r) => r.data.article === "QQ-1")!;
    const refused = await ok(
      asAdmin("post", `/admin/catalog-requests/${champagne.id}/reject`, {
        expectedVersion: champagne.version,
        reason: "Не автотовар",
      }),
      (body) => catalogRequestDecidedResponseSchema.parse(body),
    );
    expect(refused.request).toMatchObject({ status: "rejected", rejectReason: "Не автотовар" });
    const marmalade = page.requests.find((r) => r.data.article === "QQ-2")!;
    const pads = await itemByArticle("geely", "04465-0K090");
    await ok(
      asAdmin("post", `/admin/catalog-requests/${marmalade.id}/link`, {
        expectedVersion: marmalade.version,
        itemId: pads,
      }),
      (body) => catalogRequestDecidedResponseSchema.parse(body),
    );
    // The supplier sees the answers.
    const mine = await ok(shop.as("get", "/supplier/catalog-requests"), (body) =>
      supplierCatalogRequestPageSchema.parse(body),
    );
    expect(mine.requests.map((r) => [r.data.article, r.status, r.rejectReason]).sort()).toEqual(
      [
        ["BOSCH-0451", "approved", null],
        ["QQ-1", "rejected", "Не автотовар"],
        ["QQ-2", "approved", null],
      ].sort(),
    );
    const journal = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_type = 'catalog_request' AND actor_role = 'admin' ORDER BY action",
    );
    expect(journal.rows.map((r) => r.action)).toEqual([
      "catalog_request.approved",
      "catalog_request.approved",
      "catalog_request.rejected",
    ]);

    // The next price list: the created and the linked item apply by themselves.
    ai.priceMatchRequests.length = 0;
    const next = await imported(shop, csv(lines));
    expect(next.match).toMatchObject({ confident: 2, review: 0, bySource: { mapping: 2 } });
    expect(ai.priceMatchRequests).toHaveLength(0);
    // The refused one isn't sent again by itself.
    const champagneRow = (await rows(shop, next.id, "not_found"))[0]!;
    expect(champagneRow).toMatchObject({ rowNo: 3, sendRequest: false });
    const result = (await applied(shop, next.id)).result!;
    expect(result).toMatchObject({ created: 2, requested: 0 });
    const all = await db.query("SELECT 1 FROM catalog_request WHERE supplier_id = $1", [
      shop.supplierId,
    ]);
    expect(all.rowCount).toBe(3);
  });

  it("refuses a blocked company; leaves an item gone meanwhile and a price a colleague changed", async () => {
    const shop = await company("Автомир");
    const padsId = await itemByArticle("geely", "04465-0K090");
    const trwId = await itemByArticle("trw", "GDB3534");
    const pads = await offer(shop, padsId, { price: 10_000 });
    const entry = await imported(
      shop,
      csv(["04465-0K090;Geely;Колодки;10500;есть;", "GDB3534;TRW;Колодки TRW;9000;есть;"]),
    );
    // Archived by the administrator during the review.
    const trwItem = await ok(
      asAdmin("get", `/admin/catalog/items/${trwId}`),
      (body) => body as { item: { version: number } },
    );
    await ok(
      asAdmin("post", `/admin/catalog/items/${trwId}/status`, {
        expectedVersion: trwItem.item.version,
        status: "archived",
      }),
      (body) => body,
    );
    // A colleague halves the price by hand: the file's price is a sharp change now.
    await ok(
      shop.as("patch", `/supplier/offers/${pads.id}`, {
        expectedVersion: pads.version,
        price: 5_000,
      }),
      (body) => body,
    );
    const block = await ok(
      asAdmin("get", `/admin/suppliers/${shop.supplierId}`),
      (body) => body as { supplier: { version: number } },
    );
    await ok(
      asAdmin("post", `/admin/suppliers/${shop.supplierId}/block`, {
        expectedVersion: block.supplier.version,
        blocked: true,
        reason: "Проверка",
      }),
      (body) => body,
    );
    expectError(
      await shop.as("post", `/supplier/price-imports/${entry.id}/apply`, {
        expectedVersion: (await detail(shop, entry.id)).import.version,
      }),
      403,
      "SUPPLIER_BLOCKED",
    );
    const blocked = await ok(
      asAdmin("get", `/admin/suppliers/${shop.supplierId}`),
      (body) => body as { supplier: { version: number } },
    );
    await ok(
      asAdmin("post", `/admin/suppliers/${shop.supplierId}/block`, {
        expectedVersion: blocked.supplier.version,
        blocked: false,
        reason: "Проверено",
      }),
      (body) => body,
    );
    const result = (await applied(shop, entry.id)).result!;
    expect(result.notApplied.sort((x, y) => x.reason.localeCompare(y.reason))).toEqual([
      { reason: "item_unavailable", rows: 1 },
      { reason: "price_confirmation_required", rows: 1 },
    ]);
    expect(await offerNow(pads.id)).toMatchObject({ price: 5_000 });
  });

  it("errs every row of a company of services and creates nothing", async () => {
    const shop = await company("Сервис", { type: "services" });
    const entry = await imported(shop, csv(["04465-0K090;Geely;Колодки;10500;есть;"]));
    expect(entry.match).toMatchObject({ errors: 1, confident: 0 });
    expect((await rows(shop, entry.id, "errors"))[0]!.errors.map((e) => e.code)).toEqual([
      "supplier_type",
    ]);
    const result = (await applied(shop, entry.id)).result!;
    expect(result).toMatchObject({ created: 0, updated: 0 });
  });

  // ------------------------------------------------------------- TASK-048

  /** «Скачать мой прайс»: the link, then the file by it (no session — the link is the key). */
  async function exported(of: Company, include: "on_sale" | "all" = "on_sale") {
    const link = await ok(
      of.as("post", "/supplier/price-exports", { include }),
      (body) => priceExportLinkSchema.parse(body),
      201,
    );
    rememberSecret(new URL(link.url, "http://x").searchParams.get("token")!);
    const response = await http()
      .get(link.url)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml");
    return { link, bytes: response.body as Buffer };
  }

  /** The rows of an `.xlsx` as the price list reader sees them. */
  async function sheetRows(bytes: Buffer) {
    const rows: { rowNo: number; cells: (string | number | null)[] }[] = [];
    await readPriceFile(bytes, "xlsx", 1000, {
      row: (row) => rows.push(row),
      flush: () => Promise.resolve(),
    });
    return rows;
  }

  it("exports only the company's own offers on goods, with the hidden item column", async () => {
    const shop = await company("Автомир", { type: "both" });
    const rival = await company("Конкурент");
    const padsId = await itemByArticle("geely", "04465-0K090");
    const trwId = await itemByArticle("trw", "GDB3534");
    const oilId = await itemByName("Shell Helix HX8 5W-30, 4 л");
    const serviceId = await itemByName("Замена моторного масла");
    await offer(shop, padsId, { price: 12_500 });
    await offer(shop, oilId, { price: 7_000, supplierSku: "SH-HX8-4" });
    const gone = await offer(shop, trwId, { price: 9_800 });
    await ok(
      shop.as("post", `/supplier/offers/${gone.id}/withdraw`, { expectedVersion: gone.version }),
      (body) => body,
    );
    await ok(
      shop.as("post", "/supplier/offers", { itemId: serviceId, price: 8_000 }),
      (b) => b,
      201,
    );
    const rivals = await offer(rival, trwId, { price: 9_000 });

    const onSale = await exported(shop);
    expect(onSale.link.offers).toBe(2);
    const sheet = strFromU8(unzipSync(new Uint8Array(onSale.bytes))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toMatch(/<col min="1" max="1"[^>]*hidden="1"/);
    const read = await sheetRows(onSale.bytes);
    expect(read[0]!.cells.slice(0, 7)).toEqual([
      "item_id",
      "Артикул",
      "Бренд",
      "Название",
      "Цена, ₸",
      "Наличие",
      "Срок, дн.",
    ]);
    expect(
      read
        .slice(1)
        .map((row) => row.cells[0])
        .sort(),
    ).toEqual([padsId, oilId].sort());
    const all = await sheetRows((await exported(shop, "all")).bytes);
    const ids = all.slice(1).map((row) => row.cells[0]);
    expect(ids.sort()).toEqual([padsId, oilId, trwId].sort());
    // Never the service (prices by model), never another company's offer.
    expect(ids).not.toContain(serviceId);
    expect(all.find((row) => row.cells[0] === trwId)!.cells[5]).toBe("Нет в наличии");
    expect(rivals.item.id).toBe(trwId);

    // A forged link — 410, nothing about why.
    const forged = await http().get(`${onSale.link.url}x`);
    expect(forged.status).toBe(410);
    // No offers: the file has the header and the hint, and nothing breaks.
    const empty = await company("Пустой");
    const nothing = await exported(empty);
    expect(nothing.link.offers).toBe(0);
    const files = unzipSync(new Uint8Array(nothing.bytes));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"]!)).toContain("item_id");
    expect(strFromU8(files["xl/worksheets/sheet2.xml"]!)).toContain("Предложений пока нет");
  });

  it("takes the export back by its item column — all sure, no AI, nothing changes; two edited prices change", async () => {
    const shop = await company("Автомир");
    const padsId = await itemByArticle("geely", "04465-0K090");
    const rearId = await itemByArticle("geely", "4050068800");
    const oilId = await itemByName("Shell Helix HX8 5W-30, 4 л");
    const pads = await offer(shop, padsId, { price: 12_500 });
    const rear = await offer(shop, rearId, { price: 15_000 });
    const oil = await offer(shop, oilId, {
      price: 7_000,
      availability: "on_order",
      leadDays: 3,
      supplierSku: "SH-HX8-4",
    });
    const { bytes } = await exported(shop);

    const same = await imported(shop, bytes);
    expect(same.columnsSource).toBe("remembered");
    expect(same.match).toMatchObject({ confident: 3, review: 0, notFound: 0, errors: 0 });
    expect(same.match?.bySource.itemId).toBe(3);
    expect((await rows(shop, same.id, "confident")).map((r) => r.source)).toEqual([
      "item_id",
      "item_id",
      "item_id",
    ]);
    const unchanged = (await applied(shop, same.id)).result!;
    expect(unchanged).toMatchObject({ updated: 0, created: 0, unchanged: 3, requested: 0 });
    for (const before of [pads, rear, oil]) {
      const now = await offerNow(before.id);
      expect(now.version).toBe(before.version);
      expect(now.supplier_sku).toBe(before.supplierSku);
    }

    // The supplier changes two prices in Excel and saves the file anew.
    const read = await sheetRows(bytes);
    const priceOf: Record<string, number> = { [padsId]: 13_000, [oilId]: 7_300 };
    const edited = writeXlsx([
      {
        name: "Прайс",
        rows: read.map((row, index) =>
          index === 0
            ? row.cells
            : row.cells.map((cell, column) =>
                column === 4 ? (priceOf[String(row.cells[0])] ?? cell) : cell,
              ),
        ),
      },
    ]);
    const back = await imported(shop, edited);
    expect(back.match).toMatchObject({ confident: 3, review: 0 });
    const result = (await applied(shop, back.id)).result!;
    expect(result).toMatchObject({ updated: 2, unchanged: 1, created: 0 });
    expect((await offerNow(pads.id)).price).toBe(13_000);
    expect((await offerNow(oil.id)).price).toBe(7_300);
    expect((await offerNow(rear.id)).price).toBe(15_000);
    expect(ai.priceMatchRequests).toHaveLength(0);
  });

  it("errs a row naming another company's item or nothing by the item column, and matches one without it as usual", async () => {
    const shop = await company("Автомир");
    const rival = await company("Конкурент");
    const padsId = await itemByArticle("geely", "04465-0K090");
    const trwId = await itemByArticle("trw", "GDB3534");
    await offer(shop, padsId, { price: 12_500 });
    const rivals = await offer(rival, trwId, { price: 9_000 });
    // The company's own export: its header and the format remembered with it.
    const header = (await sheetRows((await exported(shop)).bytes))[0]!.cells;
    const file = writeXlsx([
      {
        name: "Прайс",
        rows: [
          header,
          [trwId, "GDB3534", "TRW", "Колодки тормозные передние TRW", 1, "В наличии", 0],
          ["не-код", "04465-0K090", "Geely", "Колодки", 12_600, "В наличии", 0],
          [null, "04465-0K090", "Geely", "Колодки тормозные передние", 12_700, "В наличии", 0],
        ],
      },
    ]);
    const entry = await imported(shop, file);
    const errors = await rows(shop, entry.id, "errors");
    expect(errors.map((r) => [r.rowNo, r.errors.map((e) => e.code)])).toEqual([
      [2, ["unknown_item_id"]],
      [3, ["unknown_item_id"]],
    ]);
    // The row says nothing of whose the item is.
    expect(JSON.stringify(errors)).not.toContain(rival.name);
    const confident = await rows(shop, entry.id, "confident");
    expect(confident.map((r) => [r.rowNo, r.source, r.item?.id])).toEqual([
      [4, "exact_article", padsId],
    ]);
    await applied(shop, entry.id);
    expect((await offerNow(rivals.id)).price).toBe(9_000);
  });

  it("errs a row naming a service by its name — not «не найдено», not a request", async () => {
    const shop = await company("Автомир");
    const entry = await imported(shop, csv([";;Замена моторного масла;8000;есть;"]));
    expect(entry.match).toMatchObject({ errors: 1, notFound: 0 });
    expect((await rows(shop, entry.id, "errors"))[0]!.errors.map((e) => e.code)).toEqual([
      "service_item",
    ]);
    const result = (await applied(shop, entry.id)).result!;
    expect(result).toMatchObject({ requested: 0, created: 0 });
    const requests = await db.query("SELECT 1 FROM catalog_request WHERE supplier_id = $1", [
      shop.supplierId,
    ]);
    expect(requests.rowCount).toBe(0);
  });

  it("takes a request by hand once, shows the administrator's decision as «новое» to each employee until seen", async () => {
    const shop = await company("Автомир");
    const colleague2 = await colleague(shop, "Марат");
    const pads = await categoryByCode("brake_pads");
    const sent = await ok(
      shop.as("post", "/supplier/catalog-requests", {
        name: "Колодки тормозные передние Haval Jolion",
        brand: "Haval",
        article: "3501115XGW02A",
        categoryId: pads,
        comment: "Есть 10 комплектов",
      }),
      (body) => supplierCatalogRequestResponseSchema.parse(body).request,
      201,
    );
    expect(sent).toMatchObject({
      status: "new",
      source: "manual",
      importId: null,
      comment: "Есть 10 комплектов",
      isNew: false,
      category: { id: pads, name: "Тормозные колодки" },
    });
    // The same article again, in any spelling: one request waiting.
    const again = await shop.as("post", "/supplier/catalog-requests", {
      name: "Колодки",
      article: "3501115-xgw02a",
    });
    expectError(again, 409, "CATALOG_REQUEST_EXISTS");
    expect(again.body.details).toEqual({ requestId: sent.id });
    expectError(
      await shop.as("post", "/supplier/catalog-requests", { name: "Х", categoryId: randomUUID() }),
      400,
      "VALIDATION_ERROR",
    );
    // The limit of the company a day.
    await settings.set({ catalog_requests_per_supplier_day: 1 });
    await new TestSettings(app).reload();
    expectError(
      await shop.as("post", "/supplier/catalog-requests", { name: "Фильтр салона Haval" }),
      429,
      "RATE_LIMITED",
    );

    // The administrator sees it among the requests, marked by hand.
    const listed = await ok(asAdmin("get", "/admin/catalog-requests?status=new"), (body) =>
      adminCatalogRequestPageSchema.parse(body),
    );
    const mine = listed.requests.find((request) => request.id === sent.id)!;
    expect(mine).toMatchObject({ source: "manual", import: null, comment: "Есть 10 комплектов" });
    expect(mine.category?.id).toBe(pads);
    const summaryOf = (of: Company) =>
      ok(of.as("get", "/supplier/moderation/summary"), (body) =>
        supplierModerationSummarySchema.parse(body),
      );
    expect((await summaryOf(shop)).unseen.total).toBe(0);
    await ok(
      asAdmin("post", `/admin/catalog-requests/${sent.id}/reject`, {
        expectedVersion: mine.version,
        reason: "Нет в каталоге производителя",
      }),
      (body) => body,
    );

    // «новое» for both employees until each of them opens «Модерация».
    for (const of of [shop, colleague2]) {
      expect((await summaryOf(of)).unseen).toEqual({ requests: 1, compatibility: 0, total: 1 });
      const page = await ok(of.as("get", "/supplier/catalog-requests"), (body) =>
        supplierCatalogRequestPageSchema.parse(body),
      );
      expect(page.requests[0]).toMatchObject({
        id: sent.id,
        status: "rejected",
        rejectReason: "Нет в каталоге производителя",
        isNew: true,
      });
    }
    const opened = await summaryOf(shop);
    const seen = await ok(
      shop.as("post", "/supplier/moderation/seen", { seenUntil: opened.serverTime }),
      (body) => supplierModerationSummarySchema.parse(body),
    );
    expect(seen.unseen.total).toBe(0);
    const afterSeen = await ok(shop.as("get", "/supplier/catalog-requests"), (body) =>
      supplierCatalogRequestPageSchema.parse(body),
    );
    expect(afterSeen.requests[0]!.isNew).toBe(false);
    // The colleague hasn't looked: still «новое» for him.
    expect((await summaryOf(colleague2)).unseen.total).toBe(1);
    // An older moment sent late takes nothing back.
    await ok(
      shop.as("post", "/supplier/moderation/seen", { seenUntil: "2020-01-01T00:00:00.000Z" }),
      (body) => body,
    );
    expect((await summaryOf(shop)).unseen.total).toBe(0);

    // Brands by any spelling for the form.
    const brands = await ok(shop.as("get", "/supplier/catalog/brands?q=джи"), (body) =>
      supplierBrandSuggestionsSchema.parse(body),
    );
    expect(brands.brands.map((brand) => brand.name)).toEqual(["Geely"]);
  });

  it("matches and applies fifty thousand rows", async () => {
    const shop = await company("Автомир");
    const rowsCount = 49_990;
    const category = await categoryByCode("brake_pads");
    const geely = await brandByKey("geely");
    // The catalog of fifty thousand parts, written straight into the database.
    await db.query(
      `WITH items AS (
         INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id, article, article_norm, status)
         SELECT 'part', $1, 'goods', $2, 'BIG-' || n, 'BIG' || n, 'active' FROM generate_series(1, $3) AS n
         RETURNING id, article
       )
       INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited)
       SELECT 'catalog_item', id, 'name', 'ru', 'Деталь ' || article, 'source', false FROM items`,
      [category, geely, rowsCount],
    );
    const file = (price: number) =>
      csv(
        Array.from(
          { length: rowsCount },
          (_, i) => `BIG-${String(i + 1)};Geely;Деталь;${String(price + (i % 10))};есть;`,
        ),
      );
    await settings.set({ import_max_file_mb: 20 });
    // Each step with the API answering /health meanwhile (the worker shares this process).
    const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      let result: T | undefined;
      const health = await healthDuring(async () => {
        result = await work();
      });
      timings.push(
        `TASK-047 50k ${name}: ${String(Date.now() - started)} ms; /health max ${health.max.toFixed(0)} ms of ${String(health.count)} requests`,
      );
      return result!;
    };
    const first = await step("first import, upload to review (exact article)", () =>
      imported(shop, file(1_000), ["review"], 300_000),
    );
    expect(first.match).toMatchObject({ confident: rowsCount, aiRows: 0 });
    const created = await step("apply (create)", () => applied(shop, first.id, 300_000));
    expect(created.result).toMatchObject({ created: rowsCount });
    const second = await step("repeat import, upload to review (remembered)", () =>
      imported(shop, file(1_100), ["review"], 300_000),
    );
    expect(second.match).toMatchObject({ confident: rowsCount, bySource: { mapping: rowsCount } });
    const updated = await step("apply (update)", () => applied(shop, second.id, 300_000));
    expect(updated.result).toMatchObject({ updated: rowsCount });
    expect(ai.priceMatchRequests).toHaveLength(0);
    // Where the time went, by the phases the worker logs.
    for (const line of output.text().split("\n")) {
      if (!line.startsWith("{")) continue;
      const entry = JSON.parse(line) as { message?: string; timestamp?: string };
      const message = entry.message ?? "";
      if (
        /^Price (file read|rows read|rows matched|list matched|list applied|list apply)|^Job (failed|started job=prices)/.test(
          message,
        )
      ) {
        timings.push(`  ${entry.timestamp ?? ""} ${message.slice(0, 300)}`);
      }
    }
  }, 600_000);
});
