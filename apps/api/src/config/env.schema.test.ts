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
      http: { trustProxy: false },
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
});
