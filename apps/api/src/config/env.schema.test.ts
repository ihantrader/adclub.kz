import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, DEV_ADMIN_WEB_RELEASE_VERSION, loadConfig } from "./env.schema";

const VALID_ENV = {
  NODE_ENV: "development",
  PORT: "3000",
  DATABASE_URL: "postgres://adclub:adclub@localhost:5432/adclub",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "adclub",
  S3_SECRET_KEY: "top-secret-value",
  S3_BUCKET: "adclub-dev",
};

describe("loadConfig", () => {
  it("parses a fully valid environment into a typed AppConfig", () => {
    const config = loadConfig(VALID_ENV);

    expect(config).toEqual({
      nodeEnv: "development",
      port: 3000,
      logLevel: "log",
      database: { url: VALID_ENV.DATABASE_URL },
      redis: { url: VALID_ENV.REDIS_URL },
      storage: {
        endpoint: VALID_ENV.S3_ENDPOINT,
        accessKey: VALID_ENV.S3_ACCESS_KEY,
        secretKey: VALID_ENV.S3_SECRET_KEY,
        bucket: VALID_ENV.S3_BUCKET,
        region: "us-east-1",
      },
      adminWeb: { releaseVersion: DEV_ADMIN_WEB_RELEASE_VERSION },
      http: {
        trustProxy: false,
        webOrigins: {
          supplierWeb: ["http://localhost:5175", "http://127.0.0.1:5175"],
          adminWeb: ["http://localhost:5174", "http://127.0.0.1:5174"],
        },
      },
      loginCode: {
        channels: "test",
        testFailingChannels: [],
        devOutbox: true,
        hashSecret: expect.any(String),
      },
      session: { tokenSecret: expect.any(String) },
      signIn: { totpEncryptionKey: expect.any(String) },
      monitoring: { target: undefined, environment: "development" },
      metrics: { enabled: true, token: undefined },
      ai: { provider: "test", anthropicApiKey: undefined, testMode: "ok" },
      ignoredVariables: [],
    });
  });

  it("turns a Sentry-compatible DSN into the receiver's envelope endpoint (TASK-009)", () => {
    const config = loadConfig({
      ...VALID_ENV,
      MONITORING_DSN: "https://publickey@monitoring.example.kz/42",
      MONITORING_ENVIRONMENT: "staging",
    });

    expect(config.monitoring).toEqual({
      environment: "staging",
      target: {
        endpoint: "https://monitoring.example.kz/api/42/envelope/",
        publicKey: "publickey",
        projectId: "42",
        publicDsn: "https://monitoring.example.kz/42",
      },
    });
  });

  it("names MONITORING_DSN when it is not a DSN, without printing it", () => {
    expect(() => loadConfig({ ...VALID_ENV, MONITORING_DSN: "not-a-dsn" })).toThrow(
      /MONITORING_DSN/,
    );
    try {
      loadConfig({ ...VALID_ENV, MONITORING_DSN: "https://secretkey@host/1 broken" });
    } catch (error) {
      expect((error as Error).message).not.toContain("secretkey");
    }
  });

  it("sends nothing anywhere while no receiver is configured", () => {
    expect(loadConfig(VALID_ENV).monitoring.target).toBeUndefined();
  });

  describe("metrics outside development and test (TASK-009.A)", () => {
    const STAGING_ENV = {
      ...VALID_ENV,
      NODE_ENV: "staging",
      LOGIN_CODE_HASH_SECRET: "a-staging-secret-of-at-least-32-chars!",
      SESSION_TOKEN_SECRET: "a-staging-session-secret-of-32-chars!!",
      ADMIN_TOTP_ENCRYPTION_KEY: "a-staging-totp-key-of-at-least-32-chars",
      ADMIN_WEB_RELEASE_VERSION: "1.0.0",
    };
    const TOKEN = "metrics-collector-token-1234567890";

    it("are off without a token", () => {
      expect(loadConfig(STAGING_ENV).metrics).toEqual({ enabled: false, token: undefined });
    });

    it("are on with a token, which is then required", () => {
      expect(loadConfig({ ...STAGING_ENV, METRICS_TOKEN: TOKEN }).metrics).toEqual({
        enabled: true,
        token: TOKEN,
      });
    });

    it("refuse to start when asked for without a token", () => {
      expect(() => loadConfig({ ...STAGING_ENV, METRICS_ENABLED: "true" })).toThrow(
        /METRICS_TOKEN: required when METRICS_ENABLED=true and NODE_ENV=staging/,
      );
    });

    it("stay open without a token on a developer's machine", () => {
      expect(loadConfig(VALID_ENV).metrics).toEqual({ enabled: true, token: undefined });
      expect(loadConfig({ ...VALID_ENV, NODE_ENV: "test" }).metrics.enabled).toBe(true);
      expect(loadConfig({ ...VALID_ENV, METRICS_ENABLED: "false" }).metrics.enabled).toBe(false);
    });
  });

  it("applies documented defaults when optional variables are absent", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("log");
    expect(config.storage.region).toBe("us-east-1");
  });

  it("throws ConfigValidationError when a required variable is missing", () => {
    const { DATABASE_URL: _omit, ...withoutDatabaseUrl } = VALID_ENV;

    expect(() => loadConfig(withoutDatabaseUrl)).toThrow(ConfigValidationError);
  });

  it("names the missing/invalid variable in the error without leaking any values", () => {
    const { DATABASE_URL: _omit, ...withoutDatabaseUrl } = VALID_ENV;

    try {
      loadConfig(withoutDatabaseUrl);
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = (error as ConfigValidationError).message;
      expect(message).toContain("DATABASE_URL");
      for (const value of Object.values(VALID_ENV)) {
        expect(message).not.toContain(value);
      }
    }
  });

  it("rejects a DATABASE_URL with the wrong protocol", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, DATABASE_URL: "http://localhost:5432/adclub" }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects a malformed PORT", () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: "not-a-number" })).toThrow(ConfigValidationError);
  });

  it("rejects an empty required secret", () => {
    expect(() => loadConfig({ ...VALID_ENV, S3_SECRET_KEY: "" })).toThrow(ConfigValidationError);
  });

  it("ignores and reports former variables whose values are settings now", () => {
    const config = loadConfig({
      ...VALID_ENV,
      CLIENT_MIN_VERSION_IOS: "1.4.0",
      CLIENT_UPDATE_MESSAGE_KK: "Жаңартыңыз",
      LOGIN_CODE_LENGTH: "3",
      LOGIN_CODE_REQUESTS_PER_IP: "many",
      SESSION_ADMIN_WEB_TTL_SECONDS: String(24 * 60 * 60),
      SIGN_IN_ADMIN_TOTP_TTL_SECONDS: "7200",
      ADMIN_TOTP_VERIFY_PER_IP: "1",
      ADMIN_BACKUP_CODE_COUNT: "0",
    });
    expect(config.ignoredVariables).toEqual([
      "ADMIN_BACKUP_CODE_COUNT",
      "ADMIN_TOTP_VERIFY_PER_IP",
      "CLIENT_MIN_VERSION_IOS",
      "CLIENT_UPDATE_MESSAGE_KK",
      "LOGIN_CODE_LENGTH",
      "LOGIN_CODE_REQUESTS_PER_IP",
      "SESSION_ADMIN_WEB_TTL_SECONDS",
      "SIGN_IN_ADMIN_TOTP_TTL_SECONDS",
    ]);
    // Secrets and switches keep their names and aren't reported.
    expect(
      loadConfig({
        ...VALID_ENV,
        LOGIN_CODE_CHANNELS: "test",
        LOGIN_CODE_HASH_SECRET: "a-development-secret-of-32-characters",
        SESSION_TOKEN_SECRET: "a-development-session-secret-of-32-chars",
        ADMIN_TOTP_ENCRYPTION_KEY: "a-development-totp-key-of-32-characters",
      }).ignoredVariables,
    ).toEqual([]);
  });

  describe("admin panel release version", () => {
    it("defaults to the version of apps/admin-web in development and tests", () => {
      const adminWebPackage = JSON.parse(
        readFileSync(join(__dirname, "../../../admin-web/package.json"), "utf8"),
      ) as { version: string };
      expect(DEV_ADMIN_WEB_RELEASE_VERSION).toBe(adminWebPackage.version);
      expect(loadConfig(VALID_ENV).adminWeb.releaseVersion).toBe(DEV_ADMIN_WEB_RELEASE_VERSION);
      expect(
        loadConfig({ ...VALID_ENV, ADMIN_WEB_RELEASE_VERSION: "2.3.4" }).adminWeb.releaseVersion,
      ).toBe("2.3.4");
    });

    it.each(["1.4", "latest", "v1.4.0", " "])("rejects a malformed version %j", (value) => {
      expect(() => loadConfig({ ...VALID_ENV, ADMIN_WEB_RELEASE_VERSION: value })).toThrow(
        /ADMIN_WEB_RELEASE_VERSION/,
      );
    });

    it("is required outside development and tests", () => {
      expect(() =>
        loadConfig({
          ...VALID_ENV,
          NODE_ENV: "staging",
          LOGIN_CODE_HASH_SECRET: "a-staging-secret-of-at-least-32-chars!",
          SESSION_TOKEN_SECRET: "a-staging-session-secret-of-32-chars!!",
          ADMIN_TOTP_ENCRYPTION_KEY: "a-staging-totp-key-of-at-least-32-chars",
        }),
      ).toThrow(/ADMIN_WEB_RELEASE_VERSION: required when NODE_ENV=staging/);
    });
  });

  describe("AI provider (TASK-012)", () => {
    const KEY = "sk-ant-not-a-real-key-for-tests-only";
    const PRODUCTION_ENV = {
      ...VALID_ENV,
      NODE_ENV: "production",
      LOGIN_CODE_HASH_SECRET: "a-production-secret-of-at-least-32-chars",
      SESSION_TOKEN_SECRET: "a-production-session-secret-of-32-chars",
      ADMIN_TOTP_ENCRYPTION_KEY: "a-production-totp-key-of-at-least-32-chars",
      ADMIN_WEB_RELEASE_VERSION: "1.0.0",
    };

    it("runs the test provider without a key and Claude with one", () => {
      expect(loadConfig(VALID_ENV).ai).toEqual({
        provider: "test",
        anthropicApiKey: undefined,
        testMode: "ok",
      });
      expect(loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: KEY }).ai).toEqual({
        provider: "claude",
        anthropicApiKey: KEY,
        testMode: "ok",
      });
      // The provider can be chosen even with a key (development with a real key at hand).
      expect(
        loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: KEY, AI_PROVIDER: "test" }).ai.provider,
      ).toBe("test");
      // Empty variables in a copied .env count as unset.
      expect(
        loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: "", AI_PROVIDER: "", AI_TEST_MODE: "" }).ai,
      ).toEqual({
        provider: "test",
        anthropicApiKey: undefined,
        testMode: "ok",
      });
    });

    it("takes the mode of the test provider and refuses an unknown one", () => {
      expect(loadConfig({ ...VALID_ENV, AI_TEST_MODE: "unavailable" }).ai.testMode).toBe(
        "unavailable",
      );
      expect(() => loadConfig({ ...VALID_ENV, AI_TEST_MODE: "broken" })).toThrow(/AI_TEST_MODE/);
    });

    it("refuses Claude without a key and production with the test provider, naming the variable only", () => {
      expect(() => loadConfig({ ...VALID_ENV, AI_PROVIDER: "claude" })).toThrow(
        /ANTHROPIC_API_KEY: required when AI_PROVIDER=claude/,
      );
      expect(() => loadConfig(PRODUCTION_ENV)).toThrow(
        /AI_PROVIDER: the test AI provider is not allowed when NODE_ENV=production/,
      );
      try {
        loadConfig({ ...PRODUCTION_ENV, AI_PROVIDER: "test", ANTHROPIC_API_KEY: KEY });
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toMatch(/AI_PROVIDER/);
        expect((error as Error).message).not.toContain(KEY);
      }
      // Staging may run the test provider; production with a key has no complaint about AI.
      expect(loadConfig({ ...PRODUCTION_ENV, NODE_ENV: "staging" }).ai.provider).toBe("test");
      try {
        loadConfig({ ...PRODUCTION_ENV, ANTHROPIC_API_KEY: KEY });
      } catch (error) {
        expect((error as Error).message).not.toMatch(/AI_PROVIDER|ANTHROPIC_API_KEY/);
      }
    });
  });

  describe("login codes", () => {
    const PRODUCTION_ENV = {
      ...VALID_ENV,
      NODE_ENV: "production",
      LOGIN_CODE_HASH_SECRET: "a-production-secret-of-at-least-32-chars",
      SESSION_TOKEN_SECRET: "a-production-session-secret-of-32-chars",
      ADMIN_TOTP_ENCRYPTION_KEY: "a-production-totp-key-of-at-least-32-chars",
      ADMIN_WEB_RELEASE_VERSION: "1.0.0",
    };

    it("refuses to start production with the test channels", () => {
      expect(() => loadConfig(PRODUCTION_ENV)).toThrow(
        /LOGIN_CODE_CHANNELS: test channels are not allowed when NODE_ENV=production/,
      );
    });

    it("refuses to start production with the dev code outbox", () => {
      expect(() => loadConfig({ ...PRODUCTION_ENV, LOGIN_CODE_DEV_OUTBOX: "true" })).toThrow(
        /LOGIN_CODE_DEV_OUTBOX/,
      );
    });

    it("never enables the dev code outbox by default outside development and tests", () => {
      const staging = loadConfig({ ...PRODUCTION_ENV, NODE_ENV: "staging" });
      expect(staging.loginCode.devOutbox).toBe(false);
      expect(loadConfig({ ...VALID_ENV, NODE_ENV: "test" }).loginCode.devOutbox).toBe(true);
      expect(loadConfig({ ...VALID_ENV, LOGIN_CODE_DEV_OUTBOX: "false" }).loginCode.devOutbox).toBe(
        false,
      );
    });

    it("requires a hash secret outside development and tests, without printing it", () => {
      expect(() => loadConfig({ ...VALID_ENV, NODE_ENV: "staging" })).toThrow(
        /LOGIN_CODE_HASH_SECRET: required when NODE_ENV=staging/,
      );
      try {
        loadConfig({ ...PRODUCTION_ENV, LOGIN_CODE_HASH_SECRET: "short-secret-value" });
        expect.unreachable("loadConfig should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("LOGIN_CODE_HASH_SECRET");
        expect((error as Error).message).not.toContain("short-secret-value");
      }
    });

    it("reads the failing test channels from the environment", () => {
      const config = loadConfig({
        ...VALID_ENV,
        LOGIN_CODE_TEST_FAILING_CHANNELS: " whatsapp , sms ",
      });
      expect(config.loginCode.testFailingChannels).toEqual(["whatsapp", "sms"]);
    });

    it.each([
      ["LOGIN_CODE_TEST_FAILING_CHANNELS", "telegram"],
      ["LOGIN_CODE_CHANNELS", "meta"],
      ["LOGIN_CODE_DEV_OUTBOX", "maybe"],
    ])("rejects %s=%j", (name, value) => {
      expect(() => loadConfig({ ...VALID_ENV, [name]: value })).toThrow(new RegExp(name));
    });
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true],
    ["1", 1],
    ["loopback", "loopback"],
  ])("reads TRUST_PROXY=%j", (value, expected) => {
    expect(loadConfig({ ...VALID_ENV, TRUST_PROXY: value }).http.trustProxy).toBe(expected);
  });

  describe("sessions and web origins", () => {
    const STAGING_ENV = {
      ...VALID_ENV,
      NODE_ENV: "staging",
      LOGIN_CODE_HASH_SECRET: "a-staging-secret-of-at-least-32-chars!",
      ADMIN_TOTP_ENCRYPTION_KEY: "a-staging-totp-key-of-at-least-32-chars",
      ADMIN_WEB_RELEASE_VERSION: "1.0.0",
    };

    it("requires the TOTP encryption key outside development and tests, without printing it", () => {
      const { ADMIN_TOTP_ENCRYPTION_KEY: _key, ...withoutKey } = STAGING_ENV;
      const withSessionSecret = {
        ...withoutKey,
        SESSION_TOKEN_SECRET: "a-staging-session-secret-of-32-chars!!",
      };
      expect(() => loadConfig(withSessionSecret)).toThrow(
        /ADMIN_TOTP_ENCRYPTION_KEY: required when NODE_ENV=staging/,
      );
      expect(() =>
        loadConfig({ ...withSessionSecret, NODE_ENV: "production", LOGIN_CODE_CHANNELS: "test" }),
      ).toThrow(/ADMIN_TOTP_ENCRYPTION_KEY: required when NODE_ENV=production/);
      try {
        loadConfig({ ...withSessionSecret, ADMIN_TOTP_ENCRYPTION_KEY: "short-totp-key" });
        expect.unreachable("loadConfig should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("ADMIN_TOTP_ENCRYPTION_KEY");
        expect((error as Error).message).not.toContain("short-totp-key");
      }
      expect(loadConfig({ ...VALID_ENV }).signIn.totpEncryptionKey.length).toBeGreaterThanOrEqual(
        32,
      );
    });

    it("requires a session token secret outside development and tests, without printing it", () => {
      expect(() => loadConfig(STAGING_ENV)).toThrow(
        /SESSION_TOKEN_SECRET: required when NODE_ENV=staging/,
      );
      try {
        loadConfig({ ...STAGING_ENV, SESSION_TOKEN_SECRET: "too-short-session-secret" });
        expect.unreachable("loadConfig should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("SESSION_TOKEN_SECRET");
        expect((error as Error).message).not.toContain("too-short-session-secret");
      }
      const secret = "a-staging-session-secret-of-32-chars!!";
      expect(loadConfig({ ...STAGING_ENV, SESSION_TOKEN_SECRET: secret }).session.tokenSecret).toBe(
        secret,
      );
    });

    it("trusts no browser origin outside development unless configured", () => {
      const staging = loadConfig({
        ...STAGING_ENV,
        SESSION_TOKEN_SECRET: "a-staging-session-secret-of-32-chars!!",
      });
      expect(staging.http.webOrigins).toEqual({ supplierWeb: [], adminWeb: [] });

      const configured = loadConfig({
        ...STAGING_ENV,
        SESSION_TOKEN_SECRET: "a-staging-session-secret-of-32-chars!!",
        SUPPLIER_WEB_ORIGINS: " https://cabinet.adclub.kz , https://cabinet.staging.adclub.kz ",
        ADMIN_WEB_ORIGINS: "https://admin.adclub.kz:8443",
      });
      expect(configured.http.webOrigins).toEqual({
        supplierWeb: ["https://cabinet.adclub.kz", "https://cabinet.staging.adclub.kz"],
        adminWeb: ["https://admin.adclub.kz:8443"],
      });
      expect(loadConfig({ ...VALID_ENV, ADMIN_WEB_ORIGINS: "" }).http.webOrigins.adminWeb).toEqual(
        [],
      );
    });

    it.each([
      "https://cabinet.adclub.kz/",
      "https://cabinet.adclub.kz/app",
      "cabinet.adclub.kz",
      "ftp://cabinet.adclub.kz",
      "*",
      "null",
    ])("rejects the web origin %j", (origin) => {
      expect(() => loadConfig({ ...VALID_ENV, SUPPLIER_WEB_ORIGINS: origin })).toThrow(
        /SUPPLIER_WEB_ORIGINS/,
      );
    });
  });
});
