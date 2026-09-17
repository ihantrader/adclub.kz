import { AsyncResource } from "node:async_hooks";
import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { Metrics } from "../../observability/metrics.service";
import { describeRequestClient, getRequestClient } from "../client";
import { JsonLoggerService } from "./json-logger.service";

/** The route as the contract declares it, for a metric label of bounded cardinality. */
function routeTemplate(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route;
  return typeof route?.path === "string" ? route.path : "unmatched";
}

/**
 * Logs one line per HTTP request: method, path, status, duration and the
 * calling client (`X-Client`, or `missing`/`invalid` — ARCHITECTURE 7.4
 * wants the version spread visible), and counts the request in the metrics
 * (`adclub_http_request_duration_seconds`, ARCHITECTURE 15.3).
 *
 * Never the body or other headers — those can carry personal data — and
 * never the query string: a filter or a search term is the caller's data
 * and has no place in the access log (TASK-009). What is measured and
 * logged is the path with its values; the metric label is the route
 * template, so one series per route rather than per value.
 *
 * A middleware rather than an interceptor: guards run before
 * interceptors, so a request rejected by a guard (e.g. 426 from the
 * client version guard) never reached the old `LoggingInterceptor` and
 * went unlogged. Middleware runs for every request.
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  // See HttpExceptionFilter for why `@Inject` is required here.
  constructor(
    @Inject(JsonLoggerService) private readonly logger: JsonLoggerService,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const client = getRequestClient(request);
    // `originalUrl` carries the query string; only the path is written.
    const path = request.originalUrl.split("?")[0] ?? request.originalUrl;

    if (client.kind === "invalid") {
      this.logger.warn("Unrecognized X-Client header; serving as an unknown client", "HTTP");
    }

    // Listening for 'finish' is what gives the real status code, including
    // the one the exception filter sets after a handler fails. Bound to the
    // current async context so the line keeps the request id.
    response.on(
      "finish",
      AsyncResource.bind(() => {
        const durationMs = Date.now() - startedAt;
        this.metrics.observeHttpRequest(
          routeTemplate(request),
          request.method,
          response.statusCode,
          durationMs,
        );
        this.logger.log(
          `${request.method} ${path} ${response.statusCode} ${durationMs}ms client=${describeRequestClient(client)}`,
          "HTTP",
        );
      }),
    );

    next();
  }
}
