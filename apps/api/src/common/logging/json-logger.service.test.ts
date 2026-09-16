import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "../../config";
import { JsonLoggerService } from "./json-logger.service";
import { requestContext } from "./request-context";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      S3_ENDPOINT: "http://x",
      S3_ACCESS_KEY: "a",
      S3_SECRET_KEY: "s",
      S3_BUCKET: "b",
    }),
    ...overrides,
  };
}

describe("JsonLoggerService", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes a structured JSON line with level, message and timestamp", () => {
    const logger = new JsonLoggerService(baseConfig());
    logger.log("API listening on port 3000", "Bootstrap");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse((stdoutSpy.mock.calls[0]?.[0] as string).trim());
    expect(entry).toMatchObject({
      level: "log",
      message: "API listening on port 3000",
      context: "Bootstrap",
    });
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
  });

  it("includes the current request id from AsyncLocalStorage", () => {
    const logger = new JsonLoggerService(baseConfig());

    requestContext.run({ requestId: "req-123" }, () => {
      logger.log("handled");
    });

    const entry = JSON.parse((stdoutSpy.mock.calls[0]?.[0] as string).trim());
    expect(entry.requestId).toBe("req-123");
  });

  it("omits requestId outside of a request context", () => {
    const logger = new JsonLoggerService(baseConfig());
    logger.log("no request in flight");

    const entry = JSON.parse((stdoutSpy.mock.calls[0]?.[0] as string).trim());
    expect(entry.requestId).toBeUndefined();
  });

  it("routes error and warn to stderr, everything else to stdout", () => {
    const logger = new JsonLoggerService(baseConfig());
    logger.error("boom");
    logger.warn("careful");
    logger.log("fine");

    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses levels below the configured threshold", () => {
    const logger = new JsonLoggerService(baseConfig({ logLevel: "log" }));
    logger.debug("should not appear");
    logger.verbose("should not appear either");
    logger.log("should appear");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it("respects a more verbose configured level", () => {
    const logger = new JsonLoggerService(baseConfig({ logLevel: "debug" }));
    logger.debug("now visible");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it("never includes a request body or header field in the log entry", () => {
    const logger = new JsonLoggerService(baseConfig());
    logger.log("handled request");

    const entry = JSON.parse((stdoutSpy.mock.calls[0]?.[0] as string).trim());
    expect(entry).not.toHaveProperty("body");
    expect(entry).not.toHaveProperty("headers");
  });
});
