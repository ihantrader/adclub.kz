import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { ApiErrorResponse, ErrorCode } from "@adclub/contracts";
import type { Request, Response } from "express";
import { withoutQueryParameters } from "../../database/database-error";
import { ErrorReporter } from "../../observability/error-reporter.service";
import { JsonLoggerService } from "../logging/json-logger.service";
import { ZodValidationException } from "../validation/zod-validation.exception";
import { ApiException } from "./api.exception";
import { bodyParserException } from "./body-parser-error";
import {
  CLIENT_UPDATE_REQUIRED_STATUS,
  ClientUpdateRequiredException,
} from "./client-update-required.exception";

/**
 * The contract code that matches the meaning of a status (ARCHITECTURE 7.1,
 * TASK-009.A). `VALIDATION_ERROR` is only for request data that fails its
 * schema (400, 422); a request refused for what it is — its method, size,
 * content type, length of the address — gets a code of its own, and any
 * other 4xx `REQUEST_REJECTED`, never `VALIDATION_ERROR`.
 */
export function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return "VALIDATION_ERROR";
    case HttpStatus.UNAUTHORIZED:
      return "AUTH_REQUIRED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.METHOD_NOT_ALLOWED:
      return "METHOD_NOT_ALLOWED";
    case HttpStatus.NOT_ACCEPTABLE:
      return "NOT_ACCEPTABLE";
    case HttpStatus.REQUEST_TIMEOUT:
      return "REQUEST_TIMEOUT";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    case HttpStatus.GONE:
      return "GONE";
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return "PAYLOAD_TOO_LARGE";
    case HttpStatus.URI_TOO_LONG:
      return "URI_TOO_LONG";
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return "UNSUPPORTED_MEDIA_TYPE";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "RATE_LIMITED";
    case CLIENT_UPDATE_REQUIRED_STATUS:
      return "CLIENT_UPDATE_REQUIRED";
    case HttpStatus.SERVICE_UNAVAILABLE:
    case HttpStatus.GATEWAY_TIMEOUT:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED";
  }
}

/** The route as the contract declares it (never the caller's own values). */
function routeTemplate(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route;
  return typeof route?.path === "string" ? route.path : "unmatched";
}

/**
 * Turns every thrown error — validation failures, Nest `HttpException`s
 * (including the unmatched-route 404), and anything unexpected — into the
 * single response shape described in `@adclub/contracts` (ARCHITECTURE
 * 7.1): `{ code, message, details?, retryable }`. No stack trace or
 * internal error detail ever reaches the client; the full error is logged
 * server-side with the request id instead.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  // `@Inject` is required, not stylistic: esbuild (tsx's transform, used by
  // `pnpm dev`) doesn't always keep an import that's only referenced as a
  // constructor parameter type, which silently breaks Nest's
  // metadata-based auto-injection (`design:paramtypes`) — reproduced by
  // running `pnpm dev` (undefined `this.logger`) vs the tsc build (fine).
  constructor(
    @Inject(JsonLoggerService) private readonly logger: JsonLoggerService,
    @Inject(ErrorReporter) private readonly reporter: ErrorReporter,
  ) {}

  catch(thrown: unknown, host: ArgumentsHost): void {
    // A body the parser refused, if `configureHttpApp` didn't convert it already.
    const exception = bodyParserException(thrown) ?? thrown;
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const { status, body } = this.toResponse(exception);

    // An `ApiException` is an expected, already-described outcome (e.g. a
    // dependency reported down); only unexpected failures are logged here.
    if (status >= 500 && !(exception instanceof ApiException)) {
      // A failed query's message carries its bound values (personal data).
      const logged = withoutQueryParameters(exception);
      const error = logged instanceof Error ? logged : new Error(String(logged));
      this.logger.error(error, "ExceptionFilter");
      // Unexpected failures go to error monitoring, cleaned; an expected
      // 4xx of business logic never does (ARCHITECTURE 15.3).
      this.reporter.captureException(error, {
        transaction: `${request.method} ${routeTemplate(request)}`,
        tags: { kind: "api", status },
      });
    }

    // An error is about this moment (a category hidden now may be back in a
    // minute): no client or proxy keeps it, whatever the route set for a
    // success before failing (TASK-010.A; ARCHITECTURE 4.16).
    response.setHeader("Cache-Control", "no-store");
    if (exception instanceof ApiException) {
      for (const [name, value] of Object.entries(exception.options.headers ?? {})) {
        response.setHeader(name, value);
      }
    }
    response.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ApiErrorResponse } {
    if (exception instanceof ApiException) {
      return {
        status: exception.status,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.options.details !== undefined && { details: exception.options.details }),
          retryable: exception.options.retryable ?? false,
        },
      };
    }
    if (exception instanceof ZodValidationException) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: exception.zodError.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
          retryable: false,
        },
      };
    }

    if (exception instanceof ClientUpdateRequiredException) {
      return {
        status: CLIENT_UPDATE_REQUIRED_STATUS,
        body: {
          code: "CLIENT_UPDATE_REQUIRED",
          message: exception.message,
          details: exception.details,
          retryable: false,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const message =
        typeof responseBody === "string"
          ? responseBody
          : ((responseBody as { message?: string | string[] })?.message ?? exception.message);

      return {
        status,
        body: {
          code: codeForHttpStatus(status),
          message: Array.isArray(message) ? message.join("; ") : message,
          retryable: status >= 500 || status === HttpStatus.REQUEST_TIMEOUT,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        retryable: true,
      },
    };
  }
}
