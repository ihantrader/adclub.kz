import type { ErrorCode, RateLimitedDetails, RateLimitName } from "@adclub/contracts";

/**
 * An expected failure with a contract error code (ARCHITECTURE 7.1). The
 * global exception filter sends it as the unified error with `status`,
 * plus `headers` (e.g. `Retry-After`). `message` and `details` go to the
 * client as they are — never put internal information in them.
 */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly options: {
      details?: unknown;
      retryable?: boolean;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = "ApiException";
  }
}

/** HTTP 429 `RATE_LIMITED`: repeat after `retryAfterSeconds` (also `Retry-After`). */
export function rateLimitedException(
  limit: RateLimitName,
  retryAfterSeconds: number,
): ApiException {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const details: RateLimitedDetails = { limit, retryAfterSeconds: seconds };
  return new ApiException(429, "RATE_LIMITED", "Too many requests, try again later", {
    details,
    retryable: true,
    headers: { "Retry-After": String(seconds) },
  });
}

/** HTTP 503 `SERVICE_UNAVAILABLE`: a dependency the request needs is down. */
export function serviceUnavailableException(): ApiException {
  return new ApiException(
    503,
    "SERVICE_UNAVAILABLE",
    "The service is temporarily unavailable, try again later",
    { retryable: true },
  );
}
