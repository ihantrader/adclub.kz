import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { ApiErrorResponse, ErrorCode } from "@adclub/contracts";
import type { Response } from "express";
import { JsonLoggerService } from "../logging/json-logger.service";
import { ZodValidationException } from "../validation/zod-validation.exception";
import { ApiException } from "./api.exception";
import {
  CLIENT_UPDATE_REQUIRED_STATUS,
  ClientUpdateRequiredException,
} from "./client-update-required.exception";

function codeForHttpStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    case HttpStatus.BAD_REQUEST:
      return "VALIDATION_ERROR";
    case CLIENT_UPDATE_REQUIRED_STATUS:
      return "CLIENT_UPDATE_REQUIRED";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR";
  }
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
  constructor(@Inject(JsonLoggerService) private readonly logger: JsonLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);

    // An `ApiException` is an expected, already-described outcome (e.g. a
    // dependency reported down); only unexpected failures are logged here.
    if (status >= 500 && !(exception instanceof ApiException)) {
      this.logger.error(
        exception instanceof Error ? exception : new Error(String(exception)),
        "ExceptionFilter",
      );
    }

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
          retryable: status >= 500,
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
