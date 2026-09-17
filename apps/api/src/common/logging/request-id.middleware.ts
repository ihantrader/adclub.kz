import { randomUUID } from "node:crypto";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "./request-context";

const REQUEST_ID_HEADER = "x-request-id";

/** Longest `User-Agent` recorded with an action (`audit_log`). */
const MAX_USER_AGENT_LENGTH = 300;

/**
 * Reuses an inbound `X-Request-Id` (e.g. from a proxy) or generates one,
 * echoes it back on the response, and makes it available to the logger
 * for the lifetime of the request via `AsyncLocalStorage` — no need to
 * thread it through every service call by hand. The caller's address and
 * `User-Agent` ride along for the action journal (ARCHITECTURE 4.13), so a
 * service writing an entry doesn't need the request object.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof incoming === "string" && incoming.trim().length > 0 ? incoming : randomUUID();

    const userAgent = req.headers["user-agent"];

    res.setHeader("X-Request-Id", requestId);
    requestContext.run(
      {
        requestId,
        ip: req.ip ?? null,
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      },
      () => next(),
    );
  }
}
