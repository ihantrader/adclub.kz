import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminAttributeListResponseSchema,
  adminAttributeOptionResponseSchema,
  adminAttributeResponseSchema,
  adminCategoryResponseSchema,
  adminCategoryTreeResponseSchema,
  apiErrorResponseSchema,
  apiRoutes,
  auditActions,
  auditLogPageSchema,
  CATALOG_CLIENT_CACHE_SECONDS,
  catalogOrderConflictDetailsSchema,
  categoryAttributesResponseSchema,
  categoryTreeResponseSchema,
  isUploadRoute,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminAttribute,
  type AdminCategory,
  type ApiRouteDefinition,
  type ErrorCode,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import sharp from "sharp";
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
import { DevCatalogSeed, devCatalogTree } from ".";

/**
 * TASK-010 end to end on a real PostgreSQL: two levels held by the server
 * and by the database, the administrator's categories, attributes and list
 * options with their journal and version conflicts, the client tree and
 * attribute descriptions (guests included) with the language fallback and
 * caching, the access matrix and the development seed.
 */

const ADMIN_PHONE = "+77011234567";
const USER_PHONE = "+77471112233";
const MEMBER_PHONE = "+77051234000";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";

type Method = "get" | "post" | "put" | "patch";

describe("catalog structure (PostgreSQL + Redis)", () => {
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
  /** The administrator's access token of the current test. */
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
    // A real port: concurrent requests (the simultaneous edit test) share one
    // listening server instead of supertest opening one per request.
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
    token = await setUpAdmin();
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
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

  async function cabinetToken(): Promise<string> {
    const operator = app.get(OperatorService);
    const { supplierId } = await operator.createSupplier({ name: "Автомаркет", city: "Алматы" });
    await operator.addMember({ supplierId, phone: MEMBER_PHONE, displayName: "Айгерим" });
    const response = await signIn(MEMBER_PHONE, SUPPLIER_WEB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
  }

  function asAdmin(method: Method, path: string, body?: object): Test {
    const call = http()
      [method](path)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${token}`);
    return body ? call.send(body) : call;
  }

  function asGuest(path: string, lang?: string): Test {
    const call = http().get(path).set("X-Client", IOS);
    return lang === undefined ? call : call.set("Accept-Language", lang);
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  async function createCategory(body: object): Promise<AdminCategory> {
    const response = await asAdmin("post", "/admin/catalog/categories", body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return adminCategoryResponseSchema.parse(response.body).category;
  }

  async function createAttribute(categoryId: string, body: object): Promise<AdminAttribute> {
    const response = await asAdmin(
      "post",
      `/admin/catalog/categories/${categoryId}/attributes`,
      body,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return adminAttributeResponseSchema.parse(response.body).attribute;
  }

  /** A goods node with one subcategory. */
  async function brakes(): Promise<{ node: AdminCategory; pads: AdminCategory }> {
    const node = await createCategory({
      code: "brakes",
      kind: "goods",
      names: { ru: "Тормоза", kk: "Тежегіштер", en: "Brakes" },
      icon: "disc",
    });
    const pads = await createCategory({
      code: "brake_pads",
      kind: "goods",
      parentId: node.id,
      names: { ru: "Тормозные колодки" },
      compatibilityRequired: true,
    });
    return { node, pads };
  }

  async function journalActions(): Promise<string[]> {
    const response = await asAdmin("get", "/admin/audit-log?limit=100");
    expect(response.status).toBe(200);
    return auditLogPageSchema
      .parse(response.body)
      .entries.map((entry) => entry.action)
      .reverse();
  }

  async function count(table: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    return Number(rows[0]!.count);
  }

  describe("two levels (AC-1)", () => {
    it("refuses a third level and a subcategory of the other kind on the server", async () => {
      const { node, pads } = await brakes();
      expectError(
        await asAdmin("post", "/admin/catalog/categories", {
          code: "front_pads",
          kind: "goods",
          parentId: pads.id,
          names: { ru: "Передние" },
        }),
        400,
        "CATALOG_DEPTH_EXCEEDED",
      );
      expectError(
        await asAdmin("post", "/admin/catalog/categories", {
          code: "brake_service",
          kind: "services",
          parentId: node.id,
          names: { ru: "Ремонт тормозов" },
        }),
        400,
        "CATALOG_KIND_MISMATCH",
      );
      // A node stays a node, a subcategory stays a subcategory, a kind never changes.
      const other = await createCategory({
        code: "engine",
        kind: "goods",
        names: { ru: "Двигатель" },
      });
      expectError(
        await asAdmin("patch", `/admin/catalog/categories/${other.id}`, {
          expectedVersion: 1,
          parentId: node.id,
        }),
        400,
        "CATALOG_LEVEL_IMMUTABLE",
      );
      expectError(
        await asAdmin("patch", `/admin/catalog/categories/${pads.id}`, {
          expectedVersion: 1,
          parentId: null,
        }),
        400,
        "CATALOG_LEVEL_IMMUTABLE",
      );
      expectError(
        await asAdmin("patch", `/admin/catalog/categories/${node.id}`, {
          expectedVersion: 1,
          kind: "services",
        }),
        400,
        "CATALOG_KIND_MISMATCH",
      );
      // Attributes only on a subcategory.
      expectError(
        await asAdmin("post", `/admin/catalog/categories/${node.id}/attributes`, {
          code: "size",
          valueType: "text",
          names: { ru: "Размер" },
        }),
        400,
        "CATALOG_NOT_SUBCATEGORY",
      );
      expect(await count("category")).toBe(3);
    });

    it("can't be broken in the database either", async () => {
      const { node, pads } = await brakes();
      const services = await createCategory({
        code: "service_node",
        kind: "services",
        names: { ru: "Услуги" },
      });
      const refused = async (statement: string, params: unknown[]) => {
        await expect(db.query(statement, params)).rejects.toThrow();
      };
      const insert =
        "INSERT INTO category (code, kind, level, parent_id, parent_level) VALUES ($1, $2, $3, $4, $5)";
      // Under a subcategory: the parent must be (id, kind, 1).
      await refused(insert, ["third", "goods", 2, pads.id, 1]);
      await refused(insert, ["third2", "goods", 3, pads.id, 2]);
      // Of the other kind.
      await refused(insert, ["mixed", "services", 2, node.id, 1]);
      // A node can't be turned into a subcategory while it has subcategories,
      // nor change its kind.
      await refused(
        "UPDATE category SET level = 2, parent_id = $1, parent_level = 1 WHERE id = $2",
        [services.id, node.id],
      );
      await refused("UPDATE category SET kind = 'services' WHERE id = $1", [node.id]);
      // An attribute on a node; an option of a non-list attribute; a type change.
      await refused(
        "INSERT INTO attribute (category_id, category_level, code, value_type) VALUES ($1, 1, 'x', 'text')",
        [node.id],
      );
      await refused(
        "INSERT INTO attribute (category_id, code, value_type) VALUES ($1, 'x', 'text')",
        [node.id],
      );
      const text = await createAttribute(pads.id, {
        code: "note",
        valueType: "text",
        names: { ru: "Примечание" },
      });
      await refused(
        "INSERT INTO attribute_option (attribute_id, attribute_value_type, code) VALUES ($1, 'text', 'a')",
        [text.id],
      );
      await refused("INSERT INTO attribute_option (attribute_id, code) VALUES ($1, 'a')", [
        text.id,
      ]);
      await refused("UPDATE attribute SET value_type = 'bool' WHERE id = $1", [text.id]);
      await refused("UPDATE attribute SET is_filterable = true WHERE id = $1", [text.id]);
      await refused("UPDATE category SET compatibility_required = true WHERE id = $1", [node.id]);
      expect(await count("category")).toBe(3);
      expect(await count("attribute_option")).toBe(0);
    });
  });

  describe("categories (AC-2)", () => {
    it("creates, renames, moves, orders, hides, archives and restores, with names in three languages", async () => {
      const { node, pads } = await brakes();
      expect(node).toMatchObject({
        level: 1,
        parentId: null,
        icon: "disc",
        sort: 0,
        status: "active",
        visibleToClients: true,
        version: 1,
        names: {
          ru: { text: "Тормоза", origin: "source", isManuallyEdited: true },
          kk: { text: "Тежегіштер", origin: "manual", isManuallyEdited: true },
          en: { text: "Brakes", origin: "manual", isManuallyEdited: true },
        },
      });
      expect(pads).toMatchObject({
        level: 2,
        parentId: node.id,
        compatibilityRequired: true,
        names: { kk: null, en: null },
      });

      // Rename (spaces brought to one form), add Kazakh, clear nothing else.
      const renamed = await asAdmin("patch", `/admin/catalog/categories/${pads.id}`, {
        expectedVersion: 1,
        names: { ru: "  Колодки   тормозные ", kk: "Тежегіш қалыптары" },
        icon: "disc",
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const afterRename = adminCategoryResponseSchema.parse(renamed.body).category;
      expect(afterRename).toMatchObject({
        version: 2,
        icon: "disc",
        names: { ru: { text: "Колодки тормозные" }, kk: { text: "Тежегіш қалыптары" }, en: null },
      });
      // The code never changes; the translation remembers the Russian text it was written for.
      expect(afterRename.code).toBe("brake_pads");
      const { rows } = await db.query<{ source_hash: string | null; origin: string }>(
        "SELECT source_hash, origin FROM translation WHERE entity_id = $1 AND lang = 'kk'",
        [pads.id],
      );
      expect(rows[0]).toMatchObject({ origin: "manual" });
      expect(rows[0]!.source_hash).toMatch(/^[0-9a-f]{64}$/);

      // Move to another node of the same kind: to the end of its children.
      const suspension = await createCategory({
        code: "suspension",
        kind: "goods",
        names: { ru: "Подвеска" },
      });
      await createCategory({
        code: "shocks",
        kind: "goods",
        parentId: suspension.id,
        names: { ru: "Амортизаторы" },
      });
      const moved = await asAdmin("patch", `/admin/catalog/categories/${pads.id}`, {
        expectedVersion: 2,
        parentId: suspension.id,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(adminCategoryResponseSchema.parse(moved.body).category).toMatchObject({
        parentId: suspension.id,
        sort: 1,
        version: 3,
      });

      // Order of the goods nodes.
      const reordered = await asAdmin("put", "/admin/catalog/categories/order", {
        parentId: null,
        kind: "goods",
        categoryIds: [suspension.id, node.id],
      });
      expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
      expect(
        adminCategoryTreeResponseSchema.parse(reordered.body).categories.map((entry) => entry.code),
      ).toEqual(["suspension", "brakes"]);
      expectError(
        await asAdmin("put", "/admin/catalog/categories/order", {
          parentId: null,
          kind: "goods",
          categoryIds: [suspension.id],
        }),
        409,
        "CATALOG_ORDER_MISMATCH",
      );
      expectError(
        await asAdmin("put", "/admin/catalog/categories/order", {
          parentId: null,
          kind: "goods",
          categoryIds: [suspension.id, suspension.id],
        }),
        409,
        "CATALOG_ORDER_MISMATCH",
      );

      // Hide, archive, restore.
      const status = async (id: string, value: string, expectedVersion: number) =>
        asAdmin("post", `/admin/catalog/categories/${id}/status`, {
          status: value,
          expectedVersion,
        });
      const hidden = await status(node.id, "hidden", 1);
      expect(adminCategoryResponseSchema.parse(hidden.body).category).toMatchObject({
        status: "hidden",
        visibleToClients: false,
        version: 2,
      });
      const archived = await status(node.id, "archived", 2);
      expect(adminCategoryResponseSchema.parse(archived.body).category).toMatchObject({
        status: "archived",
      });
      expect(adminCategoryResponseSchema.parse(archived.body).category.archivedAt).not.toBeNull();
      const restored = await status(node.id, "active", 3);
      expect(adminCategoryResponseSchema.parse(restored.body).category).toMatchObject({
        status: "active",
        archivedAt: null,
        visibleToClients: true,
      });
      // No route deletes a catalog entry; the one DELETE (TASK-011) removes
      // a link between two items, never an item.
      expect(
        Object.values(apiRoutes)
          .filter((route) => route.path.startsWith("/admin/catalog") && route.method === "DELETE")
          .map((route) => route.path),
      ).toEqual(["/admin/catalog/items/{itemId}/analogs/{analogItemId}"]);
    });

    it("checks names, icons, codes and the compatibility flag", async () => {
      const { node, pads } = await brakes();
      const create = (body: object) => asAdmin("post", "/admin/catalog/categories", body);
      // Russian is required; empty, too long or with control characters is refused.
      expectError(
        await create({ code: "a1", kind: "goods", names: { kk: "Қ" } }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await create({ code: "a2", kind: "goods", names: { ru: "   " } }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await create({ code: "a3", kind: "goods", names: { ru: "x", kk: "қ".repeat(41) } }),
        400,
        "VALIDATION_ERROR",
      );
      const longest = await create({
        code: "a4",
        kind: "goods",
        names: { ru: "x", kk: "қ".repeat(40) },
      });
      expect(longest.status).toBe(201);
      expectError(
        await create({ code: "a5", kind: "goods", names: { ru: "ab" } }),
        400,
        "VALIDATION_ERROR",
      );
      // Unknown icon; code format; a taken code.
      expectError(
        await create({ code: "a6", kind: "goods", names: { ru: "y" }, icon: "rocket" }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await create({ code: "Bad Code", kind: "goods", names: { ru: "z" } }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await create({ code: "brakes", kind: "goods", names: { ru: "z" } }),
        409,
        "CATALOG_CODE_TAKEN",
      );
      // Case-insensitive names among neighbours, on every language; fine in another node.
      const clash = await create({
        code: "pads_again",
        kind: "goods",
        parentId: node.id,
        names: { ru: "тормозные КОЛОДКИ" },
      });
      expectError(clash, 409, "CATALOG_NAME_TAKEN");
      expect(clash.body.details).toEqual({ lang: "ru", conflictingId: pads.id });
      const engine = await createCategory({
        code: "engine",
        kind: "goods",
        names: { ru: "Двигатель" },
      });
      expect(
        (
          await create({
            code: "engine_pads",
            kind: "goods",
            parentId: engine.id,
            names: { ru: "Тормозные колодки" },
          })
        ).status,
      ).toBe(201);
      expectError(
        await create({ code: "brakes2", kind: "goods", names: { ru: "Другое", en: "brakes" } }),
        409,
        "CATALOG_NAME_TAKEN",
      );
      // The same name as a goods node is fine among services (other siblings).
      expect(
        (await create({ code: "brakes_services", kind: "services", names: { ru: "Тормоза" } }))
          .status,
      ).toBe(201);
      // Compatibility only for a subcategory of goods.
      expectError(
        await create({
          code: "n1",
          kind: "goods",
          names: { ru: "Узел" },
          compatibilityRequired: true,
        }),
        400,
        "VALIDATION_ERROR",
      );
      // An archived neighbour frees its name; restoring it then clashes.
      await asAdmin("post", `/admin/catalog/categories/${pads.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      const successor = await createCategory({
        code: "pads_new",
        kind: "goods",
        parentId: node.id,
        names: { ru: "Тормозные колодки" },
      });
      expectError(
        await asAdmin("post", `/admin/catalog/categories/${pads.id}/status`, {
          status: "active",
          expectedVersion: 2,
        }),
        409,
        "CATALOG_NAME_TAKEN",
      );
      expect(successor.sort).toBe(1);
    });

    it("keeps subcategories of an archived node out of the way until it is back", async () => {
      const { node, pads } = await brakes();
      await asAdmin("post", `/admin/catalog/categories/${node.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      // The subcategory itself is untouched but not visible.
      const tree = adminCategoryTreeResponseSchema.parse(
        (await asAdmin("get", "/admin/catalog/categories")).body,
      );
      expect(tree.categories[0]!.children[0]).toMatchObject({
        id: pads.id,
        status: "active",
        visibleToClients: false,
      });
      // Hiding a subcategory, then restoring it under the archived node: refused.
      const hidden = await asAdmin("post", `/admin/catalog/categories/${pads.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      expect(hidden.status).toBe(200);
      expectError(
        await asAdmin("post", `/admin/catalog/categories/${pads.id}/status`, {
          status: "active",
          expectedVersion: 2,
        }),
        409,
        "CATALOG_PARENT_ARCHIVED",
      );
      // Nothing new under an archived node, nothing moved there.
      expectError(
        await asAdmin("post", "/admin/catalog/categories", {
          code: "discs",
          kind: "goods",
          parentId: node.id,
          names: { ru: "Диски" },
        }),
        409,
        "CATALOG_PARENT_ARCHIVED",
      );
      await asAdmin("post", `/admin/catalog/categories/${node.id}/status`, {
        status: "active",
        expectedVersion: 2,
      });
      const back = await asAdmin("post", `/admin/catalog/categories/${pads.id}/status`, {
        status: "active",
        expectedVersion: 2,
      });
      expect(adminCategoryResponseSchema.parse(back.body).category.visibleToClients).toBe(true);
    });
  });

  describe("attributes (AC-3)", () => {
    it("has four types with units, bounds and options; text is never a filter; the type never changes", async () => {
      const { pads } = await brakes();
      const volume = await createAttribute(pads.id, {
        code: "thickness",
        valueType: "number",
        names: { ru: "Толщина", en: "Thickness" },
        unit: { ru: "мм", en: "mm" },
        number: { integer: false, min: 1.5, max: 30 },
        isFilterable: true,
        isRequiredForComplete: true,
      });
      expect(volume).toMatchObject({
        valueType: "number",
        unit: { ru: { text: "мм" }, en: { text: "mm" }, kk: null },
        number: { integer: false, min: 1.5, max: 30 },
        isFilterable: true,
        isRequiredForComplete: true,
        sort: 0,
      });
      const axle = await createAttribute(pads.id, {
        code: "axle",
        valueType: "enum",
        names: { ru: "Ось" },
        isFilterable: true,
        options: [
          { code: "front", names: { ru: "Передняя", kk: "Алдыңғы" } },
          { code: "rear", names: { ru: "Задняя" } },
        ],
      });
      expect(axle.options.map((option) => [option.code, option.sort])).toEqual([
        ["front", 0],
        ["rear", 1],
      ]);
      const sensor = await createAttribute(pads.id, {
        code: "wear_sensor",
        valueType: "bool",
        names: { ru: "Датчик износа" },
        isFilterable: true,
      });
      const note = await createAttribute(pads.id, {
        code: "note",
        valueType: "text",
        names: { ru: "Примечание" },
      });
      expect([sensor.sort, note.sort]).toEqual([2, 3]);

      const refuse = async (body: object, code: ErrorCode, status = 400) =>
        expectError(
          await asAdmin("post", `/admin/catalog/categories/${pads.id}/attributes`, body),
          status,
          code,
        );
      await refuse(
        { code: "t2", valueType: "text", names: { ru: "Т" }, isFilterable: true },
        "VALIDATION_ERROR",
      );
      await refuse(
        {
          code: "n2",
          valueType: "number",
          names: { ru: "Н" },
          number: { integer: true, min: 5, max: 1 },
        },
        "VALIDATION_ERROR",
      );
      await refuse(
        {
          code: "n3",
          valueType: "number",
          names: { ru: "Н3" },
          number: { integer: true, min: 0.5, max: 1 },
        },
        "VALIDATION_ERROR",
      );
      await refuse({ code: "n4", valueType: "number", names: { ru: "Н4" } }, "VALIDATION_ERROR");
      await refuse(
        { code: "b2", valueType: "bool", names: { ru: "Б" }, unit: { ru: "мм" } },
        "VALIDATION_ERROR",
      );
      await refuse(
        {
          code: "b3",
          valueType: "bool",
          names: { ru: "Б3" },
          options: [{ code: "x", names: { ru: "x" } }],
        },
        "VALIDATION_ERROR",
      );
      await refuse(
        { code: "axle", valueType: "bool", names: { ru: "Другая" } },
        "CATALOG_CODE_TAKEN",
        409,
      );
      await refuse(
        { code: "axle2", valueType: "bool", names: { ru: "ОСЬ" } },
        "CATALOG_NAME_TAKEN",
        409,
      );
      await refuse(
        {
          code: "e2",
          valueType: "enum",
          names: { ru: "Е" },
          options: [
            { code: "a", names: { ru: "Да" } },
            { code: "b", names: { ru: "да" } },
          ],
        },
        "VALIDATION_ERROR",
      );

      // The type never changes; unit and bounds do.
      const update = (id: string, body: object) =>
        asAdmin("patch", `/admin/catalog/attributes/${id}`, body);
      expectError(
        await update(volume.id, { expectedVersion: 1, valueType: "enum" }),
        400,
        "CATALOG_ATTRIBUTE_TYPE_IMMUTABLE",
      );
      const changed = await update(volume.id, {
        expectedVersion: 1,
        valueType: "number",
        unit: { ru: "см", en: null },
        number: { integer: true, min: 1, max: 5 },
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(adminAttributeResponseSchema.parse(changed.body).attribute).toMatchObject({
        version: 2,
        unit: { ru: { text: "см" }, en: null },
        number: { integer: true, min: 1, max: 5 },
      });
      expectError(
        await update(note.id, { expectedVersion: 1, isFilterable: true }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await update(sensor.id, { expectedVersion: 1, unit: { ru: "мм" } }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await update(volume.id, { expectedVersion: 2, number: { integer: false, min: 9, max: 2 } }),
        400,
        "VALIDATION_ERROR",
      );
      // No unit at all.
      const noUnit = await update(volume.id, { expectedVersion: 2, unit: null });
      expect(adminAttributeResponseSchema.parse(noUnit.body).attribute.unit).toBeNull();

      // Options: add, rename, reorder; only for a list.
      const option = await asAdmin("post", `/admin/catalog/attributes/${axle.id}/options`, {
        code: "both",
        names: { ru: "Обе" },
      });
      expect(option.status, JSON.stringify(option.body)).toBe(201);
      const both = adminAttributeOptionResponseSchema.parse(option.body).option;
      expect(both.sort).toBe(2);
      expectError(
        await asAdmin("post", `/admin/catalog/attributes/${sensor.id}/options`, {
          code: "x",
          names: { ru: "x" },
        }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", `/admin/catalog/attributes/${axle.id}/options`, {
          code: "front2",
          names: { ru: "передняя" },
        }),
        409,
        "CATALOG_NAME_TAKEN",
      );
      const renamedOption = await asAdmin("patch", `/admin/catalog/attribute-options/${both.id}`, {
        expectedVersion: 1,
        names: { ru: "Передняя и задняя", en: "Both" },
      });
      expect(adminAttributeOptionResponseSchema.parse(renamedOption.body).option).toMatchObject({
        version: 2,
        names: { ru: { text: "Передняя и задняя" }, en: { text: "Both" } },
      });
      const [front, rear] = axle.options;
      const reorderedOptions = await asAdmin(
        "put",
        `/admin/catalog/attributes/${axle.id}/options/order`,
        {
          optionIds: [both.id, rear!.id, front!.id],
        },
      );
      expect(
        adminAttributeResponseSchema
          .parse(reorderedOptions.body)
          .attribute.options.map((entry) => entry.code),
      ).toEqual(["both", "rear", "front"]);
      const reordered = await asAdmin(
        "put",
        `/admin/catalog/categories/${pads.id}/attributes/order`,
        {
          attributeIds: [note.id, sensor.id, axle.id, volume.id],
        },
      );
      expect(
        adminAttributeListResponseSchema
          .parse(reordered.body)
          .attributes.map((entry) => entry.code),
      ).toEqual(["note", "wear_sensor", "axle", "thickness"]);
      expectError(
        await asAdmin("put", `/admin/catalog/categories/${pads.id}/attributes/order`, {
          attributeIds: [note.id, sensor.id, axle.id],
        }),
        409,
        "CATALOG_ORDER_MISMATCH",
      );
    });

    it("archives and restores an attribute and an option without losing anything", async () => {
      const { pads } = await brakes();
      const axle = await createAttribute(pads.id, {
        code: "axle",
        valueType: "enum",
        names: { ru: "Ось" },
        isFilterable: true,
        options: [
          { code: "front", names: { ru: "Передняя" } },
          { code: "rear", names: { ru: "Задняя" } },
        ],
      });
      const before = {
        attributes: await count("attribute"),
        options: await count("attribute_option"),
        texts: await count("translation"),
      };
      const archived = await asAdmin("post", `/admin/catalog/attributes/${axle.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      expect(adminAttributeResponseSchema.parse(archived.body).attribute).toMatchObject({
        status: "archived",
        options: [{ status: "active" }, { status: "active" }],
      });
      const rear = axle.options[1]!;
      const archivedOption = await asAdmin(
        "post",
        `/admin/catalog/attribute-options/${rear.id}/status`,
        {
          status: "archived",
          expectedVersion: 1,
        },
      );
      expect(adminAttributeOptionResponseSchema.parse(archivedOption.body).option.status).toBe(
        "archived",
      );
      // Everything is still there; the admin list shows every status.
      expect({
        attributes: await count("attribute"),
        options: await count("attribute_option"),
        texts: await count("translation"),
      }).toEqual(before);
      const listed = adminAttributeListResponseSchema.parse(
        (await asAdmin("get", `/admin/catalog/categories/${pads.id}/attributes`)).body,
      );
      expect(listed.attributes[0]).toMatchObject({ code: "axle", status: "archived" });
      // An archived attribute's name is free; restoring then clashes, until renamed.
      const newAxle = await createAttribute(pads.id, {
        code: "axle_v2",
        valueType: "text",
        names: { ru: "Ось" },
      });
      expectError(
        await asAdmin("post", `/admin/catalog/attributes/${axle.id}/status`, {
          status: "active",
          expectedVersion: 2,
        }),
        409,
        "CATALOG_NAME_TAKEN",
      );
      await asAdmin("patch", `/admin/catalog/attributes/${newAxle.id}`, {
        expectedVersion: 1,
        names: { ru: "Ось (текст)" },
      });
      const restored = await asAdmin("post", `/admin/catalog/attributes/${axle.id}/status`, {
        status: "active",
        expectedVersion: 2,
      });
      expect(adminAttributeResponseSchema.parse(restored.body).attribute.status).toBe("active");
      const restoredOption = await asAdmin(
        "post",
        `/admin/catalog/attribute-options/${rear.id}/status`,
        {
          status: "active",
          expectedVersion: 2,
        },
      );
      expect(adminAttributeOptionResponseSchema.parse(restoredOption.body).option).toMatchObject({
        status: "active",
        archivedAt: null,
        names: { ru: { text: "Задняя" } },
      });
    });
  });

  describe("journal and simultaneous edits (AC-4)", () => {
    it("records every change with its author in the transaction of the change", async () => {
      const { node, pads } = await brakes();
      const attribute = await createAttribute(pads.id, {
        code: "axle",
        valueType: "enum",
        names: { ru: "Ось" },
        options: [{ code: "front", names: { ru: "Передняя" } }],
      });
      await asAdmin("patch", `/admin/catalog/categories/${pads.id}`, {
        expectedVersion: 1,
        names: { en: "Brake pads" },
      });
      await asAdmin("post", `/admin/catalog/categories/${node.id}/status`, {
        status: "hidden",
        expectedVersion: 1,
      });
      await asAdmin("put", "/admin/catalog/categories/order", {
        parentId: node.id,
        kind: "goods",
        categoryIds: [pads.id],
      });
      await asAdmin("patch", `/admin/catalog/attributes/${attribute.id}`, {
        expectedVersion: 1,
        isFilterable: true,
      });
      await asAdmin("post", `/admin/catalog/attributes/${attribute.id}/status`, {
        status: "archived",
        expectedVersion: 2,
      });
      const option = await asAdmin("post", `/admin/catalog/attributes/${attribute.id}/options`, {
        code: "rear",
        names: { ru: "Задняя" },
      });
      const rearId = adminAttributeOptionResponseSchema.parse(option.body).option.id;
      await asAdmin("patch", `/admin/catalog/attribute-options/${rearId}`, {
        expectedVersion: 1,
        names: { kk: "Артқы" },
      });
      await asAdmin("post", `/admin/catalog/attribute-options/${rearId}/status`, {
        status: "archived",
        expectedVersion: 2,
      });
      await asAdmin("put", `/admin/catalog/attributes/${attribute.id}/options/order`, {
        optionIds: [rearId, attribute.options[0]!.id],
      });
      await asAdmin("put", `/admin/catalog/categories/${pads.id}/attributes/order`, {
        attributeIds: [attribute.id],
      });

      expect(await journalActions()).toEqual([
        auditActions.adminGranted,
        auditActions.catalogCategoryCreated,
        auditActions.catalogCategoryCreated,
        auditActions.catalogAttributeCreated,
        auditActions.catalogCategoryChanged,
        auditActions.catalogCategoryStatusChanged,
        // The only subcategory and the only attribute "put in order" change
        // nothing and aren't journaled (TASK-010.A); the options really move.
        auditActions.catalogAttributeChanged,
        auditActions.catalogAttributeStatusChanged,
        auditActions.catalogAttributeOptionCreated,
        auditActions.catalogAttributeOptionChanged,
        auditActions.catalogAttributeOptionStatusChanged,
        auditActions.catalogAttributeOptionsReordered,
      ]);
      const page = auditLogPageSchema.parse(
        (await asAdmin("get", `/admin/audit-log?action=${auditActions.catalogCategoryChanged}`))
          .body,
      );
      expect(page.entries[0]).toMatchObject({
        actor: { role: "admin", phoneMasked: "+7***4567" },
        entityType: "catalog_category",
        entityId: pads.id,
        before: { names: { en: null, ru: "Тормозные колодки" } },
        after: { names: { en: "Brake pads" }, version: 2 },
      });

      // A refused change leaves nothing: no row changed, no journal entry.
      const entries = await count("audit_log");
      expectError(
        await asAdmin("post", "/admin/catalog/categories", {
          code: "pads_dup",
          kind: "goods",
          parentId: node.id,
          names: { ru: "ТОРМОЗНЫЕ колодки" },
        }),
        409,
        "CATALOG_NAME_TAKEN",
      );
      expect(await count("audit_log")).toBe(entries);
      // The journal can't be edited by the application's own connection either.
      await expect(db.query("DELETE FROM audit_log")).rejects.toThrow();
    });

    it("never overwrites someone else's change silently", async () => {
      const { pads } = await brakes();
      // Two administrators read version 1 and rename at the same time.
      const [first, second] = await Promise.all([
        asAdmin("patch", `/admin/catalog/categories/${pads.id}`, {
          expectedVersion: 1,
          names: { ru: "Колодки А" },
        }),
        asAdmin("patch", `/admin/catalog/categories/${pads.id}`, {
          expectedVersion: 1,
          names: { ru: "Колодки Б" },
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = first.status === 409 ? first : second;
      const winner = first.status === 200 ? first : second;
      expectError(loser, 409, "CATALOG_VERSION_CONFLICT");
      expect(loser.body.details).toEqual({ currentVersion: 2 });
      const { rows } = await db.query<{ text: string }>(
        "SELECT text FROM translation WHERE entity_id = $1 AND lang = 'ru'",
        [pads.id],
      );
      expect(rows[0]!.text).toBe(
        adminCategoryResponseSchema.parse(winner.body).category.names.ru!.text,
      );
      expect(
        (await journalActions()).filter((action) => action === auditActions.catalogCategoryChanged),
      ).toHaveLength(1);
      // Same for a status, an attribute and an option.
      expectError(
        await asAdmin("post", `/admin/catalog/categories/${pads.id}/status`, {
          status: "hidden",
          expectedVersion: 1,
        }),
        409,
        "CATALOG_VERSION_CONFLICT",
      );
      const attribute = await createAttribute(pads.id, {
        code: "axle",
        valueType: "enum",
        names: { ru: "Ось" },
        options: [{ code: "front", names: { ru: "Передняя" } }],
      });
      await asAdmin("patch", `/admin/catalog/attributes/${attribute.id}`, {
        expectedVersion: 1,
        names: { ru: "Ось установки" },
      });
      expectError(
        await asAdmin("patch", `/admin/catalog/attributes/${attribute.id}`, {
          expectedVersion: 1,
          isFilterable: true,
        }),
        409,
        "CATALOG_VERSION_CONFLICT",
      );
      const optionId = attribute.options[0]!.id;
      await asAdmin("patch", `/admin/catalog/attribute-options/${optionId}`, {
        expectedVersion: 1,
        names: { ru: "Передняя ось" },
      });
      expectError(
        await asAdmin("post", `/admin/catalog/attribute-options/${optionId}/status`, {
          status: "archived",
          expectedVersion: 1,
        }),
        409,
        "CATALOG_VERSION_CONFLICT",
      );
    });

    it("never overwrites someone else's order silently; the same order again changes nothing (TASK-010.A)", async () => {
      /**
       * One set of siblings: how to reorder it and how to read its order back.
       * Two administrators read the order and send different new ones at the
       * same time, both from what they read.
       */
      async function race(siblings: {
        ids: string[];
        path: string;
        body: (ids: string[], expectedOrder?: string[]) => object;
        order: () => Promise<string[]>;
        action: string;
      }): Promise<void> {
        const [a, b, c] = siblings.ids as [string, string, string];
        expect(await siblings.order()).toEqual([a, b, c]);
        const journaled = async () =>
          (await journalActions()).filter((action) => action === siblings.action).length;
        const before = await journaled();

        const [first, second] = await Promise.all([
          asAdmin("put", siblings.path, siblings.body([b, a, c], [a, b, c])),
          asAdmin("put", siblings.path, siblings.body([c, b, a], [a, b, c])),
        ]);
        expect(
          [first.status, second.status].sort(),
          JSON.stringify([first.body, second.body]),
        ).toEqual([200, 409]);
        const winnerOrder = first.status === 200 ? [b, a, c] : [c, b, a];
        const loser = first.status === 409 ? first : second;
        expectError(loser, 409, "CATALOG_ORDER_CONFLICT");
        expect(catalogOrderConflictDetailsSchema.parse(loser.body.details)).toEqual({
          currentOrder: winnerOrder,
        });
        // The first one stays; one journal entry.
        expect(await siblings.order()).toEqual(winnerOrder);
        expect(await journaled()).toBe(before + 1);

        // The same order again — repeated, or from the order read before
        // (someone already put them this way): nothing changes, nothing is journaled.
        for (const body of [
          siblings.body(winnerOrder),
          siblings.body(winnerOrder, winnerOrder),
          siblings.body(winnerOrder, [a, b, c]),
        ]) {
          const again = await asAdmin("put", siblings.path, body);
          expect(again.status, JSON.stringify(again.body)).toBe(200);
        }
        expect(await siblings.order()).toEqual(winnerOrder);
        expect(await journaled()).toBe(before + 1);

        // The one refused reloads and decides again: from the current order it is written.
        const retried = await asAdmin("put", siblings.path, siblings.body([a, b, c], winnerOrder));
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(await siblings.order()).toEqual([a, b, c]);
        expect(await journaled()).toBe(before + 2);
        // Still: every sibling once, whatever the expected order says.
        expectError(
          await asAdmin("put", siblings.path, siblings.body([a, b], [a, b, c])),
          409,
          "CATALOG_ORDER_MISMATCH",
        );
      }

      const { node, pads } = await brakes();
      const discs = await createCategory({
        code: "brake_discs",
        kind: "goods",
        parentId: node.id,
        names: { ru: "Тормозные диски" },
      });
      const drums = await createCategory({
        code: "brake_drums",
        kind: "goods",
        parentId: node.id,
        names: { ru: "Тормозные барабаны" },
      });
      await race({
        ids: [pads.id, discs.id, drums.id],
        path: "/admin/catalog/categories/order",
        body: (categoryIds, expectedOrder) => ({
          parentId: node.id,
          kind: "goods",
          categoryIds,
          ...(expectedOrder && { expectedOrder }),
        }),
        order: async () => {
          const tree = adminCategoryTreeResponseSchema.parse(
            (await asAdmin("get", "/admin/catalog/categories")).body,
          );
          return tree.categories
            .find((entry) => entry.id === node.id)!
            .children.map((child) => child.id);
        },
        action: auditActions.catalogCategoriesReordered,
      });

      const attributes: AdminAttribute[] = [];
      for (const code of ["axle", "thickness", "wear_sensor"]) {
        attributes.push(
          await createAttribute(pads.id, {
            code,
            valueType: code === "axle" ? "enum" : "bool",
            names: { ru: code },
            ...(code === "axle" && {
              options: [
                { code: "front", names: { ru: "Передняя" } },
                { code: "rear", names: { ru: "Задняя" } },
                { code: "both", names: { ru: "Обе" } },
              ],
            }),
          }),
        );
      }
      const listed = async () =>
        adminAttributeListResponseSchema.parse(
          (await asAdmin("get", `/admin/catalog/categories/${pads.id}/attributes`)).body,
        ).attributes;
      await race({
        ids: attributes.map((entry) => entry.id),
        path: `/admin/catalog/categories/${pads.id}/attributes/order`,
        body: (attributeIds, expectedOrder) => ({
          attributeIds,
          ...(expectedOrder && { expectedOrder }),
        }),
        order: async () => (await listed()).map((entry) => entry.id),
        action: auditActions.catalogAttributesReordered,
      });

      const axle = attributes[0]!;
      await race({
        ids: axle.options.map((option) => option.id),
        path: `/admin/catalog/attributes/${axle.id}/options/order`,
        body: (optionIds, expectedOrder) => ({
          optionIds,
          ...(expectedOrder && { expectedOrder }),
        }),
        order: async () =>
          (await listed())
            .find((entry) => entry.id === axle.id)!
            .options.map((option) => option.id),
        action: auditActions.catalogAttributeOptionsReordered,
      });
    });
  });

  describe("clients (AC-5, AC-6)", () => {
    async function seeded(): Promise<void> {
      await app.get(DevCatalogSeed).run();
    }

    async function categoryId(code: string): Promise<string> {
      const { rows } = await db.query<{ id: string }>("SELECT id FROM category WHERE code = $1", [
        code,
      ]);
      return rows[0]!.id;
    }

    it("gives the active tree in the language asked, with Russian as the fallback, to anyone", async () => {
      await seeded();
      const node = await createCategory({
        code: "new_node",
        kind: "goods",
        names: { ru: "Новый узел" },
      });
      const ru = categoryTreeResponseSchema.parse((await asGuest("/catalog/categories")).body);
      expect(ru.language).toBe("ru");
      expect(ru.categories.map((entry) => entry.code)).toEqual([
        ...devCatalogTree.filter((entry) => entry.kind === "goods").map((entry) => entry.code),
        "new_node",
        ...devCatalogTree.filter((entry) => entry.kind === "services").map((entry) => entry.code),
      ]);
      expect(ru.categories[0]).toMatchObject({
        code: "engine",
        icon: "engine",
        sort: 0,
        name: { text: "Двигатель", isFallback: false },
      });
      const kk = categoryTreeResponseSchema.parse(
        (await asGuest("/catalog/categories", "kk-KZ")).body,
      );
      expect(kk.language).toBe("kk");
      expect(kk.categories[0]!.name).toEqual({ text: "Қозғалтқыш", isFallback: false });
      const brakesNode = kk.categories.find((entry) => entry.code === "brakes")!;
      expect(brakesNode.children.map((entry) => [entry.code, entry.compatibilityRequired])).toEqual(
        [
          ["brake_pads", true],
          ["brake_discs", true],
          ["brake_calipers", true],
        ],
      );
      // No Kazakh name: the Russian one, marked.
      expect(kk.categories.find((entry) => entry.id === node.id)!.name).toEqual({
        text: "Новый узел",
        isFallback: true,
      });
      // An unknown language: Russian.
      const unknown = categoryTreeResponseSchema.parse(
        (await asGuest("/catalog/categories", "de, fr;q=0.5")).body,
      );
      expect(unknown.language).toBe("ru");
      // A mobile session and a cabinet session get the same.
      for (const [bearer, client] of [
        [await mobileToken(), IOS],
        [await cabinetToken(), SUPPLIER_WEB],
        [token, ADMIN_WEB],
      ] as const) {
        const response = await http()
          .get("/catalog/categories")
          .set("X-Client", client)
          .set("Authorization", `Bearer ${bearer}`);
        expect(response.status).toBe(200);
        expect(categoryTreeResponseSchema.parse(response.body).categories).toEqual(ru.categories);
      }
    });

    it("hides hidden and archived categories with their subcategories; 404 is the same for all", async () => {
      await seeded();
      const interior = await categoryId("interior");
      const mats = await categoryId("floor_mats");
      const pads = await categoryId("brake_pads");
      await asAdmin("post", `/admin/catalog/categories/${interior}/status`, {
        status: "hidden",
        expectedVersion: 1,
      });
      await asAdmin("post", `/admin/catalog/categories/${pads}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      const tree = categoryTreeResponseSchema.parse((await asGuest("/catalog/categories")).body);
      expect(tree.categories.map((entry) => entry.code)).not.toContain("interior");
      const codes = tree.categories.flatMap((entry) => entry.children.map((child) => child.code));
      expect(codes).not.toContain("floor_mats");
      expect(codes).not.toContain("brake_pads");
      expect(codes).toContain("brake_discs");

      const answers: Response[] = [];
      for (const id of [interior, mats, pads, randomUUID(), "not-a-uuid"]) {
        answers.push(await asGuest(`/catalog/categories/${id}/attributes`));
      }
      for (const answer of answers) {
        expectError(answer, 404, "NOT_FOUND");
        expect(answer.body).toEqual(answers[0]!.body);
      }
    });

    it("never lets a 404 be kept: a category restored is seen at once (TASK-010.A)", async () => {
      await seeded();
      const pads = await categoryId("brake_pads");
      await asAdmin("post", `/admin/catalog/categories/${pads}/status`, {
        status: "hidden",
        expectedVersion: 1,
      });
      for (const id of [pads, randomUUID(), "not-a-uuid"]) {
        const missing = await asGuest(`/catalog/categories/${id}/attributes`, "ru");
        expectError(missing, 404, "NOT_FOUND");
        // Neither a client nor a proxy may keep it (unlike a success, kept a minute).
        expect(missing.headers["cache-control"]).toBe("no-store");
        // And a conditional request never turns it into "not modified".
        const conditional = await asGuest(`/catalog/categories/${id}/attributes`, "ru").set(
          "If-None-Match",
          (missing.headers.etag as string | undefined) ?? "*",
        );
        expectError(conditional, 404, "NOT_FOUND");
        expect(conditional.headers["cache-control"]).toBe("no-store");
      }
      // Restored: the very next request (through any proxy that obeyed) sees it.
      const restored = await asAdmin("post", `/admin/catalog/categories/${pads}/status`, {
        status: "active",
        expectedVersion: 2,
      });
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      const found = await asGuest(`/catalog/categories/${pads}/attributes`, "ru");
      expect(found.status).toBe(200);
      expect(found.headers["cache-control"]).toBe(
        `public, max-age=${CATALOG_CLIENT_CACHE_SECONDS}`,
      );
      // Any other refusal of a client route is not kept either.
      const invalid = await asGuest(`/catalog/categories/${"x".repeat(101)}/attributes`, "ru");
      expectError(invalid, 400, "VALIDATION_ERROR");
      expect(invalid.headers["cache-control"]).toBe("no-store");
    });

    it("describes only active attributes and options, in order, in the language asked", async () => {
      await seeded();
      const oils = await categoryId("engine_oils");
      const described = categoryAttributesResponseSchema.parse(
        (await asGuest(`/catalog/categories/${oils}/attributes`, "en")).body,
      );
      expect(described.category).toMatchObject({
        code: "engine_oils",
        level: 2,
        name: { text: "Engine oils" },
      });
      expect(described.attributes.map((entry) => entry.code)).toEqual([
        "viscosity",
        "approval",
        "volume",
      ]);
      expect(described.attributes[2]).toMatchObject({
        valueType: "number",
        unit: { text: "L", isFallback: false },
        number: { integer: false, min: 0.1, max: 220 },
        isFilterable: true,
        isRequiredForComplete: true,
        options: [],
      });
      expect(described.attributes[0]!.options.map((option) => option.name.text)).toEqual([
        "0W-20",
        "5W-30",
        "5W-40",
        "10W-40",
      ]);

      const admin = adminAttributeListResponseSchema.parse(
        (await asAdmin("get", `/admin/catalog/categories/${oils}/attributes`)).body,
      );
      const approval = admin.attributes.find((entry) => entry.code === "approval")!;
      const viscosity = admin.attributes.find((entry) => entry.code === "viscosity")!;
      // An archived attribute; a list whose options are all archived; one archived option.
      await asAdmin("post", `/admin/catalog/attributes/${approval.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      await asAdmin("post", `/admin/catalog/attribute-options/${viscosity.options[1]!.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      const empty = await createAttribute(oils, {
        code: "base",
        valueType: "enum",
        names: { ru: "Основа" },
        options: [{ code: "pao", names: { ru: "ПАО" } }],
      });
      await asAdmin("post", `/admin/catalog/attribute-options/${empty.options[0]!.id}/status`, {
        status: "archived",
        expectedVersion: 1,
      });
      await createAttribute(oils, {
        code: "empty_list",
        valueType: "enum",
        names: { ru: "Пустой список" },
      });
      const after = categoryAttributesResponseSchema.parse(
        (await asGuest(`/catalog/categories/${oils}/attributes`, "kk")).body,
      );
      expect(after.attributes.map((entry) => entry.code)).toEqual(["viscosity", "volume"]);
      expect(after.attributes[0]!.options.map((option) => option.code)).toEqual([
        "0w_20",
        "5w_40",
        "10w_40",
      ]);
      expect(after.attributes[0]!.name).toEqual({ text: "Тұтқырлық", isFallback: false });
      // A node has no attributes of its own.
      const node = categoryAttributesResponseSchema.parse(
        (await asGuest(`/catalog/categories/${await categoryId("consumables")}/attributes`)).body,
      );
      expect(node).toMatchObject({ category: { level: 1, parentId: null }, attributes: [] });
    });

    it("shows a change of the administrator at once; clients and proxies keep an answer a minute at most", async () => {
      await seeded();
      const oils = await categoryId("engine_oils");
      const first = await asGuest(`/catalog/categories/${oils}/attributes`, "ru");
      expect(first.headers["cache-control"]).toBe(
        `public, max-age=${CATALOG_CLIENT_CACHE_SECONDS}`,
      );
      expect(CATALOG_CLIENT_CACHE_SECONDS).toBeLessThanOrEqual(60);
      expect(first.headers.vary).toMatch(/Accept-Language/);
      expect(first.headers["content-language"]).toBe("ru");
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();
      // Unchanged: a conditional request is answered 304.
      const same = await asGuest(`/catalog/categories/${oils}/attributes`, "ru").set(
        "If-None-Match",
        etag,
      );
      expect(same.status).toBe(304);

      await createAttribute(oils, {
        code: "oil_type",
        valueType: "enum",
        names: { ru: "Тип масла" },
        isFilterable: true,
        options: [
          { code: "synthetic", names: { ru: "Синтетика" } },
          { code: "semi_synthetic", names: { ru: "Полусинтетика" } },
          { code: "mineral", names: { ru: "Минеральное" } },
        ],
      });
      const changed = await asGuest(`/catalog/categories/${oils}/attributes`, "ru").set(
        "If-None-Match",
        etag,
      );
      expect(changed.status).toBe(200);
      expect(
        categoryAttributesResponseSchema
          .parse(changed.body)
          .attributes.find((entry) => entry.code === "oil_type"),
      ).toMatchObject({
        isFilterable: true,
        options: [{ code: "synthetic" }, { code: "semi_synthetic" }, { code: "mineral" }],
      });
    });
  });

  describe("access (AC-7)", () => {
    it("serves the admin routes to an admin session only; guests, mobile and cabinet sessions are refused", async () => {
      const { pads } = await brakes();
      const attribute = await createAttribute(pads.id, {
        code: "axle",
        valueType: "enum",
        names: { ru: "Ось" },
        options: [{ code: "front", names: { ru: "Передняя" } }],
      });
      const ids: Record<string, string> = {
        categoryId: pads.id,
        attributeId: attribute.id,
        optionId: attribute.options[0]!.id,
        // TASK-011: the caller is refused before anything is looked up.
        brandId: randomUUID(),
        itemId: randomUUID(),
        analogItemId: randomUUID(),
        recordId: randomUUID(),
        proposalId: randomUUID(),
      };
      const adminRoutes = Object.values(apiRoutes).filter((route) =>
        route.path.startsWith("/admin/catalog"),
      );
      // 14 of the structure (TASK-010), 14 of brands, items and the fill
      // (TASK-011), 4 of photos (TASK-013) and 5 of compatibility (TASK-015).
      expect(adminRoutes).toHaveLength(37);
      const callers = [
        { name: "guest", token: undefined, client: IOS, status: 401, code: "AUTH_REQUIRED" },
        { name: "mobile", token: await mobileToken(), client: IOS, status: 403, code: "FORBIDDEN" },
        {
          name: "cabinet",
          token: await cabinetToken(),
          client: SUPPLIER_WEB,
          status: 403,
          code: "FORBIDDEN",
        },
      ] as const;
      const before = { categories: await count("category"), journal: await count("audit_log") };
      const picture = await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .jpeg()
        .toBuffer();
      for (const route of adminRoutes) {
        expect((route as ApiRouteDefinition).contexts).toEqual(["admin"]);
        const path = route.path.replace(/\{(\w+)\}/g, (_match, name: string) => ids[name]!);
        for (const caller of callers) {
          let call = http()
            [route.method.toLowerCase() as Method](path)
            .set("X-Client", caller.client);
          if (caller.token) {
            call = call.set("Authorization", `Bearer ${caller.token}`);
          }
          // A route that takes a file gets a real picture, so the refusal
          // is about who is asking and not about the body (TASK-013).
          const response = isUploadRoute(route as ApiRouteDefinition)
            ? await call.set("Content-Type", "image/jpeg").send(picture)
            : await call.send({
                code: "intruder",
                kind: "goods",
                names: { ru: "Чужая" },
                expectedVersion: 1,
                status: "archived",
              });
          expectError(response, caller.status, caller.code as ErrorCode);
        }
      }
      expect({ categories: await count("category"), journal: await count("audit_log") }).toEqual(
        before,
      );
      // The client routes are public.
      for (const route of Object.values(apiRoutes).filter((entry) =>
        entry.path.startsWith("/catalog"),
      )) {
        expect(route).not.toHaveProperty("auth");
      }
    });
  });

  describe("development seed (AC-8)", () => {
    it("fills the example tree once; a second run creates nothing; not outside development and tests", async () => {
      const seed = app.get(DevCatalogSeed);
      const first = await seed.run();
      expect(first.created).toEqual({
        categories: 37,
        attributes: 4,
        options: 10,
        brands: 4,
        items: 10,
        analogs: 1,
      });
      const rows = {
        categories: await count("category"),
        attributes: await count("attribute"),
        options: await count("attribute_option"),
        texts: await count("translation"),
      };
      const second = await seed.run();
      expect(second.created).toEqual({
        categories: 0,
        attributes: 0,
        options: 0,
        brands: 0,
        items: 0,
        analogs: 0,
      });
      expect(second.existing).toEqual(first.created);
      expect({
        categories: await count("category"),
        attributes: await count("attribute"),
        options: await count("attribute_option"),
        texts: await count("translation"),
      }).toEqual(rows);
      const tree = adminCategoryTreeResponseSchema.parse(
        (await asAdmin("get", "/admin/catalog/categories")).body,
      );
      expect(
        tree.categories.filter((entry) => entry.kind === "goods").map((entry) => entry.code),
      ).toEqual(["engine", "brakes", "suspension", "body", "electrics", "interior", "consumables"]);
      for (const node of tree.categories) {
        expect(node.children.length).toBeGreaterThanOrEqual(node.kind === "goods" ? 2 : 1);
        expect(node.children.length).toBeLessThanOrEqual(4);
      }
      expect(
        tree.categories.filter((entry) => entry.kind === "services").length,
      ).toBeGreaterThanOrEqual(2);
      config.nodeEnv = "staging";
      try {
        await expect(seed.run()).rejects.toThrow(/development and tests only/);
      } finally {
        config.nodeEnv = "test";
      }
    });
  });

  describe("what must work in dev (TASK-010)", () => {
    it("walks the scenarios of the task", async () => {
      await app.get(DevCatalogSeed).run();
      const tree = adminCategoryTreeResponseSchema.parse(
        (await asAdmin("get", "/admin/catalog/categories")).body,
      );
      const byCode = new Map(
        tree.categories
          .flatMap((node) => [node, ...node.children])
          .map((entry) => [entry.code, entry]),
      );
      const oils = byCode.get("engine_oils")!;
      const filters = async () =>
        categoryAttributesResponseSchema
          .parse((await asGuest(`/catalog/categories/${oils.id}/attributes`)).body)
          .attributes.map((entry) => entry.code);

      await createAttribute(oils.id, {
        code: "oil_type",
        valueType: "enum",
        names: { ru: "Тип масла" },
        isFilterable: true,
        options: [
          { code: "synthetic", names: { ru: "Синтетика" } },
          { code: "semi_synthetic", names: { ru: "Полусинтетика" } },
          { code: "mineral", names: { ru: "Минеральное" } },
        ],
      });
      expect(await filters()).toContain("oil_type");

      const approval = adminAttributeListResponseSchema
        .parse((await asAdmin("get", `/admin/catalog/categories/${oils.id}/attributes`)).body)
        .attributes.find((entry) => entry.code === "approval")!;
      await asAdmin("post", `/admin/catalog/attributes/${approval.id}/status`, {
        status: "archived",
        expectedVersion: approval.version,
      });
      expect(await filters()).not.toContain("approval");
      await asAdmin("post", `/admin/catalog/attributes/${approval.id}/status`, {
        status: "active",
        expectedVersion: approval.version + 1,
      });
      expect(await filters()).toContain("approval");

      expectError(
        await asAdmin("post", "/admin/catalog/categories", {
          code: "pads_inner",
          kind: "goods",
          parentId: byCode.get("brake_pads")!.id,
          names: { ru: "Внутренние" },
        }),
        400,
        "CATALOG_DEPTH_EXCEEDED",
      );

      const interior = byCode.get("interior")!;
      await asAdmin("post", `/admin/catalog/categories/${interior.id}/status`, {
        status: "hidden",
        expectedVersion: interior.version,
      });
      const visible = categoryTreeResponseSchema.parse((await asGuest("/catalog/categories")).body);
      expect(visible.categories.map((entry) => entry.code)).not.toContain("interior");
      expectError(
        await asGuest(`/catalog/categories/${byCode.get("floor_mats")!.id}/attributes`),
        404,
        "NOT_FOUND",
      );

      const journal = auditLogPageSchema.parse(
        (await asAdmin("get", "/admin/audit-log?actorRole=admin")).body,
      );
      expect(journal.entries.map((entry) => entry.action)).toEqual([
        auditActions.catalogCategoryStatusChanged,
        auditActions.catalogAttributeStatusChanged,
        auditActions.catalogAttributeStatusChanged,
        auditActions.catalogAttributeCreated,
      ]);
      expect(new Set(journal.entries.map((entry) => entry.actor.phoneMasked))).toEqual(
        new Set(["+7***4567"]),
      );

      const mobile = await mobileToken();
      const refused = await http()
        .post("/admin/catalog/categories")
        .set("X-Client", IOS)
        .set("Authorization", `Bearer ${mobile}`)
        .send({ code: "mine", kind: "goods", names: { ru: "Моя" } });
      expectError(refused, 403, "FORBIDDEN");
    });
  });
});
