import {
  applyDecorators,
  HttpCode,
  RequestMapping,
  RequestMethod,
  SetMetadata,
} from "@nestjs/common";
import type { ApiRouteDefinition } from "@adclub/contracts";

export const API_ROUTE_METADATA = Symbol("API_ROUTE_METADATA");

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
export function ApiRoute(route: ApiRouteDefinition): MethodDecorator {
  const successStatus = Object.keys(route.responses)
    .map(Number)
    .filter((status) => status >= 200 && status < 300)
    .sort((a, b) => a - b)[0];
  return applyDecorators(
    RequestMapping({ path: route.path, method: RequestMethod[route.method] }),
    ...(successStatus === undefined ? [] : [HttpCode(successStatus)]),
    SetMetadata(API_ROUTE_METADATA, route),
  );
}
