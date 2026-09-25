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
import { OptionalSessionGuard, optionalSessionOf } from "../modules/identity";
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
 * A route open to guests that answers a session too (`auth: "optional"`)
 * may count a request with a session by its account instead (`perAccount`,
 * TASK-020.A; ARCHITECTURE 4.30): the session guard runs first, a valid
 * session is counted under `perAccount` by its account id wherever it
 * comes from, and a guest under `limit` by address. People behind one
 * address of a mobile operator then don't share a limit, and an account
 * is dear to make (a phone number and a code — limited themselves).
 *
 * Redis down: `refuse` — 503, nothing is done without the limit (the
 * request form, as the sign-in); `allow` — the read is served and the
 * outage is reported once a minute.
 */
@RateLimitGuardMark()
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly logger = new Logger("PublicRateLimit");
  /** When each limit last reported serving without Redis. */
  private readonly lastUnavailableWarning = new Map<RateLimitName, number>();

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
    const request = context.switchToHttp().getRequest<Request>();
    const counted = this.countedAs(spec, request);
    const [maxKey, windowKey] = publicRateLimitSettingKeys(counted.limit);
    const [max, windowSeconds] = await Promise.all([
      this.settings.get(maxKey),
      this.settings.get(windowKey),
    ]);
    const key = `public:${counted.limit}:${counted.subject}`;
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
        this.logger.warn(`Refused without the limit limit=${counted.limit}: ${error.message}`);
        throw serviceUnavailableException();
      }
      this.warnServedUnlimited(counted.limit, error);
      return true;
    }
    if (!allowed) {
      this.metrics.countRateLimitHit(counted.limit);
      // No address or account in the line: the limit and the route say enough.
      this.logger.warn(`Rate limit hit limit=${counted.limit} route=${route.operationId}`);
      throw rateLimitedException(counted.limit, retryAfterSeconds);
    }
    return true;
  }

  /** Which limit counts this request, and whose bucket: the account's or the address's. */
  private countedAs(
    spec: NonNullable<ApiRouteDefinition["rateLimit"]>,
    request: Request,
  ): { limit: RateLimitName; subject: string } {
    if (spec.perAccount) {
      const session = optionalSessionOf(request);
      if (session === undefined) {
        // `RateLimitedRoute` puts the session guard first; never count a
        // session by its address if that ever breaks.
        throw new Error("A limit per account without the optional session guard before it");
      }
      if (session) {
        return { limit: spec.perAccount, subject: `account:${session.accountId}` };
      }
    }
    return { limit: spec.limit, subject: rateLimitSubject(request.ip) };
  }

  private warnServedUnlimited(limit: RateLimitName, error: Error): void {
    const now = Date.now();
    if (now - (this.lastUnavailableWarning.get(limit) ?? 0) < UNAVAILABLE_WARNING_INTERVAL_MS) {
      return;
    }
    this.lastUnavailableWarning.set(limit, now);
    this.logger.warn(`Served without the limit limit=${limit}: ${error.message}`);
  }
}

/**
 * Binds a handler to a contract route that declares `rateLimit` (an open
 * route): `ApiRoute` with the guard that counts it. A route open to guests
 * with an optional session (`auth: "optional"`) gets the optional session
 * guard first — `@OptionalSession()` works as with `OptionalSessionRoute`,
 * and the limit sees the session.
 */
export function RateLimitedRoute(route: ApiRouteDefinition): MethodDecorator {
  if (route.auth === "session") {
    throw new Error(`${route.operationId}: a session route isn't limited as an open route`);
  }
  if (route.auth === "optional") {
    return ApiRoute(route, { guards: [OptionalSessionGuard, PublicRateLimitGuard] });
  }
  return ApiRoute(route, { guards: [PublicRateLimitGuard] });
}
