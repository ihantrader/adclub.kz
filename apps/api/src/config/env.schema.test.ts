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
});
