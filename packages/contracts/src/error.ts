import { z } from "zod";
import { clientPlatformSchema } from "./client";

/**
 * Machine-readable error codes shared by every endpoint (ARCHITECTURE 7.1).
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
