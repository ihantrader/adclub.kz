import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config";
import { JsonLoggerService } from "../logging/json-logger.service";
import { unhandledFailureHandlers } from "./unhandled-failures";

/**
 * TASK-009.A: an unhandled rejection is logged and reported and the process
 * goes on; an uncaught exception is logged and reported, and then the
 * process exits with code 1 once the event has left (or its time is up).
 * The real process-level behaviour, with a real receiver, is checked in
 * `observability.integration.test.ts`.
 */

function logger(): JsonLoggerService {
  return new JsonLoggerService(
    loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      S3_ENDPOINT: "http://x",
      S3_ACCESS_KEY: "a",
      S3_SECRET_KEY: "s",
      S3_BUCKET: "b",
    }),
  );
}

function failedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    "select $1::uuid",
    ["Айгерим Касымова +77011234567"],
    new Error('invalid input syntax for type uuid: "Айгерим Касымова +77011234567"'),
  );
}

describe("unhandled failures", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  const written = () => stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("");

  it("logs and reports an unhandled rejection and keeps the process", async () => {
    const reporter = { captureException: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
    const exit = vi.fn();
    const handlers = unhandledFailureHandlers({
      logger: logger(),
      reporter,
      context: "Test",
      exit,
    });

    handlers.onRejection(failedQuery());
    await Promise.resolve();

    expect(reporter.captureException).toHaveBeenCalledWith(expect.any(DrizzleQueryError), {
      transaction: "Test",
      tags: { kind: "unhandledRejection" },
    });
    expect(exit).not.toHaveBeenCalled();
    expect(written()).toContain("Failed query: select $1::uuid");
    expect(written()).not.toContain("Айгерим");
    expect(written()).not.toContain("7011234567");
  });

  it("logs, reports, waits for the event and exits with 1 on an uncaught exception", async () => {
    let flushed!: () => void;
    const reporter = {
      captureException: vi.fn(),
      flush: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            flushed = resolve;
          }),
      ),
    };
    const exit = vi.fn();
    const handlers = unhandledFailureHandlers({
      logger: logger(),
      reporter,
      context: "Test",
      exit,
      exitTimeoutMs: 1234,
    });

    handlers.onException(failedQuery());

    expect(reporter.captureException).toHaveBeenCalledWith(expect.any(DrizzleQueryError), {
      transaction: "Test",
      tags: { kind: "uncaughtException" },
    });
    expect(reporter.flush).toHaveBeenCalledWith(1234);
    // Not before the event has left.
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    flushed();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(written()).toContain("Uncaught exception: the process is exiting");
    expect(written()).not.toContain("Айгерим");
  });

  it("exits at once on a second uncaught exception while the first is being sent", () => {
    const reporter = {
      captureException: vi.fn(),
      flush: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const exit = vi.fn();
    const handlers = unhandledFailureHandlers({
      logger: logger(),
      reporter,
      context: "Test",
      exit,
    });

    handlers.onException(new Error("first"));
    handlers.onException(new Error("second"));

    expect(exit).toHaveBeenCalledWith(1);
    expect(reporter.captureException).toHaveBeenCalledTimes(1);
  });
});
