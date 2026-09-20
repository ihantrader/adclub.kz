import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminBrandResponseSchema,
  adminCatalogItemCardSchema,
  adminCatalogItemPageSchema,
  adminCategoryResponseSchema,
  adminItemPhotosResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  catalogPhotoInvalidDetailsSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminCatalogItemCard,
  type AdminItemPhoto,
  type AdminItemPhotosResponse,
  type ErrorCode,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import sharp from "sharp";
import request, { type Response, type Test } from "supertest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { JobAdmin, type JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TcpProxy } from "../../testing/tcp-proxy";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { PhotoStorage } from "./photo-storage";

/**
 * TASK-013 end to end on a real PostgreSQL and a real S3-compatible
 * storage (MinIO): uploading a picture and checking it by its content,
 * the source and the three statuses, the primary photo and the order,
 * links with a limited life that open one file and no other, the sizes a
 * list and a card get, both values of `photo_display_mode`, the deferred
 * removal of files and the cleanup of files no record points at, and what
 * happens while the storage is down.
 *
 * The storage sits behind a TCP forwarder, so it can be made unreachable
 * at the same address and brought back without touching the container.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const ADMIN_WEB = "admin-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

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

/** A picture of a given size and colour, in a real format. */
function picture(width: number, height: number, tint: { r: number; g: number; b: number }) {
  return sharp({ create: { width, height, channels: 3, background: tint } });
}

const RED = { r: 200, g: 40, b: 40 };
const BLUE = { r: 20, g: 80, b: 200 };

const jpegOf = (tint = RED, width = 1600, height = 1200) =>
  picture(width, height, tint).jpeg().toBuffer();

/** A picture that really is large: random pixels don't compress. */
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3);
  for (let at = 0; at < raw.length; at++) {
    raw[at] = (at * 1103515245 + 12345) % 256;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
}

const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
  "utf8",
);

