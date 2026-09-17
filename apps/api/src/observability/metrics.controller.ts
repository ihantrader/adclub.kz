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
 * Published only when `METRICS_ENABLED` (the controller isn't bound
 * otherwise); with `METRICS_TOKEN` set, the collector must present it as a
 * bearer token, so the endpoint can be exposed on a shared network.
 */
@Controller()
export class MetricsController {
  private readonly token: string | undefined;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    this.token = config.metrics.token;
  }

  @Get(METRICS_PATH)
  async scrape(
    @Headers("authorization") authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (this.token && authorization !== `Bearer ${this.token}`) {
      throw new ApiException(401, "AUTH_REQUIRED", "Metrics require the collector's token");
    }
    const body = await this.metrics.render();
    response.status(200).type("text/plain; version=0.0.4; charset=utf-8").send(body);
  }
}
