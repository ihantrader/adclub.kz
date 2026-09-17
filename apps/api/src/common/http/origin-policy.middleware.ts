import { Inject, Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { ApiErrorResponse } from "@adclub/contracts";
import type { NextFunction, Request, Response } from "express";
import { APP_CONFIG, type AppConfig } from "../../config";
import { isSameOrigin, requestOrigin, webClientForOrigin } from "./web-origins";

/**
 * Refuses browser requests from any site other than the web clients
 * (`ORIGIN_NOT_ALLOWED`, 403) before they reach a handler. CORS alone only
 * stops the browser from reading the answer; this also keeps a foreign
 * page from making the API do anything. Requests without `Origin` (mobile
 * app, servers) and same-origin requests pass.
 */
@Injectable()
export class OriginPolicyMiddleware implements NestMiddleware {
  private readonly logger = new Logger("OriginPolicy");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const origin = requestOrigin(request);
    if (
      origin === undefined ||
      webClientForOrigin(this.config, origin) !== undefined ||
      isSameOrigin(request, origin)
    ) {
      next();
      return;
    }
    // The origin is a site name, not personal data.
    this.logger.warn(`Request refused: origin not allowed origin=${JSON.stringify(origin)}`);
    const body: ApiErrorResponse = {
      code: "ORIGIN_NOT_ALLOWED",
      message: "Requests from this site are not allowed",
      retryable: false,
    };
    response.status(403).json(body);
  }
}
