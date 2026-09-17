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

  it("keeps the context when Nest passes a stack trace as well (TASK-009)", () => {
    const logger = new JsonLoggerService(baseConfig());
    const stack = ["Error: boom", "    at handler (file.ts:1:1)"].join("\n");

    logger.error("boom", stack, "ExceptionsHandler");

    const entry = JSON.parse((stderrSpy.mock.calls[0]?.[0] as string).trim());
    expect(entry.context).toBe("ExceptionsHandler");
    expect(entry.stack).toContain("at handler");
  });

  it("writes an object as sanitized JSON, not as [object Object]", () => {
    const logger = new JsonLoggerService(baseConfig());

    logger.log("job finished", { job: "identity.cleanup-sessions", rows: 3 }, "Jobs");

    const line = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("[object Object]");
    const entry = JSON.parse(line.trim());
    expect(entry.context).toBe("Jobs");
    expect(entry.details).toEqual({ job: "identity.cleanup-sessions", rows: 3 });
  });

  it("masks a phone number and removes a token wherever they appear", () => {
    const logger = new JsonLoggerService(baseConfig());

    logger.log("code sent to +77011234567", { phone: "+77011234567", accessToken: "abcdef" });

    const line = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("77011234567");
    expect(line).not.toContain("abcdef");
    const entry = JSON.parse(line.trim());
    expect(entry.message).toBe("code sent to +7***4567");
    expect(entry.details).toEqual({ phone: "+7***4567", accessToken: "[redacted]" });
  });

  it("masks a phone number inside an error message and its stack", () => {
    const logger = new JsonLoggerService(baseConfig());
    const error = new Error("no account for +77011234567");

    logger.error(error, "Session");

    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("77011234567");
    const entry = JSON.parse(line.trim());
    expect(entry.message).toBe("no account for +7***4567");
    expect(entry.context).toBe("Session");
  });
});
