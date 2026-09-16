import { applyDecorators, RequestMapping, RequestMethod, SetMetadata } from "@nestjs/common";
import type { ApiRouteDefinition } from "@adclub/contracts";

export const API_ROUTE_METADATA = Symbol("API_ROUTE_METADATA");

/**
 * Binds a handler to a route from `apiRoutes` (`@adclub/contracts`):
 * method and path come from the contract, not from a second copy in the
 * controller, and the definition is attached as metadata for the client
 * version guard. Use with a prefix-less `@Controller()` — the contract
 * path is the full path.
 */
export function ApiRoute(route: ApiRouteDefinition): MethodDecorator {
  return applyDecorators(
    RequestMapping({ path: route.path, method: RequestMethod[route.method] }),
    SetMetadata(API_ROUTE_METADATA, route),
  );
}
