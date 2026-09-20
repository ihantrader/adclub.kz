import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { ApiException } from "../errors/api.exception";
import { contractPathOf, uploadRouteFor } from "./upload-routes";

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
 * `Content-Type`.
 *
 * The exception is a route that takes a file (TASK-013): those declare an
 * `upload` in the contract and are the only ones let through here — the
 * list comes from the contract itself (`uploadRouteFor`), so the check
 * stays in force for every other route, including other methods of the
 * same path.
 */
@Injectable()
export class JsonBodyMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    if (uploadRouteFor(request.method, contractPathOf(request))) {
      next();
      return;
    }
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
