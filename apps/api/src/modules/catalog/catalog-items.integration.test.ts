import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminAttributeListResponseSchema,
  adminAttributeResponseSchema,
  adminBrandPageSchema,
  adminBrandResponseSchema,
  adminCatalogItemCardSchema,
  adminCatalogItemPageSchema,
  adminCategoryResponseSchema,
  adminCategoryTreeResponseSchema,
  apiErrorResponseSchema,
  apiRoutes,
  auditActions,
  auditLogPageSchema,
  catalogAnalogInvalidDetailsSchema,
  catalogBrandSpellingTakenDetailsSchema,
  catalogItemDuplicateDetailsSchema,
  catalogValuesRejectedDetailsSchema,
  categoryFillPageSchema,
  fillCategoryResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminAttribute,
  type AdminBrand,
  type AdminCatalogItemCard,
  type AdminCategory,
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
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { CatalogItemsService, DevCatalogSeed } from ".";

/**
 * TASK-011 end to end on a real PostgreSQL: brands and their spellings,
 * items of three types, the uniqueness of parts (held by the database) and
 * of products, attribute values by type, completeness always true to the
 * data, the bulk fill (all or nothing, conflicts by cell), analogs, search
 * and paging, the journal and simultaneous edits, and the scenarios the
 * task asks to walk through in dev.
 */

const ADMIN_PHONE = "+77011234567";
const SECOND_ADMIN_PHONE = "+77011234568";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77051234000";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

type Method = "get" | "post" | "put" | "patch" | "delete";

/**
 * Completeness as the data says it is, computed here independently of the
 * server: an item is incomplete while an active attribute of its category
 * that counts for completeness has no value.
 */
const COMPLETENESS_DRIFT = `
  SELECT i.id, i.completeness,
    CASE WHEN EXISTS (
      SELECT 1 FROM attribute a
      LEFT JOIN item_attribute_value v ON v.item_id = i.id AND v.attribute_id = a.id
      WHERE a.category_id = i.category_id AND a.status = 'active'
        AND a.is_required_for_complete AND v.item_id IS NULL
    ) THEN 'incomplete' ELSE 'complete' END AS actual
  FROM catalog_item i`;

interface Fixture {
  pads: AdminCategory;
  discs: AdminCategory;
  oils: AdminCategory;
  oilChange: AdminCategory;
  brakesNode: AdminCategory;
  axle: AdminAttribute;
  viscosity: AdminAttribute;
  approval: AdminAttribute;
  volume: AdminAttribute;
  packs: AdminAttribute;
  note: AdminAttribute;
  synthetic: AdminAttribute;
  geely: AdminBrand;
  trw: AdminBrand;
  shell: AdminBrand;
  mobil: AdminBrand;
}