describe("photos of catalog items (PostgreSQL + Redis + MinIO)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minio: StartedTestContainer;
  let storageProxy: TcpProxy;
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
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let token: string;
  let itemId: string;
  let fixtureCounter = 0;

  beforeAll(async () => {
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
      new GenericContainer("quay.io/minio/minio:RELEASE.2025-04-08T15-41-24Z")
        .withCommand(["server", "/data"])
        .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
        .start(),
    ]);
    storageProxy = new TcpProxy(minio.getHost(), minio.getMappedPort(9000));
    await storageProxy.start();
    const endpoint = `http://127.0.0.1:${String(storageProxy.port)}`;

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
    await worker?.close();
    await app?.close();
    s3?.destroy();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await storageProxy?.stop();
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
    token = await setUpAdmin(ADMIN_PHONE);
    itemId = (await sampleItem()).item.id;
  });

  afterEach(async () => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  // ------------------------------------------------------------- plumbing

  /**
   * Empties the tables. The worker is running its jobs against the same
   * ones, so a sweep in flight can deadlock with the truncation; that is a
   * fact of the test bench, not of the product, and repeating settles it.
   */
  async function truncateAll(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await db.query(TRUNCATE_ALL);
        return;
      } catch (error) {
        if (attempt >= 10) {
          throw error;
        }
        await sleep(200);
      }
    }
  }

  async function createBucket(): Promise<void> {
    // MinIO answers 200 on /minio/health/live a moment before it takes
    // bucket calls; a few attempts cover that.
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
        return;
      } catch (error) {
        if ((error as { name?: string }).name === "BucketAlreadyOwnedByYou") {
          return;
        }
        await sleep(300);
      }
    }
    throw new Error("The test bucket could not be created");
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
    } as { signInStep: string });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return body.session.accessToken;
  }

  function call(bearer: string, method: Method, path: string, body?: object): Test {
    const test = http()
      [method](path)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  const asAdmin = (method: Method, path: string, body?: object): Test =>
    call(token, method, path, body);

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  /** A subcategory, a brand and one part to hang photos on. */
  async function created<T>(response: Response, parse: (body: unknown) => T): Promise<T> {
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return parse(response.body);
  }

  async function sampleItem(): Promise<AdminCatalogItemCard> {
    const suffix = String(fixtureCounter++);
    const node = await created(
      await asAdmin("post", "/admin/catalog/categories", {
        code: `brakes_${suffix}`,
        kind: "goods",
        names: { ru: `Тормозная система ${suffix}` },
      }),
      (body) => adminCategoryResponseSchema.parse(body).category,
    );
    const pads = await created(
      await asAdmin("post", "/admin/catalog/categories", {
        code: `pads_${suffix}`,
        kind: "goods",
        parentId: node.id,
        names: { ru: `Тормозные колодки ${suffix}` },
      }),
      (body) => adminCategoryResponseSchema.parse(body).category,
    );
    const brand = await created(
      await asAdmin("post", "/admin/catalog/brands", { name: `Geely ${suffix}`, isOem: true }),
      (body) => adminBrandResponseSchema.parse(body).brand,
    );
    return created(
      await asAdmin("post", "/admin/catalog/items", {
        type: "part",
        categoryId: pads.id,
        brandId: brand.id,
        article: `04465-0K${suffix.padStart(3, "0")}`,
        names: { ru: `Колодки тормозные передние ${suffix}` },
      }),
      (body) => adminCatalogItemCardSchema.parse(body),
    );
  }

  /** Uploads a picture as the administrator; the body is the file itself. */
  function upload(bytes: Buffer, query = "", type = "image/jpeg", item = itemId): Test {
    return http()
      .post(`/admin/catalog/items/${item}/photos${query}`)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", type)
      .send(bytes);
  }

  async function uploaded(bytes: Buffer, query = ""): Promise<AdminItemPhotosResponse> {
    const response = await upload(bytes, query);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return adminItemPhotosResponseSchema.parse(response.body);
  }

  async function photos(item = itemId): Promise<AdminItemPhotosResponse> {
    const response = await asAdmin("get", `/admin/catalog/items/${item}/photos`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return adminItemPhotosResponseSchema.parse(response.body);
  }

  async function setStatus(
    photo: AdminItemPhoto,
    status: string,
    reason?: string,
  ): Promise<Response> {
    return asAdmin("post", `/admin/catalog/items/${photo.itemId}/photos/${photo.id}/status`, {
      expectedVersion: photo.version,
      status,
      ...(reason ? { reason } : {}),
    });
  }

  async function approve(photo: AdminItemPhoto): Promise<AdminItemPhotosResponse> {
    const response = await setStatus(photo, "approved");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return adminItemPhotosResponseSchema.parse(response.body);
  }

  /** Uploads a picture and approves it at once. */
  async function approved(tint: { r: number; g: number; b: number }): Promise<AdminItemPhoto> {
    const after = await uploaded(await jpegOf(tint));
    const fresh = after.photos.find((photo) => photo.status === "proposed")!;
    const result = await approve(fresh);
    return result.photos.find((photo) => photo.id === fresh.id)!;
  }

  async function itemCard(item = itemId): Promise<AdminCatalogItemCard> {
    const response = await asAdmin("get", `/admin/catalog/items/${item}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return adminCatalogItemCardSchema.parse(response.body);
  }

  async function keys(): Promise<string[]> {
    const { rows } = await db.query<{ storage_key: string }>(
      "SELECT storage_key FROM item_photo_file ORDER BY storage_key",
    );
    return rows.map((row) => row.storage_key);
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function objectBytes(key: string): Promise<Buffer> {
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return Buffer.from(await object.Body!.transformToByteArray());
  }

  async function fetchSigned(url: string): Promise<{ status: number; bytes: Buffer }> {
    const response = await fetch(url);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  }

  async function runJob(name: string): Promise<void> {
    const admin = worker.get(JobAdmin);
    const deadline = Date.now() + 60_000;
    let { jobId } = await admin.runNow(name);
    while (jobId === null) {
      if (Date.now() > deadline) {
        throw new Error(`${name} could not be started: a run stayed waiting`);
      }
      await sleep(100);
      ({ jobId } = await admin.runNow(name));
    }
    for (;;) {
      const { rows } = await db.query<{ state: string }>(
        "SELECT state::text AS state FROM pgboss.job WHERE id = $1",
        [jobId],
      );
      if (rows[0]?.state === "completed") {
        return;
      }
      if (rows[0]?.state === "failed" || Date.now() > deadline) {
        throw new Error(`${name} did not complete: ${rows[0]?.state ?? "gone"}`);
      }
      await sleep(100);
    }
  }

  // ------------------------------------------------------------- the tests

  describe("upload and what is stored", () => {
    it("stores a picture as a candidate with three sizes and no camera data", async () => {
      const withExif = await picture(1600, 1200, RED)
        .withExif({ IFD0: { Make: "ACME" }, IFD3: { GPSLatitudeRef: "N" } })
        .jpeg()
        .toBuffer();

      const after = await uploaded(withExif);

      expect(after.photos).toHaveLength(1);
      const photo = after.photos[0]!;
      expect(photo).toMatchObject({
        status: "proposed",
        sourceType: "admin_upload",
        sourceUrl: null,
        proposedBy: "admin",
        contentType: "image/jpeg",
        width: 1600,
        height: 1200,
        isPrimary: false,
      });
      expect(photo.checksum).toMatch(/^[0-9a-f]{64}$/);
      // Not approved yet: the item shows nothing to a client (a placeholder).
      expect(after.photo).toBeNull();

      const stored = await keys();
      expect(stored).toHaveLength(3);
      expect(stored.map((key) => key.split("/").at(-1))).toEqual(
        expect.arrayContaining(["original.jpg", "card.jpg", "thumb.jpg"]),
      );
      for (const key of stored) {
        expect(key.startsWith(`catalog-photos/${itemId}/${photo.id}/`)).toBe(true);
        expect(await objectExists(key)).toBe(true);
        const bytes = await objectBytes(key);
        const metadata = await sharp(bytes).metadata();
        // AC-2: nothing that came with the file is kept.
        expect(metadata.exif).toBeUndefined();
        expect(bytes.includes(Buffer.from("ACME", "latin1"))).toBe(false);
        expect(bytes.includes(Buffer.from("GPSLatitudeRef", "latin1"))).toBe(false);
      }
    });

    it("refuses a file that is not a picture, whatever it is called or declared", async () => {
      const text = Buffer.from("this is a text file saved as photo.jpg", "utf8");
      const response = await upload(text);
      expectError(response, 400, "CATALOG_PHOTO_INVALID");
      expect(catalogPhotoInvalidDetailsSchema.parse(response.body.details).reason).toBe(
        "not_an_image",
      );
      expect(await keys()).toEqual([]);
    });

    it("refuses a vector picture: as bytes behind a raster type, and by its own type", async () => {
      const asPng = await upload(SVG, "", "image/png");
      expectError(asPng, 400, "CATALOG_PHOTO_INVALID");
      expect(catalogPhotoInvalidDetailsSchema.parse(asPng.body.details)).toEqual({
        reason: "unsupported_format",
        detected: "svg",
      });

      const asSvg = await upload(SVG, "", "image/svg+xml");
      expectError(asSvg, 415, "UNSUPPORTED_MEDIA_TYPE");
      expect(await keys()).toEqual([]);
    });

    it("refuses an empty body and a picture that breaks off", async () => {
      const empty = await upload(Buffer.alloc(0));
      expectError(empty, 400, "CATALOG_PHOTO_INVALID");
      expect(catalogPhotoInvalidDetailsSchema.parse(empty.body.details).reason).toBe("empty");

      const whole = await jpegOf();
      const broken = await upload(whole.subarray(0, 200));
      expectError(broken, 400, "CATALOG_PHOTO_INVALID");
      expect(catalogPhotoInvalidDetailsSchema.parse(broken.body.details).reason).toBe("broken");
    });

    it("refuses a file above the size limit with 413, not 500", async () => {
      await settings.set({ photo_max_size_mb: 1 });
      await new TestSettings(app).set({ photo_max_size_mb: 1 });
      const big = await noisyJpeg(1400, 1400);
      expect(big.byteLength).toBeGreaterThan(1024 * 1024);

      expectError(await upload(big), 413, "PAYLOAD_TOO_LARGE");
      expect(await keys()).toEqual([]);
    });

    it("stores the same picture only once for one item (AC-2)", async () => {
      const bytes = await jpegOf();
      const first = await uploaded(bytes);
      const again = await upload(bytes);

      expect(again.status).toBe(200);
      const after = adminItemPhotosResponseSchema.parse(again.body);
      expect(after.photos).toHaveLength(1);
      expect(after.photos[0]!.id).toBe(first.photos[0]!.id);
      expect(await keys()).toHaveLength(3);
    });

    it("keeps one picture on two items as two photos of their own", async () => {
      const bytes = await jpegOf();
      await uploaded(bytes);
      const other = await sampleItem();
      const response = await upload(bytes, "", "image/jpeg", other.item.id);
      expect(response.status).toBe(201);

      expect(await keys()).toHaveLength(6);
      expect((await photos(other.item.id)).photos).toHaveLength(1);
    });

    it("asks for the page a picture found on the internet came from", async () => {
      const bytes = await jpegOf();
      const without = await upload(bytes, "?sourceType=manufacturer");
      expectError(without, 400, "CATALOG_PHOTO_INVALID");
      expect(catalogPhotoInvalidDetailsSchema.parse(without.body.details).reason).toBe(
        "source_url_required",
      );

      const withPage = await uploaded(
        bytes,
        "?sourceType=manufacturer&sourceUrl=https%3A%2F%2Fgeely.example%2Fpads.jpg",
      );
      expect(withPage.photos[0]).toMatchObject({
        sourceType: "manufacturer",
        sourceUrl: "https://geely.example/pads.jpg",
      });
    });

    it("refuses a source address that is not an http link", async () => {
      const response = await upload(
        await jpegOf(),
        "?sourceType=multi_store&sourceUrl=javascript%3Aalert(1)",
      );
      expectError(response, 400, "VALIDATION_ERROR");
    });
  });

  describe("the body-type check (AC-10)", () => {
    it("lets a picture through on the upload route and refuses one everywhere else", async () => {
      const bytes = await jpegOf();
      expect((await upload(bytes)).status).toBe(201);

      // The same path, another method, and another route entirely.
      const listWithBody = await http()
        .get(`/admin/catalog/items/${itemId}/photos`)
        .set("X-Client", ADMIN_WEB)
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "image/jpeg")
        .send(bytes);
      expectError(listWithBody, 415, "UNSUPPORTED_MEDIA_TYPE");

      const otherRoute = await http()
        .post("/admin/catalog/brands")
        .set("X-Client", ADMIN_WEB)
        .set("Authorization", `Bearer ${token}`)
        .set("Content-Type", "image/jpeg")
        .send(bytes);
      expectError(otherRoute, 415, "UNSUPPORTED_MEDIA_TYPE");

      const jsonRoute = await asAdmin("post", "/admin/catalog/brands", { name: "TRW" });
      expect(jsonRoute.status).toBe(201);
    });
  });

  describe("source, statuses and the journal (AC-3)", () => {
    it("shows a client only what a person approved", async () => {
      const after = await uploaded(await jpegOf());
      expect(after.photo).toBeNull();
      expect((await itemCard()).item.photo).toBeNull();

      const photo = await approved(BLUE);

      const card = await itemCard();
      expect(card.item.photo?.photoId).toBe(photo.id);
      expect(card.photos.some((entry) => entry.isPrimary && entry.id === photo.id)).toBe(true);
    });

    it("refuses a photo only with a reason, and keeps it out of what clients see", async () => {
      const photo = await approved(RED);
      const without = await asAdmin(
        "post",
        `/admin/catalog/items/${itemId}/photos/${photo.id}/status`,
        { expectedVersion: photo.version, status: "rejected" },
      );
      expectError(without, 400, "VALIDATION_ERROR");

      const refused = await setStatus(photo, "rejected", "Чужая деталь на фото");
      expect(refused.status, JSON.stringify(refused.body)).toBe(200);
      const after = adminItemPhotosResponseSchema.parse(refused.body);
      expect(after.photos[0]).toMatchObject({
        status: "rejected",
        rejectionReason: "Чужая деталь на фото",
      });
      expect(after.photos[0]!.removedAt).not.toBeNull();
      expect(after.photo).toBeNull();
      expect((await itemCard()).item.photo).toBeNull();
    });

    it("writes every decision to the journal in the transaction of the decision", async () => {
      const photo = await approved(RED);
      await setStatus(photo, "rejected", "Размыто");

      const entries = auditLogPageSchema.parse(
        (await asAdmin("get", "/admin/audit-log?entityType=catalog_item_photo&limit=20")).body,
      ).entries;
      const actions = entries.map((entry) => entry.action);
      expect(actions).toContain("catalog_item_photo.uploaded");
      expect(actions).toContain("catalog_item_photo.status_changed");
      const upload = entries.find((entry) => entry.action === "catalog_item_photo.uploaded")!;
      expect(upload.entityId).toBe(photo.id);
      expect(upload.actor.role).toBe("admin");
      // The picture itself never goes into the journal.
      expect(JSON.stringify(upload.after)).not.toContain("data:");
    });

    it("writes nothing to the journal when the decision is refused", async () => {
      const photo = await approved(RED);
      const stale = await asAdmin(
        "post",
        `/admin/catalog/items/${itemId}/photos/${photo.id}/status`,
        { expectedVersion: photo.version + 5, status: "rejected", reason: "нет" },
      );
      expectError(stale, 409, "CATALOG_VERSION_CONFLICT");

      const entries = auditLogPageSchema.parse(
        (await asAdmin("get", "/admin/audit-log?action=catalog_item_photo.status_changed")).body,
      ).entries;
      expect(entries).toHaveLength(1);
    });

    it("refuses the second of two administrators deciding on one photo", async () => {
      const after = await uploaded(await jpegOf());
      const photo = after.photos[0]!;

      const approvedResponse = await setStatus(photo, "approved");
      expect(approvedResponse.status).toBe(200);
      // The other administrator still holds the version they read.
      const rejected = await setStatus(photo, "rejected", "Не та деталь");
      expectError(rejected, 409, "CATALOG_VERSION_CONFLICT");
    });
  });

  describe("the primary photo and the order (AC-4)", () => {
    it("makes the first approved photo the primary one", async () => {
      const first = await approved(RED);
      expect(first.isPrimary).toBe(true);
      const second = await approved(BLUE);
      expect(second.isPrimary).toBe(false);

      const { rows } = await db.query<{ primary_photo_id: string }>(
        "SELECT primary_photo_id FROM catalog_item WHERE id = $1",
        [itemId],
      );
      expect(rows[0]!.primary_photo_id).toBe(first.id);
    });

    it("hands the role to the next approved photo when the primary one is refused", async () => {
      const first = await approved(RED);
      const second = await approved(BLUE);

      const after = adminItemPhotosResponseSchema.parse(
        (await setStatus(first, "rejected", "Не та сторона")).body,
      );
      expect(after.photo?.photoId).toBe(second.id);
      expect(after.photos.find((photo) => photo.id === second.id)?.isPrimary).toBe(true);
      expect(after.photos.find((photo) => photo.id === first.id)?.isPrimary).toBe(false);
    });

    it("leaves the item without a picture when the last photo is removed", async () => {
      const only = await approved(RED);
      const after = adminItemPhotosResponseSchema.parse((await setStatus(only, "deleted")).body);
      expect(after.photo).toBeNull();
      const { rows } = await db.query<{ primary_photo_id: string | null }>(
        "SELECT primary_photo_id FROM catalog_item WHERE id = $1",
        [itemId],
      );
      expect(rows[0]!.primary_photo_id).toBeNull();
      expect((await itemCard()).item.photo).toBeNull();
    });

    it("puts the approved photos in the order asked for, the first one primary", async () => {
      const first = await approved(RED);
      const second = await approved(BLUE);

      const reordered = adminItemPhotosResponseSchema.parse(
        (
          await asAdmin("put", `/admin/catalog/items/${itemId}/photos/order`, {
            photoIds: [second.id, first.id],
          })
        ).body,
      );
      expect(reordered.photo?.photoId).toBe(second.id);
      expect(reordered.photos.map((photo) => photo.id)).toEqual([second.id, first.id]);
      expect(reordered.photos.map((photo) => photo.sort)).toEqual([0, 1]);
    });

    it("refuses an order that leaves a photo out or names one that is not approved", async () => {
      const first = await approved(RED);
      await approved(BLUE);
      const waiting = (await uploaded(await jpegOf({ r: 5, g: 200, b: 5 }))).photos.find(
        (photo) => photo.status === "proposed",
      )!;

      expectError(
        await asAdmin("put", `/admin/catalog/items/${itemId}/photos/order`, {
          photoIds: [first.id],
        }),
        409,
        "CATALOG_ORDER_MISMATCH",
      );
      expectError(
        await asAdmin("put", `/admin/catalog/items/${itemId}/photos/order`, {
          photoIds: [waiting.id, first.id],
        }),
        409,
        "CATALOG_PHOTO_NOT_APPROVED",
      );
    });

    it("keeps the photos of an item that is archived and restored", async () => {
      const photo = await approved(RED);
      const item = await itemCard();
      const archived = await asAdmin("post", `/admin/catalog/items/${itemId}/status`, {
        expectedVersion: item.item.version,
        status: "archived",
      });
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      expect(adminCatalogItemCardSchema.parse(archived.body).item.photo?.photoId).toBe(photo.id);

      const back = await asAdmin("post", `/admin/catalog/items/${itemId}/status`, {
        expectedVersion: adminCatalogItemCardSchema.parse(archived.body).item.version,
        status: "active",
      });
      expect(back.status).toBe(200);
      expect((await photos()).photos).toHaveLength(1);
      expect((await itemCard()).item.photo?.photoId).toBe(photo.id);
    });
  });

  describe("links to pictures (AC-5, AC-6)", () => {
    it("gives links that open the picture and expire", async () => {
      const photo = await approved(RED);
      const card = await itemCard();
      const image = card.item.photo!;

      expect(image.expiresAt).not.toBeNull();
      const opened = await fetchSigned(image.url);
      expect(opened.status).toBe(200);
      expect((await sharp(opened.bytes).metadata()).format).toBe("jpeg");

      // A link that has run out stops working, and the next answer carries
      // a fresh one.
      const storage = app.get(PhotoStorage);
      const key = (await keys()).find((entry) => entry.endsWith("card.jpg"))!;
      const shortLived = await storage.signedUrl(key, 1);
      await sleep(1500);
      expect((await fetchSigned(shortLived)).status).toBe(403);

      const again = await itemCard();
      expect((await fetchSigned(again.item.photo!.url)).status).toBe(200);
      expect(again.item.photo!.photoId).toBe(photo.id);
    });

    it("does not let a link reach another file", async () => {
      await approved(RED);
      const card = await itemCard();
      const url = new URL(card.item.photo!.url);
      const otherKey = (await keys()).find((entry) => entry.endsWith("original.jpg"))!;

      // The same signature, another key: the storage refuses it.
      const tampered = new URL(url.toString());
      tampered.pathname = `/${BUCKET}/${otherKey}`;
      expect((await fetchSigned(tampered.toString())).status).toBe(403);

      // And a key nobody was given at all.
      const guessed = new URL(url.toString());
      guessed.pathname = `/${BUCKET}/catalog-photos/${itemId}/00000000-0000-4000-8000-000000000000/original.jpg`;
      expect((await fetchSigned(guessed.toString())).status).toBe(403);
    });

    it("never sends the full-size picture to a list (AC-6)", async () => {
      await approved(RED);
      const page = adminCatalogItemPageSchema.parse(
        (await asAdmin("get", "/admin/catalog/items")).body,
      );
      const image = page.items.find((item) => item.id === itemId)!.photo!;

      for (const link of [image.url, image.thumbUrl]) {
        expect(link).not.toContain("original.jpg");
      }
      expect(image.thumbUrl).toContain("thumb.jpg");
      expect(image.url).toContain("card.jpg");
      expect(JSON.stringify(page)).not.toContain("original.jpg");

      const thumb = await fetchSigned(image.thumbUrl);
      const original = await objectBytes((await keys()).find((k) => k.endsWith("original.jpg"))!);
      expect(thumb.bytes.byteLength).toBeLessThan(original.byteLength);
      const size = await sharp(thumb.bytes).metadata();
      expect(Math.max(size.width!, size.height!)).toBe(320);

      // The administrator, moderating, does get the full-size picture.
      const cardPhotos = await photos();
      expect(cardPhotos.photos[0]!.originalUrl).toContain("original.jpg");
    });
  });

  describe("photo_display_mode (AC-7)", () => {
    it("serves our copy with copy and the source address with link", async () => {
      await settings.set({ photo_display_mode: "copy" });
      await new TestSettings(app).set({ photo_display_mode: "copy" });
      const response = await upload(
        await jpegOf(),
        "?sourceType=official_catalog&sourceUrl=https%3A%2F%2Fcatalog.example%2Fp%2F1",
      );
      expect(response.status).toBe(201);
      const photo = adminItemPhotosResponseSchema.parse(response.body).photos[0]!;
      await approve(photo);

      const asCopy = (await itemCard()).item.photo!;
      expect(asCopy.mode).toBe("copy");
      expect(asCopy.url).toContain("card.jpg");
      expect(asCopy.width).toBeGreaterThan(0);
      expect(asCopy.expiresAt).not.toBeNull();
      expect((await fetchSigned(asCopy.url)).status).toBe(200);

      await new TestSettings(app).set({ photo_display_mode: "link" });
      const asLink = (await itemCard()).item.photo!;
      expect(asLink).toMatchObject({
        mode: "link",
        url: "https://catalog.example/p/1",
        thumbUrl: "https://catalog.example/p/1",
        width: null,
        height: null,
        expiresAt: null,
      });
      // The administrator still moderates our copy.
      expect((await photos()).photos[0]!.image?.mode).toBe("copy");
    });

    it("serves our copy in link mode too when the photo has no source address", async () => {
      await new TestSettings(app).set({ photo_display_mode: "link" });
      await approved(RED);
      const image = (await itemCard()).item.photo!;
      expect(image.mode).toBe("copy");
      expect((await fetchSigned(image.url)).status).toBe(200);
    });
  });

  describe("removing files in the background (AC-8)", () => {
    it("keeps the files until the retention, then removes them", async () => {
      const photo = await approved(RED);
      const stored = await keys();
      await setStatus(photo, "deleted");

      // Still there: the retention has not passed.
      await settings.set({ photo_removed_retention_days: 7 });
      await runJob("catalog.delete-photo-files");
      for (const key of stored) {
        expect(await objectExists(key)).toBe(true);
      }

      await settings.set({ photo_removed_retention_days: 0 });
      await runJob("catalog.delete-photo-files");
      for (const key of stored) {
        expect(await objectExists(key)).toBe(false);
      }
      const { rows } = await db.query<{ files_deleted_at: Date | null; count: string }>(
        "SELECT files_deleted_at, (SELECT count(*)::text FROM item_photo_file) AS count FROM item_photo WHERE id = $1",
        [photo.id],
      );
      expect(rows[0]!.files_deleted_at).not.toBeNull();
      expect(rows[0]!.count).toBe("0");

      // The record itself stays as history, and running again is harmless.
      await runJob("catalog.delete-photo-files");
      expect((await photos()).photos).toHaveLength(1);
      expect((await photos()).photos[0]!.image).toBeNull();
    });

    it("does not bring back a photo whose files are gone", async () => {
      const photo = await approved(RED);
      await setStatus(photo, "deleted");
      await settings.set({ photo_removed_retention_days: 0 });
      await runJob("catalog.delete-photo-files");

      const gone = (await photos()).photos[0]!;
      expectError(await setStatus(gone, "approved"), 409, "CATALOG_PHOTO_FILES_DELETED");
    });

    it("removes files no record points at, and leaves the ones that have a record", async () => {
      await approved(RED);
      const stored = await keys();
      const orphan = `catalog-photos/${itemId}/99999999-9999-4999-8999-999999999999/original.jpg`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: orphan,
          Body: await jpegOf(BLUE, 40, 30),
          ContentType: "image/jpeg",
        }),
      );
      expect(await objectExists(orphan)).toBe(true);

      await settings.set({ photo_orphan_retention_hours: 24 });
      await runJob("catalog.cleanup-photo-files");
      expect(await objectExists(orphan)).toBe(true);

      await settings.set({ photo_orphan_retention_hours: 0 });
      await runJob("catalog.cleanup-photo-files");
      expect(await objectExists(orphan)).toBe(false);
      for (const key of stored) {
        expect(await objectExists(key)).toBe(true);
      }
      // Running again finds nothing left and changes nothing.
      await runJob("catalog.cleanup-photo-files");
      for (const key of stored) {
        expect(await objectExists(key)).toBe(true);
      }
    });
  });

  describe("the storage is down (AC-9)", () => {
    it("answers the upload with a repeatable error and goes on serving the catalog", async () => {
      await approved(RED);
      await storageProxy.stop();
      try {
        const refused = await upload(await jpegOf(BLUE));
        expectError(refused, 503, "SERVICE_UNAVAILABLE");
        expect(refused.body.retryable).toBe(true);

        // Reading the catalog is untouched: nothing is asked of the
        // storage to answer (links are signed, not fetched).
        expect((await http().get("/catalog/categories")).status).toBe(200);
        const card = await itemCard();
        expect(card.item.photo).not.toBeNull();
        expect((await photos()).photos).toHaveLength(1);
        expect((await http().get("/health")).status).toBe(200);
      } finally {
        await storageProxy.start();
      }

      const after = await upload(await jpegOf(BLUE));
      expect(after.status, JSON.stringify(after.body)).toBe(201);
    });
  });

  describe("who may do this (AC-11)", () => {
    it("serves the photo routes to an administrator only", async () => {
      const user = await signIn(USER_PHONE, IOS);
      const userToken = (user.body as { session: { accessToken: string } }).session.accessToken;
      rememberSecret(userToken);

      const uploadAsUser = await http()
        .post(`/admin/catalog/items/${itemId}/photos`)
        .set("X-Client", IOS)
        .set("Authorization", `Bearer ${userToken}`)
        .set("Content-Type", "image/jpeg")
        .send(await jpegOf());
      expectError(uploadAsUser, 403, "FORBIDDEN");

      const listAsUser = await http()
        .get(`/admin/catalog/items/${itemId}/photos`)
        .set("X-Client", IOS)
        .set("Authorization", `Bearer ${userToken}`);
      expectError(listAsUser, 403, "FORBIDDEN");

      const noSession = await http()
        .get(`/admin/catalog/items/${itemId}/photos`)
        .set("X-Client", ADMIN_WEB);
      expectError(noSession, 401, "AUTH_REQUIRED");
      expect(await keys()).toEqual([]);
    });
  });
});
