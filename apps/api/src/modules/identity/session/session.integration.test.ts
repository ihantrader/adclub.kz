import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  apiErrorResponseSchema,
  currentAccountResponseSchema,
  loginCodeVerifiedResponseSchema,
  sessionListResponseSchema,
  sessionTokensSchema,
  type ErrorCode,
} from "@adclub/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { Client } from "pg";
import request, { type Response, type Test } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../../../app.module";
import { JsonLoggerService } from "../../../common/logging";
import { loadConfig, type AppConfig } from "../../../config";
import { runMigrate } from "../../../database/migrate-cli";
import { configureHttpApp } from "../../../http-app";
import { TRUNCATE_ALL } from "../../../testing/database";
import {
  appLogText,
  captureOutput,
  rememberCode,
  rememberSecret,
  rememberedCodes,
  rememberedSecrets,
} from "../../../testing/output-capture";
import { TestSettings } from "../../../testing/settings";
import { TcpProxy } from "../../../testing/tcp-proxy";
import { AccountStore } from "../account/account.store";
import { LoginCodeChannels } from "../login-code/channels/login-code-channels";
import { TestLoginCodeChannels } from "../login-code/channels/test-login-code-channels";
import { accessTokenIssuer, signAccessToken } from "./session-tokens";
import { SessionService, type IssuedSession } from "./session.service";

/**
 * TASK-005 end to end over HTTP: sign-in, access checks, refresh with
 * rotation and reuse detection, the list of sessions, ending them, cookie
 * sessions of the web clients, CORS, and outages of Redis and PostgreSQL.
 * Both dependencies are real containers behind TCP proxies the tests can
 * stop and start.
 */

const PHONE = "+77011234567";
const MASKED = "+7***4567";
const OTHER_PHONE = "+77471112233";
const SUPPLIER_ORIGIN = "http://localhost:5175";
const ADMIN_ORIGIN = "http://localhost:5174";
const EVIL_ORIGIN = "https://evil.example";
const IOS = "mobile/1.4.2 (ios)";
const ANDROID = "mobile/1.5.0 (android)";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const secondsUntil = (iso: string) => (Date.parse(iso) - Date.now()) / 1000;

