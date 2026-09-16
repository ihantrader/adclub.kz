import type { ApiRouteDefinition } from "@adclub/contracts";
import type { ServedRoute } from "../common/contract";
import { DEV_ONLY_PATHS } from "./openapi.controller";

function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Contract paths use OpenAPI's `{param}`; Express reports `:param`. */
function toExpressPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * The unmatched-route 404 handler (`@All("*")`): Express 5 reports it as
 * one `/{*path}` entry per HTTP method. Contract paths never contain `*`.
 */
function isCatchAll(route: ServedRoute): boolean {
  return route.path.includes("*");
}

/**
 * Compares what the server really serves with the contract routes and
 * returns one message per mismatch (empty = consistent). Ignores the
 * unmatched-route 404 handler and the dev-only documentation routes.
 */
export function checkServedRoutesMatchContract(
  served: readonly ServedRoute[],
  contract: readonly ApiRouteDefinition[],
): string[] {
  const servedKeys = new Set(
    served
      .filter((route) => !isCatchAll(route))
      .filter((route) => !(DEV_ONLY_PATHS as readonly string[]).includes(route.path))
      .map((route) => key(route.method, route.path)),
  );
  const contractKeys = new Set(
    contract.map((route) => key(route.method, toExpressPath(route.path))),
  );

  const problems: string[] = [];
  for (const served of servedKeys) {
    if (!contractKeys.has(served)) {
      problems.push(`${served} is served but missing from apiRoutes (@adclub/contracts)`);
    }
  }
  for (const declared of contractKeys) {
    if (!servedKeys.has(declared)) {
      problems.push(
        `${declared} is in apiRoutes (@adclub/contracts) but the server doesn't serve it`,
      );
    }
  }
  return problems.sort();
}
