import { AsyncResource } from "node:async_hooks";
import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { describeRequestClient, getRequestClient } from "../client";
import { JsonLoggerService } from "./json-logger.service";

/**
 * Logs one line per HTTP request: method, path, status, duration and the
 * calling client (`X-Client`, or `missing`/`invalid` — ARCHITECTURE 7.4
 * wants the version spread visible). Never the body or other headers —
 * those can carry personal data (ARCHITECTURE 15.3).
 *
 * A middleware rather than an interceptor: guards run before
 * interceptors, so a request rejected by a guard (e.g. 426 from the
 * client version guard) never reached the old `LoggingInterceptor` and
 * went unlogged. Middleware runs for every request.
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  // See HttpExceptionFilter for why `@Inject` is required here.
  constructor(@Inject(JsonLoggerService) private readonly logger: JsonLoggerService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const client = getRequestClient(request);

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
        this.logger.log(
          `${request.method} ${request.originalUrl} ${response.statusCode} ${durationMs}ms client=${describeRequestClient(client)}`,
          "HTTP",
        );
      }),
    );

    next();
  }
}
