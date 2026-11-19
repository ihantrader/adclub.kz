import {
  CreateBucketCommand,
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
  adminCatalogRequestResponseSchema,
  adminCityResponseSchema,
  adminHomeSchema,
  adminItemPhotosResponseSchema,
  adminModerationPageSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  catalogPhotoInvalidDetailsSchema,
  catalogPhotoNotNeededDetailsSchema,
  ITEM_PHOTOS_MAX,
  PHOTO_REJECTED_ITEM_FULL,
  itemFromRequestResponseSchema,
  searchItemPhotosResponseSchema,
  supplierCatalogRequestPageSchema,
  supplierCatalogRequestResponseSchema,
  supplierModerationPhotoPageSchema,
  supplierModerationSummarySchema,
  supplierOfferPhotosSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  supplierPhotoUploadResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type DayHours,
  type ErrorCode,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import sharp from "sharp";
import request, { type Response, type Test } from "supertest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import type { JobsTuning } from "../../jobs";
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed, PhotoStorage } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { IMAGE_SEARCH_PROVIDER } from "./image-search-provider";
import { PhotoSearchRunner } from "./photo-search-job";
import type { TestImageSearch } from "./test-image-search";

/**
 * TASK-068 on a real PostgreSQL, Redis and S3-compatible storage (MinIO),
 * with the API and a worker; the image search is the test provider
 * (fixtures, no network):
 *
 * - «Найти фото»: the manufacturer's picture first, the same picture on two
 *   shops as `multi_store`, a single shop, a broken file, not a picture and
 *   addresses inside a private network dropped; every candidate's files in
 *   the storage; a second search proposes nothing again; the day's budget;
 *   the provider down; a service;
 * - the background job: only products on the showcase without a photo,
 *   `photo_search_retry_days` and `photo_search_per_day`;
 * - the moderation queue `photo` and the home card, the decision of the
 *   item's tab, the journal;
 * - suppliers' photos: the offer card and the request to add an item, the
 *   content check, size, the day's limit, another company's — 404, «Модерация»
 *   of the cabinet, the request's photos moving to the item made of it;
 * - what clients get: a supplier's photo as our copy in `link` mode, no
 *   mark of AI, no camera metadata kept.
 */

const ADMIN_PHONE = "+77011234567";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const MINIO_USER = "adclubtest";
const MINIO_PASSWORD = "adclubtestsecret";
const BUCKET = "adclub-test";

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

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) return `${prefix}${digit}`;
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

/** A real JPEG of one colour — and, when asked, with a camera and a place in its EXIF. */
function jpeg(tint: { r: number; g: number; b: number }, withGps = false): Promise<Buffer> {
  const image = sharp({ create: { width: 900, height: 700, channels: 3, background: tint } });
  return (
    withGps
      ? image.withExif({
          IFD0: { Make: "SpyCam", Model: "X1" },
          IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 15/1 0/1" },
        })
      : image
  )
    .jpeg()
    .toBuffer();
}

/** A large picture: random pixels don't compress. */
function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3);
  for (let at = 0; at < raw.length; at++) raw[at] = (at * 1103515245 + 12345) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
}

