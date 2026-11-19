import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { contractPathOf, uploadRouteFor } from "../common/http/upload-routes";
import { SessionService } from "../modules/identity";
import { AppSettings } from "../modules/settings";
import { Metrics } from "../observability";
import { RateLimiterService, rateLimitSubject } from "../redis";
import { beforeBodyCount, RouteLimitCounter } from "./route-limit-counter";

/**
 * The limit by address of a route that takes a file (TASK-059.A;
 * ARCHITECTURE 4.33, 4.90), counted before the body is read.
 *
 * A file's body is read by `UploadBodyMiddleware`, before any guard — so
 * `RouteRateLimitGuard` would count only the requests that got through the
 * reading and the type check. A flood of refused bodies (the wrong type —
 * 415, too large — 413, not a sound — 400) would then cost the server the
 * reading of each, up to the contract's ceiling, with no limit at all. Here
 * every request of such a route is counted first, refused ones included,
 * with the same counter, settings and 429 as the guard; the guard then
 * leaves that bucket alone (`countedBeforeBody`).
 *
 * A session route counted `perAccount` (TASK-064.A: the photographed pages
 * of a price list, up to 60 MB a body) is counted here by the account its
 * access token names — by the signature alone, no database
 * (`SessionService.signedAccountOf`); a request without a valid token is
 * refused before its body is read, as the guard would refuse it. The guard
 * then checks the session itself.
 */
@Injectable()
export class UploadRateLimitMiddleware implements NestMiddleware {
  private readonly counter: RouteLimitCounter;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(RateLimiterService) limiter: RateLimiterService,
    @Inject(AppSettings) settings: AppSettings,
    @Inject(Metrics) metrics: Metrics,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {
    this.counter = new RouteLimitCounter(limiter, settings, metrics);
  }

  use(request: Request, _response: Response, next: NextFunction): void {
    const route = uploadRouteFor(request.method, contractPathOf(request));
    const counted = route ? beforeBodyCount(route) : null;
    if (!route?.rateLimit || !counted) {
      next();
      return;
    }
    let subject: string;
    try {
      // The same buckets as the guard's (`RouteRateLimitGuard.countedAs`).
      subject =
        counted.by === "account"
          ? `account:${this.sessions.signedAccountOf(request.headers.authorization, route.contexts)}`
          : rateLimitSubject(request.ip);
    } catch (error) {
      next(error);
      return;
    }
    this.counter
      .hit({
        limit: counted.limit,
        subject,
        whenUnavailable: route.rateLimit.whenUnavailable,
        route: contractPathOf(request),
      })
      .then(
        () => next(),
        (error: unknown) => next(error),
      );
  }
}
