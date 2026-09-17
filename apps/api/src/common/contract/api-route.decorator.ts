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

export interface ApiRouteOptions {
  /**
   * Guards run after the global ones (so an outdated client still gets
   * 426 first). Required for a route the contract marks `auth: "session"`
   * — the guard that enforces it (`SessionRoute` in the identity module
   * passes it) — so a protected route can't be served unprotected.
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
  if (route.auth === "session" && guards.length === 0) {
    throw new Error(`${route.operationId} requires a session: bind it with a guard (SessionRoute)`);
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
