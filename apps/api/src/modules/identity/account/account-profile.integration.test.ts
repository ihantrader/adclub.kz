import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  accountProfileSchema,
  currentAccountResponseSchema,
  loginCodeVerifiedResponseSchema,
  type AccountProfile,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { JsonLoggerService } from "../../../common/logging";
import { loadConfig, type AppConfig } from "../../../config";
import { runMigrate } from "../../../database/migrate-cli";
import { configureHttpApp } from "../../../http-app";
import { TRUNCATE_ALL } from "../../../testing/database";
import { captureOutput, rememberCode, rememberSecret } from "../../../testing/output-capture";
import { TestSettings } from "../../../testing/settings";
import { LoginCodeChannels, type TestLoginCodeChannels } from "../index";

/**
 * Registration and "Мои данные" of an account (TASK-029, ARCHITECTURE 4.41),
 * on a real PostgreSQL and Redis: the account exists from the verified code
 * without a name; finishing registration gives it the name and the consent
 * (with its version and date, journalled); the profile is changed by its
 * owner except the phone number, which is refused by name; `GET /auth/me`
 * says whether registration is finished.
 */

const IOS = "mobile/1.4.2 (ios)";
const PHONE = "+77011230029";

describe("account profile (PostgreSQL + Redis)", () => {
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
    await nest.init();
    app = nest;
    settings = new TestSettings(app);
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
    await db.query(TRUNCATE_ALL);
    await redis.flushall();
    await settings.reload();
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

  function remember(body: unknown): void {
    const text = JSON.stringify(body ?? {});
    for (const match of text.matchAll(/"(accessToken|refreshToken|token)":"([^"]+)"/g)) {
      rememberSecret(match[2]!);
    }
  }

  /** A fresh account signed in as the mobile app, as far as the verified code takes it. */
  async function signIn(phone: string): Promise<string> {
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const code = channels.sent.filter((message) => message.phone === phone).at(-1)!.code;
    rememberCode(code);
    const response = await http()
      .post("/auth/login-code/verify")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", nextIp())
      .send({ phone, code });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    remember(response.body);
    return loginCodeVerifiedResponseSchema.parse(response.body).session.accessToken;
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Client": IOS });

  function complete(token: string, body: object): Promise<Response> {
    return http().post("/auth/complete-registration").set(bearer(token)).send(body);
  }

  const consent = (extra: object = {}) => ({
    phoneShareConsent: true,
    phoneShareConsentVersion: "2026-09-mvp",
    ...extra,
  });

  async function profile(token: string): Promise<AccountProfile> {
    const response = await http().get("/account/profile").set(bearer(token));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return accountProfileSchema.parse(response.body);
  }

  function patch(token: string, body: object): Promise<Response> {
    return http().patch("/account/profile").set(bearer(token)).send(body);
  }

  async function auditOf(action: string) {
    const { rows } = await db.query<{
      actor_role: string;
      actor_account_id: string;
      entity_type: string;
      entity_id: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }>(
      "SELECT actor_role, actor_account_id, entity_type, entity_id, before, after FROM audit_log WHERE action = $1 ORDER BY created_at, id",
      [action],
    );
    return rows;
  }

  async function accountRow() {
    const { rows } = await db.query<{
      id: string;
      phone: string;
      name: string | null;
      email: string | null;
      email_news_consent: boolean;
      city_id: string | null;
      language: string | null;
      consent_phone_share_at: Date | null;
      consent_version: string | null;
    }>(
      "SELECT id, phone, name, email, email_news_consent, city_id, language, consent_phone_share_at, consent_version FROM account WHERE phone = $1",
      [PHONE],
    );
    return rows[0]!;
  }

  describe("finishing registration", () => {
    it("starts the account without a name and says so, in the profile and in /auth/me", async () => {
      const token = await signIn(PHONE);
      expect(await profile(token)).toEqual({
        name: null,
        phone: PHONE,
        email: null,
        emailNewsConsent: false,
        cityId: null,
        language: null,
        registrationCompleted: false,
        phoneShareConsent: null,
      });
      const me = currentAccountResponseSchema.parse(
        (await http().get("/auth/me").set(bearer(token))).body,
      );
      expect(me.account).toMatchObject({
        phone: PHONE,
        name: null,
        cityId: null,
        language: null,
        registrationCompleted: false,
      });
    });

    it("gives the name and the consent with its version and moment, and journals them", async () => {
      const token = await signIn(PHONE);
      const before = Date.now();
      const response = await complete(token, consent({ name: "  Әлия   Нұрғалиқызы " }));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const done = accountProfileSchema.parse(response.body);
      // The name is kept as a person writes it, only trimmed and with one space between words.
      expect(done).toMatchObject({
        name: "Әлия Нұрғалиқызы",
        phone: PHONE,
        registrationCompleted: true,
        phoneShareConsent: { version: "2026-09-mvp" },
      });
      const at = new Date(done.phoneShareConsent!.at).getTime();
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);
      // What is stored is what was said: the version and the date, in the account itself.
      const row = await accountRow();
      expect(row).toMatchObject({ name: "Әлия Нұрғалиқызы", consent_version: "2026-09-mvp" });
      expect(row.consent_phone_share_at!.getTime()).toBe(at);
      // /auth/me answers the same, additively: the old fields are still there.
      const me = currentAccountResponseSchema.parse(
        (await http().get("/auth/me").set(bearer(token))).body,
      );
      expect(me.account).toMatchObject({
        id: row.id,
        phone: PHONE,
        name: "Әлия Нұрғалиқызы",
        registrationCompleted: true,
      });
      expect(me.access).toEqual({ context: "user" });
      // The consent is in the action journal, by the account itself, without the phone number.
      const journal = await auditOf("account.registration_completed");
      expect(journal).toEqual([
        {
          actor_role: "user",
          actor_account_id: row.id,
          entity_type: "account",
          entity_id: row.id,
          before: null,
          after: { name: "Әлия Нұрғалиқызы", consentVersion: "2026-09-mvp" },
        },
      ]);
      expect(JSON.stringify(journal)).not.toContain(PHONE.slice(1));
    });

    it("takes a name of the length limit and of Kazakh letters, and gives it back the same", async () => {
      const token = await signIn(PHONE);
      const longest = "Ә".repeat(80);
      const response = await complete(token, consent({ name: longest }));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(accountProfileSchema.parse(response.body).name).toBe(longest);
      const kazakh = "Қайрат-Ұлан Ғабдуллин-Өтеген";
      expect((await complete(token, consent({ name: kazakh }))).status).toBe(200);
      expect((await profile(token)).name).toBe(kazakh);
    });

    it("refuses what is no name, and a consent that was not given — and changes nothing", async () => {
      const token = await signIn(PHONE);
      const refused: Array<[string, object]> = [
        ["a name of spaces", consent({ name: "   " })],
        ["no name", consent()],
        ["digits", consent({ name: "Марат 2" })],
        ["an emoji", consent({ name: "Марат 😀" })],
        ["a control character", consent({ name: "Марат\u0007" })],
        ["more than the limit", consent({ name: "А".repeat(81) })],
        ["no consent", { name: "Марат" }],
        [
          "a consent not given",
          { name: "Марат", phoneShareConsent: false, phoneShareConsentVersion: "v" },
        ],
        ["no version of the text", { name: "Марат", phoneShareConsent: true }],
      ];
      for (const [what, body] of refused) {
        const response = await complete(token, body);
        expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(400);
        expect(response.body.code, what).toBe("VALIDATION_ERROR");
      }
      expect(await accountRow()).toMatchObject({
        name: null,
        consent_phone_share_at: null,
        consent_version: null,
      });
      expect(await auditOf("account.registration_completed")).toEqual([]);
    });

    it("lets the same request be sent again: the fields are set again, the date moves, each time journalled", async () => {
      const token = await signIn(PHONE);
      await complete(token, consent({ name: "Марат" }));
      const first = await accountRow();
      const again = await complete(
        token,
        consent({ name: "Марат Б", phoneShareConsentVersion: "2026-10" }),
      );
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const second = await accountRow();
      expect(second).toMatchObject({ name: "Марат Б", consent_version: "2026-10" });
      expect(second.consent_phone_share_at!.getTime()).toBeGreaterThanOrEqual(
        first.consent_phone_share_at!.getTime(),
      );
      expect((await auditOf("account.registration_completed")).map((entry) => entry.after)).toEqual(
        [
          { name: "Марат", consentVersion: "2026-09-mvp" },
          { name: "Марат Б", consentVersion: "2026-10" },
        ],
      );
    });

    it("is for a signed-in member only", async () => {
      expect(
        (
          await http()
            .post("/auth/complete-registration")
            .set("X-Client", IOS)
            .send(consent({ name: "Марат" }))
        ).status,
      ).toBe(401);
      expect((await http().get("/account/profile").set("X-Client", IOS)).status).toBe(401);
    });
  });

  describe("«Мои данные»", () => {
    async function registered(): Promise<string> {
      const token = await signIn(PHONE);
      expect((await complete(token, consent({ name: "Марат" }))).status).toBe(200);
      return token;
    }

    async function city(code: string): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO city (code, name_ru) VALUES ($1, 'Алматы') RETURNING id",
        [code],
      );
      return rows[0]!.id;
    }

    it("changes the name, e-mail, newsletter consent, city and language, and journals what was before and after", async () => {
      const token = await registered();
      const almaty = await city("almaty-profile");
      const response = await patch(token, {
        name: "Марат  Ахметов",
        email: "  Marat@Example.KZ ",
        emailNewsConsent: true,
        cityId: almaty,
        language: "kk",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(accountProfileSchema.parse(response.body)).toMatchObject({
        name: "Марат Ахметов",
        phone: PHONE,
        email: "marat@example.kz",
        emailNewsConsent: true,
        cityId: almaty,
        language: "kk",
        registrationCompleted: true,
      });
      expect(await profile(token)).toMatchObject({ email: "marat@example.kz", language: "kk" });
      const [entry] = await auditOf("account.profile_updated");
      expect(entry).toMatchObject({
        actor_role: "user",
        entity_type: "account",
        before: {
          name: "Марат",
          email: null,
          emailNewsConsent: false,
          cityId: null,
          language: null,
        },
        after: {
          name: "Марат Ахметов",
          email: "marat@example.kz",
          emailNewsConsent: true,
          cityId: almaty,
          language: "kk",
        },
      });
    });

    it("leaves what the body does not name alone, and the consent of the phone with it", async () => {
      const token = await registered();
      const before = await accountRow();
      expect((await patch(token, { language: "ru" })).status).toBe(200);
      const after = await accountRow();
      expect(after).toMatchObject({ name: "Марат", language: "ru", email: null });
      expect(after.consent_phone_share_at).toEqual(before.consent_phone_share_at);
      expect(after.consent_version).toBe(before.consent_version);
    });

    it("clears the address together with the newsletter consent, which cannot outlive it", async () => {
      const token = await registered();
      await patch(token, { email: "marat@example.kz", emailNewsConsent: true });
      const cleared = await patch(token, { email: null });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(accountProfileSchema.parse(cleared.body)).toMatchObject({
        email: null,
        emailNewsConsent: false,
      });
    });

    it("refuses a bad name, e-mail, city and language, and changes nothing", async () => {
      const token = await registered();
      const refused: Array<[string, object, string]> = [
        ["a name with digits", { name: "Марат 2" }, "name"],
        ["an empty name", { name: "  " }, "name"],
        ["an address that is none", { email: "not-an-address" }, "email"],
        ["a language that is not ours", { language: "de" }, "language"],
        ["a city that is not in the directory", { cityId: randomUUID() }, "cityId"],
      ];
      for (const [what, body, path] of refused) {
        const response = await patch(token, body);
        expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(400);
        expect(response.body.code, what).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(response.body.details), what).toContain(path);
      }
      expect(await accountRow()).toMatchObject({
        name: "Марат",
        email: null,
        language: null,
        city_id: null,
      });
      expect(await auditOf("account.profile_updated")).toEqual([]);
    });

    it("never changes the phone number: a body that names it is refused, and the rest of it is not applied", async () => {
      const token = await registered();
      const response = await patch(token, { phone: "+77011112233", name: "Другой" });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(response.body.details).toEqual([
        { path: "phone", message: "The phone number cannot be changed" },
      ]);
      const row = await accountRow();
      expect(row).toMatchObject({ phone: PHONE, name: "Марат" });
      expect((await db.query("SELECT 1 FROM account WHERE phone = '+77011112233'")).rowCount).toBe(
        0,
      );
      expect(await auditOf("account.profile_updated")).toEqual([]);
      // Nor does completing the registration take one.
      const again = await complete(token, consent({ name: "Марат", phone: "+77011112233" }));
      expect(again.status).toBe(200);
      expect((await profile(token)).phone).toBe(PHONE);
    });

    it("tolerates a field it does not know — a newer app — but only that", async () => {
      const token = await registered();
      const response = await patch(token, { language: "en", somethingNewer: true });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((await profile(token)).language).toBe("en");
    });
  });
});
