import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiRouteDefinition, RateLimitName } from "@adclub/contracts";
import type { Request } from "express";
import { ApiRoute, API_ROUTE_METADATA, RateLimitGuardMark } from "../common/contract";
import { rateLimitedException, serviceUnavailableException } from "../common/errors";
import { AppSettings, isSettingKey, type SettingKey } from "../modules/settings";
import { Metrics } from "../observability";
import { RateLimiterService, RateLimiterUnavailableError, rateLimitSubject } from "../redis";

/** How often a served read without a working limiter is reported (not every request). */
const UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;

/** The settings of a limit: `<limit>` (how many) and `<limit>_window_seconds` (per how long). */
export function publicRateLimitSettingKeys(limit: RateLimitName): [SettingKey, SettingKey] {
  const max = limit;
  const window = `${limit}_window_seconds`;
  if (!isSettingKey(max) || !isSettingKey(window)) {
    throw new Error(`The rate limit ${limit} has no settings ${max} and ${window}`);
  }
  return [max, window];
}

/**
 * The limit of a route open without signing in (ARCHITECTURE 4.26;
 * TASK-016): the contract names it (`rateLimit` of the route), the
 * settings give its size, the client address is what is counted — the
 * address Express derives with `TRUST_PROXY`, an IPv6 address by its /64
 * network (as the limits of sign-in, 4.5 I36). Over the limit — 429
 * `RATE_LIMITED` with `Retry-After`. Counted before the body is read or
 * checked: a flood of malformed requests is limited too.
 *
 * Redis down: `refuse` — 503, nothing is done without the limit (the
 * request form, as the sign-in); `allow` — the read is served and the
 * outage is reported once a minute.
 */
@RateLimitGuardMark()
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly logger = new Logger("PublicRateLimit");
  private lastUnavailableWarning = 0;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<ApiRouteDefinition | undefined>(
      API_ROUTE_METADATA,
      context.getHandler(),
    );
    const spec = route?.rateLimit;
    if (!spec) {
      return true;
    }
    const [maxKey, windowKey] = publicRateLimitSettingKeys(spec.limit);
    const [max, windowSeconds] = await Promise.all([
      this.settings.get(maxKey),
      this.settings.get(windowKey),
    ]);
    const request = context.switchToHttp().getRequest<Request>();
    const key = `public:${spec.limit}:${rateLimitSubject(request.ip)}`;
    let allowed: boolean;
    let retryAfterSeconds: number;
    try {
      ({ allowed, retryAfterSeconds } = await this.limiter.hit(key, {
        max: max as number,
        windowSeconds: windowSeconds as number,
      }));
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) {
        throw error;
      }
      if (spec.whenUnavailable === "refuse") {
        this.logger.warn(`Refused without the limit limit=${spec.limit}: ${error.message}`);
        throw serviceUnavailableException();
      }
      this.warnServedUnlimited(spec.limit, error);
      return true;
    }
    if (!allowed) {
      this.metrics.countRateLimitHit(spec.limit);
      // No address in the line: the limit and the route say enough.
      this.logger.warn(`Rate limit hit limit=${spec.limit} route=${route.operationId}`);
      throw rateLimitedException(spec.limit, retryAfterSeconds);
    }
    return true;
  }

  private warnServedUnlimited(limit: RateLimitName, error: Error): void {
    const now = Date.now();
    if (now - this.lastUnavailableWarning < UNAVAILABLE_WARNING_INTERVAL_MS) {
      return;
    }
    this.lastUnavailableWarning = now;
    this.logger.warn(`Served without the limit limit=${limit}: ${error.message}`);
  }
}

/**
 * Binds a handler to a contract route that declares `rateLimit` (an open
 * route): `ApiRoute` with the guard that counts it.
 */
export function RateLimitedRoute(route: ApiRouteDefinition): MethodDecorator {
  return ApiRoute(route, { guards: [PublicRateLimitGuard] });
}
