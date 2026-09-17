import { describe, expect, it, vi } from "vitest";
import type { DependencyCheck } from "@adclub/contracts";
import { ReadinessService } from "./readiness.service";
import type { DatabaseService } from "../database";
import { Metrics } from "../observability";
import type { RedisService } from "../redis";
import type { StorageService } from "../storage";

function fakeDependency(check: DependencyCheck) {
  return { checkHealth: async () => check } as unknown as DatabaseService &
    RedisService &
    StorageService;
}

function readiness(
  postgres: DependencyCheck,
  redis: DependencyCheck,
  s3: DependencyCheck,
  metrics: Metrics = new Metrics(),
): ReadinessService {
  return new ReadinessService(
    fakeDependency(postgres),
    fakeDependency(redis),
    fakeDependency(s3),
    metrics,
  );
}

const OK: DependencyCheck = { status: "ok", latencyMs: 1 };

describe("ReadinessService", () => {
  it("reports ok when every dependency is reachable", async () => {
    const service = readiness(OK, OK, OK);

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
    const service = readiness(OK, redisDown, OK);

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
    const service = readiness(down, OK, OK);

    const result = await service.check();

    expect(result.checks.postgres).toEqual({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("10.0.0.5");
    expect(JSON.stringify(result)).not.toContain("adclub");
  });

  it("reports degraded when every dependency is down", async () => {
    const down: DependencyCheck = { status: "error", error: "unreachable" };
    const service = readiness(down, down, down);

    const result = await service.check();

    expect(result.status).toBe("degraded");
  });

  it("warns once when a dependency goes down, not on every poll (TASK-009)", async () => {
    const down: DependencyCheck = { status: "error", error: "connect ECONNREFUSED" };
    const service = readiness(OK, down, OK);
    const warn = vi.spyOn(
      (service as unknown as { logger: { warn: (message: string) => void } }).logger,
      "warn",
    );

    for (let poll = 0; poll < 50; poll += 1) {
      await service.check();
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs when a dependency comes back, and counts its state as a metric", async () => {
    const states: DependencyCheck[] = [{ status: "error", error: "down" }, OK];
    let poll = 0;
    const metrics = new Metrics();
    const service = new ReadinessService(
      fakeDependency(OK),
      { checkHealth: async () => states[Math.min(poll, 1)]! } as unknown as RedisService,
      fakeDependency(OK),
      metrics,
    );
    const logger = (service as unknown as { logger: { warn: () => void; log: () => void } }).logger;
    const log = vi.spyOn(logger, "log");
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await service.check();
    expect(await metrics.render()).toContain('adclub_dependency_up{dependency="redis"} 0');
    poll = 1;
    await service.check();

    expect(log).toHaveBeenCalledWith("Dependency is back: redis");
    expect(await metrics.render()).toContain('adclub_dependency_up{dependency="redis"} 1');
  });
});
