import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCompatibilityProposalPageSchema,
  adminCompatibilityProposalResponseSchema,
  adminCompatibilityRecordResponseSchema,
  adminItemCompatibilityResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  compatibilityCheckResponseSchema,
  copyCompatibilityResponseSchema,
  rateLimitedDetailsSchema,
  supplierCompatibilityProposalPageSchema,
  supplierCompatibilityProposalResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type CompatibilityCheckResponse,
  type CompatibilityItemResult,
  type CompatibilityLevel,
  type CompatibilityResult,
  type ErrorCode,
} from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { JsonLoggerService } from "../../common/logging";
import { loadConfig, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { DevVehicleSeed } from "../vehicles";
import { CompatibilityEvaluator, DevCompatibilitySeed } from ".";

/**
 * TASK-015 end to end on a real PostgreSQL (and Redis for sessions): the
 * calculation of compatibility on a case table (the four results, missing
 * levels, an incomplete car, an unknown year, several records, boundary
 * years), the display rule D-029, records kept by the administrator with
 * versions and the action journal, copying to an analog, proposals of
 * suppliers and their moderation, the client check, the access matrix, the
 * development seed with the scenarios of the task, and the calculation of
 * thousands of items in one statement.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77051234000";
const OTHER_MEMBER_PHONE = "+77051234001";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

type Method = "get" | "post" | "put" | "patch" | "delete";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("compatibility of items (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
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
    });
    const nest = await NestFactory.create<NestExpressApplication>(
      AppModule.forRoot(config, { settingsCache: { maxAgeMs: 50 } }),
      { bufferLogs: true },
    );
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    await nest.listen(0, "127.0.0.1");
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    settings = new TestSettings(app);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await truncateAll();
    await redis.flushall();
    await settings.reload();
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  // ------------------------------------------------------------- plumbing

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

  async function mobileToken(): Promise<string> {
    const response = await signIn(USER_PHONE, IOS);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  /** A company with one employee signed in to the cabinet. */
  async function cabinet(
    name: string,
    phone: string,
  ): Promise<{ token: string; supplierId: string }> {
    const operator = app.get(OperatorService);
    const { supplierId } = await operator.createSupplier({ name, city: "Алматы" });
    await operator.addMember({ supplierId, phone, displayName: "Сотрудник" });
    const response = await signIn(phone, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      token: (response.body as { session: { accessToken: string } }).session.accessToken,
      supplierId,
    };
  }

  function call(bearer: string, client: string, method: Method, path: string, body?: object) {
    const test = http()
      [method](path)
      .set("X-Client", client)
      .set("Authorization", `Bearer ${bearer}`);
    return body ? test.send(body) : test;
  }

  const asAdmin = (method: Method, path: string, body?: object): Test =>
    call(token, ADMIN_WEB, method, path, body);

  const asSupplier = (bearer: string, method: Method, path: string, body?: object): Test =>
    call(bearer, SUPPLIER_WEB, method, path, body);

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  async function ok<T>(test: Test, parse: (body: unknown) => T, status = 200): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  async function count(table: string, where = "true"): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    );
    return Number(rows[0]!.count);
  }

  async function idOf(query: string, params: unknown[] = []): Promise<string> {
    const { rows } = await db.query<{ id: string }>(query, params);
    expect(rows[0], query).toBeDefined();
    return rows[0]!.id;
  }

  // ---------------------------------------------------------------- world

  /**
   * The development catalog and vehicle catalog, and the ids the tests
   * speak of. Atlas I is 2016–2022 (a modification crossover 2.4 AT AWD
   * 2018–2022), Atlas II is 2023– (crossover 2.0T AT AWD 2024–), Coolray I
   * 2019– (crossover 1.5T DCT FWD 2020–).
   */
  async function world() {
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    const make = (key: string) =>
      idOf("SELECT make_id AS id FROM vehicle_make_spelling WHERE key = $1", [key]);
    const geely = await make("geely");
    const chery = await make("chery");
    const model = (key: string) =>
      idOf("SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = $1 AND key = $2", [
        geely,
        key,
      ]);
    const atlas = await model("atlas");
    const coolray = await model("coolray");
    const generation = (modelId: string, name: string) =>
      idOf("SELECT id FROM vehicle_generation WHERE model_id = $1 AND name_key = $2", [
        modelId,
        name,
      ]);
    const atlasI = await generation(atlas, "i (nl-3)");
    const atlasII = await generation(atlas, "ii (fx11)");
    const coolrayI = await generation(coolray, "i (sx11)");
    const engine = (key: string) =>
      idOf("SELECT engine_id AS id FROM vehicle_engine_spelling WHERE key = $1", [key]);
    const option = (kind: string, code: string) =>
      idOf("SELECT id FROM vehicle_option WHERE kind = $1 AND code = $2", [kind, code]);
    const modification = (generationId: string) =>
      idOf("SELECT id FROM vehicle_modification WHERE generation_id = $1 LIMIT 1", [generationId]);
    const category = (code: string) => idOf("SELECT id FROM category WHERE code = $1", [code]);
    const brand = (key: string) =>
      idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = $1", [key]);
    const item = (brandKey: string, article: string) =>
      idOf(
        "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
        [brandKey, normalizeArticle(article)],
      );
    return {
      geely,
      chery,
      atlas,
      coolray,
      atlasI,
      atlasII,
      coolrayI,
      e4G24: await engine("jlc-4g24"),
      e4G20: await engine("jlh-4g20td"),
      e3G15: await engine("jlh-3g15td"),
      crossover: await option("body", "crossover"),
      sedan: await option("body", "sedan"),
      at: await option("transmission", "at"),
      dct: await option("transmission", "dct"),
      awd: await option("drive", "awd"),
      fwd: await option("drive", "fwd"),
      atlasIMod: await modification(atlasI),
      atlasIIMod: await modification(atlasII),
      coolrayMod: await modification(coolrayI),
      brakePads: await category("brake_pads"),
      engineOils: await category("engine_oils"),
      oilChange: await category("oil_change"),
      trw: await brand("trw"),
      frontPads: await item("geely", "04465-0K090"),
      trwPads: await item("trw", "GDB3534"),
      rearPads: await item("geely", "4050068800"),
      oil: await idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND field = 'name' AND lang = 'ru' AND text = 'Shell Helix HX8 5W-30, 4 л'",
      ),
      service: await idOf("SELECT id FROM catalog_item WHERE item_type = 'service' LIMIT 1"),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  let articleCounter = 0;

  /** A TRW part of a subcategory, written directly (the fixture of a case). */
  async function part(w: World, categoryId = w.brakePads): Promise<string> {
    const article = `CASE-${String(++articleCounter)}`;
    return idOf(
      `INSERT INTO catalog_item (item_type, category_id, category_kind, category_level, brand_id, article, article_norm)
       VALUES ('part', $1, 'goods', 2, $2, $3, $4) RETURNING id`,
      [categoryId, w.trw, article, normalizeArticle(article)],
    );
  }

  async function addRecord(itemId: string, conditions: object, evidence = "Каталог производителя") {
    return ok(
      asAdmin("post", `/admin/catalog/items/${itemId}/compatibility`, { conditions, evidence }),
      (body) => adminCompatibilityRecordResponseSchema.parse(body).record,
      201,
    );
  }

  function checkRequest(body: object, bearer?: string, client = IOS): Test {
    const test = http().post("/catalog/compatibility/check").set("X-Client", client);
    return (bearer ? test.set("Authorization", `Bearer ${bearer}`) : test).send(body);
  }

  async function check(body: object): Promise<CompatibilityCheckResponse> {
    return ok(checkRequest(body), (response) => compatibilityCheckResponseSchema.parse(response));
  }

  async function resultOf(
    itemId: string,
    vehicle: object | null,
  ): Promise<CompatibilityItemResult> {
    const response = await check({ itemIds: [itemId], vehicle });
    expect(response.items).toHaveLength(1);
    return response.items[0]!;
  }

  // ------------------------------------------------------------ the rules

  describe("the calculation (case table)", () => {
    interface Case {
      name: string;
      records: (w: World) => object[];
      car: (w: World) => object;
      result: CompatibilityResult;
      missing?: CompatibilityLevel[];
    }

    const atlasYears = (w: World, yearFrom: number | null, yearTo: number | null) => ({
      makeId: w.geely,
      modelId: w.atlas,
      yearFrom,
      yearTo,
    });

    const cases: Case[] = [
      {
        name: "no approved records — not specified",
        records: () => [],
        car: (w) => ({ modificationId: w.atlasIIMod }),
        result: "not_specified",
      },
      {
        name: "a record on the make fits a car known by its make only",
        records: (w) => [{ makeId: w.geely }],
        car: (w) => ({ makeId: w.geely }),
        result: "fits",
      },
      {
        name: "a record on the model fits every car of the model",
        records: (w) => [{ makeId: w.geely, modelId: w.atlas }],
        car: (w) => ({ modificationId: w.atlasIIMod }),
        result: "fits",
      },
      {
        name: "a record on the second generation doesn't fit the first",
        records: (w) => [{ makeId: w.geely, generationId: w.atlasII }],
        car: (w) => ({ modificationId: w.atlasIMod }),
        result: "does_not_fit",
      },
      {
        name: "a car known by its model only needs the generation",
        records: (w) => [{ makeId: w.geely, generationId: w.atlasII }],
        car: (w) => ({ modelId: w.atlas }),
        result: "needs_details",
        missing: ["generation"],
      },
      {
        name: "a 2019 car of the model isn't of a generation made since 2023",
        records: (w) => [{ makeId: w.geely, generationId: w.atlasII }],
        car: (w) => ({ modelId: w.atlas, year: 2019 }),
        result: "does_not_fit",
      },
      {
        name: "a 2024 car of the model may be of that generation — ask",
        records: (w) => [{ makeId: w.geely, generationId: w.atlasII }],
        car: (w) => ({ modelId: w.atlas, year: 2024 }),
        result: "needs_details",
        missing: ["generation"],
      },
      {
        name: "a record needs the engine, the car doesn't know it",
        records: (w) => [{ makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 }],
        car: (w) => ({ generationId: w.atlasII }),
        result: "needs_details",
        missing: ["engine"],
      },
      {
        name: "one record needs the engine, another fits without it — fits",
        records: (w) => [
          { makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 },
          { makeId: w.geely, generationId: w.atlasII },
        ],
        car: (w) => ({ generationId: w.atlasII }),
        result: "fits",
      },
      {
        name: "the engine of the modification matches",
        records: (w) => [{ makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 }],
        car: (w) => ({ modificationId: w.atlasIIMod }),
        result: "fits",
      },
      {
        name: "another engine contradicts",
        records: (w) => [{ makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 }],
        car: (w) => ({ modificationId: w.atlasIMod }),
        result: "does_not_fit",
      },
      {
        name: "one record on another make — does not fit",
        records: (w) => [{ makeId: w.chery }],
        car: (w) => ({ modificationId: w.coolrayMod }),
        result: "does_not_fit",
      },
      {
        name: "records on two makes — the one of the car fits",
        records: (w) => [{ makeId: w.chery }, { makeId: w.geely, modelId: w.coolray }],
        car: (w) => ({ modificationId: w.coolrayMod }),
        result: "fits",
      },
      {
        name: "records on two makes — neither is the car's model",
        records: (w) => [{ makeId: w.chery }, { makeId: w.geely, modelId: w.coolray }],
        car: (w) => ({ modificationId: w.atlasIMod }),
        result: "does_not_fit",
      },
      {
        name: "the first year of the range fits",
        records: (w) => [atlasYears(w, 2018, 2020)],
        car: (w) => ({ generationId: w.atlasI, year: 2018 }),
        result: "fits",
      },
      {
        name: "the last year of the range fits",
        records: (w) => [atlasYears(w, 2018, 2020)],
        car: (w) => ({ generationId: w.atlasI, year: 2020 }),
        result: "fits",
      },
      {
        name: "the year after the range doesn't",
        records: (w) => [atlasYears(w, 2018, 2020)],
        car: (w) => ({ generationId: w.atlasI, year: 2021 }),
        result: "does_not_fit",
      },
      {
        name: "the year before the range doesn't",
        records: (w) => [atlasYears(w, 2018, 2020)],
        car: (w) => ({ generationId: w.atlasI, year: 2017 }),
        result: "does_not_fit",
      },
      {
        name: "a range without an end fits a late year",
        records: (w) => [atlasYears(w, 2023, null)],
        car: (w) => ({ generationId: w.atlasII, year: 2030 }),
        result: "fits",
      },
      {
        name: "a range without an end starts at its first year",
        records: (w) => [atlasYears(w, 2020, null)],
        car: (w) => ({ generationId: w.atlasI, year: 2019 }),
        result: "does_not_fit",
      },
      {
        name: "a range without a start ends at its last year",
        records: (w) => [atlasYears(w, null, 2019)],
        car: (w) => ({ generationId: w.atlasI, year: 2019 }),
        result: "fits",
      },
      {
        name: "an unknown year and a record with years — ask the year",
        records: (w) => [atlasYears(w, 2018, 2020)],
        car: (w) => ({ modelId: w.atlas }),
        result: "needs_details",
        missing: ["year"],
      },
      {
        name: "an unknown year: a record without years fits",
        records: (w) => [
          atlasYears(w, 2018, 2020),
          { makeId: w.geely, modelId: w.atlas, bodyTypeId: w.crossover },
        ],
        car: (w) => ({ modelId: w.atlas, bodyTypeId: w.crossover }),
        result: "fits",
      },
      {
        name: "no year, but the generation's years lie within the record's",
        records: (w) => [atlasYears(w, 2016, 2022)],
        car: (w) => ({ generationId: w.atlasI }),
        result: "fits",
      },
      {
        name: "no year, the generation's years overlap the record's — ask the year",
        records: (w) => [atlasYears(w, 2018, 2020)],
        car: (w) => ({ generationId: w.atlasI }),
        result: "needs_details",
        missing: ["year"],
      },
      {
        name: "no year, the modification's years are outside the record's",
        records: (w) => [atlasYears(w, 2023, null)],
        car: (w) => ({ modificationId: w.atlasIMod }),
        result: "does_not_fit",
      },
      {
        name: "the year of the car and of the modification: inside",
        records: (w) => [atlasYears(w, 2024, 2024)],
        car: (w) => ({ modificationId: w.atlasIIMod, year: 2024 }),
        result: "fits",
      },
      {
        name: "the year of the car and of the modification: outside",
        records: (w) => [atlasYears(w, 2024, 2024)],
        car: (w) => ({ modificationId: w.atlasIIMod, year: 2025 }),
        result: "does_not_fit",
      },
      {
        name: "the record needing the fewest levels is asked for",
        records: (w) => [
          { makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 },
          { makeId: w.geely, modelId: w.atlas, engineId: w.e4G20, transmissionTypeId: w.at },
        ],
        car: (w) => ({ generationId: w.atlasII }),
        result: "needs_details",
        missing: ["engine"],
      },
      {
        name: "two records needing as few levels — both are named",
        records: (w) => [
          { makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 },
          { makeId: w.geely, modelId: w.atlas, transmissionTypeId: w.at },
        ],
        car: (w) => ({ generationId: w.atlasII }),
        result: "needs_details",
        missing: ["engine", "transmission"],
      },
      {
        name: "a contradicting record doesn't count among the ones to ask",
        records: (w) => [
          { makeId: w.geely, modelId: w.atlas, bodyTypeId: w.sedan },
          { makeId: w.geely, modelId: w.atlas, driveTypeId: w.awd, engineId: w.e4G20 },
        ],
        car: (w) => ({ modelId: w.atlas, bodyTypeId: w.crossover }),
        result: "needs_details",
        missing: ["engine", "drive"],
      },
      {
        name: "another body contradicts",
        records: (w) => [{ makeId: w.geely, modelId: w.atlas, bodyTypeId: w.sedan }],
        car: (w) => ({ modificationId: w.atlasIIMod }),
        result: "does_not_fit",
      },
      {
        name: "the drive is missing on a car known by its model",
        records: (w) => [{ makeId: w.geely, modelId: w.coolray, driveTypeId: w.fwd }],
        car: (w) => ({ modelId: w.coolray }),
        result: "needs_details",
        missing: ["drive"],
      },
      {
        name: "a fully specified record fits the full modification",
        records: (w) => [
          {
            makeId: w.geely,
            modelId: w.coolray,
            generationId: w.coolrayI,
            bodyTypeId: w.crossover,
            engineId: w.e3G15,
            transmissionTypeId: w.dct,
            driveTypeId: w.fwd,
            yearFrom: 2020,
            yearTo: null,
          },
        ],
        car: (w) => ({ modificationId: w.coolrayMod }),
        result: "fits",
      },
      {
        name: "a fully specified record, a car with little known — every level is asked",
        records: (w) => [
          {
            makeId: w.geely,
            modelId: w.coolray,
            generationId: w.coolrayI,
            bodyTypeId: w.crossover,
            engineId: w.e3G15,
            transmissionTypeId: w.dct,
            driveTypeId: w.fwd,
            yearFrom: 2020,
            yearTo: null,
          },
        ],
        car: (w) => ({ makeId: w.geely }),
        result: "needs_details",
        missing: ["model", "generation", "body", "engine", "transmission", "drive", "year"],
      },
    ];

    it("gives every case its result and missing levels", async () => {
      const w = await world();
      const failures: string[] = [];
      for (const entry of cases) {
        const itemId = await part(w);
        for (const conditions of entry.records(w)) {
          await addRecord(itemId, conditions);
        }
        const got = await resultOf(itemId, entry.car(w));
        const expected = { result: entry.result, missing: entry.missing ?? [] };
        if (
          JSON.stringify({ result: got.result, missing: got.missing }) !== JSON.stringify(expected)
        ) {
          failures.push(`${entry.name}: got ${JSON.stringify(got)}`);
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);

    it("keeps the result of a car whose vehicle rows were archived; archived records don't count", async () => {
      const w = await world();
      const itemId = await part(w);
      await addRecord(itemId, { makeId: w.geely, generationId: w.atlasII });
      const car = { modificationId: w.atlasIIMod };
      expect((await resultOf(itemId, car)).result).toBe("fits");
      await db.query(
        "UPDATE vehicle_modification SET status = 'archived', archived_at = now() WHERE id = $1",
        [w.atlasIIMod],
      );
      await db.query(
        "UPDATE vehicle_generation SET status = 'archived', archived_at = now() WHERE id = $1",
        [w.atlasII],
      );
      await db.query(
        "UPDATE vehicle_make SET status = 'archived', archived_at = now() WHERE id = $1",
        [w.geely],
      );
      expect(await resultOf(itemId, car)).toMatchObject({ result: "fits", listed: true });
      // A record may still be written for an archived car.
      const other = await part(w);
      await addRecord(other, { makeId: w.geely, generationId: w.atlasII });
      expect((await resultOf(other, car)).result).toBe("fits");
      // An archived record stops counting.
      const record = (
        await ok(asAdmin("get", `/admin/catalog/items/${itemId}/compatibility`), (b) =>
          adminItemCompatibilityResponseSchema.parse(b),
        )
      ).records[0]!;
      await ok(
        asAdmin("post", `/admin/catalog/compatibility/${record.id}/archive`, {
          expectedVersion: record.version,
        }),
        (b) => adminCompatibilityRecordResponseSchema.parse(b),
      );
      expect((await resultOf(itemId, car)).result).toBe("not_specified");
    });
  });

  describe("the display rule (D-029)", () => {
    it("hides what doesn't fit and what isn't specified in a compulsory subcategory, only with a car", async () => {
      const w = await world();
      const fits = await part(w);
      const asks = await part(w);
      const wrong = await part(w);
      const none = await part(w);
      await addRecord(fits, { makeId: w.geely, generationId: w.atlasII });
      await addRecord(asks, { makeId: w.geely, modelId: w.atlas, engineId: w.e4G20 });
      await addRecord(wrong, { makeId: w.chery });
      const ids = [fits, asks, wrong, none];
      const withCar = await check({ itemIds: ids, vehicle: { generationId: w.atlasII } });
      expect(
        withCar.items.map((entry) => [
          entry.result,
          entry.mark,
          entry.listed,
          entry.requiresConfirmation,
          entry.compatibilityRequired,
        ]),
      ).toEqual([
        ["fits", "fits", true, false, true],
        ["needs_details", "needs_details", true, false, true],
        ["does_not_fit", "does_not_fit", false, true, true],
        ["not_specified", "not_specified", false, false, true],
      ]);
      const noCar = await check({ itemIds: ids });
      expect(noCar.vehicle).toBeNull();
      expect(noCar.items.map((entry) => [entry.result, entry.mark, entry.listed])).toEqual([
        [null, null, true],
        [null, null, true],
        [null, null, true],
        ["not_specified", "not_specified", true],
      ]);
    });

    it("shows everything of a universal subcategory but what doesn't fit; unmarked without records", async () => {
      const w = await world();
      const fits = await part(w, w.engineOils);
      const wrong = await part(w, w.engineOils);
      const none = await part(w, w.engineOils);
      await addRecord(fits, { makeId: w.geely });
      await addRecord(wrong, { makeId: w.chery });
      const ids = [fits, wrong, none];
      const withCar = await check({ itemIds: ids, vehicle: { modelId: w.atlas } });
      expect(
        withCar.items.map((entry) => [
          entry.result,
          entry.mark,
          entry.listed,
          entry.requiresConfirmation,
          entry.compatibilityRequired,
        ]),
      ).toEqual([
        ["fits", "fits", true, false, false],
        ["does_not_fit", "does_not_fit", false, true, false],
        ["not_specified", null, true, false, false],
      ]);
      const noCar = await check({ itemIds: ids });
      expect(noCar.items.map((entry) => [entry.mark, entry.listed])).toEqual([
        [null, true],
        [null, true],
        [null, true],
      ]);
    });
  });

  // ------------------------------------------------------------- records

  describe("records kept by the administrator", () => {
    it("checks the levels against the vehicle catalog, on the server and in the database", async () => {
      const w = await world();
      const itemId = await part(w);
      const refused = async (conditions: object, reason: string, field: string) => {
        const response = await asAdmin("post", `/admin/catalog/items/${itemId}/compatibility`, {
          conditions,
          evidence: "x",
        });
        expectError(response, 400, "COMPATIBILITY_CONDITIONS_INVALID");
        expect(response.body.details).toEqual({ reason, field });
      };
      await refused({ makeId: w.chery, modelId: w.atlas }, "model_of_other_make", "modelId");
      await refused(
        { makeId: w.geely, modelId: w.coolray, generationId: w.atlasII },
        "generation_of_other_model",
        "generationId",
      );
      await refused({ makeId: w.geely, yearFrom: 2020, yearTo: 2019 }, "years_order", "yearTo");
      await refused(
        { makeId: w.geely, generationId: w.atlasI, yearFrom: 2023 },
        "years_outside_generation",
        "yearFrom",
      );
      await refused({ makeId: w.geely, bodyTypeId: w.at }, "not_found", "bodyTypeId");
      await refused({ makeId: w.atlas }, "not_found", "makeId");
      await refused({ makeId: w.geely, engineId: w.geely }, "not_found", "engineId");
      expect(await count("item_compatibility")).toBe(0);
      expect(await count("audit_log", "entity_type = 'item_compatibility'")).toBe(0);

      // The model is taken from the generation.
      const record = await addRecord(itemId, { makeId: w.geely, generationId: w.atlasII });
      expect(record.conditions).toMatchObject({ modelId: w.atlas, generationId: w.atlasII });
      expect(record.label).toMatchObject({
        make: "Geely",
        model: "Atlas",
        generation: "II (FX11) (с 2023)",
      });

      // The database holds the same: a model of another make, a duplicate.
      await expect(
        db.query(
          "INSERT INTO item_compatibility (item_id, item_type, make_id, model_id, source, evidence) VALUES ($1, 'part', $2, $3, 'admin', 'x')",
          [itemId, w.chery, w.atlas],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          "INSERT INTO item_compatibility (item_id, item_type, make_id, model_id, generation_id, source, evidence) VALUES ($1, 'part', $2, $3, $4, 'admin', 'x')",
          [itemId, w.geely, w.atlas, w.atlasII],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      // A service can't take a record, even by hand.
      await expect(
        db.query(
          "INSERT INTO item_compatibility (item_id, item_type, make_id, source, evidence) VALUES ($1, 'part', $2, 'admin', 'x')",
          [w.service, w.geely],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("refuses duplicates, services and archived items", async () => {
      const w = await world();
      const itemId = await part(w);
      const first = await addRecord(itemId, { makeId: w.geely, modelId: w.atlas });
      const again = await asAdmin("post", `/admin/catalog/items/${itemId}/compatibility`, {
        conditions: { makeId: w.geely, modelId: w.atlas, generationId: null },
        evidence: "другое основание",
      });
      expectError(again, 409, "COMPATIBILITY_DUPLICATE");
      expect(again.body.details).toEqual({ existingId: first.id });
      expectError(
        await asAdmin("post", `/admin/catalog/items/${w.service}/compatibility`, {
          conditions: { makeId: w.geely },
          evidence: "x",
        }),
        409,
        "COMPATIBILITY_NOT_APPLICABLE",
      );
      const card = await ok(
        asAdmin("get", `/admin/catalog/items/${w.service}/compatibility`),
        (b) => adminItemCompatibilityResponseSchema.parse(b),
      );
      expect(card).toMatchObject({ applicable: false, records: [], proposals: [] });
      await db.query(
        "UPDATE catalog_item SET status = 'archived', archived_at = now() WHERE id = $1",
        [itemId],
      );
      expectError(
        await asAdmin("post", `/admin/catalog/items/${itemId}/compatibility`, {
          conditions: { makeId: w.chery },
          evidence: "x",
        }),
        409,
        "COMPATIBILITY_ITEM_ARCHIVED",
      );
      expectError(
        await asAdmin(
          "post",
          `/admin/catalog/items/00000000-0000-4000-8000-000000000000/compatibility`,
          {
            conditions: { makeId: w.chery },
            evidence: "x",
          },
        ),
        404,
        "NOT_FOUND",
      );
      expect(await count("item_compatibility")).toBe(1);
    });

    it("changes and archives with versions; every change is in the journal of its transaction", async () => {
      const w = await world();
      const itemId = await part(w);
      const record = await addRecord(itemId, { makeId: w.geely, modelId: w.atlas });
      const other = await addRecord(itemId, { makeId: w.geely, modelId: w.coolray });
      expect(record.version).toBe(1);
      const changed = await ok(
        asAdmin("patch", `/admin/catalog/compatibility/${record.id}`, {
          expectedVersion: 1,
          conditions: { makeId: w.geely, generationId: w.atlasII },
          evidence: "https://example.com/catalog/atlas",
        }),
        (b) => adminCompatibilityRecordResponseSchema.parse(b).record,
      );
      expect(changed).toMatchObject({
        version: 2,
        evidence: "https://example.com/catalog/atlas",
        conditions: { generationId: w.atlasII },
      });
      // A stale version changes nothing.
      const stale = await asAdmin("patch", `/admin/catalog/compatibility/${record.id}`, {
        expectedVersion: 1,
        evidence: "чужая правка",
      });
      expectError(stale, 409, "COMPATIBILITY_VERSION_CONFLICT");
      expect(stale.body.details).toEqual({ currentVersion: 2 });
      // The same as another record — refused, nothing written.
      expectError(
        await asAdmin("patch", `/admin/catalog/compatibility/${other.id}`, {
          expectedVersion: 1,
          conditions: { makeId: w.geely, generationId: w.atlasII },
        }),
        409,
        "COMPATIBILITY_DUPLICATE",
      );
      // Nothing to change — no new version, no journal entry.
      const same = await ok(
        asAdmin("patch", `/admin/catalog/compatibility/${record.id}`, {
          expectedVersion: 2,
          evidence: "https://example.com/catalog/atlas",
        }),
        (b) => adminCompatibilityRecordResponseSchema.parse(b).record,
      );
      expect(same.version).toBe(2);
      const archived = await ok(
        asAdmin("post", `/admin/catalog/compatibility/${record.id}/archive`, {
          expectedVersion: 2,
        }),
        (b) => adminCompatibilityRecordResponseSchema.parse(b).record,
      );
      expect(archived).toMatchObject({ status: "archived", version: 3 });
      expect(archived.archivedAt).not.toBeNull();
      const journal = auditLogPageSchema.parse(
        (
          await asAdmin(
            "get",
            `/admin/audit-log?entityType=item_compatibility&entityId=${record.id}`,
          )
        ).body,
      ).entries;
      expect(journal.map((entry) => entry.action).reverse()).toEqual([
        "item_compatibility.created",
        "item_compatibility.changed",
        "item_compatibility.archived",
      ]);
      expect(journal.every((entry) => entry.actor.role === "admin")).toBe(true);
      expect(journal.at(-1)!.after).toMatchObject({ itemId, source: "admin" });
      // The archived record is history: shown on request only.
      const card = await ok(asAdmin("get", `/admin/catalog/items/${itemId}/compatibility`), (b) =>
        adminItemCompatibilityResponseSchema.parse(b),
      );
      expect(card.records.map((entry) => entry.id)).toEqual([other.id]);
      const history = await ok(
        asAdmin("get", `/admin/catalog/items/${itemId}/compatibility?includeArchived=true`),
        (b) => adminItemCompatibilityResponseSchema.parse(b),
      );
      expect(history.records.map((entry) => entry.id).sort()).toEqual([record.id, other.id].sort());
      // A record with these conditions may be added again after the archive.
      await addRecord(itemId, { makeId: w.geely, generationId: w.atlasII });
    });

    it("copies the records of an analog in one action, skipping what the item already has", async () => {
      const w = await world();
      await addRecord(w.frontPads, { makeId: w.geely, generationId: w.atlasII });
      await addRecord(w.frontPads, { makeId: w.geely, modelId: w.coolray, engineId: w.e3G15 });
      // The analog already has one of them.
      await addRecord(w.trwPads, { makeId: w.geely, modelId: w.coolray, engineId: w.e3G15 });
      const copied = await ok(
        asAdmin("post", `/admin/catalog/items/${w.trwPads}/compatibility/copy`, {
          fromItemId: w.frontPads,
        }),
        (b) => copyCompatibilityResponseSchema.parse(b),
      );
      expect(copied).toMatchObject({ created: 1, alreadyPresent: 1 });
      expect(copied.records).toHaveLength(2);
      const copy = copied.records.find((entry) => entry.source === "copy")!;
      expect(copy.conditions.generationId).toBe(w.atlasII);
      expect(copy.copiedFromId).not.toBeNull();
      // Again: nothing new.
      expect(
        await ok(
          asAdmin("post", `/admin/catalog/items/${w.trwPads}/compatibility/copy`, {
            fromItemId: w.frontPads,
          }),
          (b) => copyCompatibilityResponseSchema.parse(b),
        ),
      ).toMatchObject({ created: 0, alreadyPresent: 2 });
      // The analog gives the same result as the original.
      for (const car of [{ modificationId: w.atlasIIMod }, { modificationId: w.atlasIMod }]) {
        const response = await check({ itemIds: [w.frontPads, w.trwPads], vehicle: car });
        expect(response.items[0]!.result).toBe(response.items[1]!.result);
      }
      // Only from an analog.
      const stranger = await part(w);
      expectError(
        await asAdmin("post", `/admin/catalog/items/${stranger}/compatibility/copy`, {
          fromItemId: w.frontPads,
        }),
        409,
        "COMPATIBILITY_NOT_ANALOG",
      );
      expect(
        await count(
          "audit_log",
          "action = 'item_compatibility.created' AND after->>'source' = 'copy'",
        ),
      ).toBe(1);
    });
  });

  // ----------------------------------------------------------- proposals

  describe("proposals of suppliers and their moderation", () => {
    it("changes nothing until approved; the supplier sees only its own, with the reason of a rejection", async () => {
      const w = await world();
      const first = await cabinet("Автомаркет", MEMBER_PHONE);
      const second = await cabinet("Запчасти+", OTHER_MEMBER_PHONE);
      const car = { modificationId: w.atlasIIMod };
      expect((await resultOf(w.rearPads, car)).result).toBe("not_specified");

      const proposed = await ok(
        asSupplier(
          first.token,
          "post",
          `/supplier/catalog/items/${w.rearPads}/compatibility-proposals`,
          {
            conditions: { makeId: w.geely, generationId: w.atlasII },
            evidence: "Каталог TecDoc, стр. 12",
          },
        ),
        (b) => supplierCompatibilityProposalResponseSchema.parse(b).proposal,
        201,
      );
      expect(proposed).toMatchObject({ status: "pending", resolution: null });
      // Still nothing for users.
      expect(await resultOf(w.rearPads, car)).toMatchObject({
        result: "not_specified",
        listed: false,
      });
      // Only the own company sees it.
      const own = await ok(
        asSupplier(first.token, "get", "/supplier/compatibility-proposals"),
        (b) => supplierCompatibilityProposalPageSchema.parse(b),
      );
      expect(own.proposals.map((entry) => entry.id)).toEqual([proposed.id]);
      const foreign = await ok(
        asSupplier(second.token, "get", "/supplier/compatibility-proposals"),
        (b) => supplierCompatibilityProposalPageSchema.parse(b),
      );
      expect(foreign).toMatchObject({ proposals: [], total: 0 });
      expectError(
        await asSupplier(second.token, "get", `/supplier/compatibility-proposals/${proposed.id}`),
        404,
        "NOT_FOUND",
      );
      // A supplier can't approve its own proposal.
      expectError(
        await asSupplier(
          first.token,
          "post",
          `/admin/compatibility-proposals/${proposed.id}/approve`,
          {},
        ),
        403,
        "FORBIDDEN",
      );

      // The queue: item, company, grounds.
      const queue = await ok(asAdmin("get", "/admin/compatibility-proposals"), (b) =>
        adminCompatibilityProposalPageSchema.parse(b),
      );
      expect(queue.total).toBe(1);
      expect(queue.proposals[0]).toMatchObject({
        id: proposed.id,
        item: {
          id: w.rearPads,
          article: "4050068800",
          brand: "Geely",
          name: "Колодки тормозные задние",
        },
        supplier: { id: first.supplierId, name: "Автомаркет" },
        evidence: "Каталог TecDoc, стр. 12",
        matchesRecordId: null,
      });
      const approved = await ok(
        asAdmin("post", `/admin/compatibility-proposals/${proposed.id}/approve`, {}),
        (b) => adminCompatibilityProposalResponseSchema.parse(b),
      );
      expect(approved.proposal).toMatchObject({ status: "approved", resolution: "created" });
      expect(approved.record).toMatchObject({ source: "supplier", proposalId: proposed.id });
      expect(await resultOf(w.rearPads, car)).toMatchObject({ result: "fits", listed: true });
      // Reviewed once.
      expectError(
        await asAdmin("post", `/admin/compatibility-proposals/${proposed.id}/reject`, {
          reason: "поздно",
        }),
        409,
        "COMPATIBILITY_PROPOSAL_STATE",
      );

      // A second proposal, rejected with a reason the supplier sees.
      const doubtful = await ok(
        asSupplier(
          first.token,
          "post",
          `/supplier/catalog/items/${w.rearPads}/compatibility-proposals`,
          {
            conditions: { makeId: w.chery },
            evidence: "по памяти",
          },
        ),
        (b) => supplierCompatibilityProposalResponseSchema.parse(b).proposal,
        201,
      );
      await ok(
        asAdmin("post", `/admin/compatibility-proposals/${doubtful.id}/reject`, {
          reason: "Нет подтверждения в каталоге производителя",
        }),
        (b) => adminCompatibilityProposalResponseSchema.parse(b),
      );
      const seen = await ok(
        asSupplier(first.token, "get", `/supplier/compatibility-proposals/${doubtful.id}`),
        (b) => supplierCompatibilityProposalResponseSchema.parse(b).proposal,
      );
      expect(seen).toMatchObject({
        status: "rejected",
        rejectionReason: "Нет подтверждения в каталоге производителя",
      });
      expect((await resultOf(w.rearPads, { modificationId: w.coolrayMod })).result).toBe(
        "does_not_fit",
      );
      const rejected = await ok(
        asSupplier(first.token, "get", "/supplier/compatibility-proposals?status=rejected"),
        (b) => supplierCompatibilityProposalPageSchema.parse(b),
      );
      expect(rejected.proposals.map((entry) => entry.id)).toEqual([doubtful.id]);
      // The journal: created by the supplier, reviewed by the administrator.
      const journal = auditLogPageSchema.parse(
        (await asAdmin("get", "/admin/audit-log?entityType=item_compatibility_proposal")).body,
      ).entries;
      expect(journal.map((entry) => [entry.action, entry.actor.role]).reverse()).toEqual([
        ["item_compatibility_proposal.created", "supplier"],
        ["item_compatibility_proposal.approved", "admin"],
        ["item_compatibility_proposal.created", "supplier"],
        ["item_compatibility_proposal.rejected", "admin"],
      ]);
      expect(journal[0]!.reason).toBe("Нет подтверждения в каталоге производителя");
    });

    it("approves with corrections; equal proposals of two suppliers make one record", async () => {
      const w = await world();
      const first = await cabinet("Автомаркет", MEMBER_PHONE);
      const second = await cabinet("Запчасти+", OTHER_MEMBER_PHONE);
      const propose = (bearer: string, conditions: object) =>
        ok(
          asSupplier(
            bearer,
            "post",
            `/supplier/catalog/items/${w.rearPads}/compatibility-proposals`,
            {
              conditions,
              evidence: "каталог",
            },
          ),
          (b) => supplierCompatibilityProposalResponseSchema.parse(b).proposal,
          201,
        );
      const coarse = await propose(first.token, { makeId: w.geely, modelId: w.atlas });
      const corrected = await ok(
        asAdmin("post", `/admin/compatibility-proposals/${coarse.id}/approve`, {
          conditions: { makeId: w.geely, generationId: w.atlasII },
          evidence: "Уточнено по каталогу Geely",
        }),
        (b) => adminCompatibilityProposalResponseSchema.parse(b),
      );
      expect(corrected.proposal).toMatchObject({
        approvedWithChanges: true,
        resolution: "created",
      });
      expect(corrected.record).toMatchObject({
        conditions: { generationId: w.atlasII },
        evidence: "Уточнено по каталогу Geely",
      });

      const a = await propose(first.token, { makeId: w.geely, modelId: w.coolray });
      const b = await propose(second.token, { makeId: w.geely, modelId: w.coolray });
      // The same company can't wait on the same proposal twice.
      expectError(
        await asSupplier(
          first.token,
          "post",
          `/supplier/catalog/items/${w.rearPads}/compatibility-proposals`,
          {
            conditions: { makeId: w.geely, modelId: w.coolray },
            evidence: "ещё раз",
          },
        ),
        409,
        "COMPATIBILITY_PROPOSAL_DUPLICATE",
      );
      await ok(asAdmin("post", `/admin/compatibility-proposals/${a.id}/approve`, {}), (body) =>
        adminCompatibilityProposalResponseSchema.parse(body),
      );
      const queue = await ok(
        asAdmin("get", `/admin/compatibility-proposals?itemId=${w.rearPads}`),
        (body) => adminCompatibilityProposalPageSchema.parse(body),
      );
      expect(queue.proposals.map((entry) => entry.id)).toEqual([b.id]);
      const records = await count("item_compatibility", `item_id = '${w.rearPads}'`);
      expect(queue.proposals[0]!.matchesRecordId).not.toBeNull();
      const same = await ok(
        asAdmin("post", `/admin/compatibility-proposals/${b.id}/approve`, {}),
        (body) => adminCompatibilityProposalResponseSchema.parse(body),
      );
      expect(same.proposal).toMatchObject({
        resolution: "already_approved",
        recordId: queue.proposals[0]!.matchesRecordId,
      });
      expect(await count("item_compatibility", `item_id = '${w.rearPads}'`)).toBe(records);

      // A proposal equal to an approved record is marked from the start.
      const late = await propose(second.token, { makeId: w.geely, generationId: w.atlasII });
      const marked = await ok(asAdmin("get", "/admin/compatibility-proposals"), (body) =>
        adminCompatibilityProposalPageSchema.parse(body),
      );
      expect(marked.proposals.find((entry) => entry.id === late.id)!.matchesRecordId).toBe(
        corrected.record!.id,
      );
      // The item's card lists what waits.
      const card = await ok(
        asAdmin("get", `/admin/catalog/items/${w.rearPads}/compatibility`),
        (body) => adminItemCompatibilityResponseSchema.parse(body),
      );
      expect(card.proposals.map((entry) => entry.id)).toEqual([late.id]);
    });

    it("takes proposals for active goods only; limits their number per company", async () => {
      const w = await world();
      const first = await cabinet("Автомаркет", MEMBER_PHONE);
      const to = (itemId: string, conditions: object = { makeId: w.geely }) =>
        asSupplier(
          first.token,
          "post",
          `/supplier/catalog/items/${itemId}/compatibility-proposals`,
          {
            conditions,
            evidence: "каталог",
          },
        );
      expectError(await to(w.service), 409, "COMPATIBILITY_NOT_APPLICABLE");
      const archived = await part(w);
      await db.query(
        "UPDATE catalog_item SET status = 'archived', archived_at = now() WHERE id = $1",
        [archived],
      );
      expectError(await to(archived), 404, "NOT_FOUND");
      const draft = await part(w);
      await db.query("UPDATE catalog_item SET status = 'draft' WHERE id = $1", [draft]);
      expectError(await to(draft), 404, "NOT_FOUND");
      expectError(await to("00000000-0000-4000-8000-000000000000"), 404, "NOT_FOUND");
      expectError(
        await to(w.rearPads, { makeId: w.chery, modelId: w.atlas }),
        400,
        "COMPATIBILITY_CONDITIONS_INVALID",
      );

      await settings.set({ compatibility_proposals_per_supplier_day: 2 });
      expect((await to(w.rearPads, { makeId: w.geely })).status).toBe(201);
      expect((await to(w.rearPads, { makeId: w.chery })).status).toBe(201);
      const third = await to(w.frontPads, { makeId: w.geely });
      expectError(third, 429, "RATE_LIMITED");
      const details = rateLimitedDetailsSchema.parse(third.body.details);
      expect(details.limit).toBe("compatibility_proposals_per_supplier");
      expect(details.retryAfterSeconds).toBeGreaterThan(86_000);
      expect(third.headers["retry-after"]).toBe(String(details.retryAfterSeconds));
      // Another company has its own limit.
      const second = await cabinet("Запчасти+", OTHER_MEMBER_PHONE);
      expect(
        (
          await asSupplier(
            second.token,
            "post",
            `/supplier/catalog/items/${w.frontPads}/compatibility-proposals`,
            {
              conditions: { makeId: w.geely },
              evidence: "каталог",
            },
          )
        ).status,
      ).toBe(201);
    });
  });

  // ---------------------------------------------------------- the check

  describe("the client check", () => {
    it("answers guests and every session alike; hidden items are not found alike", async () => {
      const w = await world();
      const itemId = await part(w);
      await addRecord(itemId, { makeId: w.geely, generationId: w.atlasII });
      const draft = await part(w);
      await db.query("UPDATE catalog_item SET status = 'draft' WHERE id = $1", [draft]);
      const archived = await part(w);
      await db.query(
        "UPDATE catalog_item SET status = 'archived', archived_at = now() WHERE id = $1",
        [archived],
      );
      const missing = "00000000-0000-4000-8000-000000000000";
      const body = {
        itemIds: [itemId, draft, archived, missing, itemId],
        vehicle: { modificationId: w.atlasIIMod },
      };
      const guest = await check(body);
      expect(guest.items.map((entry) => [entry.itemId, entry.result])).toEqual([[itemId, "fits"]]);
      expect(guest.notFound).toEqual([draft, archived, missing]);
      expect(guest.vehicle).toMatchObject({
        modificationId: w.atlasIIMod,
        makeId: w.geely,
        modelId: w.atlas,
        generationId: w.atlasII,
        engineId: w.e4G20,
        yearFrom: 2024,
        yearTo: null,
      });
      for (const [bearer, client] of [
        [await mobileToken(), IOS],
        [(await cabinet("Автомаркет", MEMBER_PHONE)).token, SUPPLIER_WEB],
        [token, ADMIN_WEB],
      ] as const) {
        const response = await checkRequest(body, bearer, client);
        expect(response.status).toBe(200);
        expect(compatibilityCheckResponseSchema.parse(response.body)).toEqual(guest);
      }
      // A whole subcategory at once; a hidden one is not found.
      const category = await check({
        categoryId: w.brakePads,
        vehicle: { generationId: w.atlasII },
      });
      expect(category.items.map((entry) => entry.itemId)).toContain(itemId);
      expect(category.items.map((entry) => entry.itemId)).not.toContain(draft);
      await db.query("UPDATE category SET status = 'hidden' WHERE id = $1", [w.brakePads]);
      expectError(await checkRequest({ categoryId: w.brakePads }), 404, "NOT_FOUND");
      expect((await check({ itemIds: [itemId] })).notFound).toEqual([itemId]);
    });

    it("explains a car that doesn't hold together and a request that names both or neither", async () => {
      const w = await world();
      const itemId = await part(w);
      const refused = async (vehicle: object, reason: string, field: string) => {
        const response = await checkRequest({ itemIds: [itemId], vehicle });
        expectError(response, 400, "COMPATIBILITY_VEHICLE_INVALID");
        expect(response.body.details).toEqual({ reason, field });
      };
      await refused({ makeId: w.chery, modelId: w.atlas }, "model_of_other_make", "modelId");
      await refused(
        { modelId: w.coolray, generationId: w.atlasII },
        "generation_of_other_model",
        "generationId",
      );
      await refused(
        { modificationId: w.atlasIIMod, generationId: w.atlasI },
        "modification_mismatch",
        "generationId",
      );
      await refused(
        { modificationId: w.atlasIIMod, engineId: w.e3G15 },
        "modification_mismatch",
        "engineId",
      );
      await refused({ engineId: w.e3G15 }, "make_required", "makeId");
      await refused({ generationId: w.atlasI, year: 2023 }, "year_outside", "year");
      await refused({ modificationId: w.atlasIMod, year: 2016 }, "year_outside", "year");
      await refused({ makeId: w.geely, bodyTypeId: w.at }, "not_found", "bodyTypeId");
      await refused({ modelId: w.geely }, "not_found", "modelId");
      expectError(
        await checkRequest({ itemIds: [itemId], categoryId: w.brakePads }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(await checkRequest({ vehicle: { makeId: w.geely } }), 400, "VALIDATION_ERROR");
      expectError(await checkRequest({ itemIds: ["not-a-uuid"] }), 400, "VALIDATION_ERROR");
    });

    it("computes thousands of items in one statement", async () => {
      const w = await world();
      const ITEMS = 5000;
      const RECORDS_PER_ITEM = 4;
      // Items and records written directly: a subcategory of 5 000 parts,
      // 4 records each (Atlas; Atlas II; Atlas with an engine; Coolray
      // with years).
      await db.query(
        `INSERT INTO catalog_item (item_type, category_id, category_kind, category_level, brand_id, article, article_norm)
         SELECT 'part', $1, 'goods', 2, $2, 'PERF-' || n, 'PERF' || n FROM generate_series(1, $3) AS n`,
        [w.brakePads, w.trw, ITEMS],
      );
      await db.query(
        `INSERT INTO item_compatibility (item_id, item_type, make_id, model_id, generation_id, engine_id, year_from, year_to, source, evidence)
         SELECT i.id, 'part', $1,
           CASE WHEN r < 3 THEN $2::uuid ELSE $3::uuid END,
           CASE WHEN r = 1 THEN $4::uuid END,
           CASE WHEN r = 2 THEN $5::uuid END,
           CASE WHEN r = 3 THEN 2016 + (hashtext(i.id::text) & 7) END,
           CASE WHEN r = 3 THEN 2024 END,
           'admin', 'perf'
         FROM catalog_item i CROSS JOIN generate_series(0, $6 - 1) AS r
         WHERE i.article LIKE 'PERF-%'`,
        [w.geely, w.atlas, w.coolray, w.atlasII, w.e4G20, RECORDS_PER_ITEM],
      );
      await db.query("ANALYZE item_compatibility; ANALYZE catalog_item");
      expect(await count("item_compatibility")).toBe(ITEMS * RECORDS_PER_ITEM);

      // One statement for the whole subcategory, whatever its size.
      const database = app.get(DatabaseService).db;
      let statements = 0;
      const counting = new Proxy(database, {
        get(target, property, receiver) {
          if (property === "execute") {
            return (...args: Parameters<typeof database.execute>) => {
              statements += 1;
              return target.execute(...args);
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }) as DbExecutor;
      const evaluator = app.get(CompatibilityEvaluator);
      const vehicle = compatibilityCheckResponseSchema.parse(
        (await checkRequest({ itemIds: [w.frontPads], vehicle: { generationId: w.atlasII } })).body,
      ).vehicle;
      const timings: number[] = [];
      let results: CompatibilityItemResult[] = [];
      for (let run = 0; run < 5; run++) {
        const started = performance.now();
        results = await evaluator.evaluate(
          vehicle,
          { kind: "category", categoryId: w.brakePads },
          counting,
        );
        timings.push(performance.now() - started);
      }
      expect(statements).toBe(5);
      expect(results.length).toBeGreaterThanOrEqual(ITEMS);
      const perf = results.filter(
        (entry) => entry.hasCompatibility && entry.itemId !== w.frontPads,
      );
      expect(new Set(perf.map((entry) => entry.result))).toEqual(new Set(["fits"]));

      const started = performance.now();
      const overHttp = await check({ categoryId: w.brakePads, vehicle: { modelId: w.atlas } });
      const httpMs = performance.now() - started;
      expect(overHttp.items.length).toBeGreaterThanOrEqual(ITEMS);
      const byIds = performance.now();
      await check({
        itemIds: overHttp.items.slice(0, 500).map((entry) => entry.itemId),
        vehicle: { modificationId: w.atlasIMod },
      });
      const idsMs = performance.now() - byIds;
      const sorted = [...timings].sort((a, b) => a - b);
      const median = sorted[2]!;
      process.stdout.write(
        `COMPATIBILITY PERF items=${String(ITEMS)} records=${String(ITEMS * RECORDS_PER_ITEM)} evaluate_ms=${timings.map((t) => t.toFixed(1)).join(",")} median_ms=${median.toFixed(1)} http_category_ms=${httpMs.toFixed(1)} http_500_ids_ms=${idsMs.toFixed(1)}\n`,
      );
      expect(median).toBeLessThan(2000);
    }, 120_000);
  });

  // ------------------------------------------------------ access matrix

  describe("access", () => {
    it("serves the admin routes to the admin context and proposals to the cabinet only", async () => {
      const w = await world();
      const mobile = await mobileToken();
      const { token: supplier } = await cabinet("Автомаркет", MEMBER_PHONE);
      const record = await addRecord(w.frontPads, { makeId: w.geely });
      const proposal = await ok(
        asSupplier(
          supplier,
          "post",
          `/supplier/catalog/items/${w.rearPads}/compatibility-proposals`,
          {
            conditions: { makeId: w.geely },
            evidence: "каталог",
          },
        ),
        (b) => supplierCompatibilityProposalResponseSchema.parse(b).proposal,
        201,
      );
      const admin: [Method, string, object?][] = [
        ["get", `/admin/catalog/items/${w.frontPads}/compatibility`],
        [
          "post",
          `/admin/catalog/items/${w.frontPads}/compatibility`,
          { conditions: { makeId: w.chery }, evidence: "x" },
        ],
        [
          "post",
          `/admin/catalog/items/${w.trwPads}/compatibility/copy`,
          { fromItemId: w.frontPads },
        ],
        [
          "patch",
          `/admin/catalog/compatibility/${record.id}`,
          { expectedVersion: 1, evidence: "y" },
        ],
        ["post", `/admin/catalog/compatibility/${record.id}/archive`, { expectedVersion: 1 }],
        ["get", "/admin/compatibility-proposals"],
        ["post", `/admin/compatibility-proposals/${proposal.id}/approve`, {}],
        ["post", `/admin/compatibility-proposals/${proposal.id}/reject`, { reason: "нет" }],
      ];
      const cabinetRoutes: [Method, string, object?][] = [
        [
          "post",
          `/supplier/catalog/items/${w.frontPads}/compatibility-proposals`,
          { conditions: { makeId: w.geely }, evidence: "x" },
        ],
        ["get", "/supplier/compatibility-proposals"],
        ["get", `/supplier/compatibility-proposals/${proposal.id}`],
      ];
      for (const [method, path, body] of admin) {
        expectError(await call(mobile, IOS, method, path, body), 403, "FORBIDDEN");
        expectError(await call(supplier, SUPPLIER_WEB, method, path, body), 403, "FORBIDDEN");
        const guest = http()[method](path).set("X-Client", IOS);
        expectError(await (body ? guest.send(body) : guest), 401, "AUTH_REQUIRED");
      }
      for (const [method, path, body] of cabinetRoutes) {
        expectError(await call(mobile, IOS, method, path, body), 403, "FORBIDDEN");
        expectError(await call(token, ADMIN_WEB, method, path, body), 403, "FORBIDDEN");
        const guest = http()[method](path).set("X-Client", IOS);
        expectError(await (body ? guest.send(body) : guest), 401, "AUTH_REQUIRED");
      }
      // Nothing of it changed anything.
      expect(await count("item_compatibility")).toBe(1);
      expect(await count("item_compatibility_proposal")).toBe(1);
      expect(await count("item_compatibility_proposal", "status = 'pending'")).toBe(1);
    });
  });

  // ----------------------------------------------------------- dev seed

  describe("the development seed", () => {
    it("fills the examples once and gives the scenarios of the task", async () => {
      await app.get(DevCatalogSeed).run();
      await app.get(DevVehicleSeed).run();
      const first = await app.get(DevCompatibilitySeed).run();
      expect(first).toEqual({ created: { records: 3 }, existing: { records: 0 } });
      await app.get(DevCatalogSeed).run();
      await app.get(DevVehicleSeed).run();
      const second = await app.get(DevCompatibilitySeed).run();
      expect(second).toEqual({ created: { records: 0 }, existing: { records: 3 } });
      expect(await count("item_compatibility")).toBe(3);
      const w = await world();

      // Geely front pads — Atlas II: fits with the engine known; Atlas I — hidden, warned.
      expect(
        await resultOf(w.frontPads, { generationId: w.atlasII, engineId: w.e4G20 }),
      ).toMatchObject({
        result: "fits",
        listed: true,
      });
      expect(await resultOf(w.frontPads, { modificationId: w.atlasIMod })).toMatchObject({
        result: "does_not_fit",
        listed: false,
        requiresConfirmation: true,
      });
      // The analog, copied, gives the same.
      expect(
        await resultOf(w.trwPads, { generationId: w.atlasII, engineId: w.e4G20 }),
      ).toMatchObject({
        result: "fits",
      });
      // The oil needs the engine of a Coolray.
      expect(await resultOf(w.oil, { modelId: w.coolray })).toMatchObject({
        result: "needs_details",
        missing: ["engine"],
        listed: true,
        mark: "needs_details",
      });
      // Rear pads: no records in a compulsory subcategory.
      expect(await resultOf(w.rearPads, { modificationId: w.atlasIIMod })).toMatchObject({
        result: "not_specified",
        listed: false,
      });
      expect(await resultOf(w.rearPads, null)).toMatchObject({
        result: "not_specified",
        mark: "not_specified",
        listed: true,
      });
    });
  });
});
