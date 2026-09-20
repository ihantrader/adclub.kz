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
import { auditLogPageSchema, auditLogQuerySchema } from "./audit";
import {
  adminAttributeListResponseSchema,
  adminAttributeOptionResponseSchema,
  adminAttributeResponseSchema,
  adminCategoryResponseSchema,
  adminCategoryTreeResponseSchema,
  attributeIdPathSchema,
  attributeOptionIdPathSchema,
  catalogCategoryPathSchema,
  categoryAttributesResponseSchema,
  categoryIdPathSchema,
  categoryTreeResponseSchema,
  createAttributeBodySchema,
  createAttributeOptionBodySchema,
  createCategoryBodySchema,
  reorderAttributeOptionsBodySchema,
  reorderAttributesBodySchema,
  reorderCategoriesBodySchema,
  setCatalogEntryStatusBodySchema,
  setCategoryStatusBodySchema,
  updateAttributeBodySchema,
  updateAttributeOptionBodySchema,
  updateCategoryBodySchema,
} from "./catalog";
import {
  adminBrandPageSchema,
  adminBrandResponseSchema,
  adminCatalogItemCardSchema,
  adminCatalogItemPageSchema,
  brandIdPathSchema,
  brandListQuerySchema,
  catalogItemIdPathSchema,
  catalogItemListQuerySchema,
  categoryFillPageSchema,
  categoryFillQuerySchema,
  createBrandBodySchema,
  createCatalogItemBodySchema,
  fillCategoryBodySchema,
  fillCategoryResponseSchema,
  itemAnalogPathSchema,
  linkItemAnalogBodySchema,
  setCatalogItemStatusBodySchema,
  setItemValuesBodySchema,
  updateBrandBodySchema,
  updateCatalogItemBodySchema,
} from "./catalog-items";
import { clientPolicyResponseSchema } from "./client-policy";
import {
  editTranslationBodySchema,
  entityTranslationsResponseSchema,
  translationEntityPathSchema,
  translationQueuePageSchema,
  translationQueueQuerySchema,
  translationTargetPathSchema,
} from "./translations";
import { healthCheckResponseSchema } from "./health";
import {
  loginCodeSentResponseSchema,
  loginCodeVerifiedResponseSchema,
  requestLoginCodeBodySchema,
  verifyLoginCodeBodySchema,
} from "./login-code";
import { readinessResponseSchema } from "./readiness";
import {
  changeSettingBodySchema,
  resetSettingBodySchema,
  settingChangedResponseSchema,
  settingHistoryResponseSchema,
  settingKeyPathSchema,
  settingListResponseSchema,
} from "./settings";
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
   * `CLIENT_UPDATE_REQUIRED` (426) instead. `enforced_except_admin_web`:
   * like `enforced`, but an outdated admin panel is still served — the
   * routes an administrator needs to sign in and fix the client policy
   * (ARCHITECTURE 4.11), so no policy change can lock them out.
   */
  clientVersionCheck: "enforced" | "exempt" | "enforced_except_admin_web";
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
  /**
   * Query parameters, one field of this object schema per parameter. Every
   * field is optional or has a default — a caller may always leave the
   * query out entirely. Values arrive as strings, so a field of another
   * type coerces (`z.coerce.number()`); the server validates with this same
   * schema.
   */
  query?: z.ZodObject;
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
    clientVersionCheck: "enforced_except_admin_web",
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
  listSettings: defineRoute({
    operationId: "listSettings",
    method: "GET",
    path: "/admin/settings",
    summary:
      "Every setting by group: description, type, unit, limits, default, current value, version, who changed it last and whether the API may change it",
    tag: "admin",
    clientVersionCheck: "enforced_except_admin_web",
    auth: "session",
    contexts: ["admin"],
    responses: {
      200: { description: "Settings by group", schema: settingListResponseSchema },
    },
  }),
  changeSetting: defineRoute({
    operationId: "changeSetting",
    method: "PUT",
    path: "/admin/settings/{key}",
    summary:
      "Change one setting with a reason, from the version it was read at; takes effect in every process within 30 seconds",
    tag: "admin",
    clientVersionCheck: "enforced_except_admin_web",
    auth: "session",
    contexts: ["admin"],
    pathParams: settingKeyPathSchema,
    requestBody: {
      description: "The new value, the version it replaces and the reason",
      schema: changeSettingBodySchema,
    },
    responses: {
      200: { description: "The setting now and the change", schema: settingChangedResponseSchema },
    },
  }),
  resetSetting: defineRoute({
    operationId: "resetSetting",
    method: "POST",
    path: "/admin/settings/{key}/reset",
    summary: "Return one setting to its default, with a reason",
    tag: "admin",
    clientVersionCheck: "enforced_except_admin_web",
    auth: "session",
    contexts: ["admin"],
    pathParams: settingKeyPathSchema,
    requestBody: {
      description: "The version it replaces and the reason",
      schema: resetSettingBodySchema,
    },
    responses: {
      200: { description: "The setting now and the change", schema: settingChangedResponseSchema },
    },
  }),
  listAuditLog: defineRoute({
    operationId: "listAuditLog",
    method: "GET",
    path: "/admin/audit-log",
    summary:
      "The action journal, newest first: who did what, over what, what changed and why; filters by period, actor, action and entity",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    query: auditLogQuerySchema,
    responses: {
      200: { description: "One page of the journal", schema: auditLogPageSchema },
    },
  }),
  getSettingHistory: defineRoute({
    operationId: "getSettingHistory",
    method: "GET",
    path: "/admin/settings/{key}/history",
    summary: "Changes of one setting, newest first: who, when, was, now, why",
    tag: "admin",
    clientVersionCheck: "enforced_except_admin_web",
    auth: "session",
    contexts: ["admin"],
    pathParams: settingKeyPathSchema,
    responses: {
      200: { description: "The history", schema: settingHistoryResponseSchema },
    },
  }),
  getCatalogCategories: defineRoute({
    operationId: "getCatalogCategories",
    method: "GET",
    path: "/catalog/categories",
    summary:
      "The active category tree (goods, then services) in the language of the request; open to guests, cacheable for a minute",
    tag: "catalog",
    clientVersionCheck: "enforced",
    responses: {
      200: { description: "The category tree", schema: categoryTreeResponseSchema },
    },
  }),
  getCatalogCategoryAttributes: defineRoute({
    operationId: "getCatalogCategoryAttributes",
    method: "GET",
    path: "/catalog/categories/{categoryId}/attributes",
    summary:
      "What the forms and filters of an active category are made of: its active attributes with types, units, bounds and options; hidden, archived and missing categories answer 404 alike",
    tag: "catalog",
    clientVersionCheck: "enforced",
    pathParams: catalogCategoryPathSchema,
    responses: {
      200: {
        description: "The category and its attributes",
        schema: categoryAttributesResponseSchema,
      },
    },
  }),
  listAdminCategories: defineRoute({
    operationId: "listAdminCategories",
    method: "GET",
    path: "/admin/catalog/categories",
    summary: "The whole category tree with every status, names in all languages and versions",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    responses: {
      200: { description: "The tree", schema: adminCategoryTreeResponseSchema },
    },
  }),
  createCategory: defineRoute({
    operationId: "createCategory",
    method: "POST",
    path: "/admin/catalog/categories",
    summary: "Create a node or a subcategory (at the end of its siblings)",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    requestBody: { description: "The new category", schema: createCategoryBodySchema },
    responses: {
      201: { description: "The category", schema: adminCategoryResponseSchema },
    },
  }),
  updateCategory: defineRoute({
    operationId: "updateCategory",
    method: "PATCH",
    path: "/admin/catalog/categories/{categoryId}",
    summary:
      "Rename a category, change its icon or compatibility flag, or move a subcategory to another node of the same kind",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    requestBody: {
      description: "The fields to change and the version they were read at",
      schema: updateCategoryBodySchema,
    },
    responses: {
      200: { description: "The category", schema: adminCategoryResponseSchema },
    },
  }),
  setCategoryStatus: defineRoute({
    operationId: "setCategoryStatus",
    method: "POST",
    path: "/admin/catalog/categories/{categoryId}/status",
    summary:
      "Hide, archive or restore a category; a hidden or archived node hides its subcategories from clients",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    requestBody: {
      description: "The new status and the version it replaces",
      schema: setCategoryStatusBodySchema,
    },
    responses: {
      200: { description: "The category", schema: adminCategoryResponseSchema },
    },
  }),
  reorderCategories: defineRoute({
    operationId: "reorderCategories",
    method: "PUT",
    path: "/admin/catalog/categories/order",
    summary: "Put the subcategories of a node, or the nodes of a kind, in a new order",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    requestBody: {
      description: "The siblings and every one of their ids in the new order",
      schema: reorderCategoriesBodySchema,
    },
    responses: {
      200: { description: "The tree", schema: adminCategoryTreeResponseSchema },
    },
  }),
  listAdminAttributes: defineRoute({
    operationId: "listAdminAttributes",
    method: "GET",
    path: "/admin/catalog/categories/{categoryId}/attributes",
    summary: "The attributes of a category with their options, every status included",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    responses: {
      200: { description: "The attributes", schema: adminAttributeListResponseSchema },
    },
  }),
  createAttribute: defineRoute({
    operationId: "createAttribute",
    method: "POST",
    path: "/admin/catalog/categories/{categoryId}/attributes",
    summary:
      "Add an attribute to a subcategory (number, list, yes/no or text); items of the category get an empty value",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    requestBody: { description: "The new attribute", schema: createAttributeBodySchema },
    responses: {
      201: { description: "The attribute", schema: adminAttributeResponseSchema },
    },
  }),
  reorderAttributes: defineRoute({
    operationId: "reorderAttributes",
    method: "PUT",
    path: "/admin/catalog/categories/{categoryId}/attributes/order",
    summary: "Put the attributes of a category in a new order",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    requestBody: {
      description: "Every attribute id of the category in the new order",
      schema: reorderAttributesBodySchema,
    },
    responses: {
      200: { description: "The attributes", schema: adminAttributeListResponseSchema },
    },
  }),
  updateAttribute: defineRoute({
    operationId: "updateAttribute",
    method: "PATCH",
    path: "/admin/catalog/attributes/{attributeId}",
    summary: "Rename an attribute, change its unit, bounds or flags; the value type never changes",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: attributeIdPathSchema,
    requestBody: {
      description: "The fields to change and the version they were read at",
      schema: updateAttributeBodySchema,
    },
    responses: {
      200: { description: "The attribute", schema: adminAttributeResponseSchema },
    },
  }),
  setAttributeStatus: defineRoute({
    operationId: "setAttributeStatus",
    method: "POST",
    path: "/admin/catalog/attributes/{attributeId}/status",
    summary: "Archive an attribute (hidden from forms and filters, values kept) or restore it",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: attributeIdPathSchema,
    requestBody: {
      description: "The new status and the version it replaces",
      schema: setCatalogEntryStatusBodySchema,
    },
    responses: {
      200: { description: "The attribute", schema: adminAttributeResponseSchema },
    },
  }),
  createAttributeOption: defineRoute({
    operationId: "createAttributeOption",
    method: "POST",
    path: "/admin/catalog/attributes/{attributeId}/options",
    summary: "Add an option to a list attribute (at the end)",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: attributeIdPathSchema,
    requestBody: { description: "The new option", schema: createAttributeOptionBodySchema },
    responses: {
      201: { description: "The option", schema: adminAttributeOptionResponseSchema },
    },
  }),
  reorderAttributeOptions: defineRoute({
    operationId: "reorderAttributeOptions",
    method: "PUT",
    path: "/admin/catalog/attributes/{attributeId}/options/order",
    summary: "Put the options of a list attribute in a new order",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: attributeIdPathSchema,
    requestBody: {
      description: "Every option id of the attribute in the new order",
      schema: reorderAttributeOptionsBodySchema,
    },
    responses: {
      200: { description: "The attribute", schema: adminAttributeResponseSchema },
    },
  }),
  updateAttributeOption: defineRoute({
    operationId: "updateAttributeOption",
    method: "PATCH",
    path: "/admin/catalog/attribute-options/{optionId}",
    summary: "Rename an option of a list attribute",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: attributeOptionIdPathSchema,
    requestBody: {
      description: "The names to change and the version they were read at",
      schema: updateAttributeOptionBodySchema,
    },
    responses: {
      200: { description: "The option", schema: adminAttributeOptionResponseSchema },
    },
  }),
  setAttributeOptionStatus: defineRoute({
    operationId: "setAttributeOptionStatus",
    method: "POST",
    path: "/admin/catalog/attribute-options/{optionId}/status",
    summary: "Archive an option (hidden from forms and filters, values kept) or restore it",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: attributeOptionIdPathSchema,
    requestBody: {
      description: "The new status and the version it replaces",
      schema: setCatalogEntryStatusBodySchema,
    },
    responses: {
      200: { description: "The option", schema: adminAttributeOptionResponseSchema },
    },
  }),
  listAdminBrands: defineRoute({
    operationId: "listAdminBrands",
    method: "GET",
    path: "/admin/catalog/brands",
    summary:
      "Brands by name with their spellings; search by a part of any spelling, case and spaces ignored",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    query: brandListQuerySchema,
    responses: {
      200: { description: "A page of brands", schema: adminBrandPageSchema },
    },
  }),
  createBrand: defineRoute({
    operationId: "createBrand",
    method: "POST",
    path: "/admin/catalog/brands",
    summary: "Create a brand with its name, other spellings and the OEM flag",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    requestBody: {
      description: "The new brand",
      schema: createBrandBodySchema,
    },
    responses: {
      201: { description: "The brand", schema: adminBrandResponseSchema },
    },
  }),
  updateBrand: defineRoute({
    operationId: "updateBrand",
    method: "PATCH",
    path: "/admin/catalog/brands/{brandId}",
    summary: "Rename a brand, replace its other spellings or change the OEM flag",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: brandIdPathSchema,
    requestBody: {
      description: "The fields to change and the version they were read at",
      schema: updateBrandBodySchema,
    },
    responses: {
      200: { description: "The brand", schema: adminBrandResponseSchema },
    },
  }),
  setBrandStatus: defineRoute({
    operationId: "setBrandStatus",
    method: "POST",
    path: "/admin/catalog/brands/{brandId}/status",
    summary: "Archive a brand (no new items get it, existing ones keep it) or restore it",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: brandIdPathSchema,
    requestBody: {
      description: "The new status and the version it replaces",
      schema: setCatalogEntryStatusBodySchema,
    },
    responses: {
      200: { description: "The brand", schema: adminBrandResponseSchema },
    },
  }),
  listAdminCatalogItems: defineRoute({
    operationId: "listAdminCatalogItems",
    method: "GET",
    path: "/admin/catalog/items",
    summary:
      "Items of the catalog, newest first: search by a part of the normalized article or of a name in any language; filters by category, brand, type, status and completeness",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    query: catalogItemListQuerySchema,
    responses: {
      200: { description: "A page of items", schema: adminCatalogItemPageSchema },
    },
  }),
  createCatalogItem: defineRoute({
    operationId: "createCatalogItem",
    method: "POST",
    path: "/admin/catalog/items",
    summary:
      "Create a part, a product described by attributes, or a service; a duplicate is refused with a link to the existing item",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    requestBody: {
      description: "The new item and its values",
      schema: createCatalogItemBodySchema,
    },
    responses: {
      201: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  getAdminCatalogItem: defineRoute({
    operationId: "getAdminCatalogItem",
    method: "GET",
    path: "/admin/catalog/items/{itemId}",
    summary:
      "The item card: the item, the active attributes of its category with its values (empty ones explicit) and its analogs",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: catalogItemIdPathSchema,
    responses: {
      200: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  updateCatalogItem: defineRoute({
    operationId: "updateCatalogItem",
    method: "PATCH",
    path: "/admin/catalog/items/{itemId}",
    summary:
      "Change the category (of the same kind), brand, article or names of an item; its type never changes",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: catalogItemIdPathSchema,
    requestBody: {
      description: "The fields to change and the version they were read at",
      schema: updateCatalogItemBodySchema,
    },
    responses: {
      200: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  setCatalogItemStatus: defineRoute({
    operationId: "setCatalogItemStatus",
    method: "POST",
    path: "/admin/catalog/items/{itemId}/status",
    summary: "Make an item a draft, active or archived; there is no deletion",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: catalogItemIdPathSchema,
    requestBody: {
      description: "The new status and the version it replaces",
      schema: setCatalogItemStatusBodySchema,
    },
    responses: {
      200: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  setCatalogItemValues: defineRoute({
    operationId: "setCatalogItemValues",
    method: "PUT",
    path: "/admin/catalog/items/{itemId}/values",
    summary: "Set or empty attribute values of an item, all or none, with the refused ones listed",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: catalogItemIdPathSchema,
    requestBody: {
      description: "The values and the version of the item they were read at",
      schema: setItemValuesBodySchema,
    },
    responses: {
      200: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  linkItemAnalog: defineRoute({
    operationId: "linkItemAnalog",
    method: "POST",
    path: "/admin/catalog/items/{itemId}/analogs",
    summary:
      "Link two parts of one subcategory as analogs of each other (a link that exists changes nothing)",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: catalogItemIdPathSchema,
    requestBody: {
      description: "The analog",
      schema: linkItemAnalogBodySchema,
    },
    responses: {
      200: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  unlinkItemAnalog: defineRoute({
    operationId: "unlinkItemAnalog",
    method: "DELETE",
    path: "/admin/catalog/items/{itemId}/analogs/{analogItemId}",
    summary: "Remove the analog link between two items",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: itemAnalogPathSchema,
    responses: {
      200: { description: "The item card", schema: adminCatalogItemCardSchema },
    },
  }),
  getCategoryFill: defineRoute({
    operationId: "getCategoryFill",
    method: "GET",
    path: "/admin/catalog/categories/{categoryId}/fill",
    summary:
      "The bulk fill table: items of a subcategory by its active attributes, newest first, optionally only those where one attribute is empty",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    query: categoryFillQuerySchema,
    responses: {
      200: { description: "A page of the table", schema: categoryFillPageSchema },
    },
  }),
  fillCategory: defineRoute({
    operationId: "fillCategory",
    method: "PUT",
    path: "/admin/catalog/categories/{categoryId}/fill",
    summary:
      "Change many cells of the bulk fill table at once: all or none, a cell changed by someone else since it was read is a conflict",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: categoryIdPathSchema,
    requestBody: {
      description: "The cells with the values they were read with",
      schema: fillCategoryBodySchema,
    },
    responses: {
      200: { description: "The rows changed", schema: fillCategoryResponseSchema },
    },
  }),
  listTranslationQueue: defineRoute({
    operationId: "listTranslationQueue",
    method: "GET",
    path: "/admin/translations",
    summary:
      "What waits for a translation or is out of date, filtered by kind of entity, language and state: the volume of work, with counts by state",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    query: translationQueueQuerySchema,
    responses: {
      200: { description: "A page of what is waiting", schema: translationQueuePageSchema },
    },
  }),
  getEntityTranslations: defineRoute({
    operationId: "getEntityTranslations",
    method: "GET",
    path: "/admin/translations/{entityType}/{entityId}",
    summary:
      "The translations of one entity by field and language: text, source (Russian, AI, manual), whether the Russian text changed since, the model and time of an automatic one, a pending task",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: translationEntityPathSchema,
    responses: {
      200: { description: "The translations", schema: entityTranslationsResponseSchema },
    },
  }),
  editTranslation: defineRoute({
    operationId: "editTranslation",
    method: "PUT",
    path: "/admin/translations/{entityType}/{entityId}/{field}/{lang}",
    summary:
      "Write a translation by hand: it is marked as manually edited and automatic translation never overwrites it; checked like any name, a neighbour's name is refused",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: translationTargetPathSchema,
    requestBody: { description: "The text", schema: editTranslationBodySchema },
    responses: {
      200: { description: "The translations", schema: entityTranslationsResponseSchema },
    },
  }),
  releaseTranslation: defineRoute({
    operationId: "releaseTranslation",
    method: "POST",
    path: "/admin/translations/{entityType}/{entityId}/{field}/{lang}/release",
    summary:
      "Release a manual edit: the text stays until the automatic translation replaces it, and the language is queued for translation",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: translationTargetPathSchema,
    responses: {
      200: { description: "The translations", schema: entityTranslationsResponseSchema },
    },
  }),
  retranslate: defineRoute({
    operationId: "retranslate",
    method: "POST",
    path: "/admin/translations/{entityType}/{entityId}/{field}/{lang}/retranslate",
    summary:
      "Translate again: only for an automatic text, a missing one or one refused before; a manually edited text is refused (TRANSLATION_MANUALLY_EDITED)",
    tag: "admin",
    clientVersionCheck: "enforced",
    auth: "session",
    contexts: ["admin"],
    pathParams: translationTargetPathSchema,
    responses: {
      200: { description: "The translations", schema: entityTranslationsResponseSchema },
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

/** Query parameters a caller may pass to a route (`never` for routes without them). */
export type ApiRouteQuery<Route extends ApiRouteDefinition> = Route extends {
  query: infer Schema extends z.ZodType;
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

/**
 * The query string of a request (`?a=1&b=2`, or `""` without parameters).
 * Only parameters the route declares are sent, so a stray field can't end
 * up in a URL; `undefined` and `null` are left out.
 */
export function buildRouteQuery(
  route: ApiRouteDefinition,
  query: Readonly<Record<string, unknown>> = {},
): string {
  const declared = route.query?.shape;
  if (!declared) {
    return "";
  }
  const parts: string[] = [];
  for (const name of Object.keys(declared)) {
    const value = query[name];
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
