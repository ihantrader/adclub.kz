import { errorCodeSchema, type ErrorCode } from "@adclub/contracts";

/**
 * Codes the client can report on top of the server's `ErrorCode`s:
 * - `NETWORK_ERROR`: no HTTP response at all (offline, DNS, refused
 *   connection, timeout) — the server may be perfectly fine;
 * - `INVALID_RESPONSE`: a documented response whose body isn't JSON;
 * - `UNKNOWN_ERROR`: an error response in a shape or with a code this
 *   client version doesn't know (a newer server, a proxy error page).
 */
export type ApiErrorCode = ErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE" | "UNKNOWN_ERROR";

export interface ApiErrorInit {
  code: ApiErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  details?: unknown;
  serverCode?: string;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status; `0` when no response was received. */
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;
  /** The `code` exactly as the server sent it, including codes unknown to this client. */
  readonly serverCode: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.details = init.details;
    this.serverCode = init.serverCode;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

const knownErrorCodes = new Set<string>(errorCodeSchema.options);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads an error response leniently: an unknown `code` from a newer
 * server becomes `UNKNOWN_ERROR` (ARCHITECTURE 7.4 — clients must cope
 * with values added after their release) instead of failing to parse.
 */
export function apiErrorFromResponse(status: number, body: unknown): ApiError {
  const fallbackRetryable = status >= 500 || status === 429;

  if (isRecord(body) && typeof body.code === "string" && typeof body.message === "string") {
    const known = knownErrorCodes.has(body.code);
    return new ApiError({
      code: known ? (body.code as ErrorCode) : "UNKNOWN_ERROR",
      message: body.message,
      status,
      retryable: typeof body.retryable === "boolean" ? body.retryable : fallbackRetryable,
      details: body.details,
      serverCode: body.code,
    });
  }

  return new ApiError({
    code: "UNKNOWN_ERROR",
    message: `Unexpected error response (HTTP ${status})`,
    status,
    retryable: fallbackRetryable,
  });
}