describe("photo search and suppliers' photos (PostgreSQL + Redis + MinIO + worker)", () => {
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
  let binCounter = 0;
  let phoneCounter = 0;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let token: string;
  let almaty: string;
  let padsId: string;
  let trwId: string;
  let rearId: string;

  beforeAll(async () => {
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
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
    expect(config.imageSearch.provider).toBe("test");
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
    await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
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
      catalog_requests_per_supplier_day: 1000,
      supplier_photo_requests_per_account: 1000,
    });
    await new TestSettings(app).reload();
    for (const provider of [app, worker]) {
      (provider.get(IMAGE_SEARCH_PROVIDER) as TestImageSearch).mode = "ok";
    }
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
    almaty = await ok(
      asAdmin("post", "/admin/cities", { code: "almaty", names: { ru: "Алматы", kk: "Алматы" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
    padsId = await itemByArticle("geely", "04465-0K090");
    trwId = await itemByArticle("trw", "GDB3534");
    rearId = await itemByArticle("geely", "4050068800");
  }, 120_000);

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) rememberCode(sent.code);
  });

  // ------------------------------------------------------------- plumbing

  async function createBucket(): Promise<void> {
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
          new PutObjectCommand({ Bucket: BUCKET, Key: probe, Body: Buffer.from("ready") }),
        );
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

  function call(
    bearer: string | null,
    client: string,
    method: Method,
    path: string,
    body?: object,
  ) {
    let test = http()[method](path).set("X-Client", client).set("X-Forwarded-For", nextIp());
    if (bearer) test = test.set("Authorization", `Bearer ${bearer}`);
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

  async function ok<T>(test: PromiseLike<Response>, parse: (body: unknown) => T, status = 200) {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  async function itemByArticle(brandKey: string, article: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
      [brandKey, normalizeArticle(article)],
    );
    expect(rows.length, article).toBe(1);
    return rows[0]!.id;
  }

  interface Company {
    supplierId: string;
    bearer: string;
    as: (method: Method, path: string, body?: object) => Test;
    upload: (path: string, bytes: Buffer, type?: string) => Test;
  }

  async function company(name: string): Promise<Company> {
    const phone = `+7705${String(++phoneCounter).padStart(7, "0")}`;
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0812340${String(binCounter++).padStart(4, "0")}`),
        cityId: almaty,
        type: "goods",
        address: `ул. ${name}, 1`,
        district: "Район",
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
    const signedIn = await signIn(phone, SUPPLIER_WEB);
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const bearer = (signedIn.body as { session: { accessToken: string } }).session.accessToken;
    return {
      supplierId: created.supplier.id,
      bearer,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
      upload: (path, bytes, type = "image/jpeg") =>
        http()
          .post(path)
          .set("X-Client", SUPPLIER_WEB)
          .set("X-Forwarded-For", nextIp())
          .set("Authorization", `Bearer ${bearer}`)
          .set("Content-Type", type)
          .send(bytes),
    };
  }

  async function putOffer(of: Company, itemId: string): Promise<string> {
    return ok(
      of.as("post", "/supplier/offers", {
        itemId,
        price: 6_500,
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: false,
      }),
      (body) => supplierOfferResponseSchema.parse(body).offer.id,
      201,
    );
  }

  const searchPhotos = (itemId: string) =>
    asAdmin("post", `/admin/catalog/items/${itemId}/photos/search`);

  async function queue(query = "") {
    return ok(asAdmin("get", `/admin/moderation${query}`), (body) =>
      adminModerationPageSchema.parse(body),
    );
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function setStatus(
    itemId: string,
    photo: { id: string; version: number },
    status: "approved" | "rejected",
    reason?: string,
  ) {
    return ok(
      asAdmin("post", `/admin/catalog/items/${itemId}/photos/${photo.id}/status`, {
        expectedVersion: photo.version,
        status,
        ...(reason ? { reason } : {}),
      }),
      (body) => adminItemPhotosResponseSchema.parse(body),
    );
  }

  // ----------------------------------------------------------------- search

  it("«Найти фото»: the manufacturer's picture, the same picture on two shops, the rest dropped", async () => {
    const answer = await ok(searchPhotos(padsId), (body) =>
      searchItemPhotosResponseSchema.parse(body),
    );
    expect(answer.search.results).toBe(9);
    expect(answer.search.candidates).toBe(2);
    const skipped = Object.fromEntries(
      answer.search.skipped.map((entry) => [entry.reason, entry.count]),
    );
    expect(skipped).toMatchObject({
      other_domain: 1,
      broken: 1,
      private_address: 2,
      not_an_image: 1,
      duplicate: 2,
    });
    const candidates = answer.photos.filter((photo) => photo.proposedBy === "ai");
    expect(candidates.map((photo) => [photo.sourceType, photo.status])).toEqual(
      expect.arrayContaining([
        ["manufacturer", "proposed"],
        ["multi_store", "proposed"],
      ]),
    );
    const manufacturer = candidates.find((photo) => photo.sourceType === "manufacturer")!;
    expect(manufacturer.sourceUrl).toBe("https://www.geely.com/parts/brake-pads-04465-0k090");
    expect(manufacturer.aiScore).toBeGreaterThan(
      candidates.find((photo) => photo.sourceType === "multi_store")!.aiScore!,
    );
    expect(answer.photoSearch).toMatchObject({ enabled: true, applicable: true, searches: 1 });
    expect(answer.photoSearch.lastSearchedAt).not.toBeNull();
    // Every candidate's three files are in the storage; nothing is approved by itself.
    const files = await db.query<{ storage_key: string }>(
      "SELECT f.storage_key FROM item_photo_file f JOIN item_photo p ON p.id = f.photo_id WHERE p.proposed_by = 'ai'",
    );
    expect(files.rows).toHaveLength(6);
    for (const row of files.rows) expect(await objectExists(row.storage_key)).toBe(true);
    expect(answer.photo).toBeNull();

    // Again: nothing new — the item has these pictures.
    const again = await ok(searchPhotos(padsId), (body) =>
      searchItemPhotosResponseSchema.parse(body),
    );
    expect(again.search.candidates).toBe(0);
    expect(again.search.skipped).toEqual(
      expect.arrayContaining([{ reason: "already_known", count: 3 }]),
    );
    expect(again.photoSearch.searches).toBe(2);

    // An official catalogue; an SVG is never a candidate.
    const trw = await ok(searchPhotos(trwId), (body) => searchItemPhotosResponseSchema.parse(body));
    expect(trw.photos.map((photo) => photo.sourceType)).toEqual(["official_catalog"]);
    expect(trw.search.skipped).toEqual([{ reason: "unsupported_format", count: 1 }]);

    // Nothing found — the search is still counted and noted.
    const rear = await ok(searchPhotos(rearId), (body) =>
      searchItemPhotosResponseSchema.parse(body),
    );
    expect(rear.search).toEqual({ results: 0, candidates: 0, skipped: [] });

    const log = await ok(
      asAdmin("get", `/admin/audit-log?entityType=catalog_item&entityId=${padsId}`),
      (body) => auditLogPageSchema.parse(body),
    );
    expect(
      log.entries.filter((entry) => entry.action === "catalog_item.photo_searched"),
    ).toHaveLength(2);
  });

  it("keeps the day's budget, says when the provider is down and refuses services", async () => {
    await settings.set({ photo_search_per_day: 1 });
    await new TestSettings(app).reload();
    (app.get(IMAGE_SEARCH_PROVIDER) as TestImageSearch).mode = "unavailable";
    const down = await searchPhotos(padsId);
    expectError(down, 503, "PHOTO_SEARCH_UNAVAILABLE");
    expect(down.body.details).toEqual({ reason: "provider" });
    // The failed request counted: the budget of the day is spent.
    (app.get(IMAGE_SEARCH_PROVIDER) as TestImageSearch).mode = "ok";
    const spent = await searchPhotos(padsId);
    expectError(spent, 429, "RATE_LIMITED");
    expect(spent.body.details).toMatchObject({ limit: "photo_search_per_day" });

    await settings.set({ photo_search_per_day: 100 });
    await new TestSettings(app).reload();
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM catalog_item WHERE item_type = 'service' LIMIT 1",
    );
    expectError(await searchPhotos(rows[0]!.id), 409, "PHOTO_SEARCH_NOT_APPLICABLE");
    const stored = await db.query<{ status: string }>(
      "SELECT status FROM photo_search ORDER BY created_at",
    );
    expect(stored.rows.map((row) => row.status)).toEqual(["unavailable"]);
  });

  it("the job searches products on the showcase without a photo, by its retry and its budget", async () => {
    const shop = await company("Автомаркет");
    await putOffer(shop, padsId);
    await putOffer(shop, trwId);
    const runner = worker.get(PhotoSearchRunner);
    const run = () =>
      runner.run({ jobId: "test", attempt: 1, signal: new AbortController().signal });
    // Only items with an offer on the showcase: the rear pads have none.
    expect((await runner.due(10)).sort()).toEqual([padsId, trwId].sort());

    await settings.set({ photo_search_per_day: 1 });
    await run();
    const first = await db.query<{ item_id: string; trigger: string }>(
      "SELECT item_id, trigger FROM photo_search",
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.trigger).toBe("job");

    await settings.set({ photo_search_per_day: 100 });
    // The searched item waits for moderation; the other one is due.
    await run();
    const second = await db.query<{ item_id: string }>("SELECT item_id FROM photo_search");
    expect(second.rows.map((row) => row.item_id).sort()).toEqual([padsId, trwId].sort());
    expect(await runner.due(10)).toEqual([]);

    // Candidates refused: still not again before `photo_search_retry_days`.
    await db.query(
      "UPDATE item_photo SET status = 'rejected', rejection_reason = 'Нет', removed_at = now() WHERE status = 'proposed'",
    );
    expect(await runner.due(10)).toEqual([]);
    await db.query(
      "UPDATE catalog_item SET photo_search_at = now() - interval '31 days' WHERE id = $1",
      [padsId],
    );
    expect(await runner.due(10)).toEqual([padsId]);
    await settings.set({ photo_search_retry_days: 60 });
    expect(await runner.due(10)).toEqual([]);
  });

  // -------------------------------------------------------------- moderation

  it("puts candidates and suppliers' photos into the queue; the item's decision takes them out", async () => {
    const shop = await company("Автомаркет");
    const offerId = await putOffer(shop, rearId);
    await ok(
      shop.upload(`/supplier/offers/${offerId}/photos`, await jpeg({ r: 10, g: 120, b: 30 })),
      (b) => b,
      201,
    );
    await ok(searchPhotos(padsId), (body) => body);

    const waiting = await queue("?kind=photo");
    expect(waiting.total).toBe(3);
    expect(waiting.entries.map((entry) => entry.source)).toEqual(["cabinet", "search", "search"]);
    const supplierEntry = waiting.entries[0]!;
    expect(supplierEntry).toMatchObject({
      kind: "photo",
      supplier: { id: shop.supplierId, name: "Автомаркет" },
      item: { id: rearId, article: "4050068800" },
      photo: { proposedBy: "supplier", sourceType: "supplier_photo", sourceUrl: null },
    });
    expect(supplierEntry.photo!.thumbUrl).toMatch(/^http/);
    const all = await queue();
    const home = await ok(asAdmin("get", "/admin/home"), (body) => adminHomeSchema.parse(body));
    expect(home.moderationWaiting).toBe(all.total);

    // «Подтвердить» from the queue: the same decision as the item's tab.
    const approved = await setStatus(rearId, supplierEntry.photo!, "approved");
    expect(approved.photos[0]).toMatchObject({ status: "approved", isPrimary: true });
    const [first, second] = waiting.entries.slice(1);
    await setStatus(padsId, first!.photo!, "rejected", "Чужая деталь");
    const rejectedAgain = await asAdmin(
      "post",
      `/admin/catalog/items/${padsId}/photos/${second!.photo!.id}/status`,
      { expectedVersion: second!.photo!.version, status: "rejected" },
    );
    expectError(rejectedAgain, 400, "VALIDATION_ERROR");
    expect((await queue("?kind=photo")).total).toBe(1);
    const homeAfter = await ok(asAdmin("get", "/admin/home"), (body) =>
      adminHomeSchema.parse(body),
    );
    expect(homeAfter.moderationWaiting).toBe((await queue()).total);

    const log = await ok(
      asAdmin("get", "/admin/audit-log?entityType=catalog_item_photo&limit=50"),
      (body) => auditLogPageSchema.parse(body),
    );
    const actions = log.entries.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "catalog_item_photo.found",
        "catalog_item_photo.uploaded",
        "catalog_item_photo.status_changed",
      ]),
    );
    expect(
      log.entries.find((entry) => entry.action === "catalog_item_photo.uploaded")!.actor,
    ).toMatchObject({
      role: "supplier",
    });
  });

  // ---------------------------------------------------- photos of suppliers

  it("takes a supplier's photo of an offer: content, size, the day's limit, another company's", async () => {
    const shop = await company("Автомаркет");
    const other = await company("Шины Юг");
    const offerId = await putOffer(shop, rearId);
    const card = await ok(shop.as("get", `/supplier/offers/${offerId}/photos`), (body) =>
      supplierOfferPhotosSchema.parse(body),
    );
    expect(card).toEqual({ needed: true, photos: [] });

    const picture = await jpeg({ r: 200, g: 40, b: 40 }, true);
    const sent = await ok(
      shop.upload(`/supplier/offers/${offerId}/photos`, picture),
      (body) => supplierPhotoUploadResponseSchema.parse(body),
      201,
    );
    expect(sent).toMatchObject({
      created: true,
      photo: { status: "proposed", rejectionReason: null },
    });
    // The same picture — nothing stored twice.
    const twice = await ok(shop.upload(`/supplier/offers/${offerId}/photos`, picture), (body) =>
      supplierPhotoUploadResponseSchema.parse(body),
    );
    expect(twice).toMatchObject({ created: false, photo: { id: sent.photo.id } });
    // Camera and place are gone from what is kept.
    const key = await db.query<{ storage_key: string }>(
      "SELECT storage_key FROM item_photo_file WHERE photo_id = $1 AND variant = 'original'",
      [sent.photo.id],
    );
    const stored = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key.rows[0]!.storage_key }),
    );
    const bytes = Buffer.from(await stored.Body!.transformToByteArray());
    expect((await sharp(picture).metadata()).exif).toBeDefined();
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    expect(bytes.includes(Buffer.from("SpyCam"))).toBe(false);

    const text = await shop.upload(
      `/supplier/offers/${offerId}/photos`,
      Buffer.from("not a picture at all"),
    );
    expectError(text, 400, "CATALOG_PHOTO_INVALID");
    expect(catalogPhotoInvalidDetailsSchema.parse(text.body.details).reason).toBe("not_an_image");
    expectError(
      await shop.upload(`/supplier/offers/${offerId}/photos`, picture, "image/gif"),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expectError(
      await other.upload(`/supplier/offers/${offerId}/photos`, picture),
      404,
      "NOT_FOUND",
    );
    expectError(await other.as("get", `/supplier/offers/${offerId}/photos`), 404, "NOT_FOUND");

    await settings.set({ photo_max_size_mb: 1 });
    await new TestSettings(app).reload();
    expectError(
      await shop.upload(`/supplier/offers/${offerId}/photos`, await noisyJpeg(1400, 1000)),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    await settings.set({ photo_max_size_mb: 10, supplier_photos_per_supplier_day: 2 });
    await new TestSettings(app).reload();
    await ok(
      shop.upload(`/supplier/offers/${offerId}/photos`, await jpeg({ r: 1, g: 2, b: 250 })),
      (b) => b,
      201,
    );
    const over = await shop.upload(
      `/supplier/offers/${offerId}/photos`,
      await jpeg({ r: 250, g: 250, b: 2 }),
    );
    expectError(over, 429, "RATE_LIMITED");
    expect(over.body.details).toMatchObject({ limit: "supplier_photos_per_supplier" });

    // Approved — «Фото принято», «новое»; the item needs no photo any more.
    const listed = await ok(asAdmin("get", `/admin/catalog/items/${rearId}/photos`), (body) =>
      adminItemPhotosResponseSchema.parse(body),
    );
    const mine = listed.photos.find((photo) => photo.id === sent.photo.id)!;
    expect(mine.supplier).toEqual({ id: shop.supplierId, name: "Автомаркет" });
    await setStatus(rearId, mine, "approved");
    const page = await ok(shop.as("get", "/supplier/moderation/photos"), (body) =>
      supplierModerationPhotoPageSchema.parse(body),
    );
    expect(page.total).toBe(2);
    expect(page.entries.find((entry) => entry.photo.id === sent.photo.id)).toMatchObject({
      photo: { status: "approved" },
      item: { id: rearId },
      isNew: true,
    });
    const summary = await ok(shop.as("get", "/supplier/moderation/summary"), (body) =>
      supplierModerationSummarySchema.parse(body),
    );
    expect(summary.unseen).toMatchObject({ photos: 1, total: 1 });
    expect(
      (
        await ok(other.as("get", "/supplier/moderation/photos"), (body) =>
          supplierModerationPhotoPageSchema.parse(body),
        )
      ).total,
    ).toBe(0);
    const after = await ok(shop.as("get", `/supplier/offers/${offerId}/photos`), (body) =>
      supplierOfferPhotosSchema.parse(body),
    );
    expect(after.needed).toBe(false);
    await settings.set({ supplier_photos_per_supplier_day: 100 });
    await new TestSettings(app).reload();
    expectError(
      await shop.upload(`/supplier/offers/${offerId}/photos`, await jpeg({ r: 9, g: 9, b: 9 })),
      409,
      "CATALOG_PHOTO_NOT_NEEDED",
    );

    // Clients: a supplier's photo has no source — our copy even in `link` mode; no mark of AI.
    await settings.set({ photo_display_mode: "link" });
    await new TestSettings(app).reload();
    const client = await http().get(`/catalog/items/${rearId}`).set("X-Client", IOS);
    expect(client.status, JSON.stringify(client.body)).toBe(200);
    const shown = (client.body as { item: { photos: { mode: string; sourceType: string }[] } }).item
      .photos;
    expect(shown).toEqual([
      expect.objectContaining({ mode: "copy", sourceType: "supplier_photo" }),
    ]);
    expect(JSON.stringify(client.body)).not.toMatch(/proposedBy|aiScore|"ai"/);
  });

  it("an approved candidate of the search is shown by its page in `link` mode, without a mark of AI", async () => {
    const shop = await company("Автомаркет");
    await putOffer(shop, trwId);
    const found = await ok(searchPhotos(trwId), (body) =>
      searchItemPhotosResponseSchema.parse(body),
    );
    await setStatus(trwId, found.photos[0]!, "approved");
    await settings.set({ photo_display_mode: "link" });
    await new TestSettings(app).reload();
    const client = await http().get(`/catalog/items/${trwId}`).set("X-Client", IOS);
    expect(client.status).toBe(200);
    const body = JSON.stringify(client.body);
    expect(body).toContain("https://aftermarket.zf.com/catalog/trw/gdb3534");
    expect(body).not.toMatch(/proposedBy|aiScore|"ai"|\[AI\]/);
  });

  it("photos of a request to add an item: up to three, the company's only, moving to the item made of it", async () => {
    const shop = await company("Автомаркет");
    const other = await company("Шины Юг");
    const ask = (name: string) =>
      ok(
        shop.as("post", "/supplier/catalog-requests", { name, brand: "Bosch", article: name }),
        (body) => supplierCatalogRequestResponseSchema.parse(body).request.id,
        201,
      );
    const requestId = await ask("FILTER-1");
    for (const tint of [
      { r: 10, g: 10, b: 200 },
      { r: 10, g: 200, b: 10 },
      { r: 200, g: 10, b: 10 },
    ]) {
      await ok(
        shop.upload(`/supplier/catalog-requests/${requestId}/photos`, await jpeg(tint)),
        (b) => b,
        201,
      );
    }
    const fourth = await shop.upload(
      `/supplier/catalog-requests/${requestId}/photos`,
      await jpeg({ r: 100, g: 100, b: 100 }),
    );
    expectError(fourth, 400, "CATALOG_PHOTO_INVALID");
    expect(fourth.body.details).toMatchObject({ reason: "too_many_photos" });
    expectError(
      await other.upload(
        `/supplier/catalog-requests/${requestId}/photos`,
        await jpeg({ r: 1, g: 1, b: 1 }),
      ),
      404,
      "NOT_FOUND",
    );
    // A photo of a request waits with it, not in the photo queue.
    expect((await queue("?kind=photo")).total).toBe(0);
    const mine = await ok(shop.as("get", "/supplier/catalog-requests"), (body) =>
      supplierCatalogRequestPageSchema.parse(body),
    );
    expect(mine.requests[0]!.photos).toHaveLength(3);
    const card = await ok(asAdmin("get", `/admin/catalog-requests/${requestId}`), (body) =>
      adminCatalogRequestResponseSchema.parse(body),
    );
    expect(card.request.photos).toHaveLength(3);
    expect(card.request.photos[0]!.originalUrl).toMatch(/^http/);

    const { rows: brands } = await db.query<{ id: string }>(
      "SELECT brand_id AS id FROM brand_spelling WHERE key = 'geely'",
    );
    const { rows: categories } = await db.query<{ id: string }>(
      "SELECT category_id AS id FROM catalog_item WHERE id = $1",
      [padsId],
    );
    const created = await ok(
      asAdmin("post", `/admin/catalog-requests/${requestId}/create-item`, {
        expectedVersion: card.request.version,
        item: {
          type: "part",
          categoryId: categories[0]!.id,
          brandId: brands[0]!.id,
          article: "FILTER-1",
          names: { ru: "Фильтр из запроса" },
        },
      }),
      (body) => itemFromRequestResponseSchema.parse(body),
      201,
    );
    const newItem = created.item.item.id;
    const photos = await ok(asAdmin("get", `/admin/catalog/items/${newItem}/photos`), (body) =>
      adminItemPhotosResponseSchema.parse(body),
    );
    expect(photos.photos).toHaveLength(3);
    expect(
      photos.photos.every(
        (photo) => photo.status === "proposed" && photo.catalogRequestId === requestId,
      ),
    ).toBe(true);
    expect((await queue("?kind=photo")).total).toBe(3);
    // A decided request takes no more photos.
    expectError(
      await shop.upload(
        `/supplier/catalog-requests/${requestId}/photos`,
        await jpeg({ r: 5, g: 5, b: 5 }),
      ),
      409,
      "CATALOG_PHOTO_NOT_NEEDED",
    );

    // A refused request takes its photos with it, with the same reason.
    const refused = await ask("FILTER-2");
    await ok(
      shop.upload(
        `/supplier/catalog-requests/${refused}/photos`,
        await jpeg({ r: 3, g: 99, b: 3 }),
      ),
      (b) => b,
      201,
    );
    const refusedCard = await ok(asAdmin("get", `/admin/catalog-requests/${refused}`), (body) =>
      adminCatalogRequestResponseSchema.parse(body),
    );
    await ok(
      asAdmin("post", `/admin/catalog-requests/${refused}/reject`, {
        expectedVersion: refusedCard.request.version,
        reason: "Нет такой детали",
      }),
      (b) => b,
    );
    const page = await ok(shop.as("get", "/supplier/moderation/photos"), (body) =>
      supplierModerationPhotoPageSchema.parse(body),
    );
    expect(page.entries[0]).toMatchObject({
      photo: { status: "rejected", rejectionReason: "Нет такой детали" },
      item: null,
      request: { id: refused, name: "FILTER-2" },
    });
  });

  // ------------------------------------------------------------ TASK-068.A

  const adminUpload = (itemId: string, bytes: Buffer) =>
    http()
      .post(`/admin/catalog/items/${itemId}/photos`)
      .set("X-Client", ADMIN_WEB)
      .set("X-Forwarded-For", nextIp())
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "image/jpeg")
      .send(bytes);

  async function requestOf(shop: Company, name: string): Promise<string> {
    return ok(
      shop.as("post", "/supplier/catalog-requests", { name, brand: "Bosch", article: name }),
      (body) => supplierCatalogRequestResponseSchema.parse(body).request.id,
      201,
    );
  }

  async function requestCard(requestId: string) {
    return ok(asAdmin("get", `/admin/catalog-requests/${requestId}`), (body) =>
      adminCatalogRequestResponseSchema.parse(body),
    );
  }

  async function objectsUnder(prefix: string): Promise<number> {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return listed.KeyCount ?? 0;
  }

  it("a request decided while its photo goes to the storage: 409, no photo without an owner", async () => {
    const shop = await company("Автомаркет");
    const storage = app.get(PhotoStorage);
    const original = storage.put.bind(storage);
    for (const decide of ["reject", "link"] as const) {
      const requestId = await requestOf(shop, `DECIDED-${decide}`);
      const card = await requestCard(requestId);
      let decided = false;
      const spy = vi.spyOn(storage, "put").mockImplementation(async (key, bytes, type) => {
        // The administrator decides between the check and the row.
        if (!decided) {
          decided = true;
          const answer =
            decide === "reject"
              ? await asAdmin("post", `/admin/catalog-requests/${requestId}/reject`, {
                  expectedVersion: card.request.version,
                  reason: "Нет такой детали",
                })
              : await asAdmin("post", `/admin/catalog-requests/${requestId}/link`, {
                  expectedVersion: card.request.version,
                  itemId: padsId,
                });
          expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        }
        return original(key, bytes, type);
      });
      try {
        const late = await shop.upload(
          `/supplier/catalog-requests/${requestId}/photos`,
          await jpeg({ r: decide === "reject" ? 40 : 41, g: 60, b: 90 }),
        );
        expectError(late, 409, "CATALOG_PHOTO_NOT_NEEDED");
        expect(catalogPhotoNotNeededDetailsSchema.parse(late.body.details).reason).toBe(
          "request_decided",
        );
      } finally {
        spy.mockRestore();
      }
      const rows = await db.query(
        "SELECT id FROM item_photo WHERE catalog_request_id = $1 AND item_id IS NULL AND removed_at IS NULL",
        [requestId],
      );
      expect(rows.rows).toEqual([]);
      expect(await objectsUnder(`catalog-photos/requests/${requestId}/`)).toBe(0);
    }
  });

  it("uploads to one request at the same moment stay within three photos", async () => {
    const shop = await company("Автомаркет");
    const requestId = await requestOf(shop, "PARALLEL-1");
    const pictures = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((n) => jpeg({ r: 20 * n, g: 200 - 20 * n, b: 77 })),
    );
    const answers = await Promise.all(
      pictures.map((picture) =>
        shop.upload(`/supplier/catalog-requests/${requestId}/photos`, picture),
      ),
    );
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([201, 201, 201, 400, 400, 400]);
    for (const refused of answers.filter((answer) => answer.status === 400)) {
      expect(refused.body.details).toMatchObject({ reason: "too_many_photos" });
    }
    const held = await db.query(
      "SELECT id FROM item_photo WHERE catalog_request_id = $1 AND item_id IS NULL AND removed_at IS NULL",
      [requestId],
    );
    expect(held.rows).toHaveLength(3);
  });

  it("photos of a request move into the item as far as its limit allows; the rest are refused with a reason", async () => {
    const shop = await company("Автомаркет");
    const requestId = await requestOf(shop, "FULL-1");
    for (const n of [0, 1, 2]) {
      await ok(
        shop.upload(
          `/supplier/catalog-requests/${requestId}/photos`,
          await jpeg({ r: 30 + 80 * n, g: 30, b: 160 }),
        ),
        (b) => b,
        201,
      );
    }
    // The item holds one photo less than it may.
    const first = await ok(
      adminUpload(padsId, await jpeg({ r: 1, g: 250, b: 250 })),
      (body) => adminItemPhotosResponseSchema.parse(body),
      201,
    );
    await db.query(
      `INSERT INTO item_photo (item_id, source_type, source_url, status, proposed_by, content_type,
         byte_size, width, height, checksum, uploaded_by)
       SELECT item_id, source_type, source_url, status, proposed_by, content_type, byte_size,
         width, height, encode(sha256((random()::text || g)::bytea), 'hex'), uploaded_by
       FROM item_photo, generate_series(1, $2::int) g WHERE id = $1`,
      [first.photos[0]!.id, ITEM_PHOTOS_MAX - 2],
    );
    const card = await requestCard(requestId);
    await ok(
      asAdmin("post", `/admin/catalog-requests/${requestId}/link`, {
        expectedVersion: card.request.version,
        itemId: padsId,
      }),
      (b) => b,
    );
    const active = await db.query(
      "SELECT id FROM item_photo WHERE item_id = $1 AND removed_at IS NULL",
      [padsId],
    );
    expect(active.rows).toHaveLength(ITEM_PHOTOS_MAX);
    const moved = await db.query<{ status: string; rejection_reason: string | null }>(
      "SELECT status, rejection_reason FROM item_photo WHERE catalog_request_id = $1 ORDER BY created_at",
      [requestId],
    );
    expect(moved.rows).toEqual([
      { status: "proposed", rejection_reason: null },
      { status: "rejected", rejection_reason: PHOTO_REJECTED_ITEM_FULL },
      { status: "rejected", rejection_reason: PHOTO_REJECTED_ITEM_FULL },
    ]);
    // The supplier sees why: the cabinet says the code in its language.
    const page = await ok(shop.as("get", "/supplier/moderation/photos"), (body) =>
      supplierModerationPhotoPageSchema.parse(body),
    );
    expect(
      page.entries.filter((entry) => entry.photo.rejectionReason === PHOTO_REJECTED_ITEM_FULL),
    ).toHaveLength(2);
  });

  it("a copy of someone else's photo tells the supplier nothing about it", async () => {
    const shop = await company("Автомаркет");
    const other = await company("Шины Юг");
    const shopOffer = await putOffer(shop, rearId);
    const otherOffer = await putOffer(other, rearId);
    const theirs = await jpeg({ r: 222, g: 11, b: 99 });
    const sent = await ok(
      shop.upload(`/supplier/offers/${shopOffer}/photos`, theirs),
      (body) => supplierPhotoUploadResponseSchema.parse(body),
      201,
    );
    // The administrator's own copy, and the shop's photo refused with a reason.
    const admins = await jpeg({ r: 12, g: 34, b: 56 });
    await ok(adminUpload(rearId, admins), (b) => b, 201);
    const listed = await ok(asAdmin("get", `/admin/catalog/items/${rearId}/photos`), (body) =>
      adminItemPhotosResponseSchema.parse(body),
    );
    await setStatus(
      rearId,
      listed.photos.find((photo) => photo.id === sent.photo.id)!,
      "rejected",
      "Секретная причина",
    );
    // A refused photo is out of the way: the same picture may be sent again by anyone.
    const resent = await other.upload(`/supplier/offers/${otherOffer}/photos`, theirs);
    expect(resent.status).toBe(201);

    for (const picture of [admins, theirs]) {
      const copy = await (picture === theirs ? shop : other).upload(
        `/supplier/offers/${picture === theirs ? shopOffer : otherOffer}/photos`,
        picture,
      );
      expectError(copy, 409, "CATALOG_PHOTO_NOT_NEEDED");
      expect(copy.body.details).toEqual({ reason: "already_there" });
      const text = JSON.stringify(copy.body);
      expect(text).not.toMatch(/thumbUrl|rejectionReason|Секретная|status/);
    }
    // Their own copy still comes back as it is.
    const own = await ok(other.upload(`/supplier/offers/${otherOffer}/photos`, theirs), (body) =>
      supplierPhotoUploadResponseSchema.parse(body),
    );
    expect(own).toMatchObject({ created: false, photo: { id: resent.body.photo.id } });
  });

  it("«Модерация → Фото» pages photos of one millisecond without losing any", async () => {
    const shop = await company("Автомаркет");
    const offerId = await putOffer(shop, rearId);
    await settings.set({ supplier_photos_per_supplier_day: 100 });
    await new TestSettings(app).reload();
    for (const n of [0, 1, 2, 3]) {
      await ok(
        shop.upload(`/supplier/offers/${offerId}/photos`, await jpeg({ r: 50, g: 50 + n, b: 5 })),
        (b) => b,
        201,
      );
    }
    // All four in one millisecond, a microsecond apart.
    await db.query(
      `UPDATE item_photo p SET created_at = timestamptz '2030-01-01 00:00:00.123' + s.n * interval '1 microsecond'
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM item_photo WHERE supplier_id = $1) s
       WHERE p.id = s.id`,
      [shop.supplierId],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<typeof supplierModerationPhotoPageSchema.parse> = await ok(
        shop.as("get", `/supplier/moderation/photos?limit=1${cursor ? `&cursor=${cursor}` : ""}`),
        (body) => supplierModerationPhotoPageSchema.parse(body),
      );
      seen.push(...page.entries.map((entry) => entry.photo.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expectError(
      await shop.as("get", "/supplier/moderation/photos?cursor=bm90LWEtY3Vyc29y"),
      400,
      "VALIDATION_ERROR",
    );
  });
});
