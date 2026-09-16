import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "./env.schema";

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
});
