import { describe, expect, it } from "vitest";
import { ConfigValidationError, defaultClientUpdateMessages, loadConfig } from "./env.schema";

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
      clientPolicy: {
        minSupportedVersions: {
          ios: "0.0.0",
          android: "0.0.0",
          "supplier-web": "0.0.0",
          "admin-web": "0.0.0",
        },
        updateMessage: defaultClientUpdateMessages,
      },
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
        settings: {
          codeLength: 6,
          ttlSeconds: 300,
          maxAttempts: 5,
          resendIntervalSeconds: 60,
          verifyFreeFailures: 2,
          verifyDelayBaseSeconds: 2,
          requestsPerPhone: { max: 5, windowSeconds: 3600 },
          requestsPerIp: { max: 30, windowSeconds: 3600 },
          verificationsPerPhone: { max: 15, windowSeconds: 3600 },
          smsPerPhoneDaily: { max: 5, windowSeconds: 86400 },
          smsPerIpDaily: { max: 10, windowSeconds: 86400 },
        },
      },
      session: {
        tokenSecret: expect.any(String),
        settings: {
          accessTokenTtlSeconds: 900,
          ttlSeconds: { mobile: 7_776_000, supplier_web: 15_552_000, admin_web: 43_200 },
          refreshReuseGraceSeconds: 60,
          refreshPerSession: { max: 30, windowSeconds: 3600 },
          refreshPerIp: { max: 600, windowSeconds: 3600 },
        },
      },
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

  it("reads per-platform minimum client versions and update messages", () => {
    const config = loadConfig({
      ...VALID_ENV,
      CLIENT_MIN_VERSION_IOS: "1.4.0",
      CLIENT_MIN_VERSION_ANDROID: "1.3.2",
      CLIENT_MIN_VERSION_ADMIN_WEB: "0.2.0",
      CLIENT_UPDATE_MESSAGE_KK: "Жаңартыңыз",
    });

    expect(config.clientPolicy.minSupportedVersions).toEqual({
      ios: "1.4.0",
      android: "1.3.2",
      "supplier-web": "0.0.0",
      "admin-web": "0.2.0",
    });
    expect(config.clientPolicy.updateMessage.kk).toBe("Жаңартыңыз");
    expect(config.clientPolicy.updateMessage.ru).toBe(defaultClientUpdateMessages.ru);
  });

  it.each(["1.4", "latest", "v1.4.0", " "])(
    "rejects a malformed minimum client version %j",
    (value) => {
      expect(() => loadConfig({ ...VALID_ENV, CLIENT_MIN_VERSION_ANDROID: value })).toThrow(
        /CLIENT_MIN_VERSION_ANDROID/,
      );
    },
  );

  it("rejects a blank update message", () => {
    expect(() => loadConfig({ ...VALID_ENV, CLIENT_UPDATE_MESSAGE_RU: "   " })).toThrow(
      /CLIENT_UPDATE_MESSAGE_RU/,
    );
  });

  describe("login codes", () => {
    const PRODUCTION_ENV = {
      ...VALID_ENV,
      NODE_ENV: "production",
      LOGIN_CODE_HASH_SECRET: "a-production-secret-of-at-least-32-chars",
      SESSION_TOKEN_SECRET: "a-production-session-secret-of-32-chars",
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

    it("reads thresholds and failing test channels from the environment", () => {
      const config = loadConfig({
        ...VALID_ENV,
        LOGIN_CODE_LENGTH: "4",
        LOGIN_CODE_TTL_SECONDS: "120",
        LOGIN_CODE_SMS_PER_IP_DAILY: "3",
        LOGIN_CODE_TEST_FAILING_CHANNELS: " whatsapp , sms ",
      });
      expect(config.loginCode.settings).toMatchObject({
        codeLength: 4,
        ttlSeconds: 120,
        smsPerIpDaily: { max: 3, windowSeconds: 86400 },
      });
      expect(config.loginCode.testFailingChannels).toEqual(["whatsapp", "sms"]);
    });

    it.each([
      ["LOGIN_CODE_LENGTH", "3"],
      ["LOGIN_CODE_LENGTH", "9"],
      ["LOGIN_CODE_TTL_SECONDS", "0"],
      ["LOGIN_CODE_REQUESTS_PER_IP", "many"],
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
    };

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

    it("reads lifetimes and refresh thresholds from the environment", () => {
      const config = loadConfig({
        ...VALID_ENV,
        SESSION_ACCESS_TOKEN_TTL_SECONDS: "60",
        SESSION_MOBILE_TTL_SECONDS: "100",
        SESSION_SUPPLIER_WEB_TTL_SECONDS: "200",
        SESSION_ADMIN_WEB_TTL_SECONDS: "300",
        SESSION_REFRESH_REUSE_GRACE_SECONDS: "0",
        SESSION_REFRESH_PER_SESSION: "5",
        SESSION_REFRESH_PER_IP_WINDOW_SECONDS: "10",
      });
      expect(config.session.settings).toEqual({
        accessTokenTtlSeconds: 60,
        ttlSeconds: { mobile: 100, supplier_web: 200, admin_web: 300 },
        refreshReuseGraceSeconds: 0,
        refreshPerSession: { max: 5, windowSeconds: 3600 },
        refreshPerIp: { max: 600, windowSeconds: 10 },
      });
    });

    it.each([
      ["SESSION_ACCESS_TOKEN_TTL_SECONDS", "0"],
      ["SESSION_MOBILE_TTL_SECONDS", "-1"],
      ["SESSION_REFRESH_REUSE_GRACE_SECONDS", "-1"],
      ["SESSION_REFRESH_PER_IP", "lots"],
    ])("rejects %s=%j", (name, value) => {
      expect(() => loadConfig({ ...VALID_ENV, [name]: value })).toThrow(new RegExp(name));
    });
  });
});
