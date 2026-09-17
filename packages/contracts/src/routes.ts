import type { z } from "zod";
import {
  adminIdPathSchema,
  administratorListResponseSchema,
  backupCodesResponseSchema,
  regenerateBackupCodesBodySchema,
  supplierCompanyResponseSchema,
  supplierIdPathSchema,
  supplierMembershipListResponseSchema,
  switchSupplierBodySchema,
  totpResetResponseSchema,
  type AccessContext,
} from "./access";
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
import {
  selectSupplierBodySchema,
  signInCompletedResponseSchema,
  totpSetupBodySchema,
  totpSetupCompletedResponseSchema,
  totpSetupConfirmBodySchema,
  totpSetupResponseSchema,
  totpVerifiedResponseSchema,
  totpVerifyBodySchema,
} from "./sign-in";

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
   * Required with `auth: "session"`: the contexts the route serves
   * (`AccessContext`). A session of any other context gets 403
   * `FORBIDDEN`; a cabinet session whose employee was removed gets 401
   * `SUPPLIER_ACCESS_CLOSED`. The server refuses to bind a session route
   * without it.
   */
  contexts?: readonly AccessContext[];
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

/** Account-level routes every signed-in session may use, whatever its context. */
const anyContext = ["user", "supplier", "admin"] as const satisfies readonly AccessContext[];

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
  selectSupplier: defineRoute({
    operationId: "selectSupplier",
    method: "POST",
    path: "/auth/sign-in/supplier",
    summary:
      "Finish a supplier cabinet sign-in by choosing one of the companies the number is an active employee of",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: {
      description:
        "The sign-in step from SUPPLIER_SELECTION_REQUIRED and the chosen company; the step cookie of that response is required",
      schema: selectSupplierBodySchema,
    },
    responses: {
      200: {
        description: "Signed in; the refresh token is in the HttpOnly cookie",
        schema: signInCompletedResponseSchema,
      },
    },
  }),
  startTotpSetup: defineRoute({
    operationId: "startTotpSetup",
    method: "POST",
    path: "/auth/sign-in/totp/setup",
    summary: "Get the authenticator app data (QR content and secret) during the setup step",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: {
      description:
        "The sign-in step from TOTP_SETUP_REQUIRED; the step cookie of that response is required",
      schema: totpSetupBodySchema,
    },
    responses: {
      200: { description: "Authenticator app data", schema: totpSetupResponseSchema },
    },
  }),
  confirmTotpSetup: defineRoute({
    operationId: "confirmTotpSetup",
    method: "POST",
    path: "/auth/sign-in/totp/setup/confirm",
    summary:
      "Confirm the authenticator app with its current code; returns the admin session and the backup codes (once)",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: {
      description:
        "The sign-in step and the current code from the app; the step cookie is required",
      schema: totpSetupConfirmBodySchema,
    },
    responses: {
      200: {
        description: "Signed in; the refresh token is in the HttpOnly cookie",
        schema: totpSetupCompletedResponseSchema,
      },
    },
  }),
  verifyTotp: defineRoute({
    operationId: "verifyTotp",
    method: "POST",
    path: "/auth/sign-in/totp",
    summary: "Finish an admin panel sign-in with the authenticator code or an unused backup code",
    tag: "auth",
    clientVersionCheck: "enforced",
    requestBody: {
      description:
        "The sign-in step and exactly one of the two codes; the step cookie of the TOTP_REQUIRED response is required",
      schema: totpVerifyBodySchema,
    },
    responses: {
      200: {
        description: "Signed in; the refresh token is in the HttpOnly cookie",
        schema: totpVerifiedResponseSchema,
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
    contexts: anyContext,
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
    contexts: anyContext,
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
    contexts: anyContext,
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
    contexts: anyContext,
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
    contexts: anyContext,
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
    contexts: anyContext,
    responses: {
      200: { description: "The current session is ended", schema: sessionsEndedResponseSchema },
    },
  }),
  listMySuppliers: defineRoute({
    operationId: "listMySuppliers",
    method: "GET",
    path: "/auth/suppliers",
    summary: "Companies the signed-in employee is an active member of (to switch between them)",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["supplier"],
    responses: {
      200: { description: "Active memberships", schema: supplierMembershipListResponseSchema },
    },
  }),
  switchSupplier: defineRoute({
    operationId: "switchSupplier",
    method: "POST",
    path: "/auth/supplier-context",
    summary:
      "Switch the current cabinet session to another company the employee is an active member of",
    tag: "auth",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["supplier"],
    requestBody: { description: "The company to work for", schema: switchSupplierBodySchema },
    responses: {
      200: {
        description: "The session now works for that company",
        schema: currentAccountResponseSchema,
      },
    },
  }),
  getSupplierCompany: defineRoute({
    operationId: "getSupplierCompany",
    method: "GET",
    path: "/supplier/company",
    summary: "The company the cabinet session works for",
    tag: "supplier",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["supplier"],
    responses: {
      200: { description: "The current company", schema: supplierCompanyResponseSchema },
    },
  }),
  getSupplierCompanyById: defineRoute({
    operationId: "getSupplierCompanyById",
    method: "GET",
    path: "/supplier/companies/{supplierId}",
    summary: "A company by id — only the session's own; any other answers like a missing one (404)",
    tag: "supplier",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["supplier"],
    pathParams: supplierIdPathSchema,
    responses: {
      200: { description: "The company", schema: supplierCompanyResponseSchema },
    },
  }),
  listAdministrators: defineRoute({
    operationId: "listAdministrators",
    method: "GET",
    path: "/admin/administrators",
    summary: "Active administrators (phone numbers partly hidden)",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    responses: {
      200: { description: "Administrators", schema: administratorListResponseSchema },
    },
  }),
  resetAdministratorTotp: defineRoute({
    operationId: "resetAdministratorTotp",
    method: "POST",
    path: "/admin/administrators/{adminId}/totp-reset",
    summary:
      "Reset another administrator's second factor: ends their admin sessions, setup is required at next sign-in",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: adminIdPathSchema,
    responses: {
      200: { description: "The second factor is reset", schema: totpResetResponseSchema },
    },
  }),
  regenerateBackupCodes: defineRoute({
    operationId: "regenerateBackupCodes",
    method: "POST",
    path: "/admin/totp/backup-codes",
    summary: "A new set of the administrator's own backup codes; the previous set stops working",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    requestBody: {
      description: "The current code from the authenticator app",
      schema: regenerateBackupCodesBodySchema,
    },
    responses: {
      200: { description: "The new backup codes (shown once)", schema: backupCodesResponseSchema },
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
