import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminPriceImportPageSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  priceImportDetailResponseSchema,
  priceImportPageSchema,
  priceImportPhotoInvalidDetailsSchema,
  priceImportResponseSchema,
  priceMissingPageSchema,
  priceReviewRowsPageSchema,
  priceReviewSummarySchema,
  priceRowDecidedResponseSchema,
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
} from "@adclub/contracts";
import { kzBinCheckDigit } from "@adclub/domain";
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
import { JobAdmin, type JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { AI_SERVICE_OPTIONS, TestAiGateway, type AiServiceOptions } from "../ai";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { photoEvalDirectory } from "../photo-eval";

/**
 * TASK-064 end to end on a real PostgreSQL, Redis and object storage with a
 * real worker and the test AI gateway (no outside calls): photographed
 * pages of a price list uploaded in one request, each checked by its
 * content (a refused page by its number), the limits of pages, of a page's
 * size and of uploads an hour (a refused upload and a page taken again
 * counting); the pages read in the worker into the rows of the import with
 * their page, source text and doubt; a page with no table and an unreadable
 * one waiting to be taken again or left out; AI out of reach and out of
 * budget — the import waits and goes on by itself; matching, the review with
 * «распознано с фото» and a row read with doubt never applied without
 * «Прочитано верно»; the same photos again matched by the company's memory
 * without AI; `ai_job` without the picture; the pages private and removed
 * with the import's files; another company's upload — 404.
 */

const ADMIN_PHONE = "+77010000368";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const ADMIN_WEB = "admin-web/0.1.0";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";

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

/** A synthetic page of `ai-eval/price-photo/samples`. */
function sample(id: string): Buffer {
  return readFileSync(join(photoEvalDirectory("price-photo"), "samples", `${id}.jpg`));
}

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) return `${prefix}${digit}`;
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

