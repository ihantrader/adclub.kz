import { z } from "zod";
import { clientPlatformSchema } from "./client";

/**
 * Machine-readable error codes shared by every endpoint (ARCHITECTURE 7.1).
 *
 * - `LOGIN_CODE_INVALID` (400): wrong code; `details` is
 *   `LoginCodeInvalidDetails`.
 * - `LOGIN_CODE_EXPIRED` (400): no code is accepted for this number any
 *   more (expired, already used, attempts exhausted, replaced by a newer
 *   one, or never sent) — request a new one.
 * - `LOGIN_CODE_DELIVERY_FAILED` (503, retryable): no channel delivered
 *   the code.
 * - `RATE_LIMITED` (429, retryable): `details` is `RateLimitedDetails`.
 * - `SERVICE_UNAVAILABLE` (503, retryable): a dependency the request
 *   needs is down; try again later. Never a reason to sign the user out.
 * - `ACCESS_TOKEN_EXPIRED` (401): the access token is past its lifetime —
 *   exchange the refresh token (`POST /auth/session/refresh`) and repeat.
 * - `AUTH_REQUIRED` (401): no usable credentials (no token, or a
 *   malformed, forged or foreign one) — sign in.
 * - `SESSION_ENDED` (401): the session was ended (logout, ended from
 *   another device, refresh token reuse) or expired — sign in again and
 *   wipe local data of the account.
 * - `SESSION_KIND_UNAVAILABLE` (403): this client can't get a session this
 *   way (supplier cabinet and admin panel sign-in isn't open yet); the code
 *   was not spent.
 * - `ORIGIN_NOT_ALLOWED` (403): a browser request from a site that isn't
 *   one of the web clients, or a cookie-based request without a trusted
 *   `Origin`.
 *
 * Extended as real endpoints need more specific codes (e.g.
 * `SUBSCRIPTION_REQUIRED`, `ORDER_STATE_CONFLICT` in later tasks). Values
 * are only ever added: clients must treat a code they don't know as a
 * generic error (ARCHITECTURE 7.4), which `@adclub/api-client` does.
 */
export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
  "CLIENT_UPDATE_REQUIRED",
  // Login codes (TASK-004, ARCHITECTURE 8.1).
  "LOGIN_CODE_INVALID",
  "LOGIN_CODE_EXPIRED",
  "LOGIN_CODE_DELIVERY_FAILED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  // Sessions (TASK-005, ARCHITECTURE 8.2).
  "ACCESS_TOKEN_EXPIRED",
  "AUTH_REQUIRED",
  "SESSION_ENDED",
  "SESSION_KIND_UNAVAILABLE",
  "ORIGIN_NOT_ALLOWED",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Single error shape returned by every failed request, whatever the
 * cause: validation, a missing resource, a conflict or an unhandled
 * server error. Internal details (stack traces, driver errors) never go
 * into `details` — only information safe to show a client.
 */
export const apiErrorResponseSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/**
 * `details` of a `CLIENT_UPDATE_REQUIRED` error (HTTP 426). `message` of
 * that error is the localized update text from the client policy.
 */
export const clientUpdateRequiredDetailsSchema = z.object({
  platform: clientPlatformSchema,
  clientVersion: z.string(),
  minSupportedVersion: z.string(),
});

export type ClientUpdateRequiredDetails = z.infer<typeof clientUpdateRequiredDetailsSchema>;
