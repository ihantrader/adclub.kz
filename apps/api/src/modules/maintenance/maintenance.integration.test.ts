import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminMaintenancePlanPageSchema,
  adminMaintenancePlanResponseSchema,
  adminSupplierResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  confirmMaintenanceItemsResponseSchema,
  maintenancePlanAnswerSchema,
  maintenancePlanCheckResponseSchema,
  showcaseListResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminMaintenancePlanResponse,
  type DayHours,
  type ErrorCode,
  type MaintenanceScope,
} from "@adclub/contracts";
import { maintenanceScopeMatches, type MaintenanceCar } from "@adclub/domain";
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
import { truncateAll } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { TestAiGateway } from "../ai";
import { DevCompatibilitySeed } from "../compatibility";
import { DevCatalogSeed } from "../catalog";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { DevSupplierSeed } from "../suppliers";
import { DevVehicleSeed } from "../vehicles";
import { DevMaintenanceSeed, maintenancePlan, planCandidatesWhere } from ".";

/**
 * TASK-061 end to end on a real PostgreSQL (and Redis for sessions and
 * limits): the SQL twin of the plan's area against the domain rule on the
 * same plans, plans and elements kept by the administrator (versions, 409,
 * the journal in the transaction, activation and its checks, one active
 * plan per area, the copy, the order, «подтвердить все»), the AI draft of
 * the test provider (proposed elements, an unmapped one, failures, the
 * limit per administrator, one draft at a time), the answer for a car
 * against the client list of the subcategory, caching, access, and the
 * development seed.
 */

const ADMIN_PHONE = "+77011230610";
const USER_PHONE = "+77471230611";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

const ALWAYS: DayHours[] = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  day,
  intervals: [{ from: "00:00", to: "24:00" }],
}));

type Method = "get" | "post" | "put" | "patch" | "delete";

