import type { z } from "zod";
import { clientPolicyResponseSchema } from "./client-policy";
import { healthCheckResponseSchema } from "./health";
import { readinessResponseSchema } from "./readiness";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiResponseDefinition {
  description: string;
  schema: z.ZodType;
}

/**
 * One HTTP route of the public API: the single description the server
 * binds its handler to (`@ApiRoute` in `apps/api`), the OpenAPI document
 * is generated from, and the typed client calls. Error responses (the
 * unified `ApiErrorResponse`) are implied for every route and not listed
 * in `responses`, which only holds the documented non-error bodies.
 *
 * Request bodies and query/path parameters are added to this shape
 * together with the first endpoint that needs them.
 */
export interface ApiRouteDefinition {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  tag: string;
  /**
   * `exempt`: served to every client whatever its version (health and the
   * client policy itself, so an outdated client can still learn it must
   * update). `enforced`: a known client below the minimum version gets
   * `CLIENT_UPDATE_REQUIRED` (426) instead.
   */
  clientVersionCheck: "enforced" | "exempt";
  responses: Readonly<Record<number, ApiResponseDefinition>>;
}

function defineRoute<const Route extends ApiRouteDefinition>(route: Route): Route {
  return route;
}

export const apiRoutes = {
  getHealth: defineRoute({
    operationId: "getHealth",
    method: "GET",
    path: "/health",
    summary: "Liveness: answers while the API process is up",
    tag: "meta",
    clientVersionCheck: "exempt",
    responses: {
      200: { description: "The process is alive", schema: healthCheckResponseSchema },
    },
  }),
  getReadiness: defineRoute({
    operationId: "getReadiness",
    method: "GET",
    path: "/ready",
    summary: "Readiness: state of PostgreSQL, Redis and S3",
    tag: "meta",
    clientVersionCheck: "enforced",
    responses: {
      200: { description: "Every dependency is reachable", schema: readinessResponseSchema },
      503: { description: "At least one dependency is down", schema: readinessResponseSchema },
    },
  }),
  getClientPolicy: defineRoute({
    operationId: "getClientPolicy",
    method: "GET",
    path: "/meta/client-policy",
    summary: "Minimum supported client version per platform and the update message",
    tag: "meta",
    clientVersionCheck: "exempt",
    responses: {
      200: { description: "Current client policy", schema: clientPolicyResponseSchema },
    },
  }),
} as const;

export type ApiRoutes = typeof apiRoutes;
export type ApiRouteName = keyof ApiRoutes;

type ResponseBody<Definition> = Definition extends { schema: infer Schema extends z.ZodType }
  ? z.output<Schema>
  : never;

/** Union of every documented (non-error) response body of a route. */
export type ApiRouteResponse<Route extends ApiRouteDefinition> = ResponseBody<
  Route["responses"][keyof Route["responses"]]
>;
