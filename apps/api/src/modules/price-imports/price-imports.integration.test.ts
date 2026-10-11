import { appendFileSync } from "node:fs";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminPriceImportPageSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  priceImportDetailResponseSchema,
  priceImportFileInvalidDetailsSchema,
  priceImportPageSchema,
  priceImportResponseSchema,
  priceImportRowsPageSchema,
  priceImportVersionConflictDetailsSchema,
  rateLimitedDetailsSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type ErrorCode,
  type PriceColumnRoleName,
  type PriceImport,
  type PriceImportStatus,
} from "@adclub/contracts";
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
import { JobAdmin, JobQueue, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { parsePriceFileJob } from "./price-import-jobs";
import { PriceImportExpiry } from "./price-import-runner";
import {
  cp1251Csv,
  kazakhXlsx,
  notATable,
  oneCExport,
  withErrorsCsv,
} from "./testing/price-samples";
import { writeXlsx } from "./testing/xlsx-writer";
import { SHARED_STRINGS, xlsxBomb, xlsxWithMerges } from "./testing/zip-bomb";

/**
 * TASK-046 end to end on a real PostgreSQL, Redis and object storage (MinIO)
 * with a real worker: the upload checked by its content and kept privately,
 * the limits, «тот же файл», reading the file into rows in the worker (CSV
 * encodings and separators, Excel with a title above the table, service
 * rows, the progress), the columns recognised and confirmed, the company's
 * remembered format, the values and the errors of rows, the file removed
 * after its retention, only the company's own imports, the administrator's
 * look, a blocked company, a stalled import, and a file of 50 000 rows.
 */

const ADMIN_PHONE = "+77010000369";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const ADMIN_WEB = "admin-web/0.1.0";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";

type Method = "get" | "post" | "put" | "patch" | "delete";

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

/** The roles the 1C example is recognised with. */
const ONE_C_ROLES: PriceColumnRoleName[] = [
  "ignore",
  "article",
  "name",
  "ignore",
  "ignore",
  "price",
  "availability",
];

describe("price list imports (PostgreSQL + Redis + MinIO)", () => {
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
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let phoneCounter = 0;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  /** Measurements printed once the tests are done (TASK-046 edge case: 50 000 rows). */
  const timings: string[] = [];

  beforeAll(async () => {
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
      // See catalog-photos.integration.test.ts for why this image and
      // `MINIO_SKIP_CLIENT` (ARCHITECTURE 4.34 I351).
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
  }, 300_000);

  afterAll(async () => {
    // The whole output of an integration file is captured and silenced; the
    // measurements go to a file when one is named (`PRICE_IMPORT_TIMINGS`).
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
    await truncateAll();
    await redis.flushall();
    await Promise.all([settings.reload(), new TestSettings(app).reload()]);
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
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

  /** A test administrator, signed in with a fresh second factor. */
  async function adminToken(): Promise<string> {
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
      .set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  interface Company {
    supplierId: string;
    memberId: string;
    as: (method: Method, path: string, body?: object) => Test;
    upload: (bytes: Buffer, fileName?: string) => Test;
  }

  /** A company of the test numbers +7 701 000 036x with a signed-in employee. */
  async function company(name = "Автомир Степь"): Promise<Company> {
    const phone = `+77010000${String(360 + phoneCounter++)}`;
    const operator = app.get(OperatorService);
    const { supplierId } = await operator.createSupplier({ name, city: "Алматы" });
    const { memberId } = await operator.addMember({ supplierId, phone, displayName: "Ерлан" });
    const response = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const bearer = (response.body as { session: { accessToken: string } }).session.accessToken;
    return {
      supplierId,
      memberId,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
      upload: (bytes, fileName) =>
        call(
          bearer,
          SUPPLIER_WEB,
          "post",
          `/supplier/price-imports${fileName ? `?fileName=${encodeURIComponent(fileName)}` : ""}`,
        )
          .set("Content-Type", "application/octet-stream")
          .send(bytes),
    };
  }

  async function uploaded(of: Company, bytes: Buffer, fileName?: string): Promise<PriceImport> {
    const response = await of.upload(bytes, fileName);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return priceImportResponseSchema.parse(response.body).import;
  }

  async function detail(of: Company, importId: string) {
    const response = await of.as("get", `/supplier/price-imports/${importId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return priceImportDetailResponseSchema.parse(response.body);
  }

  /** Waits until the worker has moved the import to one of `statuses`. */
  async function settled(
    of: Company,
    importId: string,
    statuses: PriceImportStatus[] = ["columns", "parsed", "failed"],
    timeoutMs = 60_000,
  ) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = await detail(of, importId);
      if (statuses.includes(found.import.status)) return found;
      if (Date.now() > until) {
        throw new Error(`The import is still ${found.import.status}`);
      }
      await sleep(200);
    }
  }

  async function confirm(
    of: Company,
    importId: string,
    roles: PriceColumnRoleName[],
    remember = true,
  ) {
    const response = await of.as("put", `/supplier/price-imports/${importId}/columns`, {
      roles,
      remember,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return priceImportResponseSchema.parse(response.body).import;
  }

  async function errorRows(of: Company, importId: string) {
    const response = await of.as("get", `/supplier/price-imports/${importId}/rows?limit=200`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return priceImportRowsPageSchema.parse(response.body);
  }

  async function objectsOf(supplierId: string): Promise<string[]> {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `price-imports/${supplierId}/` }),
    );
    return (page.Contents ?? []).map((object) => object.Key!);
  }

  // ---------------------------------------------------------------- tests

  it("reads a 1C export: the title passed over, the columns recognised, the supplier confirms, errors of rows", async () => {
    const of = await company();
    const created = await uploaded(of, oneCExport(), "Прайс 1С.xlsx");
    expect(created).toMatchObject({
      status: "parsing",
      format: "xlsx",
      fileName: "Прайс 1С.xlsx",
      sameFileAsImportId: null,
      uploadedBy: { memberId: of.memberId, name: "Ерлан" },
      fileKept: true,
    });
    // Kept privately under the company's prefix, named by the import alone.
    expect(await objectsOf(of.supplierId)).toEqual([
      `price-imports/${of.supplierId}/${created.id}`,
    ]);

    const read = await settled(of, created.id);
    expect(read.import).toMatchObject({
      status: "columns",
      sheetName: "TDSheet",
      headerRowNo: 6,
      columnsSource: "auto",
      stats: { rows: 1250, dataRows: 1240, serviceRows: 9, parsedRows: null, errorRows: null },
    });
    expect(read.columns!.map((column) => column.role)).toEqual(ONE_C_ROLES);
    expect(read.columns!.map((column) => column.header)).toEqual([
      "Код",
      "Артикул",
      "Номенклатура",
      "Ед.",
      "Опт",
      "Цена, тг",
      "Остаток",
    ]);
    expect(read.columns![1]).toMatchObject({ source: "header", confidence: 1 });
    expect(read.columns![4]).toMatchObject({ role: "ignore", source: null });
    expect(read.header?.rowNo).toBe(6);
    expect(read.preview).toHaveLength(20);
    // The first row of goods comes after the header and the first group.
    expect(read.preview[0]!.rowNo).toBe(8);
    expect(read.preview[0]!.cells).toHaveLength(7);

    // «Опт» stays unused; «Остаток» is not wanted: «Не использовать».
    const roles = [...ONE_C_ROLES];
    roles[6] = "ignore";
    const confirmed = await confirm(of, created.id, roles);
    expect(confirmed.status).toBe("reading");
    expect(confirmed.columnsSource).toBe("supplier");
    const parsed = await settled(of, created.id, ["parsed", "failed"]);
    expect(parsed.import).toMatchObject({
      status: "parsed",
      stats: { dataRows: 1240, parsedRows: 1228, errorRows: 12 },
    });
    expect(parsed.columns![6]).toMatchObject({ role: "ignore", source: "supplier" });
    expect(parsed.columns![1]).toMatchObject({ role: "article", source: "header" });

    const errors = await errorRows(of, created.id);
    expect(errors.total).toBe(12);
    expect(errors.rows.every((row) => row.errors[0]!.code === "price_not_number")).toBe(true);
    expect(errors.rows[0]!.errors[0]).toMatchObject({ text: "по запросу" });
    const all = priceImportRowsPageSchema.parse(
      (await of.as("get", `/supplier/price-imports/${created.id}/rows?only=data&limit=2`)).body,
    );
    expect(all.total).toBe(1240);
    expect(all.rows[0]!.parsed).toMatchObject({ price: expect.any(Number), availability: null });
    expect(all.nextCursor).not.toBeNull();
    const next = priceImportRowsPageSchema.parse(
      (
        await of.as(
          "get",
          `/supplier/price-imports/${created.id}/rows?only=data&limit=2&cursor=${all.nextCursor!}`,
        )
      ).body,
    );
    expect(next.rows[0]!.rowNo).toBeGreaterThan(all.rows[1]!.rowNo);

    // No offer was touched.
    expect((await db.query("SELECT count(*)::int AS n FROM offer")).rows[0].n).toBe(0);
  });

  it("knows the same file and skips the columns for the remembered format; forgetting it brings them back", async () => {
    const of = await company();
    const first = await uploaded(of, oneCExport(300, 3));
    await settled(of, first.id);
    await confirm(of, first.id, ONE_C_ROLES, true);
    await settled(of, first.id, ["parsed"]);

    // Uploaded during nothing: the same bytes again.
    const again = await uploaded(of, oneCExport(300, 3));
    expect(again.sameFileAsImportId).toBe(first.id);
    const skipped = await settled(of, again.id, ["parsed", "columns", "failed"]);
    expect(skipped.import).toMatchObject({
      status: "parsed",
      columnsSource: "remembered",
      stats: { dataRows: 300, errorRows: 3 },
    });
    expect(skipped.columns!.every((column) => column.source === "remembered")).toBe(true);

    // Another file of the same format (other rows): also without the screen.
    const other = await uploaded(of, oneCExport(120, 0));
    expect(other.sameFileAsImportId).toBeNull();
    expect((await settled(of, other.id, ["parsed", "columns"])).import.status).toBe("parsed");

    // The supplier opens the remembered roles and corrects them, unticking «Запомнить».
    const roles = [...ONE_C_ROLES];
    roles[4] = "price";
    roles[5] = "ignore";
    await confirm(of, other.id, roles, false);
    const corrected = await settled(of, other.id, ["parsed"]);
    expect(corrected.columns![4]).toMatchObject({ role: "price", source: "supplier" });
    const next = await uploaded(of, oneCExport(50, 0));
    expect((await settled(of, next.id)).import.status).toBe("columns");

    // Another company has its own formats.
    const stranger = await company("Шины Юг");
    const theirs = await uploaded(stranger, oneCExport(300, 3));
    expect(theirs.sameFileAsImportId).toBeNull();
    expect((await settled(stranger, theirs.id)).import.status).toBe("columns");
  });

  it("reads CSV in Windows-1251 with «;», Kazakh headers and a file of errors", async () => {
    const of = await company();
    const csv = await uploaded(of, cp1251Csv());
    expect(csv).toMatchObject({ format: "csv", encoding: "windows-1251", delimiter: ";" });
    const csvRead = await settled(of, csv.id);
    expect(csvRead.columns!.map((column) => column.role)).toEqual([
      "article",
      "brand",
      "name",
      "price",
      "availability",
      "lead_days",
    ]);
    expect(csvRead.columns![2]!.header).toBe("Наименование");
    expect(csvRead.preview[0]!.cells[2]).toMatch(/^[А-Яа-я]/);

    const kazakh = await uploaded(of, kazakhXlsx());
    const kazakhRead = await settled(of, kazakh.id);
    expect(kazakhRead.columns!.map((column) => [column.header, column.role])).toEqual([
      ["Каталог нөмірі", "article"],
      ["Өндіруші", "brand"],
      ["Атауы", "name"],
      ["Бағасы, ₸", "price"],
      ["Қалдық", "availability"],
      ["Жеткізу мерзімі", "lead_days"],
    ]);

    const faulty = await uploaded(of, withErrorsCsv());
    const faultyRead = await settled(of, faulty.id);
    await confirm(
      of,
      faulty.id,
      faultyRead.columns!.map((column) => column.role),
    );
    const done = await settled(of, faulty.id, ["parsed"]);
    expect(done.import.stats).toMatchObject({ dataRows: 10, parsedRows: 3, errorRows: 7 });
    const errors = await errorRows(of, faulty.id);
    expect(errors.rows.map((row) => [row.rowNo, row.errors.map((error) => error.code)])).toEqual([
      [3, ["price_missing"]],
      [4, ["price_not_number"]],
      [5, ["price_out_of_range"]],
      [6, ["price_out_of_range"]],
      [7, ["no_article_or_name"]],
      [8, ["lead_days_out_of_range"]],
      [10, ["price_not_number"]],
    ]);
    expect(errors.rows[2]!.errors[0]).toMatchObject({ value: 0, min: 1 });
  });

  it("refuses files it can't read, with the reason in words, and stores nothing", async () => {
    const of = await company();
    const xls = Buffer.from([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...Array(600).fill(0),
    ]);
    const xlsx = writeXlsx([
      {
        name: "Лист1",
        rows: [
          ["Артикул", "Цена"],
          ["X1", 100],
        ],
      },
    ]);
    const cases: [Buffer, string, string | null][] = [
      [Buffer.from("%PDF-1.7\n1 0 obj"), "not_a_table", "pdf"],
      [notATable(), "not_a_table", "text"],
      [
        Buffer.from("<html><body><table><tr><td>1</td></tr></table></body></html>"),
        "not_a_table",
        "html",
      ],
      [xls, "old_excel", "xls"],
      [Buffer.concat([xls, Buffer.from("EncryptedPackage", "utf16le")]), "encrypted", null],
      [xlsx.subarray(0, xlsx.length - 30), "broken", null],
      [Buffer.from([0xa4, 0xa6, 0x3b, 0xb5, 0x0a, 0x8b, 0x3b, 0x97, 0x0a]), "encoding", null],
    ];
    for (const [bytes, reason, detected] of cases) {
      const response = await of.upload(bytes);
      expectError(response, 400, "PRICE_IMPORT_FILE_INVALID");
      expect(priceImportFileInvalidDetailsSchema.parse(response.body.details)).toMatchObject({
        reason,
        detected,
      });
    }
    expectError(await of.upload(Buffer.alloc(0)), 400, "PRICE_IMPORT_FILE_INVALID");

    // Too many rows: a CSV at once, an Excel file by the worker.
    await settings.set({ import_max_rows: 100 });
    await sleep(100);
    const rows = ["Артикул;Цена", ...Array.from({ length: 120 }, (_, i) => `X${String(i)};100`)];
    const many = await of.upload(Buffer.from(rows.join("\n")));
    expectError(many, 400, "PRICE_IMPORT_FILE_INVALID");
    expect(many.body.details).toMatchObject({ reason: "too_many_rows", limit: 100 });
    const big = await uploaded(of, oneCExport(150, 0));
    const failed = await settled(of, big.id);
    expect(failed.import).toMatchObject({
      status: "failed",
      failure: { reason: "too_many_rows", limit: 100 },
      stats: null,
    });
    expect(failed.columns).toBeNull();

    // Larger than the setting: 413 before anything is looked at.
    await settings.set({ import_max_file_mb: 1 });
    await sleep(100);
    expectError(await of.upload(Buffer.alloc(1024 * 1024 + 10, 0x41)), 413, "PAYLOAD_TOO_LARGE");

    // Only the one Excel file the worker refused was stored.
    expect(await objectsOf(of.supplierId)).toEqual([`price-imports/${of.supplierId}/${big.id}`]);
  });

  it("serves a company only its own imports; the administrator only looks", async () => {
    const of = await company();
    const stranger = await company("Шины Юг");
    const own = await uploaded(of, withErrorsCsv());
    await settled(of, own.id);
    for (const [method, path] of [
      ["get", `/supplier/price-imports/${own.id}`],
      ["get", `/supplier/price-imports/${own.id}/rows`],
    ] as const) {
      expectError(await stranger.as(method, path), 404, "NOT_FOUND");
    }
    expectError(
      await stranger.as("put", `/supplier/price-imports/${own.id}/columns`, {
        roles: ["article", "name", "price", "availability", "lead_days"],
        remember: true,
      }),
      404,
      "NOT_FOUND",
    );
    const theirList = priceImportPageSchema.parse(
      (await stranger.as("get", "/supplier/price-imports")).body,
    );
    expect(theirList.imports).toEqual([]);
    const ownList = priceImportPageSchema.parse(
      (await of.as("get", "/supplier/price-imports")).body,
    );
    expect(ownList.imports.map((entry) => entry.id)).toEqual([own.id]);
    expect(ownList.limits).toEqual({ maxFileMb: 20, maxRows: 50_000 });

    const admin = await adminToken();
    const adminList = await call(
      admin,
      ADMIN_WEB,
      "get",
      `/admin/suppliers/${of.supplierId}/price-imports`,
    );
    expect(adminList.status, JSON.stringify(adminList.body)).toBe(200);
    expect(adminPriceImportPageSchema.parse(adminList.body).imports[0]).toMatchObject({
      id: own.id,
      status: "columns",
      uploadedBy: { name: "Ерлан" },
    });
    expectError(
      await call(admin, ADMIN_WEB, "get", `/admin/suppliers/${crypto.randomUUID()}/price-imports`),
      404,
      "NOT_FOUND",
    );
    // A cabinet session never reaches the admin route, nor an admin the cabinet's.
    expectError(
      await of.as("get", `/admin/suppliers/${of.supplierId}/price-imports`),
      403,
      "FORBIDDEN",
    );
    expectError(await call(admin, ADMIN_WEB, "get", "/supplier/price-imports"), 403, "FORBIDDEN");
  });

  it("checks the roles the supplier confirms and when they may be confirmed", async () => {
    const of = await company();
    const created = await uploaded(of, withErrorsCsv());
    await settled(of, created.id);
    const put = (roles: PriceColumnRoleName[]) =>
      of.as("put", `/supplier/price-imports/${created.id}/columns`, { roles, remember: true });
    expectError(await put(["article", "name", "price"]), 400, "VALIDATION_ERROR");
    expectError(
      await put(["article", "name", "price", "price", "lead_days"]),
      400,
      "VALIDATION_ERROR",
    );
    expectError(
      await put(["brand", "ignore", "price", "availability", "lead_days"]),
      400,
      "VALIDATION_ERROR",
    );
    expectError(
      await put(["article", "name", "ignore", "availability", "lead_days"]),
      400,
      "VALIDATION_ERROR",
    );
    // While the file is (again) being read, nothing is confirmed.
    await db.query("UPDATE price_import SET status = 'parsing' WHERE id = $1", [created.id]);
    const busy = await put(["article", "name", "price", "availability", "lead_days"]);
    expectError(busy, 409, "PRICE_IMPORT_STATE");
    expect(busy.body.details).toEqual({ status: "parsing" });
  });

  it("limits the uploads of one company per hour", async () => {
    await settings.set({ price_import_uploads_per_supplier_hour: 2 });
    await sleep(100);
    const of = await company();
    await uploaded(of, withErrorsCsv());
    await uploaded(of, cp1251Csv(20));
    const refused = await of.upload(kazakhXlsx(10));
    expectError(refused, 429, "RATE_LIMITED");
    expect(rateLimitedDetailsSchema.parse(refused.body.details).limit).toBe(
      "price_import_uploads_per_supplier",
    );
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(3500);
    // Another company is counted on its own.
    const other = await company("Шины Юг");
    await uploaded(other, withErrorsCsv());
  });

  it("lets a blocked company upload and read its price list (applying it is TASK-047)", async () => {
    const of = await company();
    const admin = await adminToken();
    const card = adminSupplierResponseSchema.parse(
      (await call(admin, ADMIN_WEB, "get", `/admin/suppliers/${of.supplierId}`)).body,
    );
    const blocked = await call(
      admin,
      ADMIN_WEB,
      "post",
      `/admin/suppliers/${of.supplierId}/block`,
      {
        expectedVersion: card.supplier.version,
        blocked: true,
        reason: "Проверка документов",
      },
    );
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    const created = await uploaded(of, withErrorsCsv());
    expect((await settled(of, created.id)).import.status).toBe("columns");
    await confirm(of, created.id, ["article", "name", "price", "availability", "lead_days"]);
    expect((await settled(of, created.id, ["parsed"])).import.status).toBe("parsed");
  });

  it("reads two uploads at once", async () => {
    const of = await company();
    const [first, second] = await Promise.all([
      uploaded(of, oneCExport(2000, 5)),
      uploaded(of, cp1251Csv(800)),
    ]);
    const [a, b] = await Promise.all([settled(of, first.id), settled(of, second.id)]);
    expect(a.import.stats?.dataRows).toBe(2000);
    expect(b.import.stats?.dataRows).toBe(800);
  });

  it("removes the file after its retention and keeps the history; a missing file fails the reading", async () => {
    const of = await company();
    const created = await uploaded(of, withErrorsCsv());
    await settled(of, created.id);
    await confirm(of, created.id, ["article", "name", "price", "availability", "lead_days"]);
    await settled(of, created.id, ["parsed"]);
    const young = await uploaded(of, cp1251Csv(10));
    await settled(of, young.id);

    await settings.set({ price_import_file_retention_days: 1 });
    await db.query("UPDATE price_import SET created_at = now() - interval '2 days' WHERE id = $1", [
      created.id,
    ]);
    await sleep(100);
    await worker.get(JobAdmin).runNow("prices.delete-files");
    const until = Date.now() + 30_000;
    while ((await detail(of, created.id)).import.fileKept && Date.now() < until) await sleep(200);
    const kept = await detail(of, created.id);
    expect(kept.import).toMatchObject({ fileKept: false, status: "parsed" });
    expect(kept.preview.length).toBeGreaterThan(0);
    expect((await errorRows(of, created.id)).total).toBe(7);
    expect(await objectsOf(of.supplierId)).toEqual([`price-imports/${of.supplierId}/${young.id}`]);

    // The file gone before the worker read it: the reading fails with the reason.
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: `price-imports/${of.supplierId}/${young.id}`,
      }),
    );
    await db.query("UPDATE price_import SET status = 'parsing' WHERE id = $1", [young.id]);
    await app.get(JobQueue).enqueue(parsePriceFileJob, { importId: young.id });
    const missing = await settled(of, young.id, ["failed"]);
    expect(missing.import.failure).toMatchObject({ reason: "file_missing" });
  });

  it("fails an import read longer than the timeout", async () => {
    const of = await company();
    const created = await uploaded(of, withErrorsCsv());
    await settled(of, created.id);
    await db.query(
      "UPDATE price_import SET status = 'reading', phase_started_at = now() - interval '2 hours' WHERE id = $1",
      [created.id],
    );
    await worker.get(PriceImportExpiry).run();
    const failed = await detail(of, created.id);
    expect(failed.import).toMatchObject({ status: "failed", failure: { reason: "timeout" } });
    expectError(
      await of.as("put", `/supplier/price-imports/${created.id}/columns`, {
        roles: ["article", "name", "price", "availability", "lead_days"],
        remember: true,
      }),
      409,
      "PRICE_IMPORT_STATE",
    );
  });

  it("reads 50 000 rows in the worker while the API answers", async () => {
    const of = await company();
    // 50 000 rows in all — the limit by default: 49 990 of goods, a title, a header, groups, totals.
    const bytes = oneCExport(49_990, 12);
    const started = Date.now();
    const created = await uploaded(of, bytes, "50k.xlsx");
    const uploadMs = Date.now() - started;
    // The API answers while the worker reads.
    const during = Date.now();
    const list = await of.as("get", "/supplier/price-imports");
    expect(list.status).toBe(200);
    const listMs = Date.now() - during;
    const read = await settled(of, created.id, ["columns", "failed"], 240_000);
    const parseMs = Date.now() - started;
    expect(read.import).toMatchObject({
      status: "columns",
      stats: { rows: 50_000, dataRows: 49_990 },
    });
    const confirmedAt = Date.now();
    await confirm(of, created.id, ONE_C_ROLES);
    const parsed = await settled(of, created.id, ["parsed", "failed"], 240_000);
    const valuesMs = Date.now() - confirmedAt;
    expect(parsed.import.stats).toMatchObject({ dataRows: 49_990, errorRows: 12 });
    timings.push(
      `[price-import 50k] bytes=${String(bytes.length)} uploadMs=${String(uploadMs)} listDuringParseMs=${String(listMs)} fileReadMs=${String(parseMs)} valuesReadMs=${String(valuesMs)}`,
    );
    expect(uploadMs).toBeLessThan(10_000);
    expect(parseMs + valuesMs).toBeLessThan(240_000);
  }, 600_000);

  // ------------------------------------------------- TASK-046.A: hardening

  const ARTICLE_NAME_PRICE: PriceColumnRoleName[] = [
    "article",
    "name",
    "price",
    "availability",
    "lead_days",
  ];

  async function rowsStored(importId: string): Promise<number> {
    const result = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM price_import_row WHERE import_id = $1",
      [importId],
    );
    return result.rows[0]!.n;
  }

  /** Polls /health every 100 ms while `work` runs; the longest answer, ms. */
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
    await sleep(250);
    try {
      await work();
      await sleep(300);
    } finally {
      polling = false;
      await poller;
    }
    return { max: Math.max(...health), count: health.length };
  }

  it("refuses the acceptance's 20 MB workbook at once by its ZIP directory, /health answering throughout", async () => {
    const of = await company();
    // Shared strings declared as 100 bytes, gigabytes of zeros inside.
    const bomb = xlsxBomb({ part: SHARED_STRINGS, megabytes: 19_500, declaredSize: 100 });
    let uploadMs = 0;
    const health = await healthDuring(async () => {
      const started = performance.now();
      const response = await of.upload(bomb, "bomb.xlsx");
      uploadMs = performance.now() - started;
      expectError(response, 400, "PRICE_IMPORT_FILE_INVALID");
      expect(response.body.details).toMatchObject({ reason: "broken" });
    });
    expect(await objectsOf(of.supplierId)).toEqual([]);
    timings.push(
      `[price-import bomb, acceptance] bytes=${String(bomb.length)} uploadMs=${uploadMs.toFixed(0)} healthMaxMs=${health.max.toFixed(0)} healthChecks=${String(health.count)}`,
    );
    expect(uploadMs).toBeLessThan(500);
    expect(health.max).toBeLessThan(200);
  }, 120_000);

  it("stores a 20 MB workbook that claims a plausible size; the worker stops unpacking it at once, /health answering throughout", async () => {
    const of = await company();
    // Declared as 20 MB — as much as its compressed bytes allow — gigabytes inside.
    const bomb = xlsxBomb({
      part: SHARED_STRINGS,
      megabytes: 19_500,
      declaredSize: 20 * 1024 * 1024,
    });
    let uploadMs = 0;
    let settledMs = 0;
    let importId = "";
    const health = await healthDuring(async () => {
      const started = performance.now();
      const response = await of.upload(bomb, "bomb.xlsx");
      uploadMs = performance.now() - started;
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      importId = priceImportResponseSchema.parse(response.body).import.id;
      const failed = await settled(of, importId, ["failed", "columns", "parsed"]);
      settledMs = performance.now() - started;
      expect(failed.import).toMatchObject({
        status: "failed",
        failure: { reason: "broken" },
        stats: null,
      });
    });
    expect(await rowsStored(importId)).toBe(0);
    timings.push(
      `[price-import bomb, plausible size] bytes=${String(bomb.length)} uploadMs=${uploadMs.toFixed(0)} failedAfterMs=${settledMs.toFixed(0)} healthMaxMs=${health.max.toFixed(0)} healthChecks=${String(health.count)}`,
    );
    // The upload is the 20 MB taken in and written to the storage — no reading.
    expect(uploadMs).toBeLessThan(2000);
    expect(settledMs).toBeLessThan(5000);
    expect(health.max).toBeLessThan(200);
  }, 120_000);

  it("refuses at once, and reads in the worker, what a large CSV hides past its start", async () => {
    const of = await company();
    const lines = ["Артикул;Цена"];
    for (let index = 1; index < 9_000; index++) lines.push(`X${String(index)};100`);
    const created = await uploaded(of, Buffer.from(`${lines.join("\n")}\n"X0;100\n`));
    const failed = await settled(of, created.id, ["failed", "columns"]);
    expect(failed.import.failure).toMatchObject({ reason: "broken", line: 9_001 });
  });

  it("counts refused uploads in the limit of the company, and forgets them after a day", async () => {
    await settings.set({ price_import_uploads_per_supplier_hour: 3 });
    await sleep(100);
    const of = await company();
    for (let attempt = 0; attempt < 3; attempt++) {
      expectError(await of.upload(Buffer.from("%PDF-1.7\n")), 400, "PRICE_IMPORT_FILE_INVALID");
    }
    const refused = await of.upload(withErrorsCsv());
    expectError(refused, 429, "RATE_LIMITED");
    expect(rateLimitedDetailsSchema.parse(refused.body.details).limit).toBe(
      "price_import_uploads_per_supplier",
    );
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(3500);
    // Nothing was stored of them.
    expect(await objectsOf(of.supplierId)).toEqual([]);
    const kept = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM price_import_refusal WHERE supplier_id = $1",
      [of.supplierId],
    );
    expect(kept.rows[0]!.n).toBe(3);
    // Another company is counted on its own.
    await uploaded(await company("Шины Юг"), withErrorsCsv());

    await db.query(
      "UPDATE price_import_refusal SET created_at = now() - interval '25 hours' WHERE supplier_id = $1",
      [of.supplierId],
    );
    await worker.get(PriceImportExpiry).run();
    const left = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM price_import_refusal",
    );
    expect(left.rows[0]!.n).toBe(0);
    await uploaded(of, withErrorsCsv());
  });

  it("applies 100 000 merged ranges without holding the worker: another company's file is read meanwhile", async () => {
    const of = await company();
    const other = await company("Шины Юг");
    const merged = await uploaded(of, xlsxWithMerges(50_000, 100_000));
    await sleep(200);
    const startedAt = Date.now();
    const small = await uploaded(other, withErrorsCsv());
    expect((await settled(other, small.id)).import.status).toBe("columns");
    const neighbourMs = Date.now() - startedAt;
    const read = await settled(of, merged.id, ["columns", "failed"], 120_000);
    expect(read.import).toMatchObject({ status: "columns", stats: { dataRows: 49_999 } });
    // The brand merged over the rows of goods belongs to each of them.
    expect(read.preview[5]!.cells[0]).toBe("Geely");
    timings.push(`[price-import merges] neighbourSettledMs=${String(neighbourMs)}`);
    expect(neighbourMs).toBeLessThan(5_000);
  }, 180_000);

  it("refuses a sheet merging more ranges than a price list has", async () => {
    const of = await company();
    const created = await uploaded(of, xlsxWithMerges(100, 100_001));
    expect((await settled(of, created.id)).import.failure).toMatchObject({ reason: "broken" });
  });

  it("goes on with a retry of a run that failed while reading the values by the remembered format", async () => {
    const of = await company();
    const first = await uploaded(of, withErrorsCsv());
    await settled(of, first.id);
    await confirm(of, first.id, ARTICLE_NAME_PRICE, true);
    await settled(of, first.id, ["parsed"]);
    const second = await uploaded(of, withErrorsCsv());
    expect((await settled(of, second.id, ["parsed"])).import.columnsSource).toBe("remembered");
    // As if the run died after the file was read, halfway through the values.
    await db.query(
      `UPDATE price_import SET status = 'reading', parsed_at = NULL,
         stats = jsonb_build_object('rows', 11, 'dataRows', 10, 'serviceRows', 0, 'valuesRead', 5)
       WHERE id = $1`,
      [second.id],
    );
    await db.query(
      "UPDATE price_import_row SET parsed = NULL, errors = NULL WHERE import_id = $1",
      [second.id],
    );
    await app.get(JobQueue).enqueue(parsePriceFileJob, { importId: second.id });
    const done = await settled(of, second.id, ["parsed", "failed"]);
    expect(done.import).toMatchObject({
      status: "parsed",
      stats: { dataRows: 10, errorRows: 7 },
    });
  });

  it("counts the time of a phase from when the worker took it: a queued upload doesn't expire", async () => {
    const of = await company();
    const created = await uploaded(of, withErrorsCsv());
    await settled(of, created.id);
    // The worker set it when it took the file.
    const started = await db.query<{ phase_started_at: Date | null; created_at: Date }>(
      "SELECT phase_started_at, created_at FROM price_import WHERE id = $1",
      [created.id],
    );
    expect(started.rows[0]!.phase_started_at!.getTime()).toBeGreaterThanOrEqual(
      started.rows[0]!.created_at.getTime(),
    );

    // Uploaded two hours ago and still waiting for the worker.
    await db.query(
      "UPDATE price_import SET status = 'parsing', phase_started_at = NULL, created_at = now() - interval '2 hours' WHERE id = $1",
      [created.id],
    );
    await worker.get(PriceImportExpiry).run();
    expect((await detail(of, created.id)).import.status).toBe("parsing");

    // Taken by the worker two hours ago: it times out, and its rows go.
    await db.query(
      "UPDATE price_import SET phase_started_at = now() - interval '2 hours' WHERE id = $1",
      [created.id],
    );
    await worker.get(PriceImportExpiry).run();
    expect((await detail(of, created.id)).import).toMatchObject({
      status: "failed",
      failure: { reason: "timeout" },
    });
    expect(await rowsStored(created.id)).toBe(0);
  });

  it("gives a timed-out import no rows from the run that is still reading it", async () => {
    const of = await company();
    const created = await uploaded(of, oneCExport(30_000, 0));
    const until = Date.now() + 60_000;
    while ((await detail(of, created.id)).import.progress?.done === 0 && Date.now() < until) {
      await sleep(50);
    }
    await db.query(
      "UPDATE price_import SET phase_started_at = now() - interval '2 hours' WHERE id = $1",
      [created.id],
    );
    await worker.get(PriceImportExpiry).run();
    expect((await detail(of, created.id)).import.status).toBe("failed");
    // The run goes on reading the file for a while; nothing it reads lands.
    for (let check = 0; check < 10; check++) {
      expect(await rowsStored(created.id)).toBe(0);
      await sleep(500);
    }
    expect((await detail(of, created.id)).import).toMatchObject({
      status: "failed",
      failure: { reason: "timeout" },
    });
  }, 120_000);

  it("remembers the format of a header of any length", async () => {
    const of = await company();
    const notes = Array.from(
      { length: 40 },
      (_, index) => `Примечание ${String(index)} ${"о".repeat(900)}`,
    );
    const csv = (price: number) =>
      Buffer.from(
        [
          ["Артикул", "Цена", ...notes].join(";"),
          ["X-1", String(price), ...notes.map(() => "")].join(";"),
          ["X-2", String(price + 1), ...notes.map(() => "")].join(";"),
        ].join("\n"),
      );
    const first = await uploaded(of, csv(100));
    const read = await settled(of, first.id);
    expect(read.columns).toHaveLength(42);
    const roles: PriceColumnRoleName[] = [
      "article",
      "price",
      ...notes.map(() => "ignore" as const),
    ];
    await confirm(of, first.id, roles, true);
    expect((await settled(of, first.id, ["parsed", "failed"])).import.status).toBe("parsed");
    const second = await uploaded(of, csv(200));
    expect((await settled(of, second.id, ["parsed", "columns", "failed"])).import).toMatchObject({
      status: "parsed",
      columnsSource: "remembered",
    });
  });

  it("doesn't let a page showing an older state overwrite a colleague's roles", async () => {
    const of = await company();
    const created = await uploaded(of, withErrorsCsv());
    const read = await settled(of, created.id);
    expect(read.import.version).toBe(1);
    const put = (body: object) =>
      of.as("put", `/supplier/price-imports/${created.id}/columns`, {
        roles: ARTICLE_NAME_PRICE,
        remember: false,
        ...body,
      });
    const first = await put({ expectedVersion: 1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(priceImportResponseSchema.parse(first.body).import.version).toBe(2);
    await settled(of, created.id, ["parsed"]);

    const stale = await put({ expectedVersion: 1 });
    expectError(stale, 409, "PRICE_IMPORT_VERSION_CONFLICT");
    expect(priceImportVersionConflictDetailsSchema.parse(stale.body.details)).toMatchObject({
      status: "parsed",
      version: 2,
      confirmedBy: { memberId: of.memberId, name: "Ерлан" },
    });
    expect((await detail(of, created.id)).import).toMatchObject({ status: "parsed", version: 2 });
    // A client that sends no version is answered as before.
    expect((await put({})).status).toBe(200);
  });

  it("answers a broken cursor with 400, never 500", async () => {
    const of = await company();
    const created = await uploaded(of, withErrorsCsv());
    await settled(of, created.id);
    const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const id = crypto.randomUUID();
    for (const bad of [
      cursor(["1", id]),
      cursor(["2026-10-11T10:00:00.000Z", "-".repeat(36)]),
      cursor(["+275760-09-13T00:00:00.000Z", id]),
      cursor(["2026-10-11", id]),
      cursor({}),
      "%25%25",
    ]) {
      expectError(
        await of.as("get", `/supplier/price-imports?cursor=${bad}`),
        400,
        "VALIDATION_ERROR",
      );
    }
    for (const bad of ["1e20", "99999999999", "-1", "1.5", "0x10"]) {
      expectError(
        await of.as("get", `/supplier/price-imports/${created.id}/rows?cursor=${bad}`),
        400,
        "VALIDATION_ERROR",
      );
    }
  });
});
