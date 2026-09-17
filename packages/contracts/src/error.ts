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
 *   needs is down; try again later.
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