describe("maintenance plans (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let gateway: TestAiGateway;
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
      AI_PROVIDER: "test",
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
    gateway = app.get(TestAiGateway);
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
    gateway.mode = "ok";
    await truncateAll(db);
    await redis.flushall();
    await settings.reload();
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) rememberCode(sent.code);
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

  async function ok<T>(test: Test, parse: (body: unknown) => T, status = 200): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  const plan = (body: unknown) => adminMaintenancePlanResponseSchema.parse(body);

  async function idOf(query: string, params: unknown[] = []): Promise<string> {
    const { rows } = await db.query<{ id: string }>(query, params);
    expect(rows[0], query).toBeDefined();
    return rows[0]!.id;
  }

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]!.count);
  }

  // ---------------------------------------------------------------- world

  async function world() {
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    await app.get(DevCompatibilitySeed).run();
    const make = (key: string) =>
      idOf("SELECT make_id AS id FROM vehicle_make_spelling WHERE key = $1", [key]);
    const geely = await make("geely");
    const chery = await make("chery");
    const model = (key: string) =>
      idOf("SELECT model_id AS id FROM vehicle_model_spelling WHERE key = $1", [key]);
    const coolray = await model("coolray");
    const atlas = await model("atlas");
    const tiggo = await model("tiggo7pro");
    const atlasII = await idOf(
      "SELECT id FROM vehicle_generation WHERE model_id = $1 AND name_key = 'ii (fx11)'",
      [atlas],
    );
    const engine = await idOf(
      "SELECT engine_id AS id FROM vehicle_engine_spelling WHERE key = 'jlh-3g15td'",
    );
    const category = (code: string) => idOf("SELECT id FROM category WHERE code = $1", [code]);
    const attribute = (categoryId: string, code: string) =>
      idOf("SELECT id FROM attribute WHERE category_id = $1 AND code = $2", [categoryId, code]);
    const option = (attributeId: string, code: string) =>
      idOf("SELECT id FROM attribute_option WHERE attribute_id = $1 AND code = $2", [
        attributeId,
        code,
      ]);
    const oils = await category("engine_oils");
    const viscosity = await attribute(oils, "viscosity");
    const approval = await attribute(oils, "approval");
    return {
      geely,
      chery,
      coolray,
      atlas,
      tiggo,
      atlasII,
      engine,
      oils,
      viscosity,
      approval,
      v5w30: await option(viscosity, "5w_30"),
      apiSp: await option(approval, "api_sp"),
      oilFilters: await category("oil_filters"),
      cabinFilters: await category("cabin_filters"),
      oilChange: await category("oil_change"),
      pads: await category("brake_pads"),
      helix: await idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND lang = 'ru' AND text = 'Shell Helix HX8 5W-30, 4 л'",
      ),
      frontPads: await idOf("SELECT id FROM catalog_item WHERE article_norm = '044650K090'"),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** The example supplier with its point open around the clock, an offer on the oil and the pads. */
  async function sell(w: World): Promise<{ cityId: string }> {
    const seeded = await app.get(DevSupplierSeed).run();
    const supplier = await ok(asAdmin("get", `/admin/suppliers/${seeded.supplierId}`), (body) =>
      adminSupplierResponseSchema.parse(body),
    );
    await ok(
      asAdmin("put", `/admin/suppliers/${seeded.supplierId}/schedule`, {
        expectedVersion: supplier.supplier.version,
        weeklyHours: ALWAYS,
        closedDates: [],
      }),
      (body) => body,
    );
    const member = await sessionToken(seeded.memberPhone, SUPPLIER_WEB);
    for (const itemId of [w.helix, w.frontPads]) {
      await ok(
        call(member, SUPPLIER_WEB, "post", "/supplier/offers", {
          itemId,
          price: 9_700,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        }),
        (body) => body,
        201,
      );
    }
    return { cityId: supplier.supplier.city.id };
  }

  const scope = (patch: Partial<MaintenanceScope> & { makeId: string }): MaintenanceScope => ({
    modelId: null,
    generationId: null,
    engineId: null,
    ...patch,
  });

  async function createPlan(planScope: MaintenanceScope, name?: string) {
    return ok(
      asAdmin("post", "/admin/maintenance/plans", { scope: planScope, ...(name ? { name } : {}) }),
      plan,
      201,
    );
  }

  async function addItem(planId: string, body: object): Promise<AdminMaintenancePlanResponse> {
    return ok(asAdmin("post", `/admin/maintenance/plans/${planId}/items`, body), plan, 201);
  }

  function oilElement(w: World) {
    return {
      kind: "part",
      title: { ru: "Моторное масло" },
      intervalKm: 10_000,
      intervalMonths: 12,
      serviceCodes: ["ТО-1", "ТО-2"],
      target: {
        kind: "category",
        categoryId: w.oils,
        attributes: [
          { attributeId: w.viscosity, optionIds: [w.v5w30] },
          { attributeId: w.approval, optionIds: [w.apiSp] },
        ],
      },
    };
  }

  async function activate(answer: AdminMaintenancePlanResponse) {
    return ok(
      asAdmin("post", `/admin/maintenance/plans/${answer.plan.id}/status`, {
        expectedVersion: answer.plan.version,
        status: "active",
      }),
      plan,
    );
  }

  // ----------------------------------------------------------------- tests

  it("the SQL twin selects exactly the plans the domain rule does not rule out", async () => {
    const w = await world();
    const database = app.get(DatabaseService).db;
    const scopes: MaintenanceScope[] = [
      scope({ makeId: w.geely }),
      scope({ makeId: w.geely, modelId: w.coolray }),
      scope({ makeId: w.geely, modelId: w.coolray, engineId: w.engine }),
      scope({ makeId: w.geely, modelId: w.atlas, generationId: w.atlasII }),
      scope({ makeId: w.geely, modelId: w.atlas, generationId: w.atlasII, engineId: w.engine }),
      scope({ makeId: w.geely, engineId: w.engine }),
      scope({ makeId: w.chery, modelId: w.tiggo }),
    ];
    for (const [index, planScope] of scopes.entries()) {
      await db.query(
        `INSERT INTO maintenance_plan (make_id, model_id, generation_id, engine_id, name, source, status, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6, now())`,
        [
          planScope.makeId,
          planScope.modelId,
          planScope.generationId,
          planScope.engineId,
          `p${String(index)}`,
          "active",
        ],
      );
    }
    // A draft and an archived plan never count; a plan of an archived model is invisible.
    await db.query(
      `INSERT INTO maintenance_plan (make_id, model_id, name, source, status, archived_at)
       VALUES ($1, $2, 'archived', 'manual', 'archived', now()), ($1, $2, 'draft', 'manual', 'draft', NULL)`,
      [w.geely, w.coolray],
    );
    const rows = (await database.select().from(maintenancePlan)).map((row) => ({
      id: row.id,
      status: row.status,
      scope: scope(row),
    }));
    const cars: MaintenanceCar[] = [
      { makeId: w.geely, modelId: null, generationId: null, engineId: null },
      { makeId: w.geely, modelId: w.coolray, generationId: null, engineId: null },
      { makeId: w.geely, modelId: w.coolray, generationId: null, engineId: w.engine },
      { makeId: w.geely, modelId: w.atlas, generationId: w.atlasII, engineId: null },
      { makeId: w.geely, modelId: w.atlas, generationId: null, engineId: w.engine },
      { makeId: w.chery, modelId: w.tiggo, generationId: null, engineId: null },
      { makeId: w.chery, modelId: null, generationId: null, engineId: w.engine },
    ];
    const compare = async (archivedModel: string | null) => {
      for (const car of cars) {
        const sqlIds = (
          await database
            .select({ id: maintenancePlan.id })
            .from(maintenancePlan)
            .where(planCandidatesWhere({ ...car, makeId: car.makeId! }))
        )
          .map((row) => row.id)
          .sort();
        const domainIds = rows
          .filter(
            (row) =>
              row.status === "active" &&
              (archivedModel === null || row.scope.modelId !== archivedModel) &&
              maintenanceScopeMatches(row.scope, car).result !== "does_not_fit",
          )
          .map((row) => row.id)
          .sort();
        expect(sqlIds, JSON.stringify(car)).toEqual(domainIds);
      }
    };
    await compare(null);
    await db.query(
      "UPDATE vehicle_model SET status = 'archived', archived_at = now() WHERE id = $1",
      [w.coolray],
    );
    await compare(w.coolray);
  });

  it("keeps plans and elements: versions, the rule against the catalog, activation, one active per area, the journal", async () => {
    const w = await world();
    const created = await createPlan(
      scope({ makeId: w.geely, modelId: w.coolray }),
      "Geely Coolray",
    );
    expect(created.plan).toMatchObject({ status: "draft", source: "manual", itemCount: 0 });
    expect(created.plan.label).toMatchObject({ make: "Geely", model: "Coolray" });

    // The levels agree in the base: a generation of another model.
    expectError(
      await asAdmin("post", "/admin/maintenance/plans", {
        scope: { makeId: w.geely, modelId: w.coolray, generationId: w.atlasII },
      }),
      400,
      "MAINTENANCE_SCOPE_INVALID",
    );
    // An empty plan is not ready.
    const empty = await asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/status`, {
      expectedVersion: created.plan.version,
      status: "active",
    });
    expectError(empty, 409, "MAINTENANCE_PLAN_NOT_READY");
    expect(empty.body.details).toMatchObject({ empty: true });

    // A rule names only what the catalog has.
    const base = oilElement(w);
    expectError(
      await asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/items`, {
        ...base,
        target: { kind: "category", categoryId: w.oilChange, attributes: [] },
      }),
      400,
      "MAINTENANCE_TARGET_INVALID",
    );
    expectError(
      await asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/items`, {
        ...base,
        target: {
          kind: "category",
          categoryId: w.oils,
          attributes: [{ attributeId: w.viscosity, optionIds: [w.apiSp] }],
        },
      }),
      400,
      "MAINTENANCE_TARGET_INVALID",
    );
    expectError(
      await asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/items`, {
        ...base,
        intervalKm: 10_000,
        firstKm: 10_000,
      }),
      400,
      "VALIDATION_ERROR",
    );
    expectError(
      await asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/items`, {
        ...base,
        intervalKm: null,
        intervalMonths: null,
      }),
      400,
      "VALIDATION_ERROR",
    );

    const withOil = await addItem(created.plan.id, base);
    expect(withOil.items[0]).toMatchObject({
      status: "active",
      targetLabel: "Моторные масла · Вязкость: 5W-30 · Допуск: API SP",
      problems: [],
    });
    expect(withOil.items[0]!.title.ru).toMatchObject({ text: "Моторное масло", origin: "source" });
    expect(
      await count("translation_task", "entity_type = 'maintenance_plan_item' AND entity_id = $1", [
        withOil.items[0]!.id,
      ]),
    ).toBe(2);
    const withPads = await addItem(created.plan.id, {
      kind: "part",
      title: { ru: "Тормозные колодки" },
      intervalKm: 40_000,
      target: { kind: "items", itemIds: [w.frontPads] },
      quantity: 1,
    });
    expect(withPads.items[1]!.targetLabel).toBe("Позиции: 04465-0K090");

    // An element changed by someone else meanwhile: 409, nothing changed.
    const oil = withPads.items[0]!;
    await ok(
      asAdmin("patch", `/admin/maintenance/items/${oil.id}`, {
        expectedVersion: oil.version,
        intervalKm: 15_000,
      }),
      plan,
    );
    expectError(
      await asAdmin("patch", `/admin/maintenance/items/${oil.id}`, {
        expectedVersion: oil.version,
        intervalKm: 20_000,
      }),
      409,
      "MAINTENANCE_VERSION_CONFLICT",
    );

    // The order: against the order as read.
    const now = plan((await asAdmin("get", `/admin/maintenance/plans/${created.plan.id}`)).body);
    const ids = now.items.map((item) => item.id);
    expectError(
      await asAdmin("put", `/admin/maintenance/plans/${created.plan.id}/items/order`, {
        itemIds: [...ids].reverse(),
        expectedOrder: [...ids].reverse(),
      }),
      409,
      "MAINTENANCE_VERSION_CONFLICT",
    );
    const reordered = await ok(
      asAdmin("put", `/admin/maintenance/plans/${created.plan.id}/items/order`, {
        itemIds: [...ids].reverse(),
        expectedOrder: ids,
      }),
      plan,
    );
    expect(reordered.items.map((item) => item.id)).toEqual([...ids].reverse());

    const active = await activate(reordered);
    expect(active.plan).toMatchObject({ status: "active" });
    expect(active.plan.confirmedBy).not.toBeNull();

    // A second plan of the same area: a draft is fine, its activation — 409 with the active one.
    const second = await createPlan(scope({ makeId: w.geely, modelId: w.coolray }));
    expect(second.activePlanId).toBe(created.plan.id);
    const secondWithOil = await addItem(second.plan.id, oilElement(w));
    const refused = await asAdmin("post", `/admin/maintenance/plans/${second.plan.id}/status`, {
      expectedVersion: secondWithOil.plan.version,
      status: "active",
    });
    expectError(refused, 409, "MAINTENANCE_PLAN_ACTIVE_EXISTS");
    expect(refused.body.details).toEqual({ existingPlanId: created.plan.id });
    // The area of an active plan doesn't change.
    expectError(
      await asAdmin("patch", `/admin/maintenance/plans/${created.plan.id}`, {
        expectedVersion: active.plan.version,
        scope: { makeId: w.geely },
      }),
      409,
      "MAINTENANCE_PLAN_STATE",
    );

    // The copy: a manual draft of another area with the same elements.
    const copy = await ok(
      asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/copy`, {
        scope: { makeId: w.geely, modelId: w.atlas, generationId: w.atlasII },
      }),
      plan,
      201,
    );
    expect(copy.plan).toMatchObject({
      source: "manual",
      status: "draft",
      copiedFromId: created.plan.id,
      itemCount: 2,
    });
    expect(copy.items.every((item) => item.status === "active")).toBe(true);

    // A hidden subcategory: the element of the active plan says so.
    await db.query("UPDATE category SET status = 'hidden' WHERE id = $1", [w.oils]);
    const hidden = plan((await asAdmin("get", `/admin/maintenance/plans/${created.plan.id}`)).body);
    expect(
      hidden.items.find((item) => item.kind === "part" && item.targetLabel?.startsWith("Моторные"))!
        .problems,
    ).toEqual(["category_unavailable"]);
    await db.query("UPDATE category SET status = 'active' WHERE id = $1", [w.oils]);

    // Archive: the plan stops being active; the second can be activated.
    await ok(
      asAdmin("post", `/admin/maintenance/plans/${created.plan.id}/status`, {
        expectedVersion: hidden.plan.version,
        status: "archived",
      }),
      plan,
    );
    expect((await activate(secondWithOil)).plan.status).toBe("active");

    // The journal, in the transaction of each action.
    const journal = await ok(
      asAdmin(
        "get",
        `/admin/audit-log?entityType=maintenance_plan&entityId=${created.plan.id}&limit=50`,
      ),
      (body) => auditLogPageSchema.parse(body),
    );
    expect(journal.entries.map((entry) => entry.action).sort()).toEqual(
      [
        "maintenance_plan.created",
        "maintenance_plan.items_reordered",
        "maintenance_plan.activated",
        "maintenance_plan.archived",
      ].sort(),
    );
    expect(
      await count(
        "audit_log",
        "entity_type = 'maintenance_plan_item' AND action = 'maintenance_plan_item.changed'",
      ),
    ).toBe(1);

    // The list: filters and the total.
    const page = await ok(
      asAdmin("get", `/admin/maintenance/plans?status=draft&makeId=${w.geely}`),
      (body) => adminMaintenancePlanPageSchema.parse(body),
    );
    expect(page.total).toBe(1);
    expect(page.plans[0]!.id).toBe(copy.plan.id);
    const byWords = await ok(asAdmin("get", "/admin/maintenance/plans?q=coolray"), (body) =>
      adminMaintenancePlanPageSchema.parse(body),
    );
    expect(byWords.total).toBe(2);
  });

  it("an AI draft: proposed elements mapped onto the catalog, one unmapped, nothing activated", async () => {
    const w = await world();
    const draft = await ok(
      asAdmin("post", "/admin/maintenance/plans/draft", {
        scope: { makeId: w.geely, modelId: w.coolray, engineId: w.engine },
      }),
      plan,
      201,
    );
    expect(draft.plan).toMatchObject({ source: "ai_draft", status: "draft", generating: false });
    expect(draft.items.length).toBeGreaterThan(5);
    expect(draft.items.every((item) => item.status === "proposed")).toBe(true);
    const unmapped = draft.items.filter((item) => item.target === null);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]!.note).toMatch(/^unmapped: brake_fluids/);
    expect(unmapped[0]!.problems).toEqual(["no_rule"]);
    const oil = draft.items.find((item) => item.title.ru?.text === "Моторное масло")!;
    expect(oil.targetLabel).toBe("Моторные масла · Вязкость: 5W-30 · Допуск: API SP");
    expect(oil.intervalKm).toBe(10_000);

    // The call is recorded without texts; the request had our subcategories.
    const { rows: jobs } = await db.query<{ kind: string; input_ref: unknown; output: unknown }>(
      "SELECT kind, input_ref, output FROM ai_job WHERE kind = 'maintenance_plan_draft'",
    );
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]!.input_ref)).not.toMatch(/Моторн|Geely/u);
    expect(gateway.maintenanceDraftRequests.at(-1)!.categories).toBeGreaterThan(10);

    // Nothing to activate before every element is confirmed and has a rule.
    const refused = await asAdmin("post", `/admin/maintenance/plans/${draft.plan.id}/status`, {
      expectedVersion: draft.plan.version,
      status: "active",
    });
    expectError(refused, 409, "MAINTENANCE_PLAN_NOT_READY");
    // «Подтвердить все»: the one without a rule stays.
    const confirmed = await ok(
      asAdmin("post", `/admin/maintenance/plans/${draft.plan.id}/items/confirm`, {
        expectedVersion: draft.plan.version,
      }),
      (body) => confirmMaintenanceItemsResponseSchema.parse(body),
    );
    expect(confirmed).toMatchObject({ confirmed: draft.items.length - 1, skipped: 1 });
    // The unmapped one gets a rule, then is confirmed; the plan activates.
    const fluid = confirmed.items.find((item) => item.target === null)!;
    expectError(
      await asAdmin("post", `/admin/maintenance/items/${fluid.id}/status`, {
        expectedVersion: fluid.version,
        status: "active",
      }),
      400,
      "VALIDATION_ERROR",
    );
    const ruled = await ok(
      asAdmin("patch", `/admin/maintenance/items/${fluid.id}`, {
        expectedVersion: fluid.version,
        target: { kind: "category", categoryId: w.oilFilters, attributes: [] },
      }),
      plan,
    );
    const fluidNow = ruled.items.find((item) => item.id === fluid.id)!;
    // Two administrators confirm one element: one wins.
    const [first, second] = await Promise.all([
      asAdmin("post", `/admin/maintenance/items/${fluid.id}/status`, {
        expectedVersion: fluidNow.version,
        status: "active",
      }),
      asAdmin("post", `/admin/maintenance/items/${fluid.id}/status`, {
        expectedVersion: fluidNow.version,
        status: "active",
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const latest = plan((await asAdmin("get", `/admin/maintenance/plans/${draft.plan.id}`)).body);
    expect((await activate(latest)).plan.status).toBe("active");
  });

  it("an AI draft that fails leaves nothing; one at a time per area; limited per administrator", async () => {
    const w = await world();
    const body = { scope: { makeId: w.geely, modelId: w.coolray } };
    for (const mode of ["unavailable", "rejected", "invalid_output"] as const) {
      gateway.mode = mode;
      const response = await asAdmin("post", "/admin/maintenance/plans/draft", body);
      expectError(response, 503, "SERVICE_UNAVAILABLE");
      expect(response.body.retryable).toBe(true);
    }
    gateway.mode = "ok";
    expect(await count("maintenance_plan")).toBe(0);
    // A draft being made of this area: a second one waits.
    await db.query(
      `INSERT INTO maintenance_plan (make_id, model_id, name, source, status, generating_since)
       VALUES ($1, $2, 'x', 'ai_draft', 'draft', now())`,
      [w.geely, w.coolray],
    );
    expectError(
      await asAdmin("post", "/admin/maintenance/plans/draft", body),
      409,
      "MAINTENANCE_DRAFT_IN_PROGRESS",
    );
    // A stale one (its process died) is dropped.
    await db.query("UPDATE maintenance_plan SET generating_since = now() - interval '10 minutes'");
    await ok(asAdmin("post", "/admin/maintenance/plans/draft", body), plan, 201);
    expect(await count("maintenance_plan")).toBe(1);
    // The limit per administrator.
    await redis.flushall();
    await settings.set({ maintenance_draft_per_admin_day: 1 });
    await ok(
      asAdmin("post", "/admin/maintenance/plans/draft", { scope: { makeId: w.chery } }),
      plan,
      201,
    );
    expectError(
      await asAdmin("post", "/admin/maintenance/plans/draft", { scope: { makeId: w.geely } }),
      429,
      "RATE_LIMITED",
    );
  });

  it("answers a car what is due and what is sold — by the client list of the subcategory", async () => {
    const w = await world();
    const { cityId } = await sell(w);
    const general = await createPlan(scope({ makeId: w.geely }), "Geely");
    await addItem(general.plan.id, oilElement(w));
    const generalReady = await addItem(general.plan.id, {
      kind: "service",
      title: { ru: "Замена моторного масла" },
      intervalKm: 10_000,
      serviceCodes: ["ТО-1", "ТО-2"],
      target: { kind: "category", categoryId: w.oilChange, attributes: [] },
    });
    await activate(generalReady);
    // A finer plan of the generation that needs the engine.
    const fine = await createPlan(
      scope({ makeId: w.geely, modelId: w.atlas, generationId: w.atlasII, engineId: w.engine }),
    );
    await activate(
      await addItem(fine.plan.id, {
        kind: "part",
        title: { ru: "Колодки" },
        intervalKm: 20_000,
        target: { kind: "items", itemIds: [w.frontPads] },
      }),
    );

    const car = `vehicleMakeId=${w.geely}&vehicleModelId=${w.coolray}&vehicleEngineId=${w.engine}&vehicleYear=2024`;
    const guest = await http()
      .get(`/maintenance/plan?${car}&mileageKm=20000&cityId=${cityId}`)
      .set("X-Client", IOS);
    expect(guest.status, JSON.stringify(guest.body)).toBe(200);
    expect(guest.headers["cache-control"]).toBe("public, max-age=60");
    expect(guest.headers.vary).toMatch(/Authorization/);
    const answer = maintenancePlanAnswerSchema.parse(guest.body);
    expect(answer).toMatchObject({ noPlan: null, serviceKm: 20_000, nextServiceKm: 30_000 });
    expect(answer.plan!.id).toBe(general.plan.id);
    expect(answer.plan!.serviceCodes).toEqual(["ТО-1", "ТО-2"]);
    const oil = answer.items.find((item) => item.kind === "part")!;
    expect(oil).toMatchObject({ reason: "by_km", atKm: 20_000 });
    // The count is the client list's total with the same filters, car and city.
    const list = showcaseListResponseSchema.parse(
      (
        await http()
          .get(
            `/catalog/categories/${w.oils}/items?${car}&cityId=${cityId}&attributes=${encodeURIComponent(JSON.stringify(oil.catalog.filters))}`,
          )
          .set("X-Client", IOS)
      ).body,
    );
    expect(oil.catalog.count).toBe(list.total);
    expect(oil.catalog.count).toBe(1);
    expect(oil.catalog.minPrice).toBe(9_700);
    // A service: by the city only.
    const service = answer.items.find((item) => item.kind === "service")!;
    expect(service.catalog).toMatchObject({ count: 0, cityRequired: false });
    const noCity = maintenancePlanAnswerSchema.parse(
      (await http().get(`/maintenance/plan?${car}&mileageKm=20000`).set("X-Client", IOS)).body,
    );
    expect(noCity.items.find((item) => item.kind === "service")!.catalog).toMatchObject({
      count: null,
      cityRequired: true,
    });

    // A user's session: the same, kept by nobody but the client.
    const user = await sessionToken(USER_PHONE, IOS);
    const signedIn = await call(
      user,
      IOS,
      "get",
      `/maintenance/plan?${car}&serviceCode=${encodeURIComponent("ТО-2")}`,
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers["cache-control"]).toBe("private, no-store");
    expect(
      maintenancePlanAnswerSchema
        .parse(signedIn.body)
        .items.every((item) => item.reason === "by_code"),
    ).toBe(true);
    // No mileage, no code: «уточните пробег».
    expect(
      maintenancePlanAnswerSchema.parse(
        (await http().get(`/maintenance/plan?${car}`).set("X-Client", IOS)).body,
      ),
    ).toMatchObject({ reason: "mileage_required", items: [] });

    // Atlas II without the engine: the make's plan applies, the finer one doesn't block it.
    const atlasCar = `vehicleMakeId=${w.geely}&vehicleModelId=${w.atlas}&vehicleGenerationId=${w.atlasII}`;
    const atlas = maintenancePlanAnswerSchema.parse(
      (await http().get(`/maintenance/plan?${atlasCar}&mileageKm=20000`).set("X-Client", IOS)).body,
    );
    expect(atlas.plan!.id).toBe(general.plan.id);
    // With the engine — the finer one, a rule by items counted by the list of their subcategory.
    const atlasEngine = maintenancePlanAnswerSchema.parse(
      (
        await http()
          .get(
            `/maintenance/plan?${atlasCar}&vehicleEngineId=${w.engine}&mileageKm=20000&cityId=${cityId}`,
          )
          .set("X-Client", IOS)
      ).body,
    );
    expect(atlasEngine.plan!.id).toBe(fine.plan.id);
    const pads = showcaseListResponseSchema.parse(
      (
        await http()
          .get(
            `/catalog/categories/${w.pads}/items?${atlasCar}&vehicleEngineId=${w.engine}&cityId=${cityId}`,
          )
          .set("X-Client", IOS)
      ).body,
    );
    expect(atlasEngine.items[0]!.catalog.count).toBe(
      pads.items.filter((item) => item.id === w.frontPads).length,
    );
    expect(atlasEngine.items[0]!.catalog.count).toBe(1);

    // Chery: no plan; without a car — the make is asked for.
    expect(
      maintenancePlanAnswerSchema.parse(
        (
          await http()
            .get(`/maintenance/plan?vehicleMakeId=${w.chery}&mileageKm=1000`)
            .set("X-Client", IOS)
        ).body,
      ),
    ).toMatchObject({ plan: null, noPlan: "no_plan" });
    expect(
      maintenancePlanAnswerSchema.parse(
        (await http().get("/maintenance/plan").set("X-Client", IOS)).body,
      ),
    ).toMatchObject({ plan: null, noPlan: "needs_details", missing: ["make"] });
    // Only the finer plan, the car without its engine: «уточните двигатель».
    await db.query(
      "UPDATE maintenance_plan SET status = 'archived', archived_at = now() WHERE id = $1",
      [general.plan.id],
    );
    expect(
      maintenancePlanAnswerSchema.parse(
        (await http().get(`/maintenance/plan?${atlasCar}&mileageKm=20000`).set("X-Client", IOS))
          .body,
      ),
    ).toMatchObject({ plan: null, noPlan: "needs_details", missing: ["engine"] });
    // An archived engine of the vehicle catalog hides the plan from cars.
    await db.query(
      "UPDATE vehicle_engine SET status = 'archived', archived_at = now() WHERE id = $1",
      [w.engine],
    );
    expect(
      maintenancePlanAnswerSchema.parse(
        (
          await http()
            .get(`/maintenance/plan?${atlasCar}&vehicleEngineId=${w.engine}&mileageKm=20000`)
            .set("X-Client", IOS)
        ).body,
      ),
    ).toMatchObject({ plan: null, noPlan: "no_plan" });
  });

  it("the check of a plan for the administrator: every element, the catalog and the sold counts", async () => {
    const w = await world();
    const { cityId } = await sell(w);
    const draft = await ok(
      asAdmin("post", "/admin/maintenance/plans/draft", {
        scope: { makeId: w.geely, modelId: w.coolray },
      }),
      plan,
      201,
    );
    const check = await ok(
      asAdmin("post", `/admin/maintenance/plans/${draft.plan.id}/check`, {
        vehicle: { makeId: w.geely, modelId: w.coolray, engineId: w.engine, year: 2024 },
        mileageKm: 20_000,
        cityId,
      }),
      (body) => maintenancePlanCheckResponseSchema.parse(body),
    );
    expect(check.scope).toEqual({ result: "fits", missing: [] });
    const byTitle = (title: string) => check.items.find((item) => item.title.text === title)!;
    expect(byTitle("Моторное масло")).toMatchObject({ status: "proposed", catalog: { count: 1 } });
    expect(byTitle("Моторное масло").catalogTotal).toBeGreaterThanOrEqual(1);
    expect(byTitle("Салонный фильтр")).toMatchObject({ catalogTotal: 0, catalog: { count: 0 } });
    // The car of another model: the plan's area doesn't fit.
    const other = await ok(
      asAdmin("post", `/admin/maintenance/plans/${draft.plan.id}/check`, {
        vehicle: { makeId: w.geely, modelId: w.atlas },
        mileageKm: 20_000,
      }),
      (body) => maintenancePlanCheckResponseSchema.parse(body),
    );
    expect(other.scope.result).toBe("does_not_fit");
  });

  it("a plan follows a moved model or generation, active, draft or archived, with its journal (TASK-061.A)", async () => {
    const w = await world();
    const coolrayGeneration = await idOf(
      "SELECT id FROM vehicle_generation WHERE model_id = $1 ORDER BY year_from LIMIT 1",
      [w.coolray],
    );
    const active = await activate(
      await addItem(
        (await createPlan(scope({ makeId: w.geely, modelId: w.coolray }))).plan.id,
        oilElement(w),
      ),
    );
    const draft = await createPlan(
      scope({ makeId: w.geely, modelId: w.coolray, engineId: w.engine }),
    );
    const toArchive = await createPlan(
      scope({ makeId: w.geely, modelId: w.coolray, generationId: coolrayGeneration }),
    );
    const archived = await ok(
      asAdmin("post", `/admin/maintenance/plans/${toArchive.plan.id}/status`, {
        expectedVersion: toArchive.plan.version,
        status: "archived",
      }),
      plan,
    );
    const versionOf = async (table: string, id: string) =>
      Number(
        (await db.query<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1`, [id]))
          .rows[0]!.version,
      );

    // The model was made under the wrong make: «Автомобили» moves it — no 500.
    const moved = await asAdmin("patch", `/admin/vehicles/models/${w.coolray}`, {
      expectedVersion: await versionOf("vehicle_model", w.coolray),
      makeId: w.chery,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const levels = async (id: string) =>
      (
        await db.query<{ make_id: string; model_id: string; version: number }>(
          "SELECT make_id, model_id, version FROM maintenance_plan WHERE id = $1",
          [id],
        )
      ).rows[0]!;
    for (const [before, status] of [
      [active, "active"],
      [draft, "draft"],
      [archived, "archived"],
    ] as const) {
      const row = await levels(before.plan.id);
      expect(row, status).toMatchObject({ make_id: w.chery, model_id: w.coolray });
      expect(row.version, status).toBe(before.plan.version + 1);
    }
    // The car of the new make gets the active plan.
    const answer = maintenancePlanAnswerSchema.parse(
      (
        await http()
          .get(
            `/maintenance/plan?vehicleMakeId=${w.chery}&vehicleModelId=${w.coolray}&mileageKm=10000`,
          )
          .set("X-Client", IOS)
      ).body,
    );
    expect(answer.plan?.id).toBe(active.plan.id);
    const journal = auditLogPageSchema.parse(
      (
        await asAdmin(
          "get",
          `/admin/audit-log?entityType=maintenance_plan&action=maintenance_plan.changed`,
        )
      ).body,
    );
    expect(journal.entries).toHaveLength(3);
    expect(journal.entries.find((entry) => entry.entityId === active.plan.id)).toMatchObject({
      before: { scope: { makeId: w.geely, modelId: w.coolray } },
      after: { scope: { makeId: w.chery, modelId: w.coolray }, followed: "vehicle_model" },
    });

    // The generation goes to a model of another make: model and make of the plan follow.
    const back = await asAdmin("patch", `/admin/vehicles/generations/${coolrayGeneration}`, {
      expectedVersion: await versionOf("vehicle_generation", coolrayGeneration),
      modelId: w.atlas,
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await levels(archived.plan.id)).toMatchObject({ make_id: w.geely, model_id: w.atlas });
    expect(await levels(active.plan.id)).toMatchObject({ make_id: w.chery, model_id: w.coolray });
    // An engine has no parent to move; archiving a level changes no ids.
    const modelArchived = await db.query(
      "UPDATE vehicle_model SET status = 'archived', archived_at = now() WHERE id = $1",
      [w.coolray],
    );
    expect(modelArchived.rowCount).toBe(1);
    expect(await levels(active.plan.id)).toMatchObject({ make_id: w.chery, model_id: w.coolray });
  });

  it("a rule that no longer leads to the catalog sells nothing, and its element stays editable (TASK-061.A)", async () => {
    const w = await world();
    const { cityId } = await sell(w);
    const general = await activate(
      await addItem((await createPlan(scope({ makeId: w.geely }), "Geely")).plan.id, oilElement(w)),
    );
    const car = `vehicleMakeId=${w.geely}&vehicleModelId=${w.coolray}&vehicleEngineId=${w.engine}&vehicleYear=2024`;
    const oil = async () =>
      maintenancePlanAnswerSchema
        .parse(
          (
            await http()
              .get(`/maintenance/plan?${car}&mileageKm=10000&cityId=${cityId}`)
              .set("X-Client", IOS)
          ).body,
        )
        .items.find((item) => item.kind === "part")!;
    const checked = async () =>
      (
        await ok(
          asAdmin("post", `/admin/maintenance/plans/${general.plan.id}/check`, {
            vehicle: { makeId: w.geely, modelId: w.coolray, engineId: w.engine, year: 2024 },
            mileageKm: 10_000,
            cityId,
          }),
          (body) => maintenancePlanCheckResponseSchema.parse(body),
        )
      ).items.find((item) => item.kind === "part")!;
    expect((await oil()).catalog).toMatchObject({ unavailable: false, count: 1 });

    const unavailable = {
      unavailable: true,
      count: 0,
      minPrice: null,
      categoryId: null,
      filters: [],
      itemIds: [],
    };
    // «Вязкость» no longer in the filters: the list would skip the condition — the answer doesn't widen.
    await db.query("UPDATE attribute SET is_filterable = false WHERE id = $1", [w.viscosity]);
    expect((await oil()).catalog).toMatchObject(unavailable);
    expect(await checked()).toMatchObject({
      problems: ["attribute_unavailable"],
      catalogTotal: 0,
      catalog: unavailable,
    });
    // Archived — the same.
    await db.query(
      "UPDATE attribute SET is_filterable = true, status = 'archived', archived_at = now() WHERE id = $1",
      [w.viscosity],
    );
    expect((await oil()).catalog).toMatchObject(unavailable);
    const card = await ok(asAdmin("get", `/admin/maintenance/plans/${general.plan.id}`), plan);
    const element = card.items.find((item) => item.kind === "part")!;
    expect(element.problems).toEqual(["attribute_unavailable"]);

    // The element keeps every other field editable: the stale rule is sent back as it is.
    const edited = await ok(
      asAdmin("patch", `/admin/maintenance/items/${element.id}`, {
        expectedVersion: element.version,
        intervalKm: 15_000,
        target: element.target,
      }),
      plan,
    );
    const after = edited.items.find((item) => item.id === element.id)!;
    expect(after.intervalKm).toBe(15_000);
    // A new rule is checked: the archived characteristic is refused.
    expectError(
      await asAdmin("patch", `/admin/maintenance/items/${element.id}`, {
        expectedVersion: after.version,
        target: {
          kind: "category",
          categoryId: w.oils,
          attributes: [{ attributeId: w.viscosity, optionIds: [w.v5w30] }],
        },
      }),
      400,
      "MAINTENANCE_TARGET_INVALID",
    );
    // The condition dropped (what the dialog does): the rule is valid again and sells.
    const cleaned = await ok(
      asAdmin("patch", `/admin/maintenance/items/${element.id}`, {
        expectedVersion: after.version,
        target: {
          kind: "category",
          categoryId: w.oils,
          attributes: [{ attributeId: w.approval, optionIds: [w.apiSp] }],
        },
      }),
      plan,
    );
    expect(cleaned.items.find((item) => item.id === element.id)!.problems).toEqual([]);
    expect((await oil()).catalog.unavailable).toBe(false);

    // An archived variant of the rule.
    await db.query(
      "UPDATE attribute_option SET status = 'archived', archived_at = now() WHERE id = $1",
      [w.apiSp],
    );
    expect((await oil()).catalog).toMatchObject(unavailable);
    await db.query(
      "UPDATE attribute_option SET status = 'active', archived_at = NULL WHERE id = $1",
      [w.apiSp],
    );
    // A hidden subcategory: the interval still changes.
    await db.query("UPDATE category SET status = 'hidden' WHERE id = $1", [w.oils]);
    expect((await oil()).catalog).toMatchObject(unavailable);
    const hidden = (
      await ok(asAdmin("get", `/admin/maintenance/plans/${general.plan.id}`), plan)
    ).items.find((item) => item.id === element.id)!;
    expect(hidden.problems).toContain("category_unavailable");
    const intervalChanged = await asAdmin("patch", `/admin/maintenance/items/${element.id}`, {
      expectedVersion: hidden.version,
      intervalKm: 12_000,
      target: hidden.target,
    });
    expect(intervalChanged.status, JSON.stringify(intervalChanged.body)).toBe(200);
  });

  it("the last element of an active plan stays, a plan holds 100 elements, the city is checked first (TASK-061.A)", async () => {
    const w = await world();
    const created = await createPlan(scope({ makeId: w.geely }));
    const active = await activate(await addItem(created.plan.id, oilElement(w)));
    const only = active.items[0]!;
    const refused = await asAdmin("post", `/admin/maintenance/items/${only.id}/status`, {
      expectedVersion: only.version,
      status: "archived",
    });
    expectError(refused, 409, "MAINTENANCE_PLAN_STATE");
    expect(refused.body.details).toEqual({ reason: "last_active_element" });
    // With another one — it goes.
    const two = await addItem(created.plan.id, { ...oilElement(w), title: { ru: "Масло 2" } });
    await ok(
      asAdmin("post", `/admin/maintenance/items/${only.id}/status`, {
        expectedVersion: two.items.find((item) => item.id === only.id)!.version,
        status: "archived",
      }),
      plan,
    );
    // A draft may be emptied as before.
    const other = await createPlan(scope({ makeId: w.chery }));
    const draftItem = (await addItem(other.plan.id, oilElement(w))).items[0]!;
    await ok(
      asAdmin("post", `/admin/maintenance/items/${draftItem.id}/status`, {
        expectedVersion: draftItem.version,
        status: "archived",
      }),
      plan,
    );

    // 100 elements: the 101st is refused (and so is restoring an archived one over it).
    const values = Array.from(
      { length: 99 },
      (_, index) => `($1, ${String(index + 1)}, 'part', 10000, 'proposed')`,
    );
    await db.query(
      `INSERT INTO maintenance_plan_item (plan_id, position, kind, interval_km, status) VALUES ${values.join(", ")}`,
      [other.plan.id],
    );
    await addItem(other.plan.id, oilElement(w));
    const full = await asAdmin(
      "post",
      `/admin/maintenance/plans/${other.plan.id}/items`,
      oilElement(w),
    );
    expectError(full, 409, "MAINTENANCE_PLAN_STATE");
    expect(full.body.details).toEqual({ reason: "items_limit" });
    const restore = await asAdmin("post", `/admin/maintenance/items/${draftItem.id}/status`, {
      expectedVersion: draftItem.version + 1,
      status: "active",
    });
    expectError(restore, 409, "MAINTENANCE_PLAN_STATE");

    // An inactive city is a 400 whatever the plan has, even with nothing due.
    const city = await idOf(
      "INSERT INTO city (code, name_ru, name_kk, name_en, status, archived_at) VALUES ('gone-061a', 'Г', 'Г', 'G', 'archived', now()) RETURNING id",
    );
    for (const path of [
      `/maintenance/plan?vehicleMakeId=${w.chery}&cityId=${city}`,
      `/maintenance/plan?vehicleMakeId=${w.geely}&cityId=${city}`,
    ]) {
      expectError(await http().get(path).set("X-Client", IOS), 400, "VALIDATION_ERROR");
    }
  });

  it("a draft AI never finished is not listed nor counted, and is archived like any draft (TASK-061.A)", async () => {
    const w = await world();
    const stale = await idOf(
      `INSERT INTO maintenance_plan (make_id, name, source, status, generating_since)
       VALUES ($1, 'stale', 'ai_draft', 'draft', now() - interval '10 minutes') RETURNING id`,
      [w.geely],
    );
    const fresh = await idOf(
      `INSERT INTO maintenance_plan (make_id, name, source, status, generating_since)
       VALUES ($1, 'fresh', 'ai_draft', 'draft', now()) RETURNING id`,
      [w.chery],
    );
    const page = await ok(
      asAdmin("get", "/admin/maintenance/plans?status=draft&source=ai_draft"),
      (body) => adminMaintenancePlanPageSchema.parse(body),
    );
    expect(page.plans.map((entry) => entry.id)).toEqual([fresh]);
    expect(page.total).toBe(1);
    expect(page.plans[0]!.generating).toBe(true);
    // Opened by its link it is a plain draft: archived like any.
    const card = await ok(asAdmin("get", `/admin/maintenance/plans/${stale}`), plan);
    expect(card.plan.generating).toBe(false);
    await ok(
      asAdmin("post", `/admin/maintenance/plans/${stale}/status`, {
        expectedVersion: card.plan.version,
        status: "archived",
      }),
      plan,
    );
    expect(
      (await db.query("SELECT generating_since FROM maintenance_plan WHERE id = $1", [stale]))
        .rows[0],
    ).toEqual({ generating_since: null });
    // The one being made right now is still not editable.
    const making = await ok(asAdmin("get", `/admin/maintenance/plans/${fresh}`), plan);
    expectError(
      await asAdmin("post", `/admin/maintenance/plans/${fresh}/status`, {
        expectedVersion: making.plan.version,
        status: "archived",
      }),
      409,
      "MAINTENANCE_PLAN_STATE",
    );
  });

  it("opens the admin routes to administrators only, the answer to guests and users", async () => {
    const w = await world();
    const created = await createPlan(scope({ makeId: w.geely }));
    const user = await sessionToken(USER_PHONE, IOS);
    const seeded = await app.get(DevSupplierSeed).run();
    const member = await sessionToken(seeded.memberPhone, SUPPLIER_WEB);
    const routes: [Method, string, object?][] = [
      ["get", "/admin/maintenance/plans"],
      ["post", "/admin/maintenance/plans", { scope: { makeId: w.geely } }],
      ["post", "/admin/maintenance/plans/draft", { scope: { makeId: w.geely } }],
      ["get", `/admin/maintenance/plans/${created.plan.id}`],
      [
        "post",
        `/admin/maintenance/plans/${created.plan.id}/check`,
        { vehicle: { makeId: w.geely } },
      ],
    ];
    for (const [method, path, body] of routes) {
      expectError(await call(null, ADMIN_WEB, method, path, body), 401, "AUTH_REQUIRED");
      expectError(await call(user, IOS, method, path, body), 403, "FORBIDDEN");
      expectError(await call(member, SUPPLIER_WEB, method, path, body), 403, "FORBIDDEN");
    }
    // The answer: guests and the app; the cabinet and the admin panel — 403.
    expect(
      (await call(null, IOS, "get", `/maintenance/plan?vehicleMakeId=${w.geely}`)).status,
    ).toBe(200);
    expectError(
      await call(member, SUPPLIER_WEB, "get", `/maintenance/plan?vehicleMakeId=${w.geely}`),
      403,
      "FORBIDDEN",
    );
    expectError(
      await asAdmin("get", `/maintenance/plan?vehicleMakeId=${w.geely}`),
      403,
      "FORBIDDEN",
    );
    // Limited as the catalog is.
    await settings.set({ catalog_read_per_ip: 2 });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push(
        (
          await http()
            .get(`/maintenance/plan?vehicleMakeId=${w.geely}`)
            .set("X-Client", IOS)
            .set("X-Forwarded-For", "203.0.113.7")
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("the development seed: three active plans, a second run creates nothing", async () => {
    await world();
    const first = await app.get(DevMaintenanceSeed).run();
    expect(first.created.plans).toBe(3);
    expect(await count("maintenance_plan", "status = 'active'")).toBe(3);
    const second = await app.get(DevMaintenanceSeed).run();
    expect(second).toMatchObject({ created: { plans: 0, items: 0 }, existing: { plans: 3 } });
  });
});
