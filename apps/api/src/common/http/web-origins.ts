import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import type { Request } from "express";
import type { AppConfig } from "../../config";

/** Which web client a browser origin belongs to. */
export type WebClient = "supplier_web" | "admin_web";

/**
 * Request headers the web clients send: `X-Client` and `Accept-Language`
 * (ARCHITECTURE 7.4), `Authorization` (sessions), JSON bodies, and a
 * caller's `X-Request-Id`. Anything else fails the preflight.
 */
export const CORS_ALLOWED_HEADERS = [
  "Accept",
  "Accept-Language",
  "Authorization",
  "Content-Type",
  "X-Client",
  "X-Request-Id",
];

/** Response headers a web client may read besides the CORS-safelisted ones. */
export const CORS_EXPOSED_HEADERS = ["Retry-After", "X-Request-Id"];

const PREFLIGHT_MAX_AGE_SECONDS = 600;

export function webClientForOrigin(config: AppConfig, origin: string): WebClient | undefined {
  if (config.http.webOrigins.supplierWeb.includes(origin)) {
    return "supplier_web";
  }
  if (config.http.webOrigins.adminWeb.includes(origin)) {
    return "admin_web";
  }
  return undefined;
}

/** The single `Origin` header of a request, if it has exactly one. */
export function requestOrigin(request: Request): string | undefined {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

/**
 * A browser request to the API from the API's own pages (the development
 * docs at `/docs`): the `Origin` is the API itself.
 */
export function isSameOrigin(request: Request, origin: string): boolean {
  const host = request.headers.host;
  return typeof host === "string" && origin === `${request.protocol}://${host}`;
}

/**
 * CORS (ARCHITECTURE 4.6): only the configured origins of the supplier
 * cabinet and the admin panel get CORS headers, with credentials (the
 * cookie session). Requests without `Origin` — the mobile app, servers,
 * probes — aren't affected by CORS at all.
 */
export function corsOptions(config: AppConfig): CorsOptions {
  return {
    origin: (origin, callback) => {
      callback(null, origin !== undefined && webClientForOrigin(config, origin) !== undefined);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  };
}
