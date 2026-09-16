import { z } from "zod";

/**
 * Machine-readable error codes shared by every endpoint (ARCHITECTURE 7.1).
 * Extended as real endpoints need more specific codes (e.g.
 * `SUBSCRIPTION_REQUIRED`, `ORDER_STATE_CONFLICT` in later tasks); the
 * four below cover what the server skeleton itself can produce.
 */
export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
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
