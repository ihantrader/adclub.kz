import type { z } from "zod";
import { clientPolicyResponseSchema } from "./client-policy";
import { healthCheckResponseSchema } from "./health";
import {
  loginCodeSentResponseSchema,
  loginCodeVerifiedResponseSchema,
  requestLoginCodeBodySchema,
  verifyLoginCodeBodySchema,
} from "./login-code";
import { readinessResponseSchema } from "./readiness";
import {
  currentAccountResponseSchema,
  refreshSessionBodySchema,
  sessionIdPathSchema,
  sessionListResponseSchema,
  sessionsEndedResponseSchema,
  sessionTokensSchema,
} from "./session";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiResponseDefinition {
  description: string;
  schema: z.ZodType;
}

/** A JSON request body, validated by the server with `schema`. */
export interface ApiRequestBodyDefinition {
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
 * Query parameters are added to this shape together with the first
 * endpoint that needs them.
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
  /**
   * `session`: only for a caller with a valid access token of an active
   * session (`Authorization: Bearer …`); anything else gets 401
   * (`AUTH_REQUIRED`, `ACCESS_TOKEN_EXPIRED`, `SESSION_ENDED`). Omitted:
   * public route.
   */
  auth?: "session";
  /**
   * Path parameters: `{name}` placeholders in `path`, one string field of
   * this object schema per placeholder.
   */
  pathParams?: z.ZodObject<Record<string, z.ZodType<string>>>;
  /** Required JSON body; the lowest listed 2xx status is the success status. */
  requestBody?: ApiRequestBodyDefinition;
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
  requestLoginCode: defineRoute({
    operationId: "requestLoginCode",
    method: "POST",
    path: "/auth/login-code",
    summary: "Send a one-time login code to a Kazakhstan mobile number (WhatsApp, SMS as fallback)",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: {
      description: "Phone number and optional channel",
      schema: requestLoginCodeBodySchema,
    },
    responses: {
      200: { description: "The code was sent", schema: loginCodeSentResponseSchema },
    },
  }),
  verifyLoginCode: defineRoute({
    operationId: "verifyLoginCode",
    method: "POST",
    path: "/auth/login-code/verify",
    summary: "Check a login code; a correct code confirms the phone number and is spent",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: { description: "Phone number and the code", schema: verifyLoginCodeBodySchema },
    responses: {
      200: {
        description: "The phone number is confirmed",
        schema: loginCodeVerifiedResponseSchema,
      },
    },
  }),
  refreshSession: defineRoute({
    operationId: "refreshSession",
    method: "POST",
    path: "/auth/session/refresh",
    summary:
      "Exchange a refresh token (body for the mobile app, HttpOnly cookie for web clients) for a new token pair",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: {
      description: "The refresh token (mobile), or an empty object (web, cookie)",
      schema: refreshSessionBodySchema,
    },
    responses: {
      200: { description: "A new token pair", schema: sessionTokensSchema },
    },
  }),
  getCurrentAccount: defineRoute({
    operationId: "getCurrentAccount",
    method: "GET",
    path: "/auth/me",
    summary: "The signed-in account and the current session",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    responses: {
      200: { description: "Account and session", schema: currentAccountResponseSchema },
    },
  }),
  listSessions: defineRoute({
    operationId: "listSessions",
    method: "GET",
    path: "/auth/sessions",
    summary: "Active sessions (devices) of the signed-in account",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    responses: {
      200: { description: "Active sessions", schema: sessionListResponseSchema },
    },
  }),
  endSession: defineRoute({
    operationId: "endSession",
    method: "DELETE",
    path: "/auth/sessions/{sessionId}",
    summary:
      "End one of the account's own sessions; someone else's session answers like a missing one (404)",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    pathParams: sessionIdPathSchema,
    responses: {
      200: { description: "The session is ended", schema: sessionsEndedResponseSchema },
    },
  }),
  endOtherSessions: defineRoute({
    operationId: "endOtherSessions",
    method: "POST",
    path: "/auth/sessions/end-others",
    summary: "End every session of the account except the current one",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    responses: {
      200: { description: "Other sessions are ended", schema: sessionsEndedResponseSchema },
    },
  }),
  endAllSessions: defineRoute({
    operationId: "endAllSessions",
    method: "POST",
    path: "/auth/sessions/end-all",
    summary: "End every session of the account, the current one included",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    responses: {
      200: { description: "All sessions are ended", schema: sessionsEndedResponseSchema },
    },
  }),
  logout: defineRoute({
    operationId: "logout",
    method: "POST",
    path: "/auth/logout",
    summary: "End the current session",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    responses: {
      200: { description: "The current session is ended", schema: sessionsEndedResponseSchema },
    },
  }),
} as const;

export type ApiRoutes = typeof apiRoutes;
export type ApiRouteName = keyof ApiRoutes;

type ResponseBody<Definition> = Definition extends { schema: infer Schema extends z.ZodType }
  ? z.output<Schema>
  : never;

/** Body a caller passes to a route (`never` for routes without one). */
export type ApiRouteRequestBody<Route extends ApiRouteDefinition> = Route extends {
  requestBody: { schema: infer Schema extends z.ZodType };
}
  ? z.input<Schema>
  : never;

/** Path parameters a caller passes to a route (`never` for routes without them). */
export type ApiRoutePathParams<Route extends ApiRouteDefinition> = Route extends {
  pathParams: infer Schema extends z.ZodType;
}
  ? z.input<Schema>
  : never;

/** Union of every documented (non-error) response body of a route. */
export type ApiRouteResponse<Route extends ApiRouteDefinition> = ResponseBody<
  Route["responses"][keyof Route["responses"]]
>;

/**
 * The concrete path of a route: every `{name}` placeholder replaced by the
 * URL-encoded value of `params[name]`. Throws if a value is missing.
 */
export function buildRoutePath(
  route: ApiRouteDefinition,
  params: Readonly<Record<string, string>> = {},
): string {
  return route.path.replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${route.operationId} requires the path parameter "${name}"`);
    }
    return encodeURIComponent(value);
  });
}
