import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Get, Headers, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
// The leaf file, not the module's barrel: that one reaches back here
// through the exception filter, and the cycle breaks the process at load.
import { ApiException } from "../common/errors/api.exception";
import { APP_CONFIG, type AppConfig } from "../config";
import { Metrics } from "./metrics.service";

/**
 * Not part of the client contract: metrics are for the collector, not for
 * an application (the body is Prometheus text, not JSON), so the path is
 * excluded from the served-routes check like the other non-contract routes.
 */
export const METRICS_PATH = "/metrics";

/**
 * `GET /metrics` in the Prometheus text format (ARCHITECTURE 15.3).
 * Published only when metrics are on (the controller isn't bound
 * otherwise); with `METRICS_TOKEN` set, the collector must present it as a
 * bearer token. Outside development and test metrics are on only with a
 * token (`loadConfig`), so the endpoint is never open to anyone there.
 * The token is compared in constant time.
 */
function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

@Controller()
export class MetricsController {
  /** SHA-256 of `Bearer <token>`: equal lengths for `timingSafeEqual`. */
  private readonly expected: Buffer | undefined;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    this.expected = config.metrics.token ? digest(`Bearer ${config.metrics.token}`) : undefined;
  }

  @Get(METRICS_PATH)
  async scrape(
    @Headers("authorization") authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (this.expected && !timingSafeEqual(digest(authorization ?? ""), this.expected)) {
      throw new ApiException(401, "AUTH_REQUIRED", "Metrics require the collector's token");
    }
    const body = await this.metrics.render();
    response.status(200).type("text/plain; version=0.0.4; charset=utf-8").send(body);
  }
}
