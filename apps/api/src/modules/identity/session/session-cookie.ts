import { apiRoutes, type SessionKind } from "@adclub/contracts";
import type { Request, Response } from "express";
import { readCookie, requestOrigin, webClientForOrigin } from "../../../common/http";
import type { AppConfig } from "../../../config";
import { authRequiredException, cookieOriginNotAllowedException } from "./session-errors";

/** Session kinds whose refresh token lives in an HttpOnly cookie. */
export type WebSessionKind = Exclude<SessionKind, "mobile">;

export function isWebSessionKind(kind: SessionKind): kind is WebSessionKind {
  return kind !== "mobile";
}

/**
 * One cookie per web client, so a person signed in to both the cabinet
 * and the admin panel in one browser keeps both sessions.
 */
export const REFRESH_COOKIE_NAMES: Record<WebSessionKind, string> = {
  supplier_web: "adclub_supplier_refresh",
  admin_web: "adclub_admin_refresh",
};

/** The cookie is sent only to the refresh route (`/auth/session/refresh`). */
export const REFRESH_COOKIE_PATH = apiRoutes.refreshSession.path.replace(/\/[^/]+$/, "");

/**
 * The refresh token of a web session: HttpOnly (no page script can read
 * it), Secure (HTTPS only; browsers treat http://localhost as secure),
 * SameSite=Strict (never sent with a request started by another site),
 * no Domain (the API host only), and it lives exactly as long as the
 * session. Browsers keep it until then or until an explicit logout.
 */
export function setRefreshCookie(
  response: Response,
  kind: WebSessionKind,
  token: string,
  expiresAt: Date,
  now: Date,
): void {
  response.cookie(REFRESH_COOKIE_NAMES[kind], token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.max(0, expiresAt.getTime() - now.getTime()),
  });
}

export function clearRefreshCookie(response: Response, kind: WebSessionKind): void {
  response.clearCookie(REFRESH_COOKIE_NAMES[kind], {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
  });
}

/**
 * The refresh token a web client presents through its cookie. Protection
 * against cross-site request forgery, on top of SameSite=Strict: the
 * request must carry the `Origin` of the web client the cookie belongs to
 * (browsers always send it with a POST), and must not be marked
 * cross-site by the browser. Otherwise `ORIGIN_NOT_ALLOWED`.
 */
export function cookieRefreshToken(
  request: Request,
  config: AppConfig,
): { kind: WebSessionKind; token: string } {
  const origin = requestOrigin(request);
  const kind = origin === undefined ? undefined : webClientForOrigin(config, origin);
  if (!kind || request.headers["sec-fetch-site"] === "cross-site") {
    throw cookieOriginNotAllowedException();
  }
  const token = readCookie(request, REFRESH_COOKIE_NAMES[kind]);
  if (!token) {
    throw authRequiredException();
  }
  return { kind, token };
}
