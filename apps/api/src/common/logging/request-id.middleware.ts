import { randomUUID } from "node:crypto";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "./request-context";

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Reuses an inbound `X-Request-Id` (e.g. from a proxy) or generates one,
 * echoes it back on the response, and makes it available to the logger
 * for the lifetime of the request via `AsyncLocalStorage` — no need to
 * thread it through every service call by hand.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof incoming === "string" && incoming.trim().length > 0 ? incoming : randomUUID();

    res.setHeader("X-Request-Id", requestId);
    requestContext.run({ requestId }, () => next());
  }
}
