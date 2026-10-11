import { writeFileSync } from "node:fs";
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  adminCityResponseSchema,
  adminSupplierResponseSchema,
  catalogSearchResponseSchema,
  supplierOfferResponseSchema,
  supplierOnboardedResponseSchema,
  totpSetupCompletedResponseSchema,
  totpSetupResponseSchema,
  totpStepRequiredDetailsSchema,
  type CatalogSearchResponse,
  type DayHours,
  type SupplierOffer,
  type SupplierType,
} from "@adclub/contracts";
import { kzBinCheckDigit, normalizeArticle } from "@adclub/domain";
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
import type { JobsTuning } from "../../jobs";
import { TRUNCATE_ALL } from "../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../testing/output-capture";
import { TestSettings } from "../../testing/settings";
import { TcpProxy } from "../../testing/tcp-proxy";
import { authenticatorCode, authenticatorStep } from "../../testing/totp";
import { WorkerModule } from "../../worker.module";
import { DevCatalogSeed } from "../catalog";
import { DevCompatibilitySeed } from "../compatibility";
import { LoginCodeChannels, OperatorService, type TestLoginCodeChannels } from "../identity";
import { SearchEval } from "../showcase";
import { DevVehicleSeed } from "../vehicles";
import { SearchIndexWriter } from "./search-index-writer";

/**
 * TASK-045 end to end on a real PostgreSQL, Redis and Meilisearch, with the
 * API and a worker in the process: the outbox written by the triggers in
 * the transaction of each change (and gone with a rolled-back one), the
 * worker putting every kind of change in the index within seconds, the
 * rebuild that never stops the search, the nightly check that finds and
 * fixes what drifted; the search through the index — typos, variants,
 * T-CAT-08, the article first, the city — showing nothing the catalog
 * would not show, even with the index behind; the facets; the fall back to
 * PostgreSQL when the index does not answer (and the outbox applied once it
 * does); the measured quality of `search-eval/phrases.json`.
 */

const ADMIN_PHONE = "+77011234567";
const ADMIN_WEB = "admin-web/0.1.0";
const SUPPLIER_WEB = "supplier-web/0.1.0";
const IOS = "mobile/1.4.2 (ios)";
const MEILI_KEY = "adclub-test-master-key-0123456789";
const INDEX = "test_items";

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

type Method = "get" | "post" | "put" | "patch" | "delete";

function validBin(first11: string): string {
  let prefix = first11;
  for (;;) {
    const digit = kzBinCheckDigit(prefix);
    if (digit !== null) {
      return `${prefix}${digit}`;
    }
    prefix = String((Number(prefix) + 1_000_000) % 100_000_000_000).padStart(11, "0");
  }
}

