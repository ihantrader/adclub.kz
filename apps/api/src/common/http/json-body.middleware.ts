import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { ApiException } from "../errors/api.exception";

/** `application/json`, and `application/<something>+json`. */
const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i;

function hasBody(request: Request): boolean {
  const length = request.headers["content-length"];
  return (
    request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0")
  );
}

/**
 * Every body the API takes is JSON (ARCHITECTURE 7.1). A request that
 * brings a body of another type is refused with `UNSUPPORTED_MEDIA_TYPE`
 * (415, TASK-009.A) instead of reaching a handler with no body and failing
 * as `VALIDATION_ERROR`. A request without a body passes whatever its
 * `Content-Type`. When an endpoint needs another type (file uploads), it
 * is excluded here.
 */
@Injectable()
export class JsonBodyMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    if (hasBody(request) && !JSON_TYPE.test(request.headers["content-type"] ?? "")) {
      throw new ApiException(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "The request body must be JSON (Content-Type: application/json)",
      );
    }
    next();
  }
}
