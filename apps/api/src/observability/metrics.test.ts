import * as crypto from "node:crypto";
import type { Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { MetricsController } from "./metrics.controller";
import { MetricsRegistry } from "./metrics-registry";
import { Metrics } from "./metrics.service";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

/**
 * TASK-009.A: what the metrics registry promises it does — label names
 * checked, label values cleaned, a failed sample absent rather than stale —
 * and the collector's token compared in constant time.
 */
describe("MetricsRegistry", () => {
  it("refuses a label name Prometheus wouldn't take", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("test_total", "Test");
    expect(() => counter.increment({ "bad-name": "x" })).toThrow(/Invalid metric label name/);
    expect(() => counter.increment({ le: "1" })).toThrow(/Invalid metric label name/);
  });

  it("cleans and bounds label values", async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("test_total", "Test");
    counter.increment({ route: "/call/+77011234567", long: "x".repeat(500) });

    const text = await registry.render();
    expect(text).not.toContain("7011234567");
    expect(text).toContain('route="/call/+7***4567"');
    expect(text).not.toContain("x".repeat(121));
  });

  it("leaves a failed sample out of the scrape instead of the previous values", async () => {
    const registry = new MetricsRegistry();
    const depth = registry.gauge("test_queue_depth", "Test");
    let fail = false;
    registry.collect(
      "queue",
      () => {
        depth.set({ job: "a" }, 1);
        if (fail) {
          throw new Error("database down");
        }
        depth.set({ job: "b" }, 7);
      },
      [depth],
    );

    const first = await registry.render();
    expect(first).toContain('test_queue_depth{job="b"} 7');
    expect(first).toContain('adclub_metrics_collector_up{collector="queue"} 1');

    fail = true;
    const second = await registry.render();
    expect(second).not.toContain("test_queue_depth{");
    expect(second).toContain('adclub_metrics_collector_up{collector="queue"} 0');
  });

  it("names gauges without the counter suffix", async () => {
    const metrics = new Metrics();
    metrics.setJobFailed("identity.cleanup-sessions", 2);
    metrics.setJobDead("identity.cleanup-sessions", 1);
    const text = await metrics.render();
    expect(text).toContain("# TYPE adclub_job_failed gauge");
    expect(text).toContain("# TYPE adclub_job_dead gauge");
    for (const line of text.split("\n").filter((row) => row.startsWith("# TYPE"))) {
      const [, , name, type] = line.split(" ");
      expect(name!.endsWith("_total"), line).toBe(type === "counter");
    }
  });
});

describe("MetricsController", () => {
  const TOKEN = "metrics-collector-token-1234567890";

  function controller(token: string | undefined): MetricsController {
    return new MetricsController({ metrics: { enabled: true, token } } as AppConfig, new Metrics());
  }

  function response() {
    const send = vi.fn();
    const type = vi.fn(() => ({ send }));
    const status = vi.fn(() => ({ type }));
    return { res: { status } as unknown as Response, status, send };
  }

  afterEach(() => {
    vi.mocked(crypto.timingSafeEqual).mockClear();
  });

  it("answers the right token", async () => {
    const { res, status } = response();
    await controller(TOKEN).scrape(`Bearer ${TOKEN}`, res);
    expect(status).toHaveBeenCalledWith(200);
  });

  it.each([
    ["no token", undefined],
    ["a wrong token", "Bearer wrong-token-of-some-length-000"],
    ["a longer one", `Bearer ${TOKEN}x`],
    ["the token alone", TOKEN],
  ])("refuses %s, comparing in constant time", async (_what, header) => {
    const { res, status } = response();
    await expect(controller(TOKEN).scrape(header, res)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(status).not.toHaveBeenCalled();
    // Digests of equal length, compared with `timingSafeEqual`, whatever was sent.
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
