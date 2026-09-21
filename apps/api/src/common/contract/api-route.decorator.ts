import {
  applyDecorators,
  HttpCode,
  RequestMapping,
  RequestMethod,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type Type,
} from "@nestjs/common";
import type { ApiRouteDefinition } from "@adclub/contracts";

export const API_ROUTE_METADATA = Symbol("API_ROUTE_METADATA");

const SESSION_ACCESS_GUARD = Symbol("SESSION_ACCESS_GUARD");

/**
 * Marks the guard that enforces `auth: "session"` and the route's
 * contexts (`SessionGuard` in the identity module). A session route is
 * bound only together with a guard carrying this mark — any other guard
 * would let the route be served without the access rule.
 */
export function SessionAccessGuard(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(SESSION_ACCESS_GUARD, true, target);
  };
}

function isSessionAccessGuard(guard: Type<CanActivate>): boolean {
  return Reflect.getMetadata(SESSION_ACCESS_GUARD, guard) === true;
}

const RATE_LIMIT_GUARD = Symbol("RATE_LIMIT_GUARD");

/**
 * Marks the guard that counts the `rateLimit` of an open route
 * (`PublicRateLimitGuard`, TASK-016). A route whose contract declares a
 * limit is bound only together with it, so a limited route can't be
 * served without its limit.
 */
export function RateLimitGuardMark(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(RATE_LIMIT_GUARD, true, target);
  };
}

function isRateLimitGuard(guard: Type<CanActivate>): boolean {
  return Reflect.getMetadata(RATE_LIMIT_GUARD, guard) === true;
}

export interface ApiRouteOptions {
  /**
   * Guards run after the global ones (so an outdated client still gets
   * 426 first). A route the contract marks `auth: "session"` requires the
   * guard marked `@SessionAccessGuard()` (`SessionRoute` in the identity
   * module passes it), so a protected route can't be served unprotected.
   */
  guards?: Type<CanActivate>[];
}

/** Contract paths use OpenAPI's `{param}`; Nest (path-to-regexp) uses `:param`. */
export function toNestPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Binds a handler to a route from `apiRoutes` (`@adclub/contracts`):
 * method and path come from the contract, not from a second copy in the
 * controller, and the definition is attached as metadata for the client
 * version guard. Use with a prefix-less `@Controller()` — the contract
 * path is the full path.
 *
 * The success status is the lowest 2xx the contract documents (Nest would
 * otherwise answer 201 to every POST).
 */
export function ApiRoute(
  route: ApiRouteDefinition,
  options: ApiRouteOptions = {},
): MethodDecorator {
  const guards = options.guards ?? [];
  if (route.rateLimit && !guards.some(isRateLimitGuard)) {
    throw new Error(
      `${route.operationId} declares a rate limit: bind it with the rate limit guard (RateLimitedRoute)`,
    );
  }
  if (route.auth === "session") {
    if (!guards.some(isSessionAccessGuard)) {
      throw new Error(
        `${route.operationId} requires a session: bind it with the session access guard (SessionRoute)`,
      );
    }
    if ((route.contexts?.length ?? 0) === 0) {
      throw new Error(`${route.operationId} requires a session but declares no contexts`);
    }
  }
  const successStatus = Object.keys(route.responses)
    .map(Number)
    .filter((status) => status >= 200 && status < 300)
    .sort((a, b) => a - b)[0];
  return applyDecorators(
    RequestMapping({ path: toNestPath(route.path), method: RequestMethod[route.method] }),
    ...(successStatus === undefined ? [] : [HttpCode(successStatus)]),
    SetMetadata(API_ROUTE_METADATA, route),
    ...(guards.length > 0 ? [UseGuards(...guards)] : []),
  );
}