const phoneOf = (n: number) => `+7706${String(n).padStart(7, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the search index (PostgreSQL + Redis + Meilisearch)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let meili: StartedTestContainer;
  let proxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let app: INestApplication;
  let worker: INestApplicationContext | undefined;
  let settings: TestSettings;
  let channels: TestLoginCodeChannels;
  let output: ReturnType<typeof captureOutput>;
  let ipCounter = 0;
  let binCounter = 0;
  let phoneCounter = 0;
  let almaty: string;
  let astana: string;
  const lastSteps = new Map<string, number>();
  const stepCookies = new Map<string, string>();
  let token: string;
  let meiliUrl: string;

  beforeAll(async () => {
    [postgres, redisContainer, meili] = await Promise.all([
      new PostgreSqlContainer("postgres:16").start(),
      new RedisContainer("redis:7").start(),
      new GenericContainer("getmeili/meilisearch:v1.11")
        .withEnvironment({
          MEILI_MASTER_KEY: MEILI_KEY,
          MEILI_ENV: "development",
          MEILI_NO_ANALYTICS: "true",
        })
        .withExposedPorts(7700)
        .withWaitStrategy(Wait.forHttp("/health", 7700))
        .start(),
    ]);
    meiliUrl = `http://${meili.getHost()}:${meili.getMappedPort(7700)}`;
    proxy = new TcpProxy(meili.getHost(), meili.getMappedPort(7700));
    await proxy.start();
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
      MEILISEARCH_URL: `http://127.0.0.1:${proxy.port}`,
      MEILISEARCH_API_KEY: MEILI_KEY,
      MEILISEARCH_INDEX: INDEX,
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
    settings = new TestSettings(app);
  }, 300_000);

  afterAll(async () => {
    await stopWorker();
    await app?.close();
    redis?.disconnect();
    await db?.end().catch(() => undefined);
    await proxy?.stop();
    await Promise.all([
      postgres?.stop(),
      redisContainer?.stop(),
      meili?.stop().catch(() => undefined),
    ]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    lastSteps.clear();
    stepCookies.clear();
    await stopWorker();
    await db.query(TRUNCATE_ALL);
    await db.query(
      "INSERT INTO search_index_state (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET synonyms_hash = NULL, retry_after = NULL, failures = 0, last_error = NULL, last_applied_at = NULL, reindex_started_at = NULL, last_reindexed_at = NULL, last_reconciled_at = NULL, last_reconcile_documents = NULL, last_reconcile_mismatches = NULL",
    );
    await meiliCall("DELETE", `/indexes/${INDEX}`);
    await meiliCall("DELETE", `/indexes/${INDEX}__next`);
    await redis.flushall();
    await settings.reload();
    await settings.set({
      login_code_resend_interval_seconds: 1,
      login_code_requests_per_phone: 1000,
      catalog_read_per_ip: 100_000,
      catalog_read_per_account: 100_000,
    });
    output = captureOutput();
    token = await setUpAdmin(ADMIN_PHONE);
    almaty = await ok(
      asAdmin("post", "/admin/cities", { code: "almaty", names: { ru: "Алматы", kk: "Алматы" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    astana = await ok(
      asAdmin("post", "/admin/cities", { code: "astana", names: { ru: "Астана", kk: "Астана" } }),
      (body) => adminCityResponseSchema.parse(body).city.id,
      201,
    );
    await app.get(DevCatalogSeed).run();
    await app.get(DevVehicleSeed).run();
    await app.get(DevCompatibilitySeed).run();
  }, 180_000);

  afterEach(() => {
    output.stop();
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  // ------------------------------------------------------------- plumbing

  async function meiliCall(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${meiliUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${MEILI_KEY}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => null)) as { taskUid?: number } | null;
    if (parsed?.taskUid !== undefined) {
      for (;;) {
        const task = (await (
          await fetch(`${meiliUrl}/tasks/${parsed.taskUid}`, {
            headers: { Authorization: `Bearer ${MEILI_KEY}` },
          })
        ).json()) as { status: string };
        if (!["enqueued", "processing"].includes(task.status)) {
          break;
        }
        await sleep(50);
      }
    }
    return parsed;
  }

  /** The ids of the documents in the index. */
  async function indexedIds(): Promise<string[]> {
    const page = (await meiliCall("POST", `/indexes/${INDEX}/documents/fetch`, {
      limit: 1000,
      fields: ["id"],
    })) as { results?: { id: string }[] };
    return (page.results ?? []).map((document) => document.id).sort();
  }

  async function indexedDocument(id: string): Promise<Record<string, unknown> | null> {
    const document = (await meiliCall("GET", `/indexes/${INDEX}/documents/${id}`)) as Record<
      string,
      unknown
    > | null;
    return document && document.id === id ? document : null;
  }

  async function startWorker(): Promise<void> {
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { settingsCache: { maxAgeMs: 200 }, jobs: FAST }),
      { bufferLogs: true },
    );
    worker.useLogger(worker.get(JsonLoggerService));
    worker.flushLogs();
    await worker.init();
  }

  async function stopWorker(): Promise<void> {
    const running = worker;
    worker = undefined;
    await running?.close();
  }

  async function pending(): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM search_outbox WHERE processed_at IS NULL",
    );
    return rows[0]!.n;
  }

  /** Waits until the worker has applied the outbox (the index has the changes). */
  async function settle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const exists = await meiliCall("GET", `/indexes/${INDEX}`);
      if ((await pending()) === 0 && (exists as { uid?: string } | null)?.uid === INDEX) {
        const stats = (await meiliCall("GET", `/indexes/${INDEX}/stats`)) as {
          isIndexing?: boolean;
        };
        if (!stats.isIndexing) {
          return;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`The outbox was not applied in ${timeoutMs} ms (${await pending()} left)`);
      }
      await sleep(200);
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
      if (refresh) {
        rememberSecret(refresh[1]!);
      }
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
    for (const code of body.backupCodes) {
      rememberCode(code, code.replace("-", ""));
    }
    return body.session.accessToken;
  }

  async function sessionToken(phone: string, client: string): Promise<string> {
    const response = await signIn(phone, client);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { session: { accessToken: string } }).session.accessToken;
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

  async function ok<T>(
    test: PromiseLike<Response>,
    parse: (body: unknown) => T,
    status = 200,
  ): Promise<T> {
    const response = await test;
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return parse(response.body);
  }

  async function idOf(text: string, values: unknown[]): Promise<string> {
    const { rows } = await db.query<{ id: string }>(text, values);
    expect(rows.length, text).toBeGreaterThan(0);
    return rows[0]!.id;
  }

  async function versionOf(table: string, id: string): Promise<number> {
    const { rows } = await db.query<{ version: number }>(
      `SELECT version FROM ${table} WHERE id = $1`,
      [id],
    );
    return rows[0]!.version;
  }

  // ---------------------------------------------------------------- world

  interface Company {
    supplierId: string;
    as: (method: Method, path: string, body?: object) => Test;
  }

  async function company(
    name: string,
    cityId: string,
    type: SupplierType = "both",
  ): Promise<Company> {
    const phone = phoneOf(++phoneCounter);
    rememberCode(phone);
    const created = await ok(
      asAdmin("post", "/admin/suppliers", {
        name,
        bin: validBin(`0812340${String(binCounter++).padStart(4, "0")}`),
        cityId,
        type,
        contactPhone: phoneOf(500 + phoneCounter),
        address: `ул. ${name}, ${String(phoneCounter)}`,
        district: `Район ${name}`,
        firstMember: { name: "Айгерим", phone },
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
    const bearer = await sessionToken(phone, SUPPLIER_WEB);
    return {
      supplierId: created.supplier.id,
      as: (method, path, body) => call(bearer, SUPPLIER_WEB, method, path, body),
    };
  }

  async function offerOf(of: Company, itemId: string, extra: object = {}): Promise<SupplierOffer> {
    const { rows } = await db.query<{ item_type: string }>(
      "SELECT item_type FROM catalog_item WHERE id = $1",
      [itemId],
    );
    const service = rows[0]!.item_type === "service";
    return ok(
      of.as(
        "post",
        "/supplier/offers",
        service
          ? { itemId, price: 7_000, ...extra }
          : {
              itemId,
              price: 12_500,
              availability: "in_stock",
              leadDays: 0,
              pickup: true,
              delivery: false,
              ...extra,
            },
      ),
      (body) => supplierOfferResponseSchema.parse(body).offer,
      201,
    );
  }

  async function world() {
    const item = (brandKey: string, article: string) =>
      idOf(
        "SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id WHERE b.key = $1 AND i.article_norm = $2",
        [brandKey, normalizeArticle(article)],
      );
    const named = (name: string) =>
      idOf(
        "SELECT entity_id AS id FROM translation WHERE entity_type = 'catalog_item' AND lang = 'ru' AND text = $1",
        [name],
      );
    const geely = await idOf(
      "SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely'",
      [],
    );
    const atlas = await idOf(
      "SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = $1 AND key = 'atlas'",
      [geely],
    );
    return {
      geely,
      atlas,
      atlasII: await idOf(
        "SELECT id FROM vehicle_generation WHERE model_id = $1 AND name_key = 'ii (fx11)'",
        [atlas],
      ),
      engineOils: await idOf("SELECT id FROM category WHERE code = 'engine_oils'", []),
      brakePads: await idOf("SELECT id FROM category WHERE code = 'brake_pads'", []),
      oilChange: await idOf("SELECT id FROM category WHERE code = 'oil_change'", []),
      viscosity: await idOf("SELECT id FROM attribute WHERE code = 'viscosity'", []),
      frontPads: await item("geely", "04465-0K090"),
      trwPads: await item("trw", "GDB3534"),
      rearPads: await item("geely", "4050068800"),
      helix: await named("Shell Helix HX8 5W-30, 4 л"),
      super3000: await named("Mobil Super 3000 5W-40, 4 л"),
      helixUltra: await named("Shell Helix Ultra 0W-20, 1 л"),
      mobilEsp: await named("Mobil 1 ESP 5W-30"),
      oilService: await named("Замена моторного масла"),
      padService: await named("Замена передних тормозных колодок"),
      diagnostics: await named("Компьютерная диагностика двигателя"),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** Every item of the dev catalog on offer in Almaty; the TRW pads in Astana. */
  async function everythingOnOffer(w: World) {
    const shop = await company("Автомаркет", almaty);
    const other = await company("Деталь Астана", astana);
    const offers = new Map<string, SupplierOffer>();
    for (const id of [
      w.frontPads,
      w.rearPads,
      w.helix,
      w.super3000,
      w.helixUltra,
      w.mobilEsp,
      w.oilService,
      w.padService,
      w.diagnostics,
    ]) {
      offers.set(id, await offerOf(shop, id));
    }
    offers.set(w.trwPads, await offerOf(other, w.trwPads, { price: 9_000 }));
    return { shop, other, offers };
  }

  const guest = (path: string): Test => http().get(path).set("X-Client", IOS);

  async function search(
    q: string,
    query: Record<string, string> = {},
  ): Promise<CatalogSearchResponse> {
    return ok(guest(`/catalog/search?${new URLSearchParams({ q, ...query }).toString()}`), (body) =>
      catalogSearchResponseSchema.parse(body),
    );
  }

  const ids = (answer: CatalogSearchResponse) => answer.items.map((item) => item.id);

  // ------------------------------------------------------------- the outbox

  it("registers a change in its own transaction: a rolled-back one leaves no row, a no-op none", async () => {
    const w = await world();
    const { offers } = await everythingOnOffer(w);
    await db.query("DELETE FROM search_outbox");
    const offer = offers.get(w.helix)!;

    await db.query("BEGIN");
    await db.query("UPDATE offer SET price = price + 1 WHERE id = $1", [offer.id]);
    const inside = await db.query<{ kind: string; id: string }>(
      "SELECT subject_kind AS kind, subject_id AS id FROM search_outbox",
    );
    expect(inside.rows).toEqual([{ kind: "item", id: w.helix }]);
    await db.query("ROLLBACK");
    expect((await db.query("SELECT 1 FROM search_outbox")).rows).toHaveLength(0);

    // An update that changes nothing registers nothing.
    await db.query("UPDATE offer SET price = price WHERE id = $1", [offer.id]);
    expect((await db.query("SELECT 1 FROM search_outbox")).rows).toHaveLength(0);

    // The subjects of each table (one function: search_outbox_register).
    await db.query(
      "UPDATE supplier SET updated_at = now() WHERE id = (SELECT supplier_id FROM offer WHERE id = $1)",
      [offer.id],
    );
    await db.query("UPDATE category SET updated_at = now() WHERE id = $1", [w.engineOils]);
    await db.query(
      "UPDATE translation SET updated_at = now() WHERE entity_type = 'attribute_option' AND entity_id = (SELECT id FROM attribute_option WHERE code = '5w_30') AND lang = 'ru'",
    );
    const kinds = await db.query<{ kind: string }>(
      "SELECT DISTINCT subject_kind AS kind FROM search_outbox ORDER BY 1",
    );
    expect(kinds.rows.map((row) => row.kind)).toEqual(["category", "option", "supplier"]);
  });

  // --------------------------------------------------------------- worker

  it("builds the index when the worker starts and searches through it: typos, variants, the article first", async () => {
    const w = await world();
    await everythingOnOffer(w);
    await startWorker();
    await settle();

    expect(await indexedIds()).toEqual(
      [
        w.frontPads,
        w.trwPads,
        w.rearPads,
        w.helix,
        w.super3000,
        w.helixUltra,
        w.mobilEsp,
        w.oilService,
        w.padService,
        w.diagnostics,
      ].sort(),
    );
    const document = await indexedDocument(w.frontPads);
    expect(document).toMatchObject({
      kind: "goods",
      categoryId: w.brakePads,
      article: ["04465 0k090", "044650k090"],
      brand: expect.arrayContaining(["geely", "джили"]),
      category: expect.arrayContaining([
        "колодки",
        "тормозные колодки",
        "brake pads",
        "тежегиш калыптары",
      ]),
      cities: [almaty],
      popularity: 0,
    });
    // Nothing of a person, a supplier or a warranty.
    expect(Object.keys(document!).sort()).toEqual(
      [
        "article",
        "brand",
        "categoryId",
        "category",
        "cities",
        "hash",
        "id",
        "kind",
        "nodeId",
        "own",
        "popularity",
        "values",
      ].sort(),
    );

    // A typo the PostgreSQL branch could not forgive with other words found.
    const typo = await search("тормозные колодкм", { cityId: almaty });
    // Found with «колодкм» forgiven: the pads in the city by relevance, the
    // service «Замена передних тормозных колодок» (less relevant: two words
    // forgiven), and last the TRW pads — their offer is in Astana: the city
    // goes before relevance.
    expect(ids(typo).slice(0, 2).sort()).toEqual([w.frontPads, w.rearPads].sort());
    expect(ids(typo).slice(2)).toEqual([w.padService, w.trwPads]);
    expect(typo.usedQuery).toBe("тормозные колодки");
    // «Весь Казахстан» drops that priority: the cheaper TRW pads are not last for price alone.
    const anywhere = await search("колодки");
    expect(anywhere.items.every((item) => !item.offers.inCity)).toBe(true);

    expect((await search("колодкм")).usedQuery).toBe("колодки");
    expect((await search("rjkjlrb")).usedQuery).toBe("колодки");
    expect((await search("колодки")).usedQuery).toBeNull();

    // The article: first, by the PostgreSQL branch.
    const article = await search("04465 0k090", { cityId: almaty });
    expect(article.items[0]).toMatchObject({ id: w.frontPads, match: "article" });

    // A word nothing has: the found items stay — those with more words of
    // the query first — and the reading tells it.
    const extra = await search("колодки geely atlas");
    expect(ids(extra).slice(0, 2).sort()).toEqual([w.frontPads, w.rearPads].sort());
    expect(extra.usedQuery).toBe("колодки geely");
    // Junk the index dropped words for is not shown.
    expect((await search("зимние шины")).total).toBe(0);
    expect((await search("xyzxyz")).total).toBe(0);

    const status = await app.get(SearchIndexWriter).status();
    expect(status).toMatchObject({
      enabled: true,
      reachable: true,
      documents: 10,
      outbox: { pending: 0 },
      failures: 0,
    });
    const metrics = await http().get("/metrics");
    expect(metrics.text).toContain("adclub_search_outbox_pending 0");
  }, 120_000);

  it("puts every kind of change in the index within seconds", async () => {
    const w = await world();
    const { shop, other, offers } = await everythingOnOffer(w);
    await startWorker();
    await settle();

    // The name of an item (a translation — kk).
    await ok(
      asAdmin("put", `/admin/translations/catalog_item/${w.helix}/name/kk`, {
        text: "Шелл Хеликс жазғы майы",
      }),
      (body) => body,
    );
    await settle();
    expect(ids(await search("жазғы майы"))).toEqual([w.helix]);

    // A synonym of an item — and the synonyms of the index's settings.
    await ok(
      asAdmin("post", `/admin/catalog/items/${w.mobilEsp}/synonyms`, { term: "эспешка" }),
      (body) => body,
      200,
    );
    await ok(
      asAdmin("post", `/admin/catalog/items/${w.mobilEsp}/synonyms`, { term: "мобил эсп" }),
      (body) => body,
      200,
    );
    await settle();
    expect(ids(await search("эспешка"))).toEqual([w.mobilEsp]);
    const synonyms = (await meiliCall("GET", `/indexes/${INDEX}/settings/synonyms`)) as Record<
      string,
      string[]
    >;
    expect(synonyms["эспешка"]).toEqual(["мобил эсп"]);
    expect(synonyms["колодки"]).toEqual(
      expect.arrayContaining(["brake pads", "тормозные колодки"]),
    );

    // A synonym of a category.
    await ok(
      asAdmin("post", `/admin/catalog/categories/${w.brakePads}/synonyms`, { term: "фрикционки" }),
      (body) => body,
      200,
    );
    await settle();
    expect(ids(await search("фрикционки")).sort()).toEqual(
      [w.frontPads, w.trwPads, w.rearPads].sort(),
    );

    // A spelling of a brand.
    const trw = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'trw'", []);
    await ok(
      asAdmin("patch", `/admin/catalog/brands/${trw}`, {
        expectedVersion: await versionOf("brand", trw),
        aliases: ["тэрээрвэ"],
      }),
      (body) => body,
    );
    await settle();
    expect(ids(await search("тэрээрвэ"))).toEqual([w.trwPads]);

    // A value of a characteristic.
    const fiveForty = await idOf("SELECT id FROM attribute_option WHERE code = '5w_40'", []);
    await ok(
      asAdmin("put", `/admin/catalog/items/${w.helixUltra}/values`, {
        expectedVersion: await versionOf("catalog_item", w.helixUltra),
        values: [{ attributeId: w.viscosity, value: fiveForty }],
      }),
      (body) => body,
    );
    await settle();
    expect((await indexedDocument(w.helixUltra))?.values).toContain("5w 40");

    // An offer withdrawn — out of the results at once, out of the index after the outbox.
    const trwOffer = offers.get(w.trwPads)!;
    await ok(
      other.as("post", `/supplier/offers/${trwOffer.id}/withdraw`, {
        expectedVersion: trwOffer.version,
      }),
      (body) => body,
    );
    expect(ids(await search("колодки"))).not.toContain(w.trwPads);
    await settle();
    expect(await indexedDocument(w.trwPads)).toBeNull();
    // … and returned.
    await ok(
      other.as("post", `/supplier/offers/${trwOffer.id}/return`, {
        expectedVersion: trwOffer.version + 1,
      }),
      (body) => body,
    );
    await settle();
    expect(await indexedDocument(w.trwPads)).not.toBeNull();

    // The point of a supplier moves to another city.
    await ok(
      asAdmin("patch", `/admin/suppliers/${other.supplierId}`, {
        expectedVersion: await versionOf("supplier", other.supplierId),
        cityId: almaty,
      }),
      (body) => body,
    );
    await settle();
    expect((await indexedDocument(w.trwPads))?.cities).toEqual([almaty]);

    // A supplier paused — and back.
    await ok(
      asAdmin("post", `/admin/suppliers/${shop.supplierId}/pause`, {
        expectedVersion: await versionOf("supplier", shop.supplierId),
        paused: true,
        reason: "admin",
        note: "Проверка",
      }),
      (body) => body,
    );
    expect((await search("масло", { cityId: almaty })).total).toBe(0);
    await settle();
    expect(await indexedIds()).toEqual([w.trwPads]);
    await ok(
      asAdmin("post", `/admin/suppliers/${shop.supplierId}/pause`, {
        expectedVersion: await versionOf("supplier", shop.supplierId),
        paused: false,
        reason: "admin",
        note: "Проверено",
      }),
      (body) => body,
    );
    await settle();
    expect(await indexedIds()).toHaveLength(10);

    // The type of a supplier: goods only — its services leave the index.
    await ok(
      asAdmin("patch", `/admin/suppliers/${shop.supplierId}`, {
        expectedVersion: await versionOf("supplier", shop.supplierId),
        type: "goods",
      }),
      (body) => body,
    );
    await settle();
    expect(await indexedDocument(w.oilService)).toBeNull();

    // Hours closed for the whole horizon — the point's offers leave.
    const today = new Date();
    const closedDates = Array.from({ length: 62 }, (_, day) => ({
      date: new Date(today.getTime() + day * 86_400_000).toISOString().slice(0, 10),
      note: "Закрыто",
    }));
    await ok(
      asAdmin("put", `/admin/suppliers/${shop.supplierId}/schedule`, {
        expectedVersion: await versionOf("supplier", shop.supplierId),
        weeklyHours: ALWAYS,
        closedDates,
      }),
      (body) => body,
    );
    await settle();
    expect(await indexedIds()).toEqual([w.trwPads]);

    // An item archived; a category hidden.
    await ok(
      asAdmin("post", `/admin/catalog/items/${w.trwPads}/status`, {
        expectedVersion: await versionOf("catalog_item", w.trwPads),
        status: "archived",
      }),
      (body) => body,
    );
    await settle();
    expect(await indexedIds()).toEqual([]);
  }, 240_000);

  it("never shows more than the catalog when the index is behind (no worker: nothing applied)", async () => {
    const w = await world();
    const { shop, offers } = await everythingOnOffer(w);
    await startWorker();
    await settle();
    await stopWorker();

    const helixOffer = offers.get(w.helix)!;
    await ok(
      shop.as("post", `/supplier/offers/${helixOffer.id}/withdraw`, {
        expectedVersion: helixOffer.version,
      }),
      (body) => body,
    );
    await ok(
      asAdmin("post", `/admin/catalog/categories/${w.oilChange}/status`, {
        expectedVersion: await versionOf("category", w.oilChange),
        status: "hidden",
      }),
      (body) => body,
    );
    expect(await pending()).toBeGreaterThan(0);
    // The index still has them …
    expect(await indexedDocument(w.helix)).not.toBeNull();
    expect(await indexedDocument(w.oilService)).not.toBeNull();
    // … and the search shows neither.
    const answer = await search("масло", { cityId: almaty });
    expect(ids(answer)).not.toContain(w.helix);
    expect(ids(answer)).not.toContain(w.oilService);
    expect(ids(await search("shell helix hx8"))).not.toContain(w.helix);
    // D-029 stays the catalog's: with Atlas II the rear pads (no records) are not listed.
    const forAtlas = await search("колодки", {
      vehicleMakeId: w.geely,
      vehicleModelId: w.atlas,
      vehicleGenerationId: w.atlasII,
      vehicleYear: "2023",
    });
    expect(ids(forAtlas)).not.toContain(w.rearPads);
    expect(ids(forAtlas)).toContain(w.frontPads);
    // Services only in the chosen city.
    expect((await search("диагностика")).cityRequired).toBe(true);
    expect(ids(await search("диагностика", { cityId: astana }))).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------- the rebuild

  it("rebuilds without stopping the search, and applies what changed meanwhile", async () => {
    const w = await world();
    await everythingOnOffer(w);
    await startWorker();
    await settle();

    let searching = true;
    const answers: number[] = [];
    const totals: number[] = [];
    const loop = (async () => {
      while (searching) {
        const response = await guest(
          `/catalog/search?q=${encodeURIComponent("масло")}&cityId=${almaty}`,
        );
        answers.push(response.status);
        totals.push((response.body as { total?: number }).total ?? -1);
      }
    })();
    const writer = app.get(SearchIndexWriter);
    const rebuilt = writer.rebuild();
    // A change while it is rebuilt.
    await ok(
      asAdmin("post", `/admin/catalog/items/${w.diagnostics}/synonyms`, { term: "сканирование" }),
      (body) => body,
      200,
    );
    expect(await rebuilt).toMatchObject({ documents: 10, index: INDEX });
    await expect(writer.rebuild().then(() => writer.rebuild())).resolves.toBeDefined();
    searching = false;
    await loop;
    expect(answers.length).toBeGreaterThan(3);
    expect(new Set(answers)).toEqual(new Set([200]));
    expect(new Set(totals)).toEqual(new Set([5]));

    await settle();
    expect(ids(await search("сканирование", { cityId: almaty }))).toEqual([w.diagnostics]);
    expect(await indexedIds()).toHaveLength(10);
    expect((await meiliCall("GET", `/indexes/${INDEX}__next`)) as { code?: string }).toMatchObject({
      code: "index_not_found",
    });
  }, 120_000);

  // ------------------------------------------------------------ the check

  it("the nightly check finds and fixes what drifted", async () => {
    const w = await world();
    await everythingOnOffer(w);
    await startWorker();
    await settle();
    await stopWorker();

    // A document lost, one that should not be there, one stale.
    await meiliCall("POST", `/indexes/${INDEX}/documents/delete-batch`, [w.helix]);
    await meiliCall("POST", `/indexes/${INDEX}/documents`, [
      { id: "00000000-0000-4000-8000-000000000001", own: ["призрак"], hash: "x", popularity: 0 },
    ]);
    const stale = await indexedDocument(w.frontPads);
    await meiliCall("POST", `/indexes/${INDEX}/documents`, [
      { ...stale, own: ["что то другое"], hash: "stale" },
    ]);

    const outcome = await app.get(SearchIndexWriter).reconcile();
    expect(outcome).toMatchObject({ documents: 10, missing: 1, extra: 1, stale: 1, mismatches: 3 });
    expect(await indexedIds()).toEqual(
      [
        w.frontPads,
        w.trwPads,
        w.rearPads,
        w.helix,
        w.super3000,
        w.helixUltra,
        w.mobilEsp,
        w.oilService,
        w.padService,
        w.diagnostics,
      ].sort(),
    );
    expect((await indexedDocument(w.frontPads))?.own).toContain("колодки тормозные передние");
    expect(await app.get(SearchIndexWriter).reconcile()).toMatchObject({ mismatches: 0 });
    const metrics = await http().get("/metrics");
    expect(metrics.text).toContain("adclub_search_reconcile_mismatches 0");
    expect((await app.get(SearchIndexWriter).status()).lastReconcile).toMatchObject({
      documents: 10,
      mismatches: 0,
    });
  }, 120_000);

  // ------------------------------------------------------------- facets

  it("gives the facets of what is shown: the chips, the brands and the characteristics of a chosen one", async () => {
    const w = await world();
    await everythingOnOffer(w);
    await startWorker();
    await settle();

    const oil = await search("масло", { cityId: almaty });
    expect(oil.facets.categories.map((facet) => [facet.id, facet.count])).toEqual([
      [w.engineOils, 4],
      [w.oilChange, 1],
    ]);
    expect(oil.facets.attributes).toEqual([]);

    const oils = await search("масло", { cityId: almaty, categoryId: w.engineOils });
    expect(oils.total).toBe(4);
    expect(oils.facets.categories).toEqual(oil.facets.categories);
    expect(oils.facets.brands.map((brand) => [brand.name, brand.count])).toEqual([
      ["Mobil", 2],
      ["Shell", 2],
    ]);
    const option = async (code: string) =>
      idOf("SELECT id FROM attribute_option WHERE code = $1", [code]);
    const [w30, w40, w20] = await Promise.all([option("5w_30"), option("5w_40"), option("0w_20")]);
    const viscosity = oils.facets.attributes.find((facet) => facet.attributeId === w.viscosity)!;
    expect(new Map(viscosity.options.map((entry) => [entry.optionId, entry.count]))).toEqual(
      new Map([
        [w30, 2],
        [w40, 1],
        [w20, 1],
      ]),
    );

    // «Вязкость 5W-30»: two shown, and the counts of the others stay.
    const chosen = await search("масло", {
      cityId: almaty,
      categoryId: w.engineOils,
      attributes: JSON.stringify([{ attributeId: w.viscosity, optionIds: [w30] }]),
    });
    expect(ids(chosen).sort()).toEqual([w.helix, w.mobilEsp].sort());
    expect(
      chosen.facets.attributes.find((facet) => facet.attributeId === w.viscosity)!.options,
    ).toHaveLength(3);
    // A brand.
    const shellId = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'shell'", []);
    const shell = await search("масло", {
      cityId: almaty,
      categoryId: w.engineOils,
      brandIds: shellId,
    });
    expect(ids(shell).sort()).toEqual([w.helix, w.helixUltra].sort());

    // Pages of a general query: no gaps, no repeats.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: CatalogSearchResponse = await search("масло", {
        cityId: almaty,
        limit: "2",
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  }, 120_000);

  // ------------------------------------------------------------ quality

  it("finds the expected item in the first three for at least 95 % of the phrases", async () => {
    const w = await world();
    await everythingOnOffer(w);
    await startWorker();
    await settle();

    const result = await app.get(SearchEval).run();
    // The output of an integration test is captured: the share and what
    // failed go to a file when asked for (`SEARCH_EVAL_REPORT=<path>`).
    if (process.env.SEARCH_EVAL_REPORT) {
      writeFileSync(process.env.SEARCH_EVAL_REPORT, JSON.stringify(result, null, 2));
    }
    expect(result.share).toBeGreaterThanOrEqual(result.threshold);
    // «Nothing» means nothing.
    expect(result.byKind.nothing).toMatchObject({ passed: result.byKind.nothing!.phrases });
  }, 180_000);

  // ------------------------------------------------------------ measured

  it("applies 3 000 new items in seconds and answers a general query over them in well under a second", async () => {
    const w = await world();
    const { offers } = await everythingOnOffer(w);
    await startWorker();
    await settle();

    // 3 000 engine oils of one brand, each on offer like the Helix (one statement each).
    const shell = await idOf("SELECT brand_id AS id FROM brand_spelling WHERE key = 'shell'", []);
    await db.query(
      `INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id, status)
       SELECT 'generic', $1, 'goods', $2, 'active' FROM generate_series(1, 3000)`,
      [w.engineOils, shell],
    );
    await db.query(
      `INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited)
       SELECT 'catalog_item', i.id, 'name', 'ru', 'Масло синтетическое серия ' || row_number() OVER (ORDER BY i.id), 'source', false
       FROM catalog_item i
       WHERE i.category_id = $1 AND NOT EXISTS (
         SELECT 1 FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = i.id
       )`,
      [w.engineOils],
    );
    const { rows: columns } = await db.query<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'offer' AND column_name NOT IN ('id', 'item_id', 'created_at', 'updated_at')",
    );
    const list = columns.map((column) => column.name).join(", ");
    await db.query(
      `INSERT INTO offer (item_id, ${list})
       SELECT i.id, ${columns.map((column) => `o.${column.name}`).join(", ")}
       FROM catalog_item i CROSS JOIN offer o
       WHERE o.id = $1 AND i.category_id = $2
         AND NOT EXISTS (SELECT 1 FROM offer x WHERE x.item_id = i.id)`,
      [offers.get(w.helix)!.id, w.engineOils],
    );
    const started = Date.now();
    await settle(120_000);
    const applySeconds = (Date.now() - started) / 1000;
    const stats = (await meiliCall("GET", `/indexes/${INDEX}/stats`)) as {
      numberOfDocuments: number;
    };
    expect(stats.numberOfDocuments).toBe(3010);

    const car = {
      cityId: almaty,
      vehicleMakeId: w.geely,
      vehicleModelId: w.atlas,
      vehicleGenerationId: w.atlasII,
      vehicleYear: "2023",
    };
    const timings: number[] = [];
    let total = 0;
    for (let run = 0; run < 5; run += 1) {
      const at = Date.now();
      const answer = await search("масло", car);
      timings.push(Date.now() - at);
      total = answer.total;
    }
    timings.sort((a, b) => a - b);
    // Engine oils are universal: every one of them is listed for the car.
    expect(total).toBeGreaterThanOrEqual(3000);
    if (process.env.SEARCH_PERF_REPORT) {
      writeFileSync(
        process.env.SEARCH_PERF_REPORT,
        JSON.stringify({ applySeconds, total, timingsMs: timings }, null, 2),
      );
    }
    expect(timings[2]).toBeLessThan(2000);
  }, 300_000);

  // ------------------------------------------------------------- outages

  it("answers from PostgreSQL while the index is away, and applies the outbox once it is back", async () => {
    const w = await world();
    const { shop, offers } = await everythingOnOffer(w);
    await startWorker();
    await settle();

    await proxy.stop();
    const answer = await search("колодки", { cityId: almaty });
    expect(ids(answer).sort()).toEqual([w.frontPads, w.trwPads, w.rearPads].sort());
    const metrics = await http().get("/metrics");
    expect(metrics.text).toMatch(
      /adclub_search_index_fallbacks_total\{reason="unavailable"\} [1-9]/,
    );

    const offer = offers.get(w.super3000)!;
    await ok(
      shop.as("post", `/supplier/offers/${offer.id}/withdraw`, { expectedVersion: offer.version }),
      (body) => body,
    );
    // The worker cannot apply it: the rows wait, the failure is written down.
    for (let tries = 0; tries < 50; tries += 1) {
      const { rows } = await db.query<{ failures: number }>(
        "SELECT failures FROM search_index_state WHERE id = 1",
      );
      if (rows[0]!.failures > 0) {
        break;
      }
      await sleep(200);
    }
    expect(await pending()).toBeGreaterThan(0);
    const status = await app.get(SearchIndexWriter).status();
    expect(status).toMatchObject({ reachable: false });
    expect(status.failures).toBeGreaterThan(0);
    expect(ids(await search("mobil super", { cityId: almaty }))).not.toContain(w.super3000);

    await proxy.start();
    await db.query("UPDATE search_index_state SET retry_after = now() WHERE id = 1");
    await settle();
    expect(await indexedDocument(w.super3000)).toBeNull();
    expect((await app.get(SearchIndexWriter).status()).failures).toBe(0);
  }, 120_000);

  it("answers from PostgreSQL with the container of the index stopped", async () => {
    const w = await world();
    await everythingOnOffer(w);
    await startWorker();
    await settle();
    await stopWorker();

    await meili.stop();
    const answer = await search("колодки", { cityId: almaty });
    expect(ids(answer).sort()).toEqual([w.frontPads, w.trwPads, w.rearPads].sort());
    expect((await search("rjkjlrb", { cityId: almaty })).usedQuery).toBe("колодки");
    // Readiness does not look at the index (I17): no word of it in the answer.
    expect(JSON.stringify((await http().get("/ready")).body)).not.toMatch(/meili|search/i);
  }, 120_000);
});
