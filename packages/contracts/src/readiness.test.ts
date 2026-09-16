import { describe, expect, it } from "vitest";
import { readinessResponseSchema } from "./readiness";

describe("readinessResponseSchema", () => {
  it("accepts a fully healthy readiness response", () => {
    const result = readinessResponseSchema.safeParse({
      status: "ok",
      checks: {
        postgres: { status: "ok", latencyMs: 4 },
        redis: { status: "ok", latencyMs: 1 },
        s3: { status: "ok", latencyMs: 12 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a degraded response with a failing dependency", () => {
    const result = readinessResponseSchema.safeParse({
      status: "degraded",
      checks: {
        postgres: { status: "ok", latencyMs: 4 },
        redis: { status: "error", error: "connect ECONNREFUSED" },
        s3: { status: "ok", latencyMs: 12 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing a dependency check", () => {
    const result = readinessResponseSchema.safeParse({
      status: "ok",
      checks: {
        postgres: { status: "ok" },
        redis: { status: "ok" },
      },
    });
    expect(result.success).toBe(false);
  });
});
