import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports a well-formed ok status for the api service", () => {
    const response = new HealthController().getHealth();
    expect(response.status).toBe("ok");
    expect(response.service).toBe("api");
    expect(() => new Date(response.timestamp).toISOString()).not.toThrow();
  });
});
