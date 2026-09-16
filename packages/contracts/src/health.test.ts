import { describe, expect, it } from "vitest";
import { healthCheckResponseSchema } from "./health";

describe("healthCheckResponseSchema", () => {
  it("accepts a well-formed health response", () => {
    const result = healthCheckResponseSchema.safeParse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response with an unknown status", () => {
    const result = healthCheckResponseSchema.safeParse({
      status: "degraded",
      service: "api",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
