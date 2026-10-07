import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCatalogItemPageSchema,
  adminCompatibilityCheckResponseSchema,
  adminHomeCatalogFilters,
  adminHomeSchema,
  adminItemOffersResponseSchema,
  catalogLocationSchema,
  adminSignalConflictDetailsSchema,
  adminSignalPageSchema,
  adminSignalResponseSchema,
  administratorListResponseSchema,
  apiErrorResponseSchema,
  auditLogPageSchema,
  settingHistoryResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type AdminSignal,
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
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { DevCompatibilitySeed } from "../compatibility";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { OffersService } from "../offers";
import { SupplierReachWatch } from "../orders";
import { AppSettings, SettingsChangeService } from "../settings";
import { DevSupplierSeed } from "../suppliers";
import { DevVehicleSeed } from "../vehicles";

/**
 * TASK-034 on the server: the queue of attention in one answer whose every
 * counter is what its list shows, the administrator's actions on signals
 * (the version, the comment, the journal, «уже закрыт {кем}»), the detector
 * of an unreachable supplier (one signal per company, closing by itself),
 * the history of a setting a page at a time, the reset of another
 * administrator's second factor with a reason, and the names in the journal.
 * TASK-035: every catalog card counts the rows of the items list it opens
 * (the same filters, from the contract), offers on sale, an item's offers,
 * its history, the admin check of compatibility and locating an attribute.
 * Real PostgreSQL and Redis; the detector runs in a real worker context.
 */

const ADMIN_PHONE = "+77011234567";
const SECOND_ADMIN_PHONE = "+77012223344";
const ADMIN_WEB = "admin-web/0.1.0";

interface Admin {
  adminId: string;
  accountId: string;
  secret: string;
  accessToken: string;
}