interface SignedIn {
  accountId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

describe("sessions over HTTP (PostgreSQL + Redis)", () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let postgresProxy: TcpProxy;
  let redisProxy: TcpProxy;
  let redis: Redis;
  let db: Client;
  let config: AppConfig;
  let settings: TestSettings;
  let app: INestApplication;
  let channels: TestLoginCodeChannels;
  let sessions: SessionService;
  let ipCounter = 0;
  /** Every token issued during the whole suite (also checked by the output capture). */
  const issuedTokens = new Set<string>();
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
    postgresProxy = new TcpProxy(postgres.getHost(), postgres.getPort());
    redisProxy = new TcpProxy(redisContainer.getHost(), redisContainer.getPort());
    await Promise.all([postgresProxy.start(), redisProxy.start()]);

    const proxiedDatabaseUrl = new URL(postgres.getConnectionUri());
    proxiedDatabaseUrl.hostname = "127.0.0.1";
    proxiedDatabaseUrl.port = String(postgresProxy.port);
    config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "log",
      DATABASE_URL: proxiedDatabaseUrl.toString(),
      REDIS_URL: `redis://127.0.0.1:${redisProxy.port}`,
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
    sessions = app.get(SessionService);
    settings = new TestSettings(app);
    await waitForDependencies();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([postgresProxy?.stop(), redisProxy?.stop()]);
    redis?.disconnect();
    await db?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    channels.sent.length = 0;
    // Every setting back to its default, as the tables are emptied.
    await db.query(TRUNCATE_ALL);
    await settings.reload();
    // Many sign-ins per number and address in this suite.
    await settings.set({
      login_code_requests_per_phone: 10_000,
      login_code_requests_per_ip: 10_000,
      login_code_verifications_per_phone: 10_000,
    });
    await redis.flushall();
    output = captureOutput();
  });

  afterEach(() => {
    output.stop();
    for (const token of issuedTokens) {
      rememberSecret(token);
    }
    for (const sent of channels.sent) {
      rememberCode(sent.code);
    }
  });

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

  /** Remembers a token (and its secret-bearing parts) to check the logs for it later. */
  function remember(tokens: { accessToken: string; refreshToken?: string }): void {
    issuedTokens.add(tokens.accessToken);
    issuedTokens.add(tokens.accessToken.split(".")[2]!);
    if (tokens.refreshToken) {
      issuedTokens.add(tokens.refreshToken);
      issuedTokens.add(tokens.refreshToken.split(".")[3]!);
    }
  }

  async function sendCode(phone: string): Promise<string> {
    await redis.del(`rl:login-code:resend:${phone}`);
    const sent = await http()
      .post("/auth/login-code")
      .set("X-Forwarded-For", nextIp())
      .send({ phone });
    expect(sent.status).toBe(200);
    const code = channels.sent.filter((message) => message.phone === phone).at(-1)?.code;
    if (!code) {
      throw new Error("no code was sent");
    }
    return code;
  }

  function verify(
    phone: string,
    code: string,
    options: { client?: string; ip?: string; deviceName?: string } = {},
  ): Test {
    const call = http()
      .post("/auth/login-code/verify")
      .set("X-Forwarded-For", options.ip ?? nextIp());
    if (options.client !== undefined) {
      call.set("X-Client", options.client);
    }
    return call.send({
      phone,
      code,
      ...(options.deviceName && { deviceName: options.deviceName }),
    });
  }

  async function signIn(
    phone = PHONE,
    options: { client?: string; ip?: string; deviceName?: string } = {},
  ): Promise<SignedIn> {
    const code = await sendCode(phone);
    const response = await verify(phone, code, { client: IOS, ...options });
    expect(response.status).toBe(200);
    const body = loginCodeVerifiedResponseSchema.parse(response.body);
    remember(body.session);
    return {
      accountId: body.accountId,
      sessionId: body.session.sessionId,
      accessToken: body.session.accessToken,
      refreshToken: body.session.refreshToken!,
    };
  }

  function me(accessToken: string | undefined, client = IOS): Test {
    const call = http().get("/auth/me").set("X-Client", client);
    return accessToken === undefined ? call : call.set("Authorization", `Bearer ${accessToken}`);
  }

  function refresh(refreshToken: string, ip?: string): Test {
    return http()
      .post("/auth/session/refresh")
      .set("X-Client", IOS)
      .set("X-Forwarded-For", ip ?? "203.0.113.200")
      .send({ refreshToken });
  }

  function bearer(method: "get" | "post" | "delete", path: string, accessToken: string): Test {
    return http()[method](path).set("X-Client", IOS).set("Authorization", `Bearer ${accessToken}`);
  }

  async function refreshed(refreshToken: string): Promise<SignedIn & { sessionExpiresAt: string }> {
    const response = await refresh(refreshToken);
    expect(response.status).toBe(200);
    const body = sessionTokensSchema.parse(response.body);
    remember(body);
    return {
      accountId: "",
      sessionId: body.sessionId,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken!,
      sessionExpiresAt: body.sessionExpiresAt,
    };
  }

  function expectError(response: Response, status: number, code: ErrorCode): void {
    expect(response.status).toBe(status);
    expect(apiErrorResponseSchema.parse(response.body).code).toBe(code);
    const text = JSON.stringify(response.body);
    for (const token of issuedTokens) {
      expect(text).not.toContain(token);
    }
  }

  async function sessionRow(sessionId: string) {
    const { rows } = await db.query<{
      revoked_at: Date | null;
      revoked_reason: string | null;
      refresh_generation: number;
      expires_at: Date;
      absolute_expires_at: Date | null;
    }>("SELECT * FROM session WHERE id = $1", [sessionId]);
    return rows[0];
  }

  async function issueWebSession(
    kind: "supplier_web" | "admin_web",
    phone = PHONE,
  ): Promise<IssuedSession & { accountId: string }> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id",
      [phone],
    );
    const accountId = rows[0]!.id;
    let context: { supplierId: string; supplierMemberId: string } | undefined;
    if (kind === "supplier_web") {
      // The session context must be a real membership (TASK-006).
      const supplierId = randomUUID();
      const supplierMemberId = randomUUID();
      await db.query(
        "INSERT INTO supplier (id, name, city) VALUES ($1, 'Test company', 'Almaty')",
        [supplierId],
      );
      await db.query(
        "INSERT INTO supplier_member (id, supplier_id, account_id, display_name, added_by) VALUES ($1, $2, $3, 'Test employee', 'operator')",
        [supplierMemberId, supplierId, accountId],
      );
      context = { supplierId, supplierMemberId };
    } else {
      await db.query(
        "INSERT INTO admin_user (account_id, totp_secret, totp_confirmed_at) VALUES ($1, 'v1.test.only', now()) ON CONFLICT (account_id) DO NOTHING",
        [accountId],
      );
    }
    const issued = await sessions.issue({
      account: { id: accountId, phone },
      kind,
      ...(context && { context }),
      client: {
        platform: kind === "supplier_web" ? "supplier-web" : "admin-web",
        version: "0.1.0",
      },
      deviceName: null,
      ip: "192.0.2.10",
      loginChallengeId: null,
    });
    remember(issued.tokens);
    return { ...issued, accountId };
  }

  function cookieRefresh(origin: string | undefined, cookie: string | undefined): Test {
    const call = http().post("/auth/session/refresh").set("X-Client", "supplier-web/0.1.0");
    if (origin !== undefined) {
      call.set("Origin", origin);
    }
    if (cookie !== undefined) {
      call.set("Cookie", cookie);
    }
    return call.send({});
  }

  function setCookies(response: Response): string[] {
    const header = response.headers["set-cookie"] as string[] | string | undefined;
    return header === undefined ? [] : Array.isArray(header) ? header : [header];
  }

  async function waitForDependencies(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await http()
        .post("/auth/login-code")
        .set("X-Forwarded-For", "192.0.2.250")
        .send({ phone: "+77000000000" });
      if (response.status === 200) {
        await redis.flushall();
        return;
      }
      await sleep(250);
    }
    throw new Error("the API never reached PostgreSQL and Redis");
  }

  describe("accounts", () => {
    it("creates one account on the first sign-in and finds it on the next", async () => {
      const first = await signIn();
      const second = await signIn(PHONE, { client: ANDROID });
      expect(second.accountId).toBe(first.accountId);
      expect(second.sessionId).not.toBe(first.sessionId);
      const { rows } = await db.query("SELECT id, phone FROM account");
      expect(rows).toEqual([{ id: first.accountId, phone: PHONE }]);
      expect(output.text()).toContain(`Account created account=${first.accountId}`);

      const other = await signIn(OTHER_PHONE);
      expect(other.accountId).not.toBe(first.accountId);
    });

    it("converges concurrent first sign-ins of one number on one account", async () => {
      const store = app.get(AccountStore);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.findOrCreateByPhone(PHONE)),
      );
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM account");
      expect(rows).toEqual([{ n: 1 }]);
    });

    it("gives exactly one session when the right code is entered concurrently", async () => {
      const code = await sendCode(PHONE);
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => verify(PHONE, code, { client: IOS })),
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      for (const response of responses.filter((response) => response.status !== 200)) {
        expect(response.body.code).toBe("LOGIN_CODE_EXPIRED");
      }
      const counts = await db.query(
        "SELECT (SELECT count(*) FROM account)::int AS accounts, (SELECT count(*) FROM session)::int AS sessions",
      );
      expect(counts.rows).toEqual([{ accounts: 1, sessions: 1 }]);
    });
  });

  describe("sign-in", () => {
    it("returns the account, an access token, a refresh token and their lifetimes", async () => {
      const code = await sendCode(PHONE);
      const response = await verify(PHONE, code, {
        client: IOS,
        deviceName: "iPhone 15",
        ip: "203.0.113.57",
      });
      expect(response.status).toBe(200);
      const body = loginCodeVerifiedResponseSchema.parse(response.body);
      remember(body.session);
      expect(body).toMatchObject({
        status: "verified",
        phone: PHONE,
        session: { kind: "mobile" },
      });
      expect(Object.keys(body).sort()).toEqual([
        "access",
        "accountId",
        "phone",
        "session",
        "status",
      ]);
      expect(body.access).toEqual({ context: "user" });
      expect(secondsUntil(body.session.accessTokenExpiresAt)).toBeGreaterThan(890);
      expect(secondsUntil(body.session.accessTokenExpiresAt)).toBeLessThanOrEqual(900);
      expect(secondsUntil(body.session.sessionExpiresAt)).toBeGreaterThan(90 * 86_400 - 10);
      expect(body.session.refreshToken).toMatch(/^rt1\./);
      expect(setCookies(response)).toEqual([]);

      const current = await me(body.session.accessToken);
      expect(current.status).toBe(200);
      expect(currentAccountResponseSchema.parse(current.body)).toMatchObject({
        account: { id: body.accountId, phone: PHONE },
        session: {
          id: body.session.sessionId,
          kind: "mobile",
          current: true,
          deviceName: "iPhone 15",
          platform: "ios",
          clientVersion: "1.4.2",
          ipHint: "203.0.113.*",
        },
      });
      expect(JSON.stringify(current.body)).not.toContain("203.0.113.57");
    });

    it("creates no session for a wrong, repeated or expired code", async () => {
      const code = await sendCode(PHONE);
      const wrong = await verify(PHONE, code === "000000" ? "111111" : "000000", { client: IOS });
      expectError(wrong, 400, "LOGIN_CODE_INVALID");
      expect((await verify(PHONE, code, { client: IOS })).status).toBe(200);
      expectError(await verify(PHONE, code, { client: IOS }), 400, "LOGIN_CODE_EXPIRED");

      await settings.set({ login_code_ttl_seconds: 1 });
      const late = await sendCode(OTHER_PHONE);
      await sleep(1200);
      expectError(await verify(OTHER_PHONE, late, { client: IOS }), 400, "LOGIN_CODE_EXPIRED");
      const { rows } = await db.query("SELECT count(*)::int AS n FROM session");
      expect(rows).toEqual([{ n: 1 }]);
    });

    it("gives a caller without X-Client a mobile session", async () => {
      const code = await sendCode(PHONE);
      const response = await verify(PHONE, code);
      expect(response.status).toBe(200);
      remember(response.body.session);
      expect(response.body.session.kind).toBe("mobile");
      const current = await me(response.body.session.accessToken, "");
      expect(current.body.session).toMatchObject({ platform: null, clientVersion: null });
    });

    // Changed by TASK-006 (D-046): the code is checked and spent first, the
    // refusal comes after it, and nothing is created.
    it.each([
      [
        "supplier-web/0.1.0",
        "NOT_SUPPLIER_MEMBER",
        "Supplier sign-in refused: no active membership",
      ],
      ["admin-web/0.1.0", "NOT_ADMIN", "Admin sign-in refused: not an administrator"],
    ] as const)(
      "refuses a %s sign-in of a number without the role after spending the code",
      async (client, code, event) => {
        const loginCode = await sendCode(PHONE);
        const refused = await verify(PHONE, loginCode, { client });
        expectError(refused, 403, code);
        expect(setCookies(refused)).toEqual([]);
        expect(output.text()).toContain(`${event} phone=${MASKED}`);
        const { rows } = await db.query(
          "SELECT (SELECT count(*) FROM session)::int AS sessions, (SELECT count(*) FROM account)::int AS accounts, (SELECT status FROM otp_challenge) AS code",
        );
        expect(rows).toEqual([{ sessions: 0, accounts: 0, code: "consumed" }]);
        // The spent code signs nobody in any more.
        expectError(await verify(PHONE, loginCode, { client: IOS }), 400, "LOGIN_CODE_EXPIRED");
      },
    );
  });

  describe("access", () => {
    it("serves public routes without a token", async () => {
      expect((await http().get("/health")).status).toBe(200);
      expect((await http().get("/meta/client-policy")).status).toBe(200);
      // S3 is deliberately unreachable in this suite: 503, but not a sign-in error.
      const ready = await http().get("/ready");
      expect(ready.status).toBe(503);
      // The response never carries the driver's error text or the unreachable
      // endpoint's address (TASK-005.A) — only the reason is logged.
      expect(ready.body.checks.s3).toEqual({ status: "error" });
      expect(JSON.stringify(ready.body)).not.toContain("127.0.0.1:3");
      expect(output.text()).toContain("Dependency check failed: s3");
      expect((await http().post("/auth/login-code").send({ phone: PHONE })).status).toBe(200);
    });

    it("asks for sign-in without a token or with an unusable one", async () => {
      const { accessToken, refreshToken, sessionId, accountId } = await signIn();
      const [header, payload, signature] = accessToken.split(".") as [string, string, string];
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      const reencode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

      const unusable: [string, string | undefined][] = [
        ["no header", undefined],
        ["another scheme", `Basic ${accessToken}`],
        ["a bare token", accessToken],
        ["two tokens", `Bearer ${accessToken} ${accessToken}`],
        ["a truncated token", `Bearer ${accessToken.slice(0, -4)}`],
        [
          "a changed account",
          `Bearer ${header}.${reencode({ ...claims, sub: randomUUID() })}.${signature}`,
        ],
        [
          "a longer lifetime",
          `Bearer ${header}.${reencode({ ...claims, exp: now + 99_999 })}.${signature}`,
        ],
        ["alg none", `Bearer ${reencode({ alg: "none", typ: "JWT" })}.${payload}.`],
        [
          "another secret",
          `Bearer ${signAccessToken("secret-of-another-environment-0123456789", accessTokenIssuer("test"), { ...claims })}`,
        ],
        [
          "another environment",
          `Bearer ${signAccessToken(config.session.tokenSecret, accessTokenIssuer("staging"), { ...claims })}`,
        ],
        [
          "an unknown session",
          `Bearer ${signAccessToken(config.session.tokenSecret, accessTokenIssuer("test"), { ...claims, sid: randomUUID() })}`,
        ],
        [
          "another account's claim on this session",
          `Bearer ${signAccessToken(config.session.tokenSecret, accessTokenIssuer("test"), { ...claims, sub: randomUUID() })}`,
        ],
        [
          "another kind on this session",
          `Bearer ${signAccessToken(config.session.tokenSecret, accessTokenIssuer("test"), { ...claims, knd: "admin_web" })}`,
        ],
        ["the refresh token", `Bearer ${refreshToken}`],
      ];
      for (const [label, authorization] of unusable) {
        const call = http().get("/auth/me").set("X-Client", IOS);
        const response = await (authorization === undefined
          ? call
          : call.set("Authorization", authorization));
        expect({ label, status: response.status, code: response.body.code }).toEqual({
          label,
          status: 401,
          code: "AUTH_REQUIRED",
        });
        expect(response.headers["www-authenticate"]).toContain("Bearer");
        expectError(response, 401, "AUTH_REQUIRED");
      }
      expect(output.text()).toContain("Access refused reason=bad_signature");
      expect(output.text()).toContain("Access refused reason=wrong_issuer");
      expect(output.text()).toContain(`reason=session_mismatch`);
      // None of that affected the real session.
      expect((await me(accessToken)).status).toBe(200);
      expect(await sessionRow(sessionId)).toMatchObject({ revoked_at: null });
      expect((await me(accessToken)).body.account.id).toBe(accountId);
    });

    it("tells an expired access token (refresh) from an ended session (sign in)", async () => {
      await settings.set({ session_access_token_ttl_seconds: 1 });
      const session = await signIn();
      await sleep(2100);
      const expired = await me(session.accessToken);
      expectError(expired, 401, "ACCESS_TOKEN_EXPIRED");

      // A 1-second token may expire before the next request even reaches the server.
      await settings.set({ session_access_token_ttl_seconds: 900 });
      const renewed = await refreshed(session.refreshToken);
      expect((await me(renewed.accessToken)).status).toBe(200);

      await bearer("post", "/auth/logout", renewed.accessToken);
      expectError(await me(renewed.accessToken), 401, "SESSION_ENDED");
      expectError(await refresh(renewed.refreshToken), 401, "SESSION_ENDED");
    });

    it("answers an outdated client with 426 before looking at the token", async () => {
      await settings.set({ client_min_version_ios: "2.0.0" });
      const response = await me(undefined);
      expect(response.status).toBe(426);
      expect(response.body.code).toBe("CLIENT_UPDATE_REQUIRED");
    });

    it("records when a session was last used", async () => {
      const session = await signIn();
      await db.query(
        "UPDATE session SET last_used_at = now() - interval '1 hour', last_ip = NULL WHERE id = $1",
        [session.sessionId],
      );
      await me(session.accessToken).set("X-Forwarded-For", "2001:db8:1:2::10");
      const { rows } = await db.query(
        "SELECT last_used_at > now() - interval '1 minute' AS fresh, last_ip FROM session WHERE id = $1",
        [session.sessionId],
      );
      expect(rows).toEqual([{ fresh: true, last_ip: "2001:db8:1:2::10" }]);
      const list = await bearer("get", "/auth/sessions", session.accessToken);
      expect(list.body.sessions[0].ipHint).toBe("2001:db8::*");
    });
  });

  describe("refresh", () => {
    it("rotates the pair; the replaced token ends the session once the grace period is over", async () => {
      await settings.set({ session_refresh_reuse_grace_seconds: 0 });
      const session = await signIn();
      const renewed = await refreshed(session.refreshToken);
      expect(renewed.sessionId).toBe(session.sessionId);
      expect(renewed.refreshToken).not.toBe(session.refreshToken);
      expect((await me(renewed.accessToken)).status).toBe(200);
      expect((await sessionRow(session.sessionId))?.refresh_generation).toBe(1);

      await sleep(5);
      expectError(await refresh(session.refreshToken), 401, "SESSION_ENDED");
      expect(await sessionRow(session.sessionId)).toMatchObject({
        revoked_reason: "refresh_reuse",
      });
      expectError(await me(renewed.accessToken), 401, "SESSION_ENDED");
      expectError(await refresh(renewed.refreshToken), 401, "SESSION_ENDED");
      expect(output.text()).toContain(
        `Refresh token reuse detected, session revoked session=${session.sessionId}`,
      );
    });

    it("returns the same pair to a repeated refresh within the grace period", async () => {
      const session = await signIn();
      const first = await refreshed(session.refreshToken);
      const repeated = await refreshed(session.refreshToken);
      expect(repeated.refreshToken).toBe(first.refreshToken);
      expect(repeated.sessionExpiresAt).toBe(first.sessionExpiresAt);
      expect((await me(repeated.accessToken)).status).toBe(200);
      expect((await sessionRow(session.sessionId))?.refresh_generation).toBe(1);
      expect(output.text()).toContain("Session refresh repeated within grace");

      const next = await refreshed(first.refreshToken);
      expect(next.refreshToken).not.toBe(first.refreshToken);
      expect((await sessionRow(session.sessionId))?.refresh_generation).toBe(2);
    });

    it("keeps the session of a client that refreshes concurrently", async () => {
      const session = await signIn();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => refresh(session.refreshToken)),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
      responses.forEach((response) => remember(response.body));
      expect(new Set(responses.map((response) => response.body.refreshToken)).size).toBe(1);
      const row = await sessionRow(session.sessionId);
      expect(row).toMatchObject({ refresh_generation: 1, revoked_at: null });

      const next = await refreshed(responses[4]!.body.refreshToken);
      expect((await me(next.accessToken)).status).toBe(200);
    });

    it("ends the session when a stolen token is used after the owner refreshed", async () => {
      await settings.set({ session_refresh_reuse_grace_seconds: 1 });
      const owner = await signIn();
      const stolen = owner.refreshToken;
      const ownerRenewed = await refreshed(owner.refreshToken);
      await sleep(1100);

      expectError(await refresh(stolen, "192.0.2.66"), 401, "SESSION_ENDED");
      expectError(await refresh(ownerRenewed.refreshToken), 401, "SESSION_ENDED");
      expectError(await me(ownerRenewed.accessToken), 401, "SESSION_ENDED");
    });

    it("ends the session when the owner comes back after a thief refreshed", async () => {
      await settings.set({ session_refresh_reuse_grace_seconds: 1 });
      const owner = await signIn();
      const thief = await refreshed(owner.refreshToken);
      const thiefAgain = await refreshed(thief.refreshToken);
      await sleep(1100);

      expectError(await refresh(owner.refreshToken), 401, "SESSION_ENDED");
      expectError(await refresh(thiefAgain.refreshToken, "192.0.2.66"), 401, "SESSION_ENDED");
      expectError(await me(thiefAgain.accessToken), 401, "SESSION_ENDED");
      expect(output.text()).toContain("presentedGeneration=0 currentGeneration=2");
    });

    it("ignores forged and malformed refresh tokens without harming the session", async () => {
      const session = await signIn();
      const [prefix, id, generation, mac] = session.refreshToken.split(".") as [
        string,
        string,
        string,
        string,
      ];
      const flipped = `${mac.slice(0, -2)}${mac.at(-2) === "A" ? "B" : "A"}${mac.at(-1)}`;
      for (const token of [
        `${prefix}.${id}.${generation}.${flipped}`,
        `${prefix}.${id}.1.${mac}`,
        `${prefix}.${id}.7.${mac}`,
        `${prefix}.${randomUUID()}.${generation}.${mac}`,
        "garbage",
      ]) {
        expectError(await refresh(token), 401, "AUTH_REQUIRED");
      }
      // An access token is no refresh token (and longer than one may be).
      expectError(await refresh(session.accessToken), 400, "VALIDATION_ERROR");
      expectError(
        await http().post("/auth/session/refresh").send({ refreshToken: "" }),
        400,
        "VALIDATION_ERROR",
      );
      expect(await sessionRow(session.sessionId)).toMatchObject({
        revoked_at: null,
        refresh_generation: 0,
      });
      expect((await refresh(session.refreshToken)).status).toBe(200);
    });

    it("slides the mobile session forward on refresh until it is not refreshed in time", async () => {
      await settings.set({ session_mobile_ttl_seconds: 3 });
      const session = await signIn();
      expect(
        secondsUntil((await sessionRow(session.sessionId))!.expires_at.toISOString()),
      ).toBeLessThanOrEqual(3);
      await sleep(2000);
      const renewed = await refreshed(session.refreshToken);
      expect(secondsUntil(renewed.sessionExpiresAt)).toBeGreaterThan(2);
      // Access tokens never outlive the session.
      await sleep(1500);
      expect((await me(renewed.accessToken)).status).toBe(200);

      await sleep(2000);
      expectError(await me(renewed.accessToken), 401, "ACCESS_TOKEN_EXPIRED");
      expectError(await refresh(renewed.refreshToken), 401, "SESSION_ENDED");
      expect(output.text()).toContain(`session=${session.sessionId} reason=expired`);
    });

    it("refuses a web session's token sent in the body", async () => {
      const web = await issueWebSession("supplier_web");
      expectError(await refresh(web.tokens.refreshToken), 401, "AUTH_REQUIRED");
      expect(output.text()).toContain("reason=wrong_transport");
    });
  });

  describe("the owner's sessions", () => {
    it("lists only the owner's active sessions and marks the current one", async () => {
      const phone = await signIn(PHONE, { client: IOS, deviceName: "iPhone", ip: "203.0.113.5" });
      const tablet = await signIn(PHONE, {
        client: ANDROID,
        deviceName: "Tab",
        ip: "198.51.100.77",
      });
      const ended = await signIn(PHONE);
      await bearer("post", "/auth/logout", ended.accessToken);
      const stranger = await signIn(OTHER_PHONE);

      const fromPhone = sessionListResponseSchema.parse(
        (await bearer("get", "/auth/sessions", phone.accessToken)).body,
      );
      expect(fromPhone.sessions.map((session) => [session.id, session.current]).sort()).toEqual(
        [
          [phone.sessionId, true],
          [tablet.sessionId, false],
        ].sort(),
      );
      expect(fromPhone.sessions.find((session) => session.id === tablet.sessionId)).toMatchObject({
        deviceName: "Tab",
        platform: "android",
        clientVersion: "1.5.0",
        ipHint: "198.51.100.*",
      });
      const text = JSON.stringify(fromPhone);
      expect(text).not.toContain("198.51.100.77");
      expect(text).not.toContain('203.0.113.5"');
      expect(text).not.toContain(stranger.sessionId);

      const fromTablet = await bearer("get", "/auth/sessions", tablet.accessToken);
      expect(
        fromTablet.body.sessions.find((session: { current: boolean }) => session.current).id,
      ).toBe(tablet.sessionId);
    });

    it("ends another device's session at once, refresh token included", async () => {
      const first = await signIn();
      const second = await signIn(PHONE, { client: ANDROID });
      expect((await me(second.accessToken)).status).toBe(200);

      const response = await bearer(
        "delete",
        `/auth/sessions/${second.sessionId}`,
        first.accessToken,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ended: 1, currentEnded: false });

      expectError(await me(second.accessToken), 401, "SESSION_ENDED");
      expectError(await refresh(second.refreshToken), 401, "SESSION_ENDED");
      expect((await me(first.accessToken)).status).toBe(200);
      expect(await sessionRow(second.sessionId)).toMatchObject({
        revoked_reason: "ended_by_owner",
      });
      expect(output.text()).toContain(
        `Access refused: session ended session=${second.sessionId} account=${second.accountId} reason=ended_by_owner`,
      );

      expectError(
        await bearer("delete", `/auth/sessions/${second.sessionId}`, first.accessToken),
        404,
        "NOT_FOUND",
      );
    });

    it("answers for someone else's session exactly as for a missing one", async () => {
      const mine = await signIn();
      const theirs = await signIn(OTHER_PHONE);
      const foreign = await bearer(
        "delete",
        `/auth/sessions/${theirs.sessionId}`,
        mine.accessToken,
      );
      const missing = await bearer("delete", `/auth/sessions/${randomUUID()}`, mine.accessToken);
      expectError(foreign, 404, "NOT_FOUND");
      expect(foreign.body).toEqual(missing.body);
      expect(Object.keys(foreign.headers).sort()).toEqual(Object.keys(missing.headers).sort());
      expect((await me(theirs.accessToken)).status).toBe(200);

      expectError(
        await bearer("delete", "/auth/sessions/not-a-uuid", mine.accessToken),
        400,
        "VALIDATION_ERROR",
      );
      expectError(await http().delete(`/auth/sessions/${theirs.sessionId}`), 401, "AUTH_REQUIRED");
    });

    it("ends every other session and keeps the current one", async () => {
      const [a, b, c] = [await signIn(), await signIn(), await signIn()];
      const stranger = await signIn(OTHER_PHONE);
      const response = await bearer("post", "/auth/sessions/end-others", a!.accessToken);
      expect(response.body).toEqual({ ended: 2, currentEnded: false });
      expectError(await me(b!.accessToken), 401, "SESSION_ENDED");
      expectError(await me(c!.accessToken), 401, "SESSION_ENDED");
      expect((await me(a!.accessToken)).status).toBe(200);
      expect((await me(stranger.accessToken)).status).toBe(200);
      expect(output.text()).toContain(`scope=all_except count=2 by=${a!.sessionId}`);
    });

    it("ends all sessions, the current one included", async () => {
      const [a, b] = [await signIn(), await signIn(PHONE, { client: ANDROID })];
      const response = await bearer("post", "/auth/sessions/end-all", a!.accessToken);
      expect(response.body).toEqual({ ended: 2, currentEnded: true });
      for (const session of [a!, b!]) {
        expectError(await me(session.accessToken), 401, "SESSION_ENDED");
        expectError(await refresh(session.refreshToken), 401, "SESSION_ENDED");
      }
      expect(output.text()).toContain("scope=all count=2");
    });

    it("logs out the current session only", async () => {
      const [a, b] = [await signIn(), await signIn()];
      const response = await bearer("post", "/auth/logout", a!.accessToken);
      expect(response.body).toEqual({ ended: 1, currentEnded: true });
      expectError(await me(a!.accessToken), 401, "SESSION_ENDED");
      expectError(await bearer("post", "/auth/logout", a!.accessToken), 401, "SESSION_ENDED");
      expect((await me(b!.accessToken)).status).toBe(200);
      expect(await sessionRow(a!.sessionId)).toMatchObject({ revoked_reason: "logout" });

      // Ending the current session by id is a logout too.
      const own = await bearer("delete", `/auth/sessions/${b!.sessionId}`, b!.accessToken);
      expect(own.body).toEqual({ ended: 1, currentEnded: true });
      expect(await sessionRow(b!.sessionId)).toMatchObject({ revoked_reason: "logout" });
    });
  });

  describe("web sessions (cookie)", () => {
    it("keeps the supplier cabinet's refresh token in an HttpOnly cookie for 180 days", async () => {
      const web = await issueWebSession("supplier_web");
      expect(secondsUntil(web.tokens.sessionExpiresAt)).toBeGreaterThan(180 * 86_400 - 10);
      const cookie = `adclub_supplier_refresh=${web.tokens.refreshToken}`;

      const response = await cookieRefresh(SUPPLIER_ORIGIN, cookie);
      expect(response.status).toBe(200);
      const body = sessionTokensSchema.parse(response.body);
      expect(body).not.toHaveProperty("refreshToken");
      expect(body.kind).toBe("supplier_web");
      remember(body);
      expect(response.headers["access-control-allow-origin"]).toBe(SUPPLIER_ORIGIN);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");

      const [setCookie, ...others] = setCookies(response);
      expect(others).toEqual([]);
      const attributes = setCookie!.split(";").map((part) => part.trim());
      const newToken = attributes[0]!.replace("adclub_supplier_refresh=", "");
      expect(newToken).toMatch(/^rt1\./);
      expect(newToken).not.toBe(web.tokens.refreshToken);
      issuedTokens.add(newToken);
      expect(attributes).toEqual(
        expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/auth/session"]),
      );
      const maxAge = Number(attributes.find((part) => part.startsWith("Max-Age="))!.slice(8));
      expect(maxAge).toBeGreaterThan(180 * 86_400 - 10);
      expect(maxAge).toBeLessThanOrEqual(180 * 86_400);
      expect(attributes.some((part) => part.startsWith("Domain="))).toBe(false);

      expect((await me(body.accessToken, "supplier-web/0.1.0")).status).toBe(200);
      const next = await cookieRefresh(SUPPLIER_ORIGIN, `adclub_supplier_refresh=${newToken}`);
      expect(next.status).toBe(200);
      remember(next.body);
      const { rows } = await db.query(
        "SELECT supplier_id IS NOT NULL AS has_supplier, supplier_member_id IS NOT NULL AS has_member FROM session",
      );
      expect(rows).toEqual([{ has_supplier: true, has_member: true }]);
    });

    it("stays signed in until an explicit logout, which clears the cookie", async () => {
      await settings.set({ session_access_token_ttl_seconds: 1 });
      const web = await issueWebSession("supplier_web");
      await sleep(2100);
      // The first access token has expired; the renewed one must outlive the
      // logout below however slow the machine is (was a 1-second token too).
      await settings.set({ session_access_token_ttl_seconds: 900 });
      const renewed = await cookieRefresh(
        SUPPLIER_ORIGIN,
        `adclub_supplier_refresh=${web.tokens.refreshToken}`,
      );
      expect(renewed.status).toBe(200);
      remember(renewed.body);

      const logout = await http()
        .post("/auth/logout")
        .set("Origin", SUPPLIER_ORIGIN)
        .set("Authorization", `Bearer ${renewed.body.accessToken}`);
      expect(logout.body).toEqual({ ended: 1, currentEnded: true });
      const cleared = setCookies(logout)[0]!;
      expect(cleared).toMatch(/^adclub_supplier_refresh=;/);
      expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
      expect(cleared).toContain("Path=/auth/session");

      const newToken = setCookies(renewed)[0]!.split(";")[0]!.split("=")[1]!;
      issuedTokens.add(newToken);
      const after = await cookieRefresh(SUPPLIER_ORIGIN, `adclub_supplier_refresh=${newToken}`);
      expectError(after, 401, "SESSION_ENDED");
      expect(setCookies(after)[0]).toMatch(/^adclub_supplier_refresh=;/);
    });

    it("refuses cookie requests that don't come from the cabinet itself", async () => {
      const web = await issueWebSession("supplier_web");
      const cookie = `adclub_supplier_refresh=${web.tokens.refreshToken}`;

      const foreign = await cookieRefresh(EVIL_ORIGIN, cookie);
      expectError(foreign, 403, "ORIGIN_NOT_ALLOWED");
      expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
      expect(setCookies(foreign)).toEqual([]);

      expectError(await cookieRefresh(undefined, cookie), 403, "ORIGIN_NOT_ALLOWED");
      expectError(
        await cookieRefresh(SUPPLIER_ORIGIN, cookie).set("Sec-Fetch-Site", "cross-site"),
        403,
        "ORIGIN_NOT_ALLOWED",
      );
      // The admin panel's origin reads the admin cookie, not this one.
      expectError(await cookieRefresh(ADMIN_ORIGIN, cookie), 401, "AUTH_REQUIRED");
      expectError(await cookieRefresh(SUPPLIER_ORIGIN, undefined), 401, "AUTH_REQUIRED");
      // A cookie alone never authorizes an action.
      expectError(
        await http()
          .post("/auth/sessions/end-all")
          .set("Origin", SUPPLIER_ORIGIN)
          .set("Cookie", cookie),
        401,
        "AUTH_REQUIRED",
      );
      expectError(
        await http()
          .post("/auth/logout")
          .set("Origin", EVIL_ORIGIN)
          .set("Cookie", cookie)
          .set("Authorization", `Bearer ${web.tokens.accessToken}`),
        403,
        "ORIGIN_NOT_ALLOWED",
      );

      expect(await sessionRow(web.tokens.sessionId)).toMatchObject({
        revoked_at: null,
        refresh_generation: 0,
      });
      expect((await cookieRefresh(SUPPLIER_ORIGIN, cookie)).status).toBe(200);
    });

    it("never extends an admin session past 12 hours from sign-in", async () => {
      const standard = await issueWebSession("admin_web", OTHER_PHONE);
      expect(secondsUntil(standard.tokens.sessionExpiresAt)).toBeGreaterThan(12 * 3600 - 10);
      expect(secondsUntil(standard.tokens.sessionExpiresAt)).toBeLessThanOrEqual(12 * 3600);
      const row = await sessionRow(standard.tokens.sessionId);
      expect(row?.absolute_expires_at).toEqual(row?.expires_at);

      await settings.set({ session_admin_web_ttl_seconds: 4 });
      const admin = await issueWebSession("admin_web");
      const endsAt = admin.tokens.sessionExpiresAt;
      let token = admin.tokens.refreshToken;
      for (const wait of [1000, 1000]) {
        await sleep(wait);
        const response = await cookieRefresh(ADMIN_ORIGIN, `adclub_admin_refresh=${token}`);
        expect(response.status).toBe(200);
        remember(response.body);
        expect(response.body.sessionExpiresAt).toBe(endsAt);
        expect(Date.parse(response.body.accessTokenExpiresAt)).toBeLessThanOrEqual(
          Date.parse(endsAt),
        );
        const cookie = setCookies(response)[0]!;
        expect(cookie).toMatch(/^adclub_admin_refresh=/);
        token = cookie.split(";")[0]!.split("=")[1]!;
        issuedTokens.add(token);
      }
      await sleep(Math.max(0, Date.parse(endsAt) - Date.now()) + 200);
      expectError(
        await cookieRefresh(ADMIN_ORIGIN, `adclub_admin_refresh=${token}`),
        401,
        "SESSION_ENDED",
      );
      expect((await sessionRow(admin.tokens.sessionId))?.expires_at.toISOString()).toBe(endsAt);
    });
  });

  describe("CORS", () => {
    const preflight = (origin: string) =>
      http()
        .options("/auth/me")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "x-client, accept-language, authorization");

    it.each([SUPPLIER_ORIGIN, ADMIN_ORIGIN, "http://127.0.0.1:5174"])(
      "lets the web client at %s through the preflight",
      async (origin) => {
        const response = await preflight(origin);
        expect(response.status).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
        expect(response.headers["access-control-allow-credentials"]).toBe("true");
        const allowed = String(response.headers["access-control-allow-headers"]).toLowerCase();
        for (const header of ["x-client", "accept-language", "authorization", "content-type"]) {
          expect(allowed).toContain(header);
        }
        expect(response.headers["vary"]).toContain("Origin");
      },
    );

    it("gives a foreign site no CORS headers and refuses its requests", async () => {
      const response = await preflight(EVIL_ORIGIN);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();

      const health = await http().get("/health").set("Origin", EVIL_ORIGIN);
      expectError(health, 403, "ORIGIN_NOT_ALLOWED");
      expect(health.headers["access-control-allow-origin"]).toBeUndefined();
      expect(output.text()).toContain('origin not allowed origin=\\"https://evil.example\\"');
      expectError(await http().get("/health").set("Origin", "null"), 403, "ORIGIN_NOT_ALLOWED");
    });

    it("serves requests without Origin and same-origin requests as before", async () => {
      const plain = await http().get("/meta/client-policy");
      expect(plain.status).toBe(200);
      expect(plain.headers["access-control-allow-origin"]).toBeUndefined();

      // The API's own pages (development docs) call it from its own origin.
      const own = await http()
        .get("/health")
        .set("Host", "api.example.test")
        .set("Origin", "http://api.example.test");
      expect(own.status).toBe(200);
      const lookalike = await http()
        .get("/health")
        .set("Host", "api.example.test")
        .set("Origin", "https://api.example.test.evil.example");
      expectError(lookalike, 403, "ORIGIN_NOT_ALLOWED");
    });

    it("exposes Retry-After and X-Request-Id to the web clients", async () => {
      const response = await http().get("/health").set("Origin", SUPPLIER_ORIGIN);
      expect(response.status).toBe(200);
      expect(String(response.headers["access-control-expose-headers"])).toBe(
        "Retry-After,X-Request-Id",
      );
    });
  });

  describe("rate limits", () => {
    it("limits refreshes per session", async () => {
      await settings.set({ session_refresh_per_session: 3 });
      const session = await signIn();
      const other = await signIn(OTHER_PHONE);
      let token = session.refreshToken;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        token = (await refreshed(token)).refreshToken;
      }
      const limited = await refresh(token);
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details).toMatchObject({ limit: "session_refresh_per_session" });
      expect(limited.headers["retry-after"]).toBeDefined();
      expect((await refresh(other.refreshToken)).status).toBe(200);
      // A refused refresh changed nothing: the token still works later.
      expect((await sessionRow(session.sessionId))?.refresh_generation).toBe(3);
    });

    it("limits refreshes per address, garbage included", async () => {
      await settings.set({ session_refresh_per_ip: 2 });
      const session = await signIn();
      expectError(await refresh("garbage", "192.0.2.99"), 401, "AUTH_REQUIRED");
      expect((await refresh(session.refreshToken, "192.0.2.99")).status).toBe(200);
      const limited = await refresh(session.refreshToken, "192.0.2.99");
      expectError(limited, 429, "RATE_LIMITED");
      expect(limited.body.details).toMatchObject({ limit: "session_refresh_per_ip" });
    });

    it("does not get in the way of ordinary use with the default limits", async () => {
      expect(await settings.values()).toMatchObject({
        session_access_token_ttl_seconds: 900,
        session_refresh_reuse_grace_seconds: 60,
        session_refresh_per_session: 30,
        session_refresh_per_session_window_seconds: 3600,
        session_refresh_per_ip: 600,
        session_refresh_per_ip_window_seconds: 3600,
      });
      expect(
        (await db.query("SELECT key FROM app_setting WHERE key LIKE 'session_%'")).rows,
      ).toEqual([]);
      const session = await signIn();
      let token = session.refreshToken;
      for (let round = 0; round < 4; round += 1) {
        const responses = await Promise.all([refresh(token), refresh(token)]);
        expect(responses.map((response) => response.status)).toEqual([200, 200]);
        responses.forEach((response) => remember(response.body));
        token = responses[0]!.body.refreshToken;
      }
      expect((await me(session.accessToken)).status).toBe(200);
    });
  });

  describe("outages", () => {
    it("keeps refusing an ended session and serving active ones while Redis is down", async () => {
      const active = await signIn();
      const ended = await signIn(PHONE, { client: ANDROID });
      await bearer("delete", `/auth/sessions/${ended.sessionId}`, active.accessToken);

      await redisProxy.stop();
      try {
        expectError(await me(ended.accessToken), 401, "SESSION_ENDED");
        expect((await me(active.accessToken)).status).toBe(200);
        expect((await bearer("get", "/auth/sessions", active.accessToken)).status).toBe(200);
        const refused = await refresh(active.refreshToken);
        expectError(refused, 503, "SERVICE_UNAVAILABLE");
        expect(refused.body.retryable).toBe(true);
      } finally {
        await redisProxy.start();
      }
      await waitForDependencies();
      expect(await sessionRow(active.sessionId)).toMatchObject({
        revoked_at: null,
        refresh_generation: 0,
      });
      expect((await refresh(active.refreshToken)).status).toBe(200);
    }, 60_000);

    it("refuses every token while PostgreSQL is down, and recovers without a restart", async () => {
      const active = await signIn();
      const ended = await signIn(PHONE, { client: ANDROID });
      await bearer("delete", `/auth/sessions/${ended.sessionId}`, active.accessToken);

      await postgresProxy.stop();
      try {
        for (const token of [ended.accessToken, active.accessToken]) {
          const response = await me(token);
          expectError(response, 503, "SERVICE_UNAVAILABLE");
          expect(response.body.retryable).toBe(true);
        }
        expectError(await refresh(active.refreshToken), 503, "SERVICE_UNAVAILABLE");
        expect((await http().get("/health")).status).toBe(200);
      } finally {
        await postgresProxy.start();
      }
      await waitForDependencies();
      expectError(await me(ended.accessToken), 401, "SESSION_ENDED");
      expect((await me(active.accessToken)).status).toBe(200);
      expect(output.text()).toContain("Session store unavailable");
    }, 60_000);
  });

  describe("logs and storage", () => {
    it("record every session event with ids and a masked number", async () => {
      await settings.set({ session_refresh_reuse_grace_seconds: 0 });
      const first = await signIn();
      const second = await signIn();
      const renewed = await refreshed(first.refreshToken);
      await bearer("delete", `/auth/sessions/${second.sessionId}`, renewed.accessToken);
      await me(second.accessToken);
      await sleep(5);
      await refresh(first.refreshToken);
      const third = await signIn();
      await bearer("post", "/auth/sessions/end-all", third.accessToken);
      const fourth = await signIn();
      await bearer("post", "/auth/logout", fourth.accessToken);

      const logged = output.text();
      for (const event of [
        `Session created session=${first.sessionId} account=${first.accountId} kind=mobile phone=${MASKED}`,
        `Session refreshed session=${first.sessionId} account=${first.accountId} generation=1`,
        `Session ended session=${second.sessionId} account=${first.accountId} reason=ended_by_owner`,
        `Access refused: session ended session=${second.sessionId}`,
        `Refresh token reuse detected, session revoked session=${first.sessionId}`,
        `Sessions ended account=${first.accountId} scope=all count=1 by=${third.sessionId}`,
        `Session ended session=${fourth.sessionId} account=${first.accountId} reason=logout`,
      ]) {
        expect(logged).toContain(event);
      }
    });

    it("stores nothing a token could be rebuilt from without the server secret", async () => {
      const session = await signIn();
      const renewed = await refreshed(session.refreshToken);
      const { rows } = await db.query<{ row: string }>(
        "SELECT row_to_json(s)::text AS row FROM session s",
      );
      expect(rows).toHaveLength(1);
      for (const token of [session, renewed]) {
        for (const part of [
          token.accessToken,
          token.accessToken.split(".")[2]!,
          token.refreshToken,
          token.refreshToken.split(".")[3]!,
        ]) {
          expect(rows[0]!.row).not.toContain(part);
        }
      }
    });

    it("never logged a token or a usable part of one, or a full phone number, during this whole suite", () => {
      const output = appLogText();
      expect(output).toContain("Session created");
      expect(rememberedSecrets().size).toBeGreaterThan(100);
      // Login codes too: the output capture looks for them after this file.
      expect(rememberedCodes().size).toBeGreaterThan(50);
      expect(issuedTokens.size).toBeGreaterThan(100);
      for (const token of issuedTokens) {
        expect(output).not.toContain(token);
      }
      expect(output).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(output).not.toMatch(/rt1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}/);
      for (const digits of ["77011234567", "7011234567", "77471112233"]) {
        expect(output).not.toContain(digits);
      }
    });
  });
});