describe("photographed price lists (PostgreSQL + Redis + MinIO)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minio: StartedTestContainer;
  let endpoint: string;
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
    endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`;
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
    ai.matchOverride = undefined;
    ai.priceMatchRequests.length = 0;
    ai.photoRequests.length = 0;
    ai.pricePhotoAnswers.length = 0;
    ai.pricePhotoSlow.length = 0;
    ai.delayMs = 5_000;
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

  interface Company {
    supplierId: string;
    as: As;
  }

  async function company(name: string): Promise<Company> {
    const phone = `+77050${String(100000 + ++phoneCounter)}`;
    rememberCode(phone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0712350${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: "goods",
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
    const response = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const bearer = (response.body as { session: { accessToken: string } }).session.accessToken;
    return {
      supplierId: created.supplier.id,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  /** The pages in one form, named `page`, in their order. */
  function photos(of: Company, pages: readonly Buffer[]): Test {
    let test = of.as("post", "/supplier/price-imports/photos");
    pages.forEach((bytes, index) => {
      test = test.attach("page", bytes, {
        filename: `page-${String(index + 1)}.jpg`,
        contentType: "image/jpeg",
      });
    });
    return test;
  }

  async function upload(of: Company, pages: readonly Buffer[]): Promise<PriceImport> {
    return ok(photos(of, pages), (body) => priceImportResponseSchema.parse(body).import, 201);
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
    also: (entry: PriceImport) => boolean = () => true,
    timeoutMs = 60_000,
  ): Promise<PriceImport> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = (await detail(of, importId)).import;
      if (statuses.includes(found.status) && also(found)) return found;
      if (Date.now() > until) throw new Error(`The import is still ${found.status}`);
      await sleep(200);
    }
  }

  async function rows(of: Company, importId: string, group: PriceReviewGroup) {
    return ok(
      of.as("get", `/supplier/price-imports/${importId}/review/rows?group=${group}&limit=200`),
      (body) => priceReviewRowsPageSchema.parse(body).rows,
    );
  }

  async function allRows(of: Company, importId: string): Promise<PriceReviewRow[]> {
    const groups = ["confident", "review", "not_found", "errors"] as const;
    return (await Promise.all(groups.map((group) => rows(of, importId, group))))
      .flat()
      .sort((a, b) => a.rowNo - b.rowNo);
  }

  async function summary(of: Company, importId: string) {
    return ok(of.as("get", `/supplier/price-imports/${importId}/review`), (body) =>
      priceReviewSummarySchema.parse(body),
    );
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
      (body) => body,
      202,
    );
    return settled(of, importId, ["applied"]);
  }

  async function objects(prefix: string): Promise<string[]> {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (listed.Contents ?? []).map((entry) => entry.Key!).sort();
  }

  // ---------------------------------------------------------------- tests

  it("reads two pages into the rows of one import, page by page, and goes to the review", async () => {
    const of = await company("Фото Один");
    const uploaded = await upload(of, [sample("two-pages-1"), sample("two-pages-2")]);
    expect(uploaded).toMatchObject({
      status: "parsing",
      format: "photo",
      fileName: null,
      photo: { recognized: 0, aiWaiting: null },
    });
    expect(uploaded.photo!.pages.map((page) => [page.pageNo, page.status])).toEqual([
      [1, "waiting"],
      [2, "waiting"],
    ]);
    const done = await settled(of, uploaded.id, ["review"]);
    expect(done.columnsSource).toBe("photo");
    expect(done.photo!.pages.map((page) => [page.pageNo, page.status, page.rows])).toEqual([
      [1, "read", 4],
      [2, "read", 3],
    ]);
    // S-PRICE-02 is never asked: the roles are known.
    expect(done.stats).toMatchObject({ dataRows: 7, errorRows: 0 });
    const stored = await db.query<{
      row_no: number;
      photo_page: number;
      photo_text: string;
      photo_uncertain: string[];
      parsed: { articleNorm: string | null; price: number };
    }>(
      "SELECT row_no, photo_page, photo_text, photo_uncertain, parsed FROM price_import_row WHERE import_id = $1 ORDER BY row_no",
      [uploaded.id],
    );
    expect(stored.rows.map((row) => [row.row_no, row.photo_page, row.parsed.price])).toEqual([
      [1, 1, 18_500],
      [2, 1, 14_200],
      [3, 1, 16_900],
      [4, 1, 21_400],
      [5, 2, 6_300],
      [6, 2, 24_000],
      [7, 2, 2_100],
    ]);
    expect(stored.rows[0]!.parsed.articleNorm).toBe("044650K090");
    expect(stored.rows[4]!.photo_uncertain).toEqual(["price"]);
    expect(stored.rows[0]!.photo_text).toContain("04465-0K090");

    // The review: «распознано с фото» with the source text and the doubt.
    const reviewRows = await allRows(of, uploaded.id);
    expect(reviewRows).toHaveLength(7);
    const pads = reviewRows.find((row) => row.rowNo === 1)!;
    expect(pads).toMatchObject({
      group: "confident",
      source: "exact_article",
      photo: { pageNo: 1, uncertain: [], readConfirmed: false },
    });
    const stained = reviewRows.find((row) => row.rowNo === 5)!;
    expect(stained.photo).toMatchObject({ pageNo: 2, uncertain: ["price"], readConfirmed: false });

    // `ai_job`: two readings a page, the size only — never the picture.
    const jobs = await db.query<{
      kind: string;
      status: string;
      input_ref: Record<string, unknown>;
    }>("SELECT kind, status, input_ref FROM ai_job WHERE kind = 'price_photo' ORDER BY created_at");
    expect(jobs.rows).toHaveLength(4);
    for (const job of jobs.rows) {
      expect(job.status).toBe("succeeded");
      expect(Object.keys(job.input_ref).sort()).toEqual([
        "bytes",
        "height",
        "importId",
        "page",
        "reading",
        "width",
      ]);
      expect(JSON.stringify(job.input_ref).length).toBeLessThan(200);
    }

    // The pages are kept privately under the import's prefix, without their metadata.
    const keys = await objects(`price-imports/${of.supplierId}/${uploaded.id}/`);
    expect(keys).toEqual([
      `price-imports/${of.supplierId}/${uploaded.id}/page-1-0`,
      `price-imports/${of.supplierId}/${uploaded.id}/page-2-0`,
    ]);
    const anonymous = await fetch(`${endpoint}/${BUCKET}/${keys[0]!}`);
    expect(anonymous.status).toBe(403);
    const kept = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keys[0]! }));
    const bytes = Buffer.from(await kept.Body!.transformToByteArray());
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    // No EXIF: the picture was written again.
    expect(bytes.includes(Buffer.from("Exif"))).toBe(false);

    // The administrator sees the upload: its kind and pages, nothing to change.
    const admin = await ok(
      asAdmin("get", `/admin/suppliers/${of.supplierId}/price-imports`),
      (body) => adminPriceImportPageSchema.parse(body),
    );
    expect(admin.imports[0]).toMatchObject({ format: "photo", photo: { recognized: 2 } });
  });

  it("never applies a row read with doubt without «Прочитано верно»; the same photos again need no AI", async () => {
    const of = await company("Фото Два");
    const first = await upload(of, [sample("pen-correction")]);
    await settled(of, first.id, ["review"]);
    const corrected = (await allRows(of, first.id)).find((row) => row.photo?.uncertain.length)!;
    expect(corrected.parsed).toMatchObject({ articleNorm: "4050068800", price: 17_500 });
    expect(corrected.group).toBe("confident");
    let numbers = await summary(of, first.id);
    expect(numbers.preview.readConfirmationRequired).toBe(1);
    const created = numbers.preview.create;

    // Applied without the confirmation: the row isn't.
    const result = await applied(of, first.id);
    expect(result.result!.notApplied).toContainEqual({
      reason: "read_confirmation_required",
      rows: 1,
    });
    expect(result.result!.created).toBe(created);
    const unconfirmed = await db.query(
      "SELECT o.id FROM offer o JOIN catalog_item i ON i.id = o.item_id WHERE o.supplier_id = $1 AND i.article_norm = '4050068800'",
      [of.supplierId],
    );
    expect(unconfirmed.rows).toHaveLength(0);

    // The same photo again: every row the memory knows, no AI matching at all.
    ai.priceMatchRequests.length = 0;
    const again = await upload(of, [sample("pen-correction")]);
    expect(again.sameFileAsImportId).toBe(first.id);
    await settled(of, again.id, ["review"]);
    expect(ai.priceMatchRequests).toHaveLength(0);
    const row = (await allRows(of, again.id)).find((entry) => entry.photo?.uncertain.length)!;
    expect(row.source).toBe("exact_article");
    // «Прочитано верно» now: applied.
    const decided = await decide(of, again.id, row.rowNo, { readConfirmed: true });
    expect(decided.row.photo!.readConfirmed).toBe(true);
    numbers = await summary(of, again.id);
    expect(numbers.preview.readConfirmationRequired).toBe(0);
    const second = await applied(of, again.id);
    expect(
      second.result!.notApplied.some((entry) => entry.reason === "read_confirmation_required"),
    ).toBe(false);
    const offer = await db.query<{ price: number }>(
      "SELECT o.price FROM offer o JOIN catalog_item i ON i.id = o.item_id WHERE o.supplier_id = $1 AND i.article_norm = '4050068800'",
      [of.supplierId],
    );
    expect(offer.rows).toEqual([{ price: 17_500 }]);

    // A row of a file has nothing to confirm.
    const sure = (await allRows(of, again.id)).find(
      (entry) => entry.photo?.uncertain.length === 0,
    )!;
    const version = (await detail(of, again.id)).import.version;
    const refused = await of.as(
      "put",
      `/supplier/price-imports/${again.id}/review/rows/${String(sure.rowNo)}`,
      {
        expectedVersion: version,
        readConfirmed: true,
      },
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("checks every page by its content and refuses with the page's number; the limits", async () => {
    const of = await company("Фото Три");
    const notImage = await photos(of, [
      sample("list-clean"),
      Buffer.from("это не картинка, а текст"),
    ]);
    expectError(notImage, 400, "PRICE_IMPORT_PHOTO_INVALID");
    expect(priceImportPhotoInvalidDetailsSchema.parse(notImage.body.details)).toEqual({
      page: 2,
      reason: "not_an_image",
      limit: null,
    });
    const svg = await photos(of, [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    ]);
    expectError(svg, 400, "PRICE_IMPORT_PHOTO_INVALID");
    expect(svg.body.details).toMatchObject({ page: 1 });
    const none = await of
      .as("post", "/supplier/price-imports/photos")
      .field("note", "no pages here");
    expectError(none, 400, "PRICE_IMPORT_PHOTO_INVALID");
    expect(none.body.details).toMatchObject({ page: null, reason: "no_pages" });
    const json = await of.as("post", "/supplier/price-imports/photos").send({ pages: [] });
    expect(json.status).toBe(415);

    await settings.set({ price_photo_max_pages: 2, price_photo_max_size_mb: 1 });
    // The API keeps its own copy of the settings: read again, not by the cache age.
    await new TestSettings(app).reload();
    const many = await photos(of, [
      sample("list-clean"),
      sample("list-tilt"),
      sample("list-clean"),
    ]);
    expectError(many, 400, "PRICE_IMPORT_PHOTO_INVALID");
    expect(many.body.details).toEqual({ page: null, reason: "too_many_pages", limit: 2 });
    const large = await photos(of, [sample("list-clean"), Buffer.alloc(1024 * 1024 + 10, 1)]);
    expectError(large, 400, "PRICE_IMPORT_PHOTO_INVALID");
    expect(large.body.details).toEqual({ page: 2, reason: "too_large", limit: 1 });
    // Nothing of a refused upload is kept.
    expect(await objects(`price-imports/${of.supplierId}/`)).toEqual([]);
    const refusals = await db.query<{ reason: string }>(
      "SELECT reason FROM price_import_refusal WHERE supplier_id = $1 ORDER BY created_at",
      [of.supplierId],
    );
    expect(refusals.rows.map((row) => row.reason)).toEqual([
      "photo_not_an_image",
      "photo_unsupported_format",
      "photo_no_pages",
      "photo_too_many_pages",
      "photo_too_large",
    ]);

    // One upload, however many pages, counts once — together with the refused ones.
    await db.query("DELETE FROM price_import_refusal");
    await settings.set({ price_import_uploads_per_supplier_hour: 2 });
    await new TestSettings(app).reload();
    const page = await of.as("get", "/supplier/price-imports");
    expect(priceImportPageSchema.parse(page.body).limits).toMatchObject({
      photoMaxPages: 2,
      photoMaxMb: 1,
    });
    await upload(of, [sample("two-pages-1"), sample("two-pages-2")]);
    expectError(await photos(of, [Buffer.from("x")]), 400, "PRICE_IMPORT_PHOTO_INVALID");
    const over = await photos(of, [sample("list-clean")]);
    expectError(over, 429, "RATE_LIMITED");
    expect(over.body.details).toMatchObject({ limit: "price_import_uploads_per_supplier" });
  });

  it("waits for a page with no table or unreadable: taken again or left out, the other pages keep what they gave", async () => {
    const of = await company("Фото Четыре");
    const uploaded = await upload(of, [sample("not-a-table"), sample("two-pages-1")]);
    const waits = await settled(of, uploaded.id, ["needs_retake"]);
    expect(waits.photo!.pages.map((page) => [page.pageNo, page.status, page.rows])).toEqual([
      [1, "no_table", null],
      [2, "read", 4],
    ]);
    // Not applied, no rows yet.
    const none = await db.query("SELECT 1 FROM price_import_row WHERE import_id = $1", [
      uploaded.id,
    ]);
    expect(none.rows).toHaveLength(0);
    ai.photoRequests.length = 0;
    ai.pricePhotoAnswers.length = 0;

    // «Переснять» the first page: only it goes to AI again.
    const retaken = await ok(
      of
        .as("put", `/supplier/price-imports/${uploaded.id}/photos/1`)
        .set("Content-Type", "image/jpeg")
        .send(sample("two-pages-2")),
      (body) => priceImportResponseSchema.parse(body).import,
    );
    expect(retaken.status).toBe("parsing");
    expect(retaken.photo!.pages[0]).toMatchObject({ status: "waiting", retakes: 1 });
    const done = await settled(of, uploaded.id, ["review"]);
    // Only the page taken again is read (twice: the two readings of a page).
    expect(ai.photoRequests.filter((call) => call.kind === "price")).toHaveLength(2);
    expect(done.stats).toMatchObject({ dataRows: 7 });
    const kept = await objects(`price-imports/${of.supplierId}/${uploaded.id}/`);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatch(/\/page-1-1-[0-9a-f-]{36}$/);
    expect(kept[1]).toBe(`price-imports/${of.supplierId}/${uploaded.id}/page-2-0`);
    const retakes = await db.query("SELECT 1 FROM price_import_photo_retake WHERE import_id = $1", [
      uploaded.id,
    ]);
    expect(retakes.rows).toHaveLength(1);
    // A retake is for a page that waits: not now.
    const late = await of
      .as("put", `/supplier/price-imports/${uploaded.id}/photos/2`)
      .set("Content-Type", "image/jpeg")
      .send(sample("two-pages-2"));
    expectError(late, 409, "PRICE_IMPORT_STATE");

    // Left out: the import goes on with the readable page.
    const second = await upload(of, [sample("unreadable-blur"), sample("list-clean")]);
    const waiting = await settled(of, second.id, ["needs_retake"]);
    expect(waiting.photo!.pages[0]!.status).toBe("unreadable");
    const removed = await ok(
      of.as("delete", `/supplier/price-imports/${second.id}/photos/1`),
      (body) => priceImportResponseSchema.parse(body).import,
    );
    expect(removed.photo!.pages.map((page) => page.pageNo)).toEqual([2]);
    const read = await settled(of, second.id, ["review"]);
    expect(read.stats).toMatchObject({ dataRows: 6 });

    // The only page can't be left out.
    const third = await upload(of, [sample("not-a-table")]);
    await settled(of, third.id, ["needs_retake"]);
    expectError(
      await of.as("delete", `/supplier/price-imports/${third.id}/photos/1`),
      409,
      "PRICE_IMPORT_STATE",
    );

    // Another company's upload is no upload at all.
    const stranger = await company("Фото Чужой");
    expectError(await stranger.as("get", `/supplier/price-imports/${third.id}`), 404, "NOT_FOUND");
    expectError(
      await stranger
        .as("put", `/supplier/price-imports/${third.id}/photos/1`)
        .set("Content-Type", "image/jpeg")
        .send(sample("list-clean")),
      404,
      "NOT_FOUND",
    );
    expectError(
      await stranger.as("delete", `/supplier/price-imports/${third.id}/photos/1`),
      404,
      "NOT_FOUND",
    );
  });

  it("reads a page twice: readings that disagree make it unreadable, one disagreeing row doubtful", async () => {
    const of = await company("Фото Сверка");
    const row = (article: string, name: string, price: number) => ({
      text: `${article} | ${name} | ${String(price)}`,
      article,
      brand: "GEELY",
      name,
      price,
      availability: "есть",
      leadTime: null,
      uncertain: [] as never[],
    });
    // A blurred page: a model makes up a table, and another one the next time.
    ai.pricePhotoAnswers.push(
      {
        kind: "price_list",
        rows: [row("AAAA-1", "Колодки", 10_500), row("BBBB-2", "Диск", 14_000)],
      },
      {
        kind: "price_list",
        rows: [row("1AM 335", "Фильтр", 3_800), row("Z 206", "Фильтр", 4_200)],
      },
    );
    const invented = await upload(of, [sample("list-clean")]);
    const waits = await settled(of, invented.id, ["needs_retake"]);
    expect(waits.photo!.pages[0]).toMatchObject({ status: "unreadable", rows: null });

    // A page read twice alike but for one price: that row is doubtful as a whole.
    const pads = row("04465-0K090", "Колодки тормозные передние", 18_500);
    const trw = { ...row("GDB3534", "Колодки тормозные передние TRW", 14_200), brand: "TRW" };
    const rear = row("4050068800", "Колодки тормозные задние", 16_900);
    ai.pricePhotoAnswers.push(
      { kind: "price_list", rows: [pads, trw, rear] },
      { kind: "price_list", rows: [pads, { ...trw, price: 17_200 }, rear] },
    );
    const read = await upload(of, [sample("two-pages-1")]);
    await settled(of, read.id, ["review"]);
    const rows = await allRows(of, read.id);
    expect(rows.map((entry) => entry.photo?.uncertain)).toEqual([[], ["row"], []]);
    expect((await summary(of, read.id)).preview.readConfirmationRequired).toBe(1);
  });

  it("waits while AI can't be reached or the day's budget is spent, and goes on by itself", async () => {
    const of = await company("Фото Пять");
    ai.mode = "unavailable";
    const uploaded = await upload(of, [sample("list-clean")]);
    const waits = await settled(
      of,
      uploaded.id,
      ["parsing"],
      (found) => found.photo?.aiWaiting === "unavailable",
    );
    expect(waits.photo!.recognized).toBe(0);
    ai.mode = "ok";
    await settled(of, uploaded.id, ["review"]);
    // The provider out of reach is no attempt of the page (TASK-064.A).
    const attempts = await db.query<{ read_attempts: number }>(
      "SELECT read_attempts FROM price_import_photo_page WHERE import_id = $1",
      [uploaded.id],
    );
    expect(attempts.rows).toEqual([{ read_attempts: 0 }]);

    await settings.set({ ai_daily_budget_usd: 0 });
    const second = await upload(of, [sample("list-tilt")]);
    await settled(of, second.id, ["parsing"], (found) => found.photo?.aiWaiting === "budget");
    await settings.set({ ai_daily_budget_usd: 10 });
    await settled(of, second.id, ["review"]);
  });

  it("removes the pages with the import's files after the retention; the import stays as history", async () => {
    const of = await company("Фото Шесть");
    const uploaded = await upload(of, [sample("two-pages-1"), sample("two-pages-2")]);
    await settled(of, uploaded.id, ["review"]);
    expect(await objects(`price-imports/${of.supplierId}/${uploaded.id}/`)).toHaveLength(2);
    await settings.set({ price_import_file_retention_days: 1 });
    await db.query("UPDATE price_import SET created_at = now() - interval '2 days' WHERE id = $1", [
      uploaded.id,
    ]);
    await worker.get(JobAdmin).runNow("prices.delete-files");
    const until = Date.now() + 30_000;
    while ((await objects(`price-imports/${of.supplierId}/${uploaded.id}/`)).length > 0) {
      if (Date.now() > until) throw new Error("The pages are still kept");
      await sleep(200);
    }
    const kept = await settled(of, uploaded.id, ["review"], (found) => !found.fileKept);
    expect(kept.photo!.pages).toHaveLength(2);
  });
  // ------------------------------------------------- TASK-064.A: hardening

  async function pageRow(importId: string, pageNo: number) {
    const result = await db.query<{
      status: string;
      read_attempts: number;
      first_reading: unknown;
      rows: unknown;
      seen_keys: { kind: string; key: string }[] | null;
    }>(
      "SELECT status, read_attempts, first_reading, rows, seen_keys FROM price_import_photo_page WHERE import_id = $1 AND page_no = $2",
      [importId, pageNo],
    );
    return result.rows[0]!;
  }

  async function itemIdByArticle(article: string): Promise<string> {
    const result = await db.query<{ id: string }>(
      "SELECT id FROM catalog_item WHERE article_norm = $1",
      [article.replace(/[^0-9A-Za-z]/g, "").toUpperCase()],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.id;
  }

  it("gives up on a page AI runs out of time on after the attempts — the others go on, the first reading is never paid twice, a retake starts over", async () => {
    const of = await company("Фото Семь");
    await settings.set({ price_photo_read_attempts: 2 });
    const options = worker.get<AiServiceOptions>(AI_SERVICE_OPTIONS);
    const usual = options.timeoutMs;
    options.timeoutMs = 300;
    ai.delayMs = 3_000;
    let uploaded!: PriceImport;
    try {
      // Page 1: the first reading answers, the second runs out of time
      // (the main model and the fallback) — twice. Page 2 is read as usual.
      ai.pricePhotoSlow.push(false, true, true, true, true);
      uploaded = await upload(of, [sample("list-clean"), sample("two-pages-1")]);
      const waits = await settled(of, uploaded.id, ["needs_retake"]);
      expect(waits.photo!.pages.map((page) => [page.pageNo, page.status])).toEqual([
        [1, "failed"],
        [2, "read"],
      ]);
      // 1 + 2 + 2 calls for page 1 (the first reading once), 2 for page 2.
      expect(ai.photoRequests.filter((call) => call.kind === "price")).toHaveLength(7);
      const firstReadings = await db.query(
        "SELECT 1 FROM ai_job WHERE kind = 'price_photo' AND input_ref->>'importId' = $1 AND (input_ref->>'page')::int = 1 AND (input_ref->>'reading')::int = 1",
        [uploaded.id],
      );
      expect(firstReadings.rows).toHaveLength(1);
      expect(await pageRow(uploaded.id, 1)).toMatchObject({
        status: "failed",
        read_attempts: 2,
        first_reading: null,
      });
      // Nothing more is tried: no money goes on the page past its attempts.
      await sleep(2_500);
      expect(ai.photoRequests.filter((call) => call.kind === "price")).toHaveLength(7);
    } finally {
      options.timeoutMs = usual;
    }

    // «Переснять»: the new picture starts over and is read.
    ai.photoRequests.length = 0;
    await ok(
      of
        .as("put", `/supplier/price-imports/${uploaded.id}/photos/1`)
        .set("Content-Type", "image/jpeg")
        .send(sample("list-clean")),
      (body) => priceImportResponseSchema.parse(body).import,
    );
    await settled(of, uploaded.id, ["review"]);
    expect(ai.photoRequests.filter((call) => call.kind === "price")).toHaveLength(2);
    const page = await pageRow(uploaded.id, 1);
    expect(page).toMatchObject({ status: "read", read_attempts: 0, first_reading: null });
    // The rows of the pages are cleared once the import's rows are written from them.
    expect(page.rows).toBeNull();
    expect((await pageRow(uploaded.id, 2)).rows).toBeNull();
    expect(page.seen_keys).toContainEqual({ kind: "article", key: "044650K090" });
    // What the screen asks of the pages carries none of it.
    const answer = await of.as("get", `/supplier/price-imports/${uploaded.id}`);
    expect(JSON.stringify(answer.body)).not.toContain("seenKeys");
    expect(JSON.stringify(answer.body)).not.toContain("firstReading");
  });

  it("never makes «missing» an offer only one reading saw on the photo; the review keeps the agreed rows only", async () => {
    const of = await company("Фото Восемь");
    const offerOn = (itemId: string) =>
      ok(
        of.as("post", "/supplier/offers", {
          itemId,
          price: 10_000,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        }),
        (body) => (body as { offer: { id: string } }).offer.id,
        201,
      );
    await offerOn(await itemIdByArticle("04465-0K090"));
    await offerOn(await itemIdByArticle("GDB3534"));
    const rear = await offerOn(await itemIdByArticle("4050068800"));
    const line = (article: string | null, name: string, price: number) => ({
      text: `${article ?? "—"} | ${name} | ${String(price)}`,
      article,
      brand: null,
      name,
      price,
      availability: "есть",
      leadTime: null,
      uncertain: [],
    });
    const pads = line("04465-0K090", "Колодки тормозные передние", 18_500);
    const oil = line(null, "Shell Helix HX8 5W-30, 4 л", 21_400);
    const mobil = line(null, "Mobil Super 3000 5W-40, 4 л", 19_800);
    const trw = line("GDB3534", "Колодки тормозные передние TRW", 14_200);
    // The second reading saw the TRW pads the first one left out.
    ai.pricePhotoAnswers.push(
      { kind: "price_list", rows: [pads, oil, mobil] },
      { kind: "price_list", rows: [pads, oil, mobil, trw] },
    );
    const uploaded = await upload(of, [sample("list-clean")]);
    await settled(of, uploaded.id, ["review"]);
    const reviewRows = await allRows(of, uploaded.id);
    expect(reviewRows).toHaveLength(3);
    expect(JSON.stringify(reviewRows)).not.toContain("GDB3534");
    // Only the rear pads, on no reading of the photo, are missing.
    const review = await summary(of, uploaded.id);
    expect(review.missing.offers).toBe(1);
    const missing = await ok(
      of.as("get", `/supplier/price-imports/${uploaded.id}/review/missing`),
      (body) => priceMissingPageSchema.parse(body),
    );
    expect(missing.offers.map((entry) => entry.offerId)).toEqual([rear]);
  });

  it("counts the uploads of a person before reading their bodies; a form past its limits is refused at the part that breaks them", async () => {
    const of = await company("Фото Девять");
    await settings.set({ price_photo_requests_per_account: 3, price_photo_max_pages: 2 });
    await new TestSettings(app).reload();
    // A form of thousands of tiny pages stops at the third.
    let many = of.as("post", "/supplier/price-imports/photos");
    for (let index = 0; index < 2000; index++) {
      many = many.attach("page", Buffer.from("x"), { filename: `p${String(index)}.jpg` });
    }
    const tooMany = await many;
    expectError(tooMany, 400, "PRICE_IMPORT_PHOTO_INVALID");
    expect(tooMany.body.details).toEqual({ page: null, reason: "too_many_pages", limit: 2 });
    // Refused ones count: a malformed form and a page of the wrong kind.
    expectError(
      await of
        .as("post", "/supplier/price-imports/photos")
        .set("Content-Type", "multipart/form-data; boundary=nothing")
        .send("not a form"),
      400,
      "PRICE_IMPORT_PHOTO_INVALID",
    );
    expectError(
      await of
        .as(
          "put",
          `/supplier/price-imports/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/photos/1`,
        )
        .set("Content-Type", "image/jpeg")
        .send(Buffer.from("x")),
      404,
      "NOT_FOUND",
    );
    const over = await photos(of, [sample("list-clean")]);
    expectError(over, 429, "RATE_LIMITED");
    expect(over.body.details).toMatchObject({ limit: "price_photo_requests_per_account" });
    // Another person is counted apart.
    const other = await company("Фото Десять");
    await upload(other, [sample("list-clean")]);
    // Without a valid token nothing is read or counted: 401 at once.
    const anonymous = await http()
      .post("/supplier/price-imports/photos")
      .set("X-Client", SUPPLIER_WEB)
      .set("X-Forwarded-For", nextIp())
      .attach("page", sample("list-clean"), { filename: "p.jpg" });
    expectError(anonymous, 401, "AUTH_REQUIRED");
    const forged = await http()
      .post("/supplier/price-imports/photos")
      .set("X-Client", SUPPLIER_WEB)
      .set("X-Forwarded-For", nextIp())
      .set("Authorization", "Bearer x.y.z")
      .attach("page", sample("list-clean"), { filename: "p.jpg" });
    expectError(forged, 401, "AUTH_REQUIRED");
  });

  it("removes the files of uploads that were never written; a page is not taken again once the import's files are gone", async () => {
    const of = await company("Фото Одиннадцать");
    // A process that stopped between storing the files and writing the import.
    const lostPrefix = `price-imports/${of.supplierId}/${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}/`;
    const lostFile = `price-imports/${of.supplierId}/${"2".repeat(8)}-2222-4222-8222-${"2".repeat(12)}`;
    for (const key of [`${lostPrefix}page-1-0`, `${lostPrefix}page-2-0`, lostFile]) {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from("x") }));
    }
    await db.query(
      "INSERT INTO price_file_pending (file_key, supplier_id, created_at) VALUES ($1, $3, now() - interval '25 hours'), ($2, $3, now() - interval '25 hours')",
      [lostPrefix, lostFile, of.supplierId],
    );
    // A written upload leaves no record behind; a fresh one is not touched.
    const uploaded = await upload(of, [sample("not-a-table"), sample("two-pages-1")]);
    const pending = await db.query<{ file_key: string }>("SELECT file_key FROM price_file_pending");
    expect(pending.rows.map((row) => row.file_key).sort()).toEqual([lostFile, lostPrefix].sort());
    await worker.get(JobAdmin).runNow("prices.cleanup-orphan-files");
    const until = Date.now() + 30_000;
    while (
      (await objects(lostPrefix)).length > 0 ||
      (await objects(lostFile)).length > 0 ||
      ((await db.query("SELECT 1 FROM price_file_pending")).rowCount ?? 0) > 0
    ) {
      if (Date.now() > until) throw new Error("The files of the lost uploads are still kept");
      await sleep(200);
    }
    expect(await objects(`price-imports/${of.supplierId}/${uploaded.id}/`)).toHaveLength(2);

    // The import waits for a retake when its files pass their retention.
    await settled(of, uploaded.id, ["needs_retake"]);
    await settings.set({ price_import_file_retention_days: 1 });
    await db.query("UPDATE price_import SET created_at = now() - interval '2 days' WHERE id = $1", [
      uploaded.id,
    ]);
    await worker.get(JobAdmin).runNow("prices.delete-files");
    await settled(of, uploaded.id, ["needs_retake"], (found) => !found.fileKept);
    const refused = await of
      .as("put", `/supplier/price-imports/${uploaded.id}/photos/1`)
      .set("Content-Type", "image/jpeg")
      .send(sample("list-clean"));
    expectError(refused, 409, "PRICE_IMPORT_FILES_DELETED");
    // Nothing of the refused retake is kept.
    expect(await objects(`price-imports/${of.supplierId}/${uploaded.id}/`)).toEqual([]);
    expect((await db.query("SELECT 1 FROM price_file_pending")).rows).toHaveLength(0);
  });
});
