import { describe, expect, it } from "vitest";
import type { DependencyCheck } from "@adclub/contracts";
import { ReadinessService } from "./readiness.service";
import type { DatabaseService } from "../database";
import type { RedisService } from "../redis";
import type { StorageService } from "../storage";

function fakeDependency(check: DependencyCheck) {
  return { checkHealth: async () => check } as unknown as DatabaseService &
    RedisService &
    StorageService;
}

const OK: DependencyCheck = { status: "ok", latencyMs: 1 };

describe("ReadinessService", () => {
  it("reports ok when every dependency is reachable", async () => {
    const service = new ReadinessService(
      fakeDependency(OK),
      fakeDependency(OK),
      fakeDependency(OK),
    );

    const result = await service.check();

    expect(result.status).toBe("ok");
    expect(result.checks.postgres.status).toBe("ok");
    expect(result.checks.redis.status).toBe("ok");
    expect(result.checks.s3.status).toBe("ok");
  });

  it("reports degraded when Redis alone is down, while other checks stay ok", async () => {
    const redisDown: DependencyCheck = {
      status: "error",
      error: "connect ECONNREFUSED 127.0.0.1:6379",
    };
    const service = new ReadinessService(
      fakeDependency(OK),
      fakeDependency(redisDown),
      fakeDependency(OK),
    );

    const result = await service.check();

    expect(result.status).toBe("degraded");
    expect(result.checks.redis.status).toBe("error");
    expect(result.checks.postgres.status).toBe("ok");
    expect(result.checks.s3.status).toBe("ok");
  });

  it("never exposes the driver's error text, addresses or credentials in the response", async () => {
    const down: DependencyCheck = {
      status: "error",
      error: 'password authentication failed for user "adclub" at 10.0.0.5:5432',
    };
    const service = new ReadinessService(
      fakeDependency(down),
      fakeDependency(OK),
      fakeDependency(OK),
    );

    const result = await service.check();

    expect(result.checks.postgres).toEqual({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    expect(JSON.stringify(result)).not.toContain("adclub");
  });

  it("reports degraded when every dependency is down", async () => {
    const down: DependencyCheck = { status: "error", error: "unreachable" };
    const service = new ReadinessService(
      fakeDependency(down),
      fakeDependency(down),
      fakeDependency(down),
    );

    const result = await service.check();

    expect(result.status).toBe("degraded");
  });
});
