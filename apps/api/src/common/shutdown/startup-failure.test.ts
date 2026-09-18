import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../config/env.schema";
import { logStartupFailure } from "./startup-failure";

/** TASK-009.A: a process that can't start says why through the sanitizer. */
describe("logStartupFailure", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  const written = () => stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("");

  it("writes a failure as cleaned JSON lines", () => {
    const cause = new Error("connect ECONNREFUSED postgres://adclub:s3cr3t@10.0.0.5:5432/adclub");
    logStartupFailure(
      "worker process",
      "Worker",
      new DrizzleQueryError("select $1", ["+77011234567"], cause),
    );

    const text = written();
    expect(text).toContain("Failed to start worker process");
    expect(text).toContain('"context":"Worker"');
    expect(text).not.toContain("7011234567");
    for (const line of text.trim().split("\n")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it("keeps a configuration error readable, and cleaned", () => {
    logStartupFailure(
      "API process",
      "Bootstrap",
      new ConfigValidationError(["DATABASE_URL: invalid postgres://adclub:s3cr3t@db/adclub"]),
    );

    const text = written();
    expect(text).toContain("Invalid configuration:\n  - DATABASE_URL: invalid");
    expect(text).not.toContain("s3cr3t");
  });

  it("does not throw on a value that isn't an error", () => {
    expect(() => logStartupFailure("API process", "Bootstrap", "+77011234567")).not.toThrow();
    expect(written()).not.toContain("7011234567");
  });
});
