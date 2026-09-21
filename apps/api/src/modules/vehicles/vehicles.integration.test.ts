import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminVehicleEngineResponseSchema,
  adminVehicleGenerationPageSchema,
  adminVehicleGenerationResponseSchema,
  adminVehicleImportResponseSchema,
  adminVehicleMakePageSchema,
  adminVehicleMakeResponseSchema,
  adminVehicleModelPageSchema,
  adminVehicleModelResponseSchema,
  adminVehicleModificationPageSchema,
  adminVehicleModificationResponseSchema,
  adminVehicleOptionListResponseSchema,
  adminVehicleOptionResponseSchema,
  apiErrorResponseSchema,
  apiRoutes,
  auditLogPageSchema,
  isUploadRoute,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  vehicleDuplicateDetailsSchema,
  vehicleGenerationsResponseSchema,
  vehicleImportFileInvalidDetailsSchema,
  vehicleImportRowsPageSchema,
  vehicleImportTemplateResponseSchema,
  vehicleMakesResponseSchema,
  vehicleModelsResponseSchema,
  vehicleModificationsResponseSchema,
  vehicleYearsInvalidDetailsSchema,
  type AdminVehicleImport,
  type AdminVehicleMakePage,
  type AdminVehicleModificationPage,
  type AdminVehicleOption,
  type ApiRouteDefinition,
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
import { runMigrate } from "../../database/migrate-cli";
import { configureHttpApp } from "../../http-app";
import type { JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { DevVehicleSeed, DevVehicleSeedError, VehicleImportAnalyzer, VehicleImportExpiry } from ".";
import type { SettingValues } from "../settings";

/**
 * TASK-014 end to end on a real PostgreSQL (and Redis for sessions): the
 * rules of the vehicle catalog held by the server and by the database
 * (years, uniqueness, archiving), keeping it by an administrator with
 * versions and the action journal, paging without gaps, imports from a
 * file with a report before anything changes (the check and the
 * application run in a real worker), the client routes for choosing a car
 * step by step, the access matrix and the development seed.
 */

const ADMIN_PHONE = "+77011234567";
const SECOND_ADMIN_PHONE = "+77011234568";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77051234000";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

const FIXTURES = join(__dirname, "../../../fixtures/vehicles");

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

const HEADER =
  "make,model,generation,generation_year_from,generation_year_to,body,engine_code,engine_displacement_l,engine_fuel,engine_power_hp,transmission,drive,year_from,year_to,market";

describe("vehicle catalog (PostgreSQL + Redis)", () => {
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
    await Promise.all([settings.reload(), new TestSettings(app).reload()]);
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

  // ------------------------------------------------------------ builders

  async function option(
    kind: string,
    code: string,
    names: { ru: string; kk?: string | null; en?: string | null },
  ): Promise<AdminVehicleOption> {
    return ok(
      asAdmin("post", "/admin/vehicles/options", { kind, code, names }),
      (body) => adminVehicleOptionResponseSchema.parse(body).option,
      201,
    );
  }

  const makeOf = (name: string, aliases: string[] = []) =>
    ok(
      asAdmin("post", "/admin/vehicles/makes", { name, aliases }),
      (body) => adminVehicleMakeResponseSchema.parse(body).make,
      201,
    );

  const modelOf = (makeId: string, name: string, aliases: string[] = []) =>
    ok(
      asAdmin("post", "/admin/vehicles/models", { makeId, name, aliases }),
      (body) => adminVehicleModelResponseSchema.parse(body).model,
      201,
    );

  const generationOf = (modelId: string, name: string, yearFrom: number, yearTo: number | null) =>
    ok(
      asAdmin("post", "/admin/vehicles/generations", { modelId, name, yearFrom, yearTo }),
      (body) => adminVehicleGenerationResponseSchema.parse(body).generation,
      201,
    );

  /** A small catalog: options, Geely Coolray I with one engine. */
  async function basics() {
    const sedan = await option("body", "sedan", { ru: "Седан", kk: "Седан", en: "Sedan" });
    const crossover = await option("body", "crossover", {
      ru: "Кроссовер",
      kk: "Кроссовер",
      en: "Crossover",
    });
    const dct = await option("transmission", "dct", {
      ru: "Робот",
      kk: "Робот беріліс",
      en: "Dual-clutch",
    });
    const at = await option("transmission", "at", { ru: "Автомат", kk: null, en: "Automatic" });
    const fwd = await option("drive", "fwd", { ru: "Передний", kk: "Алдыңғы", en: "Front" });
    const awd = await option("drive", "awd", { ru: "Полный", kk: "Толық", en: "All-wheel" });
    const petrol = await option("fuel", "petrol", { ru: "Бензин", kk: "Бензин", en: "Petrol" });
    const geely = await makeOf("Geely", ["Джили"]);
    const coolray = await modelOf(geely.id, "Coolray");
    const coolrayI = await generationOf(coolray.id, "I (SX11)", 2019, null);
    const engine = await ok(
      asAdmin("post", "/admin/vehicles/engines", {
        code: "JLH-3G15TD",
        aliases: ["3G15TD"],
        displacementL: 1.5,
        fuelId: petrol.id,
        powerHp: 177,
      }),
      (body) => adminVehicleEngineResponseSchema.parse(body).engine,
      201,
    );
    return { sedan, crossover, dct, at, fwd, awd, petrol, geely, coolray, coolrayI, engine };
  }

  type Basics = Awaited<ReturnType<typeof basics>>;

  function modificationBody(b: Basics, extra: Record<string, unknown> = {}) {
    return {
      generationId: b.coolrayI.id,
      bodyTypeId: b.crossover.id,
      engineId: b.engine.id,
      transmissionTypeId: b.dct.id,
      driveTypeId: b.fwd.id,
      yearFrom: 2020,
      yearTo: null,
      market: "kz",
      ...extra,
    };
  }

  const createModification = (b: Basics, extra: Record<string, unknown> = {}) =>
    asAdmin("post", "/admin/vehicles/modifications", modificationBody(b, extra));

  async function modification(b: Basics, extra: Record<string, unknown> = {}) {
    return ok(
      createModification(b, extra),
      (body) => adminVehicleModificationResponseSchema.parse(body).modification,
      201,
    );
  }

  // --------------------------------------------------------------- import

  function upload(bytes: Buffer, type = "text/csv", query = ""): Test {
    return http()
      .post(`/admin/vehicles/imports${query}`)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", type)
      .send(bytes);
  }

  async function uploaded(bytes: Buffer, query = ""): Promise<AdminVehicleImport> {
    return ok(
      upload(bytes, "text/csv", query),
      (body) => adminVehicleImportResponseSchema.parse(body).import,
      201,
    );
  }

  async function importState(importId: string): Promise<AdminVehicleImport> {
    return ok(
      asAdmin("get", `/admin/vehicles/imports/${importId}`),
      (body) => adminVehicleImportResponseSchema.parse(body).import,
    );
  }

  /** Waits for the worker to move an import out of `from`. */
  async function settled(
    importId: string,
    from: readonly string[] = ["parsing", "applying"],
    timeoutMs = 60_000,
  ): Promise<AdminVehicleImport> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await importState(importId);
      if (!from.includes(current.status)) {
        return current;
      }
      if (Date.now() > deadline) {
        throw new Error(`Import ${importId} is still ${current.status}`);
      }
      await sleep(250);
    }
  }

  async function checkedFile(bytes: Buffer): Promise<AdminVehicleImport> {
    const created = await uploaded(bytes);
    expect(created.status).toBe("parsing");
    return settled(created.id);
  }

  async function applied(importId: string): Promise<AdminVehicleImport> {
    const started = await ok(
      asAdmin("post", `/admin/vehicles/imports/${importId}/apply`),
      (body) => adminVehicleImportResponseSchema.parse(body).import,
    );
    expect(started.status).toBe("applying");
    return settled(importId);
  }

  /** A setting for the worker and the API alike, in effect at once in both. */
  async function setEverywhere(values: Partial<SettingValues>): Promise<void> {
    await settings.set(values);
    await new TestSettings(app).reload();
  }

  const fixture = (name: string) => readFileSync(join(FIXTURES, name));

  const csv = (...rows: string[]) => Buffer.from([HEADER, ...rows].join("\r\n"), "utf8");

  // ================================================================ tests

  describe("the model and its rules (AC-1)", () => {
    it("keeps the years in order and a modification's years within its generation, on the server and in the database", async () => {
      const b = await basics();
      expectError(
        await asAdmin("post", "/admin/vehicles/generations", {
          modelId: b.coolray.id,
          name: "II",
          yearFrom: 2024,
          yearTo: 2023,
        }),
        400,
        "VEHICLE_YEARS_INVALID",
      );
      const atlas = await generationOf(b.coolray.id, "Old", 2010, 2015);
      const outside = await createModification(b, {
        generationId: atlas.id,
        yearFrom: 2012,
        yearTo: null,
      });
      expectError(outside, 400, "VEHICLE_YEARS_INVALID");
      expect(vehicleYearsInvalidDetailsSchema.parse(outside.body.details)).toMatchObject({
        reason: "outside_generation",
        generationYears: { from: 2010, to: 2015 },
      });
      const inside = await modification(b, {
        generationId: atlas.id,
        yearFrom: 2011,
        yearTo: 2014,
      });
      // Narrowing the generation would leave the modification out.
      const narrowed = await asAdmin("patch", `/admin/vehicles/generations/${atlas.id}`, {
        expectedVersion: atlas.version,
        yearTo: 2013,
      });
      expectError(narrowed, 400, "VEHICLE_YEARS_INVALID");
      expect(vehicleYearsInvalidDetailsSchema.parse(narrowed.body.details)).toMatchObject({
        reason: "modifications_outside",
        modificationIds: [inside.id],
      });
      // The database refuses the same, whatever writes it.
      await expect(
        db.query("UPDATE vehicle_generation SET year_to = 2012 WHERE id = $1", [atlas.id]),
      ).rejects.toThrow(/leave out/);
      await expect(
        db.query("UPDATE vehicle_modification SET year_to = NULL WHERE id = $1", [inside.id]),
      ).rejects.toThrow(/outside generation/);
      await expect(
        db.query("UPDATE vehicle_generation SET year_to = 2000 WHERE id = $1", [b.coolrayI.id]),
      ).rejects.toThrow(/vehicle_generation_years_check/);
      // A modification still made in a generation still made.
      const open = await modification(b);
      expect(open).toMatchObject({ yearFrom: 2020, yearTo: null, visibleToClients: true });
    });

    it("holds uniqueness of makes, models, generations, engines, options and modifications, with a link to the existing record", async () => {
      const b = await basics();
      const upper = await asAdmin("post", "/admin/vehicles/makes", { name: "GEELY" });
      expectError(upper, 409, "VEHICLE_DUPLICATE");
      expect(vehicleDuplicateDetailsSchema.parse(upper.body.details)).toMatchObject({
        entity: "make",
        existingId: b.geely.id,
      });
      expectError(
        await asAdmin("post", "/admin/vehicles/makes", { name: "Chery", aliases: ["джили"] }),
        409,
        "VEHICLE_DUPLICATE",
      );
      expectError(
        await asAdmin("post", "/admin/vehicles/models", { makeId: b.geely.id, name: "cool ray" }),
        409,
        "VEHICLE_DUPLICATE",
      );
      const chery = await makeOf("Chery");
      await modelOf(chery.id, "Coolray"); // another make — another model
      expectError(
        await asAdmin("post", "/admin/vehicles/generations", {
          modelId: b.coolray.id,
          name: "i (sx11)",
          yearFrom: 2019,
        }),
        409,
        "VEHICLE_DUPLICATE",
      );
      expectError(
        await asAdmin("post", "/admin/vehicles/engines", { code: "3g15 td", fuelId: b.petrol.id }),
        409,
        "VEHICLE_DUPLICATE",
      );
      expectError(
        await asAdmin("post", "/admin/vehicles/options", {
          kind: "body",
          code: "saloon",
          names: { ru: "седан" },
        }),
        409,
        "VEHICLE_DUPLICATE",
      );
      const first = await modification(b);
      const second = await createModification(b, { market: "global" });
      expectError(second, 409, "VEHICLE_DUPLICATE");
      expect(vehicleDuplicateDetailsSchema.parse(second.body.details)).toMatchObject({
        entity: "modification",
        existingId: first.id,
      });
      // Two open-ended ones are equal in the database too.
      await expect(
        db.query(
          `INSERT INTO vehicle_modification (generation_id, body_type_id, engine_id, transmission_type_id, drive_type_id, year_from, market)
           SELECT generation_id, body_type_id, engine_id, transmission_type_id, drive_type_id, year_from, 'global'
           FROM vehicle_modification WHERE id = $1`,
          [first.id],
        ),
      ).rejects.toThrow(/vehicle_modification_identity_key/);
      // An option of another kind can't stand for a body — the database refuses it too.
      await expect(
        db.query("UPDATE vehicle_modification SET body_type_id = $1 WHERE id = $2", [
          b.dct.id,
          first.id,
        ]),
      ).rejects.toThrow(/vehicle_modification_body_fkey/);
    });

    it("archives instead of deleting: the make hides its models, the parent must be restored first, archived references stay where chosen", async () => {
      const b = await basics();
      const kept = await modification(b);
      const archivedMake = await ok(
        asAdmin("post", `/admin/vehicles/makes/${b.geely.id}/status`, {
          status: "archived",
          expectedVersion: b.geely.version,
        }),
        (body) => adminVehicleMakeResponseSchema.parse(body).make,
      );
      expect(archivedMake.status).toBe("archived");
      // Models keep their status; they are only hidden.
      const models = await ok(
        asAdmin("get", `/admin/vehicles/models?makeId=${b.geely.id}`),
        (body) => adminVehicleModelPageSchema.parse(body),
      );
      expect(models.models[0]).toMatchObject({ status: "active", visibleToClients: false });
      expectError(
        await asAdmin("post", `/admin/vehicles/models/${b.coolray.id}/status`, {
          status: "archived",
          expectedVersion: 1,
        }).then(() =>
          asAdmin("post", `/admin/vehicles/models/${b.coolray.id}/status`, {
            status: "active",
            expectedVersion: 2,
          }),
        ),
        409,
        "VEHICLE_PARENT_ARCHIVED",
      );
      expectError(
        await asAdmin("post", "/admin/vehicles/models", { makeId: b.geely.id, name: "Tugella" }),
        409,
        "VEHICLE_PARENT_ARCHIVED",
      );
      expect(await count("vehicle_modification")).toBe(1);
      expect((await http().get(`/vehicles/makes/${b.geely.id}/models`)).status).toBe(404);
      await ok(
        asAdmin("post", `/admin/vehicles/makes/${b.geely.id}/status`, {
          status: "active",
          expectedVersion: archivedMake.version,
        }),
        (body) => body,
      );
      // The model was archived above: restored now that its make is.
      await ok(
        asAdmin("post", `/admin/vehicles/models/${b.coolray.id}/status`, {
          status: "active",
          expectedVersion: 2,
        }),
        (body) => body,
      );
      // An archived engine is not offered for a new modification, and stays where it was chosen.
      await ok(
        asAdmin("post", `/admin/vehicles/engines/${b.engine.id}/status`, {
          status: "archived",
          expectedVersion: b.engine.version,
        }),
        (body) => body,
      );
      const refused = await createModification(b, { driveTypeId: b.awd.id });
      expectError(refused, 409, "VEHICLE_REFERENCE_ARCHIVED");
      expect(refused.body.details).toEqual({ field: "engineId" });
      const list = await ok(
        asAdmin("get", `/admin/vehicles/modifications?generationId=${b.coolrayI.id}`),
        (body) => adminVehicleModificationPageSchema.parse(body),
      );
      expect(list.modifications).toEqual([
        expect.objectContaining({
          id: kept.id,
          engine: expect.objectContaining({ status: "archived" }) as unknown,
        }),
      ]);
      const choice = await ok(
        http().get(`/vehicles/generations/${b.coolrayI.id}/modifications`),
        (body) => vehicleModificationsResponseSchema.parse(body),
      );
      expect(choice.modifications.map((entry) => entry.id)).toEqual([kept.id]);
      // Nothing is ever deleted.
      expect(await count("vehicle_make")).toBe(1);
    });

    it("moves a model to another make and a generation to another model, keeping names unique there", async () => {
      const b = await basics();
      const chery = await makeOf("Chery");
      const moved = await ok(
        asAdmin("patch", `/admin/vehicles/models/${b.coolray.id}`, {
          expectedVersion: b.coolray.version,
          makeId: chery.id,
        }),
        (body) => adminVehicleModelResponseSchema.parse(body).model,
      );
      expect(moved.make).toMatchObject({ id: chery.id, name: "Chery" });
      expect(await count("vehicle_model_spelling", `make_id = '${chery.id}'`)).toBe(1);
      const tiggo = await modelOf(chery.id, "Tiggo");
      await generationOf(tiggo.id, "I (SX11)", 2019, null);
      expectError(
        await asAdmin("patch", `/admin/vehicles/generations/${b.coolrayI.id}`, {
          expectedVersion: b.coolrayI.version,
          modelId: tiggo.id,
        }),
        409,
        "VEHICLE_DUPLICATE",
      );
    });
  });

  describe("keeping it by an administrator (AC-2)", () => {
    it("never overwrites a change made meanwhile, and journals every change in its transaction", async () => {
      const b = await basics();
      const [one, two] = await Promise.all([
        asAdmin("patch", `/admin/vehicles/makes/${b.geely.id}`, {
          expectedVersion: b.geely.version,
          aliases: ["Geely Auto"],
        }),
        asAdmin("patch", `/admin/vehicles/makes/${b.geely.id}`, {
          expectedVersion: b.geely.version,
          aliases: ["Джили", "ДЖИЛИ АВТО"],
        }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const conflict = one.status === 409 ? one : two;
      expectError(conflict, 409, "VEHICLE_VERSION_CONFLICT");
      expect(conflict.body.details).toEqual({ currentVersion: 2 });

      const journal = async (entityType: string) =>
        ok(
          asAdmin("get", `/admin/audit-log?entityType=${entityType}&limit=100`),
          (body) => auditLogPageSchema.parse(body).entries,
        );
      const makeEntries = await journal("vehicle_make");
      expect(makeEntries.map((entry) => entry.action).sort()).toEqual([
        "vehicle_make.changed",
        "vehicle_make.created",
      ]);
      expect(makeEntries.find((entry) => entry.action === "vehicle_make.changed")).toMatchObject({
        actor: { role: "admin" },
        before: { aliases: ["Джили"] },
        after: { version: 2 },
      });
      // A change with nothing new neither moves the version nor journals.
      const same = await ok(
        asAdmin("patch", `/admin/vehicles/options/${b.sedan.id}`, {
          expectedVersion: 1,
          names: { ru: "Седан" },
        }),
        (body) => adminVehicleOptionResponseSchema.parse(body).option,
      );
      expect(same.version).toBe(1);
      // A refused change leaves no entry: the journal is in the same transaction.
      const before = await count("audit_log");
      expectError(await createModification(b, { yearFrom: 2000 }), 400, "VEHICLE_YEARS_INVALID");
      expectError(
        await asAdmin("post", "/admin/vehicles/makes", { name: "geely" }),
        409,
        "VEHICLE_DUPLICATE",
      );
      expect(await count("audit_log")).toBe(before);
      const created = await modification(b);
      await ok(
        asAdmin("patch", `/admin/vehicles/modifications/${created.id}`, {
          expectedVersion: 1,
          market: "global",
        }),
        (body) => body,
      );
      const entries = await journal("vehicle_modification");
      expect(entries.map((entry) => entry.action)).toEqual([
        "vehicle_modification.changed",
        "vehicle_modification.created",
      ]);
      expect(entries[0]).toMatchObject({
        before: { market: "kz" },
        after: { market: "global", version: 2 },
      });
      for (const type of [
        "vehicle_option",
        "vehicle_model",
        "vehicle_generation",
        "vehicle_engine",
      ]) {
        expect((await journal(type)).length).toBeGreaterThan(0);
      }
    });

    it("lets two administrators archive and rename one record at once without losing either decision silently", async () => {
      const b = await basics();
      const other = await setUpAdmin(SECOND_ADMIN_PHONE);
      const [archive, rename] = await Promise.all([
        asAdmin("post", `/admin/vehicles/generations/${b.coolrayI.id}/status`, {
          status: "archived",
          expectedVersion: 1,
        }),
        call(other, "patch", `/admin/vehicles/generations/${b.coolrayI.id}`, {
          expectedVersion: 1,
          name: "I рестайлинг",
        }),
      ]);
      expect([archive.status, rename.status].sort()).toEqual([200, 409]);
      const { rows } = await db.query<{ version: number }>(
        "SELECT version FROM vehicle_generation WHERE id = $1",
        [b.coolrayI.id],
      );
      expect(rows[0]!.version).toBe(2);
    });
  });

  describe("search and paging (AC-3)", () => {
    it("pages makes, models, generations and modifications with filters, without gaps or repeats", async () => {
      const b = await basics();
      for (const name of ["Chery", "Haval", "Kia", "Lada", "BMW", "Audi"]) {
        await makeOf(name);
      }
      const seenMakes: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: AdminVehicleMakePage = await ok(
          asAdmin("get", `/admin/vehicles/makes?limit=3${cursor ? `&cursor=${cursor}` : ""}`),
          (body) => adminVehicleMakePageSchema.parse(body),
        );
        expect(page.total).toBe(pages === 0 ? 7 : 8);
        seenMakes.push(...page.makes.map((make) => make.name));
        cursor = page.nextCursor;
        pages++;
        if (pages === 1) {
          // Added while reading: comes on a later page, nothing repeats.
          await makeOf("Zotye");
        }
      } while (cursor);
      expect(seenMakes).toEqual(["Audi", "BMW", "Chery", "Geely", "Haval", "Kia", "Lada", "Zotye"]);
      const search = await ok(
        asAdmin("get", "/admin/vehicles/makes?q=%D0%B4%D0%B6%D0%B8"),
        (body) => adminVehicleMakePageSchema.parse(body),
      );
      expect(search.makes.map((make) => make.name)).toEqual(["Geely"]);

      for (const name of ["Atlas", "Monjaro", "Tugella"]) {
        await modelOf(b.geely.id, name);
      }
      const models = await ok(
        asAdmin("get", `/admin/vehicles/models?makeId=${b.geely.id}&limit=2`),
        (body) => adminVehicleModelPageSchema.parse(body),
      );
      expect(models).toMatchObject({ total: 4 });
      const rest = await ok(
        asAdmin(
          "get",
          `/admin/vehicles/models?makeId=${b.geely.id}&limit=2&cursor=${models.nextCursor}`,
        ),
        (body) => adminVehicleModelPageSchema.parse(body),
      );
      expect([...models.models, ...rest.models].map((model) => model.name)).toEqual([
        "Atlas",
        "Coolray",
        "Monjaro",
        "Tugella",
      ]);
      expect(rest.nextCursor).toBeNull();

      await generationOf(b.coolray.id, "0 (old)", 2010, 2018);
      const in2015 = await ok(asAdmin("get", `/admin/vehicles/generations?year=2015`), (body) =>
        adminVehicleGenerationPageSchema.parse(body),
      );
      expect(in2015.generations.map((generation) => generation.name)).toEqual(["0 (old)"]);
      const ofMake = await ok(
        asAdmin("get", `/admin/vehicles/generations?makeId=${b.geely.id}&limit=1`),
        (body) => adminVehicleGenerationPageSchema.parse(body),
      );
      expect(ofMake).toMatchObject({ total: 2, generations: [{ name: "0 (old)" }] });

      const created: string[] = [];
      for (const [year, market] of [
        [2020, "kz"],
        [2021, "global"],
        [2022, "kz"],
        [2023, "kz"],
        [2024, "global"],
      ] as const) {
        created.push((await modification(b, { yearFrom: year, market })).id);
      }
      const all: string[] = [];
      cursor = null;
      do {
        const page: AdminVehicleModificationPage = await ok(
          asAdmin(
            "get",
            `/admin/vehicles/modifications?modelId=${b.coolray.id}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
          ),
          (body) => adminVehicleModificationPageSchema.parse(body),
        );
        expect(page.total).toBe(5);
        all.push(...page.modifications.map((entry) => entry.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(all).toEqual([...created].reverse());
      const kz2023 = await ok(
        asAdmin("get", "/admin/vehicles/modifications?market=kz&year=2023&status=active"),
        (body) => adminVehicleModificationPageSchema.parse(body),
      );
      expect(kz2023.modifications.map((entry) => entry.yearFrom).sort()).toEqual([
        2020, 2022, 2023,
      ]);
      expectError(
        await asAdmin("get", "/admin/vehicles/modifications?cursor=bm9wZQ"),
        400,
        "VALIDATION_ERROR",
      );
    });
  });

  describe("import from a file (AC-4, AC-5, AC-7)", () => {
    it("gives a template the importer takes back", async () => {
      await app.get(DevVehicleSeed).run();
      const template = await ok(asAdmin("get", "/admin/vehicles/import-template"), (body) =>
        vehicleImportTemplateResponseSchema.parse(body),
      );
      expect(
        template.columns.filter((column) => column.required).map((column) => column.name),
      ).toEqual([
        "make",
        "model",
        "generation",
        "body",
        "engine_code",
        "transmission",
        "drive",
        "year_from",
        "market",
      ]);
      expect(
        template.options.some((entry) => entry.kind === "fuel" && entry.code === "petrol"),
      ).toBe(true);
      const checked = await checkedFile(Buffer.from(template.csv, "utf8"));
      // The example row is a Kazakhstan Coolray the seed already has.
      expect(checked.report).toMatchObject({ create: 0, update: 0, unchanged: 1, rejected: 0 });
    });

    it("reports before applying, changes nothing until confirmed, applies what it said, and imports the same file again without duplicates", async () => {
      await app.get(DevVehicleSeed).run();
      const before = {
        makes: await count("vehicle_make"),
        modifications: await count("vehicle_modification"),
        engines: await count("vehicle_engine"),
      };
      const checked = await checkedFile(fixture("import-example.csv"));
      expect(checked.status).toBe("ready");
      expect(checked.report).toMatchObject({
        create: 4,
        update: 1,
        unchanged: 1,
        rejected: 0,
        newMakes: [{ row: 7, name: "Haval" }],
        newModels: [
          { row: 5, make: "GEELY", name: "Okavango" },
          { row: 6, make: "Chery", name: "Tiggo 8 Pro" },
          { row: 7, make: "Haval", name: "Jolion" },
        ],
        newEngines: [
          { row: 5, code: "JLE-4G18TDB" },
          { row: 6, code: "SQRF4J16" },
          { row: 7, code: "GW4B15A" },
        ],
      });
      // Nothing has changed before the confirmation.
      expect({
        makes: await count("vehicle_make"),
        modifications: await count("vehicle_modification"),
        engines: await count("vehicle_engine"),
      }).toEqual(before);
      const done = await applied(checked.id);
      expect(done).toMatchObject({
        status: "applied",
        result: { created: 4, updated: 1, unchanged: 1, rejected: 0, differsFromReport: 0 },
        appliedBy: { adminId: expect.any(String) as unknown },
      });
      expect(await count("vehicle_modification")).toBe(before.modifications + 4);
      expect(await count("vehicle_make")).toBe(before.makes + 1);
      expect(
        await count("vehicle_modification", "source = 'import' AND import_id IS NOT NULL"),
      ).toBe(4);
      expect(await count("vehicle_make", "source = 'import'")).toBe(1);
      // «GEELY» of the file is the Geely of the catalog.
      expect(await count("vehicle_make_spelling", "key = 'geely'")).toBe(1);
      const rows = await ok(
        asAdmin("get", `/admin/vehicles/imports/${checked.id}/rows?outcome=updated`),
        (body) => vehicleImportRowsPageSchema.parse(body),
      );
      expect(rows.rows).toEqual([
        expect.objectContaining({ row: 2, planned: "update", outcome: "updated" }),
      ]);

      // The same file again: nothing to add, nothing to change.
      const again = await checkedFile(fixture("import-example.csv"));
      expect(again.sameFileAsImportId).toBe(checked.id);
      expect(again.report).toMatchObject({ create: 0, update: 0, unchanged: 6, rejected: 0 });
      const second = await applied(again.id);
      expect(second.result).toMatchObject({ created: 0, updated: 0, unchanged: 6 });
      expect(await count("vehicle_modification")).toBe(before.modifications + 4);

      // Who uploaded and applied — in the journal.
      const journal = await ok(
        asAdmin("get", `/admin/audit-log?entityType=vehicle_import&entityId=${checked.id}`),
        (body) => auditLogPageSchema.parse(body).entries,
      );
      expect(journal.map((entry) => entry.action).reverse()).toEqual([
        "vehicle_import.uploaded",
        "vehicle_import.apply_started",
        "vehicle_import.applied",
      ]);
      expect(journal.every((entry) => entry.actor.role === "admin")).toBe(true);
      const history = await ok(
        asAdmin("get", "/admin/vehicles/imports?limit=1"),
        (body) => body as { total: number; nextCursor: string | null },
      );
      expect(history).toMatchObject({ total: 2 });
      expect(history.nextCursor).not.toBeNull();
    });

    it("rejects bad rows with row numbers and reasons, and applies the rest", async () => {
      await app.get(DevVehicleSeed).run();
      const checked = await checkedFile(fixture("import-with-errors.csv"));
      expect(checked.report).toMatchObject({ create: 2, update: 0, unchanged: 0, rejected: 4 });
      expect(
        checked.report!.rejectedRows.map((row) => [
          row.row,
          row.reasons.map((reason) => reason.code),
        ]),
      ).toEqual([
        [3, ["unknown_option"]],
        [4, ["years_outside_generation"]],
        [5, ["duplicate_in_file"]],
        [6, ["generation_not_found"]],
      ]);
      const rejected = await ok(
        asAdmin("get", `/admin/vehicles/imports/${checked.id}/rows?planned=rejected&limit=2`),
        (body) => vehicleImportRowsPageSchema.parse(body),
      );
      expect(rejected.total).toBe(4);
      expect(rejected.rows[0]).toMatchObject({
        row: 3,
        values: { body: "кабриолет-пикап" },
        reasons: [{ code: "unknown_option", column: "body" }],
      });
      const done = await applied(checked.id);
      expect(done.result).toMatchObject({ created: 2, rejected: 4, differsFromReport: 0 });
      expect(await count("vehicle_option", "code = 'кабриолет-пикап'")).toBe(0);
    });

    it("cancels before applying without changing anything, and applies a report only once", async () => {
      await app.get(DevVehicleSeed).run();
      const modifications = await count("vehicle_modification");
      const checked = await checkedFile(fixture("import-example.csv"));
      const cancelled = await ok(
        asAdmin("post", `/admin/vehicles/imports/${checked.id}/cancel`),
        (body) => adminVehicleImportResponseSchema.parse(body).import,
      );
      expect(cancelled).toMatchObject({ status: "cancelled", report: { create: 4 } });
      expectError(
        await asAdmin("post", `/admin/vehicles/imports/${checked.id}/apply`),
        409,
        "VEHICLE_IMPORT_STATE",
      );
      expect(await count("vehicle_modification")).toBe(modifications);

      const next = await checkedFile(fixture("import-example.csv"));
      const [first, second] = await Promise.all([
        asAdmin("post", `/admin/vehicles/imports/${next.id}/apply`),
        asAdmin("post", `/admin/vehicles/imports/${next.id}/apply`),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const done = await settled(next.id);
      expect(done.result).toMatchObject({ created: 4 });
      expectError(
        await asAdmin("post", `/admin/vehicles/imports/${next.id}/apply`),
        409,
        "VEHICLE_IMPORT_STATE",
      );
      expectError(
        await asAdmin("post", `/admin/vehicles/imports/${next.id}/cancel`),
        409,
        "VEHICLE_IMPORT_STATE",
      );
      expect(await count("vehicle_modification")).toBe(modifications + 4);
    });

    it("applies a report made stale by hand edits without damaging the catalog, saying which rows went otherwise", async () => {
      const b = await basics();
      const checked = await checkedFile(
        csv(
          "Geely,Coolray,I (SX11),,,sedan,JLH-3G15TD,,,,dct,awd,2021,,kz",
          "Geely,Coolray,I (SX11),,,crossover,JLH-3G15TD,,,,at,fwd,2021,,kz",
          "Chery,Tiggo,I,2020,,crossover,JLH-3G15TD,,,,dct,fwd,2021,,kz",
        ),
      );
      expect(checked.report).toMatchObject({ create: 3 });
      // Meanwhile: the first modification is created by hand, the drive of the second archived.
      await modification(b, { bodyTypeId: b.sedan.id, driveTypeId: b.awd.id, yearFrom: 2021 });
      await ok(
        asAdmin("post", `/admin/vehicles/options/${b.fwd.id}/status`, {
          status: "archived",
          expectedVersion: 1,
        }),
        (body) => body,
      );
      const done = await applied(checked.id);
      expect(done.result).toMatchObject({
        created: 0,
        unchanged: 1,
        rejected: 2,
        differsFromReport: 3,
      });
      const rows = await ok(asAdmin("get", `/admin/vehicles/imports/${checked.id}/rows`), (body) =>
        vehicleImportRowsPageSchema.parse(body),
      );
      expect(
        rows.rows.map((row) => [
          row.planned,
          row.outcome,
          row.outcomeReasons.map((reason) => reason.code),
        ]),
      ).toEqual([
        ["create", "unchanged", []],
        ["create", "rejected", ["archived_reference"]],
        ["create", "rejected", ["archived_reference"]],
      ]);
      expect(await count("vehicle_modification")).toBe(1);
      expect(await count("vehicle_make")).toBe(1);
    });

    it("checks and applies ten thousand rows in the background, showing the state, in batches", async () => {
      const b = await basics();
      await setEverywhere({ vehicle_import_batch_size: 1000 });
      const bodies = [b.sedan, b.crossover];
      const transmissions = [b.dct, b.at];
      const drives = [b.fwd, b.awd];
      const rows: string[] = [];
      for (let yearFrom = 1900; rows.length < 10_000; yearFrom++) {
        for (const body of bodies) {
          for (const transmission of transmissions) {
            for (const drive of drives) {
              for (const yearTo of [
                "",
                ...[1, 2, 3, 4, 5, 6].map((add) => String(yearFrom + add)),
              ]) {
                if (rows.length < 10_000) {
                  rows.push(
                    `Geely,Coolray,Big,1900,,${body.code},JLH-3G15TD,,,,${transmission.code},${drive.code},${yearFrom},${yearTo},kz`,
                  );
                }
              }
            }
          }
        }
      }
      const created = await uploaded(csv(...rows));
      expect(created).toMatchObject({ status: "parsing", rowCount: 10_000 });
      const checked = await settled(created.id, ["parsing"], 120_000);
      expect(checked.report).toMatchObject({ create: 10_000, rejected: 0 });
      expect(await count("vehicle_modification")).toBe(0);
      const started = await ok(
        asAdmin("post", `/admin/vehicles/imports/${created.id}/apply`),
        (body) => adminVehicleImportResponseSchema.parse(body).import,
      );
      expect(started.status).toBe("applying");
      const done = await settled(created.id, ["applying"], 240_000);
      expect(done.result).toMatchObject({ created: 10_000, rejected: 0 });
      expect(await count("vehicle_modification")).toBe(10_000);
    }, 400_000);

    it("marks an import that took too long as failed, and a cancelled check never becomes ready", async () => {
      await basics();
      const checked = await checkedFile(
        csv("Geely,Coolray,I (SX11),,,sedan,JLH-3G15TD,,,,dct,fwd,2021,,kz"),
      );
      await ok(asAdmin("post", `/admin/vehicles/imports/${checked.id}/apply`), (body) => body);
      await settled(checked.id);
      // An import stuck in a phase (a worker that died with it):
      const stuck = await uploaded(
        csv("Geely,Coolray,I (SX11),,,sedan,JLH-3G15TD,,,,at,fwd,2021,,kz"),
      );
      await settled(stuck.id);
      await db.query(
        "UPDATE vehicle_import SET status = 'applying', phase_started_at = now() - interval '2 hours', applied_by_admin_id = uploaded_by_admin_id, applied_by_account_id = uploaded_by_account_id WHERE id = $1",
        [stuck.id],
      );
      await worker.get(VehicleImportExpiry).run();
      const failed = await importState(stuck.id);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining("longer than") as unknown,
      });
      const entries = await ok(
        asAdmin("get", `/admin/audit-log?entityId=${stuck.id}&action=vehicle_import.failed`),
        (body) => auditLogPageSchema.parse(body).entries,
      );
      expect(entries[0]).toMatchObject({ actor: { role: "system" } });
      expectError(
        await asAdmin("post", `/admin/vehicles/imports/${stuck.id}/cancel`),
        409,
        "VEHICLE_IMPORT_STATE",
      );
      // Cancelled while being checked: the check finds it cancelled and leaves it so.
      await db.query(
        "UPDATE vehicle_import SET status = 'parsing', report = NULL, error = NULL, finished_at = NULL WHERE id = $1",
        [stuck.id],
      );
      await ok(asAdmin("post", `/admin/vehicles/imports/${stuck.id}/cancel`), (body) => body);
      const analyzer = worker.get(VehicleImportAnalyzer);
      await analyzer.run(
        { importId: stuck.id },
        { jobId: "test", attempt: 1, signal: new AbortController().signal },
      );
      expect((await importState(stuck.id)).status).toBe("cancelled");
    });
  });

  describe("file errors (AC-6)", () => {
    it("answers every problem of the file with its own code and stores nothing", async () => {
      await basics();
      const refused = async (response: Response, reason: string) => {
        expectError(response, 400, "VEHICLE_IMPORT_FILE_INVALID");
        expect(vehicleImportFileInvalidDetailsSchema.parse(response.body.details).reason).toBe(
          reason,
        );
      };
      await refused(
        await upload(
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "unsupported_format",
      );
      await refused(await upload(Buffer.from("%PDF-1.4\n"), "text/csv"), "unsupported_format");
      await refused(await upload(Buffer.alloc(0), "text/csv"), "empty");
      await refused(await upload(Buffer.from(`${HEADER}\r\n`), "text/csv"), "no_rows");
      await refused(
        await upload(Buffer.from("make,model\r\nGeely,Coolray\r\n"), "text/csv"),
        "missing_columns",
      );
      await refused(
        await upload(Buffer.from(`${HEADER},colour\r\nx\r\n`), "text/csv"),
        "unknown_columns",
      );
      await refused(
        await upload(
          Buffer.concat([Buffer.from(`${HEADER}\r\n`), Buffer.from([0xc3, 0x28, 0x0a])]),
          "text/csv",
        ),
        "encoding",
      );
      await refused(
        await upload(Buffer.from(`${HEADER}\r\n"Geely,Coolray\r\n`), "text/csv"),
        "malformed",
      );
      await setEverywhere({ vehicle_import_max_rows: 10 });
      const eleven = Array.from(
        { length: 11 },
        (_, index) => `Geely,Coolray,I (SX11),,,sedan,X${index},,,,dct,fwd,2021,,kz`,
      );
      await refused(await upload(csv(...eleven)), "too_many_rows");
      await setEverywhere({ vehicle_import_max_file_mb: 1 });
      expectError(await upload(Buffer.alloc(1024 * 1024 + 10, 0x61)), 413, "PAYLOAD_TOO_LARGE");
      expectError(
        await upload(Buffer.from(`${HEADER}\r\n`), "image/png"),
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      );
      expect(await count("vehicle_import")).toBe(0);
      expect(await count("vehicle_import_row")).toBe(0);
    });
  });

  describe("clients choose a car step by step (AC-8)", () => {
    it("serve guests and every session the active part, in the language asked for with Russian as the fallback, cacheable", async () => {
      const b = await basics();
      const kz = await modification(b);
      const archivedOne = await modification(b, {
        driveTypeId: b.awd.id,
        transmissionTypeId: b.at.id,
        market: "global",
      });
      await ok(
        asAdmin("post", `/admin/vehicles/modifications/${archivedOne.id}/status`, {
          status: "archived",
          expectedVersion: 1,
        }),
        (body) => body,
      );
      const empty = await generationOf(b.coolray.id, "II", 2024, null);
      const mobile = await signIn(USER_PHONE, IOS);
      const operator = app.get(OperatorService);
      const { supplierId } = await operator.createSupplier({ name: "Автомаркет", city: "Алматы" });
      await operator.addMember({ supplierId, phone: MEMBER_PHONE, displayName: "Айгерим" });
      const cabinet = await signIn(MEMBER_PHONE, SUPPLIER_WEB);
      const callers: [string, string | undefined][] = [
        [IOS, undefined],
        [IOS, mobile.body.session.accessToken as string],
        [SUPPLIER_WEB, cabinet.body.session.accessToken as string],
        [ADMIN_WEB, token],
      ];
      const answers: unknown[] = [];
      for (const [client, bearer] of callers) {
        let test = http()
          .get(`/vehicles/generations/${b.coolrayI.id}/modifications`)
          .set("X-Client", client)
          .set("Accept-Language", "kk");
        if (bearer) {
          test = test.set("Authorization", `Bearer ${bearer}`);
        }
        const response = await test;
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("public, max-age=60");
        expect(response.headers.vary).toContain("Accept-Language");
        expect(response.headers["content-language"]).toBe("kk");
        answers.push(response.body);
      }
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
      const choice = vehicleModificationsResponseSchema.parse(answers[0]);
      expect(choice.make).toMatchObject({ name: "Geely", aliases: ["Джили"] });
      expect(choice.modifications).toHaveLength(1);
      expect(choice.modifications[0]).toMatchObject({
        id: kz.id,
        market: "kz",
        bodyType: { code: "crossover", name: { text: "Кроссовер", isFallback: false } },
        transmissionType: { name: { text: "Робот беріліс", isFallback: false } },
        engine: {
          code: "JLH-3G15TD",
          displacementL: 1.5,
          powerHp: 177,
          fuel: { name: { text: "Бензин" } },
        },
      });

      const makes = vehicleMakesResponseSchema.parse((await http().get("/vehicles/makes")).body);
      expect(makes.makes.map((make) => make.name)).toEqual(["Geely"]);
      const models = vehicleModelsResponseSchema.parse(
        (await http().get(`/vehicles/makes/${b.geely.id}/models`)).body,
      );
      expect(models.models.map((model) => model.name)).toEqual(["Coolray"]);
      const generations = vehicleGenerationsResponseSchema.parse(
        (await http().get(`/vehicles/models/${b.coolray.id}/generations`)).body,
      );
      expect(generations.generations.map((generation) => generation.name)).toEqual([
        "II",
        "I (SX11)",
      ]);
      // No Kazakh name — the Russian one, marked.
      const withAt = await modification(b, { transmissionTypeId: b.at.id, yearFrom: 2021 });
      const fallback = vehicleModificationsResponseSchema.parse(
        (
          await http()
            .get(`/vehicles/generations/${b.coolrayI.id}/modifications?market=kz`)
            .set("Accept-Language", "kk")
        ).body,
      );
      expect(
        fallback.modifications.find((entry) => entry.id === withAt.id)!.transmissionType.name,
      ).toEqual({
        text: "Автомат",
        isFallback: true,
      });
      const english = vehicleModificationsResponseSchema.parse(
        (
          await http()
            .get(`/vehicles/generations/${b.coolrayI.id}/modifications`)
            .set("Accept-Language", "en")
        ).body,
      );
      expect(english.language).toBe("en");
      expect(english.modifications[0]!.bodyType.name.text).toBe("Crossover");
      // A generation without modifications is an empty list, not an error.
      const none = vehicleModificationsResponseSchema.parse(
        (await http().get(`/vehicles/generations/${empty.id}/modifications`)).body,
      );
      expect(none.modifications).toEqual([]);
      // Missing, malformed and archived — one 404, never cached.
      await ok(
        asAdmin("post", `/admin/vehicles/makes/${b.geely.id}/status`, {
          status: "archived",
          expectedVersion: 1,
        }),
        (body) => body,
      );
      for (const path of [
        `/vehicles/makes/${b.geely.id}/models`,
        `/vehicles/models/${b.coolray.id}/generations`,
        `/vehicles/generations/${b.coolrayI.id}/modifications`,
        "/vehicles/makes/not-an-id/models",
        "/vehicles/makes/00000000-0000-4000-8000-000000000000/models",
      ]) {
        const response = await http().get(path);
        expectError(response, 404, "NOT_FOUND");
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(
        vehicleMakesResponseSchema.parse((await http().get("/vehicles/makes")).body).makes,
      ).toEqual([]);
    });
  });

  describe("access (AC-9)", () => {
    it("serves the admin routes to the admin context only", async () => {
      const b = await basics();
      const routes = Object.values(apiRoutes).filter((route) =>
        route.path.startsWith("/admin/vehicles"),
      );
      expect(routes).toHaveLength(31);
      const ids: Record<string, string> = {
        optionId: b.sedan.id,
        makeId: b.geely.id,
        modelId: b.coolray.id,
        generationId: b.coolrayI.id,
        engineId: b.engine.id,
        modificationId: (await modification(b)).id,
        importId: "00000000-0000-4000-8000-000000000000",
      };
      const mobile = await signIn(USER_PHONE, IOS);
      const operator = app.get(OperatorService);
      const { supplierId } = await operator.createSupplier({ name: "Автомаркет", city: "Алматы" });
      await operator.addMember({ supplierId, phone: MEMBER_PHONE, displayName: "Айгерим" });
      const cabinet = await signIn(MEMBER_PHONE, SUPPLIER_WEB);
      const callers = [
        { token: undefined, client: IOS, status: 401, code: "AUTH_REQUIRED" },
        {
          token: mobile.body.session.accessToken as string,
          client: IOS,
          status: 403,
          code: "FORBIDDEN",
        },
        {
          token: cabinet.body.session.accessToken as string,
          client: SUPPLIER_WEB,
          status: 403,
          code: "FORBIDDEN",
        },
      ] as const;
      const before = { journal: await count("audit_log"), imports: await count("vehicle_import") };
      for (const route of routes) {
        expect((route as ApiRouteDefinition).contexts).toEqual(["admin"]);
        const path = route.path.replace(/\{(\w+)\}/g, (_match, name: string) => ids[name]!);
        for (const caller of callers) {
          let test = http()
            [route.method.toLowerCase() as Method](path)
            .set("X-Client", caller.client);
          if (caller.token) {
            test = test.set("Authorization", `Bearer ${caller.token}`);
          }
          const sent = isUploadRoute(route as ApiRouteDefinition)
            ? test
                .set("Content-Type", "text/csv")
                .send(csv("Geely,Coolray,I (SX11),,,sedan,JLH-3G15TD,,,,dct,fwd,2021,,kz"))
            : test.send({ name: "Чужой", expectedVersion: 1, status: "archived" });
          expectError(await sent, caller.status, caller.code as ErrorCode);
        }
      }
      expect({ journal: await count("audit_log"), imports: await count("vehicle_import") }).toEqual(
        before,
      );
    });
  });

  describe("development seed (AC-10)", () => {
    it("fills the catalog once, is visible to clients in Kazakh, and refuses outside development and tests", async () => {
      const seed = app.get(DevVehicleSeed);
      const first = await seed.run();
      expect(first.created).toMatchObject({ makes: 2, options: 17, engines: 6 });
      expect(first.created.modifications).toBeGreaterThanOrEqual(7);
      const second = await seed.run();
      expect(second.created).toEqual({
        options: 0,
        makes: 0,
        models: 0,
        generations: 0,
        engines: 0,
        modifications: 0,
      });
      expect(second.existing).toEqual(first.created);
      const options = await ok(asAdmin("get", "/admin/vehicles/options?kind=drive"), (body) =>
        adminVehicleOptionListResponseSchema.parse(body),
      );
      expect(options.options.map((entry) => entry.code)).toEqual(["fwd", "rwd", "awd"]);
      const makes = vehicleMakesResponseSchema.parse((await http().get("/vehicles/makes")).body);
      const geely = makes.makes.find((make) => make.name === "Geely")!;
      const models = vehicleModelsResponseSchema.parse(
        (await http().get(`/vehicles/makes/${geely.id}/models`)).body,
      );
      const monjaro = models.models.find((model) => model.name === "Monjaro")!;
      const generations = vehicleGenerationsResponseSchema.parse(
        (await http().get(`/vehicles/models/${monjaro.id}/generations`)).body,
      );
      const choice = vehicleModificationsResponseSchema.parse(
        (
          await http()
            .get(`/vehicles/generations/${generations.generations[0]!.id}/modifications`)
            .set("Accept-Language", "kk")
        ).body,
      );
      expect(choice.modifications[0]).toMatchObject({
        market: "kz",
        driveType: { name: { text: "Толық", isFallback: false } },
        engine: { code: "JLH-4G20TDB" },
      });
      const production = new DevVehicleSeed(
        { ...config, nodeEnv: "production" },
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );
      await expect(production.run()).rejects.toBeInstanceOf(DevVehicleSeedError);
    });
  });
});