describe("catalog items (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
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
      S3_ENDPOINT: "http://127.0.0.1:3",
      S3_ACCESS_KEY: "x",
      S3_SECRET_KEY: "x",
      S3_BUCKET: "x",
      TRUST_PROXY: "true",
    });
    const nest = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nest.useLogger(nest.get(JsonLoggerService));
    nest.flushLogs();
    configureHttpApp(nest, config);
    // A real port: concurrent requests share one listening server.
    await nest.listen(0, "127.0.0.1");
    app = nest;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await db.query(TRUNCATE_ALL);
    await redis.flushall();
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
  });

  afterEach(async () => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
    // Whatever a test did, completeness is never behind the data.
    expect(await drift()).toEqual([]);
  });

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

  /** An administrator signed in to the admin panel; returns the access token. */
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

  async function drift(): Promise<unknown[]> {
    const { rows } = await db.query<{ id: string; completeness: string; actual: string }>(
      COMPLETENESS_DRIFT,
    );
    return rows.filter((row) => row.completeness !== row.actual);
  }

  async function count(table: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    return Number(rows[0]!.count);
  }

  async function created<T>(response: Response, parse: (body: unknown) => T): Promise<T> {
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return parse(response.body);
  }

  async function ok<T>(response: Response, parse: (body: unknown) => T): Promise<T> {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return parse(response.body);
  }

  async function category(body: object): Promise<AdminCategory> {
    return created(
      await asAdmin("post", "/admin/catalog/categories", body),
      (value) => adminCategoryResponseSchema.parse(value).category,
    );
  }

  async function attribute(categoryId: string, body: object): Promise<AdminAttribute> {
    return created(
      await asAdmin("post", `/admin/catalog/categories/${categoryId}/attributes`, body),
      (value) => adminAttributeResponseSchema.parse(value).attribute,
    );
  }

  async function brandOf(body: object): Promise<AdminBrand> {
    return created(
      await asAdmin("post", "/admin/catalog/brands", body),
      (value) => adminBrandResponseSchema.parse(value).brand,
    );
  }

  async function createItem(body: object): Promise<AdminCatalogItemCard> {
    return created(await asAdmin("post", "/admin/catalog/items", body), (value) =>
      adminCatalogItemCardSchema.parse(value),
    );
  }

  async function card(itemId: string): Promise<AdminCatalogItemCard> {
    return ok(await asAdmin("get", `/admin/catalog/items/${itemId}`), (value) =>
      adminCatalogItemCardSchema.parse(value),
    );
  }

  async function fixture(): Promise<Fixture> {
    const brakesNode = await category({ code: "brakes", kind: "goods", names: { ru: "Тормоза" } });
    const pads = await category({
      code: "brake_pads",
      kind: "goods",
      parentId: brakesNode.id,
      names: { ru: "Тормозные колодки", kk: "Тежегіш қалыптары", en: "Brake pads" },
      compatibilityRequired: true,
    });
    const discs = await category({
      code: "brake_discs",
      kind: "goods",
      parentId: brakesNode.id,
      names: { ru: "Тормозные диски" },
    });
    const consumables = await category({
      code: "consumables",
      kind: "goods",
      names: { ru: "Расходники" },
    });
    const oils = await category({
      code: "engine_oils",
      kind: "goods",
      parentId: consumables.id,
      names: { ru: "Моторные масла" },
    });
    const maintenance = await category({
      code: "maintenance",
      kind: "services",
      names: { ru: "Техобслуживание" },
    });
    const oilChange = await category({
      code: "oil_change",
      kind: "services",
      parentId: maintenance.id,
      names: { ru: "Замена масла" },
    });
    const axle = await attribute(pads.id, {
      code: "axle",
      valueType: "enum",
      names: { ru: "Ось" },
      isRequiredForComplete: true,
      options: [
        { code: "front", names: { ru: "Передняя" } },
        { code: "rear", names: { ru: "Задняя" } },
      ],
    });
    const viscosity = await attribute(oils.id, {
      code: "viscosity",
      valueType: "enum",
      names: { ru: "Вязкость" },
      isRequiredForComplete: true,
      options: [
        { code: "0w_20", names: { ru: "0W-20" } },
        { code: "5w_30", names: { ru: "5W-30" } },
        { code: "5w_40", names: { ru: "5W-40" } },
      ],
    });
    const approval = await attribute(oils.id, {
      code: "approval",
      valueType: "enum",
      names: { ru: "Допуск" },
      isRequiredForComplete: true,
      options: [
        { code: "api_sp", names: { ru: "API SP" } },
        { code: "acea_c3", names: { ru: "ACEA C3" } },
      ],
    });
    const volume = await attribute(oils.id, {
      code: "volume",
      valueType: "number",
      names: { ru: "Объём" },
      unit: { ru: "л" },
      number: { integer: false, min: 0.1, max: 220 },
      isRequiredForComplete: true,
    });
    const packs = await attribute(oils.id, {
      code: "packs",
      valueType: "number",
      names: { ru: "Штук в коробке" },
      number: { integer: true, min: 1, max: 24 },
    });
    const note = await attribute(oils.id, {
      code: "note",
      valueType: "text",
      names: { ru: "Примечание" },
    });
    const synthetic = await attribute(oils.id, {
      code: "synthetic",
      valueType: "bool",
      names: { ru: "Синтетика" },
    });
    const geely = await brandOf({ name: "Geely", aliases: ["GEELY Auto"], isOem: true });
    const trw = await brandOf({ name: "TRW" });
    const shell = await brandOf({ name: "Shell" });
    const mobil = await brandOf({ name: "Mobil" });
    return {
      pads,
      discs,
      oils,
      oilChange,
      brakesNode,
      axle,
      viscosity,
      approval,
      volume,
      packs,
      note,
      synthetic,
      geely,
      trw,
      shell,
      mobil,
    };
  }

  const option = (target: AdminAttribute, code: string): string =>
    target.options.find((entry) => entry.code === code)!.id;

  /** An oil of `brand` with these values (by the fixture's attributes). */
  function oil(f: Fixture, brandId: string, ru: string, values: Record<string, unknown>) {
    return {
      type: "generic",
      categoryId: f.oils.id,
      brandId,
      names: { ru },
      values: Object.entries(values).map(([code, value]) => {
        const target = [f.viscosity, f.approval, f.volume, f.packs, f.note, f.synthetic].find(
          (entry) => entry.code === code,
        )!;
        return {
          attributeId: target.id,
          value: target.valueType === "enum" ? option(target, value as string) : value,
        };
      }),
    };
  }

  async function journal(): Promise<
    { action: string; entityId: string; actorRole: string; before: unknown; after: unknown }[]
  > {
    const response = await asAdmin("get", "/admin/audit-log?limit=100");
    expect(response.status).toBe(200);
    return auditLogPageSchema
      .parse(response.body)
      .entries.map((entry) => ({
        action: entry.action,
        entityId: entry.entityId,
        actorRole: entry.actor.role,
        before: entry.before,
        after: entry.after,
      }))
      .reverse();
  }

  // ------------------------------------------------------------- brands

  describe("brands (AC-1)", () => {
    it("keeps every spelling unique whatever the case and spaces; an archived brand isn't chosen for new items", async () => {
      const f = await fixture();
      expect(f.geely).toMatchObject({ name: "Geely", aliases: ["GEELY Auto"], isOem: true });

      for (const body of [
        { name: "GEELY" },
        { name: "geely  auto" },
        { name: "GeelyAuto" },
        { name: "Джили", aliases: [" geely "] },
      ]) {
        const refused = await asAdmin("post", "/admin/catalog/brands", body);
        expectError(refused, 409, "CATALOG_BRAND_SPELLING_TAKEN");
        expect(
          catalogBrandSpellingTakenDetailsSchema.parse(refused.body.details).conflictingBrandId,
        ).toBe(f.geely.id);
      }
      // An alias repeating its own name, or another alias.
      expectError(
        await asAdmin("post", "/admin/catalog/brands", { name: "Febi", aliases: ["FEBI"] }),
        400,
        "VALIDATION_ERROR",
      );
      // Another brand can't take a spelling of Geely by renaming either.
      expectError(
        await asAdmin("patch", `/admin/catalog/brands/${f.trw.id}`, {
          expectedVersion: f.trw.version,
          aliases: ["Geely Auto"],
        }),
        409,
        "CATALOG_BRAND_SPELLING_TAKEN",
      );
      // Geely itself may rewrite its spellings.
      const renamed = await ok(
        await asAdmin("patch", `/admin/catalog/brands/${f.geely.id}`, {
          expectedVersion: f.geely.version,
          aliases: ["GEELY Auto", "Джили"],
        }),
        (value) => adminBrandResponseSchema.parse(value).brand,
      );
      expect(renamed).toMatchObject({ aliases: ["GEELY Auto", "Джили"], version: 2 });
      expectError(
        await asAdmin("patch", `/admin/catalog/brands/${f.geely.id}`, {
          expectedVersion: 1,
          isOem: false,
        }),
        409,
        "CATALOG_VERSION_CONFLICT",
      );

      // Search by a part of any spelling.
      const found = await ok(
        await asAdmin("get", `/admin/catalog/brands?q=${encodeURIComponent("джил")}`),
        (value) => adminBrandPageSchema.parse(value),
      );
      expect(found.brands.map((entry) => entry.name)).toEqual(["Geely"]);

      const pad = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.trw.id,
        article: "GDB3534",
        names: { ru: "Колодки TRW" },
      });
      const archived = await ok(
        await asAdmin("post", `/admin/catalog/brands/${f.trw.id}/status`, {
          expectedVersion: f.trw.version,
          status: "archived",
        }),
        (value) => adminBrandResponseSchema.parse(value).brand,
      );
      expect(archived.status).toBe("archived");
      expectError(
        await asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: f.pads.id,
          brandId: f.trw.id,
          article: "GDB1330",
          names: { ru: "Колодки TRW задние" },
        }),
        409,
        "CATALOG_BRAND_ARCHIVED",
      );
      // Nor can an existing item be moved to it…
      const other = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "4050068800",
        names: { ru: "Колодки задние" },
      });
      expectError(
        await asAdmin("patch", `/admin/catalog/items/${other.item.id}`, {
          expectedVersion: other.item.version,
          brandId: f.trw.id,
        }),
        409,
        "CATALOG_BRAND_ARCHIVED",
      );
      // …but the item that has it keeps it and can still be edited.
      const kept = await ok(
        await asAdmin("patch", `/admin/catalog/items/${pad.item.id}`, {
          expectedVersion: pad.item.version,
          names: { ru: "Колодки передние TRW" },
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(kept.item.brand).toMatchObject({ id: f.trw.id, status: "archived" });
      // An archived brand still holds its spellings.
      expectError(
        await asAdmin("post", "/admin/catalog/brands", { name: "trw" }),
        409,
        "CATALOG_BRAND_SPELLING_TAKEN",
      );
      // The database holds it too.
      await expect(
        db.query(
          "INSERT INTO brand_spelling (brand_id, text, key, is_name) VALUES ($1, $2, $3, false)",
          [f.shell.id, "GEELY AUTO", "geelyauto"],
        ),
      ).rejects.toThrow(/brand_spelling_key_key/);
    });
  });

  // -------------------------------------------------------------- items

  describe("items of three types (AC-2)", () => {
    it("checks category, brand, article and names by type; the type never changes", async () => {
      const f = await fixture();
      const refusals: [object, number, ErrorCode][] = [
        [
          { type: "part", categoryId: f.pads.id, article: "X1", names: { ru: "Без бренда" } },
          400,
          "VALIDATION_ERROR",
        ],
        [
          {
            type: "part",
            categoryId: f.pads.id,
            brandId: f.geely.id,
            names: { ru: "Без артикула" },
          },
          400,
          "VALIDATION_ERROR",
        ],
        [
          {
            type: "part",
            categoryId: f.pads.id,
            brandId: f.geely.id,
            article: " - . ",
            names: { ru: "Пустой артикул" },
          },
          400,
          "VALIDATION_ERROR",
        ],
        [
          { type: "generic", categoryId: f.oils.id, names: { ru: "Масло без бренда" } },
          400,
          "VALIDATION_ERROR",
        ],
        [
          {
            type: "service",
            categoryId: f.oilChange.id,
            brandId: f.shell.id,
            names: { ru: "Услуга с брендом" },
          },
          400,
          "VALIDATION_ERROR",
        ],
        [
          {
            type: "service",
            categoryId: f.oilChange.id,
            article: "S1",
            names: { ru: "Услуга с артикулом" },
          },
          400,
          "VALIDATION_ERROR",
        ],
        [
          {
            type: "part",
            categoryId: f.pads.id,
            brandId: f.geely.id,
            article: "X2",
            names: { kk: "Орысшасыз" },
          },
          400,
          "VALIDATION_ERROR",
        ],
        [
          {
            type: "part",
            categoryId: f.oilChange.id,
            brandId: f.geely.id,
            article: "X3",
            names: { ru: "В услугах" },
          },
          400,
          "CATALOG_KIND_MISMATCH",
        ],
        [
          { type: "service", categoryId: f.pads.id, names: { ru: "Услуга в товарах" } },
          400,
          "CATALOG_KIND_MISMATCH",
        ],
        [
          {
            type: "part",
            categoryId: f.brakesNode.id,
            brandId: f.geely.id,
            article: "X4",
            names: { ru: "В узле" },
          },
          400,
          "CATALOG_NOT_SUBCATEGORY",
        ],
        [
          {
            type: "part",
            categoryId: randomUUID(),
            brandId: f.geely.id,
            article: "X5",
            names: { ru: "Нет категории" },
          },
          404,
          "NOT_FOUND",
        ],
        [
          {
            type: "part",
            categoryId: f.pads.id,
            brandId: randomUUID(),
            article: "X6",
            names: { ru: "Нет бренда" },
          },
          404,
          "NOT_FOUND",
        ],
      ];
      for (const [body, status, code] of refusals) {
        expectError(await asAdmin("post", "/admin/catalog/items", body), status, code);
      }
      expect(await count("catalog_item")).toBe(0);

      const part = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "04465-0K090",
        names: { ru: "Колодки передние", kk: "Алдыңғы қалыптар" },
        values: [{ attributeId: f.axle.id, value: option(f.axle, "front") }],
      });
      expect(part.item).toMatchObject({
        type: "part",
        article: "04465-0K090",
        articleNorm: "044650K090",
        status: "active",
        completeness: "complete",
        brand: { id: f.geely.id, name: "Geely", isOem: true },
        names: {
          ru: { text: "Колодки передние", origin: "source" },
          kk: { text: "Алдыңғы қалыптар", origin: "manual" },
          en: null,
        },
      });
      const product = await createItem({
        ...oil(f, f.shell.id, "Shell Helix", {}),
        status: "draft",
      });
      expect(product.item).toMatchObject({
        type: "generic",
        article: null,
        status: "draft",
        completeness: "incomplete",
      });
      expect(product.missingAttributeIds.sort()).toEqual(
        [f.viscosity.id, f.approval.id, f.volume.id].sort(),
      );
      const service = await createItem({
        type: "service",
        categoryId: f.oilChange.id,
        names: { ru: "Замена масла" },
      });
      expect(service.item).toMatchObject({ type: "service", brand: null, article: null });

      // A hidden subcategory takes items; an archived one or one of an archived node doesn't.
      await ok(
        await asAdmin("post", `/admin/catalog/categories/${f.discs.id}/status`, {
          expectedVersion: f.discs.version,
          status: "hidden",
        }),
        (value) => value,
      );
      const inHidden = await createItem({
        type: "part",
        categoryId: f.discs.id,
        brandId: f.geely.id,
        article: "DISC-1",
        names: { ru: "Диск" },
      });
      await ok(
        await asAdmin("post", `/admin/catalog/categories/${f.discs.id}/status`, {
          expectedVersion: f.discs.version + 1,
          status: "archived",
        }),
        (value) => value,
      );
      expectError(
        await asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: f.discs.id,
          brandId: f.geely.id,
          article: "DISC-2",
          names: { ru: "Диск 2" },
        }),
        409,
        "CATALOG_CATEGORY_ARCHIVED",
      );
      // The item already there stays.
      expect((await card(inHidden.item.id)).item.categoryId).toBe(f.discs.id);
      await ok(
        await asAdmin("post", `/admin/catalog/categories/${f.brakesNode.id}/status`, {
          expectedVersion: f.brakesNode.version,
          status: "archived",
        }),
        (value) => value,
      );
      expectError(
        await asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: f.pads.id,
          brandId: f.geely.id,
          article: "PAD-9",
          names: { ru: "Колодки 9" },
        }),
        409,
        "CATALOG_CATEGORY_ARCHIVED",
      );
      await ok(
        await asAdmin("post", `/admin/catalog/categories/${f.brakesNode.id}/status`, {
          expectedVersion: f.brakesNode.version + 1,
          status: "active",
        }),
        (value) => value,
      );

      // The type never changes; nor does a part move to services or become brandless.
      expectError(
        await asAdmin("patch", `/admin/catalog/items/${part.item.id}`, {
          expectedVersion: part.item.version,
          type: "generic",
        }),
        400,
        "CATALOG_ITEM_TYPE_IMMUTABLE",
      );
      expectError(
        await asAdmin("patch", `/admin/catalog/items/${part.item.id}`, {
          expectedVersion: part.item.version,
          categoryId: f.oilChange.id,
        }),
        400,
        "CATALOG_KIND_MISMATCH",
      );
      for (const change of [{ brandId: null }, { article: null }]) {
        expectError(
          await asAdmin("patch", `/admin/catalog/items/${part.item.id}`, {
            expectedVersion: part.item.version,
            ...change,
          }),
          400,
          "VALIDATION_ERROR",
        );
      }
      expectError(
        await asAdmin("patch", `/admin/catalog/items/${service.item.id}`, {
          expectedVersion: service.item.version,
          brandId: f.shell.id,
        }),
        400,
        "VALIDATION_ERROR",
      );
      await expect(
        db.query("UPDATE catalog_item SET item_type = 'generic' WHERE id = $1", [part.item.id]),
      ).rejects.toThrow(/never changes/);
      await expect(
        db.query("UPDATE catalog_item SET brand_id = NULL WHERE id = $1", [part.item.id]),
      ).rejects.toThrow(/catalog_item_brand_check/);

      // Draft → active → archived → active; no deletion anywhere.
      let status = product.item.version;
      for (const next of ["active", "archived", "active"] as const) {
        const changed = await ok(
          await asAdmin("post", `/admin/catalog/items/${product.item.id}/status`, {
            expectedVersion: status,
            status: next,
          }),
          (value) => adminCatalogItemCardSchema.parse(value),
        );
        expect(changed.item.status).toBe(next);
        expect(changed.item.archivedAt === null).toBe(next !== "archived");
        status = changed.item.version;
      }
      expect(
        Object.values(apiRoutes)
          .filter(
            (route) => route.method === "DELETE" && route.path.startsWith("/admin/catalog/items"),
          )
          .map((route) => route.path),
      ).toEqual(["/admin/catalog/items/{itemId}/analogs/{analogItemId}"]);
    });

    it("moves an item to another subcategory of the same kind; values of the old one don't count there", async () => {
      const f = await fixture();
      const part = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "MOVE-1",
        names: { ru: "Колодки" },
        values: [{ attributeId: f.axle.id, value: option(f.axle, "front") }],
      });
      expect(part.item.completeness).toBe("complete");
      const moved = await ok(
        await asAdmin("patch", `/admin/catalog/items/${part.item.id}`, {
          expectedVersion: part.item.version,
          categoryId: f.discs.id,
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(moved.item.categoryId).toBe(f.discs.id);
      expect(moved.attributes).toEqual([]);
      expect(moved.values).toEqual([]);
      // Discs require something now: the item is incomplete there.
      const thickness = await attribute(f.discs.id, {
        code: "thickness",
        valueType: "number",
        names: { ru: "Толщина" },
        number: { integer: false, min: 1, max: 50 },
        isRequiredForComplete: true,
      });
      expect((await card(part.item.id)).missingAttributeIds).toEqual([thickness.id]);
      // The old value is kept (not deleted) and comes back with the item.
      const back = await ok(
        await asAdmin("patch", `/admin/catalog/items/${part.item.id}`, {
          expectedVersion: moved.item.version,
          categoryId: f.pads.id,
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(back.item.completeness).toBe("complete");
      expect(back.values).toEqual([
        expect.objectContaining({ attributeId: f.axle.id, value: option(f.axle, "front") }),
      ]);
    });
  });

  // --------------------------------------------------------- uniqueness

  describe("one article of one brand is one item (AC-3)", () => {
    it("treats spellings of one article as one, refuses a change onto a taken pair, and the database holds it", async () => {
      const f = await fixture();
      const first = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "04465-0K090",
        names: { ru: "Колодки" },
      });
      for (const article of ["04465 0k090", "044650K090", "04465.0k.090"]) {
        const refused = await asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: f.pads.id,
          brandId: f.geely.id,
          article,
          names: { ru: `Дубль ${article}` },
        });
        expectError(refused, 409, "CATALOG_ITEM_DUPLICATE");
        expect(catalogItemDuplicateDetailsSchema.parse(refused.body.details)).toEqual({
          existingItemId: first.item.id,
        });
      }
      // A product of the same brand can't take the article either (one article — one card).
      expectError(
        await asAdmin("post", "/admin/catalog/items", {
          type: "generic",
          categoryId: f.oils.id,
          brandId: f.geely.id,
          article: "04465 0K090",
          names: { ru: "Масло с тем же артикулом" },
        }),
        409,
        "CATALOG_ITEM_DUPLICATE",
      );
      // The same article of another brand is another item.
      const trw = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.trw.id,
        article: "04465-0K090",
        names: { ru: "Колодки TRW" },
      });
      // Changing brand or article onto a taken pair.
      for (const change of [
        { brandId: f.geely.id },
        { brandId: f.geely.id, article: "04465 0K090" },
      ]) {
        const refused = await asAdmin("patch", `/admin/catalog/items/${trw.item.id}`, {
          expectedVersion: trw.item.version,
          ...change,
        });
        expectError(refused, 409, "CATALOG_ITEM_DUPLICATE");
        expect(refused.body.details).toEqual({ existingItemId: first.item.id });
      }
      const other = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "4050068800",
        names: { ru: "Задние" },
      });
      const refused = await asAdmin("patch", `/admin/catalog/items/${other.item.id}`, {
        expectedVersion: other.item.version,
        article: "04465-0K-090",
      });
      expectError(refused, 409, "CATALOG_ITEM_DUPLICATE");
      expect(refused.body.details).toEqual({ existingItemId: first.item.id });
      // Archived, it still is that article.
      await asAdmin("post", `/admin/catalog/items/${first.item.id}/status`, {
        expectedVersion: first.item.version,
        status: "archived",
      });
      expectError(
        await asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: f.pads.id,
          brandId: f.geely.id,
          article: "044650k090",
          names: { ru: "Снова" },
        }),
        409,
        "CATALOG_ITEM_DUPLICATE",
      );
      // Past the server, the unique index refuses it.
      await expect(
        db.query(
          `INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id, article, article_norm)
           VALUES ('part', $1, 'goods', $2, '04465/0K090', '044650K090')`,
          [f.pads.id, f.geely.id],
        ),
      ).rejects.toThrow(/catalog_item_brand_article_key/);
      expect(await count("catalog_item")).toBe(3);
    });

    it("lets exactly one of simultaneous creations of one part in; the others get a link to it", async () => {
      const f = await fixture();
      const responses = await Promise.all(
        ["04465-0K090", "04465 0k090", "044650K090", "04465.0K090", "04465_0k090"].map(
          (article, index) =>
            asAdmin("post", "/admin/catalog/items", {
              type: "part",
              categoryId: f.pads.id,
              brandId: f.geely.id,
              article,
              names: { ru: `Колодки ${index}` },
            }),
        ),
      );
      const winners = responses.filter((response) => response.status === 201);
      expect(winners).toHaveLength(1);
      const winner = adminCatalogItemCardSchema.parse(winners[0]!.body).item.id;
      for (const response of responses.filter((entry) => entry.status !== 201)) {
        expectError(response, 409, "CATALOG_ITEM_DUPLICATE");
        expect(response.body.details).toEqual({ existingItemId: winner });
      }
      expect(await count("catalog_item")).toBe(1);
      expect(
        (await journal()).filter((entry) => entry.action === auditActions.catalogItemCreated),
      ).toHaveLength(1);
    });
  });

  describe("a product is its brand and identifying values (AC-4)", () => {
    it("refuses the same brand with the same filled values in one category; an empty value is never the same", async () => {
      const f = await fixture();
      const values = { viscosity: "5w_30", approval: "api_sp", volume: 4 };
      const first = await createItem(oil(f, f.shell.id, "Shell Helix HX8 5W-30 4 л", values));
      expect(first.item.completeness).toBe("complete");
      const refused = await asAdmin(
        "post",
        "/admin/catalog/items",
        oil(f, f.shell.id, "Shell Helix HX8 (дубль)", { ...values, volume: 4.0, note: "Другое" }),
      );
      expectError(refused, 409, "CATALOG_ITEM_DUPLICATE");
      expect(refused.body.details).toEqual({ existingItemId: first.item.id });
      // Another brand, another volume — other products.
      await createItem(oil(f, f.mobil.id, "Mobil 5W-30 4 л", values));
      await createItem(oil(f, f.shell.id, "Shell Helix HX8 5W-30 1 л", { ...values, volume: 1 }));
      // Without an approval it isn't «the same», however often.
      const noApproval = { viscosity: "5w_30", volume: 4 };
      const open1 = await createItem(oil(f, f.shell.id, "Shell без допуска 1", noApproval));
      const open2 = await createItem(oil(f, f.shell.id, "Shell без допуска 2", noApproval));
      expect(open1.item.completeness).toBe("incomplete");
      // Filling it to match the first one is refused and writes nothing.
      const filled = await asAdmin("put", `/admin/catalog/items/${open2.item.id}/values`, {
        expectedVersion: open2.item.version,
        values: [{ attributeId: f.approval.id, value: option(f.approval, "api_sp") }],
      });
      expectError(filled, 409, "CATALOG_ITEM_DUPLICATE");
      expect(filled.body.details).toEqual({ existingItemId: first.item.id });
      expect(
        (await card(open2.item.id)).values.find((v) => v.attributeId === f.approval.id)!.value,
      ).toBeNull();
      // Another approval is another product.
      const other = await ok(
        await asAdmin("put", `/admin/catalog/items/${open2.item.id}/values`, {
          expectedVersion: open2.item.version,
          values: [{ attributeId: f.approval.id, value: option(f.approval, "acea_c3") }],
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(other.item.completeness).toBe("complete");
      // Moving a product to the brand of its twin is refused as well.
      const mobilTwin = await createItem(
        oil(f, f.mobil.id, "Mobil 5W-30 SP 4 л?", {
          viscosity: "5w_30",
          approval: "acea_c3",
          volume: 4,
        }),
      );
      const moved = await asAdmin("patch", `/admin/catalog/items/${mobilTwin.item.id}`, {
        expectedVersion: mobilTwin.item.version,
        brandId: f.shell.id,
      });
      expectError(moved, 409, "CATALOG_ITEM_DUPLICATE");
      expect(moved.body.details).toEqual({ existingItemId: open2.item.id });
    });
  });

  // ------------------------------------------------------------- values

  describe("values by type (AC-5)", () => {
    it("stores numbers within bounds, active options of the attribute, yes/no and texts; refuses the rest all together", async () => {
      const f = await fixture();
      const item = await createItem(oil(f, f.shell.id, "Shell Helix", { viscosity: "5w_30" }));
      const put = (values: object[], version = item.item.version) =>
        asAdmin("put", `/admin/catalog/items/${item.item.id}/values`, {
          expectedVersion: version,
          values,
        });

      // Archive one option: it can't be chosen any more.
      const archivedOption = f.viscosity.options.find((entry) => entry.code === "0w_20")!;
      await ok(
        await asAdmin("post", `/admin/catalog/attribute-options/${archivedOption.id}/status`, {
          expectedVersion: archivedOption.version,
          status: "archived",
        }),
        (value) => value,
      );
      const refused = await put([
        { attributeId: f.volume.id, value: 400 },
        { attributeId: f.volume.id, value: 4 },
        { attributeId: f.packs.id, value: 2.5 },
        { attributeId: f.viscosity.id, value: archivedOption.id },
        { attributeId: f.approval.id, value: option(f.viscosity, "5w_40") },
        { attributeId: f.axle.id, value: option(f.axle, "front") },
        { attributeId: f.synthetic.id, value: "yes" },
        { attributeId: f.note.id, value: "я".repeat(201) },
        { attributeId: f.note.id, value: "   " },
        { attributeId: randomUUID(), value: 1 },
      ]);
      expectError(refused, 400, "CATALOG_VALUES_REJECTED");
      expect(
        catalogValuesRejectedDetailsSchema
          .parse(refused.body.details)
          .rejections.map((entry) => [entry.index, entry.reason]),
      ).toEqual([
        [0, "out_of_range"],
        [1, "repeated"],
        [2, "not_integer"],
        [3, "option_invalid"],
        [4, "option_invalid"],
        [5, "attribute_not_found"],
        [6, "wrong_type"],
        [7, "too_long"],
        [8, "repeated"],
        [9, "attribute_not_found"],
      ]);
      // Nothing of the valid ones was written either.
      expect((await card(item.item.id)).item.version).toBe(item.item.version);

      const written = await ok(
        await put([
          { attributeId: f.volume.id, value: 4.5 },
          { attributeId: f.packs.id, value: 6 },
          { attributeId: f.approval.id, value: option(f.approval, "api_sp") },
          { attributeId: f.synthetic.id, value: false },
          { attributeId: f.note.id, value: "  Для   турбомоторов " },
        ]),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(written.item).toMatchObject({
        version: item.item.version + 1,
        completeness: "complete",
      });
      const byId = new Map(written.values.map((entry) => [entry.attributeId, entry]));
      expect(byId.get(f.volume.id)).toMatchObject({ value: 4.5, source: "admin" });
      expect(byId.get(f.packs.id)!.value).toBe(6);
      expect(byId.get(f.synthetic.id)!.value).toBe(false);
      expect(byId.get(f.note.id)!.value).toBe("Для турбомоторов");
      expect(written.values.map((entry) => entry.attributeId)).toEqual(
        [f.viscosity, f.approval, f.volume, f.packs, f.note, f.synthetic].map((entry) => entry.id),
      );
      // Emptying a value removes it; the item becomes incomplete again.
      const emptied = await ok(
        await put([{ attributeId: f.volume.id, value: null }], written.item.version),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(emptied.item.completeness).toBe("incomplete");
      expect(emptied.missingAttributeIds).toEqual([f.volume.id]);
      // An old version is refused.
      expectError(
        await put([{ attributeId: f.volume.id, value: 1 }], written.item.version),
        409,
        "CATALOG_VERSION_CONFLICT",
      );
      // An archived attribute takes no new value, but its stored values stay.
      await ok(
        await asAdmin("post", `/admin/catalog/attributes/${f.note.id}/status`, {
          expectedVersion: f.note.version,
          status: "archived",
        }),
        (value) => value,
      );
      const archivedNote = await put(
        [{ attributeId: f.note.id, value: "Новое" }],
        emptied.item.version,
      );
      expectError(archivedNote, 400, "CATALOG_VALUES_REJECTED");
      expect(archivedNote.body.details.rejections[0].reason).toBe("attribute_archived");
      const afterArchive = await card(item.item.id);
      expect(afterArchive.attributes.map((entry) => entry.code)).not.toContain("note");
      const { rows } = await db.query(
        "SELECT value_text FROM item_attribute_value WHERE item_id = $1 AND attribute_id = $2",
        [item.item.id, f.note.id],
      );
      expect(rows).toEqual([{ value_text: "Для турбомоторов" }]);
      // The database refuses a value of the wrong type or an option of another attribute.
      await expect(
        db.query(
          `INSERT INTO item_attribute_value (item_id, attribute_id, attribute_value_type, value_text, source)
           VALUES ($1, $2, 'text', '5', 'admin')`,
          // The volume was emptied above: no row stands in the way.
          [item.item.id, f.volume.id],
        ),
      ).rejects.toThrow(/item_attribute_value_attribute_fkey/);
      await expect(
        db.query(
          `UPDATE item_attribute_value SET value_option_id = $1 WHERE item_id = $2 AND attribute_id = $3`,
          [option(f.axle, "front"), item.item.id, f.approval.id],
        ),
      ).rejects.toThrow(/item_attribute_value_option_fkey/);
    });
  });

  // -------------------------------------------------------- completeness

  describe("completeness (AC-6)", () => {
    it("follows the data through every event; the number of items left empty is given", async () => {
      const f = await fixture();
      const items = app.get(CatalogItemsService);
      const operator = { role: "operator" } as const;
      const ids: string[] = [];
      for (let index = 0; index < 100; index += 1) {
        const made = await items.create(
          {
            type: "part",
            categoryId: f.discs.id,
            brandId: f.trw.id,
            article: `DF${1000 + index}`,
            names: { ru: `Диск ${index}` },
          },
          operator,
        );
        ids.push(made.item.id);
      }
      const incomplete = async () =>
        adminCatalogItemPageSchema.parse(
          (
            await asAdmin(
              "get",
              `/admin/catalog/items?categoryId=${f.discs.id}&completeness=incomplete&limit=1`,
            )
          ).body,
        ).total;
      expect(await incomplete()).toBe(0);

      // A required attribute: all of them are empty — and incomplete.
      const response = await asAdmin("post", `/admin/catalog/categories/${f.discs.id}/attributes`, {
        code: "diameter",
        valueType: "number",
        names: { ru: "Диаметр" },
        number: { integer: true, min: 200, max: 400 },
        isRequiredForComplete: true,
      });
      const createdAttribute = adminAttributeResponseSchema.parse(response.body);
      expect(response.status).toBe(201);
      expect(createdAttribute.itemsWithoutValue).toBe(100);
      expect(await incomplete()).toBe(100);
      expect(await drift()).toEqual([]);
      let diameter = createdAttribute.attribute;

      // Archived: complete again; restored: incomplete again.
      for (const [status, expected] of [
        ["archived", 0],
        ["active", 100],
      ] as const) {
        const changed = adminAttributeResponseSchema.parse(
          (
            await asAdmin("post", `/admin/catalog/attributes/${diameter.id}/status`, {
              expectedVersion: diameter.version,
              status,
            })
          ).body,
        );
        diameter = changed.attribute;
        expect(await incomplete()).toBe(expected);
        expect(await drift()).toEqual([]);
      }
      // The flag off: complete; on: incomplete.
      for (const [flag, expected] of [
        [false, 0],
        [true, 100],
      ] as const) {
        const changed = adminAttributeResponseSchema.parse(
          (
            await asAdmin("patch", `/admin/catalog/attributes/${diameter.id}`, {
              expectedVersion: diameter.version,
              isRequiredForComplete: flag,
            })
          ).body,
        );
        diameter = changed.attribute;
        expect(changed.itemsWithoutValue).toBe(100);
        expect(await incomplete()).toBe(expected);
        expect(await drift()).toEqual([]);
      }
      // A value makes one complete; another category's attribute doesn't matter to it.
      const one = await card(ids[0]!);
      await ok(
        await asAdmin("put", `/admin/catalog/items/${ids[0]}/values`, {
          expectedVersion: one.item.version,
          values: [{ attributeId: diameter.id, value: 300 }],
        }),
        (value) => value,
      );
      expect(await incomplete()).toBe(99);
      // Moved to pads (axle required, empty): incomplete there; the count here drops.
      const moved = await ok(
        await asAdmin("patch", `/admin/catalog/items/${ids[1]}`, {
          expectedVersion: 1,
          categoryId: f.pads.id,
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(moved.item.completeness).toBe("incomplete");
      expect(await incomplete()).toBe(98);
      expect(await drift()).toEqual([]);
      // Incompleteness blocks nothing: an incomplete item is activated and archived.
      await ok(
        await asAdmin("post", `/admin/catalog/items/${ids[2]}/status`, {
          expectedVersion: 1,
          status: "draft",
        }),
        (value) => value,
      );
      await ok(
        await asAdmin("post", `/admin/catalog/items/${ids[2]}/status`, {
          expectedVersion: 2,
          status: "active",
        }),
        (value) => value,
      );
    }, 120_000);
  });

  // ---------------------------------------------------------- bulk fill

  describe("bulk fill (AC-7)", () => {
    it("shows only empty cells page by page, applies all cells or none, and refuses a cell changed meanwhile", async () => {
      const f = await fixture();
      const items = app.get(CatalogItemsService);
      const operator = { role: "operator" } as const;
      const ids: string[] = [];
      for (let index = 0; index < 60; index += 1) {
        const made = await items.create(
          {
            type: "generic",
            categoryId: f.oils.id,
            brandId: index % 2 === 0 ? f.shell.id : f.mobil.id,
            names: { ru: `Масло ${index}` },
            values: [
              { attributeId: f.viscosity.id, value: option(f.viscosity, "5w_30") },
              { attributeId: f.approval.id, value: option(f.approval, "api_sp") },
              ...(index < 10 ? [{ attributeId: f.volume.id, value: index + 1 }] : []),
            ],
          },
          operator,
        );
        ids.push(made.item.id);
      }
      // Only empty volumes: 50, in pages of 20 without gaps or repeats.
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `emptyAttributeId=${f.volume.id}&limit=20${cursor ? `&cursor=${cursor}` : ""}`;
        const page = await ok(
          await asAdmin("get", `/admin/catalog/categories/${f.oils.id}/fill?${query}`),
          (value) => categoryFillPageSchema.parse(value),
        );
        expect(page.total).toBe(50);
        expect(page.attributes.map((entry) => entry.code)).toEqual([
          "viscosity",
          "approval",
          "volume",
          "packs",
          "note",
          "synthetic",
        ]);
        for (const row of page.rows) {
          expect(row.values.find((value) => value.attributeId === f.volume.id)!.value).toBeNull();
          seen.push(row.item.id);
        }
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(50);
      expect(seen.sort()).toEqual(ids.slice(10).sort());

      // 50 cells, one of them wrong: nothing is written, the wrong one is named.
      const empty = ids.slice(10);
      const cells: {
        itemId: string;
        attributeId: string;
        previous: number | null;
        value: number;
      }[] = empty.map((itemId, index) => ({
        itemId,
        attributeId: f.volume.id,
        previous: null,
        value: index === 37 ? 999 : 4 + (index % 2) * 0.5,
      }));
      // Make every product distinct first: each gets its own volume below.
      cells.forEach((cell, index) => {
        if (index !== 37) {
          cell.value = 11 + index;
        }
      });
      const journalBefore = await count("audit_log");
      const refused = await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, {
        cells,
      });
      expectError(refused, 400, "CATALOG_VALUES_REJECTED");
      expect(catalogValuesRejectedDetailsSchema.parse(refused.body.details).rejections).toEqual([
        expect.objectContaining({
          index: 37,
          itemId: empty[37],
          attributeId: f.volume.id,
          reason: "out_of_range",
        }),
      ]);
      expect(await count("item_attribute_value WHERE attribute_id = '" + f.volume.id + "'")).toBe(
        10,
      );
      expect(await count("audit_log")).toBe(journalBefore);

      // Another administrator changes one cell after it was read.
      const second = await setUpAdmin(SECOND_ADMIN_PHONE);
      const theirs = await card(empty[5]!);
      await ok(
        await call(second, "put", `/admin/catalog/items/${empty[5]}/values`, {
          expectedVersion: theirs.item.version,
          values: [{ attributeId: f.volume.id, value: 5.5 }],
        }),
        (value) => value,
      );
      cells[37]!.value = 11 + 37;
      const conflict = await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, {
        cells,
      });
      expectError(conflict, 409, "CATALOG_VALUES_REJECTED");
      expect(conflict.body.details.rejections).toEqual([
        expect.objectContaining({ index: 5, reason: "conflict", currentValue: 5.5 }),
      ]);
      // Read again (5.5 now) and apply: every cell at once, one journal entry per item.
      cells[5] = { ...cells[5]!, previous: 5.5 };
      const applied = await ok(
        await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, { cells }),
        (value) => fillCategoryResponseSchema.parse(value),
      );
      expect(applied.changedCells).toBe(50);
      expect(applied.rows.map((row) => row.item.id)).toEqual(empty);
      expect(applied.rows.every((row) => row.item.completeness === "complete")).toBe(true);
      const entries = (await journal()).filter(
        (entry) =>
          entry.action === auditActions.catalogItemValuesChanged &&
          (entry.after as { via: string }).via === "fill",
      );
      expect(entries).toHaveLength(50);
      // Entries of one transaction share its time; find the one of the first item.
      expect(entries.find((entry) => entry.entityId === empty[0])).toMatchObject({
        actorRole: "admin",
        before: { values: { volume: null } },
        after: { values: { volume: 11 }, via: "fill" },
      });
      const emptyNow = await ok(
        await asAdmin(
          "get",
          `/admin/catalog/categories/${f.oils.id}/fill?emptyAttributeId=${f.volume.id}`,
        ),
        (value) => categoryFillPageSchema.parse(value),
      );
      expect(emptyNow.total).toBe(0);

      // The same value again changes nothing and journals nothing.
      const again = await ok(
        await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, {
          cells: [{ itemId: empty[0], attributeId: f.volume.id, previous: 11, value: 11 }],
        }),
        (value) => fillCategoryResponseSchema.parse(value),
      );
      expect(again).toEqual({ changedCells: 0, rows: [] });
      // Two products made the same by the fill: refused with the twin.
      const twin = await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, {
        cells: [{ itemId: empty[2], attributeId: f.volume.id, previous: 13, value: 11 }],
      });
      expectError(twin, 400, "CATALOG_VALUES_REJECTED");
      expect(twin.body.details.rejections).toEqual([
        expect.objectContaining({ index: 0, reason: "duplicate_item", existingItemId: empty[0] }),
      ]);
      // An item of another category, and the size limit.
      const pad = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "P-1",
        names: { ru: "Колодки" },
      });
      const foreign = await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, {
        cells: [{ itemId: pad.item.id, attributeId: f.volume.id, previous: null, value: 1 }],
      });
      expect(foreign.body.details.rejections[0].reason).toBe("item_not_found");
      expectError(
        await asAdmin("put", `/admin/catalog/categories/${f.oils.id}/fill`, {
          cells: Array.from({ length: 501 }, () => cells[0]),
        }),
        400,
        "VALIDATION_ERROR",
      );
    }, 120_000);
  });

  // ------------------------------------------------------------- analogs

  describe("analogs (AC-8)", () => {
    it("links two parts of one subcategory both ways, once, never with itself, a service or an archived item", async () => {
      const f = await fixture();
      const part = (brandId: string, article: string, categoryId = f.pads.id) =>
        createItem({
          type: "part",
          categoryId,
          brandId,
          article,
          names: { ru: `Деталь ${article}` },
        });
      const original = await part(f.geely.id, "04465-0K090");
      const analog = await part(f.trw.id, "GDB3534");
      const disc = await part(f.geely.id, "DISC-1", f.discs.id);
      const product = await createItem(oil(f, f.shell.id, "Масло", {}));
      const service = await createItem({
        type: "service",
        categoryId: f.oilChange.id,
        names: { ru: "Замена" },
      });

      const linked = await ok(
        await asAdmin("post", `/admin/catalog/items/${original.item.id}/analogs`, {
          analogItemId: analog.item.id,
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(linked.analogs).toEqual([
        {
          item: expect.objectContaining({ id: analog.item.id }),
          status: "approved",
          source: "admin",
        },
      ]);
      expect((await card(analog.item.id)).analogs.map((entry) => entry.item.id)).toEqual([
        original.item.id,
      ]);
      // Again, either way round: nothing changes, nothing is journaled.
      const journalBefore = await count("audit_log");
      await ok(
        await asAdmin("post", `/admin/catalog/items/${analog.item.id}/analogs`, {
          analogItemId: original.item.id,
        }),
        (value) => value,
      );
      expect(await count("audit_log")).toBe(journalBefore);
      expect(await count("item_analog")).toBe(1);

      const invalid = async (itemId: string, analogItemId: string, reason: string) => {
        const refused = await asAdmin("post", `/admin/catalog/items/${itemId}/analogs`, {
          analogItemId,
        });
        expectError(refused, 400, "CATALOG_ANALOG_INVALID");
        expect(catalogAnalogInvalidDetailsSchema.parse(refused.body.details).reason).toBe(reason);
      };
      await invalid(original.item.id, original.item.id, "self");
      await invalid(original.item.id, disc.item.id, "other_category");
      await invalid(original.item.id, product.item.id, "not_part");
      await invalid(service.item.id, original.item.id, "not_part");
      expectError(
        await asAdmin("post", `/admin/catalog/items/${original.item.id}/analogs`, {
          analogItemId: randomUUID(),
        }),
        404,
        "NOT_FOUND",
      );
      // An archived item takes no new links; its existing one stays.
      const third = await part(f.geely.id, "PAD-3");
      await asAdmin("post", `/admin/catalog/items/${analog.item.id}/status`, {
        expectedVersion: analog.item.version,
        status: "archived",
      });
      await invalid(third.item.id, analog.item.id, "archived");
      expect((await card(original.item.id)).analogs[0]!.item.status).toBe("archived");
      // An item with analogs stays in its subcategory.
      expectError(
        await asAdmin("patch", `/admin/catalog/items/${original.item.id}`, {
          expectedVersion: original.item.version,
          categoryId: f.discs.id,
        }),
        409,
        "CATALOG_ITEM_HAS_ANALOGS",
      );
      // The database keeps pairs single and ordered.
      const [low, high] = [original.item.id, analog.item.id].sort();
      await expect(
        db.query(
          "INSERT INTO item_analog (item_id, analog_item_id, category_id) VALUES ($1, $2, $3)",
          [high, low, f.pads.id],
        ),
      ).rejects.toThrow(/item_analog_order_check/);
      await expect(
        db.query(
          "INSERT INTO item_analog (item_id, analog_item_id, category_id) VALUES ($1, $2, $3)",
          [low, high, f.pads.id],
        ),
      ).rejects.toThrow(/item_analog_pkey/);
      // Removed from either side.
      const unlinked = await ok(
        await asAdmin(
          "delete",
          `/admin/catalog/items/${analog.item.id}/analogs/${original.item.id}`,
        ),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      expect(unlinked.analogs).toEqual([]);
      expect((await card(original.item.id)).analogs).toEqual([]);
      expectError(
        await asAdmin(
          "delete",
          `/admin/catalog/items/${analog.item.id}/analogs/${original.item.id}`,
        ),
        404,
        "NOT_FOUND",
      );
      const actions = (await journal()).map((entry) => entry.action);
      expect(actions.filter((action) => action.startsWith("catalog_item.analog"))).toEqual([
        auditActions.catalogItemAnalogLinked,
        auditActions.catalogItemAnalogUnlinked,
      ]);
    });
  });

  // -------------------------------------------------------------- search

  describe("search and paging (AC-9)", () => {
    it("finds by a part of the normalized article and by a name in any language, with filters, page by page", async () => {
      const f = await fixture();
      const pads = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "04465-0K090",
        names: {
          ru: "Колодки тормозные передние",
          kk: "Алдыңғы тежегіш қалыптары",
          en: "Front brake pads",
        },
        values: [{ attributeId: f.axle.id, value: option(f.axle, "front") }],
      });
      const trw = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.trw.id,
        article: "GDB3534",
        names: { ru: "Колодки TRW 50%_off" },
      });
      const shell = await createItem(
        oil(f, f.shell.id, "Shell Helix Ultra", { viscosity: "5w_30" }),
      );
      const service = await createItem({
        type: "service",
        categoryId: f.oilChange.id,
        names: { ru: "Замена моторного масла", kk: "Мотор майын ауыстыру" },
      });
      const search = async (query: string) =>
        adminCatalogItemPageSchema
          .parse((await asAdmin("get", `/admin/catalog/items?${query}`)).body)
          .items.map((item) => item.id);

      expect(await search(`q=${encodeURIComponent("04465 0k090")}`)).toEqual([pads.item.id]);
      expect(await search("q=0k09")).toEqual([pads.item.id]);
      expect(await search("q=gdb-35")).toEqual([trw.item.id]);
      expect(await search(`q=${encodeURIComponent("тежегіш")}`)).toEqual([pads.item.id]);
      expect(await search(`q=${encodeURIComponent("МАЙЫН")}`)).toEqual([service.item.id]);
      expect(await search("q=brake%20PADS")).toEqual([pads.item.id]);
      expect((await search(`q=${encodeURIComponent("колодки")}`)).sort()).toEqual(
        [pads.item.id, trw.item.id].sort(),
      );
      // `%` and `_` are letters here, not patterns.
      expect(await search(`q=${encodeURIComponent("%_off")}`)).toEqual([trw.item.id]);
      expect(await search(`q=${encodeURIComponent("%")}`)).toEqual([trw.item.id]);
      // Filters.
      expect(await search(`brandId=${f.trw.id}`)).toEqual([trw.item.id]);
      expect(await search("type=service")).toEqual([service.item.id]);
      expect(await search(`categoryId=${f.oils.id}`)).toEqual([shell.item.id]);
      expect(await search("completeness=incomplete")).toEqual([shell.item.id, trw.item.id]);
      await asAdmin("post", `/admin/catalog/items/${trw.item.id}/status`, {
        expectedVersion: trw.item.version,
        status: "draft",
      });
      expect(await search("status=draft")).toEqual([trw.item.id]);
      expect(await search(`q=colodki&type=part`)).toEqual([]);

      // Paging: newest first, no gaps or repeats even when items appear meanwhile.
      const more: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        more.push(
          (
            await createItem({
              type: "service",
              categoryId: f.oilChange.id,
              names: { ru: `Услуга ${index}` },
            })
          ).item.id,
        );
      }
      const all = [...more.reverse(), service.item.id, shell.item.id, trw.item.id, pads.item.id];
      const read: string[] = [];
      let cursor: string | null = null;
      let first = true;
      do {
        const page = adminCatalogItemPageSchema.parse(
          (await asAdmin("get", `/admin/catalog/items?limit=3${cursor ? `&cursor=${cursor}` : ""}`))
            .body,
        );
        expect(page.total).toBe(first ? 11 : 12);
        read.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        if (first) {
          // A new item after the first page doesn't shift the next ones.
          await createItem({ type: "service", categoryId: f.oilChange.id, names: { ru: "Позже" } });
          first = false;
        }
      } while (cursor);
      expect(read).toEqual(all);
      expectError(
        await asAdmin("get", "/admin/catalog/items?cursor=bm90LWEtY3Vyc29y"),
        400,
        "VALIDATION_ERROR",
      );
      expectError(await asAdmin("get", "/admin/catalog/items?limit=101"), 400, "VALIDATION_ERROR");
    });
  });

  // ------------------------------------------------ journal, edits, access

  describe("journal and simultaneous edits (AC-10)", () => {
    it("records every change with its author in the transaction; a refused change leaves no entry", async () => {
      const f = await fixture();
      const item = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "04465-0K090",
        names: { ru: "Колодки" },
        values: [{ attributeId: f.axle.id, value: option(f.axle, "front") }],
      });
      const changed = await ok(
        await asAdmin("patch", `/admin/catalog/items/${item.item.id}`, {
          expectedVersion: 1,
          names: { en: "Pads" },
          article: "04465-0K091",
        }),
        (value) => adminCatalogItemCardSchema.parse(value),
      );
      await ok(
        await asAdmin("put", `/admin/catalog/items/${item.item.id}/values`, {
          expectedVersion: changed.item.version,
          values: [{ attributeId: f.axle.id, value: option(f.axle, "rear") }],
        }),
        (value) => value,
      );
      await ok(
        await asAdmin("post", `/admin/catalog/items/${item.item.id}/status`, {
          expectedVersion: changed.item.version + 1,
          status: "archived",
        }),
        (value) => value,
      );
      const before = await count("audit_log");
      expectError(
        await asAdmin("post", "/admin/catalog/items", {
          type: "part",
          categoryId: f.pads.id,
          brandId: f.geely.id,
          article: "04465 0k091",
          names: { ru: "Дубль" },
        }),
        409,
        "CATALOG_ITEM_DUPLICATE",
      );
      expect(await count("audit_log")).toBe(before);

      const entries = (await journal()).filter((entry) => entry.entityId === item.item.id);
      expect(entries.map((entry) => [entry.action, entry.actorRole])).toEqual([
        [auditActions.catalogItemCreated, "admin"],
        [auditActions.catalogItemChanged, "admin"],
        [auditActions.catalogItemValuesChanged, "admin"],
        [auditActions.catalogItemStatusChanged, "admin"],
      ]);
      expect(entries[0]!.after).toMatchObject({
        type: "part",
        article: "04465-0K090",
        articleNorm: "044650K090",
        values: { axle: "front" },
      });
      expect(entries[1]).toMatchObject({
        before: { article: "04465-0K090", names: { en: null } },
        after: {
          article: "04465-0K091",
          articleNorm: "044650K091",
          names: { en: "Pads" },
          version: 2,
        },
      });
      expect(entries[2]).toMatchObject({
        before: { values: { axle: "front" } },
        after: { values: { axle: "rear" }, via: "item", version: 3 },
      });
      const brandEntries = (await journal()).filter((entry) => entry.entityId === f.geely.id);
      expect(brandEntries.map((entry) => entry.action)).toEqual([auditActions.catalogBrandCreated]);
    });

    it("never overwrites someone else's change silently", async () => {
      const f = await fixture();
      const item = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "SAME-1",
        names: { ru: "Колодки" },
      });
      const second = await setUpAdmin(SECOND_ADMIN_PHONE);
      const [mine, theirs] = await Promise.all([
        asAdmin("patch", `/admin/catalog/items/${item.item.id}`, {
          expectedVersion: 1,
          names: { ru: "Колодки передние" },
        }),
        call(second, "patch", `/admin/catalog/items/${item.item.id}`, {
          expectedVersion: 1,
          names: { ru: "Колодки задние" },
        }),
      ]);
      const statuses = [mine.status, theirs.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = mine.status === 409 ? mine : theirs;
      expectError(loser, 409, "CATALOG_VERSION_CONFLICT");
      expect(loser.body.details).toEqual({ currentVersion: 2 });
      const winner = mine.status === 200 ? "Колодки передние" : "Колодки задние";
      expect((await card(item.item.id)).item.names.ru!.text).toBe(winner);
    });
  });

  describe("access (AC-11)", () => {
    it("serves brands, items and the fill to an admin session only", async () => {
      const f = await fixture();
      const routes = Object.values(apiRoutes).filter(
        (route) =>
          route.path.startsWith("/admin/catalog/brands") ||
          route.path.startsWith("/admin/catalog/items") ||
          route.path.endsWith("/fill"),
      );
      expect(routes).toHaveLength(14);
      const item = await createItem({
        type: "part",
        categoryId: f.pads.id,
        brandId: f.geely.id,
        article: "A-1",
        names: { ru: "Колодки" },
      });
      const ids: Record<string, string> = {
        brandId: f.geely.id,
        itemId: item.item.id,
        analogItemId: randomUUID(),
        categoryId: f.pads.id,
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
      const before = { items: await count("catalog_item"), journal: await count("audit_log") };
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
          expectError(
            await test.send({ name: "Чужой", expectedVersion: 1, status: "archived", cells: [] }),
            caller.status,
            caller.code as ErrorCode,
          );
        }
      }
      expect({ items: await count("catalog_item"), journal: await count("audit_log") }).toEqual(
        before,
      );
    });
  });

  // ----------------------------------------------------------- dev seed

  describe("development seed (AC-12)", () => {
    it("adds brands, items and a pair of analogs once", async () => {
      const seed = app.get(DevCatalogSeed);
      await seed.run();
      const counts = {
        brands: await count("brand"),
        items: await count("catalog_item"),
        values: await count("item_attribute_value"),
        analogs: await count("item_analog"),
        texts: await count("translation"),
      };
      expect(counts).toMatchObject({ brands: 4, items: 10, analogs: 1 });
      const second = await seed.run();
      expect(second.existing).toMatchObject({ brands: 4, items: 10, analogs: 1 });
      expect({
        brands: await count("brand"),
        items: await count("catalog_item"),
        values: await count("item_attribute_value"),
        analogs: await count("item_analog"),
        texts: await count("translation"),
      }).toEqual(counts);
      const page = adminCatalogItemPageSchema.parse(
        (await asAdmin("get", "/admin/catalog/items?completeness=incomplete")).body,
      );
      expect(page.items.map((item) => item.names.ru!.text).sort()).toEqual([
        "Mobil 1 ESP 5W-30",
        "Shell Helix Ultra 0W-20, 1 л",
      ]);
      expect(
        adminCatalogItemPageSchema.parse(
          (await asAdmin("get", "/admin/catalog/items?type=service")).body,
        ).total,
      ).toBe(3);
    });
  });

  // ------------------------------------------------- what must work in dev

  describe("what must work in dev (TASK-011)", () => {
    it("walks the scenarios of the task", async () => {
      await app.get(DevCatalogSeed).run();
      // 1. Find the pads by «04465 0k090».
      const found = adminCatalogItemPageSchema.parse(
        (await asAdmin("get", `/admin/catalog/items?q=${encodeURIComponent("04465 0k090")}`)).body,
      );
      expect(found.items).toHaveLength(1);
      const pads = found.items[0]!;
      expect(pads).toMatchObject({ article: "04465-0K090", brand: { name: "Geely" } });

      // 2. The same part written «044650K090» is refused with a link.
      const duplicate = await asAdmin("post", "/admin/catalog/items", {
        type: "part",
        categoryId: pads.categoryId,
        brandId: pads.brand!.id,
        article: "044650K090",
        names: { ru: "Колодки ещё раз" },
      });
      expectError(duplicate, 409, "CATALOG_ITEM_DUPLICATE");
      expect(duplicate.body.details).toEqual({ existingItemId: pads.id });

      // 3. A required attribute on engine oils → N empty → listed incomplete → filled at once → none.
      const tree = adminCategoryTreeResponseSchema.parse(
        (await asAdmin("get", "/admin/catalog/categories")).body,
      );
      const oils = tree.categories
        .flatMap((node) => node.children)
        .find((entry) => entry.code === "engine_oils")!;
      const added = await asAdmin("post", `/admin/catalog/categories/${oils.id}/attributes`, {
        code: "base",
        valueType: "enum",
        names: { ru: "Основа" },
        isRequiredForComplete: true,
        options: [
          { code: "synthetic", names: { ru: "Синтетика" } },
          { code: "semi", names: { ru: "Полусинтетика" } },
        ],
      });
      const base = adminAttributeResponseSchema.parse(added.body);
      expect(base.itemsWithoutValue).toBe(4);
      const incomplete = adminCatalogItemPageSchema.parse(
        (await asAdmin("get", `/admin/catalog/items?categoryId=${oils.id}&completeness=incomplete`))
          .body,
      );
      expect(incomplete.total).toBe(4);
      const table = categoryFillPageSchema.parse(
        (
          await asAdmin(
            "get",
            `/admin/catalog/categories/${oils.id}/fill?emptyAttributeId=${base.attribute.id}`,
          )
        ).body,
      );
      const attributes = adminAttributeListResponseSchema.parse(
        (await asAdmin("get", `/admin/catalog/categories/${oils.id}/attributes`)).body,
      ).attributes;
      const approval = attributes.find((entry) => entry.code === "approval")!;
      const volume = attributes.find((entry) => entry.code === "volume")!;
      const cells = table.rows.flatMap((row) => {
        const value = (id: string) => row.values.find((entry) => entry.attributeId === id)!.value;
        return [
          {
            itemId: row.item.id,
            attributeId: base.attribute.id,
            previous: null,
            value: base.attribute.options[0]!.id,
          },
          ...(value(approval.id) === null
            ? [
                {
                  itemId: row.item.id,
                  attributeId: approval.id,
                  previous: null,
                  value: approval.options[0]!.id,
                },
              ]
            : []),
          ...(value(volume.id) === null
            ? [{ itemId: row.item.id, attributeId: volume.id, previous: null, value: 5 }]
            : []),
        ];
      });
      // 4. One wrong cell: nothing is applied, the cell is named.
      const wrong = cells.map((cell, index) => (index === 1 ? { ...cell, value: 1000 } : cell));
      const refused = await asAdmin("put", `/admin/catalog/categories/${oils.id}/fill`, {
        cells: wrong,
      });
      expectError(refused, 400, "CATALOG_VALUES_REJECTED");
      expect(refused.body.details.rejections).toHaveLength(1);
      expect(refused.body.details.rejections[0].index).toBe(1);
      await ok(
        await asAdmin("put", `/admin/catalog/categories/${oils.id}/fill`, { cells }),
        (value) => fillCategoryResponseSchema.parse(value),
      );
      expect(
        adminCatalogItemPageSchema.parse(
          (
            await asAdmin(
              "get",
              `/admin/catalog/items?categoryId=${oils.id}&completeness=incomplete`,
            )
          ).body,
        ).total,
      ).toBe(0);

      // 5. Link two pads as analogs → each card shows the other → unlink.
      const rear = adminCatalogItemPageSchema.parse(
        (await asAdmin("get", "/admin/catalog/items?q=4050068800")).body,
      ).items[0]!;
      await ok(
        await asAdmin("post", `/admin/catalog/items/${pads.id}/analogs`, { analogItemId: rear.id }),
        (value) => value,
      );
      expect((await card(rear.id)).analogs.map((entry) => entry.item.id)).toEqual([pads.id]);
      expect((await card(pads.id)).analogs.map((entry) => entry.item.id)).toContain(rear.id);
      await ok(
        await asAdmin("delete", `/admin/catalog/items/${pads.id}/analogs/${rear.id}`),
        (value) => value,
      );
      expect((await card(rear.id)).analogs).toEqual([]);

      // 6. Everything is in the journal with its author.
      const actions = (await journal())
        .filter((entry) => entry.actorRole === "admin")
        .map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          auditActions.catalogAttributeCreated,
          auditActions.catalogItemValuesChanged,
          auditActions.catalogItemAnalogLinked,
          auditActions.catalogItemAnalogUnlinked,
        ]),
      );
    });
  });
});
