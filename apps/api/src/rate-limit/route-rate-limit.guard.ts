import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiRouteDefinition, RateLimitName } from "@adclub/contracts";
import type { Request } from "express";
import { ApiRoute, API_ROUTE_METADATA, RateLimitGuardMark } from "../common/contract";
import {
  authenticatedSessionOf,
  OptionalSessionGuard,
  optionalSessionOf,
  SessionGuard,
} from "../modules/identity";
import { AppSettings } from "../modules/settings";
import { Metrics } from "../observability";
import { RateLimiterService, rateLimitSubject } from "../redis";
import { countedBeforeBody, RouteLimitCounter, rateLimitSettingKeys } from "./route-limit-counter";

export { rateLimitSettingKeys };

/**
 * How often a route may be called (ARCHITECTURE 4.26, 4.30, 4.33): the
 * contract names the limit (`rateLimit` of the route), the settings give
 * its size, and this one guard counts every route that declares one — an
 * open route, a route open to guests that answers a session too, and a
 * route of a session (TASK-023: the limits that used to be written by hand
 * inside services). Over the limit — 429 `RATE_LIMITED` with
 * `Retry-After`. Counted before the body is checked: a flood of malformed
 * requests is limited too. A route that takes a file (`upload`) has its
 * body read by a middleware before any guard, so its address is counted
 * there, before the body is read (`UploadRateLimitMiddleware`, TASK-059.A),
 * and this guard counts only a session's own bucket of such a route.
 *
 * Whose bucket a request falls into (`countedAs`):
 *
 * - `limit` — the client address Express derives with `TRUST_PROXY`, an
 *   IPv6 address by its /64 network (as the limits of sign-in, 4.5 I36);
 * - `perAccount` — the account of the session. On a route with
 *   `auth: "optional"` (TASK-020.A) a session is counted by its account
 *   and a guest by address: people behind one address of a mobile operator
 *   then don't share a limit, and an account is dear to make (a phone
 *   number and a code — limited themselves). On a session route there is
 *   no guest, so the account is the only bucket;
 * - `perMember` — the employee of a cabinet session (TASK-023): the work
 *   of a company is limited per person, not per company or address.
 *
 * Redis down: `refuse` — 503, nothing is done without the limit (the
 * request form, as the sign-in); `allow` — the request is served and the
 * outage is reported once a minute. The limits against guessing an order's
 * code stay inside `OrderLookup` (4.32 I325): they count failures rather
 * than requests, write to the action journal and refuse without Redis —
 * not a plain limit of a route.
 */
@RateLimitGuardMark()
@Injectable()
export class RouteRateLimitGuard implements CanActivate {
  private readonly counter: RouteLimitCounter;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimiterService) limiter: RateLimiterService,
    @Inject(AppSettings) settings: AppSettings,
    @Inject(Metrics) metrics: Metrics,
  ) {
    this.counter = new RouteLimitCounter(limiter, settings, metrics);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<ApiRouteDefinition | undefined>(
      API_ROUTE_METADATA,
      context.getHandler(),
    );
    const spec =
      route?.rateLimit ??
      this.reflector.get<NonContractRateLimit | undefined>(
        NON_CONTRACT_RATE_LIMIT,
        context.getHandler(),
      );
    if (!spec) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const counted = this.countedAs(route, spec, request);
    if (route && countedBeforeBody(route)) {
      // Counted by address before the body was read (`UploadRateLimitMiddleware`).
      return true;
    }
    await this.counter.hit({
      limit: counted.limit,
      subject: counted.subject,
      whenUnavailable: spec.whenUnavailable,
      route: route?.operationId ?? request.path,
    });
    return true;
  }

  /** Which limit counts this request, and whose bucket. */
  private countedAs(
    route: ApiRouteDefinition | undefined,
    spec: NonNullable<ApiRouteDefinition["rateLimit"]>,
    request: Request,
  ): { limit: RateLimitName; subject: string } {
    if (spec.perMember) {
      const memberId = this.session(request).supplierMemberId;
      if (!memberId) {
        // The contract binds `perMember` to the context «supplier».
        throw new Error("A limit per member on a route reached without an employee");
      }
      return { limit: spec.perMember, subject: `member:${memberId}` };
    }
    if (spec.perAccount) {
      const session = route?.auth === "session" ? this.session(request) : this.optional(request);
      if (session) {
        return { limit: spec.perAccount, subject: `account:${session.accountId}` };
      }
    }
    if (!spec.limit) {
      // `defineRoute` refuses such a contract; never count a session by its address.
      throw new Error("A rate limit without a bucket for this request");
    }
    return { limit: spec.limit, subject: rateLimitSubject(request.ip) };
  }

  /** The session of a route that requires one; its guard runs before this one. */
  private session(request: Request) {
    const session = authenticatedSessionOf(request);
    if (!session) {
      throw new Error("A limit per session without the session guard before it");
    }
    return session;
  }

  /** The session of a route open to guests: `null` — a guest, `undefined` — no guard ran. */
  private optional(request: Request) {
    const session = optionalSessionOf(request);
    if (session === undefined) {
      // `RateLimitedRoute` puts a session guard first; never count a
      // session by its address if that ever breaks.
      throw new Error("A limit per account without a session guard before it");
    }
    return session;
  }
}

/**
 * Binds a handler to a contract route that declares `rateLimit`: `ApiRoute`
 * with the guard that counts it, after the guard that knows who is asking.
 * An open route is counted by address; a route with `auth: "optional"`
 * gets the optional session guard first (so `@OptionalSession()` works as
 * with `OptionalSessionRoute` and the limit sees the session); a route
 * with `auth: "session"` gets the session guard first, exactly as
 * `SessionRoute` gives it, and `@CurrentSession()` works as usual.
 */
export function RateLimitedRoute(route: ApiRouteDefinition): MethodDecorator {
  if (!route.rateLimit) {
    throw new Error(`${route.operationId}: the contract declares no rate limit`);
  }
  if (route.auth === "session") {
    return ApiRoute(route, { guards: [SessionGuard, RouteRateLimitGuard] });
  }
  if (route.auth === "optional") {
    return ApiRoute(route, { guards: [OptionalSessionGuard, RouteRateLimitGuard] });
  }
  return ApiRoute(route, { guards: [RouteRateLimitGuard] });
}

/** The limit of a route that is deliberately outside the client contract. */
export const NON_CONTRACT_RATE_LIMIT = Symbol("NON_CONTRACT_RATE_LIMIT");

export type NonContractRateLimit = NonNullable<ApiRouteDefinition["rateLimit"]>;

/**
 * Binds a handler of a route outside the client contract to the same limit
 * mechanism (TASK-024): the provider's webhook is not part of the contract
 * (`/metrics` is not either), but there is still only one guard, one pair of
 * settings and one way of counting. Only a limit by address is possible
 * here: a route outside the contract has no session.
 */
export function RateLimitedNonContractRoute(spec: {
  limit: RateLimitName;
  whenUnavailable: "refuse" | "allow";
}): MethodDecorator {
  // Both settings must exist, or the limit would silently not be counted.
  rateLimitSettingKeys(spec.limit);
  return applyDecorators(
    SetMetadata(NON_CONTRACT_RATE_LIMIT, spec satisfies NonContractRateLimit),
    UseGuards(RouteRateLimitGuard),
  );
}
