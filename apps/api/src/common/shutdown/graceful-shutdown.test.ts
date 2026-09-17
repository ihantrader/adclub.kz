import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "./graceful-shutdown";

function fakeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
}

describe("installGracefulShutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it("closes and exits 0 on SIGTERM", async () => {
    const logger = fakeLogger();
    const close = vi.fn().mockResolvedValue(undefined);
    installGracefulShutdown({ logger, context: "Test", close });

    process.emit("SIGTERM");
    // Let close()'s promise microtask, then the .then() handler, run.
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.log).toHaveBeenCalledWith("Received SIGTERM, shutting down", "Test");
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("ignores a second signal once shutdown has started", async () => {
    const logger = fakeLogger();
    let resolveClose!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    installGracefulShutdown({ logger, context: "Test", close });

    process.emit("SIGTERM");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Received SIGINT while already shutting down, ignoring",
      "Test",
    );

    resolveClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("forces a nonzero exit if close() hangs past the timeout", async () => {
    vi.useFakeTimers();
    const logger = fakeLogger();
    const close = vi.fn(() => new Promise<void>(() => {}));
    installGracefulShutdown({ logger, context: "Test", close, timeoutMs: 5000 });

    process.emit("SIGTERM");
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Shutdown did not complete within 5000ms, forcing exit",
      "Test",
    );
  });

  it("exits nonzero and logs the reason if close() rejects", async () => {
    const logger = fakeLogger();
    const close = vi.fn().mockRejectedValue(new Error("pool.end() failed"));
    installGracefulShutdown({ logger, context: "Test", close });

    process.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith("Shutdown failed: pool.end() failed", "Test");
  });
});