describe("admin panel (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext;
  let channels: TestLoginCodeChannels;
  let ipCounter = 0;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let output: ReturnType<typeof captureOutput>;

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
    const nestApp = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
      bufferLogs: true,
    });
    nestApp.useLogger(nestApp.get(JsonLoggerService));
    nestApp.flushLogs();
    configureHttpApp(nestApp, config);
    await nestApp.init();
    app = nestApp;
    channels = app.get(LoginCodeChannels) as TestLoginCodeChannels;
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), {
      bufferLogs: true,
    });
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
  });

  afterAll(async () => {
    await worker?.close();
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
    await Promise.all([app.get(AppSettings).refresh(), worker.get(AppSettings).refresh()]);
    await operatorSet({
      login_code_requests_per_phone: 10_000,
      login_code_requests_per_ip: 10_000,
      login_code_verifications_per_phone: 10_000,
      admin_totp_allowed_drift_steps: 5,
      admin_totp_verify_per_admin: 1000,
      admin_totp_verify_per_ip: 1000,
    });
    await redis.flushall();
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  async function operatorSet(values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await app.get(SettingsChangeService).change({
        key,
        value,
        expectedVersion: undefined,
        reason: "integration test",
        actor: { kind: "operator" },
      });
    }
    await worker.get(AppSettings).refresh();
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect({ status: response.status, body: response.body }).toMatchObject({
      status,
      body: { code },
    });
    apiErrorResponseSchema.parse(response.body);
  }

  function remember(body: unknown): void {
    const text = JSON.stringify(body ?? {});
    for (const match of text.matchAll(
      /"(accessToken|refreshToken|token|secret|otpauthUri)":"([^"]+)"/g,
    )) {
      rememberSecret(match[2]!);
    }
  }

  async function signIn(phone: string): Promise<Response> {
    await redis.del(`rl:login-code:resend:${phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Client", ADMIN_WEB)
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const code = channels.sent.filter((message) => message.phone === phone).at(-1)!.code;
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", ADMIN_WEB)
      .set("X-Forwarded-For", nextIp())
      .send({ phone, code });
    remember(response.body);
    for (const cookie of ([] as string[]).concat(response.headers["set-cookie"] ?? [])) {
      const match = /^adclub_sign_in_([0-9a-f-]{36})=([^;]*)/.exec(cookie);
      if (match) {
        rememberSecret(match[2]!);
        stepCookies.set(match[1]!, `adclub_sign_in_${match[1]}=${match[2]}`);
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

  async function setUpAdmin(phone = ADMIN_PHONE): Promise<Admin> {
    const { adminId } = await app.get(OperatorService).grantAdmin(phone);
    const signedIn = await signIn(phone);
    expectError(signedIn, 403, "TOTP_SETUP_REQUIRED");
    const token = totpStepRequiredDetailsSchema.parse(signedIn.body.details).signInStep.token;
    const setupResponse = await stepPost("/auth/sign-in/totp/setup", { signInStep: token });
    remember(setupResponse.body);
    const setup = totpSetupResponseSchema.parse(setupResponse.body);
    const confirmed = await stepPost("/auth/sign-in/totp/setup/confirm", {
      signInStep: token,
      totpCode: nextCode(setup.secret),
    } as { signInStep: string });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    remember(confirmed.body);
    const body = totpSetupCompletedResponseSchema.parse(confirmed.body);
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return {
      adminId,
      accountId: body.accountId,
      secret: setup.secret,
      accessToken: body.session.accessToken,
    };
  }

  function asAdmin(method: "get" | "post", path: string, admin: Admin, body?: object): Test {
    const call = http()
      [method](path)
      .set("X-Client", ADMIN_WEB)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    return body ? call.send(body) : call;
  }

  async function insertSignal(
    kind: string,
    subjectType: string,
    subjectId: string,
    status: "open" | "acknowledged" | "closed" = "open",
    payload: object = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO admin_signal (kind, subject_type, subject_id, status, payload, closed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'closed' THEN now() END) RETURNING id`,
      [kind, subjectType, subjectId, status, JSON.stringify(payload)],
    );
    return rows[0]!.id;
  }

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  describe("the queue of attention (A-HOME)", () => {
    it("answers every counter in one request, each equal to what its list shows", async () => {
      const admin = await setUpAdmin();
      await app.get(DevCatalogSeed).run();
      await app.get(DevVehicleSeed).run();
      await app.get(DevCompatibilitySeed).run();
      await app.get(DevSupplierSeed).run();
      await insertSignal("whatsapp_outage", "channel", uuid(1), "open", {
        since: "2026-10-07T08:00:00.000Z",
        affectedOrders: 3,
        failedMessages: 5,
      });
      await insertSignal("frequent_admin_closes", "supplier", uuid(2), "open");
      await insertSignal("frequent_admin_closes", "supplier", uuid(3), "acknowledged");
      await insertSignal("frequent_admin_closes", "supplier", uuid(4), "closed");
      await operatorSet({ ai_daily_budget_usd: 0 });

      const response = await asAdmin("get", "/admin/home", admin);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const home = adminHomeSchema.parse(response.body);

      expect(home.channelOutage).toMatchObject({
        status: "open",
        since: "2026-10-07T08:00:00.000Z",
        affectedOrders: 3,
        failedMessages: 5,
      });
      expect(home.signals.find((row) => row.kind === "frequent_admin_closes")).toEqual({
        kind: "frequent_admin_closes",
        open: 1,
        acknowledged: 1,
      });
      expect(home.signals.find((row) => row.kind === "supplier_unreachable")).toEqual({
        kind: "supplier_unreachable",
        open: 0,
        acknowledged: 0,
      });
      expect(home.aiBudget).toMatchObject({ exhausted: true, budgetUsd: 0 });

      // The same numbers as the lists the cards lead to.
      const signals = adminSignalPageSchema.parse(
        (await asAdmin("get", "/admin/signals?kind=frequent_admin_closes&status=current", admin))
          .body,
      );
      expect(signals.total).toBe(2);
      const leads = await asAdmin("get", "/admin/supplier-leads?status=new", admin);
      expect(leads.status).toBe(200);
      expect(home.newSupplierLeads).toBe(leads.body.counts.new);
      expect(home.newSupplierLeads).toBeGreaterThan(0);
      const incomplete = await asAdmin(
        "get",
        "/admin/catalog/items?completeness=incomplete&status=active&limit=1",
        admin,
      );
      expect(home.catalog.incomplete).toBe(incomplete.body.total);
      expect(home.catalog.incomplete).toBeGreaterThan(0);
      const translations = await asAdmin("get", "/admin/translations?limit=1", admin);
      expect(home.catalog.withoutTranslation).toBe(
        translations.body.counts.missing + translations.body.counts.failed,
      );
      // No photo was approved in the seed: every active item lacks one.
      const active = await asAdmin("get", "/admin/catalog/items?status=active&limit=1", admin);
      expect(home.catalog.withoutPhoto).toBe(active.body.total);

      // Without compatibility, counted the long way: the active goods of every
      // subcategory that requires it, minus those with an approved record.
      const { rows: required } = await db.query<{ id: string }>(
        `SELECT i.id FROM catalog_item i JOIN category c ON c.id = i.category_id
         WHERE c.compatibility_required AND i.status = 'active' AND i.item_type <> 'service'`,
      );
      const { rows: covered } = await db.query<{ item_id: string }>(
        "SELECT DISTINCT item_id FROM item_compatibility WHERE status = 'approved'",
      );
      const coveredIds = new Set(covered.map((row) => row.item_id));
      const expected = required.filter((row) => !coveredIds.has(row.id)).length;
      expect(home.catalog.withoutCompatibility).toBe(expected);
      expect(home.catalog.withoutCompatibility).toBeGreaterThan(0);

      // An approved photo takes the item off the count.
      const item = active.body.items[0] as { id: string };
      await db.query(
        `INSERT INTO item_photo (item_id, source_type, status, content_type, byte_size, checksum, width, height)
         VALUES ($1, 'admin_upload', 'approved', 'image/jpeg', 10, $2, 10, 10)`,
        [item.id, "a".repeat(64)],
      );
      const after = adminHomeSchema.parse((await asAdmin("get", "/admin/home", admin)).body);
      expect(after.catalog.withoutPhoto).toBe(home.catalog.withoutPhoto - 1);
    });

    it("is for administrators only", async () => {
      const response = await http().get("/admin/home").set("X-Client", ADMIN_WEB);
      expectError(response, 401, "AUTH_REQUIRED");
    });
  });

  describe("the catalog section (TASK-035)", () => {
    interface ListRow {
      id: string;
      status: string;
      offersOnSale: number;
    }

    /** Every row of the items list with these filters, a small page at a time. */
    async function allRows(admin: Admin, filters: Record<string, string>): Promise<ListRow[]> {
      const rows: ListRow[] = [];
      let cursor: string | null = null;
      let total: number | null = null;
      do {
        const query = new URLSearchParams({ ...filters, limit: "2" });
        if (cursor) query.set("cursor", cursor);
        const response = await asAdmin("get", `/admin/catalog/items?${query.toString()}`, admin);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const page = adminCatalogItemPageSchema.parse(response.body);
        total ??= page.total;
        expect(page.total).toBe(total);
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(rows).toHaveLength(total);
      return rows;
    }

    async function seedAll(): Promise<{ supplierId: string }> {
      await app.get(DevCatalogSeed).run();
      await app.get(DevVehicleSeed).run();
      await app.get(DevCompatibilitySeed).run();
      return app.get(DevSupplierSeed).run();
    }

    async function itemByArticle(article: string): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM catalog_item WHERE article = $1",
        [article],
      );
      return rows[0]!.id;
    }

    async function offerOn(supplierId: string, itemId: string): Promise<string> {
      const { rows } = await db.query<{ id: string; account_id: string }>(
        "SELECT id, account_id FROM supplier_member WHERE supplier_id = $1 LIMIT 1",
        [supplierId],
      );
      const offer = await app.get(OffersService).create(
        {
          itemId,
          price: 12_500,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        },
        { role: "supplier", supplierId, memberId: rows[0]!.id, accountId: rows[0]!.account_id },
        "ru",
      );
      return offer.id;
    }

    it("counts on every catalog card exactly the rows of the list it opens", async () => {
      const admin = await setUpAdmin();
      await seedAll();
      const pads = await itemByArticle("04465-0K090");
      // An approved photo, a fully translated name, a refused translation
      // and a draft (drafts are not on the cards) move the numbers apart.
      await db.query(
        `INSERT INTO item_photo (item_id, source_type, status, content_type, byte_size, checksum, width, height)
         VALUES ($1, 'admin_upload', 'approved', 'image/jpeg', 10, $2, 10, 10)`,
        [pads, "b".repeat(64)],
      );
      for (const lang of ["kk", "en"]) {
        const edited = await http()
          .put(`/admin/translations/catalog_item/${pads}/name/${lang}`)
          .set("X-Client", ADMIN_WEB)
          .set("Authorization", `Bearer ${admin.accessToken}`)
          .send({ text: `Колодки ${lang}` });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      }
      const trw = await itemByArticle("GDB3534");
      await db.query(
        `INSERT INTO translation_task (entity_type, entity_id, field, lang, status, failure, source_hash)
         SELECT 'catalog_item', $1, 'name', 'en', 'failed', 'wrong_language',
                encode(sha256(convert_to(t.text, 'UTF8')), 'hex')
         FROM translation t
         WHERE t.entity_type = 'catalog_item' AND t.entity_id = $1 AND t.field = 'name' AND t.lang = 'ru'
         ON CONFLICT (entity_type, entity_id, field, lang)
         DO UPDATE SET status = 'failed', failure = 'wrong_language'`,
        [trw],
      );
      const rear = await itemByArticle("4050068800");
      await db.query("UPDATE catalog_item SET status = 'draft' WHERE id = $1", [rear]);

      const home = adminHomeSchema.parse((await asAdmin("get", "/admin/home", admin)).body);
      for (const card of Object.keys(adminHomeCatalogFilters) as Array<
        keyof typeof adminHomeCatalogFilters
      >) {
        const rows = await allRows(admin, adminHomeCatalogFilters[card]);
        expect(rows.length, card).toBe(home.catalog[card]);
        expect(rows.every((row) => row.status === "active")).toBe(true);
      }
      expect(home.catalog.withoutPhoto).toBeGreaterThan(0);
      expect(home.catalog.itemsWithoutTranslation).toBeGreaterThan(0);

      // The long way for the new rules: what they mean, not how they are written.
      const noPhoto = await allRows(admin, adminHomeCatalogFilters.withoutPhoto);
      expect(noPhoto.map((row) => row.id)).not.toContain(pads);
      const { rows: activeIds } = await db.query<{ id: string }>(
        "SELECT id FROM catalog_item WHERE status = 'active'",
      );
      const queue = await asAdmin(
        "get",
        "/admin/translations?entityType=catalog_item&limit=100",
        admin,
      );
      const untranslated = new Set(
        (queue.body.items as { entityId: string; state: string }[])
          .filter((entry) => entry.state === "missing" || entry.state === "failed")
          .map((entry) => entry.entityId),
      );
      const expected = activeIds.filter((row) => untranslated.has(row.id)).map((row) => row.id);
      const listed = await allRows(admin, adminHomeCatalogFilters.itemsWithoutTranslation);
      expect(listed.map((row) => row.id).sort()).toEqual(expected.sort());
      expect(listed.map((row) => row.id)).toContain(trw);
      expect(listed.map((row) => row.id)).not.toContain(pads);

      // Without compatibility: a service never is, a covered part isn't.
      const noCompatibility = await allRows(admin, adminHomeCatalogFilters.withoutCompatibility);
      expect(noCompatibility.map((row) => row.id)).not.toContain(pads);
      const { rows: services } = await db.query<{ id: string }>(
        "SELECT id FROM catalog_item WHERE item_type = 'service'",
      );
      for (const service of services) {
        expect(noCompatibility.map((row) => row.id)).not.toContain(service.id);
      }
    });

    it("lists the offers of an item, filters by offers on sale and tells the archiving numbers", async () => {
      const admin = await setUpAdmin();
      const { supplierId } = await seedAll();
      const pads = await itemByArticle("04465-0K090");
      const trw = await itemByArticle("GDB3534");
      await offerOn(supplierId, pads);
      const withdrawn = await offerOn(supplierId, trw);
      await db.query(
        "UPDATE offer SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'manual' WHERE id = $1",
        [withdrawn],
      );

      const withOffers = await allRows(admin, { hasOffers: "true" });
      expect(withOffers.map((row) => row.id)).toEqual([pads]);
      expect(withOffers[0]!.offersOnSale).toBe(1);
      const all = await allRows(admin, {});
      expect(all.find((row) => row.id === trw)!.offersOnSale).toBe(0);

      const response = await asAdmin("get", `/admin/catalog/items/${pads}/offers`, admin);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const offers = adminItemOffersResponseSchema.parse(response.body);
      expect(offers.onSale).toBe(1);
      expect(offers.activeOrders).toBe(0);
      expect(offers.offers[0]).toMatchObject({
        supplier: { id: supplierId, name: "Автомаркет" },
        price: 12_500,
        status: "active",
      });
      // The seeded point has its hours: the showcase shows the offer.
      expect(offers.offers[0]!.showcase).toEqual({ visible: true, reasons: [] });

      const trwOffers = adminItemOffersResponseSchema.parse(
        (await asAdmin("get", `/admin/catalog/items/${trw}/offers`, admin)).body,
      );
      expect(trwOffers.onSale).toBe(0);
      expect(trwOffers.offers.map((offer) => offer.status)).toEqual(["withdrawn"]);

      expectError(
        await asAdmin("get", `/admin/catalog/items/${uuid(99)}/offers`, admin),
        404,
        "NOT_FOUND",
      );
    });

    it("keeps the history of an item: itself, its translations, photos and compatibility", async () => {
      const admin = await setUpAdmin();
      await seedAll();
      const pads = await itemByArticle("04465-0K090");
      const trw = await itemByArticle("GDB3534");
      const edited = await http()
        .put(`/admin/translations/catalog_item/${pads}/name/kk`)
        .set("X-Client", ADMIN_WEB)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ text: "Тежегіш қалыптары, сынақ" });
      expect(edited.status).toBe(200);

      const page = auditLogPageSchema.parse(
        (await asAdmin("get", `/admin/audit-log?itemId=${pads}&limit=100`, admin)).body,
      );
      const kinds = new Set(page.entries.map((entry) => entry.entityType));
      expect(kinds).toEqual(new Set(["catalog_item", "catalog_translation", "item_compatibility"]));
      for (const entry of page.entries) {
        const named =
          entry.entityId === pads ||
          (entry.after as { itemId?: string } | null)?.itemId === pads ||
          (entry.before as { itemId?: string } | null)?.itemId === pads;
        expect(named, JSON.stringify(entry)).toBe(true);
      }
      // The analog's own records are its history, not this item's.
      const other = auditLogPageSchema.parse(
        (await asAdmin("get", `/admin/audit-log?itemId=${trw}&limit=100`, admin)).body,
      );
      expect(other.entries.some((entry) => entry.entityId === pads)).toBe(false);
      expect(other.entries.length).toBeGreaterThan(0);
    });

    it("checks one item against a car whatever its status, and locates attributes and options", async () => {
      const admin = await setUpAdmin();
      await seedAll();
      const pads = await itemByArticle("04465-0K090");
      const { rows: generations } = await db.query<{ id: string; make_id: string; name: string }>(
        `SELECT g.id, m.make_id, g.name FROM vehicle_generation g
         JOIN vehicle_model m ON m.id = g.model_id
         JOIN vehicle_model_spelling s ON s.model_id = m.id AND s.is_name AND s.text = 'Atlas'
         ORDER BY g.year_from`,
      );
      const second = generations.at(-1)!;
      const first = generations[0]!;
      const check = (vehicle: object | null) =>
        asAdmin("post", `/admin/catalog/items/${pads}/compatibility/check`, admin, { vehicle });

      const fits = adminCompatibilityCheckResponseSchema.parse(
        (await check({ makeId: second.make_id, generationId: second.id })).body,
      );
      expect(fits.result.result).toBe("fits");
      expect(fits.visibleToClients).toBe(true);
      const wrong = adminCompatibilityCheckResponseSchema.parse(
        (await check({ makeId: first.make_id, generationId: first.id })).body,
      );
      expect(wrong.result.result).toBe("does_not_fit");

      // A draft is checked too; clients don't see it.
      await db.query("UPDATE catalog_item SET status = 'draft' WHERE id = $1", [pads]);
      const draft = adminCompatibilityCheckResponseSchema.parse(
        (await check({ makeId: second.make_id, generationId: second.id })).body,
      );
      expect(draft.result.result).toBe("fits");
      expect(draft.visibleToClients).toBe(false);
      expectError(
        await asAdmin("post", `/admin/catalog/items/${uuid(98)}/compatibility/check`, admin, {}),
        404,
        "NOT_FOUND",
      );

      const { rows: options } = await db.query<{
        id: string;
        attribute_id: string;
        category_id: string;
      }>(
        `SELECT o.id, o.attribute_id, a.category_id FROM attribute_option o
         JOIN attribute a ON a.id = o.attribute_id LIMIT 1`,
      );
      const option = options[0]!;
      const byOption = catalogLocationSchema.parse(
        (await asAdmin("get", `/admin/catalog/locate?optionId=${option.id}`, admin)).body,
      );
      expect(byOption).toEqual({
        categoryId: option.category_id,
        attributeId: option.attribute_id,
        optionId: option.id,
      });
      const byAttribute = catalogLocationSchema.parse(
        (await asAdmin("get", `/admin/catalog/locate?attributeId=${option.attribute_id}`, admin))
          .body,
      );
      expect(byAttribute.optionId).toBeNull();
      expectError(
        await asAdmin(
          "get",
          `/admin/catalog/locate?attributeId=${option.attribute_id}&optionId=${option.id}`,
          admin,
        ),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("get", `/admin/catalog/locate?attributeId=${uuid(97)}`, admin),
        404,
        "NOT_FOUND",
      );
    });

    it("is for administrators only", async () => {
      const response = await http()
        .get(`/admin/catalog/items/${uuid(5)}/offers`)
        .set("X-Client", ADMIN_WEB);
      expectError(response, 401, "AUTH_REQUIRED");
    });
  });

  describe("signals (A-SIG)", () => {
    it("is taken in work and closed with a comment, with the version, the journal and the actor", async () => {
      const admin = await setUpAdmin();
      await db.query("UPDATE account SET name = 'Айгерим' WHERE id = $1", [admin.accountId]);
      const id = await insertSignal("frequent_admin_closes", "supplier", uuid(9));

      const taken = await asAdmin("post", `/admin/signals/${id}/acknowledge`, admin, {
        expectedVersion: 1,
      });
      expect(taken.status, JSON.stringify(taken.body)).toBe(200);
      const inWork = adminSignalResponseSchema.parse(taken.body).signal;
      expect(inWork).toMatchObject({
        status: "acknowledged",
        version: 2,
        acknowledgedBy: {
          kind: "admin",
          adminId: admin.adminId,
          name: "Айгерим",
          phoneMasked: "+7***4567",
        },
        closedBy: null,
      });

      // The same fact again: counted up, still in work, the version stays.
      await db.query("UPDATE admin_signal SET times = times + 1 WHERE id = $1", [id]);
      expectError(
        await asAdmin("post", `/admin/signals/${id}/acknowledge`, admin, { expectedVersion: 2 }),
        409,
        "SIGNAL_CONFLICT",
      );
      expectError(
        await asAdmin("post", `/admin/signals/${id}/close`, admin, {
          expectedVersion: 2,
          comment: "   ",
        }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", `/admin/signals/${id}/close`, admin, {
          expectedVersion: 1,
          comment: "Проверили",
        }),
        409,
        "SIGNAL_CONFLICT",
      );
      const closed = await asAdmin("post", `/admin/signals/${id}/close`, admin, {
        expectedVersion: 2,
        comment: "  Проверили, всё в порядке  ",
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(adminSignalResponseSchema.parse(closed.body).signal).toMatchObject({
        status: "closed",
        version: 3,
        closeComment: "Проверили, всё в порядке",
        closedBy: { kind: "admin", name: "Айгерим" },
      });

      const journal = auditLogPageSchema.parse(
        (await asAdmin("get", `/admin/audit-log?entityType=admin_signal&entityId=${id}`, admin))
          .body,
      );
      expect(journal.entries.map((entry) => [entry.action, entry.reason])).toEqual([
        ["admin_signal.closed", "Проверили, всё в порядке"],
        ["admin_signal.acknowledged", null],
      ]);
      expect(journal.entries[0]!.actor).toMatchObject({ role: "admin", name: "Айгерим" });
    });

    it("tells the second administrator who closed it first, and the server's own close", async () => {
      const first = await setUpAdmin();
      await db.query("UPDATE account SET name = 'Айгерим' WHERE id = $1", [first.accountId]);
      const second = await setUpAdmin(SECOND_ADMIN_PHONE);
      const id = await insertSignal("duplicate_after_late_close", "order", uuid(10));

      expect(
        (
          await asAdmin("post", `/admin/signals/${id}/close`, first, {
            expectedVersion: 1,
            comment: "Дубль, связались с клиентом",
          })
        ).status,
      ).toBe(200);
      const late = await asAdmin("post", `/admin/signals/${id}/close`, second, {
        expectedVersion: 1,
        comment: "Тоже проверил",
      });
      expectError(late, 409, "SIGNAL_CONFLICT");
      const now = adminSignalConflictDetailsSchema.parse(late.body.details).signal;
      expect(now).toMatchObject({ status: "closed", closedBy: { kind: "admin", name: "Айгерим" } });
      // Nothing of the second close was written.
      const { rows } = await db.query(
        "SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'admin_signal.closed'",
        [id],
      );
      expect(rows).toHaveLength(1);

      // The outage the server closes by itself has no administrator.
      const outage = await insertSignal("whatsapp_outage", "channel", uuid(11), "acknowledged");
      await db.query(
        "UPDATE admin_signal SET status = 'closed', closed_at = now(), version = version + 1 WHERE id = $1",
        [outage],
      );
      const list = adminSignalPageSchema.parse(
        (await asAdmin("get", "/admin/signals?kind=whatsapp_outage", first)).body,
      );
      expect(list.signals[0]).toMatchObject({
        status: "closed",
        closedBy: { kind: "system", adminId: null },
        closeComment: null,
      });
      expect(
        adminSignalPageSchema.parse(
          (await asAdmin("get", "/admin/signals?status=current", first)).body,
        ).total,
      ).toBe(0);
      expectError(
        await asAdmin("post", `/admin/signals/${uuid(77)}/acknowledge`, first, {
          expectedVersion: 1,
        }),
        404,
        "NOT_FOUND",
      );
    });
  });

  describe("the unreachable supplier (D-061)", () => {
    async function company(phones: string[]): Promise<string> {
      const operator = app.get(OperatorService);
      const { supplierId } = await operator.createSupplier({ name: "Шины Юг", city: "Астана" });
      for (const [index, phone] of phones.entries()) {
        await operator.addMember({ supplierId, phone, displayName: `Сотрудник ${index + 1}` });
      }
      await db.query(
        "UPDATE supplier_member SET notifications_enabled_at = now() WHERE supplier_id = $1",
        [supplierId],
      );
      return supplierId;
    }

    async function message(
      phone: string,
      outcome: "no_whatsapp" | "delivered" | "unavailable",
      minutesAgo = 1,
    ): Promise<void> {
      const at = `now() - make_interval(mins => ${minutesAgo})`;
      if (outcome === "delivered") {
        await db.query(
          `INSERT INTO outbound_message (dedupe_key, template, lang, phone, subject_type, status, provider,
             provider_message_id, sent_at, delivered_at, settled_at, attempts)
           VALUES (gen_random_uuid()::text, 'supplier_invitation', 'ru', $1, 'supplier_invitation', 'delivered',
             'whatsapp_cloud', gen_random_uuid()::text, ${at}, ${at}, ${at}, 1)`,
          [phone],
        );
        return;
      }
      await db.query(
        `INSERT INTO outbound_message (dedupe_key, template, lang, phone, subject_type, status, provider,
           failure_kind, settled_at, attempts)
         VALUES (gen_random_uuid()::text, 'supplier_invitation', 'ru', $1, 'supplier_invitation', 'failed',
           'whatsapp_cloud', $2, ${at}, 1)`,
        [phone, outcome],
      );
    }

    async function signalsOf(supplierId: string): Promise<AdminSignal[]> {
      const admin = await setUpAdminOnce();
      return adminSignalPageSchema.parse(
        (
          await asAdmin(
            "get",
            `/admin/signals?kind=supplier_unreachable&subjectId=${supplierId}`,
            admin,
          )
        ).body,
      ).signals;
    }

    let cachedAdmin: Admin | null = null;
    async function setUpAdminOnce(): Promise<Admin> {
      cachedAdmin ??= await setUpAdmin();
      return cachedAdmin;
    }
    beforeEach(() => {
      cachedAdmin = null;
    });

    const detect = () => worker.get(SupplierReachWatch).run();

    it("raises one signal for a company whose every recipient has no WhatsApp, and closes it by itself", async () => {
      const supplierId = await company(["+77051110001", "+77051110002"]);
      await message("+77051110001", "no_whatsapp", 10);
      await detect();
      // One recipient still unknown: the company is not judged unreachable.
      expect(await signalsOf(supplierId)).toEqual([]);

      await message("+77051110002", "no_whatsapp", 5);
      // A failure of the channel says nothing about the number.
      await message("+77051110001", "unavailable", 2);
      await detect();
      await detect();
      const [raised, ...rest] = await signalsOf(supplierId);
      expect(rest).toEqual([]);
      expect(raised).toMatchObject({
        status: "open",
        subjectType: "supplier",
        times: 1,
        payload: {
          supplierId,
          supplierName: "Шины Юг",
          recipients: 2,
          recipientsWithoutWhatsapp: 2,
        },
      });

      // A message reaches one of them again: the fact is over.
      await message("+77051110002", "delivered", 0);
      await detect();
      const [closed] = await signalsOf(supplierId);
      expect(closed).toMatchObject({ status: "closed", closedBy: { kind: "system" } });
      expect(closed!.payload.endedAt).toBeDefined();
      await detect();
      expect(await signalsOf(supplierId)).toHaveLength(1);
    });

    it("keeps a signal taken in work one signal, refreshed while the fact lasts", async () => {
      const supplierId = await company(["+77051110003"]);
      await message("+77051110003", "no_whatsapp", 10);
      await detect();
      const [first] = await signalsOf(supplierId);
      const admin = await setUpAdminOnce();
      expect(
        (
          await asAdmin("post", `/admin/signals/${first!.id}/acknowledge`, admin, {
            expectedVersion: first!.version,
          })
        ).status,
      ).toBe(200);
      await message("+77051110003", "no_whatsapp", 1);
      await detect();
      const [again, ...rest] = await signalsOf(supplierId);
      expect(rest).toEqual([]);
      expect(again).toMatchObject({ id: first!.id, status: "acknowledged", times: 2, version: 2 });

      // Closed by the administrator: the same refusals don't open it again…
      expect(
        (
          await asAdmin("post", `/admin/signals/${first!.id}/close`, admin, {
            expectedVersion: 2,
            comment: "Связались с поставщиком",
          })
        ).status,
      ).toBe(200);
      await detect();
      expect((await signalsOf(supplierId)).map((signal) => signal.status)).toEqual(["closed"]);
      // …a newer refusal does.
      await message("+77051110003", "no_whatsapp", 0);
      await detect();
      expect((await signalsOf(supplierId)).map((signal) => signal.status).sort()).toEqual([
        "closed",
        "open",
      ]);
    });
  });

  describe("the history of a setting, a page at a time", () => {
    it("pages by a cursor without gaps or repeats, and answers as before without one", async () => {
      const admin = await setUpAdmin();
      for (const hours of [3, 4, 5, 6, 7]) {
        await operatorSet({ supplier_response_hours: hours });
      }
      const all = settingHistoryResponseSchema.parse(
        (await asAdmin("get", "/admin/settings/supplier_response_hours/history", admin)).body,
      );
      expect(all.changes.map((change) => change.version)).toEqual([5, 4, 3, 2, 1]);
      expect(all.nextCursor).toBeNull();

      const versions: number[] = [];
      let cursor: string | null = "";
      while (cursor !== null) {
        const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
        const page = settingHistoryResponseSchema.parse(
          (await asAdmin("get", `/admin/settings/supplier_response_hours/history${query}`, admin))
            .body,
        );
        versions.push(...page.changes.map((change) => change.version));
        cursor = page.nextCursor;
        if (versions.length === 2) {
          // A change made while paging doesn't shift the older pages.
          await operatorSet({ supplier_response_hours: 8 });
        }
      }
      expect(versions).toEqual([5, 4, 3, 2, 1]);
      expectError(
        await asAdmin("get", "/admin/settings/supplier_response_hours/history?cursor=abc", admin),
        400,
        "VALIDATION_ERROR",
      );
    });
  });

  describe("security", () => {
    it("resets another administrator's second factor with a reason, and lists names and the last sign-in", async () => {
      const admin = await setUpAdmin();
      const other = await setUpAdmin(SECOND_ADMIN_PHONE);
      await db.query("UPDATE account SET name = 'Марат' WHERE id = $1", [other.accountId]);

      const list = administratorListResponseSchema.parse(
        (await asAdmin("get", "/admin/administrators", admin)).body,
      );
      expect(list.administrators.find((row) => row.id === other.adminId)).toMatchObject({
        name: "Марат",
        totpConfigured: true,
        current: false,
      });
      expect(list.administrators.find((row) => row.current)?.lastSignInAt).not.toBeNull();

      expectError(
        await asAdmin("post", `/admin/administrators/${other.adminId}/second-factor-reset`, admin, {
          reason: "  ",
        }),
        400,
        "VALIDATION_ERROR",
      );
      expectError(
        await asAdmin("post", `/admin/administrators/${admin.adminId}/second-factor-reset`, admin, {
          reason: "Сам себе",
        }),
        403,
        "TOTP_SELF_RESET_FORBIDDEN",
      );
      const reset = await asAdmin(
        "post",
        `/admin/administrators/${other.adminId}/second-factor-reset`,
        admin,
        { reason: "Потерял телефон" },
      );
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(reset.body.sessionsEnded).toBe(1);
      // The other administrator's session is over.
      expectError(await asAdmin("get", "/admin/home", other), 401, "SESSION_ENDED");

      const journal = auditLogPageSchema.parse(
        (await asAdmin("get", "/admin/audit-log?action=admin.totp_reset", admin)).body,
      );
      expect(journal.entries[0]).toMatchObject({
        entityId: other.adminId,
        reason: "Потерял телефон",
        actor: { role: "admin", phoneMasked: "+7***4567" },
      });
    });
  });
});
